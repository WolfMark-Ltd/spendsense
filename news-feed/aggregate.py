#!/usr/bin/env python3
"""Aggregate feed country counts. Thin wrapper over wolfmark_ledger.feed_counts.

Usage:
    python news-feed/aggregate.py --counts /var/lib/spendsense-feed/count.tmp.log \
        --totals /opt/wolfmark-spendsense-feed/state/country-daily.json [--no-reopen]
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from wolfmark_ledger.feed_counts import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(main())
