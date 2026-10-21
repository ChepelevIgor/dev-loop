#!/usr/bin/env python3
"""Hand a page request to a live agent with Claude's native Artifact tool.

This local queue never calls Claude, stores credentials, or publishes by itself.
"""
import argparse
from contextlib import redirect_stdout
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import sys
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'start-task' / 'scripts'))
from runtime import Conflict, Store, atomic_json

ARTIFACT_URL = re.compile(r'https://claude\.ai/code/artifact/[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\Z')


def artifact_url(value):
    return value if isinstance(value, str) and ARTIFACT_URL.fullmatch(value) else None


class Bridge:
    def __init__(self, root):
        self.store = Store(root)
        with self.store.connect() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS artifact_listener (
                    slot INTEGER PRIMARY KEY CHECK(slot=1), owner TEXT, expires REAL);
                CREATE TABLE IF NOT EXISTS artifact_requests (
                    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, source_sha256 TEXT NOT NULL,
                    source_path TEXT NOT NULL, previous_url TEXT, status TEXT NOT NULL,
                    created REAL NOT NULL, url TEXT, error TEXT);
                CREATE UNIQUE INDEX IF NOT EXISTS one_artifact_request
                    ON artifact_requests(task_id) WHERE status IN ('queued','claimed');
            ''')

    def task(self, task_id):
        task = self.store.task(task_id)
        if task.get('id', task_id) != task_id:
            raise ValueError('task id does not match directory')
        return task

    def available(self, db):
        row = db.execute('SELECT expires FROM artifact_listener WHERE slot=1').fetchone()
        return bool(row and row['expires'] > time.time())

    def status(self, task_id):
        task = self.task(task_id)
        with self.store.connect() as db:
            row = db.execute('SELECT * FROM artifact_requests WHERE task_id=? ORDER BY created DESC LIMIT 1', (task_id,)).fetchone()
            # Do not expose local paths or credentials to the browser.
            result = {key: row[key] for key in ('id', 'status', 'url', 'error')} if row else {}
            result['available'] = self.available(db)
        result['artifact_url'] = artifact_url(task.get('artifact_url'))
        return result

    def request(self, task_id):
        task = self.task(task_id)
        page = self.store.path(f'tasks/{task_id}/report.html')
        html = page.read_text(encoding='utf-8')
        marker = "/*__TOKEN__*/''"
        if marker not in html or '/*__HOSTED__*/false' not in html:
            raise ValueError('rebuild the task page before publishing')
        html = html.replace('/*__HOSTED__*/false', 'true')
        data = html.encode('utf-8')
        if len(data) > 15 * 1024 * 1024:
            raise ValueError('page is too large for Claude; reduce screenshot sizes first')
        digest = hashlib.sha256(data).hexdigest()
        with self.store.connect() as db:
            row = db.execute("SELECT * FROM artifact_requests WHERE task_id=? AND status IN ('queued','claimed')", (task_id,)).fetchone()
            if row:
                return {'id': row['id'], 'status': row['status']}
            if not self.available(db):
                raise Conflict('No Claude session is listening. In Claude Code, ask Dev Loop to enable the artifact button for this project.')
            request_id = str(uuid.uuid4())
            relative = f'runtime/artifact-{request_id}.html'
            self.store.path(relative).write_bytes(data)
            db.execute('INSERT INTO artifact_requests VALUES(?,?,?,?,?,?,?,?,?)',
                       (request_id, task_id, digest, relative, artifact_url(task.get('artifact_url')),
                        'queued', time.time(), None, None))
        return {'id': request_id, 'status': 'queued'}

    def listen(self, timeout):
        """Advertise only while this bounded wait runs; claim once, never auto-retry."""
        owner = str(uuid.uuid4())
        deadline = time.monotonic() + timeout
        try:
            while time.monotonic() < deadline:
                with self.store.connect() as db:
                    current = db.execute('SELECT * FROM artifact_listener WHERE slot=1').fetchone()
                    if current and current['owner'] != owner and current['expires'] > time.time():
                        raise Conflict('another artifact listener is active')
                    db.execute('INSERT OR REPLACE INTO artifact_listener VALUES(1,?,?)', (owner, time.time() + 3))
                    row = db.execute("SELECT * FROM artifact_requests WHERE status='queued' ORDER BY created LIMIT 1").fetchone()
                    if row:
                        db.execute("UPDATE artifact_requests SET status='claimed' WHERE id=?", (row['id'],))
                        result = dict(row)
                        result['status'] = 'claimed'
                        result['source_path'] = str(self.store.path(row['source_path']))
                        return result
                time.sleep(.25)
        finally:
            with self.store.connect() as db:
                db.execute('DELETE FROM artifact_listener WHERE owner=?', (owner,))
        return None

    def complete(self, request_id, url):
        if not artifact_url(url):
            raise ValueError('expected the actual https://claude.ai/code/artifact/<uuid> URL')
        with self.store.connect() as db:
            row = db.execute('SELECT * FROM artifact_requests WHERE id=?', (request_id,)).fetchone()
            if not row or row['status'] not in ('claimed', 'published'):
                raise Conflict('request is not claimed')
            if row['status'] == 'published' and row['url'] != url:
                raise Conflict('request already has a different artifact URL')
            if row['previous_url'] and row['previous_url'] != url:
                raise Conflict('update the existing artifact to preserve its URL and comments')
            data = self.store.path(row['source_path']).read_bytes()
            if hashlib.sha256(data).hexdigest() != row['source_sha256']:
                raise Conflict('artifact source changed; reconcile publication before retrying')
            task = self.task(row['task_id'])
            current = artifact_url(task.get('artifact_url'))
            if current and current not in (row['previous_url'], url):
                raise Conflict('task is already linked to another artifact')
            task['artifact_url'] = url
            atomic_json(self.store.path(f"tasks/{row['task_id']}/task.json"), task)
            # This association is recoverable by repeating complete with the same URL.
            from build_report import build
            with redirect_stdout(sys.stderr):
                build(self.store.path('tasks'), self.store.path(f"tasks/{row['task_id']}/report.html"), task_id=row['task_id'])
            db.execute("UPDATE artifact_requests SET status='published',url=?,error=NULL WHERE id=?", (url, request_id))
        return {'id': request_id, 'status': 'published', 'url': url}

    def fail(self, request_id, reason):
        if not reason or len(reason) > 1000:
            raise ValueError('provide a short error without credentials or private tool output')
        with self.store.connect() as db:
            row = db.execute('SELECT status FROM artifact_requests WHERE id=?', (request_id,)).fetchone()
            if not row or row['status'] not in ('queued', 'claimed'):
                raise Conflict('request is not pending')
            db.execute("UPDATE artifact_requests SET status='failed',error=? WHERE id=?", (reason, request_id))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root')
    commands = parser.add_subparsers(dest='command', required=True)
    wait = commands.add_parser('wait')
    wait.add_argument('--timeout', type=int, default=300)
    wait.add_argument('--native-artifact', action='store_true', required=True,
                      help='confirm that the current interactive agent has the native Artifact tool')
    status = commands.add_parser('status')
    status.add_argument('task_id')
    complete = commands.add_parser('complete')
    complete.add_argument('request_id')
    complete.add_argument('--url', required=True)
    fail = commands.add_parser('fail')
    fail.add_argument('request_id')
    fail.add_argument('--reason', required=True)
    args = parser.parse_args()
    try:
        bridge = Bridge(args.root)
        if args.command == 'wait':
            if not 1 <= args.timeout <= 900:
                raise ValueError('timeout must be between 1 and 900 seconds')
            result = bridge.listen(args.timeout)
            print(json.dumps(result))
            return 0 if result else 3
        if args.command == 'status':
            result = bridge.status(args.task_id)
        elif args.command == 'complete':
            result = bridge.complete(args.request_id, args.url)
        else:
            bridge.fail(args.request_id, args.reason)
            result = {'status': 'failed'}
        print(json.dumps(result))
        return 0
    except (ValueError, OSError, sqlite3.Error) as exc:
        parser.exit(2, f'artifact bridge: {exc}\n')


if __name__ == '__main__':
    raise SystemExit(main())
