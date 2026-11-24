import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { budgetStopped, creditExhausted, creditSpec } from "./agents/claude.ts";
import { readConsole, readSessions, type VendorBalance } from "./console.ts";
import { stateDir, usage } from "./state.ts";
import {
  type AgentId,
  type CreditKey,
  type CreditPoolConfig,
  DEFAULT_ACCOUNT,
  instanceId,
  type LaunchSpec,
  parseCreditPool,
  type UsageReading,
  type WorkerRun,
} from "./types.ts";
import { errorMessage, execFileAsync, isRecord } from "./util.ts";

const LedgerLineSchema = z.discriminatedUnion("kind", [
  z.object({ at: z.number(), kind: z.literal("balance"), usd: z.number(), floorUsd: z.number().min(0) }),
  z.object({
    at: z.number(),
    taskId: z.string().min(1),
    kind: z.enum(["reserve", "settle", "exhausted"]),
    usd: z.number().min(0),
  }),
]);
export type LedgerLine = z.infer<typeof LedgerLineSchema>;
type TaskKind = Exclude<LedgerLine["kind"], "balance">;

/** Credits are valued as a 30-day allowance, so a grant near expiry outranks subscriptions (§13). */
const PERIOD_HOURS = 720;

const ledgerPath = (poolId: string): string => join(stateDir(), "ledger", `${poolId}.jsonl`);

/** One `O_APPEND` write per line, so every reader sees the same line order. */
export async function appendLedger(poolId: string, line: LedgerLine): Promise<void> {
  await mkdir(dirname(ledgerPath(poolId)), { recursive: true, mode: 0o700 });
  await appendFile(ledgerPath(poolId), `${JSON.stringify(line)}\n`, { mode: 0o600 });
}

/** Line `n` (1-based) parsed, or a throw naming the first invalid field. */
function ledgerLine(text: string, n: number): LedgerLine {
  let l: unknown;
  try {
    l = JSON.parse(text);
  } catch {
    throw new Error(`ledger line ${n}: not JSON`);
  }
  const result = LedgerLineSchema.safeParse(l);
  if (!result.success)
    throw new Error(`ledger line ${n}: ${String(result.error.issues[0].path[0] ?? "not an object")}`);
  return result.data;
}

/** Complete lines only (one still being written is skipped); an invalid complete line throws. */
export async function readLedger(poolId: string): Promise<LedgerLine[]> {
  let text: string;
  try {
    text = await readFile(ledgerPath(poolId), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const end = text.lastIndexOf("\n");
  return end < 0
    ? []
    : text
        .slice(0, end)
        .split("\n")
        .map((l, i) => ledgerLine(l, i + 1));
}

/**
 * Replays ledger lines in file order (§13). `base`: the last balance line. A reserve is valid only if it fits above
 * the base's floor given the lines before it; an invalid one is void, so every process agrees without a lock.
 * `open`: the valid reservations not yet settled, held across balance lines.
 */
export function replay(lines: LedgerLine[]): {
  base?: { usd: number; floorUsd: number };
  left: number;
  open: Map<string, number>;
} {
  let base: { usd: number; floorUsd: number } | undefined;
  let left = 0;
  let exhausted = false;
  const open = new Map<string, number>();
  for (const l of lines) {
    if (l.kind === "balance") {
      base = l;
      left = l.usd;
      for (const usd of open.values()) left -= usd;
      exhausted = false;
    } else if (l.kind === "reserve") {
      if (base && !exhausted && l.usd > 0 && l.usd <= left - base.floorUsd) {
        left -= l.usd;
        open.set(l.taskId, l.usd);
      }
    } else if (l.kind === "settle") {
      left -= l.usd;
      const reserved = open.get(l.taskId);
      if (reserved !== undefined) {
        left += reserved;
        open.delete(l.taskId);
      }
    } else {
      exhausted = true;
    }
  }
  return {
    ...(base ? { base: { usd: base.usd, floorUsd: base.floorUsd } } : {}),
    left: exhausted ? 0 : left,
    open,
  };
}

/** A pool that cannot route, windowless so the router reports `error` under its id. */
function skipped(id: string, error: string, fetchedAt: number): UsageReading {
  const parsed = parseCreditPool(id);
  // An id that names no credit key (the 0.4 shape's keys) is shown under M1's only credit vendor.
  const agent: AgentId = parsed?.agent ?? "claude";
  const account = parsed?.name ?? id;
  return {
    agent,
    account,
    fetchedAt,
    warnings: [],
    error,
    pools: [{ id, agent, account, keys: [parsed?.key ?? "claude-credits"], windows: [] }],
  };
}

/** The first problem of a hand-edited entry, or undefined when it can spend. */
function entryError(id: string, entry: unknown): string | undefined {
  const parsed = parseCreditPool(id);
  if (!parsed) return "credit pool id invalid";
  const invalid = (field: string) => `credit pool config invalid: ${field}`;
  if (!isRecord(entry) || Array.isArray(entry)) return invalid("not an object");
  const { keyCommand, overageOff, taskCapUsd, org } = entry;
  if (
    !Array.isArray(keyCommand) ||
    keyCommand.length === 0 ||
    !keyCommand.every((a) => typeof a === "string")
  )
    return invalid("keyCommand");
  if (overageOff !== true) return invalid("overageOff");
  if (
    taskCapUsd !== undefined &&
    !(typeof taskCapUsd === "number" && Number.isFinite(taskCapUsd) && taskCapUsd > 0)
  )
    return invalid("taskCapUsd");
  if (parsed.key === "claude-credits" && !(typeof org === "string" && org.length > 0)) return invalid("org");
  return undefined;
}

/**
 * `config.credits` split into the pools that can spend and a skipped reading per bad entry, keeping only pools whose
 * agent's default login is in `routable` (a credit run uses that login's binary).
 */
export function parseCredits(
  credits: Record<string, unknown> | undefined,
  routable: string[],
  now = Date.now(),
): { pools: Map<string, CreditPoolConfig>; invalid: Map<string, UsageReading> } {
  const pools = new Map<string, CreditPoolConfig>();
  const invalid = new Map<string, UsageReading>();
  for (const [id, entry] of Object.entries(credits ?? {})) {
    if (!routable.includes(instanceId(parseCreditPool(id)?.agent ?? "claude", DEFAULT_ACCOUNT))) continue;
    const error = entryError(id, entry);
    if (error === undefined) pools.set(id, entry as CreditPoolConfig);
    else invalid.set(id, skipped(id, error, now));
  }
  return { pools, invalid };
}

/** A provider's balances by pool id, cached as one usage reading; `error` set when any pool failed, so it rereads within 60 s. */
type ProviderReading = UsageReading & { balances: Record<string, VendorBalance> };

/** Every pool of `pools` gets an entry, so a session file that cannot be read fails each pool alike. */
async function readBalances(pools: [string, CreditPoolConfig][]): Promise<Record<string, VendorBalance>> {
  let sessions: Record<string, string>;
  try {
    sessions = await readSessions();
  } catch (err) {
    const error = errorMessage(err);
    return Object.fromEntries(pools.map(([id]) => [id, { error }]));
  }
  return readConsole(sessions, Object.fromEntries(pools.map(([id, p]) => [id, p.org as string])));
}

/** A failed ledger write as its errno code, else its message. */
const writeError = (err: unknown): string => (err as NodeJS.ErrnoException).code ?? errorMessage(err);

/**
 * One pool's reading: the vendor balance, recorded as a `balance` line when it differs from the last one and is
 * newer, minus what the ledger holds and settled since. An unreadable balance or ledger skips the pool.
 */
async function poolReading(id: string, balance: VendorBalance, fetchedAt: number): Promise<UsageReading> {
  if ("error" in balance) return skipped(id, balance.error, fetchedAt);
  const parsed = parseCreditPool(id) as NonNullable<ReturnType<typeof parseCreditPool>>;
  let lines: LedgerLine[];
  try {
    lines = await readLedger(id);
  } catch (err) {
    return skipped(id, `credit ledger unreadable: ${errorMessage(err)}`, fetchedAt);
  }
  const last = lines.findLast((l) => l.kind === "balance");
  // An older read (another process's, cached before this one's) never replaces a newer base.
  if (!last || (last.at < fetchedAt && (last.usd !== balance.usd || last.floorUsd !== balance.floorUsd))) {
    const line: LedgerLine = { at: fetchedAt, kind: "balance", usd: balance.usd, floorUsd: balance.floorUsd };
    try {
      await appendLedger(id, line);
    } catch (err) {
      return skipped(id, `credit ledger write failed: ${writeError(err)}`, fetchedAt);
    }
    lines.push(line);
  }
  const { left } = replay(lines);
  const granted = balance.grantedUsd;
  // No live grant to scale by: all of the balance above the floor counts as the full allowance.
  const remaining = granted > 0 ? Math.min(1, Math.max(0, left) / granted) : left > balance.floorUsd ? 1 : 0;
  return {
    agent: parsed.agent,
    account: parsed.name,
    fetchedAt,
    warnings: balance.warnings,
    pools: [
      {
        id,
        agent: parsed.agent,
        account: parsed.name,
        keys: [parsed.key],
        windows: [
          { kind: "period", remaining, resetsAt: balance.window.resetsAt, periodHours: PERIOD_HOURS },
        ],
        usd: { left, granted },
      },
    ],
  };
}

/** The readings of `agent`'s pools, one vendor read per credit key through the usage cache (id = the key). */
export async function readCreditPools(
  agent: AgentId,
  pools: Map<string, CreditPoolConfig>,
  maxAgeMs: number,
): Promise<Map<string, UsageReading>> {
  const byKey = new Map<CreditKey, [string, CreditPoolConfig][]>();
  for (const [id, pool] of pools) {
    const parsed = parseCreditPool(id);
    if (parsed?.agent === agent) byKey.set(parsed.key, [...(byKey.get(parsed.key) ?? []), [id, pool]]);
  }
  const out = new Map<string, UsageReading>();
  for (const [key, mine] of byKey) {
    const read = async (): Promise<ProviderReading> => {
      const fetchedAt = Date.now();
      const balances = await readBalances(mine);
      const errors = Object.values(balances).flatMap((b) => ("error" in b ? [b.error] : []));
      return {
        agent,
        account: DEFAULT_ACCOUNT,
        fetchedAt,
        warnings: [],
        pools: [],
        balances,
        ...(errors.length > 0 ? { error: errors.join(" ") } : {}),
      };
    };
    let reading = (await usage(key, read, maxAgeMs)) as ProviderReading;
    // A pool added since the cached read has no balance in it.
    if (mine.some(([id]) => !(id in reading.balances)))
      reading = (await usage(key, read, 0)) as ProviderReading;
    for (const [id] of mine) {
      out.set(id, await poolReading(id, reading.balances[id] as VendorBalance, reading.fetchedAt));
    }
  }
  return out;
}

/**
 * B = min(left − floor, cap), cap = `taskCapUsd`, else a tenth of the grant (of the balance when no grant is live).
 * Appended as a reserve when > 0 and returned once the replay holds it open; a reserve voided by a line that landed
 * first is retried. B ≤ 0 (or no balance read yet) is a quota outcome. `clipped`: the pool, not the cap, set B.
 */
export async function reserveCredit(
  poolId: string,
  pool: CreditPoolConfig,
  grantedUsd: number,
  taskId: string,
): Promise<{ budget: number; clipped: boolean }> {
  for (;;) {
    const { base, left } = replay(await readLedger(poolId));
    if (!base) return { budget: 0, clipped: true };
    const cap = pool.taskCapUsd ?? (grantedUsd > 0 ? grantedUsd : base.usd) / 10;
    const budget = Math.min(left - base.floorUsd, cap);
    if (budget <= 0) return { budget, clipped: true };
    await appendLedger(poolId, { at: Date.now(), taskId, kind: "reserve", usd: budget });
    if (replay(await readLedger(poolId)).open.has(taskId)) return { budget, clipped: budget < cap };
  }
}

/** The credit key: `keyCommand`'s stdout, run without a shell. The error names argv[0] and the exit only, never its output. */
async function readKey(command: string[], signal: AbortSignal): Promise<string> {
  const [file, ...args] = command;
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(file as string, args, { signal, encoding: "utf8" }));
  } catch (err) {
    const { code, signal: killed } = err as { code?: unknown; signal?: unknown };
    const why = typeof code === "number" ? `exit ${code}` : String(killed ?? code);
    throw new Error(`${file} ${why}`);
  }
  const key = stdout.trim();
  if (!key) {
    throw new Error(`${file} printed no key`);
  }
  return key;
}

/**
 * A credit lane's run (§13). `spec` carries the key and the reserved budget B; `settle` writes the run's ledger lines
 * and says whether the pool stopped it (then the key is dead for every model), with a note if a line failed to write.
 */
export interface CreditRun {
  spec: LaunchSpec;
  settle: (run: WorkerRun, costUsd: number | undefined) => Promise<{ stopped: boolean; note?: string }>;
}

/**
 * Reads the key, then reserves B. `"quota"`: B ≤ 0. `note`: the lane key cannot run this call. `cancelled`: the key
 * command was aborted.
 */
export async function openCreditRun(
  poolId: string,
  pool: CreditPoolConfig,
  grantedUsd: number,
  spec: LaunchSpec,
  signal: AbortSignal,
): Promise<CreditRun | "quota" | { note: string } | { cancelled: string }> {
  let key: string;
  try {
    key = await readKey(pool.keyCommand, signal);
  } catch (err) {
    const message = errorMessage(err);
    return signal.aborted ? { cancelled: message } : { note: `${poolId} key command failed: ${message}` };
  }
  const taskId = randomUUID();
  let reserved: { budget: number; clipped: boolean };
  try {
    reserved = await reserveCredit(poolId, pool, grantedUsd, taskId);
  } catch (err) {
    return { note: `${poolId} ledger write failed: ${writeError(err)}` };
  }
  const { budget, clipped } = reserved;
  if (budget <= 0) return "quota";
  const line = (kind: TaskKind, usd: number) => appendLedger(poolId, { at: Date.now(), taskId, kind, usd });
  return {
    spec: creditSpec(spec, key, budget),
    settle: async (run, costUsd) => {
      const exhausted = run.failure !== undefined && creditExhausted(run.failure);
      // B below the cap: the pool, not the task, set the budget, so its stop is a quota outcome.
      const stopped = exhausted || (clipped && budgetStopped(run));
      // A prompted run without a cost may have spent all of B; the next balance read corrects it.
      const spent = run.prompted ? (costUsd ?? budget) : 0;
      try {
        await line("settle", spent);
        if (exhausted) await line("exhausted", 0);
      } catch (err) {
        // The reservation then stays counted.
        return { stopped, note: `${poolId} ledger write failed after the run: ${writeError(err)}` };
      }
      return { stopped };
    },
  };
}
