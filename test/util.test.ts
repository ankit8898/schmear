import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { lineIO } from "../src/ui.ts";
import { run, slug } from "../src/util.ts";

describe("run", () => {
  it("returns the exit code, stdout and stderr", async () => {
    const out = await run(process.execPath, [
      "-e",
      "process.stdout.write('hi'); process.stderr.write('oops'); process.exit(3)",
    ]);
    assert.deepEqual(out, { code: 3, stdout: "hi", stderr: "oops" });
  });

  it("passes input on stdin and closes it", async () => {
    const out = await run(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], "secret\n");
    assert.deepEqual(out, { code: 0, stdout: "secret\n", stderr: "" });
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

describe("lineIO", () => {
  const SECRET = "sessionKey=sk-ant-sid01-secret";
  const io = lineIO(
    async () => SECRET,
    () => {},
  );
  const options = [
    { value: "a", label: "A" },
    { value: "b", label: "B" },
  ];
  const rejects = (promise: Promise<unknown>, message: string) =>
    assert.rejects(promise, (err: Error) => {
      assert.equal(err.message, message);
      return true;
    });

  it("choose names the options, never the reply", () =>
    rejects(io.choose("Pick", options, []), "invalid answer to: Pick (expected one of: a, b)"));

  it("select names the options, never the reply", () =>
    rejects(io.select("Pick", options, "a"), "invalid answer to: Pick (expected one of: a, b)"));

  it("text gives the validator's reason, never the reply", () =>
    rejects(io.text("Name", { validate: () => "too long" }), "invalid answer to: Name (too long)"));
});
