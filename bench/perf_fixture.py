"""Deterministic synthetic usage fixtures for SpendSense performance work.

Builds isolated SQLite + JSON fixtures with realistic variation (providers,
models, token mixes, outcomes, cache flags, billing classes, sessions,
subscriptions) without copying any private records. Deterministic for a
given (n_events, seed).
"""
from __future__ import annotations

import json
import random
import sqlite3
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

from wolfmark_ledger import store
from wolfmark_ledger.pricing import Catalogue, Rate, Tier

NOW = datetime(2026, 10, 29, 12, tzinfo=timezone.utc).timestamp()
DAY = 86400.0

PROVIDERS = ("test", "other", "nouslike", "ghost")
MODELS = {
    "test": ("m0", "m1"),
    "other": ("m2",),
    "nouslike": ("n0",),
    "ghost": ("g0",),
}


def fixture_catalogue() -> Catalogue:
    """Catalogue covering test/* and other/* only.

    test/m0 carries tiers, retention write rates and an official overlay
    WITH peak/off-peak windows so windowed-rate memoisation is exercised.
    nouslike/* is native-only; ghost/* is unpriced everywhere.
    """
    # Tiers + retention write rates live on test/m1, which no official
    # overlay shadows (the overlay on test/m0 replaces its whole card, so
    # tiers there would never execute). test/m0 keeps the weekday-windowed
    # overlay to exercise _windowed_rate/_window_active paths.
    tiered = Rate(2.0, 4.0, 0.5, 3.0,
                  tiers=(Tier(threshold=100000, input=1.5, output=3.0),),
                  cache_write_rates=(("30m", 3.0), ("12h", 5.0)))
    plain = Rate(2.0, 4.0, 0.5, 3.0)
    book = Catalogue(
        {"test": {"m0": plain, "m1": tiered},
         "other": {"m2": Rate(1.0, 2.0, 0.25, 1.5)}},
        "fixture", "test", "", "1")
    # Official overlay with weekday windows on test/m0: Mon-Fri 09:00-17:00
    # peak input rate, exercising _windowed_rate/_window_active paths.
    book.official[("test", "m0")] = (
        Rate(2.0, 4.0, 0.5, 3.0), "2026-10-01",
        (((0, 1, 2, 3, 4), 540, 1020, 3.0, 5.0, 0.75, 3.5),))
    return book


def native_rows() -> dict[str, dict[str, dict]]:
    return {
        "nouslike": {
            "n0": {"prompt": "0.0000015", "completion": "0.000006",
                   "input_cache_read": "0.0000002",
                   "original": {"prompt": "0.000002", "completion": "0.000008",
                                "input_cache_read": "0.0000003"}},
        },
    }


def build_events(path: Path, n_events: int, seed: int = 20261126) -> int:
    """Write n_events synthetic calls spread over the trailing 60 days."""
    rng = random.Random(seed)
    path.unlink(missing_ok=True)
    sessions = [f"perf-session-{i:05d}" for i in range(max(16, n_events // 50))]
    rows = []
    for i in range(n_events):
        provider = rng.choices(PROVIDERS, weights=(45, 25, 20, 10))[0]
        model = rng.choice(MODELS[provider])
        roll = rng.random()
        outcome = "error" if roll < 0.03 else ("missing_usage" if roll < 0.05 else "ok")
        # A slice of test/m1 traffic crosses the 100k tier threshold so
        # both tier bands (and retention write-rate selection) execute.
        big_prompt = provider == "test" and model == "m1" and rng.random() < 0.2
        input_tokens = (rng.randint(100001, 150000) if big_prompt
                        else rng.randint(500, 60000))
        cache_mix = rng.random()
        if cache_mix < 0.4:
            cache_read, cache_write = rng.randint(0, 50000), 0
        elif cache_mix < 0.7:
            cache_read, cache_write = rng.randint(0, 50000), rng.randint(0, 20000)
        else:
            cache_read, cache_write = 0, 0
        rows.append((
            f"perf-event-{i:07d}",
            NOW - rng.random() * 60 * DAY,
            NOW - rng.random() * 60 * DAY,
            rng.choice(sessions),
            rng.choice(("", "research", "code-review")),
            "desktop",
            model, provider,
            rng.choice(("ok", "ok", "ok", "main", "aux")),
            "ok" if outcome == "ok" else outcome,
            input_tokens, rng.randint(0, 8000),
            cache_read, cache_write, rng.randint(0, 2000),
            rng.choice((True, False, None)), rng.choice((True, False, None)),
            rng.choice((None, "main", "subagent", "auxiliary")),
            NOW,
        ))
    with closing(sqlite3.connect(path)) as conn, conn:
        conn.executescript(store._SCHEMA)
        conn.executemany(
            "INSERT INTO calls (event_id, ts, started_at, session_id, task_id,"
            " platform, model, provider, aux_task, outcome,"
            " input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,"
            " reasoning_tokens, cache_read_reported, cache_write_reported,"
            " call_class, recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            rows,
        )
        conn.execute(
            "INSERT INTO baseline (id, captured_at, total_tokens, main_tokens, aux_tokens)"
            " VALUES (1, ?, 0, 0, 0)", (NOW - 60 * DAY,))
    return n_events


def build_state(path: Path, seed: int = 20261126) -> None:
    """Sessions table (with parent links) + session_model_usage billing rows."""
    rng = random.Random(seed)
    path.unlink(missing_ok=True)
    with closing(sqlite3.connect(path)) as conn, conn:
        conn.execute(
            "CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT DEFAULT '',"
            " model TEXT DEFAULT '', parent_session_id TEXT, model_config TEXT,"
            " started_at REAL)")
        srows = []
        for i in range(16):
            parent = f"perf-session-{rng.randrange(8):05d}" if i >= 8 and rng.random() < 0.5 else None
            srows.append((f"perf-session-{i:05d}", "desktop", "m0", parent, None, NOW - 10 * DAY))
        conn.executemany(
            "INSERT INTO sessions (id, source, model, parent_session_id, model_config,"
            " started_at) VALUES (?,?,?,?,?,?)", srows)
        conn.execute(
            "CREATE TABLE session_model_usage (billing_provider TEXT, model TEXT,"
            " cost_status TEXT, actual_cost_usd REAL, estimated_cost_usd REAL,"
            " last_seen REAL)")
        conn.executemany(
            "INSERT INTO session_model_usage VALUES (?,?,?,?,?,?)",
            [("test", "m0", "metered", None, 12.5, NOW - DAY),
             ("other", "m2", "metered", 3.25, None, NOW - DAY),
             ("nouslike", "n0", "unknown", None, None, NOW - DAY)])
    # NOTE: perf-session ids beyond the first 16 are unknown to state.db,
    # which exercises the unattributed scope path.


def build_memberships(path: Path) -> None:
    path.write_text(json.dumps({
        "version": 1,
        "accounts": [
            {"id": "acc-test", "family": "test", "label": "acc-test",
             "route_slugs": ["test"], "credential_present": True,
             "billing_arrangement": "subscription", "plan_id": "test.plus",
             "fee_overrides": [], "manual_exhaustions": []},
        ],
    }))


def build_plans() -> dict:
    from wolfmark_ledger import membership as M
    return M.load_plan_catalogue({
        "catalogue_version": "perf.1",
        "plans": [{"id": "test.plus", "provider_family": "test", "name": "Test Plus",
                   "price": {"amount": 20.0, "currency": "USD", "period": "month"}}],
    })


def build_fx(path: Path) -> None:
    path.write_text(json.dumps({"rates": []}))


def build_budgets(path: Path) -> None:
    from wolfmark_ledger import budgets as B

    doc = B.mutate("total", if_rev=B.load(path)["rev"],
                   budget={"id": "total", "label": "Monthly value",
                           "scope": "total", "measurement": "api_equivalent",
                           "amount": 500.0, "currency": "USD", "cycle_day": 1,
                           "timezone": "UTC", "enabled": True,
                           "thresholds": [50, 80, 100],
                           "provider": "", "model": ""},
                   path=path)
    B.mutate("actual", if_rev=doc["rev"],
             budget={"id": "actual", "label": "Metered spend",
                     "scope": "total", "measurement": "actual_metered",
                     "amount": 400.0, "currency": "USD", "cycle_day": 1,
                     "timezone": "UTC", "enabled": True,
                     "thresholds": [50, 80, 100],
                     "provider": "", "model": ""},
             path=path)


def build_fixture(directory: Path | str, n_events: int, seed: int = 20261126) -> dict[str, Path]:
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    events = directory / "usage.db"
    state = directory / "state.db"
    memberships = directory / "memberships.json"
    fx = directory / "fx-rates.json"
    budgets = directory / "budgets.json"
    build_events(events, n_events, seed)
    build_state(state, seed)
    build_memberships(memberships)
    build_fx(fx)
    build_budgets(budgets)
    return {"events": events, "state": state, "memberships": memberships,
            "fx": fx, "budgets": budgets}
