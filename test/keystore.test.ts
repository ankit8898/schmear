import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  checkKey,
  deleteKey,
  KEY_SHAPE,
  keyService,
  ownKey,
  readCommand,
  storedKey,
  storeKey,
} from "../src/keystore.ts";
import type { Run, Sys } from "../src/util.ts";

const KEY = "sk-ant-api03-synthetic-key-0123456789abcdef";
const GEMINI = "AQ.synthetic-gemini-key-0123456789";
const ORG = { id: "11111111-1111-4111-8111-111111111111", name: "Acme" };
const OTHER = "33333333-3333-4333-8333-333333333333";

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(res: () => Response, calls: Call[] = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return res();
  }) as typeof fetch;
}

const status =
  (code: number, headers: Record<string, string> = {}) =>
  () =>
    new Response(code === 200 ? `{"echo":"${KEY}"}` : `{"error":"${KEY}"}`, { status: code, headers });

describe("checkKey", () => {
  const anthropic: Array<[string, () => Response, RegExp | undefined]> = [
    ["200 with the org's header", status(200, { "anthropic-organization-id": ORG.id }), undefined],
    [
      "200 with the org's id in upper case",
      status(200, { "anthropic-organization-id": ORG.id.toUpperCase() }),
      undefined,
    ],
    [
      "200 with another org's header",
      status(200, { "anthropic-organization-id": OTHER }),
      /^This key belongs to another organization \(3333.*\), not Acme \(1111.*\)\. In the Console, switch to Acme/,
    ],
    ["200 without the header", status(200), /^Anthropic did not say which organization owns this key/],
    [
      "400",
      status(400),
      /^Anthropic refused this key \(HTTP 400\)\. A key that is not scoped to a workspace/,
    ],
    ["401", status(401), /^Anthropic rejected this key \(HTTP 401\): it is mistyped, revoked or expired\./],
    ["500", status(500), /^Anthropic returned HTTP 500 for the key check\. Try again later\.$/],
    [
      "a thrown fetch",
      () => {
        throw new TypeError("fetch failed");
      },
      /^Could not reach Anthropic to check the key: fetch failed$/,
    ],
  ];
  for (const [name, res, want] of anthropic) {
    it(`Anthropic: ${name}`, async () => {
      const calls: Call[] = [];
      const problem = await checkKey("anthropic", KEY, fakeFetch(res, calls), ORG);
      if (want) assert.match(problem ?? "", want);
      else assert.equal(problem, undefined);
      assert.ok(!problem?.includes(KEY));
      assert.equal(calls.length, 1);
      const call = calls[0] as Call;
      assert.equal(call.url, "https://api.anthropic.com/v1/models?limit=1");
      assert.ok(!call.url.includes(KEY));
      assert.equal(call.init.redirect, "manual");
      assert.deepEqual(call.init.headers, { "x-api-key": KEY, "anthropic-version": "2023-06-01" });
    });
  }

  const gemini: Array<[string, () => Response, RegExp | undefined]> = [
    ["200", status(200), undefined],
    [
      "400",
      status(400),
      /^Google rejected this key \(HTTP 400\)\. Copy a key from aistudio\.google\.com\/apikey\.$/,
    ],
    ["401", status(401), /^Google rejected this key \(HTTP 401\)\./],
    ["403", status(403), /^Google rejected this key \(HTTP 403\)\./],
    ["500", status(500), /^Google returned HTTP 500 for the key check\. Try again later\.$/],
    [
      "a thrown fetch",
      () => {
        throw new TypeError("fetch failed");
      },
      /^Could not reach Google to check the key: fetch failed$/,
    ],
  ];
  for (const [name, res, want] of gemini) {
    it(`Gemini: ${name}`, async () => {
      const calls: Call[] = [];
      const problem = await checkKey("gemini", GEMINI, fakeFetch(res, calls));
      if (want) assert.match(problem ?? "", want);
      else assert.equal(problem, undefined);
      assert.ok(!problem?.includes(GEMINI));
      const call = calls[0] as Call;
      assert.equal(call.url, "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1");
      assert.equal(call.init.redirect, "manual");
      assert.deepEqual(call.init.headers, { "x-goog-api-key": GEMINI });
    });
  }
});

describe("KEY_SHAPE", () => {
  it("accepts Anthropic API keys only", () => {
    assert.ok(KEY_SHAPE.anthropic.test(KEY));
    assert.ok(!KEY_SHAPE.anthropic.test("sk-ant-sid01-session-cookie-value-0123"));
    assert.ok(!KEY_SHAPE.anthropic.test(`${KEY} `));
    assert.ok(!KEY_SHAPE.anthropic.test("sk-ant-api03-short"));
  });

  it("accepts both Gemini key forms, with no fixed length", () => {
    assert.ok(KEY_SHAPE.gemini.test(GEMINI));
    assert.ok(KEY_SHAPE.gemini.test(`AIza${"x".repeat(35)}`));
    assert.ok(KEY_SHAPE.gemini.test(`AIza${"x".repeat(60)}`));
    assert.ok(!KEY_SHAPE.gemini.test("AIzashort"));
    assert.ok(!KEY_SHAPE.gemini.test(KEY));
  });
});

describe("keyService, readCommand, ownKey", () => {
  it("names the service by vendor and pool name", () => {
    assert.equal(keyService("claude-credits@work"), "schmear-anthropic-work");
    assert.equal(keyService("gemini-credits@home"), "schmear-gemini-home");
  });

  it("reads with the platform's command", () => {
    assert.deepEqual(readCommand("darwin", "s"), ["security", "find-generic-password", "-s", "s", "-w"]);
    assert.deepEqual(readCommand("linux", "s"), ["secret-tool", "lookup", "service", "s"]);
  });

  it("holds only for the exact argv of the pool's own service", () => {
    const mac = ["security", "find-generic-password", "-s", "schmear-anthropic-work", "-w"];
    assert.equal(ownKey("claude-credits@work", mac, "darwin"), "schmear-anthropic-work");
    assert.equal(ownKey("claude-credits@work", mac, "linux"), undefined);
    assert.equal(ownKey("claude-credits@other", mac, "darwin"), undefined);
    assert.equal(ownKey("claude-credits@work", [...mac, "-x"], "darwin"), undefined);
    assert.equal(ownKey("claude-credits@work", mac.slice(0, 4), "darwin"), undefined);
    assert.equal(ownKey("claude-credits@work", mac.join(" "), "darwin"), undefined);
    assert.equal(ownKey("claude-credits@work", ["op", "read", "op://x/y"], "darwin"), undefined);
    assert.equal(
      ownKey("gemini-credits@home", ["secret-tool", "lookup", "service", "schmear-gemini-home"], "linux"),
      "schmear-gemini-home",
    );
    assert.equal(ownKey("not-a-pool", mac, "darwin"), undefined);
  });
});

interface RunCall {
  file: string;
  args: string[];
  input?: string;
}

/** A fake secret store: remembers what was stored, keyed by service, and answers reads from it. */
function fakeSys(
  platform: NodeJS.Platform,
  opts: { keep?: (key: string) => string | undefined; missing?: boolean } = {},
) {
  const calls: RunCall[] = [];
  const items = new Map<string, string>();
  const run: Run = async (file, args, input) => {
    calls.push({ file, args, input });
    if (opts.missing) throw Object.assign(new Error(`spawn ${file} ENOENT`), { code: "ENOENT" });
    const kept = (key: string) => (opts.keep ? opts.keep(key) : key);
    if (file === "/usr/bin/security" && args[0] === "-i") {
      const m = /^add-generic-password -U -s (\S+) -a schmear -w (\S+)\n$/.exec(input ?? "");
      const value = m ? kept(m[2] as string) : undefined;
      if (m && value !== undefined) items.set(m[1] as string, value);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (file === "secret-tool" && args[0] === "store") {
      const value = kept(input ?? "");
      if (value !== undefined) items.set(args[3] as string, value);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (file === "security" && args[0] === "find-generic-password") {
      const v = items.get(args[2] as string);
      return v === undefined
        ? { code: 44, stdout: "", stderr: "" }
        : { code: 0, stdout: `${v}\n`, stderr: "" };
    }
    if (file === "secret-tool" && args[0] === "lookup") {
      const v = items.get(args[2] as string);
      return v === undefined ? { code: 1, stdout: "", stderr: "" } : { code: 0, stdout: v, stderr: "" };
    }
    if (
      (file === "/usr/bin/security" && args[0] === "delete-generic-password") ||
      (file === "secret-tool" && args[0] === "clear")
    ) {
      const service = args[2] as string;
      return { code: items.delete(service) ? 0 : 44, stdout: "", stderr: "" };
    }
    throw new Error(`unexpected run: ${file} ${args.join(" ")}`);
  };
  const sys: Sys = { platform, home: "/nonexistent-home", run };
  return { sys, calls, items };
}

describe("storeKey", () => {
  it("darwin: writes the key only on stdin of security -i, then reads it back", async () => {
    const { sys, calls, items } = fakeSys("darwin");
    await storeKey("schmear-anthropic-work", "work", KEY, sys);
    assert.deepEqual(calls, [
      {
        file: "/usr/bin/security",
        args: ["-i"],
        input: `add-generic-password -U -s schmear-anthropic-work -a schmear -w ${KEY}\n`,
      },
      {
        file: "security",
        args: ["find-generic-password", "-s", "schmear-anthropic-work", "-w"],
        input: undefined,
      },
    ]);
    for (const call of calls) assert.ok(!call.args.some((a) => a.includes(KEY)));
    assert.equal(items.get("schmear-anthropic-work"), KEY);
  });

  it("linux: writes the key only on stdin of secret-tool store, then reads it back", async () => {
    const { sys, calls } = fakeSys("linux");
    await storeKey("schmear-gemini-home", "home", GEMINI, sys);
    assert.deepEqual(calls, [
      {
        file: "secret-tool",
        args: ["store", "--label=schmear home", "service", "schmear-gemini-home"],
        input: GEMINI,
      },
      { file: "secret-tool", args: ["lookup", "service", "schmear-gemini-home"], input: undefined },
    ]);
    for (const call of calls) assert.ok(!call.args.some((a) => a.includes(GEMINI)));
  });

  it("throws when the read-back differs", async () => {
    const darwin = fakeSys("darwin", { keep: (k) => `${k}x` }).sys;
    await assert.rejects(storeKey("schmear-anthropic-work", "work", KEY, darwin), {
      message: "Your login Keychain did not keep the key. Unlock it and run schmear credits again.",
    });
    const linux = fakeSys("linux", { keep: () => undefined }).sys;
    await assert.rejects(storeKey("schmear-gemini-home", "home", GEMINI, linux), {
      message: "Your keyring did not keep the key. Unlock it and run schmear credits again.",
    });
  });

  it("linux: a secret-tool that cannot start throws the install message", async () => {
    const { sys } = fakeSys("linux", { missing: true });
    await assert.rejects(storeKey("schmear-gemini-home", "home", GEMINI, sys), {
      message:
        "secret-tool is not installed. Install libsecret-tools (Debian, Ubuntu) or libsecret (Fedora, Arch), then run schmear credits again.",
    });
  });

  it("refuses a key or service that security -i could misparse, running nothing", async () => {
    const { sys, calls } = fakeSys("darwin");
    await assert.rejects(storeKey("schmear-anthropic-work", "work", `${KEY} -x`, sys), {
      message: "unstorable key",
    });
    await assert.rejects(storeKey("schmear anthropic", "work", KEY, sys), { message: "unstorable key" });
    assert.equal(calls.length, 0);
  });
});

describe("storedKey", () => {
  it("returns the trimmed key, or undefined on a non-zero exit or empty output", async () => {
    const { sys, items } = fakeSys("darwin");
    assert.equal(await storedKey("svc", sys), undefined);
    items.set("svc", KEY);
    assert.equal(await storedKey("svc", sys), KEY);
    items.set("svc", "");
    assert.equal(await storedKey("svc", sys), undefined);
  });

  it("linux: a secret-tool that cannot start throws the install message", async () => {
    const { sys } = fakeSys("linux", { missing: true });
    await assert.rejects(storedKey("svc", sys), { message: /^secret-tool is not installed\./ });
  });
});

describe("deleteKey", () => {
  it("darwin: deletes with security and reports whether it did", async () => {
    const { sys, calls, items } = fakeSys("darwin");
    items.set("schmear-anthropic-work", KEY);
    assert.equal(await deleteKey("schmear-anthropic-work", sys), true);
    assert.deepEqual(calls[0], {
      file: "/usr/bin/security",
      args: ["delete-generic-password", "-s", "schmear-anthropic-work"],
      input: undefined,
    });
    assert.equal(await deleteKey("schmear-anthropic-work", sys), false);
  });

  it("linux: clears with secret-tool; one that cannot start deletes nothing", async () => {
    const { sys, calls, items } = fakeSys("linux");
    items.set("schmear-gemini-home", GEMINI);
    assert.equal(await deleteKey("schmear-gemini-home", sys), true);
    assert.deepEqual(calls[0]?.args, ["clear", "service", "schmear-gemini-home"]);
    assert.equal(await deleteKey("schmear-gemini-home", fakeSys("linux", { missing: true }).sys), false);
  });
});
