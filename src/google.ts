import { SessionExpired, type VendorBalance } from "./console.ts";
import { errorMessage } from "./util.ts";

// Reads the Google Developer Program monthly credit of Google AI Pro/Ultra the way CodexBar's `googledeveloper`
// plugin does (§13, §4.2). The benefits endpoints are undocumented; the cookie goes only to
// me.developers.google.com and never into a message.

const ORIGIN = "https://me.developers.google.com";
const TIMEOUT_MS = 60_000;
const FLOOR_FRACTION = 0.02;
const MAX_ACCOUNTS = 8;
// Benefit type 19 is the monthly Gen AI & Cloud credit.
const CREDIT_BENEFIT = 19;

type Fetch = typeof fetch;

export const nonUsd = (currency: string) => `Google credit is in ${currency}; schmear meters USD`;
const NO_SESSION = "no Google session; run: schmear credits login google";
const UNAPPLIED =
  "Google credit is not applied to a billing account; apply it at me.developers.google.com/benefits";

export interface Credit {
  granted: number;
  remaining: number;
  currency: string;
  /** `offer[6][2]` without `billingAccounts/`; absent when Google sent no string there. */
  billing: string | undefined;
  /** Seconds. */
  expiresAt: number | undefined;
  grantedAt: number | undefined;
}

/** One signed-in Google account. `credit` is `"unapplied"` when the credit exists but is not applied to a billing account, `undefined` when the account has none. */
export interface GoogleAccount {
  email: string;
  credit: Credit | "unapplied" | undefined;
}

const invalid = (field: string): never => {
  throw new Error(
    `Could not parse Google Developer Program ${field}. The benefits response format may have changed; update schmear or report this.`,
  );
};
const array = (value: unknown, field: string): unknown[] => (Array.isArray(value) ? value : invalid(field));
const json = (text: string, field: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return invalid(field);
  }
};
// Google Money arrays omit zero units and nanos.
const integer = (value: unknown, field: string): number =>
  value === null || value === undefined
    ? 0
    : typeof value === "number" && Number.isSafeInteger(value)
      ? value
      : invalid(field);
function money(value: unknown, field: string): { currency: string; amount: number } {
  const [currency, units, nanos] = array(value, field);
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) {
    return invalid(`${field} currency`);
  }
  return { currency, amount: integer(units, field) + integer(nanos, field) / 1e9 };
}
// A malformed date means an unknown date, never a failed read.
function seconds(value: unknown): number | undefined {
  const s = Array.isArray(value) ? value[0] : undefined;
  return typeof s === "number" && Number.isSafeInteger(s) && s > 0 ? s : undefined;
}
// WIZ_global_data values are JSON string literals.
function pageValue(html: string, key: string): string | undefined {
  const literal = html.match(new RegExp(`"${key}":("(?:[^"\\\\]|\\\\.)*")`))?.[1];
  return literal === undefined ? undefined : (json(literal, "page token") as string);
}

async function send(fetchFn: Fetch, path: string, init: RequestInit, retry: boolean): Promise<Response> {
  try {
    // Manual: a redirect must not carry the cookie to another host.
    return await fetchFn(`${ORIGIN}${path}`, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if (retry) {
      return send(fetchFn, path, init, false);
    }
    throw new Error(`Google Developer Program request failed: ${errorMessage(err)}`);
  }
}

/** true: signed out (a redirect, 401 or 403). Other failures throw a message free of the cookie and of bodies. */
function denied(res: Response): boolean {
  if ((res.status >= 300 && res.status < 400) || res.status === 401 || res.status === 403) {
    return true;
  }
  if (res.status === 429) {
    throw new Error("Google Developer Program requests are rate limited. Try again in a few minutes.");
  }
  if (res.status >= 500) {
    throw new Error("Google Developer Program is unavailable. Try again later.");
  }
  if (res.status !== 200) {
    throw new Error(`Google Developer Program returned HTTP ${res.status}. Try again later or report this.`);
  }
  return false;
}

function parseCredit(offer: unknown[]): Credit {
  const billing = array(offer[6], "credit balance");
  const granted = money(billing[0], "granted credit");
  const remaining = money(billing[1], "remaining credit");
  if (granted.amount <= 0 || remaining.currency !== granted.currency) {
    return invalid("credit amounts");
  }
  return {
    granted: granted.amount,
    remaining: Math.max(0, remaining.amount),
    currency: granted.currency,
    billing: typeof billing[2] === "string" ? billing[2].replace(/^billingAccounts\//, "") : undefined,
    expiresAt: seconds(offer[1]),
    grantedAt: seconds(offer[16]),
  };
}

/** Each signed-in Google account of the session (`authuser` 0..7). Yields nothing for a signed-out session. */
async function* accounts(cookie: string, fetchFn: Fetch): AsyncGenerator<GoogleAccount> {
  const emails: string[] = [];
  for (let index = 0; index < MAX_ACCOUNTS; index += 1) {
    const page = await send(
      fetchFn,
      `/benefits?authuser=${index}`,
      { headers: { Accept: "text/html", Cookie: cookie } },
      true,
    );
    if (denied(page)) {
      return;
    }
    const html = await page.text();
    // Signed-out pages also omit the page tokens.
    const token = pageValue(html, "SNlM0e");
    const email = pageValue(html, "oPEP7c");
    if (!token || !email || emails.includes(email)) {
      return;
    }

    const res = await send(
      fetchFn,
      `/_/GoogleDeveloperProfile/data/batchexecute?rpcids=Ro0AYc&source-path=%2Fbenefits&hl=en&authuser=${index}&rt=c`,
      {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: ORIGIN,
          Referer: `${ORIGIN}/benefits`,
        },
        body: new URLSearchParams({
          "f.req": JSON.stringify([[["Ro0AYc", "[]", null, "generic"]]]),
          at: token,
        }).toString(),
      },
      false,
    );
    if (denied(res)) {
      return;
    }
    emails.push(email);

    // The chunked envelope alternates length lines with JSON chunks; only the Ro0AYc result matters.
    const result = (await res.text())
      .split("\n")
      .filter((line) => line.startsWith("["))
      .flatMap((line) => array(json(line, "response"), "response"))
      .find((entry) => Array.isArray(entry) && entry[0] === "wrb.fr" && entry[1] === "Ro0AYc") as
      | unknown[]
      | undefined;
    if (!result) {
      return invalid("response");
    }
    // A per-account RPC error has no string payload.
    if (typeof result[2] !== "string") {
      yield { email, credit: undefined };
      continue;
    }
    const list = array(json(result[2], "benefits"), "benefits")[0];
    const benefit = array(list ?? [], "benefits")
      .map((b) => array(b, "benefit"))
      .find((b) => b[0] === CREDIT_BENEFIT);
    if (!benefit) {
      yield { email, credit: undefined };
      continue;
    }
    const offer = array(benefit[9] ?? [], "credit offer");
    // A credit not applied to a billing account yet has no money fields.
    yield { email, credit: offer[6] === null || offer[6] === undefined ? "unapplied" : parseCredit(offer) };
  }
}

/** Every signed-in account of a Cookie header. Throws the session-expired message when none is signed in. */
export async function googleAccounts(
  cookie: string,
  fetchFn: Fetch = fetch,
  label?: string,
): Promise<GoogleAccount[]> {
  const found: GoogleAccount[] = [];
  for await (const account of accounts(cookie, fetchFn)) found.push(account);
  if (found.length === 0) throw new SessionExpired("google", label ? [label] : []);
  return found;
}

function balance(credit: Credit): VendorBalance {
  if (credit.currency !== "USD") {
    return { error: nonUsd(credit.currency) };
  }
  // The grant date tells the next monthly grant apart when its amounts read the same; one field only, so a field
  // missing from one read cannot read as a new grant.
  const tranche = credit.grantedAt;
  return {
    usd: credit.remaining,
    grantedUsd: credit.granted,
    floorUsd: FLOOR_FRACTION * credit.granted,
    window: { resetsAt: credit.expiresAt === undefined ? null : credit.expiresAt * 1000 },
    warnings: [],
    ...(tranche === undefined ? {} : { tranche: String(tranche) }),
  };
}

/**
 * Each pool's balance, `pools` mapping pool id → billing account id. Every signed-in account of every session is
 * read until each pool's billing account is found.
 */
export async function readGoogle(
  sessions: Record<string, string>,
  pools: Record<string, string>,
  fetchFn: Fetch = fetch,
): Promise<Record<string, VendorBalance>> {
  const out: Record<string, VendorBalance> = {};
  const failures: string[] = [];
  const rejected: string[] = [];
  let unapplied = false;
  let applied = false;
  const entries = Object.entries(sessions);
  walk: for (const [label, cookie] of entries) {
    let signedIn = false;
    try {
      for await (const { credit } of accounts(cookie, fetchFn)) {
        signedIn = true;
        if (credit === "unapplied") {
          unapplied = true;
        } else if (credit) {
          applied = true;
          for (const [id, billing] of Object.entries(pools)) {
            if (id in out || credit.billing !== billing) {
              continue;
            }
            out[id] = balance(credit);
          }
        }
        if (Object.keys(pools).every((id) => id in out)) {
          break walk;
        }
      }
    } catch (err) {
      failures.push(`session ${label}: ${errorMessage(err)}`);
      continue;
    }
    if (!signedIn) {
      rejected.push(label);
    }
  }
  for (const [id, billing] of Object.entries(pools)) {
    out[id] ??= {
      error:
        failures.length > 0
          ? failures.join(" ")
          : rejected.length > 0
            ? new SessionExpired("google", rejected).message
            : unapplied && !applied
              ? UNAPPLIED
              : entries.length === 0
                ? NO_SESSION
                : `no Google credit for billing account ${billing} in any Google session`,
    };
  }
  return out;
}
