import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";
import type { AgentAdapter, AgentId, AgentReading } from "../src/types.ts";
import type { InitIO } from "../src/ui.ts";

// Every path init resolves points into this temp dir before src/ is imported.
const root = mkdtempSync(join(tmpdir(), "schmear-init-"));
const home = join(root, "home");
const bin = join(root, "bin");
const callLog = join(root, "calls.jsonl");
mkdirSync(home);
mkdirSync(bin);
Object.assign(process.env, {
  HOME: home,
  CODEX_HOME: join(home, ".codex"),
  GROK_HOME: join(home, ".grok"),
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_STATE_HOME: join(home, ".local", "state"),
  XDG_CACHE_HOME: join(home, ".cache"),
  XDG_DATA_HOME: join(home, ".local", "share"),
  PATH: bin,
});
delete process.env.CLAUDE_CONFIG_DIR;

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const claudeState = join(home, ".claude.json");
// Present: `mcp get` shows an entry of this scope shadowing the user entry.
const claudeShadow = join(home, "fake-claude-shadow");
// Present: `mcp add-json` fails.
const claudeAddFails = join(home, "fake-claude-add-fails");

// Each fake logs its argv; `mcp list` prints the server names its host's config file holds.
const prelude = (name: string) => `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callLog)}, JSON.stringify({ bin: ${JSON.stringify(name)}, args }) + "\\n");
const rpc = (answer) => {
  require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
    const msg = JSON.parse(line);
    if (msg.id === undefined) return;
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: answer(msg) }) + "\\n");
  });
};
`;
const FAKES: Record<string, string> = {
  claude: `
const state = ${JSON.stringify(claudeState)};
const readEntry = () => {
  if (!fs.existsSync(state)) return undefined;
  return JSON.parse(fs.readFileSync(state, "utf8")).mcpServers?.schmear;
};
const writeEntry = (entry) => {
  const doc = fs.existsSync(state) ? JSON.parse(fs.readFileSync(state, "utf8")) : {};
  const servers = { ...(doc.mcpServers ?? {}) };
  if (entry === undefined) delete servers.schmear;
  else servers.schmear = entry;
  fs.writeFileSync(state, JSON.stringify({ ...doc, mcpServers: servers }, null, 2) + "\\n");
};
const a = args.join(" ");
if (a === "--version") console.log("2.1.330 (Claude Code)");
else if (a === "auth status --json") console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", planTier: "max_5x" }));
else if (a === "mcp get schmear") {
  const shadow = ${JSON.stringify(claudeShadow)};
  if (fs.existsSync(shadow)) {
    console.log(["schmear:", "  Scope: " + fs.readFileSync(shadow, "utf8"), "  Type: stdio", "  Command: /shadow", "  Args: "].join("\\n"));
    process.exit(0);
  }
  const s = readEntry();
  if (!s) { console.error("No MCP server found with name: schmear"); process.exit(1); }
  console.log(["schmear:", "  Scope: User config (available in all your projects)", "  Status: ✓ Connected", "  Type: stdio",
    "  Command: " + s.command, "  Args: " + s.args.join(" "),
    ...(s.timeout === undefined ? [] : ["  Timeout: " + s.timeout + "ms"])].join("\\n"));
} else if (a === "mcp remove -s user schmear") {
  if (!readEntry()) { console.error('No MCP server named "schmear" in user scope'); process.exit(1); }
  writeEntry(undefined);
} else if (a.startsWith("mcp add-json -s user schmear ")) {
  if (fs.existsSync(${JSON.stringify(claudeAddFails)})) { console.error("add-json refused"); process.exit(1); }
  if (readEntry()) { console.error("MCP server schmear already exists"); process.exit(1); }
  writeEntry(JSON.parse(args[5]));
} else process.exit(2);
`,
  codex: `
if (args[0] === "--version") console.log("codex-cli 0.147.0");
else if (args.join(" ") === "-s read-only -a never app-server")
  rpc((m) => (m.method === "initialize" ? {} : JSON.parse(fs.readFileSync(${JSON.stringify(fixture("codex-monthly.json"))}, "utf8"))));
else if (args.join(" ") === "mcp list") console.log(fs.readFileSync(process.env.CODEX_HOME + "/config.toml", "utf8").match(/^\\[mcp_servers\\.[^\\]]+\\]/gm).join("\\n"));
else process.exit(2);
`,
  grok: `
if (args[0] === "--version") console.log("grok 1.0.77");
else if (args.join(" ") === "--no-auto-update agent stdio")
  rpc((m) => (m.method === "initialize" ? { protocolVersion: 1, agentCapabilities: {}, authMethods: [] }
    : JSON.parse(fs.readFileSync(${JSON.stringify(fixture("grok-billing-percent.json"))}, "utf8"))));
else if (args.join(" ") === "mcp list") console.log(fs.readFileSync(process.env.GROK_HOME + "/config.toml", "utf8").match(/^\\[mcp_servers\\.[^\\]]+\\]/gm).join("\\n"));
else process.exit(2);
`,
  agy: `
if (args[0] === "--version") console.log("1.5.14");
else if (args.join(" ") === "-p /usage --output-format json") process.stdout.write(fs.readFileSync(${JSON.stringify(fixture("agy-usage.json"))}));
else if (args.join(" ") === "mcp list") console.log(Object.keys(JSON.parse(fs.readFileSync(process.env.HOME + "/.gemini/config/mcp_config.json", "utf8")).mcpServers).join("\\n"));
else process.exit(2);
`,
};
for (const [name, body] of Object.entries(FAKES)) {
  writeFileSync(join(bin, name), prelude(name) + body);
  chmodSync(join(bin, name), 0o755);
}

const { init, setupCredits, uninstall } = await import("../src/init.ts");
const { cliUsageText, snapshot: usageSnapshot } = await import("../src/server.ts");
const { lineIO } = await import("../src/ui.ts");
const { adapters } = await import("../src/agents/index.ts");

after(() => rmSync(root, { recursive: true, force: true }));

const cliPath = join(root, "lib", "node_modules", "schmear", "dist", "cli.js");
const codexToml = join(home, ".codex", "config.toml");
const grokToml = join(home, ".grok", "config.toml");
const agyJson = join(home, ".gemini", "config", "mcp_config.json");
const configJson = join(home, ".config", "schmear", "config.json");
const skills = [
  join(home, ".claude", "skills"),
  join(home, ".agents", "skills"),
  join(home, ".grok", "skills"),
  join(home, ".gemini", "config", "skills"),
].map((dir) => join(dir, "schmear", "SKILL.md"));
const skillText = readFileSync(new URL("../skills/schmear/SKILL.md", import.meta.url), "utf8");
const files = [codexToml, grokToml, agyJson, configJson, claudeState, ...skills];

/**
 * Runs init with `answers` as the typed replies in order, then ""; returns the questions asked and the printed
 * text. A rejection carries the printed text as `out`.
 */
async function scripted(answers: string[], run: (io: InitIO) => Promise<void>) {
  const questions: string[] = [];
  const out: string[] = [];
  const io = lineIO(
    async (q) => {
      questions.push(q);
      return answers.shift() ?? "";
    },
    (text) => out.push(text),
  );
  try {
    await run(io);
  } catch (err) {
    throw Object.assign(err as Error, { out: out.join("\n") });
  }
  return { questions, out: out.join("\n") };
}

let installs = 0;
const countInstall = async () => {
  installs++;
};
const runInit = (
  yes: boolean,
  answers: string[] = [],
  path = cliPath,
  agents = adapters,
  install = countInstall,
) => scripted(answers, (io) => init({ yes, cliPath: path }, io, agents, install));
const runUninstall = (yes: boolean, answers: string[] = []) =>
  scripted(answers, (io) => uninstall({ yes }, io));
const runCredits = (answers: string[], claude = adapters.claude) =>
  scripted(answers, (io) => setupCredits(io, claude));

const calls = (): { bin: string; args: string[] }[] =>
  readFileSync(callLog, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
const snapshot = () => files.map((f) => [f, readFileSync(f, "utf8"), statSync(f).mtimeMs]);
const args = [cliPath, "serve"];
// Spread: smol-toml tables have a null prototype.
const toml = (path: string) => ({
  ...((parse(readFileSync(path, "utf8")).mcp_servers as Record<string, object>).schmear as object),
});
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const claudeEntry = () => json(claudeState).mcpServers?.schmear;

describe("init", () => {
  it("refuses to register a path in npx's cache and writes nothing", async () => {
    await assert.rejects(runInit(true, [], "/u/.npm/_npx/1a2b/node_modules/schmear/dist/cli.js"), /npx/);
    for (const f of files) assert.equal(existsSync(f), false, f);
  });

  it("--yes uses every detected subscription and writes the four entries with timeouts and absolute paths", async () => {
    mkdirSync(join(home, ".codex"));
    writeFileSync(
      codexToml,
      '# my codex settings\nmodel = "gpt-5.6-terra"\n\n[mcp_servers.other]\ncommand = "x"\n',
    );
    chmodSync(codexToml, 0o640); // not the 0600 default, so preservation shows
    installs = 0;
    const { questions, out } = await runInit(true);

    assert.deepEqual(questions, []);
    assert.equal(installs, 1, "claude and codex are on, so the adapters are installed once");
    assert.match(out, /ACP adapters ready/);
    assert.ok(isAbsolute(process.execPath) && isAbsolute(cliPath));
    assert.deepEqual(claudeEntry(), {
      type: "stdio",
      command: process.execPath,
      args,
      timeout: 86_400_000,
    });
    assert.deepEqual(toml(codexToml), {
      command: process.execPath,
      args,
      tool_timeout_sec: 86_400,
      env_vars: ["SCHMEAR_WORKER"],
    });
    assert.deepEqual(toml(grokToml), { command: process.execPath, args, tool_timeout_sec: 86_400 });
    assert.deepEqual(json(agyJson).mcpServers.schmear, {
      command: process.execPath,
      args,
      timeoutSeconds: 86_400,
    });
    const codexText = readFileSync(codexToml, "utf8");
    assert.ok(codexText.startsWith('# my codex settings\nmodel = "gpt-5.6-terra"\n\n[mcp_servers.other]\n'));
    assert.equal(statSync(codexToml).mode & 0o777, 0o640);

    assert.deepEqual(json(configJson), {
      version: 1,
      agents: {
        "claude@default": { consent: true, path: join(bin, "claude") },
        "codex@default": { consent: true, path: join(bin, "codex") },
        "grok@default": { consent: true, path: join(bin, "grok") },
        "agy@default": { consent: false, path: join(bin, "agy") },
      },
    });
    for (const host of ["Claude Code", "Codex", "Grok", "Antigravity"]) {
      assert.match(out, new RegExp(`${host}\\s+registered · skill installed`));
    }
    assert.match(out, /codex@default\s+30d 63% left/);
    assert.match(out, /^grok@default\s+\d/m);
    assert.doesNotMatch(out, /^agy-gemini@default\s+\d/m);
    assert.doesNotMatch(out, /does not list schmear/);
    for (const [name, list] of [
      ["claude", "mcp get schmear"],
      ["codex", "mcp list"],
      ["agy", "mcp list"],
    ]) {
      assert.ok(
        calls().some((c) => c.bin === name && c.args.join(" ") === list),
        `${name} ${list}`,
      );
    }
  });

  it("a second run changes nothing", async () => {
    const before = snapshot();
    const callCount = calls().length;
    const { out } = await runInit(true);
    assert.deepEqual(snapshot(), before);
    const writes = calls()
      .slice(callCount)
      .filter((c) => c.bin === "claude" && (c.args[1] === "add-json" || c.args[1] === "remove"));
    assert.deepEqual(writes, []);
    for (const host of ["Claude Code", "Codex", "Grok", "Antigravity"]) {
      assert.match(out, new RegExp(`${host}\\s+already registered · skill current`));
    }
    assert.doesNotMatch(out, /updated/);
  });

  it("installs the skill into each host's skill folder and rewrites an edited copy", async () => {
    for (const path of skills) assert.equal(readFileSync(path, "utf8"), skillText, path);
    writeFileSync(skills[1], "edited");
    const { out } = await runInit(true);
    assert.match(out, /Codex\s+already registered · skill updated/);
    assert.equal(readFileSync(skills[1], "utf8"), skillText);
  });

  it("an edited entry is rewritten and reported updated", async () => {
    writeFileSync(
      claudeState,
      JSON.stringify({ mcpServers: { schmear: { type: "stdio", command: process.execPath, args } } }),
    );
    writeFileSync(
      codexToml,
      readFileSync(codexToml, "utf8").replace("tool_timeout_sec = 86400", "tool_timeout_sec = 60") +
        '\n[profiles.fast]\nmodel = "gpt-5.6-luna"\n',
    );
    writeFileSync(grokToml, `[mcp_servers.schmear]\ncommand = "node"\nargs = ["/old/cli.js", "serve"]\n`);
    const agy = json(agyJson);
    agy.mcpServers.schmear.timeoutSeconds = 180;
    agy.mcpServers.mine = { command: "mine" };
    writeFileSync(agyJson, JSON.stringify(agy));

    const { out } = await runInit(true);
    for (const host of ["Claude Code", "Codex", "Grok", "Antigravity"]) {
      assert.match(out, new RegExp(`${host}\\s+updated`));
    }
    assert.equal(claudeEntry().timeout, 86_400_000);
    assert.equal((toml(codexToml) as { tool_timeout_sec: number }).tool_timeout_sec, 86_400);
    assert.deepEqual(toml(grokToml), { command: process.execPath, args, tool_timeout_sec: 86_400 });
    assert.equal(json(agyJson).mcpServers.schmear.timeoutSeconds, 86_400);
    assert.deepEqual(json(agyJson).mcpServers.mine, { command: "mine" });
    const codex = JSON.parse(JSON.stringify(parse(readFileSync(codexToml, "utf8"))));
    assert.deepEqual(codex.profiles, { fast: { model: "gpt-5.6-luna" } });
    assert.deepEqual(codex.mcp_servers.other, { command: "x" });
    assert.match(readFileSync(codexToml, "utf8"), /^# my codex settings\n/);
  });

  it("unticked subscriptions are stored unused, and later runs keep them unticked", async () => {
    const { questions } = await runInit(false, ["claude@default, agy@default"]);
    assert.equal(questions.length, 1, "piped input gets no add-subscription menu");
    assert.match(
      questions[0] as string,
      /Which subscriptions should schmear use\? \(claude@default, codex@default, grok@default, agy@default/,
    );
    const consent = () =>
      Object.fromEntries(
        Object.entries(json(configJson).agents).map(([id, a]) => [id, (a as { consent: boolean }).consent]),
      );
    const picked = {
      "claude@default": true,
      "codex@default": false,
      "grok@default": false,
      "agy@default": true,
    };
    assert.deepEqual(consent(), picked);
    assert.match((await runInit(true)).out, /codex@default\s+not used/);
    assert.deepEqual(consent(), picked, "--yes keeps the unticked ones");
    await runInit(false, [""]);
    assert.deepEqual(consent(), picked, "an empty answer keeps the ticked set");
    await runInit(false, ["claude@default, codex@default, grok@default, agy@default"]);
    assert.deepEqual(consent(), {
      "claude@default": true,
      "codex@default": true,
      "grok@default": true,
      "agy@default": true,
    });
  });

  describe("Antigravity is opt-in", () => {
    const agyConsent = () => json(configJson).agents["agy@default"].consent;
    const offNotice = /Antigravity is off until you tick it/;
    const all = "claude@default, codex@default, grok@default, agy@default";

    it("a fresh --yes leaves it off, says so, and ticks the others", async () => {
      rmSync(configJson);
      const { out } = await runInit(true);
      assert.match(out, offNotice);
      assert.deepEqual(
        Object.fromEntries(
          Object.entries(json(configJson).agents).map(([id, a]) => [id, (a as { consent: boolean }).consent]),
        ),
        { "claude@default": true, "codex@default": true, "grok@default": true, "agy@default": false },
      );
    });

    it("a stored consent keeps it on under --yes without the notice", async () => {
      await runInit(false, [all]);
      assert.equal(agyConsent(), true);
      const { out } = await runInit(true);
      assert.doesNotMatch(out, offNotice);
      assert.equal(agyConsent(), true);
    });

    it("ticking it in the checklist turns it on, and a later --yes keeps it", async () => {
      rmSync(configJson);
      await runInit(false, [all]);
      assert.equal(agyConsent(), true);
      await runInit(true);
      assert.equal(agyConsent(), true);
    });
  });

  describe("ACP adapters", () => {
    const prior = () => readFileSync(configJson, "utf8");
    const withConsent = (claude: boolean, codex: boolean) => {
      const config = json(configJson);
      config.agents["claude@default"].consent = claude;
      config.agents["codex@default"].consent = codex;
      writeFileSync(configJson, JSON.stringify(config));
    };

    it("a failed install warns, and init still registers every host", async () => {
      const saved = prior();
      try {
        const failing = async () => {
          throw new Error("could not install the Claude and Codex ACP adapters: boom");
        };
        const { out } = await runInit(true, [], cliPath, adapters, failing);
        assert.match(out, /ACP adapters not installed/);
        assert.match(out, /ACP adapters: boom/);
        for (const host of ["Claude Code", "Codex", "Grok", "Antigravity"]) {
          assert.match(out, new RegExp(`${host}\\s+(already registered|registered|updated)`));
        }
      } finally {
        writeFileSync(configJson, saved);
      }
    });

    it("neither Claude nor Codex consented: nothing is installed", async () => {
      const saved = prior();
      try {
        withConsent(false, false);
        installs = 0;
        const { out } = await runInit(true);
        assert.equal(installs, 0);
        assert.doesNotMatch(out, /ACP adapters/);
      } finally {
        writeFileSync(configJson, saved);
      }
    });
  });

  it("an unknown subscription aborts before writing", async () => {
    const before = readFileSync(configJson, "utf8");
    await assert.rejects(runInit(false, ["claude@default, nope"]), /unknown nope/);
    assert.equal(readFileSync(configJson, "utf8"), before);
  });

  const keyCommand = ["security", "find-generic-password", "-s", "schmear-anthropic", "-w"];

  it("credits: an invalid answer or a plan without credits aborts before writing", async () => {
    const before = readFileSync(configJson, "utf8");
    await assert.rejects(runCredits(["32"]), /invalid answer '32'/);
    await assert.rejects(runCredits(["1", '"security"']), /expected a JSON array of non-empty strings/);
    const pro = { ...adapters.claude, find: async () => ({ version: "2.1.330", plan: "pro" }) };
    await assert.rejects(runCredits([], pro), /Claude plan pro includes no monthly API credits/);
    assert.equal(readFileSync(configJson, "utf8"), before);
  });

  it("credits: without the no-overage confirmation no pool is written", async () => {
    const { out } = await runCredits(["1", "", "no"]);
    assert.match(out, /no credit lane written/);
    assert.equal(json(configJson).credits, undefined);
  });

  it("credits: init points to the grant, the grant comes from the plan, and a later init keeps the pool", async () => {
    const hint = /\$100 of API credits per billing cycle; `schmear credits`/;
    assert.match((await runInit(true)).out, hint);
    const { questions } = await runCredits(["31", "", "yes"]);
    assert.match(questions[0] as string, /\$100 of API credits per billing cycle/);
    const pool = { grantUsd: 100, cycleDay: 31, keyCommand, taskCapUsd: 10, overageOff: true };
    assert.deepEqual(json(configJson).credits, pool);
    assert.doesNotMatch((await runInit(true)).out, hint);
    assert.deepEqual(json(configJson).credits, pool);
  });

  it("registers PATH node when it resolves to process.execPath, and falls back when it points elsewhere", async () => {
    const pathNode = join(bin, "node");
    const otherNode = join(root, "other-node");
    writeFileSync(otherNode, "#!/bin/sh\n");
    chmodSync(otherNode, 0o755);
    try {
      symlinkSync(process.execPath, pathNode);
      const linked = await runInit(true);
      for (const host of ["Claude Code", "Codex", "Grok", "Antigravity"]) {
        assert.match(linked.out, new RegExp(`${host}\\s+updated`));
      }
      assert.equal(claudeEntry().command, pathNode);
      assert.equal((toml(codexToml) as { command: string }).command, pathNode);
      assert.equal((toml(grokToml) as { command: string }).command, pathNode);
      assert.equal(json(agyJson).mcpServers.schmear.command, pathNode);

      rmSync(pathNode);
      symlinkSync(otherNode, pathNode);
      const other = await runInit(true);
      for (const host of ["Claude Code", "Codex", "Grok", "Antigravity"]) {
        assert.match(other.out, new RegExp(`${host}\\s+updated`));
      }
      assert.equal(claudeEntry().command, process.execPath);
      assert.equal((toml(codexToml) as { command: string }).command, process.execPath);
      assert.equal((toml(grokToml) as { command: string }).command, process.execPath);
      assert.equal(json(agyJson).mcpServers.schmear.command, process.execPath);
    } finally {
      rmSync(pathNode, { force: true });
      rmSync(otherNode, { force: true });
    }
  });

  it("registers PATH schmear when it resolves to the running cli.js, so a Homebrew upgrade keeps the entry", async () => {
    const pathSchmear = join(bin, "schmear");
    const kegCli = join(
      root,
      "Cellar",
      "schmear",
      "0.3.0",
      "libexec",
      "lib",
      "node_modules",
      "schmear",
      "dist",
      "cli.js",
    );
    mkdirSync(dirname(kegCli), { recursive: true });
    writeFileSync(kegCli, "#!/usr/bin/env node\n");
    chmodSync(kegCli, 0o755);
    const registered = () => [
      claudeEntry().args[0],
      (toml(codexToml) as { args: string[] }).args[0],
      (toml(grokToml) as { args: string[] }).args[0],
      json(agyJson).mcpServers.schmear.args[0],
    ];
    try {
      symlinkSync(kegCli, pathSchmear);
      await runInit(true, [], kegCli);
      assert.deepEqual(registered(), Array(4).fill(pathSchmear));

      rmSync(pathSchmear);
      symlinkSync(join(root, "other-cli.js"), pathSchmear);
      writeFileSync(join(root, "other-cli.js"), "");
      chmodSync(join(root, "other-cli.js"), 0o755);
      await runInit(true, [], kegCli);
      assert.deepEqual(registered(), Array(4).fill(kegCli));
    } finally {
      rmSync(pathSchmear, { force: true });
      rmSync(join(root, "other-cli.js"), { force: true });
      await runInit(true);
    }
  });

  it("keeps a user-added [mcp_servers.schmear.env] subtable and reports already registered", async () => {
    const subtable = '\n[mcp_servers.schmear.env]\nFOO = "bar"\n';
    writeFileSync(codexToml, readFileSync(codexToml, "utf8") + subtable);
    writeFileSync(grokToml, readFileSync(grokToml, "utf8") + subtable);
    const codexBefore = readFileSync(codexToml, "utf8");
    const grokBefore = readFileSync(grokToml, "utf8");

    const { out } = await runInit(true);
    assert.match(out, /Codex\s+already registered/);
    assert.match(out, /Grok\s+already registered/);
    assert.doesNotMatch(out, /(Codex|Grok)\s+updated/);
    assert.equal(readFileSync(codexToml, "utf8"), codexBefore);
    assert.equal(readFileSync(grokToml, "utf8"), grokBefore);
    assert.deepEqual({ ...(toml(codexToml) as { env: object }).env }, { FOO: "bar" });
    assert.deepEqual({ ...(toml(grokToml) as { env: object }).env }, { FOO: "bar" });

    // Updating an init-owned key still preserves the env subtable and converges on the next run.
    writeFileSync(codexToml, codexBefore.replace("tool_timeout_sec = 86400", "tool_timeout_sec = 60"));
    const updated = await runInit(true);
    assert.match(updated.out, /Codex\s+updated/);
    assert.equal((toml(codexToml) as { tool_timeout_sec: number }).tool_timeout_sec, 86_400);
    assert.deepEqual({ ...(toml(codexToml) as { env: object }).env }, { FOO: "bar" });

    const steady = await runInit(true);
    assert.match(steady.out, /Codex\s+already registered/);
  });
  it("reports each agent's own detection error and still registers the others", async () => {
    const failing = {
      ...adapters,
      codex: { ...adapters.codex, find: async () => ({ error: "codex is not logged in" }) },
    };
    const { out } = await runInit(true, [], cliPath, failing);
    assert.match(
      out,
      new RegExp(`codex\\s+${join(bin, "codex")} failed detection \\(codex is not logged in\\); not offered`),
    );
    assert.doesNotMatch(out, /claude\.ai login/);
    assert.equal(json(configJson).agents["codex@default"], undefined);
    assert.ok(json(configJson).agents["agy@default"]);
  });

  it("skips an agent that is not on PATH", async () => {
    renameSync(join(bin, "agy"), join(bin, "agy.off"));
    try {
      const { out } = await runInit(true);
      assert.match(out, /agy\s+not installed/);
      assert.equal(json(configJson).agents["agy@default"], undefined);
    } finally {
      renameSync(join(bin, "agy.off"), join(bin, "agy"));
    }
  });

  const serverToml = (command: string, argsLines: string, rest: string) =>
    `[mcp_servers.schmear]\n# managed by schmear\ncommand = ${JSON.stringify(command)}\n${argsLines}\nenabled = false   # paused\nstartup_timeout_sec = 30\n${rest}`;
  const cliArgs = `args = [ ${JSON.stringify(cliPath)}, "serve" ]`;

  it("leaves a TOML entry with user keys and lines alone when init's keys match, and rewrites only init's keys otherwise", async () => {
    // default_tools_approval_mode is a user key: init never writes it and keeps it.
    const codexRest =
      'tool_timeout_sec = 86400\nenv_vars = [ "SCHMEAR_WORKER" ]\ndefault_tools_approval_mode = "approve"\n\n[mcp_servers.schmear.env]\nFOO = "bar"\n\n[mcp_servers.other]\ncommand = "x"\n';
    const codexText = `# my codex settings\n\n${serverToml(process.execPath, cliArgs, codexRest)}`;
    const grokText = serverToml(process.execPath, cliArgs, "tool_timeout_sec = 86400\n");
    writeFileSync(codexToml, codexText);
    writeFileSync(grokToml, grokText);

    const steady = await runInit(true);
    assert.match(steady.out, /Codex\s+already registered/);
    assert.match(steady.out, /Grok\s+already registered/);
    assert.equal(readFileSync(codexToml, "utf8"), codexText);
    assert.equal(readFileSync(grokToml, "utf8"), grokText);

    // An old multi-line args value, a changed timeout, and a missing init key.
    writeFileSync(
      codexToml,
      codexText
        .replace(cliArgs, 'args = [\n  "/old/cli.js",\n  "serve",\n]')
        .replace("tool_timeout_sec = 86400", "tool_timeout_sec = 60")
        .replace('env_vars = [ "SCHMEAR_WORKER" ]\n', ""),
    );
    writeFileSync(
      grokToml,
      serverToml("node", 'args = ["/old/cli.js", "serve"]', "tool_timeout_sec = 86400\n"),
    );
    const updated = await runInit(true);
    assert.match(updated.out, /Codex\s+updated/);
    assert.match(updated.out, /Grok\s+updated/);
    assert.equal(
      readFileSync(codexToml, "utf8"),
      codexText
        .replace('env_vars = [ "SCHMEAR_WORKER" ]\n', "")
        .replace("[mcp_servers.schmear]\n", '[mcp_servers.schmear]\nenv_vars = [ "SCHMEAR_WORKER" ]\n'),
    );
    assert.equal(readFileSync(grokToml, "utf8"), grokText);
    assert.equal(
      (toml(codexToml) as { enabled: boolean }).enabled,
      false,
      "a disabled server stays disabled",
    );
    assert.match((await runInit(true)).out, /Codex\s+already registered/);
  });

  it("leaves an Antigravity entry with user keys alone when init's keys match, and rewrites only init's keys otherwise", async () => {
    const entry = {
      command: process.execPath,
      args,
      timeoutSeconds: 86_400,
      env: { A: "1" },
      disabled: true,
    };
    const text = `${JSON.stringify({ mcpServers: { schmear: entry, mine: { command: "mine" } } }, null, 2)}\n`;
    writeFileSync(agyJson, text);
    assert.match((await runInit(true)).out, /Antigravity\s+already registered/);
    assert.equal(readFileSync(agyJson, "utf8"), text);

    writeFileSync(agyJson, text.replace('"timeoutSeconds": 86400', '"timeoutSeconds": 180'));
    assert.match((await runInit(true)).out, /Antigravity\s+updated/);
    assert.equal(readFileSync(agyJson, "utf8"), text);
  });

  it("writes through a symlinked host config and keeps the link", async () => {
    const real = join(root, "dotfiles", "codex.toml");
    mkdirSync(join(root, "dotfiles"));
    writeFileSync(
      real,
      readFileSync(codexToml, "utf8").replace("tool_timeout_sec = 86400", "tool_timeout_sec = 60"),
    );
    rmSync(codexToml);
    symlinkSync(real, codexToml);
    assert.match((await runInit(true)).out, /Codex\s+updated/);
    assert.ok(lstatSync(codexToml).isSymbolicLink());
    assert.equal((toml(real) as { tool_timeout_sec: number }).tool_timeout_sec, 86_400);
  });

  it("registers at user scope and warns when another Claude scope shadows the entry", async () => {
    const scope = "Local config (private to you in this project)";
    writeFileSync(claudeShadow, scope);
    rmSync(claudeState);
    try {
      const { out } = await runInit(true);
      assert.match(
        out,
        new RegExp(`Claude Code: the ${scope.replace(/[()]/g, "\\$&")} schmear entry shadows the user entry`),
      );
      assert.match(out, /Claude Code\s+registered/);
      assert.deepEqual(claudeEntry(), {
        type: "stdio",
        command: process.execPath,
        args,
        timeout: 86_400_000,
      });
    } finally {
      rmSync(claudeShadow);
    }
    assert.match((await runInit(true)).out, /Claude Code\s+already registered/);
  });

  it("a host that fails to register is reported, the others still register, and init fails", async () => {
    const grokText = readFileSync(grokToml, "utf8");
    writeFileSync(grokToml, "[mcp_servers.schmear\n");
    writeFileSync(claudeAddFails, "");
    rmSync(claudeState);
    try {
      const err = await runInit(true).then(
        () => assert.fail("init resolved"),
        (e: Error & { out: string }) => e,
      );
      assert.equal(err.message, "not registered in Claude Code, Grok");
      assert.match(err.out, /Claude Code: not registered \(.*add-json refused/s);
      assert.match(err.out, /Grok: not registered \(cannot parse /);
      assert.match(err.out, /Codex\s+already registered/);
      assert.match(err.out, /Antigravity\s+already registered/);
      assert.doesNotMatch(err.out, /does not list schmear/);
    } finally {
      rmSync(claudeAddFails);
      writeFileSync(grokToml, grokText);
    }
    assert.match((await runInit(true)).out, /Claude Code\s+registered/);
  });

  it("init lists accounts after the default ones, keeps them, and reads their quotas", async () => {
    const dir = join(home, ".codex-w");
    const stored = { consent: true, path: "/old/codex", home: dir };
    writeFileSync(
      configJson,
      JSON.stringify({ ...json(configJson), agents: { ...json(configJson).agents, "codex@w": stored } }),
    );
    const { questions, out } = await runInit(false, [""]);
    assert.match(
      questions[0] as string,
      /\(claude@default, codex@default, grok@default, agy@default, codex@w; comma-separated\) \[claude@default, codex@default, grok@default, codex@w\]/,
    );
    assert.match(out, /^codex@w\s+30d 63% left/m);
    assert.deepEqual(json(configJson).agents["codex@w"], { ...stored, path: join(bin, "codex") });

    await runInit(false, ["claude@default, codex@default, grok@default, agy@default"]);
    assert.equal(json(configJson).agents["codex@w"].consent, false);
    assert.match((await runInit(true)).out, /codex@w\s+not used/);
    assert.equal(json(configJson).agents["codex@w"].consent, false, "--yes keeps it unticked");

    const failing = {
      ...adapters,
      codex: { ...adapters.codex, find: async () => ({ error: "codex is not logged in" }) },
    };
    await runInit(true, [], cliPath, failing);
    assert.deepEqual(json(configJson).agents["codex@w"], {
      ...stored,
      path: join(bin, "codex"),
      consent: false,
    });
  });

  describe("add a subscription from the menu", () => {
    const loginsDir = join(home, ".local", "share", "schmear", "logins");
    const mine = "me@x.com";
    // The default claude is `mine`; an account's find and usage follow the email the fake login "signed in" as.
    const claudeWith = (accountEmail: string | ((dir: string) => string) | undefined, usageError?: string) =>
      ({
        ...adapters,
        claude: {
          ...adapters.claude,
          find: async (_bin: string, env?: Record<string, string>) =>
            env?.CLAUDE_CONFIG_DIR
              ? accountEmail === undefined
                ? { error: "not logged in" }
                : {
                    version: "2.1.330",
                    email:
                      typeof accountEmail === "function" ? accountEmail(env.CLAUDE_CONFIG_DIR) : accountEmail,
                    plan: "pro",
                  }
              : { version: "2.1.330", email: mine, plan: "max_5x" },
          readUsage: async (_bin: string, env?: Record<string, string>): Promise<AgentReading> => ({
            agent: "claude",
            fetchedAt: Date.now(),
            warnings: [],
            error: env?.CLAUDE_CONFIG_DIR ? usageError : undefined,
            pools: env?.CLAUDE_CONFIG_DIR
              ? [
                  {
                    id: "claude",
                    agent: "claude",
                    keys: ["claude"],
                    windows: [{ kind: "period", remaining: 0.5, resetsAt: null, periodHours: 168 }],
                  },
                ]
              : [],
          }),
        } as AgentAdapter,
      }) as Record<AgentId, AgentAdapter>;
    const keepConfig = async (body: () => Promise<void>) => {
      const saved = readFileSync(configJson, "utf8");
      try {
        await body();
      } finally {
        writeFileSync(configJson, saved);
        rmSync(loginsDir, { recursive: true, force: true });
      }
    };
    /**
     * Terminal init answering the menus with `picks` in order (then "done") and each nickname prompt with the next of
     * `nicknames`; `run` resolves `code`. `validators` holds each nickname prompt's validate.
     */
    const menuInit = (
      picks: string[],
      agents: Record<AgentId, AgentAdapter>,
      code = 0,
      nicknames: string[] = ["work"],
    ) => {
      const ran: { command: string; args: string[]; env: Record<string, string> }[] = [];
      const asked: string[] = [];
      const validators: ((value: string) => string | undefined)[] = [];
      return scripted(["", ""], (io) =>
        init(
          { yes: false, cliPath },
          {
            ...io,
            select: async (message, _options, initial) => {
              asked.push(message);
              return picks.shift() ?? initial;
            },
            text: async (message, opts) => {
              asked.push(message);
              if (opts?.validate) validators.push(opts.validate);
              return nicknames.shift() ?? "";
            },
            run: async (command, args, env) => {
              ran.push({ command, args, env });
              return code;
            },
          },
          agents,
          countInstall,
        ),
      ).then((r) => ({ ...r, ran, asked, validators }));
    };
    const stored = () => Object.keys(json(configJson).agents);

    it("signs in to a new Claude, labels it from the login and writes it with a 0700 home", async () => {
      await keepConfig(async () => {
        const { out, ran, asked } = await menuInit(["claude", "continue", "done"], claudeWith("work@x.com"));
        const dir = join(loginsDir, "claude-work");
        assert.deepEqual(json(configJson).agents["claude@work"], {
          consent: true,
          path: join(bin, "claude"),
          home: dir,
        });
        assert.equal(statSync(dir).mode & 0o777, 0o700);
        assert.equal(ran.length, 1);
        assert.deepEqual(ran[0]?.args, ["auth", "login"]);
        assert.equal(ran[0]?.env.CLAUDE_CONFIG_DIR, dir);
        assert.deepEqual(asked, [
          "Add another subscription?",
          "Nickname for this Claude subscription",
          "Signed in to the account you're linking?",
          "Add another subscription?",
        ]);
        assert.match(
          out,
          /Linking claude@work: first sign in to the account you're linking at claude\.ai in your browser/,
        );
        assert.match(out, /Opening Claude's sign-in…/);
        assert.match(out, /Added claude@work {2}work@x\.com · pro/);
        assert.match(out, /^claude@work\s+7d 50% left/m);
      });
    });

    it("names each subscription by its nickname and refuses default, a bad name and a taken one", async () => {
      await keepConfig(async () => {
        const { validators } = await menuInit(
          ["claude", "continue", "claude", "continue", "done"],
          claudeWith((dir) => `${basename(dir)}@x.com`),
          0,
          ["work", "side"],
        );
        assert.ok(stored().includes("claude@work") && stored().includes("claude@side"));
        assert.equal(json(configJson).agents["claude@side"].home, join(loginsDir, "claude-side"));
        const [first, second] = validators;
        assert.equal(first?.("other-1"), undefined);
        assert.equal(first?.("default"), '"default" is your first Claude login');
        assert.equal(first?.("Bad_Name"), 'use lowercase letters, digits and "-", up to 32');
        assert.equal(second?.("work"), "claude@work is already added");
      });
    });

    it("cancelling at the confirmation runs nothing and leaves nothing", async () => {
      await keepConfig(async () => {
        const { ran } = await menuInit(["claude", "cancel", "done"], claudeWith("work@x.com"));
        assert.equal(ran.length, 0);
        assert.equal(existsSync(join(loginsDir, "claude-work")), false);
        assert.equal(stored().includes("claude@work"), false);
      });
    });

    it("refuses the same login as the default account and removes the home", async () => {
      await keepConfig(async () => {
        const { out } = await menuInit(["claude", "continue", "done"], claudeWith(mine));
        assert.equal(existsSync(join(loginsDir, "claude-work")), false);
        assert.equal(stored().includes("claude@work"), false);
        assert.match(
          out,
          /claude@work not added: that is the same login as claude@default\. Sign in with a different account\./,
        );
      });
    });

    it("refuses a sign-in that did not finish, an unreadable login and a usage error, leaving nothing", async () => {
      await keepConfig(async () => {
        const failed = await menuInit(["claude", "continue", "done"], claudeWith("w@x.com"), 1);
        assert.match(failed.out, /claude@work not added: sign-in did not finish \(exit 1\)\./);
        const unreadable = await menuInit(["claude", "continue", "done"], claudeWith(undefined));
        assert.match(unreadable.out, /claude@work not added: not logged in\./);
        const broken = await menuInit(["claude", "continue", "done"], claudeWith("w@x.com", "usage down"));
        assert.match(broken.out, /claude@work not added: usage down\./);
        assert.equal(existsSync(join(loginsDir, "claude-work")), false);
        assert.equal(stored().includes("claude@work"), false);
      });
    });

    it("piped input and --yes never show the menu", async () => {
      await keepConfig(async () => {
        const never = async () => assert.fail("select called");
        const piped = await scripted([""], (io) =>
          init({ yes: false, cliPath }, { ...io, select: never }, claudeWith("w@x.com"), countInstall),
        );
        assert.match(piped.out, /Add more subscriptions by running `schmear init` in a terminal\./);
        const yes = await scripted([], (io) =>
          init(
            { yes: true, cliPath },
            { ...io, select: never, run: async () => 0 },
            claudeWith("w@x.com"),
            countInstall,
          ),
        );
        assert.doesNotMatch(yes.out, /Add more subscriptions/);
        assert.equal(stored().includes("claude@work"), false);
      });
    });

    it("the checklist labels show email and plan, and an account that is not signed in", async () => {
      await keepConfig(async () => {
        const dir = join(home, "acct");
        writeFileSync(
          configJson,
          JSON.stringify({
            ...json(configJson),
            agents: { ...json(configJson).agents, "claude@work": { consent: true, path: "/x", home: dir } },
          }),
        );
        const labels: string[][] = [];
        for (const accountEmail of ["w@x.com", undefined]) {
          await scripted([""], (io) =>
            init(
              { yes: false, cliPath },
              {
                ...io,
                choose: async (_m, options, ticked) => {
                  labels.push(options.map((o) => o.label));
                  return ticked;
                },
              },
              claudeWith(accountEmail),
              countInstall,
            ),
          );
        }
        assert.ok(labels[0]?.includes("claude@default  me@x.com · max_5x"));
        assert.ok(labels[0]?.includes("claude@work  w@x.com · pro"));
        assert.ok(labels[1]?.includes("claude@work  not signed in"));
      });
    });
  });

  it("reports host connection health as ok, stale, missing, then ok after re-init", async () => {
    const tempCli = join(root, "temp-cli.js");
    writeFileSync(tempCli, "#!/usr/bin/env node\n");
    try {
      await runInit(true, [], tempCli);
      const ok = await usageSnapshot(adapters, null, 0);
      assert.deepEqual(ok.hosts, [
        { id: "claude", status: "ok" },
        { id: "codex", status: "ok" },
        { id: "grok", status: "ok" },
        { id: "agy", status: "ok" },
      ]);
      assert.doesNotMatch(await cliUsageText(adapters, null), /can't reach schmear/);

      rmSync(tempCli);
      const stale = await usageSnapshot(adapters, null, 0);
      assert.deepEqual(stale.hosts, [
        { id: "claude", status: "stale" },
        { id: "codex", status: "stale" },
        { id: "grok", status: "stale" },
        { id: "agy", status: "stale" },
      ]);
      const staleText = await cliUsageText(adapters, null);
      for (const host of ["Claude Code", "Codex", "Grok", "Antigravity"]) {
        assert.match(
          staleText,
          new RegExp(
            `${host} can't reach schmear: its entry runs .*temp-cli\\.js, which no longer exists\\. Run \`schmear init --yes\`, then restart ${host}\\.`,
          ),
        );
      }

      rmSync(agyJson);
      const missing = await usageSnapshot(adapters, null, 0);
      assert.deepEqual(missing.hosts, [
        { id: "claude", status: "stale" },
        { id: "codex", status: "stale" },
        { id: "grok", status: "stale" },
        { id: "agy", status: "missing" },
      ]);
      assert.match(
        await cliUsageText(adapters, null),
        /Antigravity can't reach schmear: no schmear entry\. Run `schmear init --yes`, then restart Antigravity\./,
      );

      writeFileSync(tempCli, "#!/usr/bin/env node\n");
      await runInit(true, [], tempCli);
      const fixed = await usageSnapshot(adapters, null, 0);
      assert.deepEqual(fixed.hosts, [
        { id: "claude", status: "ok" },
        { id: "codex", status: "ok" },
        { id: "grok", status: "ok" },
        { id: "agy", status: "ok" },
      ]);
      assert.doesNotMatch(await cliUsageText(adapters, null), /can't reach schmear/);
    } finally {
      rmSync(tempCli, { force: true });
    }
  });

  it("uninstall removes every host entry, the skills, config and state, and keeps everything else", async () => {
    await runInit(true);
    const other = '[mcp_servers.kept]\ncommand = "x"\n\n';
    writeFileSync(codexToml, other + readFileSync(codexToml, "utf8"));
    writeFileSync(grokToml, other + readFileSync(grokToml, "utf8"));
    const agy = json(agyJson);
    writeFileSync(
      agyJson,
      JSON.stringify({ ...agy, mcpServers: { kept: { command: "x" }, ...agy.mcpServers } }),
    );
    const stateDir = join(home, ".local", "state", "schmear");
    mkdirSync(stateDir, { recursive: true });
    const accountDir = join(home, ".codex-w"); // the account init kept above
    mkdirSync(accountDir, { recursive: true });
    const made = join(home, ".local", "share", "schmear", "logins", "claude-2"); // a login init created
    mkdirSync(made, { recursive: true });
    writeFileSync(
      configJson,
      JSON.stringify({
        ...json(configJson),
        agents: { ...json(configJson).agents, "claude@2": { consent: true, path: "/x", home: made } },
      }),
    );

    assert.match((await runUninstall(false, ["no"])).out, /Nothing removed/);
    assert.ok(existsSync(claudeState) && existsSync(configJson));

    const { out } = await runUninstall(false, ["yes"]);
    for (const host of ["Claude Code", "Codex", "Grok", "Antigravity"]) {
      assert.match(out, new RegExp(`${host}\\s+removed`));
    }
    assert.match(out, /Your codex@w login stays in ~\/\.codex-w\./);
    assert.ok(existsSync(accountDir));
    assert.equal(existsSync(made), false);
    assert.match(out, /Deleted ~\/\.local\/share\/schmear/);
    assert.doesNotMatch(out, /Your claude@2 login stays/);
    assert.match(out, /Your API key stays where `security find-generic-password/);
    assert.equal(claudeEntry(), undefined);
    for (const path of [codexToml, grokToml]) {
      const text = readFileSync(path, "utf8");
      assert.ok(text.startsWith(other.trimEnd()) && text.endsWith("\n") && !text.endsWith("\n\n"), path);
      const servers = parse(text).mcp_servers as Record<string, unknown>;
      assert.equal(servers.schmear, undefined, path);
      assert.ok(servers.kept, path);
    }
    const agyServers = json(agyJson).mcpServers;
    assert.equal(agyServers.schmear, undefined);
    assert.deepEqual(agyServers.kept, { command: "x" });
    for (const path of [...skills, configJson, stateDir]) assert.equal(existsSync(path), false, path);

    const again = await runUninstall(true);
    for (const host of ["Claude Code", "Codex", "Grok", "Antigravity"]) {
      assert.match(again.out, new RegExp(`${host}\\s+not registered`));
    }
  });
});
