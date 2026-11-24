import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, it } from "node:test";
import { adaptersDir, ensureAdapters } from "../src/agents/shared.ts";

const freshEnv = (): NodeJS.ProcessEnv => ({
  XDG_DATA_HOME: mkdtempSync(join(tmpdir(), "schmear-adapters-")),
});

function fakeCi(): { calls: string[]; ci: (cwd: string) => Promise<void> } {
  const calls: string[] = [];
  return {
    calls,
    ci: async (cwd) => {
      calls.push(cwd);
      await mkdir(join(cwd, "node_modules", "ok"), { recursive: true });
    },
  };
}

const tmpSiblings = (dir: string): string[] =>
  readdirSync(dirname(dir)).filter((name) => name.startsWith(`${basename(dir)}.tmp-`));

describe("ensureAdapters", () => {
  it("installs into adaptersDir and deletes other pin sets' trees", async () => {
    const env = freshEnv();
    const dir = adaptersDir(env);
    const parent = dirname(dir);
    for (const name of ["stale", "0000000000000000", `${basename(dir)}.tmp-keep`]) {
      mkdirSync(join(parent, name), { recursive: true });
    }
    const { calls, ci } = fakeCi();
    await ensureAdapters(env, ci);
    assert.equal(calls.length, 1);
    assert.ok(existsSync(join(dir, "node_modules", "ok")));
    assert.ok(existsSync(join(dir, "package-lock.json")));
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.deepEqual(readdirSync(parent).sort(), [basename(dir), `${basename(dir)}.tmp-keep`]);
  });

  it("does not reinstall an existing tree", async () => {
    const env = freshEnv();
    const { calls, ci } = fakeCi();
    await ensureAdapters(env, ci);
    await ensureAdapters(env, ci);
    assert.equal(calls.length, 1);
  });

  it("shares one install between concurrent calls", async () => {
    const env = freshEnv();
    const { calls, ci } = fakeCi();
    await Promise.all([ensureAdapters(env, ci), ensureAdapters(env, ci)]);
    assert.equal(calls.length, 1);
  });

  it("fails with the cause, leaves nothing behind, and retries on the next call", async () => {
    const env = freshEnv();
    const dir = adaptersDir(env);
    await assert.rejects(
      ensureAdapters(env, async () => {
        throw new Error("boom");
      }),
      (err: Error) =>
        /could not install the Claude and Codex ACP adapters: boom/.test(err.message) &&
        /schmear init --yes/.test(err.message),
    );
    assert.ok(!existsSync(dir));
    assert.deepEqual(tmpSiblings(dir), []);
    const { calls, ci } = fakeCi();
    await ensureAdapters(env, ci);
    assert.equal(calls.length, 1);
    assert.ok(existsSync(dir));
  });

  it("succeeds when another process installed the tree first", async () => {
    const env = freshEnv();
    const dir = adaptersDir(env);
    await ensureAdapters(env, async () => {
      await mkdir(dir);
      await writeFile(join(dir, "theirs"), "");
    });
    assert.ok(existsSync(join(dir, "theirs")));
    assert.deepEqual(tmpSiblings(dir), []);
  });
});

describe("shipped adapter lock", () => {
  const root = new URL("../adapters/", import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
  const lock = JSON.parse(readFileSync(new URL("package-lock.json", root), "utf8"));

  it("matches the manifest's pins", () => {
    assert.deepEqual(manifest.dependencies, lock.packages[""].dependencies);
  });

  it("pins every package by sha512 from the npm registry, with no install script", () => {
    for (const [path, entry] of Object.entries(lock.packages) as [string, Record<string, unknown>][]) {
      if (path === "") {
        continue;
      }
      assert.match(String(entry.integrity), /^sha512-/, path);
      assert.ok(String(entry.resolved).startsWith("https://registry.npmjs.org/"), path);
      assert.equal(entry.hasInstallScript, undefined, path);
    }
  });
});
