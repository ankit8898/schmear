import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { Snapshot } from "../src/server.ts";
import { renderUsage } from "../src/view.ts";

const now = new Date(2026, 10, 24, 12, 0).getTime();
const thu14 = new Date(2026, 10, 26, 14, 0).getTime();
const fri09 = new Date(2026, 10, 27, 9, 0).getTime();
const period = (remaining: number, resetsAt: number | null) => ({
  kind: "period" as const,
  remaining,
  resetsAt,
  periodHours: 168,
  projectedUnused: null,
});
const short = (remaining: number) => ({
  kind: "short" as const,
  remaining,
  resetsAt: null,
  periodHours: 5,
  projectedUnused: null,
});

const fixture: Snapshot = {
  version: 1,
  cliVersion: "0.4.0",
  at: now,
  driver: "claude",
  hosts: [
    { id: "claude", status: "ok" },
    { id: "codex", status: "stale" },
  ],
  readings: [
    {
      id: "claude@default",
      fetchedAt: now,
      warnings: [],
      pools: [
        {
          id: "claude@default",
          windows: [short(1), period(0.36, thu14)],
          pace: 0.72,
          status: "ok",
        },
        {
          id: "claude-fable@default",
          windows: [period(0.12, thu14)],
          pace: null,
          status: "out: period window 12% left, threshold 20%",
        },
      ],
    },
    {
      id: "claude@work",
      fetchedAt: now,
      warnings: [],
      pools: [{ id: "claude@work", windows: [short(1), period(1, null)], pace: 4.8, status: "ok" }],
    },
    { id: "codex@default", skipped: "not configured", warnings: [], pools: [] },
    { id: "grok@default", skipped: "no consent", warnings: [], pools: [] },
    {
      id: "agy@default",
      fetchedAt: now,
      warnings: [],
      pools: [
        { id: "agy-gemini@default", windows: [period(0.62, null), short(1)], pace: 1.35, status: "ok" },
        { id: "agy-3p@default", windows: [period(0.55, fri09)], pace: 0.9, status: "ok" },
      ],
    },
    {
      id: "agy@work",
      skipped: "agy /usage timed out after 90000 ms",
      fetchedAt: now,
      warnings: [],
      pools: [],
    },
    {
      id: "claude-credits@default",
      fetchedAt: now,
      warnings: [],
      pools: [
        {
          id: "claude-credits@default",
          windows: [{ ...period(0.75, thu14), periodHours: 720 }],
          pace: 2.1,
          status: "ok",
        },
      ],
    },
  ],
  next: [
    { tier: 1, lane: "agy-gemini@default:gemini-3-flash", effort: "low" },
    { tier: 2, lane: "claude@work:fable", effort: "medium" },
    { tier: 3, lane: null },
  ],
  notOffered: ["codex@default:gpt-6.2@high (tier 3)"],
  tasks: [
    {
      id: "b",
      driver: "claude",
      description: "Review the credit ledger replay for off-by-one cycle boundaries and report each finding",
      tier: 2,
      cwd: "/repo",
      lane: "claude@work:fable",
      effort: "medium",
      startedAt: now - 95_000,
      status: "running",
    },
    {
      id: "a",
      driver: "claude",
      description: "Write tests for etimeSeconds",
      tier: 1,
      cwd: "/repo",
      lane: "agy-gemini@default:gemini-3-flash",
      effort: "low",
      startedAt: now - 3_600_000,
      endedAt: now - 3_400_000,
      status: "done",
      costUsd: 0.0421,
    },
  ],
};

describe("renderUsage", () => {
  it("renders quotas, next lanes, tasks and broken hosts at width 100 with colour off", () => {
    const expected = [
      "┌  schmear usage 0.4.0 · driver claude",
      "│",
      "◇  Quotas",
      "│  Claude",
      "│  ● default",
      "│    All models   ████░░░░░░░░  36%  5h 100% · 7d 36% · resets Thu 14:00 · pace 0.72 · ok",
      "│    Fable        █░░░░░░░░░░░  12%  7d · resets Thu 14:00 · pace — · out: period window 12% left,",
      "│    threshold 20%",
      "│    API credits  █████████░░░  75%  $150 of $200 · resets Thu 14:00 · pace 2.10 · ok",
      "│  ● work",
      "│    All models   ████████████ 100%  5h 100% · 7d 100% · pace 4.80 · ok",
      "│",
      "│  Antigravity",
      "│  ● default",
      "│    Gemini       ███████░░░░░  62%  7d 62% · 5h 100% · pace 1.35 · ok",
      "│    Claude/GPT   ███████░░░░░  55%  7d · resets Fri 09:00 · pace 0.90 · ok",
      "│  ● work",
      "│    ▲ skipped: agy /usage timed out after 90000 ms",
      "│",
      "│  Grok  not used",
      "│",
      "◇  Next",
      "│  1  → agy-gemini:gemini-3-flash  low",
      "│  2  → claude@work:fable          medium",
      "│  3  —  no lane",
      "│  not offered: codex@default:gpt-6.2@high (tier 3)",
      "│",
      "◇  Tasks  last 24 h",
      "│  ● Review the credit ledger replay for off-by-one cycle…  claude@work:fable          1m 35s",
      "│  ✓ Write tests for etimeSeconds                           agy-gemini:gemini-3-flash  3m 20s  $0.04",
      "│",
      "▲  Codex can't reach schmear: its entry is out of date. Run schmear init --yes, then restart Codex.",
      "│",
      "└",
    ].join("\n");
    const plain = renderUsage(fixture, { color: false, width: 100, now, creditGrantUsd: 200 });
    assert.equal(plain, expected);
    assert.equal(plain.includes("\x1b"), false);

    const colored = renderUsage(fixture, { color: true, width: 100, now, creditGrantUsd: 200 });
    assert.equal(colored.includes("\x1b["), true);
    assert.equal(stripVTControlCharacters(colored), expected);
  });

  it("drops bars at width 50", () => {
    const narrow = renderUsage(fixture, { color: false, width: 50, now, creditGrantUsd: 200 });
    assert.doesNotMatch(narrow, /[█░]/);
    assert.match(narrow, /^│ {4}All models {4}36% {2}5h 100% · 7d 36% · resets$/m);
  });
});
