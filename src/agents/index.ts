import { constants } from "node:fs";
import { access } from "node:fs/promises";
import type { AgentAdapter, AgentId } from "../types.ts";
import { unreadable } from "../util.ts";
import { agyAdapter } from "./agy.ts";
import { claudeAdapter } from "./claude.ts";
import { codexAdapter } from "./codex.ts";
import { grokAdapter } from "./grok.ts";

/**
 * init keeps the entry of a CLI it cannot find, so its stored path may be gone. That read fails before any CLI or
 * credential read: Claude's and Codex's token fallbacks would otherwise read usage and route tasks to a missing CLI.
 */
export const installed = (adapter: AgentAdapter): AgentAdapter => ({
  ...adapter,
  readUsage: (bin, env) =>
    access(bin, constants.X_OK).then(
      () => adapter.readUsage(bin, env),
      () => unreadable(adapter.id, `${adapter.id} not found at ${bin}; reinstall it or run schmear init`),
    ),
});

export const adapters: Record<AgentId, AgentAdapter> = {
  claude: installed(claudeAdapter),
  codex: installed(codexAdapter),
  grok: installed(grokAdapter),
  agy: installed(agyAdapter),
};
