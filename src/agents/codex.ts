import { readFile } from "node:fs/promises";
import { homedir, release } from "node:os";
import { join } from "node:path";
import { workerEnv } from "../acp.ts";
import type { AgentAdapter, AgentReading, Lane, LaunchSpec, Window, WorkerFailure } from "../types.ts";
import {
  errorMessage,
  execFileAsync,
  firstLine,
  isRecord,
  PACKAGE_VERSION,
  unreadable,
  versionLine,
} from "../util.ts";
import { adapterBin, type Fallthrough, lineExchange, window } from "./shared.ts";

const RPC_TIMEOUT_MS = 15_000;
const HTTP_TIMEOUT_MS = 30_000;
const CLI_VERSION_TIMEOUT_MS = 5_000;
const OAUTH_REFRESH_WINDOW_MS = 300_000;
const OAUTH_MAX_AGE_MS = 8 * 24 * 60 * 60 * 1000;
const JWT_EXP_MIN = -8_334_601_228_800;
const JWT_EXP_MAX = 8_210_266_876_799;
const WHOAMI_URL = "https://auth.openai.com/api/accounts/v1/user-auth-credential/whoami";
const WHAM_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_ORIGINATOR = "codex_cli_rs";
const TOKEN_RE = /^[\x21-\x7e]+$/;

export interface CodexDeps {
  readFile(path: string): Promise<string>;
  fetch: typeof fetch;
  rpc(bin: string, env?: Record<string, string>): Promise<unknown>;
  cliVersion?: (bin: string, env?: NodeJS.ProcessEnv) => Promise<string | undefined>;
  osVersion?: () => Promise<string>;
  platform?: NodeJS.Platform;
  arch?: string;
}

/** ChatGPT subscription plans (`codex-acp` 2.9.0 `PLAN_DISPLAY_NAMES`, `dist/index.js:49020-49029`). */
const SUBSCRIPTION_PLANS = new Set(["free", "go", "plus", "pro", "team", "business", "enterprise", "edu"]);

/** Codex user config path (`${CODEX_HOME:-~/.codex}/config.toml`). */
export function codexConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CODEX_HOME || join(homedir(), ".codex"), "config.toml");
}

/** Maps Codex's effective permission triple to the codex-acp mode that reproduces it (spec 8.2, R27). */
export function codexMode(
  sandboxMode: string,
  approvalPolicy: string,
  approvalsReviewer: string,
  configFile = codexConfigPath(),
): string {
  const triple = `${sandboxMode}/${approvalPolicy}/${approvalsReviewer}`;
  switch (triple) {
    case "read-only/on-request/user":
      return "read-only";
    case "workspace-write/on-request/user":
      return "workspace-write";
    case "workspace-write/on-request/auto_review":
      return "agent";
    case "danger-full-access/never/user":
      return "agent-full-access";
    default:
      throw new Error(
        `no codex-acp mode for sandbox_mode=${sandboxMode}, approval_policy=${approvalPolicy}, approvals_reviewer=${approvalsReviewer}; in ${configFile}, set sandbox_mode, approval_policy and approvals_reviewer to a supported combination or set default_permissions`,
      );
  }
}

/** One JSON-RPC call to `<bin> <args>` (initialize, initialized, then `method`); kills the process after the reply. */
async function codexRpc(
  bin: string,
  args: string[],
  method: string,
  params: unknown,
  env: Record<string, string>,
): Promise<unknown> {
  const rpc = (m: Record<string, unknown>): string => JSON.stringify({ jsonrpc: "2.0", ...m });
  const outcome = await lineExchange(
    bin,
    args,
    {
      env,
      timeoutMs: RPC_TIMEOUT_MS,
      start: [
        rpc({
          id: 1,
          method: "initialize",
          params: { clientInfo: { name: "schmear", version: PACKAGE_VERSION } },
        }),
      ],
    },
    (line, send) => {
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        throw new Error("codex app-server sent a line that is not JSON");
      }
      if (!isRecord(msg) || (msg.id !== 1 && msg.id !== 2)) {
        return undefined;
      }
      if (isRecord(msg.error)) {
        throw new Error(`codex app-server error: ${String(msg.error.message)}`);
      }
      if (msg.id === 1) {
        send(rpc({ method: "initialized" }));
        send(rpc({ id: 2, method, params }));
        return undefined;
      }
      return { value: msg.result };
    },
  );
  if (outcome.status === "timeout") {
    throw new Error(`codex app-server did not answer ${method} within ${RPC_TIMEOUT_MS} ms`);
  }
  if (outcome.status === "closed") {
    throw new Error(`codex app-server exited before answering ${method}`);
  }
  return outcome.value;
}

/** `config/read {cwd}` from `<bin> app-server`: the merged config Codex would load for cwd. */
async function readCodexConfig(
  bin: string,
  cwd: string,
  env: Record<string, string>,
): Promise<Record<string, unknown>> {
  const result = await codexRpc(bin, ["app-server"], "config/read", { cwd }, env);
  const config = isRecord(result) ? result.config : undefined;
  if (!isRecord(config)) {
    throw new Error("codex config/read reply has no result.config");
  }
  return config;
}

/** Raw `account/rateLimits/read` result (spec 8.2, R13); token-free. */
export function readCodexUsage(bin: string, env?: Record<string, string>): Promise<unknown> {
  return codexRpc(
    bin,
    ["-s", "read-only", "-a", "never", "app-server"],
    "account/rateLimits/read",
    null,
    workerEnv(env),
  );
}

function codexWindow(raw: unknown, name: string, reached: boolean): Window | string | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (!isRecord(raw)) {
    return `Codex ${name} window is not an object`;
  }
  const { usedPercent, windowDurationMins, resetsAt } = raw;
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) {
    return `Codex ${name} window has no numeric usedPercent`;
  }
  if (typeof windowDurationMins !== "number" || !(windowDurationMins > 0)) {
    return `Codex ${name} window has no positive windowDurationMins`;
  }
  const kind = windowDurationMins <= 1440 ? "short" : "period";
  const resetsAtMs = typeof resetsAt === "number" ? resetsAt * 1000 : null;
  return window(reached ? 100 : usedPercent, resetsAtMs, kind, windowDurationMins / 60);
}

/** Maps the `account/rateLimits/read` result to a reading (spec 8.2): the pool comes from `rateLimits` only. */
export function parseCodexUsage(raw: unknown, now: number): AgentReading {
  const limits = isRecord(raw) ? raw.rateLimits : undefined;
  if (!isRecord(limits)) {
    return unreadable("codex", "Codex rate-limit reply has no rateLimits", [], now);
  }
  const reached =
    limits.spendControlReached === true ||
    (limits.rateLimitReachedType !== undefined && limits.rateLimitReachedType !== null);
  const windows: Window[] = [];
  for (const name of ["primary", "secondary"]) {
    const w = codexWindow(limits[name], name, reached);
    if (typeof w === "string") {
      return unreadable("codex", w, [], now);
    }
    if (w) {
      windows.push(w);
    }
  }
  if (windows.length === 0) {
    return unreadable("codex", "Codex reports no rate-limit window", [], now);
  }
  const warnings: string[] = [];
  const ownId = typeof limits.limitId === "string" ? limits.limitId : "codex";
  const byId = isRecord(raw) ? raw.rateLimitsByLimitId : undefined;
  for (const id of isRecord(byId) ? Object.keys(byId) : []) {
    if (id !== ownId) {
      warnings.push(`Codex reports another limit '${id}'; not used for routing`);
    }
  }
  const spendOn = codexCreditsOn(limits.credits);
  return {
    agent: "codex",
    fetchedAt: now,
    pools: [{ id: "codex", agent: "codex", keys: ["codex"], windows }],
    warnings,
    ...(spendOn === undefined ? {} : { error: spendOn }),
  };
}

/** Codex spends credits past the plan limit, so held credits skip Codex (§8.2 spend guard). */
export function codexCreditsOn(credits: unknown): string | undefined {
  if (!isRecord(credits) || (credits.hasCredits !== true && credits.unlimited !== true)) {
    return undefined;
  }
  const balance = typeof credits.balance === "string" ? ` (balance ${credits.balance})` : "";
  return `codex credits can pay past your plan limit${credits.unlimited === true ? " (unlimited)" : balance}`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function nonEmptyTrimmed(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function validHeaderToken(value: string | undefined): string | undefined {
  return value !== undefined && TOKEN_RE.test(value) ? value : undefined;
}

function recordField(
  obj: Record<string, unknown>,
  snake: string,
  camel: string,
): Record<string, unknown> | undefined {
  const first = obj[snake];
  if (isPlainRecord(first)) {
    return first;
  }
  const second = obj[camel];
  return isPlainRecord(second) ? second : undefined;
}

function spendNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed !== "") {
      const n = Number(trimmed);
      if (Number.isFinite(n)) {
        return n;
      }
    }
  }
  return undefined;
}

function whamSpendControlReached(raw: Record<string, unknown>, rateLimit: Record<string, unknown>): boolean {
  const spendControl = recordField(raw, "spend_control", "spendControl");
  const individual =
    recordField(raw, "individual_limit", "individualLimit") ??
    recordField(rateLimit, "individual_limit", "individualLimit") ??
    (spendControl ? recordField(spendControl, "individual_limit", "individualLimit") : undefined);
  if (!individual) {
    return false;
  }
  const limit = spendNumber(individual.limit);
  if (limit === undefined || !(limit > 0)) {
    return false;
  }
  const remainingPercent =
    spendNumber(individual.remainingPercent) ?? spendNumber(individual.remaining_percent);
  if (remainingPercent !== undefined) {
    return remainingPercent <= 0;
  }
  const used = spendNumber(individual.used);
  return used !== undefined && 100 - (used / limit) * 100 <= 0;
}

function whamWindow(raw: unknown, name: string, reached: boolean): Window | string | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (!isPlainRecord(raw)) {
    return `Codex ${name} window is not an object`;
  }
  const { used_percent, limit_window_seconds, reset_at } = raw;
  if (typeof used_percent !== "number" || !Number.isFinite(used_percent)) {
    return `Codex ${name} window has no numeric used_percent`;
  }
  if (
    typeof limit_window_seconds !== "number" ||
    !Number.isFinite(limit_window_seconds) ||
    !(limit_window_seconds > 0)
  ) {
    return `Codex ${name} window has no positive limit_window_seconds`;
  }
  const kind = limit_window_seconds <= 86_400 ? "short" : "period";
  const resetsAtMs = typeof reset_at === "number" && Number.isFinite(reset_at) ? reset_at * 1000 : null;
  return window(reached ? 100 : used_percent, resetsAtMs, kind, limit_window_seconds / 3600);
}

function whamCredits(credits: unknown): unknown {
  if (!isPlainRecord(credits)) {
    return undefined;
  }
  const balance =
    typeof credits.balance === "number" && Number.isFinite(credits.balance)
      ? String(credits.balance)
      : typeof credits.balance === "string"
        ? credits.balance
        : undefined;
  return {
    hasCredits: credits.has_credits === true,
    unlimited: credits.unlimited === true,
    ...(balance === undefined ? {} : { balance }),
  };
}

/** Maps a `wham/usage` response (PAT or OAuth) to a reading with the same semantics as `parseCodexUsage`. */
export function parseCodexWham(raw: unknown, now: number): AgentReading {
  if (!isPlainRecord(raw)) {
    return unreadable("codex", "Codex rate-limit reply is not an object", [], now);
  }
  if (raw.rate_limit === undefined || raw.rate_limit === null) {
    return unreadable("codex", "Codex reports no rate-limit window", [], now);
  }
  if (!isPlainRecord(raw.rate_limit)) {
    return unreadable("codex", "Codex rate_limit is not an object", [], now);
  }
  const rateLimit = raw.rate_limit;
  const reached =
    whamSpendControlReached(raw, rateLimit) ||
    recordField(raw, "spend_control", "spendControl")?.reached === true ||
    (raw.rate_limit_reached_type ?? null) !== null;
  const windows: Window[] = [];
  for (const [key, name] of [
    ["primary_window", "primary"],
    ["secondary_window", "secondary"],
  ] as const) {
    const w = whamWindow(rateLimit[key], name, reached);
    if (typeof w === "string") {
      return unreadable("codex", w, [], now);
    }
    if (w) {
      windows.push(w);
    }
  }
  if (windows.length === 0) {
    return unreadable("codex", "Codex reports no rate-limit window", [], now);
  }
  const warnings: string[] = [];
  if (Array.isArray(raw.additional_rate_limits)) {
    for (const entry of raw.additional_rate_limits) {
      if (isPlainRecord(entry)) {
        const label =
          nonEmptyTrimmed(entry.limit_name) ?? nonEmptyTrimmed(entry.metered_feature) ?? "unknown";
        warnings.push(`Codex reports another limit '${label}'; not used for routing`);
      }
    }
  }
  const spendOn = codexCreditsOn(whamCredits(raw.credits));
  return {
    agent: "codex",
    fetchedAt: now,
    pools: [{ id: "codex", agent: "codex", keys: ["codex"], windows }],
    warnings,
    ...(spendOn === undefined ? {} : { error: spendOn }),
  };
}

function codexAuthPath(env: NodeJS.ProcessEnv): string {
  const codexHome = env.CODEX_HOME?.trim();
  if (codexHome) {
    return join(codexHome, "auth.json");
  }
  const home = env.HOME?.trim() || homedir();
  return join(home, ".codex", "auth.json");
}

async function readAuthJson(
  env: NodeJS.ProcessEnv,
  deps: CodexDeps,
  now: number,
): Promise<{ ok: Record<string, unknown> } | { missing: true } | { invalid: AgentReading }> {
  let text: string;
  try {
    text = await deps.readFile(codexAuthPath(env));
  } catch {
    return { missing: true };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // JSON.parse's message quotes auth.json text, which holds tokens.
    return { invalid: unreadable("codex", "Codex auth.json is not valid JSON", [], now) };
  }
  if (!isPlainRecord(parsed)) {
    return { invalid: unreadable("codex", "Codex auth.json is not valid JSON", [], now) };
  }
  return { ok: parsed };
}

function decodeJwtPayload(token: string, requireNonEmptyParts: boolean): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length !== 3 || (requireNonEmptyParts && parts.some((p) => p.length === 0))) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return isPlainRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function jwtAccountId(idToken: string | undefined, accessToken: string): string | undefined {
  for (const token of [idToken, accessToken]) {
    if (!token) {
      continue;
    }
    const payload = decodeJwtPayload(token, false);
    if (!payload) {
      continue;
    }
    const direct = nonEmptyTrimmed(payload.chatgpt_account_id);
    if (direct) {
      return direct;
    }
    const auth = payload["https://api.openai.com/auth"];
    if (isPlainRecord(auth)) {
      const nested = nonEmptyTrimmed(auth.chatgpt_account_id);
      if (nested) {
        return nested;
      }
    }
  }
  return undefined;
}

function jwtExpMs(accessToken: string): number | undefined {
  const payload = decodeJwtPayload(accessToken, true);
  if (!payload) {
    return undefined;
  }
  const { exp } = payload;
  if (typeof exp === "number" && Number.isInteger(exp) && exp >= JWT_EXP_MIN && exp <= JWT_EXP_MAX) {
    return exp * 1000;
  }
  return undefined;
}

function normalizeCliVersion(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  const parts = trimmed.split(/\s+/);
  const token = parts[0]?.toLowerCase() === "codex-cli" ? parts[1] : parts[0];
  return validHeaderToken(token);
}

function normalizeOsVersion(raw: string): string {
  const head = raw.split("-", 1)[0]?.trim() ?? "";
  const parts = head.split(".").filter((p) => /^\d+$/.test(p));
  if (parts.length === 0) {
    return "0.0.0";
  }
  while (parts.length < 3) {
    parts.push("0");
  }
  return parts.slice(0, 3).join(".");
}

let darwinOsVersionPromise: Promise<string> | undefined;

function defaultOsVersion(platform: NodeJS.Platform): Promise<string> {
  if (platform !== "darwin") {
    return Promise.resolve(normalizeOsVersion(release()));
  }
  darwinOsVersionPromise ??= execFileAsync("/usr/bin/sw_vers", ["-productVersion"], {
    timeout: CLI_VERSION_TIMEOUT_MS,
  })
    .then(({ stdout }) => normalizeOsVersion(firstLine(stdout)))
    .catch(() => normalizeOsVersion(release()));
  return darwinOsVersionPromise;
}

const cliVersionCache = new Map<string, Promise<string | undefined>>();

function cachedCodexVersion(bin: string, env?: NodeJS.ProcessEnv): Promise<string | undefined> {
  let pending = cliVersionCache.get(bin);
  if (!pending) {
    pending = execFileAsync(bin, ["--version"], {
      env: workerEnv(undefined, env),
      timeout: CLI_VERSION_TIMEOUT_MS,
    })
      .then(({ stdout }) => firstLine(stdout) || undefined)
      .catch(() => undefined);
    cliVersionCache.set(bin, pending);
  }
  return pending;
}

function codexCliUserAgent(
  cliVersion: string | undefined,
  platform: NodeJS.Platform,
  osVersion: string,
  arch: string,
): string {
  const platformName = platform === "darwin" ? "Mac OS" : platform === "linux" ? "Linux" : platform;
  const archName = arch === "arm64" ? "arm64" : arch === "x64" || arch === "x86_64" ? "x86_64" : "unknown";
  const version = normalizeCliVersion(cliVersion);
  const osVer = normalizeOsVersion(osVersion);
  return version
    ? `${CODEX_ORIGINATOR}/${version} (${platformName} ${osVer}; ${archName})`
    : `${CODEX_ORIGINATOR} (${platformName} ${osVer}; ${archName})`;
}

async function fetchCodexJson(
  deps: CodexDeps,
  url: string,
  headers: Record<string, string>,
  now: number,
  on401: string,
  apiLabel: string,
  invalidLabel: string,
): Promise<{ body: Record<string, unknown> } | AgentReading | Fallthrough> {
  let res: Response;
  try {
    res = await deps.fetch(url, {
      method: "GET",
      headers,
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (err) {
    return unreadable("codex", errorMessage(err), [], now);
  }
  if (res.status === 401) {
    return { fallthrough: on401 };
  }
  if (!res.ok) {
    return unreadable("codex", `${apiLabel} HTTP ${res.status}`, [], now);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return unreadable("codex", invalidLabel, [], now);
  }
  if (!isPlainRecord(body)) {
    return unreadable("codex", invalidLabel, [], now);
  }
  return { body };
}

/** Step 0: reads Codex usage via a `personal_access_token` in `auth.json` (whoami, then wham/usage). */
export async function readCodexPAT(
  env: NodeJS.ProcessEnv,
  deps: CodexDeps,
  now: number,
  bin = "codex",
): Promise<AgentReading | Fallthrough> {
  const auth = await readAuthJson(env, deps, now);
  if ("missing" in auth) {
    return { fallthrough: "" };
  }
  if ("invalid" in auth) {
    return auth.invalid;
  }
  const rawPat =
    typeof auth.ok.personal_access_token === "string" && auth.ok.personal_access_token.trim() !== ""
      ? auth.ok.personal_access_token
      : typeof auth.ok.personalAccessToken === "string" && auth.ok.personalAccessToken.trim() !== ""
        ? auth.ok.personalAccessToken
        : undefined;
  if (rawPat === undefined) {
    return { fallthrough: "" };
  }
  const pat = validHeaderToken(rawPat);
  if (!pat) {
    return { fallthrough: "Codex PAT is invalid" };
  }

  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const [cliVer, osVer] = await Promise.all([
    deps.cliVersion ? deps.cliVersion(bin, env).catch(() => undefined) : Promise.resolve(undefined),
    deps.osVersion ? deps.osVersion().catch(() => "0.0.0") : defaultOsVersion(platform),
  ]);
  const patHeaders: Record<string, string> = {
    Authorization: `Bearer ${pat}`,
    Accept: "application/json",
    originator: CODEX_ORIGINATOR,
    "User-Agent": codexCliUserAgent(cliVer, platform, osVer, arch),
  };

  const whoami = await fetchCodexJson(
    deps,
    WHOAMI_URL,
    patHeaders,
    now,
    "Codex PAT expired or invalid",
    "Codex whoami API",
    "Codex PAT whoami response was invalid",
  );
  if (!("body" in whoami)) {
    return whoami;
  }
  const accountId = validHeaderToken(nonEmptyTrimmed(whoami.body.chatgpt_account_id));

  const usage = await fetchCodexJson(
    deps,
    WHAM_USAGE_URL,
    { ...patHeaders, ...(accountId ? { "ChatGPT-Account-Id": accountId } : {}) },
    now,
    "Codex PAT expired or invalid",
    "Codex usage API",
    "Codex usage API response was invalid",
  );
  if (!("body" in usage)) {
    return usage;
  }
  const reading = parseCodexWham(usage.body, now);
  return reading.pools.length > 0 ? { ...reading, source: "pat" } : reading;
}

/** Step 1: reads Codex usage via OAuth tokens in `auth.json` against `wham/usage`; never refreshes tokens. */
export async function readCodexOAuth(
  env: NodeJS.ProcessEnv,
  deps: CodexDeps,
  now: number,
): Promise<AgentReading | Fallthrough> {
  const auth = await readAuthJson(env, deps, now);
  if ("missing" in auth) {
    return { fallthrough: "no Codex OAuth credentials" };
  }
  if ("invalid" in auth) {
    return auth.invalid;
  }
  const tokens = auth.ok.tokens;
  if (!isPlainRecord(tokens)) {
    return { fallthrough: "no Codex OAuth tokens" };
  }
  const rawAccessToken = nonEmptyString(tokens.access_token) ?? nonEmptyString(tokens.accessToken);
  const refreshToken = nonEmptyString(tokens.refresh_token) ?? nonEmptyString(tokens.refreshToken);
  if (!rawAccessToken || rawAccessToken.trim() === "" || !refreshToken) {
    return { fallthrough: "no Codex OAuth tokens" };
  }
  const accessToken = validHeaderToken(rawAccessToken);
  if (!accessToken) {
    return { fallthrough: "Codex OAuth token is invalid" };
  }

  const expMs = jwtExpMs(accessToken);
  if (expMs !== undefined) {
    if (expMs <= now + OAUTH_REFRESH_WINDOW_MS) {
      return { fallthrough: "Codex OAuth token due for refresh" };
    }
  } else {
    const lastRefreshMs = typeof auth.ok.last_refresh === "string" ? Date.parse(auth.ok.last_refresh) : NaN;
    if (Number.isNaN(lastRefreshMs) || now - lastRefreshMs > OAUTH_MAX_AGE_MS) {
      return { fallthrough: "Codex OAuth token due for refresh" };
    }
  }

  const idToken = nonEmptyString(tokens.id_token) ?? nonEmptyString(tokens.idToken);
  const accountId = validHeaderToken(
    nonEmptyTrimmed(tokens.account_id) ??
      nonEmptyTrimmed(tokens.accountId) ??
      jwtAccountId(idToken, accessToken),
  );

  const usage = await fetchCodexJson(
    deps,
    WHAM_USAGE_URL,
    {
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": `schmear/${PACKAGE_VERSION}`,
      Accept: "application/json",
      ...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
    },
    now,
    "Codex OAuth token expired or invalid",
    "Codex usage API",
    "Codex usage API response was invalid",
  );
  if (!("body" in usage)) {
    return usage;
  }
  const reading = parseCodexWham(usage.body, now);
  return reading.pools.length > 0 ? { ...reading, source: "oauth" } : reading;
}

export const codexDeps: CodexDeps = {
  readFile: (path) => readFile(path, "utf8"),
  fetch,
  rpc: readCodexUsage,
  cliVersion: cachedCodexVersion,
};

/** PAT, then OAuth, then CLI RPC; falls back only on credential states the next step can repair. Never throws. */
export async function readCodex(
  bin: string,
  deps: CodexDeps = codexDeps,
  env?: Record<string, string>,
): Promise<AgentReading> {
  const mergedEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
  const pat = await readCodexPAT(mergedEnv, deps, Date.now(), bin);
  if (!("fallthrough" in pat)) {
    return pat;
  }
  const oauth = await readCodexOAuth(mergedEnv, deps, Date.now());
  if (!("fallthrough" in oauth)) {
    return oauth;
  }
  let rpcReading: AgentReading;
  try {
    rpcReading = parseCodexUsage(await deps.rpc(bin, env), Date.now());
  } catch (err) {
    rpcReading = unreadable("codex", errorMessage(err), [], Date.now());
  }
  if (rpcReading.pools.length > 0) {
    return { ...rpcReading, source: "rpc" };
  }
  const reasons = [
    ...(pat.fallthrough ? [`PAT: ${pat.fallthrough}`] : []),
    `OAuth: ${oauth.fallthrough}`,
  ].join("; ");
  return { ...rpcReading, error: `${rpcReading.error ?? "Codex RPC failed"} (${reasons})` };
}

/** Config values can be structured (a granular approval_policy); name them as JSON. */
function configString(value: unknown, fallback: string): string {
  if (value === undefined || value === null) {
    return fallback;
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Undefined for a subscription plan, else why the plan fails detection. */
function codexPlanError(plan: unknown): string | undefined {
  if (typeof plan === "string" && SUBSCRIPTION_PLANS.has(plan.trim().toLowerCase())) {
    return undefined;
  }
  const label = JSON.stringify(plan) ?? "missing";
  return `Codex plan ${label} does not bill a ChatGPT subscription`;
}

export const codexAdapter: AgentAdapter = {
  id: "codex",
  home: { env: "CODEX_HOME", login: ["login"] },

  isClient(clientName: string): boolean {
    return clientName === "codex-mcp-client";
  },

  async find(
    bin: string,
    env?: Record<string, string>,
  ): Promise<{ version: string; plan?: string } | { error: string }> {
    let version: string;
    let raw: unknown;
    try {
      version = await versionLine(bin, workerEnv(env));
      raw = await readCodexUsage(bin, env);
    } catch (err) {
      return { error: errorMessage(err) };
    }
    const limits = isRecord(raw) ? raw.rateLimits : undefined;
    if (!isRecord(limits)) {
      return { error: "Codex rate-limit reply has no rateLimits" };
    }
    const planError = codexPlanError(limits.planType);
    return planError ? { error: planError } : { version, plan: String(limits.planType) };
  },

  readUsage(bin: string, env?: Record<string, string>): Promise<AgentReading> {
    return readCodex(bin, undefined, env);
  },

  async launch(lane: Lane, cwd: string, bin: string, overlay?: Record<string, string>): Promise<LaunchSpec> {
    const env = workerEnv({ ...overlay, CODEX_PATH: bin });
    const config = await readCodexConfig(bin, cwd, env);
    const spec: LaunchSpec = {
      command: process.execPath,
      args: [await adapterBin("@agentclientprotocol/codex-acp", "codex-acp")],
      env,
      config: { model: lane.model, effort: lane.effort },
    };
    if (config.default_permissions === undefined || config.default_permissions === null) {
      spec.config = {
        mode: codexMode(
          configString(config.sandbox_mode, "workspace-write"),
          configString(config.approval_policy, "on-request"),
          configString(config.approvals_reviewer, "user"),
          codexConfigPath(env),
        ),
        ...spec.config,
      };
    }
    return spec;
  },

  classifyFailure(f: WorkerFailure): "quota" | "failed" {
    if (f.code === -32603 && isRecord(f.data) && f.data.codexErrorInfo === "usageLimitExceeded") {
      return "quota";
    }
    return "failed";
  },
};
