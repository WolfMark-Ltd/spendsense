"""Benchmark harness for SpendSense report performance (non-CI).

Machine-dependent thresholds live here, not in CI tests. CI tests assert
call counts and output equivalence (see test/test_perf_memo.py).

Usage:
  python3 bench/bench_reports.py --events 1000 17000 [--reps 2] [--snapshot FILE | --check FILE]
  python3 bench/bench_reports.py --events 17000 --concurrent 4 --reps 1
  python3 bench/bench_reports.py --events 17000 --cold   # subprocess per build
"""
from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import subprocess
import sys
import tempfile
import time
import tracemalloc
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import perf_fixture as PF
from wolfmark_ledger import aggregate, analytics, economics, forecast
from wolfmark_ledger import provider_native, store
from wolfmark_ledger import pricing as pricing_mod
from wolfmark_ledger.singleflight import REPORT_FLIGHT, analytics_key

VOLATILE_KEYS = {"as_of"}


class Counters:
    def __init__(self):
        self.reset()

    def reset(self):
        self.resolve_rate = 0
        self.native_lookup = 0
        self.provider_fetch = 0
        self.db_queries = 0


class counting:
    """Wrap hot functions with call counters for one measurement."""

    def __init__(self, counters: Counters, native_rows):
        self.c = counters
        self.native_rows = native_rows
        self.saved = {}

    def __enter__(self):
        c = self.c
        orig_resolve = pricing_mod.resolve_rate

        def resolve_rate(*a, **k):
            c.resolve_rate += 1
            return orig_resolve(*a, **k)

        self.saved["pricing.resolve_rate"] = pricing_mod.resolve_rate
        self.saved["aggregate.resolve_rate"] = aggregate.resolve_rate
        self.saved["analytics.resolve_rate"] = analytics.resolve_rate
        pricing_mod.resolve_rate = resolve_rate
        aggregate.resolve_rate = resolve_rate
        analytics.resolve_rate = resolve_rate

        orig_lookup = provider_native.lookup

        def lookup(*a, **k):
            c.native_lookup += 1
            return orig_lookup(*a, **k)

        self.saved["provider_native.lookup"] = provider_native.lookup
        provider_native.lookup = lookup

        rows = self.native_rows

        def fake_resolver(provider, *, force_refresh=False, cached_only=False, base_url=""):
            c.provider_fetch += 1
            return dict(rows.get(provider) or {})

        self.saved["_resolver"] = provider_native._resolver
        provider_native._resolver = lambda: fake_resolver  # noqa: E731
        provider_native.reset_for_tests()
        # reset_for_tests restores _real_resolver; re-apply fake after reset
        provider_native._resolver = lambda: fake_resolver  # noqa: E731

        orig_query = store.query_calls

        def query_calls(*a, **k):
            c.db_queries += 1
            return orig_query(*a, **k)

        self.saved["store.query_calls"] = store.query_calls
        store.query_calls = query_calls
        return self

    def __exit__(self, *exc):
        pricing_mod.resolve_rate = self.saved["pricing.resolve_rate"]
        aggregate.resolve_rate = self.saved["aggregate.resolve_rate"]
        analytics.resolve_rate = self.saved["analytics.resolve_rate"]
        provider_native.lookup = self.saved["provider_native.lookup"]
        provider_native._resolver = self.saved["_resolver"]
        provider_native.reset_for_tests()
        store.query_calls = self.saved["store.query_calls"]
        return False


_MEM_PROFILE = False


def measure(fn):
    if _MEM_PROFILE:
        tracemalloc.start()
    t0 = time.perf_counter()
    c0 = time.process_time()
    try:
        out = fn()
    finally:
        cpu = time.process_time() - c0
        wall = time.perf_counter() - t0
        if _MEM_PROFILE:
            _, peak = tracemalloc.get_traced_memory()
            tracemalloc.stop()
        else:
            peak = 0
    # NOTE: wall/cpu are measured WITHOUT tracemalloc (it adds large
    # overhead on allocation-heavy aggregation). Use --mem for a separate
    # allocation-profile pass; wall numbers from that pass are inflated.
    return out, {"wall_s": wall, "cpu_s": cpu, "peak_bytes": peak}


def normalize(report):
    """Replace volatile wall-clock strings so snapshots compare exactly."""
    if isinstance(report, dict):
        return {k: ("<TS>" if k in VOLATILE_KEYS else normalize(v))
                for k, v in report.items()}
    if isinstance(report, list):
        return [normalize(v) for v in report]
    return report


def build_all(fx, book, plans):
    out = {}
    c = Counters()
    with counting(c, PF.native_rows()):
        r1, m1 = measure(lambda: analytics.build_analytics_report(
            fx["events"], state_db_path=fx["state"], now=PF.NOW, catalogue=book, days=1))
        n1 = dict(vars(c)); c.reset()
        r7, m7 = measure(lambda: analytics.build_analytics_report(
            fx["events"], state_db_path=fx["state"], now=PF.NOW, catalogue=book, days=7))
        n7 = dict(vars(c)); c.reset()
        r30, m30 = measure(lambda: analytics.build_analytics_report(
            fx["events"], state_db_path=fx["state"], now=PF.NOW, catalogue=book, days=30))
        n30 = dict(vars(c)); c.reset()
        re_, me = measure(lambda: economics.build_economics_report(
            now=PF.NOW, event_db_path=fx["events"], state_db_path=fx["state"],
            membership_path=fx["memberships"], fx_file=fx["fx"], catalogue=book,
            plans=plans))
        ne = dict(vars(c)); c.reset()
        rb, mb = measure(lambda: forecast.build_report(
            path=fx["budgets"], event_db_path=fx["events"], now=PF.NOW,
            catalogue=book, fx_path=fx["fx"], state_db_path=fx["state"]))
        nb = dict(vars(c))
    out["analytics_1"] = {"metrics": m1, "counts": n1, "report": normalize(r1)}
    out["analytics_7"] = {"metrics": m7, "counts": n7, "report": normalize(r7)}
    out["analytics_30"] = {"metrics": m30, "counts": n30, "report": normalize(r30)}
    out["economics"] = {"metrics": me, "counts": ne, "report": normalize(re_)}
    out["budgets"] = {"metrics": mb, "counts": nb, "report": normalize(rb)}
    return out


def cold_build(n_events, which):
    """Build one report in a fresh subprocess (cold imports + caches)."""
    code = (
        "import sys, time, json;"
        f"sys.path.insert(0, {str(ROOT)!r}); sys.path.insert(0, {str(Path(__file__).resolve().parent)!r});"
        "import perf_fixture as PF;"
        "from wolfmark_ledger import analytics, economics, provider_native;"
        "fx = PF.build_fixture(__import__('tempfile').mkdtemp(), "
        f"{n_events}, seed=20261126);"
        "book = PF.fixture_catalogue();"
        "rows = PF.native_rows();"
        "provider_native._resolver = lambda: (lambda p, *, force_refresh=False, cached_only=False, base_url='': dict(rows.get(p) or {}));"
        "t0 = time.perf_counter();"
        + (f"r = analytics.build_analytics_report(fx['events'], state_db_path=fx['state'], now=PF.NOW, catalogue=book, days={which});"
           if which != "econ" else
           "r = economics.build_economics_report(now=PF.NOW, event_db_path=fx['events'], state_db_path=fx['state'], membership_path=fx['memberships'], fx_file=fx['fx'], catalogue=book, plans=PF.build_plans());")
        + "import resource;"
        + "print(f\"{time.perf_counter()-t0:.3f} {(r.get('totals') or {}).get('calls', '?')} maxrss={resource.getrusage(resource.RUSAGE_SELF).ru_maxrss // 1024}MB\")"
    )
    t0 = time.perf_counter()
    p = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=600)
    wall = time.perf_counter() - t0
    return {"subprocess_wall_s": wall, "out": (p.stdout or "").strip()[-120:],
            "err": (p.stderr or "")[-300:] if p.returncode else ""}


def _overview_burst(fx, book, plans):
    def run_one(kind):
        # Fixture-anchored now (plus a per-thread stagger to mimic
        # near-simultaneous arrival); live wall time would leave
        # the fixed windows near-empty and meaningless.
        now = PF.NOW + {"d1": 0.0, "d7": 0.1, "d30": 0.2,
                        "econ": 0.3}[kind]
        if kind == "econ":
            return economics.build_economics_report(
                now=now, event_db_path=fx["events"],
                state_db_path=fx["state"],
                membership_path=fx["memberships"], fx_file=fx["fx"],
                catalogue=book, plans=plans)
        return analytics.build_analytics_report(
            fx["events"], state_db_path=fx["state"], now=now,
            catalogue=book, days=int(kind[1:]))

    t0 = time.perf_counter()
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as ex:
        futs = {ex.submit(run_one, k): k
                for k in ("d1", "d7", "d30", "econ")}
        done = {}
        for f in concurrent.futures.as_completed(futs):
            f.result()  # surface worker exceptions, never swallow
            done[futs[f]] = time.perf_counter() - t0
    wall = time.perf_counter() - t0
    order = sorted(done.items(), key=lambda kv: kv[1])
    print(f"overviewburst wall={wall:.3f}s first={order[0][0]}@{order[0][1]:.3f}s "
          f"order=" + ",".join(f"{k}@{v:.2f}" for k, v in order),
          flush=True)




def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--events", nargs="+", type=int, default=[17000])
    ap.add_argument("--reps", type=int, default=2)
    ap.add_argument("--snapshot", default=None)
    ap.add_argument("--check", default=None)
    ap.add_argument("--concurrent", type=int, default=0)
    ap.add_argument("--retryburst", type=int, default=0,
                    help="N threads sharing one analytics_30 via REPORT_FLIGHT")
    ap.add_argument("--overviewburst", action="store_true",
                    help="Fire d1+d7+d30+economics concurrently (Overview open shape)")
    ap.add_argument("--cold", action="store_true")
    ap.add_argument("--mem", action="store_true",
                    help="Separate allocation-profile pass (peak Python bytes)")
    args = ap.parse_args()
    global _MEM_PROFILE
    _MEM_PROFILE = bool(args.mem)

    for n in args.events:
        with tempfile.TemporaryDirectory() as tmp:
            fx = PF.build_fixture(Path(tmp) / "fx", n)
            book = PF.fixture_catalogue()
            plans = PF.build_plans()
            print(f"=== events={n} ===", flush=True)
            for rep in range(args.reps):
                res = build_all(fx, book, plans)
                for name in ("analytics_1", "analytics_7", "analytics_30", "economics",
                             "budgets"):
                    m, cc = res[name]["metrics"], res[name]["counts"]
                    print(f"rep{rep} {name}: wall={m['wall_s']:.3f}s cpu={m['cpu_s']:.3f}s "
                          f"peak={m['peak_bytes']/1e6:.1f}MB resolve={cc['resolve_rate']} "
                          f"native={cc['native_lookup']} fetch={cc['provider_fetch']} "
                          f"dbq={cc['db_queries']}", flush=True)
                if args.snapshot and rep == 0:
                    snap = {name: res[name]["report"] for name in res}
                    path = Path(args.snapshot)
                    doc = (json.loads(path.read_text())
                           if path.exists() else {"fixtures": {}})
                    doc.setdefault("fixtures", {})[str(n)] = snap
                    path.write_text(json.dumps(doc, sort_keys=True))
                    print(f"snapshot[{n}] -> {args.snapshot}", flush=True)
                if args.check and rep == 0:
                    doc = json.loads(Path(args.check).read_text())
                    want = doc.get("fixtures", {}).get(str(n))
                    if want is None and doc.get("events") == n:
                        want = doc.get("reports")  # legacy single-size shape
                    if want is None:
                        print(f"check: no baseline for events={n} in {args.check}",
                              flush=True)
                    else:
                        for name in want:
                            got = json.dumps(res[name]["report"], sort_keys=True)
                            exp = json.dumps(want[name], sort_keys=True)
                            print(f"check {name}: {'IDENTICAL' if got == exp else 'DIFFERS'}",
                                  flush=True)
            if args.concurrent:
                with counting(Counters(), PF.native_rows()):
                    def one():
                        return analytics.build_analytics_report(
                            fx["events"], state_db_path=fx["state"], now=PF.NOW,
                            catalogue=book, days=30)
                    t0 = time.perf_counter()
                    with concurrent.futures.ThreadPoolExecutor(max_workers=args.concurrent) as ex:
                        outs = list(ex.map(lambda _: one(), range(args.concurrent)))
                    wall = time.perf_counter() - t0
                same = all(json.dumps(normalize(o), sort_keys=True) == json.dumps(
                    normalize(outs[0]), sort_keys=True) for o in outs[1:])
                print(f"concurrent x{args.concurrent} identical days=30: wall={wall:.3f}s "
                      f"all_identical={same}", flush=True)
            if args.retryburst:
                builds = []
                with counting(Counters(), PF.native_rows()):
                    def one(i):
                        now = PF.NOW + i * 0.1
                        key = analytics_key(
                            days=30, model=None, provider=None, surface=None,
                            task=None, parent=None, scope=None,
                            pricing_mode="strict", presentation="both",
                            arrangements=None, now=now,
                            event_db=str(fx["events"]), state_db=str(fx["state"]),
                            profiles_path=None, catalogue=book)

                        def build():
                            builds.append(1)
                            return analytics.build_analytics_report(
                                fx["events"], state_db_path=fx["state"], now=now,
                                catalogue=book, days=30)

                        return REPORT_FLIGHT.run(key, build)
                    t0 = time.perf_counter()
                    with concurrent.futures.ThreadPoolExecutor(
                            max_workers=args.retryburst) as ex:
                        outs = list(ex.map(one, range(args.retryburst)))
                    wall = time.perf_counter() - t0
                same = all(json.dumps(normalize(o), sort_keys=True) == json.dumps(
                    normalize(outs[0]), sort_keys=True) for o in outs[1:])
                print(f"retryburst x{args.retryburst} shared days=30: wall={wall:.3f}s "
                      f"builds={len(builds)} all_identical={same}", flush=True)
            if args.overviewburst:
                # Same fixture pricing context as every other mode: without
                # it the pool would use the real resolver (or none) and the
                # wall figure would not be comparable.
                with counting(Counters(), PF.native_rows()):
                    _overview_burst(fx, book, plans)


            if args.cold:
                for which in (30, "econ"):
                    print(f"cold {which}: {cold_build(n, which)}", flush=True)


if __name__ == "__main__":
    main()

