import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  consoleSessionsPath,
  isAutoReloadMessage,
  isExpiredMessage,
  listOrgs,
  PASTE,
  pasteCommand,
  readConsole,
  readCredits,
  readSessionEntries,
  readSessions,
  removeSession,
  SessionExpired,
  writeSession,
} from "../src/console.ts";

// biome-ignore lint/suspicious/noExplicitAny: fixtures are edited by path; the reader checks their shape
type Json = any;
const fixture = async (name: string): Promise<Json> =>
  JSON.parse(
    await readFile(fileURLToPath(new URL(`./fixtures/console/${name}.json`, import.meta.url)), "utf8"),
  );

const NOW = Date.parse("2026-10-13T00:00:00Z");
const CHAT = "11111111-1111-4111-8111-111111111111";
const API = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const SECRET = "sessionKey=sk-ant-sid01-synthetic-secret";

interface Call {
  path: string;
  cookie: string;
  init: RequestInit;
}

interface Routes {
  /** Per cookie: the body of `/api/organizations`. */
  orgs?: Record<string, Json>;
  /** Per cookie, `/api/organizations` status. */
  orgsStatus?: Record<string, number>;
  /** Body of every credits request. */
  credits?: Json;
  /** Per org id, credits status. */
  creditsStatus?: Record<string, number>;
  /** Per cookie and org id, credits status; wins over `creditsStatus`. */
  creditsStatusBy?: Record<string, number>;
  /** Per org id, credits body; wins over `credits`. */
  creditsBody?: Record<string, Json>;
  rawBody?: string;
  /** Body of every `current_spend` request; absent answers 404. */
  spend?: Json;
  spendStatus?: number;
}

/** A fetch that answers `platform.claude.com` paths from `routes`; any other path fails the test. */
function fakeFetch(routes: Routes, calls: Call[] = []): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    assert.equal(url.host, "platform.claude.com");
    assert.equal(init.method ?? "GET", "GET");
    const headers = init.headers as Record<string, string>;
    const cookie = headers.Cookie;
    calls.push({ path: url.pathname, cookie, init });
    const reply = (status: number, body: unknown): Response =>
      new Response(status === 200 ? (routes.rawBody ?? JSON.stringify(body)) : '{"type":"error"}', {
        status,
      });
    if (url.pathname === "/api/organizations") {
      return reply(routes.orgsStatus?.[cookie] ?? 200, routes.orgs?.[cookie]);
    }
    if (url.pathname.endsWith("/current_spend")) {
      return reply(routes.spendStatus ?? (routes.spend === undefined ? 404 : 200), routes.spend);
    }
    const m = url.pathname.match(/^\/api\/organizations\/([^/]+)\/prepaid\/credits$/);
    assert.ok(m, `unexpected fixture request ${url.pathname}`);
    const org = m[1];
    return reply(
      routes.creditsStatusBy?.[`${cookie}|${org}`] ?? routes.creditsStatus?.[org] ?? 200,
      routes.creditsBody?.[org] ?? routes.credits,
    );
  }) as typeof fetch;
}

const grant = (
  name: string | null,
  program: string,
  remaining: number,
  granted: number,
  expires: string | null,
): Json => ({
  remaining_amount_minor_units: remaining,
  granted_amount_minor_units: granted,
  currency: "USD",
  expires_at: expires,
  program_id: program,
  name,
});

const wallet = (promo: Json[], tranches: Json[], amount = 18725, exponent = 2): Json => ({
  amount,
  currency: "USD",
  balance: { money: null, credits: { amount_minor: amount, exponent } },
  promo_tranches: promo,
  tranches,
});

const usd = (r: Awaited<ReturnType<typeof readCredits>>) => {
  assert.ok(!("error" in r), "error" in r ? r.error : "");
  return r;
};
const failure = (r: Awaited<ReturnType<typeof readCredits>>): string => {
  assert.ok("error" in r, "expected an error");
  return r.error;
};
const approx = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

describe("readConsole", () => {
  it("maps the API org's balance, floor and soonest expiry, never touching the chat org", async () => {
    const calls: Call[] = [];
    const out = await readConsole(
      { main: SECRET },
      { "claude-credits@main": API },
      fakeFetch(
        { orgs: { [SECRET]: await fixture("organizations") }, credits: await fixture("credits") },
        calls,
      ),
      NOW,
    );
    const r = usd(out["claude-credits@main"]);
    assert.equal(r.usd, 187.25);
    approx(r.grantedUsd, 300);
    approx(r.floorUsd, 0.02 * 300);
    assert.equal(r.window.resetsAt, Date.parse("2026-10-28T00:00:00Z"));
    assert.deepEqual(r.warnings, []);
    assert.deepEqual(
      calls.map((c) => c.path),
      [
        "/api/organizations",
        `/api/organizations/${API}/prepaid/credits`,
        `/api/organizations/${API}/current_spend`,
      ],
    );
    assert.ok(!calls.some((c) => c.path.includes(CHAT)));
  });

  it("sends a manual-redirect GET with the Accept and Cookie headers, a timeout signal, nothing else", async () => {
    const calls: Call[] = [];
    await readConsole(
      { main: SECRET },
      { p: API },
      fakeFetch(
        { orgs: { [SECRET]: await fixture("organizations") }, credits: await fixture("credits") },
        calls,
      ),
      NOW,
    );
    for (const { init } of calls) {
      assert.deepEqual(init.headers, { Accept: "application/json", Cookie: SECRET });
      assert.equal(init.redirect, "manual");
      assert.ok(init.signal);
      assert.equal(init.body, undefined);
    }
  });

  it("reads two orgs from two sessions, one fetch of each session's org list", async () => {
    const calls: Call[] = [];
    const out = await readConsole(
      { a: "k=a", b: "k=b" },
      { "claude-credits@main": API, "claude-credits@side": OTHER },
      fakeFetch(
        {
          orgs: { "k=a": await fixture("organizations"), "k=b": await fixture("organizations-two-api") },
          creditsBody: {
            [API]: wallet([], [grant(null, "api_credits", 1000, 2000, null)], 1000),
            [OTHER]: wallet([], [grant(null, "api_credits", 3000, 5000, null)], 3000),
          },
        },
        calls,
      ),
      NOW,
    );
    assert.equal(usd(out["claude-credits@main"]).usd, 10);
    assert.equal(usd(out["claude-credits@side"]).usd, 30);
    assert.equal(calls.filter((c) => c.path === "/api/organizations").length, 2);
  });

  it("an org listed by two sessions is read from the first, and the second is not even listed", async () => {
    const calls: Call[] = [];
    const orgs = await fixture("organizations");
    const out = await readConsole(
      { a: "k=a", b: "k=b" },
      { p: API },
      fakeFetch({ orgs: { "k=a": orgs, "k=b": orgs }, credits: await fixture("credits") }, calls),
      NOW,
    );
    usd(out.p);
    assert.deepEqual(
      calls.map((c) => c.cookie),
      ["k=a", "k=a", "k=a"],
    );
  });

  it("PASTE is the environment's clipboard command", () => {
    assert.equal(PASTE, pasteCommand());
    assert.equal(pasteCommand("darwin", { WAYLAND_DISPLAY: "wayland-0" }), "pbpaste");
    assert.equal(pasteCommand("linux", { WAYLAND_DISPLAY: "wayland-0" }), "wl-paste");
    assert.equal(pasteCommand("linux", {}), "xclip -o -selection clipboard");
  });

  it("isExpiredMessage holds for each SessionExpired form, and only at the start", () => {
    for (const err of [
      new SessionExpired("claude"),
      new SessionExpired("claude", ["main"]),
      new SessionExpired("claude", ["a", "b", "c"]),
      new SessionExpired("google", ["g"]),
    ]) {
      assert.equal(isExpiredMessage(err.message), true, err.message);
      assert.equal(isExpiredMessage(`${err.message} session c: rate limited`), true);
    }
    assert.equal(
      isExpiredMessage("session main: org X: Claude Console is unavailable. Try again later."),
      false,
    );
    assert.equal(isExpiredMessage(`session c: ${new SessionExpired("claude").message}`), false);
  });

  it("SessionExpired names where to sign in and the command; several labels read as a list", () => {
    const login = "schmear credits login claude";
    assert.equal(
      new SessionExpired("claude").message,
      `Console session expired. Sign in at platform.claude.com, then run: ${login}`,
    );
    assert.equal(
      new SessionExpired("claude", ["main", "k1c"]).message,
      `Console sessions main and k1c expired. Sign in at platform.claude.com, then run for each: ${login} --label <label>`,
    );
    assert.equal(
      new SessionExpired("claude", ["a", "b", "c"]).message,
      `Console sessions a, b and c expired. Sign in at platform.claude.com, then run for each: ${login} --label <label>`,
    );
  });

  it("every rejected session is one expiry naming all labels, then the other errors", async () => {
    const orgs = await fixture("organizations");
    const out = await readConsole(
      { a: "k=a", b: "k=b", c: "k=c" },
      { p: API },
      fakeFetch({
        orgs: { "k=a": [], "k=b": [], "k=c": orgs },
        orgsStatus: { "k=a": 401, "k=b": 403 },
        creditsStatusBy: { [`k=c|${API}`]: 429 },
        credits: await fixture("credits"),
      }),
      NOW,
    );
    assert.equal(
      failure(out.p),
      `Console sessions a and b expired. Sign in at platform.claude.com, then run for each: schmear credits login claude --label <label> session c: org Synthetic API Org: Claude Console requests are rate limited. Try again in a few minutes.`,
    );
  });

  it("an org in no session is an error naming it", async () => {
    const out = await readConsole(
      { main: SECRET },
      { p: OTHER },
      fakeFetch({ orgs: { [SECRET]: await fixture("organizations") }, credits: await fixture("credits") }),
      NOW,
    );
    assert.equal(
      failure(out.p),
      `No stored Console session can read org ${OTHER}. Log in as the account that owns it: schmear credits login claude --label <new name>`,
    );
  });

  it("no sessions: every pool is not in any session", async () => {
    const out = await readConsole({}, { p: API }, fakeFetch({}), NOW);
    assert.match(failure(out.p), /^No stored Console session can read org /);
  });

  it("a session with no API org reports that, naming the session", async () => {
    const calls: Call[] = [];
    const out = await readConsole(
      { main: SECRET },
      { p: API },
      fakeFetch({ orgs: { [SECRET]: await fixture("organizations-chat-only") } }, calls),
      NOW,
    );
    assert.match(failure(out.p), /^session main: This Claude account has no Claude Console API organization/);
    assert.deepEqual(
      calls.map((c) => c.path),
      ["/api/organizations"],
    );
  });

  for (const status of [401, 403]) {
    it(`a ${status} on the org list expires the session and the next session serves the pool`, async () => {
      const calls: Call[] = [];
      const out = await readConsole(
        { old: "k=old", fresh: "k=fresh" },
        { p: API },
        fakeFetch(
          {
            orgs: { "k=old": [], "k=fresh": await fixture("organizations") },
            orgsStatus: { "k=old": status },
            credits: await fixture("credits"),
          },
          calls,
        ),
        NOW,
      );
      assert.equal(usd(out.p).usd, 187.25);
      assert.ok(!calls.some((c) => c.cookie === "k=old" && c.path.endsWith("/credits")));
    });

    it(`a ${status} on the org list with no other session names the session and says to log in again`, async () => {
      const out = await readConsole(
        { old: "k=old" },
        { p: API },
        fakeFetch({ orgs: { "k=old": [] }, orgsStatus: { "k=old": status } }),
        NOW,
      );
      assert.equal(
        failure(out.p),
        "Console session old expired. Sign in at platform.claude.com, then run: schmear credits login claude --label old",
      );
    });
  }

  it("a 401 on the credits request with no other session names the session and says to log in again", async () => {
    const out = await readConsole(
      { old: "k=old" },
      { p: API },
      fakeFetch({
        orgs: { "k=old": await fixture("organizations") },
        creditsStatusBy: { [`k=old|${API}`]: 401 },
        credits: await fixture("credits"),
      }),
      NOW,
    );
    assert.equal(
      failure(out.p),
      "Console session old expired. Sign in at platform.claude.com, then run: schmear credits login claude --label old",
    );
  });

  it("a 401 on the credits request advances to the next session", async () => {
    const orgs = await fixture("organizations");
    const out = await readConsole(
      { old: "k=old", fresh: "k=fresh" },
      { p: API },
      fakeFetch({
        orgs: { "k=old": orgs, "k=fresh": orgs },
        creditsStatusBy: { [`k=old|${API}`]: 401 },
        credits: await fixture("credits"),
      }),
      NOW,
    );
    assert.equal(usd(out.p).usd, 187.25);
  });

  it("one org's billing denial does not block another pool", async () => {
    const out = await readConsole(
      { main: SECRET },
      { member: API, owner: OTHER },
      fakeFetch({
        orgs: { [SECRET]: await fixture("organizations-two-api") },
        creditsStatus: { [API]: 403 },
        credits: await fixture("credits"),
      }),
      NOW,
    );
    assert.equal(
      failure(out.member),
      "session main: org Synthetic Member Org: Claude Console billing access was denied. Ask the organization owner for billing access.",
    );
    assert.equal(usd(out.owner).usd, 187.25);
  });

  it("a credits error in one session falls through to a later session that reads the org", async () => {
    const orgs = await fixture("organizations");
    const out = await readConsole(
      { a: "k=a", b: "k=b" },
      { p: API },
      fakeFetch({
        orgs: { "k=a": orgs, "k=b": orgs },
        creditsStatusBy: { [`k=a|${API}`]: 403 },
        credits: await fixture("credits"),
      }),
      NOW,
    );
    assert.equal(usd(out.p).usd, 187.25);
  });
});

describe("readCredits", () => {
  const org = { id: API, name: "Synthetic API Org" };
  const read = async (body: Json, status = 200) => {
    const bodies = fakeFetch({ credits: body, creditsStatus: { [API]: status } });
    return readCredits(SECRET, org, bodies, NOW);
  };

  const spending = async (routes: Routes) =>
    readCredits(SECRET, org, fakeFetch({ credits: await fixture("credits"), ...routes }), NOW);

  it("names the org, splits grant from purchased credit and reads month-to-date spend", async () => {
    const r = usd(await spending({ spend: await fixture("current-spend") }));
    assert.equal(r.name, "Synthetic API Org");
    approx(r.grantUsd ?? Number.NaN, 124.75);
    approx(r.purchasedUsd ?? Number.NaN, 62.5);
    approx(r.spentMonthUsd ?? Number.NaN, 43.21);
  });

  for (const [name, routes] of [
    ["a 500", { spend: { amount: 1 }, spendStatus: 500 }],
    ["a 401", { spend: { amount: 1 }, spendStatus: 401 }],
    ["a negative amount", { spend: { amount: -1 } }],
    ["a missing amount", { spend: {} }],
  ] as const) {
    it(`spend: ${name} leaves the balance and omits the spend`, async () => {
      const r = usd(await spending(routes));
      assert.equal(r.usd, 187.25);
      assert.equal("spentMonthUsd" in r, false);
    });
  }

  it("a field the response omits leaves its part of the split out", async () => {
    const r = usd(await read({ amount: 500, currency: "USD", tranches: [] }));
    assert.equal(r.purchasedUsd, 0);
    assert.equal("grantUsd" in r, false);
  });

  const reloading = async (settings: unknown) => {
    const { auto_reload_settings: _, ...body } = await fixture("credits");
    return read(settings === undefined ? body : { ...body, auto_reload_settings: settings });
  };
  const ON =
    "Console org Synthetic API Org has auto-reload on; turn it off at platform.claude.com/settings/billing, or Anthropic charges your card past the balance";
  const UNRECOGNIZED =
    "Console org Synthetic API Org reports an auto-reload setting schmear does not recognize, so it is skipped; check auto-reload is off at platform.claude.com/settings/billing and update schmear or report this";
  for (const [name, settings] of [
    ["null", null],
    ["{ enabled: false }", { enabled: false }],
    ["missing", undefined],
    ["false", false],
  ] as const) {
    it(`auto-reload ${name} reads the balance`, async () => {
      assert.equal(usd(await reloading(settings)).usd, 187.25);
    });
  }
  for (const [name, settings, message] of [
    ["{ enabled: true }", { enabled: true, threshold: 1000 }, ON],
    ["{}", {}, UNRECOGNIZED],
    ['{ enabled: "no" }', { enabled: "no" }, UNRECOGNIZED],
    ["true", true, UNRECOGNIZED],
    ["a string", "off", UNRECOGNIZED],
    ["a number", 0, UNRECOGNIZED],
    ["an array", [], UNRECOGNIZED],
  ] as const) {
    it(`auto-reload ${name} is skipped with its message`, async () => {
      assert.equal(failure(await reloading(settings)), message);
      assert.ok(isAutoReloadMessage(message));
    });
  }
  it("isAutoReloadMessage rejects other errors", () => {
    assert.equal(
      isAutoReloadMessage("Console org Synthetic API Org bills in EUR; schmear meters USD"),
      false,
    );
  });

  it("takes the soonest grant with credit left and ignores exhausted and undated ones for the expiry", async () => {
    const r = usd(
      await read(
        wallet(
          [
            grant("API credit (Max 20x)", "subscription_api_credit", 15000, 20000, "2026-11-12T00:00:00Z"),
            grant("API credit (Pro)", "subscription_api_credit", 0, 5000, "2026-10-20T00:00:00Z"),
            // An unparseable expiry is unknown, not a failed read.
            grant("Launch credit", "promo", 1000, 1000, "2026-10-31Tnot-a-date"),
          ],
          [grant(null, "api_credits", 2500, 5000, null)],
          18500,
        ),
      ),
    );
    assert.equal(r.usd, 185);
    approx(r.grantedUsd, 200 + 50 + 10 + 50);
    approx(r.floorUsd, 0.02 * (200 + 50 + 10 + 50));
    assert.equal(r.window.resetsAt, Date.parse("2026-11-12T00:00:00Z"));
    assert.deepEqual(r.expiring, { usd: 150, grantedUsd: 200 });
  });

  it("expiring sums every live tranche that expires at the soonest expiry, promotional or purchased", async () => {
    const r = usd(
      await read(
        wallet(
          [
            grant("Launch credit", "promo", 500, 500, "2026-10-15T00:00:00Z"),
            grant("API credit (Max 20x)", "subscription_api_credit", 1000, 2000, "2026-11-12T00:00:00Z"),
          ],
          [
            grant(null, "api_credits", 200, 300, "2026-10-15T00:00:00Z"),
            grant(null, "api_credits", 50000, 50000, null),
          ],
          51700,
        ),
      ),
    );
    assert.equal(r.window.resetsAt, Date.parse("2026-10-15T00:00:00Z"));
    assert.deepEqual(r.expiring, { usd: 7, grantedUsd: 8 });
  });

  it("drops expired grants (expiring exactly now counts as expired) from the floor and the expiry", async () => {
    const r = usd(
      await read(
        wallet(
          [
            grant("API credit (Max 5x)", "subscription_api_credit", 5000, 10000, "2026-10-13T00:00:00Z"),
            grant("API credit (Pro)", "subscription_api_credit", 0, 5000, "2026-10-20T00:00:00Z"),
          ],
          [
            grant(null, "api_credits", 4000, 4000, "2026-10-12T00:00:00Z"),
            grant(null, "api_credits", 2500, 5000, null),
          ],
          2500,
        ),
      ),
    );
    assert.equal(r.usd, 25);
    approx(r.grantedUsd, 100);
    approx(r.floorUsd, 0.02 * 100);
    assert.equal(r.window.resetsAt, null);
    assert.equal(r.expiring, undefined);
  });

  it("skips grants with no granted amount and clamps negative remaining to zero", async () => {
    const r = usd(
      await read(
        wallet(
          [grant(null, "promo", 100, 0, null), grant(null, "promo", -500, 1000, "2026-10-20T00:00:00Z")],
          [],
          0,
        ),
      ),
    );
    assert.equal(r.usd, 0);
    approx(r.grantedUsd, 10);
    approx(r.floorUsd, 0.02 * 10);
    assert.equal(r.window.resetsAt, null);
  });

  it("sums many grants", async () => {
    const promo = Array.from({ length: 200 }, (_, i) => grant(`Promo ${i}`, "promo", 100, 200, null));
    const r = usd(await read(wallet(promo, [], 20000)));
    assert.equal(r.usd, 200);
    approx(r.grantedUsd, 400);
    approx(r.floorUsd, 0.02 * 400);
  });

  it("no tranches: the floor is 2% of the balance", async () => {
    const r = usd(await read({ amount: 500, currency: "USD" }));
    assert.equal(r.usd, 5);
    assert.equal(r.grantedUsd, 0);
    approx(r.floorUsd, 0.02 * 5);
    assert.equal(r.window.resetsAt, null);
  });

  it("uses the reported credit exponent", async () => {
    const r = usd(
      await read(
        wallet(
          [grant(null, "subscription_api_credit", 124750, 200000, "2026-10-28T00:00:00Z")],
          [],
          187250,
          3,
        ),
      ),
    );
    assert.equal(r.usd, 187.25);
    approx(r.grantedUsd, 200);
    approx(r.floorUsd, 0.02 * 200);
  });

  it("a currency other than USD is an error", async () => {
    assert.equal(
      failure(await read({ ...wallet([], []), currency: "EUR" })),
      "Console org Synthetic API Org bills in EUR; schmear meters USD",
    );
  });

  for (const [status, message] of [
    [403, /billing access was denied/],
    [429, /rate limited/],
    [500, /unavailable/],
    [503, /unavailable/],
    [404, /returned HTTP 404/],
  ] as const) {
    it(`status ${status} is an error that names the org`, async () => {
      assert.match(failure(await read(wallet([], []), status)), message);
      assert.match(failure(await read(wallet([], []), status)), /^org Synthetic API Org: /);
    });
  }

  const malformed: [string, Json][] = [
    ["null amount", { amount: null, currency: "USD" }],
    ["string amount", { amount: "18725", currency: "USD" }],
    ["fractional amount", { amount: 187.25, currency: "USD" }],
    ["unsafe amount", { amount: 1e99, currency: "USD" }],
    ["object tranches", { amount: 18725, currency: "USD", tranches: {} }],
    ["object promo tranches", { amount: 18725, currency: "USD", promo_tranches: {} }],
    ["bad currency", { amount: 1, currency: "usd" }],
    ["bad exponent", { amount: 1, currency: "USD", balance: { credits: { exponent: 5 } } }],
    ["fractional exponent", { amount: 1, currency: "USD", balance: { credits: { exponent: 1.5 } } }],
    ["bad balance", { amount: 1, currency: "USD", balance: [] }],
    ["array body", []],
    [
      "bad granted",
      {
        amount: 1,
        currency: "USD",
        tranches: [{ ...grant(null, "x", 1, 2, null), granted_amount_minor_units: "2" }],
      },
    ],
    [
      "bad remaining",
      {
        amount: 1,
        currency: "USD",
        tranches: [{ ...grant(null, "x", 1, 2, null), remaining_amount_minor_units: 0.5 }],
      },
    ],
    ["non-object tranche", { amount: 1, currency: "USD", tranches: [1] }],
  ];
  for (const [name, body] of malformed) {
    it(`fails closed on ${name}`, async () => {
      assert.match(failure(await read(body)), /format may have changed/);
    });
  }

  it("fails closed on a body that is not JSON", async () => {
    const r = await readCredits(SECRET, org, fakeFetch({ rawBody: "<html>login</html>" }), NOW);
    assert.match(failure(r), /Could not parse Claude Console JSON response/);
  });

  it("a thrown fetch is an error that never carries the cookie", async () => {
    const boom = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    const r = failure(await readCredits(SECRET, org, boom, NOW));
    assert.match(r, /Claude Console request failed: connect ECONNREFUSED/);
    assert.ok(!r.includes("sk-ant"));
  });

  it("a redirect (manual mode answers 3xx) is an HTTP error, not followed", async () => {
    const redirect = (async () =>
      new Response(null, { status: 302, headers: { Location: "https://evil.example" } })) as typeof fetch;
    assert.match(failure(await readCredits(SECRET, org, redirect, NOW)), /returned HTTP 302/);
  });
});

describe("listOrgs", () => {
  it("lists API orgs in order and skips chat orgs", async () => {
    const orgs = await listOrgs(
      SECRET,
      fakeFetch({ orgs: { [SECRET]: await fixture("organizations-two-api") } }),
    );
    assert.deepEqual(orgs, [
      { id: API, name: "Synthetic Member Org" },
      { id: OTHER, name: "Synthetic Owner Org" },
    ]);
  });

  it("falls back to the id for a nameless org", async () => {
    const orgs = await listOrgs(
      SECRET,
      fakeFetch({ orgs: { [SECRET]: [{ uuid: API, capabilities: ["api"] }] } }),
    );
    assert.deepEqual(orgs, [{ id: API, name: API }]);
  });

  it("rejects an org id that is not a safe path segment", async () => {
    await assert.rejects(
      listOrgs(SECRET, fakeFetch({ orgs: { [SECRET]: [{ uuid: "../x", capabilities: ["api"] }] } })),
      /organization ID/,
    );
  });

  it("rejects a list that is not an array", async () => {
    await assert.rejects(listOrgs(SECRET, fakeFetch({ orgs: { [SECRET]: {} } })), /organizations/);
  });

  it("a rejected session throws the expiry message without the cookie", async () => {
    await assert.rejects(
      listOrgs(SECRET, fakeFetch({ orgs: { [SECRET]: [] }, orgsStatus: { [SECRET]: 403 } })),
      (err: Error) => /session expired/.test(err.message) && !err.message.includes("sk-ant"),
    );
  });
});

describe("console sessions file", () => {
  let dir: string;
  const saved = process.env.XDG_CONFIG_HOME;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "schmear-console-"));
    process.env.XDG_CONFIG_HOME = dir;
  });
  afterEach(() => {
    if (saved === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = saved;
    }
  });

  it("lives beside config.json", () => {
    assert.equal(consoleSessionsPath(), join(dir, "schmear", "console-sessions.json"));
  });

  it("keeps google sessions apart in google-sessions.json at 0600", async () => {
    await writeSession("g", "SID=a", "google");
    const path = consoleSessionsPath(process.env, "google");
    assert.equal(path, join(dir, "schmear", "google-sessions.json"));
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(await readSessions("google"), { g: "SID=a" });
    assert.deepEqual(await readSessions(), {});
    assert.equal(await removeSession("g", "google"), true);
    assert.deepEqual(await readSessions("google"), {});
  });

  it("a missing file reads as no sessions", async () => {
    assert.deepEqual(await readSessions(), {});
  });

  it("writes a 0600 file in a 0700 directory and keeps earlier labels in order", async () => {
    await writeSession("main", "sessionKey=a");
    await writeSession("side", "sessionKey=b");
    assert.deepEqual(Object.entries(await readSessions()), [
      ["main", "sessionKey=a"],
      ["side", "sessionKey=b"],
    ]);
    const path = consoleSessionsPath();
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(dirname(path))).mode & 0o777, 0o700);
  });

  it("round-trips an entry with and without its source", async () => {
    const source = { browser: "Chrome", profile: "Profile 1" };
    await writeSession("pasted", "sessionKey=a");
    await writeSession("imported", "sessionKey=b", "claude", source);
    assert.deepEqual(await readSessionEntries(), {
      pasted: { cookie: "sessionKey=a" },
      imported: { cookie: "sessionKey=b", source },
    });
    assert.deepEqual(await readSessions(), { pasted: "sessionKey=a", imported: "sessionKey=b" });
    await writeSession("imported", "sessionKey=c");
    assert.deepEqual((await readSessionEntries()).imported, { cookie: "sessionKey=c" });
  });

  it("rewriting a label replaces its cookie", async () => {
    await writeSession("main", "sessionKey=a");
    await writeSession("main", "sessionKey=c");
    assert.deepEqual(await readSessions(), { main: "sessionKey=c" });
  });

  it("removes a label and reports whether it existed", async () => {
    await writeSession("main", "sessionKey=a");
    await writeSession("side", "sessionKey=b");
    assert.equal(await removeSession("main"), true);
    assert.equal(await removeSession("main"), false);
    assert.deepEqual(await readSessions(), { side: "sessionKey=b" });
    assert.equal((await stat(consoleSessionsPath())).mode & 0o777, 0o600);
  });

  for (const cookie of ["sessionKey=secret\nX: y", "sessionKey=secret\0", "sessionKey=secrét", ""]) {
    it(`refuses to write the cookie ${JSON.stringify(cookie)} without quoting it`, async () => {
      await assert.rejects(
        writeSession("main", cookie),
        (err: Error) => err.message.includes("session main") && !err.message.includes("secret"),
      );
      assert.deepEqual(await readSessions(), {});
    });
  }

  for (const [name, content] of [
    ["invalid JSON", "sessionKey=secret"],
    ["an array", "[]"],
    ["a bare string value", '{"main": "sessionKey=secret"}'],
    ["a non-string cookie", '{"main": {"cookie": 1}}'],
    ["a source of the wrong shape", '{"main": {"cookie": "k", "source": {"browser": "Chrome"}}}'],
    ["a cookie with a line break", '{"main": {"cookie": "sessionKey=secret\\r\\nX: y"}}'],
    ["a cookie with a NUL", '{"main": {"cookie": "sessionKey=secret\\u0000"}}'],
    ["a non-ASCII cookie", '{"main": {"cookie": "sessionKey=secret\u00e9"}}'],
  ]) {
    it(`${name} is a malformed-file error that does not quote the content`, async () => {
      await writeSession("x", "y");
      await writeFile(consoleSessionsPath(), content);
      await assert.rejects(
        readSessions(),
        (err: Error) =>
          /malformed .*console-sessions\.json/.test(err.message) && !err.message.includes("secret"),
      );
    });
  }
});
