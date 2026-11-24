# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions are 0.x until 1.0, and a minor version may break. Breaking means a change to the `delegate` or `usage` tool schemas, config `version: 1` and its keys, the lane keys in tier entries, or the CLI commands and flags.

## [Unreleased]

### Added

- Connection health: `schmear usage --json` reports `hosts`, whether each agent's schmear entry is `ok`, `missing` or `stale` (it runs a file that no longer exists, as after a Homebrew upgrade of 0.3.0), and `schmear usage` names the fix. Both apps show an agent that isn't connected with a **Reconnect** button that runs `schmear init --yes`.
- Both apps say when the installed `schmear` is older than they need and show the command to upgrade it; `schmear usage --json` reports `cliVersion`.
- The menu bar and tray icons show a warning when schmear is not installed, an agent isn't connected, or no subscription has pools.
- At most 10 tasks run at once on one usage pool, counted across every agent using schmear, so concurrent agents also spread their tasks; a task over the limit takes another subscription or waits for a free slot. Change it with `schmear max-per-pool <n>` or `maxPerPool` in the config; `schmear max-per-pool reset` restores the default.
- `host_mcp_probe.sh` `mrtr:` mode: a 2026-07-28-only probe server with multi-round-trip prompts.

### Changed

- One `delegate` call carries up to 50 tasks, up from 8. Set the limit with `schmear max-tasks <n>`, `maxTasks` in the config, or the tier editor in either app; `schmear max-tasks reset` restores the default. `schmear tiers` reports it as `maxTasks`.
- Antigravity is off in a new setup until you tick it in `schmear init`, because Google's FAQ says wrapping `agy` is unsupported on consumer plans; a setup that already uses it keeps it.
- Grok 4.7 leaves default tier 2: Epoch's ECI rates it below Haiku, so it stays a tier-1 lane only. A config that lists it at tier 2 keeps it.

### Fixed

- A `delegate` result with many tasks stays within the 60,000-character output budget, errors and notes included; only replies, errors and notes are shortened, never a task's status or session.
- A global npm install takes about 810 MB, not 5.5 GB: the package no longer ships `npm-shrinkwrap.json`, from which npm 11 installed the adapters' binaries for every platform. `--omit=optional` never applied to global installs and is gone from the install commands.
- The state directory is created with mode 0700 even when a Claude usage read creates it first.
- The apps stop a `schmear` call after 180 s, so a hung call no longer stops their refreshes.
- Saving the tier editor after changing only the task limit no longer writes the default tiers into your config, so later default tiers still reach you.

## [0.3.1] - 2026-11-24

### Fixed

- A Homebrew upgrade no longer disconnects schmear from your agents. `schmear init` registered the versioned path under Homebrew's `Cellar`, which an upgrade deletes; it now registers `schmear` on PATH when that resolves to the running CLI. After upgrading, run `schmear init --yes` and restart your agents.
- A release now fails before publishing while any dependency is less than a day old, since Homebrew would refuse to install it.
- `schmear uninstall` names `brew uninstall schmear` alongside npm.

## [0.3.0] - 2026-11-23

### Added

- A Linux tray app in `linux/`, released as x86_64 and ARM64 archives with a per-user installer (glibc 2.34+, system Qt 6.4+), with the macOS app's features: pools, pace, the next lane per tier, delegations, an Open at Login toggle, and a tier editor, over `usage --json` and `tiers`.
- Homebrew install on macOS: `brew install --cask kevin1chun/tap/schmear` installs the menu bar app, the CLI and Node. Each release attaches a notarized `Schmear.zip`.
- The menu bar app's **Set Up in Terminal** button installs the CLI with npm or runs `schmear init` when either is missing.

## [0.2.1] - 2026-11-23

### Changed

- Default tier 3 runs Gemini 4 Neon at `medium` in the Antigravity Gemini pool, in place of Hydrogen at `high`.
- Default Codex entries move to GPT-6.x: `gpt-6-luna@max` at tier 1, `gpt-6.1-terra@medium` at tier 2 and `gpt-6.1-terra@max` at tier 3, replacing GPT-5.6 Terra, which OpenAI no longer lists.
- `@agentclientprotocol/claude-agent-acp` 0.110.0 and `@agentclientprotocol/codex-acp` 2.10.0 (Codex 0.171.0).

## [0.2.0] - 2026-11-23

### Added

- `schmear usage --json`: one versioned snapshot of pools, pace, status, the lane each tier would take next, and running and recent delegations, for a UI to read.
- `schmear usage --driver <id>`: show routing as that agent's driver sees it, with its reserve. The JSON snapshot's windows carry `projectedUnused`, the fraction expected to expire unused at the current spend rate.
- `schmear tiers`, `tiers set` and `tiers reset`: read, validate-and-write, and reset the tier list in the config.
- A macOS menu bar app in `macos/`, built from source: pools, pace, the next lane per tier, delegations, an Open at Login toggle, and a tier editor, over `usage --json` and `tiers`. `build.sh` signs it with your Developer ID and notarizes it when `SCHMEAR_NOTARY_PROFILE` is set.
- `schmear uninstall [--yes]`: removes schmear's entry from each host's MCP config, its skills, config and state.
- More than one subscription per provider: every subscription is `<agent>@<nickname>`, the existing login being `@default`. After the checklist, `schmear init` offers "Add another subscription?", asks a nickname, runs the picked CLI's usual sign-in for the other account, and each one routes as its own pools. Its workers run with `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GROK_HOME` or, for Antigravity, `HOME` set to the account's directory.
- A delegation log, `tasks.jsonl` in the state directory (rotated to `tasks.jsonl.1` at 1 MiB): each task's description, tier, lane and status, never its prompt or reply.

### Changed

- Ids carry the subscription: pool, lane and `usage` reading ids are `<id>@default` for your existing login (`claude@default:opus`, pool `claude@default`), and the config's `agents` keys are `<agent>@<nickname>`; a config with bare agent keys is still read.
- `schmear init` asks for a checklist of the detected subscriptions, all ticked, then any extra logins. The per-provider consent questions, the Claude risk question and the overage questions are gone; `--yes` takes the ticked set.
- `schmear init` output: spinners over the slow steps, a one-line-per-pool quota summary, and one status line per host instead of each host's raw `mcp list` output.
- Codex is skipped while it holds credits, read from its rate-limit reply; Antigravity AI credits are assumed off. The agents' `overageOff` config key is no longer used.
- The credit lane moved from `init` to `schmear credits`, which reads the grant from your Claude plan and asks only the renewal day, the key command and the no-overage confirmation; `init` names the grant and points to it while the lane is off.

## [0.1.1] - 2026-11-22

### Fixed

- A worker failure's stderr tail could miss lines the worker wrote just before failing.

## [0.1.0] - 2026-11-22

### Added

- `delegate` MCP tool: hands 1 to 8 coding subtasks per call to workers on Claude, Codex, Grok and Antigravity over the Agent Client Protocol, using your existing logins.
- Routing by pace: the subscription most at risk of expiring unused at its reset, on a model at or above the task's tier, with a 2% quota floor and a reserve for the driver's own subscription.
- Tier list with a built-in default and a `tiers` override in `~/.config/schmear/config.json`.
- `usage` tool and `schmear usage` command: every pool's windows, pace and status, and the lane each tier would take next.
- `schmear init`: consent per provider, overage confirmations, and MCP registration with long timeouts in Claude Code, Codex, Grok and Antigravity.
- The `schmear` agent skill (`skills/schmear/SKILL.md`), which teaches the driving agent when and how to delegate; `init` installs it into each host, and `npx skills add kevin1chun/schmear` installs it anywhere else.
- Optional `claude-credits` lane that spends expiring Anthropic API credits, metered by a local ledger.
- Permission requests from workers are forwarded to the driver's user; a worker's own `schmear serve` hides `delegate`, which prevents accidental delegation loops.
