"""Cross-process exclusive file lock for the JSON stores.

``membership_store`` and ``billing`` both persist whole documents with a
read-modify-write cycle, so every write runs under this lock to stop two
processes losing each other's update. The lock is held on a sidecar file
next to the store (``<name>.json.lock``); the handle is only a token and
is never read from or written to.

POSIX uses ``fcntl.flock``; Windows uses a one-byte ``msvcrt.locking``
range at offset 0. Both are real cross-process exclusive locks acquired
with a blocking wait (the CRT's ``LK_LOCK`` gives up after ~10s with
``EDEADLK``, so contention is retried until the lock is held).
Anything else fails closed: an unsupported platform or a lock failure
raises instead of writing unlocked.

The lock is not re-entrant and must not be nested on the same file: the
Windows byte-range lock conflicts even within one process.
"""

from __future__ import annotations

import errno
import os
from contextlib import contextmanager
from pathlib import Path
from typing import BinaryIO, Iterator


class LockUnavailable(OSError):
    """No usable file lock: the write must not proceed unlocked."""


def _lock_handle(handle: BinaryIO) -> None:
    if os.name == "nt":
        import msvcrt

        handle.seek(0)
        while True:
            try:
                msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
                break
            except OSError as exc:
                if exc.errno == errno.EDEADLK:
                    # Ordinary contention: LK_LOCK already waited ~10s, so
                    # re-enter it and keep waiting like flock(LOCK_EX)
                    # rather than failing the write.
                    continue
                raise LockUnavailable(f"could not lock {handle.name}: {exc}") from exc
    elif os.name == "posix":
        import fcntl

        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        except OSError as exc:
            raise LockUnavailable(f"could not lock {handle.name}: {exc}") from exc
    else:  # pragma: no cover - exercised via mock, not a real platform
        raise LockUnavailable(f"no file locking available on {os.name!r}")


def _unlock_handle(handle: BinaryIO) -> None:
    if os.name == "nt":
        import msvcrt

        handle.seek(0)
        msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
    elif os.name == "posix":
        import fcntl

        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    else:  # pragma: no cover - exercised via mock, not a real platform
        raise LockUnavailable(f"no file locking available on {os.name!r}")


@contextmanager
def locked(target: Path) -> Iterator[BinaryIO]:
    """Exclusive cross-process lock around a store's read-modify-write cycle.

    A lock failure raises :class:`LockUnavailable` and the body never runs,
    so a store is never written without the lock held.
    """
    target.parent.mkdir(parents=True, exist_ok=True)
    handle = open(target.with_suffix(target.suffix + ".lock"), "a+b")
    try:
        _lock_handle(handle)
    except BaseException:
        handle.close()
        raise
    try:
        yield handle
    finally:
        try:
            _unlock_handle(handle)
        finally:
            handle.close()
