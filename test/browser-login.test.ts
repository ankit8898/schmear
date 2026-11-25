import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { importSessions, loginBrowser } from "../src/browser-login.ts";
import { PASTE, readSessionEntries, type SessionEntry, writeSession } from "../src/console.ts";
import type { Found, Jar } from "../src/cookies.ts";
import { lineIO } from "../src/ui.ts";
import type { Sys } from "../src/util.ts";

type Cookies = typeof import("../src/cookies.ts");

// Every cookie value carries this marker; no output line may contain it.
const SECRET = "cookieval-";
const SYS: Sys = {
  platform: "darwin",
  home: "/nonexistent",
  run: async () => assert.fail("the fake cookies module must not spawn"),
};

const jar = (browser: string, profile: string, value: string, keyId?: string): Jar => ({
  source: { browser, profile },
  name: `${browser} · ${profile}`,
  browser,
  ...(keyId ? { keyId } : {}),
  rows: [{ host_key: ".claude.com", name: "sessionKey", value: `${SECRET}${value}` }],
  version: 0,
});

interface Fake {
  cookies: Cookies;
  calls: string[];
}

/** `keys`: keyId → password, or the message `browserKey` throws. A keyed jar decrypts only with `pw-<keyId>`. */
function fakeCookies(found: Partial<Found>, keys: Record<string, string | Error> = {}): Fake {
  const calls: string[] = [];
  const cookies = {
    findJars: async () => {
      calls.push("findJars");
      return {
        jars: [],
        searched: found.jars?.map((j) => j.name) ?? [],
        chromium: true,
        problems: [],
        ...found,
      };
    },
    browserKey: async (keyId: string) => {
      calls.push(`browserKey ${keyId}`);
      const key = keys[keyId];
      if (key instanceof Error || key === undefined)
        throw key ?? new Error(`no "${keyId}" key in the Keychain`);
      return key;
    },
    jarCookie: (_vendor: string, j: Jar, _sys: Sys, password?: string) => {
      calls.push(`jarCookie ${j.name}`);
      if (j.keyId !== undefined && password !== `pw-${j.keyId}`)
        throw new Error("could not decrypt its cookies");
      const row = j.rows[0];
      assert.ok(row);
      return `${row.name}=${row.value}`;
    },
  } as unknown as Cookies;
  return { cookies, calls };
}

/** cookie value (after the marker) → its org names; absent: signed out (401). */
function consoleFetch(orgs: Record<string, string[]>): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    assert.equal(url.host, "platform.claude.com");
    assert.equal(url.pathname, "/api/organizations");
    const cookie = (init.headers as Record<string, string>).Cookie ?? "";
    const names = orgs[cookie.slice(`sessionKey=${SECRET}`.length)];
    if (!names) return new Response("{}", { status: 401 });
    return new Response(
      JSON.stringify(
        names.map((name) => ({ uuid: `id-${name.replace(/\W/g, "")}`, name, capabilities: ["api"] })),
      ),
    );
  }) as typeof fetch;
}

/** A piped IO answering from `replies`; records every question and output line. */
function scripted(replies: string[]) {
  const questions: string[] = [];
  const lines: string[] = [];
  const io = lineIO(
    async (q) => {
      questions.push(q);
      const reply = replies.shift();
      if (reply === undefined) throw new Error(`input ended before: ${q.trim()}`);
      return reply;
    },
    (text) => lines.push(text),
  );
  return { io, questions, lines, text: () => [...questions, ...lines].join("\n") };
}

const entries = () => readSessionEntries("claude");

describe("importSessions", () => {
  let dir: string;
  const saved = { config: process.env.XDG_CONFIG_HOME, state: process.env.XDG_STATE_HOME };
  let out: ReturnType<typeof scripted> | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "schmear-browser-login-"));
    process.env.XDG_CONFIG_HOME = join(dir, "config");
    process.env.XDG_STATE_HOME = join(dir, "state");
  });
  afterEach(async () => {
    if (out) assert.ok(!out.text().includes(SECRET), "a cookie value reached the output");
    out = undefined;
    for (const [key, value] of [
      ["XDG_CONFIG_HOME", saved.config],
      ["XDG_STATE_HOME", saved.state],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  });

  const run = (replies: string[], fake: Fake, fetchFn: typeof fetch, label?: string, sys = SYS) => {
    out = scripted(replies);
    return importSessions(out.io, "claude", label === undefined ? {} : { label }, {
      fetchFn,
      sys,
      cookies: fake.cookies,
    });
  };

  it("takes an empty reply as paste and never calls the cookie reader", async () => {
    const fake = fakeCookies({ jars: [jar("Chrome", "Default", "a")] });
    assert.deepEqual(await run([""], fake, consoleFetch({})), []);
    assert.deepEqual(fake.calls, []);
    assert.ok(
      out?.questions[0]?.startsWith("How should schmear get your Console session? (browser, paste) [paste]"),
    );
    assert.ok(out?.lines[0]?.includes("Nothing is read unless you choose it below."));
    assert.equal(
      out?.lines.at(-1),
      `1. Open platform.claude.com, signed in.\n2. DevTools → Network: copy the Cookie request header of any request to platform.claude.com.\n3. ${PASTE} | schmear credits login claude --stdin`,
    );
  });

  it("stores one login as default with its source", async () => {
    const fake = fakeCookies(
      { jars: [jar("Chrome", "Default", "a", "Chrome Safe Storage")] },
      {
        "Chrome Safe Storage": "pw-Chrome Safe Storage",
      },
    );
    assert.deepEqual(await run(["browser"], fake, consoleFetch({ a: ["Acme"] })), ["default"]);
    assert.deepEqual(await entries(), {
      default: { cookie: `sessionKey=${SECRET}a`, source: { browser: "Chrome", profile: "Default" } },
    });
    assert.ok(out?.lines.includes("✓ Saved Console session default from Chrome · Default: Acme."));
    assert.ok(
      out?.lines.some((l) =>
        l.startsWith(
          'macOS may now ask for your login password so "security" can read "Chrome Safe Storage"',
        ),
      ),
    );
    assert.ok(out?.lines.includes("Read Chrome's cookie key"));
  });

  it("asks which of two logins to store and labels them by org", async () => {
    const fake = fakeCookies({
      jars: [jar("Chrome", "Default", "a"), jar("Firefox", "default-release", "b")],
    });
    const labels = await run(["browser", ""], fake, consoleFetch({ a: ["Acme Corp"], b: ["Beta", "Gamma"] }));
    assert.deepEqual(labels, ["acme-corp", "beta"]);
    assert.ok(
      out?.questions[1]?.startsWith("Which logins should schmear store? (0, 1; comma-separated) [0, 1]"),
    );
    assert.ok(
      out?.lines.includes("✓ Saved Console session beta from Firefox · default-release: Beta, Gamma."),
    );
  });

  it("suffixes a slug label already in use", async () => {
    await writeSession("default", "sessionKey=pasted");
    await writeSession("acme", "sessionKey=pasted2");
    const fake = fakeCookies({ jars: [jar("Chrome", "Default", "a")] });
    assert.deepEqual(await run(["browser"], fake, consoleFetch({ a: ["Acme"] })), ["acme-2"]);
  });

  it("drops a duplicate cookie and a duplicate account", async () => {
    const fake = fakeCookies({
      jars: [jar("Chrome", "Default", "a"), jar("Arc", "Default", "a"), jar("Firefox", "x", "c")],
    });
    assert.deepEqual(await run(["browser"], fake, consoleFetch({ a: ["Acme"], c: ["Acme"] })), ["default"]);
    assert.ok(out?.lines.includes("Checking 2 sessions…"));
    assert.ok(out?.lines.includes("1 signed in"));
  });

  it("refreshes a session from the same source instead of adding one", async () => {
    await writeSession("work", `sessionKey=${SECRET}old`, "claude", {
      browser: "Chrome",
      profile: "Default",
    });
    const fake = fakeCookies({ jars: [jar("Chrome", "Default", "new")] });
    assert.deepEqual(await run(["browser"], fake, consoleFetch({ new: ["Acme"] })), ["work"]);
    assert.deepEqual(Object.keys(await entries()), ["work"]);
    assert.equal((await entries()).work?.cookie, `sessionKey=${SECRET}new`);
    assert.ok(out?.lines.includes("✓ Refreshed Console session work from Chrome · Default: Acme."));
  });

  it("matches a pasted session only by its exact cookie", async () => {
    await writeSession("pasted", `sessionKey=${SECRET}a`);
    const fake = fakeCookies({ jars: [jar("Chrome", "Default", "a")] });
    assert.deepEqual(await run(["browser"], fake, consoleFetch({ a: ["Acme"] })), ["pasted"]);
    const stored: SessionEntry | undefined = (await entries()).pasted;
    assert.deepEqual(stored?.source, { browser: "Chrome", profile: "Default" });
  });

  it("with --label and a source match asks nothing more", async () => {
    await writeSession("work", `sessionKey=${SECRET}old`, "claude", {
      browser: "Chrome",
      profile: "Profile 1",
    });
    const fake = fakeCookies({ jars: [jar("Chrome", "Default", "a"), jar("Chrome", "Profile 1", "b")] });
    assert.deepEqual(await run(["browser"], fake, consoleFetch({ a: ["Acme"], b: ["Beta"] }), "work"), [
      "work",
    ]);
    assert.equal(out?.questions.length, 1);
    assert.equal((await entries()).work?.cookie, `sessionKey=${SECRET}b`);
  });

  it("with --label and two unmatched logins asks which", async () => {
    const fake = fakeCookies({ jars: [jar("Chrome", "Default", "a"), jar("Brave", "Default", "b")] });
    assert.deepEqual(await run(["browser", "1"], fake, consoleFetch({ a: ["Acme"], b: ["Beta"] }), "work"), [
      "work",
    ]);
    assert.ok(out?.questions[1]?.startsWith("Which login is work? (0, 1) [0]"));
    assert.deepEqual((await entries()).work?.source, { browser: "Brave", profile: "Default" });
  });

  it("with --label replaces a signed-out source by the one signed-in profile", async () => {
    await writeSession("work", `sessionKey=${SECRET}old`, "claude", {
      browser: "Chrome",
      profile: "Default",
    });
    const fake = fakeCookies({ jars: [jar("Chrome", "Default", "gone"), jar("Firefox", "x", "b")] });
    assert.deepEqual(await run(["browser"], fake, consoleFetch({ b: ["Beta"] }), "work"), ["work"]);
    assert.deepEqual((await entries()).work?.source, { browser: "Firefox", profile: "x" });
  });

  it("with --label writes nothing when every signed-in profile is another session", async () => {
    await writeSession("home", `sessionKey=${SECRET}x`, "claude", { browser: "Chrome", profile: "Default" });
    const fake = fakeCookies({ jars: [jar("Chrome", "Default", "a")] });
    assert.deepEqual(await run(["browser"], fake, consoleFetch({ a: ["Acme"] }), "work"), []);
    assert.ok(
      out?.lines.includes(
        "! Every signed-in browser profile is already stored as another session (Chrome · Default → home).",
      ),
    );
    assert.ok(out?.lines.at(-1)?.endsWith("--stdin --label work"));
  });

  it("reports no supported browser", async () => {
    const fake = fakeCookies({ searched: [], chromium: false });
    assert.deepEqual(await run(["browser"], fake, consoleFetch({})), []);
    assert.ok(out?.lines.includes("No platform.claude.com cookie in any browser"));
    assert.ok(
      out?.lines.includes(
        "! No supported browser found (Chrome, Arc, Brave, Edge, Chromium, Vivaldi, Dia, Firefox or Zen).",
      ),
    );
    assert.ok(
      out?.lines
        .at(-1)
        ?.startsWith(
          "Sign in at platform.claude.com in one of them, wait half a minute and run this again. Safari is not read. Or paste the header:\n1. Open platform.claude.com",
        ),
    );
  });

  it("reports what it searched and each problem, on linux without the Safari note", async () => {
    const fake = fakeCookies({
      jars: [jar("Chrome", "Default", "gone")],
      searched: ["Chrome · Default", "Firefox · x"],
      problems: [{ name: "Firefox · x", problem: "could not read its cookie database" }],
    });
    assert.deepEqual(
      await run(["browser"], fake, consoleFetch({}), undefined, { ...SYS, platform: "linux" }),
      [],
    );
    const tail = out?.lines.slice(-4);
    assert.deepEqual(tail?.slice(0, 3), [
      "! No signed-in platform.claude.com session found. Searched Chrome · Default, Firefox · x.",
      "! Firefox · x: could not read its cookie database",
      "! Chrome · Default: signed out of platform.claude.com",
    ]);
    assert.ok(
      tail?.[3]?.startsWith(
        "Sign in at platform.claude.com in one of them, wait half a minute (Chrome saves cookies every 30 s) and run this again. Or paste the header:\n1.",
      ),
    );
    assert.ok(out?.lines[0]?.includes("from your keyring (secret-tool), which may ask you to unlock it"));
  });

  it("fails only the browser whose key it cannot read, asking once per key", async () => {
    const denied = 'Keychain access to "Chrome Safe Storage" was denied';
    const fake = fakeCookies(
      {
        jars: [
          jar("Chrome", "Default", "a", "Chrome Safe Storage"),
          jar("Chrome", "Profile 1", "b", "Chrome Safe Storage"),
          jar("Firefox", "x", "c"),
        ],
      },
      { "Chrome Safe Storage": new Error(denied) },
    );
    assert.deepEqual(await run(["browser"], fake, consoleFetch({ a: ["A"], b: ["B"], c: ["Cee"] })), [
      "default",
    ]);
    assert.deepEqual(
      fake.calls.filter((c) => c.startsWith("browserKey")),
      ["browserKey Chrome Safe Storage"],
    );
    assert.ok(out?.lines.includes("Could not read Chrome's cookie key"));
    assert.deepEqual((await entries()).default?.source, { browser: "Firefox", profile: "x" });
  });

  it("reports an unreadable key once and asks to fix the keyring when every profile is signed in", async () => {
    const problem = "secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY";
    const fake = fakeCookies(
      { jars: [jar("Chromium", "Default", "a", "chromium")] },
      { chromium: new Error(problem) },
    );
    assert.deepEqual(
      await run(["browser"], fake, consoleFetch({ a: ["A"] }), undefined, { ...SYS, platform: "linux" }),
      [],
    );
    assert.ok(out?.lines.includes("Could not read Chromium's cookie key"));
    assert.equal(out?.lines.filter((l) => l.includes(problem)).length, 1);
    assert.deepEqual(out?.lines.slice(-2, -1), [`! Chromium · Default: ${problem}`]);
    assert.ok(
      out?.lines
        .at(-1)
        ?.startsWith("Fix the keyring problem above and run this again. Or paste the header:\n1."),
    );
  });

  it("drops the Chrome note when only Firefox was searched", async () => {
    const fake = fakeCookies({ jars: [jar("Firefox", "x", "gone")], chromium: false });
    assert.deepEqual(await run(["browser"], fake, consoleFetch({})), []);
    assert.ok(
      out?.lines
        .at(-1)
        ?.startsWith(
          "Sign in at platform.claude.com in one of them, wait half a minute and run this again. Safari is not read. Or paste the header:\n1.",
        ),
    );
  });

  it("labels Google sessions by the email's local part", async () => {
    const google = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      assert.equal(url.host, "me.developers.google.com");
      const cookie = (init.headers as Record<string, string>).Cookie ?? "";
      const email = `${cookie.slice(`sessionKey=${SECRET}`.length)}@example.com`;
      if (url.searchParams.get("authuser") !== "0") return new Response("", { status: 302 });
      if ((init.method ?? "GET") === "GET") {
        return new Response(`"SNlM0e":"token","oPEP7c":${JSON.stringify(email)}`);
      }
      return new Response(`)]}'\n\n[["wrb.fr","Ro0AYc",null]]\n`);
    }) as typeof fetch;
    const fake = fakeCookies({ jars: [jar("Chrome", "Default", "Ann.Lee"), jar("Firefox", "x", "bob")] });
    out = scripted(["browser", ""]);
    const labels = await importSessions(
      out.io,
      "google",
      {},
      { fetchFn: google, sys: SYS, cookies: fake.cookies },
    );
    assert.deepEqual(labels, ["ann-lee", "bob"]);
    assert.ok(out.lines[0]?.endsWith("run the import again when it does."));
    assert.deepEqual(Object.keys(await readSessionEntries("google")), ["ann-lee", "bob"]);
  });

  it("loginBrowser ends by naming the next command, or that nothing was saved", async () => {
    const fake = fakeCookies({ jars: [jar("Chrome", "Default", "a")] });
    out = scripted(["browser"]);
    await loginBrowser(out.io, "claude", undefined, {
      fetchFn: consoleFetch({ a: ["Acme"] }),
      sys: SYS,
      cookies: fake.cookies,
    });
    assert.match(
      out.lines[0] ?? "",
      /^schmear .* · credits login — let schmear read your Claude Console credit balances$/,
    );
    assert.equal(out.lines.at(-1), "Next: schmear credits");
    out = scripted(["paste"]);
    await loginBrowser(out.io, "claude", "work", {
      fetchFn: consoleFetch({}),
      sys: SYS,
      cookies: fake.cookies,
    });
    assert.equal(out.lines.at(-1), "Nothing saved.");
    await assert.rejects(
      loginBrowser(scripted([]).io, "claude", "Bad Label", { fetchFn: consoleFetch({}), sys: SYS }),
      { message: '--label must be lowercase letters, digits and "-", up to 32' },
    );
  });
});
