import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { configPath, writeAtomic } from "./state.ts";
import { errorMessage, isRecord } from "./util.ts";

// Reads a Claude Console org's prepaid credit balance the way CodexBar's `claudeplatform` plugin does (§13).
// Console endpoints are undocumented; the cookie goes only to platform.claude.com and never into a message.

const HOST = "https://platform.claude.com";
const TIMEOUT_MS = 60_000;
const FLOOR_FRACTION = 0.02;

export type VendorBalance =
  | {
      usd: number;
      grantedUsd: number;
      floorUsd: number;
      window: { resetsAt: number | null };
      /** What is left of, and was granted in, the live money expiring at `window.resetsAt`; present exactly when that is set. */
      expiring?: { usd: number; grantedUsd: number };
      warnings: string[];
      /** Identifies the grant, so equal amounts from the next grant still read as a new balance. */
      tranche?: string;
      name?: string;
      /** Remaining in live promotional grants. */
      grantUsd?: number;
      /** Remaining in live purchased credit. */
      purchasedUsd?: number;
      spentMonthUsd?: number;
    }
  | { error: string };

export interface ConsoleOrg {
  id: string;
  name: string;
}

type Fetch = typeof fetch;

export type SessionVendor = "claude" | "google";

export const pasteCommand = (
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string =>
  platform === "darwin" ? "pbpaste" : env.WAYLAND_DISPLAY ? "wl-paste" : "xclip -o -selection clipboard";

/** The command that prints the clipboard, for the login commands schmear tells the user to run. */
export const PASTE = pasteCommand();

const LOGIN_SITE: Record<SessionVendor, string> = {
  claude: "platform.claude.com",
  google: "me.developers.google.com",
};

/** A rejected session; its message names the labels and the command, so callers show it unprefixed (`sessionProblem`). */
export class SessionExpired extends Error {
  constructor(vendor: SessionVendor = "claude", labels: string[] = []) {
    const name = vendor === "claude" ? "Console" : "Google";
    const site = LOGIN_SITE[vendor];
    const login = `schmear credits login ${vendor}`;
    if (labels.length > 1) {
      const list = `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
      super(
        `${name} sessions ${list} expired. Sign in at ${site}, then run for each: ${login} --label <label>`,
      );
    } else {
      const [label] = labels;
      super(
        `${name} session ${label ? `${label} ` : ""}expired. Sign in at ${site}, then run: ${login}${label ? ` --label ${label}` : ""}`,
      );
    }
  }
}

/** Whether a reading's error opens with a `SessionExpired` message. */
export const isExpiredMessage = (text: string): boolean =>
  /^(Console|Google) sessions? (.+ )?expired\. Sign in at /.test(text);

export const sessionProblem = (label: string, err: unknown): string =>
  err instanceof SessionExpired ? err.message : `session ${label}: ${errorMessage(err)}`;

export function consoleSessionsPath(
  env: NodeJS.ProcessEnv = process.env,
  vendor: SessionVendor = "claude",
): string {
  return join(
    dirname(configPath(env)),
    vendor === "claude" ? "console-sessions.json" : "google-sessions.json",
  );
}

export interface SessionSource {
  browser: string;
  profile: string;
}

export interface SessionEntry {
  cookie: string;
  source?: SessionSource;
}

const isSource = (v: unknown): v is SessionSource =>
  isRecord(v) && !Array.isArray(v) && typeof v.browser === "string" && typeof v.profile === "string";

// Printable ASCII only: fetch's error for an invalid header quotes the value.
const isCookie = (v: unknown): v is string => typeof v === "string" && /^[\x20-\x7e]+$/.test(v);

const isEntry = (v: unknown): v is SessionEntry =>
  isRecord(v) && !Array.isArray(v) && isCookie(v.cookie) && (v.source === undefined || isSource(v.source));

/** label → entry, in file order. Missing file: none. */
export async function readSessionEntries(
  vendor: SessionVendor = "claude",
): Promise<Record<string, SessionEntry>> {
  const path = consoleSessionsPath(process.env, vendor);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw err;
  }
  // The parse error message can quote the text, which holds cookies.
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (!isRecord(parsed) || Array.isArray(parsed) || !Object.values(parsed).every(isEntry)) {
    throw new Error(`malformed ${path}: expected an object of label to { cookie, source }`);
  }
  return parsed as Record<string, SessionEntry>;
}

/** label → Cookie header. */
export async function readSessions(vendor: SessionVendor = "claude"): Promise<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(await readSessionEntries(vendor)).map(([label, entry]) => [label, entry.cookie]),
  );
}

/** A pasted session has no `source`. */
export async function writeSession(
  label: string,
  cookie: string,
  vendor: SessionVendor = "claude",
  source?: SessionSource,
): Promise<void> {
  if (!isCookie(cookie)) {
    throw new Error(`session ${label}: the cookie must be printable ASCII on one line`);
  }
  const entry: SessionEntry = source ? { cookie, source } : { cookie };
  const sessions = { ...(await readSessionEntries(vendor)), [label]: entry };
  await writeAtomic(consoleSessionsPath(process.env, vendor), `${JSON.stringify(sessions, null, 2)}\n`);
}

/** false: no such label. */
export async function removeSession(label: string, vendor: SessionVendor = "claude"): Promise<boolean> {
  const { [label]: gone, ...rest } = await readSessionEntries(vendor);
  if (gone === undefined) {
    return false;
  }
  await writeAtomic(consoleSessionsPath(process.env, vendor), `${JSON.stringify(rest, null, 2)}\n`);
  return true;
}

const invalid = (field: string): never => {
  throw new Error(
    `Could not parse Claude Console ${field}. The Console response format may have changed; update schmear or report this.`,
  );
};
const object = (value: unknown, field: string): Record<string, unknown> =>
  isRecord(value) && !Array.isArray(value) ? value : invalid(field);
const minorUnits = (value: unknown, field: string): number =>
  typeof value === "number" && Number.isSafeInteger(value) ? value : invalid(field);
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;
// A malformed date means an unknown expiry, never a failed read.
function timestamp(value: unknown): number | undefined {
  const raw = text(value);
  if (!raw || !/^\d{4}-\d{2}-\d{2}T/.test(raw)) {
    return undefined;
  }
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : undefined;
}

/** GET a Console path with the session's cookie; throws a message free of the cookie and of response bodies. */
async function request(
  fetchFn: Fetch,
  cookie: string,
  path: string,
  forbidden: string | null,
  label?: string,
): Promise<unknown> {
  let res: Response;
  try {
    // Manual: a redirect must not carry the cookie to another host.
    res = await fetchFn(`${HOST}${path}`, {
      headers: { Accept: "application/json", Cookie: cookie },
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`Claude Console request failed: ${errorMessage(err)}`);
  }
  if (res.status === 401) {
    throw new SessionExpired("claude", label ? [label] : []);
  }
  if (res.status === 403) {
    throw forbidden === null ? new SessionExpired("claude", label ? [label] : []) : new Error(forbidden);
  }
  if (res.status === 429) {
    throw new Error("Claude Console requests are rate limited. Try again in a few minutes.");
  }
  if (res.status >= 500) {
    throw new Error("Claude Console is unavailable. Try again later.");
  }
  if (res.status !== 200) {
    throw new Error(`Claude Console returned HTTP ${res.status}. Try again later or report this.`);
  }
  try {
    return JSON.parse(await res.text());
  } catch {
    return invalid("JSON response");
  }
}

/** The session's API orgs, in listed order (chat orgs share the list but own no Console billing). Throws when none or when the session is rejected. */
export async function listOrgs(
  cookie: string,
  fetchFn: Fetch = fetch,
  label?: string,
): Promise<ConsoleOrg[]> {
  // The list doubles as the session check; a rejected cookie answers 403.
  const list = await request(fetchFn, cookie, "/api/organizations", null, label);
  if (!Array.isArray(list)) {
    return invalid("organizations");
  }
  const orgs = list
    .map((value) => object(value, "organization"))
    .filter((org) => Array.isArray(org.capabilities) && org.capabilities.some((c) => c === "api"))
    .map((org) => {
      const id = text(org.uuid);
      if (!id || !/^[A-Za-z0-9-]{1,64}$/.test(id)) {
        return invalid("organization ID");
      }
      return { id, name: text(org.name) ?? id };
    });
  if (orgs.length === 0) {
    throw new Error(
      "This Claude account has no Claude Console API organization. Create one at platform.claude.com.",
    );
  }
  return orgs;
}

interface Tranche {
  granted: number;
  remaining: number;
  expiresAt: number | undefined;
}

const BILLING_PAGE = "platform.claude.com/settings/billing";

const AUTO_RELOAD = {
  on: ` has auto-reload on; turn it off at ${BILLING_PAGE}, or Anthropic charges your card past the balance`,
  unknown: ` reports an auto-reload setting schmear does not recognize, so it is skipped; check auto-reload is off at ${BILLING_PAGE} and update schmear or report this`,
};

/** Decision 17 of the credits spec: auto-reload charges a card, so any shape but a known "off" fails closed. */
function autoReloadProblem(settings: unknown, org: ConsoleOrg): string | undefined {
  if (settings === undefined || settings === null || settings === false) {
    return undefined;
  }
  const enabled = isRecord(settings) && !Array.isArray(settings) ? settings.enabled : undefined;
  if (enabled === false) {
    return undefined;
  }
  return `Console org ${org.name}${enabled === true ? AUTO_RELOAD.on : AUTO_RELOAD.unknown}`;
}

/** Whether `text` is one of the errors `autoReloadProblem` returns. */
export const isAutoReloadMessage = (text: string): boolean =>
  text.startsWith("Console org ") && Object.values(AUTO_RELOAD).some((suffix) => text.endsWith(suffix));

/** Month-to-date spend in minor units; any failure, including a rejected session, is unknown. */
async function readSpend(fetchFn: Fetch, cookie: string, org: ConsoleOrg): Promise<number | undefined> {
  try {
    const body = await request(fetchFn, cookie, `/api/organizations/${org.id}/current_spend`, null);
    const amount = isRecord(body) ? body.amount : undefined;
    return typeof amount === "number" && Number.isSafeInteger(amount) && amount >= 0 ? amount : undefined;
  } catch {
    return undefined;
  }
}

/** `usd` = the balance; `grantedUsd` = the live grants' total; `floorUsd` = 2% of it; `resetsAt` = the soonest expiry with credit left. Throws `SessionExpired` when the session is rejected. */
export async function readCredits(
  cookie: string,
  org: ConsoleOrg,
  fetchFn: Fetch = fetch,
  now = Date.now(),
  label?: string,
): Promise<VendorBalance> {
  try {
    const body = object(
      await request(
        fetchFn,
        cookie,
        `/api/organizations/${org.id}/prepaid/credits`,
        "Claude Console billing access was denied. Ask the organization owner for billing access.",
        label,
      ),
      "credit balance",
    );
    const currency = text(body.currency) ?? "USD";
    if (!/^[A-Z]{3}$/.test(currency)) {
      return invalid("currency");
    }
    let exponent = 2;
    if (body.balance !== undefined && body.balance !== null) {
      const reported = object(object(body.balance, "balance").credits ?? {}, "balance credits").exponent;
      if (reported !== undefined && reported !== null) {
        if (typeof reported !== "number" || !Number.isInteger(reported) || reported < 0 || reported > 4) {
          return invalid("currency exponent");
        }
        exponent = reported;
      }
    }
    const scale = 10 ** exponent;
    const amount = minorUnits(body.amount, "credit balance");

    const live: Tranche[] = [];
    // Remaining per field, present only when the field is listed.
    const left: Record<string, number> = {};
    for (const field of ["promo_tranches", "tranches"]) {
      const list = body[field];
      if (list === undefined || list === null) {
        continue;
      }
      if (!Array.isArray(list)) {
        return invalid(field);
      }
      left[field] = 0;
      for (const raw of list) {
        const tranche = object(raw, "credit grant");
        const granted = minorUnits(tranche.granted_amount_minor_units, "granted credit");
        const remaining = minorUnits(tranche.remaining_amount_minor_units, "remaining credit");
        const expiresAt = timestamp(tranche.expires_at);
        if (granted > 0 && (expiresAt === undefined || expiresAt > now)) {
          live.push({ granted, remaining: Math.max(0, remaining), expiresAt });
          left[field] += Math.max(0, remaining);
        }
      }
    }

    const autoReload = autoReloadProblem(body.auto_reload_settings, org);
    if (autoReload) {
      return { error: autoReload };
    }
    if (currency !== "USD") {
      return { error: `Console org ${org.name} bills in ${currency}; schmear meters USD` };
    }
    const expiries = live.flatMap((t) => (t.remaining > 0 && t.expiresAt !== undefined ? [t.expiresAt] : []));
    const grantedUsd = live.reduce((sum, t) => sum + t.granted, 0) / scale;
    const resetsAt = expiries.length > 0 ? Math.min(...expiries) : null;
    const next = live.filter((t) => resetsAt !== null && t.expiresAt === resetsAt);
    const spent = await readSpend(fetchFn, cookie, org);
    return {
      usd: amount / scale,
      grantedUsd,
      // With no live grant, the floor is taken on the balance, so a pool never spends to zero.
      floorUsd: FLOOR_FRACTION * (grantedUsd > 0 ? grantedUsd : amount / scale),
      window: { resetsAt },
      ...(resetsAt === null
        ? {}
        : {
            expiring: {
              usd: next.reduce((sum, t) => sum + t.remaining, 0) / scale,
              grantedUsd: next.reduce((sum, t) => sum + t.granted, 0) / scale,
            },
          }),
      warnings: [],
      name: org.name,
      ...(left.promo_tranches === undefined ? {} : { grantUsd: left.promo_tranches / scale }),
      ...(left.tranches === undefined ? {} : { purchasedUsd: left.tranches / scale }),
      ...(spent === undefined ? {} : { spentMonthUsd: spent / scale }),
    };
  } catch (err) {
    if (err instanceof SessionExpired) {
      throw err;
    }
    return { error: `org ${org.name}: ${errorMessage(err)}` };
  }
}

type Problems = { expired: string[]; other: string[] };

const addProblem = (problems: Problems, label: string, err: unknown): void => {
  if (err instanceof SessionExpired) problems.expired.push(label);
  else problems.other.push(sessionProblem(label, err));
};

/**
 * Each pool's balance, `pools` mapping pool id → Console org uuid. A session's org list is fetched once per call;
 * the first session (in `sessions` order) that lists and reads a pool's org wins.
 */
export async function readConsole(
  sessions: Record<string, string>,
  pools: Record<string, string>,
  fetchFn: Fetch = fetch,
  now = Date.now(),
): Promise<Record<string, VendorBalance>> {
  const out: Record<string, VendorBalance> = {};
  const poolProblems: Record<string, Problems> = {};
  const sessionProblems: Problems = { expired: [], other: [] };
  const poolOf = (id: string): Problems => {
    poolProblems[id] ??= { expired: [], other: [] };
    return poolProblems[id];
  };
  for (const [label, cookie] of Object.entries(sessions)) {
    const pending = Object.entries(pools).filter(([id]) => !(id in out));
    if (pending.length === 0) {
      break;
    }
    let orgs: ConsoleOrg[];
    try {
      orgs = await listOrgs(cookie, fetchFn, label);
    } catch (err) {
      addProblem(sessionProblems, label, err);
      continue;
    }
    for (const [id, orgId] of pending) {
      const org = orgs.find((o) => o.id === orgId);
      if (!org) {
        continue;
      }
      let balance: VendorBalance;
      try {
        balance = await readCredits(cookie, org, fetchFn, now, label);
      } catch (err) {
        addProblem(poolOf(id), label, err);
        continue;
      }
      if ("error" in balance) {
        poolOf(id).other.push(`session ${label}: ${balance.error}`);
      } else {
        out[id] = balance;
      }
    }
  }
  for (const [id, orgId] of Object.entries(pools)) {
    const pool = poolProblems[id];
    const expired = [...sessionProblems.expired, ...(pool?.expired ?? [])];
    const other = [...sessionProblems.other, ...(pool?.other ?? [])];
    const errors = expired.length > 0 ? [new SessionExpired("claude", expired).message, ...other] : other;
    out[id] ??= {
      error:
        errors.length > 0
          ? errors.join(" ")
          : `No stored Console session can read org ${orgId}. Log in as the account that owns it: schmear credits login claude --label <new name>`,
    };
  }
  return out;
}
