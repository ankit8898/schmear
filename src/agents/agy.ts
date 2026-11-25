import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { workerEnv } from "../acp.ts";
import { dataDir } from "../state.ts";
import {
  type AgentAdapter,
  type AgentPool,
  type AgentReading,
  keyId,
  type Lane,
  type LaneKey,
  type LaunchSpec,
  type Window,
  type WorkerFailure,
} from "../types.ts";
import {
  errorMessage,
  execFileAsync,
  firstLine,
  isRecord,
  leadGroup,
  signalChild,
  unreadable,
  versionLine,
} from "../util.ts";
import { type Fallthrough, window } from "./shared.ts";

const AGY_QUOTA_RE = /quota|limit reached|exhausted|RESOURCE_EXHAUSTED|\b429\b/i;
// agy reports executor errors (invalid key, quota, depleted prepay) as the turn's last reply line, not as an ACP error.
export const AGY_FAIL_REPLY = /(?:^|\n)[ \t]*⚠?[ \t]*agent executor error:[^\n]*\s*$/;
const AGY_MIN_VERSION = [1, 1, 11] as const;
const AGY_VERSION_TIMEOUT_MS = 3_000;
export const AGY_USAGE_TIMEOUT_MS = 90_000;
const AGY_USAGE_MAX_BYTES = 1024 * 1024;
const BROWSER_GUARD_SCRIPT = "#!/bin/sh\nexit 1\n";
const BROWSER_LAUNCHERS = ["open", "xdg-open"] as const;

export function parseAgyVersion(output: string): [number, number, number] | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(firstLine(output));
  if (!match) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isVersionAtLeast(
  version: readonly [number, number, number],
  min: readonly [number, number, number],
): boolean {
  for (let i = 0; i < 3; i++) {
    if (version[i] !== min[i]) {
      return version[i] > min[i];
    }
  }
  return true;
}

const errorLine = (err: unknown): string => firstLine(errorMessage(err));

async function installBrowserGuard(): Promise<{ dir: string; launcher: string }> {
  const dir = await mkdtemp(join(tmpdir(), "schmear-agy-usage-"));
  try {
    for (const name of BROWSER_LAUNCHERS) {
      const target = join(dir, name);
      await writeFile(target, BROWSER_GUARD_SCRIPT, "utf8");
      await chmod(target, 0o700);
    }
    return { dir, launcher: join(dir, BROWSER_LAUNCHERS[0]) };
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

// agy runs in its own process group: a timeout or overflow SIGKILLs the group and settles at once, and
// agy's exit reaps leftovers (detached MCP servers) so a background child cannot hold stdout open.
function runAgyCommand(
  bin: string,
  args: string[],
  opts: { cwd?: string; env: Record<string, string>; timeoutMs: number; label: string },
): Promise<{ stdout?: string; error?: string }> {
  return new Promise((resolve) => {
    const child = leadGroup(
      spawn(bin, args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ["ignore", "pipe", "ignore"],
        detached: true,
      }),
    );
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;
    const done = (result: { stdout?: string; error?: string }): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const abort = (error: string): void => {
      signalChild(child, "SIGKILL");
      done({ error });
    };

    const timer = setTimeout(
      () => abort(`${opts.label} timed out after ${opts.timeoutMs} ms`),
      opts.timeoutMs,
    );

    child.stdout.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > AGY_USAGE_MAX_BYTES) {
        abort(`${opts.label} output exceeded ${AGY_USAGE_MAX_BYTES} bytes`);
        return;
      }
      chunks.push(chunk);
    });

    child.on("error", (err) => {
      done({ error: `${opts.label} failed: ${errorLine(err)}` });
    });

    child.on("close", (code, signal) => {
      if (code !== 0) {
        done({ error: `${opts.label} failed: ${signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`}` });
        return;
      }
      done({ stdout: Buffer.concat(chunks).toString("utf8") });
    });
  });
}

const AGY_POOLS: Record<string, { id: string; keys: LaneKey[] }> = {
  "Gemini Models": { id: "agy-gemini", keys: ["agy-gemini", "agy-argon"] },
  "Gemini 4 Argon": { id: "agy-argon", keys: ["agy-argon"] },
  "Claude and GPT models": { id: "agy-3p", keys: ["agy-3p"] },
};
const AGY_WINDOWS: Record<string, { kind: Window["kind"]; hours: number }> = {
  weekly: { kind: "period", hours: 168 },
  "5h": { kind: "short", hours: 5 },
};

const APP_PROBE_TIMEOUT_MS = 3_000;
const APP_REQUEST_TIMEOUT_MS = 5_000;
const APP_QUOTA_PATH = "/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary";
const APP_REQUEST_BODY = JSON.stringify({
  metadata: {
    ideName: "antigravity",
    extensionName: "antigravity",
    ideVersion: "unknown",
    locale: "en",
  },
});

const LANG_SERVER_RE = /(^|\/)language[_-]server([_-][a-z0-9]+)*(\s|$)/;
const CSRF_FLAG_RE = /--csrf_token[=\s]+(\S+)/i;
const IDE_MARKERS = [
  "antigravity ide.app/",
  "--app_data_dir antigravity-ide",
  "--app_data_dir=antigravity-ide",
  "/extensions/antigravity/bin/language_server",
];

export interface AgyAppDeps {
  ps(): Promise<string>;
  listeningPorts(pid: number): Promise<number[]>;
  post(
    port: number,
    path: string,
    headers: Record<string, string>,
    body: string,
    timeoutMs: number,
  ): Promise<{ status: number; body: string }>;
}

export interface AgyDeps {
  app: AgyAppDeps;
  cli(bin: string, env?: Record<string, string>): Promise<AgentReading>;
}

/** Extracts Antigravity app `language_server` processes (excluding IDE and CLI processes) that carry a CSRF token. */
export function findAgyAppServers(psOutput: string): { pid: number; csrf: string }[] {
  const servers: { pid: number; csrf: string }[] = [];
  for (const rawLine of psOutput.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const match = /^(\d+)\s+(.+)$/.exec(line);
    if (!match) {
      continue;
    }
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      continue;
    }
    const command = match[2];
    const lower = command.toLowerCase();
    if (!LANG_SERVER_RE.test(lower)) {
      continue;
    }
    const hasAppMarker =
      (lower.includes("--app_data_dir") && lower.includes("antigravity")) ||
      lower.includes("antigravity.app/") ||
      lower.includes("/gemini.app/") ||
      lower.includes("/antigravity/");
    if (!hasAppMarker || IDE_MARKERS.some((marker) => lower.includes(marker))) {
      continue;
    }
    const csrfMatch = CSRF_FLAG_RE.exec(command);
    if (!csrfMatch) {
      continue;
    }
    servers.push({ pid, csrf: csrfMatch[1] });
  }
  return servers;
}

/** Parses listening TCP ports from `lsof -nP -iTCP -sTCP:LISTEN -a -p <pid>` output. */
export function parseListeningPorts(lsofOutput: string): number[] {
  const ports = new Set<number>();
  for (const match of lsofOutput.matchAll(/:(\d+)\s+\(LISTEN\)/g)) {
    const port = Number(match[1]);
    if (Number.isSafeInteger(port) && port > 0 && port <= 65_535) {
      ports.add(port);
    }
  }
  return [...ports].sort((a, b) => a - b);
}

function parseAgyResetTime(value: unknown): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value * 1000 : Number.NaN;
  }
  if (typeof value === "string") {
    const iso = Date.parse(value);
    if (!Number.isNaN(iso)) {
      return iso;
    }
    const trimmed = value.trim();
    const secs = trimmed !== "" ? Number(trimmed) : Number.NaN;
    return Number.isFinite(secs) ? secs * 1000 : Number.NaN;
  }
  return Number.NaN;
}

function readBucketFraction(bucket: Record<string, unknown>): unknown {
  if (bucket.remainingFraction !== undefined) {
    return bucket.remainingFraction;
  }
  if (bucket.remaining_fraction !== undefined) {
    return bucket.remaining_fraction;
  }
  if (isRecord(bucket.remaining)) {
    if (bucket.remaining.remainingFraction !== undefined) {
      return bucket.remaining.remainingFraction;
    }
    if (bucket.remaining.case === "remainingFraction") {
      return bucket.remaining.value;
    }
  }
  return undefined;
}

/** Shared parser for Antigravity quota summary `groups` (app server camelCase and CLI snake_case). */
export function parseAgyGroups(
  groups: unknown,
  warnings: string[],
  _now: number,
): AgentPool[] | { error: string } {
  if (!Array.isArray(groups)) {
    return { error: "agy quota groups are missing" };
  }
  const pools: AgentPool[] = [];
  for (const group of groups) {
    if (!isRecord(group) || !Array.isArray(group.buckets)) {
      return { error: "agy quota group is malformed" };
    }
    const rawName =
      typeof group.displayName === "string" && group.displayName !== "" ? group.displayName : group.name;
    if (typeof rawName !== "string") {
      return { error: "agy quota group is malformed" };
    }
    const target = AGY_POOLS[rawName];
    if (!target) {
      warnings.push(`unknown agy usage group "${rawName}"`);
      continue;
    }
    const windows: Window[] = [];
    for (const bucket of group.buckets) {
      if (!isRecord(bucket)) {
        return { error: `agy quota bucket in "${rawName}" is malformed` };
      }
      if (bucket.disabled === true) {
        continue;
      }
      const spec = typeof bucket.window === "string" ? AGY_WINDOWS[bucket.window] : undefined;
      if (!spec) {
        warnings.push(`unknown agy usage window ${JSON.stringify(bucket.window)} in "${rawName}"`);
        continue;
      }
      const fraction = readBucketFraction(bucket);
      const resetsAt = parseAgyResetTime(bucket.resetTime ?? bucket.reset_time);
      if (typeof fraction !== "number" || !Number.isFinite(fraction) || Number.isNaN(resetsAt)) {
        return { error: `agy ${bucket.window} bucket in "${rawName}" has an unreadable value` };
      }
      windows.push(window(100 * (1 - fraction), resetsAt, spec.kind, spec.hours));
    }
    if (windows.length > 0) {
      pools.push({ id: target.id, agent: "agy", keys: target.keys, windows });
    }
  }
  if (pools.length === 0) {
    return { error: "agy has no enabled buckets in a known group" };
  }
  return pools;
}

/** Maps the `agy -p /usage --output-format json` result (R12) to pools; an unreadable result sets `error`. */
export function parseAgyUsage(raw: unknown, now: number): AgentReading {
  const warnings: string[] = [];
  const fail = (error: string): AgentReading => unreadable("agy", error, warnings, now);

  if (!isRecord(raw) || raw.status !== "SUCCESS") {
    return fail(`agy /usage did not succeed: status ${JSON.stringify(isRecord(raw) ? raw.status : raw)}`);
  }
  if (raw.num_turns !== 0) {
    return fail(`agy /usage ran model turns: num_turns ${JSON.stringify(raw.num_turns)}`);
  }
  const data = isRecord(raw.command) && isRecord(raw.command.data) ? raw.command.data : null;
  if (!data || !Array.isArray(data.groups)) {
    return fail("agy /usage result has no command.data.groups");
  }

  const parsed = parseAgyGroups(data.groups, warnings, now);
  if (!Array.isArray(parsed)) {
    return fail(parsed.error);
  }
  return { agent: "agy", fetchedAt: now, pools: parsed, warnings };
}

function isAppResponseCodeOk(code: unknown): boolean {
  if (code === undefined || code === null) {
    return true;
  }
  if (typeof code === "number") {
    return code === 0;
  }
  if (typeof code === "string") {
    const lower = code.toLowerCase();
    return lower === "ok" || lower === "success" || code === "0";
  }
  return false;
}

function scrubTokens(text: string, tokens: readonly string[]): string {
  let cleaned = text;
  for (const token of tokens) {
    if (token) {
      cleaned = cleaned.replaceAll(token, "[redacted]");
    }
  }
  return cleaned;
}

/** Step 1: probes the running Antigravity app language server over loopback HTTPS; falls through on any failure. */
export async function readAgyApp(deps: AgyAppDeps, now: number): Promise<AgentReading | Fallthrough> {
  let psOutput: string;
  try {
    psOutput = await deps.ps();
  } catch {
    return { fallthrough: "no Antigravity app server" };
  }
  const servers = findAgyAppServers(psOutput);
  if (servers.length === 0) {
    return { fallthrough: "no Antigravity app server" };
  }

  const tokens = servers.map((s) => s.csrf);
  const scrub = (text: string): string => scrubTokens(text, tokens);
  let lastReason: string | undefined;

  for (const server of servers) {
    let ports: number[];
    try {
      ports = await deps.listeningPorts(server.pid);
    } catch {
      lastReason ??= "Antigravity app server unreachable";
      continue;
    }
    for (const port of ports) {
      let res: { status: number; body: string };
      try {
        res = await deps.post(
          port,
          APP_QUOTA_PATH,
          {
            "Content-Type": "application/json",
            "Connect-Protocol-Version": "1",
            "X-Codeium-Csrf-Token": server.csrf,
          },
          APP_REQUEST_BODY,
          APP_REQUEST_TIMEOUT_MS,
        );
      } catch {
        lastReason ??= "Antigravity app server unreachable";
        continue;
      }
      if (res.status !== 200) {
        lastReason = `Antigravity app server HTTP ${res.status}`;
        continue;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(res.body);
      } catch {
        lastReason = "Antigravity app server response is not JSON";
        continue;
      }
      if (!isRecord(raw) || Array.isArray(raw)) {
        lastReason = "Antigravity app server response is malformed";
        continue;
      }
      if (!isAppResponseCodeOk(raw.code)) {
        const label =
          typeof raw.code === "number" || typeof raw.code === "string" ? String(raw.code) : "invalid";
        lastReason = scrub(`Antigravity app server code ${label}`);
        continue;
      }
      const payload = isRecord(raw.response) ? raw.response : isRecord(raw.summary) ? raw.summary : raw;
      if (!Array.isArray(payload.groups)) {
        lastReason = "Antigravity app server response has no groups";
        continue;
      }
      const warnings: string[] = [];
      const parsed = parseAgyGroups(payload.groups, warnings, now);
      if (!Array.isArray(parsed)) {
        lastReason = scrub(parsed.error);
        continue;
      }
      return {
        agent: "agy",
        fetchedAt: now,
        pools: parsed,
        warnings: warnings.map(scrub),
        source: "app",
      };
    }
  }

  return { fallthrough: scrub(lastReason ?? "Antigravity app server unreachable") };
}

function postLocalHttps(
  port: number,
  path: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: { ...headers, "Content-Length": String(Buffer.byteLength(body)) },
        rejectUnauthorized: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        res.on("data", (chunk: Buffer) => {
          totalBytes += chunk.length;
          if (totalBytes > AGY_USAGE_MAX_BYTES) {
            req.destroy(new Error("response too large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
        res.on("error", reject);
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`request timed out after ${timeoutMs} ms`));
    });
    req.on("error", reject);
    req.end(body);
  });
}

export const agyAppDeps: AgyAppDeps = {
  async ps(): Promise<string> {
    const { stdout } = await execFileAsync("ps", ["-ax", "-o", "pid=,command="], {
      timeout: APP_PROBE_TIMEOUT_MS,
      maxBuffer: AGY_USAGE_MAX_BYTES,
    });
    return stdout;
  },
  async listeningPorts(pid: number): Promise<number[]> {
    try {
      const { stdout } = await execFileAsync(
        "lsof",
        ["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", String(pid)],
        { timeout: APP_PROBE_TIMEOUT_MS, maxBuffer: AGY_USAGE_MAX_BYTES },
      );
      return parseListeningPorts(stdout);
    } catch (err) {
      const e = err as { code?: number | string; stdout?: string; stderr?: string };
      // lsof exits 1 with empty stderr when the pid has no listening sockets.
      if (e.code === 1 && !(e.stderr ?? "").trim()) {
        return parseListeningPorts(e.stdout ?? "");
      }
      throw err;
    }
  },
  post: postLocalHttps,
};

export const agyDeps: AgyDeps = {
  app: agyAppDeps,
  cli: (bin, env) => readAgyUsage(bin, undefined, env),
};

/** `agy -p /usage` first; on failure probes the app server for `@default` (no `HOME` overlay). Never throws. */
export async function readAgy(
  bin: string,
  deps: AgyDeps = agyDeps,
  env?: Record<string, string>,
): Promise<AgentReading> {
  let cli: AgentReading;
  try {
    cli = await deps.cli(bin, env);
  } catch (err) {
    cli = unreadable("agy", `agy /usage failed: ${errorMessage(err)}`, [], Date.now());
  }
  if (!cli.error) {
    return { ...cli, source: "cli" };
  }
  if (env?.HOME) {
    return cli;
  }
  const app = await readAgyApp(deps.app, Date.now());
  if (!("fallthrough" in app) && !app.error) {
    return app;
  }
  return { ...cli, error: `${cli.error} (app: ${"fallthrough" in app ? app.fallthrough : app.error})` };
}

/** Never throws; `timeoutMs` exists so the timeout path is testable. */
export async function readAgyUsage(
  bin: string,
  timeoutMs = AGY_USAGE_TIMEOUT_MS,
  overlay?: Record<string, string>,
): Promise<AgentReading> {
  const fail = (error: string): AgentReading => unreadable("agy", error);
  const env = workerEnv({ ...overlay, AGY_CLI_DISABLE_AUTO_UPDATE: "true" });

  const versionRun = await runAgyCommand(bin, ["--version"], {
    env,
    timeoutMs: AGY_VERSION_TIMEOUT_MS,
    label: "agy --version",
  });
  if (versionRun.error !== undefined) {
    return fail(versionRun.error);
  }
  const versionOut = versionRun.stdout ?? "";
  const version = parseAgyVersion(versionOut);
  if (!version) {
    const rawVersion = firstLine(versionOut) || "(empty)";
    return fail(`agy version ${JSON.stringify(rawVersion)} is unreadable; requires agy >= 1.1.11`);
  }
  if (!isVersionAtLeast(version, AGY_MIN_VERSION)) {
    return fail(`agy ${version.join(".")} is below 1.1.11; /usage requires agy >= 1.1.11`);
  }

  let guard: { dir: string; launcher: string };
  try {
    guard = await installBrowserGuard();
  } catch (err) {
    return fail(`agy /usage browser guard failed: ${errorLine(err)}`);
  }

  const pathWithGuard = env.PATH ? `${guard.dir}${delimiter}${env.PATH}` : guard.dir;
  let usageRun: { stdout?: string; error?: string };
  try {
    usageRun = await runAgyCommand(bin, ["-p", "/usage", "--output-format", "json"], {
      cwd: guard.dir,
      env: { ...env, PATH: pathWithGuard, BROWSER: guard.launcher },
      timeoutMs,
      label: "agy /usage",
    });
  } finally {
    await rm(guard.dir, { recursive: true, force: true }).catch(() => {});
  }
  if (usageRun.error !== undefined) {
    return fail(usageRun.error);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(usageRun.stdout ?? "");
  } catch {
    return fail("agy /usage output is not JSON");
  }
  return parseAgyUsage(raw, Date.now());
}

/** A credit lane's launch: its key in this spawn's env, and the mandatory key-mode `authenticate` (V11). agy has no budget stop. */
export const agyCreditSpec = (spec: LaunchSpec, key: string, _budgetUsd: number): LaunchSpec => ({
  ...spec,
  env: { ...spec.env, GEMINI_API_KEY: key },
  authenticate: { methodId: "gemini-api-key" },
});

/** The vendor's credit exhaustion error (assumed text until a real event shows it). */
export const agyCreditExhausted = (f: WorkerFailure): boolean =>
  /Error 402\b|payment[ _]required|prepay\w* credits? (are )?depleted|spend(ing)? cap/i.test(f.message);

/** A rejected key spent nothing, so the pool is not drained. */
export const agyCreditUnspent = (f: WorkerFailure): boolean =>
  /API key not valid|API_KEY_INVALID/.test(f.message);

export const agyAdapter: AgentAdapter = {
  id: "agy",
  home: { env: "HOME", login: [] },

  isClient(clientName: string): boolean {
    return clientName === "antigravity-client";
  },

  async find(bin: string, env?: Record<string, string>): Promise<{ version: string } | { error: string }> {
    try {
      return { version: await versionLine(bin, workerEnv({ ...env, AGY_CLI_DISABLE_AUTO_UPDATE: "true" })) };
    } catch (err) {
      return { error: errorMessage(err) };
    }
  },

  readUsage(bin: string, env?: Record<string, string>): Promise<AgentReading> {
    return readAgy(bin, undefined, env);
  },

  async launch(lane: Lane, _cwd: string, bin: string, env?: Record<string, string>): Promise<LaunchSpec> {
    const credit = lane.key === "gemini-credits";
    let args = ["acp"];
    if (credit) {
      const home = join(dataDir(), "credit-homes", keyId(lane.key, lane.account));
      await mkdir(home, { recursive: true, mode: 0o700 });
      args = ["acp", "--gemini-dir", home];
    }
    return {
      command: bin,
      args,
      env: workerEnv({ ...env, AGY_CLI_DISABLE_AUTO_UPDATE: "true" }),
      config: { model: lane.model, effort: lane.effort },
      failReply: AGY_FAIL_REPLY,
    };
  },

  classifyFailure(f: WorkerFailure): "quota" | "failed" {
    return AGY_QUOTA_RE.test(f.message) ? "quota" : "failed";
  },
};
