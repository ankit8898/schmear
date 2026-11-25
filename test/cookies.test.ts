import assert from "node:assert/strict";
import { createCipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, beforeEach, describe, it } from "node:test";
import { browserKey, findJars, type Jar, jarCookie } from "../src/cookies.ts";
import type { Run, Sys } from "../src/util.ts";

const PASSWORD = "synthetic-keychain-password";
const base = mkdtempSync(join(tmpdir(), "cookies-test-"));
// The store reader's temp copies land here, so the test can see that none is left behind.
const scratch = join(base, "tmp");
mkdirSync(scratch);
process.env.TMPDIR = scratch;
after(() => rmSync(base, { recursive: true, force: true }));

let home: string;
let homes = 0;
beforeEach(() => {
  home = join(base, `home-${homes++}`);
  mkdirSync(home);
});

interface Call {
  file: string;
  args: string[];
}

function sys(reply: { code: number | null; stdout: string } = { code: 0, stdout: `${PASSWORD}\n` }) {
  const calls: Call[] = [];
  const run: Run = async (file, args) => {
    calls.push({ file, args });
    return reply;
  };
  const s: Sys = { platform: "darwin", home, run };
  return { sys: s, calls };
}

function encrypt(value: string, host: string, version: number, password = PASSWORD): Buffer {
  const key = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  const plain = Buffer.concat([
    version >= 24 ? createHash("sha256").update(host).digest() : Buffer.alloc(0),
    Buffer.from(value, "utf8"),
  ]);
  return Buffer.concat([Buffer.from("v10"), cipher.update(plain), cipher.final()]);
}

interface ChromiumRow {
  host: string;
  name: string;
  value?: string;
  /** Encrypt with the SHA-256 prefix of this host instead of `host`. */
  hashHost?: string;
  path?: string;
  topFrame?: string;
}

function chromiumDb(file: string, rows: ChromiumRow[], version = 24, password = PASSWORD): void {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(
    "CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);" +
      "CREATE TABLE cookies(creation_utc INTEGER, host_key TEXT, top_frame_site_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER);",
  );
  db.prepare("INSERT INTO meta VALUES ('version', ?)").run(String(version));
  const insert = db.prepare("INSERT INTO cookies VALUES (0, ?, ?, ?, ?, ?, ?, 13400000000000000000)");
  for (const r of rows) {
    const encrypted = r.value === undefined;
    insert.run(
      r.host,
      r.topFrame ?? "",
      r.name,
      r.value ?? "",
      encrypted ? encrypt(`${r.name}-secret`, r.hashHost ?? r.host, version, password) : Buffer.alloc(0),
      r.path ?? "/",
    );
  }
  db.close();
}

function firefoxDb(
  file: string,
  rows: { host: string; name: string; value: string; attrs?: string }[],
): void {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(
    "CREATE TABLE moz_cookies(id INTEGER PRIMARY KEY, originAttributes TEXT NOT NULL DEFAULT '', name TEXT, value TEXT, host TEXT, path TEXT, expiry INTEGER);",
  );
  const insert = db.prepare(
    "INSERT INTO moz_cookies(originAttributes, name, value, host, path, expiry) VALUES (?, ?, ?, ?, '/', 1900000000000)",
  );
  for (const r of rows) insert.run(r.attrs ?? "", r.name, r.value, r.host);
  db.close();
}

const support = (...parts: string[]) => join(home, "Library/Application Support", ...parts);
const chrome = (...parts: string[]) => support("Google/Chrome", ...parts);
const claudeRow = (r: Partial<ChromiumRow> = {}): ChromiumRow => ({
  host: ".platform.claude.com",
  name: "sessionKey",
  ...r,
});

async function onlyJar(vendor: "claude" | "google", s: Sys): Promise<Jar> {
  const found = await findJars(vendor, s);
  assert.deepEqual(found.problems, []);
  assert.equal(found.jars.length, 1);
  return found.jars[0] as Jar;
}

describe("findJars and jarCookie: macOS Chromium", () => {
  it("decrypts a meta 24 row, checking and removing the SHA-256 host prefix", async () => {
    chromiumDb(chrome("Default/Cookies"), [claudeRow()]);
    const { sys: s, calls } = sys();
    const jar = await onlyJar("claude", s);
    assert.deepEqual(jar.source, { browser: "Chrome", profile: "Default" });
    assert.equal(jar.name, "Chrome · Default");
    assert.equal(jar.keyId, "Chrome Safe Storage");
    assert.equal(jarCookie("claude", jar, s, PASSWORD), "sessionKey=sessionKey-secret");
    assert.deepEqual(calls, [], "findJars and jarCookie read no Keychain");
  });

  it("decrypts a meta 23 row, which has no prefix", async () => {
    chromiumDb(chrome("Default/Cookies"), [claudeRow()], 23);
    const { sys: s } = sys();
    assert.equal(
      jarCookie("claude", await onlyJar("claude", s), s, PASSWORD),
      "sessionKey=sessionKey-secret",
    );
  });

  it("reads a plaintext value without a key", async () => {
    chromiumDb(chrome("Default/Cookies"), [claudeRow({ value: "sk-plain" })]);
    const { sys: s } = sys();
    const jar = await onlyJar("claude", s);
    assert.equal(jar.keyId, undefined);
    assert.equal(jarCookie("claude", jar, s), "sessionKey=sk-plain");
  });

  it("a wrong password reads as could not decrypt its cookies", async () => {
    chromiumDb(chrome("Default/Cookies"), [claudeRow()]);
    const { sys: s } = sys();
    const jar = await onlyJar("claude", s);
    assert.throws(() => jarCookie("claude", jar, s, "wrong"), { message: "could not decrypt its cookies" });
    assert.throws(() => jarCookie("claude", jar, s), { message: "could not decrypt its cookies" });
  });

  it("drops a row whose prefix is another host's hash", async () => {
    chromiumDb(chrome("Default/Cookies"), [
      { host: ".google.com", name: "SID" },
      { host: ".google.com", name: "HSID", hashHost: ".evil.example" },
    ]);
    const { sys: s } = sys();
    assert.equal(jarCookie("google", await onlyJar("google", s), s, PASSWORD), "SID=SID-secret");
  });

  it("ignores partitioned rows and rows on another path", async () => {
    chromiumDb(chrome("Default/Cookies"), [
      claudeRow({ topFrame: "https://claude.com" }),
      claudeRow({ path: "/x" }),
    ]);
    const { sys: s } = sys();
    const found = await findJars("claude", s);
    assert.deepEqual(found.jars, []);
    assert.deepEqual(found.searched, ["Chrome · Default"]);
  });

  it("prefers Network/Cookies over Cookies", async () => {
    chromiumDb(chrome("Default/Network/Cookies"), [claudeRow({ value: "network" })]);
    chromiumDb(chrome("Default/Cookies"), [claudeRow({ value: "legacy" })]);
    const { sys: s } = sys();
    assert.equal(jarCookie("claude", await onlyJar("claude", s), s), "sessionKey=network");
  });

  it("opens no Cookies file outside Default and Profile directories", async () => {
    chromiumDb(chrome("Default/Storage/ext/x/Cookies"), [claudeRow({ value: "ext" })]);
    chromiumDb(chrome("System Profile/Cookies"), [claudeRow({ value: "system" })]);
    chromiumDb(chrome("Guest Profile/Network/Cookies"), [claudeRow({ value: "guest" })]);
    const { sys: s } = sys();
    assert.deepEqual(await findJars("claude", s), { jars: [], searched: [], problems: [] });
  });

  it("names profiles from Local State and lists one without the cookie as searched only", async () => {
    chromiumDb(chrome("Default/Cookies"), [{ host: ".claude.com", name: "other", value: "x" }]);
    chromiumDb(chrome("Profile 1/Cookies"), [claudeRow()]);
    chromiumDb(chrome("Profile 2/Cookies"), [claudeRow()]);
    writeFileSync(
      chrome("Local State"),
      JSON.stringify({
        profile: { info_cache: { Default: { name: "Personal" }, "Profile 1": { name: "Work" } } },
      }),
    );
    const { sys: s } = sys();
    const found = await findJars("claude", s);
    assert.deepEqual(found.searched, ["Chrome · Personal", "Chrome · Work", "Chrome · Profile 2"]);
    assert.deepEqual(
      found.jars.map((j) => [j.name, j.source.profile, j.keyId]),
      [
        ["Chrome · Work", "Profile 1", "Chrome Safe Storage"],
        ["Chrome · Profile 2", "Profile 2", "Chrome Safe Storage"],
      ],
    );
  });

  it("gives Chrome, Chrome Beta and Chrome Canary one key and other browsers their own", async () => {
    for (const dir of [
      "Google/Chrome",
      "Google/Chrome Beta",
      "Google/Chrome Canary",
      "Arc/User Data",
      "Dia/User Data",
    ]) {
      chromiumDb(support(dir, "Default/Cookies"), [claudeRow()]);
    }
    const { sys: s } = sys();
    const found = await findJars("claude", s);
    assert.deepEqual(
      found.jars.map((j) => [j.browser, j.keyId]),
      [
        ["Chrome", "Chrome Safe Storage"],
        ["Chrome Beta", "Chrome Safe Storage"],
        ["Chrome Canary", "Chrome Safe Storage"],
        ["Arc", "Arc Safe Storage"],
        ["Dia", "Dia Safe Storage"],
      ],
    );
  });

  it("reads a row that is only in the WAL while the writer is still open", async () => {
    const file = chrome("Default/Cookies");
    chromiumDb(file, []);
    const writer = new DatabaseSync(file);
    writer.exec("PRAGMA journal_mode = WAL");
    writer
      .prepare(
        "INSERT INTO cookies VALUES (0, '.platform.claude.com', '', 'sessionKey', 'from-wal', x'', '/', 0)",
      )
      .run();
    try {
      const { sys: s } = sys();
      assert.equal(jarCookie("claude", await onlyJar("claude", s), s), "sessionKey=from-wal");
    } finally {
      writer.close();
    }
  });

  it("reports an unreadable store and leaves no copy behind, as after a good read", async () => {
    chromiumDb(chrome("Default/Cookies"), [claudeRow()]);
    mkdirSync(chrome("Profile 1"));
    writeFileSync(chrome("Profile 1/Cookies"), "not a database");
    const { sys: s } = sys();
    const found = await findJars("claude", s);
    assert.equal(found.jars.length, 1);
    assert.deepEqual(found.problems, [
      { name: "Chrome · Profile 1", problem: "could not read its cookie database" },
    ]);
    assert.deepEqual(readdirSync(scratch), []);
  });

  it("finds nothing when no browser is installed", async () => {
    const { sys: s } = sys();
    assert.deepEqual(await findJars("google", s), { jars: [], searched: [], problems: [] });
  });
});

describe("browserKey: macOS", () => {
  it("runs security find-generic-password with the service and account", async () => {
    const { sys: s, calls } = sys();
    assert.equal(await browserKey("Microsoft Edge Safe Storage", s), PASSWORD);
    assert.deepEqual(calls, [
      {
        file: "/usr/bin/security",
        args: ["find-generic-password", "-w", "-s", "Microsoft Edge Safe Storage", "-a", "Microsoft Edge"],
      },
    ]);
  });

  it("maps exit 44 to a missing key and any other failure to denied", async () => {
    await assert.rejects(browserKey("Chrome Safe Storage", sys({ code: 44, stdout: "" }).sys), {
      message: 'no "Chrome Safe Storage" key in the Keychain',
    });
    await assert.rejects(browserKey("Chrome Safe Storage", sys({ code: 51, stdout: "" }).sys), {
      message: 'Keychain access to "Chrome Safe Storage" was denied',
    });
  });
});

describe("findJars and jarCookie: Firefox", () => {
  it("reads the default row and ignores a container row, under Firefox and Zen", async () => {
    firefoxDb(support("Firefox/Profiles/ab12.default-release/cookies.sqlite"), [
      { host: ".platform.claude.com", name: "sessionKey", value: "ff" },
      { host: ".platform.claude.com", name: "sessionKey", value: "container", attrs: "^userContextId=1" },
    ]);
    firefoxDb(support("zen/Profiles/cd34.Default (release)/cookies.sqlite"), [
      { host: "platform.claude.com", name: "sessionKey", value: "zen" },
    ]);
    const { sys: s, calls } = sys();
    const found = await findJars("claude", s);
    assert.deepEqual(found.problems, []);
    assert.deepEqual(
      found.jars.map((j) => [j.name, j.source, j.keyId, jarCookie("claude", j, s)]),
      [
        [
          "Firefox · default-release",
          { browser: "Firefox", profile: "ab12.default-release" },
          undefined,
          "sessionKey=ff",
        ],
        [
          "Zen · Default (release)",
          { browser: "Zen", profile: "cd34.Default (release)" },
          undefined,
          "sessionKey=zen",
        ],
      ],
    );
    assert.deepEqual(calls, []);
  });
});

describe("jarCookie: Google header", () => {
  it("puts the more specific host first and drops a non-ASCII value", async () => {
    firefoxDb(support("Firefox/Profiles/x.default/cookies.sqlite"), [
      { host: ".google.com", name: "SID", value: "sid" },
      { host: "me.developers.google.com", name: "PREF", value: "pref" },
      { host: ".google.com", name: "NID", value: "naïve" },
      { host: ".developers.google.com", name: "DEV", value: "dev" },
      { host: ".youtube.com", name: "SID", value: "elsewhere" },
    ]);
    const { sys: s } = sys();
    assert.equal(jarCookie("google", await onlyJar("google", s), s), "PREF=pref; DEV=dev; SID=sid");
  });

  it("a profile without SID or __Secure-1PSID is not a jar", async () => {
    firefoxDb(support("Firefox/Profiles/x.default/cookies.sqlite"), [
      { host: ".google.com", name: "NID", value: "n" },
    ]);
    const { sys: s } = sys();
    const found = await findJars("google", s);
    assert.deepEqual(found.jars, []);
    assert.deepEqual(found.searched, ["Firefox · default"]);
  });

  it("accepts __Secure-1PSID as the required cookie", async () => {
    firefoxDb(support("Firefox/Profiles/x.default/cookies.sqlite"), [
      { host: ".google.com", name: "__Secure-1PSID", value: "p" },
    ]);
    const { sys: s } = sys();
    assert.equal(jarCookie("google", await onlyJar("google", s), s), "__Secure-1PSID=p");
  });
});
