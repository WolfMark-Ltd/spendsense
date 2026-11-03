#!/bin/sh
# Spend Sense Model News — scheduled collection and publication.
#
# Fetches a models.dev snapshot, rebuilds the public feed (carrying recent
# history forward), validates it with the same client rules the plugin uses,
# and atomically publishes it. ANY failure exits non-zero WITHOUT touching
# the live feed, so the prior good feed always survives a bad run.
#
# Silent on success (failures surface via the service journal). One
# operational line per run goes to state/collect.log; no visitor data exists
# anywhere in this pipeline. A directory lock serialises runs: systemd
# already prevents overlapping timer starts, and the lock also covers
# manual runs sharing the same staging files.
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
LIVE_TMP="$WEBROOT/feed/v1/.news.json.new"
ROLLBACK="$STATE/news.json.prev"
LOCKDIR="$STATE/collect.lock"
RECOVERING="$STATE/collect.recovering"
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

# The lock mkdir goes through Python's os.mkdir rather than mkdir(1):
# coreutils mkdir 9.5 has been observed to exit 0 after a racy EEXIST
# (strace-proven: the syscall fails, the binary reports success), which
# would let two runs hold the lock at once. The syscall reports truthfully.
lock_mkdir() {
    "$PYTHON" -c 'import os, sys; os.mkdir(sys.argv[1])' "$1" 2>/dev/null
}

# Directory lock with stale recovery: a reboot or SIGKILL leaves the lock
# behind with no trap running, which would refuse every later run. A lock
# whose recorded pid is dead is removed and retried once; an unreadable
# pid means a holder we cannot verify, so refuse and let the next run retry.
# Stale recovery itself is serialised by a second dir: without it, two runs
# could both read the same dead pid, clear each other's fresh lock, and
# both proceed. The recovery dir has no recovery of its own (a crash in
# that microsecond window only wedges the recovery path, loudly).
acquire_lock() {
    if lock_mkdir "$LOCKDIR"; then
        if ! echo $$ > "$LOCKDIR/pid"; then
            rmdir "$LOCKDIR" 2>/dev/null || :
            return 1
        fi
        return 0
    fi
    lock_pid="$(cat "$LOCKDIR/pid" 2>/dev/null || true)"
    case "$lock_pid" in
        ''|*[!0-9]*) return 1 ;;
    esac
    if kill -0 "$lock_pid" 2>/dev/null; then
        return 1
    fi
    lock_mkdir "$RECOVERING" || return 1
    rm -f "$LOCKDIR/pid" 2>/dev/null || :
    if ! rmdir "$LOCKDIR" 2>/dev/null; then
        rmdir "$RECOVERING" 2>/dev/null || :
        return 1
    fi
    if ! lock_mkdir "$LOCKDIR"; then
        rmdir "$RECOVERING" 2>/dev/null || :
        return 1
    fi
    if ! echo $$ > "$LOCKDIR/pid"; then
        rmdir "$LOCKDIR" 2>/dev/null || :
        rmdir "$RECOVERING" 2>/dev/null || :
        return 1
    fi
    rmdir "$RECOVERING" 2>/dev/null || :
    return 0
}

mkdir -p "$STATE"
[ -x "$PYTHON" ] || fail "python not executable: $PYTHON"
"$PYTHON" -c 'import sys; sys.exit(sys.version_info < (3, 10))' \
    || fail "python 3.10+ required"
acquire_lock || fail "another run holds the lock (remove $LOCKDIR and $RECOVERING if stale)"
# Trap only after acquiring: a refused run must never touch the holder's lock.
# Each step is '|| :'-guarded: under 'set -e' a failing rmdir (e.g. the lock
# already removed) would otherwise abort the trap and override our exit status.
# Signals exit through the EXIT trap, so cleanup runs exactly once at exit
# instead of inline with the pipeline continuing unlocked afterwards.
trap 'rm -f "$LOCKDIR/pid" 2>/dev/null || :; rmdir "$LOCKDIR" 2>/dev/null || :; rm -f "$LIVE_TMP" 2>/dev/null || :' EXIT
trap 'exit 1' INT TERM

[ -f "$STATE/curated.json" ] || fail "missing $STATE/curated.json (seed it at activation)"
mkdir -p "$STAGING" "$WEBROOT/feed/v1" || fail "cannot create staging or webroot directories"

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

# Build the generator argv with positional parameters so state paths containing
# spaces survive intact (an unquoted $ARGS string would word-split them and
# fail argument parsing).
set -- --current "$NEW_SNAPSHOT"
[ -f "$STATE/models-prev.json" ] && set -- "$@" --previous "$STATE/models-prev.json"
set -- "$@" --curated "$STATE/curated.json" --observed-at "$OBSERVED"
[ -f "$LIVE" ] && set -- "$@" --prior-feed "$LIVE"
set -- "$@" --retain-days "$RETAIN_DAYS" --out "$STAGING/feed.json"
"$PYTHON" "$REPO/news-feed/generate.py" "$@" > /dev/null || fail "feed generation failed"

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

if [ -f "$LIVE" ]; then
    cp -p "$LIVE" "$ROLLBACK" || fail "cannot copy live feed to rollback"
fi
# Stage beside LIVE so the final rename never crosses filesystems: a rename
# within one directory is atomic, while a cross-device mv would copy (readers
# could see partial JSON, and a failed copy could take the live feed with it).
cp -p "$STAGING/feed.json" "$LIVE_TMP" || fail "staging to live directory failed"
chmod 0644 "$LIVE_TMP" || fail "cannot set feed permissions"  # world-readable under restrictive umasks
mv "$LIVE_TMP" "$LIVE" || fail "atomic feed publication failed"
mv "$NEW_SNAPSHOT" "$STATE/models-prev.json" || fail "cannot rotate snapshot"

echo "$(date -u +%FT%TZ) OK $FEED_CHECK retain=${RETAIN_DAYS}d" >> "$STATE/collect.log" \
    || fail "cannot write run log"
tail -200 "$STATE/collect.log" > "$STAGING/collect.log" && mv "$STAGING/collect.log" "$STATE/collect.log" \
    || fail "cannot rotate run log"
exit 0
