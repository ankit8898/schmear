import { HOSTS } from "./hosts.ts";
import type { Snapshot } from "./server.ts";
import type { TaskRow } from "./tasks.ts";
import {
  type AgentId,
  creditLogin,
  DEFAULT_ACCOUNT,
  instanceId,
  type Pool,
  parseCreditPool,
  parseInstance,
  type Window,
} from "./types.ts";
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
  "gemini-credits": "API credits",
};

export function poolLabel(poolId: string): string {
  const base = poolId.split("@")[0] ?? poolId;
  return POOL_LABELS[base] ?? base;
}

export interface QuotaPool {
  id: string;
  label: string;
  windows: Window[];
  /** A credit pool's org name or Google billing account, printed on its second line. */
  name?: string;
  /** A credit pool's balance: the row prints `$<left> of $<granted> left` and the expiry, the second line the split and month spend. */
  usd?: Pool["usd"];
  /** Routing verdict printed dim at the row's end, e.g. `pace 0.72 · ok`. */
  route?: string;
}

export interface QuotaAccount {
  account: string;
  plan?: string;
  /** Monthly API credits included with the plan, in USD. */
  planCreditsUsd?: number;
  /** True when the plan includes API credits and the account owns no credit pool: the row names `schmear credits <account>`. */
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
  pools: Array<{ id: string; windows: Window[]; name?: string; usd?: Pool["usd"]; route?: string }>;
}

/** An account's pools and warnings, with `credits` (the credit pool readings it owns) nested under it. */
export function quotaAccount(account: string, reading: QuotaReading, credits: QuotaReading[]): QuotaAccount {
  const pool = (p: QuotaReading["pools"][number], label = poolLabel(p.id)): QuotaPool => ({
    id: p.id,
    label,
    windows: p.windows,
    ...(p.name !== undefined ? { name: p.name } : {}),
    ...(p.usd !== undefined ? { usd: p.usd } : {}),
    ...(p.route !== undefined ? { route: p.route } : {}),
  });
  const pools = reading.pools.map((p) => pool(p));
  const warnings = [...reading.warnings];
  for (const credit of credits) {
    if (credit.error !== undefined) {
      warnings.push(`${poolLabel(credit.pools[0]?.id ?? "")}: ${credit.error}`);
    }
    for (const p of credit.pools) {
      if (p.windows.length > 0) pools.push(pool(p));
    }
    warnings.push(...credit.warnings);
  }
  return { account, ...(reading.error !== undefined ? { error: reading.error } : {}), warnings, pools };
}

/** A credit reading's agent and owning account: pool `<key>@<n>` belongs to `<agentOf(key)>@<n>`. An unparseable id (a 0.4-shape key) falls back to `claude@default`. */
function creditOwner(reading: QuotaReading): { agent: AgentId; account: string } {
  const parsed = parseCreditPool(reading.pools[0]?.id ?? "");
  return { agent: parsed?.agent ?? "claude", account: parsed?.name ?? DEFAULT_ACCOUNT };
}

/** The credit readings that `agent`'s account `account` owns. */
export function creditsOf(credits: QuotaReading[], agent: AgentId, account: string): QuotaReading[] {
  return credits.filter((c) => {
    const owner = creditOwner(c);
    return owner.agent === agent && owner.account === account;
  });
}

/** One row per `agent` credit reading that none of its `accounts` (consented, default first) owns: an API-only pool, named with the login it runs under. */
export function apiOnlyAccounts(agent: AgentId, accounts: string[], credits: QuotaReading[]): QuotaAccount[] {
  return credits
    .filter((c) => {
      const owner = creditOwner(c);
      return owner.agent === agent && !accounts.includes(owner.account);
    })
    .map((c) => {
      const login = creditLogin(
        c.pools[0]?.id ?? "",
        accounts.map((a) => instanceId(agent, a)),
      );
      const label = `${creditOwner(c).account} · API credits only${login ? ` · runs under ${login}` : ""}`;
      return quotaAccount(label, { warnings: [], pools: [] }, [c]);
    });
}

const BAR_WIDTH = 12;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

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

export function formatDate(epochMs: number): string {
  const d = new Date(epochMs);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

export function formatUsd(usd: number): string {
  const rounded = Math.round(usd * 100) / 100;
  return Number.isInteger(rounded) ? `$${rounded}` : `$${rounded.toFixed(2)}`;
}

/** The amount to name before `expires`: set only when less than the whole balance expires. */
export const expiringUsd = (usd: NonNullable<Pool["usd"]>): number | undefined =>
  usd.expiring !== undefined && usd.left - usd.expiring >= 0.005 ? usd.expiring : undefined;

const NBSP = "\u00a0";

/** `wrap` that never breaks a `schmear …` command across lines: its spaces are non-breaking while wrapping. */
function wrapKeep(text: string, width: number): string {
  // A command runs until a token ending in punctuation.
  const glued = text.replace(/schmear(?: [^\s,;.)]+)+/g, (command) => command.replaceAll(" ", NBSP));
  return wrap(glued, width).replaceAll(NBSP, " ");
}

interface Part {
  text: string;
  style?: TextStyle;
}

/** `head`, then `parts` joined by " · "; a part that would pass `width` starts a new line indented by four, so no part breaks. */
function pack(head: string, parts: Part[], width: number, color: boolean): string[] {
  const indent = "    ";
  const lines: string[] = [];
  let line = head;
  let used = visibleWidth(head);
  for (const [i, { text, style }] of parts.entries()) {
    const sep = i === 0 ? "" : " · ";
    if (line !== indent && used + sep.length + text.length > width) {
      lines.push(line);
      [line, used] = [indent, indent.length];
    }
    const piece = line === indent ? text : `${sep}${text}`;
    line += style === undefined ? piece : paint(color, style, piece);
    used += piece.length;
  }
  lines.push(line);
  return lines;
}

/** A credit pool's dim second line: org name or billing account, the grant/purchased split, month-to-date spend. */
function poolDetail(pool: QuotaPool, width: number, color: boolean): string[] {
  const usd = pool.usd;
  const split = [
    ...(usd?.grant !== undefined ? [`${formatUsd(usd.grant)} grant`] : []),
    ...(usd?.purchased !== undefined ? [`${formatUsd(usd.purchased)} purchased`] : []),
  ];
  const parts = [
    ...(pool.name === undefined
      ? []
      : [parseCreditPool(pool.id)?.key === "gemini-credits" ? `billing ${pool.name}` : pool.name]),
    ...(split.length > 0 ? [split.join(" + ")] : []),
    ...(usd?.spentMonth !== undefined ? [`${formatUsd(usd.spentMonth)} spent this month`] : []),
  ];
  if (parts.length === 0) return [];
  return pack(
    "    ",
    parts.map((text) => ({ text, style: "dim" })),
    width,
    color,
  );
}

/** A yellow `▲` line inside an account, wrapped under its text. */
function warnLines(text: string, width: number, color: boolean): string[] {
  return wrapKeep(text, width - 4)
    .split("\n")
    .map((l, i) => `  ${paint(color, "yellow", `${i === 0 ? "▲ " : "  "}${l}`)}`);
}

/** Pure renderer for the nested Quotas block; drops bars when `width < 60`, emits no `\x1b` when `color` is false, and no line wider than `width`. */
export function renderQuotas(rows: QuotaRows, opts: { color: boolean; width: number }): string {
  const { color, width } = opts;
  const showBar = width >= 60;
  const allPools = rows.agents.flatMap((a) => a.accounts.flatMap((acct) => acct.pools));
  const labelWidth = Math.max(0, ...allPools.map((p) => visibleWidth(p.label)));
  const sections: string[] = [];

  for (const agent of rows.agents) {
    const lines: string[] = [paint(color, ["bold", "cyan"], agent.name)];
    // Only plan and not-used rows pad their name to a column; an API-only row's long label must not widen it.
    const acctWidth = Math.max(
      0,
      ...agent.accounts.filter((a) => a.plan !== undefined || a.notUsed).map((a) => visibleWidth(a.account)),
    );
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
      if (acct.planCreditsUsd === undefined && !acct.creditsHint) {
        return { leftPlain, leftStyled, rightPlain: "", rightStyled: "" };
      }
      const credits =
        acct.planCreditsUsd !== undefined
          ? `${formatUsd(acct.planCreditsUsd)} API credits / month`
          : "API credits";
      const command =
        acct.account === DEFAULT_ACCOUNT ? "schmear credits" : `schmear credits ${acct.account}`;
      const rightPlain = acct.creditsHint ? `${credits} · ${command}` : credits;
      const rightStyled = acct.creditsHint
        ? `${paint(color, "dim", `${credits} · `)}${paint(color, "cyan", command)}`
        : paint(color, "dim", credits);
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

      if (acct.error !== undefined) lines.push(...warnLines(`skipped: ${acct.error}`, width, color));
      for (const pool of acct.pools) {
        if (pool.windows.length === 0) continue;
        const binding = pool.windows.reduce((low, w) => (w.remaining < low.remaining ? w : low));
        const pct = Math.round(binding.remaining * 100);
        const tone = pct >= 50 ? "green" : pct >= 20 ? "yellow" : "red";
        const pctStr = paint(color, tone, `${pct}%`.padStart(4));
        const label = paint(color, "dim", pool.label.padEnd(labelWidth));

        const parts: Part[] =
          pool.usd !== undefined
            ? [
                {
                  text: `${formatUsd(Math.max(0, pool.usd.left))}${pool.usd.granted > 0 ? ` of ${formatUsd(pool.usd.granted)}` : ""} left`,
                },
              ]
            : pool.windows.length === 1
              ? [{ text: windowSpan(binding) }]
              : pool.windows.map((w) => ({ text: `${windowSpan(w)} ${Math.round(w.remaining * 100)}%` }));
        if (binding.resetsAt !== null) {
          const expiring = pool.usd && expiringUsd(pool.usd);
          const when =
            pool.usd !== undefined
              ? `${expiring === undefined ? "" : `${formatUsd(expiring)} `}expires ${formatDate(binding.resetsAt)}`
              : `resets ${formatReset(binding.resetsAt)}`;
          parts.push({ text: when, style: "dim" });
        }
        if (pool.route !== undefined) parts.push({ text: pool.route, style: "dim" });

        const filled = Math.round(Math.max(0, Math.min(1, binding.remaining)) * BAR_WIDTH);
        const bar = showBar
          ? `${paint(color, tone, "█".repeat(filled))}${paint(color, "dim", "░".repeat(BAR_WIDTH - filled))} `
          : "";
        lines.push(
          ...pack(`  ${label}  ${bar}${pctStr}  `, parts, width, color),
          ...poolDetail(pool, width, color),
        );
      }
      for (const warning of acct.warnings) lines.push(...warnLines(warning, width, color));
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
function snapshotQuotas(s: Snapshot): QuotaRows {
  const toQuota = (r: SnapshotReading): QuotaReading => ({
    ...(r.skipped !== undefined ? { error: r.skipped } : {}),
    warnings: r.warnings,
    pools: r.pools.map((p) => ({
      id: p.id,
      windows: p.windows,
      ...(p.name !== undefined ? { name: p.name } : {}),
      ...(p.usd !== undefined ? { usd: p.usd } : {}),
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
        : quotaAccount(instance.account, toQuota(r), creditsOf(credits, instance.agent, instance.account)),
    );
  }
  const rows: QuotaRows = { agents: [], unused: [] };
  for (const agent of new Set([...byAgent.keys(), ...credits.map((c) => creditOwner(c).agent)])) {
    const accounts = byAgent.get(agent) ?? [];
    const owners = accounts.filter((a) => !a.notUsed).map((a) => a.account);
    const apiOnly = apiOnlyAccounts(agent, owners, credits);
    if (owners.length === 0 && apiOnly.length === 0) rows.unused.push(NAMES[agent]);
    else rows.agents.push({ agent, name: NAMES[agent], accounts: [...accounts, ...apiOnly] });
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

/** clack-style gutter shared by the terminal views; `width` is the terminal's, gutter included. */
function gutter(color: boolean, termWidth: number, wordmark: string, note: string) {
  const width = Math.max(40, termWidth - 3); // the gutter's "│  ", floored as ttyIO does
  const bar = paint(color, "gray", "│");
  const lines = [
    `${paint(color, "gray", "┌")}  ${paint(color, ["bold", "cyan"], wordmark)} ${paint(color, "dim", note)}`,
  ];
  const block = (symbol: string, text: string) => {
    for (const [i, line] of wrapKeep(text, width).split("\n").entries()) {
      lines.push(line === "" ? bar : `${i === 0 ? symbol : bar}  ${line}`);
    }
  };
  return {
    width,
    bar,
    lines,
    block,
    section(title: string, body: string) {
      lines.push(bar);
      block(paint(color, "green", "◇"), title);
      block(bar, body);
    },
    dimLines: (text: string) =>
      wrap(text, width)
        .split("\n")
        .map((l) => paint(color, "dim", l))
        .join("\n"),
    end(): string {
      lines.push(bar, paint(color, "gray", "└"));
      return lines.join("\n");
    },
  };
}

/** The `schmear usage` terminal view of `s` in init's gutter; `width` is the terminal's, gutter included. */
export function renderUsage(s: Snapshot, opts: { color: boolean; width: number; now: number }): string {
  const { color, now } = opts;
  const g = gutter(color, opts.width, "schmear usage", `${s.cliVersion} · driver ${s.driver ?? "unknown"}`);

  const quotas = renderQuotas(snapshotQuotas(s), { color, width: g.width });
  g.section(
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
  if (s.notOffered.length > 0) next.push(g.dimLines(`not offered: ${s.notOffered.join(", ")}`));
  g.section("Next", next.join("\n"));

  if (s.tasks.length > 0) {
    g.section(`Tasks  ${paint(color, "dim", "last 24 h")}`, renderTasks(s.tasks, color, g.width, now));
  }

  const broken = s.hosts.filter((h) => h.status !== "ok");
  if (broken.length > 0) g.lines.push(g.bar);
  for (const { id, status } of broken) {
    const reason = status === "missing" ? "no schmear entry" : "its entry is out of date";
    g.block(
      paint(color, "yellow", "▲"),
      `${HOSTS[id]} can't reach schmear: ${reason}. Run ${paint(color, "cyan", "schmear init --yes")}, then restart ${HOSTS[id]}.`,
    );
  }
  return g.end();
}

export interface ViewOpts {
  color: boolean;
  /** The terminal's width, gutter included. */
  width: number;
}

const HELP_COMMANDS: Array<[command: string, description: string]> = [
  ["init [--yes]", "detect CLIs, pick subscriptions, register the MCP server in each host"],
  ["usage [--json] [--driver <id>]", "show each subscription's quota and where the next task would go"],
  ["tiers [--json]", "print the tier list"],
  ["tiers set", "replace the tier list with the JSON array of arrays on stdin"],
  ["tiers reset", "restore the default tier list"],
  ["max-tasks", "print the most tasks one delegate call may carry"],
  ["max-tasks <n>", 'set it; "reset" restores the default of 50'],
  ["max-per-pool", "print the most tasks that run at once on one usage pool"],
  ["max-per-pool <n>", 'set it; "reset" restores the default of 10'],
  ["credits", "spend your plan's Claude or Google API credits on a separate lane"],
  ["credits <account>", "set up credits for one account (claude@<name>, <name> or agy@<name>)"],
  ["credits status", "show stored sessions and credit pools"],
  [
    "credits login <claude|google> [--stdin] [--label <name>]",
    "store a Console or Google session: import it from a browser, or paste it with --stdin",
  ],
  ["credits logout [google] <label>", "remove a stored session"],
  ["credits remove <id>", "remove a credit pool and its ledger"],
  ["credits reset <id>", "clear a pool's exhausted mark"],
  ["uninstall [--yes]", "remove schmear from each host, and delete its skills, config and state"],
  ["serve", "run the stdio MCP server (your host starts this)"],
];

const HELP_OPTIONS: Array<[option: string, description: string]> = [
  [
    "-y, --yes",
    "init: keep your current selection without asking (newly found CLIs except Antigravity are ticked); uninstall: skip the confirmation",
  ],
  ["--json", "usage: print one JSON snapshot, from the routing cache; tiers: print JSON in a terminal too"],
  ["--driver <id>", "route as if this agent were driving, keeping its reserve (claude, codex, grok, agy)"],
  ["-h, --help", "show this help"],
  ["-v, --version", "print the version"],
];

const HELP_TAGLINE = "delegate coding subtasks across your AI subscriptions";
const HELP_DOCS = "https://github.com/kevin1chun/schmear";

/** The help a pipe gets: no styling, one command per line with its description beside or below it. */
export function plainHelp(): string {
  const commands = HELP_COMMANDS.map(([command, description]) => {
    const left = `  schmear ${command}`;
    return left.length > 26
      ? `${left}\n${" ".repeat(25)}${description}`
      : `${left.padEnd(Math.max(left.length + 1, 25))}${description}`;
  });
  const options = HELP_OPTIONS.map(([option, description]) => `  ${option.padEnd(14)} ${description}`);
  return `schmear: ${HELP_TAGLINE}\n\nUsage:\n${commands.join("\n")}\n\nOptions:\n${options.join("\n")}\n\nDocs: ${HELP_DOCS}\n`;
}

/** Two aligned columns, the left one `style`d, the right wrapped to `width` and indented under itself. */
function table(rows: Array<[string, string]>, width: number, style: (left: string) => string): string {
  const col = Math.min(28, Math.max(...rows.map(([left]) => left.length)));
  return rows
    .flatMap(([left, right]) => {
      const text = wrap(right, width - col - 2).split("\n");
      if (left.length > col) return [style(left), ...text.map((l) => `${" ".repeat(col + 2)}${l}`)];
      return text.map((l, i) => `${i === 0 ? style(left.padEnd(col)) : " ".repeat(col)}  ${l}`);
    })
    .join("\n");
}

/** `schmear --help` in a terminal. */
export function renderHelp(opts: ViewOpts): string {
  const { color } = opts;
  const g = gutter(color, opts.width, "schmear", `· ${HELP_TAGLINE}`);
  const cyan = (t: string) => paint(color, "cyan", t);
  g.section(
    "Commands",
    table(
      HELP_COMMANDS.map(([c, d]) => [`schmear ${c}`, d]),
      g.width,
      cyan,
    ),
  );
  g.section("Options", table(HELP_OPTIONS, g.width, cyan));
  g.lines.push(g.bar);
  g.block(g.bar, paint(color, "dim", `Docs: ${HELP_DOCS}`));
  return g.end();
}

/** `schmear tiers` in a terminal: one row per tier, weakest first. */
export function renderTiers(tiers: string[][], custom: boolean, opts: ViewOpts): string {
  const { color } = opts;
  const g = gutter(color, opts.width, "schmear tiers", custom ? "(custom)" : "(default)");
  const label = (i: number) => `Tier ${String(i + 1).padStart(String(tiers.length).length)}`;
  g.section(
    `Tiers  ${paint(color, "dim", "weakest first")}`,
    tiers
      .map((entries, i) => {
        // Greedy rows of "entry ·": the dot stays with its entry, so a wrapped row never starts with one.
        const avail = g.width - label(i).length - 2;
        const rows: string[][] = [[]];
        let used = 0;
        for (const [j, e] of entries.entries()) {
          const dot = j < entries.length - 1;
          const w = e.length + (dot ? 2 : 0);
          if (used > 0 && used + 1 + w > avail) {
            rows.push([]);
            used = 0;
          }
          (rows[rows.length - 1] as string[]).push(
            paint(color, "cyan", e) + (dot ? paint(color, "dim", " ·") : ""),
          );
          used += (used > 0 ? 1 : 0) + w;
        }
        return rows
          .map((row, j) => `${j === 0 ? label(i) : " ".repeat(label(i).length)}  ${row.join(" ")}`)
          .join("\n");
      })
      .join("\n"),
  );
  g.lines.push(g.bar);
  g.block(
    g.bar,
    g.dimLines(
      "schmear tiers --json prints the list and its defaults as JSON; schmear tiers set replaces it.",
    ),
  );
  return g.end();
}

/** A confirmation line: green ✓, then `text` wrapped under itself. */
export function renderOk(text: string, opts: ViewOpts): string {
  const rows = wrap(text, Math.max(40, opts.width - 2)).split("\n");
  return rows.map((row, i) => `${i === 0 ? paint(opts.color, "green", "✓") : " "} ${row}`).join("\n");
}

/** `schmear max-tasks` in a terminal: `50 tasks per call  (default)`. */
export function renderLimit(n: number, unit: string, custom: boolean, color: boolean): string {
  return `${paint(color, ["bold", "cyan"], String(n))} ${unit}  ${paint(color, "dim", custom ? "(custom)" : "(default)")}`;
}

/** A failure line for stderr: red ✗, with each backticked command in cyan. */
export function renderError(message: string, color: boolean): string {
  return `${paint(color, "red", "✗")} ${message.replace(/`([^`]+)`/g, (_, command: string) => paint(color, "cyan", command))}`;
}
