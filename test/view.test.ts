import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { Snapshot } from "../src/server.ts";
import {
  plainHelp,
  type QuotaRows,
  renderError,
  renderHelp,
  renderLimit,
  renderOk,
  renderQuotas,
  renderTiers,
  renderUsage,
} from "../src/view.ts";

const now = new Date(2026, 10, 24, 12, 0).getTime();
const thu14 = new Date(2026, 10, 26, 14, 0).getTime();
const dec20 = new Date(2026, 11, 20, 0, 0).getTime();
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
      id: "claude-credits@main",
      fetchedAt: now,
      warnings: [],
      pools: [
        {
          id: "claude-credits@main",
          windows: [{ ...period(0.75, dec20), periodHours: 720 }],
          usd: { left: 150, granted: 200 },
          pace: 2.1,
          status: "ok",
        },
      ],
    },
    {
      id: "claude-credits@side",
      skipped: "Claude Console session expired; run schmear credits login claude",
      fetchedAt: now,
      warnings: [],
      pools: [{ id: "claude-credits@side", windows: [] }],
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
      "│    All models          ████░░░░░░░░  36%  5h 100% · 7d 36% · resets Thu 14:00 · pace 0.72 · ok",
      "│    Fable               █░░░░░░░░░░░  12%  7d · resets Thu 14:00 · pace — · out: period window 12%",
      "│    left, threshold 20%",
      "│    API credits (main)  █████████░░░  75%  $150 of $200 · expires Dec 20 · pace 2.10 · ok",
      "│    ▲ API credits (side): Claude Console session expired; run schmear credits login claude",
      "│  ● work",
      "│    All models          ████████████ 100%  5h 100% · 7d 100% · pace 4.80 · ok",
      "│",
      "│  Antigravity",
      "│  ● default",
      "│    Gemini              ███████░░░░░  62%  7d 62% · 5h 100% · pace 1.35 · ok",
      "│    Claude/GPT          ███████░░░░░  55%  7d · resets Fri 09:00 · pace 0.90 · ok",
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
    const plain = renderUsage(fixture, { color: false, width: 100, now });
    assert.equal(plain, expected);
    assert.equal(plain.includes("\x1b"), false);

    const colored = renderUsage(fixture, { color: true, width: 100, now });
    assert.equal(colored.includes("\x1b["), true);
    assert.equal(stripVTControlCharacters(colored), expected);
  });

  it("drops bars at width 50", () => {
    const narrow = renderUsage(fixture, { color: false, width: 50, now });
    assert.doesNotMatch(narrow, /[█░]/);
    assert.match(narrow, /^│ {4}All models {11}36% {2}5h 100% · 7d 36% ·$/m);
    assert.match(narrow, /^│ {4}API credits \(main\) {3}75% {2}\$150 of \$200 ·$/m);
  });
});

describe("renderQuotas", () => {
  it("shows plan API credit amounts on every Max Claude account and the command only with creditsHint", () => {
    const rows: QuotaRows = {
      agents: [
        {
          agent: "claude",
          name: "Claude",
          accounts: [
            {
              account: "default",
              plan: "max_20x",
              planCreditsUsd: 200,
              creditsHint: true,
              warnings: [],
              pools: [{ id: "claude@default", label: "All models", windows: [short(1), period(0.5, thu14)] }],
            },
            {
              account: "work",
              plan: "max_5x",
              planCreditsUsd: 100,
              warnings: [],
              pools: [{ id: "claude@work", label: "All models", windows: [short(1), period(1, null)] }],
            },
          ],
        },
      ],
      unused: [],
    };
    const expected = [
      "Claude",
      "● default  max_20x                          $200 API credits / month · schmear credits",
      "  All models  ██████░░░░░░  50%  5h 100% · 7d 50% · resets Thu 14:00",
      "● work     max_5x                           $100 API credits / month",
      "  All models  ████████████ 100%  5h 100% · 7d 100%",
    ].join("\n");
    const off = renderQuotas(rows, { color: false, width: 100 });
    assert.equal(off, expected);
    assert.equal(off.includes("\x1b"), false);
    assert.equal(stripVTControlCharacters(renderQuotas(rows, { color: true, width: 100 })), expected);
  });
});

const plain = (text: string) => stripVTControlCharacters(text);

describe("help, tiers, limits and errors", () => {
  it("piped help keeps the plain layout", () => {
    const help = plainHelp();
    assert.equal(help.includes("\x1b"), false);
    assert.match(help, /^schmear: delegate coding subtasks across your AI subscriptions\n\nUsage:\n/);
    assert.match(help, /^ {2}schmear init \[--yes\] {3}detect CLIs/m);
    assert.match(help, /^ {2}schmear max-per-pool <n> set it; "reset" restores the default of 10$/m);
    assert.match(help, /^ {2}schmear usage \[--json\] \[--driver <id>\]\n {25}show each/m);
    assert.match(help, /^ {2}schmear tiers \[--json\] print the tier list$/m);
    assert.match(help, /\nDocs: https:\/\/github.com\/kevin1chun\/schmear\n$/);
  });

  it("styled help is the same text with and without colour, wrapped inside the width", () => {
    const off = renderHelp({ color: false, width: 80 });
    assert.equal(off.includes("\x1b"), false);
    assert.equal(plain(renderHelp({ color: true, width: 80 })), off);
    for (const line of off.split("\n")) assert.ok(line.length <= 80, line);
    assert.match(off, /^│ {2}schmear init \[--yes\] {8}/m);
  });

  it("renders tiers one row per tier, wrapped under the label", () => {
    const tiers = [["claude:haiku@medium"], ["claude:sonnet@medium", "codex:gpt-6.1-terra@medium"]];
    const expected = [
      "┌  schmear tiers (custom)",
      "│",
      "◇  Tiers  weakest first",
      "│  Tier 1  claude:haiku@medium",
      "│  Tier 2  claude:sonnet@medium · codex:gpt-6.1-terra@medium",
      "│",
      "│  schmear tiers --json prints the list and its defaults as JSON; schmear tiers set replaces it.",
      "│",
      "└",
    ].join("\n");
    assert.equal(renderTiers(tiers, true, { color: false, width: 120 }), expected);
    assert.equal(plain(renderTiers(tiers, true, { color: true, width: 120 })), expected);
    assert.match(renderTiers(tiers, false, { color: false, width: 120 }), /^┌ {2}schmear tiers \(default\)/);
  });

  it("renders confirmations, limits and errors", () => {
    assert.equal(
      renderOk("Using the default tiers.", { color: false, width: 80 }),
      "✓ Using the default tiers.",
    );
    assert.equal(renderOk("a b c", { color: true, width: 80 }).startsWith("\x1b["), true);
    assert.equal(renderLimit(50, "tasks per call", false, false), "50 tasks per call  (default)");
    assert.equal(renderLimit(7, "tasks per call", true, false), "7 tasks per call  (custom)");
    assert.equal(renderError("run `schmear init` first", false), "✗ run schmear init first");
    assert.equal(plain(renderError("run `schmear init` first", true)), "✗ run schmear init first");
    assert.ok(renderError("run `schmear init` first", true).includes("\x1b[36mschmear init\x1b[39m"));
  });
});
