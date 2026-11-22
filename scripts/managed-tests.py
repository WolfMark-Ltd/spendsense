import argparse
import asyncio
import json
import os
import pathlib
import re
import signal
import sys

from test_guard import test_guard
from test_process import RunFailed, supervise

ROOT = pathlib.Path(__file__).resolve().parent.parent


async def run(args, directory):
    cancelled = asyncio.Event()
    loop = asyncio.get_running_loop()
    signals = [signal.SIGINT, signal.SIGTERM]
    if hasattr(signal, 'SIGBREAK'):
        signals.append(signal.SIGBREAK)
    for sig in signals:
        signal.signal(sig, lambda *_: loop.call_soon_threadsafe(cancelled.set))
    journal = directory / 'active-run'
    if journal.exists():
        raise RunFailed(f'previous cleanup was not verified; inspect {journal} before removing it')

    async def execute(command, **options):
        return await supervise(command, cwd=ROOT, journal=journal, cancelled=cancelled, **options)

    if args.suite in ('python', 'all'):
        pattern = args.test or 'test_*.py'
        await execute([sys.executable, '-m', 'unittest', 'discover', '-s', 'test', '-p', pattern])
    if args.suite == 'python':
        return
    for mode in ('browserless', 'browser') if args.suite == 'all' else (args.suite,):
        runner = [os.environ.get('SPENDSENSE_NODE', 'node'), 'scripts/node-tests.mjs']
        names = json.loads(await execute([*runner, '--plan', mode, *([args.test] if args.test else [])],
                                         timeout=15, capture=True))
        for name in names:
            print(f'Running {name}', flush=True)
            await execute([*runner, '--run', mode, name])
        print(f'{mode}: {len(names)} files passed', flush=True)


def main():
    parser = argparse.ArgumentParser(description='Run managed SpendSense tests')
    parser.add_argument('suite', choices=['browserless', 'browser', 'python', 'all'])
    parser.add_argument('test', nargs='?', help='exact test filename, with optional test/ prefix')
    args = parser.parse_args()
    if args.test:
        args.test = args.test.removeprefix('test/')
        pattern = r'test_\w+\.py' if args.suite == 'python' else r'[\w.-]+\.test\.mjs'
        if args.suite == 'all' or not re.fullmatch(pattern, args.test) or not (ROOT / 'test' / args.test).is_file():
            parser.error('supply an existing test filename for its suite')
    try:
        with test_guard() as directory:
            asyncio.run(run(args, directory))
    except (OSError, RuntimeError, ValueError) as error:
        print(f'SpendSense tests: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
