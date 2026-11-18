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
| `price_mixed` | Rates measured moving in both directions (`magnitude.direction == "mixed"`), not merely categorised | "opencheap changes kimi-k3 in both directions (output raised, input cut)" |
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
  provider disappears, its models are not reported individually, and any earlier
  per-model removal for that provider is replaced by the single delisting rather
  than shown beside it.
- **A retry is not an observation.** `update_history` called twice with the same
  `observed_at` re-derives the state without advancing any absence counter, so a
  crashed-and-retried publisher run cannot confirm a removal from one real
  missing observation.
- **Old removals leave the news surface, not the history.** Confirmed records
  stay in the sidecar indefinitely but only appear in the briefing for
  `REMOVAL_WINDOW_DAYS` (90) after `removed_at`, ordered newest first, so an
  accumulating archive cannot crowd out today's news.
- **An operator note is the only place a hard claim lives.** A curated entry may
  carry a validated `event_type` (`new_plan`, `new_to_catalogue`,
  `removed_from_provider`, …) with `confidence: curated` or `verified`; that is
  how a launch, a removal or a plan change is asserted when a catalogue diff
  cannot prove it. Curated removal notes feed the same removals section as
  absence-confirmed records, and supersede an inferred record for the same
  provider and model instead of appearing beside it.
- **Evidence lists are capped, counts are not.** `other_providers` publishes at
  most 16 names (the schema's width) so a document always validates, while
  `other_provider_count` carries the true total, so "already listed by 17 other
  providers" stays true after a carried event is re-validated.
- **Identity keeps its supported width.** A removal record stores provider and
  model ids at the widths the published schema allows (128 and 256 characters).
  Only timestamps are held to 64, so a long model id is never renamed in a
  headline and two ids sharing a prefix never collapse into one.
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
   per 1M tokens` decide what earns a headline, and a percentage move must clear
   **both**: the relative change alone let a 1 850% move on a sub-cent cache rate
   outrank a real input-price change. A zero-baseline move has no percentage, so
   its dollar delta carries the whole test. Both are named constants in
   `news_briefing.py`, mirrored in the Desktop port. On the live feed measured at
   this head (200 items, 151 price events) 111 price groups qualify — 67
   reductions, 32 increases, 12 mixed — against 117 under the percentage-only
   rule, so the absolute floor removed 6 headline candidates; 8 per section are
   shown and everything else stays in All Updates and in the counts.
2. **Section caps.** Eight entries per section, eight sections.
3. **`category` for removals.** Removals are published in `briefing.sections`
   only, with `event_type`, because the v1 `category` enum has no honest value
   for them and adding one would make older clients drop the item *and* fail
   carry-forward on the next run. A UI that wants removals in All Updates needs
   either a v2 category or a category-independent renderer.
4. **Truncation policy.** Generic provider listings are now dropped before any
   event with a model identity when the 200-item cap binds — including listings
   carried from an older feed that has no `event_type` yet.
5. **Removal window.** 90 days, matching the feed's retention.
6. **Size budget.** The document is held under 200 KiB, below the client's
   256 KiB cap. The editorial layer is trimmed first, then dropped; if items
   alone are too large, the derivable `change` block is shed before any event
   is. Events are never removed to make room for text.

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

The editorial layer has two legal sources and one renderer. A publisher-supplied
`central.briefing` is preferred when it is present and well-formed; when it is
absent — which is every published feed today — the Desktop plugin builds the
same document from the items it already holds, using a port of
`news_briefing.py` that is held to the Python builder by a golden fixture
(`test/fixtures/news/editorial-golden.json`, regenerate with
`python3 scripts/news-editorial-golden.py`). Nothing in the client-side path
calls a model or transmits usage.

- Render the briefing as the For You first screen, in the page's own reading
  order (`biggest_reductions`, `biggest_increases`, `new_models`,
  `newly_available`, `removals`, `subscriptions`, `preview_models`,
  `mixed_price_changes`). All Updates stays a pure archive: the headline block
  is additive and never duplicates its list.
- Localise `title_code`, `headline_code` and `headline_params`; treat
  `headline` as the English fallback, exactly like `summary_code`/`summary`.
- Use `variants[]` for the per-provider rows under a family banner, and
  `event_ids` to join back to the full event in All Updates. A variant carries
  its own `source_url`, `provenance` and `confidence`: it is a different
  provider's record, so borrowing the family head's evidence would attribute one
  record's source to another. Join through the
  archive's own grouped events, not the raw feed records: a merged local and
  publish-side record is one event with `merged_sources`, and resolving an id
  against the raw list alone drops the other source's provenance, timestamps and
  tier evidence. A variant with no joinable record keeps its published evidence
  rather than losing it.
- "Open in All Updates" must land on the **event**, not the model: clear the
  category and date filters, search the model, open the containing offer's panel
  and mark the row whose id the story names (`data-news-focus`). A model with an
  older cut and a newer rise would otherwise open on the newest record and leave
  the story's own event inside a collapsed panel.
- Honour `briefing.unsupported` — say "removal detection is not available"
  rather than showing an empty section, and name the missing plan-event source
  instead of reporting an empty Subscription Updates filter (F94). A published
  briefing describes the PUBLISHER's coverage, and the local feed emits plan
  events independently, so the plan limitation applies only when this archive
  holds no plan event either; otherwise it would hide real updates behind their
  own filter.
- A section-cap note may state the limit and the count, never where the omitted
  entries can be found: they are not in the payload, so nothing can be proved
  about whether the archive holds them. An earlier "every event stays in All
  Updates" claim was wrong for briefing-only removals.
- Treat a missing briefing as normal (byte-budget fallback) and keep the
  existing item rendering.

## One scrolling surface

The Model News page is content-sized (`height:auto; overflow:visible`) and no
descendant may be its own vertical scroll container: the host pane owns the
only scrollbar. The layout harness asserts this on every case
(`scrollSurfaces()` in `test/news-layout.page.jsx`). A second, nested scroller
is an explicit owner blocker (F89) because the wheel latches onto whichever
surface the pointer happens to be over.

## What "All Updates" can and cannot promise (F102)

The published feed is the latest 200 events with a rolling window, not a
history: on 18 Nov 2026 the served document held 200 items spanning 18 hours
and carried `truncated: {model_items_dropped: 10}`. OpenRouter **is** ingested —
the same document carried 36 `openrouter` items, so the owner's empty
`openrouter` search on 16 Nov 2026 was the archive window, not a filter or an
alias defect. The UI therefore states the window it covers
(`[data-news-archive-note]`) and repeats the limitation under a search that
returns nothing, so a missing older event reads as a bounded archive rather
than a broken feed.
