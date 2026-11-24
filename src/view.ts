import { HOSTS } from "./hosts.ts";
import type { Snapshot } from "./server.ts";
import type { TaskRow } from "./tasks.ts";
import { type AgentId, DEFAULT_ACCOUNT, instanceId, parseInstance, type Window } from "./types.ts";
import { paint, type TextStyle, visibleWidth, wrap } from "./ui.ts";

export const NAMES: Record<AgentId, string> = {
  claude: "Claude",
  codex: "Codex",
  grok: "Grok",
  agy: "Antigravity",
};

/** Human label for a pool id (derived from the adapters' pool definitions and model lists). */
const POOL_LABELS: Record<string, string> = {
  claude: "All models",
  "claude-haiku": "Haiku",
  "claude-sonnet": "Sonnet",
  "claude-opus": "Opus",
  "claude-fable": "Fable",
  "claude-credits": "API credits",
  codex: "All models",
  grok: "All models",
  "agy-gemini": "Gemini",
  "agy-argon": "Argon",
  "agy-3p": "Claude/GPT",
};

export function poolLabel(poolId: string): string {
  const base = poolId.split("@")[0] ?? poolId;
  return POOL_LABELS[base] ?? base;
}

export interface QuotaPool {
  id: string;
  label: string;
  windows: Window[];
  /** Set for the `claude-credits` pool so the row prints `$<remaining> of $<grant>`. */
  grantUsd?: number;
  /** Routing verdict printed dim at the row's end, e.g. `pace 0.72 · ok`. */
  route?: string;
}

export interface QuotaAccount {
  account: string;
  plan?: string;
  /** Monthly API credit grant on this Claude account's plan, if any. */
  grantUsd?: number;
  /** True on `claude@default` when its plan has a grant and `config.credits` is unset. */
  creditsHint?: boolean;
  notUsed?: boolean;
  error?: string;
  warnings: string[];
  pools: QuotaPool[];
}

export interface QuotaAgent {
  agent: AgentId;
  name: string;
  accounts: QuotaAccount[];
}

export interface QuotaRows {
  agents: QuotaAgent[];
  unused: string[];
}

/** What a quota block needs of a reading; `error` set: the subscription is skipped. */
export interface QuotaReading {
  error?: string;
  warnings: string[];
  pools: Array<{ id: string; windows: Window[]; route?: string }>;
}

/** An account's pools and warnings, with `credits` (claude@default's API credit readings) nested under it. */
export function quotaAccount(
  account: string,
  reading: QuotaReading,
  credits: QuotaReading[],
  creditGrantUsd: number | undefined,
): QuotaAccount {
  const pool = (p: QuotaReading["pools"][number]): QuotaPool => ({
    id: p.id,
    label: poolLabel(p.id),
    windows: p.windows,
    ...(p.route !== undefined ? { route: p.route } : {}),
  });
  const pools = reading.pools.map(pool);
  const warnings = [...reading.warnings];
  for (const credit of credits) {
    if (credit.error !== undefined) warnings.push(`API credits: ${credit.error}`);
    for (const p of credit.pools) {
      if (p.windows.length > 0) pools.push({ ...pool(p), grantUsd: creditGrantUsd });
    }
    warnings.push(...credit.warnings);
  }
  return { account, ...(reading.error !== undefined ? { error: reading.error } : {}), warnings, pools };
}

const BAR_WIDTH = 12;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function windowSpan(w: Window): string {
  const hours = Number(w.periodHours.toFixed(1));
  return hours >= 24 && hours % 24 === 0 ? `${hours / 24}d` : `${hours}h`;
}

function formatReset(epochMs: number): string {
  const d = new Date(epochMs);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${DAYS[d.getDay()]} ${hh}:${mm}`;
}

function formatUsd(usd: number): string {
  const rounded = Math.round(usd * 100) / 100;
  return Number.isInteger(rounded) ? `$${rounded}` : `$${rounded.toFixed(2)}`;
}

/** Pure renderer for the nested Quotas block; drops bars when `width < 60`, emits no `\x1b` when `color` is false. */
export function renderQuotas(rows: QuotaRows, opts: { color: boolean; width: number }): string {
  const { color, width } = opts;
  const showBar = width >= 60;
  const allPools = rows.agents.flatMap((a) => a.accounts.flatMap((acct) => acct.pools));
  const labelWidth = Math.max(0, ...allPools.map((p) => visibleWidth(p.label)));
  const sections: string[] = [];

  for (const agent of rows.agents) {
    const lines: string[] = [paint(color, ["bold", "cyan"], agent.name)];
    const acctWidth = Math.max(...agent.accounts.map((a) => visibleWidth(a.account)));
    const headers = agent.accounts.map((acct) => {
      if (acct.notUsed) {
        const plain = `○ ${acct.account.padEnd(acctWidth)}  not used`;
        return { leftPlain: plain, leftStyled: paint(color, "dim", plain), rightPlain: "", rightStyled: "" };
      }
      const hasPlan = acct.plan !== undefined;
      const acctName = hasPlan ? acct.account.padEnd(acctWidth) : acct.account;
      const leftPlain = hasPlan ? `● ${acctName}  ${acct.plan}` : `● ${acctName}`;
      const leftStyled = hasPlan
        ? `${paint(color, "cyan", "●")} ${paint(color, "bold", acctName)}  ${paint(color, "dim", acct.plan as string)}`
        : `${paint(color, "cyan", "●")} ${paint(color, "bold", acctName)}`;
      if (acct.grantUsd === undefined) {
        return { leftPlain, leftStyled, rightPlain: "", rightStyled: "" };
      }
      const grantText = `$${acct.grantUsd} API credits / cycle`;
      const rightPlain = acct.creditsHint ? `${grantText} · schmear credits` : grantText;
      const rightStyled = acct.creditsHint
        ? `${paint(color, "dim", `${grantText} · `)}${paint(color, "cyan", "schmear credits")}`
        : paint(color, "dim", grantText);
      return { leftPlain, leftStyled, rightPlain, rightStyled };
    });

    const withGrant = headers.filter((h) => h.rightPlain !== "");
    const maxLeft = Math.max(0, ...withGrant.map((h) => visibleWidth(h.leftPlain)));
    const maxRight = Math.max(0, ...withGrant.map((h) => visibleWidth(h.rightPlain)));
    const inlineGrants = withGrant.length > 0 && maxLeft + 2 + maxRight <= width;
    const grantCol = inlineGrants ? Math.max(maxLeft + 2, Math.min(width, 86) - maxRight) : 0;

    for (let i = 0; i < agent.accounts.length; i++) {
      const acct = agent.accounts[i] as QuotaAccount;
      const h = headers[i] as (typeof headers)[number];
      if (h.rightPlain === "") {
        lines.push(h.leftStyled);
      } else if (inlineGrants) {
        const pad = " ".repeat(Math.max(2, grantCol - visibleWidth(h.leftPlain)));
        lines.push(`${h.leftStyled}${pad}${h.rightStyled}`);
      } else {
        lines.push(h.leftStyled);
        lines.push(`  ${h.rightStyled}`);
      }

      if (acct.error !== undefined) {
        lines.push(`  ${paint(color, "yellow", `▲ skipped: ${acct.error}`)}`);
      }
      for (const pool of acct.pools) {
        if (pool.windows.length === 0) continue;
        const binding = pool.windows.reduce((low, w) => (w.remaining < low.remaining ? w : low));
        const pct = Math.round(binding.remaining * 100);
        const tone = pct >= 50 ? "green" : pct >= 20 ? "yellow" : "red";
        const pctStr = paint(color, tone, `${pct}%`.padStart(4));
        const label = paint(color, "dim", pool.label.padEnd(labelWidth));

        let metric: string;
        if (pool.grantUsd !== undefined) {
          const leftUsd = Math.max(0, binding.remaining * pool.grantUsd);
          metric = `${formatUsd(leftUsd)} of ${formatUsd(pool.grantUsd)}`;
        } else if (pool.windows.length === 1) {
          metric = windowSpan(binding);
        } else {
          metric = pool.windows.map((w) => `${windowSpan(w)} ${Math.round(w.remaining * 100)}%`).join(" · ");
        }
        const reset =
          binding.resetsAt !== null ? paint(color, "dim", ` · resets ${formatReset(binding.resetsAt)}`) : "";
        const route = pool.route !== undefined ? paint(color, "dim", ` · ${pool.route}`) : "";
        const detail = `${metric}${reset}${route}`;

        if (showBar) {
          const filled = Math.round(Math.max(0, Math.min(1, binding.remaining)) * BAR_WIDTH);
          const bar =
            paint(color, tone, "█".repeat(filled)) + paint(color, "dim", "░".repeat(BAR_WIDTH - filled));
          lines.push(`  ${label}  ${bar} ${pctStr}  ${detail}`);
        } else {
          lines.push(`  ${label}  ${pctStr}  ${detail}`);
        }
      }
      for (const warning of acct.warnings) {
        lines.push(`  ${paint(color, "yellow", `▲ ${warning}`)}`);
      }
    }
    sections.push(lines.join("\n"));
  }

  if (rows.unused.length > 0) {
    sections.push(paint(color, "dim", `${rows.unused.join(" · ")}  not used`));
  }
  return sections.join("\n\n");
}

type SnapshotReading = Snapshot["readings"][number];

/** The snapshot's readings as init's quota rows; "not configured" and "no consent" are the snapshot's own skip reasons. */
function snapshotQuotas(s: Snapshot, creditGrantUsd: number | undefined): QuotaRows {
  const toQuota = (r: SnapshotReading): QuotaReading => ({
    ...(r.skipped !== undefined ? { error: r.skipped } : {}),
    warnings: r.warnings,
    pools: r.pools.map((p) => ({
      id: p.id,
      windows: p.windows,
      ...(p.status !== undefined
        ? { route: `pace ${typeof p.pace === "number" ? p.pace.toFixed(2) : "—"} · ${p.status}` }
        : {}),
    })),
  });
  // Credit pool readings are the only ones whose id is not an agent instance.
  const credits = s.readings.filter((r) => parseInstance(r.id) === undefined).map(toQuota);
  const byAgent = new Map<AgentId, QuotaAccount[]>();
  for (const r of s.readings) {
    const instance = parseInstance(r.id);
    if (!instance || r.skipped === "not configured") continue;
    const accounts = byAgent.get(instance.agent) ?? [];
    byAgent.set(instance.agent, accounts);
    accounts.push(
      r.skipped === "no consent"
        ? { account: instance.account, notUsed: true, warnings: [], pools: [] }
        : quotaAccount(
            instance.account,
            toQuota(r),
            r.id === instanceId("claude", DEFAULT_ACCOUNT) ? credits : [],
            creditGrantUsd,
          ),
    );
  }
  const rows: QuotaRows = { agents: [], unused: [] };
  for (const [agent, accounts] of byAgent) {
    if (accounts.every((a) => a.notUsed)) rows.unused.push(NAMES[agent]);
    else rows.agents.push({ agent, name: NAMES[agent], accounts });
  }
  return rows;
}

/** A lane id without the default account: `claude:fable`, `claude@work:opus`. */
const laneLabel = (lane: string): string => lane.replace(`@${DEFAULT_ACCOUNT}:`, ":");

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

const truncate = (text: string, width: number): string =>
  text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1)).trimEnd()}…`;

const TASK_GLYPHS: Record<TaskRow["status"], [string, TextStyle]> = {
  running: ["●", "cyan"],
  done: ["✓", "green"],
  failed: ["✗", "red"],
  lost: ["▲", "yellow"],
  cancelled: ["■", "dim"],
  no_quota: ["○", "yellow"],
};
const MAX_TASKS_SHOWN = 10;

function renderTasks(tasks: TaskRow[], color: boolean, width: number, now: number): string {
  const shown = tasks.slice(0, MAX_TASKS_SHOWN).map((t) => ({
    glyph: paint(color, TASK_GLYPHS[t.status][1], TASK_GLYPHS[t.status][0]),
    description: t.description,
    lane: t.lane === null ? "no lane" : laneLabel(t.lane),
    duration: formatDuration((t.endedAt ?? now) - t.startedAt),
    cost: t.costUsd === undefined ? "" : `$${t.costUsd.toFixed(2)}`,
  }));
  const laneWidth = Math.max(...shown.map((t) => t.lane.length));
  const durationWidth = Math.max(...shown.map((t) => t.duration.length));
  const costWidth = Math.max(...shown.map((t) => t.cost.length));
  const fixed = 2 + 2 + laneWidth + 2 + durationWidth + (costWidth > 0 ? 2 + costWidth : 0);
  const descWidth = Math.min(
    Math.max(...shown.map((t) => t.description.length)),
    Math.max(10, width - fixed),
  );
  const rows = shown.map((t) => {
    const cost = t.cost === "" ? "" : `  ${t.cost.padStart(costWidth)}`;
    return `${t.glyph} ${truncate(t.description, descWidth).padEnd(descWidth)}  ${paint(color, "dim", t.lane.padEnd(laneWidth))}  ${t.duration.padStart(durationWidth)}${cost}`;
  });
  if (tasks.length > shown.length) rows.push(paint(color, "dim", `+${tasks.length - shown.length} more`));
  return rows.join("\n");
}

/** The `schmear usage` terminal view of `s` in init's gutter; `width` is the terminal's, gutter included. */
export function renderUsage(
  s: Snapshot,
  opts: { color: boolean; width: number; now: number; creditGrantUsd?: number },
): string {
  const { color, now } = opts;
  const width = Math.max(40, opts.width - 3); // the gutter's "│  ", floored as ttyIO does
  const bar = paint(color, "gray", "│");
  const lines = [
    `${paint(color, "gray", "┌")}  ${paint(color, ["bold", "cyan"], "schmear usage")} ${paint(color, "dim", `${s.cliVersion} · driver ${s.driver ?? "unknown"}`)}`,
  ];
  const block = (symbol: string, text: string) => {
    for (const [i, line] of wrap(text, width).split("\n").entries()) {
      lines.push(line === "" ? bar : `${i === 0 ? symbol : bar}  ${line}`);
    }
  };
  const section = (title: string, body: string) => {
    lines.push(bar);
    block(paint(color, "green", "◇"), title);
    block(bar, body);
  };
  const dimLines = (text: string) =>
    wrap(text, width)
      .split("\n")
      .map((l) => paint(color, "dim", l))
      .join("\n");

  const quotas = renderQuotas(snapshotQuotas(s, opts.creditGrantUsd), { color, width });
  section(
    "Quotas",
    quotas === ""
      ? `${paint(color, "dim", "No subscriptions set up. Run")} ${paint(color, "cyan", "schmear init")}`
      : quotas,
  );

  const tierWidth = String(s.next.length).length;
  const laneWidth = Math.max(0, ...s.next.map((n) => (n.lane === null ? 0 : laneLabel(n.lane).length)));
  const next = s.next.map((n) => {
    const tier = String(n.tier).padStart(tierWidth);
    if (n.lane === null) return `${tier}  ${paint(color, "dim", "—  no lane")}`;
    return `${tier}  ${paint(color, "dim", "→")} ${paint(color, "cyan", laneLabel(n.lane).padEnd(laneWidth))}  ${paint(color, "dim", n.effort ?? "")}`;
  });
  if (s.notOffered.length > 0) next.push(dimLines(`not offered: ${s.notOffered.join(", ")}`));
  section("Next", next.join("\n"));

  if (s.tasks.length > 0) {
    section(`Tasks  ${paint(color, "dim", "last 24 h")}`, renderTasks(s.tasks, color, width, now));
  }

  const broken = s.hosts.filter((h) => h.status !== "ok");
  if (broken.length > 0) lines.push(bar);
  for (const { id, status } of broken) {
    const reason = status === "missing" ? "no schmear entry" : "its entry is out of date";
    block(
      paint(color, "yellow", "▲"),
      `${HOSTS[id]} can't reach schmear: ${reason}. Run ${paint(color, "cyan", "schmear init --yes")}, then restart ${HOSTS[id]}.`,
    );
  }
  lines.push(bar, paint(color, "gray", "└"));
  return lines.join("\n");
}
