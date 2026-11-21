# Stage 2: one Chromium process for the Model News layout suite

This PR replaces the Model News suite's twenty independent `execFileSync`
Chromium launches with one managed browser and one isolated browser context per
scenario. It is the Model News half of the Stage 2 lifecycle work; PR #81 did
the same for Reports and supplied the process, DevTools and isolation code this
change reuses.

Scope: `test/news-layout.*` and the shared `test/chromium-lifecycle.mjs`
extraction. No product code changes.

## 1. What the suite did before

`test/news-layout.test.mjs` called `chromeDom()`, which ran `execFileSync` with
`--headless --virtual-time-budget=6000 --dump-dom` and retried up to three
times. Portions of the 24-case layout matrix were batched into one document per
`(fixture, scope, locale)` group, split into chunks of at most five cases, and
the interaction probes each navigated a separate command-line Chrome.

Measured at `069d752` (the baseline for this change):

| Category | Chromium root launches |
| --- | ---: |
| Layout grid (4 realistic groups + 6 variant groups + 2 state groups) | 12 |
| Interaction and candidate probes | 8 |
| **Total** | **20** |

Three of those probes re-navigated a case the grid had already measured
(`realistic__foryou__380__dark__en` twice, plus the two 1200 px candidate
probes); the rest were genuinely different scenarios.

## 2. Root cause of the repeated launches

The launch count was a property of the **helper**, not the assertions. Each
`chromeDom()` call was a whole browser cold start plus teardown, and the helper
was called once per run/probe. Nothing about the checks needed a new process:
they needed a rendered page, a fixed viewport and their own fixture globals.

## 3. The lifecycle now

1. Build the fixture bundle once with esbuild.
2. Serve the page and bundle from a loopback HTTP server. A real origin, not
   `file://`, is what lets each case prove its context carries no storage from
   the previous one.
3. Launch Chromium once, in its own process group, with a dedicated temporary
   profile.
4. Connect once to the browser-level DevTools socket.
5. For each scenario: `Target.createBrowserContext` → `Target.createTarget` →
   attach a flattened session → `Emulation.setDeviceMetricsOverride` (width =
   the pane width under test, height 1800) → navigate → poll for the published
   measurement → dispose the context, target and session.
6. Stop the browser once, verify the owned process group is empty, verify
   exactly one profile directory existed, remove the scratch tree.

The browser instance is shared. The **fixture environment is not**: every case
is a fresh document in a fresh context, so the page's fixture, scope and locale
globals are established before React renders and cannot carry over.

`test/chromium-lifecycle.mjs` holds the shared code. It is a move, not a
rewrite: `reports-layout.chromium.mjs` and `reports-layout.devtools.mjs` now
re-export it with their previous names, defaults and message wording, so every
Reports regression test still runs against the same behaviour. The Reports
process-tree protections — explicit group ownership from the spawn
configuration, descendant verification even when the leader has already exited,
bounded SIGKILL escalation inside the owned group only — are unchanged and their
negative controls remain in `reports-layout.chromium.test.mjs`.

## 4. Isolation model

| Concern | Mechanism | Evidence |
| --- | --- | --- |
| Fixture / scope / locale globals | fresh page per case | `createBrowserContext` per case (browserless test) |
| Cookies and web storage | fresh browser context per case | page writes a marker; every case asserts `isolation.prior === null` |
| Earlier React roots | never reused | one case per document |
| Pagination / filter / focus state | starts from the documented initial state | probes assert the initial page size and tab order |
| Viewport | `Emulation.setDeviceMetricsOverride` per case | width asserted to be the case width |

The per-case `prior === null` assertion would be vacuous if the marker could
never be observed, so the suite also runs one negative control: two navigations
inside **one** context must see each other's marker. It asserts the fresh load
sees nothing and the second load sees the first case's id.

## 5. Complete matrix and probes

The 24-case matrix moved from the page to `NEWS_LAYOUT_MATRIX` in
`test/news-layout.chromium.mjs`, unchanged: realistic × For You/All × 380/1200
× dark/light × en/zh-CN (16), plus empty/partial/nosignals × both scopes and
stale/error (8). A browserless test asserts its size, uniqueness and every
dimension, so a scenario cannot silently disappear.

Every probe is retained and each still gets its own isolated page:

- headline → archive destination (scope, category, date window, search);
- the same probe for a model-less story (`model=` present and empty);
- the split-family story landing inside the panel it opened;
- focus consumed once and re-armed by a new click;
- candidate structure for All and For You at 1200 px;
- the evidence-retention payload;
- a story that sorts past the first page.

The two 1200 px candidate probes now ride their own matrix measurement: the
matrix navigation asks for `probe=1` for those two ids, so one page execution
yields both the measurement and the probe. It is the same URL, the same query
and the same pre-probe page state the separate run used.

## 6. Readiness

The page no longer waits a fixed 900 ms before measuring. It publishes as soon
as the browser reports the document loaded and then runs a bounded readiness
poll of its own:

- the controls row exists;
- a list, an empty region or a state section exists;
- when the fixture carries items, at least one card or model group has rendered.

The result records `readiness: { ready, waitedMs, expectedItems }`, and every
case asserts `ready === true`. A page that never paints therefore fails by name
instead of being measured and passing a set of assertions about nothing.

Virtual time is gone. The page's clock is still pinned by an inline
`Date.now = () => 2026-11-10T12:00:00Z`, so the 30-day recency assertions keep
the same semantics; `--virtual-time-budget` was only ever a way to fast-forward
the fixed timers, and those timers are now real bounded waits. The probe still
asserts `nowMs === NEWS_PAGE_NOW_MS`, which proves the pin took effect.

## 7. Retry and failure handling

There are no retries. `chromeDom()` and its three attempts are gone; a failure
fails.

- A missing or malformed measurement fails with the case name.
- A payload that does not describe exactly the requested case fails.
- A navigation, CDP or viewport error is reported with the affected case.
- An uncaught page exception is attached to the timeout it caused.
- Every path releases the context, and reports a release failure instead of
  swallowing it.
- There is no relaunch path: the suite never restarts Chromium, and the
  baseline test asserts the root process is still the original one after the
  whole matrix.

## 8. Process ownership and teardown

Unchanged from PR #81, and now shared: the spawn carries the process-group
ownership flag explicitly, `stopChromium` requires that flag rather than
inferring it, and it verifies the group is empty on every path — including when
the leader exited on its own — before reporting success. The suite's `after()`
hook runs on failure too, so a broken assertion cannot leak a browser; it
reports teardown errors as an `AggregateError` rather than hiding them.

## 9. Screenshots

`NEWS_LAYOUT_SHOTS` remains opt-in and must resolve outside the repository
(`shotsOutsideRepo`, unchanged). The capture now runs on the **same isolated
page** that produced the measurement, through `Page.captureScreenshot` with a
clip of the case container, so one screenshot costs no second browser process.
Names stay deterministic and scenario-scoped:
`news-<fixture>-<scope>-<w>-<theme>-<locale>.png`. The baseline test asserts the
file exists and starts with the PNG signature, and a browserless test proves the
capture is skipped entirely when no path is requested.

## 10. Regression coverage

New browserless file `test/news-layout.chromium.test.mjs` (no Chromium, focused
doubles):

- the 24-case matrix inventory and each of its dimensions;
- case ids and URLs, including `model=` present-but-empty;
- one context and page per scenario, released before the next;
- per-case viewport;
- payload validation (two cases, wrong case, page refusal);
- missing and malformed measurements;
- CDP and navigation failures reported per scenario;
- a crash mid-run still releases the context;
- page exceptions surfaced on timeout;
- the isolation negative control;
- screenshot naming, capture and the empty-box failure.

Existing coverage kept: `news-layout.harness.test.mjs` still proves the
screenshot path containment and that a mandatory candidate run fails, never
skips, when Chromium is unavailable or when only a Chromium binary is present.
The Reports process-ownership controls are untouched.

## 11. Measurements

Recorded from hosted GitHub Actions runs (`node-tests.sh browser`) at the final
head. Placeholder — filled after the first CI run of this branch.

| Metric | Before (`069d752`) | After |
| --- | ---: | ---: |
| Model News Chromium root launches | 20 | 1 |
| Model News Node test cases | 7 | 7 |
| Layout matrix combinations | 24 | 24 |
| `news-layout.test.mjs` duration | 60.0 s (documented PR #83 run) | measured below |
| Browserless cases | 808 across 28 files | 822 across 29 files (+14) |
| Process leftovers | none observed | asserted zero owned processes |

## 12. Risks and limitations

- **Chromium is still Chromium.** One long-lived browser keeps its zygote, GPU
  and network processes resident, so the peak *process count* need not fall even
  though launches fall by 95%. The suite reports its peak owned-process count
  per run rather than claiming a reduction it did not measure.
- **Sequential by design.** Cases run one at a time. Parallel contexts would cut
  wall clock further but make contended-runner timing and failure attribution
  worse; that is a separate decision.
- **A shared browser is a shared failure domain.** If the browser dies, the
  remaining cases fail rather than silently restarting — deliberate, and the
  original crash is reported.
- **jsdom cannot stand in for the layout assertions.** The browser suite is
  still the only place computed contrast, overflow, scroll topology and focus
  visibility are measured.
