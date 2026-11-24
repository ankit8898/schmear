import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { link, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { runWorker } from "./acp.ts";
import { permit } from "./agents/permit.ts";
import { CREDIT_POOL, type CreditRun, creditReading, openCreditRun } from "./credit.ts";
import { type PoolRow, route } from "./router.ts";
import { readConfig, readOffered, stateDir, USAGE_ROUTE_MS, usage, writeOffered } from "./state.ts";
import { appendTask, type TaskLine } from "./tasks.ts";
import { agentOf, candidates, DEFAULT_TIERS, parseTiers } from "./tiers.ts";
import {
  AGENT_IDS,
  type AgentAdapter,
  type AgentId,
  type Ask,
  DEFAULT_ACCOUNT,
  type DelegateInput,
  type DelegateTask,
  instanceId,
  keyId,
  LANE_KEYS,
  type Lane,
  type LaunchSpec,
  type Offered,
  parseInstance,
  type SessionHandle,
  type TaskResult,
  type UsageReading,
} from "./types.ts";
import { errorMessage } from "./util.ts";

export const MAX_DESCRIPTION_CHARS = 80;
const MAX_STDERR_LINES = 20;
const MAX_ERROR_CHARS = 2048;
const MAX_TOTAL_REPLY_CHARS = 60_000;

interface DelegateContext {
  driver: AgentId | null;
  signal: AbortSignal;
  ask?: Ask;
}

export function formatFailureError(message: string, stderr?: string): string {
  const tail = (stderr ?? "").split(/\r?\n/).slice(-MAX_STDERR_LINES).join("\n");
  const text = tail ? `${message}\n${tail}` : message;
  if (text.length <= MAX_ERROR_CHARS) {
    return text;
  }
  const head = MAX_ERROR_CHARS / 2;
  return `${text.slice(0, head)}…${text.slice(text.length - (MAX_ERROR_CHARS - head - 1))}`;
}

function truncateReply(reply: string, limit: number): string {
  if (reply.length <= limit) {
    return reply;
  }
  const marker = (n: number): string => `[… ${n} chars omitted …]`;
  const keep = Math.max(0, limit - marker(reply.length).length);
  const head = Math.ceil(keep / 2);
  return `${reply.slice(0, head)}${marker(reply.length - keep)}${reply.slice(reply.length - (keep - head))}`;
}

function capReplies(results: TaskResult[]): void {
  const total = results.reduce((sum, item) => sum + item.reply.length, 0);
  if (total <= MAX_TOTAL_REPLY_CHARS || results.length === 0) {
    return;
  }
  const share = Math.floor(MAX_TOTAL_REPLY_CHARS / results.length);
  for (const item of results) {
    if (item.reply.length > share) {
      item.reply = truncateReply(item.reply, share);
    }
  }
}

function describeTask(task: DelegateTask): string {
  if (task.description !== undefined) {
    return task.description;
  }
  const first = task.prompt.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "";
  return first.trim().slice(0, MAX_DESCRIPTION_CHARS);
}

const HandleSchema = z
  .object({
    agent: z.enum(AGENT_IDS),
    account: z.string().default(DEFAULT_ACCOUNT), // handles issued before accounts were named lack it
    key: z.enum(LANE_KEYS),
    model: z.string().min(1),
    effort: z.string().min(1),
    tier: z.int().min(1),
    sessionId: z.string().min(1),
    cwd: z.string().min(1),
    costUsd: z.number().min(0).optional(),
  })
  .refine((h) => agentOf(h.key) === h.agent && parseInstance(instanceId(h.agent, h.account)) !== undefined);

/** The per-install key that signs session handles (§10), created on first use. */
async function sessionKey(): Promise<Buffer> {
  const path = join(stateDir(), "secret");
  try {
    return await readKey(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  // Exclusive create via link, so two processes starting at once agree on one key.
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(tmp, randomBytes(32).toString("hex"), { mode: 0o600 });
  try {
    await link(tmp, path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  } finally {
    await unlink(tmp);
  }
  return readKey(path);
}

/** A key that is not 32 bytes (an emptied or edited file) would make handles forgeable, so it is refused. */
async function readKey(path: string): Promise<Buffer> {
  const key = Buffer.from((await readFile(path, "utf8")).trim(), "hex");
  if (key.length !== 32) {
    throw new Error(
      `${path} is not a 32-byte hex key; delete it to make a new one (earlier session handles stop working)`,
    );
  }
  return key;
}

const mac = (body: string, key: Buffer): Buffer => createHmac("sha256", key).update(body).digest();

/** `<base64url JSON>.<base64url HMAC-SHA256>`. */
export async function encodeSession(h: SessionHandle): Promise<string> {
  const { agent, account, key, model, effort, tier, sessionId, cwd, costUsd } = h;
  const body = Buffer.from(
    JSON.stringify({ agent, account, key, model, effort, tier, sessionId, cwd, costUsd }),
  ).toString("base64url");
  return `${body}.${mac(body, await sessionKey()).toString("base64url")}`;
}

/** The handle `encodeSession` made with this install's key, or undefined when `session` is anything else. */
export async function decodeSession(session: string): Promise<SessionHandle | undefined> {
  const [body, signature, ...rest] = session.split(".");
  if (body === undefined || signature === undefined || rest.length > 0) {
    return undefined;
  }
  const given = Buffer.from(signature, "base64url");
  const expected = mac(body, await sessionKey());
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return undefined;
  }
  const parsed = HandleSchema.safeParse(JSON.parse(Buffer.from(body, "base64url").toString("utf8")));
  return parsed.success ? parsed.data : undefined;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Throws a tool error naming the task index; returns each task's decoded session handle. */
async function validateInput(
  input: DelegateInput,
  adapters: Partial<Record<AgentId, AgentAdapter>>,
  tierCount: number,
): Promise<(SessionHandle | undefined)[]> {
  const handles: (SessionHandle | undefined)[] = [];
  for (const [i, task] of input.tasks.entries()) {
    const fail: (reason: string) => never = (reason) => {
      throw new Error(`tasks[${i}]: ${reason}`);
    };
    if (task.prompt.trim().length === 0) {
      fail("prompt must be non-empty");
    }
    if (!isAbsolute(task.cwd)) {
      fail(`cwd must be an absolute path: ${task.cwd}`);
    }
    if (!(await isDirectory(task.cwd))) {
      fail(`cwd is not an existing directory: ${task.cwd}`);
    }
    if (task.tier > tierCount) {
      fail(`tier must be an integer from 1 to ${tierCount}`);
    }
    if (task.description !== undefined && /[\r\n]/.test(task.description)) {
      fail("description must be a single line");
    }
    for (const agent of task.agents ?? []) {
      if (!adapters[agent]) {
        fail(`unknown agent: ${agent}`);
      }
    }
    if (task.session === undefined) {
      handles.push(undefined);
    } else {
      const handle = await decodeSession(task.session);
      if (!handle || !adapters[handle.agent]) {
        fail("session is not a handle from an earlier result");
      }
      // By session id, not handle text: a resumed result returns a new handle for the same session.
      const first = handles.findIndex((h) => h?.agent === handle.agent && h.sessionId === handle.sessionId);
      if (first !== -1) {
        fail(`session already resumed by tasks[${first}]`);
      }
      if (resolve(handle.cwd) !== resolve(task.cwd)) {
        fail(`a resumed task runs in its session's cwd ${handle.cwd}`);
      }
      if (task.tier > handle.tier) {
        fail(`session ran tier ${handle.tier}; tier ${task.tier} needs a new session`);
      }
      handles.push(handle);
    }
  }
  return handles;
}

const provenance = (lane: Lane): Pick<TaskResult, "provider" | "account"> => ({
  provider: lane.agent,
  account: lane.account,
});

/** A result with no reply. */
function ended(
  description: string,
  notes: string[],
  status: "failed" | "cancelled" | "no_quota",
  error: string,
  lane?: Lane,
): TaskResult {
  return { description, status, ...(lane ? provenance(lane) : {}), reply: "", notes, error };
}

function noLane(task: DelegateTask, pools: PoolRow[]): string {
  const summary = pools
    .map((p) => `${p.id} ${p.status}${p.pace === null ? "" : ` (pace ${p.pace.toFixed(2)})`}`)
    .join("; ");
  return `no lane for tier ${task.tier}; pools: ${summary || "none"}`;
}

/** Config, the tier list, the offered lists, readers of usage, and `route()` bound to them (§10 steps 1–3). Reads no usage. */
export async function loadRouting(adapters: Partial<Record<AgentId, AgentAdapter>>) {
  const config = await readConfig();
  const tiers = parseTiers(config.tiers ?? DEFAULT_TIERS);
  // Per adapter: its default account, then its added ones in config order.
  const configured = Object.keys(config.agents).flatMap((id) => {
    const instance = parseInstance(id);
    return instance && config.agents[id]?.consent ? [{ id, ...instance }] : [];
  });
  const instances = (Object.keys(adapters) as AgentId[]).flatMap((agent) =>
    configured
      .filter((i) => i.agent === agent)
      .sort((a, b) => Number(a.account !== DEFAULT_ACCOUNT) - Number(b.account !== DEFAULT_ACCOUNT)),
  );
  const routable = instances.map((i) => i.id);
  const binOf = (instance: string): string => config.agents[instance]?.path as string;
  const envOf = (instance: string): Record<string, string> => {
    const { agent, account } = parseInstance(instance) as { agent: AgentId; account: string };
    if (account === DEFAULT_ACCOUNT) return {};
    return { [(adapters[agent] as AgentAdapter).home.env]: config.agents[instance]?.home as string };
  };
  const readings = new Map<string, UsageReading>();
  const offered: Offered = {};
  const defaultClaude = instanceId("claude", DEFAULT_ACCOUNT);
  const creditPool =
    config.credits?.overageOff === true && routable.includes(defaultClaude) ? config.credits : undefined;
  const credits = new Map<string, UsageReading>(); // by pool id
  /** The reading and its pools carry the account, and pool ids gain `@account`. */
  const read = async (instance: string, maxAgeMs: number): Promise<void> => {
    if (!routable.includes(instance)) return;
    const { agent, account } = parseInstance(instance) as { agent: AgentId; account: string };
    const adapter = adapters[agent] as AgentAdapter;
    const readAccount = async (): Promise<UsageReading> => {
      const reading = await adapter.readUsage(binOf(instance), envOf(instance));
      const pools = reading.pools.map((p) => ({ ...p, id: keyId(p.id, account), account }));
      return { ...reading, account, pools };
    };
    readings.set(instance, await usage(instance, readAccount, maxAgeMs));
    if (creditPool && instance === defaultClaude) {
      credits.set(CREDIT_POOL, await creditReading(creditPool));
    }
  };
  const tierKeys = [...new Set(tiers.flat().map((e) => e.key))];
  await Promise.all(
    instances.flatMap(({ agent, account }) =>
      tierKeys
        .filter((key) => agentOf(key) === agent)
        .map(async (key) => {
          const models = await readOffered(keyId(key, account));
          if (models) {
            offered[keyId(key, account)] = models;
          }
        }),
    ),
  );

  // The credit lane spends the default Claude login's API key, so added subscriptions never get one.
  const lanes = (tier: number, agents?: AgentId[]): Lane[] =>
    instances
      .filter(({ agent }) => !agents || agents.includes(agent))
      .flatMap(({ agent, account }) =>
        candidates(tier, tiers, offered, account).filter(
          (l) => l.agent === agent && !(account !== DEFAULT_ACCOUNT && l.key === "claude-credits"),
        ),
      );
  const routeTasks = (driver: AgentId | null, exclude: Set<string>, tasks: Lane[][]) =>
    route({
      now: Date.now(),
      driver,
      readings: [...routable.flatMap((id) => readings.get(id) ?? []), ...credits.values()],
      config,
      exclude,
      tasks,
    });
  return {
    config,
    tiers,
    offered,
    creditPool,
    routable,
    readings,
    credits,
    binOf,
    envOf,
    read,
    lanes,
    routeTasks,
  };
}

export async function delegate(
  input: DelegateInput,
  ctx: DelegateContext,
  adapters: Partial<Record<AgentId, AgentAdapter>>,
): Promise<TaskResult[]> {
  const { tiers, offered, creditPool, binOf, envOf, read, lanes, routeTasks } = await loadRouting(adapters);
  const handles = await validateInput(input, adapters, tiers.length);

  const exclude = new Set<string>();
  // A handle resumes its own lane whatever the list says now, so excluding it ends in no_quota, not a new session.
  const lanesFor = (i: number): Lane[] => {
    const h = handles[i];
    const task = input.tasks[i] as DelegateTask;
    return h
      ? [
          {
            id: `${keyId(h.key, h.account)}:${h.model}`,
            agent: h.agent,
            account: h.account,
            key: h.key,
            tier: h.tier,
            model: h.model,
            effort: h.effort,
          },
        ]
      : lanes(task.tier, task.agents);
  };
  const used = new Set(input.tasks.flatMap((_, i) => lanesFor(i).map((l) => instanceId(l.agent, l.account))));
  await Promise.all([...used].map((id) => read(id, USAGE_ROUTE_MS)));
  // Resumed tasks route alone (§10 step 4), so they are not part of the batch split.
  const freshAt = input.tasks.flatMap((_, i) => (handles[i] ? [] : [i]));
  const first = routeTasks(ctx.driver, exclude, freshAt.map(lanesFor));

  const runTask = async (
    task: DelegateTask,
    index: number,
    description: string,
    notes: string[],
    onRun: (lane: Lane) => Promise<void>,
  ): Promise<TaskResult> => {
    const handle = handles[index];
    let lane: Lane | null = first.assignments[freshAt.indexOf(index)] ?? null;
    let pools: PoolRow[] = first.pools;
    const reroute = () => {
      const routed = routeTasks(ctx.driver, exclude, [lanesFor(index)]);
      lane = routed.assignments[0] ?? null;
      pools = routed.pools;
    };
    if (handle) {
      reroute();
    }
    /** Excludes a lane id or key, rereads `reread`'s usage, reroutes and notes it; `ran` names the lane rerouted to. */
    const next = async (excluded: string, note: string, opts: { reread?: string; ran?: boolean } = {}) => {
      exclude.add(excluded);
      if (opts.reread) await read(opts.reread, 0);
      reroute();
      notes.push(opts.ran && lane ? `${note}; ran ${lane.id}` : note);
    };
    const quota = (from: Lane, excluded = from.id) =>
      next(excluded, `rerouted from ${from.id}: quota`, { reread: instanceId(from.agent, from.account) });

    for (;;) {
      if (!lane) {
        return ended(description, notes, "no_quota", noLane(task, pools));
      }
      const current: Lane = lane;
      const agentId = current.agent;
      const instance = instanceId(agentId, current.account);
      const currentKey = keyId(current.key, current.account);
      const adapter = adapters[agentId] as AgentAdapter;

      let spec: LaunchSpec;
      try {
        spec = await adapter.launch(current, task.cwd, binOf(instance), envOf(instance));
      } catch (err) {
        return ended(description, notes, "failed", formatFailureError(errorMessage(err)), current);
      }

      let credit: CreditRun | undefined;
      if (current.key === "claude-credits" && creditPool) {
        const open = await openCreditRun(creditPool, spec, ctx.signal);
        if (open === "quota") {
          await quota(current);
          continue;
        }
        if ("cancelled" in open) {
          return ended(description, notes, "cancelled", open.cancelled, current);
        }
        if ("note" in open) {
          await next(currentKey, open.note);
          continue;
        }
        credit = open;
        spec = open.spec;
      }

      const who = `${agentId} worker on '${description}'`;
      let overage = false;
      await onRun(current);
      const run = await runWorker(spec, task.cwd, task.prompt, {
        agent: agentId,
        ...(handle ? { resume: handle.sessionId } : {}),
        signal: ctx.signal,
        permit: (req, turn) => permit(req, turn, { who, ask: ctx.ask, note: (text) => notes.push(text) }),
        onRateLimit: (rateLimit, cancel) => {
          if (adapter.quotaRateLimit?.(rateLimit)) {
            overage = true;
            cancel();
          }
        },
      });

      const costUsd =
        run.costUsd === undefined ? undefined : Math.max(0, run.costUsd - (handle?.costUsd ?? 0));
      let poolStopped = false;
      if (credit) {
        const settled = await credit.settle(run, costUsd);
        poolStopped = settled.stopped;
        if (settled.note) notes.push(settled.note);
      }

      if (run.offered) {
        offered[currentKey] = run.offered;
        try {
          await writeOffered(currentKey, run.offered);
        } catch (err) {
          notes.push(`${currentKey} offered list write failed: ${errorMessage(err)}`);
        }
      }

      if (!ctx.signal.aborted) {
        const failure = run.failure;
        if (failure?.notOffered) {
          const { notOffered } = failure;
          const at = notOffered.effort === undefined ? "" : ` at ${notOffered.effort}`;
          await next(current.id, `${notOffered.model}${at} not offered by ${agentId}`, { ran: true });
          continue;
        }
        // The worker's auth belongs to the account, so every lane of the key would bill it; usage is unchanged.
        if (failure?.auth !== undefined) {
          await next(currentKey, `rerouted from ${current.id}: would bill ${failure.auth}`);
          continue;
        }
        if (overage || poolStopped || (failure && adapter.classifyFailure(failure) === "quota")) {
          // The key is dead for every model, even if the "exhausted" ledger line failed to write.
          await quota(current, poolStopped ? currentKey : current.id);
          continue;
        }
      }

      const result: TaskResult = {
        description,
        status: "done",
        ...provenance(current),
        ...(run.model !== undefined ? { model: run.model } : {}),
        ...(run.effort !== undefined ? { effort: run.effort } : {}),
        ...(run.sessionId
          ? {
              session: await encodeSession({
                agent: agentId,
                account: current.account,
                key: current.key,
                model: current.model,
                effort: current.effort,
                tier: current.tier,
                sessionId: run.sessionId,
                cwd: task.cwd,
                ...(run.costUsd !== undefined ? { costUsd: run.costUsd } : {}),
              }),
            }
          : {}),
        ...(costUsd !== undefined ? { costUsd } : {}),
        reply: run.reply,
        notes,
      };
      if (ctx.signal.aborted) {
        result.status = "cancelled";
      } else if (run.failure) {
        result.status = "failed";
        result.error = formatFailureError(run.failure.message, run.failure.stderr);
      } else if (run.stopReason !== "end_turn") {
        result.status = "failed";
        notes.push(`worker stopped: ${run.stopReason}`);
      }
      return result;
    }
  };

  // A throw fails its own task only, so the batch's other workers still return.
  const results = await Promise.all(
    input.tasks.map(async (task, index): Promise<TaskResult> => {
      const description = describeTask(task);
      const notes: string[] = [];
      const id = randomUUID();
      let ran: Lane | undefined;
      const log = async (status: TaskLine["status"], costUsd?: number): Promise<void> => {
        try {
          await appendTask({
            at: Date.now(),
            id,
            pid: process.pid,
            driver: ctx.driver,
            description,
            tier: task.tier,
            cwd: task.cwd,
            lane: ran?.id ?? null,
            ...(ran ? { effort: ran.effort } : {}),
            status,
            ...(costUsd !== undefined ? { costUsd } : {}),
          });
        } catch (err) {
          notes.push(`task log write failed: ${errorMessage(err)}`);
        }
      };
      let result: TaskResult;
      try {
        result = await runTask(task, index, description, notes, async (lane) => {
          ran = lane;
          await log("running");
        });
      } catch (err) {
        result = ended(description, notes, "failed", formatFailureError(errorMessage(err)));
      }
      await log(result.status, result.costUsd);
      return result;
    }),
  );
  capReplies(results);
  return results;
}
