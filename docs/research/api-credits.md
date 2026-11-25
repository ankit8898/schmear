# Plan-bundled API credits (researched 2026-11-21)

Read-only web research. Official pages were fetched through a summarizing fetcher, so quotes are short and
may differ by a word from the page; third-party and X posts are marked. Programs are new (Claude: 2026-10-07,
OpenAI: reported 2026-10-28, Google Cloud credits: Jan 2026, claim-in-AI-Studio: Nov 2026), so re-check amounts
before hard-coding.

## Verdict on the premise

| Vendor | Plan includes API credits? |
|---|---|
| Anthropic | Yes on Max ($100), Ultra ($200), Team (pooled, up to $500). **Not Pro.** |
| Google | Yes: Google Cloud credits via Developer Program on AI Pro ($10), Ultra 5x ($40), Ultra 20x ($100). |
| OpenAI | Yes on Pro ($100/$200/$500 by tier) and Business ($20/$100 per seat). **Not Plus.** |
| xAI | **No** per current official docs. A $50/month SuperGrok Heavy credit existed in Aug 2025 and is reported removed (X posts only). |

## Per-vendor table

| | Anthropic (Max / Ultra / Team) | Google (AI Pro / Ultra) | OpenAI (Pro / Business) | xAI (SuperGrok / Heavy) |
|---|---|---|---|---|
| **Included?** | Yes, Max/Ultra/Team. Pro, Free, Enterprise excluded. | Yes, "Google Cloud credits" through Google Developer Program. AI Plus: none. | Yes, Pro and Business. Plus, Enterprise, Edu excluded. | No. |
| **Amount / cadence** | Max $100, Ultra $200 per billing cycle (monthly on annual plans). Team $20 per Standard seat, $100 per Premium seat, pooled, cap $500. Needs 7 days on plan. | Pro $10, Ultra 5x $40, Ultra 20x $100 per month. Cadence = monthly anniversary of first claim, not billing date. | Pro $100/$200/$500 matching tier, per billing period. Business $20 Standard / $100 Premium per seat, pool cap $500/month. First grant prorated. Needs 7 days on plan. | n/a |
| **Expiry** | End of each billing cycle, no rollover. | One year after grant, grants stack, earliest-expiring spent first. | End of billing cycle, no rollover (annual Business: end of year). | n/a |
| **Spendable on** | Claude API (Messages, Batches), Managed Agents, Agent SDK, Console playground. **Not** Claude Code interactive, extra usage, Bedrock/Vertex/Foundry. | Google Cloud and Maps Platform products incl. Gemini API, AI Studio, Firebase, Agent Platform (Vertex). Standard promo exclusions apply. Not named: Antigravity, Gemini CLI. | Paid API Platform usage of the linked org (Responses, Chat Completions, Realtime, Images, built-in tools). **Not** Codex via API key. Does not raise ChatGPT/Codex plan limits. | n/a |
| **Activation** | Opt-in. claude.ai Settings > Billing > API credits > link a Console org, accept terms. Subscriber must be Admin/Billing in the Console org. One org per plan, one plan per org, cannot self-change. | Opt-in. Claim in AI Studio (creates Developer Program profile) or on the Developer Program Benefits page; pick a billing account; tick "Always use this billing account" for auto-apply. Primary subscriber only, no family sharing. Gemini API use needs **$5 minimum prepay**. | Opt-in. ChatGPT Settings > Billing (or Admin Console / API Platform billing), pick API org, confirm. Same email on both accounts; must own subscription and API org. One link each way. | n/a |
| **Balance read** | Console Billing page "Promotional credits" (amount + expiry). **No documented API.** Admin API cost report gives spend only, needs admin key, not for individual accounts. CodexBar's `prepaid/credits` is claude.ai extra-usage credits, a different pool. | AI Studio Billing "Available credits" card; Benefits page. **No official API** (Cloud Billing API lists accounts/projects/SKUs, no credits resource), but the Benefits page's own endpoints answer a signed-in session; CodexBar's `googledeveloper` reads them (addendum V1–V3). | API Platform billing > Credit grants (UI). **No official balance API.** Detect exhaustion by HTTP 429 `credit_balance_exhausted`. | n/a. Console shows prepaid API credits; Management API (`management-api.x.ai`, management key) is said to cover "prepaid credit balances" but the path was not confirmed. |
| **Reset date** | Billing-cycle date of the plan (not exposed by an API; claude.ai usage endpoints do not return it). Note Console spend caps reset on the 1st of the calendar month, credits do not. | Monthly anniversary of first claim; per-grant expiry 12 months. | Subscription renewal date. | n/a |
| **When credits run out** | API requests stop until next grant; "never charged to your Claude plan". Falls to purchased credits if any; auto-reload (card) only if the user enabled it, and it keys off purchased balance only. Error: "credit balance is too low". | Prepay account: HTTP 402, all keys on the billing account stop, until funds added. Card charged only by auto-reload (prepay) or if on postpay. The $5+ prepaid is real money and credits are consumed before it. | 429 `credit_balance_exhausted`. Continues on purchased credits; Auto Recharge (card) only if enabled. No API payment method needed while a grant is active. | Prepaid API credits: requests rejected at zero unless monthly invoiced billing is enabled (then card at month end). |
| **How an agent spends it** | `ANTHROPIC_API_KEY` from the linked Console org with **Agent SDK / `claude -p`** (and so claude-agent-acp, which wraps the SDK). In `-p` the key is always used; interactive Claude Code asks once to approve it but is excluded from coverage. `CLAUDE_CODE_USE_VERTEX` is excluded. Signed-in (OAuth) `-p`/SDK uses plan limits, not credits. | `agy acp` in `gemini-api-key` mode with `GEMINI_API_KEY` from AI Studio (billing = key's billing account; addendum V4, R43), Gemini CLI with the same key, or Vertex AI with a project on the credited billing account. Gemini CLI "Login with Google" and `agy` signed in use the plan, not these credits. Whether Claude-on-Vertex is credit-eligible: not verified. | A non-Codex harness calling the OpenAI API with a key from the linked org. **Codex CLI with an API key is explicitly unsupported by the benefit** and bills standard API rates. Codex signed in with ChatGPT uses plan limits. | n/a. Grok Build signed in uses the weekly SuperGrok pool; an API key bills the Console account. |

## Details and caveats by vendor

### Anthropic

- Official table: "Max: $100, Ultra: $200, up to $500 (Team, pooled)". Refresh: "Each billing cycle (or monthly for annual plans)".
  Expiry: "End of each billing cycle... with no rollover." (platform docs).
- Not Pro. $100 on a top plan matches Max. Third-party posts map Max to 5x and Ultra to 20x; the official page uses Max/Ultra only.
- Coverage subtlety: the Help Center says credits cover `claude -p` and the Agent SDK "when you run them yourself with an API key"
  from the linked org, and exclude "Interactive Claude Code in the terminal, IDE, desktop, or web" and runs from the GitHub Action,
  IDE extensions, or desktop app. The docs also show Claude Code printing "Credit balance too low" for an org holding only these credits,
  so exclusion is enforced server-side by request type, not by which key is used. Untested here: whether claude-agent-acp requests
  classify as Agent SDK. Verify with one real run before relying on it.
- Ranking: `ANTHROPIC_API_KEY` outranks subscription OAuth in Claude Code; with `-p` it is "always used when present". An exported
  key therefore silently moves a subscription run onto credits (and onto the card if the org has auto-reload).
- Sharing: every key and workspace in the linked org draws one balance; cap a project with a workspace spend limit.
- A separate June 2026 monthly Agent SDK credit existed; the FAQ now says "That credit isn't available." Do not count it.
- Balance probing: no official endpoint found. Practical options: user-entered grant and cycle date, minus spend measured from SDK
  result cost fields or the Admin cost report, reconciled when the "credit balance is too low" error appears.

### Google

- Official benefits FAQ: Pro $10, Ultra 5x $40, Ultra 20x $100 monthly; each credit expires "one year after the date they are granted".
  Eligible: "any eligible Google Cloud or Google Maps Platform product". Balance: "active credits at any time" on the Benefits page.
- AI Studio billing doc: promotional credits need funds first ("you must add funds... before you can use promotional Cloud Credits"),
  $5 minimum prepay, prepaid expires in 12 months and is generally non-refundable, zero balance stops all keys with HTTP 402. AI Studio's
  announcement says credits apply after the AI Studio subscription quota is exhausted and the earliest-expiring credits go first.
- Gemini CLI docs list three auth modes: Login with Google (billing tied to account/subscription), Gemini API key (tied to the key), Vertex AI
  (tied to the Cloud project). The same page says Antigravity CLI replaced Gemini CLI for unpaid and Google One users on 2026-06-18. For
  AI Pro/Ultra the credit-drawing path is any client with an API key or Vertex; `agy acp` is one, in `gemini-api-key` mode (addendum V4), and
  Gemini CLI is not a schmear worker.
- Different pool, do not conflate: Google One "AI credits" (purchased; used for Antigravity/Flow overage via the Never/Always toggle).
  Google's help page lists no monthly Antigravity grant; forum reports conflict and are unverified. `agy` signed in does not draw the Developer Program credit; with a Gemini API key it does as any key does (addendum V4).
- Balance probing: no official API. The Benefits page's own endpoints are readable with a signed-in session's Cookie (addendum V1–V3), and only for the current monthly grant; the AI Studio prepaid wallet is UI only. Spend caps in AI Studio are
  marked experimental with about 10 minutes of latency.

### OpenAI

- Pricing page: Plus "No" for monthly API credits; Pro tiers 100/200/500; "Unused credits expire at the end of the applicable billing cycle."
- Help article: Pro $100/$200/$500, Business $20 per Standard and $100 per Premium seat, pooled cap $500/month ($6,000 per annual cycle).
  Renewal grants are automatic after the first link. Unlinking "immediately revokes unused promotional credits".
- Dev guide: "Codex usage through API keys is not supported by this benefit." Codex auth page: API-key usage is billed "at standard API rates"
  and does not use included plan credits. So the credits cannot fuel Codex CLI at all; they need a non-Codex client against the Platform API.
- Balance probing: UI (Credit grants) only. Community threads confirm no balance endpoint; the old dashboard `credit_grants` route needs a
  browser session and is unsupported. Spend can be read from the Usage/Costs API with an admin key (not re-verified on current docs).

### xAI

- Official FAQ: "the billing is separate for Grok and xAI API" (docs.x.ai/console/faq/accounts). No page lists included API credits.
  Grok's X account replied that the API "requires its own pay-per-use account" (X post, secondary).
- History: an Aug 2025 X post said SuperGrok Heavy subscribers get $50/month API credits; a later X post (2026) says it ended. Neither is
  official documentation. Treat as zero.
- API billing: prepaid by default, "Your API requests will be automatically rejected" at zero, invoiced billing off by default.
- Not the same thing: Grok CLI's `_x.ai/billing` exposes `config.prepaidBalance` (purchased wallet in USD cents), documented in [CodexBar `docs/grok.md`](https://github.com/steipete/CodexBar/blob/94cc400e1b190f444e2a4d1910c2d63cfbb47e9f/docs/grok.md).
  It is a purchased balance, not an included monthly grant, and its link to Console API credits is unconfirmed.

## Implications for schmear

1. **Credits are a separate API-key lane, not more subscription quota.** They only spend through an API key from the linked org and only
   on specific harnesses: Claude via Agent SDK / `claude -p` / claude-agent-acp (never interactive Claude Code or Vertex); Gemini via
   `GEMINI_API_KEY` or Vertex (through `agy acp` in key mode, never `agy` on its login); OpenAI via a non-Codex client (never Codex). xAI has none. Model each credit
   pool as its own capacity entry keyed by (agent, auth mode), and inject the key per spawned process, never ambient. An exported
   `ANTHROPIC_API_KEY` silently reroutes subscription runs onto credits and possibly a card.
2. **No vendor documents a remaining-balance API, so schmear meters locally between reads** (the addendum finds undocumented reads for Claude and Google). Store per-pool: monthly grant,
   cycle date (user-entered or derived from the plan's renewal), spend measured from each run's reported cost, and reconcile on the
   vendor's exhaustion signal (Anthropic "credit balance is too low", OpenAI 429 `credit_balance_exhausted`, Google 402). Anthropic and
   OpenAI credits are use-it-or-lose-it per cycle, so the scheduler should bias work toward them as the cycle end nears; Google grants
   last 12 months, so they are low urgency.
3. **Fall-through to real money is opt-in on the vendor side and the tool cannot read it.** Anthropic and OpenAI stop at zero unless
   the user enabled auto-reload/auto-recharge or holds purchased credits; Google needs a $5+ real prepay before credits work and stops at
   402 afterward; xAI stops unless invoiced billing is on. Require the user to confirm those settings in config, prefer a dedicated
   workspace/project with a spend limit, and treat any exhaustion error as a hard stop for that lane, not a retry.

Deferred: verify claude-agent-acp is billed as Agent SDK usage against a linked org (one real run); check whether Claude-on-Vertex is exempt from Google credit exclusions; verify with a real credit that `agy` on a key spends the credit before the prepaid wallet (V6, spec §19 PG).

## Addendum (2026-11-24): vendor balance reads and ACP API-key probes

Supersedes the 2026-11-21 "no vendor exposes a balance" conclusion and confirms xAI's Management API paths. CodexBar references are at commit `a26ca57b518667a659d69524c473af2735069612` (`CB/` = `https://github.com/steipete/CodexBar/blob/a26ca57b518667a659d69524c473af2735069612/`).

- **Anthropic Console (`claudeplatform`, E3–E5):** CodexBar's `claudeplatform` plugin (`CB/Sources/CodexBarCore/Resources/Plugins/claudeplatform.ts`, `CB/docs/claudeplatform.md`, `CB/TestsPlugin/ClaudePlatformPluginTests.swift`) reads Console API credits directly from `https://platform.claude.com` using a `Cookie` header containing `sessionKey` (`Accept: application/json`):
  - `GET /api/organizations` lists orgs; API orgs have `"api"` in `capabilities` and `uuid` matching `^[A-Za-z0-9-]{1,64}$`. 401 → session expired; 403 → session rejected; 429 → rate limited; ≥500 → unavailable.
  - `GET /api/organizations/<org>/prepaid/credits` returns `currency` (default USD, `^[A-Z]{3}$`), `balance.credits.exponent` (int 0–4, default 2), `amount` (safe integer minor units ÷ `10^exp`), `promo_tranches` (included/plan grants, e.g. `subscription_api_credit`) and `tranches` (purchased), each with `granted_amount_minor_units`, `remaining_amount_minor_units`, and optional `name`, `program_id`, `expires_at` (malformed expiry → unknown; granted ≤ 0 or expired skipped; remaining clamped ≥ 0; soonest expiry first). 403 → billing access denied. `current_spend` is optional and display-only.
  - Cookie sources in CodexBar: automatic macOS browser import via SweetCookieKit (Safari, Chrome family, Brave, Opera, Firefox, Zen; Chromium values decrypted with Keychain `<browser> Safe Storage` via PBKDF2-SHA1 `saltysalt`, 1003 rounds, AES-128-CBC `v10`), or manual `Cookie` header stored in a 0600 file (`codexbar config login --provider claudeplatform --stdin`), never printed or refreshed.
- **OpenAI (`openai`, E6, E8):** `CB/Sources/CodexBarCore/Resources/Plugins/openai.js` (lines 12, 348–371) and `CB/docs/openai.md`: `OPENAI_ADMIN_KEY` (`GET /v1/organization/costs`, `/usage/completions`) reports spend only, not balance. Balance is read only from legacy `GET https://api.openai.com/v1/dashboard/billing/credit_grants` (opt-in `OPENAI_ALLOW_BALANCE_FALLBACK=1`) with a user API key and optional `OpenAI-Organization`, returning numeric `total_granted`, `total_used`, `total_available`; modern keys return HTTP 403 (browser session required). Included ChatGPT API credits continue to exclude Codex on an API key (which bills standard API rates, 429 `credit_balance_exhausted` at zero).
- **xAI (`xai`, E7):** `CB/Sources/CodexBarCore/Resources/Plugins/xai.js` (lines 10–131), `CB/docs/xai.md`, and `https://docs.x.ai/developers/rest-api-reference/management/billing`: with a management key (`Authorization: Bearer`) and team id, `GET https://management-api.x.ai/v1/billing/teams/{team}/prepaid/balance` returns `total.val` in inverted string cents (`"-1000"` = $10.00 posted), and `GET …/postpaid/invoice/preview` returns `coreInvoice.amountAfterVat` in string cents; live remaining (est.) = posted − preview (missing/malformed total or missing preview is an error, never zero). `GET …/postpaid/spending-limits` exposes invoiced billing limits (`effectiveHardSl.val`, `effectiveSl.val`; not read by CodexBar). The same management key can call `POST …/prepaid/top-up`.
- **Google Developer Program credit (`googledeveloper`, V1–V3):** `CB/Sources/CodexBarCore/Resources/Plugins/googledeveloper.ts`, `CB/docs/googledeveloper.md`, `CB/TestsPlugin/GoogleDeveloperPluginTests.swift`.
  - **V1, request.** Reads `https://me.developers.google.com` with the Cookie of a signed-in request (cookie domains `me.developers.google.com` and `google.com`). `GET /benefits?authuser=N` (`Accept: text/html`, one retry on a transient failure) yields `"SNlM0e"` (XSRF token) and `"oPEP7c"` (email) as JSON string literals. `POST /_/GoogleDeveloperProfile/data/batchexecute?rpcids=Ro0AYc&source-path=%2Fbenefits&hl=en&authuser=N&rt=c` with form fields `f.req=[[["Ro0AYc","[]",null,"generic"]]]` and `at=<token>`, headers `Origin` and `Referer: <origin>/benefits`.
  - **V2, parse.** Response lines starting `[` are JSON arrays; the entry `["wrb.fr","Ro0AYc",<string>]` holds the result (a non-string payload is a per-account RPC error, next account). `JSON.parse(payload)[0]` is the benefit list; the benefit with `[0] === 19` is the monthly credit; `offer = benefit[9]`; `offer[6]` null means not applied to a billing account, else `[granted, remaining, "billingAccounts/<id>"]`, money `[currency, units, nanos]` with null as 0 (granted ≤ 0 or mismatched currencies are a format error; remaining clamps at 0). `offer[1][0]` is the expiry and `offer[16][0]` the grant date, in seconds; a malformed date is unknown, not an error.
  - **V3, scope.** Walks `authuser` 0..7 per session, stopping at a 3xx, 401, 403, a page without token or email, or a repeated email; 429 is rate limited, ≥500 unavailable. **Only the current monthly grant is returned**: "Older grants that are still valid are not part of that response, so the balance is not the total credit of the Cloud Billing account." Cookie sources in CodexBar: browser import, or a manual `Cookie` header in a 0600 file; schmear takes the pasted header only.
- **agy in Gemini API key mode (V4, V5; spec §19 R43):**
  - **V4.** `agy acp` (≥ 1.5.0) advertises auth method `gemini-api-key` ("reads GEMINI_API_KEY from the agent's environment"). Since 1.2.12 key sessions stop at once on depleted prepaid credits or a spend cap. Cost over ACP is undocumented. Sources: https://antigravity.google/docs/changelog, https://antigravity.google/docs/install.md, https://antigravity.google/docs/ide/extensions/acp/.
  - **V5.** agy 1.5.16: `agy acp --help` lists `--gemini-dir` ("Path where Gemini files are stored (default .gemini)") and `--app-data-dir` (default `antigravity-cli`); the changelog says an `agy acp` session whose settings name an auth method with no credential "falls back to your saved login". R43 confirmed that fall-back: the saved login lives in the macOS keyring, so `--gemini-dir` does not isolate it, and a credit run must fail on any `authenticate` error.
- **Google billing (V6):** credits are "consumed first before your prepaid funds"; $5 minimum prepay; at zero HTTP 402 for every key on the account, and a negative balance is deducted from the next purchase (https://aistudio.google.com/docs/billing). Forum replies (secondary) say the Cloud credit and the AI Studio prepaid wallet are separate ledgers, credits apply only while the wallet is positive, and 402 can lag (https://discuss.ai.google.dev/t/prepaid-balance-showing-0-19-in-ai-studio-despite-20-96-unspent-adjustment-in-cloud-billing-ledger/181799, https://discuss.ai.google.dev/t/error-code-402-message-your-prepayment-credits-are-depleted/185524). No API reads either balance. Unverified with a real credit (spec §19 PG).
- **Codex ACP API-key probe (P1, E9):** With an isolated `CODEX_HOME` containing `cli_auth_credentials_store = "ephemeral"`, `CODEX_API_KEY` in env, and ACP `authenticate {methodId: "api-key"}`, the key is never written to disk (only a masked echo, first 8 + last 4 chars, lands in the home's sqlite logs and rollout). Without `authenticate`, `session/new` fails; a bad key fails only at the first prompt (`-32000 Authentication required`). A separate `CODEX_HOME` loses the user's MCP servers, skills, plugins, and settings, and Codex clones its plugin marketplace into it.
- **Grok ACP API-key probe (P1, E10):** With `XAI_API_KEY` and an empty `GROK_HOME`, Grok checks the key during `initialize` (~400 ms); a failing key advertises no API-key auth method and `session/new` fails `-32000`. A session token outranks `XAI_API_KEY` (`~/.grok/docs/user-guide/02-authentication.md`). Unverified for a valid key: advertised auth method, whether `authenticate` is required, and whether Grok writes the key to `auth.json` (binary contains `"failed to persist API key to auth.json"`).

## Sources

- Anthropic API credits doc: https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers
- Anthropic Help Center: https://support.claude.com/en/articles/17154008-api-credits-for-max-and-team-plans
- Anthropic Agent SDK with plan: https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan
- Claude Code authentication precedence: https://code.claude.com/docs/en/authentication
- Claude Code on Vertex: https://code.claude.com/docs/en/google-vertex-ai
- Anthropic cost report: https://platform.claude.com/docs/en/api/admin/cost_report
- Google Developer Program benefits FAQ: https://developers.google.com/profile/help/benefits
- Google AI Studio claim announcement: https://blog.google/innovation-and-ai/technology/developers-tools/google-cloud-credits-gdp-ai-studio/
- AI Studio billing: https://aistudio.google.com/docs/billing
- Gemini CLI authentication: https://geminicli.com/docs/get-started/authentication/
- Antigravity plans: https://antigravity.google/docs/plans
- Antigravity changelog, install and ACP docs (V4): https://antigravity.google/docs/changelog, https://antigravity.google/docs/install.md, https://antigravity.google/docs/ide/extensions/acp/
- AI Studio forum threads on prepaid balance and 402 (V6, secondary): https://discuss.ai.google.dev/t/prepaid-balance-showing-0-19-in-ai-studio-despite-20-96-unspent-adjustment-in-cloud-billing-ledger/181799, https://discuss.ai.google.dev/t/error-code-402-message-your-prepayment-credits-are-depleted/185524
- Google One AI Ultra benefits: https://support.google.com/googleone/answer/16286513
- Cloud Billing API reference (no credits resource): https://docs.cloud.google.com/billing/reference/rest
- ChatGPT pricing: https://chatgpt.com/pricing
- OpenAI help, API credits benefit: https://help.openai.com/en/articles/20001626-api-credits-benefit-for-eligible-chatgpt-subscriptions
- OpenAI dev guide: https://developers.openai.com/api/docs/guides/chatgpt-api-credits
- Codex auth: https://learn.chatgpt.com/docs/auth
- OpenAI community on balance API: https://community.openai.com/t/get-the-remaining-credits-via-the-api/18827
- xAI accounts FAQ: https://docs.x.ai/console/faq/accounts
- xAI billing: https://docs.x.ai/console/billing
- xAI Management API: https://docs.x.ai/docs/management-api
- Grok reply on X (secondary): https://x.com/grok/status/2040783994082496542
- $50 Heavy credit (Aug 2025, X, secondary): https://x.com/TobyPhln/status/1959760583026434506
- Reported removal (X, secondary): https://x.com/blankspeaker/status/2050208427046297627
- CodexBar provider docs: [claude.md](https://github.com/steipete/CodexBar/blob/e6edfb87d5bcdcd942de8b11d111d6c132ee392e/docs/claude.md), [gemini.md](https://github.com/steipete/CodexBar/blob/0ff1cf55c0a27b63cbb4a7359e0ef2d098114d97/docs/gemini.md), [antigravity.md](https://github.com/steipete/CodexBar/blob/e6edfb87d5bcdcd942de8b11d111d6c132ee392e/docs/antigravity.md), [grok.md](https://github.com/steipete/CodexBar/blob/94cc400e1b190f444e2a4d1910c2d63cfbb47e9f/docs/grok.md)
