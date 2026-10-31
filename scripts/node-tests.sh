#!/usr/bin/env bash
# Node suites. --test-force-exit is needed by test/membership-scope.test.mjs:
# it renders React in jsdom, and React's scheduler leaves MessagePort handles
# open, which keeps node's runner waiting after the last test has reported.
set -euo pipefail
cd "$(dirname "$0")/.."
exec node --test --test-force-exit test/*.mjs "$@"
