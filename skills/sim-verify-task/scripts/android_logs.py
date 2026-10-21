#!/usr/bin/env python3
"""Incremental logcat snapshot; never clears the device log buffer."""
import argparse
from collections import Counter
from decimal import Decimal
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

STAMP = re.compile(r'^\s*(\d+\.\d+)\s')


def delta(text, cursor=None, pattern=''):
    entries = []
    for line in text.splitlines(keepends=True):
        match = STAMP.match(line)
        if match:
            entries.append((match.group(1), line))
        elif line.strip() and not line.startswith('---------'):
            if not entries:
                raise ValueError('logcat did not return timestamped epoch output')
            stamp, previous = entries[-1]
            entries[-1] = (stamp, previous + line)
    if not entries:
        return '', cursor
    high = max(Decimal(stamp) for stamp, _ in entries)
    old = Decimal(cursor['timestamp']) if cursor else Decimal('-1')
    if high < old:
        # Device clock moved backwards / reboot: include the new buffer rather than lose it.
        old, cursor = Decimal('-1'), None
    seen = Counter((cursor or {}).get('seen', {}))
    boundary = Counter()
    output = []
    for stamp, line in entries:
        value = Decimal(stamp)
        digest = hashlib.sha256(line.encode()).hexdigest()
        if value == high:
            boundary[digest] += 1
        fresh = value > old
        if value == old:
            fresh = seen[digest] <= 0
            seen[digest] -= 1
        if fresh and (not pattern or pattern in line):
            output.append(line)
    return ''.join(output), {'timestamp': str(high), 'seen': dict(boundary)}


def replace(path, text):
    fd, temp = tempfile.mkstemp(prefix='.log-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as out:
            out.write(text)
            out.flush()
            os.fsync(out.fileno())
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def collect(device, output, state_dir, pattern=''):
    directory = Path(state_dir)
    directory.mkdir(parents=True, exist_ok=True)
    key = hashlib.sha256(json.dumps([device, pattern]).encode()).hexdigest()[:24]
    cursor_path = directory / (key + '.json')
    with (directory / (key + '.lock')).open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        cursor = json.loads(cursor_path.read_text()) if cursor_path.exists() else None
        capture = subprocess.run(['adb', '-s', device, 'logcat', '-d', '-v', 'threadtime,epoch,usec'], text=True, capture_output=True, check=True)
        text, next_cursor = delta(capture.stdout, cursor, pattern)
        path = Path(output)
        path.parent.mkdir(parents=True, exist_ok=True)
        # If a crash occurs between these writes, logs can repeat; they cannot be silently lost.
        replace(path, text)
        if next_cursor is not None:
            replace(cursor_path, json.dumps(next_cursor))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--device', required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--state-dir', required=True)
    parser.add_argument('--filter', default='')
    args = parser.parse_args()
    try:
        collect(args.device, args.out, args.state_dir, args.filter)
    except (ValueError, OSError, subprocess.SubprocessError) as exc:
        parser.exit(2, f'log capture failed: {exc}\n')


if __name__ == '__main__':
    main()
