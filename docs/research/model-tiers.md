# Model tiers: ACP controls, pools and the tier list

Gathered 2026-11-21 on the R1–R4 machine (claude 2.1.330, codex-cli 0.147.0, grok 1.0.77, agy 1.5.14; claude-agent-acp 0.109.1, codex-acp 2.9.0). Re-audited 2026-11-23 with codex-cli 0.171.0, grok 1.0.92, agy 1.5.15, claude-agent-acp 0.110.0 and codex-acp 2.10.0 (each the latest per its vendor's release page): Codex now offers GPT-6.x, Grok gained an effort option, and the other lists and every earlier AA and Epoch score are unchanged. Re-audited 2026-11-24 with agy 1.5.16, which adds Gemini 4 Carbon (low–high) to the Gemini Models pool; Epoch's ECI now rates GPT-6.x and Carbon. Re-audited 2026-11-25 with opencode 2.4.1 (signed out), which adds the `opencode-go` lane; four of its models copy ratings made for the same models elsewhere. The default list applies the spec's model-tiers decision (`docs/spec.md` Decisions) at reference effort `medium`: tier 1 Haiku, 2 Sonnet, 3 Opus, 4 Fable; the tier is a floor.

## 1. Probe

`T=<probe dir>/tiers`, `A=<probe dir>/adapters` (spec §19 setup), `S=docs/probes/config_probe.py`. The script sends `initialize` and `session/new {cwd, mcpServers: []}`, writes `configOptions`/`models`/`modes` to `$T/out/<label>.json`, sends `session/close` (all four advertise it, all answered ok), and terminates. It never sends `session/prompt`, so no inference ran. Cwd: a fresh `git init` dir `$T/run`.

```
CLAUDE_CODE_EXECUTABLE=$(command -v claude) python3 -I $S claude $T/run $T/out -- node $A/claude-acp/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js
CODEX_PATH=$(command -v codex) python3 -I $S codex $T/run $T/out -- node $A/codex-acp/node_modules/@agentclientprotocol/codex-acp/dist/index.js
python3 -I $S grok $T/run $T/out -- grok --no-auto-update agent stdio
AGY_CLI_DISABLE_AUTO_UPDATE=true python3 -I $S agy $T/run $T/out -- agy acp
```

### claude (claude-agent-acp 0.109.1, user's claude 2.1.330)

| id | category | values (current first) |
|---|---|---|
| `model` | `model` | current `opus`; `default` (Opus 5.5), `opus` (Opus 5.5), `fable` (Fable 5.2), `sonnet` (Sonnet 5.5), `haiku` (Haiku 5.5), `claude-fable-5-1`, `claude-haiku-4-5-20251001`, `claude-sonnet-5`, `claude-opus-5`, `claude-fable-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6`, `claude-sonnet-4-6` |
| `effort` | `thought_level` | current `high`; `default`, `low`, `medium`, `high`, `xhigh`, `max` |
| `fast` | `speed` | current `off`; `off`, `on` |
| `ultracode` | `model_config` | current `off`; `on`, `off` |
| `mode` | `mode` | current `auto`; `default`, `acceptEdits`, `plan`, `auto`, `bypassPermissions` |
| `agent` | none | current `default`; `default` plus the user's own subagent names |

- Effort is a separate `thought_level` option. Its values are the current model's `supportedEffortLevels` from the SDK, so the list changes when the model changes (`dist/session-effort.js:82–121`).
- Anthropic's effort doc says Fable 5.2, Opus 5.5, Sonnet 5.5 and Haiku 5.5 each support all five levels. Haiku 4.5 is not on its effort list, and Opus 4.6 lacks `xhigh` (platform.claude.com/docs/en/build-with-claude/effort).
- The current models are offered only as the aliases `haiku`, `sonnet`, `opus` and `fable`, so the list uses those. No pinned id for them is listed.
- No `models` field (the unstable API) is returned.

### codex (codex-acp 2.10.0, user's codex 0.171.0; probed on a Free-plan ChatGPT account, R13)

| id | category | values |
|---|---|---|
| `model` | `model` | current `gpt-6-luna`; `gpt-6-luna` ("Fast and affordable model for easier tasks"), `gpt-5.6-terra` ("Legacy balanced model for agentic coding"), `gpt-5.6-luna` ("Legacy fast model for simpler tasks") |
| `reasoning_effort` | `thought_level` | current `medium`; `low`, `medium`, `high`, `xhigh`, `max` |
| `mode` | `mode` | current `agent`; `read-only`, `workspace-write`, `agent`, `agent-full-access` |
| `collaboration_mode` | `collaboration_mode` | current `default`; `default`, `plan` |

- Effort has two forms: the separate `thought_level` option, and model-id suffixes in `models.availableModels` (`gpt-6-luna[low]` … `[max]`, current `gpt-6-luna[medium]`). Only `gpt-5.6-terra` adds `ultra`.
- The official model list (learn.chatgpt.com/docs/models, read 2026-11-23) names the Codex ids `gpt-6.2-astra`, `gpt-6-astra`, `gpt-6.2-sol`, `gpt-6.1-sol`, `gpt-6.1-terra` and `gpt-6-luna`, Astra and Sol "on supported plans"; codex 0.171.0's release notes add GPT-6.2 Sol and Astra. GPT-5.6 is not on it. The Free plan offers only `gpt-6-luna` of these. The page gives no per-model effort set; the list assumes `low`–`max` for each, as probed for Luna.
- The list never uses `ultra`: it delegates the work, so it is not an effort level.

### grok (`grok --no-auto-update agent stdio` 1.0.92; probed on a Free-tier account, R14)

| id | category | values |
|---|---|---|
| `model` | `model` | current `grok-4.7`; `grok-4.7` |
| `reasoning_effort` | `thought_level` | current `high`; `xhigh`, `high`, `medium`, `low` |

- 1.0.77 had no effort configOption; it showed effort only in `models.availableModels[grok-4.7]._meta`. 1.0.92 adds `reasoning_effort`.
- The documented route is the launch overlay `GROK_CONFIG='{"models":{"default":"grok-4.7","default_reasoning_effort":"<effort>"}}'` (`~/.grok/docs/user-guide/05-configuration.md:30–33`; `models.*` is on its allowlist). schmear sets model and effort this way at launch; the live tiers test confirmed it (spec R41).

### opencode (`opencode acp` 2.4.1, signed out with a placeholder `OPENCODE_API_KEY`; spec R46)

Same `initialize` and `session/new`, then `session/set_config_option` `model` per model; no `session/close`, no prompt. The Zen provider is denied through `OPENCODE_CONFIG_CONTENT` (spec §8.5), so every model is `opencode-go/<id>`.

| id | category | values |
|---|---|---|
| `model` | `model` | `<provider>/<model>`, here `opencode-go/*` |
| `effort` | `thought_level` | the model's variants plus `default`; absent for a model without variants |
| `mode` | `mode` | `build`, `plan` |

- Probed effort values: `opencode-go/gpt-6-luna` and `opencode-go/claude-haiku-5-5` `none`, `low`, `medium`, `high`, `xhigh`, `max`, `default`; `opencode-go/gemini-4-argon` `low`, `medium`, `high`, `default`; `opencode-go/grok-4.7` `low`, `medium`, `high`, `xhigh`, `default`.
- Variants come from models.dev's per-model reasoning efforts (`packages/core/src/variant.ts:25–37` in anomalyco/opencode), so they differ by model; models.dev's list for other Go models (read 2026-11-25, not probed) has kimi-k3 `max` only, glm-5.3 `low`, `high`, `max`, and minimax-m3 none, which leaves no `effort` option.
- An entry's `model` is the full `opencode-go/<id>` value and its `effort` is the `effort` value; the model list is the signed-in catalog's, so a model absent from it fails before the prompt.

### agy (`agy acp` 1.5.15; Carbon from 1.5.16)

| id | category | values |
|---|---|---|
| `model` | `model` | current `gemini-4-neon`; `gemini-4-neon`, `gemini-4-carbon` (1.5.16), `gemini-4-argon`, `gemini-4-hydrogen`, `gemini-pro-orchestrator-neon`, `gemini-pro-orchestrator-g1-pro` ("Orchestrator (Argon)"), `gemini-3.8-flash`, `claude-opus-5-5`, `claude-sonnet-5-5`, `gpt-oss-120b-medium` |
| `thought_level` | `thought_level` | current `high`; `low`, `medium`, `high`, `xhigh` ("Extra") |
| `mode` | `mode` | current `default`; `default`, `accept-edits`, `auto`, `plan` |

- Effort has two forms: the `thought_level` option, and suffixed ids in `models.availableModels` (current `gemini-4-neon-high`).
- The suffixes give each model's real effort set:

  | Model | Efforts |
  |---|---|
  | Neon, Hydrogen | low–xhigh |
  | Carbon, Argon, 3.8 Flash | low–high |
  | Claude Opus 5.5, Claude Sonnet 5.5 | low–high |
  | Orchestrators | no effort variant |
  | `gpt-oss-120b-medium` | medium only |

- An entry's `model` is the configOption value, and its `effort` is the `thought_level` value.

## 2. Quota pools

| Agent | Model | Pool and windows |
|---|---|---|
| claude | every model | `claude`: `five_hour` + `seven_day` (spec §8.1) |
| claude | `sonnet` | + `seven_day_sonnet` |
| claude | `opus` | + `seven_day_opus` |
| claude | `fable` | + its `limits[].weekly_scoped` row ([CodexBar `docs/claude.md`](https://github.com/steipete/CodexBar/blob/e6edfb87d5bcdcd942de8b11d111d6c132ee392e/docs/claude.md) lines 254, 267 name Fable) |
| claude | `haiku` | main windows only (no Haiku-scoped window is documented) |
| codex | terra, luna | `codex`: one 43200-min window on the probed Free plan (R13) |
| grok | grok-4.7 | `grok`: weekly `currentPeriod` (R14) |
| agy | neon, hydrogen | `Gemini Models` (weekly + 5h). Neon and Hydrogen share it. |
| agy | argon | `Gemini 4 Argon` (weekly) and also `Gemini Models`: Argon draws on both pools |
| agy | claude-opus-5-5, claude-sonnet-5-5, gpt-oss-120b | `Claude and GPT models` (weekly; its 5h bucket was `disabled: True` on the probed account) |
| agy | 3.8 Flash, orchestrators | Assumption: `Gemini Models`, with Orchestrator (Argon) also in Argon. `/usage` groups list no members. |
| opencode | every `opencode-go/*` model | `opencode-go`: rolling 5 h, weekly and monthly meters of one shared allowance (spec §8.5) |

Group names come from `AGY_CLI_DISABLE_AUTO_UPDATE=true agy -p /usage --output-format json` (`status SUCCESS`, `num_turns 0`). It printed groups `Gemini Models` [weekly, 5h], `Claude and GPT models` [weekly, 5h disabled] and `Gemini 4 Argon` [weekly].

Because pools differ inside agy, the list keys agy by its spec §8.4 lanes: `agy-gemini`, `agy-argon` and `agy-3p`.

## 3. Tier list

**Reference scores.** Artificial Analysis Intelligence Index v5.0.1 per effort, from artificialanalysis.ai/models/<model>, read 2026-11-21 (Carbon 2026-11-24), and Epoch ECI with its 90% interval, from epoch.ai/data/eci_scores.csv, read 2026-11-24:

| Model | low | medium | high | xhigh | max | ECI (interval) |
|---|---|---|---|---|---|---|
| Haiku 5.5 (tier 1) | 19 | 25 | 30 | 35 | 36 | 160.33 (158.18–162.69) |
| Sonnet 5.5 (tier 2) | 26 | 31 | 42 | 50 | 55 | 166.6 (163.92–169.61) |
| Opus 5.5 (tier 3) | 35 | 48 | 52 | 57 | 59 | 168.67 (165.92–171.96) |
| Fable 5.2 (tier 4) | 54 | 56 | 62 | 62 | 65 | 173.4 (170.04–177.22) |

**Rule.** The list is the `medium` column of `docs/probes/grid.py`'s output. One rule applies to every lane, with no per-lane overrides.

1. Per lane, tier T holds the weakest offered `model@effort`, effort ≥ `medium`, whose AA score is at least the Claude tier-T model's score at `medium` (Haiku 25, Sonnet 31, Opus 48, Fable 56).
2. The chosen effort is never below `medium`. When the model lacks `medium`, it clamps to the model's highest effort, and only if that still meets the score.
3. When an effort has no AA score, it takes the nearest lower measured score. With no lower measured score, that effort is unrated.
4. When Epoch rates the model, the top of its ECI interval must reach the bottom of the Claude tier-T model's interval (158.18, 163.92, 165.92, 170.04); below it, the model is significantly weaker on Epoch and fails the tier. A model Epoch does not rate is judged on AA alone. ECI has one score per model, not per effort.

| Model | AA v5.0.1 scores | ECI (interval) | Rating |
|---|---|---|---|
| haiku, sonnet, opus, fable | above | above | Definitional: tiers 1–4 at `medium` ("Model selection matrix", platform.claude.com/docs/en/about-claude/models/choosing-a-model). |
| gpt-6-luna | low 10, medium 18, high 21, xhigh 23, max 28 | 156.45 (154.58–158.48) | `max` at tier 1 (28 ≥ 25; ECI top 158.48 ≥ 158.18, by 0.3). |
| gpt-6.1-terra | low 29, medium 38, high 42, xhigh 45, max 51 | 167.71 (164.86–171.04) | `medium` at tier 2 (38 ≥ 31); `max` at tier 3 (51 ≥ 48). Max 51 misses tier 4. Paid plans. |
| gpt-6.2-sol | low 41, medium 53, high 55, xhigh 56, max 57 | not listed | `xhigh` at tier 4 (56 ≥ 56, a tie, on AA alone). Weaker Codex entries already cover tiers 1–3. |
| gpt-6.2-astra | low 46, medium 57, high 60, xhigh 62, max 62 | 172.82 (169.37–176.94) | Clears tier 4 on both indexes at `medium`, but Sol `xhigh` is weaker and also clears it. |
| gpt-6.1-sol, gpt-6-astra | unscored | 168.61, 169.21 | Excluded: no AA score. |
| gpt-5.6-terra, gpt-5.6-luna | Terra max 32, Luna max 24 | 160.8, 156.7 | Excluded: off OpenAI's Codex model list, labelled "Legacy" by codex-acp and deprecated by AA. |
| grok-4.7 | low 31, high 35, xhigh 35; medium assumed 31 | 156.43 (154.51–158.52) | `medium` at tier 1 only. AA's assumed 31 ties Sonnet, but the ECI top 158.52 is under Sonnet's 163.92. |
| gemini-4-hydrogen | low 27, medium 41, high 51, xhigh 54 | 166.81 (163.99–170.1) | `medium` at tiers 1–2 (41 ≥ 31); `high` at tier 3 (51 ≥ 48). Xhigh 54 misses tier 4. |
| gemini-4-carbon | low 54, medium 58, high 60 | 169.68 (166.58–173.14) | `medium` at tier 4 (58 ≥ 56; ECI top 173.14 ≥ 170.04). Agy 1.5.16 adds it to the Gemini Models pool. |
| gemini-4-neon | low 44, medium 55, high 60, xhigh 61 | not listed | None: Hydrogen is weaker at tiers 1–3 and Carbon `medium` is weaker at tier 4. |
| gemini-4-argon | medium 48, high 50; low unscored ("2 effort levels") | 166.53 (163.94–169.47) | `medium` at tiers 1–3 (48 ≥ 48). High 50 misses tier 4. |
| claude-opus-5-5, claude-sonnet-5-5 via agy | Assumption: the native scores | as native | Sonnet `medium` at tiers 1–2, Opus `medium` at tier 3; capped at `high` by agy's suffix list, so none reaches tier 4. |
| claude-haiku-5-5, gpt-6-luna, grok-4.7, gemini-4-argon via `opencode-go` | Assumption: each model's scores on `claude`, `codex`, `grok` and `agy-argon` above | as above | The same entries as there: Haiku 5.5 `medium` and Grok 4.7 `medium` at tier 1, GPT-6 Luna `max` at tier 1, Argon `medium` at tiers 1–3. Go offers each at that effort (R46). |
| other `opencode-go` models (GLM, Kimi, Qwen, DeepSeek, MiniMax, MiMo, Hy, Step, LongCat, `gpt-5.6-luna`) | not read | not read | Excluded: unrated. The `*-contributor` Muse Spark models also train on your data and the `*-free` ones carry no allowance. |
| gemini-3.8-flash | low 23, medium 30, high 31 | 158.81 (156.82–161.01) | Excluded: AA marks it deprecated, so its scores are not maintained. |
| gpt-oss-120b-medium | high 4 | 140.2 | Excluded: below tier 1. |
| orchestrators | no score | no score | Excluded: unrated. |

Entries are `lane:model@effort`, using the provider's own values. `claude-credits` mirrors `claude`. Each `opencode-go` entry names a model already rated on another lane and is listed after `agy-3p`.

| tier | entries |
|---|---|
| 1 | `claude:haiku@medium`, `codex:gpt-6-luna@max`, `grok:grok-4.7@medium`, `agy-gemini:gemini-4-hydrogen@medium`, `agy-argon:gemini-4-argon@medium`, `agy-3p:claude-sonnet-5-5@medium`, `opencode-go:opencode-go/claude-haiku-5-5@medium`, `opencode-go:opencode-go/gpt-6-luna@max`, `opencode-go:opencode-go/grok-4.7@medium`, `opencode-go:opencode-go/gemini-4-argon@medium`, `claude-credits:haiku@medium` |
| 2 | `claude:sonnet@medium`, `codex:gpt-6.1-terra@medium`, `agy-gemini:gemini-4-hydrogen@medium`, `agy-argon:gemini-4-argon@medium`, `agy-3p:claude-sonnet-5-5@medium`, `opencode-go:opencode-go/gemini-4-argon@medium`, `claude-credits:sonnet@medium` |
| 3 | `claude:opus@medium`, `codex:gpt-6.1-terra@max`, `agy-gemini:gemini-4-hydrogen@high`, `agy-argon:gemini-4-argon@medium`, `agy-3p:claude-opus-5-5@medium`, `opencode-go:opencode-go/gemini-4-argon@medium`, `claude-credits:opus@medium` |
| 4 | `claude:fable@medium`, `codex:gpt-6.2-sol@xhigh`, `agy-gemini:gemini-4-carbon@medium`, `claude-credits:fable@medium` |

## 4. List as data

The default list is `DEFAULT_TIERS` in `src/tiers.ts`, printed in `docs/guide.md`.

## 5. Main unresolved uncertainty

Several entries clear their bar by a hair, on an aggregate index rather than a coding benchmark: GPT-6.2 Sol `xhigh` ties Fable `medium` at 56 and Epoch does not rate it, Argon ties Opus at 48, and GPT-6 Luna's ECI interval clears Haiku's by 0.3. Rule 1 picks the weakest model that clears, so these marginal entries are exactly the ones routed to. The GPT-6.x entries also rest on the official model list rather than a probe, since the probed Free plan does not offer them; a Free-plan Codex account serves tier 1 only. The `opencode-go` entries assume Go serves each model at the quality and effort mapping its first-party lane has; no prompt has run on it, and Go's open-weight models are unrated.
