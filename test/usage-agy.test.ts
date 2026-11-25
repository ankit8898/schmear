import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, mock } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  AGY_USAGE_TIMEOUT_MS,
  type AgyAppDeps,
  findAgyAppServers,
  parseAgyGroups,
  parseAgyUsage,
  parseAgyVersion,
  parseListeningPorts,
  readAgy,
  readAgyApp,
  readAgyUsage,
} from "../src/agents/agy.ts";
import type { AgentReading } from "../src/types.ts";

const NOW = Date.parse("2026-11-28T00:00:00Z");
const fixturePath = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
type Json = {
  num_turns?: unknown;
  command: { data: { groups: { buckets: Record<string, unknown>[] }[] } };
};
const fixture = (name: string): Json => JSON.parse(readFileSync(fixturePath(name), "utf8"));
const FAKE_AGY = fileURLToPath(new URL("./fake-agy.ts", import.meta.url));

async function waitFor(ok: () => boolean): Promise<void> {
  // 10 s: a fake agy subprocess can take seconds to start on a loaded machine.
  for (let i = 0; i < 500 && !ok(); i++) {
    await sleep(20);
  }
  assert.equal(ok(), true, "condition not met in time");
}

describe("parseAgyVersion", () => {
  it("extracts major.minor.patch from the first line", () => {
    assert.deepEqual(parseAgyVersion("1.5.14\n"), [1, 5, 14]);
    assert.deepEqual(parseAgyVersion("agy 1.1.11 (abc)\nextra"), [1, 1, 11]);
    assert.deepEqual(parseAgyVersion("v1.1.10-beta.1"), [1, 1, 10]);
    assert.equal(parseAgyVersion("unknown"), null);
    assert.equal(parseAgyVersion(""), null);
  });
});

describe("parseAgyUsage", () => {
  it("maps groups to pools and windows, skipping the disabled bucket", () => {
    const r = parseAgyUsage(fixture("agy-usage.json"), NOW);
    assert.equal(r.error, undefined);
    assert.deepEqual(r.warnings, []);
    assert.equal(r.agent, "agy");
    assert.equal(r.fetchedAt, NOW);
    assert.deepEqual(
      r.pools.map((p) => [p.id, p.keys, p.windows.length]),
      [
        ["agy-gemini", ["agy-gemini", "agy-argon"], 2],
        ["agy-3p", ["agy-3p"], 1],
        ["agy-argon", ["agy-argon"], 1],
      ],
    );
    const [weekly, short] = r.pools[0].windows;
    assert.deepEqual(
      [weekly.kind, weekly.periodHours, weekly.resetsAt],
      ["period", 168, Date.parse("2026-12-05T08:00:00Z")],
    );
    assert.ok(Math.abs(weekly.remaining - 0.75) < 1e-9);
    assert.deepEqual(
      [short.kind, short.periodHours, short.resetsAt],
      ["short", 5, Date.parse("2026-11-29T03:00:00Z")],
    );
    assert.ok(Math.abs(short.remaining - 0.5) < 1e-9);
    assert.equal(r.pools[1].windows[0].remaining, 0);
  });

  it("warns on an unknown group and keeps the known ones", () => {
    const r = parseAgyUsage(fixture("agy-usage-unknown-group.json"), NOW);
    assert.equal(r.error, undefined);
    assert.deepEqual(r.warnings, ['unknown agy usage group "Imagen Models"']);
    assert.deepEqual(
      r.pools.map((p) => p.id),
      ["agy-gemini"],
    );
  });

  it("is unreadable on a non-SUCCESS status", () => {
    const r = parseAgyUsage(fixture("agy-usage-error.json"), NOW);
    assert.match(r.error ?? "", /status "ERROR"/);
    assert.deepEqual(r.pools, []);
  });

  it("is unreadable when num_turns is not 0", () => {
    for (const turns of [1, 2, undefined, null, "0"]) {
      const raw = fixture("agy-usage.json");
      if (turns === undefined) {
        delete raw.num_turns;
      } else {
        raw.num_turns = turns;
      }
      const r = parseAgyUsage(raw, NOW);
      assert.match(r.error ?? "", /num_turns/, `turns=${String(turns)}`);
      assert.deepEqual(r.pools, []);
    }
  });

  it("is unreadable on malformed input", () => {
    const noGroups = { status: "SUCCESS", num_turns: 0, command: { data: {} } };
    const badRemaining = fixture("agy-usage.json");
    badRemaining.command.data.groups[0].buckets[0].remaining_fraction = "84%";
    const badReset = fixture("agy-usage.json");
    badReset.command.data.groups[0].buckets[0].reset_time = "soon";
    const onlyDisabled = fixture("agy-usage.json");
    onlyDisabled.command.data.groups = [
      {
        name: "Gemini Models",
        buckets: [{ window: "5h", remaining_fraction: 1, disabled: true }],
      },
    ] as unknown as Json["command"]["data"]["groups"];
    for (const raw of [null, "SUCCESS", {}, noGroups, badRemaining, badReset, onlyDisabled]) {
      const r = parseAgyUsage(raw, NOW);
      assert.ok(r.error, JSON.stringify(raw)?.slice(0, 60));
      assert.deepEqual(r.pools, []);
    }
  });

  it("warns on an unknown window and skips it", () => {
    const raw = fixture("agy-usage.json");
    raw.command.data.groups[0].buckets[1].window = "monthly";
    const r = parseAgyUsage(raw, NOW);
    assert.equal(r.error, undefined);
    assert.equal(r.pools[0].windows.length, 1);
    assert.match(r.warnings[0], /unknown agy usage window "monthly"/);
  });
});

describe("readAgyUsage", () => {
  async function run(env: Record<string, string>, timeoutMs?: number) {
    const prev = { ...process.env };
    Object.assign(process.env, env);
    try {
      return await readAgyUsage(FAKE_AGY, timeoutMs);
    } finally {
      for (const k of Object.keys(env)) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
    }
  }

  function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = mkdtempSync(join(tmpdir(), "schmear-agy-test-"));
    return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
  }

  it("runs the usage command and parses its output", async () => {
    const r = await run({ FAKE_AGY_OUT: fixturePath("agy-usage.json") });
    assert.equal(r.error, undefined);
    assert.equal(r.pools.length, 3);
  });

  it("accepts agy 1.1.11 and rejects versions below 1.1.11 without calling /usage", async () => {
    await withTempDir(async (dir) => {
      const ok = await run({
        FAKE_AGY_VERSION: "1.1.11",
        FAKE_AGY_OUT: fixturePath("agy-usage.json"),
      });
      assert.equal(ok.error, undefined);
      assert.equal(ok.pools.length, 3);

      for (const version of ["1.1.10", "1.0.99", "0.9.5"]) {
        const log = join(dir, `log-${version}`);
        const r = await run({
          FAKE_AGY_VERSION: version,
          FAKE_AGY_LOG: log,
          FAKE_AGY_OUT: fixturePath("agy-usage.json"),
        });
        assert.match(r.error ?? "", new RegExp(version.replaceAll(".", "\\.")));
        assert.match(r.error ?? "", /1\.1\.11/);
        assert.deepEqual(r.pools, []);
        assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), ["--version"]);
      }

      const badLog = join(dir, "log-bad");
      const unreadable = await run({
        FAKE_AGY_VERSION: "unknown-build",
        FAKE_AGY_LOG: badLog,
        FAKE_AGY_OUT: fixturePath("agy-usage.json"),
      });
      assert.match(unreadable.error ?? "", /unknown-build/);
      assert.deepEqual(readFileSync(badLog, "utf8").trim().split("\n"), ["--version"]);

      const failLog = join(dir, "log-fail");
      const failed = await run({
        FAKE_AGY_VERSION_FAIL: "1",
        FAKE_AGY_LOG: failLog,
        FAKE_AGY_OUT: fixturePath("agy-usage.json"),
      });
      assert.match(failed.error ?? "", /--version failed/);
      assert.deepEqual(readFileSync(failLog, "utf8").trim().split("\n"), ["--version"]);
    });
  });

  it("installs failing browser launchers in a private probe dir and removes it on success and failure", async () => {
    await withTempDir(async (dir) => {
      const inspectOk = join(dir, "inspect-ok.json");
      const ok = await run({
        FAKE_AGY_INSPECT: inspectOk,
        FAKE_AGY_OUT: fixturePath("agy-usage.json"),
      });
      assert.equal(ok.error, undefined);
      const info = JSON.parse(readFileSync(inspectOk, "utf8")) as {
        cwd: string;
        pathHead: string;
        browser: string;
        browserDir: string;
        open: { status: number | null; error: string | null };
        xdgOpen: { status: number | null; error: string | null };
        browserExec: { status: number | null; error: string | null };
      };
      assert.equal(info.pathHead, info.cwd);
      assert.equal(info.browserDir, info.cwd);
      assert.equal(info.open.status, 1);
      assert.equal(info.xdgOpen.status, 1);
      assert.equal(info.browserExec.status, 1);
      assert.equal(existsSync(info.cwd), false);

      const inspectFail = join(dir, "inspect-fail.json");
      const failed = await run({
        FAKE_AGY_INSPECT: inspectFail,
        FAKE_AGY_FAIL: "1",
      });
      assert.match(failed.error ?? "", /agy \/usage failed/);
      assert.equal(failed.error?.includes("FAKE_AGY_SECRET_STDERR"), false);
      const failInfo = JSON.parse(readFileSync(inspectFail, "utf8")) as { cwd: string };
      assert.equal(existsSync(failInfo.cwd), false);
    });
  });

  it("does not run /usage if the browser guard cannot be installed", async () => {
    await withTempDir(async (dir) => {
      const notADir = join(dir, "not-a-dir");
      const log = join(dir, "log");
      writeFileSync(notADir, "x", "utf8");
      const r = await run({
        TMPDIR: notADir,
        FAKE_AGY_LOG: log,
        FAKE_AGY_OUT: fixturePath("agy-usage.json"),
      });
      assert.match(r.error ?? "", /browser guard failed/);
      assert.deepEqual(r.pools, []);
      assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), ["--version"]);
    });
  });

  it("reports a non-SUCCESS status as unreadable", async () => {
    const r = await run({ FAKE_AGY_OUT: fixturePath("agy-usage-error.json") });
    assert.match(r.error ?? "", /status "ERROR"/);
  });

  it("reports non-JSON output and a failing binary as unreadable", async () => {
    const notJson = await run({ FAKE_AGY_OUT: fileURLToPath(import.meta.url) });
    assert.match(notJson.error ?? "", /not JSON/);
    const missing = await readAgyUsage("/nonexistent/agy");
    assert.match(missing.error ?? "", /failed/);
  });

  it("reports a timeout as unreadable and cleans up the probe dir", async () => {
    await withTempDir(async (dir) => {
      const inspect = join(dir, "inspect-timeout.json");
      const r = await run({ FAKE_AGY_HANG: "1", FAKE_AGY_INSPECT: inspect }, 1000);
      assert.match(r.error ?? "", /timed out after 1000 ms/);
      const info = JSON.parse(readFileSync(inspect, "utf8")) as { cwd: string };
      assert.equal(existsSync(info.cwd), false);
    });
  });

  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it("ends at the timeout when agy ignores SIGTERM, and kills it", async () => {
    await withTempDir(async (dir) => {
      const pidFile = join(dir, "pid");
      const started = Date.now();
      const r = await run({ FAKE_AGY_HANG: "1", FAKE_AGY_IGNORE_TERM: "1", FAKE_AGY_PID: pidFile }, 1000);
      assert.match(r.error ?? "", /timed out after 1000 ms/);
      assert.ok(Date.now() - started < 2500, "read outlived its timeout");
      const pid = Number(readFileSync(pidFile, "utf8"));
      await waitFor(() => !alive(pid));
    });
  });

  it("returns promptly when agy exits leaving a background child holding stdout, and kills the child", async () => {
    await withTempDir(async (dir) => {
      const bgFile = join(dir, "bg-pid");
      const started = Date.now();
      const r = await run({ FAKE_AGY_BG_PID: bgFile, FAKE_AGY_OUT: fixturePath("agy-usage.json") }, 20_000);
      assert.equal(r.error, undefined);
      assert.equal(r.pools.length, 3);
      assert.ok(Date.now() - started < 5000, "read waited on the background child");
      const bg = Number(readFileSync(bgFile, "utf8"));
      await waitFor(() => !alive(bg));
    });
  });

  it("defaults to CodexBar's 90 s timeout", async () => {
    assert.equal(AGY_USAGE_TIMEOUT_MS, 90_000);
    await withTempDir(async (dir) => {
      const inspect = join(dir, "inspect-90s.json");
      mock.timers.enable({ apis: ["setTimeout"] });
      try {
        const pending = run({ FAKE_AGY_HANG: "1", FAKE_AGY_INSPECT: inspect });
        await waitFor(() => existsSync(inspect));
        mock.timers.tick(90_000);
        const r = await pending;
        assert.match(r.error ?? "", /timed out after 90000 ms/);
        const info = JSON.parse(readFileSync(inspect, "utf8")) as { cwd: string };
        assert.equal(existsSync(info.cwd), false);
      } finally {
        mock.timers.reset();
      }
    });
  });
});

const SYNTHETIC_CSRF = "synthetic-csrf-Token-123";

function appServerBody(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    code: 0,
    response: {
      groups: [
        {
          displayName: "Gemini Models",
          buckets: [
            {
              window: "weekly",
              remainingFraction: 0.75,
              resetTime: "2026-12-05T08:00:00Z",
            },
            {
              window: "5h",
              remaining: { remainingFraction: 0.5 },
              resetTime: 1796457600,
            },
          ],
        },
        {
          displayName: "Claude and GPT models",
          buckets: [{ window: "weekly", remainingFraction: 0.25, resetTime: "2026-12-02T06:00:00Z" }],
        },
      ],
    },
    ...extra,
  });
}

describe("findAgyAppServers", () => {
  it("keeps Antigravity app language_server processes with a CSRF token and skips IDE, CLI, and tokenless lines", () => {
    const psOutput = [
      "  PID COMMAND",
      `  101 /Applications/Antigravity.app/Contents/MacOS/language_server_macos_arm --app_data_dir antigravity --csrf_token ${SYNTHETIC_CSRF}`,
      `  102 /Applications/Gemini.app/Contents/Resources/language_server_macos_arm --csrf_token=tok-Gemini-2`,
      `  103 /opt/antigravity/language-server-linux-x64 --app_data_dir antigravity --csrf_token=tok-linux-3`,
      // IDE processes must be ignored
      "  201 /Applications/Antigravity IDE.app/Contents/MacOS/language_server_macos_arm --app_data_dir antigravity --csrf_token tok-ide-1",
      "  202 /Applications/Antigravity.app/Contents/MacOS/language_server --app_data_dir antigravity-ide --csrf_token tok-ide-2",
      "  203 /usr/local/bin/language_server --app_data_dir=antigravity-ide --csrf_token tok-ide-3",
      "  204 /Users/me/.vscode/extensions/antigravity/bin/language_server --app_data_dir antigravity --csrf_token tok-ide-4",
      // CLI processes must be ignored
      "  301 /usr/local/bin/agy acp",
      "  302 /usr/local/bin/antigravity-cli --app_data_dir antigravity --csrf_token tok-cli",
      // App server without CSRF token must be skipped
      "  401 /Applications/Antigravity.app/Contents/MacOS/language_server_macos_arm --app_data_dir antigravity",
      // Unrelated language servers must be ignored
      "  501 /Applications/NotGemini.app/Contents/MacOS/language_server --csrf_token tok-other",
      "  502 /usr/bin/typescript-language-server --csrf_token tok-ts",
    ].join("\n");

    assert.deepEqual(findAgyAppServers(psOutput), [
      { pid: 101, csrf: SYNTHETIC_CSRF },
      { pid: 102, csrf: "tok-Gemini-2" },
      { pid: 103, csrf: "tok-linux-3" },
    ]);
  });
});

describe("parseListeningPorts", () => {
  it("parses deduplicated sorted TCP LISTEN ports from lsof output", () => {
    const lsofOutput = [
      "COMMAND     PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME",
      "language_ 101 user   12u  IPv4 0x111      0t0  TCP 127.0.0.1:54322 (LISTEN)",
      "language_ 101 user   13u  IPv6 0x222      0t0  TCP [::1]:54321 (LISTEN)",
      "language_ 101 user   14u  IPv4 0x333      0t0  TCP *:54322 (LISTEN)",
      "language_ 101 user   15u  IPv4 0x444      0t0  TCP 127.0.0.1:54322->127.0.0.1:55555 (ESTABLISHED)",
    ].join("\n");

    assert.deepEqual(parseListeningPorts(lsofOutput), [54321, 54322]);
    assert.deepEqual(parseListeningPorts(""), []);
  });
});

describe("parseAgyGroups", () => {
  it("maps camelCase app groups, nested remainingFraction, and epoch-seconds reset times", () => {
    const warnings: string[] = [];
    const pools = parseAgyGroups(
      [
        {
          displayName: "Gemini Models",
          buckets: [
            {
              window: "weekly",
              remainingFraction: 0.75,
              resetTime: "2026-12-05T08:00:00Z",
            },
            {
              window: "5h",
              remaining: { remainingFraction: 0.5 },
              resetTime: 1796457600,
            },
          ],
        },
        {
          name: "Gemini 4 Argon",
          buckets: [
            {
              window: "weekly",
              remaining: { case: "remainingFraction", value: 0.25 },
              reset_time: "1796455800",
            },
          ],
        },
        {
          displayName: "Claude and GPT models",
          buckets: [{ window: "5h", remaining_fraction: 1, disabled: true }],
        },
      ],
      warnings,
      NOW,
    );

    assert.deepEqual(warnings, []);
    assert.ok(Array.isArray(pools));
    assert.equal(pools.length, 2);
    assert.equal(pools[0].id, "agy-gemini");
    assert.deepEqual(pools[0].windows[0], {
      kind: "period",
      remaining: 0.75,
      resetsAt: Date.parse("2026-12-05T08:00:00Z"),
      periodHours: 168,
    });
    assert.deepEqual(pools[0].windows[1], {
      kind: "short",
      remaining: 0.5,
      resetsAt: 1796457600 * 1000,
      periodHours: 5,
    });
    assert.equal(pools[1].id, "agy-argon");
    assert.deepEqual(pools[1].windows[0], {
      kind: "period",
      remaining: 0.25,
      resetsAt: 1796455800 * 1000,
      periodHours: 168,
    });
  });

  it("returns an error when no known group has an enabled bucket", () => {
    const warnings: string[] = [];
    const res = parseAgyGroups(
      [{ displayName: "Imagen Models", buckets: [{ window: "weekly", remainingFraction: 0.9 }] }],
      warnings,
      NOW,
    );
    assert.ok(!Array.isArray(res));
    assert.ok(res.error);
    assert.deepEqual(warnings, ['unknown agy usage group "Imagen Models"']);
  });
});

describe("readAgyApp", () => {
  const PS_ONE = `101 /Applications/Antigravity.app/Contents/MacOS/language_server_macos_arm --app_data_dir antigravity --csrf_token ${SYNTHETIC_CSRF}`;

  it("picks the first port returning 200 with a valid pool and sends the expected headers and body", async () => {
    const seenPosts: {
      port: number;
      path: string;
      headers: Record<string, string>;
      body: string;
      timeoutMs: number;
    }[] = [];

    const deps: AgyAppDeps = {
      ps: async () => PS_ONE,
      listeningPorts: async (pid) => {
        assert.equal(pid, 101);
        return [5001, 5002, 5003, 5004];
      },
      post: async (port, path, headers, body, timeoutMs) => {
        seenPosts.push({ port, path, headers, body, timeoutMs });
        if (port === 5001) {
          throw new Error("ECONNREFUSED");
        }
        if (port === 5002) {
          return { status: 404, body: "not found" };
        }
        return { status: 200, body: appServerBody() };
      },
    };

    const r = await readAgyApp(deps, NOW);
    assert.ok(!("fallthrough" in r));
    assert.equal(r.source, "app");
    assert.equal(r.fetchedAt, NOW);
    assert.equal(r.pools.length, 2);
    assert.equal(r.pools[0].id, "agy-gemini");
    assert.equal(r.pools[1].id, "agy-3p");
    assert.deepEqual(
      seenPosts.map((p) => p.port),
      [5001, 5002, 5003],
    );
    assert.equal(seenPosts[2].path, "/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary");
    assert.deepEqual(seenPosts[2].headers, {
      "Content-Type": "application/json",
      "Connect-Protocol-Version": "1",
      "X-Codeium-Csrf-Token": SYNTHETIC_CSRF,
    });
    assert.deepEqual(JSON.parse(seenPosts[2].body), {
      metadata: {
        ideName: "antigravity",
        extensionName: "antigravity",
        ideVersion: "unknown",
        locale: "en",
      },
    });
    assert.equal(seenPosts[2].timeoutMs, 5000);
    assert.equal(JSON.stringify(r).includes(SYNTHETIC_CSRF), false);
  });

  it("supports summary and top-level groups payloads", async () => {
    for (const payload of [
      {
        summary: {
          groups: [{ displayName: "Gemini Models", buckets: [{ window: "5h", remainingFraction: 0.4 }] }],
        },
      },
      { groups: [{ displayName: "Gemini Models", buckets: [{ window: "5h", remainingFraction: 0.4 }] }] },
    ]) {
      const r = await readAgyApp(
        {
          ps: async () => PS_ONE,
          listeningPorts: async () => [5001],
          post: async () => ({ status: 200, body: JSON.stringify(payload) }),
        },
        NOW,
      );
      assert.ok(!("fallthrough" in r));
      assert.equal(r.source, "app");
      assert.equal(r.pools.length, 1);
    }
  });

  it("falls through when no app server is running", async () => {
    const r = await readAgyApp(
      {
        ps: async () => "201 /usr/local/bin/agy acp\n",
        listeningPorts: async () => {
          throw new Error("should not run");
        },
        post: async () => {
          throw new Error("should not run");
        },
      },
      NOW,
    );
    assert.deepEqual(r, { fallthrough: "no Antigravity app server" });
  });

  it("falls through on non-200, non-zero code, and no known group without leaking the CSRF token", async () => {
    const cases: { name: string; status: number; body: string }[] = [
      { name: "non-200", status: 503, body: `error ${SYNTHETIC_CSRF}` },
      { name: "non-zero numeric code", status: 200, body: appServerBody({ code: 7 }) },
      {
        name: "non-zero string code",
        status: 200,
        body: appServerBody({ code: `PERMISSION_DENIED_${SYNTHETIC_CSRF}` }),
      },
      {
        name: "no known group",
        status: 200,
        body: JSON.stringify({
          code: "OK",
          response: {
            groups: [
              {
                displayName: `Unknown_${SYNTHETIC_CSRF}`,
                buckets: [{ window: "weekly", remainingFraction: 0.5 }],
              },
            ],
          },
        }),
      },
    ];

    for (const c of cases) {
      const r = await readAgyApp(
        {
          ps: async () => PS_ONE,
          listeningPorts: async () => [5001],
          post: async () => ({ status: c.status, body: c.body }),
        },
        NOW,
      );
      assert.ok("fallthrough" in r, c.name);
      assert.equal(r.fallthrough.includes(SYNTHETIC_CSRF), false, `${c.name} leaked CSRF`);
    }
  });

  it("never leaks the CSRF token in warnings when echoed in an unknown group or window", async () => {
    const r = await readAgyApp(
      {
        ps: async () => PS_ONE,
        listeningPorts: async () => [5001],
        post: async () => ({
          status: 200,
          body: JSON.stringify({
            response: {
              groups: [
                {
                  displayName: `Extra_${SYNTHETIC_CSRF}`,
                  buckets: [{ window: "weekly", remainingFraction: 0.5 }],
                },
                {
                  displayName: "Gemini Models",
                  buckets: [
                    { window: `weird_${SYNTHETIC_CSRF}`, remainingFraction: 0.5 },
                    { window: "weekly", remainingFraction: 0.8 },
                  ],
                },
              ],
            },
          }),
        }),
      },
      NOW,
    );
    assert.ok(!("fallthrough" in r));
    assert.equal(JSON.stringify(r).includes(SYNTHETIC_CSRF), false);
  });
});

describe("readAgy", () => {
  const PS_ONE = `101 /Applications/Antigravity.app/Contents/MacOS/language_server_macos_arm --app_data_dir antigravity --csrf_token ${SYNTHETIC_CSRF}`;

  const cliPools = [{ id: "agy-gemini", agent: "agy" as const, keys: ["agy-gemini" as const], windows: [] }];

  it("returns the CLI reading with source: cli without probing the app server", async () => {
    let psCalled = false;
    const r = await readAgy("agy", {
      app: {
        ps: async () => {
          psCalled = true;
          return PS_ONE;
        },
        listeningPorts: async () => [5001],
        post: async () => ({ status: 200, body: appServerBody() }),
      },
      cli: async () => ({ agent: "agy", fetchedAt: NOW, pools: cliPools, warnings: [] }),
    });
    assert.equal(psCalled, false);
    assert.equal(r.error, undefined);
    assert.equal(r.source, "cli");
  });

  it("falls back to the app server when the CLI read fails or throws, and combines errors when both fail", async () => {
    const cliFails = async (): Promise<AgentReading> => ({
      agent: "agy",
      fetchedAt: NOW,
      pools: [],
      error: "agy /usage failed: exit 1",
      warnings: [],
    });
    const appOk = {
      ps: async () => PS_ONE,
      listeningPorts: async () => [5001],
      post: async () => ({ status: 200, body: appServerBody() }),
    };
    const viaApp = await readAgy("agy", { app: appOk, cli: cliFails });
    assert.equal(viaApp.error, undefined);
    assert.equal(viaApp.source, "app");
    assert.equal(viaApp.pools.length, 2);

    const thrown = await readAgy("agy", {
      app: appOk,
      cli: async () => {
        throw new Error("spawn ENOENT");
      },
    });
    assert.equal(thrown.source, "app");

    const bothFail = await readAgy("agy", {
      app: { ...appOk, post: async () => ({ status: 503, body: "" }) },
      cli: cliFails,
    });
    assert.equal(bothFail.error, "agy /usage failed: exit 1 (app: Antigravity app server HTTP 503)");
    assert.equal(bothFail.error?.includes(SYNTHETIC_CSRF), false);
  });

  it("never calls ps when an account HOME overlay is present, even when the CLI read fails", async () => {
    let psCalled = false;
    const app = {
      ps: async () => {
        psCalled = true;
        return PS_ONE;
      },
      listeningPorts: async () => [5001],
      post: async () => ({ status: 200, body: appServerBody() }),
    };
    const env = { HOME: "/tmp/agy-account-2" };
    const ok = await readAgy(
      "agy",
      {
        app,
        cli: async (_bin, e) => {
          assert.equal(e?.HOME, "/tmp/agy-account-2");
          return { agent: "agy", fetchedAt: NOW, pools: cliPools, warnings: [] };
        },
      },
      env,
    );
    assert.equal(ok.error, undefined);
    assert.equal(ok.source, "cli");

    const failed = await readAgy(
      "agy",
      {
        app,
        cli: async () => ({
          agent: "agy",
          fetchedAt: NOW,
          pools: [],
          error: "agy /usage failed: exit 1",
          warnings: [],
        }),
      },
      env,
    );
    assert.equal(failed.error, "agy /usage failed: exit 1");
    assert.equal(psCalled, false);
  });
});
