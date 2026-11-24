import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { delegate, loadRouting, MAX_DESCRIPTION_CHARS, truncateReply } from "./delegate.ts";
import { type HostStatus, hostStatus, hostWarnings } from "./hosts.ts";
import type { PoolRow } from "./router.ts";
import { DEFAULT_MAX_TASKS, readConfig, USAGE_SHOW_MS } from "./state.ts";
import { readTasks, type TaskRow } from "./tasks.ts";
import { agentOf, DEFAULT_TIERS, parseTiers } from "./tiers.ts";
import {
  AGENT_IDS,
  type AgentAdapter,
  type AgentId,
  type Ask,
  DEFAULT_ACCOUNT,
  instanceId,
  keyId,
  parseInstance,
  type TaskResult,
  type TierList,
  type UsageReading,
  type Window,
} from "./types.ts";
import { errorMessage, PACKAGE_VERSION } from "./util.ts";

export const INSTRUCTIONS =
  "schmear hands subtasks to AI coding agents on the user's other subscriptions, spending the quota most at risk of expiring unused before its reset; your own subscription keeps a reserve. Use delegate for any self-contained subtask you would give a subagent: research, a review, tests, a scoped change. Write each prompt so the worker needs nothing else from you. Put independent subtasks in one delegate call; they run in parallel. Give each task the lowest tier that can do it well. The usage tool shows each subscription's quota and the lane each tier would take.";

function delegateDescription(tiers: TierList): string {
  const models = tiers
    .map((tier, i) => `${i + 1} ${[...new Set(tier.map((e) => e.model))].join(", ")}`)
    .join("; ");
  return `Hand self-contained coding subtasks to other AI coding agents running on the user's subscriptions; schmear picks the agent whose quota is most at risk of expiring unused. Tasks in one call run in parallel. Each task runs in the cwd you give it, and tasks given the same cwd share that directory: isolate tasks that could conflict yourself, for example in separate git worktrees. The prompt is sent verbatim; the worker sees nothing else from you. tier is the minimum model strength, from 1 (weakest) to ${tiers.length}: a task runs on a model of its tier or a stronger one, so give harder work, or work that needs more thinking, a higher tier. Models by tier: ${models}. Pass a result's session to continue that subagent: for follow-up work on the same task, continue it instead of starting a new task, which starts with none of that context. agents limits a task to these agents (claude, codex, grok, agy); schmear still picks the subscription. Status no_quota means no subscription has quota left for the task: do it yourself.`;
}

const delegateInputSchema = (maxTier: number, maxTasks: number) => ({
  tasks: z
    .array(
      z.object({
        prompt: z.string().min(1),
        cwd: z.string().min(1).describe("Absolute path of an existing directory the worker runs in."),
        tier: z.number().int().min(1).max(maxTier),
        description: z
          .string()
          .min(1)
          .max(MAX_DESCRIPTION_CHARS)
          .optional()
          .describe("Short single-line label for the task (defaults to the prompt's first line)."),
        agents: z
          .array(z.enum(AGENT_IDS))
          .min(1)
          .optional()
          .describe("Limit this task to these agents; schmear picks the subscription."),
        session: z
          .string()
          .min(1)
          .optional()
          .describe("Session handle from an earlier result to continue that subagent."),
      }),
    )
    .min(1)
    .max(maxTasks),
});

const MAX_RESULT_CHARS = 60_000;

/** Renders each task, passing every notes, error and reply string through `cut`, in order. */
function renderTasks(results: TaskResult[], cut: (s: string) => string): string {
  return results
    .map((r) => {
      const fields: [string, string | undefined][] = [
        ["status", r.status],
        ["provider", r.provider],
        ["account", r.account],
        ["model", r.model],
        ["effort", r.effort],
        ["session", r.session],
        ["cost", r.costUsd === undefined ? undefined : `$${r.costUsd.toFixed(4)}`],
        ["notes", r.notes.length > 0 ? cut(r.notes.join("; ")) : undefined],
        ["error", r.error === undefined ? undefined : cut(r.error)],
      ];
      const lines = [
        `## ${r.description}`,
        ...fields.flatMap(([k, v]) => (v === undefined ? [] : [`${k}: ${v}`])),
      ];
      if (r.reply.length > 0) lines.push("", cut(r.reply));
      return lines.join("\n");
    })
    .join("\n\n");
}

/** Splits `total` across strings of the given lengths: short ones keep their length and the rest share what is left equally. */
function waterFill(lengths: number[], total: number): number[] {
  const limits: number[] = [];
  let left = Math.max(0, total);
  const order = lengths.map((_, i) => i).sort((a, b) => (lengths[a] ?? 0) - (lengths[b] ?? 0));
  order.forEach((i, k) => {
    const limit = Math.min(lengths[i] ?? 0, Math.floor(left / (order.length - k)));
    limits[i] = limit;
    left -= limit;
  });
  return limits;
}

/** The result text, within `budget` chars when the parts that are never cut fit in it. */
export function formatTaskResults(results: TaskResult[], budget = MAX_RESULT_CHARS): string {
  const lengths: number[] = [];
  const full = renderTasks(results, (s) => {
    lengths.push(s.length);
    return s;
  });
  if (full.length <= budget) return full;
  const cuttable = lengths.reduce((sum, n) => sum + n, 0);
  const limits = waterFill(lengths, budget - (full.length - cuttable));
  let next = 0;
  return renderTasks(results, (s) => truncateReply(s, limits[next++] ?? 0));
}

/** A window's length and what is left, e.g. "7d 37% left". */
export function windowLeft(w: Window): string {
  const hours = Number(w.periodHours.toFixed(1));
  const span = hours >= 24 && hours % 24 === 0 ? `${hours / 24}d` : `${hours}h`;
  return `${span} ${Math.round(w.remaining * 100)}% left`;
}

type SnapshotReading = Snapshot["readings"][number];

/** The fraction of a window expected to expire unused at its current spend rate, or null when it has no reset or has not started. */
export function projectedUnused(w: Window, at: number): number | null {
  if (w.resetsAt === null) return null;
  const hoursLeft = (w.resetsAt - at) / 3.6e6;
  const elapsed = w.periodHours - hoursLeft;
  if (elapsed <= 0 || hoursLeft < 0) return null;
  return Math.max(0, w.remaining - ((1 - w.remaining) / elapsed) * hoursLeft);
}

/** The `usage` tool's data (§12): the driver, per consented agent and account its pools with pace and status or why it is skipped, each routed credit pool, the lane each tier's next task would take, the list entries the account does not offer, and the last day's delegations. */
export interface Snapshot {
  version: 1;
  at: number;
  driver: AgentId | null;
  hosts: HostStatus[];
  readings: Array<{
    id: string;
    skipped?: string;
    source?: string;
    fetchedAt?: number;
    warnings: string[];
    pools: Array<{
      id: string;
      models?: string[];
      windows: Array<Window & { projectedUnused: number | null }>;
      pace?: number | null;
      status?: PoolRow["status"];
    }>;
  }>;
  next: Array<{ tier: number; lane: string | null; effort?: string }>;
  notOffered: string[];
  tasks: TaskRow[];
}

function snapshotReading(
  id: string,
  reading: UsageReading,
  rows: Map<string, PoolRow>,
  at: number,
): SnapshotReading {
  return {
    id,
    ...(reading.error !== undefined ? { skipped: reading.error } : {}),
    ...(reading.source !== undefined ? { source: reading.source } : {}),
    fetchedAt: reading.fetchedAt,
    warnings: reading.warnings,
    pools: reading.pools.map((pool) => {
      const row = rows.get(pool.id);
      return {
        id: pool.id,
        ...(pool.models ? { models: pool.models } : {}),
        windows: pool.windows.map((w) => ({ ...w, projectedUnused: projectedUnused(w, at) })),
        ...(row ? { pace: row.pace, status: row.status } : {}),
      };
    }),
  };
}

async function usageState(
  adapters: Partial<Record<AgentId, AgentAdapter>>,
  driver: AgentId | null,
  maxAgeMs: number,
): Promise<Omit<Snapshot, "hosts" | "tasks">> {
  const { config, tiers, offered, routable, readings, credits, read, lanes, routeTasks } =
    await loadRouting(adapters);
  await Promise.all(routable.map((id) => read(id, maxAgeMs)));
  const at = Date.now();
  const none = new Set<string>();
  const rows = new Map(routeTasks(driver, none, []).pools.map((row) => [row.id, row]));
  const block = (id: string): SnapshotReading => {
    const entry = config.agents[id];
    if (!entry) return { id, skipped: "not configured", warnings: [], pools: [] };
    if (!entry.consent) return { id, skipped: "no consent", warnings: [], pools: [] };
    return snapshotReading(id, readings.get(id) as UsageReading, rows, at); // read for every consented instance
  };
  const accounts = Object.keys(config.agents).flatMap((id) => {
    const instance = parseInstance(id);
    return instance && instance.account !== DEFAULT_ACCOUNT ? [instance] : [];
  });
  const blocks = Object.values(adapters).flatMap((adapter) => [
    block(instanceId(adapter.id, DEFAULT_ACCOUNT)),
    ...accounts.filter((a) => a.agent === adapter.id).map((a) => block(instanceId(a.agent, a.account))),
  ]);
  for (const [id, reading] of credits) {
    blocks.push(snapshotReading(id, reading, rows, at));
  }
  // One route() call per tier holding one task, so the batch split never changes a line.
  const next = tiers.map((_, i) => {
    const lane = routeTasks(driver, none, [lanes(i + 1)]).assignments[0];
    return { tier: i + 1, lane: lane?.id ?? null, ...(lane ? { effort: lane.effort } : {}) };
  });
  const missing = new Set<string>();
  const notOffered = tiers.flatMap((tier, i) =>
    tier.flatMap(({ key, model, effort }) =>
      [DEFAULT_ACCOUNT, ...accounts.filter((a) => a.agent === agentOf(key)).map((a) => a.account)].flatMap(
        (account) => {
          const kid = keyId(key, account);
          const id = `${kid}:${model}`;
          if (offered[kid]?.includes(model) !== false || missing.has(id)) return [];
          missing.add(id);
          return [`${id}@${effort} (tier ${i + 1})`];
        },
      ),
    ),
  );
  return { version: 1, at, driver, readings: blocks, next, notOffered };
}

export async function snapshot(
  adapters: Partial<Record<AgentId, AgentAdapter>>,
  driver: AgentId | null,
  maxAgeMs: number,
): Promise<Snapshot> {
  const [{ version, at, driver: d, ...rest }, hosts] = await Promise.all([
    usageState(adapters, driver, maxAgeMs),
    hostStatus(),
  ]);
  // `hosts` follows `driver` in the JSON.
  return { version, at, driver: d, hosts, ...rest, tasks: await readTasks(at - 24 * 3_600_000) };
}

function formatWindow(w: Window): string {
  const reset = w.resetsAt === null ? "reset unknown" : `resets ${new Date(w.resetsAt).toISOString()}`;
  return `${w.kind} ${windowLeft(w)}, ${reset}`;
}

function formatReading(reading: SnapshotReading): string[] {
  const lines: string[] = [];
  if (reading.source !== undefined) {
    lines.push(`source: ${reading.source}`);
  }
  if (reading.skipped !== undefined) {
    lines.push(`skipped: ${reading.skipped}`);
  }
  for (const pool of reading.pools) {
    const models = pool.models ? ` [${pool.models.join(", ")}]` : "";
    const verdict =
      pool.status === undefined
        ? ""
        : ` | pace ${pool.pace === null || pool.pace === undefined ? "-" : pool.pace.toFixed(2)} | ${pool.status}`;
    lines.push(`pool ${pool.id}${models}: ${pool.windows.map(formatWindow).join("; ")}${verdict}`);
  }
  for (const warning of reading.warnings) {
    lines.push(`warning: ${warning}`);
  }
  return lines;
}

/** The `usage` tool's text: a snapshot without its hosts or tasks, which it never reads. */
function formatSnapshot(s: Omit<Snapshot, "hosts" | "tasks">): string {
  const blocks = s.readings.map((r) => [`## ${r.id}`, ...formatReading(r)].join("\n"));
  const next = s.next.map((n) => `next: tier ${n.tier} → ${n.lane ? `${n.lane} (${n.effort})` : "none"}`);
  if (s.notOffered.length > 0) {
    next.push(`not offered: ${s.notOffered.join(", ")}`);
  }
  return [`driver: ${s.driver ?? "unknown"}`, ...blocks, next.join("\n")].join("\n\n");
}

export async function usageText(
  adapters: Partial<Record<AgentId, AgentAdapter>>,
  driver: AgentId | null,
): Promise<string> {
  return formatSnapshot(await usageState(adapters, driver, USAGE_SHOW_MS));
}

export async function cliUsageText(
  adapters: Partial<Record<AgentId, AgentAdapter>>,
  driver: AgentId | null,
): Promise<string> {
  const [text, warnings] = await Promise.all([usageText(adapters, driver), hostWarnings()]);
  return warnings.length > 0 ? `${text}\n\n${warnings.join("\n")}` : text;
}

function detectDriver(server: McpServer, adapters: Partial<Record<AgentId, AgentAdapter>>): AgentId | null {
  const clientName = server.server.getClientVersion()?.name;
  if (!clientName) {
    return null;
  }
  for (const adapter of Object.values(adapters)) {
    if (adapter?.isClient(clientName)) {
      return adapter.id;
    }
  }
  return null;
}

// Matches init's host timeouts; the SDK default of 60 s would reject a prompt the user is still reading.
const ASK_TIMEOUT_MS = 86_400_000;

/** §12 permission prompts: a form elicitation per request, or none when the client lacks form elicitation. */
function formAsk(server: McpServer): Ask | undefined {
  if (!server.server.getClientCapabilities()?.elicitation?.form) {
    return undefined;
  }
  return async (message, options, signal) => {
    const result = await server.server.elicitInput(
      {
        mode: "form",
        message,
        requestedSchema: {
          type: "object",
          required: ["option"],
          properties: {
            option: {
              type: "string",
              title: "Permission",
              enum: options.map((o) => o.optionId),
              enumNames: options.map((o) => o.name),
            },
          },
        },
      },
      { signal, timeout: ASK_TIMEOUT_MS },
    );
    const option = result.content?.option;
    return result.action === "accept" && typeof option === "string" ? option : undefined;
  };
}

export async function createServer(adapters: Partial<Record<AgentId, AgentAdapter>>): Promise<McpServer> {
  const config = await readConfig();
  const tiers = parseTiers(config.tiers ?? DEFAULT_TIERS);
  const delegating = process.env.SCHMEAR_WORKER !== "1";
  const info = { name: "schmear", version: PACKAGE_VERSION };
  const shutdownController = new AbortController();
  const activeCalls = new Set<Promise<unknown>>();
  // Closing aborts every running delegate call and waits for its workers to exit.
  const server = new (class extends McpServer {
    override async close(): Promise<void> {
      shutdownController.abort();
      await Promise.allSettled(activeCalls);
      await super.close();
    }
  })(info, delegating ? { instructions: INSTRUCTIONS } : undefined);
  server.server.onclose = () => shutdownController.abort();

  // A worker's own schmear must not delegate again: that would loop work across agents.
  if (delegating) {
    server.registerTool(
      "delegate",
      {
        title: "Delegate tasks",
        description: delegateDescription(tiers),
        inputSchema: delegateInputSchema(tiers.length, config.maxTasks ?? DEFAULT_MAX_TASKS),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async (args, extra) => {
        const signal = AbortSignal.any([extra.signal, shutdownController.signal]);
        const driver = detectDriver(server, adapters);
        const run = delegate(args, { driver, signal, ask: formAsk(server) }, adapters);
        activeCalls.add(run);
        try {
          const results = await run;
          return {
            content: [{ type: "text", text: formatTaskResults(results) }],
          };
        } finally {
          activeCalls.delete(run);
        }
      },
    );
  }

  server.registerTool(
    "usage",
    {
      title: "Subscription usage",
      description:
        "Show each consented agent's subscription pools with every window's remaining quota and reset time, each pool's pace and status, and the lane the next task of each tier would take, or why an agent is skipped.",
      annotations: { readOnlyHint: true },
    },
    async () => ({
      content: [{ type: "text", text: await usageText(adapters, detectDriver(server, adapters)) }],
    }),
  );

  return server;
}

export async function serveStdio(adapters: Partial<Record<AgentId, AgentAdapter>>): Promise<void> {
  const server = await createServer(adapters);
  const transport = new StdioServerTransport();

  server.server.onerror = (error) => {
    process.stderr.write(`schmear server error: ${error.message}\n`);
  };

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    void (async () => {
      try {
        await server.close();
      } catch (error) {
        process.stderr.write(`schmear shutdown error: ${errorMessage(error)}\n`);
      } finally {
        process.exit(0);
      }
    })();
  };

  process.stdin.once("end", shutdown);
  process.stdin.once("close", shutdown);
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  await server.connect(transport);
}
