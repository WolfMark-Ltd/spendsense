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
  the fixture rates (`full` for the openai cut and the fixturelabs x2 cut,
  `partial` with the cache-excluded caveat for the anthropic cut; items
  without usage get none, exactly as the backend behaves).
- **Hand-written fields** (documented here because the worktree diff cannot
  generate them): the kimi local twin's `effective_at`/`source_url`/`official`
  and the gemini local event's `observed_at`/`source_url` (the same-event proof
  and conflict controls), one `model_name` (as the final backend copies it from
  the catalogue entry), the control item's `last_used_at` (the final backend
  derives it from the newest exact `(provider, model)` usage row; the
  case-only `m1` item deliberately gets none), the `ts-*` items'
  `last_used_at`/`observed_at` (recency-rejection variants), and the opus
  item's root `tiers_detail`/`tiers_before`/`tiers_after`.

Regenerate from the repo root:

```
/Users/mark/Projects/spendsense/.venv/bin/python test/fixtures/news/generate.py
```

Timestamps are fixed (2026-11-06 … 2026-11-10) so the committed JSON is
deterministic. Only side effect: the "N day(s) ago" freshness label on the
page drifts as real time passes; no assertion depends on it.

## realistic.json — the populated payload

20 local + 8 central items (payload `for_you_count` 13 from this worktree's
`rank_items`, which marks a model as used on any provider with a matching
last path segment; read-time relevance marks 11 — what the page's For You
scope renders; the final backend narrows the rank flag to exact pairs too).
Deliberately included:

- **Same-event proof controls** (the final `newsSameEventProof` /
  `newsMergeEvents` contract):
  - *proven pair*: `moonshotai` / `kimi-k2.5` — local diff item and central
    feed entry, distinct ids, identical transition, same nonempty
    `effective_at` (2026-11-07) and same nonempty `source_url` → one event.
  - *variant*: `deepseek` / `deepseek-v4` — identical transition observed at
    the same instant, both `effective_at` empty, `source_url` only on the
    central side (an absent URL never conflicts) → one event.
  - *source-url conflict control*: `google` / `gemini-3-flash` — local and
    central events with `observed_at` hand-equalised (07:59:50Z), both
    `effective_at` empty, but conflicting nonempty `source_url`s → two events.
  - *effective-date conflict control*: two central `mistral-large-3`
    increases with identical transitions but conflicting nonempty
    `effective_at` (2026-11-01 vs 2026-11-05) → two events; both sides are
    central, so this doubles as the same-origin control (same-origin items
    with different ids never merge).
- **Case-only identity variant**: usage records `M1` under `fixturelabs`
  while the item model is `m1`. `match_relevance` lowercases, so the backend
  emits `used_model` for the m1 item — but the exact-pair usage never prices
  an impact and no `last_used_at` exists, so the UI must render only the
  neutral "Related update" wording, never model-use or recency claims. The
  exact-match control `x2` (same provider, exactly recorded model) carries
  an in-window `last_used_at` (2026-11-09T18:30:00Z) and a priced impact.
- **Recency-timestamp variants** (`fixturelabs` / `ts-*`, all relevant via
  `used_provider`, none with an exact usage row, so none may carry a numeric
  estimate): `ts-old90day` carries a valid `last_used_at` ~101 days old (its
  `observed_at` also sits ~36 days back, past the All Updates day window),
  `ts-malformed` a non-parseable string, `ts-future` a future date and
  `ts-empty` an empty string — none may ever earn "Used recently"; only the
  valid old stamp may earn the truthful "Used before".
- **Root-level tier fields**: the `openrouter` / `anthropic/claude-opus-4.1`
  increase carries `tiers_detail: "known"` with `tiers_before`/`tiers_after`
  (one `standard` row, +20% on every comparable field), so the UI renders a
  comparable tier chip and lists the row in Details.
- **Official verification block**: the local kimi twin carries `official`
  with `verified_at`, an empty `windows` list and a `source_note` — the note
  is plain text by contract and must never render as a link.
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
- **Signals/usage** making For You non-empty (11 relevant items), impact items
  (`openai` full, `anthropic` partial, `fixturelabs/x2` full) and no-usage
  items (`xai`, `google`, `mistral`, `m1` and the `ts-*` changes have no
  personal estimate, exactly as `compute_impacts` omits them).
- One removed-model note (`cohere/command-r7b-12-2024`, count 1).

## variants.json — state variants

| variant | meaning |
| --- | --- |
| `empty` | No items in either origin, Live Updates on, baseline recorded, signals present; For You and All both render the "unchanged since last check" empty state. |
| `partial` | Live Updates off: local-only items (4), central `state: "disabled"` with empty `fetched_at`; the live-off note with the Open Settings action shows. |
| `stale` | Live Updates on but the fetch failed: central `state: "stale"` retains the cached items and reports `central feed unavailable (URLError)`, which the page surfaces in its alert (For You still shows the 11 relevant cached items). |
| `nosignals` | Full item list but empty signals: relevance/`for_you` all false, no impacts, For You empty with the "nothing to personalise" state while All stays complete. |
| `error` | Transport-level failure: `rest('/news/refresh')` resolves `{ok:false, detail: …}` so the query rejects and the page shows its error + Retry state. This one is not a payload — it is what the harness transport returns. |

## Evidence-retention regressions (page-local payload)

Two further cases live only in `test/news-layout.page.jsx` under the
`evidence` fixture name (probed as a single case; never part of the grid
matrix and never written to these JSON files — no fixture churn):

- `ev-model`: two records sharing ONE id (one local, one central) that
  dedupe to exactly one event, while both records' source URL, full
  `observed_at`, `effective_at` and provenance must stay recoverable in
  Details.
- `hist-model`: a proven distinct-ID pair (identical transition plus a
  shared `event_key`) collapsed into one event, which becomes History once a
  newer update lands in the same offer; the historical event must keep every
  original id, both origin evidences, full timestamps, provenance, its exact
  previous/current four rates and its raw tier type/size recoverable.

## Consumers

- `test/news-layout.test.mjs` + `test/news-layout.page.jsx` +
  `test/news-layout.sdk.mjs` — the layout/verification harness (real headless
  Chrome; screenshot mode via `NEWS_LAYOUT_SHOTS=<dir>`).
- The scratch baseline harness under `/tmp/wp11-baseline-harness/` used
  hand-written equivalents of these fixtures before they were committed.
