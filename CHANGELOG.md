# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions are 0.x until 1.0, and a minor version may break. Breaking means a change to the `delegate` or `usage` tool schemas, config `version: 1` and its keys, the lane keys in tier entries, or the CLI commands and flags.

## [Unreleased]

### Added

- `delegate` tasks take an optional `model` (`model@effort`, e.g. `gemini-4-neon@high`) to pin one model as a manual override; schmear still picks the account, and normal routing by tier is unchanged.

### Changed

- `schmear usage` warns when a credit pool is stopped as exhausted (naming `schmear credits reset`) and when custom tiers never spend a configured pool.
- `schmear <command> --help` and `schmear help <command>` show that command's help; an option a command does not take, or one missing its value, is an error naming the command.

### Fixed

- Piped `init`, `uninstall` and `credits` write progress to stderr, and a prompt with no answer on stdin says to run in a terminal or pass `--yes`.

## [0.5.1] - 2026-11-25

### Fixed

- The Linux tray app needed glibc 2.38 instead of the stated 2.34, which stopped 0.5.0's app release; 0.5.0 reached npm only, and its macOS and Linux apps and Homebrew update ship with 0.5.1.

## [0.5.0] - 2026-11-24

### Added

- Browser session import for credit pools, opt in: in `schmear credits` or `schmear credits login <claude|google>`, pick "Import it from my browser" to copy your signed-in Console or Google session from Chrome, Chrome Beta, Chrome Canary, Arc, Brave, Edge, Chromium, Vivaldi, Dia, Firefox or Zen on macOS, or Chrome, Chromium, Brave, Edge or Firefox on Linux. Paste is the default answer; schmear reads no browser unless you choose the import.
- Credit-pool sessions: `schmear credits login <claude|google> [--label <name>]` imports or prints the paste steps, and `--stdin` reads a piped Cookie header (a terminal is refused, so the cookie never reaches scrollback). Sessions are stored `0600` in `~/.config/schmear/console-sessions.json` and `google-sessions.json` as `{cookie, source}` per label; a second import from the same browser profile refreshes its session. An expired session's message names the fix, e.g. `Console session work expired. Sign in at platform.claude.com, then run: schmear credits login claude --label work`.
- `schmear credits logout [google] <label>` removes a session and names the pools that lose their only session; `schmear credits remove <id>` removes a pool.
- The `credits` wizard takes each pool's API key at a hidden prompt, checks it with the vendor (an Anthropic key must belong to the org the pool spends), and after your typed `yes` stores it in your login Keychain (macOS) or keyring (Linux). A working key schmear stored earlier is offered for reuse.
- `schmear credits status` checks each stored session live and shows each pool's balance, the login it runs under and whether its key works. `schmear credits reset <id>` clears a pool's exhausted mark.
- Credit pools in `schmear usage` and both apps get a dim detail line: the org name or billing account, grant and purchased credit left, and this month's spend.
- `schmear usage --json` carries `notices` for credit expiring within 72 hours and for expired sessions, and both apps post each one once as a notification.
- Google credit lane: `gemini-credits@<account>` pools spend the Google Developer Program credit through Antigravity on a Gemini API key, one per billing account; `schmear credits agy@<n>` sets up that account's pool. Whether runs draw the credit before your AI Studio prepaid balance is not yet verified; see [Safety](docs/safety.md).
- A `delegate` result carries `lane`, the lane that ran (`claude-credits@k1c:sonnet` for a credit-funded run), beside `provider` and `account`.
- Resuming a `session` whose pool now runs under another login fails with a message naming both logins, instead of the agent's own error.
- `schmear init` in a terminal ends by opening the menu bar app (macOS) or tray app (Linux), first offering to install it with Homebrew (macOS) or the release install script (Linux, `scripts/install-tray.sh`); `init --yes` does not.

### Changed

- A credit pool's pace and expiry notice count only the money that expires next; purchased credit adds no urgency.
- `schmear init` shows a Max plan's included API credits ($100 a month for Max 5x, $200 for Max 20x) beside each Claude account without a pool, with Google AI and ChatGPT credits for information, and asks "Set up API credits now?" (default Later) instead of only pointing to `schmear credits`. `init --yes` never asks.
- The `credits` wizard asks for the API key itself instead of a command that prints it; to use another secret manager, edit the pool's `keyCommand` in the config. With no stored session it offers the import or paste inline, and the "What do you want to add?" menu preselects the first vendor without a pool. Console org rows show left, granted and expiry, as Google rows do.
- `schmear credits remove` and `schmear uninstall` delete the API key schmear stored for a pool, and say it still works at the vendor until you revoke it; a key read by your own command is left alone.
- A credit pool's key command times out after 15 s, so an unanswered Keychain dialog no longer holds a task, and its last failure shows as a warning in `schmear usage` until a later read succeeds.
- A credit pool whose agent has no consented account shows as skipped with the reason instead of vanishing.
- A credit pool runs as the account that owns it: `claude-credits@work` with `claude@work`'s CLI login, settings and MCP servers, `gemini-credits@work` with `agy@work`'s, billing only the pool's key. A pool with no consented owner runs as that agent's first consented login, which `schmear usage` names (`· runs under <login>`).
- The menu bar and tray apps show each credit pool under its owner account as `API credits`, with `$4.20 of $5 left · expires Nov 20` in place of quota bars, or as a `<name> · API credits only · runs under <login>` group when no account owns it.
- `schmear` alone prints the help; an unknown command or option prints one line pointing to `schmear --help`. `schmear init` with none of claude, codex, grok or agy on PATH fails without writing anything.
- Piped input that ends before an `init`, `credits` or `uninstall` question is answered now fails with `input ended before: <question>` instead of answering Enter.
- An Antigravity run whose last reply line is `⚠ agent executor error: …` (invalid key, quota) is a failed run: a quota error reroutes the task instead of returning the error text as its reply.
- Usage reads try the vendor CLI first and, only when it fails, read a credential as CodexBar does: Claude's `get_usage` then Claude Code's OAuth token (credentials file, or the macOS Keychain item for the default login) against `api.anthropic.com/api/oauth/usage`; Codex's app-server RPC, then a `personal_access_token`, then `auth.json`'s OAuth access token, against `chatgpt.com` wham usage; `agy -p /usage` then, for the default login, the Antigravity app's local server. When every step fails, the error is the CLI's plus the credential reasons, and `usage --json` names the step that answered in `source`. Claude's usage also lists `limits[]` model rows and the extra-usage spend. They run under the consent each provider was given in 0.4, with no new prompt; see [Safety](docs/safety.md) for the credentials these read.
- **Breaking:** Credit pools now read each Claude Console org's live USD prepaid balance (promotional and purchased credits) down to a 2% floor instead of metering an entered monthly grant and renewal day. `config.json`'s `credits` is now a map of per-pool entries (`"claude-credits@<name>": { org, keyCommand, overageOff: true, taskCapUsd? }`), each pool has its own ledger at `~/.local/state/schmear/ledger/<pool id>.jsonl`, and `schmear usage --json` reports each credit pool's `pools[].usd`. An 0.4 config's old `credits` keys show as skipped pools, and the 0.4 credit lane spends nothing, until you run `schmear credits`; `schmear credits remove <key>` clears each old key's row, and `~/.local/state/schmear/ledger/claude-credits.jsonl` can be deleted.
- A credit pool `<key>@<n>` now belongs to the account `<agent>@<n>` of the same name and shows nested under it as `API credits` in `usage` and `init`, as `$<left> of $<granted> left · expires <Mon D>` (a pool matching no consented account shows as `<n> · API credits only · runs under <login>`; the `usage` tool text says `expires` for a credit pool's window where a subscription's says `resets`, and a skipped pool's reason is printed once); every consented Claude account whose plan includes credits and owns no pool gets a `schmear credits <n>` hint. `schmear credits [account]` asks which account owns each pool (or `API-only`).
- In a terminal, `schmear usage`, `--help`, `tiers`, `max-tasks`, `max-per-pool` and errors use the same styled layout as `init`; piped output is unchanged. `schmear tiers --json` prints the JSON in a terminal.
- `schmear init`, `credits` and `uninstall` share a styled terminal onboarding layout with a nested Quotas view (bars, per-account Claude API credit grants, and nested `API credits` pool), live spinner progress, aligned status tables and a framed Next panel.

### Fixed

- Credit ledger: a reservation a killed process never settled is released after 30 hours (was 24), at each ledger line's own time so a later line is judged on the room it was sized on; a balance line no newer than the current one is ignored instead of dropping the settles before it; and in a tie, a credit pool with no expiry date no longer beats a subscription lane.

### Security

- An invalid piped answer to a prompt is never quoted in the error, so a Cookie header piped by mistake does not reach your terminal or logs.
- A stored session's cookie must be printable ASCII, so it can never leak through a request error into `schmear usage` or `usage --json`.
- schmear reads each Console org's auto-reload setting on every balance read and skips the org while auto-reload is on or reported in a shape schmear does not recognize; the wizard refuses such an org.
- The browser import copies a cookie database into a `0700` directory under `~/.local/state/schmear/tmp`, not the system temp directory, and deletes it after reading; a cookie whose name is not a valid token is dropped.
- schmear reads and deletes only Keychain or keyring items under account `schmear`, through `/usr/bin/security` by absolute path on macOS, so an item another program stored under the same name is never used or deleted; a stored key that does not look like an API key is never sent.

## [0.4.0] - 2026-11-24

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
- The default tiers follow one rule on Artificial Analysis and Epoch scores, with no per-provider exceptions: tier 4 adds GPT-6.2 Sol at `xhigh` and Gemini 4 Carbon at `medium`, and Antigravity Gemini tier 3 returns to Hydrogen at `high`, which clears Opus and is weaker than Neon. A config with its own `tiers` keeps them.

### Fixed

- A `delegate` result with many tasks stays within the 60,000-character output budget, errors and notes included; only replies, errors and notes are shortened, never a task's status or session.
- A global npm install takes about 32 MB (810 MB before; 5.5 GB under npm 11 in 0.3.0). The Claude and Codex ACP adapters are no longer npm dependencies: when you use Claude or Codex, `schmear init` installs the pinned set (about 45 MB, no vendor binaries) into the data dir, with npm and the network, and after an upgrade the first Claude or Codex task installs a changed set itself. `npm-shrinkwrap.json` is no longer shipped, and `--omit=optional` is gone from the install commands.
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
