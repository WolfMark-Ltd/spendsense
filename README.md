# Spend Sense

**What you pay. What you use. What it's worth.**

Spend Sense is a Hermes plugin that shows what your AI usage is actually
costing you. It records usage locally, prices it against published rates, and
keeps your subscription plans, prepaid wallets and API routes in one place —
so you can see what you used, what your plan covered, and what the same work
would have cost pay-as-you-go.

> **Project status: development-stage candidate.** Spend Sense is not yet a
> supported public release. There is no validated public install or upgrade
> procedure yet. Only try it on an isolated Hermes profile, with a backup of
> your plugin data. See [RELEASING.md](RELEASING.md) for what still has to be
> verified before a release.

## The problem

If you use more than one AI provider, the true cost of your usage is spread
across places that never meet:

- A fixed subscription fee in one app.
- A prepaid balance or allowance in another.
- Pay-as-you-go API charges on a route you only use occasionally.
- Token counts inside Hermes that carry no price at all.

Provider dashboards show their own slice, after the fact. None of them answer
the questions that matter while you work:

- What did this session cost — or what would it have cost at API rates?
- Is my subscription actually covering my usage, or am I paying for headroom
  I never use?
- Which model and route is eating my budget?
- Is prompt caching saving me money, or costing me a write premium?

Spend Sense answers those from the usage Hermes already sees, on your own
machine, without sending your usage anywhere.

## What Spend Sense does

- **Live session view.** A Desktop chip and pane for the focused session:
  input, output, cache and total tokens, call counts, context use, the
  current provider and model rates, cache hit rate and estimated cache
  savings.
- **A recorded ledger.** Eligible backend calls are timestamped and stored
  locally as they happen, so usage history does not depend on reopening an
  old session.
- **Usage analytics.** Distribution by model and provider, usage over time,
  parent versus delegated (subagent) work, cache performance, token
  composition, and a sortable Model Explorer covering every model × route
  pair — including how much of your usage could not be priced.
- **Costs in one place.** Declared membership fees sit alongside current
  cost estimates, with optional advanced rules for prepaid wallets,
  per-route allowances and custom token rates.
- **Memberships.** Discover the provider accounts Hermes is configured for,
  confirm which plan each account is on, add your own fee overrides, and
  mark allowances as exhausted when you know you have hit a limit. On
  request, Spend Sense can also read account usage through Hermes itself
  to prefill plan hints and quota windows.
- **Offline-capable pricing.** No direct pricing calls of its own: it uses
  Hermes' local models.dev pricing cache when available and falls back to
  the bundled offline rate snapshot.

## How it works

1. **Collect.** Hermes observer hooks (`post_api_request`,
   `post_auxiliary_call`, `api_request_error`) hand Spend Sense accounting
   metadata for each call: provider, model, route, token buckets, outcome
   and timestamps. Prompts, responses and credentials are never recorded.
2. **Store locally.** Calls go into a profile-scoped SQLite store in the
   plugin's data directory. Your memberships and billing rules live in
   separate local JSON files and survive plugin upgrades.
3. **Price.** Each recorded call is priced from the best available
   catalogue — Hermes' models.dev cache first, then the bundled snapshot.
   The Desktop ledger uses the rates captured at the time; backend
   analytics use the currently available catalogue. They are related, but
   they are not the same view and are not presented as one figure.
4. **Present.** The Desktop plugin renders the live pane, the ledger, the
   Usage analytics, Costs, Memberships and Settings & About views from the
   local backend. Nothing needs to leave your machine for the core views.

### Membership discovery

Discovery reads Hermes' authentication storage in memory and counts the
configured credential slots per provider. Credential values are never
returned, logged or stored. A slot proves an account is configured — not
which plan it is on — so Spend Sense suggests a plan where it can and asks
you to confirm it. That human confirmation is deliberate: a wrong plan
silently reprices every past month.

A user-triggered native usage read runs `hermes usage` for a provider.
Hermes may then contact that provider using credentials Hermes manages.

### Four figures, never summed

A membership card keeps four different kinds of number apart, because adding
them together would produce a confident, wrong total:

| Figure | What it is | What it is not |
|---|---|---|
| Membership fee | The plan fee you declared (or a fee override) | A per-call charge |
| Provider-reported usage | Quota or usage Hermes read from the provider | An invoice |
| API-equivalent value | What the same tokens would cost at published API rates | Money you actually spent |
| Metered / incremental cost | Allowance consumed, and extra cash beyond it under your rules | Provider-confirmed billing |

Estimates are estimates. An API-equivalent figure is a comparison price,
useful for judging whether a plan is worth keeping — it is not a provider
invoice, and Spend Sense never presents it as one.

Unpriced usage is reported as unpriced. Unknown is never shown as zero, and
known free usage is never mixed into a priced subtotal as if it were priced.

## Why you need it

- **Renew, downgrade or cancel with evidence.** Compare what a plan covered
  against what the same usage would have cost at API rates before the next
  fee leaves your account.
- **Spot the expensive route early.** Model × route analytics show which
  combination is driving tokens and cost, including delegated subagent work
  that is easy to miss in a session view.
- **Use allowances deliberately.** Per-model and shared allowances, prepaid
  wallets and manual exhaustion marks show what is left — inferred from
  your rules, and labelled as inferred.
- **Trust the cache numbers.** Cache hit rate is weighted across calls with
  known cache activity, and cache economics are shown as a theoretical
  comparison, not a billing credit.
- **Keep your data.** Everything is local-first. There is no Spend Sense
  account, no telemetry and no usage upload.

## Privacy and network behaviour

- Records accounting metadata only: identifiers, route and model, token
  buckets, outcome and timestamps. No prompts, responses, credentials or
  telemetry.
- Membership discovery counts credential slots in memory. It does not
  return or log credential values.
- Spend Sense makes no direct HTTP pricing requests. Automatic Hermes
  model-options refresh is off by default; when enabled, Hermes may refresh
  public models.dev metadata or contact configured providers using
  credentials Hermes manages.
- Settings & About can clear your Memberships and advanced billing rules
  for the current profile. Captured usage records, Hermes data and provider
  credentials are left untouched.

## Requirements and compatibility

- Hermes `>= 0.22.5`, per the plugin manifest. Compatibility with specific
  newer builds remains to be verified.
- Desktop and backend components should be tested together on an isolated
  profile. Backend analytics require the agent component to be active on
  the relevant Hermes profile.
- Coverage depends on what Hermes supplies and what the plugin observed.
  Cross-gateway attribution also depends on the event-origin information
  the SDK provides, so treat figures as indicative until the acceptance
  checks in [RELEASING.md](RELEASING.md) are complete.

## Installation

There is no supported public installation yet. A validated install, update
and rollback procedure will be published with the first supported release.

If you are evaluating the candidate from source, keep the existing
`wolfmark-cost-ledger` plugin ID and `/cost-ledger` route (changing them
would orphan existing namespaces and storage), back up plugin data first,
and test on an isolated profile. Do not install it over an existing plugin
without a verified backup.

## Development

Run the Python tests with:

```bash
python -m unittest discover -s test -p 'test_*.py'
```

Run the JavaScript tests with:

```bash
node --test --test-force-exit test/*.test.mjs
```

Some API tests need FastAPI and HTTPX (`python -m pip install fastapi httpx`)
and are skipped without them. The development-only UI test dependencies are
installed with `npm ci --prefix test/harness`. Hermes catalogue admission
additionally requires `hermes plugins validate /path/to/plugin
--install-deps` on the exact commit.

Do not run integration tests against production data.

## Attribution and licence

Spend Sense is built by WolfMark Ltd and derived from
[Token & Cost Meter](https://github.com/IT-dreamer/token-cost-meter) by AFei
(IT-dreamer), originally licensed under Apache-2.0. The combined Spend Sense
software distribution is licensed under GPL-3.0. That project licence does
not replace the original Apache-2.0 licence or attribution for the upstream
component. Both licence texts and applicable notices are included in this
repository. See [LICENSE](LICENSE), [NOTICE](NOTICE) and
[Apache-2.0](licenses/Apache-2.0.txt).

The [branding assets](BRANDING.md) have separate terms. Representative
screenshots of a validated build will be added with the first release.
