#!/bin/sh
# Registers mcp_logger.py with one MCP host for a single headless run (no user-level config
# is modified; grok and agy get a project-scoped file inside the throwaway fixture repo) and asks
# for two parallel probe_sleep calls (mode=parallel), one long call (mode=timeout:<seconds>), one
# probe_elicit call that sleeps <seconds> after the answers (mode=elicit:<seconds>[:<count>]), or the same
# call against a 2026-07-28-only server that asks through <rounds> multi-round-trip prompts
# (mode=mrtr:<seconds>:<rounds>; codex also gets -c features.mcp_2026_07_28=true). Claude only:
# PK_CLAUDE_SETTINGS (extra --settings JSON, e.g. an Elicitation hook) and PK_TIMEOUT_MS (server timeout).
# The logger's JSONL shows clientInfo, call overlap, and where a call was cut off.
# Usage: host_mcp_probe.sh <claude|codex|grok|agy> <mode> <fixture repo> <log file> [ro] [agy timeoutSeconds]
set -u
host=$1; mode=$2; repo=$3; log=$4; ro=${5:-rw}; agy_timeout=${6:-}; mod=""; cx=""
here=$(cd "$(dirname "$0")" && pwd)
py=$(command -v python3)
case $mode in
  parallel) prompt='Call the probe_sleep tool twice in parallel in a single step (two tool calls in the same message): seconds=5 tag=A, and seconds=5 tag=B. Then reply DONE.';;
  timeout:*) s=${mode#timeout:}; prompt="Call the probe_sleep tool once with seconds=$s tag=T. Then reply with the exact tool result text, or the exact error message if the call failed.";;
  elicit:*) a=${mode#elicit:}; s=${a%%:*}; n=1; [ "$a" = "$s" ] || n=${a#*:}
    prompt="Call the probe_elicit tool once with seconds=$s count=$n. Then reply with the exact tool result text, or the exact error message if the call failed.";;
  mrtr:*) a=${mode#mrtr:}; s=${a%%:*}; n=${a#*:}; mod=modern; cx="-c features.mcp_2026_07_28=true"
    prompt="Call the probe_elicit tool once with seconds=$s count=$n. Then reply with the exact tool result text, or the exact error message if the call failed.";;
esac
cd "$repo" || exit 2
case $host in
  claude)
    t=""; [ -n "${PK_TIMEOUT_MS:-}" ] && t=",\"timeout\":$PK_TIMEOUT_MS"
    cfg="{\"mcpServers\":{\"probe\":{\"command\":\"$py\",\"args\":[\"-I\",\"$here/mcp_logger.py\",\"$log\",\"$ro\",\"$mod\"]$t}}}"
    st=${PK_CLAUDE_SETTINGS:-}; [ -n "$st" ] || st='{}'
    claude -p "$prompt" --mcp-config "$cfg" --strict-mcp-config --allowedTools 'mcp__probe__*' --settings "$st" --output-format json ;;
  codex)
    codex exec --skip-git-repo-check -s read-only $cx \
      -c "mcp_servers.probe.command=\"$py\"" -c "mcp_servers.probe.args=[\"-I\",\"$here/mcp_logger.py\",\"$log\",\"$ro\",\"$mod\"]" \
      -c 'mcp_servers.probe.default_tools_approval_mode="approve"' "$prompt" < /dev/null ;;
  grok)
    mkdir -p .grok && printf '[mcp_servers.probe]\ncommand = "%s"\nargs = ["-I", "%s/mcp_logger.py", "%s", "%s", "%s"]\n' "$py" "$here" "$log" "$ro" "$mod" > .grok/config.toml
    grok --no-auto-update -p "$prompt" --trust --always-approve --output-format json ;;
  agy)  # `agy --settings` rejects mcpServers ("unknown setting"), so use the workspace MCP file
    t=""; [ -n "$agy_timeout" ] && t=",\"timeoutSeconds\":$agy_timeout"
    mkdir -p .agents && printf '{"mcpServers":{"probe":{"command":"%s","args":["-I","%s/mcp_logger.py","%s","%s","%s"]%s}}}\n' "$py" "$here" "$log" "$ro" "$mod" "$t" > .agents/mcp_config.json
    AGY_CLI_DISABLE_AUTO_UPDATE=true agy -p "$prompt" --dangerously-skip-permissions --output-format json < /dev/null ;;
esac
