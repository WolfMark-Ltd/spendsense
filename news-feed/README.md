# Spend Sense central Model News feed

Public, user-agnostic model and subscription announcements for the optional
"Spend Sense Live Updates" service. The plugin fetches one static JSON file;
the server learns nothing except what the connection itself reveals (see
Privacy below).

## Files

| File | Purpose |
| --- | --- |
| `schema.json` | Feed schema (version 1). The plugin validates every fetch against the same rules. |
| `generate.py` | Operator wrapper. Deterministic: same inputs plus `--observed-at` give byte-identical output. |
| `collect.sh` | Weekly collection: download, generate, validate, atomic publish. Prepared, not scheduled. |
| `crontab.example` | Cron schedule example. Prepared, not installed. |
| `web/.htaccess` | Feed-directory web config. Prepared, not installed. |
| `curated.json` | Curated subscription/allowance announcements. Starts empty; entries are transcribed verbatim. |
| `curated.example.json` | Entry shape example. Never read by the generator. |
| `fixtures/sample-feed.json` | Sample feed for tests and docs. Invented examples, not real announcements. |

The generator logic lives in `wolfmark_ledger/news_feed.py` so the test suite
covers it; `generate.py` only wires the repo path to the CLI.

## How publication works

`collect.sh` runs weekly and does, in order:

1. Downloads the models.dev snapshot with retries and a timeout; refuses
   bodies under 1 MB or that are not valid JSON.
2. Runs the generator: diffs the new snapshot against the previous one,
   merges reviewed `curated.json` entries, and carries forward recent items
   from the live feed (90-day retention, fresh items win duplicates).
3. Rejects the run unless the output passes the plugin's own client
   validation with zero problems and fits the 256 KiB client fetch cap.
4. Atomically publishes by rename over `feed/v1/news.json`, keeping the
   previous live feed outside the web root as the rollback copy.
5. Rotates the snapshot (`models-prev.json`) and appends one operational
   line to `state/collect.log` (kept to the last 200 lines).

Any failure exits non-zero before publication, so the prior good feed
always survives a bad run. The script is silent on success; cron mails
its stderr on failure when `MAILTO` is set.

On-host layout (created at activation, outside the web root except `LIVE`):

```
~/spendsense-feed/repo    spendsense checkout (this directory's source)
~/spendsense-feed/state   curated.json, models-prev.json, news.json.prev, collect.log
~/spendsense.wolfmark.co.uk/feed/v1/news.json   LIVE (plus .htaccess)
```

Curated announcements are edited directly in `state/curated.json` on the
host (seeded from the repo copy at activation). Every entry still needs a
provider, a summary and an https `source_url` the reader can check. Never
invent a change: if the effective date or the new allowance cannot be
established from the source, leave that field out and say so in
`conditions`. A malformed curated file fails the run without publishing.

## Serving configuration (shared LiteSpeed/cPanel hosting)

The feed host is a plain subdomain document root serving one static file.
TLS comes from the host's AutoSSL once DNS exists. Install
`web/.htaccess` as `<docroot>/feed/v1/.htaccess`: JSON content type,
6-hour public cache headers, no directory indexes.

There is no application server, no per-visitor processing, no analytics,
and nothing on this host that stores accounts, usage, credentials or
membership data — the publisher only ever sees public models.dev data
and the operator's own curated file.

### Logging, stated honestly

- Our scripts log only operational lines (time, item count, outcome) to
  `state/collect.log`. They never see visitor addresses.
- `.htaccess` cannot disable the platform's own HTTP access logging. The
  host writes per-domain access logs (visible under `~/logs`, rotated
  monthly) that include source IPs for every request, including feed
  fetches. This is outside unprivileged control.
- Closest achievable posture at activation: in cPanel, disable log
  processing programs for the feed subdomain (Metrics → Raw Access: no
  archived-log statistics), and prune that subdomain's rotated archives
  from `~/logs` whenever stability allows. Transient TCP/TLS metadata
  (source IP, timing) remains visible while any request is served.
- If full "no request logs" becomes a hard requirement, this feed needs a
  host where the web-server log configuration is operator-controlled
  (e.g. a root VPS with `access_log off` for the feed location). That is
  a platform move, not a config tweak, and is not part of this plan.

## Activation (requires explicit approval — do NOT run yet)

1. DNS: add `spendsense.wolfmark.co.uk` → the hosting account IP.
2. cPanel: create the subdomain with document root
   `~/spendsense.wolfmark.co.uk`; confirm AutoSSL covers it (https works).
3. Copy `web/.htaccess` to `<docroot>/feed/v1/.htaccess`.
4. On the host: `mkdir -p ~/spendsense-feed/state`, clone the repo to
   `~/spendsense-feed/repo`, copy `news-feed/curated.json` to
   `~/spendsense-feed/state/curated.json`.
5. Dry-run once by hand (no cron yet):
   `FEED_ROOT=~/spendsense-feed sh ~/spendsense-feed/repo/news-feed/collect.sh`
   and confirm the first feed publishes (first run has no diff baseline;
   curated-only content is expected).
6. Fetch `https://spendsense.wolfmark.co.uk/feed/v1/news.json` over TLS
   and confirm content type, cache headers and valid JSON.
7. cPanel: disable log programs for the subdomain; prune its archives.
8. Merge `crontab.example` into the account cron (adjust `MAILTO`).

## Rollback

The previous live feed is kept at `~/spendsense-feed/state/news.json.prev`
(outside the web root). To restore it:

```sh
cp ~/spendsense-feed/state/news.json.prev /tmp/rollback-news.json
mv /tmp/rollback-news.json ~/spendsense.wolfmark.co.uk/feed/v1/news.json
```

To pause publication without removing the endpoint, comment out the cron
line; the last good feed keeps serving. To withdraw the endpoint
entirely, remove the cron line and the `feed/` directory.

## Privacy and connection metadata

- The plugin sends an unauthenticated GET with static headers (`Accept`,
  `User-Agent: SpendSense-News`) and no query string, cookies, user IDs,
  accounts, credentials, model lists, usage totals or tracking tokens.
- Enabling the service necessarily involves an HTTPS request whose
  **source IP is visible to the server** at the TCP/TLS layer. On a remote
  Hermes host, that host's address makes the request, not the Desktop machine.
- The feed carries no executable code; the plugin never executes, evaluates
  or self-updates from it.

## Catalogue security note

The plugin reads this feed through its own Python backend over plain
HTTPS with a 10 s timeout and a 256 KiB size cap, validates the schema,
and keeps working locally when the feed is unreachable. No credentials or
Hermes internals are involved.
