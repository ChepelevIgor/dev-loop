#!/usr/bin/env python3
"""Track development tasks, save progress and resume checks after an interruption."""
import argparse
import json
import os
from pathlib import Path
import signal
import runpy
import sqlite3
import subprocess
import sys
import time

from runtime import Conflict, STAGES, Store, atomic_json, git_head


def config_file(path):
    value = json.loads(Path(path).read_text(encoding='utf-8'))
    if not isinstance(value, dict) or not isinstance(value.get('stages'), dict):
        raise ValueError('config needs a stages object')
    for stage, spec in value['stages'].items():
        if stage not in STAGES or not isinstance(spec, dict):
            raise ValueError('invalid stage config')
        argv = spec.get('argv')
        timeout = spec.get('timeout', 600)
        if not isinstance(argv, list) or not argv or any(not isinstance(arg, str) or '\0' in arg for arg in argv) or not argv[0]:
            raise ValueError('argv must be a nonempty array of strings')
        if type(timeout) not in (int, float) or not 0 < timeout <= 3600:
            raise ValueError('timeout must be 0..3600 seconds')
    return value['stages']


def terminate_group(process):
    # Workers run in their own process group, so timeout also stops their children.
    try:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=2)
    except ProcessLookupError:
        pass
    except subprocess.TimeoutExpired:
        pass
    finally:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()


def worker(store, record, spec, lock_fd):
    attempt = store.path('runtime/' + record['attempt_id'])
    attempt.mkdir(mode=0o700)
    request = {**record, 'root': str(store.root), 'project': str(store.root.parent), 'task': store.task(record['task_id'])}
    atomic_json(attempt / 'input.json', request)
    with (attempt/'input.json').open('rb') as stdin, (attempt/'stdout.json').open('wb') as stdout, (attempt/'stderr.log').open('wb') as stderr:
        # Inherit the consumer lock: if the parent dies, no second executor can run
        # while this worker is still alive. No interpolation of comment/task text.
        process = subprocess.Popen(spec['argv'], cwd=store.root.parent, stdin=stdin, stdout=stdout, stderr=stderr,
                                   start_new_session=True, pass_fds=(lock_fd,))
        try:
            deadline = time.monotonic() + spec.get('timeout', 600)
            while process.poll() is None:
                if time.monotonic() >= deadline:
                    raise TimeoutError('worker timed out')
                if os.fstat(stdout.fileno()).st_size > 1048576 or os.fstat(stderr.fileno()).st_size > 16777216:
                    raise ValueError('worker exceeded output limit')
                time.sleep(.05)
            if process.returncode:
                raise ValueError(f'worker exited {process.returncode}; see {attempt}/stderr.log')
        except BaseException:
            terminate_group(process)
            raise
    data = (attempt/'stdout.json').read_bytes()
    if len(data) > 1048576:
        raise ValueError('worker result exceeds 1 MiB')
    return json.loads(data)


def run(store, config, max_steps=32, watch_seconds=0):
    stages = config_file(config)
    with store.consumer() as lock:
        store.import_queue()
        store.recover()
        deadline = time.monotonic() + watch_seconds
        steps = 0
        while steps < max_steps:
            pending = store.snapshot()
            if not any(r['status'] in ('queued', 'ready') for r in pending):
                if time.monotonic() < deadline:
                    time.sleep(min(.25, max(0, deadline-time.monotonic())))
                    continue
                return 2 if any(r['status'] == 'blocked' for r in pending) else 0
            record = store.start(git_head(store.root.parent))
            if record is None:
                continue
            try:
                spec = stages.get(record['stage'])
                if spec is None:
                    raise ValueError(f"no configured worker for {record['stage']}")
                result = worker(store, record, spec, lock.fileno())
                updated = store.complete(record['request_id'], result, git_head(store.root.parent))
                print(json.dumps({'request_id': record['request_id'], 'stage': updated['stage'], 'status': updated['status']}, ensure_ascii=False), flush=True)
                if updated['status'] == 'blocked':
                    return 2
            except (ValueError, OSError, subprocess.SubprocessError, TimeoutError) as exc:
                # If completion committed before an export error, retain the committed success.
                current = store.get(record['request_id'])
                if current['status'] == 'running':
                    store.block(record['request_id'], record['attempt_id'], str(exc))
                print(str(exc), file=sys.stderr)
                return 2
            except KeyboardInterrupt:
                store.block(record['request_id'], record['attempt_id'], 'interrupted by user; inspect effects before resume')
                return 130
            steps += 1
        return 3 if any(r['status'] in ('queued', 'ready') for r in store.snapshot()) else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', default='.devloop', help='state directory inside the target Git project')
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('status', help='show saved tasks, progress and blockers')
    sub.add_parser('recover', help='mark interrupted attempts for reconciliation; does not resume them')
    help_parser = sub.add_parser('help', help='read the plugin guide or help for one skill')
    help_parser.add_argument('topic', nargs='?', help='skill name or guide topic; omit for the full guide')
    enqueue = sub.add_parser('enqueue', help='queue a task for implementation, a PR or another check')
    enqueue.add_argument('task_id', help='ID of a saved task in tasks/<id>/task.json')
    enqueue.add_argument('--action', choices=('execute', 'retest', 'pr'), default='execute',
                         help='execute: implement; retest: check again; pr: prepare the pull request')
    enqueue.add_argument('--comment', default='', help='instructions to keep with this request')
    resume = sub.add_parser('resume', help='continue a blocked request after its cause has been resolved')
    resume.add_argument('request_id', help='request ID shown by status')
    resume.add_argument('--comment', help='the answer the next stage reads (e.g. to business review questions)')
    send = sub.add_parser('send', help='what the page\'s Dev Loop button does: answer a blocked request or start a new one')
    send.add_argument('task_id', help='ID of a saved task in tasks/<id>/task.json')
    send.add_argument('--action', choices=('execute', 'retest', 'pr'), default='execute', help='used when a new request starts')
    send.add_argument('--comment', default='', help='what to change or answer')
    sub.add_parser('start', help='claim the next stage for the interactive agent')
    complete = sub.add_parser('complete', help='record completed-stage evidence and advance if valid')
    complete.add_argument('request_id', help='request ID shown by start')
    complete.add_argument('--result', required=True, help='path to the stage result JSON with evidence')
    block = sub.add_parser('block', help='record why the current attempt cannot continue')
    block.add_argument('request_id', help='request ID shown by start')
    block.add_argument('--attempt-id', required=True, help='attempt ID returned by start')
    block.add_argument('--reason', required=True, help='plain explanation of what needs attention')
    run_parser = sub.add_parser('run', help='run explicitly configured project workers for a limited time')
    run_parser.add_argument('--config', required=True, help='JSON file with project-specific stage commands')
    run_parser.add_argument('--max-steps', type=int, default=32, help='maximum stages to run (default: 32)')
    run_parser.add_argument('--watch-seconds', type=float, default=0, help='seconds to wait for queued work (default: 0)')
    args = parser.parse_args()
    if args.command == 'help':
        helper = Path(__file__).resolve().parents[2] / 'help' / 'scripts' / 'help.py'
        return runpy.run_path(str(helper))['main']([args.topic] if args.topic else [])
    try:
        store = Store(args.root)
        if args.command == 'status':
            result = store.snapshot()
        elif args.command == 'enqueue':
            result = store.enqueue(args.task_id, args.action, args.comment)
        elif args.command == 'send':
            result = store.request(args.task_id, args.action, args.comment)
        elif args.command == 'run':
            if args.max_steps < 1 or not 0 <= args.watch_seconds <= 86400:
                raise ValueError('max-steps must be positive; watch-seconds must be 0..86400')
            return run(store, args.config, args.max_steps, args.watch_seconds)
        else:
            with store.consumer():
                if args.command == 'recover':
                    store.import_queue()
                    store.recover()
                    result = store.snapshot()
                elif args.command == 'resume':
                    store.resume(args.request_id, args.comment)
                    result = store.get(args.request_id)
                elif args.command == 'start':
                    store.import_queue()
                    result = store.start(git_head(store.root.parent))
                elif args.command == 'complete':
                    evidence = json.loads(Path(args.result).read_text(encoding='utf-8'))
                    result = store.complete(args.request_id, evidence, git_head(store.root.parent))
                elif args.command == 'block':
                    store.block(args.request_id, args.attempt_id, args.reason)
                    result = store.get(args.request_id)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (ValueError, OSError, sqlite3.Error, subprocess.SubprocessError) as exc:
        parser.exit(2, f'dev-loop: {exc}\n')


if __name__ == '__main__':
    raise SystemExit(main())
