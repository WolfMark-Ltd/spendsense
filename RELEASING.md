# Release and update checklist

This candidate is not yet a release. A release, catalogue submission and any
production installation require separate authorisation.

1. Review the exact commit, its dependencies, licences, privacy disclosures and
   changes to persistent data. Keep the existing plugin ID and route unless a
   tested migration has been explicitly agreed.
2. Run the Python and Node suites in README and validate that exact commit with
   `hermes plugins validate /path/to/plugin --install-deps`. Review every warning.
3. On an isolated Hermes profile, test both Desktop and backend together, including
   install, restart, upgrade, rollback, network behaviour and account changes.
   Exercise multiple gateways, profile switches and return to the same gateway,
   including pending reads, writes and usage events. Keep test data synthetic.
4. Document compatibility and back up relevant plugin data before an authorised
   upgrade. Confirm a tested recovery path before replacing an installation.
5. For catalogue admission, follow the current Hermes submission documentation,
   including a full commit SHA, accurate disclosures and UI screenshots. Catalogue
   updates require a newly reviewed pin. Do not submit until authorised.

Do not ship private diagnostics, personal usage exports, credentials, databases,
local configuration or internal operational records. The logo and other brand
assets have separate terms in BRANDING.md.
