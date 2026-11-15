# Model News: editorial layer and curation

This page documents how Spend Sense turns verified catalogue events into a
shared news briefing, what it can and cannot claim, and how the optional
model-assisted curator was evaluated. It is the contract the Model News UI is
built against.

## Architecture: curate once, filter per user

```
models.dev + curated notes
        │
        ▼
  publisher (VPS)  ── diff, evidence, absence history ──▶  items[]  (complete archive)
        │                                                 briefing{}  (shared editorial view)
        ▼
   /feed/v1/news.json  ── one document, every client ──▶  plugin
                                                            │
                                    For You: deterministic filter/rank
                                    on this profile's providers, plans and use
```

The briefing is computed **once** per publication. "For You" is the existing
local filter (`rank_items`) over the same events: it reads configured providers,
selected plans and locally recorded model use, and it never sends usage to an
AI or generates per-user prose. There is no per-user agent and no per-user
inference call anywhere in this design.

## Supported event types

`category` stays the v1 compatibility field. `event_type` is the editorial
taxonomy and may refine it: a price change that cuts one rate and raises another
is `price_mixed` even though its v1 category follows the input+output total.

| `event_type` | Evidence required | Headline shape |
| --- | --- | --- |
| `price_reduction` / `price_increase` | Both rate blocks published; the dominant rate's own percentage | "wafer.ai cuts GLM-5.2 input by 86.4% ($1.4 → $0.19 per 1M tokens)" |
| `price_mixed` | Rates moved in both directions | "opencheap changes kimi-k3 in both directions (output raised, input cut)" |
| `new_to_catalogue` | A model id absent from the previous snapshot | "lowrouter starts listing … (new catalogue entry; no launch claim)" |
| `newly_available` | The same model id already listed by another provider in the same observation | "… now also lists … (already listed by N other provider(s))" |
| `provider_listed` | A provider absent from the previous snapshot | Never headlined; counted and kept in All Updates |
| `removed_from_provider` | Present previously, then absent for **two consecutive** observations of a provider that is itself still listed | "… no longer lists … (confirmed across 2 catalogue observations)" |
| `provider_delisted` | A whole provider absent for two consecutive observations | "… no longer appears in the catalogue" |
| `new_plan` / `plan_change` | A curated note or plan-catalogue diff | The curated summary |
| `preview` (signal) | The provider's own id or name carries preview/beta/stealth/alpha/experimental | "Preview-labelled model … observed at … (no vendor or launch identity inferred)" |

### The rules that make those claims honest

- **A missing entry is not a removal.** Removal detection needs publisher-side
  history (`update_history`). One absent observation is a catalogue wobble; the
  record only becomes a removal on the second consecutive absence, it carries
  the date of the *first* absence, and it is retracted without trace if the
  model returns. Without history the briefing lists `removals` under
  `unsupported` and claims nothing.
- **A vanished provider is one delisting, not a thousand removals.** When a
  provider disappears, its models are not reported individually.
- **No percentage against zero.** A rate that moves from `$0` has a delta but no
  percentage; the headline says so instead of printing an infinite change.
- **No blended percentage.** Each rate type is compared separately; the headline
  names the rate that moved most in USD per 1M tokens, because that is the one a
  buyer feels. Ranking uses that same rate's percentage, so the ranking and the
  printed headline never disagree.
- **A launch needs corroboration.** A new catalogue entry is `new_to_catalogue`
  ("no launch claim"). Only a `verified` or `curated` item may say "launches".
- **Grouping never merges.** Model families group headlines for scanning
  (`DeepSeek V4.1 Flash: 2 changes at wally`), while every variant keeps its
  exact provider and model id and its own event id.

## What the current publisher can and cannot support

Measured on the live feed on 15 Nov 2026 (200 items, `generated_at`
2026-11-15T04:26:56Z):

| Observation | Consequence |
| --- | --- |
| 200 of 200 items observed within a **6-hour** window; 32 model items were dropped by the 200-item cap | The feed is an evolution stream, not an archive. "Complete history" is not achievable at the current cap and emission rate. |
| 143 `new_model`, of which **44 name no model at all** ("provider newly listed") | 22% of the feed is catalogue bookkeeping. These are now demoted, never headlined, and dropped first under truncation. |
| **0** subscription events | The publisher diffs models.dev only; plan changes live in the bundled catalogue. Shared subscription news requires curated notes or a plan feed. |
| **0** removal events | The publisher keeps no history. The builder supports it (`update_history`); the ops publisher must pass and persist the state (see below). |
| 68 providers, dominated by `tempr`, `uberllm`, `zenifra`, `scx-ai`, `wafer.ai` | Global headlines must stay usefulness-ranked; provider relevance is a For You concern. |
| 4 price changes moved input and output in **opposite** directions | Previously all were rendered as one-way "Increased"/"Decreased". Now `price_mixed`. |
| One provider published `$0` rates before raising them (`nan`) | Previously an infinite percentage; now a delta with no percentage. |
| Rate magnitudes vary by provider (`uberllm` publishes `$0.0028` and `$0.28` for sibling models) | Absolute cross-provider price comparison is unsafe; percentages rank, absolutes inform. |

## Before and after

The same live feed, unedited. "Before" is what a client shows today; "after" is
the briefing for the same events.

| Before (one card per event, newest first) | After (shared briefing) |
| --- | --- |
| `deepseek/deepseek-v4.1-flash (uberllm) list price changed on models.dev.` — category `price_increase` | `uberllm changes deepseek/deepseek-v4.1-flash in both directions (input raised, output, cache_read cut)` — `price_mixed` |
| `deepseek/deepseek-v4.1-flash (hostinger-router) list price changed on models.dev.` — category `price_increase`, no magnitude | `hostinger-router raises deepseek-v4.1-flash output by 127.3% ($0.792 → $1.8 per 1M tokens)` |
| 44 cards: `tempr newly listed on models.dev with N priced model(s).` | Not headlined; counted as catalogue bookkeeping, still in All Updates |
| 4 cards: `kimi-k3 newly listed under … on models.dev.` | `Kimi K3: 2 changes across 2 providers` with each provider row preserved underneath |
| `deepseek-v4-flash (nan) list price changed on models.dev.` | `nan now lists deepseek-v4-flash input at $0.29484 per 1M tokens (previously $0; no meaningful percentage)` |
| No removal event exists at all | `acme no longer lists alpha (confirmed across 2 catalogue observations)` — only when history proves it |

## Is a Hermes curator worth it?

**Method.** `scripts/news-editorial-eval.py` builds the deterministic briefing
from a published feed and, with `--prompt`, emits the exact story set a single
editorial pass would receive. On the live feed that is 30 grouped stories,
15,553 prompt characters ≈ **3.9k input tokens**, for ~30 headlines ≈ 400 output
tokens.

**Result.** One bounded pass over that story set produced tighter prose — brand
casing (`Wafer.ai`, `UberLLM`), "per million tokens" instead of "per 1M tokens",
and the mixed-direction headlines with both magnitudes instead of one. It
produced **no new fact**, and the two gains it did make are reproducible
deterministically: the family label already carries brand casing, and the mixed
event already carries both percentages in `headline_params`.

**Verdict.** Not material. The facts, identity, percentages, ranking and
provenance are deterministic and must stay that way; a model in the path adds
non-determinism (unstable tests, unstable diffs), a prompt-injection surface
(provider-controlled names and summaries), and a failure mode that produces
plausible prose with no source. **Recommendation: do not put inference in the
publication path.** If editorial voice is wanted later, run it as an offline
review step whose output is a curated note (already a supported, `verified`
item type), not as a runtime dependency.

**Cost if it were adopted.** 3.9k input + 0.4k output tokens per run. Priced at
the published `deepseek-v4.1-flash` rates in the bundled catalogue
($0.15 / $0.60 per 1M tokens) that is **$0.0008 per run**, ≈ **$0.10/month at
four runs a day**, or ≈ $0.025/month daily. The cost is negligible; the
operational and review burden is not.

## Decisions needing the owner's sign-off

1. **Materiality thresholds.** `MIN_ABS_PCT = 2.0` and `MIN_ABS_DELTA = $0.005
   per 1M tokens` decide what earns a headline. Both are named constants in
   `news_briefing.py`. On the measured feed 49 of 57 price events qualify,
   forming 44 family groups of which 8 per section are shown; the 8 events that
   do not qualify stay in All Updates and in the counts.
2. **Section caps.** Eight entries per section, eight sections.
3. **`category` for removals.** Removals are published in `briefing.sections`
   only, with `event_type`, because the v1 `category` enum has no honest value
   for them and adding one would make older clients drop the item *and* fail
   carry-forward on the next run. A UI that wants removals in All Updates needs
   either a v2 category or a category-independent renderer.
4. **Truncation policy.** Generic provider listings are now dropped before any
   event with a model identity when the 200-item cap binds.

## Ops follow-up (not in this change)

The publisher must persist the history sidecar for removals and first-seen
evidence to work:

```python
state, removals = news_feed.update_history(prior_state, current_snapshot,
                                           observed_at=observed_at)
doc, problems = news_feed.build_feed(current_snapshot, previous_snapshot, curated,
                                     observed_at=observed_at, prior_feed=prior,
                                     history=state)
# write `state` to a sidecar next to the previous snapshot
```

Until that ships, `build_feed` publishes the briefing with `removals` and
`newly_available` empty and says so in `briefing.unsupported`. Nothing is
inferred in their absence.

## Desktop UI dependencies

The feed already carries everything the Model News redesign needs; Luna's
sidebar work does not depend on this change.

- Render `central.briefing.sections` as the headline surface, in feed order
  (`biggest_reductions`, `biggest_increases`, `mixed_price_changes`,
  `new_models`, `newly_available`, `removals`, `subscriptions`,
  `preview_models`).
- Localise `title_code`, `headline_code` and `headline_params`; treat
  `headline` as the English fallback, exactly like `summary_code`/`summary`.
- Use `variants[]` for the per-provider rows under a family banner, and
  `event_ids` to join back to the full event in All Updates.
- Honour `briefing.unsupported` — say "removal detection is not available"
  rather than showing an empty section.
- Treat a missing `briefing` as normal (byte-budget fallback) and keep the
  existing item rendering.
