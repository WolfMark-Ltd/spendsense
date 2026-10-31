#!/usr/bin/env bash
# Demonstration: one catalogue change through discovery → diff → stage →
# validate → review → approve (one accepted, one rejected) → activate →
# rollback. Runs against a throwaway copy of the catalogue and the committed
# fixtures, so the repository's active catalogue is never touched.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
EMPTY="$(mktemp -d)"
export WORK
trap 'rm -rf "$WORK" "$EMPTY"' EXIT

cp -a "$REPO/catalogue/." "$WORK/"
rm -rf "$WORK/revisions" "$WORK/history"
CLI=(python3 "$REPO/scripts/catalogue-maintain.py" --catalogue-dir "$WORK")
FIX="$REPO/test/fixtures/catalogue"

banner() { printf '\n=== %s ===\n' "$1"; }
version() { python3 -c "import json,os;print(json.load(open(os.environ['WORK']+'/plans.json'))['catalogue_version'])"; }
price() {
  python3 - "$1" <<'PRICE'
import json, os, sys
doc = json.load(open(os.environ["WORK"] + "/plans.json"))
p = next(x for x in doc["plans"] if x["id"] == sys.argv[1])
print(f"  {sys.argv[1]} = {p['price']['amount']} {p['price']['currency']}/{p['price']['period']}"
      f" ({p['verification']['status']})")
PRICE
}
sha() { sha256sum "$WORK/plans.json" | cut -d' ' -f1; }

banner "0. starting state"
echo "active version: $(version)"
price opencode-go.go
price opencode-go.go-plus
ACTIVE_BEFORE="$(sha)"
echo "plans.json sha256: ${ACTIVE_BEFORE:0:16}…"

banner "1. discovery — the approved catalogue still matches its sources"
"${CLI[@]}" --fixtures "$FIX/baseline" check

banner "2. diff — the vendor pages now differ"
"${CLI[@]}" --fixtures "$FIX/demo-change" check

banner "2b. a plan missing from a complete source is a material removal"
"${CLI[@]}" --fixtures "$FIX/demo-reject" check | sed -n '/change(s)/,$p'

banner "2c. a source we could not read proves nothing: every apparent removal is ambiguous"
"${CLI[@]}" --fixtures "$EMPTY" check | sed -n '/change(s)/,$p' | head -6

banner "3. stage — a proposed revision, active file untouched"
"${CLI[@]}" --fixtures "$FIX/demo-change" stage --note "demo: vendor price movement" | tee "$WORK/stage.txt"
REV="$(grep -o 'rev-[0-9TZ]*-[0-9a-f]*' "$WORK/stage.txt" | head -1)"
echo "revision: $REV"
echo "plans.json unchanged: $([ "$(sha)" = "$ACTIVE_BEFORE" ] && echo yes || echo NO)"

banner "4. validation refuses an undecided financial change"
"${CLI[@]}" validate "$REV"; echo "exit=$?"
"${CLI[@]}" activate "$REV" --by mark; echo "exit=$?"

banner "5. review"
"${CLI[@]}" review "$REV"

banner "6. approval — accept one price, reject the other"
"${CLI[@]}" approve "$REV" --by mark --note "accept the Go rise, reject Go Plus pending a second source" \
  --accept price_changed:opencode-go.go \
  --reject price_changed:opencode-go.go-plus; echo "exit=$?"
"${CLI[@]}" validate "$REV"; echo "exit=$?"

banner "7. dry-run activation"
"${CLI[@]}" activate "$REV" --by mark --dry-run
echo "plans.json unchanged: $([ "$(sha)" = "$ACTIVE_BEFORE" ] && echo yes || echo NO)"

banner "8. activation"
"${CLI[@]}" activate "$REV" --by mark
echo "active version: $(version)"
price opencode-go.go
price opencode-go.go-plus
echo "  ^ the accepted change landed; the rejected one kept the approved value"

banner "9. rollback"
"${CLI[@]}" rollback 2026-10-31.1 --by mark --reason "revert the demonstration"
echo "active version: $(version)"
price opencode-go.go
price opencode-go.go-plus

banner "10. audit trail"
"${CLI[@]}" status
