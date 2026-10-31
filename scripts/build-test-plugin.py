#!/usr/bin/env python3
"""Build the Phase A test plugin under a distinct identity.

The Desktop refuses a second plugin with an existing id (`duplicate id …`), so
the test build must be a different plugin as far as the app is concerned: its
own id, its own contribution ids, its own backend namespace. Nothing here edits
the installed release; it reads the current tree and writes a copy.

    python3 scripts/build-test-plugin.py --out /path/to/wolfmark-cost-ledger-test

The backend namespace follows the plugin id (``ctx.rest`` → `/api/plugins/<id>`),
so the API is mounted under the test name wherever this copy is installed.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

SOURCE_ID = "wolfmark-cost-ledger"
TEST_ID = "wolfmark-cost-ledger-test"
TEST_VERSION = "0.5.0-test.5"

#: Local contribution ids. The host namespaces them as `<pluginId>:<id>` anyway,
#: but distinct local ids keep a stray log line unambiguous.
CONTRIBUTIONS = ("pane", "chip", "page", "nav")

#: Identity that the *user* sees and the app routes on. The id alone is not
#: enough: `contributedRoutes()` resolves a path with `.find()`, first match
#: wins, so two plugins claiming `/cost-ledger` means the production page keeps
#: the route and the test page is unreachable — and the production page then
#: calls its own namespace against the test backend and gets 404. Name, route,
#: page title, nav label and pane title must all differ.
IDENTITY = (
    ("const LEDGER_ROUTE = '/cost-ledger'", "const LEDGER_ROUTE = '/cost-ledger-test'"),
    ("name: 'Spend Sense',", "name: 'Spend Sense (test)',"),
    ("title: 'Spend Sense',", "title: 'Spend Sense (test)',"),
    ("label: 'Spend Sense',", "label: 'Spend Sense (test)',"),
    ("title: 'Spend Sense',", "title: 'Spend Sense (test)',"),
)

COPY = ("plugin.yaml", "__init__.py", "dashboard", "desktop", "wolfmark_ledger", "catalogue",
        "NOTICE", "LICENSE", "licenses", "BRANDING.md", "assets", "README.md")


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True, help="output plugin directory")
    parser.add_argument("--source-id", default=SOURCE_ID)
    parser.add_argument("--test-id", default=TEST_ID)
    args = parser.parse_args()

    out = Path(args.out).resolve()
    if out.exists():
        raise SystemExit("Output already exists; choose a new empty destination.")
    out.mkdir(parents=True)

    for name in COPY:
        src = ROOT / name
        if src.is_dir():
            shutil.copytree(src, out / name,
                            ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        else:
            shutil.copy2(src, out / name)

    report: list[dict] = []

    # 1. the plugin identity itself
    plugin = out / "desktop" / "plugin.js"
    source = plugin.read_text(encoding="utf-8")
    declaration = f"const ID = '{args.source_id}'"
    if declaration not in source:
        raise SystemExit(f"plugin.js does not declare {declaration!r}; refusing to guess")
    source = source.replace(declaration, f"const ID = '{args.test_id}'", 1)

    # 2. contribution identities
    for local in CONTRIBUTIONS:
        before = f"id: '{local}'"
        after = f"id: '{local}-test'"
        count = source.count(before)
        if count:
            source = source.replace(before, after)
            report.append({"file": "desktop/plugin.js", "change": f"{before} → {after}", "count": count})

    report.insert(0, {"file": "desktop/plugin.js", "change": f"ID {args.source_id} → {args.test_id}", "count": 1})

    # 2b. the identity the app routes and the user reads
    for index, (before, after) in enumerate(IDENTITY):
        count = source.count(before)
        expected = 2 if index == 2 else 1
        if count != expected:
            raise SystemExit(f"expected {expected} occurrence(s) of {before!r} in plugin.js, found {count}")
        source = source.replace(before, after, 1)
        report.append({"file": "desktop/plugin.js", "change": f"{before} → {after}", "count": 1})

    plugin.write_text(source, encoding="utf-8")

    # 3. the package name the host reads
    manifest_path = out / "dashboard" / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["name"] = args.test_id
    manifest["label"] = "Spend Sense (test)"
    manifest["version"] = TEST_VERSION
    manifest["description"] = ("Phase A test build — isolated backend, synthetic data. "
                               "Not the installed release.")
    tab = manifest.get("tab")
    if not isinstance(tab, dict) or tab.get("path") != "/cost-ledger":
        raise SystemExit("dashboard manifest does not declare the expected production tab route")
    tab["path"] = "/cost-ledger-test"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    report.append({"file": "dashboard/manifest.json", "change": f"name → {args.test_id}, version → {TEST_VERSION}, tab path → {tab['path']}", "count": 1})

    # 4. the agent-facing manifest
    yaml_path = out / "plugin.yaml"
    lines = yaml_path.read_text(encoding="utf-8").splitlines()
    for index, line in enumerate(lines):
        if line.startswith("name:"):
            lines[index] = f"name: {args.test_id}"
        elif line.startswith("version:"):
            lines[index] = f'version: "{TEST_VERSION}"'
        elif line.startswith("description:"):
            lines[index] = ('description: "Phase A test build of the Spend Sense — '
                            'isolated backend, synthetic data, not the installed release."')
    yaml_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    report.append({"file": "plugin.yaml", "change": f"name → {args.test_id}, version → {TEST_VERSION}", "count": 1})

    # 5. the API announces which build it is
    api = out / "dashboard" / "plugin_api.py"
    api_source = api.read_text(encoding="utf-8")
    if 'VERSION = "0.5.0"' not in api_source:
        raise SystemExit("plugin_api.py VERSION is not the expected 0.5.0")
    api.write_text(api_source.replace('VERSION = "0.5.0"', f'VERSION = "{TEST_VERSION}"', 1),
                   encoding="utf-8")
    report.append({"file": "dashboard/plugin_api.py", "change": f"VERSION → {TEST_VERSION}", "count": 1})

    # 6. prove the identity actually changed and nothing else claims it
    final = plugin.read_text(encoding="utf-8")
    if f"const ID = '{args.test_id}'" not in final:
        raise SystemExit("the id rewrite did not take")
    if f"const ID = '{args.source_id}'" in final:
        raise SystemExit("the original id is still present")

    print(f"test plugin: {out}")
    for row in report:
        print(f"  {row['file']:<28} {row['change']} ×{row['count']}")
    print(f"  desktop/plugin.js sha256    {sha(plugin)}")
    print(f"  dashboard/plugin_api.py     {sha(api)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
