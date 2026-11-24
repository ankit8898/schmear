import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  type ClaudeDeps,
  type ClaudeOAuthToken,
  claudeAdapter,
  execSecurity,
  parseClaudeLimits,
  parseClaudeUsage,
  readClaude,
  readClaudeOAuth,
  readClaudeToken,
  readClaudeUsage,
} from "../src/agents/claude.ts";
import { unreadable } from "../src/util.ts";

const fixturePath = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url));
const fixture = async (name: string): Promise<Json[]> =>
  JSON.parse(await readFile(fixturePath(name), "utf8"));
// biome-ignore lint/suspicious/noExplicitAny: fixtures are edited by path; the parser checks their shape
type Json = Record<string, any>;
const NOW = Date.parse("2026-11-21T12:00:00Z");
const WEEK_RESET = Date.parse("2026-11-28T21:00:00.575560+00:00");
const EXTRA_WARNING_START = "Claude extra usage is on";

/** The `rate_limits` object of a cloned usage fixture, for editing. */
const limitsOf = (messages: Json[]): Json => messages[1]?.response.response.rate_limits;

describe("parseClaudeUsage", () => {
  it("maps seven_day and model_scoped Fable when five_hour is null", async () => {
    const reading = parseClaudeUsage(await fixture("claude-usage"), NOW);
    assert.deepEqual(reading, {
      agent: "claude",
      fetchedAt: NOW,
      warnings: [],
      pools: [
        {
          id: "claude",
          agent: "claude",
          keys: ["claude"],
          windows: [{ kind: "period", remaining: 0.63, resetsAt: WEEK_RESET, periodHours: 168 }],
        },
        {
          id: "claude-fable",
          agent: "claude",
          keys: ["claude"],
          models: ["fable"],
          windows: [
            {
              kind: "period",
              remaining: 0.88,
              resetsAt: Date.parse("2026-11-28T21:00:00.575720+00:00"),
              periodHours: 168,
            },
          ],
        },
      ],
    });
  });

  it("maps five_hour, opus and sonnet windows, falls back to seven_day_oauth_apps, warns on extra usage", async () => {
    const messages = await fixture("claude-usage");
    const limits = limitsOf(messages);
    limits.five_hour = { utilization: 30, resets_at: "2026-11-21T15:00:00+00:00" };
    limits.seven_day = null;
    limits.seven_day_oauth_apps = { utilization: 50, resets_at: "2026-11-27T00:00:00+00:00" };
    limits.seven_day_opus = { utilization: 100, resets_at: null };
    limits.seven_day_sonnet = { utilization: null, resets_at: "2026-11-27T00:00:00+00:00" };
    limits.extra_usage = { is_enabled: true, monthly_limit: 100, used_credits: 1, utilization: 1 };
    const reading = parseClaudeUsage(messages, NOW);
    assert.equal(reading.error, undefined);
    assert.deepEqual(
      reading.pools.map((p) => [p.id, p.models, p.windows.map((w) => [w.kind, w.remaining, w.periodHours])]),
      [
        [
          "claude",
          undefined,
          [
            ["short", 0.7, 5],
            ["period", 0.5, 168],
          ],
        ],
        ["claude-opus", ["opus"], [["period", 0, 168]]],
        ["claude-fable", ["fable"], [["period", 0.88, 168]]],
      ],
    );
    assert.equal(reading.pools[0]?.windows[0]?.resetsAt, Date.parse("2026-11-21T15:00:00Z"));
    assert.equal(reading.pools[1]?.windows[0]?.resetsAt, null);
    assert.equal(reading.warnings.length, 1);
    assert.ok(reading.warnings[0]?.startsWith(EXTRA_WARNING_START));
  });

  it("leaves an unknown model_scoped window unscoped with a warning", async () => {
    const messages = await fixture("claude-usage");
    limitsOf(messages).model_scoped = [{ display_name: "Quasar", utilization: 20, resets_at: null }];
    const reading = parseClaudeUsage(messages, NOW);
    const quasar = reading.pools.find((p) => p.id === "claude-quasar");
    assert.deepEqual(quasar?.keys, ["claude"]);
    assert.equal(quasar?.models, undefined);
    assert.deepEqual(reading.warnings, ["unknown Claude model window 'quasar'"]);
  });

  it("does not duplicate a pool a model_scoped row repeats", async () => {
    const messages = await fixture("claude-usage");
    const limits = limitsOf(messages);
    limits.seven_day_opus = { utilization: 10, resets_at: null };
    limits.model_scoped = [{ display_name: "Opus", utilization: 99, resets_at: null }];
    const opus = parseClaudeUsage(messages, NOW).pools.filter((p) => p.id === "claude-opus");
    assert.equal(opus.length, 1);
    assert.equal(opus[0]?.windows[0]?.remaining, 0.9);
  });

  it("is unreadable without a weekly window", async () => {
    const messages = await fixture("claude-usage");
    limitsOf(messages).seven_day = null;
    const reading = parseClaudeUsage(messages, NOW);
    assert.equal(reading.error, "Claude reports no weekly limit");
    assert.deepEqual(reading.pools, []);
  });

  it("is unreadable when rate_limits_available is false", async () => {
    const reading = parseClaudeUsage(await fixture("claude-unavailable"), NOW);
    assert.equal(reading.error, "Claude reports no plan limits for this login");
    assert.deepEqual(reading.pools, []);
  });

  it("is unreadable on subtype error, with the reason", async () => {
    const reading = parseClaudeUsage(await fixture("claude-error"), NOW);
    assert.equal(reading.error, "Claude get_usage failed: Unknown control request subtype: get_usage");
  });

  it("is unreadable without a `u` answer", async () => {
    const [init] = await fixture("claude-usage");
    assert.equal(parseClaudeUsage([init, "junk", null], NOW).error, "Claude get_usage gave no answer");
    assert.equal(parseClaudeUsage([], NOW).error, "Claude get_usage gave no answer");
  });

  it("adds the hooks warning for a hook_started message, also on an unreadable read", async () => {
    const hook = { type: "system", subtype: "hook_started", hook_name: "SessionStart" };
    const ok = parseClaudeUsage([hook, ...(await fixture("claude-usage"))], NOW);
    assert.equal(ok.error, undefined);
    assert.deepEqual(ok.warnings, ["Claude usage read ran your hooks"]);
    const bad = parseClaudeUsage([hook, ...(await fixture("claude-error"))], NOW);
    assert.ok(bad.error);
    assert.deepEqual(bad.warnings, ["Claude usage read ran your hooks"]);
  });
});

describe("readClaudeUsage", () => {
  const FAKE = fileURLToPath(new URL("./fake-claude.ts", import.meta.url));
  const saved = { state: process.env.XDG_STATE_HOME };
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "schmear-claude-"));
    process.env.XDG_STATE_HOME = join(dir, "state");
    process.env.FAKE_CLAUDE_LOG = join(dir, "log");
    delete process.env.FAKE_CLAUDE_OUT;
  });

  afterEach(() => {
    if (saved.state === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = saved.state;
    }
    delete process.env.FAKE_CLAUDE_LOG;
    delete process.env.FAKE_CLAUDE_OUT;
  });

  const readLog = async (): Promise<{
    header: { args: string[]; cwd: string; pid: number };
    lines: unknown[];
  }> => {
    const [header, ...lines] = (await readFile(join(dir, "log"), "utf8")).trim().split("\n");
    return { header: JSON.parse(header ?? ""), lines: lines.map((l) => JSON.parse(l)) };
  };

  it("runs the §8.1 command in the state dir, writes only the two control requests and parses the answer", async () => {
    process.env.FAKE_CLAUDE_OUT = fixturePath("claude-usage");
    const reading = await readClaudeUsage(FAKE);
    assert.equal(reading.error, undefined);
    assert.deepEqual(
      reading.pools.map((p) => p.id),
      ["claude", "claude-fable"],
    );
    const { header, lines } = await readLog();
    assert.deepEqual(header.args, [
      "--output-format",
      "stream-json",
      "--verbose",
      "--input-format",
      "stream-json",
      "--strict-mcp-config",
      "--settings",
      '{"disableAllHooks":true}',
    ]);
    assert.equal(header.cwd, await realpath(join(dir, "state", "schmear")));
    assert.deepEqual(lines, [
      { type: "control_request", request_id: "i", request: { subtype: "initialize" } },
      { type: "control_request", request_id: "u", request: { subtype: "get_usage", skip_behaviors: true } },
    ]);
  });

  it("reports the reason when claude answers with an error", async () => {
    process.env.FAKE_CLAUDE_OUT = fixturePath("claude-error");
    const reading = await readClaudeUsage(FAKE);
    assert.match(reading.error ?? "", /get_usage failed/);
  });

  it("is unreadable on timeout and SIGTERMs the child", async () => {
    const reading = await readClaudeUsage(FAKE, 2000);
    assert.equal(reading.error, "Claude get_usage timed out after 2 s");
    assert.deepEqual(reading.pools, []);
    const { pid } = (await readLog()).header;
    const deadline = Date.now() + 3000;
    let alive = true;
    while (alive && Date.now() < deadline) {
      try {
        process.kill(pid, 0);
        await new Promise((r) => setTimeout(r, 25));
      } catch {
        alive = false;
      }
    }
    assert.equal(alive, false);
  });

  it("is unreadable when the binary cannot be spawned", async () => {
    const reading = await readClaudeUsage(join(dir, "missing"));
    assert.match(reading.error ?? "", /^Claude get_usage could not start: /);
  });

  it("claudeAdapter.readUsage delegates to readClaude and reads the CLI for a custom config dir", async () => {
    process.env.FAKE_CLAUDE_OUT = fixturePath("claude-usage");
    const reading = await claudeAdapter.readUsage(FAKE, { CLAUDE_CONFIG_DIR: join(dir, "empty-profile") });
    assert.equal(reading.error, undefined);
    assert.equal(reading.source, "cli");
    assert.deepEqual(
      reading.pools.map((p) => p.id),
      ["claude", "claude-fable"],
    );
  });
});

describe("parseClaudeLimits", () => {
  const BASE = {
    five_hour: { utilization: 25, resets_at: "2026-11-21T15:00:00Z" },
    seven_day: { utilization: 40, resets_at: "2026-11-28T21:00:00Z" },
  };

  it("maps limits[] weekly_scoped rows, skips All Models and non-weekly entries, and dedupes with model_scoped", () => {
    const reading = parseClaudeLimits(
      {
        ...BASE,
        model_scoped: [{ display_name: "Opus", utilization: 15, resets_at: "2026-11-28T21:00:00Z" }],
        limits: [
          {
            group: "weekly",
            kind: "weekly_scoped",
            percent: 90,
            resets_at: "2026-11-28T21:00:00Z",
            scope: { model: { id: "claude-opus", display_name: "Opus" } },
          },
          {
            group: "weekly",
            kind: "weekly_scoped",
            percent: 22,
            resets_at: "2026-11-28T21:00:00Z",
            scope: { model: { id: "claude-fable", display_name: "Fable" } },
          },
          {
            group: "weekly",
            kind: "weekly_scoped",
            percent: 40,
            resets_at: "2026-11-28T21:00:00Z",
            scope: { model: { id: "all-models", display_name: "All Models" } },
          },
          {
            group: "five_hour",
            kind: "weekly_scoped",
            percent: 10,
            resets_at: null,
            scope: { model: { display_name: "Haiku" } },
          },
          {
            group: "weekly",
            kind: "weekly",
            percent: 10,
            resets_at: null,
            scope: { model: { display_name: "Sonnet" } },
          },
          {
            group: "weekly",
            kind: "weekly_scoped",
            percent: 30,
            resets_at: null,
            scope: { model: { display_name: "Nova" } },
          },
        ],
        seven_day_routines: { utilization: 10, resets_at: null },
        cowork: { utilization: 5, resets_at: null },
        iguana_necktie: { remaining: 500 },
        cedar_ember: { grants: [] },
      },
      [],
      NOW,
    );
    assert.equal(reading.error, undefined);
    assert.deepEqual(
      reading.pools.map((p) => [p.id, p.models, p.windows.map((w) => [w.kind, w.remaining, w.periodHours])]),
      [
        [
          "claude",
          undefined,
          [
            ["short", 0.75, 5],
            ["period", 0.6, 168],
          ],
        ],
        ["claude-opus", ["opus"], [["period", 0.85, 168]]],
        ["claude-fable", ["fable"], [["period", 0.78, 168]]],
        ["claude-nova", undefined, [["period", 0.7, 168]]],
      ],
    );
    assert.deepEqual(reading.warnings, ["unknown Claude model window 'nova'"]);
  });

  it("formats extra_usage warning with dollar amounts when used_credits and monthly_limit are numbers", () => {
    const withNumbers = parseClaudeLimits(
      { ...BASE, extra_usage: { is_enabled: true, used_credits: 1250, monthly_limit: 5000 } },
      [],
      NOW,
    );
    assert.deepEqual(withNumbers.warnings, [
      "Claude extra usage is on ($12.50 of $50.00 this month): a task that crosses the limit may bill your card. schmear cancels a task as soon as Claude reports overage, but cannot stop the request in flight.",
    ]);

    const withoutNumbers = parseClaudeLimits(
      { ...BASE, extra_usage: { is_enabled: true, used_credits: 1250, monthly_limit: null } },
      [],
      NOW,
    );
    assert.deepEqual(withoutNumbers.warnings, [
      "Claude extra usage is on: a task that crosses the limit may bill your card. schmear cancels a task as soon as Claude reports overage, but cannot stop the request in flight.",
    ]);
  });
});

describe("readClaudeToken", () => {
  let dir: string;
  const FUTURE = Date.now() + 3_600_000;
  const PAST = Date.now() - 3_600_000;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "schmear-claude-tok-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const writeFakeSecurity = async (scriptBody: string): Promise<string> => {
    const bin = join(dir, "fake-security");
    await writeFile(bin, `#!/bin/sh\n${scriptBody}\n`, "utf8");
    await chmod(bin, 0o755);
    return bin;
  };

  it("reads a fresh token from $HOME/.claude/.credentials.json without calling security", async () => {
    const claudeDir = join(dir, ".claude");
    await mkdir(claudeDir, { recursive: true });
    await writeFile(
      join(claudeDir, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "synthetic-file-token",
          expiresAt: FUTURE,
          scopes: ["user:profile", "user:inference"],
        },
      }),
    );
    let securityCalled = false;
    const token = await readClaudeToken({ HOME: dir }, "darwin", async () => {
      securityCalled = true;
      return "";
    });
    assert.equal(securityCalled, false);
    assert.deepEqual(token, {
      accessToken: "synthetic-file-token",
      expiresAt: FUTURE,
      scopes: ["user:profile", "user:inference"],
    });
  });

  it("reads from $CLAUDE_CONFIG_DIR/.credentials.json and never runs security when missing or expired", async () => {
    const customDir = join(dir, "custom");
    await mkdir(customDir, { recursive: true });
    let securityCalls = 0;
    const spy = async () => {
      securityCalls++;
      return "";
    };

    const missing = await readClaudeToken({ HOME: dir, CLAUDE_CONFIG_DIR: customDir }, "darwin", spy);
    assert.deepEqual(missing, { fallthrough: "no Claude OAuth credentials" });
    assert.equal(securityCalls, 0);

    await writeFile(
      join(customDir, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: { accessToken: "synthetic-custom", expiresAt: PAST, scopes: ["user:profile"] },
      }),
    );
    const expired = await readClaudeToken({ HOME: dir, CLAUDE_CONFIG_DIR: customDir }, "darwin", spy);
    assert.deepEqual(expired, {
      accessToken: "synthetic-custom",
      expiresAt: PAST,
      scopes: ["user:profile"],
    });
    assert.equal(securityCalls, 0);
  });

  it("reads Keychain via fake security binary on darwin default profile and strips trailing newlines", async () => {
    const argsLog = join(dir, "security-args.txt");
    const payload = JSON.stringify({
      claudeAiOauth: { accessToken: "synthetic-kc-token", expiresAt: FUTURE, scopes: ["user:profile"] },
    });
    const fakeBin = await writeFakeSecurity(
      `printf '%s\\n' "$@" > "${argsLog}"\nprintf '%s\\n\\n' '${payload}'`,
    );

    const token = await readClaudeToken({ HOME: dir }, "darwin", execSecurity(fakeBin));
    assert.deepEqual(token, {
      accessToken: "synthetic-kc-token",
      expiresAt: FUTURE,
      scopes: ["user:profile"],
    });
    const recordedArgs = (await readFile(argsLog, "utf8")).trim().split("\n");
    assert.deepEqual(recordedArgs, ["find-generic-password", "-s", "Claude Code-credentials", "-w"]);
  });

  it("uses 1500 ms timeout for security and falls back from expired file to Keychain on darwin", async () => {
    const claudeDir = join(dir, ".claude");
    await mkdir(claudeDir, { recursive: true });
    await writeFile(
      join(claudeDir, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: { accessToken: "synthetic-old", expiresAt: PAST, scopes: ["user:profile"] },
      }),
    );
    let seenTimeout = 0;
    const token = await readClaudeToken({ HOME: dir }, "darwin", async (_args, timeoutMs) => {
      seenTimeout = timeoutMs;
      return `${JSON.stringify({
        claudeAiOauth: { accessToken: "synthetic-fresh", expiresAt: FUTURE, scopes: ["user:profile"] },
      })}\r\n`;
    });
    assert.equal(seenTimeout, 1_500);
    assert.deepEqual(token, {
      accessToken: "synthetic-fresh",
      expiresAt: FUTURE,
      scopes: ["user:profile"],
    });
  });

  it("never runs security on linux", async () => {
    let called = false;
    const res = await readClaudeToken({ HOME: dir }, "linux", async () => {
      called = true;
      return "";
    });
    assert.equal(called, false);
    assert.deepEqual(res, { fallthrough: "no Claude OAuth credentials" });
  });

  it("falls through with no Claude OAuth credentials on MCP-only Keychain payload or non-zero security exit", async () => {
    const mcpBin = await writeFakeSecurity(`printf '%s\\n' '{"mcpOAuth":{"srv":{"accessToken":"secret"}}}'`);
    assert.deepEqual(await readClaudeToken({ HOME: dir }, "darwin", execSecurity(mcpBin)), {
      fallthrough: "no Claude OAuth credentials",
    });

    const missingBin = await writeFakeSecurity(`echo "secret-stderr-text" >&2; exit 44`);
    const missing = await readClaudeToken({ HOME: dir }, "darwin", execSecurity(missingBin));
    assert.deepEqual(missing, { fallthrough: "no Claude OAuth credentials" });
    assert.ok(!JSON.stringify(missing).includes("secret-stderr-text"));
  });

  it("never quotes file or Keychain text in JSON parse errors", async () => {
    const claudeDir = join(dir, ".claude");
    await mkdir(claudeDir, { recursive: true });
    const credPath = join(claudeDir, ".credentials.json");
    await writeFile(credPath, '{"claudeAiOauth":{"accessToken":"super-secret-file-token"');
    const fileRes = await readClaudeToken({ HOME: dir }, "linux");
    assert.ok("fallthrough" in fileRes);
    assert.ok(fileRes.fallthrough.includes(credPath));
    assert.ok(!fileRes.fallthrough.includes("super-secret-file-token"));

    await rm(credPath);
    const badKcBin = await writeFakeSecurity(
      `printf '%s' '{"claudeAiOauth":{"accessToken":"super-secret-kc-token"'`,
    );
    const kcRes = await readClaudeToken({ HOME: dir }, "darwin", execSecurity(badKcBin));
    assert.ok("fallthrough" in kcRes);
    assert.ok(!kcRes.fallthrough.includes("super-secret-kc-token"));
  });

  it("rejects malformed accessToken (newline or non-ASCII) without quoting it", async () => {
    const claudeDir = join(dir, ".claude");
    await mkdir(claudeDir, { recursive: true });
    const credPath = join(claudeDir, ".credentials.json");
    for (const bad of ["secret-line1\nsecret-line2", "secret-token\n", "secret-non-ascii-\u00e9"]) {
      await writeFile(
        credPath,
        JSON.stringify({
          claudeAiOauth: { accessToken: bad, expiresAt: FUTURE, scopes: ["user:profile"] },
        }),
      );
      const res = await readClaudeToken({ HOME: dir }, "linux");
      assert.deepEqual(res, { fallthrough: "Claude OAuth token is malformed" });
      assert.ok(!JSON.stringify(res).includes("secret-"));
    }
  });
});

describe("readClaudeOAuth and readClaude", () => {
  const VALID_TOKEN: ClaudeOAuthToken = {
    accessToken: "synthetic-token",
    expiresAt: NOW + 60_000,
    scopes: ["user:profile", "user:inference"],
  };
  const OAUTH_BODY = {
    five_hour: { utilization: 20, resets_at: "2026-11-21T15:00:00Z" },
    seven_day: { utilization: 35, resets_at: "2026-11-28T21:00:00Z" },
  };
  const CLI_OK = {
    agent: "claude" as const,
    fetchedAt: NOW,
    warnings: [],
    pools: [
      {
        id: "claude",
        agent: "claude" as const,
        keys: ["claude" as const],
        windows: [{ kind: "period" as const, remaining: 0.5, resetsAt: WEEK_RESET, periodHours: 168 }],
      },
    ],
  };

  const makeDeps = (overrides: Partial<ClaudeDeps> = {}): ClaudeDeps => ({
    readToken: async () => VALID_TOKEN,
    fetch: (async () =>
      new Response(JSON.stringify(OAUTH_BODY), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
    cli: async () => CLI_OK,
    ...overrides,
  });

  it("sends the expected OAuth request with detected and fallback User-Agent and returns source: oauth on 200", async () => {
    let seenUrl: string | URL | Request = "";
    let seenInit: RequestInit | undefined;
    let seenBin = "";
    const deps = makeDeps({
      version: async (bin) => {
        seenBin = bin;
        return "2.1.330 (Claude Code)";
      },
      fetch: (async (url, init) => {
        seenUrl = url;
        seenInit = init;
        return new Response(JSON.stringify(OAUTH_BODY), { status: 200 });
      }) as typeof fetch,
    });
    const res = await readClaudeOAuth({}, deps, NOW, "/custom/bin/claude");
    assert.ok(!("fallthrough" in res));
    assert.equal(res.source, "oauth");
    assert.equal(res.error, undefined);
    assert.equal(res.pools[0]?.windows[0]?.remaining, 0.8);
    assert.equal(res.pools[0]?.windows[1]?.remaining, 0.65);

    assert.equal(seenBin, "/custom/bin/claude");
    assert.equal(seenUrl, "https://api.anthropic.com/api/oauth/usage");
    assert.equal(seenInit?.method, "GET");
    assert.equal(seenInit?.credentials, "omit");
    assert.equal(seenInit?.redirect, "error");
    assert.ok(seenInit?.signal instanceof AbortSignal);
    assert.deepEqual(seenInit?.headers, {
      Authorization: "Bearer synthetic-token",
      Accept: "application/json",
      "anthropic-beta": "oauth-2025-04-20",
      "User-Agent": "claude-cli/2.1.330 (external, cli)",
    });

    for (const version of [
      undefined,
      async () => "",
      async () => {
        throw new Error("boom");
      },
    ]) {
      let ua: string | undefined;
      const fallbackRes = await readClaudeOAuth(
        {},
        makeDeps({
          version,
          fetch: (async (_url, init) => {
            ua = (init?.headers as Record<string, string> | undefined)?.["User-Agent"];
            return new Response(JSON.stringify(OAUTH_BODY), { status: 200 });
          }) as typeof fetch,
        }),
        NOW,
      );
      assert.ok(!("fallthrough" in fallbackRes));
      assert.equal(ua, "claude-cli/2.1.0 (external, cli)");
    }
  });

  it("never passes a token with a newline to fetch and never leaks token text in reasons or errors", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schmear-claude-badtok-"));
    try {
      const claudeDir = join(dir, ".claude");
      await mkdir(claudeDir, { recursive: true });
      const badToken = "secret-header-part1\nsecret-header-part2";
      await writeFile(
        join(claudeDir, ".credentials.json"),
        JSON.stringify({
          claudeAiOauth: {
            accessToken: badToken,
            expiresAt: Date.now() + 60_000,
            scopes: ["user:profile"],
          },
        }),
      );
      let fetchCalled = false;
      const noFetch = (async () => {
        fetchCalled = true;
        return new Response("{}", { status: 200 });
      }) as typeof fetch;

      const fromFile = await readClaude(
        "/fake/claude",
        {
          readToken: (env) => readClaudeToken(env, "linux"),
          fetch: noFetch,
          cli: async () => unreadable("claude", "Claude get_usage failed", [], NOW),
        },
        { HOME: dir },
      );
      assert.equal(fetchCalled, false);
      assert.equal(fromFile.error, "Claude get_usage failed (OAuth: Claude OAuth token is malformed)");
      assert.ok(!JSON.stringify(fromFile).includes("secret-header"));

      const fromStub = await readClaudeOAuth(
        {},
        makeDeps({
          readToken: async () => ({ ...VALID_TOKEN, accessToken: badToken }),
          fetch: noFetch,
        }),
        NOW,
      );
      assert.equal(fetchCalled, false);
      assert.deepEqual(fromStub, { fallthrough: "Claude OAuth token is malformed" });
      assert.ok(!JSON.stringify(fromStub).includes("secret-header"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("falls through on expired token (past or missing expiresAt) and missing user:profile scope", async () => {
    let fetchCalled = false;
    const noFetch = (async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    assert.deepEqual(
      await readClaudeOAuth(
        {},
        makeDeps({ readToken: async () => ({ ...VALID_TOKEN, expiresAt: NOW }), fetch: noFetch }),
        NOW,
      ),
      { fallthrough: "Claude OAuth token expired" },
    );
    assert.deepEqual(
      await readClaudeOAuth(
        {},
        makeDeps({
          readToken: async () => ({ accessToken: "synthetic-token", scopes: ["user:profile"] }),
          fetch: noFetch,
        }),
        NOW,
      ),
      { fallthrough: "Claude OAuth token expired" },
    );
    assert.deepEqual(
      await readClaudeOAuth(
        {},
        makeDeps({ readToken: async () => ({ ...VALID_TOKEN, scopes: ["user:inference"] }), fetch: noFetch }),
        NOW,
      ),
      { fallthrough: "Claude OAuth token lacks user:profile" },
    );
    assert.equal(fetchCalled, false);
  });

  it("falls through with the right reason on 401, 429, other HTTP status, invalid JSON, non-object JSON, missing weekly window and network error", async () => {
    assert.deepEqual(
      await readClaudeOAuth(
        {},
        makeDeps({ fetch: (async () => new Response("", { status: 401 })) as typeof fetch }),
        NOW,
      ),
      { fallthrough: "Claude OAuth request unauthorized" },
    );
    assert.deepEqual(
      await readClaudeOAuth(
        {},
        makeDeps({ fetch: (async () => new Response("", { status: 429 })) as typeof fetch }),
        NOW,
      ),
      { fallthrough: "Claude OAuth rate limited" },
    );
    assert.deepEqual(
      await readClaudeOAuth(
        {},
        makeDeps({ fetch: (async () => new Response("", { status: 503 })) as typeof fetch }),
        NOW,
      ),
      { fallthrough: "Claude OAuth HTTP 503" },
    );
    assert.deepEqual(
      await readClaudeOAuth(
        {},
        makeDeps({ fetch: (async () => new Response("not-json", { status: 200 })) as typeof fetch }),
        NOW,
      ),
      { fallthrough: "Claude OAuth response was invalid" },
    );
    assert.deepEqual(
      await readClaudeOAuth(
        {},
        makeDeps({ fetch: (async () => new Response("[]", { status: 200 })) as typeof fetch }),
        NOW,
      ),
      { fallthrough: "Claude OAuth response was invalid" },
    );
    assert.deepEqual(
      await readClaudeOAuth(
        {},
        makeDeps({ fetch: (async () => new Response("{}", { status: 200 })) as typeof fetch }),
        NOW,
      ),
      { fallthrough: "Claude reports no weekly limit" },
    );
    assert.deepEqual(
      await readClaudeOAuth(
        {},
        makeDeps({
          fetch: (async () => {
            throw new Error("socket hang up");
          }) as typeof fetch,
        }),
        NOW,
      ),
      { fallthrough: "socket hang up" },
    );
  });

  it("readClaude returns the CLI reading with source: cli and never touches credentials", async () => {
    let tokenCalls = 0;
    let fetchCalls = 0;
    let cliEnv: Record<string, string> | undefined;
    const reading = await readClaude(
      "/fake/claude",
      makeDeps({
        readToken: async () => {
          tokenCalls += 1;
          return VALID_TOKEN;
        },
        fetch: (async () => {
          fetchCalls += 1;
          return new Response("{}", { status: 200 });
        }) as typeof fetch,
        cli: async (_bin, env) => {
          cliEnv = env;
          return CLI_OK;
        },
      }),
      { CLAUDE_CONFIG_DIR: "/tmp/custom-claude" },
    );
    assert.equal(reading.source, "cli");
    assert.equal(reading.error, undefined);
    assert.equal(tokenCalls, 0);
    assert.equal(fetchCalls, 0);
    assert.deepEqual(cliEnv, { CLAUDE_CONFIG_DIR: "/tmp/custom-claude" });
  });

  it("readClaude falls back to OAuth with source: oauth when the CLI read fails or throws, merging the env overlay", async () => {
    let tokenEnv: NodeJS.ProcessEnv | undefined;
    const deps = (cli: ClaudeDeps["cli"]): ClaudeDeps =>
      makeDeps({
        readToken: async (env) => {
          tokenEnv = env;
          return { ...VALID_TOKEN, expiresAt: Date.now() + 60_000 };
        },
        cli,
      });
    const failed = await readClaude(
      "/fake/claude",
      deps(async () => unreadable("claude", "Claude get_usage timed out after 15 s", [], NOW)),
      { CLAUDE_CONFIG_DIR: "/tmp/custom-claude" },
    );
    assert.equal(failed.source, "oauth");
    assert.equal(failed.error, undefined);
    assert.equal(tokenEnv?.CLAUDE_CONFIG_DIR, "/tmp/custom-claude");

    const thrown = await readClaude(
      "/fake/claude",
      deps(async () => {
        throw new Error("spawn ENOENT");
      }),
    );
    assert.equal(thrown.source, "oauth");
  });

  it("readClaude combines both errors when the CLI fails and OAuth falls through", async () => {
    const reading = await readClaude(
      "/fake/claude",
      makeDeps({
        readToken: async () => ({ ...VALID_TOKEN, expiresAt: Date.now() + 60_000 }),
        fetch: (async () => new Response("", { status: 429 })) as typeof fetch,
        cli: async () => unreadable("claude", "Claude get_usage timed out after 15 s", [], NOW),
      }),
    );
    assert.equal(reading.source, undefined);
    assert.equal(reading.error, "Claude get_usage timed out after 15 s (OAuth: Claude OAuth rate limited)");
    assert.deepEqual(reading.pools, []);

    const thrown = await readClaude(
      "/fake/claude",
      makeDeps({
        readToken: async () => ({ fallthrough: "no Claude OAuth credentials" }),
        cli: async () => {
          throw new Error("spawn ENOENT");
        },
      }),
    );
    assert.equal(thrown.error, "Claude get_usage failed: spawn ENOENT (OAuth: no Claude OAuth credentials)");
  });
});
