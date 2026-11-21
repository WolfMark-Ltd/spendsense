# Stage 3: moving Overview and Usage assertions out of Chromium

This is the assertion-level migration map for the Overview and Usage slice of
the Stage 3 browser-test optimisation. It records what left the two Chromium
suites, where it went, what stayed, what the negative controls proved, and what
the measurements actually were.

Scope: **Overview and Usage only**. Model News (#83, #85), Reports (#81) and
Memberships (#84) are untouched. Product code is unchanged: `git diff
origin/main -- desktop/` is empty.

## 1. What the suites looked like at the start

At `origin/main` (`d894f19`, which includes #79, #81, #83, #84 and #85):

| Suite | Cases | Chromium launches | Assertion statements | Wall clock |
| --- | --- | --- | --- | --- |
| `overview-layout.test.mjs` | 1 | 12 | 75 | 36.5 s |
| `usage-layout.test.mjs` | 1 | 4 | 79 | 22.9 s |
| **Total** | **2** | **16** | **154** | **59.5 s** |
| Browserless (`scripts/node-tests.sh browserless`) | 825 across 29 files | 0 | — | 78.9 s |

Launch counts are measured, not estimated: `child_process.execFileSync` was
wrapped by a measurement-only `--require` stub that logged every invocation
(`/tmp/wm-launches.log`, kept per run). The 12 Overview launches are
`2 locales × (1 matrix run + 4 single-pane runs + 1 Review run)`; the 4 Usage
launches are one per `locale × host-token` combination.

Both files make a **constant** number of launches. Everything they assert is
read back from one JSON blob per launch, so assertion volume does not drive the
wall clock — which is why moving assertions cannot, by itself, reduce launches.

## 2. What was actually out of place

Both suites were doing two jobs at once:

- **Financial semantics and copy.** Which evidence kind a figure belongs to, its
  scope, its caveat words, the disclosure titles, the ranking's labels, the
  filter inventory and the chip vocabulary — re-verified once per layout case,
  in both languages, under `--dump-dom`.
- **Geometry and paint.** Columns, card heights and widths, sticky navigation,
  button clipping, computed theme colours, table scrolling, SVG paint, contrast
  ratios and filter overlap.

The first group needs no browser. It also cannot be *trusted* in one: an early
read of the suite produced a whole layout case with no Overview panels at all on
an unchanged revision, so the same file could pass a copy assertion because the
copy was right and fail a geometry assertion because nothing had painted.

The second group is the reason these files exist and is entirely retained.

## 3. Overview migration map

New home: `test/overview-render.test.mjs` — browserless, the real `OverviewPage`
with real React and real TanStack Query over jsdom, four cases covering both
languages. The payload is shared with the Chromium harness through
`test/overview-fixtures.mjs`, so the two renderers cannot drift.

Each row was asserted in Chromium once per layout (`3 widths × 2 themes ×
2 locales` = 12 times).

| # | Existing browser assertion | Browserless replacement | Class |
| --- | --- | --- | --- |
| 1 | `methodSections === 5` | “five named methodology sections”: count **and** every heading, both locales | Move (strengthened) |
| 2 | charge card shows `Not recorded` | “four evidence kinds”: the figure equals `ovNotRecorded` | Consolidate → `membership-scope` “Overview keeps provider charges not recorded…” + Move |
| 3 | charge card shows `No per-call evidence` | same test: the chip's text | Consolidate → same |
| 4 | charge card does not match `covers` / `N of N records` | same test, plus “never printed as a zero amount” | Consolidate + Strengthen |
| 5 | recorded card matches *all profiles … calendar month to date* | same test: equals `ovRecordedScope` | Consolidate → `membership-scope` “Overview renders its settled Desktop cost summary…” |
| 6 | estimate card matches *active profile … rolling 30 days* | same test: the estimate's scope | Move |
| 7 | page says the two usage amounts must not be added | same test: the scope note, both locales | Move |
| 8 | recorded card shows `Partial` | same test: the certainty chip | Consolidate → `membership-scope` “keeps the subtotal visible…” |
| 9 | recorded figure is not prefixed `At least` | “never prefixes a measured figure”: figure shape + no qualifier | Consolidate → same + Move |
| 10 | estimate figure is not prefixed `At least` | same test | Move |
| 11 | page labels `Actual provider charges` | “four evidence kinds”: the card's eyebrow | Consolidate → `membership-scope` “renders its settled Desktop cost summary” |
| 12 | page shows `Most-used models` | “ranks recorded calls…”: the panel heading equals `ovModelsTitle` | Move |
| 13 | page shows `GBP 20.00/mo` | “four evidence kinds”: the fee figure keeps currency **and** period | Move |
| 14 | fee card shows `Partial` | same test: the fee chips | Consolidate → `membership-scope` “known fee subtotal as Partial” |
| 15 | pricing action label is the localised string | — | Consolidate → `membership-scope` “attention gives specific actions…” and `ux-primitives` “Overview pricing action opens unfiltered 30-day Usage coverage” (which also asserts the destination, the 30-day query and the focus move) |
| 16 | no redundant `Open Usage` action in the ranking | “ranks recorded calls…”: no usage shortcut, in the localised vocabulary | Consolidate → `membership-scope` “ranks backend model call counts…” + Move |
| 17 | first model label is the friendly long name | same test: both friendly names, both locales | Move |
| 18 | two exact-ID help controls | same test: one labelled control per row **and** the tooltip's model + provider IDs | Consolidate → `membership-scope` + Strengthen |
| 19 | `layout.locale === locale` | the Chromium probe now reports the page title, asserted against `ovTitle`; the browserless suite asserts the same title per language | **Strengthen** — see §6.1 |
| 20 | pricing action label (single-pane loop) | — | Consolidate — duplicate of #15 inside the same file |

### Added to Chromium with the migration (all browser-only or anti-vacuous)

- `readiness.ready` — the page reached its final structure (§6.4).
- `errors === []` — the probe previously referenced `window.__overviewErrors`
  without ever registering a listener, so a render error could only show up as a
  missing panel.
- `buttonCount >= 7` — `clippedButtons: []` passes on an empty button list.

## 4. Usage migration map

New home: `test/usage-render.test.mjs` — browserless, the real `Usage` page
(`AnalyticsPage` with `productPage: true`, i.e. the production shape) over the
shared fixture, seven cases, both languages.

Each row was asserted in Chromium once per layout (`2 widths × 2 themes`) ×
`4 runs` (`en`, `zh-CN` × host-token present/absent`) = 16 times.

| # | Existing browser assertion | Browserless replacement | Class |
| --- | --- | --- | --- |
| 1 | section numbers are `01`–`07` | “numbers seven sections 01–07”: numbers **and** every panel title | Move |
| 2 | at least two KPI groups | “five headline figures”: exact `money`/`activity` kinds, their aria-labels and `role="group"` | Move + Strengthen |
| 3 | four advanced selects | “seven filters, four behind a disclosure” | Consolidate → `analytics.test.mjs` “advanced filters stay available…” |
| 4 | advanced summary contains `2` | same test: the summary **equals** `usageFilterAdvanced(2)` | Move + Strengthen |
| 5 | every trend point is titled | “exact chart values on hover”: all seven points, both locales | Move |
| 6 | every legend row is titled | same test | Move |
| 7 | page shows `72,000` | same test: the selected point's detail, exactly | Move + Strengthen |
| 8 | Methodology is collapsed | “methodology and baseline stay collapsed” | Consolidate → `analytics.test.mjs` “dashboard renders three SVG analytics…” |
| 9 | Baseline is collapsed | same test: plus its summary names it a separate estimate | Consolidate + Strengthen |
| 10 | no `× Close` | retained in Chromium, and asserted browserlessly in the chip test | Retain (relocated) + Move |
| 11 | chip count 3 → 2 after removing the surface chip | “drops a filter from its chip”: counts **and** the query state | Move + Strengthen |
| 12 | disclosure count drops to `1` | same test: the summary equals `usageFilterAdvanced(1)` | Move + Strengthen |
| 13 | chip count 2 → 1 after removing the model chip | same test: plus `filters.model === ''` | Move + Strengthen |
| 14 | the advanced disclosure toggles closed and open | same test: DOM open state both ways | Move |
| 15 | `Theoretical net savings` | “billing and cache honesty copy”: the dictionary string, both locales | Consolidate → `analytics.test.mjs` + Move |
| 16 | `Provider charges are not recorded` | same test | Consolidate → same + Move |
| 17 | `Partial` | “five headline figures”: the pricing qualifier with both denominators | Consolidate → same + Strengthen |
| 18 | `Billing classification` | “billing and cache honesty copy” | Consolidate → same + Move |
| 19 | `Methodology & coverage details` | same test | Consolidate → same + Move |
| 20 | zh chart key translates cache read | “exact chart values on hover”: every stream named from `analyticsComposition` | Consolidate → `analytics.test.mjs` “analytics pricing, insights and deltas…” + Move |
| 21 | zh filter chips translate `模型` | “seven filters…”: the chip row in both locales | Consolidate → `ui-labels` “granularity and filter-chip labels translate” + Move |

### Added or strengthened in Chromium with the migration

- `readiness.ready` — the page reached its final structure (§6.4).
- `advancedOpen === !!advanced.open` was a self-referential check (the probe had
  just set `advanced.open = true`). Replaced by `advancedRowHeight > 0`: a
  collapsed row measures zero height, and the overlap/overflow assertions that
  follow would otherwise pass on nothing (§6.3).

## 5. Deliberately retained in Chromium

**Overview**

- Columns per width (`summaryColumns`, `panelColumns`), card content overflow,
  equal card heights and widths, and the `height < 260` compactness ceiling.
- Pane and document horizontal overflow; the whole `268 / 380 / 1200 px` matrix.
- Sticky navigation: `position`, `z-index`, opaque underlay, pinned `top`, and
  tab-strip overflow.
- Button clipping inside the pane, and inside the full-height pane in
  single-pane mode.
- `paneLeft / paneRight / paneBottom` against the screenshot viewport.
- Dark and light host fills and text colours.
- **The narrow Review jump**: focus before activation, the fixture wrapping the
  tabs beyond the old 68 px offset, `scrollMarginTop` derived from the rendered
  header height, and the attention heading and intro sitting visibly below the
  sticky tabs and inside the pane. This is the regression the suite exists for
  and is unchanged.

**Usage**

- Nested-scroll freedom (`usageOverflowY`, `usageScrollDelta`, `mainScrollDelta`)
  and the explorer's own `overflow-x: auto` / `overflow-y: clip` with no
  vertical delta.
- Sticky explorer column geometry (`stickyColumnWidth < tableViewportWidth`) and
  the computed `position: sticky` on the first cell.
- Filter, chip and advanced-row overlap; filter-row and KPI overflow.
- `--ui-warning` / `--ui-error` resolution **with and without** the optional host
  tokens, and every shared state style computed from them (attention pill,
  Memberships rail, Reports rail, flash, partial/error/success chips, Settings
  warning and confirmation, news badge). This protects compatibility with other
  Hermes Desktop themes and is unchanged.
- Four distinct chart-key colours with contrast ratios, the eight-colour series
  palette and its contrast floor, the painted cache-read rect matching its key,
  every chart's visible non-black paint, and the doughnut stroke.
- `headingStart` as the locale guard, `sections`, `stats`, `selects`, `chips`,
  `trendPoints > 0`, `legendRows > 0` and `explorerColumns` as the content guards
  that keep the geometry above from passing on an empty page.

Both suites keep their own content guards so an empty or broken page cannot pass
a geometry check, and both now fail if the page never reaches that content.

## 6. Weak or vacuous assertions found

1. **Overview's locale check compared a value with itself.** The probe copied
   `globalThis.__overviewLocale` into `layout.locale` and the test compared
   `layout.locale` with the same variable, so `layout.locale === locale` could
   not fail. Replaced by the rendered page title against `ovTitle`.
2. **Usage's `advancedOpen` echoed its own probe.** The page set
   `advanced.open = true` and the test read `!!advanced.open` back. It could not
   detect a disclosure that failed to open, and the two geometry assertions that
   depend on the row being open would then measure four zero-height rectangles
   and pass.
3. **Empty-list vacuity in both suites.** `clippedButtons: []`,
   `overflow: []`, `filterOverlap: []`, `chipOverlap: []` and
   `advancedRowOverflow: 0` all pass when the query finds nothing. Usage already
   had count guards (`chips`, `selects`, `stats`); Overview had none for buttons.
   Fixed with `buttonCount >= 7` and `advancedRowHeight > 0`.
4. **A fixed wait measured whatever happened to be on screen.** The Overview
   page measured at `setTimeout(…, 900)` and Usage at `tick(1200)`. A run during
   this work published `missingOverview` for one of six cases on an unchanged
   revision — the same signature recorded for this harness before PR #79. Both
   pages now poll (bounded: 4000 ms and 6000 ms of page time) for the final
   structure every assertion depends on, publish `readiness`, and report a page
   that missed the deadline by name.
5. **Overview had no page-error capture at all.** `window.__overviewErrors` was
   referenced but never populated. The probe now registers the listener and the
   suite asserts the list is empty.
6. **Overview's five-section check was weaker than the existing one.**
   `membership-scope` already asserted the count *and* a section name after
   expanding the disclosure; Chromium asserted only the count, twelve times.

## 7. Regression parity

Each replacement was proved against a deliberately broken product **before** the
browser assertion was deleted. `desktop/plugin.js` was mutated in place, the
replacement was run alone, the file was restored from memory and verified by
SHA-256 (`dc658758…`). The harness is a scratch script kept with the gate
handover evidence rather than in the tree, because it rewrites product source in
place by design; the tree holds no deliberate mutation at the end (`git diff --
desktop/` empty).

| Control | Regression injected | Caught by | Result |
| --- | --- | --- | --- |
| M1 | recorded usage borrows the estimate's scope label | overview-render · evidence kinds | DETECTED |
| M2 | a missing provider charge is printed as `$0.00` | same | DETECTED |
| M3 | a partly priced subtotal loses its Partial chip | same | DETECTED |
| M4 | the scope note stops saying the totals are not additive | same | DETECTED |
| M5 | the methodology drops one of five sections | overview-render · methodology | DETECTED |
| M6 | the ranking shows the raw route id | overview-render · ranking | DETECTED |
| M7 | the exact-ID tooltip drops the route | same | DETECTED |
| M8 | the fee figure loses its billing period | overview-render · evidence kinds | DETECTED |
| M9 | the seventh section is numbered `06` | usage-render · sections | DETECTED |
| M10 | removing a chip leaves the filter in the query state | usage-render · chips | DETECTED |
| M11 | the advanced disclosure undercounts active slices | usage-render · filters **and** chips | DETECTED |
| M12 | trend points lose their hover values | usage-render · exact chart values | DETECTED |
| M13 | methodology opens by default | usage-render · disclosures | DETECTED |
| M14 | the pricing qualifier drops the token/call split | usage-render · headline figures | DETECTED |
| M15 | the theoretical saving shows the API subtotal | same | DETECTED |
| M16 | the ranking loses its window-bearing title | overview-render · ranking | DETECTED |
| M17 | the charge card claims per-call coverage | `membership-scope` (existing surrogate) | DETECTED |
| M18 | a measured subtotal gains an `At least` prefix | `membership-scope` (existing surrogate) | DETECTED |
| M19 | the recorded-cost classification drops its label | usage-render · honesty copy | DETECTED |
| M20 | the page re-offers a redundant `× Close` | usage-render · chips | DETECTED |

20/20 failed with the regression present and passed on the restored source. Every
Overview and Usage expectation runs in both languages, so each mutation is
detected twice.

**The readiness gate is itself controlled.** Requiring a selector the page never
renders made the Overview suite fail with

```
[en] the page reached its final structure (4000ms)
false !== true
```

in 6.4 s — one launch, first assertion — so the gate is live rather than
decorative, and a run whose page never paints cannot reach the geometry checks.

## 8. Measurements

Local figures are from the Hermes VPS, one file at a time, `/usr/bin/google-chrome`,
Node v24.22.3. The VPS is shared with Hermes itself and carried a load average
between 5 and 7 during these runs, so **treat the wall clocks as indicative and
the launch counts as exact**. Hosted CI figures are in §9.

| Metric | Before | After |
| --- | --- | --- |
| Overview Chromium cases | 1 | 1 |
| Usage Chromium cases | 1 | 1 |
| Overview Chromium launches | 12 | **12** |
| Usage Chromium launches | 4 | **4** |
| Chromium launches, total | 16 | **16** |
| Overview assertion statements | 75 | 61 |
| — per layout (×12) | 36 | 20 |
| Usage assertion statements | 79 | 59 |
| — per layout (×16) | 61 | 52 |
| Overview wall clock | 36.5 s | 40.2 s |
| Usage wall clock | 22.9 s | 16.8 s |
| Browserless cases | 825 across 29 files | 836 across 31 files |
| New browserless suites | — | 11 cases: 4.3 s + 6.6 s process time |
| Owned browser processes remaining | 0 | 0 |

**The honest conclusion: this PR saves no Chromium launches, because neither
file's launch count depends on how much it asserts.** Overview makes 12 launches
for `2 locales × (matrix + 4 single-pane + Review)` and Usage makes 4 for
`locale × host-token`; both still need every one of those for geometry, paint or
viewport-accurate screenshots. What changed is *where* the assertions run: the
financial semantics, the copy, the section inventory, the filter state and the
chip behaviour now fail in the browserless job in about a second, and the
Chromium files no longer re-verify them 12 and 16 times over.

The local wall clocks moved in both directions (Overview +3.7 s, Usage −6.1 s)
on a loaded host; they are not a treatment effect and this PR does not claim
one.

## 9. Hosted CI

See the PR's final commit for the run that was green on both `tests` jobs and on
`chromium`. The `chromium` job log gives per-file completion times, which is the
comparable measurement the local host cannot provide.

## 10. Screenshot compatibility

Both mechanisms are untouched and were exercised on the final tree:

- `OVERVIEW_LAYOUT_SHOT_DIR` wrote the expected eight PNGs —
  `overview-w{268,380,1200}-{dark,light}-en.png` and
  `overview-w{380,1200}-light-zh.png` — at 308×2400, 420×2400 and 1240×1600, and
  the run's own pane assertions (`paneLeft`, `paneRight`, `clippedButtons`,
  `buttonsOutsidePane`, `navigationOverflow`) passed before each capture.
- `USAGE_LAYOUT_SHOT_DIR` wrote the expected eight PNGs —
  `usage-{en,zh-CN}-{narrow,wide}-{dark,light}.png` — at 420×3600 and 1240×2200.

Neither is generated in ordinary CI: both remain gated on their environment
variable.

## 11. Risks and limitations

- **No launch reduction is claimed or possible here.** All sixteen launches are
  still made; the gain is placement, not resource use.
- **jsdom is not Chromium.** The moved assertions prove the DOM and copy the
  components produce, not that a browser paints them. Every paint, contrast,
  scroll and overlap check stays in Chromium.
- **Two renderers, one payload.** `overview-fixtures.mjs` and
  `usage-fixtures.mjs` are the only thing keeping the browser and browserless
  data identical; editing one renderer's copy is no longer possible, but a change
  to the *shape* of a fixture affects both suites at once.
- **Usage renders the production shape** (`productPage: true`, inside the
  product shell) while the Chromium harness renders the same content without the
  shell. The inner content is built once by `AnalyticsDashboard` and both
  wrappers render it unchanged; the shell adds the seven-tab bar and the health
  query, which the fixture answers.
- **The readiness gates are new.** A page that legitimately needs more than
  4000 ms (Overview) or 6000 ms (Usage) of page time to reach its final
  structure will now fail by name rather than measure late. That is the intended
  trade: a named failure beats a silent misread.
- **Local timing is noisy.** The VPS load averaged 5–7 during measurement.

## 12. Recommendations for future browser-launch reduction

1. **Overview: one browser, many contexts.** Twelve launches exist because each
   single-pane case needs its own window size. Stage 2's pattern —
   `Target.createBrowserContext` plus a flattened page session per case, one
   Chrome process — would take this file from 12 launches to 1 with no loss of
   layout evidence. It is a page-and-probe rewrite with its own risk profile and
   belongs in its own PR.
2. **Both files: render both locales in one page.** Overview launches twice for
   the matrix and twice per width for the single panes; Usage four times for
   `locale × host-token`. A page that fills a locale into a container rather than
   at bundle time would remove the per-locale launch entirely (Overview 12 → 6,
   Usage 4 → 2) even before process reuse.
3. **Do not chase assertion counts for speed.** Both files' run time is dominated
   by bundle build, Chrome start and the virtual-time budget; assertion volume is
   free.
