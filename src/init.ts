import { mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { workerEnv } from "./acp.ts";
import { grokHome } from "./agents/grok.ts";
import { loadRouting } from "./delegate.ts";
import { HOST_CONFIGS, HOSTS, tilde } from "./hosts.ts";
import { windowLeft } from "./server.ts";
import { configPath, dataDir, readConfig, stateDir, USAGE_SHOW_MS, writeAtomic } from "./state.ts";
import {
  type AgentAdapter,
  type AgentId,
  type Config,
  DEFAULT_ACCOUNT,
  instanceId,
  type Pool,
  parseInstance,
  type UsageReading,
} from "./types.ts";
import type { InitIO } from "./ui.ts";
import { errorMessage, execFileAsync, findExecutableOnPath, isRecord, PACKAGE_VERSION } from "./util.ts";

const TIMEOUT_S = 86_400;
const KEY_COMMAND_EXAMPLE = ["security", "find-generic-password", "-s", "schmear-anthropic", "-w"];
const HOST_CMD_TIMEOUT_MS = 30_000;

// Global skill folders, as the `skills` CLI (github.com/vercel-labs/skills, docs/agents.md) installs them.
const SKILL_DIRS: Record<AgentId, () => string> = {
  claude: () => join(homedir(), ".claude", "skills"),
  codex: () => join(homedir(), ".agents", "skills"),
  grok: () => join(grokHome(), "skills"),
  agy: () => join(homedir(), ".gemini", "config", "skills"),
};
const SKILL = new URL("../skills/schmear/SKILL.md", import.meta.url);

const NAMES: Record<AgentId, string> = { claude: "Claude", codex: "Codex", grok: "Grok", agy: "Antigravity" };

// Where a subscription's browser sign-in is already open, so the user can switch accounts before linking.
const SITES: Record<AgentId, string> = {
  claude: "at claude.ai",
  codex: "at chatgpt.com",
  grok: "at grok.com",
  agy: "in your Google account",
};

type Found = Awaited<ReturnType<AgentAdapter["find"]>>;

/** `claude@work  work@x.com · max_5x`: the instance id, then what the login itself reports. */
function subscriptionLabel(id: string, found?: Found): string {
  if (!found) return id;
  if ("error" in found) return `${id}  not signed in`;
  const who = [found.email, found.plan].filter(Boolean).join(" · ");
  return who ? `${id}  ${who}` : id;
}

/** One quota line, `id` padded to `width`. */
const poolLine = (pool: Pool, width: number) =>
  `${pool.id.padEnd(width)}  ${pool.windows.map(windowLeft).join(" · ")}`;

type Outcome = "added" | "updated" | "unchanged";

interface ServerCommand {
  command: string;
  args: string[];
}

/** `init [--yes]` (§3.1, §12): detect, pick subscriptions, write config, read usage once, register in each host, check. */
export async function init(
  opts: { yes: boolean; cliPath: string },
  io: InitIO,
  adapters: Record<AgentId, AgentAdapter>,
  installAdapters: () => Promise<void>,
): Promise<void> {
  if (opts.cliPath.includes("/_npx/")) {
    throw new Error(
      `refusing to register ${opts.cliPath}: it is in npx's cache, which npm may delete. Install with \`npm i -g schmear\` and run \`schmear init\`.`,
    );
  }
  const entry: ServerCommand = {
    command: await onPathIfSame("node", process.execPath),
    args: [await onPathIfSame("schmear", opts.cliPath), "serve"],
  };
  const ids = Object.keys(adapters) as AgentId[];
  io.start(`schmear ${PACKAGE_VERSION} setup`);

  const prior = await readConfig();
  // Added subscriptions follow the default ones; one whose agent was not detected stays as stored.
  const accounts = Object.entries(prior.agents).flatMap(([id, entry]) => {
    const instance = parseInstance(id);
    return instance && instance.account !== DEFAULT_ACCOUNT ? [{ id, entry, ...instance }] : [];
  });
  const { detected, accountFound } = await io.task(
    "Looking for agent CLIs",
    async () => {
      const detected = await Promise.all(
        ids.map(async (id) => {
          const bin = await findExecutableOnPath(id);
          return { id, bin, found: bin ? await adapters[id].find(bin) : undefined };
        }),
      );
      const ok = (agent: AgentId) => {
        const found = detected.find((d) => d.id === agent)?.found;
        return found !== undefined && !("error" in found);
      };
      const accountFound = new Map(
        await Promise.all(
          accounts
            .filter((a) => ok(a.agent))
            .map(async (a) => {
              const bin = detected.find((d) => d.id === a.agent)?.bin as string;
              const env = { [adapters[a.agent].home.env]: a.entry.home as string };
              return [a.id, await adapters[a.agent].find(bin, env)] as const;
            }),
        ),
      );
      return { detected, accountFound };
    },
    ({ detected }) => `Found ${detected.filter((d) => d.bin).length} of ${ids.length} agent CLIs`,
  );
  const hosts = new Map<AgentId, string>();
  const workers: AgentId[] = [];
  const width = Math.max(...ids.map((id) => id.length));
  const version = (v: string) => v.match(/\d+(\.\d+)+/)?.[0] ?? v;
  const versionWidth = Math.max(
    ...detected.map((d) => (d.found && !("error" in d.found) ? version(d.found.version).length : 0)),
  );
  for (const { id, bin, found } of detected) {
    const label = id.padEnd(width);
    if (!bin || !found) {
      io.log("info", `${label}  not installed`);
      continue;
    }
    hosts.set(id, bin);
    if ("error" in found) {
      io.log("warn", `${label}  ${tilde(bin)} failed detection (${found.error}); not offered as a worker`);
      continue;
    }
    workers.push(id);
    io.log("ok", `${label}  ${version(found.version).padEnd(versionWidth)}  ${tilde(bin)}`);
  }

  const foundOf = (id: AgentId) => detected.find((d) => d.id === id)?.found;
  const defaultId = (agent: AgentId) => instanceId(agent, DEFAULT_ACCOUNT);
  const offeredAccounts = (Object.keys(adapters) as AgentId[]).flatMap((agent) =>
    workers.includes(agent) ? accounts.filter((a) => a.agent === agent) : [],
  );
  const options = [
    ...workers.map((id) => ({ value: defaultId(id), label: subscriptionLabel(defaultId(id), foundOf(id)) })),
    ...offeredAccounts.map((a) => ({ value: a.id, label: subscriptionLabel(a.id, accountFound.get(a.id)) })),
  ];
  // A stored `"consent": false` stays unticked; `--yes` takes the ticked set without asking.
  // Antigravity is opt-in (docs/safety.md): ticked only when already consented.
  const isAgy = (id: string) => parseInstance(id)?.agent === "agy";
  const ticked = options
    .map((o) => o.value)
    .filter((id) => (isAgy(id) ? prior.agents[id]?.consent === true : prior.agents[id]?.consent !== false));
  if (options.some((o) => isAgy(o.value) && !ticked.includes(o.value))) {
    io.log(
      "info",
      "Antigravity is off until you tick it: Google says wrapping agy in other agents is unsupported on consumer plans and may suspend the account (docs/safety.md). Run `schmear init` and tick it to use it.",
    );
  }
  const chosen = opts.yes
    ? ticked
    : await io.choose("Which subscriptions should schmear use?", options, ticked);
  const agents: Config["agents"] = {
    ...Object.fromEntries(
      workers.map((id) => [
        defaultId(id),
        { consent: chosen.includes(defaultId(id)), path: hosts.get(id) as string },
      ]),
    ),
    ...Object.fromEntries(
      accounts.map((a) => [
        a.id,
        workers.includes(a.agent)
          ? { ...a.entry, consent: chosen.includes(a.id), path: hosts.get(a.agent) as string }
          : a.entry,
      ]),
    ),
  };
  let config: Config = { ...prior, agents };
  await writeIfChanged(configPath(), `${JSON.stringify(config, null, 2)}\n`);

  if (!opts.yes && workers.length > 0) {
    const run = io.run;
    if (!run) {
      io.log("info", "Add more subscriptions by running `schmear init` in a terminal.");
    } else {
      // Every login seen so far, to refuse a sign-in that returns one of them again.
      const known = [
        ...workers.map((agent) => ({ id: defaultId(agent), agent, found: foundOf(agent) })),
        ...offeredAccounts.map((a) => ({ id: a.id, agent: a.agent, found: accountFound.get(a.id) })),
      ];
      const menu = [
        ...workers.map((agent) => ({ value: agent as string, label: NAMES[agent] })),
        { value: "done", label: "Done" },
      ];
      const addSubscription = async (agent: AgentId): Promise<void> => {
        const adapter = adapters[agent];
        const bin = hosts.get(agent) as string;
        const name = NAMES[agent];
        const nickname = await io.text(`Nickname for this ${name} subscription`, {
          placeholder: "work",
          validate: (v) => {
            if (!parseInstance(instanceId(agent, v)))
              return 'use lowercase letters, digits and "-", up to 32';
            if (v === DEFAULT_ACCOUNT) return `"${DEFAULT_ACCOUNT}" is your first ${name} login`;
            if (instanceId(agent, v) in config.agents) return `${instanceId(agent, v)} is already added`;
            return undefined;
          },
        });
        const id = instanceId(agent, nickname);
        io.log(
          "info",
          `Linking ${id}: first sign in to the account you're linking ${SITES[agent]} in your browser. The sign-in that opens next approves whichever account your browser is signed in to.`,
        );
        const go = await io.select(
          "Signed in to the account you're linking?",
          [
            { value: "continue", label: "Yes, open the sign-in" },
            { value: "cancel", label: "Cancel" },
          ],
          "continue",
        );
        if (go === "cancel") return;

        const accountHome = join(dataDir(), "logins", `${agent}-${nickname}`);
        const env = { [adapter.home.env]: accountHome };
        await mkdir(accountHome, { recursive: true, mode: 0o700 });
        const reject = async (why: string) => {
          await rm(accountHome, { recursive: true, force: true });
          io.log("warn", `${id} not added: ${why}.`);
        };
        io.log(
          "info",
          `Opening ${name}'s sign-in…${adapter.home.login.length === 0 ? " Antigravity opens; sign in, then quit it." : ""}`,
        );
        const outcome = await run(bin, adapter.home.login, workerEnv(env)).then(
          (code) => (code === 0 ? undefined : `exit ${code}`),
          (err: unknown) => errorMessage(err),
        );
        if (outcome !== undefined) return reject(`sign-in did not finish (${outcome})`);
        const found = await adapter.find(bin, env);
        if ("error" in found) return reject(found.error);
        const twin = known.find(
          (k) =>
            k.agent === agent &&
            found.email !== undefined &&
            k.found &&
            !("error" in k.found) &&
            k.found.email === found.email,
        );
        if (twin) return reject(`that is the same login as ${twin.id}. Sign in with a different account`);
        const next: Config = {
          ...config,
          agents: { ...config.agents, [id]: { consent: true, path: bin, home: accountHome } },
        };
        await writeIfChanged(configPath(), `${JSON.stringify(next, null, 2)}\n`);
        const routing = await loadRouting(adapters);
        await routing.read(id, 0);
        const error = routing.readings.get(id)?.error;
        if (error !== undefined) {
          await writeIfChanged(configPath(), `${JSON.stringify(config, null, 2)}\n`);
          return reject(error);
        }
        config = next;
        known.push({ id, agent, found });
        io.log("ok", `Added ${subscriptionLabel(id, found)}`);
      };
      for (;;) {
        const pick = await io.select("Add another subscription?", menu, "done");
        if (pick === "done") break;
        await addSubscription(pick as AgentId);
      }
    }
  }

  const usesAcp = Object.entries(config.agents).some(
    ([id, e]) => e.consent && ["claude", "codex"].includes(parseInstance(id)?.agent ?? ""),
  );
  if (usesAcp) {
    const failure = await io.task(
      "Installing the Claude and Codex ACP adapters",
      () =>
        installAdapters().then(
          () => undefined,
          (err: unknown) => errorMessage(err),
        ),
      (message) => (message === undefined ? "ACP adapters ready" : "ACP adapters not installed"),
    );
    if (failure !== undefined) io.log("warn", failure);
  }

  const quotas = await io.task(
    "Reading quotas",
    () => quotaLines(adapters),
    () => "Quotas",
  );
  for (const [kind, line] of quotas) {
    io.log(kind, line);
  }
  const claude = detected.find((d) => d.id === "claude")?.found;
  const grantUsd = claude && !("error" in claude) ? planGrantUsd(claude.plan) : undefined;
  if (chosen.includes(defaultId("claude")) && !config.credits && grantUsd !== undefined) {
    io.log(
      "info",
      `Your Claude plan includes $${grantUsd} of API credits per billing cycle; \`schmear credits\` spends them on a separate lane.`,
    );
  }

  const register: Record<AgentId, (bin: string, notes: string[]) => Promise<Outcome>> = {
    claude: (bin, notes) => registerClaude(bin, entry, notes),
    codex: () =>
      registerToml(HOST_CONFIGS.codex(), {
        ...entry,
        tool_timeout_sec: TIMEOUT_S,
        env_vars: ["SCHMEAR_WORKER"],
      }),
    grok: () =>
      registerToml(HOST_CONFIGS.grok(), {
        ...entry,
        tool_timeout_sec: TIMEOUT_S,
      }),
    agy: () =>
      registerJson(HOST_CONFIGS.agy(), {
        ...entry,
        timeoutSeconds: TIMEOUT_S,
      }),
  };
  const list: Record<AgentId, string[]> = {
    claude: ["mcp", "get", "schmear"],
    codex: ["mcp", "list"],
    grok: ["mcp", "list"],
    agy: ["mcp", "list"],
  };
  const skill = await readFile(SKILL, "utf8");
  const hostNames = [...hosts.keys()].map((id) => HOSTS[id]);
  const results = await io.task(
    `Registering with ${hostNames.join(", ")}`,
    () =>
      Promise.all(
        [...hosts].map(async ([id, bin]) => {
          const notes: string[] = [];
          const registered = await register[id](bin, notes).then(
            (outcome) => ({ outcome }),
            (err: unknown) => ({ error: errorMessage(err) }),
          );
          const path = join(SKILL_DIRS[id](), "schmear", "SKILL.md");
          const installed = await readText(path).then(
            async ({ text }) => {
              if (text !== skill) {
                await writeAtomic(path, skill, 0o644);
              }
              return {
                skill: text === skill ? "skill current" : text === "" ? "skill installed" : "skill updated",
              };
            },
            (err: unknown) => ({ error: errorMessage(err) }),
          );
          const listed = "outcome" in registered ? await run(bin, list[id]) : undefined;
          return { id, notes, registered, installed, listed };
        }),
      ),
    () => "Registered",
  );
  const failed: string[] = [];
  const hostWidth = Math.max(...hostNames.map((name) => name.length));
  for (const { id, notes, registered, installed, listed } of results) {
    const host = HOSTS[id];
    for (const note of notes) {
      io.log("warn", `${host}: ${note}`);
    }
    if ("error" in registered) {
      failed.push(host);
      io.log("error", `${host}: not registered (${registered.error})`);
    }
    if ("error" in installed) {
      failed.push(`${host} skill`);
      io.log("error", `${host}: skill not installed (${installed.error})`);
    }
    if ("outcome" in registered && "skill" in installed) {
      const done = { added: "registered", updated: "updated", unchanged: "already registered" }[
        registered.outcome
      ];
      io.log("ok", `${host.padEnd(hostWidth)}  ${done} · ${installed.skill}`);
    }
    if (listed && !(listed.ok && listed.output.includes("schmear"))) {
      io.log(
        "warn",
        `${host} does not list schmear yet. \`${id} ${list[id].join(" ")}\` printed:\n${listed.output}`,
      );
    }
  }
  if (failed.length > 0) {
    throw new Error(`not registered in ${failed.join(", ")}`);
  }
  io.end(
    "Done. Restart your agents, then ask one to delegate a subtask. `schmear usage` shows quotas anytime.",
  );
}

/** One line per consented instance's pool (default account, then its accounts), or why it is skipped. */
async function quotaLines(adapters: Record<AgentId, AgentAdapter>): Promise<["info" | "warn", string][]> {
  const { config, routable, readings, credits, read } = await loadRouting(adapters);
  await Promise.all(routable.map((id) => read(id, USAGE_SHOW_MS)));
  const all = [...readings.values(), ...credits.values()];
  const instances = (Object.keys(adapters) as AgentId[]).flatMap((agent) => {
    const ids = Object.keys(config.agents).filter((id) => parseInstance(id)?.agent === agent);
    const isDefault = (id: string) => id === instanceId(agent, DEFAULT_ACCOUNT);
    return [...ids.filter(isDefault), ...ids.filter((id) => !isDefault(id))];
  });
  const width = Math.max(
    ...Object.keys(adapters).map((id) => id.length),
    ...instances.map((id) => id.length),
    ...all.flatMap((r) => r.pools.map((p) => p.id.length)),
  );
  const lines: ["info" | "warn", string][] = [];
  const add = (reading: UsageReading) => {
    const id = instanceId(reading.agent, reading.account);
    if (reading.error !== undefined) {
      lines.push(["warn", `${id.padEnd(width)}  skipped: ${reading.error}`]);
    }
    for (const pool of reading.pools) {
      lines.push(["info", poolLine(pool, width)]);
    }
    for (const warning of reading.warnings) {
      lines.push(["warn", `${id}: ${warning}`]);
    }
  };
  for (const id of instances) {
    const reading = readings.get(id);
    if (reading) add(reading);
    else lines.push(["info", `${id.padEnd(width)}  not used`]);
  }
  for (const reading of credits.values()) add(reading);
  return lines;
}

/** `uninstall [--yes]`: removes what init and credits wrote: each host's entry, the skills, config, state, and the data directory's logins and adapter trees. */
export async function uninstall(opts: { yes: boolean }, io: InitIO): Promise<void> {
  io.start(`schmear ${PACKAGE_VERSION} uninstall`);
  const ids = Object.keys(HOSTS) as AgentId[];
  const dirs = [
    dirname(configPath()),
    stateDir(),
    dataDir(),
    ...ids.map((id) => join(SKILL_DIRS[id](), "schmear")),
  ];
  if (!opts.yes) {
    const answer = await io.text("Type yes to remove schmear", {
      detail: `Removes schmear from ${ids.map((id) => HOSTS[id]).join(", ")} and deletes:\n${dirs.map(tilde).join("\n")}`,
      placeholder: "no",
    });
    if (answer.toLowerCase() !== "yes") {
      io.end("Nothing removed.");
      return;
    }
  }
  // A malformed config is deleted below all the same.
  const prior = await readConfig().catch(() => undefined);
  const keyCommand = prior?.credits?.keyCommand;
  const logins = Object.entries(prior?.agents ?? {}).flatMap(([id, e]) =>
    e.home ? [{ id, home: e.home }] : [],
  );
  const unregister: Record<AgentId, () => Promise<boolean | undefined>> = {
    claude: unregisterClaude,
    codex: () => unregisterToml(HOST_CONFIGS.codex()),
    grok: () => unregisterToml(HOST_CONFIGS.grok()),
    agy: () => unregisterJson(HOST_CONFIGS.agy()),
  };
  const failed: string[] = [];
  const width = Math.max(...ids.map((id) => HOSTS[id].length));
  for (const id of ids) {
    const host = HOSTS[id].padEnd(width);
    try {
      const removed = await unregister[id]();
      io.log(
        removed ? "ok" : "info",
        `${host}  ${removed === undefined ? "not installed" : removed ? "removed" : "not registered"}`,
      );
    } catch (err) {
      failed.push(HOSTS[id]);
      io.log("error", `${host}  not removed (${errorMessage(err)})`);
    }
  }
  for (const dir of dirs) {
    const existed = await stat(dir).then(
      () => true,
      () => false,
    );
    await rm(dir, { recursive: true, force: true });
    if (existed) io.log("ok", `Deleted ${tilde(dir)}`);
  }
  for (const { id, home } of logins) {
    if (home.startsWith(`${dataDir()}${sep}`)) continue;
    io.log("info", `Your ${id} login stays in ${tilde(home)}.`);
  }
  if (keyCommand) {
    io.log("info", `Your API key stays where \`${keyCommand.join(" ")}\` reads it.`);
  }
  if (failed.length > 0) {
    throw new Error(`not removed from ${failed.join(", ")}`);
  }
  io.end("Removed. `npm uninstall -g schmear` or `brew uninstall schmear` removes the command.");
}

/** `undefined`: no `claude` on PATH; otherwise whether a user-scope entry was removed. */
async function unregisterClaude(): Promise<boolean | undefined> {
  const bin = await findExecutableOnPath("claude");
  if (!bin) return undefined;
  const removed = await run(bin, ["mcp", "remove", "-s", "user", "schmear"]);
  if (removed.ok) return true;
  // Older claude: "No user-scoped MCP server found …"; newer: "No MCP server named \"schmear\" in user scope".
  if (/No user-scoped MCP server|No MCP server named "schmear" in user scope/.test(removed.output))
    return false;
  throw new Error(removed.output);
}

const OWN_TOML_HEADER = /^\s*\[\s*mcp_servers\.schmear(\.[^\]]*)?\s*\]/;

/** Drops `[mcp_servers.schmear]` and its subtables as text, so every other line stays. */
async function unregisterToml(path: string): Promise<boolean> {
  const { text, mode } = await readText(path);
  let servers: unknown;
  try {
    servers = parseToml(text).mcp_servers;
  } catch (err) {
    throw new Error(`cannot parse ${path}: ${errorMessage(err)}`);
  }
  if (!isRecord(servers) || servers.schmear === undefined) return false;
  let inside = false;
  const kept = text.split("\n").filter((line) => {
    if (/^\s*\[/.test(line)) inside = OWN_TOML_HEADER.test(line);
    return !inside;
  });
  const next = kept.join("\n").replace(/\n{2,}$/, "\n");
  const check = parseToml(next).mcp_servers;
  if (isRecord(check) && check.schmear !== undefined) {
    throw new Error(
      `${path} defines mcp_servers.schmear without a [mcp_servers.schmear] header; edit it by hand`,
    );
  }
  await writeAtomic(path, next, mode);
  return true;
}

async function unregisterJson(path: string): Promise<boolean> {
  const { text, mode } = await readText(path);
  if (text.trim() === "") return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`cannot parse ${path}: ${errorMessage(err)}`);
  }
  if (!isRecord(parsed) || !isRecord(parsed.mcpServers) || parsed.mcpServers.schmear === undefined)
    return false;
  const { schmear: _, ...servers } = parsed.mcpServers;
  await writeAtomic(path, `${JSON.stringify({ ...parsed, mcpServers: servers }, null, 2)}\n`, mode);
  return true;
}

// planTier as `claude auth status --json` prints it → the monthly API credit grant (docs/research/api-credits.md).
const PLAN_GRANT_USD: Record<string, number> = { max_5x: 100, max_20x: 200 };
const planGrantUsd = (plan: string | undefined) => (plan === undefined ? undefined : PLAN_GRANT_USD[plan]);

/** `credits` (§13): the grant from the Claude plan, then the renewal day, the key command and the no-overage confirmation. */
export async function setupCredits(io: InitIO, claude: AgentAdapter): Promise<void> {
  io.start("schmear credit lane");
  const prior = await readConfig();
  const entry = prior.agents[instanceId("claude", DEFAULT_ACCOUNT)];
  if (!entry?.consent) {
    throw new Error("Claude is not set up as a worker; run `schmear init` with `claude` logged in first");
  }
  const found = await io.task(
    "Reading your Claude plan",
    () => claude.find(entry.path),
    (f) => ("error" in f ? "Could not read your Claude plan" : `Claude plan: ${f.plan ?? "unknown"}`),
  );
  if ("error" in found) {
    throw new Error(found.error);
  }
  const grantUsd = planGrantUsd(found.plan);
  if (grantUsd === undefined) {
    throw new Error(
      `Claude plan ${found.plan ?? "unknown"} includes no monthly API credits (Max and Ultra do)`,
    );
  }
  const cycleDay = Number(
    await io.text("Day of the month your Claude plan renews (1-31)", {
      detail: `Your plan includes $${grantUsd} of API credits per billing cycle. They refill on your renewal date, which Claude's CLI does not report; claude.ai Settings > Billing shows it.`,
      validate: (v) =>
        /^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 31 ? undefined : "a whole number from 1 to 31",
    }),
  );
  const keyCommand = JSON.parse(
    await io.text("Command that prints the API key, as a JSON array", {
      initial: JSON.stringify(KEY_COMMAND_EXAMPLE),
      validate: (v) => (isKeyCommand(v) ? undefined : "expected a JSON array of non-empty strings"),
    }),
  ) as string[];
  const confirmed = await io.text("Type yes to confirm nothing past the grant can be billed", {
    detail:
      "schmear meters the grant locally and cannot see your Console balance. If purchased credits or auto-reload are on, Anthropic bills past the grant. Use a dedicated Console workspace whose spend limit equals the grant.",
    placeholder: "no",
  });
  if (confirmed.toLowerCase() !== "yes") {
    io.end("Not confirmed; no credit lane written.");
    return;
  }
  const credits = { grantUsd, cycleDay, keyCommand, taskCapUsd: grantUsd / 10, overageOff: true as const };
  await writeIfChanged(configPath(), `${JSON.stringify({ ...prior, credits }, null, 2)}\n`);
  io.end(
    `Credit lane on: $${grantUsd} per cycle from day ${cycleDay}, at most $${credits.taskCapUsd} per task. Edit "credits" in ${tilde(configPath())} to change it.`,
  );
}

function isKeyCommand(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) && parsed.length > 0 && parsed.every((a) => typeof a === "string" && a);
  } catch {
    return false;
  }
}

async function run(bin: string, args: string[]): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, { timeout: HOST_CMD_TIMEOUT_MS });
    return { ok: true, output: `${stdout}${stderr}`.trim() };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    return { ok: false, output: `${e.stdout ?? ""}${e.stderr ?? ""}`.trim() || e.message };
  }
}

async function readText(path: string): Promise<{ text: string; mode?: number }> {
  try {
    const [text, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    return { text, mode: info.mode & 0o777 };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { text: "" };
    }
    throw err;
  }
}

async function writeIfChanged(path: string, data: string): Promise<void> {
  if ((await readText(path)).text !== data) {
    await writeAtomic(path, data);
  }
}

/**
 * `claude mcp get` prints the entry Claude uses, with `Scope:`, `Command:`, `Args:` (space-joined) and
 * `Timeout: <n>ms` lines; it exits non-zero when absent.
 */
async function registerClaude(bin: string, entry: ServerCommand, notes: string[]): Promise<Outcome> {
  const timeout = TIMEOUT_S * 1000;
  const got = await run(bin, ["mcp", "get", "schmear"]);
  const field = (name: string) => new RegExp(`^\\s*${name}: (.*)$`, "m").exec(got.output)?.[1];
  const scope = got.ok ? (field("Scope") ?? "unscoped") : undefined;
  const user = scope !== undefined && /^user\b/i.test(scope);
  if (user) {
    if (
      field("Command") === entry.command &&
      field("Args") === entry.args.join(" ") &&
      field("Timeout") === `${timeout}ms`
    ) {
      return "unchanged";
    }
    await execFileAsync(bin, ["mcp", "remove", "-s", "user", "schmear"], { timeout: HOST_CMD_TIMEOUT_MS });
  } else if (scope !== undefined) {
    notes.push(`the ${scope} schmear entry shadows the user entry`);
    // `get` shows only the shadowing entry, so a user entry may or may not exist: remove it if it does.
    await run(bin, ["mcp", "remove", "-s", "user", "schmear"]);
  }
  const json = JSON.stringify({ type: "stdio", ...entry, timeout });
  await execFileAsync(bin, ["mcp", "add-json", "-s", "user", "schmear", json], {
    timeout: HOST_CMD_TIMEOUT_MS,
  });
  return user ? "updated" : "added";
}

/** `name` on PATH when it resolves to the file `actual`, else `actual`: Homebrew's unversioned symlinks survive upgrades, the Cellar paths they point into do not. */
async function onPathIfSame(name: string, actual: string): Promise<string> {
  const onPath = await findExecutableOnPath(name);
  return onPath && (await realpath(onPath)) === (await realpath(actual)) ? onPath : actual;
}

// Compare only the keys init owns, so user keys (`env`, `enabled`, `disabled`, …) never make an entry differ.
const sameTable = (parsed: unknown, table: Record<string, unknown>): boolean =>
  isRecord(parsed) &&
  !Array.isArray(parsed) &&
  Object.entries(table).every(([k, v]) => Object.hasOwn(parsed, k) && isDeepStrictEqual(parsed[k], v));

const TOML_HEADER = /^\s*\[\s*mcp_servers\.schmear\s*\]\s*(#.*)?$/;

const parsesAlone = (toml: string): boolean => {
  try {
    parseToml(toml);
    return true;
  } catch {
    return false;
  }
};

/** Appends `[mcp_servers.schmear]`, or rewrites only init's keys in it, as text, so every other line stays. */
async function registerToml(path: string, table: Record<string, unknown>): Promise<Outcome> {
  const { text, mode } = await readText(path);
  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(text);
  } catch (err) {
    throw new Error(`cannot parse ${path}: ${errorMessage(err)}`);
  }
  const servers = parsed.mcp_servers;
  const current = isRecord(servers) ? servers.schmear : undefined;
  if (sameTable(current, table)) {
    return "unchanged";
  }
  let next: string;
  if (current === undefined) {
    const block = `[mcp_servers.schmear]\n${stringifyToml(table)}`;
    next = `${text}${text === "" ? "" : text.endsWith("\n") ? "\n" : "\n\n"}${block}`;
  } else {
    const lines = text.split("\n");
    const start = lines.findIndex((line) => TOML_HEADER.test(line));
    if (start < 0) {
      throw new Error(
        `${path} defines mcp_servers.schmear without a [mcp_servers.schmear] header; edit it by hand`,
      );
    }
    const after = lines.findIndex((line, i) => i > start && /^\s*\[/.test(line));
    let end = after < 0 ? lines.length : after;
    const missing: string[] = [];
    for (const [key, value] of Object.entries(table)) {
      const line = stringifyToml({ [key]: value }).trimEnd();
      const keyLine = new RegExp(`^\\s*${key}\\s*=`);
      const at = lines.findIndex((l, i) => i > start && i < end && keyLine.test(l));
      if (at < 0) {
        missing.push(line);
        continue;
      }
      // A value can span lines (a multi-line array): it ends at the first line where the key parses alone.
      let last = at;
      while (last < end - 1 && !parsesAlone(lines.slice(at, last + 1).join("\n"))) {
        last++;
      }
      lines.splice(at, last - at + 1, line);
      end -= last - at;
    }
    lines.splice(start + 1, 0, ...missing);
    next = lines.join("\n");
  }
  const check = parseToml(next).mcp_servers;
  const expected = { ...(isRecord(current) ? current : {}), ...table };
  if (!isRecord(check) || !isRecord(check.schmear) || !isDeepStrictEqual({ ...check.schmear }, expected)) {
    throw new Error(`rewriting ${path} would not yield the expected [mcp_servers.schmear]; edit it by hand`);
  }
  await writeAtomic(path, next, mode);
  return current === undefined ? "added" : "updated";
}

async function registerJson(path: string, server: Record<string, unknown>): Promise<Outcome> {
  const { text, mode } = await readText(path);
  let parsed: unknown = {};
  if (text.trim() !== "") {
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error(`cannot parse ${path}: ${errorMessage(err)}`);
    }
  }
  if (
    !isRecord(parsed) ||
    Array.isArray(parsed) ||
    (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))
  ) {
    throw new Error(`${path}: expected {"mcpServers": {...}}`);
  }
  const servers = (parsed.mcpServers ?? {}) as Record<string, unknown>;
  const current = servers.schmear;
  if (sameTable(current, server)) {
    return "unchanged";
  }
  const kept = isRecord(current) && !Array.isArray(current) ? current : {};
  const next = { ...parsed, mcpServers: { ...servers, schmear: { ...kept, ...server } } };
  await writeAtomic(path, `${JSON.stringify(next, null, 2)}\n`, mode);
  return current === undefined ? "added" : "updated";
}
