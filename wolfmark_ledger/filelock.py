"""Cross-process file locks for the JSON stores.

``membership_store`` and ``billing`` both persist whole documents with a
read-modify-write cycle, so every write runs under the exclusive lock to
stop two processes losing each other's update. Multi-file reads use the
shared lock so they see a consistent snapshot without serialising
against each other. The lock is held on a sidecar file next to the store
(``<name>.json.lock``); the handle is only a token and is never read
from or written to.

POSIX uses ``fcntl.flock``; Windows uses a one-byte ``msvcrt.locking``
range at offset 0. Exclusive locks are acquired with a blocking wait
(the CRT's ``LK_LOCK`` gives up after ~10s with ``EDEADLK``, so
contention is retried until the lock is held). Shared locks wait at
most ``SHARED_LOCK_TIMEOUT`` seconds and then raise instead of stalling
an API worker: a contended read fails loudly as ``LockUnavailable``
(→ HTTP 503, retry) rather than hanging past the transport timeout.
Anything else fails closed: an unsupported platform or a lock failure
raises instead of proceeding unlocked.

Neither lock is re-entrant and they must not be nested on the same file:
the Windows byte-range lock conflicts even within one process, and a
nested shared request would time out rather than deadlock.
"""

from __future__ import annotations

import errno
import os
import time
from contextlib import contextmanager
from pathlib import Path
from typing import BinaryIO, Iterator


#: Longest a consistent-snapshot read waits for a writer. Writes are
#: milliseconds; anything longer means real contention, and the Desktop
#: transport gives up at 15 s anyway.
SHARED_LOCK_TIMEOUT = 5.0


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


def _lock_shared(handle: BinaryIO, timeout: float) -> None:
    deadline = time.monotonic() + timeout
    if os.name == "nt":
        import msvcrt

        # The CRT has no shared locks: brief exclusive waits preserve the
        # consistency guarantee without hanging readers.
        handle.seek(0)
        while True:
            try:
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                return
            except OSError:
                if time.monotonic() >= deadline:
                    raise LockUnavailable(
                        f"could not lock {handle.name}: timed out waiting for readers' lock"
                    )
                time.sleep(0.02)
    elif os.name == "posix":
        import fcntl

        while True:
            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_SH | fcntl.LOCK_NB)
                return
            except OSError as exc:
                if exc.errno not in (errno.EACCES, errno.EAGAIN):
                    raise LockUnavailable(f"could not lock {handle.name}: {exc}") from exc
                if time.monotonic() >= deadline:
                    raise LockUnavailable(
                        f"could not lock {handle.name}: timed out waiting for readers' lock"
                    )
                time.sleep(0.02)
    else:  # pragma: no cover - exercised via mock, not a real platform
        raise LockUnavailable(f"no file locking available on {os.name!r}")


@contextmanager
def shared(target: Path, timeout: float = SHARED_LOCK_TIMEOUT) -> Iterator[BinaryIO]:
    """Shared cross-process lock for a consistent multi-file snapshot read.

    Readers never block each other; they wait for an active writer only up
    to ``timeout`` and then raise :class:`LockUnavailable` instead of
    stalling the API worker past the transport timeout.
    """
    target.parent.mkdir(parents=True, exist_ok=True)
    handle = open(target.with_suffix(target.suffix + ".lock"), "a+b")
    try:
        _lock_shared(handle, timeout)
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
