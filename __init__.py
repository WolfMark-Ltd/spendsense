"""Spend Sense — Hermes plugin package.

The desktop UI lives in ``desktop/plugin.js``; the read-only backend is the
dashboard router in ``dashboard/plugin_api.py`` with the aggregation package in
``wolfmark_ledger/``. This module registers the observer-only usage collector.
"""

from __future__ import annotations

import logging
from typing import Any

log = logging.getLogger(__name__)


def register(ctx: Any) -> None:
    """Register the observer-only usage collector.

    The dashboard router and desktop plugin are the read surfaces; this half
    records per-call accounting metadata from Hermes' supported observer hooks.
    A missing hook API or a storage failure must never block the agent.
    """
    try:
        try:
            from .wolfmark_ledger.collector import install
        except ImportError:
            # Hermes' isolated capability probe loads this file as a top-level
            # module; a normal plugin load uses the package-relative import.
            import sys
            from pathlib import Path

            sys.path.insert(0, str(Path(__file__).resolve().parent))
            from wolfmark_ledger.collector import install

        install(ctx)
    except Exception:
        log.warning("spend-sense: collector registration failed; continuing", exc_info=True)
