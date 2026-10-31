"""The test build must be a different *route* identity, not just a different id.

Phase A found the failure mode this guards: the Desktop resolves a contributed
route with `.find()` over every `routes` contribution, first match wins. Two
plugins claiming `/cost-ledger` means the first-loaded page keeps the path, the
second page is unreachable, and the winning page then calls its own namespace
against whichever backend is selected — which is how a `-test` backend answered
`404 {"detail":"Plugin not found"}` for a pane the user believed was the test one.

So the build is only correct when the id, the display name, the route path, the
page title, the nav label and the pane title all differ from the release.
"""
from __future__ import annotations

import hashlib
import json
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PRODUCTION = ROOT / "desktop" / "plugin.js"
BUILD = ROOT / "scripts" / "build-test-plugin.py"


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def declared_id(source: str) -> str:
    match = re.search(r"^const ID = '([^']+)'", source, re.M)
    if not match:
        raise AssertionError("no `const ID = '…'` declaration")
    return match.group(1)


def declared_route(source: str) -> str:
    match = re.search(r"^const LEDGER_ROUTE = '([^']+)'", source, re.M)
    if not match:
        raise AssertionError("no `const LEDGER_ROUTE = '…'` declaration")
    return match.group(1)


class TestBuildIdentity(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.out = Path(cls.tmp.name) / "wolfmark-cost-ledger-test"
        cls.production_hash = sha(PRODUCTION)
        result = subprocess.run([sys.executable, str(BUILD), "--out", str(cls.out)],
                                capture_output=True, text=True, timeout=180)
        if result.returncode != 0:
            raise AssertionError(f"build failed: {result.stdout}{result.stderr}")
        cls.build_log = result.stdout
        cls.source = (cls.out / "desktop" / "plugin.js").read_text(encoding="utf-8")
        cls.release = PRODUCTION.read_text(encoding="utf-8")

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    # -- the build must not touch the release ------------------------------
    def test_refuses_to_replace_existing_output(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / "keep.txt"
            marker.write_text("keep")
            result = subprocess.run([sys.executable, str(BUILD), "--out", directory],
                                    capture_output=True, text=True, timeout=30)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(marker.read_text(), "keep")

    def test_building_does_not_modify_the_release(self):
        self.assertEqual(sha(PRODUCTION), self.production_hash,
                         "the build wrote to the production plugin")

    def test_test_distribution_contains_both_licences_and_upstream_attribution(self):
        for name in ("LICENSE", "NOTICE", "licenses/Apache-2.0.txt", "README.md"):
            with self.subTest(path=name):
                source = ROOT / name
                packaged = self.out / name
                self.assertTrue(packaged.is_file(), f"test build omitted {name}")
                self.assertEqual(sha(packaged), sha(source), f"test build changed {name}")

        gpl = (self.out / "LICENSE").read_text(encoding="utf-8")
        apache = (self.out / "licenses/Apache-2.0.txt").read_text(encoding="utf-8")
        notice = (self.out / "NOTICE").read_text(encoding="utf-8")
        readme = (self.out / "README.md").read_text(encoding="utf-8")
        self.assertIn("GNU GENERAL PUBLIC LICENSE", gpl)
        self.assertIn("Version 3, 29 June 2007", gpl)
        self.assertIn("Apache License", apache)
        self.assertIn("Version 2.0, January 2004", apache)
        self.assertIn("AFei (IT-dreamer/token-cost-meter)", notice)
        self.assertIn("Apache-2.0 licence for the", notice)
        self.assertIn("software distribution is licensed under GPL-3.0", readme)
        self.assertIn("original Apache-2.0 licence", readme)

    # -- identity the app routes and the user reads ------------------------
    def test_the_id_differs(self):
        self.assertEqual(declared_id(self.release), "wolfmark-cost-ledger")
        self.assertEqual(declared_id(self.source), "wolfmark-cost-ledger-test")

    def test_the_route_path_differs(self):
        # The one that actually caused the Phase A failure.
        self.assertEqual(declared_route(self.release), "/cost-ledger")
        self.assertEqual(declared_route(self.source), "/cost-ledger-test")
        self.assertNotEqual(declared_route(self.source), declared_route(self.release))

    def test_every_visible_label_differs(self):
        for needle in ("name: 'Spend Sense (test)',",
                       "title: 'Spend Sense (test)',",
                       "label: 'Spend Sense (test)',",
                       "title: 'Spend Sense (test)',"):
            self.assertIn(needle, self.source)
        # and none of the release's unqualified labels survive
        for stale in ("name: 'Spend Sense',", "title: 'Spend Sense',",
                      "label: 'Spend Sense',", "title: 'Spend Sense',"):
            self.assertNotIn(stale, self.source)

    def test_contribution_ids_are_distinct(self):
        for local in ("pane", "chip", "page", "nav"):
            self.assertIn(f"id: '{local}-test'", self.source)
            self.assertNotIn(f"id: '{local}'", self.source)

    def test_the_route_is_used_consistently(self):
        # The route constant drives the matcher, the navigate call, the page data
        # and the nav data; a half-renamed route would strand the page.
        self.assertEqual(self.source.count("const LEDGER_ROUTE = '/cost-ledger-test'"), 1)
        self.assertGreaterEqual(self.source.count("LEDGER_ROUTE"), 4)
        self.assertNotIn("'/cost-ledger'", self.source)

    # -- the backend namespace follows the id ------------------------------
    def test_the_manifest_name_matches_the_plugin_id(self):
        manifest = json.loads((self.out / "dashboard" / "manifest.json").read_text())
        self.assertEqual(manifest["name"], declared_id(self.source))

    def test_the_dashboard_tab_route_matches_the_desktop_route(self):
        manifest = json.loads((self.out / "dashboard" / "manifest.json").read_text())
        release_manifest = json.loads((ROOT / "dashboard" / "manifest.json").read_text())
        self.assertEqual(release_manifest["tab"]["path"], declared_route(self.release))
        self.assertEqual(manifest["tab"]["path"], declared_route(self.source))
        self.assertNotEqual(manifest["tab"]["path"], release_manifest["tab"]["path"])

    def test_the_three_version_statements_agree_and_are_a_test_build(self):
        # Pinning an exact number here made every rebuild a test edit. What
        # matters is that the manifest, plugin.yaml and the API agree, and that
        # the version says "test" so it can never be mistaken for a release.
        manifest = json.loads((self.out / "dashboard" / "manifest.json").read_text())
        yaml_text = (self.out / "plugin.yaml").read_text()
        api = (self.out / "dashboard" / "plugin_api.py").read_text()
        yaml_version = re.search(r"^version:\s*\"?([^\"\n]+)\"?", yaml_text, re.M).group(1).strip()
        api_version = re.search(r'VERSION = "([^"]+)"', api).group(1)
        self.assertEqual({manifest["version"], yaml_version, api_version},
                         {manifest["version"]},
                         f"manifest={manifest['version']} yaml={yaml_version} api={api_version}")
        self.assertRegex(manifest["version"], r"-test\.\d+$", "the build must announce itself as a test")

    def test_dashboard_entry_uses_test_identity(self):
        manifest = json.loads((self.out / "dashboard" / "manifest.json").read_text())
        source = (self.out / "dashboard" / manifest["entry"]).read_text()
        self.assertIn("registry.register('wolfmark-cost-ledger-test'", source)
        self.assertNotIn("registry.register('wolfmark-cost-ledger'", source)

    def test_test_backend_storage_and_reset_are_separate(self):
        # All paths and sentinels are inside a new TemporaryDirectory.
        program = r"""
import json, os, sys, types, sqlite3
from pathlib import Path
root, home = map(Path, sys.argv[1:])
os.environ['HERMES_HOME'] = str(home)
sys.path.insert(0, str(root))
plugins = types.ModuleType('plugins'); plugins.__path__ = []
ps = types.ModuleType('plugins.plugin_storage')
ps.plugin_data_dir = lambda name: home / 'plugin-data' / name
seen = []
def plugin_db(name, filename):
    seen.append((name, filename))
    return sqlite3.connect(':memory:', check_same_thread=False)
ps.plugin_db = plugin_db
sys.modules['plugins'] = plugins; sys.modules['plugins.plugin_storage'] = ps
from wolfmark_ledger import store, membership_store, billing, user_data
prod = home / 'plugin-data' / 'wolfmark-cost-ledger'; prod.mkdir(parents=True)
for name in ('usage.db','memberships.json','billing-profiles.json'):
    (prod / name).write_text('production sentinel')
assert store.event_db_path() == home / 'plugin-data' / 'wolfmark-cost-ledger-test' / 'usage.db'
store.connect_writer()
assert seen == [('wolfmark-cost-ledger-test','usage.db')]
assert membership_store.store_path().parent.name == 'wolfmark-cost-ledger-test'
assert billing.profiles_path().parent.name == 'wolfmark-cost-ledger-test'
test = store.event_db_path().parent; test.mkdir(parents=True, exist_ok=True)
(test / 'usage.db').write_text('test sentinel')
(test / 'memberships.json').write_text(json.dumps({'version':1,'accounts':[]}))
(test / 'billing-profiles.json').write_text(json.dumps({'version':1,'profiles':[]}))
user_data.reset_user_data()
assert (test / 'usage.db').read_text() == 'test sentinel'
assert all((prod / name).read_text() == 'production sentinel' for name in ('usage.db','memberships.json','billing-profiles.json'))
"""
        with tempfile.TemporaryDirectory() as home:
            result = subprocess.run([sys.executable, '-c', program, str(self.out), home],
                                    cwd=home, capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)

    # -- the calls the pane will make are relative -------------------------
    def test_every_backend_call_is_namespace_relative(self):
        paths = re.findall(r"(?<![\w.])rest\(\s*[`'\"]([^`'\"]{1,80})", self.source)
        self.assertTrue(paths, "the pane makes no backend calls — the check would prove nothing")
        for path in paths:
            self.assertTrue(path.startswith("/"), f"absolute rest path: {path!r}")
            self.assertNotIn("://", path)

    # -- the release's accounting work is carried, not replaced ------------
    def test_the_build_carries_the_release_work(self):
        # v0.2.4-ui-1's recount fixes must survive the merge the build is made from.
        for marker in ("conversation", "derived cache"):
            self.assertIn(marker, self.source.lower(), f"{marker!r} missing from the build")


if __name__ == "__main__":
    unittest.main()
