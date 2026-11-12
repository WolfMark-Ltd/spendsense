"""API contract tests.

These exercise the FastAPI surface directly; the real mount point is
``/api/plugins/spend-sense/`` and the dashboard supplies authentication.
Skipped when FastAPI/httpx are not installed (the pure ledger tests still run).
"""

from __future__ import annotations

import hashlib
import tempfile
import unittest
from contextlib import closing, nullcontext
from pathlib import Path
from unittest.mock import patch

plugin_api = None
LedgerUnavailable = None
try:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from dashboard import plugin_api  # type: ignore[no-redef]
    from wolfmark_ledger import LedgerUnavailable  # type: ignore[no-redef]
except Exception:  # pragma: no cover - depends on the test interpreter
    FastAPI = None  # type: ignore
    TestClient = None  # type: ignore


@unittest.skipUnless(FastAPI is not None and TestClient is not None,
                     "FastAPI/httpx not installed in this interpreter")
class ApiTests(unittest.TestCase):
    def setUp(self) -> None:
        app = FastAPI()
        app.include_router(plugin_api.router, prefix="/api/plugins/spend-sense")
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def test_rates_exposes_whether_context_tiers_prevent_a_single_rate(self):
        from wolfmark_ledger.pricing import Catalogue, Rate, Tier
        book = Catalogue({"test": {"plain": Rate(2, 4, .5, 3),
                                    "tiered": Rate(2, 4, .5, 3, tiers=(Tier(100, 4, 8, 1, 6),))}},
                         "fixture", "test", "", "1")
        with patch.object(plugin_api, "load_catalogue", return_value=book):
            plain = self.client.get("/api/plugins/spend-sense/rates", params={"provider": "test", "model": "plain"})
            tiered = self.client.get("/api/plugins/spend-sense/rates", params={"provider": "test", "model": "tiered"})
        self.assertEqual(plain.status_code, 200)
        self.assertFalse(plain.json()["rate"]["has_tiers"])
        self.assertEqual(plain.json()["rate"]["cache_write"], 3)
        self.assertTrue(tiered.json()["rate"]["has_tiers"])

    def test_ledger_unexpected_failure_hides_exception_details(self):
        with patch.object(plugin_api, "build_ledger_report", side_effect=RuntimeError("private sentinel")):
            response = self.client.get("/api/plugins/spend-sense/ledger")
        self.assertEqual(response.status_code, 500)
        self.assertNotIn("private sentinel", response.text)

    def test_ledger_returns_report_shape(self):
        fixture = {
            "ok": True,
            "window": {"days": 7, "basis": "list"},
            "totals": {"basis_usd": 1.23},
            "by_route": [],
            "limits": [],
        }
        with patch.object(plugin_api, "build_ledger_report", return_value=fixture):
            response = self.client.get("/api/plugins/spend-sense/ledger",
                                       params={"days": 7, "basis": "list"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["window"]["basis"], "list")

    def test_invalid_basis_is_rejected_by_the_contract(self):
        response = self.client.get("/api/plugins/spend-sense/ledger",
                                   params={"days": 7, "basis": "made-up"})
        self.assertEqual(response.status_code, 422)

    def test_unreadable_database_is_503_not_a_stack_trace(self):
        with patch.object(plugin_api, "build_ledger_report",
                          side_effect=LedgerUnavailable("no database")):
            response = self.client.get("/api/plugins/spend-sense/ledger")
        self.assertEqual(response.status_code, 503)
        self.assertIn("no database", response.json()["detail"])

    def test_analytics_endpoint_reads_real_fixture_and_forwards_every_filter(self):
        import os
        import sqlite3
        import time

        from wolfmark_ledger import store
        from wolfmark_ledger.pricing import Catalogue, Rate

        with tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR")) as scratch:
            events = Path(scratch) / "usage.db"
            state = Path(scratch) / "missing-state.db"
            with closing(sqlite3.connect(events)) as conn, conn:
                conn.executescript(store._SCHEMA)
                conn.executemany(
                    "INSERT INTO calls (event_id,ts,model,provider,platform,aux_task,outcome,"
                    "input_tokens,cache_read_tokens,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                    [("secret-id", time.time() - 1, "m", "test", "desktop", "title", "ok", 10, 20, 1),
                     ("other-id", time.time() - 1, "m", "test", "telegram", "title", "ok", 100, 200, 1)],
                )
            before = events.read_bytes()
            book = Catalogue({"test": {"m": Rate(2, 4, .5, 3)}}, "fixture", "test", "", "1")
            with patch.object(store, "event_db_path", return_value=events), \
                 patch("wolfmark_ledger.aggregate.default_db_path", return_value=state), \
                 patch("wolfmark_ledger.analytics.load_catalogue", return_value=book):
                response = self.client.get("/api/plugins/spend-sense/analytics", params={
                    "days": 30, "model": "m", "provider": "test", "surface": "desktop", "task": "title",
                })
            self.assertEqual(response.status_code, 200, response.text)
            body = response.json()
            self.assertEqual(body["totals"]["calls"], 1)
            self.assertEqual(body["totals"]["tokens"], 30)
            self.assertEqual({k: v for k, v in body["filters"].items() if k in ("model", "provider", "surface", "task")},
                             {"model": "m", "provider": "test", "surface": "desktop", "task": "title"})
            self.assertIsNone(body["filters"]["parent"])
            self.assertIsNone(body["filters"]["scope"])
            self.assertEqual(body["window"]["days"], 30)
            self.assertEqual(body["trend"]["granularity"], "day")
            self.assertEqual(body["economics"]["covered_calls"], 1)
            self.assertNotIn("secret-id", response.text)
            self.assertEqual(events.read_bytes(), before)
            self.assertFalse(state.exists())

    def test_analytics_window_bounds_are_validated(self):
        for days in (0, 366, "not-a-number"):
            with self.subTest(days=days):
                response = self.client.get("/api/plugins/spend-sense/analytics", params={"days": days})
                self.assertEqual(response.status_code, 422)

    def test_analytics_failures_return_safe_error_responses(self):
        with TestClient(self.client.app, raise_server_exceptions=False) as client:
            for error, status in [(LedgerUnavailable("call store unavailable"), 503),
                                  (RuntimeError("private implementation detail"), 500)]:
                with self.subTest(status=status), \
                     patch.object(plugin_api, "build_analytics_report", side_effect=error), \
                     (self.assertLogs(plugin_api.log, level="ERROR") if status == 500 else nullcontext()):
                    response = client.get("/api/plugins/spend-sense/analytics")
                    self.assertEqual(response.status_code, status)
                    self.assertNotIn("private implementation detail", response.text)
                    self.assertNotIn("Traceback", response.text)

    def test_weather_returns_report_shape(self):
        fixture = {"ok": True, "generated_at": "2026-10-31T12:00:00Z",
                   "accounts": [{"account_id": "a", "rollup": {"state": "behind"}}],
                   "unlinked_rules": []}
        with patch.object(plugin_api.allowance_weather, "build_weather_report",
                          return_value=fixture) as builder:
            response = self.client.get("/api/plugins/spend-sense/allowance/weather")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["accounts"][0]["rollup"]["state"], "behind")
        builder.assert_called_once_with(native=False)

    def test_weather_native_flag_is_forwarded(self):
        with patch.object(plugin_api.allowance_weather, "build_weather_report",
                          return_value={"ok": True}) as builder:
            response = self.client.get("/api/plugins/spend-sense/allowance/weather",
                                       params={"native": True})
        self.assertEqual(response.status_code, 200)
        builder.assert_called_once_with(native=True)

    def test_weather_failures_return_safe_error_responses(self):
        from wolfmark_ledger.membership_store import StoreUnreadable

        with TestClient(self.client.app, raise_server_exceptions=False) as client:
            with patch.object(plugin_api.allowance_weather, "build_weather_report",
                              side_effect=StoreUnreadable("membership store unreadable: boom")):
                response = client.get("/api/plugins/spend-sense/allowance/weather")
                self.assertEqual(response.status_code, 503)
                self.assertIn("store_unreadable", response.json()["detail"])
            with patch.object(plugin_api.allowance_weather, "build_weather_report",
                              side_effect=RuntimeError("private implementation detail")), \
                 self.assertLogs(plugin_api.log, level="ERROR"):
                response = client.get("/api/plugins/spend-sense/allowance/weather")
                self.assertEqual(response.status_code, 500)
                self.assertNotIn("private implementation detail", response.text)
                self.assertNotIn("Traceback", response.text)

    def test_digest_returns_report_shape(self):
        fixture = {"ok": True, "days": 7, "lang": "en", "sections": [],
                   "markdown": "# Digest\n", "filename": "digest.md"}
        with patch.object(plugin_api.digest, "build_digest",
                          return_value=fixture) as builder:
            response = self.client.get("/api/plugins/spend-sense/reports/digest",
                                       params={"days": 7, "lang": "en"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["markdown"], "# Digest\n")
        builder.assert_called_once_with(days=7, lang="en")

    def test_digest_rejects_other_windows_and_languages(self):
        bad_days = self.client.get("/api/plugins/spend-sense/reports/digest",
                                   params={"days": 5})
        self.assertEqual(bad_days.status_code, 400)
        self.assertIn("7 or 30", bad_days.json()["detail"])
        self.assertEqual(self.client.get("/api/plugins/spend-sense/reports/digest",
                                         params={"lang": "fr"}).status_code, 422)

    def test_digest_failures_return_safe_error_responses(self):
        from wolfmark_ledger.membership_store import StoreUnreadable

        with TestClient(self.client.app, raise_server_exceptions=False) as client:
            with patch.object(plugin_api.digest, "build_digest",
                              side_effect=StoreUnreadable("membership store unreadable: boom")):
                response = client.get("/api/plugins/spend-sense/reports/digest")
                self.assertEqual(response.status_code, 503)
                self.assertIn("store_unreadable", response.json()["detail"])
            with patch.object(plugin_api.digest, "build_digest",
                              side_effect=RuntimeError("private implementation detail")), \
                 self.assertLogs(plugin_api.log, level="ERROR"):
                response = client.get("/api/plugins/spend-sense/reports/digest")
                self.assertEqual(response.status_code, 500)
                self.assertNotIn("private implementation detail", response.text)
                self.assertNotIn("Traceback", response.text)

    def test_health_never_raises(self):
        response = self.client.get("/api/plugins/spend-sense/health")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertIn("ok", body)
        self.assertIn("rate_card", body)

    def test_health_reports_the_pair_identity(self):
        body = self.client.get("/api/plugins/spend-sense/health").json()
        build = body["build"]
        self.assertEqual(build["contract"], plugin_api.API_CONTRACT)
        root = Path(plugin_api.__file__).resolve().parent.parent
        expected = hashlib.sha256((root / "desktop" / "plugin.js").read_bytes()).hexdigest()
        # The published digest must describe the Desktop half this tree ships,
        # not a manifest that could drift from it.
        self.assertEqual(build["desktop_sha256"], expected)
        self.assertTrue(build["revision"] is None or len(build["revision"]) == 40)

    def test_real_report_endpoint_uses_a_synthetic_state_database(self):
        from wolfmark_ledger import build_ledger_report as real_report

        import sqlite3
        import time

        with tempfile.TemporaryDirectory() as scratch:
            event_db = Path(scratch) / "usage.db"
            state_db = Path(scratch) / "state.db"
            now = time.time()
            with closing(sqlite3.connect(state_db)) as conn, conn:
                conn.executescript("""
                    CREATE TABLE sessions (
                        id TEXT PRIMARY KEY, source TEXT, title TEXT,
                        started_at REAL, profile_name TEXT
                    );
                    CREATE TABLE session_model_usage (
                        session_id TEXT NOT NULL, model TEXT NOT NULL,
                        billing_provider TEXT NOT NULL DEFAULT '',
                        billing_base_url TEXT NOT NULL DEFAULT '',
                        billing_mode TEXT NOT NULL DEFAULT '', task TEXT NOT NULL DEFAULT '',
                        input_tokens INTEGER NOT NULL DEFAULT 0,
                        output_tokens INTEGER NOT NULL DEFAULT 0,
                        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
                        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
                        reasoning_tokens INTEGER NOT NULL DEFAULT 0,
                        api_call_count INTEGER NOT NULL DEFAULT 0,
                        estimated_cost_usd REAL NOT NULL DEFAULT 0,
                        actual_cost_usd REAL NOT NULL DEFAULT 0,
                        cost_status TEXT, cost_source TEXT, first_seen REAL, last_seen REAL
                    );
                """)
                conn.execute("INSERT INTO sessions VALUES (?,?,?,?,?)",
                             ("synthetic-session", "desktop", "Synthetic", now, "default"))
                conn.execute("""INSERT INTO session_model_usage (
                    session_id, model, billing_provider, task, input_tokens,
                    output_tokens, api_call_count, first_seen, last_seen
                ) VALUES (?,?,?,?,?,?,?,?,?)""",
                             ("synthetic-session", "synthetic-model", "synthetic-provider", "",
                              10, 20, 1, now, now))

            from wolfmark_ledger import store

            try:
                store.bootstrap(state_db_path=state_db, path=event_db)

                def report(**kwargs):
                    return real_report(event_db_path=event_db, state_db_path=state_db, **kwargs)

                with patch.object(plugin_api, "build_ledger_report", side_effect=report):
                    response = self.client.get("/api/plugins/spend-sense/ledger",
                                               params={"days": 30, "basis": "hybrid"})
            finally:
                # bootstrap() opened the shared writer on the temp usage.db;
                # leaving it open locks the file on Windows at cleanup.
                if store._WRITER is not None:
                    store._WRITER.close()
                store._WRITER = None
                store._WRITER_PATH = None
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertTrue(body["ok"])
        self.assertIn("totals", body)
        self.assertEqual(body["window"]["basis"], "hybrid")
        self.assertEqual(body["window"]["kind"], "timestamped_calls")
        # Period totals may be empty before the collector runs; the historical
        # baseline must still reconcile.
        self.assertIn("baseline", body)
        self.assertEqual(body["baseline"]["totals"]["tokens"], 30)
        self.assertIn("reconciliation", body)


@unittest.skipIf(plugin_api is None, "dashboard.plugin_api is not importable in this interpreter")
class BuildIdentityTests(unittest.TestCase):
    """The pair identity must be readable from an installed tree, without Git on PATH."""

    REV = "0123456789abcdef0123456789abcdef01234567"

    @staticmethod
    def api():
        assert plugin_api is not None  # narrowed for the type checker; the class is skipped otherwise
        return plugin_api

    def _tree(self, scratch: str) -> Path:
        root = Path(scratch)
        (root / ".git").mkdir()
        return root

    def test_detached_head_revision_is_read_from_the_head_file(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = self._tree(scratch)
            (root / ".git" / "HEAD").write_text(self.REV + "\n", encoding="utf-8")
            self.assertEqual(self.api()._git_head_revision(root), self.REV)

    def test_a_loose_branch_ref_resolves(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = self._tree(scratch)
            (root / ".git" / "HEAD").write_text("ref: refs/heads/main\n", encoding="utf-8")
            (root / ".git" / "refs" / "heads").mkdir(parents=True)
            (root / ".git" / "refs" / "heads" / "main").write_text(self.REV + "\n", encoding="utf-8")
            self.assertEqual(self.api()._git_head_revision(root), self.REV)

    def test_a_packed_branch_ref_resolves(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = self._tree(scratch)
            (root / ".git" / "HEAD").write_text("ref: refs/heads/main\n", encoding="utf-8")
            (root / ".git" / "packed-refs").write_text(
                "# pack-refs with: peeled fully-peeled\n"
                f"aaaabbbbccccddddeeeeffff0000111122223333 refs/heads/other\n{self.REV} refs/heads/main\n",
                encoding="utf-8")
            self.assertEqual(self.api()._git_head_revision(root), self.REV)

    def test_a_missing_or_malformed_revision_is_not_invented(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = self._tree(scratch)
            self.assertIsNone(self.api()._git_head_revision(root))
            (root / ".git" / "HEAD").write_text("ref: refs/heads/feature\n", encoding="utf-8")
            self.assertIsNone(self.api()._git_head_revision(root))
            (root / ".git" / "HEAD").write_text("not-a-sha\n", encoding="utf-8")
            self.assertIsNone(self.api()._git_head_revision(root))
        with tempfile.TemporaryDirectory() as scratch:
            self.assertIsNone(self.api()._git_head_revision(Path(scratch)))

    def test_an_installer_record_stands_in_for_missing_git_metadata(self):
        with tempfile.TemporaryDirectory() as scratch:
            parent = Path(scratch)
            root = parent / "spend-sense"
            root.mkdir()
            (root / ".hermes-catalog.json").write_text(
                '{"catalogName": "spend-sense", "sha": "%s"}' % self.REV, encoding="utf-8")
            self.assertEqual(self.api()._installer_revision(root), self.REV)

        with tempfile.TemporaryDirectory() as scratch:
            parent = Path(scratch)
            root = parent / "spend-sense"
            root.mkdir()
            (parent / ".install-metadata.json").write_text(
                '{"spend-sense": {"revision": "%s"}}' % self.REV, encoding="utf-8")
            self.assertEqual(self.api()._installer_revision(root), self.REV)
            # A registry that records a branch name or a short SHA is not an identity.
            (parent / ".install-metadata.json").write_text(
                '{"spend-sense": {"revision": "main"}}', encoding="utf-8")
            self.assertIsNone(self.api()._installer_revision(root))

    def test_a_tree_without_a_desktop_half_publishes_no_digest(self):
        with tempfile.TemporaryDirectory() as scratch:
            self.assertIsNone(self.api()._desktop_bundle_sha256(Path(scratch)))

    def test_the_digest_describes_the_desktop_half_and_follows_a_reinstall(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            (root / "desktop").mkdir()
            bundle = root / "desktop" / "plugin.js"
            bundle.write_bytes(b"first bundle")
            first = self.api()._desktop_bundle_sha256(root)
            self.assertEqual(first, hashlib.sha256(b"first bundle").hexdigest())
            self.assertEqual(self.api()._desktop_bundle_sha256(root), first)
            # A replaced half must not keep the previous digest.
            bundle.write_bytes(b"second bundle, longer than the first")
            self.assertNotEqual(self.api()._desktop_bundle_sha256(root), first)


@unittest.skipUnless(FastAPI is not None and TestClient is not None,
                     "FastAPI/httpx not installed in this interpreter")
class VersionConsistencyTests(unittest.TestCase):
    """A release must not ship two different versions in one package."""

    def test_manifest_plugin_yaml_and_health_agree(self):
        import json
        from pathlib import Path as _Path

        root = _Path(__file__).resolve().parent.parent
        yaml_version = None
        for line in (root / "plugin.yaml").read_text(encoding="utf-8").splitlines():
            if line.startswith("version:"):
                yaml_version = line.split(":", 1)[1].strip().strip('"')
                break
        manifest = json.loads((root / "dashboard" / "manifest.json").read_text(encoding="utf-8"))
        self.assertIsNotNone(yaml_version)
        self.assertEqual(manifest["version"], yaml_version, "manifest.json drifted from plugin.yaml")
        self.assertEqual(plugin_api.VERSION, yaml_version, "the API reports a different version")


@unittest.skipUnless(FastAPI is not None and TestClient is not None,
                     "FastAPI/httpx not installed in this interpreter")
class PricingParameterTests(unittest.TestCase):
    def setUp(self) -> None:
        app = FastAPI()
        app.include_router(plugin_api.router, prefix="/api/plugins/spend-sense")
        self.client = TestClient(app)

    def test_pricing_mode_and_presentation_are_forwarded(self):
        response = self.client.get("/api/plugins/spend-sense/analytics",
                                   params={"days": 7, "pricing": "approximate", "presentation": "spend"})
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body["pricing_coverage"]["mode"], "approximate")
        self.assertEqual(body["billing"]["presentation"], "spend")

    def test_invalid_pricing_mode_is_rejected(self):
        response = self.client.get("/api/plugins/spend-sense/analytics",
                                   params={"pricing": "free-lunch"})
        self.assertEqual(response.status_code, 422)


if __name__ == "__main__":
    unittest.main()
