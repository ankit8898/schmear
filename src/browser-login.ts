import {
  listOrgs,
  PASTE,
  readSessionEntries,
  SessionExpired,
  type SessionSource,
  type SessionVendor,
  writeSession,
} from "./console.ts";
import type { Jar } from "./cookies.ts";
import { googleAccounts } from "./google.ts";
import { dropUsage } from "./state.ts";
import { parseCreditPool } from "./types.ts";
import type { InitIO } from "./ui.ts";
import { errorMessage, PACKAGE_VERSION, type Sys, slug } from "./util.ts";

// The only importer of cookies.ts, and only after the user picks `browser`: nothing else may reach a browser store.

export interface ImportDeps {
  fetchFn: typeof fetch;
  sys: Sys;
  cookies?: typeof import("./cookies.ts");
}

const NAME: Record<SessionVendor, string> = { claude: "Console", google: "Google" };
const SITE: Record<SessionVendor, string> = {
  claude: "platform.claude.com",
  google: "me.developers.google.com",
};
const SUBTITLE: Record<SessionVendor, string> = {
  claude: "let schmear read your Claude Console credit balances",
  google: "let schmear read your Google Developer Program credit",
};

const browsers = (sys: Sys) =>
  sys.platform === "darwin"
    ? "Chrome, Arc, Brave, Edge, Chromium, Vivaldi, Dia, Firefox or Zen"
    : "Chrome, Chromium, Brave, Edge or Firefox";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The numbered DevTools steps that end in `credits login <vendor> --stdin`. */
export function pasteSteps(vendor: SessionVendor, label?: string): string {
  const site = SITE[vendor];
  return [
    vendor === "claude" ? `Open ${site}, signed in.` : `Open ${site}, signed in to Google.`,
    `DevTools → Network: copy the Cookie request header of any request to ${site}.`,
    `${PASTE} | schmear credits login ${vendor} --stdin${label ? ` --label ${label}` : ""}`,
  ]
    .map((text, i) => `${i + 1}. ${text}`)
    .join("\n");
}

function consent(vendor: SessionVendor, sys: Sys): string {
  const key =
    sys.platform === "darwin"
      ? "the browser's cookie key from your Keychain, which macOS asks you to allow"
      : "the browser's cookie key from your keyring (secret-tool), which may ask you to unlock it";
  const copy = `from a browser you are signed in to (${browsers(sys)}): it reads the cookie files of every profile of those browsers and, for a Chromium browser, ${key}. Nothing is read unless you choose it below.`;
  return vendor === "claude"
    ? `schmear reads each org's credit balance with your platform.claude.com session. It can copy that session's cookie ${copy}`
    : `schmear reads your Google Developer Program credit with your me.developers.google.com session, which is your Google sign-in. It can copy that session's cookies ${copy} Google rotates these cookies, so an imported session can expire within days; run the import again when it does.`;
}

interface Login {
  jar: Jar;
  cookie: string;
  /** Org names or emails. */
  names: string[];
  /** Sorted org ids or emails: one account in two browsers has one key. */
  key: string;
  /** The stored label whose source or cookie this login is. */
  label?: string;
}

const sameSource = (a: SessionSource | undefined, b: SessionSource) =>
  a?.browser === b.browser && a.profile === b.profile;

/** §3.1: asks import-or-paste and stores what the browser import finds. Returns the labels written; empty when the user chose paste or nothing was stored (the reason is logged). */
export async function importSessions(
  io: InitIO,
  vendor: SessionVendor,
  opts: { label?: string },
  deps: ImportDeps,
): Promise<string[]> {
  const { sys, fetchFn } = deps;
  const darwin = sys.platform === "darwin";
  const site = SITE[vendor];
  io.log("info", consent(vendor, sys));
  const how = await io.select(
    `How should schmear get your ${NAME[vendor]} session?`,
    [
      {
        value: "browser",
        label: "Import it from my browser",
        hint: darwin
          ? "reads every profile's cookie file; macOS may ask for Keychain access"
          : "reads every profile's cookie file; your keyring may ask to unlock",
      },
      { value: "paste", label: "Paste a Cookie header", hint: "from DevTools; reads no browser files" },
    ],
    "paste",
  );
  if (how !== "browser") {
    io.log("info", `To paste your cookie instead:\n${pasteSteps(vendor, opts.label)}`);
    return [];
  }
  const cookies = deps.cookies ?? (await import("./cookies.ts"));

  const found = await io.task(
    `Looking for a ${site} session in your browsers`,
    () => cookies.findJars(vendor, sys),
    (f) =>
      f.jars.length > 0
        ? `Found ${plural(f.jars.length, "browser profile")} with a ${site} cookie`
        : `No ${site} cookie in any browser`,
  );
  const problems: { name: string; problem: string; key?: true }[] = [...found.problems];

  const passwords = new Map<string, string | Error>();
  for (const jar of found.jars) {
    if (jar.keyId === undefined || passwords.has(jar.keyId)) continue;
    const keyId = jar.keyId;
    if (darwin) {
      io.log(
        "info",
        `macOS may now ask for your login password so "security" can read "${keyId}", the key to ${jar.browser}'s cookies. Allow is enough; Always Allow would let any program you run read it without asking.`,
      );
    }
    const password = await io.task(
      darwin ? "Waiting for the Keychain" : "Waiting for your keyring",
      () => cookies.browserKey(keyId, sys).catch((err: unknown) => new Error(errorMessage(err))),
      (p) => `${p instanceof Error ? "Could not read" : "Read"} ${jar.browser}'s cookie key`,
    );
    passwords.set(keyId, password);
  }

  const candidates: { jar: Jar; cookie: string }[] = [];
  for (const jar of found.jars) {
    const password = jar.keyId === undefined ? undefined : passwords.get(jar.keyId);
    if (password instanceof Error) {
      problems.push({ name: jar.name, problem: password.message, key: true });
      continue;
    }
    let cookie: string;
    try {
      cookie = cookies.jarCookie(vendor, jar, sys, password);
    } catch (err) {
      problems.push({ name: jar.name, problem: errorMessage(err) });
      continue;
    }
    if (!candidates.some((c) => c.cookie === cookie)) candidates.push({ jar, cookie });
  }

  const logins: Login[] = [];
  if (candidates.length > 0) {
    await io.task(
      `Checking ${plural(candidates.length, "session")}`,
      async () => {
        for (const { jar, cookie } of candidates) {
          let names: string[];
          let ids: string[];
          try {
            if (vendor === "claude") {
              const orgs = await listOrgs(cookie, fetchFn);
              names = orgs.map((o) => o.name);
              ids = orgs.map((o) => o.id);
            } else {
              names = (await googleAccounts(cookie, fetchFn)).map((a) => a.email);
              ids = names;
            }
          } catch (err) {
            problems.push({
              name: jar.name,
              problem: err instanceof SessionExpired ? `signed out of ${site}` : errorMessage(err),
            });
            continue;
          }
          const key = [...ids].sort().join("\n");
          if (!logins.some((l) => l.key === key)) logins.push({ jar, cookie, names, key });
        }
      },
      () => `${logins.length} signed in`,
    );
  }

  const entries = await readSessionEntries(vendor);
  for (const login of logins) {
    login.label =
      Object.keys(entries).find((label) => sameSource(entries[label]?.source, login.jar.source)) ??
      Object.keys(entries).find((label) => entries[label]?.cookie === login.cookie);
  }
  const identity = (l: Login) => l.names.join(", ");
  const unmatched = logins.filter((l) => l.label === undefined);
  const writes: { label: string; login: Login }[] = [];

  if (opts.label !== undefined) {
    const L = opts.label;
    let login = logins.find((l) => l.label === L) ?? (unmatched.length === 1 ? unmatched[0] : undefined);
    if (!login && unmatched.length > 1) {
      const options = unmatched.map((l, i) => ({ value: String(i), label: l.jar.name, hint: identity(l) }));
      login = unmatched[Number(await io.select(`Which login is ${L}?`, options, "0"))];
    }
    if (login) writes.push({ label: L, login });
  } else {
    for (const login of logins) if (login.label !== undefined) writes.push({ label: login.label, login });
    const picked =
      unmatched.length > 1
        ? (
            await io.choose(
              "Which logins should schmear store?",
              unmatched.map((l, i) => ({ value: String(i), label: `${l.jar.name} — ${identity(l)}` })),
              unmatched.map((_, i) => String(i)),
            )
          ).map((i) => unmatched[Number(i)] as Login)
        : unmatched;
    const taken = new Set([...Object.keys(entries), ...writes.map((w) => w.label)]);
    for (const login of picked) {
      let label = "default";
      if (picked.length !== 1 || taken.has("default")) {
        const first = login.names[0] ?? "";
        const base = slug(vendor === "claude" ? first : (first.split("@")[0] ?? "")) || "session";
        label = base;
        for (let n = 2; taken.has(label); n += 1) label = `${base.slice(0, 32 - `-${n}`.length)}-${n}`;
      }
      taken.add(label);
      writes.push({ label, login });
    }
  }

  for (const { label, login } of writes) {
    await writeSession(label, login.cookie, vendor, login.jar.source);
    io.log(
      "ok",
      `${Object.hasOwn(entries, label) ? "Refreshed" : "Saved"} ${NAME[vendor]} session ${label} from ${login.jar.name}: ${identity(login)}.`,
    );
  }
  if (writes.length > 0) {
    await dropUsage(vendor === "claude" ? "claude-credits" : "gemini-credits");
    return writes.map((w) => w.label);
  }
  // The user unticked every login: nothing was missing, so there is nothing to report.
  if (opts.label === undefined && unmatched.length > 0) return [];

  if (found.searched.length === 0) {
    io.log("warn", `No supported browser found (${browsers(sys)}).`);
  } else if (logins.length > 0) {
    const others = logins.map((l) => `${l.jar.name} → ${l.label}`).join(", ");
    io.log("warn", `Every signed-in browser profile is already stored as another session (${others}).`);
  } else {
    io.log("warn", `No signed-in ${site} session found. Searched ${found.searched.join(", ")}.`);
    for (const { name, problem } of problems) io.log("warn", `${name}: ${problem}`);
  }
  // Every profile held a cookie and only its key was unreadable: the user is signed in.
  const keyOnly =
    logins.length === 0 &&
    problems.length > 0 &&
    problems.every((p) => p.key) &&
    found.jars.length === found.searched.length;
  const saves = found.chromium ? " (Chrome saves cookies every 30 s)" : "";
  const advice = keyOnly
    ? `Fix the ${darwin ? "Keychain" : "keyring"} problem above and run this again.`
    : `Sign in at ${site} in one of them, wait half a minute${saves} and run this again.${darwin ? " Safari is not read." : ""}`;
  io.log("info", `${advice} Or paste the header:\n${pasteSteps(vendor, opts.label)}`);
  return [];
}

/** `credits login <vendor>` without --stdin (§3.2). */
export async function loginBrowser(
  io: InitIO,
  vendor: SessionVendor,
  label: string | undefined,
  deps: ImportDeps,
): Promise<void> {
  if (label !== undefined && !parseCreditPool(`claude-credits@${label}`)) {
    throw new Error('--label must be lowercase letters, digits and "-", up to 32');
  }
  io.start(`schmear ${PACKAGE_VERSION} · credits login`, SUBTITLE[vendor]);
  const written = await importSessions(io, vendor, { label }, deps);
  io.end(written.length > 0 ? "Next: schmear credits" : "Nothing saved.");
}
