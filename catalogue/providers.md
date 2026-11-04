# Hermes-native route inventory

All Spend Sense provider families, their Hermes route slugs, verification
state, official sources, and automation tier for Live Intelligence checks.

Source of truth for prices remains `plans.json` (59 plans, 21 families;
verified 48 / provisional 1 / unverified 9 / retired 1). Source registry is
`sources.json` (31 entries; 5 rows `parsed=true`). Token-rate identity is
`PROVIDER_ALIASES` in `wolfmark_ledger/pricing.py` (47 entries, covering 8
of 24 route slugs; the rest resolve under their own slug). Token lookups
read the Hermes `models_dev_cache.json` first with `catalogue/rates.json`
as fallback, and never fall back across providers.

## Tier 1 — machine-readable (adapter + parsed=true)

| Family | Plans | Verification | Source | Notes |
|---|---|---|---|---|
| opencode-go | 3 | 3 verified | opencode.ai Go docs (markdown plan table) | End-to-end slice coverage. Clean parse. |
| commandcode | 8 | 8 verified | commandcode.ai pricing-limits docs | End-to-end slice coverage. Caveat: usage-limits table says Go $2/$5 while the Go plan answer says $3/$6; conflict is surfaced, not resolved. |
| ollama-cloud | 3 | 3 verified | ollama-pricing adapter | Team verified 2026-11-04; still early access on the page. |
| kilocode | 1 | 1 verified | kilocode-pricing adapter | Subscription-only; `kilo` vs `kilocode` slug mismatch keeps it unpriced for tokens. |
| huggingface | 1 | 1 verified | huggingface_pricing adapter | Single plan; page marked incomplete. |

## Tier 2 — stable pricing page, manual (no adapter yet)

| Family | Plans | Verification | Source | Notes |
|---|---|---|---|---|
| github-copilot | 4 | 4 verified | Official Copilot pricing | Needs adapter. |
| anthropic | 3 | 3 verified | claude.com/pricing | Top tier renamed Ultra ($200, 10x weekly); needs adapter. |
| zai-coding-plan | 3 | 3 verified | Official Z.ai pricing | Needs adapter. |
| nous | 5 | 4 verified, 1 unverified | Official pricing + login-gated portal | Portal rows cannot be priced without login; API usage metered separately. |
| openai-codex | 7 | 7 verified | Pricing + Help Centre | Marketing prices injected client-side; Business Standard/Premium verified via the Help Centre ($25/$20, $125/$100 per seat). Alias maps to `openai` token rates, which cannot price the subscription. |
| alibaba-coding-plan | 1 | 1 verified | Coding Plan docs | Pro $50/mo; Lite discontinued. |
| tencent-coding-plan | 5 | 4 verified | Token Plan docs | Lite $7 / Standard $17 / Pro $51 / Max $103 with monthly credit pools. Generic entry kept unpriced for selections. |
| x-subscription | 7 | 6 verified, 1 provisional | X Subscription docs | Free $0 through Ultra $200; Teams from $30/seat; Enterprise custom. Separate family; legacy SuperGrok stays under xai-oauth. |

## Tier 3 — manual-only or structurally unpriceable

| Family | Plans | Verification | Reason |
|---|---|---|---|
| cline-pass | 1 | retired | Product retired. |
| openrouter | 1 | unverified | Balance API only; never a plan price. |
| opencode-zen | 1 | unverified | Docs only; pay-as-you-go at cost. |
| kimi-code-plan-global | 1 | unverified | API page states no subscription exists; Kimi Code price JS-gated. |
| minimax-coding-plan | 1 | unverified | M Plan tiers (Go/Explore/Build) in docs; prices only at JS checkout; old URL 404s. |
| umans-ai-coding-plan | 1 | unverified | Prepaid wallet applied via correction workflow (rev 2026-11-04); no recurring price exists. |
| volcengine-coding-plan | 1 | unverified | Coding Plan exists in Ark docs; price console-gated. |
| xai-oauth | 1 | unverified | Legacy SuperGrok; login-gated, no public price. Current tiers live under x-subscription. Alias maps to `xai` token rates. |

## Route slugs per family

alibaba-coding-plan (2 slugs, incl. -cn) · anthropic · cline-pass ·
commandcode · github-copilot (`copilot`, `github-copilot`) · huggingface ·
kilocode · kimi-code-plan-global · minimax-coding-plan (2 slugs) · nous ·
ollama-cloud · openai-codex · opencode-go · opencode-zen · openrouter ·
tencent-coding-plan · umans-ai-coding-plan · volcengine-coding-plan ·
xai-oauth · x-subscription · zai-coding-plan.

## Known route/catalogue gaps (not fixed here)

- `kilocode`, `nous`, `opencode-zen` are absent from both the Hermes cache
  and `rates.json`; Hermes carries `kilo` (381 models) and `opencode`
  (131 models) under different slugs, and nothing for `nous`. Those routes
  stay unpriced until slugs are reconciled.
- `openai-codex` → `openai` and `xai-oauth` → `xai` aliases map
  subscription routes onto token-rate providers, so token lookup cannot
  price those subscriptions; `plans.json` is the only price source there.
