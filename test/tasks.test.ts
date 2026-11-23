import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFile, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { appendTask, etimeSeconds, readTasks, type TaskLine } from "../src/tasks.ts";

const saved = process.env.XDG_STATE_HOME;
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "schmear-tasks-"));
  process.env.XDG_STATE_HOME = dir;
});
afterEach(() => {
  if (saved === undefined) {
    delete process.env.XDG_STATE_HOME;
  } else {
    process.env.XDG_STATE_HOME = saved;
  }
});

const file = () => join(dir, "schmear", "tasks.jsonl");
const padded = "x".repeat(1 << 20);
const line = (
  at: number,
  id: string,
  status: TaskLine["status"],
  extra: Partial<TaskLine> = {},
): TaskLine => ({
  at,
  id,
  pid: process.pid,
  driver: "claude",
  description: `task ${id}`,
  tier: 1,
  cwd: "/w",
  lane: "codex",
  status,
  ...extra,
});

describe("readTasks", () => {
  it("returns nothing without a log", async () => {
    assert.deepEqual(await readTasks(0), []);
  });

  it("takes the last line per id and startedAt from the first", async () => {
    await appendTask(line(10, "a", "running", { lane: "codex", effort: "low" }));
    await appendTask(line(20, "a", "running", { lane: "grok", effort: "high" }));
    await appendTask(line(30, "a", "done", { lane: "grok", effort: "high", costUsd: 0.5 }));
    assert.deepEqual(await readTasks(0), [
      {
        id: "a",
        driver: "claude",
        description: "task a",
        tier: 1,
        cwd: "/w",
        lane: "grok",
        effort: "high",
        costUsd: 0.5,
        startedAt: 10,
        endedAt: 30,
        status: "done",
      },
    ]);
  });

  it("shows a running row of a live pid as running, without endedAt", async () => {
    await appendTask(line(Date.now(), "a", "running"));
    const [row] = await readTasks(0);
    assert.equal(row?.status, "running");
    assert.equal("endedAt" in (row ?? {}), false);
  });

  it("shows a running row whose live pid started after the line as lost", async () => {
    await appendTask(line(1, "a", "running"));
    assert.equal((await readTasks(0))[0]?.status, "lost");
  });

  it("shows a running row of a dead pid as lost", async () => {
    const pid = spawnSync(process.execPath, ["-e", ""]).pid;
    await appendTask(line(10, "a", "running", { pid }));
    const [row] = await readTasks(0);
    assert.equal(row?.status, "lost");
    assert.equal("endedAt" in (row ?? {}), false);
  });

  it("skips a trailing partial line", async () => {
    await appendTask(line(10, "a", "done"));
    await appendFile(file(), '{"at":20,"id":"b","pi');
    assert.deepEqual(
      (await readTasks(0)).map((r) => r.id),
      ["a"],
    );
  });

  it("throws on a complete bad line, naming it and the first invalid field", async () => {
    await appendTask(line(10, "a", "done"));
    for (const [text, why] of [
      ["nope", "not JSON"],
      ["null", "not an object"],
      [JSON.stringify({ ...line(1, "b", "done"), tier: "1" }), "tier"],
      [JSON.stringify({ ...line(1, "", "done") }), "id"],
      [JSON.stringify({ ...line(1, "b", "done"), status: "lost" }), "status"],
    ] as const) {
      await appendFile(file(), `${text}\n`);
      await assert.rejects(readTasks(0), { message: `task log tasks.jsonl line 2: ${why}` });
      await writeFile(file(), `${JSON.stringify(line(10, "a", "done"))}\n`);
    }
  });

  it("keeps rows ended at or after since, and still-running ones", async () => {
    await appendTask(line(10, "old", "done"));
    await appendTask(line(20, "new", "done"));
    await appendTask(line(Date.now(), "run", "running"));
    assert.deepEqual(
      (await readTasks(20)).map((r) => r.id),
      ["run", "new"],
    );
  });

  it("drops a lost row older than since", async () => {
    const pid = spawnSync(process.execPath, ["-e", ""]).pid;
    await appendTask(line(10, "gone", "running", { pid }));
    await appendTask(line(30, "fresh", "running", { pid }));
    assert.deepEqual(
      (await readTasks(20)).map((r) => [r.id, r.status]),
      [["fresh", "lost"]],
    );
  });

  it("orders newest startedAt first", async () => {
    await appendTask(line(10, "a", "done"));
    await appendTask(line(20, "b", "done"));
    await appendTask(line(30, "a", "done"));
    assert.deepEqual(
      (await readTasks(0)).map((r) => r.id),
      ["b", "a"],
    );
  });
});

describe("rotation", () => {
  it("rotates on the append after the log reaches 1 MiB", async () => {
    await appendTask(line(10, "a", "done", { description: padded }));
    assert.ok((await stat(file())).size >= 1 << 20);
    await appendTask(line(20, "b", "done"));
    assert.equal((await readFile(`${file()}.1`, "utf8")).includes('"id":"a"'), true);
    assert.equal(await readFile(file(), "utf8"), `${JSON.stringify(line(20, "b", "done"))}\n`);
  });

  it("does not rotate a smaller log", async () => {
    await appendTask(line(10, "a", "done"));
    await appendTask(line(20, "b", "done"));
    await assert.rejects(stat(`${file()}.1`), { code: "ENOENT" });
  });

  it("replaces an old .1 on the next rotation", async () => {
    await appendTask(line(10, "a", "done", { description: padded }));
    await appendTask(line(20, "b", "done", { description: padded }));
    await appendTask(line(30, "c", "done"));
    assert.deepEqual(
      (await readTasks(0)).map((r) => r.id),
      ["c", "b"],
    );
  });

  it("reads .1 then the current file, keeping startedAt from the rotated first line", async () => {
    const at = Date.now();
    await appendTask(line(at, "a", "running", { description: padded }));
    await appendTask(line(at + 10, "a", "done"));
    await appendTask(line(at + 20, "b", "done"));
    assert.deepEqual(
      (await readTasks(0)).map((r) => [r.id, r.startedAt]),
      [
        ["b", at + 20],
        ["a", at],
      ],
    );
  });

  it("names the file in a parse error", async () => {
    await appendTask(line(10, "a", "done"));
    await writeFile(`${file()}.1`, `${JSON.stringify(line(1, "b", "done"))}\nnope\n`);
    await assert.rejects(readTasks(0), { message: "task log tasks.jsonl.1 line 2: not JSON" });
  });
});

describe("etimeSeconds", () => {
  it("parses [[dd-]hh:]mm:ss", () => {
    assert.equal(etimeSeconds("05:07"), 307);
    assert.equal(etimeSeconds("  03:05:07\n"), 11107);
    assert.equal(etimeSeconds("2-03:05:07"), 2 * 86400 + 11107);
  });

  it("rejects empty and malformed output", () => {
    assert.equal(etimeSeconds(""), null);
    assert.equal(etimeSeconds("5"), null);
  });
});
