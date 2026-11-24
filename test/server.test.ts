import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it, mock } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  type ElicitRequest,
  ElicitRequestSchema,
  type ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";
import { workerEnv } from "../src/acp.ts";
import { window } from "../src/agents/shared.ts";
import { encodeSession } from "../src/delegate.ts";
import {
  createServer,
  formatTaskResults,
  INSTRUCTIONS,
  projectedUnused,
  snapshot,
  usageText,
} from "../src/server.ts";
import { writeOffered } from "../src/state.ts";
import { appendTask } from "../src/tasks.ts";
import type { AgentAdapter, AgentId, AgentReading, LaneKey, LaunchSpec, TaskResult } from "../src/types.ts";
import { PACKAGE_VERSION } from "../src/util.ts";
import type { FakeAgentLog, FakeAgentScript } from "./fake-agent.ts";

// Keep the user's real schmear config and state out of these tests.
const xdg = mkdtempSync(join(tmpdir(), "schmear-server-xdg-"));
process.env.XDG_CONFIG_HOME = xdg;
process.env.XDG_STATE_HOME = xdg;
after(() => rmSync(xdg, { recursive: true, force: true }));
// delegate routes by config: one consented Claude with the fake binary path.
mkdirSync(join(xdg, "schmear"));
writeFileSync(
  join(xdg, "schmear", "config.json"),
  JSON.stringify({ version: 1, agents: { "claude@default": { consent: true, path: "/fake/bin/claude" } } }),
);

const FAKE_AGENT = fileURLToPath(new URL("./fake-agent.ts", import.meta.url));

function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "schmear-server-test-"));
  return fn(dir).finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

function makeFakeAdapter(
  scriptForTask: (callIndex: number) => FakeAgentScript,
  id: AgentId = "claude",
  readUsage: AgentAdapter["readUsage"] = async () => ({
    agent: id,
    fetchedAt: 0,
    pools: [{ id, agent: id, keys: [id as LaneKey], windows: [window(50, null, "period", 168)] }],
    warnings: [],
  }),
): AgentAdapter {
  let callIndex = 0;
  return {
    id,
    home: { env: "CLAUDE_CONFIG_DIR", login: [] },
    isClient: (name) => name === "claude-code",
    async find() {
      return { path: `/fake/bin/${id}`, version: "1.0.0" };
    },
    async launch(): Promise<LaunchSpec> {
      const script = scriptForTask(callIndex++);
      return {
        command: process.execPath,
        args: [FAKE_AGENT, JSON.stringify(script)],
        env: workerEnv(),
      };
    },
    readUsage,
    classifyFailure() {
      return "failed";
    },
  };
}

async function withClientServer<T>(
  adapters: Partial<Record<AgentId, AgentAdapter>>,
  fn: (client: Client, server: Awaited<ReturnType<typeof createServer>>) => Promise<T>,
  onElicit?: (
    params: ElicitRequest["params"],
    signal: AbortSignal,
    requestId: string | number,
  ) => Promise<ElicitResult>,
): Promise<T> {
  const server = await createServer(adapters);
  const client = new Client(
    { name: "claude-code", version: "1.0.0" },
    onElicit ? { capabilities: { elicitation: { form: {} } } } : undefined,
  );
  if (onElicit) {
    client.setRequestHandler(ElicitRequestSchema, (req, extra) =>
      onElicit(req.params, extra.signal, extra.requestId),
    );
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await fn(client, server);
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

async function waitForLog(
  logFile: string,
  done: (log: FakeAgentLog) => boolean,
): Promise<FakeAgentLog | undefined> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const log = JSON.parse(readFileSync(logFile, "utf8")) as FakeAgentLog;
      if (done(log)) return log;
    } catch {
      // not written yet, or caught mid-write
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return undefined;
}

function firstTextContent(result: Awaited<ReturnType<Client["callTool"]>>): string {
  assert.ok("content" in result && Array.isArray(result.content));
  const block = result.content[0];
  assert.ok(block && block.type === "text");
  return block.text;
}

/** Runs `fn` with `config` written to a fresh config dir and a fresh state dir. */
async function withConfig<T>(config: unknown, fn: () => Promise<T>): Promise<T> {
  return withTempDir(async (dir) => {
    const prev = { config: process.env.XDG_CONFIG_HOME, state: process.env.XDG_STATE_HOME };
    process.env.XDG_CONFIG_HOME = dir;
    process.env.XDG_STATE_HOME = dir;
    try {
      mkdirSync(join(dir, "schmear"));
      writeFileSync(join(dir, "schmear", "config.json"), JSON.stringify(config));
      return await fn();
    } finally {
      for (const [name, value] of [
        ["XDG_CONFIG_HOME", prev.config],
        ["XDG_STATE_HOME", prev.state],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
}

/** The properties of the delegate tool's task schema. */
function taskProperties(
  tool: { inputSchema: { properties?: unknown } } | undefined,
): Record<string, { minimum?: number; maximum?: number }> {
  assert.ok(tool);
  const tasks = (
    tool.inputSchema.properties as Record<
      string,
      { items: { properties: Record<string, { minimum?: number; maximum?: number }> } }
    >
  ).tasks;
  return tasks?.items.properties ?? {};
}

const claudeConfig = {
  version: 1,
  agents: { "claude@default": { consent: true, path: "/fake/bin/claude" } },
};

/** The handle a fake-agent run in `cwd` returns (the Claude tier-1 lane, the fake's first session). */
const handle = (cwd: string, costUsd?: number): Promise<string> =>
  encodeSession({
    agent: "claude",
    account: "default",
    key: "claude",
    model: "haiku",
    effort: "medium",
    tier: 1,
    sessionId: "fake-session-1",
    cwd,
    ...(costUsd !== undefined ? { costUsd } : {}),
  });

describe("createServer", () => {
  it("registers the delegate and usage tools with their annotations", async () => {
    const adapter = makeFakeAdapter(() => ({ reply: "ok" }));
    await withClientServer({ claude: adapter }, async (client) => {
      const { tools } = await client.listTools();
      assert.deepEqual(
        tools.map((t) => t.name),
        ["delegate", "usage"],
      );
      const [delegateTool, usageTool] = tools;
      assert.deepEqual(delegateTool?.annotations, {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      });
      assert.deepEqual(usageTool?.annotations, { readOnlyHint: true });
    });
  });

  it("pins the delegate input schema from listTools", async () => {
    await withClientServer({ claude: makeFakeAdapter(() => ({ reply: "ok" })) }, async (client) => {
      const [delegateTool] = (await client.listTools()).tools;
      assert.deepEqual(delegateTool?.inputSchema, {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        required: ["tasks"],
        properties: {
          tasks: {
            type: "array",
            minItems: 1,
            maxItems: 50,
            items: {
              type: "object",
              required: ["prompt", "cwd", "tier"],
              properties: {
                prompt: { type: "string", minLength: 1 },
                cwd: {
                  type: "string",
                  minLength: 1,
                  description: "Absolute path of an existing directory the worker runs in.",
                },
                tier: { type: "integer", minimum: 1, maximum: 4 },
                description: {
                  type: "string",
                  minLength: 1,
                  maxLength: 80,
                  description: "Short single-line label for the task (defaults to the prompt's first line).",
                },
                agents: {
                  type: "array",
                  minItems: 1,
                  description: "Limit this task to these agents; schmear picks the subscription.",
                  items: {
                    type: "string",
                    enum: ["claude", "codex", "grok", "agy"],
                  },
                },
                session: {
                  type: "string",
                  minLength: 1,
                  description: "Session handle from an earlier result to continue that subagent.",
                },
              },
            },
          },
        },
      });
    });
  });

  it("states a configured list's tiers and bounds the tier schema by it", async () => {
    const tiers = [["claude:sonnet@low", "codex:gpt-5.6-terra@medium"], ["claude:opus@high"]];
    await withConfig({ ...claudeConfig, tiers }, async () => {
      await withClientServer({ claude: makeFakeAdapter(() => ({ reply: "ok" })) }, async (client) => {
        const [delegateTool] = (await client.listTools()).tools;
        assert.match(delegateTool?.description ?? "", /from 1 \(weakest\) to 2:/);
        assert.match(delegateTool?.description ?? "", /Models by tier: 1 sonnet, gpt-5\.6-terra; 2 opus\./);
        const { tier } = taskProperties(delegateTool);
        assert.equal(tier.maximum, 2);
        assert.equal(tier.minimum, 1);
      });
    });
  });

  it("bounds the tasks schema by the config's maxTasks", async () => {
    await withConfig({ ...claudeConfig, maxTasks: 2 }, async () => {
      await withClientServer({ claude: makeFakeAdapter(() => ({ reply: "ok" })) }, async (client) => {
        const [delegateTool] = (await client.listTools()).tools;
        const properties = delegateTool?.inputSchema.properties as
          | { tasks: { maxItems: number } }
          | undefined;
        assert.equal(properties?.tasks.maxItems, 2);
      });
    });
  });

  it("sends INSTRUCTIONS with delegate and none in worker mode", async () => {
    const adapters = { claude: makeFakeAdapter(() => ({ reply: "ok" })) };
    await withClientServer(adapters, async (client) => {
      assert.equal(client.getInstructions(), INSTRUCTIONS);
    });
    process.env.SCHMEAR_WORKER = "1";
    try {
      await withClientServer(adapters, async (client) => {
        assert.equal(client.getInstructions(), undefined);
      });
    } finally {
      delete process.env.SCHMEAR_WORKER;
    }
  });

  it("refuses to start on an invalid config, and the usage tool errors when the config goes bad later", async () => {
    const adapters = { claude: makeFakeAdapter(() => ({ reply: "ok" })) };
    await withConfig({ ...claudeConfig, tiers: [["claude@default:haiku"]] }, async () => {
      await assert.rejects(
        createServer(adapters),
        /malformed config .*config\.json: tier 1 entry "claude@default:haiku": expected "key:model@effort"/,
      );
    });
    await withConfig(claudeConfig, async () => {
      await withClientServer(adapters, async (client) => {
        writeFileSync(
          join(process.env.XDG_CONFIG_HOME as string, "schmear", "config.json"),
          JSON.stringify({ ...claudeConfig, reserve: { claude: 2 } }),
        );
        const result = await client.callTool({ name: "usage", arguments: {} });
        assert.equal(result.isError, true);
        assert.match(firstTextContent(result), /malformed config .*: reserve\.claude must be a fraction/);
      });
    });
  });

  it("usage prints next for tiers 1..N and the entries the account does not offer", async () => {
    const tiers = [
      ["claude:haiku@low", "claude:opus@high"],
      ["claude:opus@high", "claude:fable@medium"],
    ];
    await withConfig({ ...claudeConfig, tiers }, async () => {
      await writeOffered("claude@default", ["haiku"]);
      const text = await usageText({ claude: makeFakeAdapter(() => ({ reply: "ok" })) }, null);
      assert.ok(
        text.endsWith(
          [
            "next: tier 1 → claude@default:haiku (low)",
            "next: tier 2 → none",
            "not offered: claude@default:opus@high (tier 1), claude@default:fable@medium (tier 2)",
          ].join("\n"),
        ),
        text,
      );
    });
  });

  it("usage prints pools with pace and status, skipped agents, warnings, and the next lane per tier", async () => {
    await withTempDir(async (dir) => {
      const prev = process.env.XDG_CONFIG_HOME;
      process.env.XDG_CONFIG_HOME = dir;
      const now = Date.UTC(2026, 10, 21, 12, 0, 0);
      mock.timers.enable({ apis: ["Date"], now });
      try {
        mkdirSync(join(dir, "schmear"));
        writeFileSync(
          join(dir, "schmear", "config.json"),
          JSON.stringify({
            version: 1,
            agents: {
              "claude@default": { consent: true, path: "/fake/claude" },
              "codex@default": { consent: true, path: "/fake/codex" },
              "grok@default": { consent: true, path: "/fake/grok" },
              "agy@default": { consent: true, path: "/fake/agy" },
            },
          }),
        );
        const fixed =
          (r: Omit<AgentReading, "fetchedAt" | "warnings"> & { warnings?: string[] }) =>
          async (bin: string): Promise<AgentReading> => {
            assert.equal(bin, `/fake/${r.agent}`);
            return { fetchedAt: 0, warnings: [], ...r };
          };
        const hours = (h: number) => now + h * 3.6e6;
        const script = () => ({ reply: "ok" });
        const adapters = {
          claude: makeFakeAdapter(
            script,
            "claude",
            fixed({
              agent: "claude",
              warnings: ["extra usage is enabled"],
              pools: [
                {
                  id: "claude",
                  agent: "claude",
                  keys: ["claude"],
                  windows: [window(38, hours(3), "short", 5), window(60, null, "period", 168)],
                },
                {
                  id: "claude-opus",
                  agent: "claude",
                  keys: ["claude"],
                  models: ["opus"],
                  windows: [window(97, null, "period", 168)],
                },
                {
                  id: "claude-sonnet",
                  agent: "claude",
                  keys: ["claude"],
                  models: ["sonnet"],
                  windows: [window(0, null, "period", 168)],
                },
              ],
            }),
          ),
          codex: makeFakeAdapter(
            script,
            "codex",
            fixed({
              agent: "codex",
              pools: [
                { id: "codex", agent: "codex", keys: ["codex"], windows: [window(10, null, "period", 168)] },
              ],
            }),
          ),
          grok: makeFakeAdapter(
            script,
            "grok",
            fixed({
              agent: "grok",
              source: "grok.com",
              pools: [
                {
                  id: "grok",
                  agent: "grok",
                  keys: ["grok"],
                  windows: [window(75, hours(360), "period", 720)],
                },
              ],
            }),
          ),
          agy: makeFakeAdapter(
            script,
            "agy",
            fixed({ agent: "agy", pools: [], error: "agy is not logged in" }),
          ),
        };
        const next = [
          "next: tier 1 → codex@default:gpt-6-luna (max)",
          "next: tier 2 → codex@default:gpt-6.1-terra (medium)",
          "next: tier 3 → codex@default:gpt-6.1-terra (max)",
          "next: tier 4 → claude@default:fable (medium)",
        ].join("\n");
        await withClientServer(adapters, async (client) => {
          const result = await client.callTool({ name: "usage", arguments: {} });
          assert.notEqual(result.isError, true);
          assert.equal(
            firstTextContent(result),
            [
              "driver: claude",
              "",
              [
                "## claude@default",
                `pool claude@default: short 5h 62% left, resets ${new Date(hours(3)).toISOString()}; period 7d 40% left, reset unknown | pace 0.35 | ok`,
                "pool claude-opus@default [opus]: period 7d 3% left, reset unknown | pace - | out: period window 3% left, threshold 5%",
                "pool claude-sonnet@default [sonnet]: period 7d 100% left, reset unknown | pace 0.95 | ok",
                "warning: extra usage is enabled",
              ].join("\n"),
              "",
              "## codex@default\npool codex@default: period 7d 90% left, reset unknown | pace 0.88 | ok",
              "",
              [
                "## grok@default",
                "source: grok.com",
                `pool grok@default: period 30d 25% left, resets ${new Date(hours(360)).toISOString()} | pace 0.46 | ok`,
              ].join("\n"),
              "",
              "## agy@default\nskipped: agy is not logged in",
              "",
              next,
            ].join("\n"),
          );
        });
        // The CLI passes no driver: Claude's pool loses the 5% reserve (pace 0.38, not 0.35).
        const cli = await usageText(adapters, null);
        assert.ok(cli.startsWith("driver: unknown\n"));
        assert.match(cli, /pool claude@default: .* \| pace 0\.38 \| ok/);
      } finally {
        mock.timers.reset();
        if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = prev;
      }
    });
  });

  it("projectedUnused extrapolates the spend rate to the reset", () => {
    const at = 1_000_000_000_000;
    const w = (remaining: number, hoursLeft: number | null, periodHours = 100) => ({
      kind: "period" as const,
      remaining,
      resetsAt: hoursLeft === null ? null : at + hoursLeft * 3.6e6,
      periodHours,
    });
    assert.equal(projectedUnused(w(0.5, null), at), null);
    assert.equal(projectedUnused(w(1, 100), at), null); // elapsed 0
    assert.equal(projectedUnused(w(1, 120), at), null); // elapsed < 0
    assert.equal(projectedUnused(w(0.5, -1), at), null); // already reset
    // 50 h elapsed, 50% used: 1% per hour, 50 h left spends the other 50%.
    assert.ok(Math.abs(projectedUnused(w(0.5, 50), at) ?? NaN) < 1e-9);
    // 50 h elapsed, 20% used: 0.4% per hour, 50 h left spends 20% of the 80% left.
    assert.ok(Math.abs((projectedUnused(w(0.8, 50), at) ?? NaN) - 0.6) < 1e-9);
    // 80 h elapsed, 90% used: 1.125% per hour, 20 h left would spend 22.5%, past what is left.
    assert.equal(projectedUnused(w(0.1, 20), at), 0);
  });

  it("snapshot returns readings, next, notOffered and the last day's tasks", async () => {
    const tiers = [
      ["claude:haiku@low", "claude:opus@high"],
      ["claude:opus@high", "claude:fable@medium"],
    ];
    const config = {
      ...claudeConfig,
      agents: { ...claudeConfig.agents, "agy@default": { consent: false, path: "/fake/agy" } },
      tiers,
    };
    await withConfig(config, async () => {
      await writeOffered("claude@default", ["haiku"]);
      const now = Date.now();
      const line = {
        pid: process.pid,
        driver: null,
        tier: 1,
        cwd: "/w",
        lane: "claude@default:haiku",
        effort: "low",
      };
      await appendTask({ ...line, at: now - 30 * 3_600_000, id: "old", description: "old", status: "done" });
      await appendTask({ ...line, at: now - 2_000, id: "t", description: "work", status: "running" });
      await appendTask({
        ...line,
        at: now - 1_000,
        id: "t",
        description: "work",
        status: "done",
        costUsd: 0.5,
      });
      const adapters = {
        claude: makeFakeAdapter(() => ({ reply: "ok" })),
        agy: makeFakeAdapter(() => ({ reply: "ok" }), "agy"),
      };
      const s = await snapshot(adapters, null, 0);
      assert.equal(s.version, 1);
      assert.equal(s.cliVersion, PACKAGE_VERSION);
      assert.ok(s.at >= now);
      assert.equal(s.driver, null);
      assert.deepEqual(s.readings, [
        {
          id: "claude@default",
          fetchedAt: 0,
          warnings: [],
          pools: [
            {
              id: "claude@default",
              windows: [{ ...window(50, null, "period", 168), projectedUnused: null }],
              pace: s.readings[0]?.pools[0]?.pace,
              status: "ok",
            },
          ],
        },
        { id: "agy@default", skipped: "no consent", warnings: [], pools: [] },
      ]);
      assert.equal(typeof s.readings[0]?.pools[0]?.pace, "number");
      assert.deepEqual(s.next, [
        { tier: 1, lane: "claude@default:haiku", effort: "low" },
        { tier: 2, lane: null },
      ]);
      assert.deepEqual(s.notOffered, [
        "claude@default:opus@high (tier 1)",
        "claude@default:fable@medium (tier 2)",
      ]);
      assert.deepEqual(s.tasks, [
        {
          id: "t",
          driver: null,
          description: "work",
          tier: 1,
          cwd: "/w",
          lane: "claude@default:haiku",
          effort: "low",
          costUsd: 0.5,
          startedAt: now - 2_000,
          endedAt: now - 1_000,
          status: "done",
        },
      ]);
    });
  });

  it("snapshot adds a block per account with @account pool ids, read with the account's home", async () => {
    const config = {
      version: 1,
      agents: {
        "claude@work": { consent: true, path: "/fake/bin/claude", home: "/h/work" },
        "claude@default": { consent: true, path: "/fake/bin/claude" },
      },
      tiers: [["claude:haiku@low", "claude:opus@high"]],
    };
    await withConfig(config, async () => {
      await writeOffered("claude@work", ["haiku"]);
      const envs: (Record<string, string> | undefined)[] = [];
      const readUsage: AgentAdapter["readUsage"] = async (_bin, env) => {
        envs.push(env);
        return {
          agent: "claude",
          fetchedAt: 0,
          pools: [
            {
              id: "claude",
              agent: "claude",
              keys: ["claude"],
              windows: [window(env?.CLAUDE_CONFIG_DIR ? 10 : 50, null, "period", 168)],
            },
          ],
          warnings: [],
        };
      };
      const adapters = { claude: makeFakeAdapter(() => ({ reply: "ok" }), "claude", readUsage) };
      const s = await snapshot(adapters, null, 0);
      assert.deepEqual(
        s.readings.map((r) => [r.id, r.pools.map((p) => p.id)]),
        [
          ["claude@default", ["claude@default"]],
          ["claude@work", ["claude@work"]],
        ],
      );
      assert.deepEqual(
        envs.sort((a, b) => Object.keys(a ?? {}).length - Object.keys(b ?? {}).length),
        [{}, { CLAUDE_CONFIG_DIR: "/h/work" }],
      );
      assert.deepEqual(s.next, [{ tier: 1, lane: "claude@work:haiku", effort: "low" }]);
      assert.deepEqual(s.notOffered, ["claude@work:opus@high (tier 1)"]);
    });
  });

  it("a malformed task log breaks snapshot but not the usage text", async () => {
    await withConfig(claudeConfig, async () => {
      writeFileSync(join(process.env.XDG_STATE_HOME as string, "schmear", "tasks.jsonl"), "not json\n");
      const adapters = { claude: makeFakeAdapter(() => ({ reply: "ok" })) };
      assert.match(await usageText(adapters, null), /^driver: unknown\n/);
      await assert.rejects(snapshot(adapters, null, 0), /task log tasks\.jsonl line 1/);
    });
  });

  it("skips agents without consent or a config entry without reading them", async () => {
    await withTempDir(async (dir) => {
      const prev = process.env.XDG_CONFIG_HOME;
      process.env.XDG_CONFIG_HOME = dir;
      try {
        mkdirSync(join(dir, "schmear"));
        writeFileSync(
          join(dir, "schmear", "config.json"),
          JSON.stringify({ version: 1, agents: { "agy@default": { consent: false, path: "/fake/agy" } } }),
        );
        const unread = async () => assert.fail("readUsage called without consent");
        const adapters = {
          claude: makeFakeAdapter(() => ({ reply: "ok" }), "claude", unread),
          agy: makeFakeAdapter(() => ({ reply: "ok" }), "agy", unread),
        };
        assert.equal(
          await usageText(adapters, null),
          [
            "driver: unknown",
            "",
            "## claude@default\nskipped: not configured",
            "",
            "## agy@default\nskipped: no consent",
            "",
            [1, 2, 3, 4].map((t) => `next: tier ${t} → none`).join("\n"),
          ].join("\n"),
        );
      } finally {
        if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = prev;
      }
    });
  });

  it("lists only usage in worker mode", async () => {
    process.env.SCHMEAR_WORKER = "1";
    try {
      await withClientServer({ claude: makeFakeAdapter(() => ({ reply: "ok" })) }, async (client) => {
        const { tools } = await client.listTools();
        assert.deepEqual(
          tools.map((t) => t.name),
          ["usage"],
        );
      });
    } finally {
      delete process.env.SCHMEAR_WORKER;
    }
  });

  it("delegates a task through fake-agent and returns the §12 plain-text result", async () => {
    // A run offering a model writes the offered list, so it gets its own state dir.
    await withConfig(claudeConfig, () =>
      withTempDir(async (dir) => {
        const adapter = makeFakeAdapter(() => ({
          reply: "PINEAPPLE",
          configOptions: [
            {
              id: "m",
              name: "m",
              category: "model",
              type: "select",
              currentValue: "opus",
              options: [{ value: "opus", name: "opus" }],
            },
            {
              id: "e",
              name: "e",
              category: "thought_level",
              type: "select",
              currentValue: "high",
              options: [{ value: "high", name: "high" }],
            },
          ],
          usageUpdates: [{ used: 1, size: 2, cost: { amount: 0.0123, currency: "USD" } }],
        }));
        await withClientServer({ claude: adapter }, async (client) => {
          const result = await client.callTool({
            name: "delegate",
            arguments: {
              tasks: [
                {
                  prompt: "Return first line of README.md",
                  cwd: dir,
                  tier: 1,
                  agents: ["claude"],
                  description: "Read README",
                },
              ],
            },
          });

          assert.notEqual(result.isError, true);
          assert.equal(
            firstTextContent(result),
            `## Read README\nstatus: done\nprovider: claude\naccount: default\nmodel: opus\neffort: high\nsession: ${await handle(dir, 0.0123)}\ncost: $0.0123\n\nPINEAPPLE`,
          );
        });
      }),
    );
  });

  describe("formatTaskResults", () => {
    const failed = (i: number, reply: string): TaskResult => ({
      description: `task ${i}`,
      status: "failed",
      provider: "claude",
      account: "default",
      model: "opus",
      effort: "high",
      session: `S${i}-${"s".repeat(300)}`,
      costUsd: 0.5,
      reply,
      notes: ["n".repeat(300)],
      error: "e".repeat(2048),
    });

    it("keeps 50 failed tasks within 60,000 chars and every status and session intact", () => {
      const results = Array.from({ length: 50 }, (_, i) => failed(i, "r".repeat(5000)));
      const text = formatTaskResults(results);
      assert.ok(text.length <= 60_000);
      for (const r of results) {
        assert.ok(text.includes(`\nsession: ${r.session}\n`));
        assert.ok(text.includes(`## ${r.description}\nstatus: failed\n`));
      }
      assert.equal(text.split("\nstatus: failed\n").length - 1, 50);
    });

    it("leaves short strings unchanged and gives a long reply the freed budget", () => {
      const long = `HEAD${"x".repeat(100_000)}TAIL`;
      const results = Array.from({ length: 5 }, (_, i) => ({
        ...failed(i, i === 2 ? long : `short ${i}`),
        notes: [],
        error: undefined,
      }));
      const text = formatTaskResults(results);
      assert.ok(text.length <= 60_000);
      for (const i of [0, 1, 3, 4]) assert.ok(text.includes(`\n\nshort ${i}`));
      const kept = text.match(/HEADx+\[… \d+ chars omitted …\]x+TAIL/)?.[0] ?? "";
      assert.ok(kept.length > 60_000 / 5);
    });

    it("returns the text unchanged under budget", () => {
      const r: TaskResult = {
        description: "Read README",
        status: "done",
        provider: "claude",
        account: "default",
        costUsd: 0.0123,
        reply: "PINEAPPLE",
        notes: ["a", "b"],
      };
      assert.equal(
        formatTaskResults([r]),
        "## Read README\nstatus: done\nprovider: claude\naccount: default\ncost: $0.0123\nnotes: a; b\n\nPINEAPPLE",
      );
    });

    it("cuts every string to its marker when the fixed parts use the whole budget", () => {
      const text = formatTaskResults([failed(0, "r".repeat(5000))], 10);
      assert.equal(text.match(/\[… \d+ chars omitted …\]/g)?.length, 3);
      assert.ok(text.includes(`session: ${failed(0, "").session}`));
    });
  });

  it("returns tool errors for invalid input, naming the task index for validation failures", async () => {
    await withTempDir(async (dir) => {
      const adapter = makeFakeAdapter(() => ({ reply: "ok" }));
      await withClientServer({ claude: adapter }, async (client) => {
        const call = (tasks: unknown[]) => client.callTool({ name: "delegate", arguments: { tasks } });
        const ok = { prompt: "p", cwd: dir, tier: 1, agents: ["claude"] };

        assert.equal((await call([])).isError, true);
        assert.equal((await call(Array.from({ length: 51 }, () => ok))).isError, true);
        assert.equal((await call([{ ...ok, tier: 5 }])).isError, true);
        assert.equal((await call([{ ...ok, description: "x".repeat(81) }])).isError, true);
        assert.equal((await call([{ ...ok, agents: [] }])).isError, true);

        for (const bad of [
          { ...ok, agents: ["claude", "codex"] },
          { ...ok, cwd: "relative" },
          { ...ok, cwd: join(dir, "missing") },
        ]) {
          const result = await call([ok, bad]);
          assert.equal(result.isError, true);
          assert.match(firstTextContent(result), /tasks\[1\]/);
        }
      });
    });
  });

  it("cancels the running worker when the MCP call is cancelled via extra.signal", async () => {
    await withTempDir(async (dir) => {
      const logFile = join(dir, "cancel-log.json");
      const adapter = makeFakeAdapter(() => ({
        sleepMs: 10_000,
        reply: "never",
        logFile,
      }));

      await withClientServer({ claude: adapter }, async (client) => {
        const controller = new AbortController();
        const call = client.callTool(
          {
            name: "delegate",
            arguments: {
              tasks: [{ prompt: "sleep", cwd: dir, tier: 1, agents: ["claude"] }],
            },
          },
          undefined,
          { signal: controller.signal },
        );
        assert.ok(await waitForLog(logFile, (l) => l.promptCalled));
        controller.abort();
        await assert.rejects(call);
        assert.ok(await waitForLog(logFile, (l) => l.cancelled));
      });
    });
  });

  it("cancels running tasks when the server connection closes", async () => {
    await withTempDir(async (dir) => {
      const logFile = join(dir, "close-log.json");
      const adapter = makeFakeAdapter(() => ({
        sleepMs: 10_000,
        reply: "never",
        logFile,
      }));

      const server = await createServer({ claude: adapter });
      const client = new Client({ name: "claude-code", version: "1.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

      const pendingCall = client.callTool({
        name: "delegate",
        arguments: {
          tasks: [{ prompt: "sleep", cwd: dir, tier: 1, agents: ["claude"] }],
        },
      });
      pendingCall.catch(() => {});

      assert.ok(await waitForLog(logFile, (l) => l.promptCalled));
      await server.close();
      await client.close();
      assert.ok(await waitForLog(logFile, (l) => l.cancelled));
    });
  });

  describe("permission prompts", () => {
    const options = [
      { optionId: "allow_once", name: "Allow once", kind: "allow_once" as const },
      { optionId: "reject_once", name: "Reject", kind: "reject_once" as const },
    ];
    const asking = (logFile: string, extra: FakeAgentScript = {}): FakeAgentScript => ({
      reply: "ok",
      logFile,
      permissionRequests: [{ toolCall: { toolCallId: "t1", title: "Edit a.ts", kind: "edit" }, options }],
      ...extra,
    });
    const task = (dir: string) => ({
      name: "delegate",
      arguments: {
        tasks: [{ prompt: "p", cwd: dir, tier: 1, agents: ["claude"], description: "Edit file" }],
      },
    });
    const chosen = (log: FakeAgentLog | undefined) => {
      const outcome = log?.permissionOutcomes[0]?.outcome;
      return outcome?.outcome === "selected" ? outcome.optionId : outcome?.outcome;
    };

    it("asks the client by form elicitation and passes an accepted optionId to the worker", async () => {
      await withTempDir(async (dir) => {
        const logFile = join(dir, "log.json");
        const asked: ElicitRequest["params"][] = [];
        await withClientServer(
          { claude: makeFakeAdapter(() => asking(logFile)) },
          async (client) => {
            const result = await client.callTool(task(dir));
            assert.match(firstTextContent(result), /^## Edit file\nstatus: done\n/);
          },
          async (params) => {
            asked.push(params);
            return { action: "accept", content: { option: "allow_once" } };
          },
        );
        assert.equal(asked.length, 1);
        assert.equal(asked[0]?.message, "claude worker on 'Edit file' asks: Edit a.ts (edit)");
        assert.ok(asked[0] && "requestedSchema" in asked[0]);
        assert.deepEqual(asked[0].requestedSchema, {
          type: "object",
          required: ["option"],
          properties: {
            option: {
              type: "string",
              title: "Permission",
              enum: ["allow_once", "reject_once"],
              enumNames: ["Allow once", "Reject"],
            },
          },
        });
        assert.equal(chosen(await waitForLog(logFile, (l) => l.permissionOutcomes.length > 0)), "allow_once");
      });
    });

    it("rejects on decline and the task still ends done", async () => {
      await withTempDir(async (dir) => {
        const logFile = join(dir, "log.json");
        await withClientServer(
          { claude: makeFakeAdapter(() => asking(logFile)) },
          async (client) => {
            const text = firstTextContent(await client.callTool(task(dir)));
            assert.equal(
              text,
              `## Edit file\nstatus: done\nprovider: claude\naccount: default\nsession: ${await handle(dir)}\n\nok`,
            );
          },
          async () => ({ action: "decline" }),
        );
        assert.equal(
          chosen(await waitForLog(logFile, (l) => l.permissionOutcomes.length > 0)),
          "reject_once",
        );
      });
    });

    it("rejects without eliciting when the client lacks form elicitation", async () => {
      await withTempDir(async (dir) => {
        const logFile = join(dir, "log.json");
        await withClientServer({ claude: makeFakeAdapter(() => asking(logFile)) }, async (client, server) => {
          const elicit = mock.method(server.server, "elicitInput");
          const text = firstTextContent(await client.callTool(task(dir)));
          assert.equal(
            text,
            `## Edit file\nstatus: done\nprovider: claude\naccount: default\nsession: ${await handle(dir)}\n\nok`,
          );
          assert.equal(elicit.mock.callCount(), 0);
        });
        assert.equal(
          chosen(await waitForLog(logFile, (l) => l.permissionOutcomes.length > 0)),
          "reject_once",
        );
      });
    });

    it("withdraws an open prompt when the tool call is cancelled", async () => {
      await withTempDir(async (dir) => {
        const logFile = join(dir, "log.json");
        const controller = new AbortController();
        const asked: Array<string | number> = [];
        await withClientServer(
          { claude: makeFakeAdapter(() => asking(logFile)) },
          async (client) => {
            // Read the withdrawal off the wire: the SDK client ignores a cancel for request id 0
            // (`if (!requestId) return`), and this prompt is the server's first request.
            const transport = client.transport as NonNullable<Client["transport"]>;
            const receive = transport.onmessage;
            let withdrawn!: (id: unknown) => void;
            const cancelled = new Promise((resolve) => {
              withdrawn = resolve;
            });
            transport.onmessage = (message, extra) => {
              if ("method" in message && message.method === "notifications/cancelled") {
                withdrawn(message.params?.requestId);
              }
              receive?.(message, extra);
            };
            const call = client.callTool(task(dir), undefined, { signal: controller.signal });
            await assert.rejects(call);
            assert.deepEqual([await cancelled], asked);
            assert.ok(await waitForLog(logFile, (l) => l.cancelled));
          },
          (_params, _signal, requestId) => {
            asked.push(requestId);
            controller.abort();
            return new Promise<ElicitResult>(() => {});
          },
        );
      });
    });
  });
});
