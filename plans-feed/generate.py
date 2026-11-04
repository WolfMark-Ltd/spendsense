#!/usr/bin/env python3
"""Build the public membership-plan feed. Thin wrapper over wolfmark_ledger.plans_feed.

Usage:
    python plans-feed/generate.py --out plans-feed/feed.json
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from wolfmark_ledger.plans_feed import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(main())
