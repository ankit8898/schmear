import { randomBytes } from "node:crypto";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { DEFAULT_TIERS, parseTiers } from "./tiers.ts";
import {
  AGENT_ID_SET,
  type AgentId,
  type Config,
  type CreditPoolConfig,
  DEFAULT_ACCOUNT,
  instanceId,
  keyId,
  LANE_KEYS,
  type LaneKey,
  parseInstance,
  type UsageReading,
} from "./types.ts";
import { errorMessage, isRecord } from "./util.ts";

export const USAGE_SHOW_MS = 60_000; // the usage tool and init
export const USAGE_ROUTE_MS = 300_000; // delegate routing
export const DEFAULT_MAX_TASKS = 50; // tasks one delegate call may carry
const OFFERED_TTL_MS = 24 * 3_600_000;

export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "schmear");
}

/** Where schmear keeps the logins it creates for added subscriptions and the installed adapter trees. */
export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "schmear");
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "schmear", "config.json");
}

/**
 * `mode` keeps a rewritten host config's permissions (it can hold secrets); schmear's own files default to 0600 and
 * the directories it creates to 0700. Renames onto the symlink's target, so a dotfile manager's symlink stays a symlink.
 */
export async function writeAtomic(path: string, data: string, mode = 0o600): Promise<void> {
  const target = await realpath(path).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") {
      return path;
    }
    throw err;
  });
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, data, { mode });
  await rename(tmp, target);
}

function usagePath(instance: string): string {
  return join(stateDir(), "usage", `${instance}.json`);
}

/** The cached reading when younger than maxAgeMs (a failed one at most USAGE_SHOW_MS), else read() cached (failed ones too); 0 always reads. */
export async function usage(
  instance: string, // instance id: `claude@default`, `claude@work`
  read: () => Promise<UsageReading>,
  maxAgeMs: number,
  now = Date.now(),
): Promise<UsageReading> {
  if (maxAgeMs > 0) {
    try {
      const cached = JSON.parse(await readFile(usagePath(instance), "utf8")) as UsageReading;
      // A failed reading never routes, so no quota outcome would reread it.
      const maxAge = cached.error === undefined ? maxAgeMs : Math.min(maxAgeMs, USAGE_SHOW_MS);
      if (now - cached.fetchedAt < maxAge) {
        return cached;
      }
    } catch {
      // missing or unreadable cache: reread
    }
  }
  const reading = await read();
  await writeAtomic(usagePath(instance), JSON.stringify(reading));
  return reading;
}

function offeredPath(keyId: string): string {
  return join(stateDir(), "offered", `${keyId}.json`);
}

/** The models the key id offered at its last run; undefined when unknown or older than 24 h. */
export async function readOffered(keyId: string, now = Date.now()): Promise<string[] | undefined> {
  try {
    const { fetchedAt, models } = JSON.parse(await readFile(offeredPath(keyId), "utf8")) as {
      fetchedAt: number;
      models: string[];
    };
    return now - fetchedAt < OFFERED_TTL_MS ? models : undefined;
  } catch {
    return undefined;
  }
}

export async function writeOffered(keyId: string, models: string[], now = Date.now()): Promise<void> {
  await writeAtomic(offeredPath(keyId), JSON.stringify({ fetchedAt: now, models }));
}

const AgentConfigSchema = z.object({
  consent: z.boolean(),
  path: z.string().min(1),
  home: z.string().refine(isAbsolute, "must be an absolute path").optional(), // an account's login dir
});

/** 0.1.x configs key the default login by the bare agent id; reads it as `<agent>@default`. */
const AgentsSchema = z.preprocess(
  (agents, ctx) => {
    if (!isRecord(agents)) return agents;
    const out: Record<string, unknown> = {};
    for (const [id, entry] of Object.entries(agents)) {
      const renamed = AGENT_ID_SET.has(id) ? instanceId(id as AgentId, DEFAULT_ACCOUNT) : id;
      if (renamed in agents && renamed !== id) {
        ctx.addIssue({
          code: "custom",
          message: `"${id}" and "${renamed}" are the same subscription; keep one`,
        });
      }
      out[renamed] = entry;
    }
    return out;
  },
  z.record(z.string(), AgentConfigSchema), // keys are instance ids
);

const COUNT_RULE = "must be a whole number of at least 1";

/** ~/.config/schmear/config.json. `credits` is checked only as an object here: an invalid entry skips only its pool when read (§13). */
export const ConfigSchema = z
  .strictObject({
    version: z.literal(1),
    agents: AgentsSchema,
    tiers: z.custom<string[][]>().optional(), // replaces DEFAULT_TIERS whole (§9.1)
    reserve: z.custom<Partial<Record<AgentId, number>>>().optional(), // per-driver reserve fraction (§9.2)
    maxTasks: z.int(COUNT_RULE).min(1, COUNT_RULE).optional(), // replaces DEFAULT_MAX_TASKS (§12)
    maxPerPool: z.int(COUNT_RULE).min(1, COUNT_RULE).optional(), // replaces DEFAULT_MAX_PER_POOL (§9.2)
    credits: z
      .custom<Record<string, CreditPoolConfig>>((v) => isRecord(v) && !Array.isArray(v), "must be an object")
      .optional(), // §13
  })
  .superRefine(({ agents, tiers, reserve }, ctx) => {
    // Root-level issues, so their messages print without a path prefix.
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    for (const [id, entry] of Object.entries(agents)) {
      const instance = parseInstance(id);
      if (!instance) return fail(`agents: unknown agent or bad account name "${id}"`);
      const isDefault = instance.account === DEFAULT_ACCOUNT;
      if (!isDefault && entry.home === undefined)
        return fail(`agents.${id}: an added subscription needs "home"`);
      if (isDefault && entry.home !== undefined) {
        return fail(`agents.${id}: "home" is only for an added subscription (${instance.agent}@<nickname>)`);
      }
    }
    if (tiers !== undefined) {
      try {
        parseTiers(tiers);
      } catch (err) {
        fail(errorMessage(err));
      }
    }
    if (reserve === undefined) return;
    if (!isRecord(reserve) || Array.isArray(reserve)) return fail("reserve must be an object");
    for (const [id, value] of Object.entries(reserve)) {
      if (!AGENT_ID_SET.has(id)) return fail(`reserve: unknown agent "${id}"`);
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value >= 1) {
        return fail(`reserve.${id} must be a fraction from 0 to 1, e.g. 0.05 for 5%`);
      }
    }
  });

export async function readConfig(): Promise<Config> {
  const path = configPath();
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, agents: {} };
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`malformed config ${path}: ${errorMessage(err)}`);
  }
  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    const [issue] = result.error.issues;
    const at = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
    throw new Error(`malformed config ${path}: ${at}${issue.message}`);
  }
  return result.data;
}

export interface TiersDoc {
  version: 1;
  source: "default" | "config";
  maxTasks: number; // the limit in effect
  tiers: string[][];
  defaults: string[][];
  laneKeys: LaneKey[];
  offered: Partial<Record<LaneKey, string[]>>;
}

export async function readTiers(): Promise<TiersDoc> {
  const { tiers, maxTasks } = await readConfig();
  const offered: TiersDoc["offered"] = {};
  for (const key of LANE_KEYS) {
    const models = await readOffered(keyId(key, DEFAULT_ACCOUNT));
    if (models) offered[key] = models;
  }
  return {
    version: 1,
    source: tiers ? "config" : "default",
    maxTasks: maxTasks ?? DEFAULT_MAX_TASKS,
    tiers: tiers ?? DEFAULT_TIERS,
    defaults: DEFAULT_TIERS,
    laneKeys: [...LANE_KEYS],
    offered,
  };
}

/** null removes `tiers`, restoring the default. */
export async function writeTiers(tiers: unknown): Promise<void> {
  const { tiers: _old, ...rest } = await readConfig();
  if (tiers !== null) parseTiers(tiers);
  const next = tiers === null ? rest : { ...rest, tiers };
  await writeAtomic(configPath(), `${JSON.stringify(next, null, 2)}\n`);
}

/** null removes the key, restoring its default. */
export async function writeLimit(key: "maxTasks" | "maxPerPool", n: number | null): Promise<void> {
  const { [key]: _old, ...rest } = await readConfig();
  if (n !== null && !(Number.isInteger(n) && n >= 1)) {
    throw new Error(`${key === "maxTasks" ? "max-tasks" : "max-per-pool"} ${COUNT_RULE}`);
  }
  const next = n === null ? rest : { ...rest, [key]: n };
  await writeAtomic(configPath(), `${JSON.stringify(next, null, 2)}\n`);
}
