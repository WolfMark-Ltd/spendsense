"""One-off sampling of guarded test invocations on a disposable Linux runner."""
import json
import os
from pathlib import Path
import re
import subprocess
import time

CGROUP = Path('/sys/fs/cgroup')
INTERVAL = 0.2


def keys(path):
    return {
        key: int(value)
        for key, value in (line.split() for line in path.read_text().splitlines())
    }


def pids(group):
    return sorted(set(map(int, (group / 'cgroup.procs').read_text().split())))


def sample(group):
    processes = pids(group)
    rss = pss = chrome_rss = chrome_pss = chrome_count = skipped_pss = 0
    for pid in processes:
        proc = Path('/proc') / str(pid)
        try:
            status = (proc / 'status').read_text()
        except ProcessLookupError:
            continue
        except FileNotFoundError:
            continue
        match = re.search(r'^VmRSS:\s+(\d+)', status, re.M)
        if not match:
            continue
        resident = int(match[1])
        name = (re.search(r'^Name:\s+(\S+)', status, re.M) or ['',''])[1]
        chrome = name.startswith(('chrome', 'chromium'))
        rss += resident
        chrome_count += int(chrome)
        chrome_rss += resident if chrome else 0
        try:
            proportional = re.search(r'^Pss:\s+(\d+)', (proc / 'smaps_rollup').read_text(), re.M)
            if proportional is None:
                skipped_pss += 1
                continue
            amount = int(proportional[1])
        except OSError:
            skipped_pss += 1
            continue
        pss += amount
        chrome_pss += amount if chrome else 0

    return dict(processes=len(processes), rss_kib=rss, pss_kib=pss,
                chrome_rss_kib=chrome_rss, chrome_pss_kib=chrome_pss,
                chrome_processes=chrome_count, skipped_pss=skipped_pss,
                memory_bytes=int((group / 'memory.current').read_text()))


def profile(mode, filename):
    group = CGROUP / f'spendsense-profile-{os.getpid()}-{filename}'
    subprocess.run(['sudo', '-n', 'mkdir', str(group)], check=True)
    command = ['bash', 'scripts/node-tests.sh', mode, filename]
    try:
        baseline = sample(group)
        cpu_before = keys(group / 'cpu.stat')['usage_usec']
        events_before = keys(group / 'memory.events')
        (group / 'memory.peak').read_text()
        started = time.monotonic()
        print('PROFILE_CMD', json.dumps(command), flush=True)
        # Move the shell before exec. The actual test guard and supervisor, and
        # all their descendants, stay in the cgroup even when they change session.
        with subprocess.Popen([
            'bash', '-ec',
            """sudo -n sh -c 'echo "$1" > "$2/cgroup.procs"' sh "$$" "$1"
shift
exec "$@"
""", 'profile', str(group), *command,
        ]) as worker:
            samples = []
            while worker.poll() is None:
                point = sample(group)
                point['elapsed_s'] = round(time.monotonic() - started, 2)
                samples.append(point)
                events = keys(group / 'memory.events')
                if any(events[key] > events_before[key] for key in ('oom', 'oom_kill')):
                    worker.terminate()
                    raise RuntimeError('cgroup reported OOM activity; stopping the profile')
                time.sleep(INTERVAL)
            seconds = time.monotonic() - started
            result = worker.returncode
        initial_survivors = pids(group)
        time.sleep(1)
        survivors = pids(group)
        after = sample(group)
        stats_after = keys(group / 'memory.stat')
        memory_events = keys(group / 'memory.events')
        peak_rss = max(samples, key=lambda row: row['rss_kib'])
        complete_pss = [row for row in samples if row['skipped_pss'] == 0]
        peak_pss = max(complete_pss, key=lambda row: row['pss_kib'], default=None)
        peaks_by_third = [
            max((row['rss_kib'] for row in samples
                 if min(2, int(3 * row['elapsed_s'] / seconds)) == third), default=0)
            for third in range(3)
        ]
        print('PROFILE_RESULT', json.dumps(dict(
            suite=filename, exit=result, samples=len(samples),
            seconds=round(seconds, 2),
            cpu_seconds=round((keys(group / 'cpu.stat')['usage_usec'] - cpu_before) / 1e6, 2),
            cgroup_peak_bytes=int((group / 'memory.peak').read_text()),
            peak_rss=peak_rss, peak_pss=peak_pss, complete_pss_samples=len(complete_pss),
            peak_processes=max(row['processes'] for row in samples),
            peak_chrome_processes=max(row['chrome_processes'] for row in samples),
            pids_peak_tasks=(int((group / 'pids.peak').read_text()) if (group / 'pids.peak').exists() else None),
            rss_peak_by_third_kib=peaks_by_third,
            baseline=baseline, after=after, after_anon_bytes=stats_after.get('anon'),
            after_file_bytes=stats_after.get('file'), initial_survivors=initial_survivors,
            survivors=survivors, memory_events=memory_events,
        ), sort_keys=True), flush=True)
        if result or initial_survivors or survivors or any(
            memory_events[key] > events_before[key] for key in ('oom', 'oom_kill')
        ):
            raise RuntimeError('guarded run failed or left live processes; stopping further workloads')
    finally:
        if not pids(group):
            subprocess.run(['sudo', '-n', 'rmdir', str(group)], check=True)


print('PROFILE_ENV', json.dumps({
    'image_os': os.environ.get('ImageOS'), 'image_version': os.environ.get('ImageVersion'),
    'kernel': os.uname().release, 'cpus': os.cpu_count(),
    'memtotal': Path('/proc/meminfo').read_text().splitlines()[0],
    'node': subprocess.check_output(['node', '--version'], text=True).strip(),
    'python': subprocess.check_output(['python3', '--version'], text=True).strip(),
    'chrome': subprocess.check_output(['google-chrome', '--version'], text=True).strip(),
    'sample_interval_s': INTERVAL,
}), flush=True)
for workload in (
    ('browserless', 'usage-render.test.mjs'),
    ('browser', 'sidebar-layout.test.mjs'),
    ('browser', 'overview-layout.test.mjs'),
):
    profile(*workload)
