#!/usr/bin/env python3
"""Build the public Model News feed. Thin wrapper over wolfmark_ledger.news_feed.

Usage:
    python news-feed/generate.py --current models-new.json --previous models-old.json \\
        --curated news-feed/curated.json --out news-feed/feed.json
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from wolfmark_ledger.news_feed import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(main())
