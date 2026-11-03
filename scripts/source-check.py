#!/usr/bin/env python3
"""Diff live catalogue sources against the reviewed baselines.

Read-only against the catalogue tree: writes one candidate report plus
candidate baselines for human review, and never commits, publishes, or
touches the live catalogue. Standard library only.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from wolfmark_ledger.source_check import main

if __name__ == "__main__":
    raise SystemExit(main())
