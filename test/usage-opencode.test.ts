import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseOpencodeUsage, readOpencodeUsage } from "../src/agents/opencode.ts";

const NOW = Date.parse("2026-11-21T12:00:00Z");
const dir = mkdtempSync(join(tmpdir(), "schmear-opencode-usage-"));
process.env.XDG_STATE_HOME = join(dir, "state");
after(() => rmSync(dir, { recursive: true, force: true }));

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const withGo = (go: unknown): string =>
  JSON.stringify({ data: { workspace: { id: "wrk_01" }, go, budgets: [] } });
const meter = (percent: unknown, limited: unknown = false, resetsAt: unknown = NOW + 3_600_000) => ({
  percent,
  limited,
  resetsAt,
});

describe("parseOpencodeUsage", () => {
  it("reads Go's rolling, weekly and monthly windows into one pool", () => {
    const reading = parseOpencodeUsage(fixture("opencode-usage.json"), NOW);
    assert.equal(reading.error, undefined);
    assert.deepEqual(reading.warnings, []);
    assert.equal(reading.fetchedAt, NOW);
    assert.deepEqual(reading.pools, [
      {
        id: "opencode-go",
        agent: "opencode",
        keys: ["opencode-go"],
        windows: [
          { kind: "short", remaining: 0.7, resetsAt: Date.parse("2026-11-21T15:00:00Z"), periodHours: 5 },
          { kind: "period", remaining: 0, resetsAt: Date.parse("2026-11-23T00:00:00Z"), periodHours: 168 },
          { kind: "period", remaining: 0.5, resetsAt: Date.parse("2026-12-01T00:00:00Z"), periodHours: 720 },
        ],
      },
    ]);
  });

  it("counts a limited meter as exhausted whatever its percent", () => {
    const reading = parseOpencodeUsage(
      withGo({ rolling: meter(40, true), weekly: meter(10), monthly: meter(5) }),
      NOW,
    );
    assert.equal(reading.pools[0]?.windows[0]?.remaining, 0);
    assert.equal(reading.pools[0]?.windows[1]?.remaining, 0.9);
  });

  it("is unreadable when signed out of OpenCode Console", () => {
    const reading = parseOpencodeUsage(fixture("opencode-usage-null.json"), NOW);
    assert.equal(reading.error, "opencode is not signed in to OpenCode Console (run `opencode auth login`)");
    assert.deepEqual(reading.pools, []);
  });

  it("is unreadable when the workspace has no Go", () => {
    const reading = parseOpencodeUsage(fixture("opencode-usage-no-go.json"), NOW);
    assert.equal(reading.error, "the signed-in OpenCode Console workspace has no Go subscription");
    assert.deepEqual(reading.pools, []);
  });

  it("is unreadable on a malformed meter", () => {
    const ok = meter(10);
    for (const [name, go] of [
      ["rolling", { rolling: meter(101), weekly: ok, monthly: ok }],
      ["rolling", { rolling: meter(-1), weekly: ok, monthly: ok }],
      ["weekly", { rolling: ok, weekly: meter("10"), monthly: ok }],
      ["weekly", { rolling: ok, weekly: meter(10, "no"), monthly: ok }],
      ["monthly", { rolling: ok, weekly: ok, monthly: meter(10, false, "2026-12-01") }],
      ["monthly", { rolling: ok, weekly: ok }],
    ] as const) {
      const reading = parseOpencodeUsage(withGo(go), NOW);
      assert.equal(reading.error, `opencode usage window ${name} is malformed`);
      assert.deepEqual(reading.pools, []);
    }
  });

  it("is unreadable on invalid JSON or an answer without data", () => {
    for (const stdout of ["HTTP 500", "", "{}", "[]"]) {
      assert.equal(parseOpencodeUsage(stdout, NOW).error, "opencode usage answer was invalid", stdout);
    }
  });
});

describe("readOpencodeUsage", () => {
  const fake = (body: string): string => {
    const bin = join(dir, "opencode");
    writeFileSync(bin, `#!/bin/sh\n${body}\n`);
    chmodSync(bin, 0o755);
    return bin;
  };

  it("runs `opencode api --standalone GET /api/experimental/usage/limits` in the state dir", async () => {
    const bin = fake(
      `[ "$*" = "api --standalone GET /api/experimental/usage/limits" ] && [ "$(pwd -P)" = "${join(realpathSync(dir), "state", "schmear")}" ] && [ -z "$OPENCODE_API_KEY" ] || exit 3\ncat "${fileURLToPath(new URL("./fixtures/opencode-usage.json", import.meta.url))}"`,
    );
    process.env.OPENCODE_API_KEY = "strip-me";
    try {
      const reading = await readOpencodeUsage(bin);
      assert.equal(reading.error, undefined);
      assert.equal(reading.pools[0]?.windows.length, 3);
    } finally {
      delete process.env.OPENCODE_API_KEY;
    }
  });

  it("is unreadable with the first output line when opencode exits non-zero", async () => {
    const bin = fake('echo "HTTP 401 Unauthorized"\nexit 1');
    const reading = await readOpencodeUsage(bin);
    assert.equal(reading.error, "opencode usage read failed: HTTP 401 Unauthorized");
    assert.deepEqual(reading.pools, []);
  });

  it("falls back to stderr when stdout is empty", async () => {
    const bin = fake('echo "boom" >&2\nexit 1');
    assert.equal((await readOpencodeUsage(bin)).error, "opencode usage read failed: boom");
  });
});
