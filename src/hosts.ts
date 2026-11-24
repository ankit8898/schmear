import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { codexConfigPath } from "./agents/codex.ts";
import { grokHome } from "./agents/grok.ts";
import { readConfig } from "./state.ts";
import { AGENT_IDS, type AgentId, DEFAULT_ACCOUNT, instanceId } from "./types.ts";
import { isRecord } from "./util.ts";

export const HOSTS: Record<AgentId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  grok: "Grok",
  agy: "Antigravity",
};

export const HOST_CONFIGS: Record<Exclude<AgentId, "claude">, () => string> = {
  codex: codexConfigPath,
  grok: () => join(grokHome(), "config.toml"),
  agy: () => join(homedir(), ".gemini", "config", "mcp_config.json"),
};

export const tilde = (path: string): string =>
  path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path;

export type HostConnectionStatus = "ok" | "stale" | "missing";

export interface HostStatus {
  id: AgentId;
  status: HostConnectionStatus;
}

interface HostCheck extends HostStatus {
  missingPath?: string;
}

const isExistingFile = (path: unknown): Promise<boolean> =>
  typeof path === "string" && path.length > 0
    ? stat(path).then(
        (info) => info.isFile(),
        () => false,
      )
    : Promise.resolve(false);

async function readHostEntry(id: AgentId): Promise<unknown> {
  const path =
    id === "claude" ? join(process.env.CLAUDE_CONFIG_DIR ?? homedir(), ".claude.json") : HOST_CONFIGS[id]();
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    if (id === "codex" || id === "grok") {
      const servers = parseToml(text).mcp_servers;
      return isRecord(servers) && !Array.isArray(servers) ? servers.schmear : undefined;
    }
    const parsed: unknown = JSON.parse(text);
    const servers = isRecord(parsed) && !Array.isArray(parsed) ? parsed.mcpServers : undefined;
    return isRecord(servers) && !Array.isArray(servers) ? servers.schmear : undefined;
  } catch {
    return undefined;
  }
}

async function checkHost(id: AgentId): Promise<HostCheck> {
  const entry = await readHostEntry(id);
  if (!isRecord(entry) || Array.isArray(entry)) {
    return { id, status: "missing" };
  }
  const command = entry.command;
  if (!(await isExistingFile(command))) {
    return { id, status: "stale", ...(typeof command === "string" ? { missingPath: command } : {}) };
  }
  const arg0 = Array.isArray(entry.args) ? entry.args[0] : undefined;
  if (!(await isExistingFile(arg0))) {
    return { id, status: "stale", ...(typeof arg0 === "string" ? { missingPath: arg0 } : {}) };
  }
  return { id, status: "ok" };
}

async function hostChecks(): Promise<HostCheck[]> {
  const config = await readConfig();
  const checks = await Promise.all(
    AGENT_IDS.map(async (id): Promise<HostCheck | undefined> => {
      const entry = config.agents[instanceId(id, DEFAULT_ACCOUNT)];
      if (!entry || !(await isExistingFile(entry.path))) return undefined;
      return checkHost(id);
    }),
  );
  return checks.filter((check): check is HostCheck => check !== undefined);
}

export async function hostStatus(): Promise<HostStatus[]> {
  return (await hostChecks()).map(({ id, status }) => ({ id, status }));
}

export async function hostWarnings(): Promise<string[]> {
  return (await hostChecks()).flatMap(({ id, status, missingPath }) => {
    if (status === "ok") return [];
    const name = HOSTS[id];
    const reason =
      status === "missing"
        ? "no schmear entry"
        : missingPath
          ? `its entry runs ${tilde(missingPath)}, which no longer exists`
          : "its entry has no valid command";
    return [`${name} can't reach schmear: ${reason}. Run \`schmear init --yes\`, then restart ${name}.`];
  });
}
