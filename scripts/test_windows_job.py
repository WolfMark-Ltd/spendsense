"""Windows Job Object ownership for a gated test worker and its descendants."""
import asyncio
import ctypes as c
from ctypes import wintypes as w
import time

kernel = c.WinDLL('kernel32', use_last_error=True)


def api(name, result, *args):
    function = getattr(kernel, name)
    function.restype = result
    function.argtypes = args
    return function


create_job = api('CreateJobObjectW', w.HANDLE, c.c_void_p, w.LPCWSTR)
open_process = api('OpenProcess', w.HANDLE, w.DWORD, w.BOOL, w.DWORD)
assign_process = api('AssignProcessToJobObject', w.BOOL, w.HANDLE, w.HANDLE)
close_handle = api('CloseHandle', w.BOOL, w.HANDLE)
set_info = api('SetInformationJobObject', w.BOOL, w.HANDLE, c.c_int, c.c_void_p, w.DWORD)
query_info = api('QueryInformationJobObject', w.BOOL, w.HANDLE, c.c_int, c.c_void_p, w.DWORD, c.c_void_p)
terminate = api('TerminateJobObject', w.BOOL, w.HANDLE, w.UINT)


def checked(result):
    if not result:
        raise c.WinError(c.get_last_error())
    return result


class BasicLimits(c.Structure):
    _fields_ = [('process_time', c.c_int64), ('job_time', c.c_int64),
                ('flags', w.DWORD), ('min_ws', c.c_size_t), ('max_ws', c.c_size_t),
                ('process_limit', w.DWORD), ('affinity', c.c_size_t),
                ('priority', w.DWORD), ('scheduling', w.DWORD)]


class ExtendedLimits(c.Structure):
    _fields_ = [('basic', BasicLimits), ('io_counters', c.c_uint64 * 6),
                ('memory', c.c_size_t * 4)]


class Accounting(c.Structure):
    _fields_ = [('times', c.c_int64 * 4), ('faults', w.DWORD), ('total', w.DWORD),
                ('active', w.DWORD), ('terminated', w.DWORD)]


class Job:
    def __init__(self):
        self.handle = checked(create_job(None, None))
        self.assigned = False
        limits = ExtendedLimits()
        limits.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        try:
            checked(set_info(self.handle, 9, c.byref(limits), c.sizeof(limits)))
        except OSError:
            self.close()
            raise

    def assign(self, pid):
        process = checked(open_process(0x101, False, pid))  # SET_QUOTA | TERMINATE
        try:
            checked(assign_process(self.handle, process))
            self.assigned = True
        finally:
            close_handle(process)

    def active(self):
        stats = Accounting()
        checked(query_info(self.handle, 1, c.byref(stats), c.sizeof(stats), None))
        return stats.active

    async def settle(self, *, natural_exit):
        if natural_exit and self.active():
            deadline = time.monotonic() + 0.5
            while self.active() and time.monotonic() < deadline:
                await asyncio.sleep(0.05)
        if not self.active():
            return 'verified (Windows job empty)', False
        checked(terminate(self.handle, 1))
        deadline = time.monotonic() + 3
        while self.active():
            if time.monotonic() >= deadline:
                raise RuntimeError('Windows job still has active processes')
            await asyncio.sleep(0.05)
        return 'verified after Windows job termination', True

    def close(self):
        close_handle(self.handle)
