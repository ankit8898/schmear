import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { copyFile, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { SessionSource, SessionVendor } from "./console.ts";
import { isRecord, type Sys } from "./util.ts";

// The only module that reads browser cookie stores. Each store is copied to a private temp dir, read there
// and the copy removed; only the vendor's rows are selected, and only those are decrypted.

interface Row {
  host_key: string;
  name: string;
  value: string;
  encrypted_value?: Uint8Array;
}

export interface Jar {
  source: SessionSource;
  name: string;
  browser: string;
  /** The stored key the jar's cookies need: darwin the Keychain service, linux the secret-tool application. Absent: none needed. */
  keyId?: string;
  /** The store's rows for the vendor's hosts; read only by `jarCookie`. */
  rows: Row[];
  /** The Chromium `meta` version; 0 for Firefox. */
  version: number;
}

export interface Found {
  jars: Jar[];
  searched: string[];
  problems: { name: string; problem: string }[];
}

const WANT: Record<SessionVendor, { hosts: string[]; name?: string; required: string[] }> = {
  claude: {
    hosts: ["platform.claude.com", ".platform.claude.com", ".claude.com"],
    name: "sessionKey",
    required: ["sessionKey"],
  },
  google: {
    hosts: ["me.developers.google.com", ".me.developers.google.com", ".developers.google.com", ".google.com"],
    required: ["SID", "__Secure-1PSID"],
  },
};

const UNREADABLE = "could not read its cookie database";
const UNDECRYPTABLE = "could not decrypt its cookies";

// [browser, root under ~/Library/Application Support, Keychain account]; the service is `<account> Safe Storage`.
const DARWIN_CHROMIUM: [string, string, string][] = [
  ["Chrome", "Google/Chrome", "Chrome"],
  ["Chrome Beta", "Google/Chrome Beta", "Chrome"],
  ["Chrome Canary", "Google/Chrome Canary", "Chrome"],
  ["Arc", "Arc/User Data", "Arc"],
  ["Brave", "BraveSoftware/Brave-Browser", "Brave"],
  ["Edge", "Microsoft Edge", "Microsoft Edge"],
  ["Chromium", "Chromium", "Chromium"],
  ["Vivaldi", "Vivaldi", "Vivaldi"],
  ["Dia", "Dia/User Data", "Dia"],
];
const SAFE_STORAGE = " Safe Storage";
// [browser, root under ~/.config, secret-tool application].
const LINUX_CHROMIUM: [string, string, string][] = [
  ["Chrome", "google-chrome", "chrome"],
  ["Chromium", "chromium", "chromium"],
  ["Brave", "BraveSoftware/Brave-Browser", "brave"],
  ["Edge", "microsoft-edge", "msedge"],
];

interface ChromiumRoot {
  browser: string;
  root: string;
  keyId: string;
}

function chromiumRoots(sys: Sys): ChromiumRoot[] {
  if (sys.platform === "linux") {
    return LINUX_CHROMIUM.map(([browser, dir, app]) => ({
      browser,
      root: join(sys.home, ".config", dir),
      keyId: app,
    }));
  }
  if (sys.platform !== "darwin") return [];
  const support = join(sys.home, "Library/Application Support");
  return DARWIN_CHROMIUM.map(([browser, dir, account]) => ({
    browser,
    root: join(support, dir),
    keyId: account + SAFE_STORAGE,
  }));
}

function firefoxRoots(sys: Sys): { browser: string; root: string }[] {
  if (sys.platform === "linux") {
    return [".mozilla/firefox", "snap/firefox/common/.mozilla/firefox", ".config/mozilla/firefox"].map(
      (dir) => ({ browser: "Firefox", root: join(sys.home, dir) }),
    );
  }
  if (sys.platform !== "darwin") return [];
  const support = join(sys.home, "Library/Application Support");
  return [
    { browser: "Firefox", root: join(support, "Firefox/Profiles") },
    { browser: "Zen", root: join(support, "zen/Profiles") },
  ];
}

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

/** Sorted child directory names; none when `dir` is missing. */
async function childDirs(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

type Db = import("node:sqlite").DatabaseSync;

/** Copies the database with its `-wal` and `-journal` into a 0700 temp dir, opens the copy read-write so SQLite replays the WAL, and removes the dir after `query`. */
async function readStore<T>(file: string, query: (db: Db) => T): Promise<T> {
  const { DatabaseSync } = await import("node:sqlite");
  const dir = await mkdtemp(join(tmpdir(), "schmear-cookies-"));
  try {
    const copy = join(dir, basename(file));
    await copyFile(file, copy);
    for (const suffix of ["-wal", "-journal"]) {
      if (await exists(file + suffix)) await copyFile(file + suffix, copy + suffix);
    }
    const db = new DatabaseSync(copy);
    try {
      return query(db);
    } finally {
      db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function hostFilter(vendor: SessionVendor, hostColumn: string): { where: string; params: string[] } {
  const want = WANT[vendor];
  const where = `${hostColumn} IN (${want.hosts.map(() => "?").join(", ")}) AND path = '/'${want.name ? " AND name = ?" : ""}`;
  return { where, params: want.name ? [...want.hosts, want.name] : want.hosts };
}

function chromiumRows(vendor: SessionVendor, db: Db): { rows: Row[]; version: number } {
  const { where, params } = hostFilter(vendor, "host_key");
  const rows = db
    .prepare(
      `SELECT host_key, name, value, encrypted_value FROM cookies WHERE ${where} AND top_frame_site_key = ''`,
    )
    .all(...params) as unknown as Row[];
  const meta = db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as
    | { value: string }
    | undefined;
  return { rows, version: Number(meta?.value ?? 0) };
}

function firefoxRows(vendor: SessionVendor, db: Db): { rows: Row[]; version: number } {
  const { where, params } = hostFilter(vendor, "host");
  const rows = db
    .prepare(`SELECT host AS host_key, name, value FROM moz_cookies WHERE ${where} AND originAttributes = ''`)
    .all(...params) as unknown as Row[];
  return { rows, version: 0 };
}

const prefixOf = (row: Row): string =>
  Buffer.from(row.encrypted_value ?? [])
    .subarray(0, 3)
    .toString("latin1");

/** Whether a jar's rows need its stored key: darwin any encrypted row; linux any `v11` row (`v10` uses a fixed password). */
const needsKey = (rows: Row[], sys: Sys): boolean =>
  sys.platform === "linux" ? rows.some((r) => prefixOf(r) === "v11") : rows.some((r) => r.value === "");

async function chromiumProfiles(root: string): Promise<{ dir: string; file: string; display: string }[]> {
  const localState: unknown = await readFile(join(root, "Local State"), "utf8")
    .then(JSON.parse)
    .catch(() => undefined);
  const cache =
    isRecord(localState) && isRecord(localState.profile) && isRecord(localState.profile.info_cache)
      ? localState.profile.info_cache
      : {};
  const profiles: { dir: string; file: string; display: string }[] = [];
  for (const dir of await childDirs(root)) {
    if (dir !== "Default" && !dir.startsWith("Profile ")) continue;
    const network = join(root, dir, "Network/Cookies");
    const legacy = join(root, dir, "Cookies");
    const file = (await exists(network)) ? network : (await exists(legacy)) ? legacy : undefined;
    if (!file) continue;
    const info = cache[dir];
    const name = isRecord(info) && typeof info.name === "string" && info.name ? info.name : dir;
    profiles.push({ dir, file, display: name });
  }
  return profiles;
}

/** Every profile of every supported browser that holds the vendor's required cookie. Reads cookie files only: no Keychain, keyring or network. */
export async function findJars(vendor: SessionVendor, sys: Sys): Promise<Found> {
  const found: Found = { jars: [], searched: [], problems: [] };
  const required = WANT[vendor].required;
  const add = async (
    browser: string,
    profile: string,
    display: string,
    file: string,
    read: (db: Db) => { rows: Row[]; version: number },
    keyId?: string,
  ): Promise<void> => {
    const name = `${browser} · ${display}`;
    found.searched.push(name);
    let store: { rows: Row[]; version: number };
    try {
      store = await readStore(file, read);
    } catch {
      found.problems.push({ name, problem: UNREADABLE });
      return;
    }
    if (!store.rows.some((r) => required.includes(r.name))) return;
    found.jars.push({
      source: { browser, profile },
      name,
      browser,
      ...(keyId && needsKey(store.rows, sys) ? { keyId } : {}),
      ...store,
    });
  };
  for (const { browser, root, keyId } of chromiumRoots(sys)) {
    for (const { dir, file, display } of await chromiumProfiles(root)) {
      await add(browser, dir, display, file, (db) => chromiumRows(vendor, db), keyId);
    }
  }
  for (const { browser, root } of firefoxRoots(sys)) {
    for (const dir of await childDirs(root)) {
      const file = join(root, dir, "cookies.sqlite");
      if (!(await exists(file))) continue;
      const display = dir.includes(".") ? dir.slice(dir.indexOf(".") + 1) : dir;
      await add(browser, dir, display, file, (db) => firefoxRows(vendor, db));
    }
  }
  return found;
}

/** The browser's cookie password for `keyId`. Throws an Error whose message is a §3.1 problem. */
export async function browserKey(keyId: string, sys: Sys): Promise<string> {
  if (sys.platform === "linux") {
    // Looked up by application, not label: a label lookup can return an Electron app's key (yt-dlp#12762).
    const reply = await sys
      .run("secret-tool", [
        "lookup",
        "xdg:schema",
        "chrome_libsecret_os_crypt_password_v2",
        "application",
        keyId,
      ])
      .catch(() => {
        throw new Error("secret-tool is not installed");
      });
    const password = reply.stdout.trim();
    if (reply.code !== 0 || !password) throw new Error(`no cookie key for ${keyId} in the keyring`);
    return password;
  }
  const account = keyId.slice(0, -SAFE_STORAGE.length);
  const { code, stdout } = await sys.run("/usr/bin/security", [
    "find-generic-password",
    "-w",
    "-s",
    keyId,
    "-a",
    account,
  ]);
  if (code === 0) return stdout.trim();
  throw new Error(
    code === 44 ? `no "${keyId}" key in the Keychain` : `Keychain access to "${keyId}" was denied`,
  );
}

const IV = Buffer.alloc(16, 0x20);
const utf8 = new TextDecoder("utf-8", { fatal: true });

/** A Chromium `v10`/`v11` value, or undefined when any step fails. */
function decrypt(row: Row, keys: Record<string, Buffer | undefined>, version: number): string | undefined {
  const key = keys[prefixOf(row)];
  if (!key) return undefined;
  const data = Buffer.from(row.encrypted_value ?? []);
  let plain: Buffer;
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, IV);
    plain = Buffer.concat([decipher.update(data.subarray(3)), decipher.final()]);
  } catch {
    return undefined;
  }
  if (version >= 24) {
    const hash = createHash("sha256").update(row.host_key).digest();
    if (plain.length < 32 || !hash.equals(plain.subarray(0, 32))) return undefined;
    plain = plain.subarray(32);
  }
  try {
    return utf8.decode(plain);
  } catch {
    return undefined;
  }
}

const HEADER_SAFE = /^[\x20-\x3a\x3c-\x7e]*$/;

/** The Cookie header for the vendor's host. Throws `could not decrypt its cookies` when no required cookie can be read. */
export function jarCookie(vendor: SessionVendor, jar: Jar, sys: Sys, password?: string): string {
  const linux = sys.platform === "linux";
  const derive = (p: string | undefined): Buffer | undefined =>
    p === undefined ? undefined : pbkdf2Sync(p, "saltysalt", linux ? 1 : 1003, 16, "sha1");
  const key = derive(password);
  const keys = { v10: linux ? derive("peanuts") : key, v11: key };
  const cookies: { host: string; name: string; value: string }[] = [];
  for (const row of jar.rows) {
    const value = row.value !== "" ? row.value : decrypt(row, keys, jar.version);
    if (value === undefined || !HEADER_SAFE.test(value)) continue;
    cookies.push({ host: row.host_key, name: row.name, value });
  }
  if (!cookies.some((c) => WANT[vendor].required.includes(c.name))) throw new Error(UNDECRYPTABLE);
  return cookies
    .sort((a, b) => b.host.length - a.host.length)
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}
