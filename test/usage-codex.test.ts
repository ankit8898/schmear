import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  type CodexDeps,
  parseCodexUsage,
  parseCodexWham,
  readCodex,
  readCodexOAuth,
  readCodexPAT,
  readCodexUsage,
} from "../src/agents/codex.ts";
import { PACKAGE_VERSION } from "../src/util.ts";
import type { FakeAppServerScript } from "./fake-app-server.ts";

const NOW = 1_794_000_000_000;
const WHOAMI_URL = "https://auth.openai.com/api/accounts/v1/user-auth-credential/whoami";
const WHAM_URL = "https://chatgpt.com/backend-api/wham/usage";
// biome-ignore lint/suspicious/noExplicitAny: tests mutate nested fixture fields
const fixture = (name: string): Record<string, any> =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url)), "utf8"));

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.synthetic-sig`;
}

function whamPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    plan_type: "plus",
    rate_limit: {
      primary_window: { used_percent: 12, reset_at: 1_795_003_600, limit_window_seconds: 18_000 },
      secondary_window: { used_percent: 64, reset_at: 1_795_500_000, limit_window_seconds: 604_800 },
    },
    credits: { has_credits: false, unlimited: false, balance: null },
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function withCodexHome<T>(authContent: string | undefined, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "schmear-codex-home-"));
  if (authContent !== undefined) {
    writeFileSync(join(dir, "auth.json"), authContent, "utf8");
  }
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function makeDeps(overrides: Partial<CodexDeps> = {}): CodexDeps {
  return {
    readFile: (path) => readFile(path, "utf8"),
    fetch: async () => {
      throw new Error("unexpected fetch");
    },
    rpc: async () => {
      throw new Error("unexpected rpc");
    },
    cliVersion: async () => "codex-cli 0.147.0",
    osVersion: async () => "15.3.1",
    platform: "darwin",
    arch: "arm64",
    ...overrides,
  };
}

describe("parseCodexUsage", () => {
  it("maps a 30-day primary to one period window and ignores a duplicate own limit", () => {
    const r = parseCodexUsage(fixture("codex-monthly"), NOW);
    assert.equal(r.error, undefined);
    assert.equal(r.fetchedAt, NOW);
    assert.deepEqual(r.warnings, []);
    assert.deepEqual(r.pools, [
      {
        id: "codex",
        agent: "codex",
        keys: ["codex"],
        windows: [{ kind: "period", remaining: 0.63, resetsAt: 1_795_000_000_000, periodHours: 720 }],
      },
    ]);
  });

  it("skips Codex while it holds credits, which pay past the plan limit", () => {
    const raw = fixture("codex-monthly");
    raw.rateLimits.credits = { hasCredits: false, unlimited: false, balance: null };
    assert.equal(parseCodexUsage(raw, NOW).error, undefined);
    raw.rateLimits.credits = { hasCredits: true, unlimited: false, balance: "12.50" };
    assert.equal(
      parseCodexUsage(raw, NOW).error,
      "codex credits can pay past your plan limit (balance 12.50)",
    );
    raw.rateLimits.credits = { hasCredits: false, unlimited: true, balance: null };
    assert.equal(parseCodexUsage(raw, NOW).error, "codex credits can pay past your plan limit (unlimited)");
    assert.equal(parseCodexUsage(raw, NOW).pools.length, 1, "the windows still show");
  });

  it("maps a short primary and a weekly secondary; another limit id warns and adds no window", () => {
    const r = parseCodexUsage(fixture("codex-two-limits"), NOW);
    assert.equal(r.error, undefined);
    assert.deepEqual(r.warnings, ["Codex reports another limit 'codex_bengalfox'; not used for routing"]);
    assert.equal(r.pools.length, 1);
    const [short, weekly] = r.pools[0].windows;
    assert.deepEqual(short, { kind: "short", remaining: 0.88, resetsAt: 1_795_003_600_000, periodHours: 5 });
    assert.deepEqual(weekly, {
      kind: "period",
      remaining: 0.36,
      resetsAt: 1_795_500_000_000,
      periodHours: 168,
    });
  });

  it("treats windowDurationMins 1440 as short and 1441 as period", () => {
    const raw = fixture("codex-monthly");
    raw.rateLimits.primary.windowDurationMins = 1440;
    assert.equal(parseCodexUsage(raw, NOW).pools[0].windows[0].kind, "short");
    raw.rateLimits.primary.windowDurationMins = 1441;
    assert.equal(parseCodexUsage(raw, NOW).pools[0].windows[0].kind, "period");
  });

  it("uses rateLimits.limitId to decide which entry is another limit", () => {
    const raw = fixture("codex-two-limits");
    raw.rateLimits.limitId = "codex_bengalfox";
    assert.deepEqual(parseCodexUsage(raw, NOW).warnings, [
      "Codex reports another limit 'codex'; not used for routing",
    ]);
    delete raw.rateLimits.limitId;
    assert.equal(parseCodexUsage(raw, NOW).warnings.length, 1);
    delete raw.rateLimitsByLimitId;
    assert.deepEqual(parseCodexUsage(raw, NOW).warnings, []);
  });

  it("zeroes every window when spend control is reached", () => {
    const r = parseCodexUsage(fixture("codex-spend-reached"), NOW);
    assert.deepEqual(
      r.pools[0].windows.map((w) => w.remaining),
      [0],
    );
  });

  it("zeroes every window when rateLimitReachedType is set", () => {
    const raw = fixture("codex-two-limits");
    raw.rateLimits.rateLimitReachedType = "primary";
    const r = parseCodexUsage(raw, NOW);
    assert.deepEqual(
      r.pools[0].windows.map((w) => w.remaining),
      [0, 0],
    );
  });

  it("keeps a null resetsAt as null", () => {
    const raw = fixture("codex-monthly");
    raw.rateLimits.primary.resetsAt = null;
    assert.equal(parseCodexUsage(raw, NOW).pools[0].windows[0].resetsAt, null);
  });

  it("is unreadable, with a reason, for malformed replies", () => {
    const noWindows = fixture("codex-monthly");
    noWindows.rateLimits.primary = null;
    const badPercent = fixture("codex-monthly");
    badPercent.rateLimits.primary.usedPercent = "83";
    const badDuration = fixture("codex-monthly");
    badDuration.rateLimits.primary.windowDurationMins = 0;
    const badSecondary = fixture("codex-monthly");
    badSecondary.rateLimits.secondary = 5;
    const cases: [unknown, RegExp][] = [
      [null, /no rateLimits/],
      [{}, /no rateLimits/],
      [{ rateLimits: null }, /no rateLimits/],
      [noWindows, /no rate-limit window/],
      [badPercent, /primary window has no numeric usedPercent/],
      [badDuration, /primary window has no positive windowDurationMins/],
      [badSecondary, /secondary window is not an object/],
    ];
    for (const [raw, reason] of cases) {
      const r = parseCodexUsage(raw, NOW);
      assert.match(r.error ?? "", reason);
      assert.deepEqual(r.pools, []);
    }
  });
});

describe("readCodexUsage", () => {
  it("runs app-server read-only, initializes, returns the raw result and kills the process", async () => {
    const dir = mkdtempSync(join(tmpdir(), "schmear-codex-usage-"));
    try {
      const readFile = join(dir, "read.json");
      const script: FakeAppServerScript = {
        rateLimits: fixture("codex-monthly"),
        pidFile: join(dir, "pid"),
        readFile,
      };
      const scriptFile = join(dir, "script.json");
      writeFileSync(scriptFile, JSON.stringify(script), "utf8");
      const bin = join(dir, "codex");
      const server = fileURLToPath(new URL("./fake-app-server.ts", import.meta.url));
      writeFileSync(
        bin,
        `#!/bin/sh\nexec "${process.execPath}" "${server}" "$(cat "${scriptFile}")" "$@"\n`,
        "utf8",
      );
      chmodSync(bin, 0o755);
      assert.deepEqual(await readCodexUsage(bin), script.rateLimits);
      assert.deepEqual(JSON.parse(readFileSync(readFile, "utf8")), {
        initialized: true,
        args: ["-s", "read-only", "-a", "never", "app-server"],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("parseCodexWham", () => {
  it("maps short primary and weekly secondary windows with 86400s boundary", () => {
    const r = parseCodexWham(whamPayload(), NOW);
    assert.equal(r.error, undefined);
    assert.equal(r.fetchedAt, NOW);
    assert.deepEqual(r.warnings, []);
    assert.deepEqual(r.pools, [
      {
        id: "codex",
        agent: "codex",
        keys: ["codex"],
        windows: [
          { kind: "short", remaining: 0.88, resetsAt: 1_795_003_600_000, periodHours: 5 },
          { kind: "period", remaining: 0.36, resetsAt: 1_795_500_000_000, periodHours: 168 },
        ],
      },
    ]);

    const boundaryShort = parseCodexWham(
      whamPayload({
        rate_limit: {
          primary_window: { used_percent: 25, reset_at: null, limit_window_seconds: 86_400 },
          secondary_window: null,
        },
      }),
      NOW,
    );
    assert.deepEqual(boundaryShort.pools[0].windows, [
      { kind: "short", remaining: 0.75, resetsAt: null, periodHours: 24 },
    ]);

    const boundaryPeriod = parseCodexWham(
      whamPayload({
        rate_limit: {
          primary_window: null,
          secondary_window: { used_percent: 50, limit_window_seconds: 86_401 },
        },
      }),
      NOW,
    );
    assert.equal(boundaryPeriod.pools[0].windows[0].kind, "period");
    assert.equal(boundaryPeriod.pools[0].windows[0].resetsAt, null);
  });

  it("warns on additional_rate_limits using limit_name then metered_feature", () => {
    const r = parseCodexWham(
      whamPayload({
        additional_rate_limits: [
          { limit_name: "GPT-5.3-Codex-Spark", metered_feature: "codex_spark" },
          { metered_feature: "codex_bengalfox" },
        ],
      }),
      NOW,
    );
    assert.equal(r.error, undefined);
    assert.deepEqual(r.warnings, [
      "Codex reports another limit 'GPT-5.3-Codex-Spark'; not used for routing",
      "Codex reports another limit 'codex_bengalfox'; not used for routing",
    ]);
  });

  it("zeroes every window when spend control individual_limit is reached across precedence levels", () => {
    const cases: [Record<string, unknown>, number[]][] = [
      [{ individual_limit: { limit: 100, used: 100 } }, [0, 0]],
      [{ individualLimit: { limit: "50", remainingPercent: 0 } }, [0, 0]],
      [
        {
          rate_limit: {
            primary_window: { used_percent: 10, reset_at: 1_795_003_600, limit_window_seconds: 18_000 },
            secondary_window: { used_percent: 20, reset_at: 1_795_500_000, limit_window_seconds: 604_800 },
            individual_limit: { limit: 100, remaining_percent: "0" },
          },
        },
        [0, 0],
      ],
      [{ spend_control: { individual_limit: { limit: 20, used: 25 } } }, [0, 0]],
      [{ spendControl: { individualLimit: { limit: 20, remainingPercent: -1 } } }, [0, 0]],
      // root individual_limit takes precedence over rate_limit and spend_control
      [
        {
          individual_limit: { limit: 100, used: 10 },
          spend_control: { individual_limit: { limit: 100, used: 100 } },
        },
        [0.88, 0.36],
      ],
      // the same reached flags the RPC reply zeroes windows on
      [{ spend_control: { reached: true } }, [0, 0]],
      [{ rate_limit_reached_type: { type: "workspace_member_usage_limit_reached" } }, [0, 0]],
      [{ spend_control: { reached: false }, rate_limit_reached_type: null }, [0.88, 0.36]],
      // limit <= 0 does not trigger spend control
      [{ individual_limit: { limit: 0, remaining_percent: 0 } }, [0.88, 0.36]],
    ];
    for (const [override, expectedRemaining] of cases) {
      const r = parseCodexWham(whamPayload(override), NOW);
      assert.deepEqual(
        r.pools[0].windows.map((w) => w.remaining),
        expectedRemaining,
      );
    }
  });

  it("applies the credits guard for numeric, string, null and unlimited balances", () => {
    const noCredits = parseCodexWham(
      whamPayload({ credits: { has_credits: false, unlimited: false, balance: null } }),
      NOW,
    );
    assert.equal(noCredits.error, undefined);

    const numBalance = parseCodexWham(
      whamPayload({ credits: { has_credits: true, unlimited: false, balance: 12.5 } }),
      NOW,
    );
    assert.equal(numBalance.error, "codex credits can pay past your plan limit (balance 12.5)");
    assert.equal(numBalance.pools.length, 1);

    const strBalance = parseCodexWham(
      whamPayload({ credits: { has_credits: true, unlimited: false, balance: "12.50" } }),
      NOW,
    );
    assert.equal(strBalance.error, "codex credits can pay past your plan limit (balance 12.50)");

    const nullBalance = parseCodexWham(
      whamPayload({ credits: { has_credits: true, unlimited: false, balance: null } }),
      NOW,
    );
    assert.equal(nullBalance.error, "codex credits can pay past your plan limit");

    const unlimited = parseCodexWham(
      whamPayload({ credits: { has_credits: false, unlimited: true, balance: null } }),
      NOW,
    );
    assert.equal(unlimited.error, "codex credits can pay past your plan limit (unlimited)");
    assert.equal(unlimited.pools.length, 1);
  });

  it("is unreadable, naming the window, for malformed wham replies", () => {
    const cases: [unknown, RegExp][] = [
      [null, /not an object/],
      [{}, /no rate-limit window/],
      [{ rate_limit: null }, /no rate-limit window/],
      [{ rate_limit: "bad" }, /rate_limit is not an object/],
      [{ rate_limit: { primary_window: null, secondary_window: null } }, /no rate-limit window/],
      [{ rate_limit: { primary_window: 5 } }, /primary window is not an object/],
      [
        { rate_limit: { primary_window: { used_percent: "10", limit_window_seconds: 18_000 } } },
        /primary window has no numeric used_percent/,
      ],
      [
        { rate_limit: { secondary_window: { used_percent: 10, limit_window_seconds: 0 } } },
        /secondary window has no positive limit_window_seconds/,
      ],
    ];
    for (const [raw, pattern] of cases) {
      const r = parseCodexWham(raw, NOW);
      assert.match(r.error ?? "", pattern);
      assert.deepEqual(r.pools, []);
    }
  });
});

describe("readCodexPAT", () => {
  it("fetches whoami then wham/usage with codex_cli_rs headers and whoami account id only", async () => {
    const auth = JSON.stringify({
      personal_access_token: "synthetic-pat-123",
      tokens: {
        access_token: "synthetic-oauth",
        refresh_token: "synthetic-refresh",
        account_id: "acct-from-tokens-must-not-be-used",
      },
    });
    await withCodexHome(auth, async (dir) => {
      const calls: { url: string; init: RequestInit | undefined }[] = [];
      const deps = makeDeps({
        fetch: (async (input: string | URL | Request, init?: RequestInit) => {
          const url = String(input);
          calls.push({ url, init });
          if (url === WHOAMI_URL) {
            return jsonResponse({ chatgpt_account_id: "acct-from-whoami" });
          }
          if (url === WHAM_URL) {
            return jsonResponse(whamPayload());
          }
          throw new Error(`unexpected url ${url}`);
        }) as typeof fetch,
      });

      const res = await readCodexPAT({ CODEX_HOME: dir }, deps, NOW, "codex");
      assert.ok(!("fallthrough" in res));
      assert.equal(res.source, "pat");
      assert.equal(res.error, undefined);
      assert.equal(calls.length, 2);

      const expectedUA = "codex_cli_rs/0.147.0 (Mac OS 15.3.1; arm64)";
      assert.equal(calls[0].url, WHOAMI_URL);
      assert.equal(calls[0].init?.credentials, "omit");
      assert.equal(calls[0].init?.redirect, "error");
      assert.deepEqual(calls[0].init?.headers, {
        Authorization: "Bearer synthetic-pat-123",
        Accept: "application/json",
        originator: "codex_cli_rs",
        "User-Agent": expectedUA,
      });

      assert.equal(calls[1].url, WHAM_URL);
      assert.equal(calls[1].init?.credentials, "omit");
      assert.equal(calls[1].init?.redirect, "error");
      assert.deepEqual(calls[1].init?.headers, {
        Authorization: "Bearer synthetic-pat-123",
        Accept: "application/json",
        originator: "codex_cli_rs",
        "User-Agent": expectedUA,
        "ChatGPT-Account-Id": "acct-from-whoami",
      });
    });
  });

  it("supports personalAccessToken, Linux/x64 User-Agent, missing CLI version, and absent whoami account id", async () => {
    const auth = JSON.stringify({ personalAccessToken: "synthetic-pat-camel" });
    await withCodexHome(auth, async (dir) => {
      const headersSeen: Record<string, string>[] = [];
      const deps = makeDeps({
        platform: "linux",
        arch: "x64",
        osVersion: async () => "6.8.0-45-generic",
        cliVersion: async () => undefined,
        fetch: (async (input: string | URL | Request, init?: RequestInit) => {
          headersSeen.push(init?.headers as Record<string, string>);
          if (String(input) === WHOAMI_URL) {
            return jsonResponse({});
          }
          return jsonResponse(whamPayload());
        }) as typeof fetch,
      });

      const res = await readCodexPAT({ CODEX_HOME: dir }, deps, NOW);
      assert.ok(!("fallthrough" in res));
      assert.equal(res.source, "pat");
      assert.equal(headersSeen[0]["User-Agent"], "codex_cli_rs (Linux 6.8.0; x86_64)");
      assert.equal(headersSeen[1]["ChatGPT-Account-Id"], undefined);
    });
  });

  it("falls through silently when PAT or auth.json is absent, and rejects invalid PAT characters without calling fetch", async () => {
    await withCodexHome(undefined, async (dir) => {
      const res = await readCodexPAT({ CODEX_HOME: dir }, makeDeps(), NOW);
      assert.deepEqual(res, { fallthrough: "" });
    });

    await withCodexHome(
      JSON.stringify({ tokens: { access_token: "a", refresh_token: "r" } }),
      async (dir) => {
        const res = await readCodexPAT({ CODEX_HOME: dir }, makeDeps(), NOW);
        assert.deepEqual(res, { fallthrough: "" });
      },
    );

    for (const badPat of ["secret-pat\r\nX-Bad: 1", "secret pat", "secret-pat-\u00e9"]) {
      await withCodexHome(JSON.stringify({ personal_access_token: badPat }), async (dir) => {
        const res = await readCodexPAT({ CODEX_HOME: dir }, makeDeps(), NOW);
        assert.ok("fallthrough" in res);
        assert.ok(!res.fallthrough.includes("secret"));
      });
    }
  });

  it("falls through on 401 and returns a final error on 500, network error, bad JSON or invalid auth.json", async () => {
    await withCodexHome("{broken-secret-pat-text", async (dir) => {
      const res = await readCodexPAT({ CODEX_HOME: dir }, makeDeps(), NOW);
      assert.ok(!("fallthrough" in res));
      assert.equal(res.error, "Codex auth.json is not valid JSON");
      assert.ok(!res.error.includes("broken-secret"));
    });

    const auth = JSON.stringify({ personal_access_token: "synthetic-pat" });
    await withCodexHome(auth, async (dir) => {
      const whoami401 = await readCodexPAT(
        { CODEX_HOME: dir },
        makeDeps({ fetch: (async () => new Response("", { status: 401 })) as typeof fetch }),
        NOW,
      );
      assert.ok("fallthrough" in whoami401);

      const usage401 = await readCodexPAT(
        { CODEX_HOME: dir },
        makeDeps({
          fetch: (async (input: string | URL | Request) =>
            String(input) === WHOAMI_URL
              ? jsonResponse({ chatgpt_account_id: "acct-1" })
              : new Response("", { status: 401 })) as typeof fetch,
        }),
        NOW,
      );
      assert.ok("fallthrough" in usage401);

      const usage500 = await readCodexPAT(
        { CODEX_HOME: dir },
        makeDeps({
          fetch: (async (input: string | URL | Request) =>
            String(input) === WHOAMI_URL
              ? jsonResponse({ chatgpt_account_id: "acct-1" })
              : new Response("err", { status: 500 })) as typeof fetch,
        }),
        NOW,
      );
      assert.ok(!("fallthrough" in usage500));
      assert.equal(usage500.error, "Codex usage API HTTP 500");

      const netErr = await readCodexPAT(
        { CODEX_HOME: dir },
        makeDeps({
          fetch: (async () => {
            throw new Error("socket hang up");
          }) as typeof fetch,
        }),
        NOW,
      );
      assert.ok(!("fallthrough" in netErr));
      assert.equal(netErr.error, "socket hang up");

      const badWhoami = await readCodexPAT(
        { CODEX_HOME: dir },
        makeDeps({ fetch: (async () => new Response("not-json", { status: 200 })) as typeof fetch }),
        NOW,
      );
      assert.ok(!("fallthrough" in badWhoami));
      assert.match(badWhoami.error ?? "", /whoami response was invalid/);
    });
  });
});

describe("readCodexOAuth", () => {
  it("sends Bearer token, schmear User-Agent, and account id from tokens.account_id", async () => {
    const auth = JSON.stringify({
      tokens: {
        access_token: "synthetic-token",
        refresh_token: "synthetic-refresh",
        account_id: "acct-direct",
      },
      last_refresh: new Date(NOW - 3_600_000).toISOString(),
    });
    await withCodexHome(auth, async (dir) => {
      let seenUrl = "";
      let seenInit: RequestInit | undefined;
      const deps = makeDeps({
        fetch: (async (input: string | URL | Request, init?: RequestInit) => {
          seenUrl = String(input);
          seenInit = init;
          return jsonResponse(whamPayload());
        }) as typeof fetch,
      });

      const res = await readCodexOAuth({ CODEX_HOME: dir }, deps, NOW);
      assert.ok(!("fallthrough" in res));
      assert.equal(res.source, "oauth");
      assert.equal(res.error, undefined);
      assert.equal(seenUrl, WHAM_URL);
      assert.equal(seenInit?.credentials, "omit");
      assert.equal(seenInit?.redirect, "error");
      assert.deepEqual(seenInit?.headers, {
        Authorization: "Bearer synthetic-token",
        "User-Agent": `schmear/${PACKAGE_VERSION}`,
        Accept: "application/json",
        "ChatGPT-Account-Id": "acct-direct",
      });
    });

    // Falls back to $HOME/.codex/auth.json when CODEX_HOME is unset
    const homeDir = mkdtempSync(join(tmpdir(), "schmear-codex-fakehome-"));
    try {
      mkdirSync(join(homeDir, ".codex"));
      writeFileSync(
        join(homeDir, ".codex", "auth.json"),
        JSON.stringify({
          tokens: { accessToken: "synthetic-camel-token", refreshToken: "r", accountId: "acct-camel" },
          last_refresh: new Date(NOW).toISOString(),
        }),
        "utf8",
      );
      let seenAccountId: string | undefined;
      const res = await readCodexOAuth(
        { HOME: homeDir },
        makeDeps({
          fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
            seenAccountId = (init?.headers as Record<string, string> | undefined)?.["ChatGPT-Account-Id"];
            return jsonResponse(whamPayload());
          }) as typeof fetch,
        }),
        NOW,
      );
      assert.ok(!("fallthrough" in res));
      assert.equal(res.source, "oauth");
      assert.equal(seenAccountId, "acct-camel");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("extracts account id from id_token JWT (direct and nested OpenAI auth claim), then access_token JWT", async () => {
    const expSec = Math.floor((NOW + 600_000) / 1000);
    const cases: [Record<string, unknown>, string][] = [
      [
        {
          tokens: {
            access_token: makeJwt({ exp: expSec, chatgpt_account_id: "acct-from-access" }),
            refresh_token: "synthetic-refresh",
            id_token: makeJwt({ chatgpt_account_id: "acct-from-id-direct" }),
          },
        },
        "acct-from-id-direct",
      ],
      [
        {
          tokens: {
            access_token: makeJwt({ exp: expSec }),
            refresh_token: "synthetic-refresh",
            id_token: makeJwt({
              "https://api.openai.com/auth": { chatgpt_account_id: "acct-from-id-nested" },
            }),
          },
        },
        "acct-from-id-nested",
      ],
      [
        {
          tokens: {
            access_token: makeJwt({
              exp: expSec,
              "https://api.openai.com/auth": { chatgpt_account_id: "acct-from-access-nested" },
            }),
            refresh_token: "synthetic-refresh",
          },
        },
        "acct-from-access-nested",
      ],
    ];
    for (const [authObj, expectedAccountId] of cases) {
      await withCodexHome(JSON.stringify(authObj), async (dir) => {
        let seenAccountId: string | undefined;
        const deps = makeDeps({
          fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
            seenAccountId = (init?.headers as Record<string, string> | undefined)?.["ChatGPT-Account-Id"];
            return jsonResponse(whamPayload());
          }) as typeof fetch,
        });
        const res = await readCodexOAuth({ CODEX_HOME: dir }, deps, NOW);
        assert.ok(!("fallthrough" in res));
        assert.equal(seenAccountId, expectedAccountId);
      });
    }
  });

  it("detects refresh due by JWT exp (<= now + 300s) and by last_refresh (> 8 days or missing)", async () => {
    const dueExp = makeJwt({ exp: Math.floor((NOW + 300_000) / 1000) });
    const freshExp = makeJwt({ exp: Math.floor((NOW + 301_000) / 1000) });
    const eightDaysMs = 8 * 24 * 60 * 60 * 1000;

    // Due by exp (exact 300s boundary) even with recent last_refresh
    await withCodexHome(
      JSON.stringify({
        tokens: { access_token: dueExp, refresh_token: "r" },
        last_refresh: new Date(NOW).toISOString(),
      }),
      async (dir) => {
        assert.deepEqual(await readCodexOAuth({ CODEX_HOME: dir }, makeDeps(), NOW), {
          fallthrough: "Codex OAuth token due for refresh",
        });
      },
    );

    // Fresh by exp even without last_refresh
    await withCodexHome(
      JSON.stringify({ tokens: { access_token: freshExp, refresh_token: "r" } }),
      async (dir) => {
        const res = await readCodexOAuth(
          { CODEX_HOME: dir },
          makeDeps({ fetch: (async () => jsonResponse(whamPayload())) as typeof fetch }),
          NOW,
        );
        assert.ok(!("fallthrough" in res));
        assert.equal(res.source, "oauth");
      },
    );

    // Opaque token without last_refresh -> due
    await withCodexHome(
      JSON.stringify({ tokens: { access_token: "synthetic-opaque", refresh_token: "r" } }),
      async (dir) => {
        assert.deepEqual(await readCodexOAuth({ CODEX_HOME: dir }, makeDeps(), NOW), {
          fallthrough: "Codex OAuth token due for refresh",
        });
      },
    );

    // Opaque token with last_refresh > 8 days -> due
    await withCodexHome(
      JSON.stringify({
        tokens: { access_token: "synthetic-opaque", refresh_token: "r" },
        last_refresh: new Date(NOW - eightDaysMs - 1).toISOString(),
      }),
      async (dir) => {
        assert.deepEqual(await readCodexOAuth({ CODEX_HOME: dir }, makeDeps(), NOW), {
          fallthrough: "Codex OAuth token due for refresh",
        });
      },
    );

    // Opaque token with last_refresh === 8 days -> not due
    await withCodexHome(
      JSON.stringify({
        tokens: { access_token: "synthetic-opaque", refresh_token: "r" },
        last_refresh: new Date(NOW - eightDaysMs).toISOString(),
      }),
      async (dir) => {
        const res = await readCodexOAuth(
          { CODEX_HOME: dir },
          makeDeps({ fetch: (async () => jsonResponse(whamPayload())) as typeof fetch }),
          NOW,
        );
        assert.ok(!("fallthrough" in res));
        assert.equal(res.source, "oauth");
      },
    );
  });

  it("handles missing credentials, missing tokens, invalid token chars, invalid JSON, 401 and 500", async () => {
    await withCodexHome(undefined, async (dir) => {
      assert.deepEqual(await readCodexOAuth({ CODEX_HOME: dir }, makeDeps(), NOW), {
        fallthrough: "no Codex OAuth credentials",
      });
    });

    for (const content of [
      JSON.stringify({}),
      JSON.stringify({ tokens: { access_token: "synthetic-token" } }),
      JSON.stringify({ tokens: { refresh_token: "synthetic-refresh" } }),
    ]) {
      await withCodexHome(content, async (dir) => {
        assert.deepEqual(await readCodexOAuth({ CODEX_HOME: dir }, makeDeps(), NOW), {
          fallthrough: "no Codex OAuth tokens",
        });
      });
    }

    for (const badToken of ["secret\r\nX-Inject: 1", "secret token", "secret\u2014tok"]) {
      await withCodexHome(
        JSON.stringify({
          tokens: { access_token: badToken, refresh_token: "r" },
          last_refresh: new Date(NOW).toISOString(),
        }),
        async (dir) => {
          const res = await readCodexOAuth({ CODEX_HOME: dir }, makeDeps(), NOW);
          assert.ok("fallthrough" in res);
          assert.ok(!res.fallthrough.includes("secret"));
        },
      );
    }

    await withCodexHome("{secret-token-raw-text", async (dir) => {
      const res = await readCodexOAuth({ CODEX_HOME: dir }, makeDeps(), NOW);
      assert.ok(!("fallthrough" in res));
      assert.equal(res.error, "Codex auth.json is not valid JSON");
      assert.ok(!res.error.includes("secret-token"));
    });

    const validAuth = JSON.stringify({
      tokens: { access_token: "synthetic-token", refresh_token: "r" },
      last_refresh: new Date(NOW).toISOString(),
    });
    await withCodexHome(validAuth, async (dir) => {
      assert.deepEqual(
        await readCodexOAuth(
          { CODEX_HOME: dir },
          makeDeps({ fetch: (async () => new Response("", { status: 401 })) as typeof fetch }),
          NOW,
        ),
        { fallthrough: "Codex OAuth token expired or invalid" },
      );

      const s500 = await readCodexOAuth(
        { CODEX_HOME: dir },
        makeDeps({ fetch: (async () => new Response("boom", { status: 500 })) as typeof fetch }),
        NOW,
      );
      assert.ok(!("fallthrough" in s500));
      assert.equal(s500.error, "Codex usage API HTTP 500");

      const badJson = await readCodexOAuth(
        { CODEX_HOME: dir },
        makeDeps({ fetch: (async () => new Response("not-json", { status: 200 })) as typeof fetch }),
        NOW,
      );
      assert.ok(!("fallthrough" in badJson));
      assert.equal(badJson.error, "Codex usage API response was invalid");
    });
  });
});

describe("readCodex", () => {
  const AUTH_BOTH = JSON.stringify({
    personal_access_token: "synthetic-pat",
    tokens: { access_token: "synthetic-oauth", refresh_token: "r", account_id: "acct-oauth" },
    last_refresh: new Date().toISOString(),
  });
  const rpcDown = async (): Promise<unknown> => {
    throw new Error("rpc down");
  };

  it("returns the RPC reading with source: rpc and never reads credentials or fetches", async () => {
    let reads = 0;
    let fetches = 0;
    const r = await readCodex(
      "codex",
      makeDeps({
        readFile: async () => {
          reads += 1;
          return AUTH_BOTH;
        },
        fetch: (async () => {
          fetches += 1;
          return jsonResponse(whamPayload());
        }) as typeof fetch,
        rpc: async () => fixture("codex-monthly"),
      }),
    );
    assert.equal(r.source, "rpc");
    assert.equal(r.error, undefined);
    assert.equal(r.pools.length, 1);
    assert.equal(reads, 0);
    assert.equal(fetches, 0);
  });

  it("after an RPC failure uses PAT first, falls through on PAT 401 to OAuth, and stops on PAT 500", async () => {
    await withCodexHome(AUTH_BOTH, async (dir) => {
      const patOk = await readCodex(
        "codex",
        makeDeps({
          rpc: rpcDown,
          fetch: (async (input: string | URL | Request) =>
            String(input) === WHOAMI_URL
              ? jsonResponse({ chatgpt_account_id: "acct-pat" })
              : jsonResponse(whamPayload())) as typeof fetch,
        }),
        { CODEX_HOME: dir },
      );
      assert.equal(patOk.source, "pat");
      assert.equal(patOk.error, undefined);

      const pat401 = await readCodex(
        "codex",
        makeDeps({
          rpc: rpcDown,
          fetch: (async (input: string | URL | Request, init?: RequestInit) => {
            const authHeader = (init?.headers as Record<string, string> | undefined)?.Authorization;
            if (authHeader === "Bearer synthetic-pat") {
              return new Response("", { status: 401 });
            }
            assert.equal(String(input), WHAM_URL);
            assert.equal(authHeader, "Bearer synthetic-oauth");
            return jsonResponse(whamPayload());
          }) as typeof fetch,
        }),
        { CODEX_HOME: dir },
      );
      assert.equal(pat401.source, "oauth");
      assert.equal(pat401.error, undefined);

      // PAT 500 is final: no OAuth call, and the error keeps the RPC error with the PAT reason.
      let calls = 0;
      const pat500 = await readCodex(
        "codex",
        makeDeps({
          rpc: rpcDown,
          fetch: (async (input: string | URL | Request) => {
            calls += 1;
            return String(input) === WHOAMI_URL
              ? jsonResponse({ chatgpt_account_id: "acct-pat" })
              : new Response("", { status: 500 });
          }) as typeof fetch,
        }),
        { CODEX_HOME: dir },
      );
      assert.equal(pat500.error, "rpc down (PAT: Codex usage API HTTP 500)");
      assert.equal(pat500.pools.length, 0);
      assert.equal(calls, 2);
    });
  });

  it("after an RPC failure reads OAuth when there is no PAT, stopping on OAuth 500, bad body or invalid auth.json", async () => {
    const auth = JSON.stringify({
      tokens: { access_token: "synthetic-oauth", refresh_token: "r" },
      last_refresh: new Date().toISOString(),
    });
    await withCodexHome(auth, async (dir) => {
      const ok = await readCodex(
        "codex",
        makeDeps({ rpc: rpcDown, fetch: (async () => jsonResponse(whamPayload())) as typeof fetch }),
        { CODEX_HOME: dir },
      );
      assert.equal(ok.source, "oauth");
      assert.equal(ok.error, undefined);

      const s500 = await readCodex(
        "codex",
        makeDeps({ rpc: rpcDown, fetch: (async () => new Response("", { status: 500 })) as typeof fetch }),
        { CODEX_HOME: dir },
      );
      assert.equal(s500.error, "rpc down (OAuth: Codex usage API HTTP 500)");

      const badBody = await readCodex(
        "codex",
        makeDeps({
          rpc: rpcDown,
          fetch: (async () => new Response("{bad", { status: 200 })) as typeof fetch,
        }),
        { CODEX_HOME: dir },
      );
      assert.equal(badBody.error, "rpc down (OAuth: Codex usage API response was invalid)");
    });

    // Invalid auth.json ends the PAT step, so neither OAuth nor fetch runs.
    await withCodexHome("{not-valid-json-secret", async (dir) => {
      const r = await readCodex("codex", makeDeps({ rpc: rpcDown }), { CODEX_HOME: dir });
      assert.equal(r.error, "rpc down (PAT: Codex auth.json is not valid JSON)");
    });
  });

  it("combines the RPC failure with OAuth (and PAT when present) reasons, and keeps the credits guard on RPC", async () => {
    await withCodexHome(undefined, async (dir) => {
      const failed = await readCodex(
        "codex",
        makeDeps({
          rpc: async () => {
            throw new Error("codex app-server exited before answering account/rateLimits/read");
          },
        }),
        { CODEX_HOME: dir },
      );
      assert.equal(
        failed.error,
        "codex app-server exited before answering account/rateLimits/read (OAuth: no Codex OAuth credentials)",
      );

      const withCredits = fixture("codex-monthly");
      withCredits.rateLimits.credits = { hasCredits: true, unlimited: false, balance: "5.00" };
      const guarded = await readCodex("codex", makeDeps({ rpc: async () => withCredits }), {
        CODEX_HOME: dir,
      });
      assert.equal(guarded.source, "rpc");
      assert.equal(guarded.error, "codex credits can pay past your plan limit (balance 5.00)");
      assert.equal(guarded.pools.length, 1);
    });

    const patOnly = JSON.stringify({ personal_access_token: "synthetic-pat" });
    await withCodexHome(patOnly, async (dir) => {
      const failed = await readCodex(
        "codex",
        makeDeps({ fetch: (async () => new Response("", { status: 401 })) as typeof fetch, rpc: rpcDown }),
        { CODEX_HOME: dir },
      );
      assert.equal(
        failed.error,
        "rpc down (PAT: Codex PAT expired or invalid; OAuth: no Codex OAuth tokens)",
      );
    });
  });
});
