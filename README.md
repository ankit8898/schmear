<p align="center">
  <img src="assets/cover.jpg" alt="schmear cover art" width="760">
</p>

<h1 align="center">schmear</h1>

<p align="center"><b>Optimize your weekly AI budgets by delegating to subagents across your subscriptions intelligently.</b></p>

<p align="center">
  <a href="https://github.com/kevin1chun/schmear/actions/workflows/ci.yml"><img src="https://github.com/kevin1chun/schmear/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/schmear"><img src="https://img.shields.io/npm/v/schmear" alt="npm"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT"></a>
  <a href="https://buymeacoffee.com/kevin1chun"><img src="https://img.shields.io/badge/Buy%20Me%20a%20Coffee-support-FFDD00?logo=buymeacoffee&logoColor=black" alt="Buy Me a Coffee"></a>
</p>

If you're like me, you don't have just one AI subscription. I personally run 4 subs across 3 providers. Claude Code is my primary driver, but it's annoying and slow when I'm running low on usage and need to swap accounts or providers because of the whole oauth + cache hit dance. The worst is when I don't manage my budgets well enough so I end up leaving usage on the table (wasted money!).  
<br />
Schmear solves this by transparently and intelligently spreading load across all of your subscriptions via ACP. At its core, Schmear is a load balancing algorithm that allows you to get the most out of your tokens without any of the toil.

## Install

### macOS app

Requires macOS 14+ (Sonoma) on Apple silicon. Install with Homebrew, which also installs the CLI and Node:

```sh
brew install --cask kevin1chun/tap/schmear
```

Or download the notarized `Schmear.zip` from [GitHub Releases](https://github.com/kevin1chun/schmear/releases); without the CLI, its **Set Up in Terminal** button installs it.

### Linux tray app

Release archives for x86_64 and ARM64 run against your system's Qt and need glibc 2.34+ and Qt 6.4+: Ubuntu 24.04, Debian 12 and 13, Fedora and Arch qualify. Older systems with Qt 6.4+ can [build from source](linux/README.md#build-from-source). The CLI comes from npm and needs Node 22.18 or later:

```sh
npm i -g schmear --omit=optional
```

Install the Qt runtime and curl for your distribution:

```sh
sudo apt install curl libqt6widgets6t64 libqt6network6t64 qt6-qpa-plugins qt6-wayland  # Ubuntu 24.04
sudo apt install curl libqt6widgets6 libqt6network6 qt6-qpa-plugins qt6-wayland        # Debian 12 and 13
sudo dnf install curl qt6-qtbase-gui qt6-qtwayland                                     # Fedora
sudo pacman -S --needed curl qt6-base qt6-wayland                                       # Arch
```

Then download, verify and install, in `sh` or `bash`:

```sh
(
set -eu
arch=$(uname -m)
case "$arch" in x86_64|aarch64) ;; *) echo "Unsupported architecture: $arch" >&2; exit 1 ;; esac
f=schmear-tray-linux-$arch.tar.gz
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cd "$work"
url=https://github.com/kevin1chun/schmear/releases/latest/download
curl -fsSLO "$url/$f"
curl -fsSLO "$url/$f.sha256"
sha256sum -c "$f.sha256"
tar -xzf "$f"
sh "./${f%.tar.gz}/install.sh"
)
```

The installer puts `schmear-tray` in `~/.local/bin` and adds a "schmear" entry to the app menu. Its tray icon needs KDE Plasma, XFCE, GNOME with the AppIndicator extension (built into Ubuntu; on Fedora and Debian install and enable `gnome-shell-extension-appindicator`), or waybar's `tray` module on Sway and Hyprland, where Open at Login also needs uwsm or dex to run XDG autostart entries. Without a tray it runs as a normal window.

To upgrade, quit schmear from its tray menu, rerun the block and start it again. To uninstall:

```sh
rm -f ~/.local/bin/schmear-tray ~/.local/share/applications/schmear-tray.desktop \
  ~/.local/share/icons/hicolor/scalable/apps/schmear-tray.svg ~/.config/autostart/schmear-tray.desktop
```

### First run

```sh
schmear init
```

It registers schmear with your agents and asks which subscriptions to use. Restart your agent afterwards.

`schmear uninstall` removes schmear from every agent and deletes its skills, config and state; then `brew uninstall --cask schmear && brew uninstall schmear` if you installed with Homebrew.

## How it works

1. Your agent calls schmear's `delegate` tool with one or more self-contained tasks, each with a minimum model tier.
2. schmear reads every subscription's quota and reset time, without running a model.
3. Each task goes to the subscription with the most quota left for the time left until its reset, on a model at or above the task's tier.
4. The worker runs on your existing login and the result comes back to your agent. Up to 8 tasks run at once.

```mermaid
flowchart TB
    driver["Driver Agent<br/>Claude Code · Codex · Grok · Antigravity"]

    subgraph schmear["schmear serve (local MCP stdio process)"]
        server["MCP Server<br/>delegate + usage tools"]
        router["Router & Tiers<br/>pace scoring + driver reserve"]
        usage["Quota Readers<br/>read-only, no inference"]
        acp["ACP Runner<br/>up to 8 concurrent workers"]
        state[("Local State<br/>usage cache + credit ledger")]

        server --> router
        router --> usage
        usage <--> state
        router --> acp
    end

    subgraph workers["Workers over Agent Client Protocol (existing logins)"]
        direction LR
        w1["Claude Code<br/>claude-agent-acp"]
        w2["Codex<br/>codex-acp"]
        w3["Grok<br/>grok agent stdio"]
        w4["Antigravity<br/>agy acp"]
    end

    driver -- "MCP stdio: delegate(tasks) / usage" --> server
    acp -. "MCP elicitation: permission prompts" .-> driver
    acp -- "ACP stdio" --> workers
    workers -- "results + session handles" --> server
    server -- "batched results" --> driver
```

### The algorithm

Every subscription gets a **pace**: how fast it would need to spend to use up its quota by its next reset. The ordering is [least-laxity-first](https://en.wikipedia.org/wiki/Least_slack_time_scheduling) scheduling from real-time systems, with unused quota as the remaining work and the reset as the deadline, taken as a ratio so windows of different lengths compare.

```
pace = (fraction left − threshold) × window length ÷ time until reset
```

A pace above 1 means quota will expire unused at the current rate, so the highest pace goes first. For example, with a weekly Grok plan 100% unused and resetting in 6.5 days, and the Claude plan you're typing in 40% unused and resetting in 3 days:

| | Left | Threshold | Resets in | Pace |
|---|---|---|---|---|
| Grok | 100% | 2% floor | 6.5 d | 0.98 × 7 ÷ 6.5 = **1.06** |
| Claude (your driver) | 40% | 5% reserve | 3 d | 0.35 × 7 ÷ 3 = 0.82 |

The next task goes to Grok. The rules around the pace:

- **Floor.** A subscription with 2% or less left in any window, or one whose usage can't be read, gets no tasks.
- **Reserve.** The subscription of the agent you're typing in keeps 5% for you, until the last 2 hours before its reset.
- **Tier.** Only models at or above the task's tier are candidates.
- **Ties.** Subscriptions within 5% of the best pace count as tied. Tasks in one call spread across them, and among them schmear prefers the least-loaded one, then the lowest tier that fits.
- **Reroute.** A worker that runs out of quota mid-task is retried on the next best subscription. If none is left, the result is `no_quota`.

Usage readings are cached for up to 5 minutes. The full rules are in the [guide](docs/guide.md#routing).

To change which models count for each tier, or the reserve your driver keeps, see [Tier configuration](docs/guide.md#tier-configuration).

### Multiple accounts

Two Claude subscriptions under different emails, or two logins of any supported CLI, can both take work. Every subscription has a nickname: the login each CLI already has is `@default` (`claude@default`), and each one you add gets a name you pick, such as `claude@work`.

After the subscription checklist, `schmear init` asks "Add another subscription?": pick the provider and a nickname, sign in to the account you're linking in your browser (at claude.ai, chatgpt.com, grok.com or your Google account), confirm, and the CLI's usual sign-in opens and approves that account. It asks again until you pick Done.

`schmear usage` then shows `claude@work` as its own pools next to `claude@default`, and the router weighs it by pace like any other subscription. schmear doesn't switch your login: it sets `CLAUDE_CONFIG_DIR` only on the worker processes it starts for that account, so the agent you're typing in stays on its own login. Codex, Grok and Antigravity work the same way; see [Accounts](docs/guide.md#accounts).

## Menu bar and tray apps

The macOS menu bar app and the Linux tray app show your pools, pace, next lane per tier and recent delegations, and edit your tiers. Both read the `schmear` CLI; see [macos/README.md](macos/README.md) and [linux/README.md](linux/README.md). Inspired by [CodexBar](https://github.com/steipete/CodexBar).

<img src="docs/menu-bar.png" alt="The schmear menu bar popover: four subscriptions with quota bars and pace, the next lane per tier, and recent delegations" width="360">

## Supported agents

| Agent | CLI | Delegates tasks | Runs tasks |
|---|---|:---:|:---:|
| Claude Code | `claude` | ✓ | ✓ |
| Codex | `codex` | ✓ | ✓ |
| Grok | `grok` | ✓ | ✓ |
| Antigravity | `agy` | ✓ | ✓ |

Workers launch over the [Agent Client Protocol](https://agentclientprotocol.com) on the logins you already have. No API keys required.

## Docs

[Guide](docs/guide.md) · [Safety](docs/safety.md) · [Design](docs/spec.md) · [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md)

## Support

If you love this and get more money out of your subs, please consider helping me out!

<a href="https://buymeacoffee.com/kevin1chun"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me a Coffee" height="45"></a>

## License

[MIT](LICENSE).
