# Spend Sense — UX redesign: design proposal (Phase A)

> Retained in-repo as the Phase A visual reference (PR-A). Layout breakpoints in
> the HTML references and in production use **container queries** on the plugin
> root, not viewport media queries, so the Hermes pane width — not the browser
> window — drives the narrow layout. `[hidden]` is enforced with
> `display:none!important` so certainty chips can never leak through a
> `display:inline-flex` rule.

Status: **for review — no production UI changed, no PR, no backend change.**
Source of requirements: GitHub issue #13 (visual UAT, 1 Nov 2026). Built from `main` @ PR14 merged (`3333017`).
References: [Overview](overview.html) · [Memberships](memberships.html) — open either file directly in a browser. All figures in both are **synthetic**.

This is one recommended direction, not three options. It keeps the six tabs
(`Overview · Usage · Costs · Memberships · Reports · Settings & About`), the Hermes host
theme, and every financial distinction the backend already makes. It changes
presentation and disclosure only.

---

## 1. Direction in one paragraph

A quiet, dark, ledger-like dashboard where usage *recorded and priced at capture*,
usage *estimated* at current API rates, and fees you *declared* never share a visual
voice. None of the three is presented as a provider bill or proof of payment. Blue is
the only action colour; teal means "covered / ahead"; violet is brand and secondary
emphasis (never a second action colour); amber means "look here"; red is errors only.
Everything explanatory moves behind a disclosure or an opaque tooltip, so the default
view answers three questions in under a minute: *what did I use, what was it
priced at, and what needs me?*

The memorable element is deliberately small: the WolfMark marque gradient
(`#2563EB → #813CF8`, already in `BrandMark`) appears in the marque only.
Primary actions are solid host blue; violet never becomes a second action colour.
Everything around it stays flat, bordered, and tabular. No gradient washes, no
tinted cards, no neon.

## 2. What is wrong today (from the code, not opinion)

| Surface | Current behaviour | Cost to the user |
| --- | --- | --- |
| Overview (`OverviewPage`) | 4 equal stat boxes, each with a full sentence of methodology under the number; "Needs attention" is a plain `<ul>` of strings; fallback copy repeats the tab guide twice | First impression is four paragraphs. Attention items do not say what to *do* or take you to the field. |
| Memberships (`MembershipCard`) | Every account renders fully expanded: arrangement, plan, fee form, custom-plan form, quota rows, weather, exhaustion forms — all open at once | A wall. Configuring one account means scrolling past every other account's forms. |
| Memberships header | 4 oversized stat cells (`Accounts / Plans confirmed / Marked exhausted / Your declared fees`) | Totals dominate the screen they should summarise. |
| `API Only` | Bare checkbox + one-line note | Users cannot tell it means "no recurring fee; usage still tracked". |
| Tooltips (`wm-info-pop`) | Transparent-adjacent fill, variable width | Issue #13: fix opacity/readability; never the sole home of essential info. |
| Certainty language | `≈` repeated; `—` used for both "zero" and "unknown" | An unavailable value can read as a true zero. |

## 3. Design tokens

Host variables stay authoritative. The proposal only *names roles* and adds two
brand constants the code already has. Nothing here requires a new dependency or a
backend value.

### 3.1 Colour roles

| Role | Token | Use | Never |
| --- | --- | --- | --- |
| Action / focus | `--ui-accent` (host blue; brand start `#2563EB`) | Primary button, links, focus ring, selected tab underline | Decorative fills, chart rainbow |
| Brand | `#813CF8` (existing gradient end) | Marque only; secondary emphasis text sparingly | Buttons, status |
| Positive / covered | `--ui-success` / teal `#2DD4BF` at low alpha | "Covered", "On track", value ≥ fees | Money you owe |
| Attention / uncertainty | `--ui-warning` (amber) | Needs-attention dot, `Partial`, `Lower bound`, stale | Errors |
| Error | host error red | Failed save, unreadable store | Attention |
| Text | `--ui-text-primary / -secondary / -tertiary / -quaternary` | Hierarchy in that order | Colour-coding money by hue |
| Surface | `--ui-fill-primary / -secondary / -tertiary`, `--ui-stroke-secondary` | Flat bordered cards; no shadows except tooltip | Gradient cards, tinted KPI rainbow |

Rule: **certainty is carried by a word, not a colour.** Colour supports the word;
it never replaces it (see §5).

### 3.2 Type scale (host sans, `tabular-nums` for all money/counts)

| Style | Size / weight | Use |
| --- | --- | --- |
| Display | 22px / 640, −0.35px | Screen title only (`Overview`) |
| KPI figure | 20px / 620 | Card value; one per card |
| Section | 14px / 600 | `Needs attention`, card group titles |
| Body | 13px / 400, 1.5 lh | Rows, descriptions |
| Caption | 11.5px / 400, tertiary | Time base, provenance, collapsed hints |
| Micro-label | 11px / 600, tertiary (sentence case) | Card eyebrow: `Recorded usage · 1–18 May` — *not* all-caps eyebrows everywhere |

Sentence case throughout. No tracked-out all-caps labels except the existing
sidebar card titles, which stay untouched in Phase A.

### 3.3 Space, shape, motion

- Spacing scale `4 · 8 · 12 · 16 · 24`. Card padding `14px 16px`; row padding `10px 12px`.
- Radius: `8px` cards, `6px` controls, `99px` chips. One radius family, no per-card invention.
- Border-first: `1px solid var(--ui-stroke-secondary)`. Elevation only on tooltips/popovers (`0 6px 20px rgba(0,0,0,.35)`, opaque `--ui-fill-secondary` background).
- Motion: 150ms ease on hover/expand only; `prefers-reduced-motion` disables it. Expand/collapse is the only animated state change.
- Focus: `2px solid var(--ui-accent)`, `2px` offset, on `:focus-visible` everywhere. Hover, focus, pressed (`aria-pressed` / active tab inset underline) are all visually distinct.

### 3.4 Layout

- Shell `max-width: 1180px`, padding `24px 22px` (existing). Tab bar is `position: sticky`, fixed height, so switching tabs never shifts content vertically.
- KPI row: `repeat(auto-fit, minmax(200px, 1fr))`. At narrow widths it becomes 2-up, then 1-up — never squeezed 4-across (see §7).
- Memberships list: single column of compact rows. Expanded detail opens *inside* the row; list order never changes on save.

## 4. Component system (Phase A scope)

Eight components cover both reference screens. Everything else in the app reuses them in Phase B.

| # | Component | Replaces / formalises | Key states |
| --- | --- | --- | --- |
| C1 | `AppHeader` + `TabBar` | `LedgerTabs` + per-page `<h1>` | Active tab (underline + weight), brand marque 20px, one-line purpose |
| C2 | `KpiCard` | `wm-product-stat` | `value / unknown / partial / loading / error`; eyebrow carries certainty + time base |
| C3 | `AttentionRow` | `wm-overview-attention` `<li>` strings | Amber dot, account, one-line reason, single action button that jumps + highlights |
| C4 | `CertaintyChip` | ad-hoc `≈`, `—`, `wm-chip` text | `Estimated · Partial · Not recorded · Unknown · Lower bound · Declared` (see §5) |
| C5 | `MembershipRow` (collapsed) | always-expanded `MembershipCard` header | Identity, arrangement, plan, fee, allowance state, status, `Details` toggle |
| C6 | `DetailGroups` (expanded) | inline forms in `MembershipCard` | Three groups: Plan & billing / Allowances & readings / Advanced & diagnostics |
| C7 | `InfoTip` | `wm-info-pop` | Opaque, `role="tooltip"`, keyboard-dismissible (Esc), focus returns to trigger |
| C8 | `AsyncButton` | `ProductButton` + busy flags | `idle → pending (disabled, spinner text) → success/error inline`; duplicate clicks blocked |

Form controls, selects, and the fee/custom-plan/exhaustion forms themselves do not
change behaviour — they move inside C6 groups, collapsed by default.

## 5. Financial accuracy — presentation contract (non-negotiable)

These rules are the design. If a nicer layout would break one, the layout loses.

1. **Three kinds, three labels, never merged — and none is a bill.**
   Recorded usage priced at capture (`Recorded usage`), API-equivalent
   (`Estimated`), declared fees (`Declared`). **Recorded is not actual billing:**
   the Desktop ledger prices usage at the rates captured when it was recorded;
   it does not show what a provider invoiced or what you paid. The words
   *actual*, *paid*, *charged* and *bill* are not used for it anywhere. A card
   states its kind in the eyebrow; two kinds never share a card.
2. **Every figure carries its time base.** `May so far`, `Trailing 30 days`,
   `Monthly equivalent`. Monthly and trailing-30-day figures are never placed in one
   total or one comparison without both bases printed.
3. **Unknown is not zero.** Unknown renders as the word `Unknown` (or `Not recorded`),
   never `—` next to a currency and never `£0`. `—` is reserved for "not applicable".
4. **Partial stays partial.** If any token is unpriced, the total is labelled
   `Partial` / `Lower bound` and the unpriced count is one click away — not a footnote
   in 10px grey.
5. **Currencies never combine.** Fees by currency stay separate lines
   (`£160/mo + $20/mo`). No FX conversion without a dated rate the user supplied.
6. **Value vs fees only where defensible.** The comparison appears only when usage
   and fees share a window and currency basis; otherwise the card shows *why* no
   comparison is offered instead of a number.
7. **`≈` is retired where a word does the job.** `Estimated` replaces most `≈`;
   `≈` survives only inside dense tables where a word would break alignment, and
   always with the word in the accessible label.
8. **Routes are grouped only when entitlement ownership is known.** A route is
   shown under an account only when the backend entitlement data says that
   account owns it (e.g. a plan's `route_slugs`). A route slug such as
   `commandcode-anthropic` is **not** assumed to belong to an Anthropic
   subscription: with ownership unconfirmed it is listed separately as
   `Route seen — owner not confirmed`, carries no fee, and is never grouped or
   totalled. When ownership *is* known, the fee is counted once, on the owning
   account, and the route row says so.
9. **Historical vs current rates stay distinct.** Recorded usage (rates at
   record time) and backend API-equivalent (current catalogue) keep separate
   cards and separate provenance lines, exactly as the backend provides them.

en/zh parity: every new string goes through the existing `t()` catalogue; chip
labels are translated, not hard-coded English.

## 6. The two reference screens

### 6.1 Overview — flagship

Reading order (top → bottom), designed for a 60-second first read:

1. **Header:** marque + `Spend Sense` + one sentence — *"What you used, what it
   was priced at, and the fees you declared — recorded locally."* No paragraph.
2. **Four KPI cards** (C2), each: eyebrow (kind + time base) → figure → one-line
   provenance → certainty chip where needed. Windows are printed, not implied:
   - `Recorded usage, priced at capture · 1–18 May` — Desktop ledger, priced when
     recorded. Explicitly *not* a bill or proof of payment.
   - `Estimated · 19 Apr – 18 May (30 days)` — API-equivalent at current catalogue,
     `Partial` when unpriced tokens exist.
   - `Declared · Monthly equivalent` — fees by currency, separate lines.
   - `Subscription value · 19 Apr – 18 May` — kept (decision), shown only with its
     fee basis; when no defensible comparison exists it shows the honest
     unavailable state and the reason (see §6.1 note), never an invented ratio.
3. **Needs attention** (C3): max 3 rows visible, each *account → reason → action*.
   The action switches tab and highlights the target field (amber outline pulse,
   removed on interaction). When empty, one line + routes onward — not a paragraph.
4. **Go to** row: three obvious routes (Usage / Costs / Memberships) as secondary
   buttons. Methodology lives behind a single `How these figures are calculated`
   disclosure at the foot — present, findable, and out of the default view.

What was *removed* from the default view: per-card methodology sentences, the
duplicated tab-guide paragraph, and the raw unpriced-token sentence (now the
`Partial` chip + tooltip + Usage link).

### 6.2 Memberships — interaction reference

1. **Compact summary strip** replaces the four oversized cells: one bordered bar,
   four inline stats separated by hairlines (`6 accounts · 3 plans confirmed ·
   1 exhausted · Declared £160/mo + $20/mo` — the reconciled synthetic set in
   Appendix A). Same data as `membershipSummary()`, a third of the height.
2. **Needs attention** (C3, shared with Overview): clicking a row expands and
   highlights the exact card + field group. The existing "needs attention only"
   filter stays, as a chip toggle.
3. **Compact rows** (C5), one line of identity at desktop width:
   `Anthropic · Subscription · Claude Max 20x · £160/mo declared · On track · [Details]`.
   Status is a chip; anything needing action gets an amber dot.
   - **Billing type is a segmented control, not a mystery checkbox.** The four
     arrangements read as labelled options — `Subscription / Prepaid credits /
     Metered API (pay-as-you-go) / Not confirmed`. **Decided: Metered API is a
     display-only label** over the existing `api_only` semantics. Storage
     (`api_only`, `billing_arrangement`) is untouched; no fifth arrangement.
   - `None` plan renders as `No plan confirmed` + chip `Unknown` — never the literal
     string `None`.
   - **Plan names come from the actual catalogue** (`catalogue/plans.json`,
     v2026-10-31.1): `Claude Max 20x`, `ChatGPT Plus`, `Nous Portal`,
     `SuperGrok`. No invented plan names.
   - Routes with unconfirmed ownership (`commandcode-anthropic`) appear in a
     separate *Routes seen* list — `owner not confirmed · no fee counted` —
     never nested under a provider account (see §5 rule 8).
4. **Expanded detail** (C6) — three collapsed-by-default groups:
   - *Plan & billing:* plan select, effective fee, fee edit form, catalogue-vs-declared provenance.
   - *Allowances & readings:* quota windows, allowance weather, mark-exhausted actions.
   - *Advanced & diagnostics:* custom plan, credential source, request diagnostics link, account IDs.
   Explanatory/provenance text lives inside these groups, collapsed. Save shows
   pending → success/error *next to the button that was pressed* (C8), and the row
   order is stable after save (already guaranteed by PR #11; the design must not
   re-sort).

## 7. Narrow Hermes panes (the constraint that shapes everything)

Hermes Desktop panes are often ~360–480px wide. The references are built and
checked at **1100px (full ledger), 720px, and 380px (pane)**.

| Width | Overview | Memberships |
| --- | --- | --- |
| ≥900px | KPI 4-across; attention rows single-line | Row = one line; detail groups 2-col forms |
| 560–900px | KPI 2×2 | Row wraps fee/status to second line; forms 1-col |
| <560px (pane) | Attention strip first (below), then KPI 1-col; tab bar scrolls horizontally with active tab scrolled into view | Row stacks: identity / fee+status / Details full-width tap target (min 38px); summary strip wraps to 2×2; expanded groups full-width |

Compromises, stated plainly:

- **Overview at 380px shows a compact Needs-attention strip immediately under the
  title** (`3 need attention — Review ↓`), before the KPI cards. Without it the
  four stacked cards buried attention below the fold; with it attention is
  discoverable in the first screenful while every figure and certainty word
  stays fully visible in the cards below.
- At pane width the KPI cards lose their provenance sentence to the tooltip +
  disclosure; the *certainty word and time base never* collapse away.
- The tab bar scrolls horizontally below 560px rather than shrinking labels —
  six readable tabs beat six cramped ones. No layout jump: bar height is fixed.
- Membership rows at pane width are ~3 lines tall. That is the floor for keeping
  fee, period, and status simultaneously visible; going denser would hide the fee
  or the status, and both are load-bearing.

## 8. Accessibility (checked against the references, not just claimed)

Measured on the prototype fallback tokens (production uses host tokens and must
be re-measured there):

- Contrast (WCAG AA, 4.5:1 normal text): primary 16.2:1, secondary 9.9:1,
  tertiary 8.4:1, quaternary 6.5:1 on `--ui-fill-primary`. The earlier
  quaternary (`#62677e`, 3.3:1) **failed** and was lightened; primary-button
  white on `--ui-accent` (3.7:1) **failed** and the button now uses a darker
  blue (5.7:1). Amber is never body text — dots/chips always carry a text label.
- Tooltips (C7): opaque background, `role="tooltip"`, `aria-describedby` +
  `aria-expanded` on the trigger, open on hover *and* focus, close on `Esc`
  (focus returns to the trigger), on outside click, and on pointer-leave only
  when not focus-pinned. Never the sole home of essential information.
- Keyboard: tab bar is a real tablist pattern — roving `tabindex`, `←`/`→`,
  `Home`/`End` (matching production `LedgerTabs`). Expand/collapse and group
  toggles are native `<button aria-expanded aria-controls>`; the billing-type
  segmented control is tabbable buttons with `aria-pressed`. Attention jumps
  move focus to the target card and respect `prefers-reduced-motion`.
- Async buttons disable during flight and announce outcome via `role="status"`
  adjacent to the control (existing membership notice pattern, kept).
- Control sizes (measured in the references): tabs 38px, primary/secondary
  buttons 34–38px, `Details`/group headers 36–38px, filter chips 32px → 38px
  at pane width, info buttons 32×32px hit area. No target below 32px; pane-width
  row actions are full-width ≥38px.

## 9. Decisions (settled in this revision)

1. **Metered API is display-only**, using the existing `api_only` semantics. No
   stored fifth arrangement, no backend change.
2. **Nous/xAI plan names come from the actual catalogue**
   (`catalogue/plans.json` v2026-10-31.1): Nous offers `Nous Free / Plus /
   Super / Ultra` and the unpriced `Nous Portal`; xAI (family `xai-oauth`)
   offers the unpriced `SuperGrok`. The references use `Nous Portal` for the
   unpriced-fee case and leave xAI unconfirmed (no plan selected).
3. **The subscription comparison card is kept**, with an honest unavailable
   state when no defensible comparison exists (no shared currency/window, or
   fees unknown). The Overview reference previews both states on the card.
4. **Memberships refresh copy (retained for PR-C/D):** rename `Refresh
   readings` to `Refresh provider usage` and explain that it checks
   provider-reported usage and allowance information where supported. Display
   copy only — the underlying refresh behaviour is unchanged.

Remaining open item: none for Phase A. (Issue #12 backend compatibility remains
a separate pre-release gate, unchanged.)

## 10. Recommended implementation sequence (after approval)

Focused PRs, each independently reviewable, each with automated regression tests
*and* a real Desktop visual check. No auto-merge. Issue #12 (backend compatibility
detection) remains a separate pre-release gate.

| Step | Scope | Risk |
| --- | --- | --- |
| PR-A | Tokens + C1 TabBar/header + C7 InfoTip + C8 AsyncButton primitives in `desktop/plugin.js`; no page changes | Low — additive CSS/components |
| PR-B | Overview rebuilt on C2/C3; copy diet; disclosure for methodology | Medium — copy + i18n (en/zh) |
| PR-C | Memberships summary strip + C5 collapsed rows; detail moved into C6 groups (no logic change) | Medium — largest structural change; keep all `data-*` hooks and identity/busy logic identical |
| PR-D | Memberships detail groups polish: segmented billing control (display), field highlight on attention jump, save-state placement | Medium |
| PR-E+ | Phase B rollout to Sidebar, Usage, Costs, Reports, Settings per issue #13 | Per-surface |

Estimated effort: PR-A ~0.5 day, PR-B ~1 day, PR-C ~1.5–2 days, PR-D ~1 day,
plus Desktop visual UAT per PR. Backend: zero changes in Phase A.

## Appendix A — Reconciled synthetic dataset (single source for both screens)

Synthetic “today” is **18 May 2026**. Shared figures appear identically in
`overview.html` and `memberships.html`; the subscription comparison row is
rendered on Overview only (Memberships carries the underlying declared fees).
Source currencies are preserved; nothing is converted.

| Item | Value | Basis |
| --- | --- | --- |
| Recorded usage, priced at capture | $24.60 | Desktop ledger, 1–18 May 2026. Not a bill. |
| API-equivalent (backend) | $47.90, lower bound | 19 Apr – 18 May 2026 (30 days), current catalogue |
| Unpriced tokens | 18,240 | Same 30 days → totals are Partial |
| Accounts | 6 | Anthropic, OpenAI (Codex), Nous, xAI, Google, OpenRouter |
| Plans confirmed | 3 of 6 | Anthropic, OpenAI, Nous (Portal). Google prepaid and OpenRouter metered are excluded by definition; xAI has none |
| Marked exhausted | 1 | OpenAI (manual mark, reconfirm due) |
| Anthropic | Claude Max 20x, catalogue $200/mo; declared £160/mo, renews 12 Jun 2026 | Fee counted: £160/mo |
| OpenAI (openai-codex) | ChatGPT Plus; declared $20/mo (synthetic). Catalogue price is also $20/mo and is kept separate | Fee counted: $20/mo **declared** (never the catalogue price) |
| Nous | Nous Portal, catalogue unpriced | Fee: Unknown, excluded from totals (never $0) |
| xAI (xai-oauth) | No plan confirmed (catalogue offers SuperGrok, unpriced) | Fee: Unknown |
| Google | Prepaid credits | No recurring fee |
| OpenRouter | Metered API (display label for API Only) | No recurring fee |
| Declared fees total | £160/mo + $20/mo | By currency, never combined |
| Subscription comparison (defensible subset, Overview only) | Usage $28.40 vs declared fees $20.00 → +$8.40 covered, Partial | USD subscription accounts only (OpenAI), usage 19 Apr – 18 May. **Fee-window basis: one monthly declared fee ($20) allocated to this 30-day window — a monthly-equivalent allocation, labelled on the card. No daily pro-rata is invented, and monthly totals are never mixed into the 30-day usage figure itself** |
| Not compared | Anthropic £160/mo; Nous fee unknown | No GBP/USD rate supplied; fee unknown. Stated on the card, not hidden |
| Route seen | `commandcode-anthropic` — owner not confirmed | No fee, not grouped under any account |
| Needs attention | Memberships: 3 (xAI, Nous, OpenAI). Overview: 3 (xAI, Nous, plus unpriced-pricing) | Same count, different composition — Overview adds the pricing-coverage item, as production does |

Earlier drafts disagreed (£45 vs £160, $20 vs $220, 4 vs 3 plans, “Plus
(synthetic)” plan names, a Command Code route nested under Anthropic). All are
corrected to this table.

## 11. What approval means

Approving this document approves: the colour/type/spacing roles in §3, the eight
components in §4, the accuracy contract in §5, and the two layouts as the visual
target. It does **not** authorise implementation — that starts only on your explicit
go-ahead, beginning with PR-A.
