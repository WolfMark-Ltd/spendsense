"""Model News API contract tests.

Exercises the FastAPI surface directly; skipped when FastAPI/httpx are not
installed, like the other API suites.
"""
from __future__ import annotations

import unittest
from unittest.mock import patch

plugin_api = None
try:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from dashboard import plugin_api  # type: ignore[no-redef]
except Exception:  # pragma: no cover - depends on the test interpreter
    FastAPI = None  # type: ignore
    TestClient = None  # type: ignore


@unittest.skipUnless(FastAPI is not None and TestClient is not None,
                     "FastAPI/httpx not installed in this interpreter")
class NewsApiTests(unittest.TestCase):
    def setUp(self) -> None:
        app = FastAPI()
        app.include_router(plugin_api.router, prefix="/api/plugins/spend-sense")
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def base(self):
        return "/api/plugins/spend-sense"

    def test_get_news_returns_combined_payload(self):
        fixture = {"ok": True, "settings": {"live_updates": False},
                   "local": {"items": [], "baseline": True},
                   "central": {"state": "disabled", "items": []},
                   "impacts": {}}
        with patch.object(plugin_api.news_mod, "news_payload", return_value=fixture):
            response = self.client.get(self.base() + "/news")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["ok"])
        self.assertEqual(response.json()["central"]["state"], "disabled")

    def test_get_news_personalises_with_scope_and_category(self):
        fixture = {"ok": True, "settings": {"live_updates": False},
                   "local": {"items": [], "baseline": True},
                   "central": {"state": "disabled", "items": []},
                   "impacts": {}}
        with patch.object(plugin_api.news_mod, "news_payload",
                          return_value=fixture), \
                patch.object(plugin_api.monitoring, "personalise_payload",
                             side_effect=lambda payload, **kwargs: payload) as enriched:
            response = self.client.get(self.base() + "/news",
                                       params={"scope": "all", "category": "plans"})
        self.assertEqual(response.status_code, 200)
        enriched.assert_called_once()
        self.assertEqual(enriched.call_args.kwargs["scope"], "all")
        self.assertEqual(enriched.call_args.kwargs["category"], "plans")

    def test_get_news_failure_hides_details(self):
        with patch.object(plugin_api.news_mod, "news_payload",
                          side_effect=RuntimeError("private sentinel")):
            response = self.client.get(self.base() + "/news")
        self.assertEqual(response.status_code, 500)
        self.assertNotIn("private sentinel", response.text)

    def test_post_refresh_returns_payload(self):
        fixture = {"ok": True, "settings": {"live_updates": False},
                   "local": {"items": [], "baseline": True},
                   "central": {"state": "disabled", "items": []},
                   "impacts": {}}
        with patch.object(plugin_api.news_mod, "refresh_payload", return_value=fixture):
            response = self.client.post(self.base() + "/news/refresh")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["ok"])

    def test_post_refresh_is_throttled_unless_forced(self):
        fixture = {"ok": True, "settings": {"live_updates": False},
                   "local": {"items": [], "baseline": True},
                   "central": {"state": "disabled", "items": []},
                   "impacts": {}}
        with patch.object(plugin_api.news_mod, "refresh_payload",
                          return_value=fixture) as refreshed, \
                patch.object(plugin_api.monitoring, "personalise_payload",
                             side_effect=lambda payload, **kwargs: payload):
            response = self.client.post(self.base() + "/news/refresh")
        self.assertEqual(response.status_code, 200)
        refreshed.assert_called_once_with(throttle=True, force=False)
        with patch.object(plugin_api.news_mod, "refresh_payload",
                          return_value=fixture) as refreshed, \
                patch.object(plugin_api.monitoring, "personalise_payload",
                             side_effect=lambda payload, **kwargs: payload):
            response = self.client.post(self.base() + "/news/refresh",
                                        json={"force": True})
        self.assertEqual(response.status_code, 200)
        refreshed.assert_called_once_with(throttle=True, force=True)

    def test_put_settings_enables_and_disables(self):
        with patch.object(plugin_api.news_mod, "save_settings",
                          return_value={"live_updates": True}) as saved:
            response = self.client.put(self.base() + "/news/settings",
                                       json={"live_updates": True})
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["live_updates"])
        saved.assert_called_once_with(True)
        with patch.object(plugin_api.news_mod, "save_settings",
                          return_value={"live_updates": False}):
            response = self.client.put(self.base() + "/news/settings",
                                       json={"live_updates": False})
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()["live_updates"])

    def test_put_settings_rejects_non_boolean(self):
        with patch.object(plugin_api.news_mod, "save_settings",
                          side_effect=ValueError("live_updates must be true or false")):
            response = self.client.put(self.base() + "/news/settings",
                                       json={"live_updates": "yes"})
        self.assertEqual(response.status_code, 422)
        response = self.client.put(self.base() + "/news/settings", json={})
        self.assertEqual(response.status_code, 422)


if __name__ == "__main__":
    unittest.main()
