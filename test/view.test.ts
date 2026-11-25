import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
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
        {
          id: "gemini-credits@default",
          windows: [{ ...period(0.5, dec20), periodHours: 720 }],
          usd: { left: 50, granted: 100 },
          pace: 1.1,
          status: "ok",
        },
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
  notices: [],
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
      "│    Fable        █░░░░░░░░░░░  12%  7d · resets Thu 14:00",
      "│      pace — · out: period window 12% left, threshold 20%",
      "│    API credits  █████████░░░  75%  $150 of $200 left · expires Dec 20 · pace 2.10 · ok",
      "│  ● work",
      "│    All models   ████████████ 100%  5h 100% · 7d 100% · pace 4.80 · ok",
      "│  ● side · API credits only · runs under claude@default",
      "│    ▲ API credits: Claude Console session expired; run schmear credits login claude",
      "│",
      "│  Antigravity",
      "│  ● default",
      "│    Gemini       ███████░░░░░  62%  7d 62% · 5h 100% · pace 1.35 · ok",
      "│    Claude/GPT   ███████░░░░░  55%  7d · resets Fri 09:00 · pace 0.90 · ok",
      "│    API credits  ██████░░░░░░  50%  $50 of $100 left · expires Dec 20 · pace 1.10 · ok",
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

  it("nests each credit pool under the account of its name and lists API-only pools after the accounts", () => {
    const credit = (name: string, left: number) => ({
      id: `claude-credits@${name}`,
      fetchedAt: now,
      warnings: [],
      pools: [
        {
          id: `claude-credits@${name}`,
          windows: [{ ...period(left / 200, dec20), periodHours: 720 }],
          usd: { left, granted: 200 },
        },
      ],
    });
    const account = (name: string) => ({
      id: `claude@${name}`,
      fetchedAt: now,
      warnings: [],
      pools: [{ id: `claude@${name}`, windows: [short(1)] }],
    });
    const snapshot: Snapshot = {
      ...fixture,
      readings: [
        account("default"),
        account("k1c"),
        credit("lab", 50),
        credit("k1c", 120),
        credit("default", 180),
      ],
      next: [],
      notOffered: [],
      tasks: [],
    };
    const out = stripVTControlCharacters(renderUsage(snapshot, { color: false, width: 100, now }));
    const lines = out.split("\n").filter((l) => /●|API credits/.test(l));
    assert.deepEqual(
      lines.map((l) => l.replace(/ +█.*?\d+% +/, " ").replace(/ +/g, " ")),
      [
        "│ ● default",
        "│ API credits $180 of $200 left · expires Dec 20",
        "│ ● k1c",
        "│ API credits $120 of $200 left · expires Dec 20",
        "│ ● lab · API credits only · runs under claude@default",
        "│ API credits $50 of $200 left · expires Dec 20",
      ],
    );
  });

  it("shows an agent's API-only pools and a skipped pool's reason when none of its accounts is used", () => {
    const reason =
      "no consented Antigravity account to run this pool; tick one in schmear init, or run: schmear credits remove gemini-credits@default";
    const quotas = (agy: Snapshot["readings"][number]) => {
      const out = renderUsage(
        {
          ...fixture,
          readings: [
            fixture.readings[0] as Snapshot["readings"][number],
            agy,
            {
              id: "gemini-credits@default",
              skipped: reason,
              fetchedAt: now,
              warnings: [],
              pools: [
                { id: "gemini-credits@default", windows: [], status: `skipped: ${reason}`, pace: null },
              ],
            },
          ],
          next: [],
          notOffered: [],
          tasks: [],
        },
        { color: false, width: 200, now },
      );
      return out.slice(out.indexOf("│  Antigravity"), out.indexOf("◇  Next")).trimEnd();
    };
    assert.equal(
      quotas({ id: "agy@default", skipped: "no consent", warnings: [], pools: [] }),
      [
        "│  Antigravity",
        "│  ○ default  not used",
        "│  ● default · API credits only",
        `│    ▲ API credits: ${reason}`,
        "│",
      ].join("\n"),
    );
    assert.equal(
      quotas({ id: "agy@default", skipped: "not configured", warnings: [], pools: [] }),
      ["│  Antigravity", "│  ● default · API credits only", `│    ▲ API credits: ${reason}`, "│"].join("\n"),
    );
  });

  it("prints a credit pool's name, balance split and month spend on a second line, each line within 80 columns", () => {
    const snapshot: Snapshot = {
      ...fixture,
      readings: [
        ...fixture.readings.map((r) =>
          r.id === "claude-credits@default"
            ? {
                ...r,
                warnings: [
                  "key command failed 2026-11-24 09:15 UTC: security exited 44; each task tries it and falls back to another lane until it works (schmear credits status rechecks)",
                ],
                pools: r.pools.map((p) => ({
                  ...p,
                  name: "Acme Research",
                  usd: { left: 150, granted: 200, grant: 100, purchased: 50, spentMonth: 12.5 },
                })),
              }
            : r.id === "agy@default"
              ? {
                  ...r,
                  pools: r.pools.map((p) =>
                    p.id === "gemini-credits@default"
                      ? { ...p, name: "01ABCD-234567-89EF01", usd: { left: 50, granted: 100, grant: 50 } }
                      : p,
                  ),
                }
              : r,
        ),
        {
          id: "claude-credits@lab",
          skipped:
            "no consented Claude account to run this pool; tick one in schmear init, or run: schmear credits remove claude-credits@lab",
          warnings: [],
          pools: [{ id: "claude-credits@lab", windows: [] }],
        },
      ],
      tasks: [],
    };
    const out = renderUsage(snapshot, { color: false, width: 80, now });
    for (const line of out.split("\n")) assert.ok(line.length <= 80, line);
    assert.equal(stripVTControlCharacters(renderUsage(snapshot, { color: true, width: 80, now })), out);
    const lines = out.split("\n");
    const row = lines.findIndex((l) => l.includes("$150 of $200 left"));
    assert.deepEqual(lines.slice(row, row + 6), [
      "│    API credits  █████████░░░  75%  $150 of $200 left · expires Dec 20",
      "│      pace 2.10 · ok",
      "│      Acme Research · $100 grant + $50 purchased · $12.50 spent this month",
      "│    ▲ key command failed 2026-11-24 09:15 UTC: security exited 44; each task",
      "│      tries it and falls back to another lane until it works",
      "│      (schmear credits status rechecks)",
    ]);
    assert.match(
      out,
      /^│ {4}API credits .* \$50 of \$100 left · expires Dec 20\n│ {6}pace 1\.10 · ok\n│ {6}billing 01ABCD-234567-89EF01 · \$50 grant$/m,
    );
    assert.match(out, /^│ {6}schmear credits login claude$/m);
    assert.match(out, /^│ {6}schmear init, or run: schmear credits remove claude-credits@lab$/m);
    assert.match(out, /Run schmear init --yes,\n│ {2}then restart Codex\.$/m);
  });

  it("names the expiring amount only when less than the balance expires, and no grant when none is live", () => {
    const usd: Record<string, NonNullable<Snapshot["readings"][number]["pools"][number]["usd"]>> = {
      "claude-credits@default": { left: 150, granted: 200, expiring: 100 },
      "gemini-credits@default": { left: 50, granted: 0, expiring: 50 },
    };
    const snapshot: Snapshot = {
      ...fixture,
      readings: fixture.readings.map((r) => ({
        ...r,
        pools: r.pools.map((p) => (usd[p.id] ? { ...p, usd: usd[p.id] } : p)),
      })),
    };
    const out = renderUsage(snapshot, { color: false, width: 100, now });
    assert.match(out, /^│ {4}API credits .* \$150 of \$200 left · \$100 expires Dec 20 · pace 2\.10 · ok$/m);
    assert.match(out, /^│ {4}API credits .* \$50 left · expires Dec 20 · pace 1\.10 · ok$/m);
  });

  it("drops bars at width 50", () => {
    const narrow = renderUsage(fixture, { color: false, width: 50, now });
    assert.doesNotMatch(narrow, /[█░]/);
    assert.match(
      narrow,
      /^│ {4}All models {4}36% {2}5h 100% · 7d 36%\n│ {6}resets Thu 14:00 · pace 0\.72 · ok$/m,
    );
    assert.match(
      narrow,
      /^│ {4}API credits {3}75% {2}\$150 of \$200 left\n│ {6}expires Dec 20 · pace 2\.10 · ok$/m,
    );
    assert.match(narrow, /^│ {6}expired; run schmear credits login claude$/m);
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
  it("names the account in the credits hint on every Max account without a pool", () => {
    const account = (name: string, planCreditsUsd: number, creditsHint: boolean) => ({
      account: name,
      plan: "max_5x",
      planCreditsUsd,
      ...(creditsHint ? { creditsHint } : {}),
      warnings: [],
      pools: [],
    });
    const rows: QuotaRows = {
      agents: [
        {
          agent: "claude",
          name: "Claude",
          accounts: [account("default", 100, true), account("k1c", 100, true), account("work", 100, false)],
        },
      ],
      unused: [],
    };
    assert.equal(
      renderQuotas(rows, { color: false, width: 100 }),
      [
        "Claude",
        "● default  max_5x                       $100 API credits / month · schmear credits",
        "● k1c      max_5x                       $100 API credits / month · schmear credits k1c",
        "● work     max_5x                       $100 API credits / month",
      ].join("\n"),
    );
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

  it("help describes --yes for init and uninstall", () => {
    assert.match(
      plainHelp(),
      /^ {2}-y, --yes {6}init: on first run tick every CLI found except Antigravity; later runs keep your selection \(newly found ones stay off\); uninstall: skip the confirmation$/m,
    );
  });

  it("help lists the credits session commands", () => {
    const help = plainHelp();
    assert.match(
      help,
      /schmear credits login <claude\|google> \[--stdin\] \[--label <name>\]\n {25}store a Console or Google session: import it from a browser, or paste it with --stdin/,
    );
    assert.match(help, /^ {2}schmear credits logout \[google\] <label>\s+remove a stored session$/m);
    assert.match(help, /^ {2}schmear credits remove <id>\s+remove a credit pool and its ledger$/m);
    assert.match(
      help,
      /^ {2}schmear credits <account>\n {25}set up credits for one account \(claude@<name>, <name> or agy@<name>\)$/m,
    );
    assert.match(help, /^ {2}schmear credits status show stored sessions and credit pools$/m);
    assert.match(help, /^ {2}schmear credits reset <id>\s+clear a pool's exhausted mark$/m);
  });

  it("help for one command lists only its rows and options", () => {
    const init = plainHelp({ command: "init" });
    assert.match(init, /^ {2}schmear init \[--yes\] {3}detect CLIs/m);
    assert.match(init, /^ {2}-y, --yes /m);
    assert.match(init, /^ {2}-h, --help /m);
    for (const gone of ["usage", "credits", "--json", "--driver", "--version"]) {
      assert.equal(init.includes(gone), false, gone);
    }
    const credits = plainHelp({ command: "credits" });
    assert.match(credits, /schmear credits reset <id>/);
    assert.equal(credits.includes("schmear init"), false);
    assert.equal(credits.includes("--yes"), false);
    const status = plainHelp({ command: "credits", sub: "status" });
    assert.match(status, /schmear credits status/);
    assert.equal(status.includes("credits reset"), false);
    assert.equal(plainHelp({ command: "credits", sub: "bogus" }), credits);
    const tiers = renderHelp({ color: false, width: 80 }, { command: "tiers" });
    assert.match(tiers, /schmear tiers reset/);
    assert.match(tiers, /--json/);
    assert.equal(tiers.includes("--driver"), false);
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

describe("the cli's unknown input", () => {
  type Spawn = { env?: Record<string, string>; input?: string };
  const cli = (...args: Array<string | Spawn>) => {
    const last = args[args.length - 1];
    const opts: Spawn = typeof last === "object" ? last : {};
    const argv = args.filter((a): a is string => typeof a === "string");
    return spawnSync(process.execPath, [fileURLToPath(new URL("../src/cli.ts", import.meta.url)), ...argv], {
      encoding: "utf8",
      input: opts.input ?? "",
      env: opts.env,
    });
  };

  it("an unknown command or option is one stderr line and exit 1", () => {
    const command = cli("nonsense");
    assert.equal(command.status, 1);
    assert.equal(command.stdout, "");
    assert.equal(command.stderr, 'schmear: unknown command "nonsense". Run schmear --help.\n');
    const option = cli("--bogus=secret", "usage");
    assert.equal(option.status, 1);
    assert.equal(option.stdout, "");
    assert.equal(option.stderr, "schmear: unknown option --bogus. Run schmear --help.\n");
  });

  it("a command's help names only that command, however it is asked for", () => {
    const own = cli("init", "--help");
    assert.equal(own.status, 0);
    assert.equal(own.stdout, plainHelp({ command: "init" }));
    assert.equal(cli("help", "init").stdout, own.stdout);
    assert.equal(cli("help", "credits").stdout, plainHelp({ command: "credits" }));
    assert.equal(cli("credits", "status", "-h").stdout, plainHelp({ command: "credits", sub: "status" }));
    assert.equal(cli("help").stdout, plainHelp());
    const bogus = cli("help", "bogus");
    assert.equal(bogus.status, 1);
    assert.equal(bogus.stdout, "");
    assert.equal(bogus.stderr, 'schmear: unknown command "bogus". Run schmear --help.\n');
  });

  it("an option a command does not take, or one missing its value, names the command", () => {
    const err = (...args: string[]) => {
      const r = cli(...args);
      assert.equal(r.status, 1);
      assert.equal(r.stdout, "");
      return r.stderr;
    };
    assert.equal(
      err("credits", "status", "--json"),
      "schmear: unknown option --json for credits status. Run schmear credits --help.\n",
    );
    assert.equal(
      err("init", "--json"),
      "schmear: unknown option --json for init. Run schmear init --help.\n",
    );
    assert.equal(
      err("tiers", "set", "--json"),
      "schmear: unknown option --json for tiers set. Run schmear tiers --help.\n",
    );
    assert.equal(
      err("usage", "--driver"),
      "schmear: --driver needs a value: one of claude, codex, grok, agy, opencode\n",
    );
    assert.equal(err("credits", "login", "claude", "--label"), "schmear: --label needs a name\n");
    assert.equal(err("usage", "--json=x"), "schmear: --json takes no value\n");
  });

  it("piped prompts without an answer say to use a terminal, and progress goes to stderr", () => {
    const home = mkdtempSync(join(tmpdir(), "schmear-view-"));
    const bin = join(home, "bin");
    mkdirSync(bin);
    const claude = join(bin, "claude");
    writeFileSync(
      claude,
      '#!/bin/sh\nif [ "$1" = auth ]; then echo \'{"loggedIn":true,"authMethod":"claude.ai"}\'; else echo "2.0.0 (Claude Code)"; fi\n',
    );
    chmodSync(claude, 0o755);
    const env = {
      PATH: bin,
      HOME: home,
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_STATE_HOME: join(home, "state"),
    };
    const init = cli("init", { env });
    assert.equal(init.status, 1);
    assert.match(
      init.stderr,
      /^Looking for agent CLIs…\nschmear: no answer for "Which subscriptions should schmear use\?": run it in a terminal, or pass --yes\n$/,
    );
    assert.equal(init.stdout.includes("Looking for"), false);
    const uninstall = cli("uninstall", { env });
    assert.equal(uninstall.status, 1);
    assert.equal(
      uninstall.stderr,
      'schmear: no answer for "Type yes to remove schmear": run it in a terminal, or pass --yes\n',
    );
  });

  it("credits login --stdin with nothing on stdin fails before any write", () => {
    const home = mkdtempSync(join(tmpdir(), "schmear-view-"));
    const env = { PATH: "", HOME: home, XDG_CONFIG_HOME: join(home, "config") };
    const r = cli("credits", "login", "claude", "--stdin", { env, input: " \n" });
    assert.equal(r.status, 1);
    assert.match(
      r.stderr,
      /^schmear: nothing on stdin; pipe the Cookie header: .+ \| schmear credits login claude --stdin\n$/,
    );
  });

  it("no arguments print the help to stdout and exit 0", () => {
    const bare = cli();
    assert.equal(bare.status, 0);
    assert.equal(bare.stdout, plainHelp());
    assert.equal(bare.stderr, "");
  });
});
