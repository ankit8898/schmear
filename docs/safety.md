# Safety

How far a [schmear](../README.md) worker can reach, and what each vendor's terms say. Setup and routing are in the [guide](guide.md).

## Trust boundaries

There is no OS-level guarantee and no confinement. Read this before delegating.

- A worker does not inherit the driver's sandbox or permission mode. It runs under its own CLI's mode and sandbox, in any directory the driver names, so a driver limited to read-only can still get files written and commands run through `delegate`. schmear adds no sandbox and forces no mode.
- A Codex worker trusts its cwd (codex-acp marks every session root trusted), so a repository's `.codex/config.toml`, including the MCP server commands it names, takes effect without Codex's trust prompt. Delegate untrusted checkouts only to other agents, for example with `agents: ["claude", "grok", "agy"]`.
- Permission requests a worker sends are forwarded to the driver as an MCP prompt naming the worker and task. Decline, cancel, or a driver that cannot show prompts rejects that one request and the worker continues, as a headless CLI does. This is verified only in each host's headless mode (`claude -p`, `codex exec`, `grok -p`, `agy -p`), where the host cancels or declines the prompt at once; how an interactive session shows it is not yet verified. Which requests arrive is each CLI's choice: Claude and agy ask for edits in default mode, Codex only to leave its sandbox, Grok sent none for edits or MCP calls, and agy asks for every MCP call.
- Tasks given the same `cwd` share that directory. Isolate tasks that could conflict yourself, for example in separate git worktrees.
- Workers can call your MCP tools: they load the same MCP servers their CLI loads directly. Grok calls them without asking.
- schmear adds no text to the prompt and runs no git command.
- schmear strips variables that change an agent's auth or billing route from every worker's environment (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY/ANTHROPIC_AWS/ANTHROPIC_GOOGLE_CLOUD/MANTLE/GATEWAY`, `ANTHROPIC_AWS_API_KEY`, `ANTHROPIC_FOUNDRY_API_KEY`, `AWS_BEARER_TOKEN_BEDROCK`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `CODEX_API_KEY`, `MODEL_PROVIDER`, `CODEX_CONFIG`, `DEFAULT_AUTH_REQUEST`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_GENAI_USE_VERTEXAI`, `XAI_API_KEY`, `GROK_CODE_XAI_API_KEY`, `GROK_AUTH`, `GROK_MODELS_BASE_URL`, `GROK_XAI_API_BASE_URL`, `GROK_CLI_CHAT_PROXY_BASE_URL`), so an exported key cannot silently move a subscription run onto API credits.
- schmear never refreshes a token and never runs inference to read usage. It handles three credentials:
  - The Grok login token in `~/.grok/auth.json`, read in memory only for Grok's usage fallbacks.
  - Any Claude Console `Cookie` header you pass to `schmear credits login claude --stdin`, stored with mode `0600` in `~/.config/schmear/console-sessions.json` (directory `0700`) and removed by `schmear credits logout` or `schmear uninstall`. A Console cookie is a full Console session that can create API keys and buy credits; schmear sends it only to `platform.claude.com` (with redirects disabled) for read-only GETs to the undocumented `/api/organizations` and `/api/organizations/<org>/prepaid/credits` endpoints, and never logs or prints it.
  - Each credit pool's API key, read in memory only from its `keyCommand` once per task, never written to disk or printed (passed to the worker in `ANTHROPIC_API_KEY`).
- Network: `schmear serve` is a stdio MCP server, opens no port and sends no telemetry. schmear itself contacts only `grok.com` and `cli-chat-proxy.grok.com` (for Grok usage) and `platform.claude.com` (when you add a Claude Console session for credit balances); everything else goes through your own CLIs.
- Environment: workers inherit schmear's environment except the stripped variables above (`workerEnv` in `src/acp.ts`), so tokens such as `GITHUB_TOKEN` or cloud credentials in that environment reach every worker.
- A worker's own `schmear serve` (started from its MCP config) sees `SCHMEAR_WORKER=1` and exposes only `usage`. This prevents accidental delegation loops; it is not a security boundary, since a worker with a shell can unset the variable or run another CLI directly.

## Parity

Workers have the default tools, MCP servers, skills and plugins their CLI has when run directly in the same directory. Differences found by the parity test, all from the CLI's own behavior:

- The stripped variables, and the model and effort schmear sets.
- Claude: MCP servers can still be `pending` at the first turn; the SDK entrypoint omits one built-in plugin and adds `SendToProject`; `EnterPlanMode`/`ExitPlanMode` are missing and `AskUserQuestion` is disallowed (as in Claude Code's own subagents).
- Codex: codex-acp disables the `visualize` skill, trusts the session root (see above), and turns off `cwd_relative_turn_diffs`. schmear sets the codex-acp mode that matches your Codex config.

## Terms of service

Sources were read on 2026-11-22. schmear does not decide whether a vendor's terms cover your use; read them yourself.

- **Anthropic.** The [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) says "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products", including Agent SDK agents. The [Legal and compliance page](https://code.claude.com/docs/en/legal-and-compliance) says Anthropic "does not permit third-party developers to … route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users", and may enforce this without prior notice. The same page says this does not "prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription". schmear runs your unmodified `claude` binary on your own login and never reads Claude Code's subscription credentials; Anthropic does not say whether a tool you run for yourself falls under the first two statements or the carve-out. When you configure Claude credit pools, schmear stores your Console `Cookie` header and calls undocumented `platform.claude.com/api/...` endpoints read-only outside Anthropic's clients; no Anthropic statement on this was found, and these endpoints may change or be restricted.
- **Anthropic, billing.** On 2026-04-04 Anthropic moved third-party harnesses, starting with OpenClaw, to separately billed extra usage, saying the policy "applies to all third-party harnesses" ([TechCrunch](https://techcrunch.com/2026/04/04/anthropic-says-claude-code-subscribers-will-need-to-pay-extra-for-openclaw-support/)). A planned change to Agent SDK billing was paused on 2026-06-15; Agent SDK usage on a plan "still draw[s] from your subscription limits" ([help center](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)).
- **Google.** The Antigravity [FAQ](https://antigravity.google/docs/faq) (read 2026-11-24) says that "Wrapping `agy` inside third-party coding agents or applications" is not supported on consumer plans, and names automated account rotation in the same sentence; the [terms](https://antigravity.google/terms) treat third-party access as possible grounds for suspension. schmear is such a wrapper: another vendor's agent drives `agy acp` through it, and with two Google accounts it picks between them. Google documents [`agy acp`](https://antigravity.google/docs/cli/acp) for editors' chat panels only. Users reported accounts disabled after signing in through OpenClaw ([openclaw#14203](https://github.com/openclaw/openclaw/issues/14203)), which extracted tokens; schmear does not. The account at risk is your Google account. Antigravity is unticked in the `schmear init` checklist until you tick it.
- **xAI.** xAI's [Grok Build announcement](https://x.ai/news/grok-build-cli) advertises ACP support for building your own agent orchestration apps; schmear's Grok workers use `grok agent stdio` over ACP. Its Grok usage fallbacks read your Grok login token and call grok.com endpoints with it, read-only, outside the Grok client; no xAI statement on this was found.
- **OpenAI.** schmear runs the official `codex` CLI on your own login.
- **Several accounts.** schmear can route to more than one login per provider ([Accounts](guide.md#accounts)). A provider's consumer terms may limit how one person uses several of its subscriptions; read them before adding an account.

## Claude disclosure

Claude workers run your own `claude` binary on your claude.ai login through Anthropic's Agent SDK, without the adapter's `--hide-claude-auth` flag. Anthropic restricts third-party use of subscription logins and may restrict your account or this route. The adapter is `@agentclientprotocol/claude-agent-acp`; its `--hide-claude-auth` flag would refuse subscription billing. Anthropic's statements are quoted under [Terms of service](#terms-of-service).

To avoid the risk, untick Claude in the `schmear init` checklist; the other three providers keep working, and later runs keep Claude unticked.

If Claude's extra usage is on, a task that crosses the limit may bill your card. schmear cancels a task as soon as Claude reports overage but cannot stop the request in flight.

The Claude route installs `@anthropic-ai/claude-agent-sdk`, a dependency of `@agentclientprotocol/claude-agent-acp`. Its `license` field is `SEE LICENSE IN README.md`, and that README points to Anthropic's Commercial Terms of Service, not an open-source license. It is installed even if you decline Claude.
