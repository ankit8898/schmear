import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dataDir } from "../state.ts";
import type { Window } from "../types.ts";
import { endChild, errorMessage, execFileAsync } from "../util.ts";

const shippedAdapters = new URL("../../adapters/", import.meta.url);
const NPM_CI_TIMEOUT_MS = 120_000;

/** `<dataDir(env)>/adapters/<first 16 hex of sha256(shipped adapters/package-lock.json)>`. */
export function adaptersDir(env: NodeJS.ProcessEnv = process.env): string {
  const lock = readFileSync(new URL("package-lock.json", shippedAdapters));
  return join(dataDir(env), "adapters", createHash("sha256").update(lock).digest("hex").slice(0, 16));
}

async function npmCi(cwd: string): Promise<void> {
  let npm: string;
  try {
    npm = await realpath(join(dirname(process.execPath), "npm"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`npm not found beside ${process.execPath}`);
    }
    throw err;
  }
  try {
    // --omit=peer drops @anthropic-ai/sdk, which nothing imports; the MCP SDK, a peer claude-agent-sdk does
    // import, is a direct dependency in adapters/package.json for that reason.
    await execFileAsync(
      process.execPath,
      [
        npm,
        "ci",
        "--omit=optional",
        "--omit=peer",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--loglevel=error",
      ],
      { cwd, timeout: NPM_CI_TIMEOUT_MS },
    );
  } catch (err) {
    const e = err as Error & { killed?: boolean; stderr?: string };
    if (e.killed) {
      throw new Error("npm ci timed out after 120 s");
    }
    const stderr = (e.stderr ?? "").replace(/\s+/g, " ").trim();
    throw new Error(stderr ? stderr.slice(0, 300) : errorMessage(err));
  }
}

const installing = new Map<string, Promise<void>>();

/** Installs the shipped lockfile into adaptersDir(env) unless it exists, then deletes the other pin sets' trees. `npmCi` is the test seam. */
export function ensureAdapters(
  env: NodeJS.ProcessEnv = process.env,
  ci: (cwd: string) => Promise<void> = npmCi,
): Promise<void> {
  const dir = adaptersDir(env);
  if (existsSync(dir)) {
    return Promise.resolve();
  }
  let pending = installing.get(dir);
  if (!pending) {
    pending = install(dir, ci).finally(() => installing.delete(dir));
    installing.set(dir, pending);
  }
  return pending;
}

// Each process installs into its own temp sibling and renames, so success is judged by the tree existing afterwards.
async function install(dir: string, ci: (cwd: string) => Promise<void>): Promise<void> {
  const parent = dirname(dir);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const tmp = await mkdtemp(`${dir}.tmp-`);
  try {
    for (const name of ["package.json", "package-lock.json"]) {
      await copyFile(fileURLToPath(new URL(name, shippedAdapters)), join(tmp, name));
    }
    await ci(tmp);
    await rename(tmp, dir);
  } catch (err) {
    await rm(tmp, { recursive: true, force: true });
    if (!existsSync(dir)) {
      throw new Error(
        `could not install the Claude and Codex ACP adapters: ${errorMessage(err)}. schmear retries at the next Claude or Codex task; \`schmear init --yes\` retries now.`,
      );
    }
  }
  const keep = basename(dir);
  for (const name of await readdir(parent)) {
    if (!name.startsWith(keep)) {
      await rm(join(parent, name), { recursive: true, force: true });
    }
  }
}

/** `pkgName`'s `binName`, absolute, in the adapter tree; installs the tree first when it is missing. */
export async function adapterBin(pkgName: string, binName: string): Promise<string> {
  await ensureAdapters();
  const pkgDir = join(adaptersDir(), "node_modules", pkgName);
  const pkg = JSON.parse(await readFile(join(pkgDir, "package.json"), "utf8")) as {
    bin?: string | Record<string, string>;
  };
  const relBin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.[binName];
  if (!relBin) {
    throw new Error(`${pkgName} package.json is missing bin['${binName}']`);
  }
  return join(pkgDir, relBin);
}

export function window(
  usedPercent: number,
  resetsAt: number | null,
  kind: Window["kind"],
  periodHours: number,
): Window {
  // NaN would pass the router's out check and then empty its tie band, so an unreadable value counts as out.
  if (!Number.isFinite(usedPercent)) {
    return { kind, remaining: 0, resetsAt, periodHours };
  }
  // (100 − used) / 100, not 1 − used / 100: 98% used must give exactly 0.02, or a pool at the floor routes.
  return { kind, remaining: Math.min(1, Math.max(0, (100 - usedPercent) / 100)), resetsAt, periodHours };
}

export type Fallthrough = { fallthrough: string };

type Exchange<T> = { status: "reply"; value: T } | { status: "timeout" } | { status: "closed" };

/**
 * Spawns `bin`, writes the `start` lines, and feeds each stdout line to `onLine` until it returns a reply.
 * `onLine` may `send` more lines or throw to fail. Rejects when the spawn fails; the child is always ended
 * with stdin closed, SIGTERM, then SIGKILL if it outlives the grace period.
 */
export function lineExchange<T>(
  bin: string,
  args: string[],
  opts: { env: Record<string, string>; cwd?: string; timeoutMs: number; start: string[] },
  onLine: (line: string, send: (line: string) => void) => { value: T } | undefined,
): Promise<Exchange<T>> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "ignore"] });
    const lines = createInterface({ input: child.stdout });
    const send = (line: string): void => {
      child.stdin.write(`${line}\n`);
    };
    let done = false;
    const finish = (outcome: Exchange<T> | Error): void => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      lines.close();
      child.stdin.end();
      endChild(child);
      if (outcome instanceof Error) {
        reject(outcome);
      } else {
        resolve(outcome);
      }
    };
    const timer = setTimeout(() => finish({ status: "timeout" }), opts.timeoutMs);
    child.on("error", finish);
    child.on("close", () => finish({ status: "closed" }));
    child.stdin.on("error", () => {}); // child gone early: the close event reports it
    lines.on("line", (line) => {
      try {
        const reply = onLine(line, send);
        if (reply) {
          finish({ status: "reply", value: reply.value });
        }
      } catch (err) {
        finish(err as Error);
      }
    });
    for (const line of opts.start) {
      send(line);
    }
  });
}
