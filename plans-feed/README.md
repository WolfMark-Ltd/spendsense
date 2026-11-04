# Spend Sense central membership-plan feed

Public, user-agnostic membership plans with verification states for the
optional "Spend Sense Live Updates" service. The plugin fetches one static
JSON file; the server learns nothing except what the connection itself
reveals.

Deployment target: the WolfMark VPS (Ubuntu, Nginx), alongside the Model
News feed at `feed/v1/plans.json`. Nothing here is deployed yet, and no
VPS change is part of this work.

## Files

| File | Purpose |
| --- | --- |
| `schema.json` | Feed schema (version 1). The plugin validates every fetch against the same rules. |
| `generate.py` | Operator wrapper. Deterministic: the same catalogue plus `--generated-at` gives byte-identical output. |
| `collect.sh` | Manual publication: generate, validate, atomic publish. Prepared, not scheduled. |

The generator logic lives in `wolfmark_ledger/plans_feed.py` so the test
suite covers it; `generate.py` only wires the repo path to the CLI.

## What gets published

The feed carries the approved `catalogue/plans.json` minus retired plans:

- `verified`, `provisional` and `unverified` plans ship with their
  verification state intact, so the pane shows exactly what operators
  approved.
- `retired` plans are withheld. The desktop pane already marks any stored
  membership on a retired plan for reconfirmation, so omitting them from
  the feed never strands a member silently.
- At most 200 plans and 256 KiB, matching the plugin's client fetch cap.

## How publication works

`collect.sh` is run by the operator after approving a catalogue change:

1. Runs the generator against the repo's `catalogue/plans.json`.
2. Rejects the run unless the output passes the plugin's own client
   validation (`membership_live.validate_feed`) with zero problems and
   fits the 256 KiB client fetch cap.
3. Stages the feed beside the live file, then atomically renames it over
   `feed/v1/plans.json` (same directory, so the rename can never cross
   filesystems), keeping the previous live feed outside the web root as
   the rollback copy. A directory lock serialises runs.

Any failure exits non-zero before publication, so the prior good feed
always survives a bad run.

On-host layout (created at activation, outside the web root except `LIVE`):

```
$FEED_ROOT/repo    checked-out spendsense repository
$FEED_ROOT/state   rollback copy, run log
$FEED_WEBROOT      subdomain document root (LIVE = feed/v1/plans.json)
```

All three paths are overridable for local validation (`FEED_ROOT`,
`FEED_WEBROOT`, `FEED_PYTHON`).
