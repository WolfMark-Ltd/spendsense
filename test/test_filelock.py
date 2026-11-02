"""Cross-process locking for the JSON stores.

Every write to ``memberships.json`` / ``billing-profiles.json`` runs a
read-modify-write cycle under an exclusive lock, so concurrent writers in
separate processes must never lose each other's update, and same-revision
races must surface as conflicts rather than silent overwrites.

The concurrency tests use spawned (never forked) processes: ``spawn`` is
the only start method on Windows, so the same test binary proves the
POSIX ``flock`` path and the Windows ``msvcrt`` path on their own CI.
"""

from __future__ import annotations

import multiprocessing as mp
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from wolfmark_ledger import billing
from wolfmark_ledger import filelock
from wolfmark_ledger import membership_store

SPAWN = mp.get_context("spawn")
JOIN_TIMEOUT = 120
WORKERS = 8
WRITES_EACH = 4


def _billing_writer(path_str: str, worker: int, barrier: "mp.synchronize.Barrier") -> None:
    from pathlib import Path as _Path

    from wolfmark_ledger import billing as _billing

    path = _Path(path_str)
    barrier.wait()
    for i in range(WRITES_EACH):
        pid = f"p{worker}-{i}"
        _billing.save_profile(
            {"id": pid, "kind": "api", "provider": "commandcode", "label": pid}, path
        )


def _membership_writer(path_str: str, worker: int, barrier: "mp.synchronize.Barrier") -> None:
    from pathlib import Path as _Path

    from wolfmark_ledger import membership_store as _store

    path = _Path(path_str)
    barrier.wait()
    for i in range(WRITES_EACH):
        aid = f"a{worker}-{i}"
        _store.save_account(
            {"id": aid, "family": "openai-codex", "label": aid,
             "route_slugs": ["openai-codex"], "plan_id": None},
            path,
        )


def _billing_conflict_racer(path_str: str, rev: str, label: str,
                            queue: "mp.queues.Queue",
                            barrier: "mp.synchronize.Barrier") -> None:
    from pathlib import Path as _Path

    from wolfmark_ledger import billing as _billing

    barrier.wait()
    try:
        _billing.save_profile(
            {"id": "shared", "kind": "api", "provider": "commandcode", "label": label},
            _Path(path_str),
            if_rev=rev,
        )
        queue.put("ok")
    except _billing.ProfileConflict:
        queue.put("conflict")
    except Exception as exc:  # surface crashes, don't mask them as conflicts
        queue.put(f"error: {exc!r}")


def _membership_conflict_racer(path_str: str, rev: str, label: str,
                               queue: "mp.queues.Queue",
                               barrier: "mp.synchronize.Barrier") -> None:
    from pathlib import Path as _Path

    from wolfmark_ledger import membership_store as _store

    barrier.wait()
    try:
        _store.save_account(
            {"id": "shared", "family": "openai-codex", "label": label,
             "route_slugs": ["openai-codex"], "plan_id": None},
            _Path(path_str),
            if_rev=rev,
        )
        queue.put("ok")
    except _store.MembershipConflict:
        queue.put("conflict")
    except Exception as exc:  # surface crashes, don't mask them as conflicts
        queue.put(f"error: {exc!r}")


def _join_all(test: unittest.TestCase, procs: list) -> None:
    """Join with a timeout: a locking regression must fail, not hang CI."""
    deadline = time.monotonic() + JOIN_TIMEOUT
    hung = []
    for proc in procs:
        proc.join(max(0.0, deadline - time.monotonic()))
        if proc.is_alive():
            hung.append(proc)
    for proc in hung:
        proc.terminate()
    for proc in hung:
        proc.join(10)
    if hung:
        names = ", ".join(proc.name for proc in hung)
        test.fail(f"workers hung and were terminated ({names}): the lock may be broken")


class CrossProcessBillingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.path = Path(self.dir.name) / "billing-profiles.json"
        billing.save_profile({"id": "seed", "kind": "api", "provider": "commandcode"},
                             self.path)

    def test_spawned_writers_all_records_survive(self) -> None:
        barrier = SPAWN.Barrier(WORKERS)
        procs = [SPAWN.Process(target=_billing_writer, name=f"writer-{w}",
                               args=(str(self.path), w, barrier))
                 for w in range(WORKERS)]
        for proc in procs:
            proc.start()
        _join_all(self, procs)
        self.assertEqual([p.exitcode for p in procs], [0] * WORKERS)
        ids = {p["id"] for p in billing.load_profiles(self.path)["profiles"]}
        expect = {"seed"} | {f"p{w}-{i}" for w in range(WORKERS)
                               for i in range(WRITES_EACH)}
        self.assertEqual(ids, expect)

    def test_same_revision_race_has_exactly_one_winner(self) -> None:
        billing.save_profile({"id": "shared", "kind": "api",
                              "provider": "commandcode", "label": "v0"}, self.path)
        rev = next(p["rev"] for p in billing.load_profiles(self.path)["profiles"]
                   if p["id"] == "shared")
        queue: mp.queues.Queue = SPAWN.Queue()
        barrier = SPAWN.Barrier(4)
        procs = [SPAWN.Process(target=_billing_conflict_racer, name=f"racer-{w}",
                               args=(str(self.path), rev, f"v{w + 1}", queue, barrier))
                 for w in range(4)]
        for proc in procs:
            proc.start()
        _join_all(self, procs)
        outcomes = sorted(queue.get(timeout=JOIN_TIMEOUT) for _ in procs)
        self.assertEqual(outcomes, ["conflict", "conflict", "conflict", "ok"])
        shared = next(p for p in billing.load_profiles(self.path)["profiles"]
                      if p["id"] == "shared")
        self.assertNotEqual(shared["rev"], rev)


class CrossProcessMembershipTests(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.path = Path(self.dir.name) / "memberships.json"
        membership_store.save_account(
            {"id": "seed", "family": "openai-codex", "label": "seed",
             "route_slugs": ["openai-codex"], "plan_id": None},
            self.path)

    def test_spawned_writers_all_records_survive(self) -> None:
        barrier = SPAWN.Barrier(WORKERS)
        procs = [SPAWN.Process(target=_membership_writer, name=f"writer-{w}",
                               args=(str(self.path), w, barrier))
                 for w in range(WORKERS)]
        for proc in procs:
            proc.start()
        _join_all(self, procs)
        self.assertEqual([p.exitcode for p in procs], [0] * WORKERS)
        ids = {a["id"] for a in membership_store.load_store(self.path)["accounts"]}
        expect = {"seed"} | {f"a{w}-{i}" for w in range(WORKERS)
                               for i in range(WRITES_EACH)}
        self.assertEqual(ids, expect)

    def test_same_revision_race_has_exactly_one_winner(self) -> None:
        membership_store.save_account(
            {"id": "shared", "family": "openai-codex", "label": "v0",
             "route_slugs": ["openai-codex"], "plan_id": None},
            self.path)
        rev = membership_store.accounts_by_id(self.path)["shared"]["rev"]
        queue: mp.queues.Queue = SPAWN.Queue()
        barrier = SPAWN.Barrier(4)
        procs = [SPAWN.Process(target=_membership_conflict_racer, name=f"racer-{w}",
                               args=(str(self.path), rev, f"v{w + 1}", queue, barrier))
                 for w in range(4)]
        for proc in procs:
            proc.start()
        _join_all(self, procs)
        outcomes = sorted(queue.get(timeout=JOIN_TIMEOUT) for _ in procs)
        self.assertEqual(outcomes, ["conflict", "conflict", "conflict", "ok"])
        self.assertNotEqual(membership_store.accounts_by_id(self.path)["shared"]["rev"],
                            rev)


class SidecarNamingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)

    def test_billing_lock_sidecar_name_preserved(self) -> None:
        path = Path(self.dir.name) / "billing-profiles.json"
        billing.save_profile({"id": "x", "kind": "api", "provider": "commandcode"}, path)
        self.assertTrue((path.parent / "billing-profiles.json.lock").exists())

    def test_membership_lock_sidecar_name_preserved(self) -> None:
        path = Path(self.dir.name) / "memberships.json"
        membership_store.save_account(
            {"id": "x", "family": "openai-codex", "label": "x",
             "route_slugs": ["openai-codex"], "plan_id": None},
            path)
        self.assertTrue((path.parent / "memberships.json.lock").exists())


class FailClosedTests(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.path = Path(self.dir.name) / "store.json"

    def test_unknown_platform_raises_without_running_body(self) -> None:
        ran = []
        with patch("os.name", "riscos"):
            with self.assertRaises(filelock.LockUnavailable):
                with filelock.locked(self.path):
                    ran.append(True)
        self.assertEqual(ran, [])

    @unittest.skipUnless(sys.platform != "win32", "POSIX flock path")
    def test_lock_failure_raises_and_skips_body(self) -> None:
        import fcntl

        ran = []
        with patch.object(fcntl, "flock", side_effect=OSError("denied")):
            with self.assertRaises(filelock.LockUnavailable):
                with filelock.locked(self.path):
                    ran.append(True)
        self.assertEqual(ran, [])

    def test_windows_dispatch_uses_byte_range_lock(self) -> None:
        import sys as _sys

        calls: list = []

        class FakeMsvcrt:
            LK_LOCK = "LK_LOCK"
            LK_UNLCK = "LK_UNLCK"

            @staticmethod
            def locking(fd: int, mode: str, nbytes: int) -> None:
                calls.append((mode, nbytes))

        with patch("os.name", "nt"):
            with patch.dict(_sys.modules, {"msvcrt": FakeMsvcrt}):
                with filelock.locked(self.path):
                    pass
        self.assertEqual(calls, [("LK_LOCK", 1), ("LK_UNLCK", 1)])

    def test_windows_lock_failure_raises_and_skips_body(self) -> None:
        import sys as _sys

        class FailingMsvcrt:
            LK_LOCK = "LK_LOCK"
            LK_UNLCK = "LK_UNLCK"

            @staticmethod
            def locking(fd: int, mode: str, nbytes: int) -> None:
                if mode == "LK_LOCK":
                    raise OSError("lock timeout")
                raise AssertionError("unlock must not run when locking failed")

        ran = []
        with patch("os.name", "nt"):
            with patch.dict(_sys.modules, {"msvcrt": FailingMsvcrt}):
                with self.assertRaises(filelock.LockUnavailable):
                    with filelock.locked(self.path):
                        ran.append(True)
        self.assertEqual(ran, [])

    def test_windows_contention_retries_until_acquired(self) -> None:
        import errno as _errno
        import sys as _sys

        calls: list = []

        class ContendedMsvcrt:
            LK_LOCK = "LK_LOCK"
            LK_UNLCK = "LK_UNLCK"

            @staticmethod
            def locking(fd: int, mode: str, nbytes: int) -> None:
                calls.append(mode)
                # LK_LOCK waits ~10s then reports EDEADLK while another
                # process holds the range; that must wait, not fail.
                if mode == "LK_LOCK" and calls.count("LK_LOCK") < 3:
                    raise OSError(_errno.EDEADLK, "lock contention")

        ran = []
        with patch("os.name", "nt"):
            with patch.dict(_sys.modules, {"msvcrt": ContendedMsvcrt}):
                with filelock.locked(self.path):
                    ran.append(True)
        self.assertEqual(ran, [True])
        self.assertEqual(calls, ["LK_LOCK", "LK_LOCK", "LK_LOCK", "LK_UNLCK"])

    def test_windows_non_contention_error_fails_fast(self) -> None:
        import errno as _errno
        import sys as _sys

        calls: list = []

        class BrokenMsvcrt:
            LK_LOCK = "LK_LOCK"
            LK_UNLCK = "LK_UNLCK"

            @staticmethod
            def locking(fd: int, mode: str, nbytes: int) -> None:
                calls.append(mode)
                raise OSError(_errno.EACCES, "locking violation")

        with patch("os.name", "nt"):
            with patch.dict(_sys.modules, {"msvcrt": BrokenMsvcrt}):
                with self.assertRaises(filelock.LockUnavailable):
                    with filelock.locked(self.path):
                        pass
        self.assertEqual(calls, ["LK_LOCK"])


if __name__ == "__main__":
    unittest.main()
