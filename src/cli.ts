#!/usr/bin/env node
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { adapters } from "./agents/index.ts";
import { ensureAdapters } from "./agents/shared.ts";
import { init, setupCredits, uninstall } from "./init.ts";
import { DEFAULT_MAX_PER_POOL } from "./router.ts";
import { cliUsageText, serveStdio, snapshot } from "./server.ts";
import {
  configPath,
  DEFAULT_MAX_TASKS,
  readConfig,
  readTiers,
  USAGE_ROUTE_MS,
  writeLimit,
  writeTiers,
} from "./state.ts";
import { AGENT_IDS } from "./types.ts";
import { type InitIO, lineIO, ttyIO } from "./ui.ts";
import { errorMessage, PACKAGE_VERSION } from "./util.ts";

const USAGE = `schmear: delegate coding subtasks across your AI subscriptions

Usage:
  schmear init [--yes]   detect CLIs, pick subscriptions, register the MCP server in each host
  schmear usage [--json] [--driver <id>]
                         show each subscription's quota and where the next task would go
  schmear tiers          print the tier list as JSON
  schmear tiers set      replace the tier list with the JSON array of arrays on stdin
  schmear tiers reset    restore the default tier list
  schmear max-tasks      print the most tasks one delegate call may carry
  schmear max-tasks <n>  set it; "reset" restores the default of 50
  schmear max-per-pool   print the most tasks that run at once on one usage pool
  schmear max-per-pool <n> set it; "reset" restores the default of 10
  schmear credits        spend your Claude Max/Ultra API credits on a separate lane
  schmear uninstall [--yes]
                         remove schmear from each host, and delete its skills, config and state
  schmear serve          run the stdio MCP server (your host starts this)

Options:
  -y, --yes      init: use every detected subscription; uninstall: skip the confirmation
  --json         print usage as one JSON snapshot, from the routing cache
  --driver <id>  route as if this agent were driving, keeping its reserve (claude, codex, grok, agy)
  -h, --help     show this help
  -v, --version  print the version

Docs: https://github.com/kevin1chun/schmear
`;

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

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      version: { type: "boolean", short: "v" },
      help: { type: "boolean", short: "h" },
      yes: { type: "boolean", short: "y" },
      json: { type: "boolean" },
      driver: { type: "string" },
    },
  });

  if (values.version) {
    process.stdout.write(`${PACKAGE_VERSION}\n`);
    return;
  }

  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }

  const [command, sub] = positionals;
  if (command === "serve") {
    await serveStdio(adapters);
    return;
  }

  if (command === "usage") {
    const id = AGENT_IDS.find((a) => a === values.driver) ?? null;
    if (values.driver !== undefined && id === null) {
      throw new Error(`--driver must be one of ${AGENT_IDS.join(", ")}`);
    }
    const text = values.json
      ? JSON.stringify(await snapshot(adapters, id, USAGE_ROUTE_MS))
      : await cliUsageText(adapters, id);
    process.stdout.write(`${text}\n`);
    return;
  }

  if (command === "tiers" && (sub === undefined || sub === "set" || sub === "reset")) {
    if (sub === undefined) {
      process.stdout.write(`${JSON.stringify(await readTiers(), null, 2)}\n`);
    } else if (sub === "reset") {
      await writeTiers(null);
      process.stdout.write("Using the default tiers.\n");
    } else {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      let tiers: unknown;
      try {
        tiers = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch (error) {
        throw new Error(`tiers input is not JSON: ${errorMessage(error)}`);
      }
      await writeTiers(tiers ?? undefined); // JSON null would otherwise mean reset
      const n = Array.isArray(tiers) ? tiers.length : 0;
      process.stdout.write(
        `Saved ${n} tiers to ${configPath()}. Routing uses them now; a host shows a changed tier count after it restarts schmear.\n`,
      );
    }
    return;
  }

  const limit = LIMITS[command ?? ""];
  if (limit) {
    if (sub === undefined) {
      process.stdout.write(`${(await readConfig())[limit.key] ?? limit.fallback}\n`);
    } else {
      const n = sub === "reset" ? null : Number(sub);
      await writeLimit(limit.key, n);
      const saved =
        n === null
          ? `Using the default of ${limit.fallback} ${limit.unit}.`
          : `Saved: up to ${n} ${limit.unit}.`;
      process.stdout.write(`${saved} ${limit.applies}\n`);
    }
    return;
  }

  if (command === "init" || command === "credits" || command === "uninstall") {
    const cliPath = fileURLToPath(import.meta.url);
    const yes = values.yes === true;
    const run = (io: InitIO) =>
      command === "init"
        ? init({ yes, cliPath }, io, adapters, () => ensureAdapters())
        : command === "uninstall"
          ? uninstall({ yes }, io)
          : setupCredits(io, adapters.claude);
    if (process.stdin.isTTY && process.stdout.isTTY) {
      await run(ttyIO());
      return;
    }
    const rl = createInterface({ input: process.stdin });
    const lines = rl[Symbol.asyncIterator]();
    const ask = async (question: string) => {
      process.stdout.write(question);
      const next = await lines.next();
      return next.done ? "" : next.value;
    };
    try {
      await run(lineIO(ask, (text) => process.stdout.write(`${text}\n`)));
    } finally {
      rl.close();
    }
    return;
  }

  process.stderr.write(USAGE);
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`schmear: ${errorMessage(error)}\n`);
  process.exitCode = 1;
});
