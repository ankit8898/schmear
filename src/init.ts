import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { workerEnv } from "./acp.ts";
import { grokHome } from "./agents/grok.ts";
import {
  type ConsoleOrg,
  listOrgs,
  readCredits,
  readSessions,
  removeSession,
  type SessionVendor,
  type VendorBalance,
  writeSession,
} from "./console.ts";
import { loadRouting } from "./delegate.ts";
import { type Credit, type GoogleAccount, googleAccounts } from "./google.ts";
import { HOST_CONFIGS, HOSTS, tilde } from "./hosts.ts";
import { configPath, dataDir, readConfig, stateDir, USAGE_SHOW_MS, writeAtomic } from "./state.ts";
import {
  type AgentAdapter,
  type AgentId,
  type Config,
  type CreditPoolConfig,
  DEFAULT_ACCOUNT,
  instanceId,
  keyId,
  parseCreditPool,
  parseInstance,
} from "./types.ts";
import { type InitIO, paint } from "./ui.ts";
import { errorMessage, execFileAsync, findExecutableOnPath, isRecord, PACKAGE_VERSION } from "./util.ts";
import {
  apiOnlyAccounts,
  creditsOf,
  NAMES,
  type QuotaAccount,
  type QuotaAgent,
  type QuotaRows,
  quotaAccount,
  renderQuotas,
} from "./view.ts";

const TIMEOUT_S = 86_400;
const HOST_CMD_TIMEOUT_MS = 30_000;

// Global skill folders, as the `skills` CLI (github.com/vercel-labs/skills, docs/agents.md) installs them.
const SKILL_DIRS: Record<AgentId, () => string> = {
  claude: () => join(homedir(), ".claude", "skills"),
  codex: () => join(homedir(), ".agents", "skills"),
  grok: () => join(grokHome(), "skills"),
  agy: () => join(homedir(), ".gemini", "config", "skills"),
};
const SKILL = new URL("../skills/schmear/SKILL.md", import.meta.url);

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
  fetchFn: typeof fetch = fetch,
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
  io.start(
    `schmear ${PACKAGE_VERSION}`,
    "route subtasks to the subscription that would waste the most quota",
  );

  const prior = await readConfig();
  // Added subscriptions follow the default ones; one whose agent was not detected stays as stored.
  const accounts = Object.entries(prior.agents).flatMap(([id, entry]) => {
    const instance = parseInstance(id);
    return instance && instance.account !== DEFAULT_ACCOUNT ? [{ id, entry, ...instance }] : [];
  });
  const { detected, accountFound } = await io.task(
    "Looking for agent CLIs",
    async (update) => {
      let checked = 0;
      const detected = await Promise.all(
        ids.map(async (id) => {
          const bin = await findExecutableOnPath(id);
          const found = bin ? await adapters[id].find(bin) : undefined;
          update(`Looking for agent CLIs (${++checked}/${ids.length})`);
          return { id, bin, found };
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
      io.log("info", paint(io.color, "dim", `${label}  not installed`));
      continue;
    }
    hosts.set(id, bin);
    if ("error" in found) {
      io.log(
        "warn",
        `${label}  ${paint(io.color, "dim", tilde(bin))} failed detection (${found.error}); not offered as a worker`,
      );
      continue;
    }
    workers.push(id);
    io.log(
      "ok",
      `${label}  ${version(found.version).padEnd(versionWidth)}  ${paint(io.color, "dim", tilde(bin))}`,
    );
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
        accountFound.set(id, found);
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

  const plans = new Map<string, string>();
  for (const { id, found } of detected) {
    if (found && !("error" in found) && found.plan) plans.set(defaultId(id), found.plan);
  }
  for (const [id, found] of accountFound) {
    if (!("error" in found) && found.plan) plans.set(id, found.plan);
  }
  const quotas = await io.task(
    "Reading quotas",
    (update) => quotaRows(adapters, plans, update),
    () => "Quotas",
  );
  const quotaText = renderQuotas(quotas, { color: io.color, width: io.width });
  if (quotaText !== "") io.log("info", quotaText);

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
    async (update) => {
      let doneCount = 0;
      return Promise.all(
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
          update(`Registering with hosts (${++doneCount}/${hosts.size}) · ${HOSTS[id]}`);
          return { id, notes, registered, installed, listed };
        }),
      );
    },
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
      io.log("ok", `${host.padEnd(hostWidth)}  ${done} ${paint(io.color, "dim", `· ${installed.skill}`)}`);
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
  if (!opts.yes) {
    // Each account is separate: only its own pool hides its row.
    const claudeRows = config.agents[defaultId("claude")]?.consent
      ? consentedAccounts(config, plans, "claude").flatMap(({ account, plan }) => {
          const usd = planCredits(plan);
          return usd === undefined || keyId("claude-credits", account) in (config.credits ?? {})
            ? []
            : [`Claude · ${account}  $${usd} / month`];
        })
      : [];
    const chatgptRows = consentedAccounts(config, plans, "codex").flatMap(({ account, plan }) => {
      const tier = plan?.trim().toLowerCase();
      if (tier === "pro") return [`ChatGPT Pro · ${account}  $100, $200 or $500 / month by Pro tier`];
      if (tier === "business" || tier === "team") {
        return [`ChatGPT Business · ${account}  $20 or $100 per seat / month, pooled up to $500`];
      }
      return [];
    });
    const googleRows = consentedAccounts(config, plans, "agy").flatMap(({ account }) =>
      keyId("gemini-credits", account) in (config.credits ?? {})
        ? []
        : [
            `Google AI · agy@${account}  Pro $10, Ultra 5x $40, Ultra 20x $100 / month in Google Cloud credits`,
          ],
    );
    const body = [
      ...claudeRows,
      ...chatgptRows,
      ...googleRows,
      ...(claudeRows.length > 0
        ? [
            "schmear can spend these on a separate API-key lane when your subscriptions run low. Link the plan to a Console org in claude.ai Settings > Billing > API credits first.",
            "Purchased credits in the same org are spent too, down to 2%.",
          ]
        : []),
      ...(chatgptRows.length > 0 ? ["ChatGPT plan credits are not spent: Codex cannot draw on them."] : []),
      ...(googleRows.length > 0
        ? [
            "schmear spends Google credits through Antigravity on a Gemini API key. Apply the credit at me.developers.google.com/benefits, then run schmear credits.",
          ]
        : []),
    ].join("\n");
    if (body !== "") io.panel?.("API credits", body);
    if (claudeRows.length + googleRows.length > 0) {
      const answer = await io.select(
        "Set up API credits now?",
        [
          { value: "now", label: "Yes, set up now" },
          { value: "later", label: "Later", hint: "schmear credits" },
        ],
        "later",
      );
      if (answer === "now") {
        try {
          await runCreditsWizard(io, adapters, fetchFn);
        } catch (err) {
          io.log("warn", errorMessage(err));
        }
      } else {
        io.log("info", "Run `schmear credits` anytime to spend them.");
      }
    }
  }
  // The apps run `init --yes` to reconnect, so only an interactive run opens one.
  if (!opts.yes) await desktopApp(io, process.platform, homedir());
  const nextBody = [
    "Restart your agents so they load schmear.",
    "Ask one to delegate a subtask.",
    `Run ${paint(io.color, "cyan", "schmear usage")} anytime to check quotas.`,
  ].join("\n");
  io.panel?.("Next", nextBody);
  io.end("Done.");
}

const TRAY_INSTALLER = fileURLToPath(new URL("../scripts/install-tray.sh", import.meta.url));
const APP_DOCS = "https://github.com/kevin1chun/schmear#";

/** Opens the menu bar app (macOS) or tray app (Linux), offering to install it first; both apps take a second launch. */
export async function desktopApp(io: InitIO, platform: NodeJS.Platform, home: string): Promise<void> {
  const { run, launch } = io;
  if (!run || !launch || (platform !== "darwin" && platform !== "linux")) return;
  const mac = platform === "darwin";
  const tray = join(home, ".local", "bin", "schmear-tray");
  const find = () =>
    mac
      ? ["/Applications", join(home, "Applications")]
          .map((dir) => join(dir, "Schmear.app"))
          .find((p) => existsSync(p))
      : existsSync(tray)
        ? tray
        : undefined;
  const open = (path: string) => {
    if (mac) launch("open", [path]);
    else launch(path, []);
    io.log("ok", mac ? "Opened the menu bar app." : "Opened the tray app.");
  };
  const found = find();
  if (found) return open(found);

  const brew = mac ? await findExecutableOnPath("brew") : null;
  if (mac && !brew) {
    io.log("info", `Menu bar app: ${APP_DOCS}menu-bar-and-tray-apps`);
    return;
  }
  const hint = brew
    ? "brew install --cask kevin1chun/tap/schmear"
    : "downloads the release, checks its sha256 and runs its install.sh";
  const ask = mac ? "Install the schmear menu bar app?" : "Install the schmear tray app?";
  const answer = await io.select(
    ask,
    [
      { value: "install", label: "Install it", hint },
      { value: "skip", label: "Not now" },
    ],
    "install",
  );
  if (answer !== "install") return;
  const env = process.env as Record<string, string>;
  const code = brew
    ? await run(brew, ["install", "--cask", "kevin1chun/tap/schmear"], env)
    : await run("sh", [TRAY_INSTALLER], env);
  if (code !== 0) {
    io.log(
      "warn",
      mac
        ? `Menu bar app not installed (brew exited ${code}).`
        : `Tray app not installed (exit ${code}); see ${APP_DOCS}linux-tray-app`,
    );
    return;
  }
  const installed = find();
  if (installed) open(installed);
  else
    io.log(
      "warn",
      mac
        ? "Installed, but Schmear.app is not in /Applications or ~/Applications."
        : `Installed, but ${tray} is missing.`,
    );
}

/** Reads every consented subscription's quotas and groups them by agent → account → pool. */
export async function quotaRows(
  adapters: Record<AgentId, AgentAdapter>,
  plans: ReadonlyMap<string, string> = new Map(),
  onProgress?: (status: string) => void,
): Promise<QuotaRows> {
  const { config, routable, readings, credits, read } = await loadRouting(adapters);
  let done = 0;
  await Promise.all(
    routable.map(async (id) => {
      await read(id, USAGE_SHOW_MS);
      onProgress?.(`Reading quotas (${++done}/${routable.length}) · ${id}`);
    }),
  );
  const agents: QuotaAgent[] = [];
  const unused: string[] = [];
  const creditReadings = [...credits.values()];

  for (const agent of Object.keys(adapters) as AgentId[]) {
    const ids = Object.keys(config.agents).filter((id) => parseInstance(id)?.agent === agent);
    if (ids.length === 0) continue;
    const isDefault = (id: string) => id === instanceId(agent, DEFAULT_ACCOUNT);
    const ordered = [...ids.filter(isDefault), ...ids.filter((id) => !isDefault(id))];
    if (!ordered.some((id) => readings.has(id))) {
      unused.push(NAMES[agent]);
      continue;
    }
    const accounts: QuotaAccount[] = ordered.map((id) => {
      const account = parseInstance(id)?.account ?? id;
      const reading = readings.get(id);
      if (!reading) return { account, notUsed: true, warnings: [], pools: [] };
      const plan = plans.get(id);
      const planCreditsUsd = agent === "claude" ? planCredits(plan) : undefined;
      const owned = creditsOf(creditReadings, agent, account);
      const creditsHint = planCreditsUsd !== undefined && owned.length === 0;
      return {
        ...quotaAccount(account, reading, owned),
        ...(plan !== undefined ? { plan } : {}),
        ...(planCreditsUsd !== undefined ? { planCreditsUsd } : {}),
        ...(creditsHint ? { creditsHint: true } : {}),
      };
    });
    const owners = accounts.filter((a) => !a.notUsed).map((a) => a.account);
    agents.push({
      agent,
      name: NAMES[agent],
      accounts: [...accounts, ...apiOnlyAccounts(agent, owners, creditReadings)],
    });
  }
  return { agents, unused };
}

/** `uninstall [--yes]`: removes what init and credits wrote: each host's entry, the skills, config (with the Console sessions), state, and the data directory's logins and adapter trees. */
export async function uninstall(opts: { yes: boolean }, io: InitIO): Promise<void> {
  io.start(`schmear ${PACKAGE_VERSION} · uninstall`, "remove schmear from each host and delete local files");
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
  const keyCommands = Object.entries(prior?.credits ?? {}).flatMap(([id, pool]) =>
    isRecord(pool) && Array.isArray(pool.keyCommand) ? [{ id, command: pool.keyCommand.join(" ") }] : [],
  );
  const logins = Object.entries(prior?.agents ?? {}).flatMap(([id, e]) =>
    e.home ? [{ id, home: e.home }] : [],
  );
  const unregister: Record<AgentId, () => Promise<boolean | undefined>> = {
    claude: unregisterClaude,
    codex: () => unregisterToml(HOST_CONFIGS.codex()),
    grok: () => unregisterToml(HOST_CONFIGS.grok()),
    agy: () => unregisterJson(HOST_CONFIGS.agy()),
  };
  const removed = await io.task(
    "Removing schmear from hosts",
    async (update) => {
      const out: Array<{ id: AgentId; status?: boolean; error?: string }> = [];
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i] as AgentId;
        update(`Removing schmear from hosts (${i + 1}/${ids.length}) · ${HOSTS[id]}`);
        try {
          out.push({ id, status: await unregister[id]() });
        } catch (err) {
          out.push({ id, error: errorMessage(err) });
        }
      }
      return out;
    },
    () => "Hosts updated",
  );
  const failed: string[] = [];
  const width = Math.max(...ids.map((id) => HOSTS[id].length));
  for (const { id, status, error } of removed) {
    const host = HOSTS[id].padEnd(width);
    if (error !== undefined) {
      failed.push(HOSTS[id]);
      io.log("error", `${host}  not removed (${error})`);
    } else if (status) {
      io.log("ok", `${host}  removed`);
    } else {
      io.log(
        "info",
        paint(io.color, "dim", `${host}  ${status === undefined ? "not installed" : "not registered"}`),
      );
    }
  }
  for (const dir of dirs) {
    const existed = await stat(dir).then(
      () => true,
      () => false,
    );
    await rm(dir, { recursive: true, force: true });
    if (existed) io.log("ok", `Deleted ${paint(io.color, "dim", tilde(dir))}`);
  }
  for (const { id, home } of logins) {
    if (home.startsWith(`${dataDir()}${sep}`)) continue;
    io.log("info", `Your ${id} login stays in ${paint(io.color, "dim", tilde(home))}.`);
  }
  for (const { id, command } of keyCommands) {
    io.log("info", `Your ${id} API key stays where \`${command}\` reads it.`);
  }
  if (failed.length > 0) {
    throw new Error(`not removed from ${failed.join(", ")}`);
  }
  io.panel?.(
    "Remove the command",
    `Run ${paint(io.color, "cyan", "npm uninstall -g schmear")} or ${paint(io.color, "cyan", "brew uninstall schmear")}.`,
  );
  io.end("Removed.");
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

// planTier as `claude auth status --json` prints it: monthly API credits included (docs/research/api-credits.md).
const PLAN_CREDITS_USD: Record<string, number> = { max_5x: 100, max_20x: 200 };

const planCredits = (plan?: string): number | undefined =>
  plan !== undefined && Object.hasOwn(PLAN_CREDITS_USD, plan) ? PLAN_CREDITS_USD[plan] : undefined;

/** Consented accounts of `agent` with their detected plan, the default account first. */
const consentedAccounts = (config: Config, plans: ReadonlyMap<string, string>, agent: AgentId) =>
  Object.entries(config.agents)
    .flatMap(([id, e]) => {
      const instance = parseInstance(id);
      return instance?.agent === agent && e.consent
        ? [{ account: instance.account, plan: plans.get(id) }]
        : [];
    })
    .sort((a, b) => (a.account === DEFAULT_ACCOUNT ? -1 : b.account === DEFAULT_ACCOUNT ? 1 : 0));

const LOGIN_HELP =
  "In a browser signed in to platform.claude.com, open DevTools > Network, select any request to platform.claude.com and copy its Cookie request header. Then pipe it in: schmear credits login claude --stdin [--label <name>]";

const dollars = (usd: number) => `$${usd.toFixed(2)}`;

/** Each API org of a Console session with its balance. Throws the session's problem (never the cookie). */
async function orgBalances(
  cookie: string,
  fetchFn: typeof fetch,
): Promise<{ org: ConsoleOrg; balance: VendorBalance }[]> {
  const orgs = await listOrgs(cookie, fetchFn);
  return Promise.all(orgs.map(async (org) => ({ org, balance: await readCredits(cookie, org, fetchFn) })));
}

function logOrg(io: InitIO, org: ConsoleOrg, balance: VendorBalance, note?: string): void {
  const dim = (text: string) => paint(io.color, "dim", text);
  if ("error" in balance) {
    io.log("warn", `${org.name}  ${dim(org.id)}  ${balance.error}`);
  } else {
    io.log("ok", `${org.name}  ${dim(org.id)}  ${dollars(balance.usd)}${note ? `  ${dim(note)}` : ""}`);
  }
}

const GOOGLE_LOGIN_HELP =
  "For Google credits, in a browser signed in to Google, open DevTools → Network, copy the Cookie request header of any request to me.developers.google.com, and pipe it in: schmear credits login google --stdin [--label <name>]";

/** The Cookie header as one line of printable ASCII, after checking the session label. */
function cookieOf(header: string, label: string): string {
  if (!parseCreditPool(`claude-credits@${label}`)) {
    throw new Error('--label must be lowercase letters, digits and "-", up to 32');
  }
  const cookie = header.trim().replace(/^cookie:\s*/i, "");
  if (!/^[\x20-\x7e]+$/.test(cookie)) {
    throw new Error("the Cookie header must be one line of printable ASCII");
  }
  return cookie;
}

/** `credits login claude --stdin`: stores the Cookie header once the Console accepts it. The header is never printed or put in an error. */
export async function loginConsole(
  io: InitIO,
  header: string,
  label: string,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  io.start(
    `schmear ${PACKAGE_VERSION} · credits login`,
    "let schmear read your Claude Console credit balances",
  );
  const cookie = cookieOf(header, label);
  if (!/(^|;\s*)sessionKey=/.test(cookie)) {
    throw new Error(
      "the Cookie header has no sessionKey; copy the whole Cookie header of a platform.claude.com request",
    );
  }
  const rows = await io.task(
    "Checking the Console session",
    () => orgBalances(cookie, fetchFn),
    (r) => `Console accepted the session: ${r.length} API org${r.length === 1 ? "" : "s"}`,
  );
  await writeSession(label, cookie);
  for (const { org, balance } of rows) logOrg(io, org, balance);
  io.end(`Saved Console session ${label}.`);
}

const amount = (n: number, currency: string) =>
  currency === "USD" ? dollars(n) : `${n.toFixed(2)} ${currency}`;

function logGoogle(io: InitIO, { email, credit }: GoogleAccount, note?: string): void {
  const dim = (text: string) => paint(io.color, "dim", text);
  if (credit === undefined) {
    io.log("info", `${email}  ${dim("no Google credit")}`);
  } else if (credit === "unapplied") {
    io.log("warn", `${email}  Not applied`);
  } else {
    const { remaining, granted, currency, expiresAt, billing } = credit;
    const expiry =
      expiresAt === undefined ? [] : [`expires ${new Date(expiresAt * 1000).toISOString().slice(0, 10)}`];
    const detail = [...expiry, billing ?? "billing account unknown", ...(note ? [note] : [])].join(" · ");
    io.log("ok", `${email}  ${amount(remaining, currency)} of ${amount(granted, currency)}  ${dim(detail)}`);
  }
}

/** `credits login google --stdin`: stores the Cookie header once Google shows a signed-in account. The header is never printed or put in an error. */
export async function loginGoogle(
  io: InitIO,
  header: string,
  label: string,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  io.start(
    `schmear ${PACKAGE_VERSION} · credits login`,
    "let schmear read your Google Developer Program credit",
  );
  const cookie = cookieOf(header, label);
  const found = await io.task(
    "Checking the Google session",
    () => googleAccounts(cookie, fetchFn),
    (r) => `Google accepted the session: ${r.length} account${r.length === 1 ? "" : "s"}`,
  );
  await writeSession(label, cookie, "google");
  for (const account of found) logGoogle(io, account);
  io.end(`Saved Google session ${label}.`);
}

/** `credits logout <label>`, or `credits logout google <label>`. */
export async function logoutConsole(
  io: InitIO,
  label: string,
  vendor: SessionVendor = "claude",
): Promise<void> {
  io.start(`schmear ${PACKAGE_VERSION} · credits logout`);
  const name = vendor === "claude" ? "Console" : "Google";
  if (!(await removeSession(label, vendor))) throw new Error(`no ${name} session ${label}`);
  io.end(`Removed ${name} session ${label}.`);
}

/** `credits remove <id>`: the config entry, the pool's ledger and its credit home. */
export async function removeCredit(io: InitIO, id: string): Promise<void> {
  io.start(`schmear ${PACKAGE_VERSION} · credits remove`);
  const prior = await readConfig();
  if (!Object.hasOwn(prior.credits ?? {}, id)) throw new Error(`no credit pool ${id}`);
  const { [id]: pool, ...rest } = prior.credits ?? {};
  await writeIfChanged(configPath(), `${JSON.stringify({ ...prior, credits: rest }, null, 2)}\n`);
  if (parseCreditPool(id)) {
    await rm(join(stateDir(), "ledger", `${id}.jsonl`), { force: true });
    await rm(join(dataDir(), "credit-homes", id), { recursive: true, force: true });
  }
  const command = isRecord(pool) && Array.isArray(pool.keyCommand) ? pool.keyCommand.join(" ") : undefined;
  if (command) io.log("info", `Your API key stays where \`${command}\` reads it.`);
  io.end(`Removed ${id}.`);
}

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 32)
    .replace(/-+$/, "");

/** `credits [account]` (§13): one pool per Console org, picked from the stored sessions' orgs; `account` preselects the owner. */
export async function setupCredits(
  io: InitIO,
  adapters: Record<AgentId, AgentAdapter>,
  fetchFn: typeof fetch = fetch,
  account?: string,
): Promise<void> {
  io.start(
    `schmear ${PACKAGE_VERSION} · credits`,
    "spend each Claude Console org's and Google credit's balance on a separate lane",
  );
  io.end(await runCreditsWizard(io, adapters, fetchFn, account));
}

/** Each consented Claude account with the plan its own login reports. */
function claudePlans(config: Config, adapter: AgentAdapter): Promise<{ account: string; plan?: string }[]> {
  return Promise.all(
    Object.entries(config.agents).flatMap(([id, entry]) => {
      const instance = parseInstance(id);
      if (instance?.agent !== "claude" || !entry.consent) return [];
      const env = entry.home ? { [adapter.home.env]: entry.home } : undefined;
      return [
        adapter.find(entry.path, env).then((found) => ({
          account: instance.account,
          ...("error" in found || !found.plan ? {} : { plan: found.plan }),
        })),
      ];
    }),
  );
}

/** The key command typed as a JSON array, then the typed yes; undefined when the yes is not given. */
async function askKey(
  io: InitIO,
  o: { service: string; subject: string; title: string; detail: string },
): Promise<string[] | undefined> {
  io.log("info", `Store this ${o.subject} with: security add-generic-password -s ${o.service} -a schmear -w`);
  const keyCommand = JSON.parse(
    await io.text(`Command that prints this ${o.subject}, as a JSON array`, {
      initial: JSON.stringify(["security", "find-generic-password", "-s", o.service, "-w"]),
      validate: (v) => (isKeyCommand(v) ? undefined : "expected a JSON array of non-empty strings"),
    }),
  ) as string[];
  const confirmed = await io.text(o.title, { detail: o.detail, placeholder: "no" });
  return confirmed.toLowerCase() === "yes" ? keyCommand : undefined;
}

async function runCreditsWizard(
  io: InitIO,
  adapters: Record<AgentId, AgentAdapter>,
  fetchFn: typeof fetch,
  only?: string,
): Promise<string> {
  const prior = await readConfig();
  // Entries whose id is no credit pool (the 0.4 shape) are dropped on the first write.
  let credits: Record<string, CreditPoolConfig> = Object.fromEntries(
    Object.entries(prior.credits ?? {}).filter(([id]) => parseCreditPool(id)),
  );
  const save = async (id: string, pool: CreditPoolConfig) => {
    credits = { ...credits, [id]: pool };
    await writeIfChanged(configPath(), `${JSON.stringify({ ...prior, credits }, null, 2)}\n`);
  };
  // The pool that spends an org or billing account already.
  const poolOf = (field: "org" | "billingAccount", id: string) =>
    Object.entries(credits).find(([, pool]) => isRecord(pool) && pool[field] === id)?.[0];
  const agyConsented = prior.agents[instanceId("agy", DEFAULT_ACCOUNT)]?.consent === true;

  const claudeOrgs = async (): Promise<string> => {
    if (!prior.agents[instanceId("claude", DEFAULT_ACCOUNT)]?.consent) {
      throw new Error("Claude is not set up as a worker; run `schmear init` with `claude` logged in first.");
    }
    const sessions = Object.entries(await readSessions());
    if (sessions.length === 0) {
      io.log("info", `No Console session yet. ${LOGIN_HELP}`);
      return "Nothing to add.";
    }
    const consented = await claudePlans(prior, adapters.claude);
    const eligible = () =>
      consented.filter(
        ({ account, plan }) =>
          planCredits(plan) !== undefined && !(keyId("claude-credits", account) in credits),
      );
    if (only !== undefined) {
      const owner = consented.find((a) => a.account === only);
      if (!owner) throw new Error(`claude@${only} is not a consented account`);
      if (planCredits(owner.plan) === undefined)
        throw new Error(`claude@${only}'s plan includes no API credits`);
      if (keyId("claude-credits", only) in credits)
        throw new Error(`claude@${only} owns ${keyId("claude-credits", only)} already`);
    }
    const { rows, errors } = await io.task(
      "Reading your Console orgs",
      async () => {
        const rows = new Map<string, { org: ConsoleOrg; balance: VendorBalance }>();
        const errors: string[] = [];
        for (const [label, cookie] of sessions) {
          try {
            for (const row of await orgBalances(cookie, fetchFn))
              if (!rows.has(row.org.id)) rows.set(row.org.id, row);
          } catch (err) {
            errors.push(`session ${label}: ${errorMessage(err)}`);
          }
        }
        return { rows: [...rows.values()], errors };
      },
      ({ rows }) => `Found ${rows.length} Console org${rows.length === 1 ? "" : "s"}`,
    );
    if (rows.length === 0) throw new Error(errors.join(" "));
    for (const error of errors) io.log("warn", error);

    for (const { org, balance } of rows) {
      const pool = poolOf("org", org.id);
      logOrg(io, org, balance, pool ? `spent by ${pool}` : "no pool");
    }

    for (;;) {
      const open = rows.filter(({ org }) => poolOf("org", org.id) === undefined);
      if (open.length === 0) break;
      const pick = await io.select(
        "Add a pool for an org?",
        [
          ...open.map(({ org, balance }) => ({
            value: org.id,
            label: org.name,
            hint: "error" in balance ? "balance unreadable" : dollars(balance.usd),
          })),
          { value: "done", label: "Done" },
        ],
        "done",
      );
      const row = open.find(({ org }) => org.id === pick);
      if (!row) break;
      const owner = only ?? (await pickOwner(io, eligible()));
      const name =
        owner ??
        (await io.text("Pool name", {
          detail: `The pool spends org ${row.org.name} as claude-credits@<name>.`,
          initial: slug(row.org.name),
          validate: (v) => {
            if (!parseCreditPool(keyId("claude-credits", v)))
              return 'use lowercase letters, digits and "-", up to 32';
            if (consented.some((a) => a.account === v))
              return `that name belongs to claude@${v}; pick it above`;
            return keyId("claude-credits", v) in credits
              ? `${keyId("claude-credits", v)} already exists`
              : undefined;
          },
        }));
      const keyCommand = await askKey(io, {
        service: `schmear-anthropic-${name}`,
        subject: "org's API key",
        title: "Type yes to confirm auto-reload is off",
        detail:
          "Spend this org's whole credit balance, purchased credits included, down to 2%. schmear reads the balance from your Console session and cannot see auto-reload: turn it off at platform.claude.com/settings/billing, or Anthropic bills your card past the balance.",
      });
      if (!keyCommand) {
        io.log("warn", `Not confirmed; no pool written for ${row.org.name}.`);
        continue;
      }
      const id = keyId("claude-credits", name);
      await save(id, { org: row.org.id, keyCommand, overageOff: true });
      io.log(
        "ok",
        `Added ${id}. Edit "credits" in ${paint(io.color, "dim", tilde(configPath()))} to cap a task with taskCapUsd.`,
      );
      if (only !== undefined) break;
    }
    return "Ready.";
  };

  const googleCredits = async (): Promise<string> => {
    if (!agyConsented) {
      throw new Error("Antigravity is not set up as a worker; run `schmear init` with `agy` ticked first");
    }
    const sessions = Object.entries(await readSessions("google"));
    const { rows, errors } = await io.task(
      "Reading your Google credits",
      async () => {
        const rows = new Map<string, { email: string; credit: Credit; billing: string }>();
        const errors: string[] = [];
        for (const [label, cookie] of sessions) {
          try {
            for (const { email, credit } of await googleAccounts(cookie, fetchFn)) {
              const billing = typeof credit === "object" ? credit.billing : undefined;
              if (typeof credit === "object" && billing !== undefined && !rows.has(billing))
                rows.set(billing, { email, credit, billing });
            }
          } catch (err) {
            errors.push(`session ${label}: ${errorMessage(err)}`);
          }
        }
        return { rows: [...rows.values()], errors };
      },
      ({ rows }) => `Found ${rows.length} Google credit${rows.length === 1 ? "" : "s"}`,
    );
    if (rows.length === 0) {
      if (errors.length > 0) throw new Error(errors.join(" "));
      io.log(
        "info",
        "No Google credit is applied to a billing account. Apply it at me.developers.google.com/benefits.",
      );
      return "Nothing to add.";
    }
    for (const error of errors) io.log("warn", error);
    for (const { email, credit, billing } of rows) {
      const pool = poolOf("billingAccount", billing);
      logGoogle(io, { email, credit }, pool ? `spent by ${pool}` : "no pool");
    }

    for (;;) {
      const open = rows.filter(({ billing }) => poolOf("billingAccount", billing) === undefined);
      if (open.length === 0) break;
      const owners = consentedAccounts(prior, new Map(), "agy").filter(
        ({ account }) => !(keyId("gemini-credits", account) in credits),
      );
      const [first] = owners;
      if (!first) {
        io.log("info", "Every consented Antigravity account owns a gemini-credits pool already.");
        break;
      }
      const pick = await io.select(
        "Add a pool for a Google credit?",
        [
          ...open.map(({ email, credit, billing }) => ({
            value: billing,
            label: billing,
            hint: `${email} · ${amount(credit.remaining, credit.currency)} of ${amount(credit.granted, credit.currency)}`,
          })),
          { value: "done", label: "Done" },
        ],
        "done",
      );
      const row = open.find(({ billing }) => billing === pick);
      if (!row) break;
      const owner = await io.select(
        "Which account owns this pool?",
        owners.map(({ account }) => ({ value: `agy@${account}`, label: `agy@${account}` })),
        `agy@${first.account}`,
      );
      const name = owner.slice("agy@".length);
      const keyCommand = await askKey(io, {
        service: `schmear-gemini-${name}`,
        subject: "Gemini API key",
        title: "Type yes to confirm the Gemini API key and billing account",
        detail: `Spend this credit down to 2% through Antigravity on your Gemini API key. schmear reads the monthly credit from your Google session; it cannot see your AI Studio prepaid balance, and a run has no spend limit, so it can spend past the credit into that balance before Google stops at zero. Keep that balance small, keep auto-reload off, and confirm this key's project bills to ${row.billing}. Credit runs do not load your Antigravity settings, MCP servers or skills.`,
      });
      if (!keyCommand) {
        io.log("warn", `Not confirmed; no pool written for ${row.billing}.`);
        continue;
      }
      const id = keyId("gemini-credits", name);
      await save(id, { keyCommand, overageOff: true, billingAccount: row.billing });
      io.log("ok", `Added ${id}.`);
    }
    return "Ready.";
  };

  if (only !== undefined) return claudeOrgs();
  if (Object.keys(await readSessions("google")).length === 0) {
    if (agyConsented) io.log("info", GOOGLE_LOGIN_HELP);
    return claudeOrgs();
  }
  for (;;) {
    const pick = await io.select(
      "What do you want to add?",
      [
        { value: "claude", label: "Claude Console orgs" },
        { value: "google", label: "Google credits" },
        { value: "done", label: "Done" },
      ],
      "done",
    );
    if (pick === "done") return "Ready.";
    await (pick === "claude" ? claudeOrgs() : googleCredits());
  }
}

const API_ONLY = "api-only";

/** The account that owns the new pool, or undefined for an API-only pool; with no eligible account there is nothing to select. */
async function pickOwner(
  io: InitIO,
  accounts: { account: string; plan?: string }[],
): Promise<string | undefined> {
  const [first] = accounts;
  if (!first) return undefined;
  const pick = await io.select(
    "Which account owns this pool?",
    [
      ...accounts.map(({ account, plan }) => ({
        value: `claude@${account}`,
        label: `claude@${account} · ${plan} · $${planCredits(plan)} / month`,
      })),
      { value: API_ONLY, label: "API-only (name it)" },
    ],
    `claude@${first.account}`,
  );
  return pick === API_ONLY ? undefined : pick.slice("claude@".length);
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
