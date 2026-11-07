# Budget guardrails

Budget limits are advisory. They cannot interrupt Hermes calls and do not send
notifications outside the application. Configure them in **Settings & About**;
Overview shows a compact summary and Costs shows evidence and forecasts.

## Measurements

Every monthly limit selects exactly one measurement:

- **Actual metered spending** requires explicit timestamped charges. The current
  Hermes observer hooks and SpendSense call store do not supply these. These
  limits therefore report unavailable for recorded activity; no invoice is
  inferred from session totals, route classifications or published prices.
- **Estimated usage value** uses the same strict per-call catalogue pricing as
  analytics. It includes subscription usage as a theoretical usage value, never
  as a subscription payment, allowance deduction, guaranteed saving or invoice.

Both modes support all usage, an exact provider route, or an exact model × route
pair. Limits are independent comparisons; overlapping limits are never added.
Amounts support the existing membership currencies. USD is native; other
currencies require a dated, owner-supplied FX rate from Costs, cited in the result.
Future-dated or unreadable rates cannot establish a comparison.

Missing, failed or unpriced usage is unknown. A partial amount is a known subtotal
and carries `+` and coverage. It can establish that a threshold has already been
reached, but cannot establish that total usage is within a limit. Remaining budget
and forecasts are withheld where the current cycle is incomplete.

## Session and status bar

A separate USD **session / conversation estimated usage-value** limit colours
only the amount: default normal styling, amber at the warning threshold, red at
100%. The tooltip gives the selected scope, measurement, amount, percentage,
limit and state. The monthly indicator is separate and lists its applicable
limits in its tooltip. Text labels and accessible names supplement colour.

The existing cost amount can be gateway-reported, catalogue-derived or mixed.
It is not reliably an actual charge or a pure catalogue estimate. With a session
limit configured, the chip therefore displays a separately settled catalogue
estimate (`≈`) rather than comparing that ambiguous amount. Without a session
limit the existing amount is retained. No billed figure enters this new tally.

The estimate settles each token delta at its recorded route/model rate. Unknown
routes, cross-provider fallbacks and missing required prices remain uncovered.
Cache reads and writes require their own explicit price; a documented zero price
is supported, but an input-rate fallback is not measurement evidence. Live,
remembered, backend and bundled rates retain this distinction and explicit tier
metadata. Session deltas with unresolved context tiers remain uncovered, including
output-only deltas. Monthly guardrails use the applicable per-call tier, including
discounts, and validate cache prices against that same effective rate (with
explicit base-price inheritance where the tier omits a field). They do not use
the legacy analytics upper bound as an exact amount. Conflicting recorded prompt
or total counters leave the call incomplete rather than selecting a tier.
Monthly guardrails still exclude calls requiring a cache-price fallback.

A call that advances the call counter without complete token usage remains a
coverage gap even when the token subtotal is unchanged. A later complete reading
can fill the current pending call's gap, but later calls or runtime restarts
cannot erase earlier gaps. Coalesced multi-call deltas cannot prove each call’s
usage or model price and remain uncovered; later individually supported calls
still contribute. Known, explicitly priced subtotals can still establish a crossed threshold; incomplete sessions never say Within limit.

The version-2 tally requires these usage and pricing provenance checks. Earlier
experimental tallies and remembered rates without that evidence cannot establish
coverage or warnings; their activity remains uncovered rather than being
retroactively repriced. The ordinary usage ledger and its existing cost figures
are retained. The tally follows the current run or durable conversation scope
already selected by Live, and is isolated by connection and owning profile. The
five fixed Live sections are unchanged.

With no monthly budgets, status reads return configuration without opening or
pricing the usage ledger; session-only limits work independently.

Session colours react to local usage changes. Monthly reads poll every 15 seconds
and activity invalidation is coalesced to at most once per two seconds. A failed
refresh preserves the displayed snapshot and neutralises warning colours until
successful refresh; data from another connection or activation is never adopted.

## Cycles and forecasts

Each monthly limit has a reset day and named IANA timezone. Boundaries are
half-open and resolved independently in that timezone, including DST. Reset days
29–31 clamp to each month's last day. Budget cycles are independent of subscription
renewals and never allocate subscription fees.

Burn rates use the last 7 and 30 local calendar days including today, clipped to
the known observation start. Averages include inactive observed days and prorate
partial calendar days. They are based on recorded activity, not presumed future
calls. Each burn sample requires at least three active days and 100% measurement
and pricing coverage. The observation start is the collector baseline, or the
first known call where a baseline is absent. A cycle starting before observation
is incomplete. A readable empty ledger reports insufficient active days; a
missing or unreadable ledger reports unavailable data. Collector retention is
180 days, exceeding the monthly samples.

Cycle-end projection uses the 30-day rate and remaining local calendar days.
Runway is the remaining limit divided by that rate. A projected breach date is
shown only within the current cycle, at date precision. The comparison of the
7-day and 30-day rates labels acceleration above 10%, slowing below −10%, and
steady between them; it is omitted when either sample is insufficient.

## Persistence and API

`budgets.json` lives beside the profile's billing configuration. Version 1 contains
`budgets` and bounded per-budget `dismissals`. All mutations acquire the existing
cross-process file lock, check the whole-document revision, fsync a temporary file
and atomically replace the document, then sync the parent directory where supported.
If that final sync fails, the API reports an uncertain write because the replacement
may already be visible. An unreadable or unsupported document fails closed and is
never implicitly replaced. No usage ledger migration is required.
The additive desktop tally is compatible with older readers; after downgrade and
subsequent usage, its token coverage must be checked before applying a limit.

- `GET /budgets`: configuration, dismissals and revision.
- `GET /budgets/status` or `GET /forecast`: configuration plus monthly status,
  forecasts, coverage, generation time and charge-adapter capability.
- `PUT /budgets/{id}?if_rev=…`: create or replace a fully specified limit.
- `DELETE /budgets/{id}?if_rev=…`: remove a limit.
- `POST /budgets/{id}/dismiss?if_rev=…`: persist `cycle`, `budget_rev`, and `level`.

Mutations return 409 for revision conflict, 422 for invalid input, 404 for a
missing limit and 503 for unreadable/unavailable storage. New configuration
requires the revision from an empty `GET` as well. Editing a limit clears its
dismissal. Dismissals apply only to that configuration and cycle; a higher
threshold reappears. They suppress the local alert, never the status indicator.

Recovery exports include limits and dismissals. Explicit user-data reset clears
these alongside memberships and advanced rules under the shared reset/rollback
contract; usage, provider credentials and Hermes profiles remain untouched.

## Compatibility and release boundary

No dependencies, production profiles, existing `ssuat` fixtures, VPS resources,
release versions, feed operations or PR #31 are changed. This is a feature PR,
not a release or installation. Release validation still requires the isolated
Desktop/backend lifecycle matrix in `RELEASING.md` before production adoption.
A future actual-charge adapter needs per-attempt amount, currency, timestamp and
provenance, correlated without duplicate accounting; cumulative session costs
must not be allocated to fabricate that evidence.
