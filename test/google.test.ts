import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { VendorBalance } from "../src/console.ts";
import { readGoogle } from "../src/google.ts";

const PREFIX = "SID=synthetic-secret-";
const cookie = (label: string): string => `${PREFIX}${label}`;
const sessionsOf = (...labels: string[]): Record<string, string> =>
  Object.fromEntries(labels.map((label) => [label, cookie(label)]));

const BILLING_A = "000000-AAAAAA-BBBBBB";
const BILLING_B = "000000-CCCCCC-DDDDDD";
const TOKEN = "fixture-at-token:+/=";

// biome-ignore lint/suspicious/noExplicitAny: fixtures are built from arrays of any shape
type Json = any;

const amounts = (billingId: string | null, granted: Json, remaining: Json): Json[] => [
  granted,
  remaining,
  billingId === null ? null : `billingAccounts/${billingId}`,
];
const USD_100_87_5 = (id: string | null = BILLING_A): Json[] =>
  amounts(id, ["USD", 100], ["USD", 87, 500000000]);

/** `offer[1]` and `offer[16]` are `[seconds, nanos]`; `null` is a missing date. */
function credit(billing: Json, expiry: Json = [1825588800, 0], grantedAt: Json = [1794052800, 0]): Json {
  const offer: Json[] = new Array(17).fill(null);
  offer[1] = expiry;
  offer[6] = billing;
  offer[16] = grantedAt;
  return [19, 2, null, null, null, null, null, null, [1], offer];
}
const OTHER_BENEFIT = [3, 1, null, null, null, null, null, null, [2]];
const UNAPPLIED_CREDIT = [19, 2, null, null, null, null, null, null, [1], [null, null, 0, 2]];
const benefits = (...entries: Json[]): string => JSON.stringify([entries]);

interface Account {
  /** Default `user<index>@example.com`; `null` omits it from the page. */
  email?: string | null;
  token?: string | null;
  pageStatus?: number;
  benefits?: string;
  postStatus?: number;
  envelope?: string;
}

const noCredit: Account = { benefits: benefits(OTHER_BENEFIT) };
const applied = (billing: Json = USD_100_87_5(), expiry?: Json, grantedAt?: Json): Account => ({
  benefits: benefits(OTHER_BENEFIT, credit(billing, expiry, grantedAt)),
});
const unapplied: Account = { benefits: benefits(UNAPPLIED_CREDIT) };
const withBilling = (billing: Json): Account => ({ benefits: benefits(credit(billing)) });

function envelope(payload: string): string {
  const chunks = [
    '[["di",42],["af.httprm",41,"-1234567890",7]]',
    `[["wrb.fr","Ro0AYc",${JSON.stringify(payload)},null,null,null,"generic"]]`,
    '[["e",4,null,null,1234]]',
  ];
  return `)]}'\n\n${chunks.map((c) => `${c.length}\n${c}`).join("\n")}\n`;
}

interface Call {
  method: string;
  label: string;
  authuser: number;
  init: RequestInit;
}

/** A fetch that serves `me.developers.google.com` from `byLabel` (label → its signed-in accounts); past the last account it redirects like a signed-out page. */
function fakeGoogle(byLabel: Record<string, Account[]>, calls: Call[] = []): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    assert.equal(url.host, "me.developers.google.com");
    const headers = init.headers as Record<string, string>;
    assert.ok(headers.Cookie.startsWith(PREFIX));
    const label = headers.Cookie.slice(PREFIX.length);
    const method = init.method ?? "GET";
    const authuser = Number(url.searchParams.get("authuser"));
    calls.push({ method, label, authuser, init });
    const accounts = byLabel[label] ?? [];
    const account = accounts[authuser];
    if (!account) {
      return new Response("", { status: 302, headers: { Location: "https://accounts.google.com/" } });
    }
    if (method === "GET") {
      assert.equal(url.pathname, "/benefits");
      const email = account.email === undefined ? `user${authuser}@example.com` : account.email;
      const values = ['"cfb2h":"boq_gdp-builders-ui_fixture"'];
      const token = account.token === undefined ? TOKEN : account.token;
      if (token !== null) {
        values.push(`"SNlM0e":"${token}"`);
      }
      if (email !== null) {
        values.push(`"oPEP7c":"${email}"`);
      }
      const html = `<html><script>window.WIZ_global_data = {${values.join(",")}};</script></html>`;
      return new Response(account.pageStatus && account.pageStatus !== 200 ? "" : html, {
        status: account.pageStatus ?? 200,
      });
    }
    assert.equal(method, "POST");
    assert.equal(url.pathname, "/_/GoogleDeveloperProfile/data/batchexecute");
    const body = account.envelope ?? envelope(account.benefits ?? benefits());
    return new Response(account.postStatus && account.postStatus !== 200 ? '{"error":"body"}' : body, {
      status: account.postStatus ?? 200,
    });
  }) as typeof fetch;
}

const requests = (calls: Call[]): string[] => calls.map((c) => `${c.method} ${c.label}/${c.authuser}`);

function errorOf(result: Record<string, VendorBalance>, id: string): string {
  const balance = result[id];
  assert.ok(balance && "error" in balance, `expected an error for ${id}`);
  assert.ok(!balance.error.includes("synthetic-secret"), "the cookie must not appear in an error");
  assert.ok(!balance.error.includes('"error":"body"'), "a response body must not appear in an error");
  return balance.error;
}

describe("readGoogle", () => {
  it("maps an applied credit: remaining, grant, floor, expiry, grant date, and sends the benefits requests", async () => {
    const calls: Call[] = [];
    const result = await readGoogle(
      sessionsOf("a"),
      { "gemini-credits@k": BILLING_A },
      fakeGoogle({ a: [applied()] }, calls),
    );
    assert.deepEqual(result, {
      "gemini-credits@k": {
        usd: 87.5,
        grantedUsd: 100,
        floorUsd: 2,
        window: { resetsAt: 1825588800 * 1000 },
        warnings: [],
        tranche: "1794052800",
      },
    });
    assert.deepEqual(requests(calls), ["GET a/0", "POST a/0"]);
    const [get, post] = calls;
    assert.ok(get && post);
    assert.equal(get.init.redirect, "manual");
    assert.ok(get.init.signal instanceof AbortSignal);
    assert.equal((get.init.headers as Record<string, string>).Accept, "text/html");
    const headers = post.init.headers as Record<string, string>;
    assert.equal(post.init.redirect, "manual");
    assert.ok(post.init.signal instanceof AbortSignal);
    assert.equal(headers.Origin, "https://me.developers.google.com");
    assert.equal(headers.Referer, "https://me.developers.google.com/benefits");
    assert.equal(headers["Content-Type"], "application/x-www-form-urlencoded");
    const form = new URLSearchParams(String(post.init.body));
    assert.equal(form.get("f.req"), '[[["Ro0AYc","[]",null,"generic"]]]');
    assert.equal(form.get("at"), TOKEN);
  });

  it("tranche is the grant date, else absent, never the expiry", async () => {
    const pools = { p: BILLING_A };
    const read = (a: Account) => readGoogle(sessionsOf("a"), pools, fakeGoogle({ a: [a] }));
    const noGrantDate = await read(applied(USD_100_87_5(), [1825588800, 0], null));
    assert.ok(!("tranche" in (noGrantDate.p as object)));
    const neither = await read(applied(USD_100_87_5(), null, null));
    assert.ok(!("tranche" in (neither.p as object)));
    assert.equal((neither.p as { window: { resetsAt: number | null } }).window.resetsAt, null);
  });

  it("a malformed date is unknown, not an error", async () => {
    const result = await readGoogle(
      sessionsOf("a"),
      { p: BILLING_A },
      fakeGoogle({ a: [applied(USD_100_87_5(), ["soon", 0], [-5, 0])] }),
    );
    assert.deepEqual(result.p, {
      usd: 87.5,
      grantedUsd: 100,
      floorUsd: 2,
      window: { resetsAt: null },
      warnings: [],
    });
  });

  it("an exhausted grant without nanos or an expiry reads 0 left", async () => {
    const result = await readGoogle(
      sessionsOf("a"),
      { p: BILLING_A },
      fakeGoogle({ a: [applied(amounts(BILLING_A, ["USD", 10, 0], ["USD"]), null, null)] }),
    );
    assert.deepEqual(result.p, {
      usd: 0,
      grantedUsd: 10,
      floorUsd: 0.2,
      window: { resetsAt: null },
      warnings: [],
    });
  });

  it("clamps a negative remaining balance at 0", async () => {
    const result = await readGoogle(
      sessionsOf("a"),
      { p: BILLING_A },
      fakeGoogle({ a: [applied(amounts(BILLING_A, ["USD", 10], ["USD", -3, -250000000]))] }),
    );
    assert.equal((result.p as { usd: number }).usd, 0);
  });

  it("skips accounts without the credit, with an RPC error entry or unapplied, and reads the next", async () => {
    const calls: Call[] = [];
    const rpcError: Account = { envelope: `)]}'\n\n40\n[["wrb.fr","Ro0AYc",null,null,null,[3],"generic"]]` };
    const result = await readGoogle(
      sessionsOf("a"),
      { p: BILLING_A },
      fakeGoogle({ a: [rpcError, noCredit, unapplied, applied(), applied()] }, calls),
    );
    assert.equal((result.p as { usd: number }).usd, 87.5);
    assert.deepEqual(
      requests(calls),
      ["0", "1", "2", "3"].flatMap((i) => [`GET a/${i}`, `POST a/${i}`]),
    );
  });

  it("reads two billing accounts across two sessions and stops once both are found", async () => {
    const calls: Call[] = [];
    const result = await readGoogle(
      sessionsOf("a", "b", "c"),
      { p1: BILLING_A, p2: BILLING_B },
      fakeGoogle(
        {
          a: [noCredit, applied(USD_100_87_5(BILLING_A))],
          b: [applied(amounts(BILLING_B, ["USD", 40], ["USD", 12]))],
          c: [applied()],
        },
        calls,
      ),
    );
    assert.equal((result.p1 as { usd: number }).usd, 87.5);
    assert.deepEqual(result.p2, {
      usd: 12,
      grantedUsd: 40,
      floorUsd: 0.8,
      window: { resetsAt: 1825588800 * 1000 },
      warnings: [],
      tranche: "1794052800",
    });
    assert.ok(!calls.some((c) => c.label === "c"));
  });

  it("keeps reading accounts after one credit matches another pool", async () => {
    const result = await readGoogle(
      sessionsOf("a"),
      { p2: BILLING_B },
      fakeGoogle({
        a: [applied(USD_100_87_5(BILLING_A)), applied(amounts(BILLING_B, ["USD", 10], ["USD", 4]))],
      }),
    );
    assert.equal((result.p2 as { usd: number }).usd, 4);
  });

  it("a pool with no matching billing account errors and does not hide the others", async () => {
    const result = await readGoogle(
      sessionsOf("a"),
      { p1: BILLING_A, p3: "ZZZ" },
      fakeGoogle({ a: [applied()] }),
    );
    assert.equal((result.p1 as { usd: number }).usd, 87.5);
    assert.equal(errorOf(result, "p3"), "no Google credit for billing account ZZZ in any Google session");
  });

  it("an account whose credit has no billing id cannot match a pool", async () => {
    const result = await readGoogle(
      sessionsOf("a"),
      { p: BILLING_A },
      fakeGoogle({ a: [withBilling(amounts(null, ["USD", 100], ["USD", 87]))] }),
    );
    assert.equal(
      errorOf(result, "p"),
      `no Google credit for billing account ${BILLING_A} in any Google session`,
    );
  });

  it("a pool with no sessions errors", async () => {
    const result = await readGoogle({}, { p: BILLING_A }, fakeGoogle({}));
    assert.equal(
      errorOf(result, "p"),
      `no Google credit for billing account ${BILLING_A} in any Google session`,
    );
  });

  it("an unapplied credit is its own error while no applied credit was seen", async () => {
    const unappliedOnly = await readGoogle(sessionsOf("a"), { p: BILLING_A }, fakeGoogle({ a: [unapplied] }));
    assert.equal(
      errorOf(unappliedOnly, "p"),
      "Google credit is not applied to a billing account; apply it at me.developers.google.com/benefits",
    );
    const other = await readGoogle(
      sessionsOf("a"),
      { p: BILLING_A },
      fakeGoogle({ a: [unapplied, applied(USD_100_87_5(BILLING_B))] }),
    );
    assert.equal(
      errorOf(other, "p"),
      `no Google credit for billing account ${BILLING_A} in any Google session`,
    );
  });

  it("a non-USD credit is an error naming the currency", async () => {
    const result = await readGoogle(
      sessionsOf("a"),
      { p: BILLING_A },
      fakeGoogle({ a: [applied(amounts(BILLING_A, ["TRY", 4983, 710000000], ["TRY"]))] }),
    );
    assert.equal(errorOf(result, "p"), "Google credit is in TRY; schmear meters USD");
  });

  const SIGNED_OUT: [string, Account][] = [
    ["a redirect page", { pageStatus: 302 }],
    ["a 401 page", { pageStatus: 401 }],
    ["a 403 page", { pageStatus: 403 }],
    ["a page without a token", { token: null }],
    ["a page without an email", { email: null }],
    ["a 401 batchexecute", { postStatus: 401 }],
    ["a 403 batchexecute", { postStatus: 403 }],
    ["a redirecting batchexecute", { postStatus: 302 }],
  ];
  for (const [name, account] of SIGNED_OUT) {
    it(`${name} rejects the session; every session rejected is an expiry error`, async () => {
      const result = await readGoogle(
        sessionsOf("a", "b"),
        { p: BILLING_A },
        fakeGoogle({ a: [account], b: [account] }),
      );
      assert.equal(
        errorOf(result, "p"),
        "Google session expired. Run schmear credits login google with a fresh Cookie header.",
      );
    });
  }

  it("a rejected session does not stop the next one", async () => {
    const result = await readGoogle(
      sessionsOf("a", "b"),
      { p: BILLING_A },
      fakeGoogle({ a: [{ pageStatus: 401 }], b: [applied()] }),
    );
    assert.equal((result.p as { usd: number }).usd, 87.5);
  });

  it("a rejected session next to a signed-in one without the credit is not an expiry", async () => {
    const result = await readGoogle(
      sessionsOf("a", "b"),
      { p: BILLING_A },
      fakeGoogle({ a: [{ pageStatus: 401 }], b: [noCredit] }),
    );
    assert.equal(
      errorOf(result, "p"),
      `no Google credit for billing account ${BILLING_A} in any Google session`,
    );
  });

  it("a signed-out account after the first ends the walk without rejecting the session", async () => {
    const result = await readGoogle(
      sessionsOf("a"),
      { p: BILLING_A },
      fakeGoogle({ a: [noCredit, { pageStatus: 403 }, applied()] }),
    );
    assert.equal(
      errorOf(result, "p"),
      `no Google credit for billing account ${BILLING_A} in any Google session`,
    );
  });

  for (const [name, stop, gets, posts] of [
    ["a repeated email", [noCredit, noCredit].map((a) => ({ ...a, email: "same@example.com" })), 2, 1],
    ["a missing email", [noCredit, { ...noCredit, email: null }], 2, 1],
    ["eight accounts", Array.from({ length: 9 }, () => noCredit), 8, 8],
  ] as [string, Account[], number, number][]) {
    it(`the walk stops at ${name}`, async () => {
      const calls: Call[] = [];
      const result = await readGoogle(sessionsOf("a"), { p: BILLING_A }, fakeGoogle({ a: stop }, calls));
      errorOf(result, "p");
      assert.equal(calls.filter((c) => c.method === "GET").length, gets);
      assert.equal(calls.filter((c) => c.method === "POST").length, posts);
    });
  }

  const FAILURES: [string, Account, string][] = [
    [
      "429",
      { pageStatus: 429 },
      "Google Developer Program requests are rate limited. Try again in a few minutes.",
    ],
    ["5xx", { postStatus: 500 }, "Google Developer Program is unavailable. Try again later."],
    [
      "another status",
      { postStatus: 400, envelope: `)]}'\n\n25\n[["er",null,null,null,null,400,null,null,null,3]]` },
      "Google Developer Program returned HTTP 400. Try again later or report this.",
    ],
  ];
  for (const [name, account, message] of FAILURES) {
    it(`${name} is an error, not a session rejection, and the next session still reads`, async () => {
      const failing = await readGoogle(sessionsOf("a"), { p: BILLING_A }, fakeGoogle({ a: [account] }));
      assert.equal(errorOf(failing, "p"), `session a: ${message}`);
      const next = await readGoogle(
        sessionsOf("a", "b"),
        { p: BILLING_A },
        fakeGoogle({ a: [account], b: [applied()] }),
      );
      assert.equal((next.p as { usd: number }).usd, 87.5);
    });
  }

  it("retries a failed benefits page once and then reports the failure without the cookie", async () => {
    let gets = 0;
    const failing = (async () => {
      gets += 1;
      throw new Error("socket hang up");
    }) as typeof fetch;
    const result = await readGoogle(sessionsOf("a"), { p: BILLING_A }, failing);
    assert.equal(gets, 2);
    assert.equal(errorOf(result, "p"), "session a: Google Developer Program request failed: socket hang up");
  });

  const MALFORMED: [string, Account][] = [
    ["an envelope without the result", { envelope: ')]}\'\n\n18\n[["di",42]]' }],
    ["an envelope that is not JSON", { envelope: ")]}'\n\n9\n[not-json" }],
    ["a payload that is not JSON", { envelope: envelope("not-json") }],
    ["a payload that is not a list", { envelope: envelope('{"a":1}') }],
  ];
  for (const [name, account] of MALFORMED) {
    it(`${name} fails closed`, async () => {
      const result = await readGoogle(sessionsOf("a"), { p: BILLING_A }, fakeGoogle({ a: [account] }));
      assert.match(errorOf(result, "p"), /^session a: Could not parse Google Developer Program \w+/);
    });
  }

  const BAD_MONEY: [string, Json][] = [
    ["string units", amounts(BILLING_A, ["USD", "100"], ["USD", 87])],
    ["a lowercase currency", amounts(BILLING_A, ["usd", 100], ["usd", 87])],
    ["a granted amount of 0", amounts(BILLING_A, ["USD", 0], ["USD", 0])],
    ["a negative granted amount", amounts(BILLING_A, ["USD", -5], ["USD", 0])],
    ["mismatched currencies", amounts(BILLING_A, ["USD", 100], ["EUR", 90])],
    ["unsafe integers", amounts(BILLING_A, ["USD", 2 ** 60], ["USD", 1])],
    ["an object", { granted: 100 }],
  ];
  for (const [name, billing] of BAD_MONEY) {
    it(`${name} fails closed`, async () => {
      const result = await readGoogle(
        sessionsOf("a"),
        { p: BILLING_A },
        fakeGoogle({ a: [withBilling(billing)] }),
      );
      assert.match(errorOf(result, "p"), /^session a: Could not parse Google Developer Program [\w ]+\./);
    });
  }
});
