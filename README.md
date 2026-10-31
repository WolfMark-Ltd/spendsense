# Spend Sense

**What you pay. What you use. What it's worth.**

Spend Sense is WolfMark Ltd's development-stage Hermes plugin for understanding
AI usage, recorded costs, membership fees and API-equivalent estimates. It builds
on Token & Cost Meter by AFei (IT-dreamer), and adds a backend for timestamped
Hermes usage, analytics, and user-managed memberships and pricing.

> This repository is an acceptance candidate. It is not yet a supported public
> release. Do not install it over an existing plugin without a verified backup.

## What it does

- Shows the focused session's usage and a Desktop-recorded ledger.
- Captures eligible backend calls after its collector is enabled and shows
  analytics by period, model and route. Historical cumulative data is separate.
- Records declared membership plans and fees, and compares usage with estimated
  API-equivalent values. Estimates are not provider invoices.
- Uses bundled offline pricing data and supports user-defined membership details.

The Desktop ledger and backend analytics are distinct. Backend data requires the
agent component to be active on the relevant Hermes profile. Coverage depends on
what Hermes supplies and what the plugin observed; unknown values are not zero.
Desktop-recorded amounts use rates captured at the time; backend equivalents use
the currently available catalogue and are not historical price snapshots.

## Installation and compatibility

A validated public installation and update procedure is still being prepared.
The candidate retains the `wolfmark-cost-ledger` plugin ID and `/cost-ledger`
route to preserve existing namespaces and storage. It requires Hermes >= 0.22.5
according to the manifest; compatibility with specific newer builds remains to
be verified. Desktop and backend components should be tested together on an
isolated profile before any upgrade. Back up plugin data first; no migration or
rollback has yet been validated for this public candidate.

## Privacy and network behaviour

The plugin records accounting metadata and user-entered membership and pricing
information. It is designed not to store prompts, responses, credentials or
telemetry. Membership discovery parses Hermes authentication storage in memory to
count configured provider slots; it does not return or log credential values. Desktop model-options refresh is off by default. When enabled, Hermes
may contact configured providers or refresh its own pricing metadata using
credentials it manages. The backend also reads Hermes' local pricing cache when
available. Review the code and Hermes settings for your environment before use.

Connection and profile switching, asynchronous event ownership, upgrades and
native Desktop operation remain acceptance checks. In particular, the SDK must
provide sufficient event-origin information before cross-gateway attribution can
be assured. Treat figures as indicative until those checks are complete.

## Development

Run Python tests with `python -m unittest discover -s test -p 'test_*.py'` and
JavaScript tests with `node --test --test-force-exit test/*.test.mjs`. Some tests
need FastAPI and HTTPX; UI scope tests use the development-only dependencies in
`test/harness`. Hermes catalogue admission additionally requires
`hermes plugins validate /path/to/plugin --install-deps` on the exact commit.
Do not run integration tests against production data.

## Attribution and licence

Spend Sense is derived from [Token & Cost Meter](https://github.com/IT-dreamer/token-cost-meter)
by AFei (IT-dreamer), originally licensed under Apache-2.0. The combined software
is distributed under GPL-3.0; the upstream licence and notices remain applicable.
See [LICENSE](LICENSE), [NOTICE](NOTICE) and [Apache-2.0](licenses/Apache-2.0.txt).
The [branding assets](BRANDING.md) have separate terms.

See [RELEASING.md](RELEASING.md) for the validation and update checklist. The
approved catalogue banner is in `assets/branding/`; representative screenshots
of a validated build are still needed.
