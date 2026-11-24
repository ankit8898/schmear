import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { workerEnv } from "../src/acp.ts";
import { claudeAdapter } from "../src/agents/claude.ts";
import { writeSession } from "../src/console.ts";
import {
  appendLedger,
  type LedgerLine,
  parseCredits,
  readCreditPools,
  readLedger,
  replay,
  reserveCredit,
} from "../src/credit.ts";
import { decodeSession, delegate, encodeSession } from "../src/delegate.ts";
import { route } from "../src/router.ts";
import { usageText } from "../src/server.ts";
import { configPath, readOffered, stateDir, writeAtomic } from "../src/state.ts";
import { candidates, DEFAULT_TIERS, parseTiers } from "../src/tiers.ts";
import type { AgentAdapter, Config, CreditPoolConfig, DelegateTask, Lane, TaskResult } from "../src/types.ts";
import { type FakeAgentLog, type FakeAgentScript, writeFakeAdapters } from "./fake-agent.ts";

process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), "schmear-data-"));
writeFakeAdapters();

const run = promisify(execFile);
const ID = "claude-credits@main";
const SIDE = "claude-credits@side";
const ORG_A = "aaaaaaaa-0000-4000-8000-000000000001";
const ORG_B = "bbbbbbbb-0000-4000-8000-000000000002";
const POOL: CreditPoolConfig = { org: ORG_A, keyCommand: ["true"], overageOff: true, taskCapUsd: 60 };
const ROUTABLE = ["claude@default"];
const task = (
  at: number,
  taskId: string,
  kind: "reserve" | "settle" | "exhausted",
  usd: number,
): LedgerLine => ({
  at,
  taskId,
  kind,
  usd,
});
const balance = (at: number, usd: number, floorUsd: number): LedgerLine => ({
  at,
  kind: "balance",
  usd,
  floorUsd,
});
const ledgerFile = (id = ID) => join(stateDir(), "ledger", `${id}.jsonl`);
const left = async (id = ID) => replay(await readLedger(id)).left;
const kinds = async (id = ID) => (await readLedger(id)).map((l) => [l.kind, l.usd]);

/** The fake Console: each cookie's API orgs, each org's balance (status ≠ 200 answers that status). */
interface Vendor {
  orgs: Record<string, string[]>;
  credits: Record<
    string,
    { usd: number; granted: number; expires?: string; status?: number; currency?: string }
  >;
  calls: string[];
}
let vendor: Vendor;

function fakeFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const url = new URL(String(input));
  assert.equal(url.host, "platform.claude.com");
  const cookie = (init.headers as Record<string, string>).Cookie;
  vendor.calls.push(url.pathname);
  const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  if (url.pathname === "/api/organizations") {
    return json(
      (vendor.orgs[cookie] ?? []).map((uuid) => ({
        uuid,
        name: `org ${uuid.slice(0, 4)}`,
        capabilities: ["api"],
      })),
    );
  }
  const org = url.pathname.match(/^\/api\/organizations\/([^/]+)\/prepaid\/credits$/)?.[1] as string;
  const c = vendor.credits[org];
  assert.ok(c, `unexpected request ${url.pathname}`);
  if (c.status !== undefined) return Promise.resolve(new Response("{}", { status: c.status }));
  return json({
    amount: Math.round(c.usd * 100),
    currency: c.currency ?? "USD",
    promo_tranches:
      c.granted > 0
        ? [
            {
              granted_amount_minor_units: Math.round(c.granted * 100),
              remaining_amount_minor_units: Math.round(c.usd * 100),
              expires_at: c.expires ?? null,
            },
          ]
        : [],
  });
}

let dir: string;
const saved = { state: process.env.XDG_STATE_HOME, config: process.env.XDG_CONFIG_HOME };
const restore = (name: string, value: string | undefined) => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "schmear-credits-"));
  process.env.XDG_STATE_HOME = dir;
  process.env.XDG_CONFIG_HOME = join(dir, "config");
  vendor = { orgs: { "sessionKey=a": [ORG_A] }, credits: { [ORG_A]: { usd: 100, granted: 100 } }, calls: [] };
  await writeSession("default", "sessionKey=a");
  mock.method(globalThis, "fetch", fakeFetch);
});

afterEach(() => {
  mock.restoreAll();
  restore("XDG_STATE_HOME", saved.state);
  restore("XDG_CONFIG_HOME", saved.config);
});

const read = (pools: Record<string, CreditPoolConfig>, maxAgeMs = 0) =>
  readCreditPools("claude", new Map(Object.entries(pools)), maxAgeMs);

/** Runs `body` (with `s` = credit.ts) in `n` processes started at the same instant; their stdouts. */
async function inChildren(n: number, body: string): Promise<string[]> {
  const credit = new URL("../src/credit.ts", import.meta.url).href;
  const code = `const s = await import(${JSON.stringify(credit)});
    await new Promise((r) => setTimeout(r, ${Date.now() + 500} - Date.now()));
    ${body}`;
  const outs = await Promise.all(
    Array.from({ length: n }, () =>
      run(process.execPath, ["--input-type=module", "-e", code], { env: process.env }),
    ),
  );
  return outs.map((o) => o.stdout.trim());
}

describe("replay", () => {
  const replayed = (lines: LedgerLine[]) => {
    const { base, left, open } = replay(lines, 0);
    return { base, left, open: Object.fromEntries(open) };
  };

  it("voids every reserve before the first balance line", () => {
    assert.deepEqual(replayed([task(0, "a", "reserve", 1)]), { base: undefined, left: 0, open: {} });
  });

  it("voids a reserve the earlier lines leave no room for above the floor", () => {
    const b = balance(0, 100, 2);
    assert.deepEqual(replayed([b, task(0, "a", "reserve", 60), task(0, "b", "reserve", 38)]).left, 2);
    // 39 fits in what is left (40) but would cross the floor.
    assert.deepEqual(replayed([b, task(0, "a", "reserve", 60), task(0, "b", "reserve", 39)]), {
      base: { usd: 100, floorUsd: 2 },
      left: 40,
      open: { a: 60 },
    });
  });

  it("a settle replaces its reservation; one without a valid reservation charges in full", () => {
    assert.deepEqual(
      replayed([
        balance(0, 100, 2),
        task(0, "a", "reserve", 60),
        task(0, "b", "reserve", 60),
        task(0, "a", "settle", 7),
        task(0, "b", "settle", 5),
      ]).left,
      88,
    );
  });

  it("a balance line is the new base: open reservations stay held, settles before it drop", () => {
    assert.deepEqual(
      replayed([
        balance(0, 100, 2),
        task(0, "a", "reserve", 60),
        task(0, "b", "reserve", 10),
        task(0, "b", "settle", 7),
        balance(1, 80, 2),
      ]),
      { base: { usd: 80, floorUsd: 2 }, left: 20, open: { a: 60 } },
    );
  });

  it("releases an unsettled reserve once it is older than the 24 h tool timeout", () => {
    const t0 = 1_000_000;
    const lines = [balance(t0, 100, 2), task(t0, "killed", "reserve", 10)];
    assert.deepEqual(
      { ...replay(lines, t0 + 23 * 3.6e6), open: Object.fromEntries(replay(lines, t0 + 23 * 3.6e6).open) },
      { base: { usd: 100, floorUsd: 2 }, left: 90, open: { killed: 10 } },
    );
    assert.deepEqual(
      { ...replay(lines, t0 + 25 * 3.6e6), open: Object.fromEntries(replay(lines, t0 + 25 * 3.6e6).open) },
      { base: { usd: 100, floorUsd: 2 }, left: 100, open: {} },
    );
  });

  it("exhausted leaves 0 and voids reserves until the next balance line", () => {
    const lines = [balance(0, 100, 2), task(0, "a", "reserve", 10), task(0, "x", "exhausted", 0)];
    assert.deepEqual(replayed([...lines, task(0, "b", "reserve", 1)]), {
      base: { usd: 100, floorUsd: 2 },
      left: 0,
      open: { a: 10 },
    });
    assert.equal(replayed([...lines, balance(1, 50, 2), task(1, "b", "reserve", 1)]).left, 39);
  });
});

describe("readLedger", () => {
  it("skips a trailing partial line and throws on a malformed complete one", async () => {
    await appendLedger(ID, task(1, "a", "reserve", 10));
    await appendFile(ledgerFile(), '{"at":2,"taskId":"b","ki');
    assert.deepEqual(await readLedger(ID), [task(1, "a", "reserve", 10)]);
    await appendFile(ledgerFile(), "\n");
    await assert.rejects(readLedger(ID), { message: "ledger line 2: not JSON" });
  });

  it("names the first invalid field of a complete line", async () => {
    for (const [text, field] of [
      ["null", "not an object"],
      ['{"at":"1","taskId":"a","kind":"settle","usd":1}', "at"],
      ['{"at":1,"taskId":"","kind":"settle","usd":1}', "taskId"],
      ['{"at":1,"taskId":"a","kind":"refund","usd":1}', "kind"],
      ['{"at":1,"taskId":"a","kind":"settle","usd":-1}', "usd"],
      ['{"at":1,"kind":"balance","usd":1}', "floorUsd"],
    ]) {
      await rm(ledgerFile(), { force: true });
      await appendLedger(ID, task(1, "a", "reserve", 10));
      await appendFile(ledgerFile(), `${text}\n`);
      await assert.rejects(readLedger(ID), { message: `ledger line 2: ${field}` });
    }
  });
});

describe("parseCredits", () => {
  it("skips a bad entry alone, including the 0.4 shape, and drops pools whose agent is not routable", () => {
    const { pools, invalid } = parseCredits(
      {
        [ID]: POOL,
        keyCommand: ["k"],
        "claude-credits@Bad_Name": POOL,
        "claude-credits@nokey": { ...POOL, keyCommand: [] },
        "claude-credits@open": { ...POOL, overageOff: false },
        "claude-credits@noorg": { ...POOL, org: undefined },
        "claude-credits@cap": { ...POOL, taskCapUsd: 0 },
      },
      ROUTABLE,
      7,
    );
    assert.deepEqual([...pools.keys()], [ID]);
    assert.deepEqual(Object.fromEntries([...invalid].map(([id, r]) => [id, r.error])), {
      keyCommand: "credit pool id invalid",
      "claude-credits@Bad_Name": "credit pool id invalid",
      "claude-credits@nokey": "credit pool config invalid: keyCommand",
      "claude-credits@open": "credit pool config invalid: overageOff",
      "claude-credits@noorg": "credit pool config invalid: org",
      "claude-credits@cap": "credit pool config invalid: taskCapUsd",
    });
    assert.deepEqual(invalid.get("claude-credits@open")?.pools, [
      { id: "claude-credits@open", agent: "claude", account: "open", keys: ["claude-credits"], windows: [] },
    ]);
    const none = parseCredits({ [ID]: POOL, overageOff: true }, ["claude@work"]);
    assert.equal(none.pools.size + none.invalid.size, 0);
  });
});

describe("readCreditPools", () => {
  it("spendable = last read − open reservations − settles since that read, per pool over two sessions", async () => {
    vendor.orgs = { "sessionKey=a": [ORG_A], "sessionKey=b": [ORG_B] };
    vendor.credits[ORG_B] = { usd: 40, granted: 50, expires: "2027-03-01T00:00:00Z" };
    await writeSession("second", "sessionKey=b");
    const pools = { [ID]: POOL, [SIDE]: { ...POOL, org: ORG_B } };
    const first = await read(pools);
    assert.deepEqual(first.get(ID)?.pools[0]?.usd, { left: 100, granted: 100 });
    assert.deepEqual(first.get(ID)?.pools[0]?.windows, [
      { kind: "period", remaining: 1, resetsAt: null, periodHours: 720 },
    ]);
    assert.deepEqual(first.get(SIDE)?.pools[0]?.usd, { left: 40, granted: 50 });
    assert.deepEqual(first.get(SIDE)?.pools[0]?.windows, [
      { kind: "period", remaining: 0.8, resetsAt: Date.parse("2027-03-01T00:00:00Z"), periodHours: 720 },
    ]);
    assert.deepEqual(await kinds(ID), [["balance", 100]]);
    assert.deepEqual(await kinds(SIDE), [["balance", 40]]);
    const [sideBase] = await readLedger(SIDE);
    assert.equal(sideBase?.kind === "balance" && sideBase.floorUsd, 1);

    await appendLedger(ID, task(Date.now(), "open", "reserve", 10));
    await appendLedger(ID, task(Date.now(), "done", "settle", 5));
    // The Console has not posted the spend yet: the same balance adds no line, so the settle still counts.
    assert.deepEqual((await read(pools)).get(ID)?.pools[0]?.usd, { left: 85, granted: 100 });
    vendor.credits[ORG_A] = { usd: 90, granted: 100 };
    assert.deepEqual((await read(pools)).get(ID)?.pools[0]?.usd, { left: 80, granted: 100 });
    assert.deepEqual(await kinds(ID), [
      ["balance", 100],
      ["reserve", 10],
      ["settle", 5],
      ["balance", 90],
    ]);
    assert.equal(vendor.calls.filter((p) => p === "/api/organizations").length, 6);
  });

  it("serves the cached read within maxAgeMs, and rereads for a pool the cache lacks", async () => {
    await read({ [ID]: POOL });
    const calls = vendor.calls.length;
    await read({ [ID]: POOL }, 300_000);
    assert.equal(vendor.calls.length, calls);
    vendor.orgs["sessionKey=a"] = [ORG_A, ORG_B];
    vendor.credits[ORG_B] = { usd: 5, granted: 10 };
    const both = await read({ [ID]: POOL, [SIDE]: { ...POOL, org: ORG_B } }, 300_000);
    assert.ok(vendor.calls.length > calls);
    assert.deepEqual(both.get(SIDE)?.pools[0]?.usd, { left: 5, granted: 10 });
  });

  it("an older read never replaces a newer base", async () => {
    await appendLedger(ID, balance(Date.now() + 3_600_000, 50, 1));
    assert.deepEqual((await read({ [ID]: POOL })).get(ID)?.pools[0]?.usd, { left: 50, granted: 100 });
    assert.deepEqual(await kinds(ID), [["balance", 50]]);
  });

  it("no live grant: a balance above the floor counts as full, none as empty, and B is a tenth of it", async () => {
    const { taskCapUsd: _, ...noCap } = POOL;
    vendor.credits[ORG_A] = { usd: 30, granted: 0 };
    const r = (await read({ [ID]: noCap })).get(ID);
    assert.deepEqual(r?.pools[0]?.usd, { left: 30, granted: 0 });
    assert.equal(r?.pools[0]?.windows[0]?.remaining, 1);
    assert.deepEqual(await reserveCredit(ID, noCap, 0, "a"), { budget: 3, clipped: false });
    vendor.credits[ORG_A] = { usd: 0, granted: 0 };
    assert.equal((await read({ [ID]: noCap })).get(ID)?.pools[0]?.windows[0]?.remaining, 0);
  });

  for (const [name, credits, orgs, error] of [
    ["401", { status: 401 }, [ORG_A], /session expired/],
    ["403", { status: 403 }, [ORG_A], /billing access was denied/],
    ["format", { status: 200, currency: "usd" }, [ORG_A], /format may have changed/],
    ["non-USD", { currency: "EUR" }, [ORG_A], /bills in EUR; schmear meters USD/],
    ["missing org", {}, [], /is not in any Console session; run schmear credits login claude/],
  ] as const) {
    it(`an unreadable balance (${name}) skips the pool with its message and never reserves`, async () => {
      vendor.orgs["sessionKey=a"] = orgs.length > 0 ? [...orgs] : [ORG_B];
      vendor.credits[ORG_A] = { usd: 100, granted: 100, ...credits };
      vendor.credits[ORG_B] = { usd: 100, granted: 100 };
      const r = (await read({ [ID]: POOL })).get(ID);
      assert.match(String(r?.error), error);
      assert.deepEqual(r?.pools[0]?.windows, []);
      assert.equal(r?.pools[0]?.usd, undefined);
      assert.equal(existsSync(ledgerFile()), false);
      assert.deepEqual(await reserveCredit(ID, POOL, 100, "a"), { budget: 0, clipped: true });
      assert.equal(existsSync(ledgerFile()), false);
      const routed = route({
        now: Date.now(),
        driver: null,
        readings: [r as NonNullable<typeof r>],
        config: { version: 1, agents: {} },
        exclude: new Set(),
        running: [],
        tasks: [candidates(1, parseTiers(DEFAULT_TIERS), {}, "main")],
      });
      assert.equal(routed.assignments[0], null);
      assert.match(String(routed.pools[0]?.status), /^skipped: /);
    });
  }

  it("an unreadable sessions file skips every pool alike", async () => {
    await writeAtomic(join(dir, "config", "schmear", "console-sessions.json"), "[]");
    const r = await read({ [ID]: POOL, [SIDE]: { ...POOL, org: ORG_B } });
    assert.match(String(r.get(ID)?.error), /^malformed /);
    assert.match(String(r.get(SIDE)?.error), /^malformed /);
  });
});

describe("reserveCredit", () => {
  it("reserves min(left − floor, cap), nothing at or below the floor, and a tenth of the grant by default", async () => {
    await appendLedger(ID, balance(1, 100, 2));
    assert.deepEqual(await reserveCredit(ID, POOL, 100, "a"), { budget: 60, clipped: false });
    assert.deepEqual(await reserveCredit(ID, POOL, 100, "b"), { budget: 38, clipped: true });
    assert.ok((await reserveCredit(ID, POOL, 100, "c")).budget <= 0);
    assert.deepEqual(
      (await readLedger(ID)).flatMap((l) => (l.kind === "reserve" ? [[l.taskId, l.usd]] : [])),
      [
        ["a", 60],
        ["b", 38],
      ],
    );
    const { taskCapUsd: _, ...noCap } = POOL;
    await appendLedger(SIDE, balance(1, 50, 4));
    assert.deepEqual(await reserveCredit(SIDE, noCap, 200, "d"), { budget: 20, clipped: false });
  });

  it("concurrent processes never reserve more than left − floor", async () => {
    await appendLedger(ID, balance(1, 100, 2));
    const got = (
      await inChildren(
        6,
        `console.log((await s.reserveCredit(${JSON.stringify(ID)}, ${JSON.stringify({ ...POOL, taskCapUsd: 30 })}, 100, String(process.pid))).budget);`,
      )
    )
      .map(Number)
      .sort((a, b) => b - a);
    assert.deepEqual(got, [30, 30, 30, 8, 0, 0]);
    assert.ok(Math.abs((await left()) - 2) < 1e-9);
  });
});

describe("credit spend path", () => {
  const FAKE_AGENT = fileURLToPath(new URL("./fake-agent.ts", import.meta.url));
  const KEY = "sk-test-credit-key";
  const keyCommandFor = (key: string) => [
    process.execPath,
    "-e",
    `process.stdout.write(${JSON.stringify(`${key}\n`)})`,
  ];
  const keyCommand = keyCommandFor(KEY);

  /** A claude fake on a consented config with the credit pools (default: `main` on ORG_A); the subscription pool has `claudeLeft` left. */
  async function setup(o: {
    pool?: Partial<CreditPoolConfig>;
    credits?: Record<string, unknown>;
    claudeLeft?: number;
    script?: (lane: Lane, n: number) => FakeAgentScript;
    setModel?: boolean;
  }) {
    const config: Config = {
      version: 1,
      agents: { "claude@default": { consent: true, path: "/fake/bin/claude" } },
      credits: (o.credits ?? { [ID]: { ...POOL, keyCommand, ...o.pool } }) as Record<
        string,
        CreditPoolConfig
      >,
    };
    await writeAtomic(configPath(), JSON.stringify(config));
    const launched: Lane[] = [];
    const logFiles: string[] = [];
    const adapter: AgentAdapter = {
      id: "claude",
      home: { env: "CLAUDE_CONFIG_DIR", login: [] },
      isClient: () => false,
      find: async () => ({ error: "not used" }),
      readUsage: async () => ({
        agent: "claude",
        fetchedAt: Date.now(),
        warnings: [],
        pools: [
          {
            id: "claude",
            agent: "claude",
            keys: ["claude"],
            windows: [{ kind: "period", remaining: o.claudeLeft ?? 0.5, resetsAt: null, periodHours: 168 }],
          },
        ],
      }),
      async launch(lane) {
        const n = launched.push(lane) - 1;
        const logFile = join(dir, `worker-${n}.json`);
        logFiles.push(logFile);
        const script: FakeAgentScript = { reply: "ok", logFile, ...o.script?.(lane, n) };
        return {
          command: process.execPath,
          args: [FAKE_AGENT, JSON.stringify(script)],
          env: workerEnv(),
          ...(o.setModel ? { config: { model: lane.model } } : {}),
        };
      },
      classifyFailure: claudeAdapter.classifyFailure,
      quotaRateLimit: claudeAdapter.quotaRateLimit,
    };
    const workerLog = (n: number) => JSON.parse(readFileSync(logFiles[n] as string, "utf8")) as FakeAgentLog;
    return { adapters: { claude: adapter }, launched, logFiles, workerLog };
  }

  const tasks = (n: number): DelegateTask[] =>
    Array.from({ length: n }, () => ({ prompt: "p", cwd: dir, tier: 1 }) as DelegateTask);
  const noAbort = () => ({ driver: null, signal: new AbortController().signal });
  /** Waits until the first worker's log satisfies `done`. */
  const untilLogged = async (logFiles: string[], done: (log: FakeAgentLog) => boolean) => {
    const logged = () => {
      const f = logFiles[0];
      return f !== undefined && existsSync(f) && done(JSON.parse(readFileSync(f, "utf8")) as FakeAgentLog);
    };
    while (!logged()) await sleep(20);
  };
  const leaksKey = async (results: TaskResult[]) =>
    JSON.stringify(results).includes(KEY) ||
    (await readFile(ledgerFile(), "utf8").catch(() => "")).includes(KEY);

  it("reserves B, sends it as maxBudgetUsd with the key, and settles the last reported cost", async () => {
    const { adapters, launched, workerLog } = await setup({
      script: () => ({
        usageUpdates: [
          { used: 1, size: 9, cost: { amount: 0.1, currency: "USD" } },
          { used: 2, size: 9, cost: { amount: 0.25, currency: "USD" } },
        ],
      }),
    });
    const results = await delegate({ tasks: tasks(1) }, noAbort(), adapters);
    assert.equal(results[0]?.status, "done");
    assert.equal(results[0]?.costUsd, 0.25);
    assert.equal(results[0]?.account, "main");
    assert.equal(launched[0]?.id, "claude-credits@main:haiku");
    assert.deepEqual(workerLog(0).sessionMeta, { claudeCode: { options: { maxBudgetUsd: 60 } } });
    assert.equal(workerLog(0).apiKey, KEY);
    assert.deepEqual(await kinds(), [
      ["balance", 100],
      ["reserve", 60],
      ["settle", 0.25],
    ]);
    const [, reserve, settle] = await readLedger(ID);
    assert.equal(
      reserve?.kind !== "balance" && reserve?.taskId,
      settle?.kind !== "balance" && settle?.taskId,
    );
    assert.equal(await left(), 99.75);
    assert.equal(await leaksKey(results), false);
  });

  it("each pool spends only its own key and ledger", async () => {
    vendor.orgs = { "sessionKey=a": [ORG_A], "sessionKey=b": [ORG_B] };
    vendor.credits = { [ORG_A]: { usd: 1, granted: 100 }, [ORG_B]: { usd: 50, granted: 100 } };
    await writeSession("second", "sessionKey=b");
    const { adapters, launched, workerLog } = await setup({
      claudeLeft: 0,
      credits: {
        [ID]: { ...POOL, keyCommand },
        [SIDE]: { ...POOL, org: ORG_B, keyCommand: keyCommandFor("sk-side") },
      },
    });
    const results = await delegate({ tasks: tasks(1) }, noAbort(), adapters);
    assert.equal(results[0]?.status, "done");
    assert.deepEqual(
      launched.map((l) => l.id),
      ["claude-credits@side:haiku"],
    );
    assert.equal(workerLog(0).apiKey, "sk-side");
    assert.deepEqual(await kinds(ID), [["balance", 1]]);
    assert.deepEqual((await kinds(SIDE)).slice(0, 2), [
      ["balance", 50],
      ["reserve", 48],
    ]);
  });

  it("an unreadable balance routes the subscription and writes no ledger", async () => {
    vendor.credits[ORG_A] = { usd: 100, granted: 100, status: 401 };
    const { adapters, launched, workerLog } = await setup({});
    const results = await delegate({ tasks: tasks(1) }, noAbort(), adapters);
    assert.equal(results[0]?.status, "done");
    assert.deepEqual(
      launched.map((l) => l.id),
      ["claude@default:haiku"],
    );
    assert.equal(workerLog(0).apiKey, undefined);
    assert.equal(existsSync(ledgerFile()), false);
  });

  it("settles a killed task's full reservation when it reported no cost", async () => {
    const { adapters, logFiles } = await setup({ script: () => ({ sleepMs: 10_000 }) });
    const abort = new AbortController();
    const pending = delegate({ tasks: tasks(1) }, { driver: null, signal: abort.signal }, adapters);
    await untilLogged(logFiles, (log) => log.promptCalled);
    abort.abort();
    const results = await pending;
    assert.equal(results[0]?.status, "cancelled");
    assert.deepEqual(await kinds(), [
      ["balance", 100],
      ["reserve", 60],
      ["settle", 60],
    ]);
    assert.equal(await left(), 40);
  });

  for (const [name, error] of [
    ["billing_error", { code: -32603, message: "billing", data: { errorKind: "billing_error" } }],
    ["credit balance is too low", { code: -32603, message: "Your credit balance is too low" }],
  ] as const) {
    it(`${name} settles, writes exhausted, then reroutes to the subscription without the key`, async () => {
      const { adapters, launched, workerLog } = await setup({
        script: (lane) =>
          lane.key === "claude-credits"
            ? { usageUpdates: [{ used: 1, size: 9, cost: { amount: 0.5, currency: "USD" } }], error }
            : { reply: "sub" },
      });
      const results = await delegate({ tasks: tasks(1) }, noAbort(), adapters);
      assert.equal(results[0]?.status, "done");
      assert.equal(results[0]?.reply, "sub");
      assert.deepEqual(results[0]?.notes, ["rerouted from claude-credits@main:haiku: quota"]);
      assert.deepEqual(
        launched.map((l) => l.id),
        ["claude-credits@main:haiku", "claude@default:haiku"],
      );
      // The reread on the quota outcome got the same balance, so exhausted stands.
      assert.deepEqual(await kinds(), [
        ["balance", 100],
        ["reserve", 60],
        ["settle", 0.5],
        ["exhausted", 0],
      ]);
      assert.equal(await left(), 0);
      assert.equal(workerLog(1).apiKey, undefined);
      assert.equal(workerLog(1).sessionMeta, undefined);
      assert.equal(await leaksKey(results), false);
    });
  }

  it("takes B ≤ 0 at reserve time as a quota outcome", async () => {
    const { adapters, logFiles } = await setup({
      pool: { taskCapUsd: 98 },
      claudeLeft: 0,
      script: () => ({ usageUpdates: [{ used: 1, size: 9, cost: { amount: 1, currency: "USD" } }] }),
    });
    const results = await delegate({ tasks: tasks(2) }, noAbort(), adapters);
    assert.deepEqual(results.map((r) => r.status).sort(), ["done", "no_quota"]);
    const refused = results.find((r) => r.status === "no_quota");
    assert.deepEqual(refused?.notes, ["rerouted from claude-credits@main:haiku: quota"]);
    // launch() runs before the reservation, but only one worker spawned
    assert.deepEqual(logFiles.map((f) => existsSync(f)).sort(), [false, true]);
    assert.deepEqual(await kinds(), [
      ["balance", 100],
      ["reserve", 98],
      ["settle", 1],
    ]);
  });

  // claude-agent-acp sends the stop as an error, or, when the result is not `is_error`, as `max_turn_requests`.
  const stops: [string, (usd: number) => Partial<FakeAgentScript>][] = [
    [
      "error",
      (usd) => ({ error: { code: -32603, message: `Internal error: Reached maximum budget ($${usd})` } }),
    ],
    ["max_turn_requests", () => ({ stopReason: "max_turn_requests" })],
  ];
  for (const [form, stop] of stops) {
    const budgetStop = (usd: number): Partial<FakeAgentScript> => ({
      usageUpdates: [{ used: 1, size: 9, cost: { amount: usd + 0.25, currency: "USD" } }],
      ...stop(usd),
    });

    it(`takes a budget stop (${form}) as a quota outcome when the pool clipped B below the cap`, async () => {
      vendor.credits[ORG_A] = { usd: 50, granted: 100 };
      const { adapters, launched } = await setup({
        claudeLeft: 0.3,
        script: (lane) => (lane.key === "claude-credits" ? budgetStop(48) : { reply: "sub" }),
      });
      const results = await delegate({ tasks: tasks(1) }, noAbort(), adapters);
      assert.equal(results[0]?.status, "done");
      assert.equal(results[0]?.reply, "sub");
      assert.deepEqual(results[0]?.notes, ["rerouted from claude-credits@main:haiku: quota"]);
      assert.deepEqual(
        launched.map((l) => l.id),
        ["claude-credits@main:haiku", "claude@default:haiku"],
      );
      assert.deepEqual(await kinds(), [
        ["balance", 50],
        ["reserve", 48],
        ["settle", 48.25],
      ]);
    });

    it(`keeps a budget stop (${form}) at the task cap failed`, async () => {
      const { adapters, launched } = await setup({ script: () => budgetStop(60) });
      const results = await delegate({ tasks: tasks(1) }, noAbort(), adapters);
      assert.equal(results[0]?.status, "failed");
      assert.deepEqual(
        launched.map((l) => l.id),
        ["claude-credits@main:haiku"],
      );
      assert.deepEqual(await kinds(), [
        ["balance", 100],
        ["reserve", 60],
        ["settle", 60.25],
      ]);
    });
  }

  it("reroutes past a failing key command without its output, reserving nothing", async () => {
    const { adapters, launched, workerLog } = await setup({
      pool: {
        keyCommand: [
          process.execPath,
          "-e",
          "process.stdout.write('sk-out-leak'); process.stderr.write('sk-err-leak'); process.exit(3)",
        ],
      },
    });
    const results = await delegate({ tasks: tasks(1) }, noAbort(), adapters);
    assert.equal(results[0]?.status, "done");
    assert.deepEqual(results[0]?.notes, [
      `claude-credits@main key command failed: ${process.execPath} exit 3`,
    ]);
    assert.doesNotMatch(JSON.stringify(results), /leak/);
    assert.deepEqual(
      launched.map((l) => l.id),
      ["claude-credits@main:haiku", "claude@default:haiku"],
    );
    assert.equal(workerLog(1).apiKey, undefined);
    assert.deepEqual(await kinds(), [["balance", 100]]);
  });

  it("reroutes to the subscription when the reserve cannot be written", async () => {
    const { adapters, launched, workerLog } = await setup({});
    await appendLedger(ID, balance(Date.now(), 100, 2));
    await chmod(ledgerFile(), 0o444);
    const results = await delegate({ tasks: tasks(1) }, noAbort(), adapters);
    assert.equal(results[0]?.status, "done");
    assert.deepEqual(results[0]?.notes, ["claude-credits@main ledger write failed: EACCES"]);
    assert.deepEqual(
      launched.map((l) => l.id),
      ["claude-credits@main:haiku", "claude@default:haiku"],
    );
    assert.equal(workerLog(1).apiKey, undefined);
  });

  it("skips the pool when its balance line cannot be written", async () => {
    const { adapters, launched } = await setup({});
    await appendLedger(ID, balance(1, 70, 2));
    await chmod(ledgerFile(), 0o444);
    const results = await delegate({ tasks: tasks(1) }, noAbort(), adapters);
    assert.equal(results[0]?.status, "done");
    assert.deepEqual(
      launched.map((l) => l.id),
      ["claude@default:haiku"],
    );
    assert.match(
      await usageText(adapters, null),
      /## claude-credits@main\nskipped: credit ledger write failed: EACCES/,
    );
  });

  it("keeps the task done with a note when the settle cannot be written", async () => {
    const { adapters, logFiles } = await setup({
      script: () => ({
        sleepMs: 1_000,
        usageUpdates: [{ used: 1, size: 9, cost: { amount: 2, currency: "USD" } }],
      }),
    });
    const pending = delegate({ tasks: tasks(1) }, noAbort(), adapters);
    await untilLogged(logFiles, (log) => log.promptCalled);
    await chmod(ledgerFile(), 0o444);
    const results = await pending;
    assert.equal(results[0]?.status, "done");
    assert.equal(results[0]?.reply, "ok");
    assert.deepEqual(results[0]?.notes, ["claude-credits@main ledger write failed after the run: EACCES"]);
    assert.deepEqual(await kinds(), [
      ["balance", 100],
      ["reserve", 60],
    ]);
  });

  it("an unreadable ledger skips the credit pool alone; the subscription still routes and usage says why", async () => {
    const { adapters, launched } = await setup({});
    await mkdir(join(stateDir(), "ledger"), { recursive: true });
    await appendFile(ledgerFile(), "not json\n");
    const results = await delegate({ tasks: tasks(1) }, noAbort(), adapters);
    assert.equal(results[0]?.status, "done");
    assert.deepEqual(
      launched.map((l) => l.id),
      ["claude@default:haiku"],
    );
    const text = await usageText(adapters, null);
    assert.match(text, /## claude-credits@main\nskipped: credit ledger unreadable: ledger line 1: not JSON/);
    assert.match(text, /pool claude@default: .* \| ok/);
  });

  it("settles 0 for a credit run that ended before the prompt (model not offered)", async () => {
    const offered: NonNullable<FakeAgentScript["configOptions"]> = [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "sonnet",
        options: [{ value: "sonnet", name: "sonnet" }],
      },
    ];
    const { adapters, launched } = await setup({
      setModel: true,
      script: () => ({
        configOptions: offered,
        usageUpdates: [{ used: 1, size: 9, cost: { amount: 2, currency: "USD" } }],
      }),
    });
    const results = await delegate({ tasks: tasks(1) }, noAbort(), adapters);
    assert.equal(results[0]?.status, "done");
    assert.deepEqual(
      launched.map((l) => l.id),
      ["claude-credits@main:haiku", "claude-credits@main:sonnet"],
    );
    assert.deepEqual(await kinds(), [
      ["balance", 100],
      ["reserve", 60],
      ["settle", 0],
      ["reserve", 60],
      ["settle", 2],
    ]);
    assert.equal(await left(), 98);
    assert.deepEqual(await readOffered(ID), ["sonnet"]);
    assert.equal(await readOffered("claude@default"), undefined);
  });

  it("settles the maximum cost reported, not a lower last one", async () => {
    const { adapters } = await setup({
      script: () => ({
        usageUpdates: [
          { used: 1, size: 9, cost: { amount: 3, currency: "USD" } },
          { used: 2, size: 9, cost: { amount: 0, currency: "USD" } },
        ],
        error: { code: -32603, message: "crashed" },
      }),
    });
    const results = await delegate({ tasks: tasks(1) }, noAbort(), adapters);
    assert.equal(results[0]?.status, "failed");
    assert.deepEqual(await kinds(), [
      ["balance", 100],
      ["reserve", 60],
      ["settle", 3],
    ]);
  });

  it("settles 0 for a credit run aborted before its prompt was sent", async () => {
    const { adapters, logFiles } = await setup({ script: () => ({ stallNew: true }) });
    const abort = new AbortController();
    const pending = delegate({ tasks: tasks(1) }, { driver: null, signal: abort.signal }, adapters);
    await untilLogged(logFiles, (log) => log.sessionCalls.includes("new"));
    abort.abort();
    const results = await pending;
    assert.equal(results[0]?.status, "cancelled");
    assert.deepEqual(await kinds(), [
      ["balance", 100],
      ["reserve", 60],
      ["settle", 0],
    ]);
  });

  const creditHandle = () =>
    encodeSession({
      agent: "claude",
      account: "main",
      key: "claude-credits",
      model: "haiku",
      effort: "medium",
      tier: 1,
      sessionId: "old",
      cwd: dir,
    });

  it("settles 0 for a credit resume the agent rejects", async () => {
    const { adapters, launched } = await setup({
      script: () => ({
        advertiseResume: true,
        error: { stage: "session_resume", code: -32603, message: "gone" },
      }),
    });
    const session = await creditHandle();
    const results = await delegate(
      { tasks: [{ ...tasks(1)[0], session } as DelegateTask] },
      noAbort(),
      adapters,
    );
    assert.equal(results[0]?.status, "failed");
    assert.equal(launched[0]?.id, "claude-credits@main:haiku");
    assert.deepEqual(await kinds(), [
      ["balance", 100],
      ["reserve", 60],
      ["settle", 0],
    ]);
  });

  it("a resume on a pool no longer configured ends no_quota without a launch", async () => {
    const { adapters, launched } = await setup({ credits: {} });
    const session = await creditHandle();
    const results = await delegate(
      { tasks: [{ ...tasks(1)[0], session } as DelegateTask] },
      noAbort(),
      adapters,
    );
    assert.equal(results[0]?.status, "no_quota");
    assert.deepEqual(launched, []);
  });

  it("settles a resume's own spend: the session's saved total is not charged again", async () => {
    // The fake reports the cumulative total, as the SDK does for a resumed session: $4, then $4 + $1.
    const { adapters } = await setup({
      script: (_lane, n) => ({
        advertiseResume: true,
        usageUpdates: [{ used: 1, size: 9, cost: { amount: n === 0 ? 4 : 5, currency: "USD" } }],
      }),
    });
    const [first] = await delegate({ tasks: tasks(1) }, noAbort(), adapters);
    assert.equal(first?.costUsd, 4);
    assert.equal((await decodeSession(first?.session ?? ""))?.costUsd, 4);
    const resumed = { ...tasks(1)[0], session: first?.session } as DelegateTask;
    const [second] = await delegate({ tasks: [resumed] }, noAbort(), adapters);
    assert.equal(second?.status, "done");
    assert.equal(second?.costUsd, 1);
    assert.equal((await decodeSession(second?.session ?? ""))?.costUsd, 5);
    assert.deepEqual(await kinds(), [
      ["balance", 100],
      ["reserve", 60],
      ["settle", 4],
      ["reserve", 60],
      ["settle", 1],
    ]);
    assert.equal(await left(), 95);
  });

  it("never reads, routes or reserves a pool without overageOff", async () => {
    const { adapters, launched } = await setup({ pool: { overageOff: false as true } });
    const results = await delegate({ tasks: tasks(1) }, noAbort(), adapters);
    assert.equal(results[0]?.status, "done");
    assert.deepEqual(
      launched.map((l) => l.id),
      ["claude@default:haiku"],
    );
    assert.deepEqual(vendor.calls, []);
    assert.equal(existsSync(ledgerFile()), false);
  });

  it("gives the key only to the credit-lane worker of a batch", async () => {
    const parent = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-parent-env";
    try {
      // Both pools full with no reset: the same pace, so a batch of two spreads over them.
      const { adapters, launched, workerLog } = await setup({ claudeLeft: 1 });
      const results = await delegate({ tasks: tasks(2) }, noAbort(), adapters);
      assert.deepEqual(
        results.map((r) => r.status),
        ["done", "done"],
      );
      assert.deepEqual(launched.map((l) => l.id).sort(), [
        "claude-credits@main:haiku",
        "claude@default:haiku",
      ]);
      const credit = launched.findIndex((l) => l.key === "claude-credits");
      assert.equal(workerLog(credit).apiKey, KEY);
      assert.equal(workerLog(1 - credit).apiKey, undefined);
      assert.equal(workerLog(1 - credit).sessionMeta, undefined);
      assert.equal(await leaksKey(results), false);
    } finally {
      restore("ANTHROPIC_API_KEY", parent);
    }
  });

  it("claude launch requires the API key auth on a credit lane and the account otherwise", async () => {
    const lane: Lane = {
      id: "claude@default:haiku",
      agent: "claude",
      account: "default",
      key: "claude",
      tier: 1,
      model: "haiku",
      effort: "low",
    };
    const credit: Lane = { ...lane, id: "claude-credits@main:haiku", account: "main", key: "claude-credits" };
    assert.deepEqual((await claudeAdapter.launch(lane, dir, "/fake/claude")).requireAuth, {
      kind: "account",
    });
    const spec = await claudeAdapter.launch(credit, dir, "/fake/claude");
    assert.deepEqual(spec.requireAuth, { kind: "api_key", detail: "ANTHROPIC_API_KEY" });
    assert.equal(spec.env.ANTHROPIC_API_KEY, undefined);
  });
});
