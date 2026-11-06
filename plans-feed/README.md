# Spend Sense public plans feed

Spend Sense can optionally download public subscription-plan data for its membership interface. This page documents the public consumer contract; server-side collection and publication are maintained separately.

## Endpoint and schema

- Endpoint: `https://spendsense.wolfmark.co.uk/feed/v1/plans.json`
- Schema: [schema.json](schema.json), version 1
- Catalogue source: [../catalogue/plans.json](../catalogue/plans.json)

The feed publishes current plans with their verification state. Retired plans are withheld so the plugin can ask members to reconfirm a stored plan. The public plan catalogue remains the source of plan details.

The request contains no local usage history, account identifiers, membership records or credentials. The plugin validates each response before showing it and keeps locally stored membership data under the user's control.
