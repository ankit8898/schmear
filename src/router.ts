import {
  type AgentId,
  type Config,
  DEFAULT_ACCOUNT,
  instanceId,
  keyId,
  type Lane,
  type Pool,
  type UsageReading,
} from "./types.ts";

export const FLOOR = 0.02;
export const DEFAULT_MAX_PER_POOL = 10;
const RESERVE = 0.05;
const WAIVER_H = 2;
const TIE = 0.05;
const MIN_H = 0.1;

export interface PoolRow {
  id: string;
  agent: AgentId;
  pace: number | null;
  status: "ok" | `out: ${string}` | `skipped: ${string}`;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

function skipReason(r: UsageReading, config: Config): string | undefined {
  const a = config.agents[instanceId(r.agent, r.account)];
  if (!a?.consent) return "no consent";
  return r.error;
}

function poolRow(pool: Pool, now: number, driver: AgentId | null, credit: boolean, reserve: number): PoolRow {
  let out = pool.windows.length === 0 ? "no window" : undefined;
  let pace = Infinity;
  let periodPace = Infinity;
  for (const w of pool.windows) {
    const [remaining, resetsAt] =
      w.resetsAt !== null && w.resetsAt <= now ? [1, null] : [w.remaining, w.resetsAt];
    const hoursLeft = resetsAt !== null ? (resetsAt - now) / 3.6e6 : w.periodHours;
    // The driver's own login is taken to be its default account.
    const threshold =
      w.kind === "period" &&
      pool.agent === driver &&
      pool.account === DEFAULT_ACCOUNT &&
      !credit &&
      hoursLeft > WAIVER_H
        ? reserve
        : FLOOR;
    if (remaining - threshold <= 0)
      out ??= `${w.kind} window ${pct(remaining)} left, threshold ${pct(threshold)}`;
    const p = ((remaining - threshold) * w.periodHours) / Math.max(hoursLeft, MIN_H);
    pace = Math.min(pace, p);
    if (w.kind === "period") periodPace = Math.min(periodPace, p);
  }
  if (out) return { id: pool.id, agent: pool.agent, pace: null, status: `out: ${out}` };
  return {
    id: pool.id,
    agent: pool.agent,
    pace: periodPace < Infinity ? periodPace : pace,
    status: "ok",
  };
}

const drawsOn = (pool: Pool, key: string, account: string, model: string) =>
  pool.account === account &&
  pool.keys.some((k) => k === key) &&
  (!pool.models || pool.models.includes(model));

const isDriver = (l: Lane, driver: AgentId | null) => l.agent === driver && l.account === DEFAULT_ACCOUNT;

type Scored = { lane: Lane; pace: number; pools: Set<string> };

function pick(lanes: Scored[], driver: AgentId | null, load: (l: Scored) => number): Scored | undefined {
  const best = Math.max(...lanes.map((l) => l.pace));
  const band = lanes.filter((l) => l.pace >= best * (1 - TIE));
  band.sort(
    (a, b) =>
      load(a) - load(b) ||
      a.lane.tier - b.lane.tier ||
      Number(!isDriver(b.lane, driver)) - Number(!isDriver(a.lane, driver)) ||
      b.pace - a.pace ||
      (a.lane.id < b.lane.id ? -1 : a.lane.id > b.lane.id ? 1 : 0),
  );
  return band[0];
}

/** Pure: assigns each task the lane whose pools most need spending (§9.2). */
export function route(input: {
  now: number;
  driver: AgentId | null;
  readings: UsageReading[];
  config: Config;
  exclude: Set<string>; // lane ids or key ids
  running: string[]; // lane id of each task already holding a lane, in this process or another
  tasks: Lane[][]; // per task, its candidate lanes in candidates() order
}): { assignments: (Lane | "wait" | null)[]; pools: PoolRow[] } {
  const { now, driver, readings, config } = input;
  const pools: PoolRow[] = [];
  const usable: { pool: Pool; pace: number | null }[] = [];
  for (const r of readings) {
    const skip = skipReason(r, config);
    if (r.pools.length === 0 && skip) {
      pools.push({
        id: instanceId(r.agent, r.account),
        agent: r.agent,
        pace: null,
        status: `skipped: ${skip}`,
      });
    }
    for (const p of r.pools) {
      const credit = config.credits !== undefined && p.keys.includes("claude-credits");
      const reserve = Math.max(config.reserve?.[p.agent] ?? RESERVE, FLOOR);
      const row = poolRow(p, now, driver, credit, reserve);
      if (skip) {
        pools.push({ ...row, pace: null, status: `skipped: ${skip}` });
      } else {
        pools.push(row);
        usable.push({ pool: p, pace: row.pace });
      }
    }
  }

  const cap = config.maxPerPool ?? DEFAULT_MAX_PER_POOL;
  const counts = new Map<string, number>(); // tasks per pool id: running, then assigned in this call
  for (const id of input.running) {
    const colon = id.indexOf(":");
    const at = id.lastIndexOf("@", colon);
    if (colon < 0 || at < 0) continue;
    const [key, account, model] = [id.slice(0, at), id.slice(at + 1, colon), id.slice(colon + 1)];
    for (const { pool: p } of usable) {
      if (drawsOn(p, key, account, model)) counts.set(p.id, (counts.get(p.id) ?? 0) + 1);
    }
  }
  const count = (id: string) => counts.get(id) ?? 0;
  const load = (l: Scored) => Math.max(...[...l.pools].map(count));
  const assignments = input.tasks.map((candidates) => {
    let eligible: Scored[] = [];
    for (const lane of candidates) {
      const kid = keyId(lane.key, lane.account);
      if (input.exclude.has(lane.id) || input.exclude.has(kid)) continue;
      const own = usable.filter(({ pool: p }) => drawsOn(p, lane.key, lane.account, lane.model));
      const paces = own.flatMap((u) => (u.pace === null ? [] : [u.pace]));
      // A lane needs its own pool; shared pools alone (agy-gemini for agy-argon) do not make it eligible.
      if (!own.some((u) => u.pool.id === kid) || paces.length < own.length) continue;
      eligible.push({ lane, pace: Math.min(...paces), pools: new Set(own.map((u) => u.pool.id)) });
    }
    if (eligible.length === 0) return null;
    eligible = eligible.filter((l) => load(l) < cap);
    if (eligible.length === 0) return "wait";
    const chosen = pick(eligible, driver, load);
    if (!chosen) return null;
    for (const id of chosen.pools) counts.set(id, (counts.get(id) ?? 0) + 1);
    return chosen.lane;
  });
  return { assignments, pools };
}
