# Model News data additions

Local Model News items gain raw tier detail, an honest per-field rate
classification, verification notes and exact-model recency — all additive;
fields, ids, categories and summary codes are unchanged, as are pricing,
monitoring, membership/budget/finance, the feed generator, dashboard API,
desktop plugin and central feed items.

## Additive local item fields

- **`model_name`** — raw models.dev `name` for the exact (provider, model)
  row, `""` when absent; never derived or guessed.
- **`tiers_detail`, `tiers_before`, `tiers_after`** — raw tier rows copied
  exactly as `{type, size, input, output, cache_read, cache_write}` (`null`
  where absent). `null` means the raw side was unreadable, mismatched or
  missing — never guessed; no tiers is the empty list (known).
  `tiers_after` on both item kinds, `tiers_before` on price changes;
  `tiers_detail` is `"known"` when every tier list shown was captured.
- **`rate_change_code`** (price changes) — per-field over `input`, `output`,
  `cache_read`, `cache_write` where both sides are numbers: `news_rate_down`
  (fall only), `news_rate_up` (rise only), `news_rate_mixed` (both),
  `news_rate_tiers_only` (no base field changed; tiers did). The historical
  `category` is kept, so a tiers-only change is never shown as an increase.
- **`official`** — only on an exact (provider, model) match in
  `catalogue/official-verified.json`: `{verified_at, source_note (its free-text
  source_url), windows (exact copies, null if absent)}`; the item's
  `source_url` stays `""` — URLs are never invented.
- **`last_used_at`** (all ranked items) — ISO UTC of the newest usage row
  whose recorded model equals the item model exactly (no last-segment match)
  on the same canonical route provider; `""` without a match. Built on the
  additive `last_ts` (`MAX(ts)`) bucket in `usage_summary`; totals unchanged.

## Snapshot additions and upgrades

Snapshot rows gain `name` and `tiers_raw`; the snapshot gains
`raw_tiers_v: 1`. Raw capture reads the same source file once per refresh,
read-only, yielding unknown when unreadable, unparseable or not a models.dev
cache. A `tiers_raw` difference counts as a tier change only when both sides
are non-null, so upgrading a pre-raw snapshot with identical rates emits nothing.

## Recurrence

`refresh_local` previously dropped a re-diffed item whose id was already
stored, losing A→B, B→A, A→B. If the stored item's `observed_at` is strictly
earlier than the previous snapshot's `captured_at`, the transition genuinely
recurred and is stored as `"<id>-r" + sha1(observed_at)[:6]` (skipped if
that id is also known). A re-emit against a snapshot the stored item
postdates (a crash between the two writes), or a snapshot without
`captured_at`, is skipped as before; stored ids are never altered.

## Fixtures and rollback

`test/fixtures/news/` holds `models-dev-cache.json` (raw cache),
`official-verified.json` and generated payloads `payload-local-central.json`,
`payload-unknown-recurrence.json`; regenerate with
`python3 test/fixtures/news/regenerate_payload.py`. Revert
`9cffda4`, `b905106` and `42d54f6`; no migration is needed: `load_items`
keeps any dict item with an `id` and `news_payload` passes stored items
through `rank_items` unvalidated, so older code ignores the extra fields,
`-r` ids are ordinary item ids, and snapshot extras are read with `.get()`.
