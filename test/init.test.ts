import assert from "node:assert/strict";
import childProcess from "node:child_process";
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
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify, stripVTControlCharacters } from "node:util";
import { parse } from "smol-toml";
import type { AgentAdapter, AgentId, AgentReading } from "../src/types.ts";
import type { InitIO } from "../src/ui.ts";
import type { Sys } from "../src/util.ts";
import type { QuotaRows } from "../src/view.ts";

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

// The real Keychain and network are off limits: record and refuse them (the last test asserts none happened).
const forbidden: string[] = [];
const refuse = (what: string) => {
  forbidden.push(what);
  throw new Error(`test reached ${what}`);
};
type Call = (file: string, ...rest: unknown[]) => unknown;
const guard =
  (real: Call, kind: string): Call =>
  (file, ...rest) =>
    file === "/usr/bin/security" ? refuse(`${kind} ${file}`) : real(file, ...rest);
const realExecFile = childProcess.execFile as unknown as Call & Record<symbol, Call>;
const realSpawn = childProcess.spawn as unknown as Call;
childProcess.execFile = Object.assign(guard(realExecFile, "execFile"), {
  [promisify.custom]: guard(realExecFile[promisify.custom] as Call, "execFile"),
}) as unknown as typeof childProcess.execFile;
childProcess.spawn = guard(realSpawn, "spawn") as unknown as typeof childProcess.spawn;
globalThis.fetch = (async (input: string | URL | Request) =>
  refuse(`fetch ${String(input)}`)) as typeof fetch;
syncBuiltinESMExports();

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
const { desktopApp, init, loginConsole, loginGoogle, logoutConsole, removeCredit, setupCredits, uninstall } =
  await import("../src/init.ts");
const { pasteSteps } = await import("../src/browser-login.ts");
const { PASTE } = await import("../src/console.ts");
const { readCommand } = await import("../src/keystore.ts");
const { stateDir } = await import("../src/state.ts");
const { formatDate, renderQuotas } = await import("../src/view.ts");
const { cliUsageText, snapshot: usageSnapshot } = await import("../src/server.ts");
const { lineIO, paint, wrap } = await import("../src/ui.ts");
const { adapters: realAdapters } = await import("../src/agents/index.ts");
const adapters: Record<AgentId, AgentAdapter> = {
  ...realAdapters,
  claude: {
    ...realAdapters.claude,
    readUsage: async (): Promise<AgentReading> => ({
      agent: "claude",
      fetchedAt: Date.now(),
      warnings: [],
      error: "usage is stubbed in tests",
      pools: [],
    }),
  },
};

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

const SECRET = "sessionKey=sk-ant-sid01-synthetic-secret; other=1";
const ORG_MEMBER = "22222222-2222-4222-8222-222222222222";
const ORG_OWNER = "33333333-3333-4333-8333-333333333333";
const sessionsJson = join(home, ".config", "schmear", "console-sessions.json");
const googleSessionsJson = join(home, ".config", "schmear", "google-sessions.json");
const creditHomes = join(home, ".local", "share", "schmear", "credit-homes");
const ledgerDir = join(home, ".local", "state", "schmear", "ledger");

/** A stubbed platform.claude.com: `status` answers every request; otherwise two API orgs holding $123.45 each. */
function consoleFetch(status = 200, calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    assert.equal(url.host, "platform.claude.com");
    calls.push(url.pathname);
    if (status !== 200) return new Response("{}", { status });
    if (url.pathname === "/api/organizations") {
      return new Response(readFileSync(fixture("console/organizations-two-api.json"), "utf8"));
    }
    return new Response(
      JSON.stringify({
        amount: 12345,
        currency: "USD",
        tranches: [
          {
            granted_amount_minor_units: 20000,
            remaining_amount_minor_units: 12345,
            expires_at: "2099-01-01T00:00:00Z",
          },
        ],
      }),
    );
  }) as typeof fetch;
}

const GOOGLE_COOKIE = "SID=synthetic-google-secret; HSID=1";
const BILLING = "012345-ABCDEF-678901";
const BILLING_2 = "ABCDEF-012345-FEDCBA";

/**
 * A stubbed me.developers.google.com: one signed-in account per entry, then a redirect like a signed-out page. A
 * `billing` of null is a credit not applied to a billing account; `currency` defaults to USD.
 */
function googleFetch(
  accounts: { email: string; billing: string | null; currency?: string }[],
  calls: string[] = [],
): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    assert.equal(url.host, "me.developers.google.com");
    assert.equal((init.headers as Record<string, string>).Cookie, GOOGLE_COOKIE);
    const account = accounts[Number(url.searchParams.get("authuser"))];
    calls.push(`${init.method ?? "GET"} ${url.pathname}`);
    if (!account)
      return new Response("", { status: 302, headers: { Location: "https://accounts.google.com/" } });
    if (init.method !== "POST") {
      return new Response(
        `<script>window.WIZ_global_data = {"SNlM0e":"token","oPEP7c":"${account.email}"};</script>`,
      );
    }
    const offer: unknown[] = new Array(17).fill(null);
    offer[1] = [4102444800, 0]; // 2100-01-01
    offer[6] =
      account.billing === null
        ? null
        : [
            [account.currency ?? "USD", 10],
            [account.currency ?? "USD", 8, 500000000],
            `billingAccounts/${account.billing}`,
          ];
    offer[16] = [4070908800, 0];
    const payload = JSON.stringify([[[19, 2, null, null, null, null, null, null, [1], offer]]]);
    return new Response(`[["wrb.fr","Ro0AYc",${JSON.stringify(payload)},null,null,null,"generic"]]\n`);
  }) as typeof fetch;
}

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
  fetchFn?: typeof fetch,
) => scripted(answers, (io) => init({ yes, cliPath: path }, io, agents, install, fetchFn));
// Synthetic API keys: the stubbed Anthropic check answers each with its org, or 401 for REVOKED_KEY.
const MEMBER_KEY = "sk-ant-api03-synthetic-member-key-0000";
const MEMBER_KEY_2 = "sk-ant-api03-synthetic-member-key-0002";
const OWNER_KEY = "sk-ant-api03-synthetic-owner-key-00000";
const REVOKED_KEY = "sk-ant-api03-synthetic-revoked-key-000";
const GEMINI_KEY = "AQ.synthetic-gemini-key-00000000";
const KEY_ORGS: Record<string, string> = {
  [MEMBER_KEY]: ORG_MEMBER,
  [MEMBER_KEY_2]: ORG_MEMBER,
  [OWNER_KEY]: ORG_OWNER,
};
const ALL_KEYS = [MEMBER_KEY, MEMBER_KEY_2, OWNER_KEY, REVOKED_KEY, GEMINI_KEY];

/** `rest` with the two key-check hosts stubbed; each check's URL is pushed to `urls`. */
function keyFetch(rest: typeof fetch, urls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const headers = init.headers as Record<string, string>;
    if (url.host === "api.anthropic.com") {
      urls.push(url.href);
      const org = KEY_ORGS[headers["x-api-key"] as string];
      return org
        ? new Response("{}", { headers: { "anthropic-organization-id": org } })
        : new Response("{}", { status: 401 });
    }
    if (url.host === "generativelanguage.googleapis.com") {
      urls.push(url.href);
      return new Response("{}", { status: headers["x-goog-api-key"] === GEMINI_KEY ? 200 : 400 });
    }
    return rest(input, init);
  }) as typeof fetch;
}

/**
 * A fake login Keychain behind `sys.run`: `security -i` stores from stdin, schmear's read argv prints, delete removes.
 * Every call is recorded; anything else fails, so the wizard spawns nothing else through `sys`.
 */
function keychain(items: Record<string, string> = {}) {
  const calls: { file: string; args: string[]; input?: string }[] = [];
  const sys: Sys = {
    platform: "darwin",
    home,
    run: async (file, args, input) => {
      calls.push({ file, args, ...(input === undefined ? {} : { input }) });
      const [verb, , service] = args;
      if (file === "/usr/bin/security" && verb === "-i") {
        const added = /^add-generic-password -U -s (\S+) -a schmear -w (\S+)\n$/.exec(input ?? "");
        assert.ok(added, "security -i got an unexpected command");
        items[added[1] as string] = added[2] as string;
        return { code: 0, stdout: "" };
      }
      if (file === "security" && verb === "find-generic-password" && args[3] === "-w") {
        const key = items[service as string];
        return key === undefined ? { code: 44, stdout: "" } : { code: 0, stdout: `${key}\n` };
      }
      if (file === "/usr/bin/security" && verb === "delete-generic-password") {
        const had = Object.hasOwn(items, args[2] as string);
        delete items[args[2] as string];
        return { code: had ? 0 : 44, stdout: "" };
      }
      return assert.fail(`unexpected spawn ${file} ${args.join(" ")}`);
    },
  };
  return { sys, items, calls };
}
/** No API key appears in `text`, nor in any argv the fake Keychain saw. */
const noKeyIn = (text: string, calls: { args: string[] }[] = []) => {
  for (const key of ALL_KEYS) {
    assert.ok(!text.includes(key), `a key leaked into: ${text}`);
    for (const { args } of calls) assert.ok(!args.join(" ").includes(key), "a key leaked into argv");
  }
};
const runUninstall = (yes: boolean, answers: string[] = [], sys = keychain().sys) =>
  scripted(answers, (io) => uninstall({ yes }, io, sys));
type Cookies = NonNullable<Parameters<typeof setupCredits>[5]>;
/** A cookies module whose one Chrome profile holds the Console session SECRET; records each call. */
function fakeCookies() {
  const calls: string[] = [];
  const jar = {
    source: { browser: "chrome", profile: "Default" },
    name: "Chrome · Default",
    browser: "Chrome",
    rows: [],
    version: 0,
  };
  const cookies = {
    findJars: async () => {
      calls.push("findJars");
      return { jars: [jar], searched: [jar.name], problems: [] };
    },
    browserKey: async () => assert.fail("no jar needs a key"),
    jarCookie: () => {
      calls.push("jarCookie");
      return SECRET;
    },
  } as unknown as Cookies;
  return { cookies, calls };
}
const runCredits = (
  answers: string[],
  fetchFn: typeof fetch = consoleFetch(),
  agents = adapters,
  account?: string,
  cookies?: Cookies,
  sys = keychain().sys,
) => scripted(answers, (io) => setupCredits(io, agents, keyFetch(fetchFn), account, sys, cookies));
const runLogin = (header: string, label = "default", fetchFn: typeof fetch = consoleFetch()) =>
  scripted([], (io) => loginConsole(io, header, label, fetchFn));
const runGoogleLogin = (header: string, label: string, fetchFn: typeof fetch) =>
  scripted([], (io) => loginGoogle(io, header, label, fetchFn));

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
    assert.match(out, /Codex\n● default\s+free\n\s+All models\s+[█░]+\s+63%\s+30d/);
    assert.match(out, /Grok\n● default\n\s+All models\s+[█░]+\s+60%\s+7d/);
    assert.match(out, /Antigravity\s+not used/);
    assert.doesNotMatch(out, /Gemini\s+[█░]+/);
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
    assert.equal(
      questions.length,
      2,
      "piped input asks the checklist and the credits offer, no add-subscription menu",
    );
    assert.match(questions[1] as string, /^Set up API credits now\? \(now, later\) \[later\] /);
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
    assert.match((await runInit(true)).out, /Codex · Grok\s+not used/);
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

  const keyRead = (service: string) => readCommand("darwin", service);
  const MAIN_KEY = keyRead("schmear-anthropic-main");
  const setConfig = (change: (config: Record<string, unknown>) => void) => {
    const config = json(configJson);
    change(config);
    writeFileSync(configJson, JSON.stringify(config));
  };
  /** Credit state is shared by later tests, so each credit test leaves no pool or session behind. */
  const clearCredits = () => {
    setConfig((config) => {
      delete config.credits;
    });
    rmSync(sessionsJson, { force: true });
    rmSync(googleSessionsJson, { force: true });
    rmSync(creditHomes, { recursive: true, force: true });
    rmSync(ledgerDir, { recursive: true, force: true });
  };

  it("credits login: a header without sessionKey, with a control character or a bad label saves nothing and never calls the Console", async () => {
    const calls: string[] = [];
    const fetchFn = consoleFetch(200, calls);
    await assert.rejects(runLogin("theme=dark", "default", fetchFn), /no sessionKey/);
    await assert.rejects(runLogin("sessionKey=a\u0001b", "default", fetchFn), /printable ASCII/);
    await assert.rejects(runLogin("sessionKey=é", "default", fetchFn), /printable ASCII/);
    await assert.rejects(runLogin("sessionKey=a\nb=c", "default", fetchFn), /printable ASCII/);
    await assert.rejects(runLogin(SECRET, "Bad Label", fetchFn), /--label/);
    assert.deepEqual(calls, []);
    assert.equal(existsSync(sessionsJson), false);
  });

  it("credits login: a rejected header saves nothing and its error never holds the header", async () => {
    for (const status of [401, 403, 500]) {
      const err = await runLogin(SECRET, "default", consoleFetch(status)).then(
        () => assert.fail("expected a rejection"),
        (e: Error & { out: string }) => e,
      );
      assert.ok(!err.message.includes("sk-ant-sid01") && !err.out.includes("sk-ant-sid01"));
    }
    await assert.rejects(runLogin(SECRET, "default", consoleFetch(401)), {
      message:
        "Console rejected this cookie. Copy the Cookie request header of a signed-in request to platform.claude.com (DevTools → Network).",
    });
    assert.equal(existsSync(sessionsJson), false);
  });

  it("credits login and logout: the validated header is stored 0600 and listed by org, never printed", async () => {
    try {
      const { out } = await runLogin(`Cookie: ${SECRET}\n`, "main");
      assert.deepEqual(json(sessionsJson), { main: { cookie: SECRET } });
      assert.equal(statSync(sessionsJson).mode & 0o777, 0o600);
      assert.match(out, new RegExp(`Synthetic Member Org\\s+${ORG_MEMBER}\\s+\\$123\\.45`));
      assert.match(out, new RegExp(`Synthetic Owner Org\\s+${ORG_OWNER}\\s+\\$123\\.45`));
      assert.doesNotMatch(out, /Chat Organization|sk-ant-sid01/);

      await runLogin("sessionKey=second", "side");
      assert.deepEqual(Object.keys(json(sessionsJson)), ["main", "side"]);
      await scripted([], (io) => logoutConsole(io, "main"));
      assert.deepEqual(json(sessionsJson), { side: { cookie: "sessionKey=second" } });
      await assert.rejects(
        scripted([], (io) => logoutConsole(io, "main")),
        /no Console session main; stored: side$/,
      );
      await scripted([], (io) => logoutConsole(io, "side"));
      await assert.rejects(
        scripted([], (io) => logoutConsole(io, "side")),
        /no Console session side; stored: none$/,
      );
    } finally {
      clearCredits();
    }
  });

  it("credits login drops the cached credit reading of its vendor only", async () => {
    const cached = (key: string) => join(stateDir(), "usage", `${key}.json`);
    mkdirSync(dirname(cached("x")), { recursive: true });
    for (const key of ["claude-credits", "gemini-credits"]) writeFileSync(cached(key), "{}");
    try {
      await runLogin(SECRET, "main");
      assert.deepEqual(
        [existsSync(cached("claude-credits")), existsSync(cached("gemini-credits"))],
        [false, true],
      );
      await runGoogleLogin(GOOGLE_COOKIE, "g", googleFetch([{ email: "me@example.com", billing: BILLING }]));
      assert.equal(existsSync(cached("gemini-credits")), false);
    } finally {
      clearCredits();
    }
  });

  it("credits login onto an existing label says it replaced the session; a new label says saved", async () => {
    try {
      assert.match(
        (await runLogin(SECRET, "main")).out,
        /Saved Console session main\.\nNext: schmear credits$/,
      );
      const { out } = await runLogin("sessionKey=second", "main");
      assert.match(
        out,
        /Replaced Console session main\.\nTo add another login instead, pass a new --label\.\nNext: schmear credits$/,
      );
      assert.deepEqual(json(sessionsJson), { main: { cookie: "sessionKey=second" } });
    } finally {
      clearCredits();
    }
  });

  it("credits login --stdin on a terminal names the paste command; login without a vendor and logout google without a label show usage", () => {
    const cliUrl = new URL("../src/cli.ts", import.meta.url);
    const cli = (...args: string[]) =>
      childProcess.spawnSync(process.execPath, [fileURLToPath(cliUrl), ...args], {
        env: { ...process.env, HOME: home },
        input: "",
        encoding: "utf8",
      });
    // The same cli with stdin claiming to be a terminal; the argv[1] slot is the script name.
    const cliOnTerminal = (...args: string[]) =>
      childProcess.spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `Object.defineProperty(process.stdin, "isTTY", { value: true }); await import(${JSON.stringify(cliUrl.href)});`,
          "schmear",
          ...args,
        ],
        { env: { ...process.env, HOME: home }, input: "", encoding: "utf8" },
      );
    for (const vendor of ["claude", "google"]) {
      const tty = cliOnTerminal("credits", "login", vendor, "--stdin");
      assert.equal(tty.status, 1);
      assert.ok(
        tty.stderr.includes(
          `pipe the Cookie header in: ${PASTE} | schmear credits login ${vendor} --stdin [--label <name>]`,
        ),
      );
      assert.doesNotMatch(tty.stdout + tty.stderr, /Paste the Cookie header/);
    }
    const bare = cli("credits", "login");
    assert.equal(bare.status, 1);
    assert.ok(
      bare.stderr.includes(
        "usage: schmear credits [<account> | login <claude|google> [--stdin] [--label <name>] | logout [google] <label> | remove <id>]",
      ),
    );
    const logout = cli("credits", "logout", "google");
    assert.equal(logout.status, 1);
    assert.match(logout.stderr, /usage: schmear credits logout \[google\] <label>/);
  });

  it("credits: needs a consented claude; with no Console session, paste writes nothing and never reads a browser", async () => {
    await runInit(true);
    const original = readFileSync(configJson, "utf8");
    setConfig((config) => {
      (config.agents as Record<string, { consent: boolean }>)["agy@default"].consent = false;
    });
    const before = readFileSync(configJson, "utf8");
    const fake = fakeCookies();
    const { questions, out } = await runCredits(["paste"], consoleFetch(), adapters, undefined, fake.cookies);
    assert.match(
      questions[0] as string,
      /^How should schmear get your Console session\? \(browser, paste\) \[paste\] /,
    );
    assert.ok(out.includes(pasteSteps("claude")));
    assert.match(out, /Nothing to add\.$/);
    assert.deepEqual(fake.calls, []);
    assert.equal(readFileSync(configJson, "utf8"), before);
    assert.equal(existsSync(sessionsJson), false);
    setConfig((config) => {
      const agents = config.agents as Record<string, { consent: boolean }>;
      agents["claude@default"].consent = false;
      agents["agy@default"].consent = false;
    });
    try {
      await assert.rejects(runCredits([]), /Claude is not set up as a worker/);
      setConfig((config) => {
        const agents = config.agents as Record<string, unknown>;
        agents["claude@k1c"] = {
          ...(agents["claude@default"] as object),
          consent: true,
          home: join(home, "k1c"),
        };
      });
      assert.match((await runCredits([])).out, /Nothing to add\.$/);
    } finally {
      writeFileSync(configJson, original);
    }
  });

  it("credits: with no Console session, a browser import stores the session and continues to the orgs", async () => {
    await runInit(true);
    const before = readFileSync(configJson, "utf8");
    setConfig((config) => {
      (config.agents as Record<string, { consent: boolean }>)["agy@default"].consent = false;
    });
    const fake = fakeCookies();
    try {
      const { questions, out } = await runCredits(
        ["browser", "done"],
        consoleFetch(),
        adapters,
        undefined,
        fake.cookies,
      );
      assert.deepEqual(fake.calls, ["findJars", "jarCookie"]);
      assert.match(out, /Saved Console session default from Chrome · Default/);
      assert.match(out, new RegExp(`Synthetic Member Org\\s+${ORG_MEMBER}\\s+\\$123\\.45\\s+no pool`));
      assert.match(questions[1] as string, /^Add a pool for an org\?/);
      assert.equal(json(sessionsJson).default.cookie, SECRET);
      assert.doesNotMatch(out + questions.join(""), /sk-ant-sid01/);
    } finally {
      clearCredits();
      writeFileSync(configJson, before);
    }
  });

  it("credits: one pool per org, the typed yes gates the write, prior pools stay and the 0.4 entries go", async () => {
    await runInit(true);
    const kept = { org: ORG_OWNER, keyCommand: ["pass", "owner"], overageOff: true };
    setConfig((config) => {
      config.credits = {
        grantUsd: 100,
        cycleDay: 31,
        keyCommand: ["old"],
        taskCapUsd: 10,
        overageOff: true,
        "claude-credits@kept": kept,
      };
    });
    await runLogin(SECRET, "main");
    try {
      const refused = keychain();
      const declined = await runCredits(
        ["claude", ORG_MEMBER, "", MEMBER_KEY, "no", "done", "done"],
        consoleFetch(),
        adapters,
        undefined,
        undefined,
        refused.sys,
      );
      assert.match(declined.out, /Not confirmed; no pool written for Synthetic Member Org/);
      assert.equal(json(configJson).credits.grantUsd, 100);
      assert.deepEqual(refused.items, {});
      assert.ok(!refused.calls.some((c) => c.args[0] === "-i"));

      await assert.rejects(
        runCredits(["claude", ORG_MEMBER, "api-only", "Bad Name"]),
        /invalid answer 'Bad Name'/,
      );
      await assert.rejects(runCredits(["claude", ORG_MEMBER, "api-only", "kept"]), /already exists/);
      const junk = "ghp_synthetic-clipboard-secret";
      const checks: string[] = [];
      const shape = await scripted(["claude", ORG_MEMBER, "api-only", "main", junk], (io) =>
        setupCredits(io, adapters, keyFetch(consoleFetch(), checks), undefined, keychain().sys),
      ).then(
        () => assert.fail("expected a rejection"),
        (e: Error & { out: string }) => e,
      );
      assert.equal(
        shape.message,
        "invalid answer to: Paste Synthetic Member Org's API key (that is not an Anthropic API key (they start with sk-ant-api); copy the key itself)",
      );
      assert.ok(!shape.out.includes(junk));
      assert.deepEqual(checks, []);

      const store = keychain();
      const urls: string[] = [];
      const { questions, out } = await scripted(
        ["claude", ORG_MEMBER, "api-only", "main", MEMBER_KEY, "yes", "done"],
        (io) => setupCredits(io, adapters, keyFetch(consoleFetch(), urls), undefined, store.sys),
      );
      assert.match(
        questions.join("\n"),
        /Paste Synthetic Member Org's API key\nCreate it at platform\.claude\.com\/settings\/keys with Synthetic Member Org selected\. Input is hidden\. Enter alone skips this pool\./,
      );
      assert.ok(
        out.includes(
          "Checking the key…\nThe key works\nStoring the key…\nStored the key in your login Keychain as schmear-anthropic-main\n✓ Added claude-credits@main.",
        ),
        out,
      );
      assert.deepEqual(urls, ["https://api.anthropic.com/v1/models?limit=1"]);
      assert.deepEqual(store.items, { "schmear-anthropic-main": MEMBER_KEY });
      assert.deepEqual(
        store.calls.filter((c) => c.input !== undefined),
        [
          {
            file: "/usr/bin/security",
            args: ["-i"],
            input: `add-generic-password -U -s schmear-anthropic-main -a schmear -w ${MEMBER_KEY}\n`,
          },
        ],
      );
      noKeyIn(out + questions.join("\n") + readFileSync(configJson, "utf8"), store.calls);
      assert.match(
        out,
        new RegExp(`Synthetic Owner Org\\s+${ORG_OWNER}\\s+\\$123\\.45\\s+spent by claude-credits@kept`),
      );
      assert.match(out, new RegExp(`Synthetic Member Org\\s+${ORG_MEMBER}\\s+\\$123\\.45\\s+no pool`));
      assert.match(questions.join("\n"), /Type yes to confirm auto-reload is off/);
      assert.match(questions.join("\n"), /whole credit balance, purchased credits included, down to 2%/);
      assert.match(questions.join("\n"), /turn it off at platform\.claude\.com\/settings\/billing/);
      assert.deepEqual(json(configJson).credits, {
        "claude-credits@kept": kept,
        "claude-credits@main": { org: ORG_MEMBER, keyCommand: MAIN_KEY, overageOff: true },
      });
      assert.doesNotMatch(out + questions.join(""), /sk-ant-sid01/);
      assert.match(out, /Ready\./);
    } finally {
      clearCredits();
    }
  });

  describe("credits: pool owners", () => {
    const keyOf = (name: string) => keyRead(`schmear-anthropic-${name}`);
    const withK1c = async (body: () => Promise<void>) => {
      const before = readFileSync(configJson, "utf8");
      setConfig((config) => {
        const agents = config.agents as Record<string, unknown>;
        agents["claude@k1c"] = {
          consent: true,
          path: (agents["claude@default"] as { path: string }).path,
          home: join(home, "k1c-home"),
        };
        // Claude alone: with Antigravity consented too the wizard opens on the vendor menu.
        (agents["agy@default"] as { consent: boolean }).consent = false;
      });
      await runLogin(SECRET, "main");
      try {
        await body();
      } finally {
        clearCredits();
        writeFileSync(configJson, before);
      }
    };
    const plans = (plan: string) => ({
      ...adapters,
      claude: { ...adapters.claude, find: async () => ({ version: "2.1.330", plan }) },
    });

    it("gives two Max accounts a pool each over two passes, offering neither the owned org nor an owner twice", async () => {
      await runInit(true);
      await withK1c(async () => {
        const first = await runCredits([ORG_MEMBER, "claude@k1c", MEMBER_KEY, "yes", "done"]);
        assert.match(
          first.questions[0] as string,
          new RegExp(`^Add a pool for an org\\? \\(${ORG_MEMBER}, ${ORG_OWNER}, done\\)`),
        );
        assert.match(
          first.questions[1] as string,
          /^Which account owns this pool\? Its runs use that account's CLI login\. \(claude@default, claude@k1c, api-only\)/,
        );
        assert.match(first.out, /Stored the key in your login Keychain as schmear-anthropic-k1c/);
        assert.match(
          first.out,
          /Added claude-credits@k1c\. It runs under claude@k1c \(that login's CLI, settings and MCP servers\) and bills only this org's API key\. Edit "credits" in .* to cap a task with taskCapUsd\./,
        );

        const second = await runCredits([ORG_OWNER, "", OWNER_KEY, "yes"]);
        assert.match(
          second.questions[0] as string,
          new RegExp(`^Add a pool for an org\\? \\(${ORG_OWNER}, done\\)`),
        );
        assert.match(
          second.questions[1] as string,
          /^Which account owns this pool\? Its runs use that account's CLI login\. \(claude@default, api-only\)/,
        );
        assert.deepEqual(json(configJson).credits, {
          "claude-credits@k1c": { org: ORG_MEMBER, keyCommand: keyOf("k1c"), overageOff: true },
          "claude-credits@default": { org: ORG_OWNER, keyCommand: keyOf("default"), overageOff: true },
        });
      });
    });

    it("API-only takes a free name and refuses a consented account's name", async () => {
      await runInit(true);
      await withK1c(async () => {
        await assert.rejects(
          runCredits([ORG_MEMBER, "api-only", "k1c"]),
          /that name belongs to claude@k1c; pick it above/,
        );
        const { out } = await runCredits([ORG_MEMBER, "api-only", "side", MEMBER_KEY, "yes", "done"]);
        assert.match(out, /Added claude-credits@side\. It runs under claude@default \(/);
        assert.deepEqual(json(configJson).credits, {
          "claude-credits@side": { org: ORG_MEMBER, keyCommand: keyOf("side"), overageOff: true },
        });
      });
    });

    const withKeychain = (answers: string[], items: Record<string, string> = {}) => {
      const store = keychain(items);
      return runCredits(answers, consoleFetch(), adapters, undefined, undefined, store.sys).then((r) => {
        noKeyIn(r.out + r.questions.join("\n") + readFileSync(configJson, "utf8"), store.calls);
        return { ...r, ...store };
      });
    };
    const reuseQuestion =
      "A key for claude-credits@main is already in your login Keychain. (use, replace) [use] ";

    it("key entry: a wrong-org key and a rejected key are refused and asked again; Enter alone skips the pool", async () => {
      await runInit(true);
      await withK1c(async () => {
        const { out, questions, calls } = await withKeychain([
          ORG_MEMBER,
          "api-only",
          "main",
          OWNER_KEY,
          REVOKED_KEY,
          "",
          "done",
        ]);
        assert.ok(
          out.includes(
            `Checking the key…\nThe key was not accepted\n! This key belongs to another organization (${ORG_OWNER}), not Synthetic Member Org (${ORG_MEMBER}). In the Console, switch to Synthetic Member Org, create a key there and paste that one.\n`,
          ),
          out,
        );
        assert.ok(
          out.includes(
            "! Anthropic rejected this key (HTTP 401): it is mistyped, revoked or expired. Copy a key from platform.claude.com/settings/keys.\n",
          ),
        );
        assert.match(out, /! No key; no pool written for Synthetic Member Org\./);
        assert.equal(questions.filter((q) => q.startsWith("Paste Synthetic Member Org's API key")).length, 3);
        assert.doesNotMatch(questions.join("\n"), /Type yes/);
        assert.deepEqual(
          calls.map((c) => c.args[0]),
          ["find-generic-password"],
        );
        assert.equal(json(configJson).credits, undefined);
      });
    });

    it("key entry: a working stored key is offered; use asks no paste and stores nothing, replace stores the new key", async () => {
      await runInit(true);
      await withK1c(async () => {
        const used = await withKeychain([ORG_MEMBER, "api-only", "main", "", "yes", "done"], {
          "schmear-anthropic-main": MEMBER_KEY,
        });
        assert.ok(used.out.includes("Checking the stored key…\nThe stored key works\n"));
        assert.equal(used.questions[3], reuseQuestion);
        assert.doesNotMatch(used.questions.join("\n") + used.out, /Paste|Storing the key/);
        assert.ok(!used.calls.some((c) => c.args[0] === "-i"));
        assert.deepEqual(json(configJson).credits["claude-credits@main"].keyCommand, MAIN_KEY);

        clearCredits();
        await runLogin(SECRET, "main");
        const replaced = await withKeychain(
          [ORG_MEMBER, "api-only", "main", "replace", MEMBER_KEY_2, "yes", "done"],
          { "schmear-anthropic-main": MEMBER_KEY },
        );
        assert.match(replaced.questions[4] as string, /^Paste Synthetic Member Org's API key/);
        assert.deepEqual(replaced.items, { "schmear-anthropic-main": MEMBER_KEY_2 });
        assert.deepEqual(json(configJson).credits["claude-credits@main"].keyCommand, MAIN_KEY);
      });
    });

    it("key entry: a stored key that no longer works says why and asks for a new one", async () => {
      await runInit(true);
      await withK1c(async () => {
        const { out, questions, items } = await withKeychain(
          [ORG_MEMBER, "api-only", "main", MEMBER_KEY, "yes", "done"],
          { "schmear-anthropic-main": REVOKED_KEY },
        );
        assert.ok(
          out.includes(
            "Checking the stored key…\nThe stored key does not work\n! Anthropic rejected this key (HTTP 401): it is mistyped, revoked or expired. Copy a key from platform.claude.com/settings/keys. Paste a new one.\n",
          ),
        );
        assert.ok(!questions.includes(reuseQuestion));
        assert.deepEqual(items, { "schmear-anthropic-main": MEMBER_KEY });
      });
    });

    it("with two sessions each org names the session that read it; with one session it does not", async () => {
      await runInit(true);
      await withK1c(async () => {
        const one = await runCredits(["done"]);
        assert.doesNotMatch(one.out + one.questions.join(""), /session main/);

        await runLogin("sessionKey=second", "side");
        const { out, questions } = await runCredits(["done"]);
        assert.match(
          out,
          new RegExp(`Synthetic Member Org · session main {2}${ORG_MEMBER} {2}\\$123\\.45 {2}no pool`),
        );
        assert.match(out, new RegExp(`Synthetic Owner Org · session main {2}${ORG_OWNER}`));
        assert.match(questions[0] as string, /^Add a pool for an org\?/);
        const labels: string[] = [];
        await scripted(["done"], (io) =>
          setupCredits(
            { ...io, select: (m, o, i) => (labels.push(...o.map((x) => x.label)), io.select(m, o, i)) },
            adapters,
            consoleFetch(),
            undefined,
            keychain().sys,
          ),
        );
        assert.deepEqual(labels.slice(0, 2), [
          "Synthetic Member Org (session main)",
          "Synthetic Owner Org (session main)",
        ]);
      });
    });

    it("the org prompt defaults to the first open org, not Done", async () => {
      await runInit(true);
      await withK1c(async () => {
        const { questions } = await runCredits(["done"]);
        assert.match(
          questions[0] as string,
          new RegExp(`\\(${ORG_MEMBER}, ${ORG_OWNER}, done\\) \\[${ORG_MEMBER}\\] $`),
        );
      });
    });

    it("credits <account> skips the owner select and ends after its pool", async () => {
      await runInit(true);
      await withK1c(async () => {
        const { questions, out } = await runCredits(
          [ORG_MEMBER, MEMBER_KEY, "yes"],
          consoleFetch(),
          adapters,
          "k1c",
        );
        assert.equal(questions.length, 3);
        assert.doesNotMatch(questions.join("\n"), /Which account owns/);
        assert.match(out, /Stored the key in your login Keychain as schmear-anthropic-k1c/);
        assert.deepEqual(Object.keys(json(configJson).credits), ["claude-credits@k1c"]);

        await assert.rejects(
          runCredits([], consoleFetch(), adapters, "k1c"),
          /claude@k1c owns claude-credits@k1c already/,
        );
        await assert.rejects(
          runCredits([], consoleFetch(), adapters, "nope"),
          /claude@nope is not a consented account/,
        );
        await assert.rejects(
          runCredits([], consoleFetch(), plans("pro"), "default"),
          /claude@default's plan includes no API credits/,
        );
        await assert.rejects(
          runCredits([], consoleFetch(), adapters, "claude@nope"),
          /claude@nope is not a consented account/,
        );
        await assert.rejects(
          runCredits([], consoleFetch(), adapters, "codex@k1c"),
          /schmear credits takes claude@<name> or agy@<name>/,
        );
      });
    });

    it("reports an unreadable plan apart from a plan without credits", async () => {
      await runInit(true);
      await withK1c(async () => {
        const unreadable = {
          ...adapters,
          claude: { ...adapters.claude, find: async () => ({ version: "2.1.330" }) },
        };
        await assert.rejects(
          runCredits([], consoleFetch(), unreadable, "default"),
          /could not read claude@default's plan; check `claude auth status`/,
        );
      });
    });

    it("shows Max plan ids by name in the owner select", async () => {
      await runInit(true);
      await withK1c(async () => {
        const labels: string[] = [];
        await scripted([ORG_MEMBER, "claude@k1c", MEMBER_KEY, "yes", "done"], (io) =>
          setupCredits(
            {
              ...io,
              select: (message, options, initial) => {
                labels.push(...options.map((o) => o.label));
                return io.select(message, options, initial);
              },
            },
            adapters,
            keyFetch(consoleFetch()),
            undefined,
            keychain().sys,
          ),
        );
        assert.ok(labels.includes("claude@default · Max 5x · $100 / month"), labels.join("\n"));
      });
    });
  });

  it("credits: the account's own pool silences its credits hint while keeping the plan credit amount", async () => {
    const hint = /Max 5x\s+\$100 API credits \/ month · schmear credits/;
    assert.match((await runInit(true)).out, hint);
    setConfig((config) => {
      config.credits = {
        "claude-credits@default": { org: ORG_MEMBER, keyCommand: MAIN_KEY, overageOff: true },
      };
    });
    try {
      const { out } = await runInit(true);
      assert.doesNotMatch(out, hint);
      assert.match(out, /Max 5x\s+\$100 API credits \/ month$/m);
      assert.match(out, /API credits: No stored Console session can read org /);
    } finally {
      clearCredits();
    }
  });

  describe("credits nudge in init", () => {
    it("shows the panel and logs the rerun hint on later", async () => {
      await runLogin(SECRET, "main");
      try {
        const { questions, out } = await runInit(false, [
          "claude@default, codex@default, grok@default",
          "later",
        ]);
        assert.match(questions[1] as string, /^Set up API credits now\? \(now, later\) \[later\] /);
        assert.match(
          out,
          /API credits\nClaude · default {2}\$100 \/ month\nschmear spends these on a separate API-key lane, routed like any quota: whatever would expire unused goes first, so a grant near its expiry is spent before your subscriptions\. Link the plan to a Console org in claude\.ai Settings > Billing > API credits first\.\nPurchased credits in the same org are spent too, down to 2%\./,
        );
        assert.match(out, /Run `schmear credits` anytime to spend them\./);
      } finally {
        clearCredits();
      }
    });

    it("with no stored session asks too, and later never reads a session or a browser", async () => {
      const saved = readFileSync(configJson, "utf8");
      const fetched: string[] = [];
      try {
        for (const ticked of ["claude@default", "claude@default, agy@default"]) {
          const { questions, out } = await runInit(
            false,
            [ticked, "later"],
            cliPath,
            adapters,
            countInstall,
            consoleFetch(200, fetched),
          );
          assert.equal(questions.length, 2);
          assert.match(questions[1] as string, /^Set up API credits now\? \(now, later\) \[later\] /);
          assert.match(out, /Run `schmear credits` anytime to spend them\./);
          assert.doesNotMatch(out, /DevTools|How should schmear get/);
        }
        assert.deepEqual(fetched, []);
      } finally {
        clearCredits();
        writeFileSync(configJson, saved);
      }
    });

    it("runs the credits wizard inline on now without a second start/end", async () => {
      let starts = 0;
      let ends = 0;
      const calls: string[] = [];
      await runLogin(SECRET, "main");
      try {
        const { out } = await scripted(["", "now", "done"], (io) =>
          init(
            { yes: false, cliPath },
            {
              ...io,
              start: (title, subtitle) => {
                starts++;
                io.start(title, subtitle);
              },
              end: (text) => {
                ends++;
                io.end(text);
              },
            },
            adapters,
            countInstall,
            consoleFetch(200, calls),
          ),
        );
        assert.equal(starts, 1);
        assert.equal(ends, 1);
        assert.ok(calls.length > 0);
        assert.match(out, /Synthetic Member Org/);
        assert.match(out, /Done\./);
      } finally {
        clearCredits();
      }
    });

    it("logs a wizard error as warn and finishes init", async () => {
      await runLogin(SECRET, "main");
      try {
        const { out } = await runInit(false, ["", "now"], cliPath, adapters, countInstall, consoleFetch(401));
        assert.match(
          out,
          /! Console session main expired\. Sign in at platform\.claude\.com, then run: schmear credits login claude --label main/,
        );
        assert.match(out, /Done\./);
      } finally {
        clearCredits();
      }
    });

    describe("ChatGPT and Google rows", () => {
      const withCodexPlan = (plan: string) => ({
        ...adapters,
        codex: { ...adapters.codex, find: async () => ({ version: "0.147.0", plan }) },
      });
      const chatgptSentence = "ChatGPT plan credits are not spent: Codex cannot draw on them.";
      const googleSentence =
        "schmear spends Google credits through Antigravity on a Gemini API key. Apply the credit at me.developers.google.com/benefits, then run schmear credits.";
      const keepConfig = async (body: () => Promise<void>) => {
        const saved = readFileSync(configJson, "utf8");
        try {
          await body();
        } finally {
          clearCredits();
          writeFileSync(configJson, saved);
        }
      };

      it("lists Claude, a pro Codex account and Antigravity in order, then the select", async () => {
        await keepConfig(async () => {
          await runLogin(SECRET, "main");
          const { questions, out } = await runInit(
            false,
            ["claude@default, codex@default, agy@default", "later"],
            cliPath,
            withCodexPlan(" Pro "),
          );
          assert.match(
            out,
            new RegExp(
              `API credits\\nClaude · default {2}\\$100 / month\\nChatGPT Pro · default {2}\\$100, \\$200 or \\$500 / month by Pro tier\\nGoogle AI · agy@default {2}Pro \\$10, Ultra 5x \\$40, Ultra 20x \\$100 / month in Google Cloud credits\\nschmear spends these .*\\nPurchased credits .*\\n${chatgptSentence.replaceAll(".", "\\.")}\\n${googleSentence.replaceAll(".", "\\.")}`,
            ),
          );
          assert.match(questions[1] as string, /^Set up API credits now\?/);
        });
      });

      it("lists a team Codex account alone without the Claude select", async () => {
        await keepConfig(async () => {
          const { questions, out } = await runInit(false, ["codex@default"], cliPath, withCodexPlan("team"));
          assert.match(
            out,
            new RegExp(
              `API credits\\nChatGPT Business · default {2}\\$20 or \\$100 per seat / month, pooled up to \\$500\\n${chatgptSentence.replaceAll(".", "\\.")}`,
            ),
          );
          assert.doesNotMatch(out, /schmear spends these|Google AI|Google credits/);
          assert.equal(questions.length, 1);
        });
      });

      it("lists a Google row per Antigravity account alone, offers the select, and hides the row once the account owns a pool", async () => {
        await keepConfig(async () => {
          const row =
            "Google AI · agy@default  Pro $10, Ultra 5x $40, Ultra 20x $100 / month in Google Cloud credits";
          await runGoogleLogin(
            GOOGLE_COOKIE,
            "g",
            googleFetch([{ email: "me@example.com", billing: BILLING }]),
          );
          const first = await runInit(false, ["agy@default", "later"]);
          assert.match(
            first.out,
            new RegExp(
              `API credits\\n${row.replaceAll("$", "\\$")}\\n${googleSentence.replaceAll(".", "\\.")}`,
            ),
          );
          assert.doesNotMatch(first.out, /ChatGPT|Purchased credits/);
          assert.match(first.questions[1] as string, /^Set up API credits now\?/);

          setConfig((config) => {
            config.credits = {
              "gemini-credits@default": { keyCommand: ["x"], overageOff: true, billingAccount: BILLING },
            };
          });
          rmSync(googleSessionsJson);
          const second = await runInit(false, ["agy@default"]);
          assert.doesNotMatch(second.out, /Google AI|Google credits/);
          assert.equal(second.questions.length, 1);
        });
      });

      it("shows no row for a plan without credits or an unticked Antigravity", async () => {
        await keepConfig(async () => {
          const { out } = await runInit(false, ["codex@default"], cliPath, withCodexPlan("plus"));
          assert.doesNotMatch(out, /API credits\n|ChatGPT|Google AI/);
        });
      });
    });

    it("is not shown with the account's own credit pool, with --yes, or for a pro plan", async () => {
      const yes = await runInit(true);
      assert.deepEqual(yes.questions, []);
      assert.doesNotMatch(yes.out, /Set up API credits now|Run `schmear credits`/);

      const proAdapters = {
        ...adapters,
        claude: {
          ...adapters.claude,
          find: async () => ({ version: "2.1.330", email: "me@x.com", plan: "pro" }),
        },
      };
      const pro = await runInit(false, [""], cliPath, proAdapters);
      assert.equal(pro.questions.length, 1);
      assert.doesNotMatch(pro.out, /API credits\n|Run `schmear credits`/);

      // An API-only pool belongs to no account, so the default account's row stays.
      setConfig((config) => {
        config.credits = {
          "claude-credits@main": { org: ORG_MEMBER, keyCommand: MAIN_KEY, overageOff: true },
        };
      });
      try {
        const apiOnly = await runInit(false, ["claude@default, codex@default, grok@default", "later"]);
        assert.match(apiOnly.out, /Claude · default {2}\$100 \/ month/);
      } finally {
        clearCredits();
      }

      setConfig((config) => {
        config.credits = {
          "claude-credits@default": { org: ORG_MEMBER, keyCommand: MAIN_KEY, overageOff: true },
        };
      });
      try {
        const pooled = await runInit(false, [""]);
        assert.equal(pooled.questions.length, 1);
        assert.doesNotMatch(pooled.out, /API credits\n|Run `schmear credits`/);
      } finally {
        clearCredits();
      }
    });
  });

  it("credits remove: drops the config entry and the ledger, keeps the others; an unknown id fails", async () => {
    const pool = (org: string) => ({ org, keyCommand: MAIN_KEY, overageOff: true });
    setConfig((config) => {
      config.credits = {
        "claude-credits@main": pool(ORG_MEMBER),
        "claude-credits@side": pool(ORG_OWNER),
        grantUsd: 100,
      };
    });
    mkdirSync(ledgerDir, { recursive: true });
    for (const id of ["main", "side"]) writeFileSync(join(ledgerDir, `claude-credits@${id}.jsonl`), "");
    const store = keychain({ "schmear-anthropic-main": MEMBER_KEY, "schmear-anthropic-side": OWNER_KEY });
    const remove = (id: string) => scripted([], (io) => removeCredit(io, id, store.sys));
    try {
      const { out } = await remove("claude-credits@main");
      assert.match(out, /Removed claude-credits@main/);
      assert.ok(
        out.includes(
          "✓ Deleted the API key schmear stored as schmear-anthropic-main in your login Keychain. The key still works at the vendor: revoke it at platform.claude.com/settings/keys.",
        ),
      );
      assert.deepEqual(store.calls.at(-1), {
        file: "/usr/bin/security",
        args: ["delete-generic-password", "-s", "schmear-anthropic-main"],
      });
      assert.deepEqual(Object.keys(json(configJson).credits), ["claude-credits@side", "grantUsd"]);
      assert.equal(existsSync(join(ledgerDir, "claude-credits@main.jsonl")), false);
      assert.equal(existsSync(join(ledgerDir, "claude-credits@side.jsonl")), true);
      await remove("grantUsd");
      await assert.rejects(
        remove("claude-credits@main"),
        /no credit pool claude-credits@main; configured: claude-credits@side$/,
      );
      assert.deepEqual(Object.keys(json(configJson).credits), ["claude-credits@side"]);
      // The side pool reads main's item, so it is not schmear's own key for side and stays.
      const side = await remove("claude-credits@side");
      assert.ok(side.out.includes(`Your API key stays where \`${MAIN_KEY.join(" ")}\` reads it.`));
      assert.deepEqual(store.items, { "schmear-anthropic-side": OWNER_KEY });
      assert.equal(store.calls.length, 1);
      await assert.rejects(
        remove("claude-credits@side"),
        /no credit pool claude-credits@side; configured: none$/,
      );

      setConfig((config) => {
        config.credits = {
          "claude-credits@gone": {
            org: ORG_MEMBER,
            keyCommand: keyRead("schmear-anthropic-gone"),
            overageOff: true,
          },
        };
      });
      assert.ok(
        (await remove("claude-credits@gone")).out.includes(
          "! Could not delete the stored key schmear-anthropic-gone; delete it in Keychain Access.",
        ),
      );
    } finally {
      clearCredits();
    }
  });

  describe("credits: Google", () => {
    const agyKey = keyRead("schmear-gemini-default");
    const withAgy = async (body: () => Promise<void>) => {
      const before = readFileSync(configJson, "utf8");
      setConfig((config) => {
        (config.agents as Record<string, { consent: boolean }>)["agy@default"].consent = true;
      });
      try {
        await body();
      } finally {
        clearCredits();
        writeFileSync(configJson, before);
      }
    };
    const one = [{ email: "me@example.com", billing: BILLING }];

    it("login: stores the validated header 0600 and prints each account's credit, never the header", async () => {
      try {
        const calls: string[] = [];
        const accounts = [...one, { email: "work@example.com", billing: null }];
        const { out } = await runGoogleLogin(`Cookie: ${GOOGLE_COOKIE}\n`, "g", googleFetch(accounts, calls));
        assert.deepEqual(json(googleSessionsJson), { g: { cookie: GOOGLE_COOKIE } });
        assert.equal(statSync(googleSessionsJson).mode & 0o777, 0o600);
        assert.equal(existsSync(sessionsJson), false);
        assert.match(
          out,
          new RegExp(
            `me@example\\.com\\s+\\$8\\.50 of \\$10\\.00\\s+expires ${formatDate(4102444800 * 1000)} · ${BILLING}`,
          ),
        );
        assert.match(out, /work@example\.com\s+Not applied/);
        assert.match(out, /Saved Google session g\./);
        assert.doesNotMatch(out, /synthetic-google-secret/);
        assert.deepEqual(calls, [
          "GET /benefits",
          "POST /_/GoogleDeveloperProfile/data/batchexecute",
          "GET /benefits",
          "POST /_/GoogleDeveloperProfile/data/batchexecute",
          "GET /benefits",
        ]);
      } finally {
        clearCredits();
      }
    });

    it("login: a signed-out session, a control character or a bad label saves nothing", async () => {
      const calls: string[] = [];
      const err = await runGoogleLogin(GOOGLE_COOKIE, "g", googleFetch([], calls)).then(
        () => assert.fail("expected a rejection"),
        (e: Error & { out: string }) => e,
      );
      assert.equal(
        err.message,
        "Google rejected this cookie. Copy the Cookie request header of a signed-in request to me.developers.google.com (DevTools → Network).",
      );
      assert.ok(
        !err.message.includes("synthetic-google-secret") && !err.out.includes("synthetic-google-secret"),
      );
      const before = calls.length;
      await assert.rejects(runGoogleLogin("SID=a\u0001b", "g", googleFetch(one, calls)), /printable ASCII/);
      await assert.rejects(runGoogleLogin(GOOGLE_COOKIE, "Bad Label", googleFetch(one, calls)), /--label/);
      assert.equal(calls.length, before);
      assert.equal(existsSync(googleSessionsJson), false);
    });

    it("with Claude and Antigravity consented the menu shows with or without sessions, preselecting the first vendor with no pool", async () => {
      await runInit(true);
      await withAgy(async () => {
        const menu = async () => (await runCredits(["done"])).questions[0] as string;
        const opens = (initial: string) =>
          new RegExp(`^What do you want to add\\? \\(claude, google, done\\) \\[${initial}\\] $`);
        assert.match(await menu(), opens("claude"));
        await runLogin(SECRET, "main");
        assert.match(await menu(), opens("claude"));
        const pool = { keyCommand: MAIN_KEY, overageOff: true };
        setConfig((config) => {
          config.credits = { "claude-credits@default": { ...pool, org: ORG_MEMBER } };
        });
        assert.match(await menu(), opens("google"));
        setConfig((config) => {
          config.credits = {
            "claude-credits@default": { ...pool, org: ORG_MEMBER },
            "gemini-credits@default": { ...pool, billingAccount: BILLING },
          };
        });
        assert.match(await menu(), opens("done"));
      });
    });

    it("credits agy@<n> with no Google session asks import-or-paste; paste ends with nothing to add", async () => {
      await runInit(true);
      await withAgy(async () => {
        const { questions, out } = await runCredits(["paste"], consoleFetch(), adapters, "agy@default");
        assert.match(questions[0] as string, /^How should schmear get your Google session\?/);
        assert.ok(out.includes(pasteSteps("google")));
        assert.match(out, /Nothing to add\.$/);
        assert.doesNotMatch(out, /No Google credit is applied/);
      });
    });

    it("the Google credit prompt defaults to the first open billing account, not Done", async () => {
      await runInit(true);
      await withAgy(async () => {
        await runGoogleLogin(GOOGLE_COOKIE, "g", googleFetch(one));
        const { questions } = await runCredits(["google", "done", "done"], googleFetch(one));
        assert.match(questions[1] as string, new RegExp(`\\(${BILLING}, done\\) \\[${BILLING}\\] $`));
      });
    });

    it("login onto an existing label says it replaced the session; a new label says saved", async () => {
      try {
        assert.match(
          (await runGoogleLogin(GOOGLE_COOKIE, "g", googleFetch(one))).out,
          /Saved Google session g\.\nNext: schmear credits$/,
        );
        const { out } = await runGoogleLogin(GOOGLE_COOKIE, "g", googleFetch(one));
        assert.match(
          out,
          /Replaced Google session g\.\nTo add another login instead, pass a new --label\.\nNext: schmear credits$/,
        );
      } finally {
        clearCredits();
      }
    });

    it("logout google removes only that Google session; an unknown label fails", async () => {
      try {
        await runLogin(SECRET, "g");
        await runGoogleLogin(GOOGLE_COOKIE, "g", googleFetch(one));
        await scripted([], (io) => logoutConsole(io, "g", "google"));
        assert.deepEqual(json(googleSessionsJson), {});
        assert.deepEqual(json(sessionsJson), { g: { cookie: SECRET } });
        await assert.rejects(
          scripted([], (io) => logoutConsole(io, "g", "google")),
          /no Google session g; stored: none$/,
        );
      } finally {
        clearCredits();
      }
    });

    it("the wizard writes a gemini-credits pool for agy@default with the billing account, gated on a typed yes", async () => {
      await runInit(true);
      await withAgy(async () => {
        await runGoogleLogin(GOOGLE_COOKIE, "g", googleFetch(one));
        const declined = await runCredits(
          ["google", BILLING, "agy@default", GEMINI_KEY, "no", "done", "done"],
          googleFetch(one),
        );
        assert.match(declined.out, new RegExp(`Not confirmed; no pool written for ${BILLING}`));
        assert.equal(json(configJson).credits, undefined);

        const store = keychain();
        const { questions, out } = await runCredits(
          ["google", BILLING, "agy@default", GEMINI_KEY, "yes", "done"],
          googleFetch(one),
          adapters,
          undefined,
          undefined,
          store.sys,
        );
        assert.match(questions[0] as string, /^What do you want to add\? \(claude, google, done\)/);
        assert.match(
          questions[1] as string,
          new RegExp(`^Add a pool for a Google credit\\? \\(${BILLING}, done\\)`),
        );
        assert.match(
          questions[2] as string,
          /^Which account owns this pool\? Its runs use that account's CLI login\. \(agy@default\)/,
        );
        assert.match(out, new RegExp(`me@example\\.com\\s+\\$8\\.50 of \\$10\\.00.*${BILLING}.*no pool`));
        assert.equal(
          questions[3],
          `Paste ${BILLING}'s API key\nCreate it at aistudio.google.com/apikey in the project that bills ${BILLING}. Input is hidden. Enter alone skips this pool. `,
        );
        assert.ok(out.includes("Stored the key in your login Keychain as schmear-gemini-default"));
        assert.deepEqual(store.items, { "schmear-gemini-default": GEMINI_KEY });
        const text = questions.join("\n");
        noKeyIn(out + text + readFileSync(configJson, "utf8"), store.calls);
        assert.match(
          text,
          new RegExp(
            `confirm this key's project bills to ${BILLING}\\. Credit runs do not load your Antigravity settings`,
          ),
        );
        assert.match(text, /it cannot see your AI Studio prepaid balance/);
        assert.deepEqual(json(configJson).credits, {
          "gemini-credits@default": { keyCommand: agyKey, overageOff: true, billingAccount: BILLING },
        });
        assert.doesNotMatch(out + text, /synthetic-google-secret/);
        assert.match(
          out,
          /Added gemini-credits@default\. It runs under agy@default in its own Antigravity home and bills only this Gemini API key\./,
        );
      });
    });

    it("does not offer a billing account an existing pool owns, nor an owner that has a pool", async () => {
      await runInit(true);
      await withAgy(async () => {
        await runGoogleLogin(GOOGLE_COOKIE, "g", googleFetch(one));
        setConfig((config) => {
          config.credits = {
            "gemini-credits@default": { keyCommand: agyKey, overageOff: true, billingAccount: BILLING },
          };
        });
        const owned = await runCredits(["google", "done"], googleFetch(one));
        assert.match(owned.out, new RegExp(`${BILLING}.*spent by gemini-credits@default`));
        assert.doesNotMatch(owned.questions.join("\n"), /Add a pool for a Google credit/);

        const two = [...one, { email: "two@example.com", billing: BILLING_2 }];
        const noOwner = await runCredits(["google", "done"], googleFetch(two));
        assert.match(noOwner.out, /Every consented Antigravity account owns a gemini-credits pool already/);
        assert.doesNotMatch(noOwner.questions.join("\n"), /Add a pool for a Google credit/);

        setConfig((config) => {
          const agents = config.agents as Record<string, unknown>;
          agents["agy@k1c"] = { ...(agents["agy@default"] as object), home: join(home, "k1c-agy") };
        });
        const next = await runCredits(
          ["google", BILLING_2, "agy@k1c", GEMINI_KEY, "yes", "done"],
          googleFetch(two),
        );
        assert.match(
          next.questions[1] as string,
          new RegExp(`^Add a pool for a Google credit\\? \\(${BILLING_2}, done\\)`),
        );
        assert.match(
          next.questions[2] as string,
          /^Which account owns this pool\? Its runs use that account's CLI login\. \(agy@k1c\)/,
        );
        assert.deepEqual(Object.keys(json(configJson).credits), [
          "gemini-credits@default",
          "gemini-credits@k1c",
        ]);
        assert.equal(json(configJson).credits["gemini-credits@k1c"].billingAccount, BILLING_2);
      });
    });

    it("credits agy@<n> offers only that owner and ends after its pool, and refuses a missing or owning account", async () => {
      await runInit(true);
      await withAgy(async () => {
        await runGoogleLogin(GOOGLE_COOKIE, "g", googleFetch(one));
        setConfig((config) => {
          const agents = config.agents as Record<string, unknown>;
          agents["agy@k1c"] = { ...(agents["agy@default"] as object), home: join(home, "k1c-agy") };
        });
        // The Console fetch refuses Google hosts, so these errors come before any read.
        await assert.rejects(
          runCredits([], consoleFetch(), adapters, "agy@nope"),
          /agy@nope is not a consented account/,
        );
        const { questions, out } = await runCredits(
          [BILLING, "", GEMINI_KEY, "yes"],
          googleFetch(one),
          adapters,
          "agy@k1c",
        );
        assert.match(out, /Added gemini-credits@k1c\. It runs under agy@k1c in its own Antigravity home/);
        assert.equal(questions.length, 4);
        assert.doesNotMatch(questions.join("\n"), /What do you want to add/);
        assert.match(
          questions[1] as string,
          /^Which account owns this pool\? Its runs use that account's CLI login\. \(agy@k1c\)/,
        );
        assert.deepEqual(Object.keys(json(configJson).credits), ["gemini-credits@k1c"]);
        await assert.rejects(
          runCredits([], consoleFetch(), adapters, "agy@k1c"),
          /agy@k1c owns gemini-credits@k1c already/,
        );
      });
    });

    it("does not offer a credit that is not in USD, and warns naming its billing account", async () => {
      await runInit(true);
      await withAgy(async () => {
        await runGoogleLogin(GOOGLE_COOKIE, "g", googleFetch(one));
        const mixed = [...one, { email: "eu@example.com", billing: BILLING_2, currency: "EUR" }];
        const { questions, out } = await runCredits(["google", "done", "done"], googleFetch(mixed));
        assert.match(
          out,
          new RegExp(`! billing account ${BILLING_2}: Google credit is in EUR; schmear meters USD`),
        );
        assert.match(
          questions[1] as string,
          new RegExp(`^Add a pool for a Google credit\\? \\(${BILLING}, done\\)`),
        );
      });
    });

    it("needs a consented Antigravity account; with agy but no Claude, runs the Google branch alone, asking import-or-paste when there is no Google session", async () => {
      await runInit(true);
      await withAgy(async () => {
        await runGoogleLogin(GOOGLE_COOKIE, "g", googleFetch(one));
        setConfig((config) => {
          (config.agents as Record<string, { consent: boolean }>)["agy@default"].consent = false;
        });
        await assert.rejects(
          runCredits([], googleFetch(one), adapters, "agy@default"),
          /Antigravity is not set up as a worker/,
        );
        setConfig((config) => {
          const agents = config.agents as Record<string, unknown>;
          agents["agy@k1c"] = {
            ...(agents["agy@default"] as object),
            consent: true,
            home: join(home, "k1c-agy"),
          };
        });
        const added = await runCredits(["google", "done", "done"], googleFetch(one));
        assert.match(added.questions[1] as string, /^Add a pool for a Google credit\?/);
        setConfig((config) => {
          delete (config.agents as Record<string, unknown>)["agy@k1c"];
          (config.agents as Record<string, { consent: boolean }>)["agy@default"].consent = true;
          (config.agents as Record<string, { consent: boolean }>)["claude@default"].consent = false;
        });
        const direct = await runCredits(["done"], googleFetch(one));
        assert.match(direct.questions[0] as string, /^Add a pool for a Google credit\?/);
        rmSync(googleSessionsJson);
        const { questions, out } = await runCredits([]);
        assert.match(questions[0] as string, /^How should schmear get your Google session\?/);
        assert.match(out, /Nothing to add\.$/);
        assert.doesNotMatch(out, /No Google credit is applied/);
      });
    });
  });

  it("credits remove: also deletes the pool's credit home, and only that one", async () => {
    const pool = { keyCommand: MAIN_KEY, overageOff: true, billingAccount: BILLING };
    setConfig((config) => {
      config.credits = { "gemini-credits@default": pool, "gemini-credits@k1c": pool };
    });
    for (const id of ["default", "k1c"])
      mkdirSync(join(creditHomes, `gemini-credits@${id}`), { recursive: true });
    try {
      const { sys } = keychain();
      await scripted([], (io) => removeCredit(io, "gemini-credits@default", sys));
      assert.equal(existsSync(join(creditHomes, "gemini-credits@default")), false);
      assert.equal(existsSync(join(creditHomes, "gemini-credits@k1c")), true);
      await scripted([], (io) => removeCredit(io, "gemini-credits@k1c", sys));
      assert.equal(existsSync(creditHomes), true);
    } finally {
      clearCredits();
    }
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
    assert.match(out, /● w\s+free\n\s+All models\s+[█░]+\s+63%\s+30d/);
    assert.deepEqual(json(configJson).agents["codex@w"], { ...stored, path: join(bin, "codex") });

    await runInit(false, ["claude@default, codex@default, grok@default, agy@default"]);
    assert.equal(json(configJson).agents["codex@w"].consent, false);
    assert.match((await runInit(true)).out, /○ w\s+not used/);
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
          "Set up API credits now?",
        ]);
        assert.match(
          out,
          /Linking claude@work: first sign in to the account you're linking at claude\.ai in your browser/,
        );
        assert.match(out, /Opening Claude's sign-in…/);
        assert.match(out, /Added claude@work {2}work@x\.com · pro/);
        assert.match(out, /● work\s+pro\n\s+All models\s+[█░]+\s+50%\s+7d/);
        assert.match(out, /● default\s+Max 5x\s+\$100 API credits \/ month · schmear credits/);
        assert.doesNotMatch(out, /● work.*API credits/);
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
        const noAddMenu: InitIO["select"] = async (message, _options, initial) => {
          assert.notEqual(message, "Add another subscription?");
          return initial;
        };
        const piped = await scripted([""], (io) =>
          init({ yes: false, cliPath }, { ...io, select: noAddMenu }, claudeWith("w@x.com"), countInstall),
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
        assert.ok(labels[0]?.includes("claude@default  me@x.com · Max 5x"));
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
        credits: {
          "claude-credits@main": { org: ORG_MEMBER, keyCommand: MAIN_KEY, overageOff: true },
          "gemini-credits@g": { keyCommand: ["pass", "gemini"], overageOff: true, billingAccount: BILLING },
        },
      }),
    );

    const store = keychain({ "schmear-anthropic-main": MEMBER_KEY });
    const refused = await runUninstall(false, ["no"], store.sys);
    assert.match(refused.out, /Nothing removed/);
    assert.match(
      refused.questions[0] as string,
      /\nand the API keys schmear stored: schmear-anthropic-main $/,
    );
    assert.deepEqual(store.calls, []);
    assert.ok(existsSync(claudeState) && existsSync(configJson));

    const { out } = await runUninstall(false, ["yes"], store.sys);
    for (const host of ["Claude Code", "Codex", "Grok", "Antigravity"]) {
      assert.match(out, new RegExp(`${host}\\s+removed`));
    }
    assert.match(out, /Your codex@w login stays in ~\/\.codex-w\./);
    assert.ok(existsSync(accountDir));
    assert.equal(existsSync(made), false);
    assert.match(out, /Deleted ~\/\.local\/share\/schmear/);
    assert.doesNotMatch(out, /Your claude@2 login stays/);
    assert.ok(
      out.includes(
        "✓ Deleted the API key schmear stored as schmear-anthropic-main in your login Keychain. The key still works at the vendor: revoke it at platform.claude.com/settings/keys.",
      ),
    );
    assert.deepEqual(store.items, {});
    assert.ok(out.includes("Your gemini-credits@g API key stays where `pass gemini` reads it."));
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

describe("desktop app", () => {
  const brew = join(bin, "brew");
  const trayPath = join(home, ".local", "bin", "schmear-tray");
  const appDir = join(home, "Applications", "Schmear.app");
  const answer = (value: string) => async (_: string, options: { value: string }[]) => {
    assert.deepEqual(
      options.map((o) => o.value),
      ["install", "skip"],
    );
    return value;
  };

  /** A stub IO recording what ran and launched; `exit` is run's result, `onRun` its side effect. */
  function stub(select: InitIO["select"], exit = 0, onRun = () => {}) {
    const seen = {
      runs: [] as [string, string[]][],
      launches: [] as [string, string[]][],
      logs: [] as string[],
    };
    const io = {
      select,
      run: async (command: string, args: string[]) => {
        seen.runs.push([command, args]);
        onRun();
        return exit;
      },
      launch: (command: string, args: string[]) => seen.launches.push([command, args]),
      log: (kind: string, text: string) => seen.logs.push(`${kind}: ${text}`),
    } as unknown as InitIO;
    return { io, seen };
  }
  const clean = () => {
    rmSync(appDir, { recursive: true, force: true });
    rmSync(trayPath, { force: true });
    rmSync(brew, { force: true });
  };
  const addBrew = () => {
    writeFileSync(brew, "#!/bin/sh\n");
    chmodSync(brew, 0o755);
  };

  it("macOS opens an installed app", async () => {
    clean();
    mkdirSync(appDir, { recursive: true });
    const { io, seen } = stub(answer("skip"));
    await desktopApp(io, "darwin", home);
    assert.deepEqual(seen.launches, [["open", [appDir]]]);
    assert.deepEqual(seen.logs, ["ok: Opened the menu bar app."]);
    clean();
  });

  it("macOS with brew offers the install and opens the app, or does nothing on skip", async () => {
    clean();
    addBrew();
    const install = stub(answer("install"), 0, () => mkdirSync(appDir, { recursive: true }));
    await desktopApp(install.io, "darwin", home);
    assert.deepEqual(install.seen.runs, [[brew, ["install", "--cask", "kevin1chun/tap/schmear"]]]);
    assert.deepEqual(install.seen.launches, [["open", [appDir]]]);
    clean();
    addBrew();
    const skip = stub(answer("skip"));
    await desktopApp(skip.io, "darwin", home);
    assert.deepEqual(skip.seen.runs, []);
    assert.deepEqual(skip.seen.launches, []);
    clean();
  });

  it("macOS warns when brew fails", async () => {
    clean();
    addBrew();
    const { io, seen } = stub(answer("install"), 1);
    await desktopApp(io, "darwin", home);
    assert.deepEqual(seen.logs, ["warn: Menu bar app not installed (brew exited 1)."]);
    assert.deepEqual(seen.launches, []);
    clean();
  });

  it("macOS without brew prints the link and asks nothing", async () => {
    clean();
    const { io, seen } = stub(async () => assert.fail("select called"));
    await desktopApp(io, "darwin", home);
    assert.deepEqual(seen.logs, [
      "info: Menu bar app: https://github.com/kevin1chun/schmear#menu-bar-and-tray-apps",
    ]);
    assert.deepEqual(seen.runs, []);
  });

  it("Linux opens an installed tray app", async () => {
    clean();
    mkdirSync(dirname(trayPath), { recursive: true });
    writeFileSync(trayPath, "");
    const { io, seen } = stub(answer("skip"));
    await desktopApp(io, "linux", home);
    assert.deepEqual(seen.launches, [[trayPath, []]]);
    assert.deepEqual(seen.logs, ["ok: Opened the tray app."]);
    clean();
  });

  it("Linux installs with the packaged script, and warns without launching when it fails", async () => {
    clean();
    const failed = stub(answer("install"), 1);
    await desktopApp(failed.io, "linux", home);
    const [[command, [script]]] = failed.seen.runs as [[string, string[]]];
    assert.equal(command, "sh");
    assert.ok(
      isAbsolute(script as string) && (script as string).endsWith(join("scripts", "install-tray.sh")),
    );
    assert.deepEqual(failed.seen.logs, [
      "warn: Tray app not installed (exit 1); see https://github.com/kevin1chun/schmear#linux-tray-app",
    ]);
    assert.deepEqual(failed.seen.launches, []);
    const ok = stub(answer("install"), 0, () => {
      mkdirSync(dirname(trayPath), { recursive: true });
      writeFileSync(trayPath, "");
    });
    await desktopApp(ok.io, "linux", home);
    assert.deepEqual(ok.seen.launches, [[trayPath, []]]);
    clean();
  });

  it("does nothing for other platforms or without run and launch", async () => {
    clean();
    mkdirSync(appDir, { recursive: true });
    const { io, seen } = stub(answer("install"));
    await desktopApp(io, "win32", home);
    await desktopApp({ ...io, launch: undefined }, "darwin", home);
    await desktopApp({ ...io, run: undefined }, "darwin", home);
    assert.deepEqual(seen, { runs: [], launches: [], logs: [] });
    clean();
  });

  it("init --yes never opens the app", async () => {
    const { io, seen } = stub(async () => assert.fail("select called"));
    await scripted([], (lineio) =>
      init({ yes: true, cliPath }, { ...lineio, ...io }, adapters, countInstall),
    );
    assert.deepEqual(seen.launches, []);
    assert.deepEqual(seen.runs, []);
  });

  it("the README install block is scripts/install-tray.sh", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const after = readme.slice(readme.indexOf("Then download, verify and install"));
    const block = after.split("```sh\n(\n")[1]?.split("\n)\n```")[0] ?? "";
    const lines = (text: string) =>
      text
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
    const script = readFileSync(new URL("../scripts/install-tray.sh", import.meta.url), "utf8");
    assert.ok(block.length > 0);
    assert.deepEqual(lines(script).slice(1), lines(block));
    assert.equal(lines(script)[0], "#!/bin/sh");
  });
});

describe("renderQuotas and wrap", () => {
  const thu14 = new Date(2026, 10, 26, 14, 0).getTime();
  const fri09 = new Date(2026, 10, 27, 9, 0).getTime();

  const fixtureRows: QuotaRows = {
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
            pools: [
              {
                id: "claude@default",
                label: "All models",
                windows: [
                  { kind: "short", remaining: 1, resetsAt: null, periodHours: 5 },
                  { kind: "period", remaining: 0.16, resetsAt: thu14, periodHours: 168 },
                ],
              },
              {
                id: "claude-fable@default",
                label: "Fable",
                windows: [{ kind: "period", remaining: 0.32, resetsAt: thu14, periodHours: 168 }],
              },
            ],
          },
          {
            account: "k1c",
            plan: "max_20x",
            planCreditsUsd: 200,
            warnings: [],
            pools: [
              {
                id: "claude@k1c",
                label: "All models",
                windows: [
                  { kind: "short", remaining: 1, resetsAt: null, periodHours: 5 },
                  { kind: "period", remaining: 1, resetsAt: null, periodHours: 168 },
                ],
              },
            ],
          },
        ],
      },
      {
        agent: "agy",
        name: "Antigravity",
        accounts: [
          {
            account: "default",
            warnings: [],
            pools: [
              {
                id: "agy-gemini@default",
                label: "Gemini",
                windows: [
                  { kind: "period", remaining: 0.62, resetsAt: null, periodHours: 168 },
                  { kind: "short", remaining: 1, resetsAt: null, periodHours: 5 },
                ],
              },
              {
                id: "agy-3p@default",
                label: "Claude/GPT",
                windows: [{ kind: "period", remaining: 0, resetsAt: fri09, periodHours: 168 }],
              },
            ],
          },
          {
            account: "work",
            error: "agy /usage timed out after 90000 ms",
            warnings: [],
            pools: [],
          },
        ],
      },
    ],
    unused: ["Codex", "Grok"],
  };

  it("renders nested quotas with colour off at width 100, matching colour on once VT codes are stripped", () => {
    const expected = [
      "Claude",
      "● default  max_20x                          $200 API credits / month · schmear credits",
      "  All models  ██░░░░░░░░░░  16%  5h 100% · 7d 16% · resets Thu 14:00",
      "  Fable       ████░░░░░░░░  32%  7d · resets Thu 14:00",
      "● k1c      max_20x                          $200 API credits / month",
      "  All models  ████████████ 100%  5h 100% · 7d 100%",
      "",
      "Antigravity",
      "● default",
      "  Gemini      ███████░░░░░  62%  7d 62% · 5h 100%",
      "  Claude/GPT  ░░░░░░░░░░░░   0%  7d · resets Fri 09:00",
      "● work",
      "  ▲ skipped: agy /usage timed out after 90000 ms",
      "",
      "Codex · Grok  not used",
    ].join("\n");

    const plain = renderQuotas(fixtureRows, { color: false, width: 100 });
    assert.equal(plain, expected);
    assert.equal(plain.includes("\x1b"), false);

    const colored = renderQuotas(fixtureRows, { color: true, width: 100 });
    assert.equal(colored.includes("\x1b"), true);
    assert.equal(stripVTControlCharacters(colored), expected);
  });

  it("drops bars at width 50", () => {
    const narrow = renderQuotas(fixtureRows, { color: false, width: 50 });
    assert.doesNotMatch(narrow, /[█░]/);
    assert.equal(
      narrow,
      [
        "Claude",
        "● default  max_20x",
        "  $200 API credits / month · schmear credits",
        "  All models   16%  5h 100% · 7d 16%",
        "    resets Thu 14:00",
        "  Fable        32%  7d · resets Thu 14:00",
        "● k1c      max_20x",
        "  $200 API credits / month",
        "  All models  100%  5h 100% · 7d 100%",
        "",
        "Antigravity",
        "● default",
        "  Gemini       62%  7d 62% · 5h 100%",
        "  Claude/GPT    0%  7d · resets Fri 09:00",
        "● work",
        "  ▲ skipped: agy /usage timed out after 90000 ms",
        "",
        "Codex · Grok  not used",
      ].join("\n"),
    );
  });

  it("renders a configured API credits pool with remaining and grant dollars", () => {
    const out = renderQuotas(
      {
        agents: [
          {
            agent: "claude",
            name: "Claude",
            accounts: [
              {
                account: "default",
                plan: "max_20x",
                planCreditsUsd: 200,
                warnings: [],
                pools: [
                  {
                    id: "claude-credits@default",
                    label: "API credits",
                    usd: { left: 150, granted: 200 },
                    windows: [{ kind: "period", remaining: 0.75, resetsAt: thu14, periodHours: 720 }],
                  },
                ],
              },
            ],
          },
        ],
        unused: [],
      },
      { color: false, width: 100 },
    );
    assert.equal(
      out,
      [
        "Claude",
        "● default  max_20x                                            $200 API credits / month",
        "  API credits  █████████░░░  75%  $150 of $200 left · expires Nov 26",
      ].join("\n"),
    );
  });

  it("wrap measures visible width so ANSI codes do not trigger premature breaks", () => {
    const styled = `  ${paint(true, "cyan", "hello")} ${paint(true, "green", "world")}`;
    assert.equal(wrap(styled, 15), styled);
    assert.equal(wrap("  alpha beta gamma", 12), "  alpha beta\n  gamma");
  });
});

describe("test isolation", () => {
  it("the suite never reached the Keychain or the network", () => {
    assert.deepEqual(forbidden, []);
  });
});
