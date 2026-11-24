import type { PermissionOption } from "@agentclientprotocol/sdk";
import type { z } from "zod";
import type { ConfigSchema } from "./state.ts";

export const AGENT_IDS = ["claude", "codex", "grok", "agy"] as const;
export type AgentId = (typeof AGENT_IDS)[number];
export const LANE_KEYS = [
  "claude",
  "codex",
  "grok",
  "agy-gemini",
  "agy-argon",
  "agy-3p",
  "claude-credits",
] as const;
export type LaneKey = (typeof LANE_KEYS)[number];
/** Lane keys that spend a credit pool's API key, with the agent each runs on; a pool id is `<key>@<name>`. */
export const CREDIT_AGENTS = { "claude-credits": "claude" } as const;
export type CreditKey = keyof typeof CREDIT_AGENTS;
export const CREDIT_KEYS = Object.keys(CREDIT_AGENTS) as CreditKey[];
export const isCreditKey = (key: string): key is CreditKey => (CREDIT_KEYS as string[]).includes(key);
export const agentOf = (key: LaneKey): AgentId =>
  isCreditKey(key) ? CREDIT_AGENTS[key] : (key.split("-")[0] as AgentId);

export const AGENT_ID_SET: ReadonlySet<string> = new Set(AGENT_IDS);
const ACCOUNT_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** The account name of each CLI's inherited-env login; added subscriptions have a nickname. */
export const DEFAULT_ACCOUNT = "default";
/** `claude@default`, `claude@work`. */
export const instanceId = (agent: AgentId, account: string): string => `${agent}@${account}`;
/** A lane's or pool's key with its account: `claude-fable@work`. */
export const keyId = (key: string, account: string): string => `${key}@${account}`;
/** undefined: unknown agent, no `@`, or bad account name. */
export function parseInstance(id: string): { agent: AgentId; account: string } | undefined {
  const at = id.indexOf("@");
  if (at < 0) return undefined;
  const agent = id.slice(0, at);
  const account = id.slice(at + 1);
  return AGENT_ID_SET.has(agent) && ACCOUNT_RE.test(account)
    ? { agent: agent as AgentId, account }
    : undefined;
}

/** undefined: no `@`, not a credit key, or bad pool name. */
export function parseCreditPool(id: string): { key: CreditKey; agent: AgentId; name: string } | undefined {
  const at = id.lastIndexOf("@");
  if (at < 0) return undefined;
  const key = id.slice(0, at);
  const name = id.slice(at + 1);
  return isCreditKey(key) && ACCOUNT_RE.test(name) ? { key, agent: agentOf(key), name } : undefined;
}

export interface Window {
  kind: "short" | "period"; // short: rolling ≤ 24 h; period: weekly, 30-day, cycle
  remaining: number; // fraction left, 0..1
  resetsAt: number | null; // epoch ms
  periodHours: number;
}

export interface Pool {
  id: string; // "claude@default", "claude-opus@work", "agy-gemini@default", ...
  agent: AgentId;
  account: string;
  keys: LaneKey[]; // lanes of these keys draw on it
  models?: string[]; // only lanes running one of these model values; undefined = every model
  windows: Window[];
  usd?: { left: number; granted: number }; // a credit pool's balance
}

export interface UsageReading {
  agent: AgentId;
  account: string;
  fetchedAt: number;
  pools: Pool[];
  error?: string; // set: the agent is skipped (unreadable, or a spend guard)
  warnings: string[];
  source?: string; // the step that produced the reading, when an agent has several
}

/** An adapter's reading: `read` (delegate.ts) sets the account and suffixes pool ids with it. */
export type AgentPool = Omit<Pool, "account">;
export type AgentReading = Omit<UsageReading, "account" | "pools"> & { pools: AgentPool[] };

/** A parsed tier-list entry `key:model@effort`; model and effort are the provider's own option values. */
export interface Entry {
  key: LaneKey;
  model: string;
  effort: string;
}
/** Weakest first: index 0 is tier 1. */
export type TierList = Entry[][];
/** Models each key id offered at its last run; absent = unknown. */
export type Offered = Partial<Record<string, string[]>>;

export type Config = z.infer<typeof ConfigSchema>;

/** One `Config.credits` entry, keyed by pool id (§13). One flat shape; each vendor's reader checks the fields it needs. */
export interface CreditPoolConfig {
  keyCommand: string[];
  overageOff: true;
  taskCapUsd?: number;
  org?: string; // Claude: Console org uuid
  team?: string; // xAI
  managementKeyCommand?: string[]; // xAI
  organization?: string; // OpenAI
}

/** A way to spend a pool. */
export interface Lane {
  id: string; // `${keyId(key, account)}:${model}`
  agent: AgentId;
  account: string;
  key: LaneKey;
  tier: number; // the tier of the entry that runs (≥ the task's)
  model: string;
  effort: string;
}

/** The instance whose login a lane runs under: a credit lane runs under its agent's default login. */
export const laneInstance = (lane: Lane): string =>
  instanceId(lane.agent, isCreditKey(lane.key) ? DEFAULT_ACCOUNT : lane.account);

/** Asks the driver's user to pick one of a permission request's options (§12). Resolves to the chosen optionId, or undefined on decline or cancel; throws on error. */
export type Ask = (
  message: string,
  options: PermissionOption[],
  signal: AbortSignal,
) => Promise<string | undefined>;

export interface LaunchSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
  requireAuth?: { kind: string; detail?: string };
  config?: { mode?: string; model?: string; effort?: string }; // set in this order (§7 step 5)
  sessionMeta?: Record<string, unknown>; // `_meta` of the session request (§7 step 4)
  authenticate?: { methodId: string }; // sent before the session opens; on failure no session is requested, so the agent cannot fall back to a saved login
  failReply?: RegExp; // an `end_turn` reply matching it is a failed run whose message is the match: the agent reports its executor errors as reply text
}

export interface WorkerFailure {
  code?: number;
  message: string; // the agent's own error text; classifiers match this, never stderr
  stderr?: string; // tail of the worker's stderr, shown in the task's error only
  data?: unknown;
  rateLimit?: unknown;
  auth?: string;
  notOffered?: { model: string; effort?: string }; // effort set: that effort is missing
}

export type WorkerOutcome =
  | { stopReason: "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled"; failure?: never }
  | { failure: WorkerFailure; stopReason?: never };

export type WorkerRun = WorkerOutcome & {
  reply: string;
  costUsd?: number;
  model?: string;
  effort?: string;
  offered?: string[]; // the session's `model` option values, when it has one
  sessionId: string;
  prompted: boolean; // session/prompt was sent
};

export interface AgentAdapter {
  id: AgentId;
  isClient(clientName: string): boolean;
  // error: why detection failed, printed by init; plan, email: the subscription tier and login email, when the CLI reports them
  // home: the env var that points the CLI at a separate login (an account), and the args that sign in to it
  home: { env: string; login: string[] };
  // env: overlay merged into every workerEnv this call makes, selecting an account's login
  find(
    bin: string,
    env?: Record<string, string>,
  ): Promise<{ version: string; plan?: string; email?: string } | { error: string }>;
  readUsage(bin: string, env?: Record<string, string>): Promise<AgentReading>; // always reads (delegate.ts caches); never throws
  launch(lane: Lane, cwd: string, bin: string, env?: Record<string, string>): Promise<LaunchSpec>;
  classifyFailure(f: WorkerFailure): "quota" | "failed";
  quotaRateLimit?(rateLimit: unknown): boolean; // a live rate-limit notice that ends the run as quota (§10 step 6)
}

export interface DelegateInput {
  tasks: DelegateTask[];
}

export interface DelegateTask {
  prompt: string;
  cwd: string;
  tier: number; // 1..N
  description?: string;
  agents?: AgentId[]; // schmear picks the subscription within these agents
  session?: string; // TaskResult.session from an earlier call
}

/** What `TaskResult.session` carries, base64url JSON (§6): the lane and ACP session a task continues. */
export interface SessionHandle {
  agent: AgentId;
  account: string;
  key: LaneKey;
  model: string;
  effort: string;
  tier: number; // the tier number the lane ran at, under that call's list
  sessionId: string;
  cwd: string;
  costUsd?: number; // the run's cumulative reported cost: a resumed Claude session reports its earlier turns too (sdk.d.ts:6275)
}

export interface TaskResult {
  description: string;
  status: "done" | "failed" | "cancelled" | "no_quota";
  provider?: AgentId;
  account?: string; // set with provider
  model?: string;
  effort?: string;
  session?: string;
  costUsd?: number; // a resumed run's own spend, net of its handle's costUsd
  reply: string;
  notes: string[];
  error?: string;
}
