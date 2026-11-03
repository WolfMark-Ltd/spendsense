#!/bin/sh
# Spend Sense membership plans — manual collection and publication.
#
# Rebuilds the public plans feed from the approved in-repo catalogue,
# validates it with the same client rules the plugin uses, and atomically
# publishes it. ANY failure exits non-zero WITHOUT touching the live feed,
# so the prior good feed always survives a bad run.
#
# Run by the operator after approving a catalogue/plans.json change.
# Silent on success. One operational line per run goes to
# state/plans-collect.log. A directory lock serialises runs.
#
# Layout (all overridable for local validation):
#   $FEED_ROOT/repo    checked-out spendsense repository (this script lives in repo/plans-feed/)
#   $FEED_ROOT/state   rollback copy, run log
#   $FEED_WEBROOT      subdomain document root (created at activation)
set -eu

REPO="$(cd "$(dirname "$0")/.." && pwd)"
FEED_ROOT="${FEED_ROOT:-$HOME/spendsense-feed}"
STATE="$FEED_ROOT/state"
STAGING="$STATE/staging"
WEBROOT="${FEED_WEBROOT:-$HOME/spendsense.wolfmark.co.uk}"
LIVE="$WEBROOT/feed/v1/plans.json"
LIVE_TMP="$WEBROOT/feed/v1/.plans.json.new"
ROLLBACK="$STATE/plans.json.prev"
LOCKDIR="$STATE/plans-collect.lock"
PYTHON="${FEED_PYTHON:-/usr/bin/python3}"
MAX_FEED_BYTES=262144  # must stay within the plugin's client fetch cap

fail() {
    echo "collect: $1" >&2
    echo "$(date -u +%FT%TZ) FAIL $1" >> "$STATE/plans-collect.log"
    exit 1
}

# The lock mkdir goes through Python's os.mkdir rather than mkdir(1):
# coreutils mkdir 9.5 has been observed to exit 0 after a racy EEXIST,
# which would let two runs hold the lock at once. (Same discipline as
# news-feed/collect.sh; no stale recovery here — a wedged lock is removed
# by the operator, loudly, via the failure message.)
lock_mkdir() {
    "$PYTHON" -c 'import os, sys; os.mkdir(sys.argv[1])' "$1" 2>/dev/null
}

mkdir -p "$STATE"
[ -x "$PYTHON" ] || fail "python not executable: $PYTHON"
"$PYTHON" -c 'import sys; sys.exit(sys.version_info < (3, 10))' \
    || fail "python 3.10+ required"
lock_mkdir "$LOCKDIR" || fail "another run holds the lock (remove $LOCKDIR if stale)"
# Trap only after acquiring: a refused run must never touch the holder's lock.
trap 'rmdir "$LOCKDIR" 2>/dev/null || :; rm -f "$LIVE_TMP" 2>/dev/null || :' EXIT
trap 'exit 1' INT TERM

[ -f "$REPO/catalogue/plans.json" ] || fail "missing $REPO/catalogue/plans.json"
mkdir -p "$STAGING" "$WEBROOT/feed/v1" || fail "cannot create staging or webroot directories"

OBSERVED="$(date -u +%Y-%m-%dT%H:%M:%S+00:00)"
"$PYTHON" "$REPO/plans-feed/generate.py" \
    --catalogue "$REPO/catalogue/plans.json" \
    --generated-at "$OBSERVED" \
    --out "$STAGING/plans.json" > /dev/null || fail "feed generation failed"

[ "$(wc -c < "$STAGING/plans.json")" -le "$MAX_FEED_BYTES" ] \
    || fail "generated feed exceeds ${MAX_FEED_BYTES} bytes"
FEED_CHECK="$("$PYTHON" - "$STAGING/plans.json" "$REPO" <<'EOF' || echo CHECK-FAILED
import json, sys
sys.path.insert(0, sys.argv[2])
from wolfmark_ledger.membership_live import validate_feed
doc = json.load(open(sys.argv[1], encoding="utf-8-sig"))
feed, problems = validate_feed(doc)
if feed is None or problems:
    print("CHECK-FAILED " + "; ".join(problems), file=sys.stderr)
    sys.exit(1)
print(f"plans={len(feed['plans'])}")
EOF
)"
[ "$FEED_CHECK" != "CHECK-FAILED" ] && [ -n "$FEED_CHECK" ] \
    || fail "generated feed failed client validation"

if [ -f "$LIVE" ]; then
    cp -p "$LIVE" "$ROLLBACK" || fail "cannot copy live feed to rollback"
fi
# Stage beside LIVE so the final rename never crosses filesystems: a rename
# within one directory is atomic, while a cross-device mv would copy (readers
# could see partial JSON, and a failed copy could take the live feed with it).
cp -p "$STAGING/plans.json" "$LIVE_TMP" || fail "staging to live directory failed"
chmod 0644 "$LIVE_TMP" || fail "cannot set feed permissions"  # world-readable under restrictive umasks
mv "$LIVE_TMP" "$LIVE" || fail "atomic feed publication failed"

echo "$(date -u +%FT%TZ) OK $FEED_CHECK" >> "$STATE/plans-collect.log" \
    || fail "cannot write run log"
tail -200 "$STATE/plans-collect.log" > "$STAGING/plans-collect.log" && mv "$STAGING/plans-collect.log" "$STATE/plans-collect.log" \
    || fail "cannot rotate run log"
exit 0
