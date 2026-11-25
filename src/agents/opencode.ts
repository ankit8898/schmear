import { mkdir } from "node:fs/promises";
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
} from "../types.ts";
import { errorMessage, execFileAsync, firstLine, isRecord, unreadable, versionLine } from "../util.ts";
import { window } from "./shared.ts";

export const OPENCODE_GO_PREFIX = "opencode-go/";

const USAGE_ARGS = ["api", "--standalone", "GET", "/api/experimental/usage/limits"];
const USAGE_TIMEOUT_MS = 30_000;
// Go's monthly window resets at the paid period's renewal (opencode console/go.mdx "Usage limits").
const METERS: Array<[name: "rolling" | "weekly" | "monthly", kind: Window["kind"], hours: number]> = [
  ["rolling", "short", 5],
  ["weekly", "period", 168],
  ["monthly", "period", 720],
];
// opencode's session error names for a spent Go limit or balance (packages/core/src/session/to-session-error.ts).
const QUOTA_ERRORS = new Set([
  "provider.go-limit",
  "provider.quota",
  "provider.budget-limit",
  "provider.model-budget-limit",
]);
const QUOTA_RE = /usage limit reached|insufficient (balance|account funds)/i;
// Zen (provider `opencode`) bills the pay-as-you-go balance; the model pin in launch is the guard that holds.
const ZEN_DENY = [{ action: "provider.use", resource: "opencode", effect: "deny" }];

/** `${XDG_CONFIG_HOME:-~/.config}/opencode`; `env` overlays the process env. */
export const opencodeConfigDir = (env?: Record<string, string>): string =>
  join(env?.XDG_CONFIG_HOME || process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode");

/** `opencode api --standalone GET /api/experimental/usage/limits` stdout: `{data: UsageLimits.Info | null}`. */
export function parseOpencodeUsage(stdout: string, now: number): AgentReading {
  const fail = (error: string): AgentReading => unreadable("opencode", error, [], now);
  let answer: unknown;
  try {
    answer = JSON.parse(stdout);
  } catch {
    return fail("opencode usage answer was invalid");
  }
  if (!isRecord(answer) || !("data" in answer)) return fail("opencode usage answer was invalid");
  if (answer.data === null) {
    return fail("opencode is not signed in to OpenCode Console (run `opencode auth login`)");
  }
  const go = isRecord(answer.data) ? answer.data.go : undefined;
  if (!isRecord(go)) return fail("the signed-in OpenCode Console workspace has no Go subscription");
  const windows: Window[] = [];
  for (const [name, kind, hours] of METERS) {
    const m = go[name];
    if (
      !isRecord(m) ||
      typeof m.percent !== "number" ||
      !Number.isFinite(m.percent) ||
      m.percent < 0 ||
      m.percent > 100 ||
      typeof m.resetsAt !== "number" ||
      !Number.isFinite(m.resetsAt) ||
      typeof m.limited !== "boolean"
    ) {
      return fail(`opencode usage window ${name} is malformed`);
    }
    windows.push(window(m.limited ? 100 : m.percent, m.resetsAt, kind, hours));
  }
  const pool: AgentPool = { id: "opencode-go", agent: "opencode", keys: ["opencode-go"], windows };
  return { agent: "opencode", fetchedAt: now, pools: [pool], warnings: [] };
}

/** Never throws. */
export async function readOpencodeUsage(bin: string, env?: Record<string, string>): Promise<AgentReading> {
  const fetchedAt = Date.now();
  try {
    const dir = stateDir();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const { stdout } = await execFileAsync(bin, USAGE_ARGS, {
      env: workerEnv(env),
      cwd: dir,
      timeout: USAGE_TIMEOUT_MS,
    });
    return parseOpencodeUsage(stdout, fetchedAt);
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    const line = firstLine(e.stdout ?? "") || firstLine(e.stderr ?? "") || errorMessage(err);
    return unreadable("opencode", `opencode usage read failed: ${line}`, [], fetchedAt);
  }
}

export const opencodeAdapter: AgentAdapter = {
  id: "opencode",

  isClient(clientName: string): boolean {
    return clientName === "opencode";
  },

  async find(bin: string, env?: Record<string, string>): Promise<{ version: string } | { error: string }> {
    try {
      const version = await versionLine(bin, workerEnv(env));
      const semver = /\bv(\d+)\.\S*/.exec(version);
      if (Number(semver?.[1] ?? 0) < 2) {
        return {
          error: `opencode ${semver?.[0] ?? version} is too old; schmear needs opencode 2 (brew install opencode, or npm i -g @opencode/cli)`,
        };
      }
      const reading = await readOpencodeUsage(bin, env);
      return reading.error === undefined ? { version } : { error: reading.error };
    } catch (err) {
      return { error: errorMessage(err) };
    }
  },

  readUsage(bin: string, env?: Record<string, string>): Promise<AgentReading> {
    return readOpencodeUsage(bin, env);
  },

  async launch(lane: Lane, _cwd: string, bin: string, env?: Record<string, string>): Promise<LaunchSpec> {
    if (!lane.model.startsWith(OPENCODE_GO_PREFIX)) {
      throw new Error(
        `opencode model "${lane.model}" is not an OpenCode Go model; schmear runs opencode only on ${OPENCODE_GO_PREFIX}* models`,
      );
    }
    const config = { model: lane.model, policies: ZEN_DENY };
    return {
      command: bin,
      args: ["acp"],
      env: workerEnv({ ...env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) }),
      config: { model: lane.model, effort: lane.effort },
    };
  },

  classifyFailure(f: WorkerFailure): "quota" | "failed" {
    const name = isRecord(f.data) ? f.data.errorName : undefined;
    return (typeof name === "string" && QUOTA_ERRORS.has(name)) || QUOTA_RE.test(f.message)
      ? "quota"
      : "failed";
  },
};
