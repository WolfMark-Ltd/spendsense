#!/usr/bin/env bash
# Default to browserless checks; Chromium acceptance is an explicit opt-in.
set -euo pipefail
cd "$(dirname "$0")/.."
exec node scripts/node-tests.mjs "$@"
