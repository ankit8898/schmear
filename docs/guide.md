# Guide

Reference for [schmear](../README.md). Safety and vendor terms are in [safety.md](safety.md).

## Terms

- **Driver**: the agent you type into. **Worker**: the CLI that runs a delegated task.
- **Pool**: one quota that can run out, with one or more windows, such as Claude's 5-hour and weekly limits. Antigravity has three: `agy-gemini` (Gemini models), `agy-argon` (Gemini 4 Argon) and `agy-3p` (its Claude and GPT models).
- **Lane**: one model on one subscription, such as `grok@default:grok-4.7` (`<agent>@<nickname>:<model>`). Its key (`claude`, `codex`, `grok`, `agy-gemini`, `agy-argon`, `agy-3p`, `claude-credits`, `gemini-credits`) names the route; several lanes can draw on one pool.
- **Tier**: the weakest model class a task may use, from 1 (Haiku-class) to 4 (Fable-class) by default. A task may run higher, never lower.
- **Pace**: per window, the share of quota left above the floor or reserve, divided by the share of time left until reset. Above 1, quota would go unused at an even rate. The highest pace goes first.

## How it works

After `schmear init`, restart your agent and work as usual, for example: *"Have another agent write tests for src/parse.ts in a new worktree."* schmear's MCP instructions tell the agent when to delegate, and each result names the worker that ran it.

- **Delegate.** Claude Code calls `delegate({tasks:[{prompt:"Add tests for src/parse.ts ...", cwd:"/repo/.wt/parse-tests", tier:2}]})`, having made that worktree itself. schmear picks the best-paced lane whose model meets tier 2, sends the prompt unchanged, and returns the reply with `provider`, `model`, `effort` and `session`. Any permission request from the worker appears in Claude Code as "agy worker on 'Add tests for src/parse.ts' asks: ...".
- **Fan out.** One call carries 1 to 50 tasks that run concurrently and return together; `schmear max-tasks <n>` changes the limit (`maxTasks` in the config, `schmear max-tasks reset` for the default), and a host uses it after it restarts schmear. At most 10 tasks run at once on one usage pool, across every agent using schmear (`schmear max-per-pool <n>`, `maxPerPool` in the config); the rest take another subscription or wait for a slot. Three read-only reviews with the same `cwd` share that directory and spread across the lanes in the pick's tie band.
- **Check quota.** `schmear usage`, or the `usage` tool, prints every pool with its windows, pace and status, and the lane the next task of each tier would take.
- **Continue.** Pass an earlier result's `session` back to `delegate` to resume that worker on the same provider and model.
- **Pin a model (rare).** A task's optional `model`, written `model@effort` (`gemini-4-neon@high`), is a manual override that runs exactly that model and effort instead of the tier's choice; schmear still picks the account among those offering the model. A pin shuts out every other subscription, so normal use leaves it out. No consented account offering the model fails the task with the models seen; `no_quota` means none of those accounts has quota.
- **Scope.** schmear only routes. The driver owns everything else: worktrees, read-only versus writing, commits, merging, ordering.

In a terminal every command except `serve` and `--version` prints in the same styled layout as `schmear init`: `usage` shows quotas with bars, each tier's next lane, the last day's tasks and any host that needs `schmear init --yes`; `--help`, `tiers`, `max-tasks`, `max-per-pool` and errors are styled too. `schmear <command> --help` and `schmear help <command>` show the help for that command only. Piped or redirected output is plain text as before, and `NO_COLOR` keeps the layout without colour.

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
next: tier 2 → claude@default:sonnet (medium)
next: tier 3 → claude@default:opus (medium)
next: tier 4 → claude@default:fable (medium)
```

## Install

Requires Node 22.18 or newer on macOS or Linux (Windows is not supported), and at least one of the five CLIs, logged in. The npm package takes about 32 MB. With a Claude or Codex subscription, `schmear init` installs the pinned ACP adapters (about 45 MB, without the vendor binaries schmear never runs: it launches your own `claude` and `codex`) into `~/.local/share/schmear/adapters`, using the npm beside the running Node; the first Claude or Codex task does it when they are missing, as after an upgrade that changes the pins. Both need the network. Install as in the [Install](../README.md#install); `schmear init --yes` uses every subscription it finds except Antigravity without asking on a first run, and keeps your selection on later runs.

From source: `git clone https://github.com/kevin1chun/schmear && cd schmear && npm ci && npm run build && npm i -g . && schmear init`.

Init does the following and nothing else:

- Detects `claude`, `codex`, `agy`, `grok` and `opencode` on your PATH, prints each one's path and version (or `not found on PATH`), and records each binary's absolute path in `~/.config/schmear/config.json`. `schmear serve` never resolves PATH. A CLI that is missing from PATH or fails detection keeps its stored entry, and your choice for it, while its recorded path still exists; when that path is gone, init removes the entry as uninstalled. With none found it writes and registers nothing and fails: `Found none of claude, codex, grok, agy or opencode on your PATH. Install one and sign in, then run schmear init again.`
- Says what it reads before asking: `schmear reads each ticked subscription's usage through its CLI and, only when that read fails or comes back incomplete, with the CLI's stored login token; nothing leaves your machine except to that vendor (docs/safety.md).` (details in [Safety](safety.md#trust-boundaries)).
- Shows one checklist of the subscriptions it found, all ticked except Antigravity, which stays unticked until you tick it because Google says wrapping `agy` is unsupported on consumer plans ([Terms of service](safety.md#terms-of-service)); untick any you do not want schmear to use. Later runs keep your choices.
- Asks nothing about paid overage. Codex and Grok report it in their usage read, so schmear skips Codex while you hold Codex credits and Grok while its on-demand cap or prepaid balance is above zero. Antigravity does not report its AI-credits setting; schmear assumes it is off, so turn it off in Antigravity if you do not want a task that crosses a limit to spend them.
- When a Claude or Codex subscription is on, installs the pinned ACP adapters into `~/.local/share/schmear/adapters/<hash>` with `npm ci`, and deletes the trees of other pin sets. A failure (offline, registry down) is a warning; the first Claude or Codex task retries.
- Reads usage once and prints each pool's remaining quota; `schmear usage` shows the full detail.
- Without `--yes`, shows an API credits panel: a row for each consented Claude account on Max 5x ($100) or Max 20x ($200) that owns no credit pool, with the plan's included API credits, and a row for each consented Antigravity account that owns no Google pool (Google AI Pro $10, Ultra 5x $40 or Ultra 20x $100 a month in Google Cloud credits). When a Claude or Google row shows, it asks "Set up API credits now?" (default Later): Yes runs the [`schmear credits`](#credit-pools) setup, Later prints ``Run `schmear credits` anytime to spend them.`` Nothing in it reads a browser unless you then choose the browser import. The same panel lists a ChatGPT Pro or Business plan's included API credits for information: Codex cannot draw on them, so schmear never spends them. `--yes` never asks.
- Registers the server in every host it found on PATH (Claude Code, Codex, Grok, Antigravity), even one whose worker you declined or whose detection failed: consent covers only the worker role, so you can still delegate *from* that host. The entry runs `<node> <cli> serve` with absolute paths: `node` and `schmear` on your PATH when they resolve to the ones running init, so a Homebrew upgrade keeps them, otherwise the running `node` and `cli.js`. A host started without your shell's PATH still finds them. Each entry gets a 24 hour tool timeout (Codex defaults to 60 s, Antigravity to 180 s), and Codex's also gets `env_vars = ["SCHMEAR_WORKER"]`.
- Leaves an entry alone when the keys init writes match, and otherwise replaces those keys and reports it "updated"; keys you added stay. In Claude Code the replacement is `claude mcp remove -s user schmear` followed by `claude mcp add-json -s user`, and a project or local entry that shadows the user entry is reported.
- Copies the [schmear skill](../skills/schmear/SKILL.md), which teaches the agent when and how to delegate, into each host's global skill folder: `~/.claude/skills/`, `~/.agents/skills/` (Codex), `~/.grok/skills/` and `~/.gemini/config/skills/` (Antigravity), the folders the [`skills` CLI](https://github.com/vercel-labs/skills) uses. A copy that differs from the packaged one is replaced and reported "skill updated". For any other agent, run `npx skills add kevin1chun/schmear`.
- Checks `claude mcp get schmear` and `<host> mcp list` for each registered host. A host that does not list schmear gets a warning in place of its registered row, ``<host>  registered, but `<cmd>` does not list schmear yet:``, followed by the command's output.
- Fails when no subscription is turned on, after registering: `No subscription is turned on, so delegate has nothing to run. Run schmear init and tick one.`, preceded by `<id> failed detection: <first line of the error>.` for each CLI whose detection failed.
- In a terminal and without `--yes`, ends by opening the menu bar app (macOS: `Schmear.app` in `/Applications` or `~/Applications`) or the tray app (Linux: `~/.local/bin/schmear-tray`). When it is missing, init offers to install it with `brew install --cask kevin1chun/tap/schmear` (macOS, when `brew` is found; otherwise it prints the install link) or the release install script (Linux), then opens it.
- Refuses to run from an npx cache.

`--yes` skips the checklist. On a first run it ticks every subscription found except Antigravity; once the config holds a selection, it uses only the subscriptions you ticked, and a newly found one stays off with `Found <id>; run schmear init to use it.` The apps' Reconnect runs `init --yes`, so it never turns on a subscription you did not choose. [Credit pools](#credit-pools) are set up separately, with `schmear credits`.

State lives in `~/.local/state/schmear/` (usage cache, offered-model lists, credit ledgers, recorded key failures, the secret that signs `session` handles) and `~/.config/schmear/` (`config.json`, `console-sessions.json`, `google-sessions.json`). `schmear uninstall` removes the `schmear` entry from each host, the `schmear` folder from each skill folder above, both directories (plus `~/.local/share/schmear/`) and the API keys schmear stored in your Keychain or keyring; then remove the command with `npm rm -g schmear` or `brew uninstall schmear`.

## Tested versions

Tested against `claude` 2.1.330, `codex` 0.147.0, `grok` 1.0.77 and `agy` 1.5.14. The package pins the adapters `@agentclientprotocol/claude-agent-acp` 0.110.0 and `@agentclientprotocol/codex-acp` 2.10.0 in `adapters/package.json`. Usage reads rely on undocumented vendor interfaces, so a CLI update can break them. Each agent's own CLI read runs first. Only when it fails does schmear read a credential: Claude Code's OAuth token for Claude, the `personal_access_token` or OAuth token in Codex's `auth.json` for Codex, the Antigravity app's local-server token for the default Antigravity login ([Safety](safety.md#trust-boundaries)). Reads fail closed: a pool whose usage cannot be read is skipped.

## Routing

- **Tiers are a floor.** Tiers are an ordered list, weakest first. The default has four, referenced to Anthropic's Haiku, Sonnet, Opus and Fable at medium effort; each tier names the `lane:model@effort` entries that qualify, and the ratings and sources are in [`research/model-tiers.md`](research/model-tiers.md) §3; the list is [below](#tier-configuration). `tier` is 1 to the list's length. A task may run on a stronger tier, never a weaker one. There is no `effort` parameter: more thinking is a higher tier, unless the task pins `model@effort`. Models an account does not offer are dropped.
- **Pace.** Each usage window gives `(remaining - threshold) x periodHours / hoursUntilReset`, so the pool with the most unused quota per hour left leads. The pool's pace is the minimum over its period windows (weekly, 30-day).
- **Floor.** A pool at or below 2% remaining in any window, including a 5-hour one, counts as out. A pool that cannot be read is skipped.
- **Reserve.** The driver's own subscription holds back 5% of every period window by default, waived in the last 2 hours before reset; set it per agent with `reserve` (the 2% floor still holds). The driver is identified from the MCP handshake.
- **Pick.** Lanes within 5% of the best pace form a tie band. The least-loaded pool wins first, then the lowest tier (the exact tier when it is in the band), then lanes outside the driver's provider, then pace. A credit pool with no expiry date never takes a tie from a subscription lane.
- **Batch split.** Tasks in one call spread over every lane in the tie band, least-loaded pool first; lanes that share a pool count together, and a lane outside the band gets no task.
- **Quota mid-task.** A quota failure excludes that lane for the call, rereads usage, and reroutes the task. Claude overage is detected live and cancels the task at once. An `agents` allowlist of agents (`claude`, `codex`, `grok`, `agy`) bounds the reroute; schmear still picks the subscription within them; with no lane left the result is `no_quota`.
- **`usage`.** Shows the detected driver, per agent its pools with each window's remaining and reset, per pool the pace and status, "next: tier N → <lane> (<effort>)" for each tier 1..N, and the entries of your tier list that your account does not offer. Routing reuses a usage reading up to 5 minutes old; `usage` rereads after 60 seconds. `schmear usage --json` prints the same data as one JSON snapshot, plus `hosts` (each installed host's registration status: `ok`, `stale` when its registered command or CLI path no longer exists, or `missing`) and the last day's delegations (running, finished or lost) with their lane, from the 5-minute cache, so polling it never reads quota more often than routing does. `schmear usage` in a terminal has no driver, so it prints `driver: unknown`, applies no reserve, and ends with a fix line for each host that is not `ok`; pass `--driver <id>` (`claude`, `codex`, `grok` or `agy`), or call the `usage` tool from your agent, to see that agent's routing. Each reading names the step that produced it in `source` (Claude `oauth` or `cli`, Codex `pat`, `oauth` or `rpc`, Grok `acp`, `grok.com` or `cli-proxy`, Antigravity `app` or `cli`). Each window in the JSON also carries `projectedUnused`, the fraction expected to expire unused at the current spend rate.

## Tier configuration

`tiers` in `~/.config/schmear/config.json` replaces the default list whole. Each entry is `"<lane key>:<model>@<effort>"`, with a lane key from `claude`, `codex`, `grok`, `agy-gemini`, `agy-argon`, `agy-3p`, `claude-credits`, `gemini-credits` and the provider's own model and effort values. A bad entry is an error naming the tier and entry, and schmear does not start on it. Each credit pool spends only through entries of its own key: `claude-credits:` for Claude Console pools, `gemini-credits:` for Google pools. Antigravity's key mode offers only `low` and `high` effort, so each default `gemini-credits:` entry copies its tier's `agy-gemini:` entry at `high`.

Edit the list from a script or app: `schmear tiers --json` (or `schmear tiers` when piped) prints the effective list, the defaults, the lane keys, the models each lane's account offers and `maxTasks` as JSON; `schmear tiers` in a terminal shows one row per tier; `schmear tiers set` replaces the list with the JSON array of arrays on stdin (an invalid list prints the error and changes nothing); `schmear tiers reset` restores the default. Routing uses a change at once; a host shows a new tier count after it restarts schmear.

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
    "opencode-go:opencode-go/glm-5.3@max",
    "opencode-go:opencode-go/deepseek-v4.1-flash@high",
    "opencode-go:opencode-go/gemini-4-argon@medium",
    "opencode-go:opencode-go/claude-haiku-5-5@medium",
    "opencode-go:opencode-go/gpt-6-luna@max",
    "opencode-go:opencode-go/grok-4.7@medium",
    "claude-credits:haiku@medium",
    "gemini-credits:gemini-4-hydrogen@high"
  ],
  [
    "claude:sonnet@medium",
    "codex:gpt-6.1-terra@medium",
    "agy-gemini:gemini-4-hydrogen@medium",
    "agy-argon:gemini-4-argon@medium",
    "agy-3p:claude-sonnet-5-5@medium",
    "opencode-go:opencode-go/gemini-4-argon@medium",
    "claude-credits:sonnet@medium",
    "gemini-credits:gemini-4-hydrogen@high"
  ],
  [
    "claude:opus@medium",
    "codex:gpt-6.1-terra@max",
    "agy-gemini:gemini-4-hydrogen@high",
    "agy-argon:gemini-4-argon@medium",
    "agy-3p:claude-opus-5-5@medium",
    "opencode-go:opencode-go/gemini-4-argon@medium",
    "claude-credits:opus@medium",
    "gemini-credits:gemini-4-hydrogen@high"
  ],
  [
    "claude:fable@medium",
    "codex:gpt-6.2-sol@xhigh",
    "agy-gemini:gemini-4-carbon@medium",
    "claude-credits:fable@medium",
    "gemini-credits:gemini-4-carbon@high"
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
4. checks the new login and adds it, shown with the login's email (Claude only) and plan: `claude@work  work@example.com · Max 5x`.

A sign-in that does not finish, a login whose usage cannot be read, or a Claude login with the same email as one you already have is not added, and its directory is removed. Codex, Grok and Antigravity do not report an email, so schmear cannot tell when you signed in to the same one twice. The menu needs a terminal: piped input and `--yes` add nothing. On later runs the checklist lists every subscription by id; untick one to stop using it. To rename one, edit `~/.config/schmear/config.json`. `schmear uninstall` deletes the login directories.

- schmear never switches your login. It starts each worker and each usage read for an added subscription with the variable set to its directory; your own CLI and the agent you type into stay on `@default`.
- Pools and lanes carry the nickname: pool `claude-fable@work`, lane `claude@work:claude-opus-5-5`, and each delegate result names its `account`. Tier entries name no account, so `claude:claude-opus-5-5@medium` applies to every Claude subscription, and the router weighs each by its own pace.
- The driver's reserve and the tie-break against the driver's provider apply to `@default` only: schmear cannot tell which login the driver uses. A credit pool is its owner account's worker with a different bill: `claude-credits@k1c` runs with `claude@k1c`'s CLI login, settings and MCP servers, bills only the pool's API key, and nests under `claude@k1c` in `schmear usage`. An API-only pool, or one whose account you untick, uses the first enabled login of that agent (`@default` first), and `schmear usage` names it (`side · API credits only · runs under claude@default`); the borrowed login lends its CLI and settings, never its quota.
- An `agents` allowlist on `delegate` names agents (`claude`), and covers every subscription of each.
- An Antigravity account runs with `HOME` set to its directory, so its workers see that directory's `.gitconfig` and `.ssh`, not yours.
- Whether a provider lets one person use several of its subscriptions this way is a matter of its terms; see [safety.md](safety.md#terms-of-service).

## Credit pools

Claude Console organizations hold prepaid API credits (both monthly promotional credits from Max, Ultra and Team plans and purchased credits). schmear can spend each configured org's whole reported USD credit balance down to a 2% floor on its own `claude-credits@<name>` pool (several orgs per Console login, and several Console logins): Claude workers run with `ANTHROPIC_API_KEY` set to that org's key instead of your claude.ai login. A second credit lane, `gemini-credits`, spends the Google Developer Program credit ([Google credits](#google-credits)). Each account owns its own pools: `claude-credits@<name>` belongs to `claude@<name>`, `gemini-credits@<name>` to `agy@<name>`, and accounts of one provider share nothing. There is no OpenAI or Grok credit lane: Codex on an API key cannot draw ChatGPT plan credits, and the Grok credit lane is cut for now.

1. **Run `schmear credits`** after `schmear init`; it needs a consented Claude account. With no subscription set up it stops with `No subscriptions set up yet; run schmear init first.`, and with no Claude account with `Claude Code is not set up in schmear; run schmear init and tick a Claude account.` When a Claude and an Antigravity account are both consented, it first asks "What do you want to add?" (Claude Console orgs, Google credits, Done), preselecting the first with no pool yet.

2. **Give schmear your Console session.** schmear reads each org's balance with your `platform.claude.com` session. With none stored, it says what it would read and asks "How should schmear get your Console session?":

   - **Paste a Cookie header** (the default, also for piped input; reads no browser files). It prints `To paste your cookie instead:` and the steps: open `platform.claude.com` signed in, copy the `Cookie` request header of any request to it from DevTools → Network, and run in another terminal

     ```
     pbpaste | schmear credits login claude --stdin
     ```

     (`wl-paste` under Wayland, `xclip -o -selection clipboard` under X11). Then run `schmear credits` again.
   - **Import it from my browser.** schmear searches every profile of Chrome, Arc, Brave, Edge, Chromium, Vivaldi, Dia, Firefox and Zen on macOS, or Chrome, Chromium, Brave, Edge and Firefox on Linux; Safari is not read. From each profile it takes only the `platform.claude.com` `sessionKey` cookie, ignores every other cookie and all other browser data, and stores nothing else. A Chromium browser's cookies need that browser's cookie key: macOS asks for your login password so `security` can read "<Browser> Safe Storage" (Allow is enough; Always Allow lets any program you run read it without asking), and Linux may ask to unlock your keyring. schmear checks each session it finds with the Console and stores each signed-in one, as `Saved Console session default from Chrome · Work: Acme.` The first session is `default`; later ones are named after their first org. With two or more new logins it asks which to store. The wizard then continues. When nothing is stored it names the profiles it searched and each one's problem, then prints the paste steps. What the import reads is in [Safety](safety.md#trust-boundaries).

3. **Add a pool per org.** The wizard reads every stored session and lists each API org with its balance, expiry and whether a pool spends it (with two or more sessions, each org names the session that read it). For each org you pick:

   - the account that owns the pool: `claude-credits@<name>` takes that account's name and nests under it in `schmear usage`. Pick `API-only` for an org with purchased credits and no plan, and name it.
   - its API key. Create one at `platform.claude.com/settings/keys` with that org selected and paste it at `Paste <org>'s API key`. Input is hidden; Enter alone skips the org. schmear checks the key with one request to `api.anthropic.com` and refuses one that is rejected, not scoped to a workspace, or owned by another org. When a working key for this pool is already in your Keychain or keyring, it offers `Use the stored key` or `Replace it`.
   - a typed `yes`. The pool spends the org's whole balance, purchased credits included, down to 2%. schmear checks auto-reload on every balance read and skips the org while it is on, and the wizard does not offer such an org: keep auto-reload off at `platform.claude.com/settings/billing`, or Anthropic bills your card past the balance.

   Only after the `yes` does schmear store a pasted key, in your login Keychain (macOS) or your keyring through `secret-tool` (Linux), as service `schmear-anthropic-<name>` and account `schmear` (`Stored the key in your login Keychain as schmear-anthropic-<name>`). The pool's `keyCommand` reads it back: `["/usr/bin/security","find-generic-password","-s","schmear-anthropic-<name>","-a","schmear","-w"]`, or `["secret-tool","lookup","service","schmear-anthropic-<name>","account","schmear"]`. To use another secret manager, set `keyCommand` on that pool in `~/.config/schmear/config.json` to any argv that prints the key. schmear runs `keyCommand` once per task without a shell, keeps the key in memory, and gives up after 15 s. If it fails, that task runs on another lane, and `schmear usage` shows the failure under the pool until a later read succeeds. To cap a single task, set `"taskCapUsd"` on that pool (default: a tenth of the live grants' total, or of the balance when no grant is live).

   With two Max accounts, `claude@default` and `claude@k1c`, each with its own Console org, run one wizard per account (`schmear credits <account>` skips the owner question; `schmear credits agy@<n>` sets up that Antigravity account's Google credit). Each pool belongs to one account and one org:

   ```
   schmear credits default
   schmear credits k1c
   ```

schmear reads each org's balance from `platform.claude.com/api/organizations/<org>/prepaid/credits`, and this month's spend from `…/current_spend`, through the usage cache (every 5 minutes for routing, 60 seconds for `usage`, at most 60 seconds after an error). Reads fail closed: an unreadable balance (expired session, 401/403, format change, missing org), an auto-reload setting that is on or not recognized, or a non-USD org skips that pool with the vendor message and never spends. A failed spend read only leaves the spend out.

Between reads, a per-pool ledger at `~/.local/state/schmear/ledger/<pool id>.jsonl` tracks in-flight reservations and settled costs so concurrent tasks do not over-commit. When a read returns a new balance or floor, schmear appends a `balance` line. A reservation a killed process never settled is released after 30 hours. Before each task it reserves `B = min(left − floor, cap)` (floor = 2% of the live grants' total); with nothing left above the floor the pool is out. The worker stops once a turn passes `B` (one turn can overshoot `B`, which the 2% floor absorbs) and settles the SDK's reported cost (or `B` when no cost was reported, corrected at the next read). Anthropic's "credit balance is too low" error marks the pool exhausted until the next balance read; `schmear credits reset <id>` clears the mark sooner. A continued task resumes only under the login it ran under: if the pool now runs under another login, it fails with `session ran under <old login>; <pool id> now runs under <new login>, which cannot resume it. Start a new session.`

`schmear usage` nests each pool under its same-named account (or after the accounts as `<name> · API credits only · runs under <login>`) as `API credits` showing `$<left> of $<granted> left` (`$<left> left` with no live grant) and, when dated, `expires <Mon D>`, or `$<x> expires <Mon D>` when only $x of it expires then, with a dim line below: the org name (`billing <id>` for Google), `$<g> grant + $<p> purchased` and `$<s> spent this month`, each when known. A skipped pool's reason is printed once. The `usage` tool text says `expires <timestamp>` for a credit pool's window where a subscription's says `resets`, and ends the pool's line with `| $<left> of $<granted> left`. A dated pool's pace counts only the money that expires next, so purchased credit beside a small expiring grant adds no urgency. `schmear usage --json` reports `pools[].usd`, the pool's `name`, the `login` a credit reading runs under, and `notices`: one per expired session and one per pool with $1 or more expiring within 72 hours, naming that amount, which the menu bar and tray apps post once each.

The key is in the worker's environment, so every command, hook and MCP server a credit-lane Claude worker starts can read it. Subscription workers never get it.

### Google credits

Google AI Pro, Ultra 5x and Ultra 20x include a monthly Google Cloud credit through the Developer Program ($10, $40, $100). schmear spends it on a `gemini-credits@<name>` pool: Antigravity (`agy acp`) runs on a Gemini API key, down to a 2% floor, routed like any quota: whatever would expire unused goes first. This lane is **not yet verified against a real credit**: Google's billing docs say credits are spent before prepaid funds, but nobody has run the check (`docs/probes/agy_key_acp.py --live` is it), so a run may spend your AI Studio prepaid balance instead ([Safety](safety.md)). It needs an Antigravity account ticked in `schmear init`; the pool runs under that account.

1. **Apply the credit** to a billing account at `me.developers.google.com/benefits`. Gemini API use needs a prepaid balance of at least $5, which is real money and must stay positive for credits to apply. Keep it small and keep auto-reload off.

2. **Run `schmear credits`** and pick Google credits when asked. With no Google session stored, it offers the same choice as for the Console, for your `me.developers.google.com` session, which is your Google sign-in. The paste steps end in `pbpaste | schmear credits login google --stdin`; the import stores the Google cookies of each signed-in profile. Google rotates these cookies, so an imported session can expire within days; run `schmear credits login google` again when it does.

3. **Add the pool.** The wizard lists each Google account's credit: email, `$<left> of $<granted>`, `expires <Mon D>` and billing account, or `Not applied: apply it at me.developers.google.com/benefits`. Pick a billing account and the Antigravity account that owns the pool (`agy@default`, or an added one that owns none yet). Create a Gemini API key at `aistudio.google.com/apikey` in a project billed to that billing account and paste it at the hidden prompt; schmear checks it with one request to `generativelanguage.googleapis.com`. Then type `yes` to the confirmation: schmear reads only the monthly credit, cannot see your AI Studio prepaid balance, and a run has no spend limit, so it can spend past the credit into that balance before Google stops at zero, and whether runs draw the credit before that balance is not yet verified; confirm the key's project bills to the pool's billing account. The key is stored as `schmear-gemini-<name>`, as for Claude. Pools take no `taskCapUsd` (Antigravity has no budget stop).

`schmear usage` shows the pool nested under its account as `API credits` with `$<left> of $<granted> left`, `expires <Mon D>` and `billing <id>`. The read, ledger and 2% floor work as for Claude, with these differences:

- The read covers only the current monthly grant. Each grant lasts 12 months and Google spends the earliest-expiring first, so from the second month the balance schmear reads stays flat while older grants absorb the spend. schmear then debits a reserve per run and the pool drains to its floor after a few runs and returns at the next grant: conservative, but it spends roughly one month's grant whatever older grants hold. A new grant date starts a new balance.
- A key whose project is not billed to the credit's billing account spends your prepaid balance and the read never moves.
- A credit run uses its own Antigravity home, `~/.local/share/schmear/credit-homes/<pool id>`, so it does not load your Antigravity settings, MCP servers or skills and leaves `~/.gemini` alone. The key is in the worker's environment, so commands the worker starts can read it. Subscription workers never get it.
- A rejected key (`API key not valid`) or a Google rate limit (`Error 429`) fails the task without draining the pool; an `Error 402`, a "payment required" or a "prepay credits depleted" error marks the pool exhausted until the read or the grant date changes, or until `schmear credits reset <id>`.

### Sessions and pools

- `schmear credits login <claude|google> [--label <name>]` runs the import-or-paste choice on its own and ends `Next: schmear credits`, or `Nothing saved.` A later import refreshes each stored session from the same browser profile (`Refreshed Console session …`) instead of adding one. `--label` names the one session to store or refresh.
- `<paste> | schmear credits login <claude|google> --stdin [--label <name>]` stores a piped `Cookie` header under the label (default `default`). It refuses a terminal, so the header never lands in your scrollback, and an empty stdin; a Console header must hold `sessionKey`. A stored label is replaced (`Replaced Console session <label>.`, then `To add another login instead, pass a new --label.`). It prints each org's balance (or each Google account's credit) and never the cookie or a response body. A cookie the vendor rejects fails with `Console rejected this cookie. …` or `Google rejected this cookie. …`.
- Sessions are stored in `~/.config/schmear/console-sessions.json` and `google-sessions.json`, mode `0600`, as `{ "<label>": { "cookie": "…", "source": { "browser": "Chrome", "profile": "Profile 1" } } }`; a pasted session has no `source`. Each login forgets the cached credit readings, so the next `schmear usage` reads fresh.
- `schmear credits logout [google] <label>` removes a session and names each pool that read its org or billing account only through it: `<pool id> read <name> only through this session; it is skipped until you run: schmear credits login <vendor>`. An unknown label lists the stored ones (`no Console session <label>; stored: …`).
- `schmear credits status` checks each stored session live (`Console default · Chrome · Work · Acme`, or `pasted` in place of the browser and profile), then each pool: its balance and expiry or why it is skipped, the login it runs under, and `key ok` or `key: <error>`. It runs each pool's `keyCommand`, so it can raise a Keychain dialog for a key another program stored, and clears a recorded key failure when the key works. It never reads a browser.
- `schmear credits reset <id>` clears a pool's exhausted mark with a `cleared` ledger line: `Cleared the exhausted mark on <id>. It routes again on the last balance read; if the vendor still refuses, it is marked again.`
- `schmear credits remove <id>` deletes the config entry, its ledger, its recorded key failure and a Google pool's credit home. When schmear stored the key, it deletes it too (`Deleted the API key schmear stored as <service> in your login Keychain. The key still works at the vendor: revoke it at <site>.`); a key your own `keyCommand` reads stays where it is. `schmear uninstall` deletes every key schmear stored the same way. Later `schmear init` runs keep `credits`.

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

Run `schmear usage`, or `schmear credits status` for credit pools; every skipped agent says why. Setup messages are listed too.

| Reason | Meaning and fix |
|---|---|
| `skipped: no consent` / `not configured` | Run `schmear init`. |
| `skipped: <agent> not found at <path>; reinstall it or run schmear init` | The CLI schmear recorded is gone (uninstalled or moved), so that subscription is not routed and its credit pools run under another login, if any. Reinstall it, or run `schmear init`, which records its new path or, when it is no longer on your PATH, removes the entry. |
| `skipped: codex credits can pay past your plan limit …` | Use up or remove your Codex credits; schmear routes to Codex again once it reports none. |
| `skipped: grok on-demand or prepaid spend is on (…)` | Grok's billing shows an on-demand cap or prepaid balance above zero, which can pay past your plan; Grok is skipped until both are zero. |
| `Claude reports no plan limits for this login` | The login is not a subscription with plan limits (an API key or a gateway), so it is not routed. |
| `Claude usage read ran your hooks` | Warning: your SessionStart hooks fired during the Claude CLI usage read (`get_usage`, which runs first). |
| `Grok login token expired (run grok login)` | Log in again with the `grok` CLI. |
| `Grok reports no usage percent`, `Grok billing period unknown` | Neither ACP billing nor grok.com gave a usable reading; Grok is skipped. |
| `agy /usage timed out` | Antigravity answered too slowly; rerun. |
| `log in with the <agent> CLI` | A worker was refused authentication; log in with that CLI. |
| `skipped: credit ledger unreadable: …` | A line in `~/.local/state/schmear/ledger/<pool id>.jsonl` does not parse or has an invalid field (the message names the line and field); only that credit pool is skipped until you repair or remove it. |
| `skipped: credit pool id invalid` / `skipped: credit pool config invalid: …` | A pool entry under `credits` in `~/.config/schmear/config.json` (including an 0.4 flat-object `credits` block) has an invalid id or field; run `schmear credits` to rewrite `credits` or fix the entry. |
| `Console session <label> expired. Sign in at platform.claude.com, then run: schmear credits login claude --label <label>` | The stored Console session expired or was rejected. Sign in to the Console in your browser and run the command: it imports or pastes a fresh session into that label. Several expired sessions share one message: `Console sessions a and b expired. Sign in at platform.claude.com, then run for each: schmear credits login claude --label <label>`. The apps post it once as a notification. |
| `Claude Console billing access was denied. …` | That Console session lacks billing permission on the org; ask the org owner for billing access or log in with a session that has it. |
| `No stored Console session can read org <uuid>. Log in as the account that owns it: schmear credits login claude --label <new name>` | None of the sessions in `~/.config/schmear/console-sessions.json` list that org; log in with the Console account that owns it under a new label, or remove the pool with `schmear credits remove <id>`. |
| `Console org <name> bills in <CUR>; schmear meters USD` | Non-USD Console orgs are skipped; schmear meters USD only. |
| `Could not parse Claude Console …` | The undocumented Console response format changed; update schmear or report the error. |
| `Google session <label> expired. Sign in at me.developers.google.com, then run: schmear credits login google --label <label>` | A stored Google session expired or was rejected (Google rotates its cookies, so an imported session can last only days) and no other session lists the pool's billing account; run the command. With several, `Google sessions a and b expired. Sign in at me.developers.google.com, then run for each: schmear credits login google --label <label>`. |
| `Google credit is not applied to a billing account; apply it at me.developers.google.com/benefits` | The credit exists but has no billing account yet; apply it at the Benefits page. |
| `no Google session; run: schmear credits login google` | No Google session is stored; run the command. |
| `key command failed <YYYY-MM-DD HH:MM> UTC: <error>; each task tries it and falls back to another lane until it works (schmear credits status rechecks)` (usage warning), `<pool id> key command failed: <error>` (task note) | The pool's `keyCommand` exited non-zero (`<command> exit <n>`), printed nothing (`<command> printed no key`) or hung (`<command> timed out after 15 s`, as with an unanswered Keychain dialog). Tasks run on another lane meanwhile. Unlock your Keychain or keyring, or fix `keyCommand` under `credits` in `~/.config/schmear/config.json`, then run `schmear credits status`; a working key clears the warning. |
| `<pool id> stopped after the vendor reported its credit exhausted; after you add credit, run schmear credits reset <pool id>` (usage warning) | The vendor refused the pool's last task for lack of credit, so schmear stopped spending it; it shows `$0` left. After you add credit, run `schmear credits reset <pool id>`; a new vendor balance or grant also clears it. |
| `your custom tiers name no <key> entry, so <pool id> is never spent; add one with schmear tiers set, or run schmear tiers reset` (usage warning) | Your tier list has no `claude-credits:` or `gemini-credits:` entry, so that key's pool never gets a task. Add an entry with `schmear tiers set`, or return to the default list with `schmear tiers reset`. |
| `No subscriptions set up. Run schmear init.` (end of piped `schmear usage`) | No agent is configured yet; run `schmear init`. |
| `Console org <name> has auto-reload on; turn it off at platform.claude.com/settings/billing, or Anthropic charges your card past the balance` | Turn auto-reload off there; the pool spends again at the next read. The wizard does not offer the org while it is on. |
| `Console org <name> reports an auto-reload setting schmear does not recognize, so it is skipped; …` | The Console returned an auto-reload setting schmear cannot read as off, so it counts as on. Check auto-reload is off, then update schmear or report it. |
| `no consented <agent> account to run this pool; tick one in schmear init, or run: schmear credits remove <id>` | No account of the pool's agent is ticked, so nothing can run it. |
| `session ran under <old login>; <pool id> now runs under <new login>, which cannot resume it. Start a new session.` | The pool's login changed since the task ran (an account was unticked or added). Start a new task. |
| `<pool id> read <name> only through this session; it is skipped until you run: schmear credits login <vendor>` | `credits logout` removed the only session that reads that pool. Log in again, or remove the pool. `Could not check which pools used this session: <error>` means the check failed; the session is still removed. |
| `malformed ~/.config/schmear/console-sessions.json: expected an object of label to { cookie, source }` (or `google-sessions.json`) | The file is not label → `{ cookie, source }` with a one-line printable-ASCII cookie. Fix or remove the bad entry and log in again. |
| `No signed-in <site> session found. Searched <profiles>.`, then `<profile>: <problem>` | The browser import found no usable session. Problems: `could not read its cookie database`; `no "<Browser> Safe Storage" key in the Keychain`; `Keychain access to "<Browser> Safe Storage" was denied` (also under SSH, where no dialog can show); `secret-tool is not installed`, `secret-tool: <error>` or `no cookie key for <app> in the keyring` (Linux, including KWallet, which is not read); `could not decrypt its cookies`; `signed out of <site>`. Sign in, wait half a minute and run it again, or paste the header. |
| `No supported browser found (…)` / `Every signed-in browser profile is already stored as another session (…)` | No listed browser is installed, or `--label` names a new session but every signed-in profile is stored under another label: log in with another profile, or omit `--label` to refresh them. |
| `Anthropic rejected this key (HTTP 401) …`, `Anthropic refused this key (HTTP 400) …`, `Google rejected this key (HTTP <n>) …` | The key is mistyped, revoked or expired, or (400) an Anthropic key not scoped to a workspace. Create a new one as the message says and paste it. |
| `This key belongs to another organization (<id>), not <org> (<id>). …` | The key bills another Console org than the pool reads. Switch to the named org in the Console, create a key there and paste it. |
| `Anthropic did not say which organization owns this key; …`, `… returned HTTP <n> for the key check …`, `Could not reach … to check the key: …` | The key check could not finish; try again later, or update schmear. |
| `That is not an Anthropic API key (sk-ant-…, not a session cookie or login token); copy the key itself.` / `That is not a Gemini API key (they start with AIza or AQ.); copy the key itself.` | What you pasted does not look like a key, so it was sent nowhere. Copy the key itself. |
| `Your login Keychain did not keep the key. Unlock it and run schmear credits again.` / `Your keyring did not keep …` | The store did not read back the key it wrote; nothing was saved. Unlock it and rerun. |
| `secret-tool is not installed. Install libsecret-tools (Debian, Ubuntu) or libsecret (Fedora, Arch), then run schmear credits again.` | Linux keeps keys through `secret-tool`; install it. |
| `Could not delete the stored key <service>; delete it in Keychain Access` (or `your keyring`) | `credits remove` or `uninstall` removed the pool but not its key; delete the item yourself. |
| `pipe the Cookie header in: pbpaste \| schmear credits login <vendor> --stdin [--label <name>]` | `--stdin` refuses a terminal. Pipe the header in, or drop `--stdin` to import or paste. |
| `invalid answer to: <question> (…)` | Piped input gave an answer the prompt does not take; the reply itself is never shown. |
| `No credit pool "<id>". Configured: <ids>.` / `No credit pool "<id>". You have none; run schmear credits to set one up.` | `credits remove` or `credits reset` named a pool that does not exist. |
| `No subscriptions set up yet; run schmear init first.` / `Claude Code is not set up in schmear; run schmear init and tick a Claude account.` / `Antigravity is not set up in schmear; run schmear init and tick an Antigravity account.` | `schmear credits` needs a consented account to run its pools. |
| `Found none of claude, codex, grok, agy or opencode on your PATH. Install one and sign in, then run schmear init again.` | `schmear init` wrote nothing. |
| `unknown command "<name>". Run schmear --help.` / `unknown option --<name>. Run schmear --help.` | A typo; bare `schmear` prints the help. |
| `unknown option --<name> for <command>. Run schmear <command> --help.` / `--driver needs a value: one of …` / `--label needs a name` | The command does not take that option, or the option is missing its value. `schmear <command> --help` and `schmear help <command>` list what it takes. |
| `no answer for "<question>": run it in a terminal` (`, or pass --yes` for `init` and `uninstall`) | Piped input ended before the question was answered. |
| `nothing on stdin; pipe the Cookie header: pbpaste \| schmear credits login <vendor> --stdin` | `--stdin` read an empty header. |
| `no Google credit for billing account <id> in any Google session` | No stored session lists a credit on that billing account; log in with the Google account that holds it, or remove the pool with `schmear credits remove <id>`. |
| `Google credit is in <CUR>; schmear meters USD` | Non-USD credits are skipped and the wizard does not offer them; schmear meters USD only. |
| `Could not parse Google Developer Program …` | The undocumented Benefits response format changed; update schmear or report the error. |
| `Google Developer Program requests are rate limited…`, `… is unavailable…`, `… returned HTTP <n>…` | Google refused or failed a read; the pool is skipped and retried at the next read. |
| `agy does not offer auth method gemini-api-key`, `agy authenticate gemini-api-key failed: …` | The installed `agy` is too old for key mode (needs 1.5.0 or newer) or rejected the key's setup; the task fails without running on your Antigravity login. Update `agy` or fix the key. |
| `credit pool config invalid: billingAccount` / `taskCapUsd` | A `gemini-credits` entry needs `billingAccount` (like `ABCDEF-123456-ABCDEF`) and takes no `taskCapUsd`; run `schmear credits` or fix the entry. |
| `<pool id> ledger write failed…` (task note) | The ledger could not be written; the task ran on another lane, or, after the run, its reservation stays counted. |
| `no_quota` | No consented lane at or above the task's tier has quota; do the task yourself. |
