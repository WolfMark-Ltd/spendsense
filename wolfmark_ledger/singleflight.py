"""Bounded in-flight deduplication for expensive SpendSense reports.

One leader computes; concurrent identical requests wait for and share its
result instead of each burning seconds of GIL-bound aggregation. Retries
that arrive while the original computation is still running therefore add
no load — they attach to the in-flight result.

Scope and safety rules (all enforced by key construction at the call site):

* the key must capture every input that affects the bytes: endpoint,
  resolved store paths (never share across homes), all query params, the
  frozen route arrangements, and the computed window START — never a raw
  wall-clock timestamp or the window end (windows end exactly at ``now``,
  so keying on either would defeat retries, the main pileup source);
  followers therefore share the leader's snapshot with staleness bounded
  by the in-flight overlap; the next request recomputes fresh;
* followers receive the leader's result object unchanged (including its
  ``as_of``/``generated_at`` stamps, which truthfully record when the
  shared computation ran);
* a leader exception is shared with current waiters, then the entry is
  dropped so the next request retries fresh — failures are never cached;
* entries are removed the moment the leader finishes; at most
  ``max_entries`` are tracked and beyond that calls compute directly
  (fail-open). There is no queue and no backlog: at most one computation
  per distinct key, bounded additionally by the HTTP worker pool.

Sync endpoints cannot observe client disconnects (they take no ``Request``
handle), so an abandoned leader still runs to completion and a later
identical request starts a new leader. One waiter abandoning never affects
the others: waiting is a plain ``threading.Event`` wait with no shared
cancellation.
"""
from __future__ import annotations

import threading
from typing import Any, Callable, Hashable


class _Entry:
    __slots__ = ("done", "result", "error", "waiters")

    def __init__(self) -> None:
        self.done = threading.Event()
        self.result: Any = None
        self.error: BaseException | None = None
        self.waiters = 0  # followers attached (diagnostics + tests)


class SingleFlight:
    """Deduplicate concurrent identical computations within one process."""

    def __init__(self, max_entries: int = 64) -> None:
        self._lock = threading.Lock()
        self._inflight: dict[Hashable, _Entry] = {}
        self._max_entries = max(1, int(max_entries))

    def run(self, key: Hashable, fn: Callable[[], Any]) -> Any:
        """Return ``fn()``'s result, sharing one computation per key.

        The first caller for a key becomes the leader and runs ``fn``
        outside the lock; concurrent callers with an equal key block on
        the leader's event and receive its result (or exception).
        """
        with self._lock:
            entry = self._inflight.get(key)
            if entry is None:
                if len(self._inflight) >= self._max_entries:
                    leader = None  # fail-open: compute untracked
                else:
                    entry = _Entry()
                    self._inflight[key] = entry
                    leader = True
            else:
                leader = False
                entry.waiters += 1
        if leader is None:
            return fn()
        if not leader:
            entry.done.wait()
            if entry.error is not None:
                raise entry.error
            return entry.result
        try:
            result = fn()
        except BaseException as exc:  # noqa: BLE001 - shared with waiters, never cached
            with self._lock:
                entry.error = exc
                self._inflight.pop(key, None)
                entry.done.set()
            raise
        with self._lock:
            entry.result = result
            self._inflight.pop(key, None)
            entry.done.set()
        return result

    def inflight_count(self) -> int:
        """Number of computations currently shared (tests/diagnostics)."""
        with self._lock:
            return len(self._inflight)

    def waiter_count(self, key: Hashable) -> int:
        """Followers attached to ``key``'s flight, or 0 when none.

        Tests use this to wait deterministically for full attachment
        before releasing a blocking leader (no sleeps, no flakes).
        """
        with self._lock:
            entry = self._inflight.get(key)
            return entry.waiters if entry is not None else 0

    def reset_for_tests(self) -> None:
        """Drop tracked entries. Only valid when no flight is active."""
        with self._lock:
            live = [k for k, e in self._inflight.items() if not e.done.is_set()]
            if live:
                raise AssertionError(f"reset with live flights: {live!r}")
            self._inflight.clear()


#: Process-wide flight shared by the report endpoints. Keys always carry
#: the resolved store paths, so distinct homes can never share entries.
REPORT_FLIGHT = SingleFlight(max_entries=64)


def freeze(value: Any) -> Any:
    """Canonical hashable form of small param/arrangement mappings."""
    if isinstance(value, dict):
        return tuple(sorted((freeze(k), freeze(v)) for k, v in value.items()))
    if isinstance(value, (list, tuple)):
        return tuple(freeze(v) for v in value)
    if isinstance(value, (set, frozenset)):
        return tuple(sorted((freeze(v) for v in value), key=repr))
    try:
        hash(value)
    except TypeError:
        return repr(value)
    return value


def _resolved_paths(event_db: Any = None, state_db: Any = None) -> tuple[str, str]:
    """Resolve store paths exactly as the builders do (scope isolation)."""
    from . import store
    from .db import default_db_path

    event = str(event_db) if event_db is not None else str(store.event_db_path())
    state = str(state_db) if state_db is not None else str(default_db_path())
    return event, state


def _catalogue_fp(catalogue: Any = None) -> Any:
    """Generation fingerprint of the effective pricing catalogue.

    ``(source, version, as_of)``: file loads stamp ``as_of`` from the
    file mtime, so any Hermes refresh splits concurrent requests, while
    concurrent parses of the same file share (unlike ``id()``, which
    also splits across the loader's uncached bundled/empty paths and
    races on cold cache). Explicitly passed catalogues compare by
    content generation, not identity. The official overlay ships with
    the plugin tree (changes require reinstall + restart, which drops
    all flights), and custom rates live in the billing profiles doc,
    fingerprinted separately. Unloadable catalogues fall back to a
    shared marker — the build then raises its typed error and identical
    requests share the failure.
    """
    try:
        if catalogue is None:
            from .pricing import load_catalogue as _load

            catalogue = _load()
        return ("catalogue", str(getattr(catalogue, "source", "")),
                str(getattr(catalogue, "version", "")),
                str(getattr(catalogue, "as_of", "")))
    except Exception:
        return ("unresolved", None)


def _profiles_fp(profiles_path: Any = None) -> Any:
    """Content fingerprint of the billing profiles doc (custom rates)."""
    try:
        from . import billing as _billing

        return freeze(_billing.load_profiles(profiles_path))
    except Exception:
        return ("unresolved", None)


def analytics_key(*, days: int, model: Any, provider: Any, surface: Any,
                  task: Any, parent: Any, scope: Any, pricing_mode: str,
                  presentation: str, arrangements: Any, now: float,
                  event_db: Any = None, state_db: Any = None,
                  profiles_path: Any = None,
                  catalogue: Any = None) -> Hashable:
    """Flight key for ``build_analytics_report``.

    The window START (local-midnight-anchored, stable within a day) is the
    time component — never the raw ``now`` (``_local_window`` ends the
    window exactly at ``now``, so keying on it would defeat retries, the
    main pileup source). Followers therefore share the leader's snapshot:
    rows recorded between the leader's start and their arrival (bounded by
    the in-flight overlap, typically sub-second) appear on the next refresh
    instead. Requests straddling a local-midnight boundary have different
    starts and compute separately and correctly.
    """
    from .aggregate import _local_window  # same-package window arithmetic

    since, _until, tzname = _local_window(int(days), now)
    event, state = _resolved_paths(event_db, state_db)
    return ("analytics", int(days), model, provider, surface, task, parent,
            scope, pricing_mode, presentation, freeze(arrangements),
            event, state, str(profiles_path), since, tzname,
            _catalogue_fp(catalogue), _profiles_fp(profiles_path))


def economics_key(*, days: int, trend_months: int, arrangements: Any,
                  now: float, event_db: Any = None, state_db: Any = None,
                  membership_path: Any = None, fx_file: Any = None,
                  plans: Any = None, profiles_path: Any = None,
                  data_dir: Any = None,
                  catalogue: Any = None) -> Hashable:
    """Flight key for ``build_economics_report`` (window-start-anchored).

    As with :func:`analytics_key`, the window end (exactly ``now``) is
    deliberately excluded: followers share the leader's snapshot with
    staleness bounded by the in-flight overlap.

    Membership, FX and plans documents are fingerprinted by content: a
    save landing between two concurrent requests splits them so each
    observes its own configuration snapshot (a bare path marker would
    share pre-save bytes with a post-save arrival until the leader
    finishes). Unreadable stores fall back to path markers — the build
    then raises its typed error and identical requests share the failure.
    """
    from .aggregate import _local_window  # same-package window arithmetic

    since, _until, tzname = _local_window(int(days), now)
    event, state = _resolved_paths(event_db, state_db)
    try:
        from . import membership_store as _mstore

        stored = _mstore.load_with_seats(membership_path)
        membership_fp = None if stored.get("error") else freeze(stored)
    except Exception:
        membership_fp = None
    try:
        from .economics import load_fx as _load_fx

        fx_doc = _load_fx(fx_file)
        fx_fp = None if fx_doc.get("error") else freeze(fx_doc)
    except Exception:
        fx_fp = None
    if plans is None:
        try:
            from . import membership_api as _mapi

            book, source = _mapi.active_catalogue(data_dir=data_dir)
            plans_fp = (freeze(book), source, freeze(_mapi.load_plans()))
        except Exception:
            plans_fp = None
    else:
        plans_fp = freeze(plans)
    return ("economics", int(days), int(trend_months), freeze(arrangements),
            event, state, str(membership_path), str(fx_file), plans_fp,
            str(profiles_path), str(data_dir), since, tzname,
            membership_fp, fx_fp, _catalogue_fp(catalogue),
            _profiles_fp(profiles_path))


def session_key(*, session_id: str, population: str, provider: Any,
                model: Any, pricing: str, arrangements: Any,
                event_db: Any = None, state_db: Any = None,
                catalogue: Any = None) -> Hashable:
    """Flight key for ``build_session_summary`` (no time window)."""
    event, state = _resolved_paths(event_db, state_db)
    # NOTE: session summaries do not consume billing profiles, so no
    # profiles fingerprint (keys cover actual inputs only).
    return ("session", session_id, population, provider, model, pricing,
            freeze(arrangements), event, state, _catalogue_fp(catalogue))


def budgets_key(*, arrangements: Any, now: float, event_db: Any = None,
                state_db: Any = None, budgets_path: Any = None,
                catalogue: Any = None) -> Hashable:
    """Flight key for ``forecast.build_report``.

    Cycle bounds are computed per budget from the shared ``now`` (the same
    instant the leader build uses), so only requests in identical cycles
    share; month-boundary races compute separately.
    """
    from . import budgets as _budgets
    from .forecast import cycle_bounds

    event, state = _resolved_paths(event_db, state_db)
    target = str(budgets_path) if budgets_path is not None else str(_budgets.store_path())
    try:
        doc = _budgets.load(budgets_path)
        cycles = tuple(sorted(
            (b.get("id"), cycle_bounds(b, now)["id"]) for b in doc.get("budgets", [])))
        # The doc itself is part of the key: a budget edit landing between
        # two concurrent requests splits them so each observes its own
        # configuration snapshot.
        return ("budgets", freeze(arrangements), event, state, target, cycles,
                freeze(doc), _catalogue_fp(catalogue))
    except Exception:
        # An unreadable store fails inside the build with a typed error;
        # key on the paths alone so identical requests still share it.
        return ("budgets", freeze(arrangements), event, state, target, (), None,
                _catalogue_fp(catalogue))
