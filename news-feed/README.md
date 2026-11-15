# Spend Sense Model News feed

Spend Sense can optionally download public Model News announcements. This page documents the public consumer contract; server-side collection and publication are maintained separately.

## Endpoint and schema

- Endpoint: `https://spendsense.wolfmark.co.uk/feed/v1/news.json`
- Schema: [schema.json](schema.json), version 1
- Sample: [fixtures/sample-feed.json](fixtures/sample-feed.json)

The feed contains public catalogue changes and curated public announcements. The plugin validates each response and keeps local catalogue news working when Live Updates is disabled or unavailable.

## Editorial briefing

`items` is the complete event list. The document may also carry a `briefing`
object: the same events curated once for every client into ranked sections
(biggest reductions, biggest increases, mixed price changes, new models, newly
available, removals, subscriptions, preview models), each entry carrying a
message code, its parameters, the exact provider and model identity, the source
link and the confidence.

The briefing is a presentation layer over the events, not a second source of
truth: every entry references the `items` it came from by `event_id`. It is
optional and may be absent when the document would exceed the client's size cap,
in which case clients render `items` as before. `briefing.unsupported` names any
section the publisher cannot evidence — a missing section is never a claim of
"nothing happened". See [../docs/model-news-editorial.md](../docs/model-news-editorial.md)
for the evidence rules behind each event type.

## Privacy

The request contains no local usage history, account identifiers, membership data, credentials or tracking token. As with any HTTPS request, the service can see standard connection metadata such as the source IP address. The service may derive anonymous aggregate request statistics, including approximate country-level totals; those statistics are not linked to plugin usage or an account.
