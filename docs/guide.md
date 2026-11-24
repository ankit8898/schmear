# Guide

Reference for [schmear](../README.md). Safety and vendor terms are in [safety.md](safety.md).

## Terms

- **Driver**: the agent you type into. **Worker**: the CLI that runs a delegated task.
- **Pool**: one quota that can run out, with one or more windows, such as Claude's 5-hour and weekly limits. Antigravity has three: `agy-gemini` (Gemini models), `agy-argon` (Gemini 4 Argon) and `agy-3p` (its Claude and GPT models).
- **Lane**: one model on one subscription, such as `grok@default:grok-4.7` (`<agent>@<nickname>:<model>`). Its key (`claude`, `codex`, `grok`, `agy-gemini`, `agy-argon`, `agy-3p`, `claude-credits`) names the route; several lanes can draw on one pool.
- **Tier**: the weakest model class a task may use, from 1 (Haiku-class) to 4 (Fable-class) by default. A task may run higher, never lower.
- **Pace**: per window, the share of quota left above the floor or reserve, divided by the share of time left until reset. Above 1, quota would go unused at an even rate. The highest pace goes first.

## How it works

After `schmear init`, restart your agent and work as usual, for example: *"Have another agent write tests for src/parse.ts in a new worktree."* schmear's MCP instructions tell the agent when to delegate, and each result names the worker that ran it.

- **Delegate.** Claude Code calls `delegate({tasks:[{prompt:"Add tests for src/parse.ts ...", cwd:"/repo/.wt/parse-tests", tier:2}]})`, having made that worktree itself. schmear picks the best-paced lane whose model meets tier 2, sends the prompt unchanged, and returns the reply with `provider`, `model`, `effort` and `session`. Any permission request from the worker appears in Claude Code as "agy worker on 'Add tests for src/parse.ts' asks: ...".
- **Fan out.** One call carries 1 to 8 tasks that run concurrently and return together. Three read-only reviews with the same `cwd` share that directory and spread across the lanes in the pick's tie band.
- **Check quota.** `schmear usage`, or the `usage` tool, prints every pool with its windows, pace and status, and the lane the next task of each tier would take.
- **Continue.** Pass an earlier result's `session` back to `delegate` to resume that worker on the same provider and model.
- **Scope.** schmear only routes. The driver owns everything else: worktrees, read-only versus writing, commits, merging, ordering.

`schmear usage` in a terminal has no driver, so it applies no reserve (`schmear usage --driver claude` applies Claude's, as the `usage` tool does when Claude is your agent):

```
driver: unknown

## claude@default
pool claude@default: short 5h 74% left, resets 2026-11-23T00:20:00.088Z; period 7d 50% left, resets 2026-11-26T00:00:00.088Z | pace 1.10 | ok
pool claude-fable@default [fable]: period 7d 77% left, resets 2026-11-26T00:00:00.088Z | pace 1.72 | ok

## codex@default
pool codex@default: period 30d 5% left, resets 2026-11-28T18:59:26.000Z | pace 0.15 | ok

## grok@default
source: grok.com
pool grok@default: period 7d 100% left, resets 2026-11-29T00:00:00.000Z | pace 1.14 | ok

## agy@default
pool agy-gemini@default: period 7d 62% left, resets 2026-11-28T10:20:26.000Z; short 5h 87% left, resets 2026-11-23T01:59:42.000Z | pace 0.76 | ok
pool agy-3p@default: period 7d 0% left, resets 2026-11-25T01:20:13.000Z | pace - | out: period window 0% left, threshold 2%
pool agy-argon@default: period 7d 37% left, resets 2026-11-28T10:19:13.000Z | pace 0.44 | ok

next: tier 1 → grok@default:grok-4.7 (medium)
next: tier 2 → grok@default:grok-4.7 (medium)
next: tier 3 → claude@default:opus (medium)
next: tier 4 → claude@default:fable (medium)
```

## Install

Requires Node 22.18 or newer on macOS or Linux (Windows is not supported), and at least one of the four CLIs, logged in. `--omit=optional` skips ~724 MB of bundled Claude and Codex binaries from the ACP adapters because schmear launches your own `claude` and `codex` CLIs. Install as in the [Install](../README.md#install); `schmear init --yes` uses every subscription it finds without asking.

From source: `git clone https://github.com/kevin1chun/schmear && cd schmear && npm ci --omit=optional && npm run build && npm i -g .`

Init does the following and nothing else:

- Detects `claude`, `codex`, `agy` and `grok` on your PATH, prints each one's path and version, and records each binary's absolute path in `~/.config/schmear/config.json`. `schmear serve` never resolves PATH.
- Shows one checklist of the subscriptions it found, all ticked; untick any you do not want schmear to use. Later runs keep your unticked ones unticked.
- Asks nothing about paid overage. Codex and Grok report it in their usage read, so schmear skips Codex while you hold Codex credits and Grok while its on-demand cap or prepaid balance is above zero. Antigravity does not report its AI-credits setting; schmear assumes it is off, so turn it off in Antigravity if you do not want a task that crosses a limit to spend them.
- Reads usage once and prints each pool's remaining quota; `schmear usage` shows the full detail.
- Registers the server in every host it found on PATH (Claude Code, Codex, Grok, Antigravity), even one whose worker you declined or whose detection failed: consent covers only the worker role, so you can still delegate *from* that host. The entry runs `<node> <cli> serve` with absolute paths: `node` and `schmear` on your PATH when they resolve to the ones running init, so a Homebrew upgrade keeps them, otherwise the running `node` and `cli.js`. A host started without your shell's PATH still finds them. Each entry gets a 24 hour tool timeout (Codex defaults to 60 s, Antigravity to 180 s), and Codex's also gets `env_vars = ["SCHMEAR_WORKER"]`.
- Leaves an entry alone when the keys init writes match, and otherwise replaces those keys and reports it "updated"; keys you added stay. In Claude Code the replacement is `claude mcp remove -s user schmear` followed by `claude mcp add-json -s user`, and a project or local entry that shadows the user entry is reported.
- Copies the [schmear skill](../skills/schmear/SKILL.md), which teaches the agent when and how to delegate, into each host's global skill folder: `~/.claude/skills/`, `~/.agents/skills/` (Codex), `~/.grok/skills/` and `~/.gemini/config/skills/` (Antigravity), the folders the [`skills` CLI](https://github.com/vercel-labs/skills) uses. A copy that differs from the packaged one is replaced and reported "skill updated". For any other agent, run `npx skills add kevin1chun/schmear`.
- Checks `claude mcp get schmear` and `<host> mcp list` for each registered host, and prints the output only when the host does not list schmear.
- Refuses to run from an npx cache.

`--yes` skips the checklist and uses the subscriptions it would have ticked. The [credit lane](#credit-pools) is set up separately, with `schmear credits`.

State lives in `~/.local/state/schmear/` (usage cache, offered-model lists, credit ledger, the secret that signs `session` handles) and `~/.config/schmear/config.json`. `schmear uninstall` removes the `schmear` entry from each host, the `schmear` folder from each skill folder above, and both directories; then remove the command with `npm rm -g schmear` or `brew uninstall schmear`.

## Tested versions

Tested against `claude` 2.1.330, `codex` 0.147.0, `grok` 1.0.77 and `agy` 1.5.14. The package pins `@agentclientprotocol/claude-agent-acp` 0.110.0 and `@agentclientprotocol/codex-acp` 2.10.0. Usage reads rely on undocumented vendor interfaces, so a CLI update can break them. They fail closed: a pool whose usage cannot be read is skipped.

## Routing

- **Tiers are a floor.** Tiers are an ordered list, weakest first. The default has four, referenced to Anthropic's Haiku, Sonnet, Opus and Fable at medium effort; each tier names the `lane:model@effort` entries that qualify, and the ratings and sources are in [`research/model-tiers.md`](research/model-tiers.md) §3; the list is [below](#tier-configuration). `tier` is 1 to the list's length. A task may run on a stronger tier, never a weaker one. There is no `effort` parameter: more thinking is a higher tier. Models an account does not offer are dropped.
- **Pace.** Each usage window gives `(remaining - threshold) x periodHours / hoursUntilReset`, so the pool with the most unused quota per hour left leads. The pool's pace is the minimum over its period windows (weekly, 30-day).
- **Floor.** A pool at or below 2% remaining in any window, including a 5-hour one, counts as out. A pool that cannot be read is skipped.
- **Reserve.** The driver's own subscription holds back 5% of every period window by default, waived in the last 2 hours before reset; set it per agent with `reserve` (the 2% floor still holds). The driver is identified from the MCP handshake.
- **Pick.** Lanes within 5% of the best pace form a tie band. The least-loaded pool wins first, then the lowest tier (the exact tier when it is in the band), then lanes outside the driver's provider, then pace.
- **Batch split.** Tasks in one call spread over every lane in the tie band, least-loaded pool first; lanes that share a pool count together, and a lane outside the band gets no task.
- **Quota mid-task.** A quota failure excludes that lane for the call, rereads usage, and reroutes the task. Claude overage is detected live and cancels the task at once. An `agents` allowlist of agents (`claude`, `codex`, `grok`, `agy`) bounds the reroute; schmear still picks the subscription within them; with no lane left the result is `no_quota`.
- **`usage`.** Shows the detected driver, per agent its pools with each window's remaining and reset, per pool the pace and status, "next: tier N → <lane> (<effort>)" for each tier 1..N, and the entries of your tier list that your account does not offer. Routing reuses a usage reading up to 5 minutes old; `usage` rereads after 60 seconds. `schmear usage --json` prints the same data as one JSON snapshot, plus `hosts` (each installed host's registration status: `ok`, `stale` when its registered command or CLI path no longer exists, or `missing`) and the last day's delegations (running, finished or lost) with their lane, from the 5-minute cache, so polling it never reads quota more often than routing does. `schmear usage` in a terminal has no driver, so it prints `driver: unknown`, applies no reserve, and ends with a fix line for each host that is not `ok`; pass `--driver <id>` (`claude`, `codex`, `grok` or `agy`), or call the `usage` tool from your agent, to see that agent's routing. Each window in the JSON also carries `projectedUnused`, the fraction expected to expire unused at the current spend rate.

## Tier configuration

`tiers` in `~/.config/schmear/config.json` replaces the default list whole. Each entry is `"<lane key>:<model>@<effort>"`, with a lane key from `claude`, `codex`, `grok`, `agy-gemini`, `agy-argon`, `agy-3p`, `claude-credits` and the provider's own model and effort values. A bad entry is an error naming the tier and entry, and schmear does not start on it. Credit pools spend only through `claude-credits:` entries.

Edit the list from a script or app: `schmear tiers` prints the effective list, the defaults, the lane keys and the models each lane's account offers as JSON; `schmear tiers set` replaces the list with the JSON array of arrays on stdin (an invalid list prints the error and changes nothing); `schmear tiers reset` restores the default. Routing uses a change at once; a host shows a new tier count after it restarts schmear.

<details><summary>Default tier list</summary>

```json
[
  [
    "claude:haiku@medium",
    "codex:gpt-6-luna@max",
    "grok:grok-4.7@medium",
    "agy-gemini:gemini-4-hydrogen@medium",
    "agy-argon:gemini-4-argon@medium",
    "agy-3p:claude-sonnet-5-5@medium",
    "claude-credits:haiku@medium"
  ],
  [
    "claude:sonnet@medium",
    "codex:gpt-6.1-terra@medium",
    "grok:grok-4.7@medium",
    "agy-gemini:gemini-4-hydrogen@medium",
    "agy-argon:gemini-4-argon@medium",
    "agy-3p:claude-sonnet-5-5@medium",
    "claude-credits:sonnet@medium"
  ],
  [
    "claude:opus@medium",
    "codex:gpt-6.1-terra@max",
    "agy-gemini:gemini-4-neon@medium",
    "agy-argon:gemini-4-argon@medium",
    "agy-3p:claude-opus-5-5@medium",
    "claude-credits:opus@medium"
  ],
  [
    "claude:fable@medium",
    "claude-credits:fable@medium"
  ]
]
```

</details>

This two-tier list with a 10% Claude reserve is an example, not a rating:

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

## Accounts

Every subscription is `<agent>@<nickname>`. The login each CLI already has is `@default` (`claude@default`, `codex@default`), even when it is the only one; each extra login, such as a second Claude subscription under another email, gets a nickname you choose (`claude@work`). Each CLI keeps its login in one directory, and one environment variable moves it:

| Agent | Variable | Sign in |
|---|---|---|
| claude | `CLAUDE_CONFIG_DIR` | `claude auth login` |
| codex | `CODEX_HOME` | `codex login` |
| grok | `GROK_HOME` | `grok login` |
| agy | `HOME` | run `agy` and sign in |

After the subscription checklist, `schmear init` asks "Add another subscription?" with the providers it found and Done. Picking one:

1. asks for a nickname: lowercase letters, digits and `-`, up to 32 characters, not `default` and not one you already use for that provider;
2. asks you to **sign in to the account you're linking in your browser first** (claude.ai, chatgpt.com, grok.com, or your Google account for Antigravity), since the sign-in approves whichever account the browser is signed in to; confirm, or cancel to go back to the menu;
3. creates its login directory, `~/.local/share/schmear/logins/<agent>-<nickname>`, and runs that CLI's usual sign-in with the variable above pointing there, which opens your browser to approve. For Antigravity, `agy` itself opens; sign in, then quit it;
4. checks the new login and adds it, shown with the login's email (Claude only) and plan: `claude@work  work@example.com · max_5x`.

A sign-in that does not finish, a login whose usage cannot be read, or a Claude login with the same email as one you already have is not added, and its directory is removed. Codex, Grok and Antigravity do not report an email, so schmear cannot tell when you signed in to the same one twice. The menu needs a terminal: piped input and `--yes` add nothing. On later runs the checklist lists every subscription by id; untick one to stop using it. To rename one, edit `~/.config/schmear/config.json`. `schmear uninstall` deletes the login directories.

- schmear never switches your login. It starts each worker and each usage read for an added subscription with the variable set to its directory; your own CLI and the agent you type into stay on `@default`.
- Pools and lanes carry the nickname: pool `claude-fable@work`, lane `claude@work:claude-opus-5-5`, and each delegate result names its `account`. Tier entries name no account, so `claude:claude-opus-5-5@medium` applies to every Claude subscription, and the router weighs each by its own pace.
- The driver's reserve and the tie-break against the driver's provider apply to `@default` only: schmear cannot tell which login the driver uses. The credit lane spends from `claude@default` only.
- An `agents` allowlist on `delegate` names agents (`claude`), and covers every subscription of each.
- An Antigravity account runs with `HOME` set to its directory, so its workers see that directory's `.gitconfig` and `.ssh`, not yours.
- Whether a provider lets one person use several of its subscriptions this way is a matter of its terms; see [safety.md](safety.md#terms-of-service).

## Credit pools

Claude Max, Ultra and Team plans include monthly Anthropic API credits through a linked Console org; they expire each cycle. schmear can spend them on a separate `claude-credits` lane: Claude workers run with `ANTHROPIC_API_KEY` set to that org's key instead of your claude.ai login. It is the only credit lane; Google and OpenAI credits are not used.

Run `schmear credits` after `schmear init`. It reads the grant from your Claude plan ($100 on Max, $200 on Ultra) and caps one task at a tenth of it. It asks for the day of the month your plan renews (no CLI or API reports the billing date, and it is not the weekly usage reset), a command that prints the key, as a JSON array, and a typed `yes` confirming nothing past the grant can be billed. On macOS, keep the key in the keychain:

```
security add-generic-password -s schmear-anthropic -a "$USER" -w
```

and accept the prefilled `["security","find-generic-password","-s","schmear-anthropic","-w"]`. schmear runs that command per task and keeps the key in memory only. If the command fails, that task skips the credit lane and runs on another one.

No vendor exposes a credit balance, so schmear meters the grant locally, in a ledger under `~/.local/state/schmear/ledger/`. Before each task it reserves a budget B = min(remaining − 2% of the grant, per-task cap); with nothing left above that floor the lane is out. The worker stops once a turn passes B, and one turn can overshoot it, which the 2% floor absorbs. Each task is charged the SDK's reported cost, which the SDK calls an estimate, not a billing statement, so the Console spend limit is the hard stop. Anthropic's "credit balance is too low" error closes the lane until the next cycle.

Anthropic bills past the grant if purchased credits or auto-reload are on, and schmear cannot see that. Init therefore requires you to confirm that nothing past the grant can be billed. Use a dedicated Console workspace whose spend limit equals the grant.

The key is in the worker's environment, so every command, hook and MCP server a credit-lane Claude worker starts can read it. Subscription workers never get it.

To remove the lane, delete `"credits"` from `~/.config/schmear/config.json`; later `init` runs keep it otherwise.

## Manual registration

`init` writes these for you, and finds a matching entry unchanged on a later run. If you register by hand, keep the timeouts: without them hosts cut long calls (Codex 60 s, Antigravity 180 s). Use absolute paths: `<node>` is the output of `command -v node` and `<cli>` the output of `command -v schmear`.

Claude Code:

```
claude mcp add-json -s user schmear '{"type":"stdio","command":"<node>","args":["<cli>","serve"],"timeout":86400000}'
```

Codex, in `~/.codex/config.toml`:

```toml
[mcp_servers.schmear]
command = "<node>"
args = ["<cli>", "serve"]
tool_timeout_sec = 86400
env_vars = ["SCHMEAR_WORKER"]
```

`env_vars` lets the worker marker reach a Codex worker's nested server. Codex applies its own approval policy to `delegate`, as to any MCP tool. To let Codex call `delegate` without asking, add `default_tools_approval_mode = "approve"` to that entry.

Grok, in `~/.grok/config.toml`:

```toml
[mcp_servers.schmear]
command = "<node>"
args = ["<cli>", "serve"]
tool_timeout_sec = 86400
```

Antigravity, in `~/.gemini/config/mcp_config.json`:

```json
{ "mcpServers": { "schmear": { "command": "<node>", "args": ["<cli>", "serve"], "timeoutSeconds": 86400 } } }
```

Claude Code and Codex run parallel tool calls only for tools marked read-only, Antigravity runs them serially, and Grok runs them concurrently; one `delegate` call carrying several tasks avoids the difference.

## Troubleshooting

Run `schmear usage`; every skipped agent says why.

| Reason | Meaning and fix |
|---|---|
| `skipped: no consent` / `not configured` | Run `schmear init`. |
| `skipped: codex credits can pay past your plan limit …` | Use up or remove your Codex credits; schmear routes to Codex again once it reports none. |
| `skipped: grok on-demand or prepaid spend is on (…)` | Grok's billing shows an on-demand cap or prepaid balance above zero, which can pay past your plan; Grok is skipped until both are zero. |
| `Claude reports no plan limits for this login` | The login is not a subscription with plan limits (an API key or a gateway), so it is not routed. |
| `Claude usage read ran your hooks` | Warning: your SessionStart hooks fired during the token-free usage read. |
| `Grok login token expired (run grok login)` | Log in again with the `grok` CLI. |
| `Grok reports no usage percent`, `Grok billing period unknown` | Neither ACP billing nor grok.com gave a usable reading; Grok is skipped. |
| `agy /usage timed out` | Antigravity answered too slowly; rerun. |
| `log in with the <agent> CLI` | A worker was refused authentication; log in with that CLI. |
| `skipped: credit ledger unreadable: …` | A line in `~/.local/state/schmear/ledger/claude-credits.jsonl` does not parse or has an invalid field (the message names the line and field); only the credit lane is skipped until you repair it. |
| `skipped: credit pool config invalid: …` | The named field of `credits` in `~/.config/schmear/config.json` is missing or out of range; rerun `schmear init` or fix it. |
| `claude-credits ledger write failed…` (task note) | The ledger could not be written; the task ran on another lane, or, after the run, its reservation stays counted. |
| `no_quota` | No consented lane at or above the task's tier has quota; do the task yourself. |
