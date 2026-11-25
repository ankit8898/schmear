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
      warnings: string[];
      /** Identifies the grant, so equal amounts from the next grant still read as a new balance. */
      tranche?: string;
    }
  | { error: string };

export interface ConsoleOrg {
  id: string;
  name: string;
}

type Fetch = typeof fetch;

export type SessionVendor = "claude" | "google";

/** The command that prints the clipboard, for the login commands schmear tells the user to run. */
export const PASTE = process.platform === "darwin" ? "pbpaste" : "wl-paste";

/** A rejected session; its message names the label and the command, so callers show it unprefixed (`sessionProblem`). */
export class SessionExpired extends Error {
  constructor(vendor: SessionVendor = "claude", label?: string) {
    const flag = label ? ` --label ${label}` : "";
    super(
      vendor === "claude"
        ? `Console session${label ? ` ${label}` : ""} expired. Run: ${PASTE} | schmear credits login claude --stdin${flag}`
        : `Google session expired. Run: ${PASTE} | schmear credits login google --stdin${flag}`,
    );
  }
}

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

/** label → Cookie header. Missing file: none. */
export async function readSessions(vendor: SessionVendor = "claude"): Promise<Record<string, string>> {
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
  if (
    !isRecord(parsed) ||
    Array.isArray(parsed) ||
    !Object.values(parsed).every((v) => typeof v === "string")
  ) {
    throw new Error(`malformed ${path}: expected an object of label to Cookie header`);
  }
  return parsed as Record<string, string>;
}

export async function writeSession(
  label: string,
  cookie: string,
  vendor: SessionVendor = "claude",
): Promise<void> {
  const sessions = { ...(await readSessions(vendor)), [label]: cookie };
  await writeAtomic(consoleSessionsPath(process.env, vendor), `${JSON.stringify(sessions, null, 2)}\n`);
}

/** false: no such label. */
export async function removeSession(label: string, vendor: SessionVendor = "claude"): Promise<boolean> {
  const { [label]: gone, ...rest } = await readSessions(vendor);
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
    throw new SessionExpired("claude", label);
  }
  if (res.status === 403) {
    throw forbidden === null ? new SessionExpired("claude", label) : new Error(forbidden);
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
    for (const field of ["promo_tranches", "tranches"]) {
      const list = body[field];
      if (list === undefined || list === null) {
        continue;
      }
      if (!Array.isArray(list)) {
        return invalid(field);
      }
      for (const raw of list) {
        const tranche = object(raw, "credit grant");
        const granted = minorUnits(tranche.granted_amount_minor_units, "granted credit");
        const remaining = minorUnits(tranche.remaining_amount_minor_units, "remaining credit");
        const expiresAt = timestamp(tranche.expires_at);
        if (granted > 0 && (expiresAt === undefined || expiresAt > now)) {
          live.push({ granted, remaining: Math.max(0, remaining), expiresAt });
        }
      }
    }

    if (currency !== "USD") {
      return { error: `Console org ${org.name} bills in ${currency}; schmear meters USD` };
    }
    const expiries = live.flatMap((t) => (t.remaining > 0 && t.expiresAt !== undefined ? [t.expiresAt] : []));
    const grantedUsd = live.reduce((sum, t) => sum + t.granted, 0) / scale;
    return {
      usd: amount / scale,
      grantedUsd,
      // With no live grant, the floor is taken on the balance, so a pool never spends to zero.
      floorUsd: FLOOR_FRACTION * (grantedUsd > 0 ? grantedUsd : amount / scale),
      window: { resetsAt: expiries.length > 0 ? Math.min(...expiries) : null },
      warnings: [],
    };
  } catch (err) {
    if (err instanceof SessionExpired) {
      throw err;
    }
    return { error: `org ${org.name}: ${errorMessage(err)}` };
  }
}

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
  const poolErrors: Record<string, string[]> = {};
  const sessionErrors: string[] = [];
  for (const [label, cookie] of Object.entries(sessions)) {
    const pending = Object.entries(pools).filter(([id]) => !(id in out));
    if (pending.length === 0) {
      break;
    }
    let orgs: ConsoleOrg[];
    try {
      orgs = await listOrgs(cookie, fetchFn, label);
    } catch (err) {
      sessionErrors.push(sessionProblem(label, err));
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
        poolErrors[id] = [...(poolErrors[id] ?? []), sessionProblem(label, err)];
        continue;
      }
      if ("error" in balance) {
        poolErrors[id] = [...(poolErrors[id] ?? []), `session ${label}: ${balance.error}`];
      } else {
        out[id] = balance;
      }
    }
  }
  for (const [id, orgId] of Object.entries(pools)) {
    const errors = poolErrors[id] ?? sessionErrors;
    out[id] ??= {
      error:
        errors.length > 0
          ? errors.join(" ")
          : `No stored Console session can read org ${orgId}. Log in as the account that owns it: ${PASTE} | schmear credits login claude --stdin --label <new name>`,
    };
  }
  return out;
}
