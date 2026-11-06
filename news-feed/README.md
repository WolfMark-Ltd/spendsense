# Spend Sense Model News feed

Spend Sense can optionally download public Model News announcements. This page documents the public consumer contract; server-side collection and publication are maintained separately.

## Endpoint and schema

- Endpoint: `https://spendsense.wolfmark.co.uk/feed/v1/news.json`
- Schema: [schema.json](schema.json), version 1
- Sample: [fixtures/sample-feed.json](fixtures/sample-feed.json)

The feed contains public catalogue changes and curated public announcements. The plugin validates each response and keeps local catalogue news working when Live Updates is disabled or unavailable.

## Privacy

The request contains no local usage history, account identifiers, membership data, credentials or tracking token. As with any HTTPS request, the service can see standard connection metadata such as the source IP address. The service may derive anonymous aggregate request statistics, including approximate country-level totals; those statistics are not linked to plugin usage or an account.
