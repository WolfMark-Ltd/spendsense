#!/usr/bin/env bash
# Default to browserless checks; Chromium acceptance is an explicit opt-in.
set -euo pipefail
cd "$(dirname "$0")/.."
if (($# == 0)); then set -- browserless; fi
exec "${SPENDSENSE_PYTHON:-python3}" scripts/managed-tests.py "$@"
