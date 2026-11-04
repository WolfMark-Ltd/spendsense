# Reviewed source baselines

One file per parseable catalogue source. Each pins the family slice of the
approved `catalogue/plans.json` the daily source check compares live pages
against.

## Rules

- A baseline changes only in a reviewed commit. The checker
  (`scripts/source-check.py`) never writes here.
- A file whose `status` is not `reviewed` is not trusted: the checker reports
  it as a baseline error and demands owner review.
- An unacknowledged live change reappears in every report until a reviewed
  commit accepts it. Nothing the checker writes can clear a diff on its own.

## Reviewing a candidate report

1. Download the `source-check-report` artefact (report plus `candidates/`).
2. For each changed source, read the live page and confirm the diff is real.
3. To accept a candidate: copy `candidates/<source-id>.json` over
   `catalogue/baselines/<source-id>.json`, set `status` to `reviewed`,
   record the current `catalogue_version`, and commit with the review note.
4. To reject it: do nothing. The diff will reappear until the live page or
   the baseline genuinely agrees, which is the honest outcome.
