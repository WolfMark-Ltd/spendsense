"""Fail-closed storage: an unreadable store is never replaced by a fresh one.

The integration review found that reading a corrupt `memberships.json` produced
an empty store, and the next write replaced the owner's file with that empty
document. These tests pin the distinction that fixes it:

    absent  → a new, empty store (writes are allowed)
    present but unparseable → damage (writes raise, the file is untouched)

and the API-level consequences: a 503 that says why, a 404 for an account this
store has never seen, and no path that creates a membership record by writing to
one.
"""
from __future__ import annotations

import json
import tempfile
import unittest
import unittest.mock
from pathlib import Path

from wolfmark_ledger import membership_api as api
from wolfmark_ledger import membership_store as store


def record(account_id: str, label: str, routes=("openai-codex",)) -> dict:
    """The minimum a membership record has to carry to validate."""
    return {"id": account_id, "family": "openai-codex", "label": label,
            "route_slugs": list(routes), "plan_id": None}


class AbsentStoreTest(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = tempfile.TemporaryDirectory()
        self.path = Path(self.dir.name) / "memberships.json"

    def tearDown(self) -> None:
        self.dir.cleanup()

    def test_absent_store_reads_as_empty_without_an_error(self) -> None:
        data = store.load_store(self.path)
        self.assertEqual(data["accounts"], [])
        self.assertFalse(data["loaded"])
        self.assertEqual(data["error"], "")
        self.assertFalse(self.path.exists(), "a read must not create the file")

    def test_absent_store_accepts_the_first_write(self) -> None:
        store.save_account(record("a", "A"), self.path)
        self.assertTrue(self.path.exists())
        self.assertEqual([a["id"] for a in store.load_store(self.path)["accounts"]], ["a"])


class CorruptStoreTest(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = tempfile.TemporaryDirectory()
        self.path = Path(self.dir.name) / "memberships.json"
        self.original = '{"version": 1, "accounts": [{"id": "owner-data"}'
        self.path.write_text(self.original)

    def tearDown(self) -> None:
        self.dir.cleanup()

    def test_a_reader_reports_the_damage_rather_than_an_empty_list(self) -> None:
        data = store.load_store(self.path)
        self.assertEqual(data["accounts"], [])
        self.assertFalse(data["loaded"])
        self.assertIn("unreadable", data["error"])

    def test_a_reader_may_still_ask_for_the_error_to_be_raised(self) -> None:
        with self.assertRaises(store.StoreUnreadable):
            store.load_store(self.path, strict=True)

    def test_a_write_refuses_and_leaves_the_file_byte_for_byte(self) -> None:
        before = self.path.read_bytes()
        with self.assertRaises(store.StoreUnreadable):
            store.save_account(record("new", "New"), self.path)
        self.assertEqual(self.path.read_bytes(), before,
                         "an unreadable store must not be replaced")

    def test_discovery_does_not_overwrite_an_unreadable_store(self) -> None:
        before = self.path.read_bytes()
        with self.assertRaises(store.StoreUnreadable):
            store.upsert_discovered([record("route", "Route")], self.path)
        self.assertEqual(self.path.read_bytes(), before)

    def test_delete_refuses_too(self) -> None:
        before = self.path.read_bytes()
        with self.assertRaises(store.StoreUnreadable):
            store.delete_account("anything", self.path)
        self.assertEqual(self.path.read_bytes(), before)

    def test_a_document_that_is_not_an_object_is_damage_not_emptiness(self) -> None:
        self.path.write_text('["not", "a", "store"]')
        with self.assertRaises(store.StoreUnreadable):
            store.load_store(self.path, strict=True)
        self.assertIn("not an object", store.load_store(self.path)["error"])

    def test_accounts_that_are_not_records_are_damage(self) -> None:
        self.path.write_text('{"version": 1, "accounts": ["oops"]}')
        with self.assertRaises(store.StoreUnreadable):
            store.load_store(self.path, strict=True)

    def test_the_read_api_surfaces_the_damage_instead_of_an_empty_payload(self) -> None:
        with self.assertRaises(store.StoreUnreadable):
            api.accounts_payload(path=self.path)

    def test_the_write_api_refuses_rather_than_creating(self) -> None:
        with self.assertRaises(store.StoreUnreadable):
            api.save_payload("owner-data", record("owner-data", "x"), path=self.path)
        self.assertEqual(self.path.read_text(), self.original)


class UpdateOnlyWritesTest(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = tempfile.TemporaryDirectory()
        self.path = Path(self.dir.name) / "memberships.json"
        store.save_account(record("known", "Known", ["openai-codex"]), self.path)

    def tearDown(self) -> None:
        self.dir.cleanup()

    def test_an_unknown_account_is_a_key_error_not_a_creation(self) -> None:
        with self.assertRaises(KeyError):
            api.save_payload("stranger", record("stranger", "Stranger"), path=self.path)
        self.assertEqual([a["id"] for a in store.load_store(self.path)["accounts"]], ["known"],
                         "a PUT for an unknown id must not add a record")

    def test_a_known_account_still_updates(self) -> None:
        rev = store.accounts_by_id(self.path)["known"]["rev"]
        result = api.save_payload("known", {**record("known", "Renamed"), "rev": rev}, path=self.path)
        self.assertTrue(result["ok"])
        self.assertEqual(store.accounts_by_id(self.path)["known"]["label"], "Renamed")

    def test_discovery_is_what_creates_records(self) -> None:
        result = store.upsert_discovered(
            [record("discovered", "Discovered", ["xai-oauth"])], self.path)
        self.assertIn("discovered", [a["id"] for a in result["accounts"]])


class StoreShapeTest(unittest.TestCase):
    """During edits the store must never be half-written."""

    def test_a_write_leaves_valid_json_at_every_step(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "memberships.json"
            for index in range(12):
                store.save_account(record(f"a{index}", str(index)), path)
                json.loads(path.read_text())     # parses, every time
            self.assertEqual(len(store.load_store(path)["accounts"]), 12)

    def test_the_revision_changes_when_the_document_changes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "memberships.json"
            store.save_account(record("a", "A"), path)
            first = store.accounts_by_id(path)["a"]["rev"]
            store.save_account(record("a", "B"), path, if_rev=first)
            second = store.accounts_by_id(path)["a"]["rev"]
            self.assertNotEqual(first, second, "a changed document must change the revision")


#: Every shape a damaged store has actually taken. `{}` and the falsy values are
#: the ones `data.get("accounts") or []` silently turned into "no memberships".
MALFORMED_DOCUMENTS = {
    "empty object": "{}",
    "empty account record": '{"version": 1, "accounts": [{}]}',
    "account without family": '{"version": 1, "accounts": [{"id": "owner"}]}',
    "future version": '{"version": 2, "accounts": []}',
    "negative version": '{"version": -1, "accounts": []}',
    "missing version": '{"accounts": []}',
    "string version": '{"version": "1", "accounts": []}',
    "non-string family": '{"version": 1, "accounts": [{"id":"x","family":17}]}',
    "duplicate ids": '{"version": 1, "accounts": [{"id":"x","family":"f"},{"id":"x","family":"f"}]}',
    "invalid fee list": '{"version": 1, "accounts": [{"id":"x","family":"f","fee_overrides":false}]}',
    "empty fee record": '{"version": 1, "accounts": [{"id":"x","family":"f","fee_overrides":[{}]}]}',
    "empty mark record": '{"version": 1, "accounts": [{"id":"x","family":"f","manual_exhaustions":[{"scope":{}}]}]}',
    "invalid manual scope": '{"version": 1, "accounts": [{"id":"x","family":"f","manual_exhaustions":[{"scope":"bad"}]}]}',
    "invalid route list": '{"version": 1, "accounts": [{"id":"x","family":"f","route_slugs":"bad"}]}',
    "accounts null": '{"accounts": null}',
    "accounts false": '{"accounts": false}',
    "accounts zero": '{"accounts": 0}',
    "accounts empty string": '{"accounts": ""}',
    "accounts object": '{"accounts": {}}',
    "accounts string": '{"accounts": "nope"}',
    "accounts of non-records": '{"accounts": [1]}',
    "invalid version": '{"accounts": [], "version": "x"}',
    "document false": "false",
    "document null": "null",
    "document string": '""',
    "document zero": "0",
}


class MalformedStructureTest(unittest.TestCase):
    """Every malformed shape fails closed and leaves the bytes alone.

    The original defect applied a default before validating, so all of these
    were read as an empty store and the next write replaced the owner's file.
    """

    def setUp(self) -> None:
        self.dir = tempfile.TemporaryDirectory()
        self.path = Path(self.dir.name) / "memberships.json"

    def tearDown(self) -> None:
        self.dir.cleanup()

    def _seed(self, body: str) -> bytes:
        self.path.write_text(body)
        return self.path.read_bytes()

    def test_a_reader_reports_damage_for_every_shape(self) -> None:
        for name, body in MALFORMED_DOCUMENTS.items():
            with self.subTest(name):
                self._seed(body)
                loaded = store.load_store(self.path)
                self.assertFalse(loaded["loaded"], f"{name} must not load")
                self.assertIn("unreadable", loaded["error"], name)
                with self.assertRaises(store.StoreUnreadable):
                    store.load_store(self.path, strict=True)

    def test_put_delete_and_discovery_leave_every_shape_byte_identical(self) -> None:
        for name, body in MALFORMED_DOCUMENTS.items():
            with self.subTest(name):
                before = self._seed(body)
                attempts = (
                    ("save", lambda: store.save_account(
                        {"id": "x", "family": "f", "label": "x"}, self.path)),
                    ("api save", lambda: api.save_payload(
                        "x", {"id": "x", "family": "f", "label": "x"}, path=self.path)),
                    ("delete", lambda: store.delete_account("x", self.path)),
                    ("discovery", lambda: store.upsert_discovered(
                        [{"id": "y", "family": "f", "label": "y"}], self.path)),
                )
                for label, attempt in attempts:
                    with self.assertRaises(store.StoreUnreadable, msg=f"{name}/{label}"):
                        attempt()
                    self.assertEqual(self.path.read_bytes(), before,
                                     f"{name}/{label} changed the file")

    def test_the_read_api_raises_rather_than_returning_an_empty_payload(self) -> None:
        for name, body in MALFORMED_DOCUMENTS.items():
            with self.subTest(name):
                self._seed(body)
                with self.assertRaises(store.StoreUnreadable):
                    api.accounts_payload(path=self.path)

    def test_the_error_is_explicit_and_names_the_reason(self) -> None:
        self._seed('{"accounts": false}')
        with self.assertRaises(store.StoreUnreadable) as raised:
            store.load_store(self.path, strict=True)
        message = str(raised.exception)
        self.assertTrue(message.startswith("membership store unreadable: "), message)
        self.assertIn("accounts", message)

    def test_a_valid_store_still_round_trips(self) -> None:
        store.save_account(record("a", "A"), self.path)
        loaded = store.load_store(self.path, strict=True)
        self.assertTrue(loaded["loaded"])
        self.assertEqual([a["id"] for a in loaded["accounts"]], ["a"])


class RouteFailureTest(unittest.TestCase):
    """The HTTP surface answers 503 with a machine-readable marker, not 200."""

    def setUp(self) -> None:
        try:
            from fastapi import FastAPI
            from fastapi.testclient import TestClient
            from dashboard import plugin_api
        except Exception as exc:  # pragma: no cover - interpreter dependent
            self.skipTest(f"FastAPI/test client unavailable: {exc}")
        self.dir = tempfile.TemporaryDirectory()
        self.path = Path(self.dir.name) / "memberships.json"
        self.path.write_text('{"accounts": false}')
        app = FastAPI()
        app.include_router(plugin_api.router, prefix="/api/plugins/wolfmark-cost-ledger")
        self.client = TestClient(app)
        self.addCleanup(self.client.close)
        self.addCleanup(self.dir.cleanup)
        self.plugin_api = plugin_api
        self.patch = unittest.mock.patch.object(store, "store_path", return_value=self.path)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def test_get_accounts_is_503_not_an_empty_list(self) -> None:
        response = self.client.get("/api/plugins/wolfmark-cost-ledger/membership/accounts")
        self.assertEqual(response.status_code, 503, response.text)
        self.assertIn("store_unreadable", response.text)
        self.assertEqual(self.path.read_text(), '{"accounts": false}')

    def test_put_is_503_and_does_not_write(self) -> None:
        response = self.client.put("/api/plugins/wolfmark-cost-ledger/membership/accounts/x",
                                   json={"id": "x", "family": "f", "label": "x"})
        self.assertEqual(response.status_code, 503, response.text)
        self.assertIn("store_unreadable", response.text)
        self.assertEqual(self.path.read_text(), '{"accounts": false}')


if __name__ == "__main__":
    unittest.main()
