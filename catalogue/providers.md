# Hermes-native route inventory

All Spend Sense provider families, their Hermes route slugs, verification
state, official sources, and automation tier for Live Intelligence checks.

Source of truth for prices remains `plans.json` (47 plans, 20 families;
verified 33 / provisional 3 / unverified 10 / retired 1). Source registry is
`sources.json` (29 entries; 5 rows `parsed=true`). Token-rate identity is
`PROVIDER_ALIASES` in `wolfmark_ledger/pricing.py` (47 entries, covering 8
of 23 route slugs; the rest resolve under their own slug). Token lookups
read the Hermes `models_dev_cache.json` first with `catalogue/rates.json`
as fallback, and never fall back across providers.

## Tier 1 — machine-readable (adapter + parsed=true)

| Family | Plans | Verification | Source | Notes |
|---|---|---|---|---|
| opencode-go | 3 | 3 verified | opencode.ai Go docs (markdown plan table) | End-to-end slice coverage. Clean parse. |
| commandcode | 8 | 8 verified | commandcode.ai pricing-limits docs | End-to-end slice coverage. Caveat: usage-limits table says Go $2/$5 while the Go plan answer says $3/$6; conflict is surfaced, not resolved. |
| ollama-cloud | 3 | 2 verified, 1 provisional | ollama-pricing adapter | Next expansion candidate; resolve provisional Team row first. |
| kilocode | 1 | 1 verified | kilocode-pricing adapter | Subscription-only; `kilo` vs `kilocode` slug mismatch keeps it unpriced for tokens. |
| huggingface | 1 | 1 verified | huggingface_pricing adapter | Single plan; page marked incomplete. |

## Tier 2 — stable pricing page, manual (no adapter yet)

| Family | Plans | Verification | Source | Notes |
|---|---|---|---|---|
| github-copilot | 4 | 4 verified | Official Copilot pricing | Needs adapter. |
| anthropic | 3 | 2 verified, 1 provisional | claude.com/pricing | Max 20x price inferred ($200); needs adapter. |
| zai-coding-plan | 3 | 3 verified | Official Z.ai pricing | Needs adapter. |
| nous | 5 | 4 verified, 1 unverified | Official pricing + login-gated portal | Portal rows cannot be priced without login; API usage metered separately. |
| openai-codex | 6 | 5 verified, 1 provisional | Pricing + secondary trackers | Prices injected client-side; confirmed via trackers. Alias maps to `openai` token rates, which cannot price the subscription. |

## Tier 3 — manual-only or structurally unpriceable

| Family | Plans | Verification | Reason |
|---|---|---|---|
| cline-pass | 1 | retired | Product retired. |
| openrouter | 1 | unverified | Balance API only; never a plan price. |
| opencode-zen | 1 | unverified | Docs only; pay-as-you-go at cost. |
| alibaba-coding-plan | 1 | unverified | Docs only. |
| kimi-code-plan-global | 1 | unverified | Page states no subscription exists. |
| minimax-coding-plan | 1 | unverified | Docs only, no price; one source URL 404s. |
| umans-ai-coding-plan | 1 | unverified | Token price page; no subscription. |
| tencent-coding-plan | 1 | unverified | Not fetched; CN console only. |
| volcengine-coding-plan | 1 | unverified | Not fetched; no Hermes route. |
| xai-oauth | 1 | unverified | Not fetched; login-gated, no public price table. Alias maps to `xai` token rates. |

## Route slugs per family

alibaba-coding-plan (2 slugs, incl. -cn) · anthropic · cline-pass ·
commandcode · github-copilot (`copilot`, `github-copilot`) · huggingface ·
kilocode · kimi-code-plan-global · minimax-coding-plan (2 slugs) · nous ·
ollama-cloud · openai-codex · opencode-go · opencode-zen · openrouter ·
tencent-coding-plan · umans-ai-coding-plan · volcengine-coding-plan ·
xai-oauth · zai-coding-plan.

## Known route/catalogue gaps (not fixed here)

- `kilocode`, `nous`, `opencode-zen` are absent from both the Hermes cache
  and `rates.json`; Hermes carries `kilo` (381 models) and `opencode`
  (131 models) under different slugs, and nothing for `nous`. Those routes
  stay unpriced until slugs are reconciled.
- `openai-codex` → `openai` and `xai-oauth` → `xai` aliases map
  subscription routes onto token-rate providers, so token lookup cannot
  price those subscriptions; `plans.json` is the only price source there.
