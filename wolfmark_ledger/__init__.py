"""WolfMark Cost Ledger backend.

Read-only aggregation of Hermes' own usage ledger (``state.db``) with a
provider-aware price book. No writes, no network, no message content.

The package is deliberately stdlib-only so the aggregation and pricing logic
can be unit-tested without the gateway, FastAPI or a live database.
"""

from .aggregate import build_event_period, build_ledger_report, build_report  # noqa: F401
from .db import LedgerUnavailable, default_db_path, fetch_usage_rows  # noqa: F401
from .pricing import Catalogue, load_catalogue  # noqa: F401

__all__ = [
    "Catalogue",
    "LedgerUnavailable",
    "build_event_period",
    "build_ledger_report",
    "build_report",
    "default_db_path",
    "fetch_usage_rows",
    "load_catalogue",
]
