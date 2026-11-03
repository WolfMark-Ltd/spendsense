#!/bin/sh
# Spend Sense Model News — weekly collection and publication.
#
# Fetches a models.dev snapshot, rebuilds the public feed (carrying recent
# history forward), validates it with the same client rules the plugin uses,
# and atomically publishes it. ANY failure exits non-zero WITHOUT touching
# the live feed, so the prior good feed always survives a bad run.
#
# Silent on success (cron mails only failures when MAILTO is set). One
# operational line per run goes to state/collect.log; no visitor data exists
# anywhere in this pipeline.
#
# Layout (all overridable for local validation):
#   $FEED_ROOT/repo    checked-out spendsense repository (this script lives in repo/news-feed/)
#   $FEED_ROOT/state   curated.json, snapshots, rollback copy, run log
#   $FEED_WEBROOT      subdomain document root (created at activation)
set -eu

REPO="$(cd "$(dirname "$0")/.." && pwd)"
FEED_ROOT="${FEED_ROOT:-$HOME/spendsense-feed}"
STATE="$FEED_ROOT/state"
STAGING="$STATE/staging"
WEBROOT="${FEED_WEBROOT:-$HOME/spendsense.wolfmark.co.uk}"
LIVE="$WEBROOT/feed/v1/news.json"
ROLLBACK="$STATE/news.json.prev"
PYTHON="${FEED_PYTHON:-/usr/bin/python3}"
MODELS_URL="${MODELS_DEV_URL:-https://models.dev/api.json}"
RETAIN_DAYS="${FEED_RETAIN_DAYS:-90}"
MIN_BYTES="${FEED_MIN_BYTES:-1000000}"
MAX_FEED_BYTES=262144  # must stay within the plugin's client fetch cap

fail() {
    echo "collect: $1" >&2
    echo "$(date -u +%FT%TZ) FAIL $1" >> "$STATE/collect.log"
    exit 1
}

[ -x "$PYTHON" ] || fail "python not executable: $PYTHON"
"$PYTHON" -c 'import sys; sys.exit(sys.version_info < (3, 10))' \
    || fail "python 3.10+ required"
[ -f "$STATE/curated.json" ] || fail "missing $STATE/curated.json (seed it at activation)"
mkdir -p "$STAGING" "$WEBROOT/feed/v1"

OBSERVED="$(date -u +%Y-%m-%dT%H:%M:%S+00:00)"
NEW_SNAPSHOT="$STAGING/models-new.json"
rm -f "$NEW_SNAPSHOT"

curl -fsSL --retry 3 --retry-delay 10 --max-time 180 \
    -o "$NEW_SNAPSHOT" "$MODELS_URL" \
    || fail "models.dev download failed"
[ "$(wc -c < "$NEW_SNAPSHOT")" -ge "$MIN_BYTES" ] \
    || fail "models.dev snapshot under ${MIN_BYTES} bytes"
"$PYTHON" -c 'import json,sys; json.load(open(sys.argv[1], encoding="utf-8-sig"))' \
    "$NEW_SNAPSHOT" || fail "models.dev snapshot is not valid JSON"

PREV_ARGS=""
[ -f "$STATE/models-prev.json" ] && PREV_ARGS="--previous $STATE/models-prev.json"
PRIOR_ARGS=""
[ -f "$LIVE" ] && PRIOR_ARGS="--prior-feed $LIVE"

# shellcheck disable=SC2086
"$PYTHON" "$REPO/news-feed/generate.py" \
    --current "$NEW_SNAPSHOT" $PREV_ARGS \
    --curated "$STATE/curated.json" \
    --observed-at "$OBSERVED" $PRIOR_ARGS \
    --retain-days "$RETAIN_DAYS" \
    --out "$STAGING/feed.json" > /dev/null || fail "feed generation failed"

[ "$(wc -c < "$STAGING/feed.json")" -le "$MAX_FEED_BYTES" ] \
    || fail "generated feed exceeds ${MAX_FEED_BYTES} bytes"
FEED_CHECK="$("$PYTHON" - "$STAGING/feed.json" "$REPO" <<'EOF' || echo CHECK-FAILED
import json, sys
sys.path.insert(0, sys.argv[2])
from wolfmark_ledger.news import validate_feed
doc = json.load(open(sys.argv[1], encoding="utf-8-sig"))
feed, problems = validate_feed(doc)
if feed is None or problems:
    print("CHECK-FAILED " + "; ".join(problems), file=sys.stderr)
    sys.exit(1)
print(f"items={len(feed['items'])}")
EOF
)"
[ "$FEED_CHECK" != "CHECK-FAILED" ] && [ -n "$FEED_CHECK" ] \
    || fail "generated feed failed client validation"

[ -f "$LIVE" ] && cp -p "$LIVE" "$ROLLBACK"
chmod 0644 "$STAGING/feed.json"  # world-readable under restrictive umasks
mv "$STAGING/feed.json" "$LIVE"
mv "$NEW_SNAPSHOT" "$STATE/models-prev.json"

echo "$(date -u +%FT%TZ) OK $FEED_CHECK retain=${RETAIN_DAYS}d" >> "$STATE/collect.log"
tail -200 "$STATE/collect.log" > "$STAGING/collect.log" && mv "$STAGING/collect.log" "$STATE/collect.log"
exit 0
