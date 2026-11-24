# WP31 decision briefs — evidence warnings and comparison meaning

Status: APPROVED by Mark, 24 Nov 2026. Final product decisions for this
scope; no further approval needed for the associated implementation or
wording details.
Scope per tracker: F19, F23, F110, F116, F117. F109 warning policy already
moved to WP48; these five still need separate decisions.

## F110 — what `call_failed` means (traced in current source)

**Finding.** A Costs log says an account "has an unresolved comparison
blocker (call_failed)". Mark asked whether any usage was missed.

**Trace, end to end:**
- Origin: the provider call itself failed. `collector.py` sets
  `outcome="error"` when Hermes reports an API error (`_api_request_error`)
  or an auxiliary call returns `error`. This is a failed LLM call, not a
  SpendSense capture failure — the record IS captured, including any usage
  the provider reported for the failed attempt.
- Propagation: `aggregate.py` maps `outcome == "error"` to `_failure`, which
  overrides the pricing miss reason to `"call_failed"`.
- Effects:
  - Captured calls/tokens: NOT impacted. The failed call's tokens stay in
    the gross usage totals; failures only increment a separate counter.
  - Pricing: the call is left unpriced (never priced, never treated as free).
  - Subscription comparison: `analytics.py` excludes failed calls from the
    value-vs-fee comparison and surfaces the "unresolved comparison blocker"
    wording.
  - Custom rate overrides: failed rows are ineligible (`billing.py`).

**Answer to Mark's question:** no usage was missed. The user impact is that
the API-equivalent value is conservatively understated by whatever the
failed call would have cost, and the comparison carries an "unresolved" flag.

**Decision:** APPROVED. The provider call failed; its captured usage
remains counted, but its API-equivalent value cannot be priced. Neutral and
informational, not under Needs attention.

## F116 — paid subscription with zero observed usage (verdict policy)

**Finding (WP29 U7/R5).** Zero observed usage on a paid account contributes
a full-fee negative (observed: -$48.53) to the value-minus-fee total. The
arithmetic is correct for observed usage, but it cannot establish complete
observation or a real financial loss — presenting it as a loss is misleading
when coverage may be incomplete. The export now identifies the account and
scope.

**Options:**
1. Keep the full-fee negative always (current behaviour).
2. Show it only when usage coverage for the account is verified complete.
3. Show the figure but withhold the verdict: label it a theoretical
   comparison on observed usage, never a realised loss, when coverage is
   incomplete.

**Decision:** option 3 APPROVED. Retain the theoretical observed-use
comparison, but no negative result presented as an actual financial loss
and no definitive value verdict when coverage is incomplete. The declared
fee stays visible, hypothetical value stays separate from cash spend, and
no absent usage is silently coerced to zero.

## F117 — stale FX driving comparisons (freshness policy)

**Finding (WP29 U8).** A dated but disclosed FX rate can drive a
value-versus-fee conclusion no matter how old it is. Current behaviour
(`digest.py`): a rate predating the reporting window gets a "rate predates
this window" note, but the comparison still runs. Missing FX correctly
blocks the comparison; old FX does not.

**Decision needed:** a maximum-age threshold for an accepted rate, and what
happens past it — withhold the strong comparable verdict, or keep the
verdict with the dated-source limitation made prominent.

**Decision:** APPROVED with a maximum FX age of 30 calendar days,
measured against the comparison's valuation date. Older rates may still
produce an indicative converted figure with rate date/source visible, but
must not support a definitive worth-it/not-worth-it verdict. Never invent
a replacement rate.

## F19 / F23 — Subscription value placement and actionability

**Finding.** Overview Subscription value shows Unavailable with a generic
explanation (F19); Costs comparison failures show Unavailable with text but
no direct action (F23). Fail-closed headlines are intentional and stay.

**Decisions needed:**
1. Does Subscription value belong in Costs alone, or stay on both Overview
   and Costs?
2. Approve precise per-account/per-group blockers with links to the fix
   (missing rate, missing fee, incomplete coverage) in place of the generic
   text — without mixing unconverted currencies.

**Decision:** APPROVED. Subscription value stays on both Overview and
Costs. Overview provides the concise headline and links to Costs; Costs
explains the specific blockers and provides direct links to relevant fixes
where available. Fail-closed behaviour and currency separation preserved.
