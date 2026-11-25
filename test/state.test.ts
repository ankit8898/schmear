import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { window } from "../src/agents/shared.ts";
import {
  configPath,
  DEFAULT_MAX_TASKS,
  readConfig,
  readOffered,
  readTiers,
  stateDir,
  USAGE_ROUTE_MS,
  USAGE_SHOW_MS,
  usage,
  writeAtomic,
  writeLimit,
  writeOffered,
  writeTiers,
} from "../src/state.ts";
import { DEFAULT_TIERS } from "../src/tiers.ts";
import { creditLogin, isCreditKey, LANE_KEYS, parseCreditPool, type UsageReading } from "../src/types.ts";

let dir: string;
const saved = { state: process.env.XDG_STATE_HOME, config: process.env.XDG_CONFIG_HOME };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "schmear-state-"));
  process.env.XDG_STATE_HOME = join(dir, "state");
  process.env.XDG_CONFIG_HOME = join(dir, "config");
});

afterEach(() => {
  for (const [name, value] of [
    ["XDG_STATE_HOME", saved.state],
    ["XDG_CONFIG_HOME", saved.config],
  ] as const) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

describe("paths", () => {
  it("follow the XDG variables", () => {
    assert.equal(stateDir(), join(dir, "state", "schmear"));
    assert.equal(configPath(), join(dir, "config", "schmear", "config.json"));
  });

  it("fall back to ~/.local/state and ~/.config", () => {
    assert.match(stateDir({}), /\.local[/\\]state[/\\]schmear$/);
    assert.match(configPath({}), /\.config[/\\]schmear[/\\]config\.json$/);
  });
});

describe("writeAtomic", () => {
  it("creates parent dirs and leaves no tmp file", async () => {
    const path = join(dir, "a", "b", "file.json");
    await writeAtomic(path, "one");
    await writeAtomic(path, "two");
    assert.deepEqual(await readdir(join(dir, "a", "b")), ["file.json"]);
  });

  it("creates a new file 0600 in a new dir 0700, and keeps a given mode", async () => {
    await writeOffered("grok", ["a"]);
    assert.equal((await stat(join(stateDir(), "offered", "grok.json"))).mode & 0o777, 0o600);
    assert.equal((await stat(join(stateDir(), "offered"))).mode & 0o777, 0o700);
    const host = join(dir, "host.toml");
    await writeAtomic(host, "x", 0o644);
    assert.equal((await stat(host)).mode & 0o777, 0o644);
  });
});

describe("usage cache", () => {
  const reading = (fetchedAt: number, error?: string): UsageReading => ({
    agent: "codex",
    account: "default",
    fetchedAt,
    pools: [],
    warnings: [],
    ...(error ? { error } : {}),
  });

  it("hits under maxAgeMs, rereads at or over it, and 0 always reads", async () => {
    assert.equal(USAGE_SHOW_MS, 60_000);
    assert.equal(USAGE_ROUTE_MS, 300_000);

    let calls = 0;
    const read = async () => reading(1_000 + 100 * ++calls);

    await usage("codex@default", read, USAGE_SHOW_MS, 1_000);
    assert.equal(calls, 1);
    await usage("codex@default", read, USAGE_SHOW_MS, 60_000);
    assert.equal(calls, 1);
    await usage("codex@default", read, USAGE_SHOW_MS, 61_100);
    assert.equal(calls, 2);

    // 4 min later: still under USAGE_ROUTE_MS, then at it
    await usage("codex@default", read, USAGE_ROUTE_MS, 1_200 + 240_000);
    assert.equal(calls, 2);
    await usage("codex@default", read, USAGE_ROUTE_MS, 1_200 + USAGE_ROUTE_MS);
    assert.equal(calls, 3);

    // maxAgeMs = 0 always rereads and refreshes the cache
    const fresh = await usage("codex@default", read, 0, 1_300);
    assert.equal(calls, 4);
    assert.equal(fresh.fetchedAt, 1_400);
    assert.deepEqual(await usage("codex@default", read, USAGE_SHOW_MS, 1_400), fresh);
    assert.equal(calls, 4);
  });

  it("serves a failed reading at most USAGE_SHOW_MS, even to routing", async () => {
    let calls = 0;
    const read = async () => {
      calls++;
      return reading(10_000, "timed out");
    };
    await usage("grok", read, USAGE_ROUTE_MS, 10_000);
    await usage("grok", read, USAGE_ROUTE_MS, 10_000 + USAGE_SHOW_MS - 1);
    assert.equal(calls, 1);
    await usage("grok", read, USAGE_ROUTE_MS, 10_000 + USAGE_SHOW_MS);
    assert.equal(calls, 2);
  });

  it("caches error readings", async () => {
    let calls = 0;
    const read = async () => {
      calls++;
      return reading(5_000, "no login");
    };
    const first = await usage("codex@default", read, USAGE_SHOW_MS, 5_000);
    const second = await usage("codex@default", read, USAGE_SHOW_MS, 6_000);
    assert.equal(calls, 1);
    assert.equal(second.error, "no login");
    assert.deepEqual(second, first);
  });
});

describe("usage and offered caches per account", () => {
  it("key the files by instance id and key id", async () => {
    await usage(
      "claude@work",
      async () => ({ agent: "claude", account: "work", fetchedAt: 1, pools: [], warnings: [] }),
      0,
    );
    await writeOffered("claude-credits@work", ["a"]);
    assert.deepEqual(await readdir(join(stateDir(), "usage")), ["claude@work.json"]);
    assert.deepEqual(await readOffered("claude-credits@work"), ["a"]);
    assert.equal(await readOffered("claude-credits@default"), undefined);
  });
});

describe("offered list", () => {
  it("is unknown when missing, readable within 24 h, and ignored after", async () => {
    assert.equal(await readOffered("grok", 1_000), undefined);
    await writeOffered("grok", ["a", "b"], 1_000);
    assert.deepEqual(await readOffered("grok", 1_000 + 24 * 3_600_000 - 1), ["a", "b"]);
    assert.equal(await readOffered("grok", 1_000 + 24 * 3_600_000), undefined);
  });

  it("is stored as {fetchedAt, models} under S/offered", async () => {
    await writeOffered("grok", ["a"], 5);
    assert.deepEqual(JSON.parse(await readFile(join(stateDir(), "offered", "grok.json"), "utf8")), {
      fetchedAt: 5,
      models: ["a"],
    });
  });
});

describe("readConfig", () => {
  it("returns an empty config when the file is missing", async () => {
    assert.deepEqual(await readConfig(), { version: 1, agents: {} });
  });

  it("reads a valid file with custom tiers and reserve", async () => {
    const config = {
      version: 1,
      agents: { "codex@default": { consent: true, path: "/bin/codex" } },
      tiers: [["claude:sonnet@low", "codex:gpt-5.6-terra@medium"], ["claude:opus@high"]],
      reserve: { claude: 0, codex: 0.25 },
    };
    await mkdir(join(dir, "config", "schmear"), { recursive: true });
    await writeFile(configPath(), JSON.stringify(config));
    assert.deepEqual(await readConfig(), config);
  });

  it("throws naming the file when malformed", async () => {
    await mkdir(join(dir, "config", "schmear"), { recursive: true });
    await writeFile(configPath(), "{not json");
    await assert.rejects(readConfig(), (err: Error) => err.message.includes(configPath()));
    await writeFile(configPath(), JSON.stringify({ version: 2, agents: {} }));
    await assert.rejects(readConfig(), (err: Error) => err.message.includes(configPath()));
  });

  it("rejects a non-boolean consent, an empty path, and an unknown key", async () => {
    await mkdir(join(dir, "config", "schmear"), { recursive: true });
    const path = configPath();
    const cases: [Record<string, unknown>, string][] = [
      [
        { agents: { "claude@default": { consent: "false", path: "/bin/claude" } } },
        `malformed config ${path}: agents.claude@default.consent: Invalid input: expected boolean, received string`,
      ],
      [
        { agents: { "codex@default": { consent: true, path: "" } } },
        `malformed config ${path}: agents.codex@default.path: Too small: expected string to have >=1 characters`,
      ],
      [{ agents: {}, creditPools: [] }, `malformed config ${path}: Unrecognized key: "creditPools"`],
      [{ agents: {}, credits: [] }, `malformed config ${path}: credits: must be an object`],
    ];
    for (const [extra, expected] of cases) {
      await writeFile(path, JSON.stringify({ version: 1, ...extra }));
      await assert.rejects(readConfig(), { message: expected });
    }
  });

  it("loads the 0.4 and 0.5 credits shapes; entries are checked when read", async () => {
    await mkdir(join(dir, "config", "schmear"), { recursive: true });
    const agents = { "claude@default": { consent: true, path: "/bin/claude" } };
    const old = { grantUsd: 100, cycleDay: 5, keyCommand: ["k"], taskCapUsd: 10, overageOff: true };
    const pool = { org: "o-1", keyCommand: ["k"], overageOff: true };
    for (const credits of [old, { "claude-credits@main": pool, "claude-credits@bad": 3 }]) {
      const config = { version: 1, agents, credits };
      await writeFile(configPath(), JSON.stringify(config));
      assert.deepEqual(await readConfig(), config);
    }
  });

  it("accepts an added subscription with an absolute home and rejects bad instance keys", async () => {
    await mkdir(join(dir, "config", "schmear"), { recursive: true });
    const path = configPath();
    const ok = {
      version: 1,
      agents: {
        "claude@default": { consent: true, path: "/bin/claude" },
        "claude@work": { consent: true, path: "/bin/claude", home: "/h/.claude-work" },
      },
    };
    await writeFile(path, JSON.stringify(ok));
    assert.deepEqual(await readConfig(), ok);
    const entry = { consent: true, path: "/bin/claude" };
    const cases: [Record<string, unknown>, string][] = [
      [
        { "claude@work": entry },
        `malformed config ${path}: agents.claude@work: an added subscription needs "home"`,
      ],
      [
        { "claude@default": { ...entry, home: "/h" } },
        `malformed config ${path}: agents.claude@default: "home" is only for an added subscription (claude@<nickname>)`,
      ],
      [
        { claude: { ...entry, home: "/h" } },
        `malformed config ${path}: agents.claude@default: "home" is only for an added subscription (claude@<nickname>)`,
      ],
      [
        { claude: entry, "claude@default": entry },
        `malformed config ${path}: agents: "claude" and "claude@default" are the same subscription; keep one`,
      ],
      [
        { "foo@x": { ...entry, home: "/h" } },
        `malformed config ${path}: agents: unknown agent or bad account name "foo@x"`,
      ],
      [
        { "claude@Bad_Name": { ...entry, home: "/h" } },
        `malformed config ${path}: agents: unknown agent or bad account name "claude@Bad_Name"`,
      ],
      [
        { "claude@work": { ...entry, home: "rel" } },
        `malformed config ${path}: agents.claude@work.home: must be an absolute path`,
      ],
    ];
    for (const [agents, expected] of cases) {
      await writeFile(path, JSON.stringify({ version: 1, agents }));
      await assert.rejects(readConfig(), { message: expected });
    }
  });

  it("reads a 0.1.x config's bare agent key as <agent>@default", async () => {
    await mkdir(join(dir, "config", "schmear"), { recursive: true });
    const entry = { consent: true, path: "/bin/claude" };
    const work = { ...entry, home: "/h/work" };
    await writeFile(
      configPath(),
      JSON.stringify({ version: 1, agents: { claude: entry, "claude@work": work } }),
    );
    assert.deepEqual((await readConfig()).agents, { "claude@default": entry, "claude@work": work });
  });

  it("validates tiers and reserve with messages naming the file", async () => {
    await mkdir(join(dir, "config", "schmear"), { recursive: true });
    const path = configPath();
    const cases: [Record<string, unknown>, string][] = [
      [
        { tiers: { claude: {} } },
        `malformed config ${path}: tiers must be a non-empty list of tiers, each a non-empty list of "key:model@effort" strings`,
      ],
      [{ tiers: [[]] }, `malformed config ${path}: tier 1 is empty`],
      [
        { tiers: [["claude:haiku"]] },
        `malformed config ${path}: tier 1 entry "claude:haiku": expected "key:model@effort"`,
      ],
      [
        { tiers: [["bogus:haiku@medium"]] },
        `malformed config ${path}: tier 1 entry "bogus:haiku@medium": unknown lane key "bogus" (one of claude, codex, grok, agy-gemini, agy-argon, agy-3p, claude-credits, gemini-credits)`,
      ],
      [
        { tiers: [["claude:haiku@low", "claude:haiku@high"]] },
        `malformed config ${path}: tier 1 entry "claude:haiku@high": claude:haiku is listed twice in this tier`,
      ],
      [{ reserve: 0.1 }, `malformed config ${path}: reserve must be an object`],
      [{ reserve: [] }, `malformed config ${path}: reserve must be an object`],
      [{ reserve: null }, `malformed config ${path}: reserve must be an object`],
      [{ reserve: { bogus: 0.1 } }, `malformed config ${path}: reserve: unknown agent "bogus"`],
      [
        { reserve: { claude: -0.01 } },
        `malformed config ${path}: reserve.claude must be a fraction from 0 to 1, e.g. 0.05 for 5%`,
      ],
      [
        { reserve: { claude: 1 } },
        `malformed config ${path}: reserve.claude must be a fraction from 0 to 1, e.g. 0.05 for 5%`,
      ],
      [
        { reserve: { claude: "0.05" } },
        `malformed config ${path}: reserve.claude must be a fraction from 0 to 1, e.g. 0.05 for 5%`,
      ],
      [{ maxTasks: 0 }, `malformed config ${path}: maxTasks: must be a whole number of at least 1`],
      [{ maxTasks: 2.5 }, `malformed config ${path}: maxTasks: must be a whole number of at least 1`],
      [{ maxTasks: "8" }, `malformed config ${path}: maxTasks: must be a whole number of at least 1`],
      [{ maxPerPool: 0 }, `malformed config ${path}: maxPerPool: must be a whole number of at least 1`],
      [{ maxPerPool: 2.5 }, `malformed config ${path}: maxPerPool: must be a whole number of at least 1`],
      [{ maxPerPool: "8" }, `malformed config ${path}: maxPerPool: must be a whole number of at least 1`],
    ];
    for (const [extra, expected] of cases) {
      await writeFile(path, JSON.stringify({ version: 1, agents: {}, ...extra }));
      await assert.rejects(readConfig(), { message: expected });
    }
  });
});

describe("tiers read and write", () => {
  const seed = {
    version: 1,
    agents: { "codex@default": { consent: true, path: "/bin/codex" } },
    reserve: { claude: 0.1 },
  };
  const writeSeed = async (extra: Record<string, unknown> = {}) => {
    await mkdir(join(dir, "config", "schmear"), { recursive: true });
    await writeFile(configPath(), JSON.stringify({ ...seed, ...extra }));
  };

  it("reads the default, then the config's list, with offered holding only known lists", async () => {
    await writeOffered("grok@default", ["grok-4.7"]);
    await writeOffered("codex@work", ["gpt-5.6-terra"]);
    const doc = await readTiers();
    assert.equal(doc.source, "default");
    assert.deepEqual(doc.tiers, DEFAULT_TIERS);
    assert.deepEqual(doc.defaults, DEFAULT_TIERS);
    assert.deepEqual(doc.laneKeys, [...LANE_KEYS]);
    assert.deepEqual(doc.offered, { grok: ["grok-4.7"] });
    assert.equal(doc.maxTasks, DEFAULT_MAX_TASKS);

    await writeSeed({ tiers: [["claude:haiku@low"]], maxTasks: 12 });
    const custom = await readTiers();
    assert.equal(custom.source, "config");
    assert.equal(custom.maxTasks, 12);
    assert.deepEqual(custom.tiers, [["claude:haiku@low"]]);
    assert.deepEqual(custom.defaults, DEFAULT_TIERS);
  });

  it("writes a valid list, keeping the config's other keys", async () => {
    await writeSeed();
    await writeTiers([["claude:haiku@low"], ["claude:opus@high"]]);
    assert.deepEqual(JSON.parse(await readFile(configPath(), "utf8")), {
      ...seed,
      tiers: [["claude:haiku@low"], ["claude:opus@high"]],
    });
  });

  it("creates the config when missing", async () => {
    await writeTiers([["claude:haiku@low"]]);
    assert.deepEqual(await readConfig(), { version: 1, agents: {}, tiers: [["claude:haiku@low"]] });
  });

  it("throws the parseTiers message for an invalid list and leaves the file unchanged", async () => {
    await writeSeed({ tiers: [["claude:haiku@low"]] });
    const before = await readFile(configPath(), "utf8");
    await assert.rejects(writeTiers([["bogus:haiku@medium"]]), {
      message: /^tier 1 entry "bogus:haiku@medium": unknown lane key "bogus"/,
    });
    await assert.rejects(writeTiers({}), { message: /^tiers must be a non-empty list/ });
    assert.equal(await readFile(configPath(), "utf8"), before);
  });

  it("removes tiers on null", async () => {
    await writeSeed({ tiers: [["claude:haiku@low"]] });
    await writeTiers(null);
    assert.deepEqual(JSON.parse(await readFile(configPath(), "utf8")), seed);
    assert.equal((await readTiers()).source, "default");
  });

  it("writes maxTasks keeping the config's other keys, rejects a bad value, and removes it on null", async () => {
    await writeSeed();
    await writeLimit("maxTasks", 12);
    assert.deepEqual(JSON.parse(await readFile(configPath(), "utf8")), { ...seed, maxTasks: 12 });
    for (const bad of [0, 1.5, Number.NaN]) {
      await assert.rejects(writeLimit("maxTasks", bad), {
        message: "max-tasks must be a whole number of at least 1",
      });
    }
    assert.equal((await readConfig()).maxTasks, 12);
    await writeLimit("maxTasks", null);
    assert.deepEqual(JSON.parse(await readFile(configPath(), "utf8")), seed);
  });

  it("writes maxPerPool keeping the config's other keys, rejects a bad value, and removes it on null", async () => {
    await writeSeed({ maxTasks: 12 });
    await writeLimit("maxPerPool", 3);
    assert.deepEqual(JSON.parse(await readFile(configPath(), "utf8")), {
      ...seed,
      maxTasks: 12,
      maxPerPool: 3,
    });
    const before = await readFile(configPath(), "utf8");
    await assert.rejects(writeLimit("maxPerPool", 0), {
      message: "max-per-pool must be a whole number of at least 1",
    });
    assert.equal(await readFile(configPath(), "utf8"), before);
    await writeLimit("maxPerPool", null);
    assert.deepEqual(JSON.parse(await readFile(configPath(), "utf8")), { ...seed, maxTasks: 12 });
  });
});

describe("window", () => {
  it("maps used percent to remaining and clamps to 0..1", () => {
    assert.deepEqual(window(25, 1_700_000_000_000, "short", 5), {
      kind: "short",
      remaining: 0.75,
      resetsAt: 1_700_000_000_000,
      periodHours: 5,
    });
    assert.equal(window(120, null, "period", 168).remaining, 0);
    assert.equal(window(-10, null, "period", 168).remaining, 1);
    assert.equal(window(0, null, "period", 168).resetsAt, null);
  });
});

describe("credit pool ids", () => {
  it("parses <credit key>@<name> at the last @", () => {
    assert.deepEqual(parseCreditPool("claude-credits@main"), {
      key: "claude-credits",
      agent: "claude",
      name: "main",
    });
    assert.equal(parseCreditPool("claude-credits@a@b"), undefined);
  });

  it("rejects a non-credit key, a missing or bad name, and a bare key", () => {
    for (const id of [
      "claude@main",
      "claude-credits",
      "claude-credits@",
      "claude-credits@Main",
      "claude-credits@-x",
      `claude-credits@${"a".repeat(33)}`,
      "@main",
    ]) {
      assert.equal(parseCreditPool(id), undefined, id);
    }
  });

  it("isCreditKey is true only for credit lane keys", () => {
    assert.equal(isCreditKey("claude-credits"), true);
    assert.equal(isCreditKey("claude"), false);
  });

  it("creditLogin is the pool's owner when consented, else its agent's first consented instance", () => {
    const routable = ["claude@default", "claude@work", "agy@default", "agy@work"];
    assert.equal(creditLogin("claude-credits@work", routable), "claude@work");
    assert.equal(creditLogin("claude-credits@side", routable), "claude@default");
    assert.equal(creditLogin("claude-credits@side", ["agy@default", "claude@work"]), "claude@work");
    assert.equal(creditLogin("claude-credits@work", ["agy@default"]), undefined);
    assert.equal(creditLogin("gemini-credits@work", routable), "agy@work");
    assert.equal(creditLogin("gemini-credits@side", routable), "agy@default");
    assert.equal(creditLogin("claude@work", routable), undefined);
    assert.equal(creditLogin("claude-credits", routable), undefined);
  });
});
