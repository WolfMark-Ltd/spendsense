"""Regenerate test/fixtures/news/payload-local-central.json and
test/fixtures/news/payload-unknown-recurrence.json.

Run from the repository root:

    python3 test/fixtures/news/regenerate_payload.py

The script drives the real news pipeline against the small raw models.dev
cache in this directory: a baseline refresh, then a second refresh over a
mutated copy of the same cache (price changes, new models, a new provider),
a bundled-style plans catalogue diff, usage rows in a temporary event store,
and a central feed built by ``wolfmark_ledger.news_feed.build_feed``. A fixed
clock and fixed file mtimes keep the payload byte-stable across runs.

The second builder runs a longer sequence in its own profile: an A→B→A→B
recurrence, a pre-raw (upgrade-era) snapshot rewrite, and a refresh whose
raw source is unavailable, so items with tiers_detail "unknown" and a "-r"
recurrence id land in the payload.
"""
from __future__ import annotations

import copy
import json
import os
import sqlite3
import sys
import tempfile
from contextlib import closing
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT))

from wolfmark_ledger import news, news_feed, store  # noqa: E402
from wolfmark_ledger.pricing import load_catalogue  # noqa: E402

NOW = 1798765432.0  # fixed clock, matching test/test_news.py
MTIME = NOW - 60.0
FIXTURE_DIR = Path(__file__).resolve().parent


def _write_cache(snapshot_dir: Path, doc: dict) -> Path:
    snapshot_dir.mkdir(parents=True, exist_ok=True)
    target = snapshot_dir / "models_dev_cache.json"
    target.write_text(json.dumps(doc, indent=2, sort_keys=True), encoding="utf-8")
    os.utime(target, (MTIME, MTIME))
    return target


def _second_snapshot(raw: dict) -> dict:
    """The catalogue the second refresh observes: changes and additions."""
    current = copy.deepcopy(raw)
    anthropic = current["data"]["anthropic"]["models"]
    anthropic["claude-sonnet-4"]["cost"] = {
        "input": 2.0, "output": 14.0, "cache_read": 0.3, "cache_write": 4.5}
    anthropic["claude-opus-4"]["cost"]["cache_write"] = 1.5
    anthropic["claude-haiku-4-5"] = {
        "name": "Claude Haiku 4.5", "cost": {"input": 1.0, "output": 5.0}}
    anthropic["claude-haiku-4-5-20251001"] = {
        "name": "Claude Haiku 4.5 (2025-10-01)",
        "cost": {"input": 1.0, "output": 5.0, "cache_read": 0.1}}
    openrouter = current["data"]["openrouter"]["models"]
    openrouter["anthropic/claude-haiku-4-5"] = {
        "name": "Claude Haiku 4.5 (anthropic)",
        "cost": {"input": 1.0, "output": 5.0, "cache_read": 0.1, "cache_write": 0.125}}
    vercel = current["data"]["vercel"]["models"]
    vercel["glm-large"]["cost"]["tiers"][0]["input"] = 0.25
    vercel["text-plain"] = {
        "name": "Text Plain", "cost": {"input": 0.2, "output": 0.8}}
    current["data"]["zhipu"] = {"models": {
        "glm-4-air": {"name": "GLM 4 Air", "cost": {"input": 0.1, "output": 0.1}}}}
    return current


def _plans(generated_at: str, plans: list[dict]) -> dict:
    return {"catalogue_version": "fixtures", "generated_at": generated_at,
            "plans": plans,
            "sources": [{"id": "demo-source", "url": "https://example.com/demo/plans"}]}


def _plan(plan_id: str, name: str, amount: float) -> dict:
    return {"id": plan_id, "provider_family": "demo", "name": name,
            "price": {"amount": amount, "currency": "USD", "period": "month"},
            "entitlements": {"windows": ["monthly-credits"]},
            "verification": {"source_id": "demo-source"}}


def _write_events(target: Path) -> None:
    rows = [
        {"ts": NOW - 3600, "provider": "anthropic", "model": "claude-haiku-4-5",
         "input_tokens": 1200, "output_tokens": 300},
        {"ts": NOW - 3500, "provider": "anthropic", "model": "haiku-4-5",
         "input_tokens": 500, "output_tokens": 100},
        {"ts": NOW - 3400, "provider": "openrouter", "model": "anthropic/claude-haiku-4-5",
         "input_tokens": 2000, "output_tokens": 400},
        {"ts": NOW - 3300, "provider": "anthropic", "model": "claude-sonnet-4",
         "input_tokens": 400_000, "output_tokens": 80_000,
         "cache_read_tokens": 100_000, "cache_write_tokens": 20_000},
    ]
    with closing(sqlite3.connect(target)) as conn, conn:
        conn.executescript(store._SCHEMA)
        for index, row in enumerate(rows):
            values = {"event_id": f"event-{index}", "outcome": "ok",
                      "recorded_at": NOW, **row}
            columns = list(values)
            conn.execute(f"INSERT INTO calls ({','.join(columns)}) VALUES "
                         f"({','.join('?' for _ in columns)})", list(values.values()))


def build_payload(output: Path) -> dict:
    scratch = Path(tempfile.mkdtemp(prefix="news-fixture-"))
    data_dir = scratch / "plugin-data"
    events = scratch / "usage.db"
    home = scratch / "hermes-home"
    _write_events(events)
    home.mkdir(parents=True, exist_ok=True)
    (home / "auth.json").write_text(json.dumps(
        {"credential_pool": {"anthropic": [{}], "openrouter": [{}]}}), encoding="utf-8")

    raw = json.loads((FIXTURE_DIR / "models-dev-cache.json").read_text(encoding="utf-8"))
    baseline = load_catalogue(_write_cache(scratch / "snap1", raw))
    changed = load_catalogue(_write_cache(scratch / "snap2", _second_snapshot(raw)))

    plans_before = _plans("2026-01-01T00:00:00Z", [_plan("demo.plus", "demo plus", 20.0)])
    plans_after = _plans("2026-02-01T00:00:00Z",
                         [_plan("demo.plus", "demo plus", 20.0),
                          _plan("demo.max", "demo max", 100.0)])

    news.refresh_local(data_dir=data_dir, catalogue=baseline,
                       plans_doc=plans_before, now=NOW,
                       raw_cache_path=scratch / "snap1" / "models_dev_cache.json")
    result = news.refresh_local(data_dir=data_dir, catalogue=changed,
                                plans_doc=plans_after, now=NOW + 3600,
                                raw_cache_path=scratch / "snap2" / "models_dev_cache.json",
                                official_path=FIXTURE_DIR / "official-verified.json")

    news.save_settings(True, path=news.settings_path(data_dir))
    raw_feed, _problems = news_feed.build_feed(
        _second_snapshot(raw), raw, {"announcements": []},
        observed_at=news._now_iso(NOW + 3600))
    feed, problems = news.validate_feed(raw_feed)
    assert feed is not None and not problems, f"fixture feed invalid: {problems}"
    cache_file = news.cache_path(data_dir)
    cache_file.parent.mkdir(parents=True, exist_ok=True)
    cache_file.write_text(json.dumps(
        {"version": news.NEWS_VERSION, "fetched_at": news._now_iso(NOW + 3600),
         "state": "ok", "error": "", "feed": feed}, indent=2, sort_keys=True),
        encoding="utf-8")

    payload = news.news_payload(data_dir=data_dir, event_db=events, home=home,
                                now=NOW + 7200)
    assert result["items"], "fixture refresh produced no local items"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n",
                      encoding="utf-8")
    return payload


def _recurrence_raw() -> dict:
    """Small raw cache for the unknown-tier/recurrence fixture."""
    return {"data": {"acme": {"models": {
        "m1": {"name": "M One", "cost": {"input": 1.0, "output": 2.0}},
        "m2": {"name": "M Two", "cost": {"input": 2.0, "output": 4.0}},
        "m3": {"name": "M Three", "cost": {"input": 0.5, "output": 1.0}},
    }}}}


def _raw_with_m1(raw: dict) -> dict:
    current = copy.deepcopy(raw)
    current["data"]["acme"]["models"]["m1"]["cost"] = {"input": 3.0, "output": 4.0}
    return current


def _raw_final(raw: dict) -> dict:
    """m1 stays at the B rates; m2 price drops; m4 is new."""
    current = _raw_with_m1(raw)
    models = current["data"]["acme"]["models"]
    models["m2"]["cost"] = {"input": 1.5, "output": 4.0}
    models["m4"] = {"name": "M Four", "cost": {"input": 0.25, "output": 0.75}}
    return current


def _strip_raw_fields(snapshot_file: Path) -> None:
    """Rewrite the snapshot as a pre-raw (upgrade-era) store would hold it."""
    snapshot = json.loads(snapshot_file.read_text(encoding="utf-8"))
    for models in snapshot.get("providers", {}).values():
        for row in models.values():
            row.pop("name", None)
            row.pop("tiers_raw", None)
    snapshot.pop("raw_tiers_v", None)
    snapshot_file.write_text(json.dumps(snapshot), encoding="utf-8")


def build_unknown_recurrence_payload(output: Path) -> dict:
    """Second fixture: A→B→A→B recurrence plus unknown-tier items.

    One refresh sequence: m1 flips A→B→A→B a few hours apart (one original
    id, one "-r" recurrence id, and the reverse item); then the snapshot is
    rewritten without raw tier fields (upgrade-era shape) and a final refresh
    with an unavailable raw source drops m2's price and adds m4, both with
    tiers_detail "unknown". A central feed built over the same raw diff keeps
    md- items for the same transitions, with effective_at "" on both sides.
    """
    scratch = Path(tempfile.mkdtemp(prefix="news-fixture-unknown-"))
    data_dir = scratch / "plugin-data"
    events = scratch / "usage.db"
    home = scratch / "hermes-home"
    _write_events(events)
    home.mkdir(parents=True, exist_ok=True)
    (home / "auth.json").write_text(json.dumps(
        {"credential_pool": {"anthropic": [{}], "openrouter": [{}]}}), encoding="utf-8")

    raw = _recurrence_raw()
    baseline = load_catalogue(_write_cache(scratch / "r1", raw))
    changed = load_catalogue(_write_cache(scratch / "r2", _raw_with_m1(raw)))
    final = load_catalogue(_write_cache(scratch / "r4", _raw_final(raw)))
    snapshot_file = news.snapshot_path(data_dir)
    plans = _plans("2026-01-01T00:00:00Z", [_plan("demo.plus", "demo plus", 20.0)])

    def refresh(catalogue, now, raw_cache):
        return news.refresh_local(data_dir=data_dir, catalogue=catalogue,
                                  plans_doc=plans, now=now,
                                  raw_cache_path=raw_cache)

    refresh(baseline, NOW, scratch / "r1" / "models_dev_cache.json")
    refresh(changed, NOW + 3600, scratch / "r2" / "models_dev_cache.json")     # A→B
    refresh(baseline, NOW + 7200, scratch / "r1" / "models_dev_cache.json")    # B→A
    result = refresh(changed, NOW + 10800, scratch / "r2" / "models_dev_cache.json")  # A→B again
    assert any("-r" in item["id"] for item in result["items"]), "no recurrence item"
    _strip_raw_fields(snapshot_file)
    result = refresh(final, NOW + 14400,
                     scratch / "does-not-exist" / "models_dev_cache.json")  # raw unavailable
    assert result["items"], "unknown-tier refresh produced no local items"

    news.save_settings(True, path=news.settings_path(data_dir))
    raw_feed, _problems = news_feed.build_feed(
        _raw_final(raw), raw, {"announcements": []},
        observed_at=news._now_iso(NOW + 14400))
    feed, problems = news.validate_feed(raw_feed)
    assert feed is not None and not problems, f"fixture feed invalid: {problems}"
    cache_file = news.cache_path(data_dir)
    cache_file.parent.mkdir(parents=True, exist_ok=True)
    cache_file.write_text(json.dumps(
        {"version": news.NEWS_VERSION, "fetched_at": news._now_iso(NOW + 14400),
         "state": "ok", "error": "", "feed": feed}, indent=2, sort_keys=True),
        encoding="utf-8")

    payload = news.news_payload(data_dir=data_dir, event_db=events, home=home,
                                now=NOW + 18000)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n",
                      encoding="utf-8")
    return payload


def main() -> None:
    for builder, name in ((build_payload, "payload-local-central.json"),
                          (build_unknown_recurrence_payload,
                           "payload-unknown-recurrence.json")):
        payload = builder(FIXTURE_DIR / name)
        print(f"{name}: local items: {len(payload['local']['items'])}, "
              f"central items: {len(payload['central']['items'])}")


if __name__ == "__main__":
    main()
