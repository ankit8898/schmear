#!/usr/bin/env node
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { adapters } from "./agents/index.ts";
import { ensureAdapters } from "./agents/shared.ts";
import { loginBrowser } from "./browser-login.ts";
import { PASTE } from "./console.ts";
import {
  creditsStatus,
  init,
  loginConsole,
  loginGoogle,
  logoutConsole,
  removeCredit,
  resetCredit,
  setupCredits,
  uninstall,
} from "./init.ts";
import { DEFAULT_MAX_PER_POOL } from "./router.ts";
import { cliUsageText, serveStdio, snapshot } from "./server.ts";
import {
  configPath,
  DEFAULT_MAX_TASKS,
  readConfig,
  readTiers,
  USAGE_ROUTE_MS,
  USAGE_SHOW_MS,
  writeLimit,
  writeTiers,
} from "./state.ts";
import { AGENT_IDS, DEFAULT_ACCOUNT } from "./types.ts";
import { type InitIO, lineIO, stderrColor, stdoutColor, ttyIO } from "./ui.ts";
import { errorMessage, PACKAGE_VERSION, SYS } from "./util.ts";
import {
  hasHelp,
  plainHelp,
  renderError,
  renderHelp,
  renderLimit,
  renderOk,
  renderTiers,
  renderUsage,
} from "./view.ts";

const LIMITS: Record<
  string,
  { key: "maxTasks" | "maxPerPool"; fallback: number; unit: string; applies: string }
> = {
  "max-tasks": {
    key: "maxTasks",
    fallback: DEFAULT_MAX_TASKS,
    unit: "tasks per call",
    applies: "A host uses it after it restarts schmear.",
  },
  "max-per-pool": {
    key: "maxPerPool",
    fallback: DEFAULT_MAX_PER_POOL,
    unit: "tasks at once per pool",
    applies: "Routing uses it from the next delegate call.",
  },
};

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const CREDITS_USAGE =
  "usage: schmear credits [<account> | status | login <claude|google> [--stdin] [--label <name>] | logout [google] <label> | remove <id> | reset <id>]";

const CREDITS_SUBCOMMANDS = ["status", "login", "logout", "remove", "reset"];

function parseCli() {
  try {
    return parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      options: {
        version: { type: "boolean", short: "v" },
        help: { type: "boolean", short: "h" },
        yes: { type: "boolean", short: "y" },
        stdin: { type: "boolean" },
        label: { type: "string" },
        json: { type: "boolean" },
        driver: { type: "string" },
      },
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    const message = errorMessage(error);
    const unknown = /^Unknown option '([^']+)'/.exec(message)?.[1];
    if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" && unknown) {
      throw new Error(`unknown option ${unknown}. Run schmear --help.`);
    }
    const name = /--([\w-]+)/.exec(message)?.[1];
    if (code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE" && name) {
      if (name === "driver") throw new Error(`--driver needs a value: one of ${AGENT_IDS.join(", ")}`);
      if (name === "label") throw new Error("--label needs a name");
      throw new Error(`--${name} takes no value`);
    }
    throw error;
  }
}

/** The options each command takes beyond --help and --version; a key is the command, or the command and its subcommand. */
const COMMAND_OPTIONS: Record<string, string[]> = {
  init: ["yes"],
  uninstall: ["yes"],
  usage: ["json", "driver"],
  tiers: ["json"],
  "tiers set": [],
  "tiers reset": [],
  "credits login": ["stdin", "label"],
};

const SUBCOMMANDS: Record<string, string[]> = { tiers: ["set", "reset"], credits: CREDITS_SUBCOMMANDS };

/** Fails on the first option `command` does not take. */
function checkOptions(given: string[], command: string, sub: string | undefined): void {
  const words = sub !== undefined && SUBCOMMANDS[command]?.includes(sub) ? `${command} ${sub}` : command;
  const allowed = COMMAND_OPTIONS[words] ?? COMMAND_OPTIONS[command] ?? [];
  const bad = given.find((name) => name !== "help" && name !== "version" && !allowed.includes(name));
  if (bad) throw new Error(`unknown option --${bad} for ${words}. Run schmear ${command} --help.`);
}

async function main(): Promise<void> {
  const { values, positionals } = parseCli();

  if (values.version) {
    process.stdout.write(`${PACKAGE_VERSION}\n`);
    return;
  }

  // Piped output stays plain; a terminal gets the styled view, with colour only where the stream takes it.
  const tty = process.stdout.isTTY;
  const view = { color: stdoutColor(), width: process.stdout.columns || 80 }; // columns is 0 in a pty with no size
  const ok = (text: string) => process.stdout.write(`${tty ? renderOk(text, view) : text}\n`);

  const [command, sub, arg, arg2] = positionals;
  if (values.help || command === undefined || command === "help") {
    const [topic, subtopic] = command === "help" ? [sub, arg] : [command, sub];
    if (topic !== undefined && !hasHelp(topic)) {
      throw new Error(`unknown command "${topic}". Run schmear --help.`);
    }
    const about = topic === undefined ? undefined : { command: topic, sub: subtopic };
    process.stdout.write(tty ? `${renderHelp(view, about)}\n` : plainHelp(about));
    return;
  }

  if (hasHelp(command)) checkOptions(Object.keys(values), command, sub);

  if (command === "serve") {
    if (process.stdin.isTTY) {
      process.stderr.write(
        "schmear serve is the MCP server your agents start; it waits for them on stdin. To set it up, run schmear init.\n",
      );
    }
    await serveStdio(adapters);
    return;
  }

  if (command === "usage") {
    const id = AGENT_IDS.find((a) => a === values.driver) ?? null;
    if (values.driver !== undefined && id === null) {
      throw new Error(`--driver must be one of ${AGENT_IDS.join(", ")}`);
    }
    let text: string;
    if (values.json) {
      text = JSON.stringify(await snapshot(adapters, id, USAGE_ROUTE_MS));
    } else if (tty) {
      text = renderUsage(await snapshot(adapters, id, USAGE_SHOW_MS), { ...view, now: Date.now() });
    } else {
      text = await cliUsageText(adapters, id);
    }
    process.stdout.write(`${text}\n`);
    return;
  }

  if (command === "tiers" && (sub === undefined || sub === "set" || sub === "reset")) {
    if (sub === undefined) {
      const doc = await readTiers();
      process.stdout.write(
        `${tty && !values.json ? renderTiers(doc.tiers, doc.source === "config", view) : JSON.stringify(doc, null, 2)}\n`,
      );
    } else if (sub === "reset") {
      await writeTiers(null);
      ok("Using the default tiers.");
    } else {
      let tiers: unknown;
      try {
        tiers = JSON.parse(await readStdin());
      } catch (error) {
        throw new Error(`tiers input is not JSON: ${errorMessage(error)}`);
      }
      await writeTiers(tiers ?? undefined); // JSON null would otherwise mean reset
      const n = Array.isArray(tiers) ? tiers.length : 0;
      ok(
        `Saved ${n} tiers to ${configPath()}. Routing uses them now; a host shows a changed tier count after it restarts schmear.`,
      );
    }
    return;
  }

  const limit = LIMITS[command ?? ""];
  if (limit) {
    if (sub === undefined) {
      const set = (await readConfig())[limit.key];
      process.stdout.write(
        `${tty ? renderLimit(set ?? limit.fallback, limit.unit, set !== undefined, view.color) : (set ?? limit.fallback)}\n`,
      );
    } else {
      const n = sub === "reset" ? null : Number(sub);
      await writeLimit(limit.key, n);
      const saved =
        n === null
          ? `Using the default of ${limit.fallback} ${limit.unit}.`
          : `Saved: up to ${n} ${limit.unit}.`;
      ok(`${saved} ${limit.applies}`);
    }
    return;
  }

  if (command === "init" || command === "credits" || command === "uninstall") {
    const cliPath = fileURLToPath(import.meta.url);
    const yes = values.yes === true;
    const vendor = arg === "claude" || arg === "google" ? arg : undefined;
    const browserLogin = command === "credits" && sub === "login" && !values.stdin && vendor !== undefined;
    // `credits status|logout|remove|reset` and `login --stdin` ask nothing; login's stdin holds the header, which must be read before readline.
    const direct =
      command === "credits" && sub !== undefined && CREDITS_SUBCOMMANDS.includes(sub) && !browserLogin;
    let run: (io: InitIO) => Promise<void>;
    if (command === "init") run = (io) => init({ yes, cliPath }, io, adapters, () => ensureAdapters());
    else if (command === "uninstall") run = (io) => uninstall({ yes }, io);
    else if (browserLogin) run = (io) => loginBrowser(io, vendor, values.label, { fetchFn: fetch, sys: SYS });
    else if (!direct) run = (io) => setupCredits(io, adapters, fetch, sub);
    else if (sub === "login" && vendor !== undefined) {
      // A pasted line at a terminal would echo the cookie into scrollback.
      if (process.stdin.isTTY) {
        throw new Error(
          `pipe the Cookie header in: ${PASTE} | schmear credits login ${vendor} --stdin [--label <name>]`,
        );
      }
      const header = await readStdin();
      if (header.trim() === "") {
        throw new Error(
          `nothing on stdin; pipe the Cookie header: ${PASTE} | schmear credits login ${vendor} --stdin`,
        );
      }
      const login = vendor === "claude" ? loginConsole : loginGoogle;
      run = (io) => login(io, header, values.label ?? DEFAULT_ACCOUNT);
    } else if (sub === "logout" && arg === "google" && arg2 !== undefined)
      run = (io) => logoutConsole(io, arg2, "google");
    else if (sub === "logout" && arg === "google")
      throw new Error("usage: schmear credits logout [google] <label>");
    else if (sub === "logout" && arg !== undefined) run = (io) => logoutConsole(io, arg);
    else if (sub === "remove" && arg !== undefined) run = (io) => removeCredit(io, arg);
    else if (sub === "reset" && arg !== undefined) run = (io) => resetCredit(io, arg);
    else if (sub === "status") run = (io) => creditsStatus(io, adapters);
    else throw new Error(CREDITS_USAGE);
    if (tty && (process.stdin.isTTY || direct)) {
      await run(ttyIO());
      return;
    }
    const rl = createInterface({ input: process.stdin });
    const lines = rl[Symbol.asyncIterator]();
    const ask = async (question: string) => {
      process.stdout.write(question);
      const next = await lines.next();
      if (next.done) {
        const asked = (question.trim().split("\n")[0] as string).replace(
          /(\s*(\([^()]*\)|\[[^[\]]*\]))+$/,
          "",
        );
        throw new Error(
          `no answer for "${asked}": run it in a terminal${command === "credits" ? "" : ", or pass --yes"}`,
        );
      }
      // Piped input is not echoed, so the next output would continue the question's line.
      if (!process.stdin.isTTY) process.stdout.write("\n");
      return next.value;
    };
    try {
      await run(
        lineIO(
          ask,
          (text) => process.stdout.write(`${text}\n`),
          (text) => process.stderr.write(`${text}\n`),
        ),
      );
    } finally {
      rl.close();
    }
    return;
  }

  throw new Error(`unknown command "${positionals.join(" ")}". Run schmear --help.`);
}

main().catch((error: unknown) => {
  process.stderr.write(
    process.stderr.isTTY
      ? `${renderError(errorMessage(error), stderrColor())}\n`
      : `schmear: ${errorMessage(error)}\n`,
  );
  process.exitCode = 1;
});
