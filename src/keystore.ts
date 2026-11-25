import type { ConsoleOrg } from "./console.ts";
import { parseCreditPool } from "./types.ts";
import { errorMessage, type Sys } from "./util.ts";

// API keys schmear stores for credit pools: the key goes only to its vendor's check and to the stdin of the
// platform's secret store, never into argv, a URL, a log or an error.

export type KeyVendor = "anthropic" | "gemini";

// A prefix gate that keeps clipboard junk away from a vendor; the vendor check is the authority.
export const KEY_SHAPE: Record<KeyVendor, RegExp> = {
  // sid, oat and ort are a Console session cookie and Claude Code login tokens, never API keys.
  anthropic: /^sk-ant-(?!sid|oat|ort)[\w-]{20,}$/,
  gemini: /^(AIza[\w-]{30,}|AQ\.[\w.-]{20,})$/,
};

/** Why a value fails `KEY_SHAPE`, never quoting it. */
const keyShapeProblem = (vendor: KeyVendor): string =>
  vendor === "anthropic"
    ? "that is not an Anthropic API key (sk-ant-…, not a session cookie or login token); copy the key itself"
    : "that is not a Gemini API key (they start with AIza or AQ.); copy the key itself";

const TIMEOUT_MS = 60_000;
// Every read and delete names this account, so a same-service item another program stored is never touched.
const ACCOUNT = "schmear";
const NO_SECRET_TOOL =
  "secret-tool is not installed. Install libsecret-tools (Debian, Ubuntu) or libsecret (Fedora, Arch), then run schmear credits again.";

export const storeName = (platform: NodeJS.Platform): string =>
  platform === "darwin" ? "your login Keychain" : "your keyring";

/** `schmear-anthropic-<name>` or `schmear-gemini-<name>` for a pool id. */
export function keyService(poolId: string): string {
  const parsed = parseCreditPool(poolId);
  if (!parsed) throw new Error(`credit pool id invalid: ${poolId}`);
  return `schmear-${parsed.key === "gemini-credits" ? "gemini" : "anthropic"}-${parsed.name}`;
}

/** The argv a pool's `keyCommand` holds for a key schmear stored. */
export function readCommand(platform: NodeJS.Platform, service: string): string[] {
  return platform === "darwin"
    ? ["/usr/bin/security", "find-generic-password", "-s", service, "-a", ACCOUNT, "-w"]
    : ["secret-tool", "lookup", "service", service, "account", ACCOUNT];
}

/** The service when `keyCommand` is schmear's own read argv for `poolId`. */
export function ownKey(poolId: string, keyCommand: unknown, platform: NodeJS.Platform): string | undefined {
  if (!parseCreditPool(poolId) || !Array.isArray(keyCommand)) return undefined;
  const service = keyService(poolId);
  const own = readCommand(platform, service);
  return keyCommand.length === own.length && own.every((arg, i) => keyCommand[i] === arg)
    ? service
    : undefined;
}

/** undefined: the key works (and, for Anthropic, belongs to `org`). Otherwise a §3.4 problem. */
export async function checkKey(
  vendor: KeyVendor,
  key: string,
  fetchFn: typeof fetch,
  org?: ConsoleOrg,
): Promise<string | undefined> {
  // A stored key read back for reuse is checked here too: fetch quotes a header value it rejects.
  if (!KEY_SHAPE[vendor].test(key)) {
    const problem = keyShapeProblem(vendor);
    return `${problem[0]?.toUpperCase()}${problem.slice(1)}.`;
  }
  const anthropic = vendor === "anthropic";
  const who = anthropic ? "Anthropic" : "Google";
  let res: Response;
  try {
    // Manual: a redirect must not carry the key to another host.
    res = await fetchFn(
      anthropic
        ? "https://api.anthropic.com/v1/models?limit=1"
        : "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1",
      {
        headers: anthropic
          ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
          : { "x-goog-api-key": key },
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
  } catch (err) {
    return `Could not reach ${who} to check the key: ${errorMessage(err)}`;
  }
  if (anthropic) {
    if (res.status === 401) {
      return "Anthropic rejected this key (HTTP 401): it is mistyped, revoked or expired. Copy a key from platform.claude.com/settings/keys.";
    }
    if (res.status === 400) {
      return "Anthropic refused this key (HTTP 400). A key that is not scoped to a workspace cannot run Claude Code; create a workspace key at platform.claude.com/settings/keys.";
    }
    if (res.status !== 200)
      return `Anthropic returned HTTP ${res.status} for the key check. Try again later.`;
    if (!org) return undefined;
    const owner = res.headers.get("anthropic-organization-id");
    if (!owner)
      return "Anthropic did not say which organization owns this key; update schmear or report this.";
    return owner.toLowerCase() === org.id.toLowerCase()
      ? undefined
      : `This key belongs to another organization (${owner}), not ${org.name} (${org.id}). In the Console, switch to ${org.name}, create a key there and paste that one.`;
  }
  if (res.status === 200) return undefined;
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    return `Google rejected this key (HTTP ${res.status}). Copy a key from aistudio.google.com/apikey.`;
  }
  return `Google returned HTTP ${res.status} for the key check. Try again later.`;
}

/** What `readCommand` prints, or undefined when it exits non-zero or prints nothing. Throws the secret-tool message when it cannot start. */
export async function storedKey(service: string, sys: Sys): Promise<string | undefined> {
  const [file, ...args] = readCommand(sys.platform, service) as [string, ...string[]];
  let out: Awaited<ReturnType<Sys["run"]>>;
  try {
    out = await sys.run(file, args);
  } catch (err) {
    if (sys.platform === "darwin") throw err;
    throw new Error(NO_SECRET_TOOL);
  }
  const key = out.stdout.trim();
  return out.code === 0 && key ? key : undefined;
}

/** Stores, then reads back and compares. Throws a §3.4 store failure. */
export async function storeKey(service: string, name: string, key: string, sys: Sys): Promise<void> {
  // `security -i` splits its line on spaces, so only a key and service without them can be stored this way.
  if (!/^[\w.-]+$/.test(key) || !/^[\w-]+$/.test(service)) throw new Error("unstorable key");
  // The read-back, not the store's exit code, proves the key was kept.
  if (sys.platform === "darwin") {
    await sys.run(
      "/usr/bin/security",
      ["-i"],
      `add-generic-password -U -s ${service} -a ${ACCOUNT} -w ${key}\n`,
    );
  } else {
    try {
      await sys.run(
        "secret-tool",
        ["store", `--label=schmear ${name}`, "service", service, "account", ACCOUNT],
        key,
      );
    } catch {
      throw new Error(NO_SECRET_TOOL);
    }
  }
  if ((await storedKey(service, sys)) !== key) {
    const store = storeName(sys.platform);
    throw new Error(
      `${store[0]?.toUpperCase()}${store.slice(1)} did not keep the key. Unlock it and run schmear credits again.`,
    );
  }
}

/** true when the item was deleted. */
export async function deleteKey(service: string, sys: Sys): Promise<boolean> {
  const deleted =
    sys.platform === "darwin"
      ? sys.run("/usr/bin/security", ["delete-generic-password", "-s", service, "-a", ACCOUNT])
      : sys.run("secret-tool", ["clear", "service", service, "account", ACCOUNT]);
  return deleted.then(
    ({ code }) => code === 0,
    () => false,
  );
}
