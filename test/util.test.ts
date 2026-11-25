import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { run, slug } from "../src/util.ts";

describe("run", () => {
  it("returns the exit code and stdout", async () => {
    const out = await run(process.execPath, ["-e", "process.stdout.write('hi'); process.exit(3)"]);
    assert.deepEqual(out, { code: 3, stdout: "hi" });
  });

  it("passes input on stdin and closes it", async () => {
    const out = await run(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], "secret\n");
    assert.deepEqual(out, { code: 0, stdout: "secret\n" });
  });

  it("discards stderr", async () => {
    const out = await run(process.execPath, ["-e", "console.error('noise')"]);
    assert.deepEqual(out, { code: 0, stdout: "" });
  });

  it("reports a signal as a null code", async () => {
    const out = await run(process.execPath, ["-e", "process.kill(process.pid, 'SIGKILL')"]);
    assert.equal(out.code, null);
  });

  it("rejects when the binary is missing", async () => {
    await assert.rejects(run("/nonexistent/schmear-test-binary", []), { code: "ENOENT" });
  });
});

describe("slug", () => {
  it("lowercases and collapses runs to a dash", () => {
    assert.equal(slug("Acme  Corp, Inc."), "acme-corp-inc");
  });

  it("trims leading dashes and caps at 32 without a trailing dash", () => {
    assert.equal(slug("--Hello"), "hello");
    assert.equal(slug(`${"a".repeat(31)} b`), "a".repeat(31));
    assert.equal(slug("x".repeat(40)).length, 32);
  });

  it("is empty when nothing survives", () => {
    assert.equal(slug("!!!"), "");
  });
});
