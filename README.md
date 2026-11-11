<!-- markdownlint-disable MD033 -->
<p align="center">
  <img src="assets/branding/spend-sense-hermes-catalog-v4-1200x600.png" alt="Spend Sense — a Hermes plugin by WolfMark" width="720" />
</p>

<p align="center">
  <a href="https://github.com/WolfMark-Ltd/spendsense/actions/workflows/ci.yml"><img src="https://github.com/WolfMark-Ltd/spendsense/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <img src="https://img.shields.io/badge/Hermes-%3E%3D0.22.5-informational" alt="Requires Hermes 0.22.5 or newer" />
  <img src="https://img.shields.io/badge/License-GPL--3.0-blue.svg" alt="GPL-3.0 license" />
  <img src="https://img.shields.io/badge/version-0.6.0-informational" alt="Version 0.6.0" />
  <a href="https://coderabbit.ai"><img src="https://img.shields.io/coderabbit/prs/github/WolfMark-Ltd/spendsense?label=Reviewed%20by%20CodeRabbit&logo=coderabbit" alt="Reviewed by CodeRabbit" /></a>
  <a href="https://www.greptile.com/?utm_source=oss_badge&utm_medium=readme&utm_campaign=greptile_for_open_source"><img src="https://www.greptile.com/badge.svg" alt="Greptile: The War on Bugs" /></a>
  <a href="https://github.com/WolfMark-Ltd/spendsense"><img src="https://img.shields.io/github/stars/WolfMark-Ltd/spendsense?logo=github" alt="GitHub stars" /></a>
</p>

<h1 align="center">Spend Sense</h1>

<p align="center"><strong>What you pay. What you use. What it's worth.</strong></p>

> **Early access · Available on GitHub.** SpendSense is an open-source Hermes plugin you can try now, directly from this repository. We're refining the experience and verifying compatibility before a formal release and Hermes catalogue submission. New here? Start with the [quick-start guide](docs/quickstart.md), and back up your Hermes profile data before upgrading an existing installation. Found a bug or have an idea? [Open a GitHub issue](https://github.com/WolfMark-Ltd/spendsense/issues/new/choose). Our [release checklist](RELEASING.md) tracks what remains.

## Overview

Spend Sense is a Hermes plugin that shows what your AI usage is actually costing you. It records usage locally as it happens, prices it against published rates, and keeps your subscription plans, prepaid wallets, and API routes in one place — so you always know what you used, what your plan covered, and what the same work would have cost pay-as-you-go.

- **Live session view** — tokens, rates, cache performance, and estimated savings for the focused session, right inside Hermes Desktop.
- **Recorded ledger** — every eligible call timestamped and stored locally, independent of open sessions or restarts.
- **Plan truth** — declared fees and allowances next to observed usage, so renewals, downgrades, and cancellations are evidence-based.
- **Private by design** — no Spend Sense account, no telemetry, and no usage upload. Everything stays on your machine.

## Installation

First time installing? The [quick-start guide](docs/quickstart.md) walks through install, first figures, and recovery in one place. The reference details follow.

### Requirements

| Requirement | Detail |
| --- | --- |
| Hermes | `>= 0.22.5` (per the plugin manifest; newer builds still to be verified) |
| Profile | An isolated Hermes profile for evaluation, with a backup of your plugin data |

Desktop and backend components should be tested together. Backend analytics require the agent component to be active on the relevant Hermes profile.

### From Hermes Desktop (recommended)

Install from inside Hermes Desktop using the repository URL below. This places both halves in one step: the agent backend (hooks, ledger, API) into the connected backend, and the Spend Sense UI into the app's local `desktop-plugins` folder — the UI half is what makes the sidebar entry appear.

- Repository: `https://github.com/WolfMark-Ltd/spendsense`
- Leave the commit pin empty for the latest code, or pin a validated SHA for a known-good install.
- Choose the profile to install for, then Install. Until catalogue admission the dialog warns the source is unverified — check the repository URL matches before proceeding.

Keep the existing `spend-sense` plugin ID and `/spend-sense` route — changing them would orphan existing namespaces and storage. Do not install it over an existing plugin without a verified backup.

### From the command line

For servers and headless setups:

```bash
hermes plugins install WolfMark-Ltd/spendsense
hermes plugins enable spend-sense
```

To validate a source tree before installing (recommended for exact-commit installs):

```bash
git clone https://github.com/WolfMark-Ltd/spendsense.git
hermes plugins validate ./spendsense --install-deps
```

Review every validation warning. Note the Desktop app loads its UI from its own local folder, so if your Desktop app runs on another machine, complete the install from inside the app instead.

A Hermes catalogue listing is planned; releases will be pinned by commit SHA with screenshots and disclosures. See [RELEASING.md](RELEASING.md) for the release and catalogue-admission checklist.

### More than one machine?

Spend Sense is local-first: each Hermes records only the usage it sees, and memberships and billing rules live with that install. If you run Hermes on several machines — a laptop and a server, for example — install Spend Sense on each one you want accounted. There is no sync between installs; each holds its own ledger.

## Features

| Capability | What you get |
| --- | --- |
| **Live session view** | A Desktop chip and pane for the focused session: cost KPI, prompt-token composition, cache gauge with coverage, and a collapsible rate card. Five stable sections keep their positions across live refreshes, with methodology notes tucked into info popovers. |
| **Recorded ledger** | Eligible backend calls are timestamped and stored locally as they happen, so usage history does not depend on reopening an old session. |
| **Usage analytics** | Distribution by model and provider, usage over time, parent versus delegated (subagent) work, cache performance, token composition, and a sortable Model Explorer covering every model × route pair — including how much usage could not be priced. |
| **Costs in one place** | Declared membership fees sit alongside current cost estimates, with optional advanced rules for prepaid wallets, per-route allowances, and custom token rates. |
| **Subscription economics** | Monthly-equivalent fees compared with the API-equivalent value of usage attributed to each subscription, per currency, with renewal dates, a monthly trend and partial/unavailable states instead of misleading totals. Non-USD fees convert only with a dated rate you supply. |
| **Memberships** | Discover the provider accounts Hermes is configured for, confirm which plan each account is on, add fee overrides, and mark allowances as exhausted. On request, Spend Sense can read account usage through Hermes itself to prefill plan hints and quota windows. Each card also shows allowance weather: cycle position, provider-reported consumption, and — for USD cost rules with reliable coverage — consumption pace with a projected exhaustion date. |
| **Reports** | Generate a local 7- or 30-day digest of usage, costs, fees and allowances as Markdown, then review, copy or save it. Nothing is scheduled, uploaded or sent anywhere. |
| **Model News** | New models, API price changes and subscription updates detected from your local catalogues, with API-equivalent impact estimates from your own usage — plus optional public Spend Sense announcements. |
| **Offline-capable pricing** | No direct pricing calls of its own: Hermes' local models.dev pricing cache when available, with a bundled offline rate snapshot as fallback. |

## The problem

If you use more than one AI provider, the true cost of your usage is spread across places that never meet:

- A fixed subscription fee in one app.
- A prepaid balance or allowance in another.
- Pay-as-you-go API charges on a route you only use occasionally.
- Token counts inside Hermes that carry no price at all.

Provider dashboards show their own slice, after the fact. None of them answer the questions that matter while you work:

- What did this session cost — or what would it have cost at API rates?
- Is my subscription actually covering my usage, or am I paying for headroom I never use?
- Which model and route is eating my budget?
- Is prompt caching saving me money, or costing me a write premium?

Spend Sense answers those from the usage Hermes already sees, on your own machine, without sending your usage anywhere.

## How it works

1. **Collect.** Hermes observer hooks (`post_api_request`, `post_auxiliary_call`, `api_request_error`) hand Spend Sense accounting metadata for each call: provider, model, route, token buckets, outcome and timestamps. Prompts, responses and credentials are never recorded.
2. **Store locally.** Calls go into a profile-scoped SQLite store in the plugin's data directory. Memberships and billing rules live in separate local JSON files and survive plugin upgrades.
3. **Price.** Each recorded call is priced from the best available catalogue — Hermes' models.dev cache first, then the bundled snapshot. The Desktop ledger uses the rates captured at the time; backend analytics use the currently available catalogue. They are related, but they are not the same view and are not presented as one figure.
4. **Present.** The Desktop plugin renders the live pane, the ledger, the Usage analytics, Costs, Memberships, Model News, Reports and Settings & About views from the local backend. Nothing needs to leave your machine for the core views.

### Membership discovery

Memberships can mark an account **API Only**, or identify it as a subscription, prepaid credits, or not yet confirmed. API Only hides recurring membership fees from totals while retaining the saved plan and fee revisions for a later switch back. Prepaid top-ups are not recurring membership fees; configure any advanced cost rules separately in Costs. These choices do not change recorded usage or model pricing.

Back up the profile's Spend Sense plugin data before upgrading. Releases older than 0.6.0 may not recognise membership fields; restoring a compatible pre-upgrade backup may be necessary, and edits made after that backup will not be present in it.

Seat quantities are stored separately in `membership-seats.json`, and
route-to-account relationships in `membership-entitlements.json`, alongside
`memberships.json`, `billing-profiles.json`, `budgets.json` and `fx-rates.json`
in the profile's Spend Sense plugin-data directory. Back up all of them together
with the plugin stopped; restore them together to the same profile with the
plugin stopped. If a file was absent when the backup was taken, it should also
be absent after restoration.
The Settings recovery clipboard export includes the raw `membership_store`,
`seat_history` and `route_entitlements` documents as well as the advanced rules
and budget guardrails; retain it securely.
To restore from it, save the `seat_history` JSON object as
`membership-seats.json` and the `route_entitlements` JSON object as
`membership-entitlements.json` beside the restored `memberships.json`. The rules
and budgets entries need reshaping before they can be saved as store files, and
billing defaults are not in the export — see the
[quick-start guide](docs/quickstart.md#backup-upgrade-and-recovery) for the exact
shapes. The clipboard export does not include either usage ledger or provider
credentials. The Desktop-recorded ledger lives outside the plugin-data directory
in Hermes Desktop's app-level storage and is covered by neither the directory
backup nor the export.

The preceding 0.6.0 membership store can still be read and edited after seats
are saved: it ignores the separate seat file and does not calculate seat totals.
After upgrading again, the newer version reads the saved seat history. Keep the
sidecar with the matching profile and membership data throughout a downgrade;
do not remove or replace it when using an older version. Version 0.6.0 cannot
clear the sidecar when it resets its own user data: if you reset or remove an
account while downgraded, handle the matching seat backup explicitly before
using the newer version again.

An unmerged earlier PR #30 test build stored seat revisions inside
`memberships.json`. Those test-build files are rejected rather than silently
migrated or overwritten. With the plugin stopped, make a copy of that file
and run `python scripts/recover-inline-seat-history.py COPY OUTPUT`, where
`OUTPUT` is a new file. The export leaves the source untouched and contains
`membership_store` and `seat_history` objects; save those objects as
`memberships.json` and `membership-seats.json` respectively to restore the
matching profile. Retain the original and back up all profile files first.
Do not overwrite a newer sidecar with an older recovery export.

Discovery reads Hermes' authentication storage in memory and counts the configured credential slots per provider. Credential values are never returned, logged or stored. A slot proves an account is configured — not which plan it is on — so Spend Sense suggests a plan where it can and asks you to confirm it. That human confirmation is deliberate: a wrong plan silently reprices every past month.

A user-triggered native usage read runs `hermes usage` for a provider. Hermes may then contact that provider using credentials Hermes manages.

### Four figures, never summed

A membership card keeps four different kinds of number apart, because adding them together would produce a confident, wrong total:

| Figure | What it is | What it is not |
| --- | --- | --- |
| Membership fee | The effective fee — your override, the plan price, or seats × catalogue unit price | A per-call charge or a verified provider bill |
| Provider-reported usage | Quota or usage Hermes read from the provider | An invoice |
| API-equivalent value | What the same tokens would cost at published API rates | Money you actually spent |
| Metered / incremental cost | Allowance consumed, and extra cash beyond it under your rules | Provider-confirmed billing |

Estimates are estimates. An API-equivalent figure is a comparison price, useful for judging whether a plan is worth keeping — it is not a provider invoice, and Spend Sense never presents it as one. New to these terms? The [quick-start guide](docs/quickstart.md#three-money-figures-never-one-total) explains API-equivalent cost, subscription fees and actual provider charges in plain language.

Unpriced usage is reported as unpriced. Unknown is never shown as zero, and known free usage is never mixed into a priced subtotal as if it were priced.

## Why you need it

- **Renew, downgrade or cancel with evidence.** Compare what a plan covered against what the same usage would have cost at API rates before the next fee leaves your account.
- **Spot the expensive route early.** Model × route analytics show which combination is driving tokens and cost, including delegated subagent work that is easy to miss in a session view.
- **Use allowances deliberately.** Per-model and shared allowances, prepaid wallets and manual exhaustion marks show what is left — inferred from your rules, and labelled as inferred.
- **Trust the cache numbers.** Cache hit rate is weighted across calls with known cache activity, and cache economics are shown as a theoretical comparison, not a billing credit.
- **Keep your data.** Everything is local-first. There is no Spend Sense account, no telemetry and no usage upload.

## Privacy and network behaviour

- Records accounting metadata only: identifiers, route and model, token buckets, outcome and timestamps. No prompts, responses, credentials or telemetry.
- Membership discovery counts credential slots in memory. It does not return or log credential values.
- Spend Sense makes no direct HTTP pricing requests. Automatic Hermes model-options refresh is off by default; when enabled, Hermes may refresh public models.dev metadata or contact configured providers using credentials Hermes manages.
- Model News snapshots your local Hermes pricing cache and bundled plan catalogue to detect newly listed models and rate changes. The first snapshot is a baseline, not news. Nothing is uploaded and no network request is made; everything works offline.
- Spend Sense Live Updates (Settings, off by default) downloads public Model News and subscription-plan JSON feeds over HTTPS when enabled. Requests contain no user IDs, accounts, credentials, model lists, usage totals or tracking tokens; the source IP is visible to the service, and anonymous aggregate request statistics may be produced. On a remote Hermes host, that host makes the request. Disabling Live Updates stops the requests; local news and locally stored memberships continue to work. See the public [Model News feed contract](news-feed/README.md) and [plans feed contract](plans-feed/README.md) for endpoints and schemas.
- Settings & About can clear your Memberships, route entitlement relationships, budgets and advanced billing rules for the current profile. Captured usage records, Hermes data, provider credentials and catalogues are left untouched.

## Requirements and compatibility

- Hermes `>= 0.22.5`, per the plugin manifest. Compatibility with specific newer builds remains to be verified.
- Desktop and backend components should be tested together on an isolated profile. Backend analytics require the agent component to be active on the relevant Hermes profile.
- Coverage depends on what Hermes supplies and what the plugin observed. Cross-gateway attribution also depends on the event-origin information the SDK provides, so treat figures as indicative until the acceptance checks in [RELEASING.md](RELEASING.md) are complete.

## Budget guardrails

Set monthly limits for all usage, a provider route or a model × route in
**Settings & About**. Choose **estimated usage value** (catalogue-based, including
subscription usage) or **actual metered spending** (requires charge evidence).
The two measurements are never combined with one another, subscription fees or
allowances. Current Hermes hooks do not provide per-call billed charges, so actual
spending remains unavailable where evidence is missing.

A separate session/conversation **estimated usage-value** limit gives live amber
and red status-bar warnings. Overview shows the limits; Costs adds coverage,
7-day/30-day burn rates, cycle-end projection, budget runway and a possible breach
date when there is sufficient evidence. Thresholds default to 50%, 80% and 100%.
Partial pricing shows a known subtotal and cannot produce an “on track” verdict
or forecast. All limits are advisory and local; no agent call is blocked.

See [the accounting, API and compatibility notes](design/budget-guardrails.md).

## Development

Run the Python tests from a virtual environment — never system Python (on macOS, system pip is blocked by PEP 668, so install into the project environment instead):

```bash
python3 -m venv .venv
.venv/bin/python -m pip install fastapi httpx
.venv/bin/python -m unittest discover -s test -p 'test_*.py'
```

With [uv](https://docs.astral.sh/uv/) instead: `uv venv .venv && uv pip install --python .venv/bin/python fastapi httpx`, then run the tests as above.

Run the JavaScript tests with:

```bash
node --test --test-force-exit test/*.test.mjs
```

Some API tests need FastAPI and HTTPX (installed above) and are skipped without them. The development-only UI test dependencies are installed with `npm ci --prefix test/harness`. Hermes catalogue admission additionally requires `hermes plugins validate /path/to/plugin --install-deps` on the exact commit.

Do not run integration tests against production data.

## Support

- Questions, bugs and feature requests: [GitHub issues](https://github.com/WolfMark-Ltd/spendsense/issues).
- Product support: [Contact WolfMark](https://wolfmark.co.uk/contact).

## Attribution and licence

Spend Sense is built by WolfMark Ltd and derived from [Token & Cost Meter](https://github.com/IT-dreamer/token-cost-meter) by AFei (IT-dreamer), originally licensed under Apache-2.0. The combined Spend Sense software distribution is licensed under GPL-3.0. That project licence does not replace the original Apache-2.0 licence or attribution for the upstream component. Both licence texts and applicable notices are included in this repository. See [LICENSE](LICENSE), [NOTICE](NOTICE) and [Apache-2.0](licenses/Apache-2.0.txt).

The [branding assets](BRANDING.md) have separate terms. Representative screenshots of a validated build will be added with the first release.

### Cache reporting and provenance

Cache hit rate is cache-read prompt tokens divided by covered prompt tokens (fresh input, cache reads and cache writes). Nerd Mode uses timestamped backend calls in the chosen period and filters; the live pane uses the current Desktop conversation. Coverage shows how much of each scope has usable cache information. Gateway percentages rounded by Hermes are reconstructed estimates and marked ≈. Unknown and older data are not silently treated as confirmed zeroes.

Hermes v0.22.5 normalises absent provider cache fields to zero before sending its plugin hook and removes raw usage from the hook payload. A zero-read/zero-write hook record therefore cannot prove a cache miss. As an optional upstream enhancement, Hermes could provide, for each cache-read and cache-write counter, an explicit presence/provenance indicator (including confirmed zero versus missing), plus the exact canonical token counts. Spend Sense needs only these accounting fields and would not need prompts, responses or credentials. Historical records cannot be retrospectively disambiguated.

Desktop CSV exports retain `cache_saved_usd` as the legacy gross cache-read savings field for compatibility. The separate `net_cache_savings_usd` field includes cache-write premiums and is blank when a complete net value is unavailable; the export keeps that stricter complete-value contract even though the pane shows a measured subtotal.

Theoretical net savings compare covered prompt tokens at uncached input prices with their fresh, cache-read and cache-write prices; cache writes may create a net premium. They are not a refund or invoice. The sidebar gauge and the ledger totals show the measured subtotal — the prompt tokens whose cache split and rates are known — together with the share of prompt tokens it covers. A figure covering part of a conversation is marked ≈ and is never labelled exact. When nothing can be measured, the pane names the reason (no cache evidence, no rate for the route, tiered pricing not modelled, cache-write price missing, cache split not reported) rather than showing a bare dash. A cache-write figure reconstructed from Hermes's rounded hit percentage, on a route that publishes no write price, is valued at the input rate — the same convention the cost estimate uses. That substitution omits any write premium, so a route that charges one would have its theoretical saving overstated by that premium, and a route charging less than input for writes would be understated; the figure is exact only against the card the pane displays, which prices writes at the input rate too. It is not a general guarantee that a missing write price cannot overstate savings: it holds for this ledger because the affected routes record no cache writes at all. A provider-reported cache write still requires its published price, and a provider-reported zero is a measurement rather than missing evidence — the pane says "no cache evidence" for the latter instead of pricing it at zero. Nerd Mode shows the same covered-call subtotal and its coverage. Desktop gateway counters and backend per-call events have different timing and attribution, and rates may differ by source or time; figures should be compared only for the same calls and pricing assumptions.
