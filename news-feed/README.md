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
| `curated.json` | Curated subscription/allowance announcements. Starts empty; entries are transcribed verbatim. |
| `curated.example.json` | Entry shape example. Never read by the generator. |
| `fixtures/sample-feed.json` | Sample feed for tests and docs. Invented examples, not real announcements. |

The generator logic lives in `wolfmark_ledger/news_feed.py` so the test suite
covers it; `generate.py` only wires the repo path to the CLI.

## Building a release

1. Download a models.dev snapshot (pinned, reviewable input):
   `curl -sSL https://models.dev/api.json -o models-YYYY-MM-DD.json`
2. Review `curated.json`: every entry needs a provider, a summary and an
   https `source_url` the reader can check. Never invent a change. If the
   effective date or the new allowance cannot be established from the
   source, leave that field out and say so in `conditions`.
3. Generate deterministically:
   `python news-feed/generate.py --current models-new.json --previous models-old.json --curated news-feed/curated.json --observed-at 2026-11-03T00:00:00+00:00 --out feed.json`
   (Omit `--previous` on the first run; the model diff is then skipped.)
4. Sanity-check: `feed.json` must contain no user-specific information —
   only providers, models, public prices, dates, sources and provenance.
5. Publish `feed.json` at the fixed plugin URL
   `https://spendsense.wolfmark.co.uk/feed/v1/news.json`
   (see `FEED_URL` in `wolfmark_ledger/news.py`; not yet deployed).

A weekly rebuild is plenty; the plugin caches each fetch for 6 hours.

## Serving configuration (nginx)

Static file, long cache headers, and no request logging for the feed
location:

```nginx
server {
    listen 443 ssl;
    server_name spendsense.wolfmark.co.uk;

    location = /feed/v1/news.json {
        alias /srv/spendsense/feed/v1/news.json;
        default_type application/json;
        add_header Cache-Control "public, max-age=21600" always;
        access_log off;  # no per-request visitor logs for the feed
    }
}
```

Keep `access_log off` for this location and do not add analytics,
per-client rate-limit logs, or any processing that stores requester
details. TLS session tickets, if enabled, should rotate routinely.

## Privacy and connection metadata, stated honestly

- The plugin sends an unauthenticated GET with static headers (`Accept`,
  `User-Agent: SpendSense-News`) and no query string, cookies, user IDs,
  accounts, credentials, model lists, usage totals or tracking tokens.
- Enabling the service necessarily involves an HTTPS request whose
  **source IP is visible to the server** at the TCP/TLS layer. On a remote
  Hermes host, that host's address makes the request, not the Desktop machine.
- With the configuration above the server retains no per-request feed logs,
  but transient connection metadata (source IP, timing, TLS handshake) is
  unavoidably visible while the request is served, and network operators
  between the client and the server can observe that a connection happened.
- The feed carries no executable code; the plugin never executes, evaluates
  or self-updates from it.

## Catalogue security note

The plugin reads this feed through its own Python backend over plain
HTTPS with a 10 s timeout and a 256 KiB size cap, validates the schema,
and keeps working locally when the feed is unreachable. No credentials or
Hermes internals are involved.
