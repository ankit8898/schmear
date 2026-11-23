import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile, rename, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { stateDir } from "./state.ts";
import { AGENT_IDS, type AgentId, type TaskResult } from "./types.ts";

const TaskLineSchema = z.object({
  at: z.number(),
  id: z.string().min(1),
  pid: z.number(),
  driver: z.enum(AGENT_IDS).nullable(),
  description: z.string(),
  tier: z.number(),
  cwd: z.string(),
  lane: z.string().nullable(),
  effort: z.string().optional(),
  status: z.enum(["running", "done", "failed", "cancelled", "no_quota"]),
  costUsd: z.number().optional(),
});

/** A task's full current state; the last line per `id` wins, the first gives `startedAt`. */
export type TaskLine = {
  at: number;
  id: string;
  pid: number;
  driver: AgentId | null;
  description: string;
  tier: number;
  cwd: string;
  lane: string | null;
  effort?: string;
  status: "running" | TaskResult["status"];
  costUsd?: number;
};

export type TaskRow = Omit<TaskLine, "at" | "pid" | "status"> & {
  startedAt: number;
  endedAt?: number;
  status: TaskLine["status"] | "lost";
};

const run = promisify(execFile);
const ROTATE_BYTES = 1 << 20;

const tasksPath = (): string => join(stateDir(), "tasks.jsonl");

const missing = (err: unknown): boolean => (err as NodeJS.ErrnoException).code === "ENOENT";

/** One `O_APPEND` write per line, so concurrent servers keep lines whole. Rotation is unlocked: a rare race at the boundary can lose the newest lines. */
export async function appendTask(line: TaskLine): Promise<void> {
  await mkdir(dirname(tasksPath()), { recursive: true, mode: 0o700 });
  try {
    if ((await stat(tasksPath())).size >= ROTATE_BYTES) await rename(tasksPath(), `${tasksPath()}.1`);
  } catch (err) {
    if (!missing(err)) throw err;
  }
  await appendFile(tasksPath(), `${JSON.stringify(line)}\n`, { mode: 0o600 });
}

function taskLine(text: string, file: string, n: number): TaskLine {
  let l: unknown;
  try {
    l = JSON.parse(text);
  } catch {
    throw new Error(`task log ${file} line ${n}: not JSON`);
  }
  const result = TaskLineSchema.safeParse(l);
  if (!result.success)
    throw new Error(
      `task log ${file} line ${n}: ${String(result.error.issues[0].path[0] ?? "not an object")}`,
    );
  return result.data;
}

/** Complete lines of one log file; none when it is absent. */
async function readLines(path: string): Promise<TaskLine[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if (missing(err)) return [];
    throw err;
  }
  const end = text.lastIndexOf("\n");
  if (end < 0) return [];
  return text
    .slice(0, end)
    .split("\n")
    .map((l, i) => taskLine(l, basename(path), i + 1));
}

/** Seconds from `ps -o etime=` output, `[[dd-]hh:]mm:ss`; null when unparseable. */
export function etimeSeconds(out: string): number | null {
  const m = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(out.trim());
  if (!m) return null;
  const [d, h, min, s] = [m[1] ?? 0, m[2] ?? 0, m[3], m[4]].map(Number);
  return ((d * 24 + h) * 60 + min) * 60 + s;
}

/** Start time of `pid` in epoch ms, or null when no such process. `ps` rounds elapsed time down to a second. */
async function startedAt(pid: number, now: number): Promise<number | null> {
  try {
    const { stdout } = await run("ps", ["-o", "etime=", "-p", String(pid)], {
      env: { ...process.env, LC_ALL: "C" },
    });
    const elapsed = etimeSeconds(stdout);
    return elapsed === null ? null : now - elapsed * 1000;
  } catch {
    return null; // ps exits non-zero for a missing pid
  }
}

/** Newest `startedAt` first; rows last written at or after `sinceMs`, or still running (a lost row ages out like a finished one). Complete lines only. */
export async function readTasks(sinceMs: number): Promise<TaskRow[]> {
  const now = Date.now();
  // Current file first: a rotation between the reads then duplicates lines (absorbed by the merge) instead of losing the rotated file.
  const current = await readLines(tasksPath());
  const lines = [...(await readLines(`${tasksPath()}.1`)), ...current];
  const byId = new Map<string, { first: TaskLine; last: TaskLine }>();
  for (const line of lines) byId.set(line.id, { first: byId.get(line.id)?.first ?? line, last: line });
  const rows = await Promise.all(
    [...byId.values()].map(async ({ first, last }): Promise<TaskRow | null> => {
      const { at, pid, status: logged, ...rest } = last;
      let status: TaskRow["status"] = logged;
      if (logged === "running") {
        const started = await startedAt(pid, now);
        if (started === null || started > at + 1000) status = "lost";
      }
      if (at < sinceMs && status !== "running") return null;
      return { ...rest, startedAt: first.at, ...(logged === "running" ? {} : { endedAt: at }), status };
    }),
  );
  return rows.filter((r) => r !== null).sort((a, b) => b.startedAt - a.startedAt);
}
