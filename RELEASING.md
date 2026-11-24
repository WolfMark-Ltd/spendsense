# Release and update checklist

This candidate is not yet a formal release. A release, catalogue submission and any
production installation require separate authorisation.

1. Review the exact commit, its dependencies, licences, privacy disclosures and
   changes to persistent data. Keep the existing plugin ID and route unless a
   tested migration has been explicitly agreed.
2. Run the Python, browserless Node and Chromium suites in README and validate that exact commit with
   `hermes plugins validate /path/to/plugin --install-deps`. Review every warning.
3. On an isolated Hermes profile, test both Desktop and backend together, including
   install, restart, upgrade, rollback, network behaviour and account changes.
   Exercise multiple gateways, profile switches and return to the same gateway,
   including pending reads, writes and usage events. Keep test data synthetic.
4. Document compatibility and back up relevant plugin data before an authorised
   upgrade. Confirm a tested recovery path before replacing an installation.
   Verify the actual installed Desktop bytes against the approved source and
   the live backend's expected Desktop SHA-256. Identify the process serving
   Desktop's API, restart its owner and check its running revision and contract.
   A requested pin, matching version labels or a successful gateway restart alone
   does not prove that both live components have updated. Confirm existing usage
   history, saved settings and navigation using the
   [troubleshooting acceptance checks](docs/troubleshooting.md#check-the-repair-before-calling-it-complete).
5. For catalogue admission, follow the current Hermes submission documentation,
   including a full commit SHA, accurate disclosures and UI screenshots. Catalogue
   updates require a newly reviewed pin. Do not submit until authorised.

Do not ship private diagnostics, personal usage exports, credentials, databases,
local configuration or internal operational records. The logo and other brand
assets have separate terms in BRANDING.md.

## Release identity and the pairing contract

The current source declares `0.6.38` in `plugin.yaml`, `PLUGIN_VERSION`,
`dashboard/manifest.json`, `plugin_api.VERSION` and the README version badge.
The UAT correction wave advances from `0.6.34` by one patch for each of
PRs #112, #113, #114 and #115, with the bump landing in the final Sidebar PR.
The coordinated release wave advances from `0.6.25` by one patch for each
of PRs #97 through #104, with the bump landing in the final WP31 PR; this
final correction PR (Costs nag-loop, erasure disclosure) advances to `0.6.34`.
The preceding wave advanced from `0.6.22` by one patch for each
of PR #94, PR #95 and the WP49 PR.
The wave advances from `0.6.9` by one patch for each of PRs #72, #73 and #74.
The preceding wave advanced from `0.6.7` to `0.6.9` for PRs #70 and #71.

To verify installed file identity and runtime compatibility, check the three facts
below alongside the version labels. Earlier builds shared `0.6.0`.

| Fact | Read it from | Proves |
| --- | --- | --- |
| Backend revision | `build.revision` in `GET /health` | which commit is running |
| Paired Desktop bundle | `build.desktop_sha256` in `GET /health` | which Desktop half belongs with it |
| Contract level | `API_CONTRACT` in `dashboard/plugin_api.py`, `REQUIRED_BACKEND_CONTRACT` in `desktop/plugin.js` | whether the two halves can work together |

`build.revision` is read from `.git/HEAD` — an install is a detached checkout — or
from the installer's own record when the tree carries no Git metadata. It is
`null` rather than guessed when neither exists. All three values are resolved when
the backend module is imported, so they describe the **running** build: a tree
replaced in place before the backend restarts keeps reporting the revision it
started from, which is the truthful answer and the reason to restart the backend
before reloading Desktop.

`build.desktop_sha256` is computed from `desktop/plugin.js` **in the installed
tree**, so it describes the half that commit shipped rather than a manifest that
could drift from it. The Desktop app cannot hash its own bundle. Compare this
value with the actual loaded file's SHA-256 and the approved source to verify
the pair across hosts.
Use the platform-specific commands and root-discovery guidance in
[advanced verification](docs/troubleshooting.md#verify-the-actual-files-and-running-build).

### The contract rule

1. Raise `API_CONTRACT` in the same commit as any backend change the UI depends
   on, and raise `REQUIRED_BACKEND_CONTRACT` in `desktop/plugin.js` with it.
2. Never raise `REQUIRED_BACKEND_CONTRACT` above `API_CONTRACT`: the revision that
   ships both halves must accept its own pair, and
   `test/compatibility.test.mjs` fails the build otherwise.
3. A backend that reports no `build` block reads as contract 1, so an older
   backend is detected on load rather than at the first failed write. An older UI
   against a newer backend ignores the added fields and degrades safely; that
   direction is deliberately not enforced.

### Install and roll back both halves or neither

`hermes plugins install` places the backend half only. The Desktop half is
reconciled into `desktop-plugins/` separately. Some Hermes builds retain an
existing copy whose recorded source mtime is not older than the package's, even
when the bytes differ. See [upstream PR #154773](https://github.com/NousResearch/hermes-agent/pull/154773).
This is a supported explanation for a stale UI, not a conclusively traced cause
without installation evidence. Check the actual Hermes build and installed bytes.

- Install the backend, reconcile the Desktop half, restart the process serving
  Desktop's API, then reload Desktop. A separate API service is not restarted by
  a gateway restart. Afterwards check `build` in `/health` and the installed
  bundle digest; matching version labels do not establish compatibility.
- A rollback restores the backend tree, the Desktop half and **only** the
  `spend-sense` entry of `.install-metadata.json`. `plugin-data` is replaced only
  when the older build cannot read it, and the outgoing copy is moved aside,
  never deleted.
- When the halves disagree, SpendSense shows a recovery block naming the backend
  revision, the contract found and required, the digest to compare and the two
  ways out. Membership, budget and usage data are untouched by a mismatch.
