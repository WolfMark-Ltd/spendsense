"""Regenerate test/fixtures/news/payload-local-central.json.

Run from the repository root:

    python3 test/fixtures/news/regenerate_payload.py

The script drives the real news pipeline against the small raw models.dev
cache in this directory: a baseline refresh, then a second refresh over a
mutated copy of the same cache (price changes, new models, a new provider),
a bundled-style plans catalogue diff, usage rows in a temporary event store,
and a central feed built by ``wolfmark_ledger.news_feed.build_feed``. A fixed
clock and fixed file mtimes keep the payload byte-stable across runs.
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


def main() -> None:
    payload = build_payload(FIXTURE_DIR / "payload-local-central.json")
    print(f"local items: {len(payload['local']['items'])}, "
          f"central items: {len(payload['central']['items'])}")


if __name__ == "__main__":
    main()
