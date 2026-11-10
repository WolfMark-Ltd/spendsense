# Model News verification fixtures (WP11)

Synthetic fixtures in exactly the shape `/news/refresh` (POST) returns today,
used by `test/news-layout.test.mjs` to render the real `NewsPage` from
`desktop/plugin.js`. **No real user data, no secrets, no network:** every
model ID, price, plan and URL is invented; `announcements.spend-sense.example`
is a reserved-looking but non-existent host.

## How they were made

`generate.py` builds everything through the real backend functions so the
fixtures cannot drift from the payload contract:

- **Local items** — `wolfmark_ledger.news.diff_snapshots` over two synthetic
  catalogue snapshots (`models.dev`-style provider → model → rate rows, plus a
  plan catalogue consumed through the real `_plans_table`). This is the same
  pure diff a live refresh runs, so ids (`local-<slug>-<sha1>`), summaries,
  `summary_code`/`summary_params`, `has_tiers`, `conditions_code` and the
  removed-model metadata are all produced by production code.
- **Central items** — a synthetic feed document pushed through
  `wolfmark_ledger.news.validate_feed` (the strict schema check
  `fetch_central` applies), so only fields the real feed can carry appear.
- **For You flags, `related_routes`, relevance** — `rank_items` with
  synthetic usage buckets plus `personalise_payload` with synthetic signals
  (one anthropic + one openai credential, usage on
  `openai-codex/gpt-5.6-sol` and `anthropic/claude-sonnet-4-5`, and the
  `claude-max-20x` plan selected).
- **Impacts** — `compute_impacts` pricing the synthetic token buckets against
  the fixture rates (`full` for the openai cut, `partial` with the
  cache-excluded caveat for the anthropic cut; items without usage get none,
  exactly as the backend behaves).

Regenerate from the repo root:

```
/Users/mark/Projects/spendsense/.venv/bin/python test/fixtures/news/generate.py
```

Timestamps are fixed (2026-11-06 … 2026-11-10) so the committed JSON is
deterministic. Only side effect: the "N day(s) ago" freshness label on the
page drifts as real time passes; no assertion depends on it.

## realistic.json — the populated payload

12 local + 8 central items (payload `for_you_count` 7 from `rank_items`
model-matching; read-time relevance marks 5, which is what the page's For You
scope renders, and under the candidate model-first grouping those render as
5 groups). Deliberately included:

- **Local + central duplicate**: the `moonshotai` / `kimi-k2.5` reduction
  appears as a local diff item and as a central feed entry for the same
  before→after transition — the merge candidate.
- **Repeated identical transition that must stay distinct**: two central
  `mistral-large-3` increases with identical rates but different sources and
  effective dates (`2026-11-01` vs `2026-11-05`).
- **Near-duplicates seconds apart** with different source ids: the two
  `google` / `gemini-3-flash` reductions (07:59:10 vs 07:59:50, distinct feed
  ids and mirror URLs).
- **Missing rates**: `github-copilot` / `gpt-5.6-sol` is a new listing with
  no previous rates; the anthropic sonnet cut carries null cache rates on
  both sides (rendered as `—`); several rows have only one cache side.
- **Tiered pricing**: `openrouter` / `anthropic/claude-opus-4.1` increase with
  changed tiers (`has_tiers`, `news_cond_tiers_changed`).
- **Exact variants**: `claude-sonnet-4-5-20250929`,
  `claude-sonnet-4-5`, `claude-opus-4-1-20250805-thinking`,
  `gpt-5.6-sol`, `gpt-5.6-sol-pro` — near-identical IDs a naive normaliser
  would merge.
- **Namespaced IDs**: `openrouter/anthropic/claude-sonnet-4.5` and
  `deepseek-ai/deepseek-v4-pro` as model fields, which must render verbatim.
- **One model across three providers**: `gpt-5.6-sol` on `openai` (reduction,
  For You, impact), `azure-openai` (new listing) and `github-copilot`
  (new listing, no previous rates). Existing filler listings on those
  providers keep the additions in the "shared provider" branch of the diff,
  so they are reported as model-level news, not just provider listings; one
  genuinely new provider (`perplexity`, two models) exercises the
  provider-level listing summary.
- **All four categories**, including a subscription fee change with a terms
  change (`claude-max-20x`) and a new plan (`gemini-code-assist-pro`), both
  with source URLs from the plan catalogue.
- **Source URLs and observed/effective timestamps** on every central item and
  the plan items; central `effective_at` values vary.
- **`summary_code`/`summary_params` everywhere**, so zh renders translated
  summaries with ASCII model IDs intact.
- **Signals/usage** making For You non-empty (5 relevant items), an impact
  item (`openai` full, `anthropic` partial) and no-usage items (`xai`,
  `google`, `mistral` changes have no personal estimate, exactly as
  `compute_impacts` omits them).
- One removed-model note (`cohere/command-r7b-12-2024`, count 1).

## variants.json — state variants

| variant | meaning |
| --- | --- |
| `empty` | No items in either origin, Live Updates on, baseline recorded, signals present; For You and All both render the "unchanged since last check" empty state. |
| `partial` | Live Updates off: local-only items (4), central `state: "disabled"` with empty `fetched_at`; the live-off note with the Open Settings action shows. |
| `stale` | Live Updates on but the fetch failed: central `state: "stale"` retains the cached items and reports `central feed unavailable (URLError)`, which the page surfaces in its alert (For You still shows the 5 relevant cached items). |
| `nosignals` | Full item list but empty signals: relevance/`for_you` all false, no impacts, For You empty with the "nothing to personalise" state while All stays complete. |
| `error` | Transport-level failure: `rest('/news/refresh')` resolves `{ok:false, detail: …}` so the query rejects and the page shows its error + Retry state. This one is not a payload — it is what the harness transport returns. |

## Consumers

- `test/news-layout.test.mjs` + `test/news-layout.page.jsx` +
  `test/news-layout.sdk.mjs` — the layout/verification harness (real headless
  Chrome; screenshot mode via `NEWS_LAYOUT_SHOTS=<dir>`).
- The scratch baseline harness under `/tmp/wp11-baseline-harness/` used
  hand-written equivalents of these fixtures before they were committed.
