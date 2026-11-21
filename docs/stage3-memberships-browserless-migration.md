# Stage 3: moving Memberships assertions out of Chromium

This is the assertion-level migration map for the Memberships slice of the
Stage 3 browser-test optimisation. It records what left the Chromium suites,
where it went, what stayed, and what the measurements actually were.

Scope: **Memberships only**. Model News (#83) and Reports (#81) are untouched.

## 1. What the suites looked like at the start

At `origin/main` (`4dedfd8`, which includes #79, #81 and #83):

| Suite | Cases | Chromium launches | Wall clock |
| --- | --- | --- | --- |
| `memberships-cards.test.mjs` | 1 | 2 (en, zh) | 8.1 s |
| `memberships-clarity.test.mjs` | 1 | 2 (en, zh) | 12.0 s |
| `memberships-disclosure.test.mjs` | 1 | 2 (en, zh) | 9.9 s |
| `memberships-layout.test.mjs` | 1 | 1 | 6.2 s |
| `memberships-polish.test.mjs` | 1 | 1 | 4.6 s |
| `memberships-visibility.test.mjs` | 1 | 1 | 4.4 s |
| **Total** | **6** | **9** | **45.2 s** |
| Browserless (`scripts/node-tests.sh browserless`) | 802 across 27 files | 0 | 97.1 s |

The launch count is measured, not estimated: `child_process.execFileSync` was
wrapped by a measurement-only `--import` stub that logged every invocation.

The shape of these suites matters. Each file builds one page, renders every
layout case in that page at once, and reads geometry back from a JSON blob. The
browser work per file is roughly constant — a bundle, a Chrome start, a
virtual-time budget — so **moving assertions out of these files cannot reduce
launches while each file still needs its browser for geometry**. That is what
happened, and this PR does not pretend otherwise (§7).

## 2. What was actually out of place

The assertions split unevenly:

- `memberships-cards` and `memberships-disclosure` were mostly geometry,
  computed style and focusability — correctly in Chromium.
- `memberships-clarity` was **mostly copy, vocabulary and business rules**,
  re-verified once per layout case × locale: eight identical copies of the same
  reading-state matrix under `--dump-dom`.
- `memberships-polish` and `memberships-disclosure` each asserted stylesheet
  *strings* inside a browser run — checks that need no browser at all.
- `memberships-layout` carried one reading-state assertion that the clarity
  matrix already covered more thoroughly.

## 3. Migration map

New home: `test/memberships-reading.test.mjs` (browserless, real
`MembershipsPage`, real React and TanStack Query, the real plugin bundle). The
accounts are shared with the Chromium harness through
`test/memberships-fixtures.mjs`, so the two renderers cannot drift.

| # | Existing browser assertion | Browserless replacement | Browser coverage retained | Class |
| --- | --- | --- | --- | --- |
| 1 | clarity: `memb:reported` reading state, label, age ("10 min ago") | reading suite · "every reading state is named separately" | row presence + chip overflow at 380 px | Move |
| 2 | clarity: `memb:unsupported` state + label + "explained once, not per card" | same test | chip fits its row | Move |
| 3 | clarity: `memb:nohermes` state + label + notes | same test | row presence in every case | Move |
| 4 | clarity: `memb:failed` state + label + its one note | same test | row presence | Move |
| 5 | clarity: `memb:stored` unreported state + label + notes | same test | row presence | Move |
| 6 | clarity: page-level explainer and reading-health counts (`2 with no reading`, `1 failed`, machine-readable failed count) | same test | — | Move |
| 7 | clarity (en + zh): the whole vocabulary in Chinese | reading suite · "the reading vocabulary survives translation" | — | Move |
| 8 | clarity: included / prepaid / metered / free fee wording; "No credential" chip | reading suite · "absence is never rendered as a measured zero" | — | Move |
| 9 | clarity: "no zero is invented" — pane text, per-row chips, fee cells | same test (strengthened: pane-wide and per-row) | — | Move |
| 10 | clarity: summary labels, card kinds, reviewed 9 / paid 4, statuses, notes, fee lines, tones | reading suite · "the summary reconciles…" | figure size/weight, rail width/colour, card overflow, columns | Move |
| 11 | clarity: arrangement sum, labels and the unconfirmed mapping | same test | — | Move |
| 12 | clarity: group kinds, counts, headings carry their count | reading suite · "accounts group by arrangement" | — | Move |
| 13 | clarity: no route slug in view; friendly provider name | same test | — | Move |
| 14 | clarity: backend notes inside details; diagnostics label + "optional" | reading suite · "backend messages stay behind the technical details" | `rawNotesInNormalView === false` (innerText) | Move |
| 15 | clarity: attention status derived from its own count (`value === '0' ? Clear : Open`) | reading suite asserts the count (2) and the status explicitly | — | **Strengthen** |
| 16 | clarity: `attentionScope.length > 0` (duplicate of the `Plan setup…` match) | removed — the earlier match is the assertion | — | Consolidate |
| 17 | clarity: Costs link label + keyboard focusability + click → Costs tab + anchor focus + `tabindex="-1"` | — | **Retained** in clarity | Retain |
| 18 | disclosure: chevron open/closed/rotation rules read from `MEMBERSHIP_CSS` | reading suite · "the memberships stylesheet carries the disclosure and highlight contracts" | open-group computed transform | Move |
| 19 | polish: `.wm-seg` / `.wm-flash` / `prefers-reduced-motion` presence checks | same stylesheet test (strengthened to the actual rules: animation, reduced-motion override, `flex-wrap`, `min-width:0`) | segmented-control geometry, 38 px targets, clipping | Move + Strengthen |
| 20 | layout: `readingStates === ['reported','unreported']` | covered by #1/#5 over the full matrix | `hasLongFee`, `hasMixedCurrencies`, row count | Consolidate |
| 21 | cards: summary arithmetic for its own nine-account mix (9 reviewed, 3 paid, 2 attention, 100 USD / 19.99 EUR lines) | — | **Retained** in cards | Retain |

## 4. Deliberately retained in Chromium

- **Cards**: card/rail geometry, figure dominance, columns per width, and the
  summary arithmetic for its own account mix (a different mix from the reading
  suite's: three paid accounts, one unknown fee, a confirmed free tier). That
  arithmetic is the only place those numbers are computed, and the geometry
  around it has to render those exact cards, so removing it would save nothing
  and lose a distinct case.
- **Clarity**: pane and chip overflow, computed figure size/weight, rail width
  and colour, column count per width, costs-link focus and navigation, and
  `rawNotesInNormalView` — the rendered-visibility half of the backend-notes
  rule, which only a browser can measure.
- **Layout**: two-column strip, fee-cell overflow, account-navigation stacking,
  correct fixture data (`hasLongFee`, `hasMixedCurrencies`), and the narrow-pane
  exhaustion flow (form opens inline, under its own button, focused, inside the
  pane).
- **Disclosure**: closed content taking no layout space, closed controls
  unfocusable, open grid layout, computed chevron transform, focus after
  expansion, and the draft/cancel flow.
- **Polish**: segmented-control geometry and touch targets, attention
  navigation landing on the visible control with the expected label, and the
  arrangement write with its exact payload.
- **Visibility**: below-fold targets, scroll-to-target, focus, highlight,
  reduced-motion navigation, and tooltip anchoring/clipping at both widths.

Every retained suite also keeps its anti-vacuous checks: the expected rows and
cards must render before any geometry is measured, so a blank page cannot pass.

## 5. Weak or vacuous assertions found

1. **Clarity's attention status was self-referential.** It asserted
   `status === (value === '0' ? 'None' : 'Needs action')`, deriving the expected
   status from the observed count. It could only fail if the status matched
   neither string — it could never catch the count changing. The replacement
   asserts the fixture's count (`2`) and the status (`Needs action`) explicitly,
   and negative control M4 confirms it detects a status that ignores the count.
2. **`attentionScope.length > 0` was a duplicate** of the earlier
   `Plan setup and allowance marks` match in the same loop: any change that
   broke the wording would already fail the stricter matcher.
3. **Three stylesheet checks were selector substrings**
   (`css.includes('.wm-seg')` and friends) measured from inside a browser. They
   now assert the rules themselves (animation, reduced-motion override,
   wrapping, shrinking) in the browserless suite. This is the same class of
   weakness the Model News migration found in its `plansource` fixture.

## 6. Regression parity

Each replacement was proved against a deliberately broken product before the
browser assertion was deleted. Every mutation was applied to
`desktop/plugin.js`, the replacement test was run alone, the file was restored
(SHA-256 verified, `d01f8807…`) and the test was run again.

| Control | Regression injected | Detected |
| --- | --- | --- |
| M1 | an unreadable route takes the "no reading from Hermes" words | yes |
| M2 | the Chinese limitation collapses into the no-reading label | yes |
| M3 | an unknown fee is printed as a catalogue price of zero | yes |
| M4 | two attention reasons are reported as nothing to do | yes |
| M5 | every account is filed under Paid subscriptions | yes |
| M6 | the backend messages lose the technical-details hook | yes |
| M7 | an open group no longer turns its chevron | yes |

7/7 failed with the regression present and passed on the restored source.

**Limitation, recorded deliberately:** the faithful version of M6 — moving the
backend-notes block out of the disclosure — is not usable as a control in this
harness: that mutation makes the jsdom page consume memory without bound and the
runner is OOM-killed before it can report (observed twice, and reproduced in
isolation). M6 therefore controls the containment *hook*; the visibility half of
the rule stays measured by Chromium (`rawNotesInNormalView`), which is unchanged
by this PR.

## 7. Measurements

One file at a time on the Hermes VPS with nothing else running, Node v24.22.3,
`/usr/bin/google-chrome`. Launch counts are measured with the `execFileSync`
wrapper, not estimated.

| Suite | Launches before | after | Wall before | after |
| --- | --- | --- | --- | --- |
| `memberships-cards` | 2 | 2 | 8.1 s | 16.2 s |
| `memberships-clarity` | 2 | 2 | 12.0 s | 7.9 s |
| `memberships-disclosure` | 2 | 2 | 9.9 s | 7.4 s |
| `memberships-layout` | 1 | 1 | 6.2 s | 4.3 s |
| `memberships-polish` | 1 | 1 | 4.6 s | 6.5 s |
| `memberships-visibility` | 1 | 1 | 4.4 s | 3.8 s |
| **Total** | **9** | **9** | **45.2 s** | **46.1 s** |

| Metric | Before | After |
| --- | --- | --- |
| Memberships Chromium cases | 6 | 6 |
| Browserless cases | 802 across 27 files | 809 across 28 files |
| New browserless suite | — | 7 cases, 8.3 s |
| Browserless wall clock | 97.1 s | 96.9 s |

(The browserless total moved from 97.1 s to 96.9 s while gaining seven cases:
another run-to-run difference, not a saving.)

**The honest conclusion: there is no launch or wall-clock saving here, and this
PR does not claim one.** Both states make nine launches and take about 46
seconds, because every one of the six files still needs a browser for geometry;
the per-file differences are run-to-run noise (one file 8 s slower, four
faster), not a treatment effect. What changed is *where the assertions run*: the
reading vocabulary, the summary contract, the grouping rules and the stylesheet
contracts now fail in the browserless job in about a second, and the Chromium
files no longer duplicate them eight times over.

## 7.1 What would actually reduce launches

Three of the six files launch twice, once per locale, because each page is built
with `__LOCALE__` substituted at bundle time. Rendering both locales in one page
would cut three launches (9 → 6) — the only remaining launch lever in these
suites short of browser/process reuse (Stage 2's territory). It is a rewrite of
three page fixtures and their probes, so it belongs in its own PR with its own
review; it is recommended in §9, not smuggled in here.

## 8. Risks and limitations

- **No launch reduction is claimed or possible here.** All six files still need
  a browser for the geometry they measure; nine launches before, nine after.
  The gain is where the assertions run: a vocabulary or copy regression now
  fails in the browserless job in about a second, instead of in a Chromium run
  after a bundle, a Chrome start and a virtual-time budget.
- **jsdom is not Chromium.** The moved assertions prove the DOM the component
  produces, not that a browser paints it. Visibility stays in the Chromium
  suites (`rawNotesInNormalView`, closed-content geometry, focus).
- **Two renderers, one payload.** The shared fixture module is the only thing
  keeping the browser and browserless accounts identical; a change that edits
  one renderer's copy of the data is no longer possible, but a change to the
  *shape* of the fixture affects both suites at once.

## 9. Next targets (recommended, not implemented)

1. **Overview, Usage, Costs and Settings** — the same treatment: move financial
   semantics, ordering and persistence assertions to the existing component
   suites; retain responsive layout, overflow, scrolling and interaction.
2. **The cost of the locale split.** `cards`, `clarity` and `disclosure` each
   launch twice because the page is built once per locale. One page that
   renders both locales would cut three launches (9 → 6) without combining
   files, but it is a page-and-probe rewrite in three fixtures: a separate PR
   with its own review, not a rider on this one.
3. **Reports and Sidebar** — preserve the Stage 2 lifecycle; only genuinely
   data-only assertions should move.
