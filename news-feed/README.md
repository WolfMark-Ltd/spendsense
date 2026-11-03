# Spend Sense central Model News feed

Public, user-agnostic model and subscription announcements for the optional
"Spend Sense Live Updates" service. The plugin fetches one static JSON file;
the server learns nothing except what the connection itself reveals (see
Privacy below).

Deployment target: the WolfMark VPS (Ubuntu, Nginx) — chosen over
shared hosting precisely because that platform cannot disable request
logging. Nothing here is deployed yet.

## Files

| File | Purpose |
| --- | --- |
| `schema.json` | Feed schema (version 1). The plugin validates every fetch against the same rules. |
| `generate.py` | Operator wrapper. Deterministic: same inputs plus `--observed-at` give byte-identical output. |
| `collect.sh` | Scheduled collection: download, generate, validate, atomic publish. Prepared, not scheduled. |
| `aggregate.py` | Daily country fold of the temp count log (logic in `wolfmark_ledger/feed_counts.py`). Prepared, not scheduled. |
| `vps/spendsense.wolfmark.co.uk.nginx` | Static HTTPS endpoint, anonymous count log on the feed path only. Prepared, not installed. |
| `vps/spendsense.wolfmark.co.uk.bootstrap.nginx` | HTTP-only ACME bootstrap vhost for first issuance. Prepared, not installed. |
| `vps/spendsense-feed-http.conf` | GeoIP2 country lookup + minimal count format (http context). Prepared, not installed. |
| `vps/wolfmark-spendsense-feed.service` | Hardened oneshot publisher (house systemd conventions). Prepared, not installed. |
| `vps/wolfmark-spendsense-feed.timer` | Six-hourly monotonic schedule (timezone-independent). Prepared, not enabled. |
| `vps/wolfmark-spendsense-feed-aggregate.service` | Offline daily fold (no IP networking at all). Prepared, not installed. |
| `vps/wolfmark-spendsense-feed-aggregate.timer` | Daily 00:07 rollup. Prepared, not enabled. |
| `curated.json` | Curated subscription/allowance announcements. Starts empty; entries are transcribed verbatim. |
| `curated.example.json` | Entry shape example. Never read by the generator. |
| `fixtures/sample-feed.json` | Sample feed for tests and docs. Invented examples, not real announcements. |

The generator logic lives in `wolfmark_ledger/news_feed.py` so the test suite
covers it; `generate.py` only wires the repo path to the CLI.

## How publication works

`collect.sh` runs every six hours under the systemd timer and does, in order:

1. Downloads the models.dev snapshot with retries and a timeout; refuses
   bodies under 1 MB or that are not valid JSON.
2. Runs the generator: diffs the new snapshot against the previous one,
   merges reviewed `curated.json` entries, and carries forward recent items
   from the live feed (90-day retention, fresh items win duplicates).
3. Rejects the run unless the output passes the plugin's own client
   validation with zero problems and fits the 256 KiB client fetch cap.
4. Sets the feed world-readable, then atomically publishes by rename over
   `feed/v1/news.json`, keeping the previous live feed outside the web root
   as the rollback copy.
5. Rotates the snapshot (`models-prev.json`) and appends one operational
   line to `state/collect.log` (kept to the last 200 lines).

Any failure exits non-zero before publication, so the prior good feed
always survives a bad run. Failures surface in the service journal
(`journalctl -u wolfmark-spendsense-feed`); the run log has the history.

On-host layout (created at activation, outside the web root except `LIVE`):

```
/opt/wolfmark-spendsense-feed/repo    spendsense checkout (this directory's source)
/opt/wolfmark-spendsense-feed/state   curated.json, models-prev.json, news.json.prev, collect.log
/var/www/spendsense.wolfmark.co.uk/feed/v1/news.json   LIVE
```

Permissions: state is root-only (`0700`); the document root is
`root:www-data 0755` with the feed file `0644`, so Nginx serves it without
write access to anything. The systemd unit mirrors house hardening
(`NoNewPrivileges`, `ProtectSystem=strict`, restricted address families)
with write access limited to those two paths.

Curated announcements are edited directly in `state/curated.json` on the
host (seeded from the repo copy at activation). Every entry still needs a
provider, a summary and an https `source_url` the reader can check. Never
invent a change: if the effective date or the new allowance cannot be
established from the source, leave that field out and say so in
`conditions`. A malformed curated file fails the run without publishing.

## Anonymous country counting

Nginx resolves each feed request's country in-process from a locally
installed GeoLite2 database (no per-request third-party lookup) and appends
one temporary line — `METHOD STATUS COUNTRY`, e.g. `GET 200 GB` — to
`/var/lib/spendsense-feed/count.tmp.log`. That is the entire per-request
record: no IP addresses, no timestamps, no user agents, no cookies, no
identifiers. Lookup misses become `Unknown`, counted like any other country.

Daily at 00:07 the aggregate timer folds the temp log into
`state/country-daily.json` (`{date: {country: count}}`), counting
successful GETs only, then truncates the temp log so the per-request lines
are discarded. Monitoring checks must use HEAD, which keeps them out of the
totals. Totals are keyed by the previous server-local date, matching the
rollup boundary; a missed run folds its backlog into the next key.

The totals file is shaped for an optional later export to PostHog: one
aggregate event per country per day, a single fixed identifier (never a
visitor id), person profiles off (`$process_person_profile: false`), and
PostHog GeoIP enrichment disabled. No export code ships now, no PostHog
client SDK goes into Spend Sense, and per-visitor events are never sent.

## Serving configuration (Nginx, VPS)

The feed host is a plain Nginx server block serving one static file, plus a
port-80 block that answers ACME challenges and redirects everything else to
HTTPS. TLS comes from Let's Encrypt via the established certbot webroot
flow. Static hardening follows existing WolfMark origins: tokens off,
`GET`/`HEAD` only, 1 KiB request cap, 404 for anything but the feed path.

There is no application server, no per-visitor processing, no analytics,
and nothing on this host that stores accounts, usage, credentials or
membership data — the publisher only ever sees public models.dev data
and the operator's own curated file.

### Logging, stated honestly

- `access_log off;` covers the whole feed host except the feed path, which
  writes temporary `METHOD STATUS COUNTRY` lines only — no IPs,
  timestamps, user agents, cookies or identifiers — folded daily into
  anonymous country totals, after which the per-request lines are
  discarded. ACME validation hits leave no request log.
- `error_log` stays at `warn` per house convention. It records failures
  only, but a failed request can include the client address in an error
  entry. There is no other routine visitor record on this host.
- No upstream proxy or CDN fronts this host, so there is no upstream
  request logging to account for. Transient TCP/TLS metadata remains
  visible while any request is served, as with any HTTPS server.
- Net verdict: the privacy requirements are genuinely met here — better
  than the shared host, where platform access logs cannot be disabled.

### Monitoring

Reuse the running Uptime Kuma (Docker, healthy): at activation add an
HTTPS check on the feed URL (HEAD method, expecting 200) so monitoring
stays out of the GET totals. Timer failures are also visible via
`systemctl status` / the journal and `state/collect.log`.

## Activation (requires explicit approval — do NOT run yet)

DNS is done (A record live, no AAAA).
Remaining steps, in order — `nginx -t` must pass before every reload:
1. On the VPS: `mkdir -p /opt/wolfmark-spendsense-feed/state
   /var/www/spendsense.wolfmark.co.uk/feed/v1`; clone the repo to
   `/opt/wolfmark-spendsense-feed/repo`; copy `news-feed/curated.json`
   to `.../state/curated.json`; set `root:root 0700` on state and
   `root:www-data 0755` on the document root; create
   `/var/lib/spendsense-feed` owned `www-data:www-data 0750` for the
   temporary count log.
2. Install the GeoIP2 module (`apt install libnginx-mod-http-geoip2`) and
   download GeoLite2-Country.mmdb (free vendor licence) to
   `/usr/share/GeoIP/`; confirm the module loads.
3. Install `vps/spendsense-feed-http.conf` to `/etc/nginx/conf.d/` plus
   the HTTP-only bootstrap vhost from
   `vps/spendsense.wolfmark.co.uk.bootstrap.nginx` (sites-available +
   symlink), run `nginx -t`, reload once.
4. Issue TLS: `certbot certonly --webroot -w /var/www/certbot -d
   spendsense.wolfmark.co.uk`.
5. Replace the bootstrap with the full HTTPS vhost from
   `vps/spendsense.wolfmark.co.uk.nginx`, run `nginx -t`, reload.
6. Publish the first feed by hand (no timers yet):
   `FEED_ROOT=/opt/wolfmark-spendsense-feed
   FEED_WEBROOT=/var/www/spendsense.wolfmark.co.uk
   FEED_PYTHON=/usr/bin/python3 sh
   /opt/wolfmark-spendsense-feed/repo/news-feed/collect.sh`
   (first run has no diff baseline; curated-only content is expected).
7. Fetch `https://spendsense.wolfmark.co.uk/feed/v1/news.json` and confirm
   200, JSON content type, cache headers, and schema-valid content.
8. Fetch once more and confirm the temp count log holds exactly one
   `METHOD STATUS COUNTRY` line per request — and nothing is written to
   `/var/log/nginx/` for this host.
9. Install and enable both timers (daemon-reload first):
   `systemctl enable --now wolfmark-spendsense-feed.timer
   wolfmark-spendsense-feed-aggregate.timer`.
10. Add the Uptime Kuma HTTPS check for the feed URL, using the HEAD
    method so monitoring stays out of the GET totals.

## Rollback

The previous live feed is kept at
`/opt/wolfmark-spendsense-feed/state/news.json.prev` (outside the web
root). To restore it:

```sh
cp /opt/wolfmark-spendsense-feed/state/news.json.prev /tmp/rollback-news.json
mv /tmp/rollback-news.json /var/www/spendsense.wolfmark.co.uk/feed/v1/news.json
```

To pause publication without removing the endpoint: `systemctl disable
--now wolfmark-spendsense-feed.timer`; the last good feed keeps serving.
To pause counting too, disable the aggregate timer and comment out the
feed location's `access_log` line (`nginx -t`, reload), then truncate the
temp log. To withdraw the endpoint entirely, also remove the Nginx site +
symlink (`nginx -t`, reload) and the `feed/` directory. Existing VPS
services and Hermes are untouched by all of this: separate unit names,
separate paths, no shared state.

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
