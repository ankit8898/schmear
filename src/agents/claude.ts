import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { workerEnv } from "../acp.ts";
import { stateDir } from "../state.ts";
import type {
  AgentAdapter,
  AgentPool,
  AgentReading,
  Lane,
  LaunchSpec,
  Window,
  WorkerFailure,
  WorkerRun,
} from "../types.ts";
import {
  DETECT_TIMEOUT_MS,
  errorMessage,
  execFileAsync,
  firstLine,
  isRecord,
  unreadable,
  versionLine,
} from "../util.ts";
import { adapterBin, type Fallthrough, lineExchange, window } from "./shared.ts";

export interface ClaudeOAuthToken {
  accessToken: string;
  expiresAt?: number;
  scopes: string[];
}

export interface ClaudeDeps {
  readToken(env: NodeJS.ProcessEnv): Promise<ClaudeOAuthToken | Fallthrough>;
  fetch: typeof fetch;
  cli(bin: string, env?: Record<string, string>): Promise<AgentReading>;
  version?(bin: string, env: NodeJS.ProcessEnv): Promise<string | undefined>;
}

const SECURITY_BIN = "/usr/bin/security";
const SECURITY_TIMEOUT_MS = 1_500;
const SECURITY_ARGS = ["find-generic-password", "-s", "Claude Code-credentials", "-w"];
const NO_CREDENTIALS = "no Claude OAuth credentials";
const MALFORMED_TOKEN = "Claude OAuth token is malformed";
const TOKEN_RE = /^[\x21-\x7e]+$/;
const OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA_HEADER = "oauth-2025-04-20";
const OAUTH_TIMEOUT_MS = 30_000;
const VERSION_TIMEOUT_MS = 5_000;
const FALLBACK_CLAUDE_VERSION = "2.1.0";
const claudeVersionCache = new Map<string, Promise<string>>();

function normalizeClaudeVersion(raw: string | undefined): string {
  const token = raw?.trim().split(/\s+/, 1)[0] ?? "";
  return TOKEN_RE.test(token) ? token : FALLBACK_CLAUDE_VERSION;
}

function detectClaudeVersion(bin: string, env: NodeJS.ProcessEnv): Promise<string> {
  let cached = claudeVersionCache.get(bin);
  if (!cached) {
    cached = execFileAsync(bin, ["--version"], { env, timeout: VERSION_TIMEOUT_MS })
      .then(({ stdout }) => normalizeClaudeVersion(firstLine(stdout)))
      .catch(() => FALLBACK_CLAUDE_VERSION);
    claudeVersionCache.set(bin, cached);
  }
  return cached;
}

export function execSecurity(bin = SECURITY_BIN): (args: string[], timeoutMs: number) => Promise<string> {
  return async (args, timeoutMs) => {
    const { stdout } = await execFileAsync(bin, args, { timeout: timeoutMs });
    return stdout;
  };
}

const defaultSecurity = execSecurity();

export function isClaudeQuotaRateLimit(rateLimit: unknown): boolean {
  if (!isRecord(rateLimit)) {
    return false;
  }
  return (
    rateLimit.status === "rejected" || rateLimit.isUsingOverage === true || rateLimit.overageInUse === true
  );
}

const USAGE_TIMEOUT_MS = 15_000;
const USAGE_ARGS = [
  "--output-format",
  "stream-json",
  "--verbose",
  "--input-format",
  "stream-json",
  "--strict-mcp-config",
  "--settings",
  '{"disableAllHooks":true}',
];
const USAGE_REQUESTS = [
  { type: "control_request", request_id: "i", request: { subtype: "initialize" } },
  { type: "control_request", request_id: "u", request: { subtype: "get_usage", skip_behaviors: true } },
].map((r) => JSON.stringify(r));
const CLAUDE_MODELS = ["haiku", "sonnet", "opus", "fable"];
const HOOKS_WARNING = "Claude usage read ran your hooks";
const EXTRA_USAGE_WARNING =
  "Claude extra usage is on: a task that crosses the limit may bill your card. schmear cancels a task as soon as Claude reports overage, but cannot stop the request in flight.";

function usedWindow(raw: unknown, kind: Window["kind"], periodHours: number): Window | null {
  if (!isRecord(raw) || typeof raw.utilization !== "number") {
    return null;
  }
  const resetsAt = typeof raw.resets_at === "string" ? Date.parse(raw.resets_at) : Number.NaN;
  return window(raw.utilization, Number.isNaN(resetsAt) ? null : resetsAt, kind, periodHours);
}

function extraUsageWarning(extra: Record<string, unknown>): string {
  const used = extra.used_credits;
  const limit = extra.monthly_limit;
  if (
    typeof used === "number" &&
    Number.isFinite(used) &&
    typeof limit === "number" &&
    Number.isFinite(limit)
  ) {
    return `Claude extra usage is on ($${(used / 100).toFixed(2)} of $${(limit / 100).toFixed(2)} this month): a task that crosses the limit may bill your card. schmear cancels a task as soon as Claude reports overage, but cannot stop the request in flight.`;
  }
  return EXTRA_USAGE_WARNING;
}

/** Maps a Claude `rate_limits` or OAuth `/api/oauth/usage` object to pools. */
export function parseClaudeLimits(limits: unknown, warnings: string[], now: number): AgentReading {
  const outWarnings = [...warnings];
  if (!isRecord(limits) || Array.isArray(limits)) {
    return unreadable("claude", "Claude reports no plan limits for this login", outWarnings, now);
  }
  const week =
    usedWindow(limits.seven_day, "period", 168) ?? usedWindow(limits.seven_day_oauth_apps, "period", 168);
  if (!week) {
    return unreadable("claude", "Claude reports no weekly limit", outWarnings, now);
  }
  const five = usedWindow(limits.five_hour, "short", 5);
  const pools: AgentPool[] = [
    { id: "claude", agent: "claude", keys: ["claude"], windows: five ? [five, week] : [week] },
  ];
  const addScoped = (name: string, w: Window | null): void => {
    const id = `claude-${name}`;
    if (!w || pools.some((p) => p.id === id)) {
      return;
    }
    const known = CLAUDE_MODELS.includes(name);
    if (!known) {
      outWarnings.push(`unknown Claude model window '${name}'`);
    }
    pools.push({ id, agent: "claude", keys: ["claude"], models: known ? [name] : undefined, windows: [w] });
  };
  addScoped("opus", usedWindow(limits.seven_day_opus, "period", 168));
  addScoped("sonnet", usedWindow(limits.seven_day_sonnet, "period", 168));
  if (Array.isArray(limits.model_scoped)) {
    for (const row of limits.model_scoped) {
      if (isRecord(row) && typeof row.display_name === "string") {
        addScoped(row.display_name.toLowerCase(), usedWindow(row, "period", 168));
      }
    }
  }
  if (Array.isArray(limits.limits)) {
    for (const row of limits.limits) {
      if (
        isRecord(row) &&
        row.group === "weekly" &&
        row.kind === "weekly_scoped" &&
        typeof row.percent === "number" &&
        Number.isFinite(row.percent) &&
        isRecord(row.scope) &&
        isRecord(row.scope.model) &&
        typeof row.scope.model.display_name === "string"
      ) {
        const name = row.scope.model.display_name.trim().toLowerCase();
        if (name && name !== "all models") {
          const resetsAt = typeof row.resets_at === "string" ? Date.parse(row.resets_at) : Number.NaN;
          addScoped(name, window(row.percent, Number.isNaN(resetsAt) ? null : resetsAt, "period", 168));
        }
      }
    }
  }
  if (isRecord(limits.extra_usage) && limits.extra_usage.is_enabled === true) {
    outWarnings.push(extraUsageWarning(limits.extra_usage));
  }
  return { agent: "claude", fetchedAt: now, pools, warnings: outWarnings };
}

/** Maps the stream-json messages of a `get_usage` exchange (§8.1) to pools. */
export function parseClaudeUsage(messages: unknown[], now: number): AgentReading {
  const warnings: string[] = [];
  if (messages.some((m) => isRecord(m) && m.type === "system" && m.subtype === "hook_started")) {
    warnings.push(HOOKS_WARNING);
  }
  const unread = (error: string): AgentReading => unreadable("claude", error, warnings, now);

  let answer: Record<string, unknown> | undefined;
  for (const m of messages) {
    if (
      isRecord(m) &&
      m.type === "control_response" &&
      isRecord(m.response) &&
      m.response.request_id === "u"
    ) {
      answer = m.response;
    }
  }
  if (!answer) {
    return unread("Claude get_usage gave no answer");
  }
  if (answer.subtype !== "success") {
    const detail = typeof answer.error === "string" ? answer.error.slice(0, 200) : String(answer.subtype);
    return unread(`Claude get_usage failed: ${detail}`);
  }
  const body = answer.response;
  const limits = isRecord(body) && body.rate_limits_available === true ? body.rate_limits : null;
  return parseClaudeLimits(limits, warnings, now);
}

function parseCredentialPayload(text: string, sourceLabel: string): ClaudeOAuthToken | Fallthrough {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // JSON.parse's message quotes the input, which holds the token.
    return { fallthrough: `${sourceLabel} is not valid JSON` };
  }
  if (!isRecord(raw) || !isRecord(raw.claudeAiOauth)) {
    return { fallthrough: NO_CREDENTIALS };
  }
  const oauth = raw.claudeAiOauth;
  if (typeof oauth.accessToken !== "string" || oauth.accessToken.trim() === "") {
    return { fallthrough: NO_CREDENTIALS };
  }
  if (!TOKEN_RE.test(oauth.accessToken)) {
    return { fallthrough: MALFORMED_TOKEN };
  }
  const accessToken = oauth.accessToken;
  const expiresAt =
    typeof oauth.expiresAt === "number" && Number.isFinite(oauth.expiresAt) ? oauth.expiresAt : undefined;
  const scopes = Array.isArray(oauth.scopes)
    ? oauth.scopes.filter((s): s is string => typeof s === "string")
    : [];
  return { accessToken, ...(expiresAt === undefined ? {} : { expiresAt }), scopes };
}

/** Reads Claude Code's OAuth token in memory per check; never logs, persists or quotes secrets in errors. */
export async function readClaudeToken(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  security: (args: string[], timeoutMs: number) => Promise<string> = defaultSecurity,
): Promise<ClaudeOAuthToken | Fallthrough> {
  const configDir = env.CLAUDE_CONFIG_DIR;
  const customProfile = Boolean(configDir);
  const credPath = customProfile
    ? join(configDir as string, ".credentials.json")
    : join(env.HOME || homedir(), ".claude", ".credentials.json");

  let fileToken: ClaudeOAuthToken | undefined;
  let fileError: Fallthrough | undefined;
  try {
    const text = await readFile(credPath, "utf8");
    const parsed = parseCredentialPayload(text, credPath);
    if ("accessToken" in parsed) {
      if (parsed.expiresAt !== undefined && parsed.expiresAt > Date.now()) {
        return parsed;
      }
      fileToken = parsed;
    } else if (parsed.fallthrough !== NO_CREDENTIALS) {
      fileError = parsed;
    }
  } catch {
    // Missing or unreadable file falls through to Keychain on darwin default profile.
  }

  if (platform === "darwin" && !customProfile) {
    let raw = "";
    try {
      raw = await security([...SECURITY_ARGS], SECURITY_TIMEOUT_MS);
    } catch {
      // Missing Keychain item, timeout or unavailable security binary falls through.
    }
    const trimmed = raw.replace(/[\r\n]+$/, "");
    if (trimmed !== "") {
      const parsed = parseCredentialPayload(trimmed, "Claude Keychain entry");
      if ("accessToken" in parsed) {
        return parsed;
      }
      if (parsed.fallthrough !== NO_CREDENTIALS && !fileToken) {
        return parsed;
      }
    }
  }

  return fileToken ?? fileError ?? { fallthrough: NO_CREDENTIALS };
}

/** Step 1: reads Claude usage via the OAuth usage endpoint; any credential, HTTP or parse failure falls through. */
export async function readClaudeOAuth(
  env: NodeJS.ProcessEnv,
  deps: ClaudeDeps,
  now: number,
  bin = "claude",
): Promise<AgentReading | Fallthrough> {
  let token: ClaudeOAuthToken | Fallthrough;
  try {
    token = await deps.readToken(env);
  } catch (err) {
    return { fallthrough: errorMessage(err) };
  }
  if ("fallthrough" in token) {
    return token;
  }
  if (!TOKEN_RE.test(token.accessToken)) {
    return { fallthrough: MALFORMED_TOKEN };
  }
  if (token.expiresAt === undefined || token.expiresAt <= now) {
    return { fallthrough: "Claude OAuth token expired" };
  }
  if (!token.scopes.includes("user:profile")) {
    return { fallthrough: "Claude OAuth token lacks user:profile" };
  }
  let rawVersion: string | undefined;
  if (deps.version) {
    try {
      rawVersion = await deps.version(bin, env);
    } catch {
      rawVersion = undefined;
    }
  }
  const version = normalizeClaudeVersion(rawVersion);
  let res: Response;
  try {
    res = await deps.fetch(OAUTH_USAGE_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        Accept: "application/json",
        "anthropic-beta": OAUTH_BETA_HEADER,
        "User-Agent": `claude-cli/${version} (external, cli)`,
      },
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
    });
  } catch (err) {
    return { fallthrough: errorMessage(err) };
  }
  if (res.status === 401) {
    return { fallthrough: "Claude OAuth request unauthorized" };
  }
  if (res.status === 429) {
    return { fallthrough: "Claude OAuth rate limited" };
  }
  if (res.status !== 200) {
    return { fallthrough: `Claude OAuth HTTP ${res.status}` };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { fallthrough: "Claude OAuth response was invalid" };
  }
  if (!isRecord(body) || Array.isArray(body)) {
    return { fallthrough: "Claude OAuth response was invalid" };
  }
  const reading = parseClaudeLimits(body, [], now);
  if (reading.error) {
    return { fallthrough: reading.error };
  }
  return { ...reading, source: "oauth" };
}

export const claudeDeps: ClaudeDeps = {
  readToken: (env) => readClaudeToken(env),
  fetch,
  cli: (bin, env) => readClaudeUsage(bin, undefined, env),
  version: detectClaudeVersion,
};

/** `get_usage` first, falling back to the OAuth usage endpoint when the CLI read fails; never throws. */
export async function readClaude(
  bin: string,
  deps: ClaudeDeps = claudeDeps,
  env?: Record<string, string>,
): Promise<AgentReading> {
  let cli: AgentReading;
  try {
    cli = await deps.cli(bin, env);
  } catch (err) {
    cli = unreadable("claude", `Claude get_usage failed: ${errorMessage(err)}`, [], Date.now());
  }
  if (!cli.error) {
    return { ...cli, source: "cli" };
  }
  const oauth = await readClaudeOAuth({ ...process.env, ...env }, deps, Date.now(), bin);
  if (!("fallthrough" in oauth) && !oauth.error) {
    return oauth;
  }
  return {
    ...cli,
    error: `${cli.error} (OAuth: ${"fallthrough" in oauth ? oauth.fallthrough : oauth.error})`,
  };
}

/** Spawns `bin` for one token-free `get_usage` exchange (§8.1); never throws, never writes a user message. */
export async function readClaudeUsage(
  bin: string,
  timeoutMs = USAGE_TIMEOUT_MS,
  env?: Record<string, string>,
): Promise<AgentReading> {
  const messages: unknown[] = [];
  let failure: string | undefined;
  try {
    const dir = stateDir();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const outcome = await lineExchange(
      bin,
      USAGE_ARGS,
      { env: workerEnv(env), cwd: dir, timeoutMs, start: USAGE_REQUESTS },
      (line) => {
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          return undefined;
        }
        messages.push(message);
        const answered =
          isRecord(message) &&
          message.type === "control_response" &&
          isRecord(message.response) &&
          message.response.request_id === "u";
        return answered ? { value: undefined } : undefined;
      },
    );
    if (outcome.status === "timeout") {
      failure = `Claude get_usage timed out after ${timeoutMs / 1000} s`;
    }
  } catch (err) {
    failure = `Claude get_usage could not start: ${errorMessage(err)}`;
  }
  const reading = parseClaudeUsage(messages, Date.now());
  return failure ? { ...reading, pools: [], error: failure } : reading;
}

/** The env var a credit lane's key (§13) reaches the worker in. */
const CREDIT_KEY_ENV = "ANTHROPIC_API_KEY";

/** A credit lane's launch: its key in this spawn's env and the reserved budget B as the SDK's `maxBudgetUsd` (§13). */
export const creditSpec = (spec: LaunchSpec, key: string, budgetUsd: number): LaunchSpec => ({
  ...spec,
  env: { ...spec.env, [CREDIT_KEY_ENV]: key },
  sessionMeta: { claudeCode: { options: { maxBudgetUsd: budgetUsd } } },
});

/** The vendor's credit exhaustion error (§13 absolute stop c). */
export const creditExhausted = (f: WorkerFailure): boolean =>
  (isRecord(f.data) && f.data.errorKind === "billing_error") || /credit balance is too low/i.test(f.message);

/**
 * The SDK's `maxBudgetUsd` stop: claude-agent-acp sends the result's `errors` ("Reached maximum budget ($B)"), else its
 * subtype; without `is_error` it is stop reason `max_turn_requests`, which only a budget can cause, as schmear sets
 * no turn limit (result-end.js:31–58).
 */
export const budgetStopped = (run: WorkerRun): boolean =>
  run.failure
    ? /Reached maximum budget|error_max_budget_usd/.test(run.failure.message)
    : run.stopReason === "max_turn_requests";

export const claudeAdapter: AgentAdapter = {
  id: "claude",
  home: { env: "CLAUDE_CONFIG_DIR", login: ["auth", "login"] },

  isClient(clientName: string): boolean {
    return clientName === "claude-code";
  },

  async find(
    bin: string,
    overlay?: Record<string, string>,
  ): Promise<{ version: string; plan?: string; email?: string } | { error: string }> {
    const env = workerEnv(overlay);
    let version: string;
    let status: unknown;
    try {
      const [line, auth] = await Promise.all([
        versionLine(bin, env),
        execFileAsync(bin, ["auth", "status", "--json"], { env, timeout: DETECT_TIMEOUT_MS }),
      ]);
      version = line;
      status = JSON.parse(auth.stdout);
    } catch (err) {
      return { error: errorMessage(err) };
    }
    if (!isRecord(status) || status.loggedIn !== true) {
      return { error: "claude is not logged in" };
    }
    if (status.authMethod !== "claude.ai") {
      return { error: `claude needs a claude.ai login, not ${JSON.stringify(status.authMethod)}` };
    }
    if (status.apiKeySource) {
      return {
        error: `claude uses an API key from ${JSON.stringify(status.apiKeySource)}, which workers would bill`,
      };
    }
    return {
      version,
      ...(typeof status.planTier === "string" ? { plan: status.planTier } : {}),
      ...(typeof status.email === "string" ? { email: status.email } : {}),
    };
  },

  readUsage(bin: string, env?: Record<string, string>): Promise<AgentReading> {
    return readClaude(bin, undefined, env);
  },

  async launch(lane: Lane, _cwd: string, bin: string, env?: Record<string, string>): Promise<LaunchSpec> {
    return {
      command: process.execPath,
      args: [await adapterBin("@agentclientprotocol/claude-agent-acp", "claude-agent-acp")],
      env: workerEnv({ ...env, CLAUDE_CODE_EXECUTABLE: bin }),
      config: { model: lane.model, effort: lane.effort },
      requireAuth:
        lane.key === "claude-credits" ? { kind: "api_key", detail: CREDIT_KEY_ENV } : { kind: "account" },
    };
  },

  quotaRateLimit: isClaudeQuotaRateLimit,

  classifyFailure(f: WorkerFailure): "quota" | "failed" {
    if (f.code === -32603 && isRecord(f.data)) {
      if (f.data.errorKind === "billing_error") {
        return "quota";
      }
      if (
        f.data.errorKind === "rate_limit" &&
        isRecord(f.data.rateLimit) &&
        f.data.rateLimit.status === "rejected"
      ) {
        return "quota";
      }
    }
    if (isClaudeQuotaRateLimit(f.rateLimit)) {
      return "quota";
    }
    return "failed";
  },
};
