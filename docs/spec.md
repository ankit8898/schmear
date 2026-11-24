# schmear: design spec

Package and binary name: `schmear`. Standing decisions: [Decisions](#decisions). Research inputs: `docs/research/` (tiers: `docs/research/model-tiers.md`). Probe scripts: `docs/probes/`.

## 1. Goal

schmear is an open-source TypeScript MCP server for people who pay for several AI coding subscriptions (Claude, ChatGPT/Codex, Google AI via Antigravity, SuperGrok). Whichever agent the user types into (the driver) calls one tool, `delegate`, to hand coding subtasks to the other agents (workers). schmear only load-balances: it launches each worker over the Agent Client Protocol (ACP) on the user's existing login, in the cwd the driver names, with the prompt the driver wrote, on a model at least as strong as the task's tier, and on the subscription most at risk of expiring unused at its reset, never spending into paid overage. The driver owns everything else: worktrees, read-only vs writing, commits, merging, ordering. Install is `npm i -g schmear && schmear init`.

## 2. Approach

- **One stdio MCP server per host session, no daemon.** Each host spawns its own `schmear serve`; processes share a usage cache and per-pool credit ledgers through files (§11). Nothing runs as a service.
- **A blocking `delegate` that takes a batch.** One call carries 1 to `maxTasks` tasks (config, default 50) that run concurrently and return together. Host-side parallel tool calls are unreliable (Antigravity serial; Claude Code and Codex only with `readOnlyHint`, R8), and every host tolerates long calls once `init` sets its timeout (R8–R11); `start`/`wait` polling would cost driver turns.
- **ACP is the only launch path.** All four ACP routes passed a live task (R1–R4). No CLI launcher exists.
- **`@agentclientprotocol/sdk` 2.9.1 as the ACP client.** Both official adapters depend on it, and it ships the typed v1 schema.
- **Native permissions, prompts forwarded.** Workers keep each CLI's own permission mode and sandbox settings; schmear forwards every permission request a worker sends to the driver's user as an MCP elicitation, and rejects it when nobody can answer.
- **Usage reads are read-only and fail closed, CLI first (owner ruling 2026-11-24, "CLI first, keep PAT").** Each reader runs the vendor CLI's own read first and reads a credential, as CodexBar does, only when that read fails; the reading's `source` names the step that answered. Claude: its CLI's `get_usage` control request (R34), then Claude Code's OAuth token against `api.anthropic.com`. Codex: the app-server RPC (R13), then a `personal_access_token`, then the `auth.json` OAuth access token, both against `chatgpt.com` wham usage. Grok: ACP billing (R14) with CodexBar's bearer fallbacks, unchanged. Antigravity: `agy -p /usage` (R12), then, for `@default` only, the desktop app's local language server. Credit-pool balance reads also follow CodexBar (§13): Claude Console org prepaid credits via `platform.claude.com` (`claudeplatform`, M1; M2 adds xAI Management API prepaid balance minus postpaid invoice preview and OpenAI legacy `credit_grants`). The credentials read, only when the CLI read fails, always in memory and never written or refreshed: the Claude Code OAuth token (`.credentials.json`, or on macOS the default login's Keychain item through `/usr/bin/security`), sent only to `api.anthropic.com`; the Codex PAT (sent only to `auth.openai.com` and `chatgpt.com`) and OAuth access token (only `chatgpt.com`) from `auth.json`; the Antigravity app's CSRF token, read from `ps` and sent only to `127.0.0.1`; the grok login's bearer token, for Grok's fallbacks; and the user-supplied Claude Console `Cookie` headers from `console-sessions.json`, sent only to `platform.claude.com`. An unreadable pool is skipped.
- **A tier list**, weakest first, of any length: each tier names the `lane:model@effort` entries that qualify. The default is `DEFAULT_TIERS` in `src/tiers.ts`, rated in `docs/research/model-tiers.md` §3; `Config.tiers` replaces it whole. More thinking is a higher tier, and routing treats the tier as a floor.

| # | Question | Decision | Evidence |
|---|---|---|---|
| 1 | ACP launch | `claude-agent-acp` 0.110.0 with the user's `claude`, `codex-acp` 2.10.0 with the user's `codex`, `grok agent stdio`, `agy acp`. The registry's `agy-acp-server` fails auth and is not used. | R1–R4, R1b, R2b, R4b |
| 2 | ACP surface | SDK stable app API: `initialize`, `session/new`, `session/set_config_option` found by category (`mode`, `model`, `thought_level`), `session/prompt`, `session/update`, `session/request_permission`, `session/cancel`, `session/resume`/`session/load`. | §7, R1–R4, R33 |
| 3 | Quota signal | Claude `-32603` `billing_error`, or `rate_limit` with `rateLimit.status` `rejected`, plus the live `_claude/rateLimit` watch; Codex `-32603` `usageLimitExceeded`; Grok and agy assumed message matches. | §8 |
| 4 | Host timeouts, parallelism | Blocking batch `delegate`; init writes a 24 h timeout per host. | R8–R11 |
| 5 | clientInfo.name | `claude-code`, `codex-mcp-client`, `grok-shell-<server>`, `antigravity-client`. | R8 |
| 6 | Rule files | Each worker loads what its CLI loads natively in the driver's cwd; schmear adds nothing. | R1–R4 |
| 7 | Shared state | Per-agent usage cache (served up to 5 min for routing, 60 s for `usage` and for a failed reading), per-lane-key offered-model list, and an append-only credit ledger; no locks. | §11 |
| 8 | Project | `schmear`, MIT, one package, GitHub Actions CI, tag-triggered `npm publish --provenance`. | §15 |

## Decisions

Settled; not reopened here.

- Delegation surface: one MCP server exposing a `delegate` tool and a read-only `usage` tool.
- schmear only load-balances subagents across subscriptions. The driver owns the prompt, the cwd (a worktree or not), read-only vs writing, commits, branches, merging, ordering and parallelism; schmear adds no prompt text and makes no worktree, branch or commit, and the cwd need not be a git repo. v1 targets coding subagents.
- Contract, per task in one batched `delegate` call (hosts run parallel tool calls unreliably): `prompt`, `cwd` and `tier` required; `description` optional; `agents` optional, an allowlist of agent ids (`claude`, `codex`, `grok`, `agy`), and schmear always picks the subscription; `session` optional, to continue an earlier subagent on its own provider and account without routing (that account out of quota → `no_quota`). Results carry status, reply, provider, model, effort, session, notes or error, and cost when reported (§6).
- Model tiers: an ordered list, weakest first, of any length, that the user can replace in config; each tier lists the `lane:model@effort` entries that qualify, and the shipped list, rated from public sources (Artificial Analysis, Epoch AI, Anthropic's model guidance), is the default. There is no per-task effort: more thinking is a higher tier. The tier is a floor; within the pace tie band the exact tier wins; models an account does not offer are dropped; one model reachable through several subscriptions is a separate lane per subscription.
- TypeScript, published to npm; no CodexBar dependency. Two thin clients read `schmear usage --json` and `schmear tiers`, set `schmear max-tasks`, run `schmear init --yes` to reconnect a host, and hold no routing, usage or validation code: the macOS menu bar app in `macos/` (Swift, the project's only Swift code) and the Linux tray app in `linux/` (C++17, Qt 6 Widgets).
- Usage reading runs the vendor CLI's own read first and falls back to CodexBar a26ca57's credential reads (Claude OAuth, Codex PAT then OAuth, Antigravity's app server) only when it fails; Claude's `get_usage` stands in for CodexBar's CLI PTY step, and CodexBar's Web and browser-cookie steps, Antigravity's IDE and Google OAuth steps and Codex's web dashboard are not adopted. Owner rulings 2026-11-24: "Copy CodexBar's" (the credential reads, and both User-Agents, Claude Code's `claude-cli/<version> (external, cli)` on the Claude OAuth request and Codex CLI's `codex_cli_rs/<version> (<os> <version>; <arch>)` with `originator: codex_cli_rs` on the Codex PAT calls; the Codex OAuth call sends `schmear/<version>` where CodexBar names itself), then "CLI first, keep PAT" (the order). schmear never writes or refreshes a token and never runs inference with one, rereads credentials on every check, asks consent once per provider at `init`, and skips a pool whose usage cannot be read (fail closed).
- Grok usage copies CodexBar's Grok pipeline exactly, including its grok.com path and its rule that a missing percent counts as zero only where CodexBar accepts it; no ACP-only inference.
- ACP is the only launch path. A per-agent CLI launcher is allowed only for an agent whose ACP route fails a real test.
- Claude launches over ACP via `@agentclientprotocol/claude-agent-acp` without `--hide-claude-auth`, despite Anthropic's Agent SDK policy on claude.ai login in third-party products; `docs/safety.md` discloses this. schmear does not otherwise act on that policy.
- Credit pools spend each vendor's reported API credit balance (promotional and purchased credits alike, down to the 2% floor) on separate API-key lanes (`docs/research/api-credits.md`, §13); balances are read from the vendor after CodexBar (Claude Console orgs first, one pool per org), fail closed when unreadable, and never fall through to a card.
- Workers have the tools, MCP servers, skills and plugins their CLI has when used directly, and run with its native permission mode and sandbox settings in the driver's cwd; schmear strips billing env vars and, for parity, sets the codex-acp mode matching the Codex config. Grok is a full worker. `docs/safety.md` discloses that workers can use the user's MCP tools.
- Permission prompts are forwarded to the driver's user over MCP elicitation, naming the worker and task; decline, cancel, or a driver without elicitation rejects that one request and the worker continues.
- Rule files: each worker sees only what its CLI loads natively.
- Never route into paid overage: a pool at or below the 2% floor counts as out.
- Concurrency: at most `maxPerPool` (config, default 10) tasks run at once on one usage pool, counted across every schmear process; a task over the cap takes another eligible lane, even outside the pace band, or waits for a free slot, and never fails because of it.
- The driver is identified from the MCP handshake `clientInfo`; a reserve, 5% unless the user sets one per agent in config, is held on the driver's own pools and waived in the last 2 hours before their reset.
- The interactive permission-prompt check at each driver is deferred past v1.
- Antigravity subscriptions are opt-in: unticked in init until the user ticks them (owner, 2026-11-24; Google FAQ in docs/safety.md).
- The install stays lightweight (owner, 2026-11-24): the Claude and Codex ACP adapters are data, not npm dependencies. The package ships `adapters/package.json` and its lockfile; `init` and, when the tree is missing, the first Claude or Codex launch run `npm ci` on them into `<dataDir>/adapters/<lock hash>`, so a global install is about 32 MB and the tree about 45 MB.

## 3. User walkthroughs

1. **Install.** `npm i -g schmear && schmear init`: init finds `claude`, `codex`, `agy`, `grok`, asks which of them to use (one checklist, all ticked but Antigravity), reads usage once, prints the pools it found or why one is skipped, registers the server in each host with long timeouts, and installs the schmear skill in each.
2. **Delegate from Claude Code.** Claude calls `delegate({tasks:[{prompt:"Add tests for src/parse.ts …", cwd:"/repo/.wt/parse-tests", tier:2}]})`, having made that worktree itself. schmear picks the highest-pace lane whose model meets tier 2, say `agy-gemini:gemini-4-hydrogen`, sends the prompt unchanged, and returns the reply with `provider: agy`, `model`, `effort`, `session`. Any permission request from the worker appears in Claude Code as "agy worker on 'Add tests for src/parse.ts' asks: …".
3. **Fan out.** Three read-only reviews in one call, all with `cwd: "/repo"`: they share that directory and run concurrently, spread across the lanes in the pick's tie band.
4. **Check quota.** `schmear usage`, or the `usage` tool, prints every pool with its windows, pace and status, and the lane the next task of each tier 1..N would take.
5. **Continue.** `delegate({tasks:[{session:"<from the earlier result>", prompt:"Fix the review notes", cwd:"/repo/.wt/parse-tests", tier:2}]})` resumes the same worker session on the same provider.
6. **Second subscription.** In `schmear init`, the user picks Claude at "Add another subscription?" and nicknames it `work`; init tells them to sign in to that account at claude.ai first, creates `<data>/logins/claude-work`, and runs `claude auth login` with `CLAUDE_CONFIG_DIR` pointing there; it adds `claude@work` next to the existing `claude@default`, and `usage` shows a `claude@work` block whose lanes route by pace like any other. Workers for it run with `CLAUDE_CONFIG_DIR` set; the driver's own login is untouched.

## 4. Architecture

```
driver host (Claude Code | Codex | Grok | Antigravity)
   │ MCP stdio: initialize(clientInfo) → tools/call delegate | usage; ← elicitation/create (worker prompts)
   ▼
schmear serve ── server.ts ── delegate.ts ──► router.ts (pure) ◄── tiers.ts (list)
   │                    │             └─► acp.ts ──spawn──► claude-agent-acp | codex-acp | grok agent stdio | agy acp
   │                    └─► agents/<id>.ts: readUsage(), launch(), classifyFailure()
   └─► state.ts, credit.ts, console.ts: ~/.local/state/schmear/{usage,offered,ledger}, ~/.config/schmear/{config.json,console-sessions.json}
```

- One worker process per task, one ACP session per process, one prompt per session. No pooling.
- A nested `schmear serve` started from a worker's MCP config sees `SCHMEAR_WORKER=1` and exposes only `usage` (§14).

## 5. Files

| Path | Purpose |
|---|---|
| `package.json`, `tsconfig.json`, `tsconfig.build.json`, `biome.json`, `LICENSE` | Project configuration and license. |
| `README.md`, `docs/guide.md`, `docs/safety.md` | User docs (§15). |
| `src/types.ts` | §6. |
| `src/cli.ts` | `serve`, `init [--yes]`, `usage [--json] [--driver <id>]`, `tiers [--json\|set\|reset]`, `max-tasks [<n>\|reset]`, `max-per-pool [<n>\|reset]`, `credits [login claude --stdin [--label <name>]\|logout <label>\|remove <id>]`, `uninstall [--yes]`, `--version`. |
| `src/server.ts` | `createServer(adapters)` (async): `delegate` and `usage` tools, driver detection, permission prompts, worker mode (§12). |
| `src/delegate.ts` | Validate, route, launch, collect, reroute (§10). |
| `src/router.ts` | Pure pace, eligibility, the per-pool cap, and the load-first pick that also splits a batch (§9.2). |
| `src/tiers.ts` | The default tier list, `parseTiers()`, `candidates()` (§9.1). |
| `src/acp.ts` | `runWorker()` (§7), `withAcp()` (§7 steps 3 and 8, shared with Grok's probes), `workerEnv()` (§14). |
| `src/state.ts` | Paths, atomic write, usage cache, offered models, config (§11). |
| `src/tasks.ts` | The delegation log: `appendTask()`, `readTasks()`, `otherRunningLanes()` (§11). |
| `src/console.ts` | Claude Console session storage (`console-sessions.json`, 0600) and per-org prepaid credit balance reader (§13). |
| `src/credit.ts` | Per-pool credit ledgers, replay, vendor-cached pool readings, reservation and settlement (§11, §13). |
| `src/init.ts` | Detection, consent, adapter install, registration, skill install (§12). |
| `src/hosts.ts` | The four hosts' names and MCP config files, and each host's connection status for `usage` (§12). |
| `src/ui.ts` | init's terminal and line-based prompts (`ttyIO`, `lineIO`), `paint`, `wrap`, and the stdout/stderr colour checks. |
| `src/view.ts` | Pure terminal renderers in init's clack gutter: the shared quota block (`renderQuotas`), `renderUsage`, `renderHelp`, `renderTiers`, `renderOk`, `renderLimit`, `renderError`, and the plain `plainHelp`. `cli.ts` uses them only when the stream is a TTY; piped output, `--json` and the MCP `usage` text never change, and colour follows `NO_COLOR` / `FORCE_COLOR`. |
| `scripts/install-tray.sh` | The Linux tray app's download, sha256 check and install; the README block and `init` both run it. |
| `skills/schmear/SKILL.md` | The agent skill: when and how to delegate (§12). |
| `src/agents/{claude,codex,grok,agy}.ts` | One `AgentAdapter` each (§8). |
| `src/util.ts` | Helpers every layer uses: `PACKAGE_VERSION`, `isRecord`, `errorMessage`, `versionLine`, `unreadable`, and the process-group teardown (`leadGroup`, `endChild`). |
| `src/agents/permit.ts`, `shared.ts`, `index.ts` | §8 permission policy; the adapter tree (`adaptersDir`, `ensureAdapters`, `adapterBin`), window and line-exchange helpers; registry. |
| `adapters/package.json`, `adapters/package-lock.json`, `adapters/.npmrc` | The pinned Claude and Codex ACP adapters as data: shipped in the tarball (not the `.npmrc`), installed by `ensureAdapters` (§8, §15). |
| `test/*.test.ts`, `test/fake-agent.ts`, `test/fixtures/*.json` | Unit tests; scripted ACP agent; usage payloads from R12–R14, R34 and CodexBar's provider docs with numbers changed and no tokens. |
| `test/live/*.test.ts`, `test/live/guard.ts` | Opt-in live tests (never in CI) and the money guard. |
| `.github/workflows/ci.yml`, `release.yml` | §15. |
| `macos/` | The menu bar app (Swift package, not in the npm tarball): `SchmearKit` models, CLI runner and formatting; `SchmearBar` SwiftUI app; `build.sh` makes `Schmear.app`, signed with the keychain's Developer ID (or `SCHMEAR_SIGN_IDENTITY`, else ad hoc) and notarized when `SCHMEAR_NOTARY_PROFILE` is set. Runs only `usage --json`, `tiers`, `max-tasks` and `init --yes`. |
| `linux/` | The tray app (CMake project, not in the npm tarball): `src/kit` holds models, CLI runner, formatting, store, autostart and single instance, and theme and tray glyph; `src/app` holds the popover and tier editor windows and `main.cpp`. Tests run offscreen with the macOS fixtures. Runs only `usage --json`, `tiers`, `max-tasks` and `init --yes`. |

Runtime dependencies: `@agentclientprotocol/sdk` 2.9.1, `@modelcontextprotocol/sdk` ^1.32.2, `zod`, `smol-toml`, `@clack/prompts` (init's terminal prompts).

## 6. Interfaces (`src/types.ts`)

```ts
export const AGENT_IDS = ["claude", "codex", "grok", "agy"] as const;
export type AgentId = (typeof AGENT_IDS)[number];
export const LANE_KEYS = ["claude", "codex", "grok", "agy-gemini", "agy-argon", "agy-3p", "claude-credits"] as const;
export type LaneKey = (typeof LANE_KEYS)[number];
export const CREDIT_KEYS = ["claude-credits"] as const;
export type CreditKey = (typeof CREDIT_KEYS)[number];
export const isCreditKey = (key: string): key is CreditKey => (CREDIT_KEYS as readonly string[]).includes(key);

/** Asks the driver's user to pick one of a permission request's options. optionId, or undefined on decline/cancel; throws on error. */
export type Ask = (message: string, options: PermissionOption[], signal: AbortSignal) => Promise<string | undefined>;

export interface Window {
  kind: "short" | "period";              // short: rolling ≤ 24 h; period: weekly, 30-day, cycle
  remaining: number;                     // fraction left, 0..1
  resetsAt: number | null;               // epoch ms
  periodHours: number;
}
export interface Pool {
  id: string;                            // the adapter's pool id plus "@<account>": "claude@default", "claude-fable@work", "agy-gemini@default", "claude-credits@main", ...
  agent: AgentId;
  account: string;                       // "default" for the inherited-env login (§11), or the credit pool name
  keys: LaneKey[];                       // lanes of these keys draw on it
  models?: string[];                     // only lanes running one of these model values; undefined = every model
  windows: Window[];
  usd?: { left: number; granted: number }; // a credit pool's balance
}
export interface UsageReading {
  agent: AgentId; account: string; fetchedAt: number; pools: Pool[];
  error?: string;                        // unreadable: the agent is skipped (fail closed)
  warnings: string[];
  source?: string;                       // the step that produced the reading, when an agent has several (claude: oauth, cli; codex: pat, oauth, rpc; grok: acp, grok.com, cli-proxy; agy: app, cli)
}

/** A parsed tier-list entry `key:model@effort`; model and effort are the provider's own option values. */
export interface Entry { key: LaneKey; model: string; effort: string }
/** Weakest first: index 0 is tier 1. */
export type TierList = Entry[][];
/** Models each key id (`key@account`) offered at its last run; absent = unknown. */
export type Offered = Partial<Record<string, string[]>>;

// Every subscription is `<agent>@<account>`; the inherited-env login is "default" (§11).
export const DEFAULT_ACCOUNT = "default";
export const instanceId = (agent: AgentId, account: string): string => `${agent}@${account}`;
export const keyId = (key: string, account: string): string => `${key}@${account}`;
export function parseInstance(id: string): { agent: AgentId; account: string } | undefined;   // needs the "@"
export function parseCreditPool(id: string): { key: CreditKey; agent: AgentId; name: string } | undefined;  // splits at last "@", key in CREDIT_KEYS

export interface Lane {
  id: string;                            // `${keyId(key, account)}:${model}`
  agent: AgentId; account: string;
  key: LaneKey; tier: number; model: string; effort: string;   // the entry that runs (tier ≥ the task's)
}
export const laneInstance = (lane: Lane): string =>            // credit lane → `<agent>@default`, else `<agent>@<account>`
  instanceId(lane.agent, isCreditKey(lane.key) ? DEFAULT_ACCOUNT : lane.account);

export interface LaunchSpec {
  command: string; args: string[]; env: Record<string, string>;
  config?: { mode?: string; model?: string; effort?: string };   // set in this order (§7 step 5); mode: Codex only
  requireAuth?: { kind: string; detail?: string };              // Claude (§7 step 4)
  sessionMeta?: Record<string, unknown>;                         // credit lane only
}

export interface AgentAdapter {
  id: AgentId;
  isClient(clientName: string): boolean;
  home: { env: string; login: string[] };           // the variable that selects an account's login dir, and the args that sign in to it
  // env: an account's overlay ({ [home.env]: dir }), merged into every workerEnv the call makes
  find(bin: string, env?: Record<string, string>): Promise<{ version: string; plan?: string; email?: string } | { error: string }>; // error: why detection failed
  readUsage(bin: string, env?: Record<string, string>): Promise<UsageReading>;     // never throws
  launch(lane: Lane, cwd: string, bin: string, env?: Record<string, string>): Promise<LaunchSpec>;
  classifyFailure(f: WorkerFailure): "quota" | "failed";
  quotaRateLimit?(rateLimit: unknown): boolean;      // Claude only: a live rate-limit notice that ends the run as quota (§10 step 6)
}

export interface WorkerFailure {
  code?: number; message: string; data?: unknown;   // message: the agent's own error text
  stderr?: string;                       // the worker's stderr tail (§7 step 1); shown in the error, never classified
  rateLimit?: unknown;                   // last _claude/rateLimit (Claude)
  auth?: string;                         // authStatus label when requireAuth did not match
  notOffered?: { model: string; effort?: string };   // effort set: that effort is missing
}
export type WorkerOutcome =             // a run ends with a stop reason or a failure, never both
  | { stopReason: "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled"; failure?: never }
  | { failure: WorkerFailure; stopReason?: never };
export type WorkerRun = WorkerOutcome & {
  reply: string; costUsd?: number; sessionId: string;
  model?: string; effort?: string;       // what ran (§7 step 5)
  offered?: string[];                    // the session's `model` option values, when it has one
  prompted: boolean;                     // session/prompt was sent (§13 settle)
};

// MCP tool contract
export interface DelegateInput { tasks: DelegateTask[] }             // 1..maxTasks (default 50), run concurrently
export interface DelegateTask {
  prompt: string;                        // sent verbatim
  cwd: string;                           // absolute path of an existing directory; need not be a git repo
  tier: number;                          // 1..N, a floor on the tier list
  description?: string;                  // ≤ 80 chars, one line; default: the prompt's first non-empty line cut to 80
  agents?: AgentId[];                    // allowlist of agents; schmear picks the subscription
  session?: string;                      // TaskResult.session from an earlier call
}
export interface TaskResult {
  description: string;
  status: "done" | "failed" | "cancelled" | "no_quota";
  provider?: AgentId; account?: string; model?: string; effort?: string;   // account: set with provider
  session?: string;                      // base64url JSON {agent, account (a handle without it is "default"), key, model, effort, tier (the number the lane ran at, under that call's list), sessionId, cwd, costUsd (the run's cumulative cost, when reported)}, `.`, base64url HMAC-SHA256 of the JSON part (§10)
  costUsd?: number;                      // a resumed run: its cost less the handle's costUsd (§13)
  reply: string; notes: string[]; error?: string;
}

// ~/.config/schmear/config.json: `z.infer` of `ConfigSchema` in src/state.ts (§11), which has this shape
export type Config = {
  version: 1;
  agents: Record<string, { consent: boolean; path: string; home?: string }>;  // key: instance id `<agent>@<account>`; path non-empty; home (absolute) iff the account is not "default"
  tiers?: string[][];                    // replaces DEFAULT_TIERS whole (§9.1)
  reserve?: Partial<Record<AgentId, number>>;   // per-driver reserve fraction (§9.2)
  maxTasks?: number;                     // tasks one delegate call may carry; replaces DEFAULT_MAX_TASKS = 50 (§12)
  maxPerPool?: number;                   // tasks running at once on one pool, across processes; replaces DEFAULT_MAX_PER_POOL = 10 (§9.2)
  credits?: Record<string, CreditPoolConfig>;  // keyed by pool id `<creditKey>@<name>` (§13)
};
export interface CreditPoolConfig {
  keyCommand: string[]; overageOff: true; taskCapUsd?: number;
  org?: string;                          // Claude: Console org uuid
  team?: string; managementKeyCommand?: string[];  // xAI
  organization?: string;                 // OpenAI
}
```

## 7. ACP client (`src/acp.ts`)

ACP v1 (`protocolVersion` 1), newline-delimited JSON-RPC on stdio. Schema: `@agentclientprotocol/sdk` 2.9.1 `schema/v1/schema.json`.

`runWorker(spec: LaunchSpec, cwd: string, prompt: string, opts: { agent: AgentId; signal: AbortSignal; onRateLimit?(rl: unknown, cancel: () => void): void; resume?: string; openTimeoutMs?: number; permit(req: RequestPermissionRequest, turn: AbortSignal): Promise<RequestPermissionResponse> }): Promise<WorkerRun>`

1. Spawn `spec.command spec.args` with `spec.env` and `cwd`, as the leader of its own process group (`detached: true`); keep the last 4 KB of stderr as `failure.stderr`, apart from `failure.message`. From spawn until the `session/prompt` request is sent (steps 3–5), the run has `opts.openTimeoutMs` (default `OPEN_TIMEOUT_MS` = 120 000); on expiry it ends as a failure "<agent> did not open a session within 120 s" and the child is torn down as in step 8. The prompt itself is unbounded.
2. SDK stable app API `client({name: "schmear"})`. `session/request_permission` → `opts.permit(params, turn.signal)`, where `turn` is an `AbortController` aborted on every exit (steps 7–8), which withdraws a prompt still open in the driver; ACP requires `cancelled` for every request pending at `session/cancel` (`schema.json:6691`). `fs/*` and `terminal/*` stay unregistered. Keep the last `_auth/status_update` (claude-agent-acp).
3. `initialize {protocolVersion: 1, clientCapabilities: {fs: {readTextFile: false, writeTextFile: false}, terminal: false}, clientInfo}`. Never `authenticate`; a later `-32000` becomes "log in with the <opts.agent> CLI".
4. `session/new {cwd, mcpServers: []}` (plus `_meta: spec.sessionMeta`). With `spec.requireAuth`, the last `authStatus` received by the time `session/new` returns must match, else the run ends with `failure.auth` and no prompt (R24). With `opts.resume` (the session id), send `session/resume {sessionId, cwd, mcpServers: []}` (plus the same `_meta`, so a resumed credit session keeps its budget stop) when `agentCapabilities.sessionCapabilities.resume`, else `session/load` (same params) when `agentCapabilities.loadSession`, else fail "<agent> agent cannot resume a session"; `WorkerRun.sessionId` is `opts.resume`, and `requireAuth` and step 5 apply as for a new session. History `session/load` replays is not part of the reply.
5. For each of `spec.config.mode`, `.model`, `.effort` that is set, in that order: find the option of category `mode`, `model` or `thought_level` in the latest `configOptions` (from `session/new`, then from each `session/set_config_option` response, since effort values depend on the model, R33) and set it. A missing option or value ends the run before the prompt: with no `mode` or `model` option, as a failure `config option category "<category>" is not available`; for a model the option lacks, with `failure.notOffered = {model}`; for the effort, with `failure.notOffered = {model, effort}`; the failure message lists the option's values; for a mode the option lacks, as a failure "invalid mode <value>; available: …". Once the session is open, every returned `WorkerRun` (success, failure, `notOffered`) carries `offered` = the `model` option's values when it has one (§10 step 5). Then record `WorkerRun.model` = the current value of the `model` option and `WorkerRun.effort` = the current value of the `thought_level` option; with no `thought_level` option, the effort is `session/new`'s `models.availableModels[modelId = models.currentModelId]._meta.reasoningEffort` (Grok, R33).
6. `session/prompt` with the prompt unchanged (`session/update` is handled directly: the SDK's `ActiveSession` cannot wrap a resumed session). From the prompt's start until it returns its `stopReason`: append `agent_message_chunk` text; `WorkerRun.prompted` is true from just before the request is sent; on `usage_update` with `currency === "USD"`, `WorkerRun.costUsd` is the maximum `cost.amount` seen; pass `_meta["_claude/rateLimit"]` to `onRateLimit`.
7. Abort (`opts.signal`, or `cancel()` from `onRateLimit`): `session/cancel`, then abort `turn`; wait up to 10 s for `stopReason: "cancelled"`, then SIGTERM, then SIGKILL 5 s later.
8. Every exit path: abort `turn`, end stdin, SIGTERM the child's process group if the child is alive, SIGKILL the group 5 s later unless the child has exited, and return only after it exits. The child's exit SIGKILLs whatever it left in the group (the vendor CLI, MCP servers). The child exiting fails the run even while a grandchild holds its stdout open.

## 8. Agent adapters

**Adapter tree** (`src/agents/shared.ts`): `adaptersDir(env)` is `<dataDir>/adapters/<first 16 hex of sha256(shipped adapters/package-lock.json)>`, recomputed on every call. `ensureAdapters(env, npmCi)` returns when the tree exists; otherwise it copies the shipped `package.json` and lock into a `mkdtemp` sibling, runs `npmCi` there (default: the `npm` beside `process.execPath`, run with that Node, never PATH: `npm ci --omit=optional --omit=peer --ignore-scripts --no-audit --no-fund`, 120 s cap), renames it into place, then deletes every other entry of `adapters/` whose name does not start with the current hash. Calls for one tree in a process share one promise, and a process whose install fails succeeds anyway if another process's tree now exists; else it throws `could not install the Claude and Codex ACP adapters: <cause>` naming `schmear init --yes`, caches nothing, and the next task retries. `adapterBin(pkg, bin)` ensures the tree and returns the bin read from `<tree>/node_modules/<pkg>/package.json`. `init` calls `ensureAdapters` when a Claude or Codex subscription is on; both launches call `adapterBin`.

**Permission policy** (`src/agents/permit.ts`, the same for every agent): `permit(req, turn, ctx: { who: string; ask?: Ask; note(text: string): void }): Promise<RequestPermissionResponse>`, with `who` = `<agent> worker on '<description>'`.

- With `ask`: `ask("<who> asks: <toolCall.title ?? "a tool call"> (<kind ?? "other">[: <paths>])", req.options, turn)`, where paths are `toolCall.locations[].path` and `content[]` `diff` paths, comma-separated, shown only when present. An optionId → `{outcome: {outcome: "selected", optionId}}`.
- No `ask` (a driver without form elicitation), `undefined`, or a throw → rejected, and the worker continues, as a headless native CLI does (R31). A throw while `turn` is live adds the note "permission prompt failed: <message>; rejected".
- Rejected = the `reject_once` option with optionId `decline` if listed (codex-acp's "continue without it"), else the first `reject_once`, else the `cancelled` outcome. Once `turn` has aborted, the answer is `cancelled`.
- Which requests arrive is each CLI's choice under its own mode: Claude and agy ask for edits in `default` mode (R5); Codex asks only to leave its sandbox (R5, R6, R7); Grok sent none for edits or MCP calls (R5, R23); agy asks for every MCP call (R23).

### 8.1 Claude (`src/agents/claude.ts`)

- **Detect:** `claude` on PATH, and `claude auth status --json` (worker env) reports `loggedIn: true`, `authMethod: "claude.ai"`, no `apiKeySource` (R16, R24).
- **Billing gate:** `launch()` sets `requireAuth` `{kind: "account"}`, or `{kind: "api_key", detail: "ANTHROPIC_API_KEY"}` on the credit lane. An `apiKeyHelper`, settings `ANTHROPIC_API_KEY` or a managed key outranks the claude.ai login and arrives as `api_key`; a third-party provider as `external`/`gateway` (`hide-claude-auth.js:55–103` as mapped by `auth-status.js:228–268`).
- **Usage, CLI first: `get_usage`, then OAuth** (`readClaude(bin, deps, env)`; CodexBar's Claude Web step, which needs claude.ai cookies, is not adopted). The OAuth step runs only when `get_usage` fails; when both fail, the error is `get_usage`'s plus ` (OAuth: <reason>)`.
  1. **`get_usage`** (`source: "cli"`; the token-free read, R34): spawn `<bin> --output-format stream-json --verbose --input-format stream-json --strict-mcp-config --settings {"disableAllHooks":true}` with `workerEnv()` and cwd = the state dir, and write two lines: `{"type":"control_request","request_id":"i","request":{"subtype":"initialize"}}` and `{"type":"control_request","request_id":"u","request":{"subtype":"get_usage","skip_behaviors":true}}`. Read stdout until the `control_response` whose `response.request_id` is `u`, then end stdin and SIGTERM; 15 s timeout. The reader `readClaudeUsage(bin)` only spawns and collects the parsed stdout messages; the pure `parseClaudeUsage(messages, now)` handles the hooks warning and the answer's status, then maps `rate_limits` through `parseClaudeLimits(limits, warnings, now)`, which the OAuth step shares. No user message is written, so no inference runs. The answer is `SDKControlGetUsageResponse` (claude-agent-sdk 0.3.330 `sdk.d.ts:4621–4720`). `--strict-mcp-config` keeps the user's MCP servers from starting; `disableAllHooks` keeps the user's SessionStart hooks from running (R34 saw them fire without it; R36 saw none with it): any `system`/`hook_started` message adds the warning "Claude usage read ran your hooks".
  - `subtype: "success"` with `rate_limits_available !== true` or `rate_limits: null` → unreadable: "Claude reports no plan limits for this login".
  - No answer, a spawn error, a timeout, or `subtype: "error"` → unreadable with that reason. The method is marked experimental and may be renamed (§18).
  2. **OAuth** (`readClaudeOAuth`, `source: "oauth"`; CodexBar `ClaudeOAuth/*`; runs only when `get_usage` failed). The environment is `{...process.env, ...overlay}`, and the token is read on every check, held in memory only and never written or refreshed. `readClaudeToken` reads `$CLAUDE_CONFIG_DIR/.credentials.json` when that is set and non-empty, else `$HOME/.claude/.credentials.json`; a file token with a future `expiresAt` is used. Otherwise, only on `darwin` and only for the default login (`CLAUDE_CONFIG_DIR` unset or empty), it runs `/usr/bin/security find-generic-password -s "Claude Code-credentials" -w` (absolute path, 1.5 s timeout, trailing newlines stripped); a custom profile never reads the global Keychain item, as in CodexBar. The payload is `{claudeAiOauth: {accessToken, expiresAt (ms), scopes[]}}`. Reasons: no file and no Keychain item, or a payload without `claudeAiOauth` (the MCP-only case): `no Claude OAuth credentials`; `expiresAt` missing or not in the future: `Claude OAuth token expired`; no `user:profile` scope: `Claude OAuth token lacks user:profile`; a token with characters outside printable ASCII: `Claude OAuth token is malformed`; unparseable JSON: `<path or "Claude Keychain entry"> is not valid JSON`, never quoting the text. An expired or due token is never refreshed; `claude` refreshes its own.
     Request: `GET https://api.anthropic.com/api/oauth/usage` with `Authorization: Bearer <token>`, `Accept: application/json`, `anthropic-beta: oauth-2025-04-20` and `User-Agent: claude-cli/<v> (external, cli)`, where `<v>` is the first whitespace token of `<bin> --version` (5 s timeout, cached per bin per process) or `2.1.0` ([Decisions](#decisions)); `credentials: "omit"`, `redirect: "error"`, 30 s timeout. Not sent: CodexBar's `?cedar_ember=1` and its 400/403 retry (reset-for-free credits, unused). A 200 JSON object goes to `parseClaudeLimits`. Reasons: 401 `Claude OAuth request unauthorized`, 429 `Claude OAuth rate limited`, other status `Claude OAuth HTTP <n>`, an unparseable or non-object body `Claude OAuth response was invalid`, a network error its message, and a body with no weekly window `Claude reports no weekly limit`.
- **Pools** (`parseClaudeLimits`, the same for both steps; `utilization` is 0–100 used, `resets_at` ISO; a null window or null utilization is skipped):
  - `claude` {keys: [claude]}: `five_hour` (short, 5 h); `seven_day` (period, 168 h), else `seven_day_oauth_apps`. No period window → unreadable.
  - `claude-opus` {keys: [claude], models: [opus]} from `seven_day_opus`; `claude-sonnet` {keys: [claude], models: [sonnet]} from `seven_day_sonnet`.
  - Each `model_scoped` row (R34: `Fable`) → pool `claude-<name lowercased>` with `keys: [claude]` and `models: [<name lowercased>]` when that is a Claude model value (`haiku|sonnet|opus|fable`); otherwise `models` undefined, so it bounds every Claude lane, plus the warning "unknown Claude model window '<name>'".
  - Each `limits[]` entry with `group: "weekly"`, `kind: "weekly_scoped"`, a numeric `percent` and a `scope.model.display_name` other than `all models` (case-insensitive) → the same scoped pool by lowercase name, one weekly window from `percent` and `resets_at` (CodexBar's `ClaudeScopedWeeklyLimitMapper`); a model already named by `seven_day_opus`, `seven_day_sonnet` or `model_scoped` keeps one pool. Not mapped, as they limit routines or cloud credits rather than Claude Code sessions: `seven_day_routines`, `cowork`, `iguana_necktie`, `cedar_ember`.
  - `extra_usage.is_enabled` → warning "Claude extra usage is on: a task that crosses the limit may bill your card. schmear cancels a task as soon as Claude reports overage, but cannot stop the request in flight." When `used_credits` and `monthly_limit` (cents) are both numbers, it reads "Claude extra usage is on ($<used> of $<limit> this month): a task that crosses the limit may bill your card. …" with the same closing sentences.
  - Claude Code's statusline JSON also carries these windows, but it exists only when the user has a statusline, so it is not used.
- **Launch:** `process.execPath` with claude-agent-acp's `bin["claude-agent-acp"]` from `<dataDir>/adapters/<hash>` (`adapterBin`, §8); no `--hide-claude-auth` ([Decisions](#decisions)). Env `CLAUDE_CODE_EXECUTABLE=<bin>` (R1b). No mode, no sandbox option: the CLI runs with the user's default mode and sandbox settings (R26 argv). Model and effort through config options (values `haiku|sonnet|opus|fable`, effort `low…max`, R33).
- **Quota signal:** `session/prompt` `-32603` with `data.errorKind === "billing_error"`, or `"rate_limit"` with `data.rateLimit.status === "rejected"` → `quota`; a bare `rate_limit` is a transient 429 → `failed` (`result-end.js:9–12`). Live watch: `_claude/rateLimit` with `status === "rejected"`, `isUsingOverage` or `overageInUse` → cancel at once and classify `quota` (`sdk.d.ts:6237–6250`). Not live-triggered.
- **Policy evidence:** claude-agent-acp spawns `CLAUDE_CODE_EXECUTABLE` with `{...process.env}` and the CLI's own auth chain (`claude-cli.js:19–27`, `acp-agent.js:7637–7646`). `--hide-claude-auth` refuses Free/Pro/Max/Team subscription billing (`hide-claude-auth.js:1–9, 105–116`). The Agent SDK overview says: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK." Risk sentence, shown in the Claude consent prompt and in `docs/safety.md`: "Claude workers run your own `claude` binary on your claude.ai login through Anthropic's Agent SDK, without the adapter's `--hide-claude-auth` flag. Anthropic restricts third-party use of subscription logins and may restrict your account or this route."

### 8.2 Codex (`src/agents/codex.ts`)

- **Detect:** `codex` on PATH, `--version` succeeds, and `readCodexUsage` returns `rateLimits.planType` in the ChatGPT subscription set (`free|go|plus|pro|team|business|enterprise|edu`, matching `codex-acp` 2.9.0 `PLAN_DISPLAY_NAMES`, `dist/index.js:49020–49029`); a `planType` outside that set (or missing/null) fails `find()` naming the plan.
- **Usage, CLI first: RPC, then PAT, then OAuth** (`readCodex(bin, deps, env)`; CodexBar's optional web dashboard is not adopted). The PAT step runs when the RPC fails, and the OAuth step only when the PAT step falls through (no PAT, or a 401); any other PAT failure ends the credential steps. When no step produces a reading, the error is the RPC's plus ` (PAT: <reason>; OAuth: <reason>)`, naming only the steps that gave a reason.
  1. **RPC** (`source: "rpc"`; R13): spawn `<bin> -s read-only -a never app-server`; `initialize`, `initialized`, `account/rateLimits/read`; kill after the reply; 15 s timeout. Map `rateLimits.primary`/`.secondary` `{usedPercent, windowDurationMins, resetsAt (epoch s)}`: `windowDurationMins ≤ 1440` → short, else period with `periodHours = windowDurationMins / 60`. The pool comes from `rateLimits` only. Every other `rateLimitsByLimitId` entry (an id other than `rateLimits.limitId`, default `codex`; codex-acp treats them as separately named limits, `dist/index.js:39253–39270`) becomes the warning "Codex reports another limit '<id>'; not used for routing". The reader `readCodexUsage(bin)` spawns and returns the raw result; the pure `parseCodexUsage(raw, now)` maps it. `spendControlReached === true` or a non-null `rateLimitReachedType` → every window `remaining` 0.
  2. **PAT** (`readCodexPAT`, `source: "pat"`; CodexBar `CodexPAT/*`; runs only when the RPC failed). `personal_access_token` (or `personalAccessToken`) in `${CODEX_HOME:-~/.codex}/auth.json`, read per check in memory. No file or no PAT: go to the OAuth step with no reason recorded (a ChatGPT login has none). A token with characters outside printable ASCII: `Codex PAT is invalid`. Calls, each `credentials: "omit"`, `redirect: "error"`, 30 s timeout, with `Authorization: Bearer <pat>`, `Accept: application/json`, `originator: codex_cli_rs` and `User-Agent: codex_cli_rs/<v> (<Mac OS|Linux> <os version>; <arm64|x86_64>)` ([Decisions](#decisions)); `<v>` is the version token of `<bin> --version` without a leading `codex-cli` (cached per bin; omitted, with the `/`, when unknown), and the OS version is `sw_vers -productVersion` on darwin, else `os.release()` up to the first `-`. `GET https://auth.openai.com/api/accounts/v1/user-auth-credential/whoami` gives `chatgpt_account_id`; then `GET https://chatgpt.com/backend-api/wham/usage` with `ChatGPT-Account-Id` from whoami only. The PAT is sent only to those two hosts. Go to the OAuth step: HTTP 401 on either call, `Codex PAT expired or invalid`. Final (the OAuth step does not run): any other status (`Codex whoami API HTTP <n>`, `Codex usage API HTTP <n>`), a network error or an invalid body.
  3. **OAuth** (`readCodexOAuth`, `source: "oauth"`; CodexBar `CodexOAuth/*`; runs only when the RPC failed and the PAT step went on). `tokens.access_token` and `tokens.refresh_token` (camelCase accepted) from the same `auth.json`; the account id is `tokens.account_id`, else `chatgpt_account_id` (top level or under `https://api.openai.com/auth`) in the `id_token` or then the access token's JWT payload. Refresh is due when the access token's JWT `exp` is within 300 s of now, or, with no `exp`, when `last_refresh` is missing or over 8 days old; schmear never refreshes; the CLI refreshes its own on its next run. Reasons that end in the error: no file `no Codex OAuth credentials`; no access or refresh token `no Codex OAuth tokens`; unusable token characters `Codex OAuth token is invalid`; refresh due `Codex OAuth token due for refresh`; HTTP 401 `Codex OAuth token expired or invalid`. Final: `auth.json` that is not valid JSON (`Codex auth.json is not valid JSON`, never quoting the file; also final in step 2), another status (`Codex usage API HTTP <n>`), a network error or an invalid body. `GET https://chatgpt.com/backend-api/wham/usage` with `Authorization: Bearer`, `Accept: application/json`, `User-Agent: schmear/<version>` and `ChatGPT-Account-Id` when known; same options and timeout as step 2.
  - **Wham mapping** (`parseCodexWham(raw, now)`, steps 2 and 3): `rate_limit.primary_window` and `secondary_window` `{used_percent, reset_at (epoch s), limit_window_seconds}` map like the RPC's windows (`limit_window_seconds ≤ 86400` → short, else period with `periodHours = limit_window_seconds / 3600`); a null window is skipped, a malformed one makes the reading unreadable naming it, and no window is `Codex reports no rate-limit window`. Every window's `remaining` is 0 when `spend_control.reached` is true, `rate_limit_reached_type` is non-null, or the individual limit is spent: the first of root `individual_limit`, `rate_limit.individual_limit`, `spend_control.individual_limit` (camelCase accepted) with `limit > 0` and `remaining_percent` (else `100 − used/limit × 100`) at or below 0. Each `additional_rate_limits[]` entry adds "Codex reports another limit '<limit_name or metered_feature>'; not used for routing". `credits {has_credits, unlimited, balance}` feeds the spend guard below.
- **Pool:** `codex` {keys: [codex]}.
- **Spend guard:** Codex credits pay past the plan limit. `codexCreditsOn(rateLimits.credits)`: `hasCredits` or `unlimited` true → the reading gets `error: "codex credits can pay past your plan limit (balance <balance>)"` (or `(unlimited)`), so the router never routes Codex while it holds credits; `{hasCredits: false, unlimited: false}` (read live 2026-11-22) or a missing `credits` passes.
- **Launch:** `process.execPath` with codex-acp's `bin["codex-acp"]` from `<dataDir>/adapters/<hash>`; env `CODEX_PATH=<bin>` (R2b). `config.mode` = `codexMode()` of `config/read {cwd}` from `<bin> app-server` (called as `docs/probes/codex_mcp_names.py` does; values at `result.config.*`; 15 s timeout), mapping `(sandbox_mode ?? "workspace-write", approval_policy ?? "on-request", approvals_reviewer ?? "user")`, because codex-acp otherwise starts every session in `agent` mode (`index.js:43383–43395`, R27). A triple no mode has fails the task naming it, `${CODEX_HOME:-~/.codex}/config.toml`, and `sandbox_mode`, `approval_policy`, `approvals_reviewer` and `default_permissions`; a set `default_permissions` leaves `mode` unset.

  | sandbox_mode, approval_policy, approvals_reviewer | codex-acp mode (`index.js:43254–43307`) |
  |---|---|
  | `read-only`, `on-request`, `user` | `read-only` |
  | `workspace-write`, `on-request`, `user` | `workspace-write` |
  | `workspace-write`, `on-request`, `auto_review` | `agent` |
  | `danger-full-access`, `never`, `user` | `agent-full-access` |

  Model and effort through config options (`reasoning_effort` category `thought_level`; `ultra` is never used, R33). The model list depends on the user's codex version; §10 step 5 handles a missing model or effort.
- **Quota signal:** `-32603` with `data.codexErrorInfo === "usageLimitExceeded"` → `quota`; `rateLimitExceeded` → `failed` (`index.js:40781–40784`). Not live-triggered.

### 8.3 Grok (`src/agents/grok.ts`)

- **Detect:** `grok` on PATH, and `initialize` on `grok agent stdio` succeeds.
- **Usage** (CodexBar's pipeline exactly, [Decisions](#decisions); [CodexBar `docs/grok.md`](https://github.com/steipete/CodexBar/blob/94cc400e1b190f444e2a4d1910c2d63cfbb47e9f/docs/grok.md) lines 20, 34–125, 153–161, 176–186). `readGrokUsage(bin, deps)` runs the steps below with the token reader and HTTP injected as `deps`; the pure `parseGrokCredits(json, now)` (shared by ACP and the CLI proxy) and `parseGrokProto(bytes, now)` map the answers. The usage text names the step that produced the reading (`acp`, `grok.com`, `cli-proxy`).
  1. **ACP** (token-free): spawn `<bin> --no-auto-update agent stdio`, `initialize`, `_x.ai/billing {}`. `parseGrokCredits`: `config.creditUsagePercent`, else `onDemandUsed.val / onDemandCap.val × 100` when the cap is above 0 (CodexBar's CLI-proxy rule), gives one period window `remaining = 1 − p/100`; reset and duration from `config.currentPeriod.{start,end}` when `currentPeriod.end` is present, else `billingPeriodStart/End`; missing, invalid, reversed or future start → unreadable "Grok billing period unknown". A parseable period without either value is unknown usage: go to step 2 (R14 is this case).
  2. **grok.com retry** (only for unknown usage): the token is `key` of the `${GROK_HOME:-~/.grok}/auth.json` entry under `https://auth.x.ai::<client-id>`, else `https://accounts.x.ai/sign-in`, read in memory per check; missing or past `expires_at` → unreadable without the call. POST the gRPC-web frame `00 00 00 00 02 08 00` (`GetGrokCreditsConfigRequest{exclude_legacy_monthly_usage: false}`) to `https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig` with `Authorization: Bearer <token>`, `Content-Type: application/grpc-web+proto`, `X-Grpc-Web: 1`, no cookies, a 6 s budget. Accept gRPC-web frames (flag byte `0x00` data, `0x80` trailers, 4-byte big-endian length) or a raw protobuf body; an HTTP error or non-zero `grpc-status` → unreadable. `parseGrokProto` decodes only the schema-declared messages, field numbers from the grok.com billing descriptor (`cdn.grok.com/_next/static/chunks/32g78bk5hhe1q.js`, read 2026-11-21): `GetGrokCreditsConfigResponse` 1 `config`; `GrokCreditsConfig` 1 `credit_usage_percent` (float), 7 `product_usage` (repeated `ProductUsage` {2 `usage_percent` float}), 8 `current_period` (`UsagePeriod` {1 `type` enum: 1 MONTHLY, 2 WEEKLY; 2 `start`, 3 `end` Timestamp {1 seconds}}); other length-delimited fields are skipped as opaque. Field number 0, an unknown wire type, truncation or a varint over 10 bytes makes the response incomplete. Adopt only a wire `credit_usage_percent`, or an implicit zero (`remaining = 1`) from a complete response with a WEEKLY or MONTHLY `current_period` containing now and no percentage field anywhere. The ACP (or proxy) period and plan stay authoritative for reset and duration. Otherwise unreadable: "Grok reports no usage percent".
  3. **ACP `-32601` (method not found)** (other ACP errors, spawn errors and timeouts are failures): the CLI proxy `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits` with the same token rules, `Authorization: Bearer <token>`, `x-xai-token-auth: xai-grok-cli`, `Accept: application/json`, parsed by `parseGrokCredits`; unknown usage → step 2; a proxy failure → unreadable.
  - The token is never written, refreshed, logged or sent anywhere else ([Decisions](#decisions)).
- **Pool:** `grok` {keys: [grok]}. Prepaid balance and on-demand spend can pay past the limit (R14); the spend guard below skips Grok while either is on.
- **Spend guard** (schmear's, not part of CodexBar's read; the window is unchanged): `grokSpendOn(billing)` reads `config.onDemandCap.val` and `config.prepaidBalance.val` (USD cents, `{}` = 0; [CodexBar `docs/grok.md`](https://github.com/steipete/CodexBar/blob/94cc400e1b190f444e2a4d1910c2d63cfbb47e9f/docs/grok.md) lines 210, 377–379). Either above 0 → the reading gets `error: "grok on-demand or prepaid spend is on (on-demand cap $X, prepaid balance $Y)"` (the non-zero ones), so `usage` shows it `skipped` and the router never routes Grok, whatever `overageOff` says.
- **Launch:** `<bin> --no-auto-update agent stdio`. No mode option exists (R3). Env `GROK_CONFIG={"models":{"default":"<model>","default_reasoning_effort":"<effort>"}}` (`~/.grok/docs/user-guide/05-configuration.md:30–33`), since Grok has no effort config option (R33), and `config.model` only. Checked live: the tiers test passed for Grok (R41).
- **MCP:** Grok loads the user's MCP servers and calls them through `search_tool`/`use_tool` without a permission request (R23).
- **Quota signal (assumption):** an error message matching `/usage limit|rate.?limit|quota|credits?/i` → `quota` (R17 strings).

### 8.4 Antigravity (`src/agents/agy.ts`)

Google consumer Gemini runs through Antigravity: Google shut off Gemini CLI OAuth for individual, AI Pro and Ultra accounts on 2026-06-18.

- **Detect:** `agy` on PATH.
- **Usage, CLI first: `agy -p /usage`, then the app server for `@default`** (`readAgy(bin, deps, env)`; CodexBar's IDE language-server and Google OAuth steps are not adopted: the IDE reply has no weekly windows, and OAuth needs a client secret extracted from the app, the pattern `docs/safety.md` cites accounts lost over). The app step runs only when the print read fails, and not for an account whose overlay sets `HOME` (the app is signed in under the real `HOME`). When both fail, the error is the print read's plus ` (app: <reason>)`.
  1. **`agy -p /usage`** (`source: "cli"`; R12; [CodexBar `docs/antigravity.md`](https://github.com/steipete/CodexBar/blob/e6edfb87d5bcdcd942de8b11d111d6c132ee392e/docs/antigravity.md) lines 55–67, 93): `readAgyUsage(bin)` checks `AGY_CLI_DISABLE_AUTO_UPDATE=true <bin> --version` (3 s timeout) for agy ≥ 1.1.11 (below that fails naming the version without calling `/usage`), installs failing `open` and `xdg-open` launchers in a private temp dir, prepends that dir to `PATH`, sets `BROWSER` to the failing launcher (failing before start if setup fails), runs `AGY_CLI_DISABLE_AUTO_UPDATE=true <bin> -p /usage --output-format json` in that dir (90 s timeout, 1 MiB output limit), and removes the dir after the subprocess exits. The pure `parseAgyUsage(raw, now)` requires `status === "SUCCESS"` and `num_turns === 0`, then passes `command.data.groups` to `parseAgyGroups(groups, warnings, now)`, shared with the app step: `groups[].buckets[] {window: "weekly"|"5h", remaining_fraction, reset_time, disabled?}`, where the group name is `displayName` or `name`, the fraction is `remainingFraction`, `remaining_fraction` or `remaining.remainingFraction`, and the reset is `resetTime` or `reset_time` as an ISO string or epoch seconds (the app server answers in camelCase); disabled buckets skipped; `weekly` → period 168 h, `5h` → short 5 h.
  2. **App server** (`readAgyApp`, `source: "app"`; CodexBar `AntigravityStatusProbe`; `@default` only, runs only when the print read failed). `ps -ax -o pid=,command=` keeps a lowercased line that matches `(^|/)language[_-]server([_-][a-z0-9]+)*(\s|$)`, has an Antigravity marker (`--app_data_dir` with `antigravity`, `antigravity.app/`, `/gemini.app/` or `/antigravity/`), none of the IDE markers (`antigravity ide.app/`, `--app_data_dir antigravity-ide`, `/extensions/antigravity/bin/language_server`) and a `--csrf_token` value. `lsof -nP -iTCP -sTCP:LISTEN -a -p <pid>` lists its ports (3 s timeouts). For each port, `POST https://127.0.0.1:<port>/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary` through `node:https` with certificate checking off (loopback only), `Content-Type: application/json`, `Connect-Protocol-Version: 1`, `X-Codeium-Csrf-Token: <token>` and body `{"metadata":{"ideName":"antigravity","extensionName":"antigravity","ideVersion":"unknown","locale":"en"}}`, 5 s per request. The first 200 reply that yields a pool wins; the payload is its `response`, `summary` or root `groups`, and a non-zero `code` is an error. Reasons it can give: `no Antigravity app server` (no process or no `ps`), `Antigravity app server unreachable` (no port or a failed request), `Antigravity app server HTTP <n>`, `... response is not JSON`, `... response is malformed`, `... code <c>`, `... response has no groups`, or the group parse error. The CSRF token never appears in a reading, warning or error. Not built: `GetUnleashData`, the `GetUserStatus` and `GetCommandModelConfigs` fallbacks, the `extension_server_port` retry, Linux `/proc` port discovery. On Linux the step needs `lsof`; without it agy falls through.
- **Pools** (group → pool; model-tiers.md §2):

  | agy group | Pool | keys |
  |---|---|---|
  | `Gemini Models` | `agy-gemini` | `[agy-gemini, agy-argon]` (Argon draws on both) |
  | `Gemini 4 Argon` | `agy-argon` | `[agy-argon]` |
  | `Claude and GPT models` | `agy-3p` | `[agy-3p]` |

  Unknown groups become a warning. Antigravity can continue on paid AI credits after a limit and schmear cannot read that setting (R10), and neither the app server nor CodexBar reads it; schmear assumes it is off (user ruling, 2026-11-22).
- **Launch:** `<bin> acp`, env `AGY_CLI_DISABLE_AUTO_UPDATE=true`, no mode, no `--sandbox`. Model and effort through config options (`thought_level`). The registry's `agy-acp-server` fails auth (R4b).
- **Quota signal (assumption):** an error message matching `/quota|limit reached|exhausted|RESOURCE_EXHAUSTED|\b429\b/i` → `quota`.

## 9. Tiers and router

### 9.1 Tier list (`src/tiers.ts`)

- `DEFAULT_TIERS: string[][]` is the default list; its ratings, sources and rule are `docs/research/model-tiers.md` §3. A tier is a list of `lane:model@effort` entries; index 0 is tier 1, the weakest. The default has four tiers (Haiku, Sonnet, Opus and Fable at reference effort `medium`), each lane's entry chosen by one rule on AA and Epoch scores with no per-lane overrides (model-tiers.md §3). Assumptions accepted as stated there: the Codex entries at `max` effort and the GPT-6.x effort sets, and Grok's effort set at launch through `GROK_CONFIG`.
- `parseTiers(raw: unknown): TierList` throws one of these messages (`<t>` is 1-based):
  - not an array, empty, a tier not an array, a non-string entry → `tiers must be a non-empty list of tiers, each a non-empty list of "key:model@effort" strings`
  - `tier <t> is empty`
  - `tier <t> entry "<e>": expected "key:model@effort"` (the entry must match `/^([^:@\s]+):([^@\s]+)@([^@\s]+)$/`)
  - `tier <t> entry "<e>": unknown lane key "<k>" (one of claude, codex, grok, agy-gemini, agy-argon, agy-3p, claude-credits)`
  - `tier <t> entry "<e>": <key>:<model> is listed twice in this tier`

  The same `key:model` in different tiers is allowed (the default does it).
- `candidates(tier: number, tiers: TierList, offered: Offered, account: string): Lane[]`: for `t` = the task's tier … N, each tier's entries in list order; per `key:model` only its lowest `t`; a model absent from `offered[keyId(key, account)]`, when that list is known (§11: younger than 24 h), is dropped. Key → agent: `agy-*` → `agy`, else the key. The returned order is: exact tier first, then each higher tier, list order within a tier. The tier is a floor: no candidate has `tier` below the task's. A lane is `{id: "<keyId>:<model>", agent, account?, key, tier: t, model, effort}`. Tier entries never name an account: one entry applies to every account of its agent.
- **Config** (`~/.config/schmear/config.json`) gains two optional top-level fields, both kept by `init` (which rebuilds only `agents`):
  - `tiers: string[][]` replaces `DEFAULT_TIERS` whole: no merge, one representation, and the default is itself a config value. Entry `"<lane key>:<model>@<effort>"`; lane keys `claude`, `codex`, `grok`, `agy-gemini`, `agy-argon`, `agy-3p`, `claude-credits`; model and effort are the provider's own option values. A credit pool spends only through `claude-credits:` entries.
  - `reserve: { [agent]: number }`: the fraction of each period window held back on that agent's pools while it is the driver, waived in the last 2 h before reset. Default 0.05; the 2% floor still holds (§9.2).

  ```json
  {
    "version": 1,
    "agents": { "claude@default": { "consent": true, "path": "/usr/local/bin/claude" } },
    "tiers": [
      ["claude:sonnet@low", "codex:gpt-6.1-terra@medium", "agy-gemini:gemini-4-hydrogen@medium"],
      ["claude:opus@high", "agy-3p:claude-opus-5-5@high", "agy-gemini:gemini-4-neon@high"]
    ],
    "reserve": { "claude": 0.1 }
  }
  ```

  `readConfig` validates both as part of `ConfigSchema` (§11) and throws `malformed config <path>: <message>`: `tiers` through `parseTiers`; `reserve` must be an object whose keys are agent ids (`reserve: unknown agent "<id>"`) and whose values are finite with `0 ≤ r < 1` (`reserve.<id> must be a fraction from 0 to 1, e.g. 0.05 for 5%`). A bad config is never replaced by the default: `serve` refuses to start, and `delegate`, `usage` and `init` report the error (§12).

### 9.2 Router (`src/router.ts`, pure)

Constants, not configurable: `FLOOR` 0.02, `WAIVER_H` 2, `TIE` 0.05, `MIN_H` 0.1. `RESERVE` 0.05 is the default of `Config.reserve`. `DEFAULT_MAX_PER_POOL` 10 is the default of `Config.maxPerPool`. They generalize a weekly-only rule (pace = usable × 168 / hours to reset; the highest pace wins; a 5% tie band; a 5% Claude reserve waived in the last 2 h before reset) to any window, and from a Claude-only reserve to the driver's agent. `route()` does not know about tiers: each task arrives with its candidate lanes.

```ts
export function route(input: {
  now: number; driver: AgentId | null; readings: UsageReading[]; config: Config;
  exclude: Set<string>;
  running: string[];   // one lane id per task already holding a lane: this process's claims, then other processes' live rows
  tasks: Lane[][];
}): { assignments: (Lane | "wait" | null)[]; pools: PoolRow[] }
// PoolRow: { id, agent, pace: number | null, status: "ok" | `out: ${string}` | `skipped: ${string}` }
```

1. **Normalize.** A window with `resetsAt ≤ now` is `remaining 1, resetsAt null`, except on a credit pool (`pool.keys.some(isCreditKey)`), where `resetsAt ≤ now` marks the pool `out: credits expired` until the next balance read. `hoursLeft = resetsAt ? (resetsAt − now)/3.6e6 : periodHours`.
2. **Threshold.** `max(config.reserve?.[pool.agent] ?? RESERVE, FLOOR)` when the window is `period`, the pool's agent is the driver's and its account is `default` (schmear cannot see which login the driver uses), the pool is not a credit pool, and `hoursLeft > WAIVER_H`; else `FLOOR`. The floor applies to short windows too.
3. **Pool out** when any window has `remaining − threshold ≤ 0`, or when it has no window.
4. **Pool pace** = min over `period` windows (all windows when none) of `(remaining − threshold) × periodHours / max(hoursLeft, MIN_H)`. A weekly pool gives `usable × 168 / hours_left`.
5. **Candidates** come in per task: a fresh task gets `candidates(tier, tiers, offered)` limited to routable agents and its `agents` allowlist (§10), a resumed task its handle's one lane. Eligible: the lane's instance (`instanceId(agent, account)`) has `consent` and a reading without error; a candidate's pools are the pools of its agent and account whose `keys` include its key and whose `models` is undefined or includes its model; its own pool (the pool whose id is `keyId(key, account)`) is among them, none is out, and neither its id nor its key is in `exclude`. A lane whose own pool has no reading is out. Lane pace = min pool pace.
6. **Cap.** `cap = config.maxPerPool ?? DEFAULT_MAX_PER_POOL`. Each pool's count starts at the number of `running` lane ids (`<key>@<account>:<model>`) that draw on it by the step 5 rule; an id that matches no usable pool counts nowhere. An eligible lane is full when any of its pools has count ≥ cap.
7. **Pick and split.** Per task, in order: drop full lanes; `best` = highest pace among the rest; band = those with `pace ≥ best × (1 − TIE)`. Sort the band by load ascending, then tier ascending (so the exact tier wins, and a tier-1 task never reaches Fable while Sonnet is in the band), then lanes not on the driver's `@default` (the driver also spends its own pool), then pace descending, then id; the first is the pick. First, when the band holds a lane that draws on no undated credit pool (a credit pool whose window has `resetsAt: null`), band lanes that do are removed: undated credits never outrank a subscription lane, and pace is unchanged. The pick adds 1 to the count of each of its pools. A lane's load is the highest count on any one of its pools, so a batch spreads over every band lane, lanes that share a pool count together, tasks running elsewhere count as load, and a lane outside the band gets a task only when every band lane is full. A single task with nothing running is unchanged (all loads 0).
8. No eligible candidate → `null` (`no_quota`); eligible candidates that are all full → `"wait"` (§10 step 4).

Required table-driven tests: a weekly pool gives `usable × 168 / hours_left`; the reserve applies only to the driver's pools and is waived at `hoursLeft ≤ 2`; `reserve.claude: 0.2` outs a 15% Claude pool when Claude drives and not when Codex drives; `reserve.claude: 0` leaves the floor; the floor holds in the waiver window; a 5 h window at 2% outs the pool; a 30-day window (R13 shape); `seven_day_opus` at 0 outs `claude:opus` but not `claude:sonnet`; an unknown-model Claude window bounds every Claude lane; agy-argon takes the minimum of two pools; a tier-2 task never gets a tier-1 lane, and in the band the exact tier beats a higher tier with more pace; the driver's lane sorts after another provider's in the band; missing consent or `overageOff`, error readings and `exclude` remove lanes; an empty candidate list gives `null`; a batch of 3 over 3 disjoint-pool band lanes gets 3 distinct lanes; a lane at pace < best × 0.95 gets no batch task; with `claude:haiku` and `claude:sonnet` (one pool) and `grok:grok-4.7` all in the band, a batch of 3 gets haiku, grok, haiku; two tier-1 tasks when the Claude pool leads never split onto another Claude model; tasks at different tiers alternate across disjoint pools in the band; windows built with `window(98, …)` (floor) and `window(95, …)` (driver reserve) are out; an agy-argon lane is not eligible when the reading has no `agy-argon` pool; a lane whose pool holds `maxPerPool` running tasks is full and the task takes an eligible lane outside the band; a batch of 3 over one lane at `maxPerPool` 2 gets the lane twice, then `"wait"`; lanes sharing a pool count together toward the cap; no eligible lane gives `null`, not `"wait"`; a running task elsewhere counts as band load; running ids with no usable pool change nothing.

## 10. Delegate flow (`src/delegate.ts`)

`delegate(input: DelegateInput, ctx: { driver: AgentId | null; signal: AbortSignal; ask?: Ask }, adapters): Promise<TaskResult[]>`

1. **Routing setup, then validate.** `loadRouting` reads the config (a malformed one throws `malformed config <path>: …`, §9.1), builds the tier list with `parseTiers(config.tiers ?? DEFAULT_TIERS)` and reads the offered file of every key in the list whose agent is routable; it reads no usage. Then validate (any failure is a tool error naming the task index): 1 to `maxTasks` tasks (the server's schema, §12); `prompt` non-empty; `cwd` absolute and `fs.stat` says directory; `tier` an integer from 1 to N, else `tasks[i]: tier must be an integer from 1 to <N>`; `description` one line ≤ 80 chars (default per §6); `agents` non-empty, each an agent id with an adapter, else `tasks[i]: unknown agent: <x>`; `session` decodes, and a task's `tier` is at most the handle's, else `tasks[i]: session ran tier N; tier M needs a new session`; a `session` already given by an earlier task of the call, else `tasks[j]: session already resumed by tasks[i]` (two workers would resume one transcript at once).
   A handle is signed: `<base64url JSON>.<base64url HMAC-SHA256>` under a per-install 32-byte key in `S/secret` (hex, mode 0600, written atomically on first use). Decoding checks the HMAC with `timingSafeEqual` before parsing, then the fields with a zod schema; any failure is `tasks[i]: session is not a handle from an earlier result`. Why: the handle carries the cost a resumed credit run settles against (§13) and the lane it resumes, so an edited one could settle $0 or run a model outside the tier list. A handle from another install, or from before its key was replaced, is rejected the same way.
2. **Readings.** Only for the distinct instances of all tasks' candidate lanes, in parallel, `state.usage(instance, () => adapter.readUsage(path, envOf(instance)), USAGE_ROUTE_MS)`, where `envOf` is `{}` for `default` and `{[adapter.home.env]: home}` for any other account; every reading gets `account` set and each pool id suffixed `@<account>`: a reading younger than 5 min (a failed one, 60 s) is served from the cache (§11).
3. **Lane.** The fresh tasks go to one `route()` call (the batch split) with an empty `exclude`, each with `candidates(task.tier, tiers, offered, account)` for every routable instance (a consented `Config.agents` key whose agent has an adapter), limited to that instance's agent and the task's `agents` allowlist. A task with `session` routes alone with one candidate, the handle's `(account, key, model, effort)` at the handle's tier, recomputed on every call so a list edit never re-rates a handle; if that lane is out → `no_quota`. Every reroute recomputes the task's candidates, so a newly written offered list applies. The task's `cwd` must equal the handle's after `path.resolve` (a session is found per directory), else tool error `tasks[i]: a resumed task runs in its session's cwd <handle cwd>`. Every `route()` call gets `running`: the lane id of each task this process holds (across its concurrent calls), then `otherRunningLanes()` (§11); the call reads both, routes and claims each assigned lane with no `await` in between, and a task releases its claim before any reroute and when its run ends. A failed task-log read counts no other process and adds the note `task log read failed: <message>`.
4. **Run, per task concurrently.** `"wait"` → the task waits until this process releases a claim, `SLOT_POLL_MS` (2 s) passes, or the call is cancelled; it then reads its candidates' instances by step 2's rule and routes again. Leaving the wait adds the note `waited <s> s for a free slot (maxPerPool <n>)`; cancel while waiting → `cancelled` with error `cancelled while waiting for a free slot`. No lock: processes routing between another's claim and its `running` line can overshoot the cap by the tasks routed in that window. `null` → `no_quota` with the §9.2 pool summary in `error`. Else `adapter.launch(lane, task.cwd, bin, envOf(instance))` (bin: the instance's `Config.agents` path), then `runWorker(spec, task.cwd, task.prompt, {agent, signal: ctx.signal, permit: (req, turn) => permit(req, turn, {who, ask: ctx.ask, note}), onRateLimit})`.
5. **Offered models and model or effort not offered.** After every `runWorker` that returns `WorkerRun.offered` (the session's `model` option values), write them to `S/offered/<key id>.json` (the lane's key id, so `claude-credits` never hides a model from `claude`, nor one account from another) and use them for later candidates; a failed write adds the note "<lane key> offered list write failed: <message>" and the run's result stands. On `failure.notOffered` add the lane id to `exclude` and re-route, with the note "<model>[ at <effort>] not offered by <agent>; ran <lane id>"; a missing effort drops only that lane for this call. No candidate left → `no_quota`, with the error `no lane for tier <t>; pools: …`.
6. **Quota outcome** (`classifyFailure` → `quota`; or the overage watch fired, i.e. `onRateLimit` saw `adapter.quotaRateLimit?.(rateLimit)` (an optional member only Claude implements) and cancelled): add the lane id to the call's `exclude`; re-read the lane's instance's usage with `maxAgeMs` 0, which also refreshes the shared cache; re-route this task with the note "rerouted from <lane id>: quota". `failure.auth` set: the auth belongs to the account, so add the lane's key id to `exclude` and re-route with the note "rerouted from <lane id>: would bill <failure.auth>", without touching the reading. No lane left → `no_quota`. Classifiers match `message` and structured fields, never `stderr`: a quota misread as a failure returns `failed`, which the driver can retry, while a failure misread as quota re-runs the prompt in the same cwd.
7. **Other outcomes.** `ctx.signal` aborted → `cancelled`. Else `done` only for `end_turn`; any other stop reason → `failed` with note "worker stopped: <stopReason>"; a failure → `failed` with `error` = the message plus the last 20 stderr lines, at most 2,048 characters (over that, the first 1,024 and last 1,023 around `…`). A throw anywhere in one task's run makes that task `failed` with the error message and its notes so far; the batch's other tasks still return. Results carry `provider`, `account`, `WorkerRun.model`, `WorkerRun.effort` and `costUsd`.
8. **Output cap.** The whole result text is at most 60,000 chars (Claude Code's default MCP output limit is 25,000 tokens). When it would be longer, each task's status, provider, account, model, effort, session and cost are kept, and the budget left over is shared equally across every task's notes, error and reply, shorter strings keeping their full length and over-long ones keeping their first and last halves around `[… N chars omitted …]`.
9. **Cancel.** The host's `notifications/cancelled` aborts `ctx.signal`; every running worker is cancelled (§7 step 7).

## 11. Shared state (`src/state.ts`, ledger in `src/credit.ts`)

`S = ${XDG_STATE_HOME:-~/.local/state}/schmear`, `C = ${XDG_CONFIG_HOME:-~/.config}/schmear/config.json`. Every write is atomic (`<file>.<pid>.<8 hex>.tmp`, then `rename`); JSONL appends use `O_APPEND`, one `write` per line. schmear creates its own directories with mode 0700 and its own files (S, C) with 0600, since they hold `keyCommand`, binary paths, quota levels and ledger spend; a rewritten host config keeps its existing mode.

`readConfig()` parses C with one zod `ConfigSchema` (`Config` is its `z.infer`): `version` the literal 1; `agents` keyed by instance id `<agent>@<account>` (account name matching `/^[a-z0-9][a-z0-9-]{0,31}$/`; anything else is an error naming the key; a bare agent key from a 0.1.x config is read as `<agent>@default`, and holding both is an error), each `{consent: boolean, path: non-empty string, home?: absolute path}`, `home` forbidden for `default` and required for any other account (other keys, such as an old `overageOff`, are dropped); `tiers` checked by `parseTiers` (§9.1) and `reserve` as a record of agent ids to fractions in [0, 1), both with their own messages; `maxTasks` and `maxPerPool` whole numbers of at least 1; `credits` checked only as an object (its fields are checked per read, §13, so an invalid pool skips only its lane); any other top-level key is rejected, so a typo is never silently ignored. A missing C reads as `{version: 1, agents: {}}`; any failure throws `malformed config <C>: <first issue path>: <message>` (no path for `tiers` and `reserve` messages, which name their field).

| Path | Content | Rule |
|---|---|---|
| `S/usage/<id>.json` | last `UsageReading`, error readings included (subscriptions by `<agent>@<account>`, credit providers by `<creditKey>` with `balances`) | `usage(id, read, maxAgeMs)` serves it when younger than `maxAgeMs`, else reads and caches (error readings too): 5 min for routing (`USAGE_ROUTE_MS`), 60 s for `usage` and `init` (`USAGE_SHOW_MS`), and never more than 60 s for a failed reading; a quota outcome rereads with 0, which also hands other processes the fresh reading; duplicate refreshes are harmless |
| `S/offered/<key id>.json` | `{fetchedAt, models: string[]}` from the last run's `model` option values | written after every run from `WorkerRun.offered` (§10 step 5); `candidates()` drops models absent from it; a list older than 24 h is ignored |
| `S/tasks.jsonl` | `TaskLine`: `{at, id, pid, driver, description, tier, cwd, lane, effort?, status, costUsd?}`, the task's full state at `at` | appended by `delegate` (§10) like the ledger (`O_APPEND`, one `write` per line, no lock): a `running` line before each worker run (a reroute adds one with the new lane), one final line with the result's status and cost; never the prompt or reply. Before each append, a log of 1 MiB (`1 << 20`) or more is renamed to `tasks.jsonl.1`, replacing any old one; no lock, so two appends racing at the boundary can lose the newest lines, accepted. `readTasks(sinceMs)` reads `tasks.jsonl` first, then `tasks.jsonl.1` if present, and merges `.1`'s lines before the current file's (a rotation between the two reads repeats lines, which the last-line merge absorbs, instead of losing the file), keeps the last line per `id` (the first gives `startedAt`, a non-`running` last gives `endedAt`), turns a `running` row into `lost` unless its last line's `pid` is a live process that started at or before that line's `at` + 1 s (start time = `now` − `ps -o etime= -p <pid>` with `LC_ALL=C`, `now` taken before `ps` runs; a non-zero exit or empty output is dead), keeps rows last written at or after `sinceMs` plus every still-`running` one, newest `startedAt` first; skips a trailing partial line per file and throws `task log <file> line <n>: <why>` on a complete bad one. A failed append is a task note, never a task failure. `otherRunningLanes()` returns the `lane` of every task whose last line is `running` with a lane and a live `pid` other than this process's, by the same rule, for the pool cap (§9.2); `ps` runs once per pid per read. |
| `S/secret` | 32 random bytes as hex: the key that signs session handles (§10) | created on first use, mode 0600, by exclusive link so concurrent processes agree on one key; never rewritten |
| `S/ledger/<pool id>.jsonl` | `{at, kind: "balance", usd, floorUsd}` \| `{at, taskId, kind: "reserve" \| "settle" \| "exhausted", usd}` | append-only, no lock: `O_APPEND` gives every process the same line order, and the replay (§13) judges each line only by the lines before it; readers skip a trailing partial line and throw `ledger line <n>: <field>` on a complete one that is not JSON or fails the zod discriminated-union schema (`at` finite; `balance`: `usd` finite, `floorUsd` finite ≥ 0; `reserve`/`settle`/`exhausted`: `taskId` non-empty string, `usd` finite ≥ 0; `not an object` for a non-object) |
| `${XDG_CONFIG_HOME:-~/.config}/schmear/console-sessions.json` | `Record<label, CookieHeader>` | written atomically (mode 0600, dir 0700) only by `schmear credits login claude --stdin` and updated by `schmear credits logout <label>`; deleted with the config dir by `uninstall`; read on each Console balance read, kept in memory, never logged, printed, or sent anywhere but `platform.claude.com` |

**Accounts.** Every subscription is an account `<agent>@<name>`: the login the CLI already has (the inherited environment, unchanged) is `default`, and each added one is a second login selected by one variable (`AgentAdapter.home.env`) pointing at its own directory: Claude `CLAUDE_CONFIG_DIR`, Codex `CODEX_HOME`, Grok `GROK_HOME`, Antigravity `HOME` (agy has no config-dir variable). Each account has its own reading, pools (`claude-fable@work`), lanes (`claude@work:claude-opus-5-5`), offered lists and session handles, so the router weighs it by pace with no new rule. Accounts are added in `init` (§12).

Why 5 min for routing: 5 minutes is under 2% of a 5-hour window and 0.05% of a week, and a stale reading that is wrong self-corrects: the floor and each vendor's overage-off refusal bound the run, and a quota outcome rereads. A failed reading keeps its agent out of routing, so nothing would reread it: it is served 60 s at most. A background refresh was rejected: it would leave `agy -p /usage` children running past the server's exit (§14 "Children are killed on every exit path").

## 12. MCP server and host registration

`src/server.ts`:

- `createServer(adapters): Promise<McpServer>` reads the config once at start and builds the tier list with `parseTiers(config.tiers ?? DEFAULT_TIERS)`; an invalid config rejects, so `serve` exits 1 with `schmear: malformed config …`. The schema and description are fixed for the process; routing re-reads the config on every call, so a list edited after start applies to routing, validation and `usage` at once (a tier above a shrunk list's N is refused), and the description and the schema's bound refresh when the host restarts schmear. `serve` connects it to `StdioServerTransport`; tests use `InMemoryTransport.createLinkedPair()` with adapters whose `launch()` runs `test/fake-agent.ts`. `registerTool(name, {title, description, inputSchema, annotations}, cb)`.
- **Driver:** `server.server.getClientVersion()?.name` through each adapter's `isClient`: exact `claude-code`, `codex-mcp-client`, `antigravity-client`; prefix `grok-shell-` (R8). Unknown → `null`, no reserve.
- **Worker mode:** `SCHMEAR_WORKER === "1"` → `delegate` is not registered.
- **Permission prompts:** when `getClientCapabilities()?.elicitation?.form` is set (a bare `elicitation: {}` reads as form; all four hosts declare it, R31), `ask` = `elicitInput({mode: "form", message, requestedSchema: {type: "object", required: ["option"], properties: {option: {type: "string", title: "Permission", enum: <optionIds>, enumNames: <names>}}}}, {signal, timeout: 86_400_000})`, returning `content.option` on `accept`, else undefined. The timeout matches init's host timeouts; the SDK default of 60 s would reject a prompt the user is still reading.
- **Protocol revision:** schmear speaks MCP 2025-11-25 through `@modelcontextprotocol/sdk` 1.x, which answers `server/discover` with `-32601`; a host that tries 2026-07-28 first (Claude Code since 2.1.292) then falls back to `initialize` (R8, R31), which is what carries `clientInfo` and lets a call send `elicitation/create` mid-call. The move to 2026-07-28 waits for its §18 trigger; the design is `docs/research/mcp-2026-07-28.md`.
- **`delegate`:** input schema is the zod form of `DelegateInput` (`tasks.min(1).max(config.maxTasks ?? DEFAULT_MAX_TASKS)`, read once when the server starts, `tier` an integer from 1 to N for the list's N, `agents` an optional non-empty array of agent ids (`claude`, `codex`, `grok`, `agy`); a lane matches when its agent is listed, so the subscription stays schmear's pick). There is no `effort` field; a driver that still sends one has it stripped by zod and the task routes by tier. Annotations `{readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true}`. Result: one plain-text block; per task a `## <description>` line, then `key: value` lines for `status`, `provider`, `account`, `model`, `effort`, `session`, `cost`, `notes`, `error` (only those set), a blank line, then the reply.
- **Description** (load-bearing; `delegateDescription(tiers)` builds it from the effective list):
  "Hand self-contained coding subtasks to other AI coding agents running on the user's subscriptions; schmear picks the agent whose quota is most at risk of expiring unused. Tasks in one call run in parallel. Each task runs in the cwd you give it, and tasks given the same cwd share that directory: isolate tasks that could conflict yourself, for example in separate git worktrees. The prompt is sent verbatim; the worker sees nothing else from you. tier is the minimum model strength, from 1 (weakest) to <N>: a task runs on a model of its tier or a stronger one, so give harder work, or work that needs more thinking, a higher tier. Models by tier: 1 <m>, <m>; 2 <m>; …; <N> <m>. Pass a result's session to continue that subagent: for follow-up work on the same task, continue it instead of starting a new task, which starts with none of that context. agents limits a task to these agents (claude, codex, grok, agy); schmear still picks the subscription. Status no_quota means no subscription has quota left for the task: do it yourself."
  Each tier lists its distinct model names in list order (default tier 1: `haiku, gpt-6-luna, grok-4.7, gemini-4-hydrogen, gemini-4-argon, claude-sonnet-5-5`).
- **Instructions** (sent only when `delegate` is registered, so not in worker mode): `new McpServer(info, { instructions: INSTRUCTIONS })` with exactly:
  "schmear hands subtasks to AI coding agents on the user's other subscriptions, spending the quota most at risk of expiring unused before its reset; your own subscription keeps a reserve. Use delegate for any self-contained subtask you would give a subagent: research, a review, tests, a scoped change. Write each prompt so the worker needs nothing else from you. Put independent subtasks in one delegate call; they run in parallel. Give each task the lowest tier that can do it well. The usage tool shows each subscription's quota and the lane each tier would take."
- **`usage`:** no input, `{readOnlyHint: true}`. Text: the detected driver; per agent its pools with each window's remaining and reset, or `skipped: <reason>`, plus warnings; per pool `pace` and status, and `next: tier t → <lane id> (<effort>)` for t = 1..N, each from one `route()` call holding one task; then, when any, one line `not offered: <entry>@<effort> (tier <t>), …` naming each distinct list entry whose model is absent from its key's known offered list, at its lowest tier; each routed credit pool as its own block (§13). Every routable agent's usage is read with `USAGE_SHOW_MS`. `schmear usage` prints the same text; it has no driver (`driver: unknown`, no reserve) unless `--driver <id>` names one, which keeps that agent's reserve in pace (any other value: `schmear: --driver must be one of claude, codex, grok, agy`, exit 1). An invalid config makes the tool a tool error and `schmear usage` and `init` print it and exit 1.
- **`snapshot(adapters, driver, maxAgeMs): Promise<Snapshot>`** is the data `usage` prints, plus the last day's delegations; `usageText` formats it without `tasks`. `schmear usage --json` prints it on one line (`driver` is null unless `--driver` is given) with the 5 min routing cache (`USAGE_ROUTE_MS`), so a polling UI never reads vendor quota more often than routing does:
  `{version: 1, cliVersion, at, driver, hosts: [{id, status}], readings: [{id, skipped?, source?, fetchedAt?, warnings, pools: [{id, models?, windows, usd?, pace?, status?}]}], next: [{tier, lane: string | null, effort?}], notOffered: ["<key>:<model>@<effort> (tier <t>)"], tasks: TaskRow[]}`. `cliVersion` is the CLI's package version (`PACKAGE_VERSION`; the field `version` is the schema's), which the apps compare with their minimum (0.4.0) to say when the CLI is too old for them. Each `windows[]` entry is a `Window` plus `projectedUnused`, the fraction expected to expire unused at the current spend rate (`projectedUnused(w, at)`: `null` without a reset, before the window starts or after its reset; else `max(0, remaining − (1 − remaining) / elapsedHours × hoursLeft)`). `readings[].id` is an instance id (an adapter's default block, then one per account of that agent in config order) or a credit pool's block id; `skipped` is `not configured`, `no consent` or the reading's error; `pace` and `status` appear only for a pool the router has a row for. `hosts` has one row per agent whose `<agent>@default` config entry has a `path` that exists, read from its MCP config file without spawning (`src/hosts.ts`): `missing` (no readable schmear entry), `stale` (its `command` or `args[0]` is not an existing file) or `ok`; the CLI's text `usage` adds a line naming `schmear init --yes` for each host not ok. `tasks` is `readTasks(at - 24 h)`; each row is `{id, driver, description, tier, cwd, lane, effort?, costUsd?, startedAt, endedAt?, status}` with `status` `running`, `lost` or a `TaskResult` status.
- **`schmear tiers`** prints `TiersDoc` as 2-space JSON when stdout is not a terminal or with `--json`, and one `Tier N` row per tier in a terminal: `{version: 1, source: "default" | "config", maxTasks, tiers, defaults, laneKeys, offered}`, where `maxTasks` is `config.maxTasks ?? DEFAULT_MAX_TASKS`, `tiers` is `config.tiers ?? DEFAULT_TIERS`, `defaults` is `DEFAULT_TIERS`, `laneKeys` is `LANE_KEYS` and `offered` maps each lane key with a known offered list (§11) to its models. `schmear tiers set` reads a JSON array of tiers from stdin, validates it with `parseTiers` (§9.1), and writes `{...config, tiers}` atomically to C (other keys kept); an invalid list prints the `parseTiers` message, exits 1 and leaves C byte-for-byte unchanged, as does non-JSON input (`schmear: tiers input is not JSON: …`). `schmear tiers reset` removes `tiers` from C. All three start from `readConfig()`, so a malformed config fails with its usual message. Routing rereads C on every call, so a change applies to the next `delegate` at once; a host shows a changed tier count after it restarts schmear.
- **`schmear max-tasks`** prints `config.maxTasks ?? DEFAULT_MAX_TASKS` (50). `schmear max-tasks <n>` writes `{...config, maxTasks: n}` atomically to C for a whole number of at least 1, else prints `schmear: max-tasks must be a whole number of at least 1`, exits 1 and leaves C unchanged; `schmear max-tasks reset` removes the key. The `delegate` schema reads it when the server starts, so a host uses a change after it restarts schmear. Both apps' tier editors show it from `TiersDoc.maxTasks` and write it with these two commands.
- **`schmear max-per-pool`** prints `config.maxPerPool ?? DEFAULT_MAX_PER_POOL` (10). `schmear max-per-pool <n>` writes `{...config, maxPerPool: n}` atomically to C for a whole number of at least 1, else prints `schmear: max-per-pool must be a whole number of at least 1`, exits 1 and leaves C unchanged; `schmear max-per-pool reset` removes the key. Routing rereads C on every call, so a change applies to the next `delegate` call. The apps do not show it.
- Logs to stderr only. On stdin close, SIGTERM or SIGINT: cancel running tasks, exit.

Registration by `init`. Every entry runs `[<node>, <cli>, "serve"]`, where `<node>` is `node` on PATH when its `realpath` equals `process.execPath`, else `process.execPath`, and `<cli>` is `schmear` on PATH when its `realpath` equals the running `dist/cli.js`, else that absolute path (so Homebrew's unversioned symlinks survive upgrades, which delete the versioned Cellar paths); init refuses to run from an npx cache path (`/_npx/`). add-mcp is not used: its Codex and stdio transforms drop timeout fields (`add-mcp` 2.6.1 `dist/chunk-JZK2SME6.js:1029–1062, 1236–1254`).

| Host | Write | Timeout key | Default without it | Parallel calls (R8) |
|---|---|---|---|---|
| Claude Code | `claude mcp add-json -s user schmear '{"type":"stdio","command":…,"args":[…],"timeout":86400000}'` | `timeout` ms; at ≥1000 it also floors the 30 min stdio idle timeout | about 28 h, aborted after 30 min idle (R11) | serial; concurrent with `readOnlyHint` |
| Codex | append `[mcp_servers.schmear]` with `command`, `args`, `tool_timeout_sec = 86400`, `env_vars = ["SCHMEAR_WORKER"]` to `${CODEX_HOME:-~/.codex}/config.toml`; no `default_tools_approval_mode`, so Codex applies its own approval policy to `delegate`, and one the user added (R17) is a user key init keeps | `tool_timeout_sec` | 60 s per docs; a 75 s call succeeded (R9) | serial; concurrent with `readOnlyHint` |
| Grok | append `[mcp_servers.schmear]` with `command`, `args`, `tool_timeout_sec = 86400` to `${GROK_HOME:-~/.grok}/config.toml` | `tool_timeout_sec` | 6000 s (R11) | concurrent |
| Antigravity | JSON merge `mcpServers.schmear = {command, args, timeoutSeconds: 86400}` into `~/.gemini/config/mcp_config.json` | `timeoutSeconds` | 180 s (R10; the user-level file is unverified) | serial |

- Parse the target first (`smol-toml`, `JSON.parse`, `claude mcp get schmear`). An entry equal on the keys init writes is left alone, so user keys (`env`, `disabled`, `enabled = false`, `startup_timeout_sec`, a `[mcp_servers.schmear.env]` subtable) never make it differ; a differing one gets only init's keys rewritten, every other key, line and comment kept (Claude: remove then add; TOML: each init key's line, as text) and is reported "updated". A new TOML table is appended as text; JSON is rewritten atomically. Writes go through a symlinked config to its target.
- Claude: `claude mcp get` shows the entry Claude uses; one whose `Scope:` is not user is not the user entry, so init registers at user scope and warns that the other scope's entry shadows it.
- Each host registers independently: a failure prints `<host>: not registered (<msg>)`, the other hosts still register and are checked, and init exits 1.
- API credits offer: a terminal run without `--yes`, with `claude@default` consented and no Claude credit pool configured, shows an "API credits" panel when a consented Claude account's plan is Max 5x (`max_5x`, $100 / month) or Max 20x (`max_20x`, $200 / month) in `claude auth status --json`, one `Claude · <account>  $<N> / month` row each, and asks "Set up API credits now?" (Yes runs the `schmear credits` wizard, §13; Later prints "Run `schmear credits` anytime to spend them."). `--yes` never asks. The init quota summary marks such an account `$<N> API credits / month`. The panel also shows, information only, `ChatGPT Pro · <account>` (plan `pro`: $100, $200 or $500 by Pro tier) and `ChatGPT Business · <account>` (plan `business` or `team`: $20 or $100 per seat, pooled up to $500) per consented Codex account, one `Google AI` row (Pro $10, Ultra 5x $40, Ultra 20x $100 of Google Cloud credits) when `agy@default` is consented, and then "ChatGPT and Google credits are not spent yet: Codex and Antigravity cannot draw on them."; the select is asked only with a Claude row.
- Adapters: before the usage read, when any ticked entry is a Claude or Codex account, init runs `ensureAdapters` (§8) under the task "Installing the Claude and Codex ACP adapters"; a failure prints a warning and init continues.
- Desktop app: a terminal run without `--yes` ends with `desktopApp(io, platform, home)`, which needs `InitIO.run` and `launch` (terminal IO only). It opens `Schmear.app` from `/Applications` or `~/Applications` with `open`, or on Linux `~/.local/bin/schmear-tray`, detached (both apps hand a second launch to the running one). When the app is missing it asks whether to install it: `brew install --cask kevin1chun/tap/schmear` on macOS with `brew` on PATH (without brew it prints the README link), `sh scripts/install-tray.sh` on Linux; exit 0 then opens it, non-zero warns. `--yes` skips all of it because the apps run `init --yes` to reconnect.
- Skill: for each host found, init copies the packaged `skills/schmear/SKILL.md` to `<dir>/schmear/SKILL.md`, where `<dir>` is the host's global skill folder as the `skills` CLI (vercel-labs/skills `docs/agents.md`) names it: `~/.claude/skills`, `~/.agents/skills` (Codex), `${GROK_HOME:-~/.grok}/skills`, `~/.gemini/config/skills`. An equal copy is left alone ("skill current"), a different one replaced ("skill updated"); each host prints one line with its registration and skill outcome; a failed write prints `<host>: skill not installed (<msg>)` and init exits 1. Other agents install it with `npx skills add kevin1chun/schmear`; the skill holds the delegation workflow, the MCP instructions only when to delegate.
- An agent whose `find(bin)` fails prints `<id>: <bin> failed detection (<error>)` and is not offered as a worker.
- Afterwards init runs `claude mcp get schmear`, `codex mcp list`, `grok mcp list`, `agy mcp list` for each registered host and prints a host's output only when it fails or does not name schmear. It stores each binary's absolute path in `Config.agents[id].path`; `serve` never resolves PATH.
- Output: on a terminal, `@clack/prompts` with a spinner over each slow step (detection, the usage read, registration), the subscription checklist, and a one-line-per-pool quota summary (`schmear usage` has the full text); piped input gets the same steps as plain lines, the checklist answered as comma-separated agent ids (empty keeps the ticked set).
- Consent: one checklist of the detected agents, then each added account whose agent was detected, each row labelled `<id>  [email · ]plan` from `find` (or `<id>  not signed in`), each ticked unless config holds `consent: false` for it (an `agy` instance: ticked only when config holds `consent: true`, [Decisions](#decisions)); every account entry is kept, a detected one with the checklist's consent and the detected `path`; the ticked ones get `consent: true`. Using a detected CLI is the consent (user ruling, 2026-11-22): there is no per-provider question, no Claude risk question (`docs/safety.md` keeps the risk sentence) and no overage question, since Codex and Grok overage is read (§8.2, §8.3 spend guards) and Antigravity's is assumed off (§8.4). `--yes` takes the ticked set without asking. The credit lane is `schmear credits` (§13), not init; when `claude@default` is ticked, no Claude credit pool is set and its plan is in `CREDIT_PLANS` (`max_5x`, `max_20x`), init prints an `API credits · schmear credits` hint beside the account.
- Accounts: on a terminal and without `--yes`, after the checklist init loops on `select("Add another subscription?", detected agents + Done)`. A pick of agent `a` asks a nickname (account rule, not `default`, not already used for `a`), tells the user to sign in to that account in the browser first (claude.ai, chatgpt.com, grok.com, their Google account) and waits for `select` Continue (Cancel returns to the menu), creates `${XDG_DATA_HOME:-~/.local/share}/schmear/logins/<a>-<nick>` (0700) and runs `<bin> <home.login…>` with `{[home.env]: home}` over `workerEnv` and inherited stdio (`InitIO.run`, which ignores SIGINT while the child runs, so Ctrl-C ends only the login). It then runs `find` with that env (Claude reports `email` and `plan`, Codex `plan`), writes `{consent: true, path, home}` and reads usage fresh; a failed sign-in, a usage error, or an email equal to another login's of the same agent removes the entry and the directory with a warning naming the matching id. `uninstall` deletes the data directory with the config and state.
- **`schmear uninstall [--yes]`** undoes init and credits after a typed `yes` (`--yes` skips it): `claude mcp remove -s user schmear` (other scopes are the user's; no `claude` on PATH prints "not installed"), and in the Codex and Grok TOML and the Antigravity JSON the `schmear` entry, with its TOML subtables, as text, every other line kept. It then deletes the config, state and data directories (the config directory holds `console-sessions.json` and the data directory holds the account logins init created) and the four `<dir>/schmear` skill folders, prints one line per credit pool naming its `keyCommand` (the keys stay where those commands read them) and, per account whose login is outside the data directory, `Your <id> login stays in <dir>.` (those directories are never touched), and names `npm uninstall -g schmear` and `brew uninstall schmear`. Each host is removed independently; a failure prints `<host>  not removed (<msg>)`, the rest still runs, and uninstall exits 1.

## 13. Credit pools

Facts and vendor balance sources: `docs/research/api-credits.md`.

| Vendor | Status |
|---|---|
| Anthropic (`claude-credits`) | Implemented (M1). One pool per Console org (several orgs per login, several logins), spending the org's whole reported prepaid credit balance (promotional and purchased credits) down to 2% through `claude-agent-acp` with `ANTHROPIC_API_KEY`. |
| xAI (`grok-credits`) | Planned (M2, gated on owner check G0). Management API prepaid balance minus postpaid invoice preview, with a spending-limit guard refusing invoiced billing. |
| OpenAI (`codex-credits`) | Planned (M2, gated on owner check C1 and decision O1). Legacy `dashboard/billing/credit_grants` with the pool's own key; modern keys return 403 and stay skipped (Admin costs report spend only, not balance). |
| Google | Out of scope: no balance API, `agy` has no BYOK, and Gemini CLI is not a worker. |

Design:

- **Config.** `Config.credits` (§6) is `Record<string, CreditPoolConfig>`, keyed by pool id `<creditKey>@<name>` (e.g. `claude-credits@main`, `<name>` matching the account regex). `readConfig` checks `credits` only as a plain object; `parseCredits` validates each entry per read so a bad entry (including the 0.4 flat-object shape) skips only itself (`credit pool id invalid` or `credit pool config invalid: <field>`) and leaves every other pool routable. Only pools whose agent's `@default` instance is routable are loaded. `overageOff: true` is the user's typed confirmation that auto-reload is off; `taskCapUsd` is optional.
- **Claude Console reader (`src/console.ts`).** Mirrors CodexBar's `claudeplatform` plugin (`https://platform.claude.com`, 60 s timeout, `Accept: application/json`, `redirect: "manual"` so cookies never follow redirects to another host), except every configured org is read rather than stopping at the first readable one.
  - Sessions live in `console-sessions.json` (mode 0600, dir 0700) as `Record<label, CookieHeader>`.
  - `readConsole(sessions, pools)` iterates sessions in file order, calling `GET /api/organizations` once per session (filtering to orgs with `"api"` in `capabilities` and `uuid` matching `/^[A-Za-z0-9-]{1,64}$/`). For each pending pool whose `org` matches, it calls `GET /api/organizations/<org>/prepaid/credits`. The first session in file order that reads an org wins.
  - Parse: `currency` defaults to `"USD"` (`^[A-Z]{3}$`); non-USD fails closed (`Console org <name> bills in <CUR>; schmear meters USD`). `balance.credits.exponent` is an integer 0–4 (default 2), `scale = 10^exponent`, `usd = amount / scale`. Live tranches from `promo_tranches` and `tranches` with `granted_amount_minor_units > 0` and un-expired (a malformed `expires_at` becomes an unknown expiry, not a read error; remaining clamped ≥ 0) give `grantedUsd = Σ granted / scale`, `floorUsd = 0.02 × grantedUsd`, and `window.resetsAt` = soonest `expires_at` among live tranches with remaining > 0 (null when none dated).
  - Errors: 401 → session expired; 403 on `/api/organizations` → session expired, on `prepaid/credits` → billing access denied; 429 → rate limited; ≥500 → unavailable; other non-200 → HTTP status; bad JSON/shape → parse error naming the field. An org in no session → `org <uuid> is not in any Console session; run schmear credits login claude`. Neither cookies nor upstream response bodies appear in errors or logs.
- **Cached reading and pool window (`src/credit.ts`).** `readCreditPools` caches one `ProviderReading` (holding `balances` per pool id) per credit key through `usage(key, read, maxAgeMs)` (5 min for routing, 60 s for `usage`, at most 60 s when any pool failed; forces `maxAgeMs = 0` when a newly configured pool id is absent from the cached `balances`).
  - For each pool, an unreadable vendor balance or an unreadable/unwritable ledger returns a windowless skipped reading (fail closed). Otherwise, when there is no prior `balance` line or the reading is newer (`last.at < fetchedAt`) and `usd` or `floorUsd` changed, `credit.ts` appends `{at: fetchedAt, kind: "balance", usd, floorUsd}` to `S/ledger/<pool id>.jsonl`.
  - It replays the ledger to get `left` and builds `{id, agent, account: name, keys: [key], windows: [{kind: "period", remaining, resetsAt, periodHours: 720}], usd: {left, granted}}`, where `remaining = granted > 0 ? min(1, max(0, left) / granted) : (left > floorUsd ? 1 : 0)`. `periodHours: 720` values credits as a 30-day allowance so a monthly grant near expiry outranks subscriptions while undated or far-out purchased credits do not.
  - In `usage` (`src/view.ts`, `src/server.ts`), each credit pool nests under its agent's `@default` account as `API credits (<name>)`, printing `$<left> of $<granted>` (plus `expires <Mon D>` when `resetsAt` is set); a skipped pool prints its error as a warning line under that account, and `usage --json` carries `pools[].usd`.
- **Ledger replay (`src/credit.ts`).** Lines in `S/ledger/<pool id>.jsonl` replay in file order:
  - Before each line, every open reservation older than `RESERVE_TTL_MS` (30 h, above Claude Code's 28 h per-call limit, R11) at that line's `at` is released (`left += reserved`), so the room a reserve was sized on is the room it is checked on.
  - `balance`: ignored when `at` is not newer than the current `base`'s, so a duplicate append cannot drop the settles before it; otherwise sets `base = line`, `left = usd − Σ open`, and clears `exhausted`.
  - `reserve`: valid iff `base` is set, not `exhausted`, `usd > 0`, and `usd ≤ left − base.floorUsd`; then `left −= usd` and `open.set(taskId, usd)`. Otherwise void.
  - `settle`: `left −= usd` and, if `taskId` is open, releases its hold (`left += reserved`, closes it).
  - `exhausted`: sets `exhausted = true` (`left` becomes 0 until the next `balance` line).
  - After the last line, reservations older than `RESERVE_TTL_MS` at `now` are released the same way, so a killed process never leaks a hold. A line's validity depends only on the lines before it and their timestamps, never on `now`.
- **Lane and spend path.** Subscription instances drop credit-key lanes; each valid pool adds `candidates(tier, tiers, offered, name).filter(l => l.key === key)` (unless `agents` excludes its agent) and launches under `laneInstance(lane)` (`<agent>@default`). For a credit lane, `delegate` calls `openCreditRun(poolId, pool, grantedUsd, spec, signal)`:
  - Run `keyCommand` without a shell before reserving, keeping stdout in memory. A failing or empty command returns `{cancelled}` if aborted, else `{note}` naming only `argv[0]` and exit/signal (never its output), excluding the lane key and re-routing.
  - Reserve (`reserveCredit`): replay the ledger; if no `base`, return `budget: 0` (`"quota"`). `cap = taskCapUsd ?? (grantedUsd > 0 ? grantedUsd : base.usd) / 10`; `B = min(left − base.floorUsd, cap)`. `B ≤ 0` → `"quota"`. Else append `{kind: "reserve", usd: B}`, replay again, and use B once `open.has(taskId)` (retrying if a concurrent line voided it). A ledger write failure excludes the lane key with a note naming its errno code or message.
  - Claude launch (`creditSpec`): sets `ANTHROPIC_API_KEY=<key>` in worker env (outranking OAuth; inherited by shell commands the worker runs, disclosed in `docs/guide.md`), `requireAuth {kind: "api_key", detail: "ANTHROPIC_API_KEY"}`, and `sessionMeta.claudeCode.options.maxBudgetUsd = B`. The SDK stops with `error_max_budget_usd` only after a turn exceeds B (`sdk.d.ts:2069–2073`), reaching the client as "Reached maximum budget ($B)" or stop reason `max_turn_requests` (`result-end.js:31–58`); `floorUsd` is the margin for that turn. When `B < cap` (`clipped`), the pool set the budget so that stop is a quota outcome (§10 step 6); when `B = cap`, it stays `failed`.
  - Settle: at finish, `spent = run.prompted ? (costUsd ?? B) : 0` (the SDK's `total_cost_usd` is cumulative per query, so keep the maximum; a resumed run passes `max(0, cost − handle.costUsd)`; if a prompted run reported no cost, B is settled and the next balance read corrects it). Appends `settle`, and `exhausted` (`usd: 0`) on `errorKind: "billing_error"` / "credit balance is too low". A failed write after the run adds a note and leaves the task result intact.
  - Console posting lag: a balance read taken before the Console posts a finished task's cost resets the base and drops that settle; bounded by `floorUsd` and the vendor's stop at zero.
- **Absolute stop.** (a) Unreadable vendor balance fails closed. (b) No reservation at or below `floorUsd`. (c) SDK `maxBudgetUsd = B` stops the task inside the run. (d) Vendor exhaustion appends `exhausted` and triggers §10 step 6. (e) `overageOff: true` is required and confirmed by typed `yes` because auto-reload cannot be read from the Console.
- **CLI (`src/cli.ts`, `src/init.ts`).**
  - `schmear credits login claude --stdin [--label <name>]`: reads one `Cookie` header from stdin (stripping optional `Cookie:` prefix, requiring printable ASCII and `sessionKey=`), validates via `GET /api/organizations` and reads each API org's balance, saves atomically to `console-sessions.json` (0600, default label `default`), and prints each API org (name, uuid, balance); never prints the cookie or response bodies.
  - `schmear credits logout <label>`: removes that session from `console-sessions.json`.
  - `schmear credits`: requires `claude@default` consented; reads every stored session's API orgs and balances (with no sessions, prints the `credits login` instructions); lists each org with its balance and whether a pool spends it; loops on `select("Add a pool for an org?", orgs without a pool + Done)` asking pool name (slugged org name prefilled), `keyCommand` JSON array (prefilled `["security","find-generic-password","-s","schmear-anthropic-<name>","-w"]`), and typed `yes` confirming auto-reload is off. Writes `{...prior, credits}`, dropping unparseable prior entries (such as the 0.4 shape). Later `init` runs keep `credits`.
  - `schmear credits remove <id>`: removes the config entry and deletes `S/ledger/<id>.jsonl` (leaving the API key where `keyCommand` reads it).

## 14. Edge cases and constraints

### Worker environment (`workerEnv(extra?, base = process.env)`)

1. Copy `base` and delete every variable that changes an agent's auth or billing route: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`, `CLAUDE_CODE_USE_ANTHROPIC_AWS`, `CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD`, `CLAUDE_CODE_USE_MANTLE`, `CLAUDE_CODE_USE_GATEWAY`, `ANTHROPIC_AWS_API_KEY`, `ANTHROPIC_FOUNDRY_API_KEY`, `AWS_BEARER_TOKEN_BEDROCK`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `CODEX_API_KEY`, `MODEL_PROVIDER`, `CODEX_CONFIG`, `DEFAULT_AUTH_REQUEST`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_GENAI_USE_VERTEXAI`, `XAI_API_KEY`, `GROK_CODE_XAI_API_KEY`, `GROK_AUTH`, `GROK_MODELS_BASE_URL`, `GROK_XAI_API_BASE_URL`, `GROK_CLI_CHAT_PROXY_BASE_URL`. An exported `ANTHROPIC_API_KEY` would silently move a subscription run onto API credits.
2. Set `SCHMEAR_WORKER=1` and the adapter's variables. Only a credit lane gets a key back (§13).
3. Detection and usage commands run with the same env, so they report what workers use.

### Worker parity

Workers have the default tools, MCP servers, skills and plugins their CLI has when used directly in the same cwd, under its own permission mode and sandbox. schmear adds or removes none, sets the codex-acp mode matching the Codex config, sets model and effort, and strips the variables above. The parity live test (`test/live/parity.test.ts`, fixture from `docs/probes/parity_fixture.sh`) runs the worker through the adapter's own `launch()` and the native reference in the same fixture checkout, comparing CLI records only (model self-reports are not evidence, R23):

| Agent | Native reference | Worker | Compared |
|---|---|---|---|
| claude | `claude -p --output-format stream-json --verbose` `system/init`, and the hook log | the worker CLI's `system/init`, captured with `docs/probes/tee_exec.sh` as `bin` | permissionMode, output_style, apiKeySource, agents, skills, slash_commands, plugins, non-MCP tools, MCP servers by name and source, loaded instruction files |
| codex | app-server `thread/start {cwd}`, `skills/list`, MCP startup names | codex-acp's app-server traffic via `tee_exec.sh` as `CODEX_PATH`; skills and MCP names from a direct app-server replaying the captured `thread/start` params | approvalPolicy, approvalsReviewer, sandbox, instructionSources, skills, MCP names; overrides equal the three below |
| grok | `grok inspect --json` | `grok inspect --json` with the worker env (`agent stdio` reports no inventory, R28) | projectTrusted, projectInstructions, skills, mcpServers, hooks, plugins |
| agy | `agy -p /skills --output-format json`; the fixture's workspace logger started by a one-turn `agy -p` prompt (`/skills` starts none, R37) | the same logger started by the `agy acp` worker | skills, MCP servers started |

Inventories that fill in during startup are read until two reads 1 s apart agree, at most 30 s (R27). The test sets `PK_TEE_REAL`/`PK_TEE_LOG` under its temp dir and deletes the logs afterwards; it never writes user-level config. Every other difference fails the test unless listed; an unlisted difference is reported, never added by the implementer.

| Agent | Known difference | Why accepted |
|---|---|---|
| all | the stripped variables; the model and effort schmear sets | [Decisions](#decisions) |
| claude | MCP servers can be `pending` at the first turn, so their prompts are not yet in `slash_commands`; `-p` waits (R26, R37) | the interactive CLI also connects in the background; compare names and sources, and skip the prompts of servers pending in the worker |
| claude | the SDK entrypoint omits built-in plugin `cc-plugin-easel` and adds `SendToProject`, `SendToProjectContext`, skill `send-to-project`; `-p` drops `EnterPlanMode`/`ExitPlanMode` (R26, R26b) | the CLI's own per-entrypoint behavior |
| claude | `AskUserQuestion` is disallowed (`acp-agent.js:7581`); `-p` lacks it too | Claude Code removes it from its own subagents (code.claude.com/docs/en/sub-agents) |
| codex | codex-acp's `thread/start` overrides: `visualize:visualize` disabled, the session root trusted, `features.cwd_relative_turn_diffs=false` (R27; `index.js:43999–44011`) | adapter options; trusting the root also trusts a cwd the user never trusted (§18) |

### Recursion guard

Workers load the user's MCP config, which includes schmear after init; a worker-side server must not offer `delegate`. Claude, agy and Grok pass the worker env to the MCP servers they spawn; Codex only for variables in `env_vars` (R18; init writes it). clientInfo cannot tell a driver from a worker (R18).

### Safety

There is no OS-level guarantee and no confinement. A worker does not inherit the driver's sandbox or permission mode: its CLI's own mode and sandbox decide what it may do, in any cwd the driver names, so a read-only driver can get files written and commands run through `delegate`. A Codex worker trusts its cwd (codex-acp marks every session root trusted), so a repository's `.codex/config.toml`, MCP server commands included, takes effect without Codex's trust prompt. What a worker asks goes to the driver's user, and with nobody to answer every request is rejected (R31). Tasks given the same cwd share it. Workers can call the user's MCP tools. The recursion guard prevents accidental delegation loops; it is not a security boundary, since a worker with a shell can unset `SCHMEAR_WORKER` or run another CLI directly. `docs/safety.md` says all of this.

### Usage and quota

- **Unreadable** (missing binary, logged out, expired token, missing scope, endpoint error, timeout, no percent) → an error reading; the agent is skipped and `usage` shows why. schmear never writes or refreshes a token and never runs inference to read usage.
- **Source order.** A usage reader runs the vendor CLI's own read first (§8.1, §8.2, §8.4) and a credential step only when it fails, so a working CLI never makes schmear read a credential. Claude: OAuth after any `get_usage` failure. Codex: PAT after an RPC failure; OAuth when the PAT step has no token or gets a 401; a PAT or OAuth failure of any other kind (another status, a network error, a bad body, an invalid `auth.json`) ends the credential steps. Antigravity: the app server after a print-read failure, for `@default` only. A reading names the step that answered in `source`, shown by `usage` and `usage --json`; when every step fails, the error is the CLI's with the credential reasons in parentheses. The cache rules of §11 are unchanged, so the credential steps run at most once a minute per account; the worst case is the CLI's own timeout plus 30 s per credential HTTP call (5 s per app-server port).
- **Overage overrun.** The floor is a margin, not a meter. Claude reports overage live and schmear cancels (§8.1); Codex and Grok report their overage sources in the usage read, so held credits or a non-zero on-demand cap or prepaid balance skip them (§8.2, §8.3 spend guards). Antigravity's AI-credits setting is unreadable and assumed off (§8.4).
- **Quota failure mid-task** → exclude the lane for the call, re-read, re-route (§10 step 6); an `agents` allowlist bounds the reroute. A transient 429 is `failed`.

### Hosts and processes

- Tasks in a batch ask independently, so several prompts can be open at once; the host's tool-call timer keeps running while one waits (R31).
- "Allow always" reaches the agent, which keeps it its own way, as natively.
- A user who registers schmear by hand without the §12 timeouts gets the host default (Codex 60 s, Antigravity 180 s); the snippets in `docs/guide.md` include them.
- Workers and agy's `/usage` read run in their own process groups (`leadGroup` in `src/util.ts`); the whole group is killed on every exit path, including schmear's own shutdown: closing stdin, SIGTERM or SIGINT aborts every call, and schmear's exit SIGKILLs every group still running. If schmear is SIGKILLed, the groups survive it: being detached, they also get no signal from the terminal or the host.

### Accounts

- schmear cannot see which login the driver itself uses; `@default` is treated as the driver's (reserve and tie-break, §9.2). Each credit pool runs under its agent's `@default` binary (`laneInstance`) with its own API key and ledger, and nests under `@default` in `usage`.
- An Antigravity account runs with `HOME=<dir>`, so its workers also see that HOME for git, ssh and every other tool.
- An account that is not signed in reads as skipped with the adapter's error, like any unreadable agent.

### Platform

- Workers run the user's own `claude` and `codex` (R1b, R2b), so their home-directory state is never written by a newer bundled version.
- Node ≥22.18; macOS and Linux; Windows is out of scope. A global install is about 32 MB. The adapters' tree (about 45 MB) is installed with `npm ci --omit=optional --omit=peer` apart from it, so the vendor binaries the adapters pull as optional dependencies (most of a full install's size) never arrive; schmear never runs them. The menu bar app needs macOS 14 and the tray app glibc 2.34 and Qt 6.4 or later.

## 15. Project

- **Name** `schmear` (npm and GitHub 404 on 2026-11-22). **License** MIT. **Layout** one npm package, plus the Swift package in `macos/` and the CMake project in `linux/`.
- **CI** (`.github/workflows/ci.yml`): push to main and pull requests, `contents: read`, `ubuntu-latest` and `macos-latest` × Node `22.18.0` (the engines floor), `22.x`, `24.x`, `26.x`; `npm ci && npm run build`, `node dist/cli.js --version`, `npm run check` (60 s per-test timeout). Actions are pinned to commit SHAs; Dependabot (`.github/dependabot.yml`) proposes npm (root and `/adapters`) and action updates weekly. After the `--version` step, `adapterBin` runs a real adapter install into `$RUNNER_TEMP/data` on each Node's own npm. A `macos` job (`macos-15` and `macos-26`) runs `swift build && swift test` in `macos/`. A `linux` job (`ubuntu-24.04` and `ubuntu-24.04-arm`) apt-installs Qt 6, builds `linux/` and runs `ctest` offscreen. Live tests never run in CI.
- **Dependencies**: `package-lock.json` pins schmear's own tree for development and CI and is not published. The adapters are not dependencies: a global install cannot omit a dependency's optional or peer packages, a shipped `npm-shrinkwrap.json` made npm 11 install every platform's binaries (5.5 GB), and the Claude SDK's licence bars bundling. `adapters/package.json` pins the two adapters and the MCP SDK (a peer claude-agent-sdk imports, kept because `--omit=peer` drops `@anthropic-ai/sdk`, which nothing imports); `adapters/package-lock.json` is shipped and every entry must be a registry.npmjs.org sha512 with no install script (`test/adapters.test.ts`). To bump: edit `adapters/package.json`, run `npm install --package-lock-only --ignore-scripts` in `adapters/` (this also refreshes the frozen transitive versions), under `adapters/.npmrc`'s two-day `min-release-age`, which a nested project root does not inherit from the root's; Dependabot (`/adapters`, two-day cooldown) does the same. The first `adapters/package-lock.json` was derived from the then-root lockfile (same pins) because the two-day hold blocked a fresh resolution. The hold applies when pins are chosen, not at install: the hashes fix the bytes.
- **Release** (`.github/workflows/release.yml`): triggered by a `v*` tag after `npm version <x>` and a CHANGELOG entry. The workflow's top-level `permissions` is empty. Job `publish` runs in the `npm` environment, which needs the owner's review and holds no secrets, with `{contents: read, id-token: write}`; after checkout it fails unless `v<package.json version>` equals the tag. Then: Node 24, an exact npm 11 pin, `npm ci && npm run check`, a real adapter install (`adapterBin` into a temp data dir, as CI does on each Node's own npm), a dry-run global install of the packed tarball with Homebrew's `--min-release-age=1 --ignore-scripts` (it fails while any dependency is less than a day old, which would fail `brew install`), and `npm publish --provenance --access public` through npm trusted publishing. Job `github-release` then runs `gh release create $TAG --draft --verify-tag --generate-notes` with `contents: write` only; a draft keeps `releases/latest/download` on the previous release until every asset is attached. Job `linux-app`, a matrix on `ubuntu-24.04` (x86_64) and `ubuntu-24.04-arm` (aarch64), whose OS sets the glibc and Qt floor, builds Release, runs ctest, stages with `cmake --install --prefix schmear-tray-linux-<arch> --strip`, and uploads the `.tar.gz` and its `.sha256`. Job `macos-app`, after both, in the `release` environment, builds, notarizes and uploads `Schmear.zip`, publishes the release (`--draft=false --latest`), then updates the Homebrew tap, whose URLs a draft does not serve. The owner claims the npm name and binds the trusted publisher to the `npm` environment, which requires the owner's review; the `release` environment holds the signing and tap secrets, needs no review, and accepts only `v*` tags, so one approval releases everything.
- **Community files**: `SECURITY.md` (private vulnerability reporting), `CONTRIBUTING.md`, `CHANGELOG.md` (Keep a Changelog; names what counts as breaking), `.github/ISSUE_TEMPLATE/bug.yml`.
- **User docs**: `README.md` (pitch and install), `docs/guide.md` (reference) and `docs/safety.md` (threat model, vendor terms, Claude disclosure). Every fact is checked against src/ and this spec; the §8.1 risk sentence appears in `docs/safety.md`.

## 16. Verification

| When | Check |
|---|---|
| Every change | `npm run check` |
| A change under `macos/` or `linux/` | `cd macos && swift build && swift test`; `cmake -S linux -B linux/build && cmake --build linux/build && QT_QPA_PLATFORM=offscreen ctest --test-dir linux/build` |
| Before the release tag | `npm run check && node --test test/live/*.test.ts` on macOS with all four agents logged in; Linux CI green once a remote exists |

Live commands need the agents logged in, skip agents not installed, and obey the money guard: a live test spends subscription quota on tiny read-only prompts only, and runs only when `test/live/guard.ts` shows every pool of every agent it can route to above 5% remaining, else it skips with the reason. Anything that spends API credits or could charge a card (the credit-lane live check) is run by the owner.

A live failure caused by a vendor change is fixed by re-running the matching probe in `docs/probes/`, not by loosening a test.

## 17. Out of scope

- A daemon, a background service, a web UI, telemetry, process pooling.
- Any non-ACP launcher; Windows.
- Worktrees, branches, commits, merges or any git operation; adding text to a prompt; read-only enforcement. The driver owns these.
- A per-task wall-clock limit inside schmear; host cancel governs.
- Google credit lanes; any POST to a billing endpoint or editing vendor overage settings.
- Writing, refreshing or caching any vendor token.
- CodexBar's other Grok surfaces: browser cookies, limit-reset coupons, `/v1/settings` plan enrichment, team principals.

## 18. Deferred

### Post-v1 (each needs a vendor change, a field observation, or spend the user runs)

- One adapter tree per adapter: a Codex-only user installs the Claude adapter's share of the 45 MB.
- schmear's own 32 MB (zod 8, MCP SDK 6, ACP SDK 5.5, hono 3, ajv 2.4 MB), about 20 MB of it repeated in the adapter tree.
- A `serve` still running from a Homebrew keg an upgrade deleted fails Claude and Codex tasks with ENOENT until its host restarts it; name the restart in that error.
- Two installed schmear copies with different pins delete each other's adapter tree at every install.
- Whether `npm ci` applies a user's own `min-release-age` to a locked tree (unprobed); if it does, such a user cannot install a pin younger than their hold.
- The upgrade-test harness lives in a session scratchpad; move it into the repo if it is to gate releases.
- `test/live/guard.ts` skips an agent when any of its pools is at or below 5%, so Antigravity goes untested while `agy-3p` is spent even though tier 1 would route to `agy-gemini`; guard only the pools the test's lanes draw on.
- `test/live/nested.test.ts` fails with `NONE` when schmear is not registered with the worker's CLI; skip with that reason instead.
- The credit lane with the Claude subscription switched off installs the adapters at first use, not at `init`.
- A task waiting for a slot writes no task-log line, so the apps and `usage --json` show it only once it starts.
- A per-login cap for Antigravity, if bursts across `agy-gemini` and `agy-3p` (each capped separately) are observed to trigger blocks.
- Claude `limits[]` rows that get_usage's allowlist hides from `model_scoped`, and a `model_scoped` that is absent because the answer was cached (the OAuth step maps `limits[]`).
- Claude: the Web step (claude.ai `sessionKey`, `/usage`, `overage_spend_limit`, `prepaid/credits`) and a browser-cookie importer (Chromium, Firefox), which the macOS app could pipe into `schmear credits login claude`; `CLAUDE_SECURESTORAGE_CONFIG_DIR`; CodexBar's 429 `Retry-After` gate; the `cedar_ember`, routines/cowork and cloud-credit display rows.
- Codex: the `chatgpt_base_url` override, the workspace `remaining_balance` in the credits message, and CodexBar's two 50 ms `auth.json` reread retries.
- Antigravity: the app's `GetUserStatus`/`GetCommandModelConfigs` fallbacks, the `extension_server_port` HTTP retry, Linux `/proc` port discovery, and an identity check of the app's login against the agy CLI's (`@default` takes the app's reading).
- Grok: the team-principal identity-only path, `GetRemainingResets` coupons and the `/v1/settings` tier (display only).
- `init`'s consent text does not name the credential reads of §8; `docs/safety.md` carries the disclosure.
- Codex limits other than `rateLimits` (other `rateLimitsByLimitId` ids) are warnings, not routed on; map them once one is observed.
- Not fixed (decision: no upstream report): a withdrawn permission prompt can stay on screen in clients built on `@modelcontextprotocol/sdk` 1.32.2: `Protocol._oncancel` returns early on a falsy `requestId`, and the server's first elicitation has id 0 (`dist/esm/shared/protocol.js:174`). The server sends `notifications/cancelled` and ignores a late answer.
- Elicitations from MCP servers inside a worker are not relayed (claude-agent-acp handles them itself, `acp-agent.js:26`).
- Where "allow always" persists for Codex exec-policy and network amendments, Grok and agy.
- codex-acp's three `thread/start` overrides (§14) need an adapter option to undo; trusting the session root trusts a cwd the user never trusted.
- Codex settings the mode cannot carry: every codex-acp mode turns workspace network access off, and the merged `config/read` view omitted the project layer (R27).
- Mid-task overage detection for Codex (`account/rateLimits/updated` is consumed inside codex-acp, `index.js:40326`) and Antigravity.
- Grok and Antigravity quota signals over ACP: replace message matching with the observed error shape once an exhaustion is seen.
- The `cancelled` fallback for a request with no `reject_once` option may stop the agent's turn rather than skip one action.
- MCP 2026-07-28 (stateless; permission prompts by multi-round-trip results): built when a host stops falling back to `initialize` for stdio servers, when `@modelcontextprotocol/sdk` 1.x misses a needed fix (fixes are promised only to about 2027-01-27), or when the owner chooses; design, trigger checks and the probe are in `docs/research/mcp-2026-07-28.md`.
- MCP tasks (async tool calls; on 2026-07-28 the `io.modelcontextprotocol/tasks` extension, which `@modelcontextprotocol/server` 2.4.0 does not implement) and progress notifications for hosts that advertise them.
- Re-rate the non-Claude tier entries when AA or Epoch publish missing per-effort scores (model-tiers.md §5).
- Config-defined new lane keys or agy group-to-pool maps; short-window (5 h) capacity in pace; burn-rate forecasting.
- Two accounts on the same login double-count its quota; only Claude's is detected, by email.
- schmear and its skill are not registered inside an account's own config dir: an account is a worker, never a driver.
- The macOS and Linux apps show accounts but cannot add or remove them.
- `schmear tiers` reports `offered` for `@default` only.
- A worker's permission prompt names its agent, not its account.
- Removing or renaming a subscription means editing the config (the login directory keeps the first nickname); unticking it in `init` stops its use.
- Codex, Grok and Antigravity report no email, so signing in to the same one twice is not detected.
- On macOS a Claude login may also live in the keychain; deleting its directory may leave that entry.
- Probe Codex on a paid plan to confirm the GPT-6.1 Terra effort set the list assumes (model-tiers.md §5); probe Grok's on a paid plan.
- Grok 1.0.92 offers a `reasoning_effort` configOption; schmear still sets effort through `GROK_CONFIG`.
- `usage` cannot name an entry whose effort the model lacks; it is found when it runs.
- The tool description and the schema's tier bound refresh only when the host restarts schmear.
- A custom list without `claude-credits:` entries never spends a configured credit pool, and `usage` does not say so.
- The default list is the `medium` column of model-tiers.md's ratings, so no default tier runs a model above medium effort (for example Opus@high between tiers 3 and 4); a finer default ladder needs per-effort ratings (model-tiers.md §5). Users can add such tiers in config.
- Live verification on Linux.
- The hands-on tray check on KDE Plasma (SNI), GNOME with AppIndicator and an XEmbed panel (XFCE): icon legibility at 22–24 px on light and dark panels, including a panel whose theme is the opposite of the app's (the icon looks heavy there), left-click toggle, context menu, placement next to the icon, Open at Login across a re-login, and Wayland focus on show.
- AppImage, Flatpak, Snap and distro packages for the tray app (Flatpak's sandbox cannot run the host CLI). Build provenance attestations for release assets.
- At login the tray app waits up to a minute for a StatusNotifierItem tray host; a panel with only an XEmbed tray (i3bar) gets the icon after that minute.
- Two tray app launches in the same instant can both run.
- The release's Linux and macOS asset jobs run after `npm publish`, so a failure there that a rerun cannot fix is fixed forward in a patch release; CI builds and tests `linux/` on both release runners first.
- The tray app ignores `X-GNOME-Autostart-enabled=false` in its autostart entry; its desktop id is not reverse-DNS; the single-instance hand-off passes no GNOME Wayland activation token; the tray icon follows the app's palette, not the panel's.
- Immutable releases.
- The Homebrew gate holds the whole release, npm and Linux included, until every dependency is a day old; split the tap update into its own rerunnable job if that ever blocks a hotfix.
- The menu bar and tray icons fill when any pool's pace exceeds 1, which an untouched weekly pool reaches hours after its reset.
- Tier editor "Reset to Defaults" removes a saved custom tier list without confirmation or undo.
- `schmear usage` prints reset times as ISO timestamps; the apps print "resets in 3h 11m".
- Neither app shows its own version, and zip and Linux installs get no notice of a newer app; they only say when the CLI is too old for them.
- GitHub release notes are generated from pull requests, not the CHANGELOG section.
- The README's Linux uninstall line hardcodes `~/.local/share`, while `install.sh` honours `XDG_DATA_HOME`.
- An agent still running a pre-upgrade `schmear serve` reads `ok` until it restarts; config files cannot show it.
- An entry from a different schmear install (npm beside Homebrew) reads `ok`, though that agent runs the other copy.
- A Claude local or project entry that shadows the user entry is not reported in `hosts`.
- A Reconnect that succeeds while a poll is in flight shows the stale host rows until the next poll.
- Reconnect runs `init --yes`, which also turns on a newly detected subscription the user never chose; the button does not say so.
- The macOS attention icon replaces the schmear glyph instead of badging it, as Linux does; "no reading has a pool" raises the same warning as a disconnected agent.
- The apps say only "isn't connected" where the CLI names the missing path; Linux has no Connections heading; macOS keeps an old Reconnected hint across a second Reconnect.
- A reply joins a worker's separate agent messages with no separator (R36); join them with a blank line once ACP marks message boundaries.
- The Grok spend guard (§8.3) reads a missing `onDemandCap` or `prepaidBalance` as 0.
- Antigravity AI credits are assumed off; with them on, a task that crosses a limit may spend them (§8.4).
- The interactive permission-prompt check at each driver (deferred past v1, decided 2026-11-21).
- The credit key command (`keyCommand`) has no timeout, so a Keychain GUI prompt blocks its task until the host's timeout.
- A torn ledger append followed by another append leaves one invalid complete line, which skips the credit pool (fail-closed) until the line is removed by hand.
- Init's TOML rewrite drops a trailing comment on one of its own key lines, and a quoted key (`"command" = …`) makes it refuse with "edit it by hand"; a dangling symlinked config is replaced by a regular file.
- While a local or project Claude entry shadows the user entry, every init run removes and re-adds the user entry.
- A grandchild of an agy usage probe that calls `setsid` escapes the process-group kill (bounded by the 90 s timeout; CodexBar's environment-marker sweep is not built).
- Claude's usage probe omits CodexBar's `remoteControlAtStartup:false`; Codex has no `account/read` plan fallback.
- A task allowed only `claude-credits` still runs Claude's usage read (OAuth, else `get_usage`), since credit readings are refreshed inside the Claude read.
- A resumed credit run settles its cost net of the handle's, which under-counts if the SDK's resumed total omits earlier turns (bounded by the Console spend limit; unverified).
- A permission prompt still open at teardown is withdrawn only after the worker exits (up to 5 s when it ignores SIGTERM).
- Antigravity's user-level `timeoutSeconds` (§12) is unverified live: an Antigravity driver may cut `delegate` at 180 s.

## 19. Research log

Setup:
- `B=<probe dir>`, `P=docs/probes`. Adapters were installed into their own new empty directories under `$B/adapters/` (`claude-agent-acp@0.109.1`, `codex-acp@2.9.0`, registry `antigravity-acp` 1.5.2, and `npm pack` of `@agentclientprotocol/sdk@2.9.1`, `@modelcontextprotocol/sdk@1.32.2`, `add-mcp@2.6.1`).
- Fixtures from `sh $P/make_fixture.sh <dir>`: `README.md` first line `PINEAPPLE`, `AGENTS.md` `KIWI`, `CLAUDE.md` `LIME`, `GEMINI.md` `PLUM`, `.grok/rules` `FIG`, `.agents/rules` `PEAR`, `.claude/rules` `DATE`. `acp_probe.py` prompts: `rules` (list the codewords), `task` (reply with README's first line), `cancel` (long task cancelled after 2 s).
- macOS arm64, Node 26.12.1, claude 2.1.330, codex-cli 0.147.0, agy 1.5.14, grok 1.0.77. No credential value was printed into any log below.

**R1: Claude via claude-agent-acp 0.109.1: PASS.** `python3 -I $P/acp_probe.py claude $B/repo-claude … -- node $B/adapters/claude-acp/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js`
```
initialize ok protocolVersion=1 agentInfo={"name": "@agentclientprotocol/claude-agent-acp", "title": "Claude Agent", "version": "0.109.1"}
configOption id=mode category=mode current=auto values=['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']
prompt[rules] reply='LIME DATE'
prompt[task] reply='PINEAPPLE'
prompt[cancel] stopReason=cancelled
```

**R1b: Claude with the user's binary: PASS.** `CLAUDE_CODE_EXECUTABLE=$(command -v claude)` (2.1.330): `prompt[custom] reply='PINEAPPLE'`.

**R2: Codex via codex-acp 2.9.0 (bundled codex 0.171): PASS.**
```
configOption id=mode category=mode current=agent values=['read-only', 'workspace-write', 'agent', 'agent-full-access']
prompt[rules] reply='KIWI'
prompt[task] reply='I’ll read only `README.md` and return its first line.PINEAPPLE'
prompt[cancel] stopReason=cancelled
```

**R2b: Codex with the user's binary: PASS.** `CODEX_PATH=$(command -v codex)` (0.147.0): `prompt[custom] reply='OK'`; stderr `failed to load models cache: missing field supports_parallel_tool_calls`, a cache the bundled 0.171 wrote in R2. This is why workers run the user's binary.

**R3: Grok via `grok --no-auto-update agent stdio` 1.0.77: PASS.** `agentCapabilities={"loadSession": true, …, "sessionCapabilities": {"list": {}, "resume": {}, "close": {}}}`; `prompt[rules] reply='NONE'`; `prompt[task]` … `PINEAPPLE`; `prompt[cancel] stopReason=cancelled`.

**R4: Antigravity via `agy acp` 1.5.14: PASS.** `configOption id=mode … values=['default', 'accept-edits', 'auto', 'plan']`; `prompt[rules] reply='KIWI PLUM PEAR'`; `prompt[task] reply='PINEAPPLE'`; `prompt[cancel] stopReason=cancelled`.

**R4b: Registry `antigravity-acp` 1.5.2: FAIL.** `session/new` → `-32000 Authentication required`; with `--auth=oauth-personal` and browser-refusing shims: `authenticate > 60s` (it wanted a browser OAuth).

**R5: Edit requests** (prompt "create inside.txt" then "create ../logs/outside-<label>.txt"; the probe allowed an edit only inside cwd).

| Run | Agent and setup | Result |
|---|---|---|
| `wclaude` | Claude, mode `default` | `request_permission kind=edit title='Write inside.txt' -> allow_once`; outside `-> reject_once` |
| `wcodex` | Codex, mode `workspace-write` | no permission requests; outside reply `DENIED` |
| `wgrok` | Grok | no permission requests; both files created |
| `wagy` | agy, mode `default` | `request_permission kind=edit title='File inside.txt' -> allow_once`; outside `-> reject_once` |

**R6: Codex shell inside its sandbox** (`scodex`, `workspace-write`): no permission requests; the outside write failed `zsh:1: operation not permitted`.

**R7: Codex escalation** (`rocodex`, mode `read-only`): `request_permission kind=execute title='echo OK > inside.txt' options=['allow_once', 'allow_always', 'reject_once'] -> allow_once`; both files created: approving a Codex request runs the command outside its sandbox.

**R8: MCP hosts as clients** (`sh $P/host_mcp_probe.sh <host> parallel …`; seconds from the first call start).

| Host | `clientInfo` (protocol) | Without `readOnlyHint` | With `readOnlyHint` |
|---|---|---|---|
| Claude Code 2.1.330 | `{"name": "claude-code", …}` (2025-11-25) | A 0.0–5.0, B 5.4–10.5: serial | A 0.0–5.0, B 0.3–5.3: concurrent |
| Codex 0.147.0 | `{"name": "codex-mcp-client", …}` (2025-06-18) | serial | concurrent |
| Grok 1.0.77 | `{"name": "grok-shell-probe", …}` (2025-11-25); server `brokerx` saw `grok-shell-brokerx` | concurrent | not run |
| Antigravity | `{"name": "antigravity-client", "version": "v1.0.0"}` (2025-11-25) | A 0.0–5.0, B 6.8–11.8: serial | not run |

**R9: Codex tool timeout.** `timeout:75`: the call succeeded after 75.0 s; the documented default is 60 s, so init sets it regardless.

**R10: Antigravity tool timeout and settings.** `timeout:330`: cancelled at +180.0 s; with `"timeoutSeconds":400` in `.agents/mcp_config.json`, a 200 s call succeeded. `agy -p … --settings` rejects `mcpServers` and `useAiCredits` ("unknown setting").

**R11: Claude Code and Grok timeouts (docs).** code.claude.com/docs/en/mcp "Time limits on MCP tool calls": about 28 h per call, 30 min idle for stdio, a per-server `timeout` ≥ 1000 floors the idle timeout. `~/.grok/docs/user-guide/07-mcp-servers.md:34`: `tool_timeout_sec` default 6000.

**R12: Antigravity usage.** `AGY_CLI_DISABLE_AUTO_UPDATE=true agy -p /usage --output-format json`: `status SUCCESS`, `num_turns 0`, zero tokens.
```
Gemini Models	Weekly Limit Remaining	84%	2026-11-28T10:20:26Z
Gemini Models	Five Hour Limit Remaining	99%	2026-11-22T00:37:11Z
Claude and GPT models	Weekly Limit Remaining	0%	2026-11-25T01:20:13Z
Claude and GPT models	Five Hour Limit Remaining	disabled
Gemini 4 Argon	Gemini 4 Argon Weekly Limit	91%	2026-11-28T10:19:13Z
```
Bucket fields: `id`, `name`, `description`, `window`, `remaining_fraction`, `reset_time`, `disabled`. The exhausted bucket reads "If on a supported paid plan, you can use AI credits in the interim".

**R13: Codex rate limits, token-free.** `python3 -I $P/codex_ratelimits.py "$(command -v codex)"`: result keys `rateLimitResetCredits`, `rateLimits`, `rateLimitsByLimitId`; `rateLimits` keys `credits`, `individualLimit`, `limitId`, `limitName`, `planType` (a Free-plan account returned `free`), `primary`, `rateLimitReachedType`, `secondary`, `spendControlReached`; `primary: {'usedPercent': 83, 'windowDurationMins': 43200, 'resetsAt': 1795892366}`, `secondary: None`.

**R14: Grok billing over ACP.** `python3 -I $P/grok_billing_keys.py`: `{"config": {"currentPeriod": {"type", "start", "end"}, "onDemandCap": {"val"}, "onDemandUsed": {"val"}, "prepaidBalance": {"val"}, "isUnifiedBillingUser", "billingPeriodStart", "billingPeriodEnd"}, "subscription_tier"}`; `subscription_tier: <tier> | creditUsagePercent: None | currentPeriod: {'type': 'USAGE_PERIOD_TYPE_WEEKLY', 'start': '2026-11-15T00:00:00+00:00', 'end': '2026-11-22T00:00:00+00:00'}`.


**R16: Login state.** `claude auth status --json`: `loggedIn: True, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: <plan>`. `codex login status`: `Logged in using ChatGPT`.

**R17: Binary strings.** grok 1.0.77: `rate_limited`, `is_rate_limited`, `RetryState::Exhausted`. codex 0.147.0: `env_vars`, `tool_timeout_sec`, `default_tools_approval_mode`.

**R18: Env inheritance into worker-spawned MCP servers.** A marker in the adapter's env reached `mcp_logger.py` for claude, agy and grok, not codex. Worker-side clientInfo: `antigravity-client`, `grok-shell-probe`, the same names a driver sends.

**R21: Source reads.** claude-agent-acp 0.109.1 `dist/claude-cli.js:19–27`; `dist/v1/acp-agent.js:26, 4870, 5110–5127, 7581, 7637–7646`; `dist/result-end.js:9–12`; `dist/hide-claude-auth.js:1–9, 55–103, 105–116`; `dist/auth-status.js:1–30, 228–268`; `dist/session-effort.js:82–121`. claude-agent-sdk 0.3.330 `sdk.d.ts:2069–2073, 3378–3396, 4609–4720, 6237–6250, 6275`. codex-acp 2.9.0 `dist/index.js:40326, 40781–40784, 43254–43307, 43383–43395, 43999–44011, 46468, 48851–48873, 58113–58115`. `@agentclientprotocol/sdk` 2.9.1 `dist/v1/stable/bindings.d.ts:188–231, 616–640`, `schema/v1/schema.json:6691`. `@modelcontextprotocol/sdk` 1.32.2 `dist/esm/server/index.d.ts:121–125`, `mcp.d.ts:161–168`, `index.js:340–372`, `types.js:335–345`, `shared/protocol.js:8`. add-mcp 2.6.1 `dist/chunk-JZK2SME6.js:1029–1062, 1236–1254`.

**R23: MCP servers in workers.** `sh $P/a1_fixture.sh <dir> <logdir>` declares a logger per agent config file. Claude's `.mcp.json` and Codex's `.codex/config.toml` loggers started in workers; the Codex model replied `NONE` to "list your MCP servers" with servers loaded (MCP tools are deferred), so only logger logs count. MCP calls ("Call the MCP tool probe_sleep…"): Grok `tool_call title='search_tool'`, `title='use_tool'`, `permissions seen: []`; agy `request_permission kind=other title='Run mcp_probe_probe_sleep' options=['allow_once', 'reject_once']`, the same with `readOnlyHint`.

**R24: Claude billing identity.** Probe without a prompt: `_auth/status_update keys=['account', 'kind', 'label'] kind=account label=Claude <plan>` at +0.3 s and +0.7 s, before `session/new ok`.

**R26: Claude parity.** `sh $P/parity_fixture.sh $B/par/repo $B/par/logs`; native `claude -p --output-format stream-json --verbose "Reply with exactly: OK"`; worker `acp_probe.py` with `CLAUDE_CODE_EXECUTABLE=$P/tee_exec.sh`; `python3 -I $P/parity_claude.py …`:
```
model, permissionMode (auto), output_style, apiKeySource, agents: equal
tools: native-only ListMcpResourcesTool, ReadMcpResourceTool, ReadMcpResourceDirTool and every mcp__* tool; worker-only EnterPlanMode, ExitPlanMode, SendToProject, SendToProjectContext; AskUserQuestion in neither
mcp_servers: same names and sources; worker statuses pending where native connected
skills: worker-only send-to-project | plugins: native-only 1 built-in
worker CLI argv: --tools=default --setting-sources=user,project,local --disallowedTools=AskUserQuestion --permission-prompt-tool=stdio --permission-mode=auto --allow-dangerously-skip-permissions
```
R26b: `CLAUDE_CODE_ENTRYPOINT=sdk-ts claude -p`: the built-in plugin is gone.

**R27: Codex parity.** `python3 -I $P/parity_codex.py live "$(command -v codex)" <repo> --trust` against codex-acp run with `CODEX_PATH=$P/tee_exec.sh`:
```
native: gpt-5.6-terra | on-request | reviewer user | workspaceWrite | instructionSources [<repo>/AGENTS.md] | skills pk-par-skill +16 | mcp pk_par_codex +5
worker: gpt-5.6-terra | on-request | reviewer auto_review | workspaceWrite | effort medium | instructionSources [<repo>/AGENTS.md] | skills pk-par-skill +20 | mcp +5
worker thread/start config: {"features":{"cwd_relative_turn_diffs":false},"skills":{"config":[{"name":"visualize:visualize","enabled":false}]},"projects":{"<wt>":{"trust_level":"trusted"}}}
```
The four extra skills were plugin skills still loading; read 3 s later the sets matched. Merged `config/read`: `approval_policy`, `approvals_reviewer`, `sandbox_mode`, `default_permissions` all null; the project layer was absent from it.

**R28: Grok inventory.** `grok inspect --json` in the checkout: `projectTrusted false | project layer .grok/config.toml | instructions 1 | hooks 2`. `agent stdio` `session/new` returns `_meta {currentWorkingDirectory, isGitRepo, gitRoot, …}`, model and effort data, and no command list.

**R29: agy parity.** `agy -p /skills --output-format json` (`num_turns 0`) lists 8 skills including `pk-par-skill`. The ignored workspace logger `pk_par_agy` logged `initialize` from `antigravity-client` for `agy -p` and for an `agy acp` worker in the same checkout. `/rules` and `/memory` go to the model (`num_turns 1`).

**R31: Elicitation.** Every host declares form elicitation: `claude-code` `{form: {}, url: {}}`; `codex-mcp-client` `{form: {}, url: {}}`; `grok-shell-*` `{form: {schemaValidation: true}, url: {}}`; `antigravity-client` `{form: {}, url: {}}`. `host_mcp_probe.sh <host> elicit:0[:2]` (a form `elicitation/create` with a titled enum mid-call): `claude -p` → `cancel` at once; with an `Elicitation` hook that accepts after 3 s → `{"action": "accept", "content": {"option": "allow_once"}}`, two at once both answered; with server `timeout` 5000 and the hook sleeping 8 s → `notifications/cancelled` at 5.0 s, so the tool timer runs during a wait. `codex exec` → `decline`; `grok -p` and `agy -p` → `cancel`, at once. Interactive rendering is a deferred user check (§18).

**R33: Tier controls** (2026-11-21; full tables and grid in `docs/research/model-tiers.md`; raw output in `$B/tiers/out/`). `T=$B/tiers`; `$P/config_probe.py` sends `initialize`, `session/new`, `session/close` and never a prompt, in a fresh `git init` dir:
```
CLAUDE_CODE_EXECUTABLE=$(command -v claude) python3 -I $P/config_probe.py claude $T/run $T/out -- node $B/adapters/claude-acp/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js
CODEX_PATH=$(command -v codex) python3 -I $P/config_probe.py codex $T/run $T/out -- node $B/adapters/codex-acp/node_modules/@agentclientprotocol/codex-acp/dist/index.js
python3 -I $P/config_probe.py grok $T/run $T/out -- grok --no-auto-update agent stdio
AGY_CLI_DISABLE_AUTO_UPDATE=true python3 -I $P/config_probe.py agy $T/run $T/out -- agy acp
```
- claude: `model` values include `haiku`, `sonnet`, `opus`, `fable` (current `opus`); `effort` (category `thought_level`) `default, low, medium, high, xhigh, max`, varying with the model.
- codex: `model` `gpt-5.6-terra`, `gpt-5.6-luna`; `reasoning_effort` (`thought_level`) `low … max, ultra`; Luna has no `ultra`.
- grok: `model` current `grok-4.6`, options only `grok-4.7`; no effort option; `models.availableModels[grok-4.7]._meta` `reasoningEffort: "high"`, `reasoningEfforts` `xhigh, high, medium, low`.
- agy: `model` `gemini-4-neon` (current), `gemini-4-carbon` (1.5.16), `gemini-4-argon`, `gemini-4-hydrogen`, two orchestrators, `gemini-3.8-flash`, `claude-opus-5-5`, `claude-sonnet-5-5`, `gpt-oss-120b-medium`; `thought_level` `low, medium, high, xhigh`; per-model efforts from the suffixed `models` ids.
- The grid (`$P/grid.py`, AA Intelligence Index v5.0.1 per effort) is model-tiers.md §3–4.

**R34: Claude `get_usage`, token-free: PASS.** `python3 -I $P/claude_get_usage.py "$(command -v claude)" $B/getusage/run` (claude 2.1.330; sends `initialize` and `get_usage {skip_behaviors: true}` over stream-json, no user message, reads no credential):
```
argv: --output-format stream-json --verbose --input-format stream-json --strict-mcp-config
+0.3s message type=system subtype=hook_started
+0.3s message type=system subtype=hook_started
+0.5s message type=system subtype=hook_response
+0.6s control_response request_id=init subtype=success
+0.7s control_response request_id=usage subtype=success
keys: ['behaviors', 'rate_limits', 'rate_limits_available', 'session', 'subscription_type']
subscription_type: <plan> | rate_limits_available: True
rate_limits keys: ['amber_cistern', …, 'cedar_ember', …, 'extra_usage', 'five_hour', …, 'limits', …, 'model_scoped', …, 'seven_day', 'seven_day_breakdown', 'seven_day_cowork', 'seven_day_oauth_apps', 'seven_day_omelette', 'seven_day_opus', 'seven_day_sonnet', …]
  five_hour: None
  seven_day: {'utilization': 6, 'resets_at': '2026-11-28T21:00:00.575560+00:00'}
  seven_day_oauth_apps: None
  seven_day_opus: None
  seven_day_sonnet: None
  model_scoped: {'display_name': 'Fable', 'utilization': 4, 'resets_at': '2026-11-28T21:00:00.575720+00:00'}
  extra_usage: {'is_enabled': False}
behaviors is null: True | exit 143 | 1.5s
```
The user's SessionStart hooks ran (`hook_started`); exit 143 is the probe's SIGTERM.

**R35: grok.com billing call: NOT RUN.** A probe that reads `~/.grok/auth.json` in memory and POSTs `GetGrokCreditsConfig` was denied by the session's auto-mode classifier before it was written or run ("Permission for this action was denied … [Unauthorized Access]"). No file was written and no request sent. Live verification of §8.3 steps 2–3 is a user-run step.

**R36: live readers and route: PASS** (2026-11-21). `XDG_CONFIG_HOME=$T XDG_STATE_HOME=$T node dist/cli.js usage` with Claude, Codex and agy consented (Grok left out, R35): Claude `claude` 7d 91% and `claude-fable` 7d 95% from get_usage with no hooks warning; Codex `codex` 30d 10%; agy `agy-gemini` 7d 74% / 5h 100%, `agy-argon` 7d 37%, `agy-3p` 7d 0%; the agy and Claude numbers match an independent statusline reading taken the same minute. `node --test --test-name-pattern='route: (claude|codex|agy) ' test/live/route.test.ts`: 3/3 done with `PINEAPPLE`, each under the guard. Codex's reply was "I’ll check the file.PINEAPPLE": separate agent messages are joined with no separator.

**R37: live parity: PASS** (2026-11-21). `node --test --test-name-pattern='parity: (claude|codex|agy) ' test/live/parity.test.ts`, Grok left out (R35). Codex equal on model `gpt-5.6-terra`, `on-request`, `user`, `workspaceWrite`, `AGENTS.md`, 21 skills, MCP names, and the three listed overrides. Claude equal on model, `auto`, output style, `apiKeySource: none`, agents, plugins, MCP servers, instruction files; first run differed on six slash commands from one of the user's MCP servers, the rerun showed three user MCP servers `pending` in the worker's `system/init` and `connected` under `-p`. agy: first run differed on `pk_par_agy` started (worker only), because `agy -p /skills` starts no MCP server; with a one-turn native prompt both started it, skills equal.

**R38: live tiers: PASS** (2026-11-21). `node --test --test-name-pattern='tiers: (claude|codex|agy) ' test/live/tiers.test.ts`, tier 1 effort low pinned, `agy-3p` cells `null`, Grok left out (R35): Claude `haiku` at `low`, Codex `gpt-5.6-luna` at `max`, agy `gemini-4-hydrogen` at `low`, each reported as expected. Codex's 30-day pool fell from 10% to 7% across the R36–R38 live runs (route, parity, tiers), about 1% per one-turn task at `max` effort.

**R39: live routing: PASS** (2026-11-21). `npm run build && node --test --test-name-pattern=routing test/live/routing.test.ts`, `clientInfo.name: "claude-code"`, Claude, Codex and agy consented, no `overageOff` confirmed, Grok left out (R35): Codex and agy pools listed as `skipped: overage not confirmed off`; Claude `pace 0.87` served vs `0.90` from the CLI (the 5% driver reserve); `next: tier 1 → claude:haiku (medium)`; the routed task ran on `claude` / `haiku`, `status: done`, `PINEAPPLE`. One `schmear usage` run earlier saw `agy /usage timed out after 30000 ms`; the rerun answered in 11 s.

**R40: live resume: PASS for Claude** (2026-11-21). `node --test --test-name-pattern=resume test/live/resume.test.ts`: Claude turn 1 `OK` with a `session:` handle (`claude:haiku` at `low`), turn 2 resumed in the same cwd answered `MANGO` and returned a handle; the account check after `session/resume` passed. Codex and agy skipped (overage not confirmed off), Grok left out (R35).

**R41: live init and the live suite: PASS** (2026-11-21; Codex credits, Grok on-demand/prepaid and Antigravity AI credits confirmed off; Grok usage read approved). Real `node dist/cli.js init --yes` (Claude consent typed, credit lane declined) registered schmear in Claude Code (`claude mcp get`: Connected), Codex, Grok and Antigravity. Grok usage: source step grok.com, `grok` 7d 100% left, guard (§8.3) clear. `SCHMEAR_LIVE_OVERAGE_OFF=codex,grok,agy SCHMEAR_LIVE_GROK=1 node --test test/live/*.test.ts`: parity and resume PASS for all four (Grok's first live runs); route and tiers PASS for Claude, Grok, agy (Codex skipped by the guard once its pool fell to 5%); nested PASS for Claude, Grok, agy, and Codex replied `mcp__schmear__usage` (the run's regex missed host-prefixed names, since fixed); routing PASS with tier 1 → `grok:grok-4.7`, the first live cross-provider pick.

**R42: CodexBar's credential reads, adopted as the fallback after each CLI read** (owner rulings 2026-11-24: "let's audit and copy them", then "CLI first, keep PAT", which moved the CLI read ahead of CodexBar's order; CodexBar a26ca57, `CB/` = `Sources/CodexBarCore/`). Claude: `CB/Providers/Claude/ClaudeProviderDescriptor.swift:778-805` (Auto falls back on any OAuth error), `ClaudeConfigPaths.swift:87-101`, `ClaudeOAuth/ClaudeOAuthCredentials.swift:337-480` and `ClaudeOAuthCredentials+SecurityCLIReader.swift:14,247-277` (credential order, `/usr/bin/security`), `ClaudeOAuthCredentialModels.swift:106-135` (payload), `ClaudeOAuth/ClaudeOAuthUsageFetcher.swift:61-135,212-224` (request and User-Agent), `ClaudeScopedWeeklyLimitMapper.swift:22-26` and `ClaudeWeb/ClaudeWebExtraRateWindowParser.swift:51-63` (`limits[]` rows), `ClaudeUsageFetcher.swift:1032-1046` (extra-usage cents). Codex: `docs/codex.md:36-44` and `Providers/Codex/CodexProviderDescriptor.swift:492-525` (order, fallback rule), `CodexPAT/*`, `CodexOAuth/CodexOAuthCredentials.swift:51-62,97-112,210-230,273-292,483-560`, `CodexOAuthUsageFetcher.swift:379-415`, `CodexCLIUserAgent.swift`, `CodexSpendControlLimitMapping.swift`. Antigravity: `docs/antigravity.md:130-318`, `Providers/Antigravity/AntigravityStatusProbe.swift:1222-1300,1546-1555,1715-1726` (process filter, quota request), `AntigravityQuotaSummaryParser.swift:95-115`, `AntigravityProviderDescriptor.swift:32` (`supportsCredits: false`). Grok already matched `docs/grok.md` and did not change. Not adopted: Claude Web and browser cookies, the Claude token refresh into CodexBar's own cache (D2: a due token is never refreshed; the CLI refreshes its own), Codex's web dashboard, Antigravity's IDE and Google OAuth steps. Unit tests inject every fetch, file, `security`, `ps`, `lsof` and POST. With the CLIs working, `schmear usage --json` shows `source` `cli`, `rpc` and `cli`; a credential step shows only after a CLI failure, so its live check needs one (for example a `claude` that cannot start); the macOS Keychain read assumes that `security find-generic-password -w` shows no dialog for Claude Code's item (CodexBar `docs/claude.md:194`), which the owner checks once.

**R43: agy acp in Gemini API key mode: PASS** (2026-11-24, agy 1.5.16, fake key only). `python3 -I $P/agy_key_acp.py <new scratch dir>`. `authMethods`: `oauth-personal`, `oauth-business`, `gemini-api-key`, `agent-platform`. Recipe: `agy acp --gemini-dir <dir>` with `GEMINI_API_KEY` in env, then `authenticate {methodId: "gemini-api-key"}` before `session/new`; agy's log then reads `authenticated via gemini_api_key`, mode `gemini-api`. The absolute and the `$HOME`-relative `--gemini-dir` both work (relative resolves against `$HOME`, not the cwd); everything agy writes lands in `<dir>/antigravity-cli` and `<dir>/config`. `modelProvider` is not needed: runs with and without `{"modelProvider":"gemini"}` in `<dir>/antigravity-cli/settings.json` were identical. Key-mode options: `model` `gemini-4-neon`, `gemini-4-carbon`, `gemini-4-hydrogen`, `gemini-4-argon`, `gemini-3.8-flash`, `gemini-3.7-flash`, `gemini-3.6-flash`, `gemini-3.1-pro` (default); `thought_level` `low` (default), `high`; `mode` `default`, `accept-edits`, `plan`. The fake key's `Hi` ends `end_turn` with the agent message `⚠ agent executor error: generating and executing: Error 400, Message: API key not valid. Please pass a valid API key., Status: INVALID_ARGUMENT, ... reason:API_KEY_INVALID` (J1), not a JSON-RPC error. `~/.gemini` listing (34,137 entries, path, mtime, size) identical before and after (J2); no scratch file holds the key or a fragment of it (J3). **The scratch dir does not isolate the saved login:** it is in the macOS keyring, not `~/.gemini`. `session/new` without `authenticate` succeeds on that login (log: `authenticated via keyring`, mode `ccpa`, the subscription model list), and so does `session/new` after `authenticate` fails, which it does with `-32602 GEMINI_API_KEY is not set; pass an API key in _meta.apiKey or set the GEMINI_API_KEY environment variable.` when the key is unset. A credit run must therefore fail on any `authenticate` error and never skip it.

## Main unresolved uncertainty

Every Codex and Grok tier entry rests on one aggregate index with most per-effort scores missing, from free-plan probes (model-tiers.md §5); Claude's `get_usage` fallback is an experimental SDK method, and whether `api.anthropic.com/api/oauth/usage` keeps answering schmear's reads is unverified (it falls through to `get_usage` when not); and the shape of Anthropic's exhausted-credit error is untested live.
