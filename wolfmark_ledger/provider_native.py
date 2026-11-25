"""Provider-native pricing: effective and list rates read from the provider.

Some serving routes have no models.dev catalogue card at all (Nous is the live
example), and even priced cards can miss the exact dated variant a route
records. Hermes already resolves per-credential pricing for exactly those
providers (``hermes_cli.models_pricing.get_pricing_for_provider``), returning
the provider's own per-model price rows from its native API.

A provider price row carries two different bases, and both are the provider's
own statement:

* the row's ``prompt`` / ``completion`` / ``input_cache_read`` rates are what
  the provider bills on this credential — the *effective* rates. For Nous
  these are the discounted credits rates, verified to the tenth decimal
  against a provider usage export on 2026-11-25;
* the optional ``original`` block is the provider's undiscounted *list*
  pricing (verified equal to the portal's published list for Nous).

Neither figure is invented here and no discount is hardcoded: the
effective/list split comes verbatim from the provider's row. SpendSense
precedence is unchanged above this source: official verified overlay > route
catalogue card (Hermes models.dev cache, then bundled) > provider-native rows
> opt-in third-party/approximate. Provider-native rows only fill gaps.

Import and network behaviour: ``hermes_cli`` is imported lazily and guarded —
when it is unavailable (CI, bare probes, plugin probes without the host app)
the resolver reports unavailable and pricing falls through exactly as before.
Reads are ``cached_only`` (never provider I/O) whenever a cache entry exists;
when none does, one bounded fetch runs per TTL window against the free
provider metadata endpoint — no inference usage, no credential logging.
"""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from typing import Any, Optional

from .pricing import Rate

# One refresh attempt per provider per window. Hermes' own per-credential
# catalog cache enforces its TTL underneath this; the marker here only stops a
# cold cache from re-dialing on every row of a large report.
NATIVE_TTL_SECONDS = 300.0
SOURCE_LABEL = "provider-native rates"

_lock = threading.Lock()
_import_failed = False          # hermes_cli unavailable in this process
_last_fetch_attempt: dict[str, float] = {}
_missing_provider: set[str] = set()   # providers with no native pricing source


@dataclass(frozen=True)
class NativeRate:
    """One provider-native price row, per-token strings scaled to $/MTok."""

    provider: str
    model: str
    input: float                        # effective (billed) input, $/MTok
    output: float                       # effective (billed) output, $/MTok
    cache_read: Optional[float]         # effective cache-read, $/MTok
    list_input: Optional[float] = None  # provider-published list ("original")
    list_output: Optional[float] = None
    list_cache_read: Optional[float] = None
    as_of: str = ""

    def list_rate(self) -> Optional[Rate]:
        """The row's list basis, when the provider publishes one."""
        if self.list_input is None or self.list_output is None:
            return None
        return Rate(input=self.list_input, output=self.list_output,
                    cache_read=self.list_cache_read, cache_write=None)

    def effective_rate(self) -> Rate:
        """The row's effective (billed) basis."""
        return Rate(input=self.input, output=self.output,
                    cache_read=self.cache_read, cache_write=None)


def unavailable() -> bool:
    """True when the Hermes resolver cannot be used in this process."""
    return _import_failed


def reset_for_tests() -> None:
    """Clear module state (test isolation only)."""
    global _import_failed
    with _lock:
        _import_failed = False
        _last_fetch_attempt.clear()
        _missing_provider.clear()


def _resolver():
    """The Hermes pricing resolver, or None when the host app is absent."""
    global _import_failed
    try:
        from hermes_cli.models_pricing import get_pricing_for_provider
        return get_pricing_for_provider
    except Exception:
        with _lock:
            _import_failed = True
        return None


def _per_mtok(value: Any) -> Optional[float]:
    """A provider per-token price string/number as $/MTok; None when absent."""
    if value is None or isinstance(value, bool):
        return None
    try:
        return float(value) * 1_000_000.0
    except (TypeError, ValueError):
        return None


def _native_rates(provider: str, *, allow_fetch: bool) -> dict[str, dict[str, Any]]:
    """The provider's native price rows, or ``{}`` when unavailable."""
    key = provider.strip().lower()
    if not key or key in _missing_provider:
        return {}
    resolver = _resolver()
    if resolver is None:
        return {}
    with _lock:
        last = _last_fetch_attempt.get(key)
        fresh = last is not None and (time.monotonic() - last) < NATIVE_TTL_SECONDS
        need_fetch = allow_fetch and not fresh
        if need_fetch:
            _last_fetch_attempt[key] = time.monotonic()
    if need_fetch:
        try:
            rows = resolver(key, force_refresh=False) or {}
        except Exception:
            rows = {}
    else:
        try:
            rows = resolver(key, cached_only=True) or {}
        except Exception:
            rows = {}
    if not rows:
        # One probe per provider per process: get_pricing_for_provider
        # returns {} for every provider without a native pricing source.
        with _lock:
            _missing_provider.add(key)
    return rows


def _row_rate(provider: str, model: str, row: dict[str, Any], as_of: str) -> Optional[NativeRate]:
    if not isinstance(row, dict):
        return None
    eff_in = _per_mtok(row.get("prompt"))
    eff_out = _per_mtok(row.get("completion"))
    if eff_in is None and eff_out is None:
        return None
    raw_original = row.get("original")
    original: dict[str, Any] = raw_original if isinstance(raw_original, dict) else {}
    return NativeRate(
        provider=provider,
        model=model,
        input=eff_in if eff_in is not None else 0.0,
        output=eff_out if eff_out is not None else 0.0,
        cache_read=_per_mtok(row.get("input_cache_read")),
        list_input=_per_mtok(original.get("prompt")),
        list_output=_per_mtok(original.get("completion")),
        list_cache_read=_per_mtok(original.get("input_cache_read")),
        as_of=as_of,
    )


def lookup(provider: str, model: str, *, allow_fetch: bool = True) -> Optional[NativeRate]:
    """One route's provider-native price row, by explicit model identity.

    Exact ids match exactly; a namespaced id may also match its bare suffix,
    mirroring the catalogue's own two-candidate convention. ``None`` when the
    provider has no native source, the model is absent, or the host resolver
    is unavailable — callers keep their existing unpriced handling.
    """
    route = (provider or "").strip()
    name = (model or "").strip()
    if not route or not name:
        return None
    rows = _native_rates(route, allow_fetch=allow_fetch)
    if not rows:
        return None
    for candidate in (name, name.split("/")[-1] if "/" in name else name):
        row = rows.get(candidate)
        if row is not None:
            return _row_rate(route, candidate, row, time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
    return None
