#!/usr/bin/env python3
"""Generate the Model News editorial golden fixture.

The Desktop plugin carries a JavaScript port of the deterministic briefing in
``wolfmark_ledger/news_briefing.py`` so the headline surface works before a
publisher emits ``central.briefing``. Both implementations must agree on the
facts a headline prints — event type, headline code and parameters, family
identity, magnitude and event links — so this script records the Python
builder's answer for the committed Model News fixture and
``test/news-editorial.test.mjs`` asserts the JavaScript port reproduces it.

Usage (from the repository root)::

    python3 scripts/news-editorial-golden.py

Writes ``test/fixtures/news/editorial-golden.json``. Only ``family_label`` is
excluded from the comparison: it is cosmetic presentation and may be improved
without changing any published claim.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from wolfmark_ledger import news_briefing as nb  # noqa: E402

FIXTURE = ROOT / "test" / "fixtures" / "news" / "realistic.json"
OUTPUT = ROOT / "test" / "fixtures" / "news" / "editorial-golden.json"


def main() -> int:
    payload = json.loads(FIXTURE.read_text(encoding="utf-8"))
    items = list(payload.get("local", {}).get("items") or [])
    items.extend(payload.get("central", {}).get("items") or [])
    generated_at = str(payload.get("central", {}).get("fetched_at") or "")

    briefing = nb.build_briefing(items, generated_at=generated_at)
    document = {
        "source": "wolfmark_ledger.news_briefing.build_briefing",
        "fixture": FIXTURE.name,
        "generated_at": generated_at,
        "sections": [
            {
                "id": section["id"],
                "total": section["total"],
                "entries": [
                    {
                        "event_type": entry.get("event_type"),
                        "headline_code": entry.get("headline_code"),
                        "headline_params": entry.get("headline_params"),
                        "provider": entry.get("provider"),
                        "model": entry.get("model"),
                        "model_family": entry.get("model_family"),
                        "observed_at": entry.get("observed_at"),
                        "confidence": entry.get("confidence"),
                        "event_ids": entry.get("event_ids"),
                        "magnitude": {
                            "max_abs_pct": entry.get("magnitude", {}).get("max_abs_pct"),
                            "dominant_pct": entry.get("magnitude", {}).get("dominant_pct"),
                            "max_abs_delta": entry.get("magnitude", {}).get("max_abs_delta"),
                            "rate": entry.get("magnitude", {}).get("rate"),
                            "zero_baseline": entry.get("magnitude", {}).get("zero_baseline"),
                        },
                        "variants": [
                            {
                                "event_type": variant.get("event_type"),
                                "headline_code": variant.get("headline_code"),
                                "headline_params": variant.get("headline_params"),
                                "provider": variant.get("provider"),
                                "model": variant.get("model"),
                                "event_ids": variant.get("event_ids"),
                            }
                            for variant in entry.get("variants") or []
                        ],
                    }
                    for entry in section["entries"]
                ],
            }
            for section in briefing["sections"]
        ],
        "counts": briefing["counts"],
        "unsupported": briefing["unsupported"],
        "all_updates": briefing["all_updates"],
    }
    OUTPUT.write_text(json.dumps(document, indent=2, sort_keys=False) + "\n",
                      encoding="utf-8")
    print(f"wrote {OUTPUT.relative_to(ROOT)} "
          f"({len(document['sections'])} sections, "
          f"{sum(len(section['entries']) for section in document['sections'])} entries)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
