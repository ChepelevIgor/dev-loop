#!/usr/bin/env python3
"""Transactional queue and stage machine. SQLite is authoritative; JSON is a projection."""
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import tempfile
import time
import uuid

ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\Z")
# execute: business review → technical solution → QA cases → code → local review → retest. PR only on request.
FIRST = {'execute': 'BRIEF', 'retest': 'RETEST', 'pr': 'PR'}
STAGES = {'BRIEF', 'PLAN', 'QA', 'EXECUTE', 'PR', 'REVIEW', 'COUNCIL', 'FIX', 'RETEST'}
GAP_KINDS = {'design', 'data', 'product'}
PROTECTED = {'main', 'master', 'HEAD'}


def filled(value):
    return isinstance(value, str) and bool(value.strip())


def acceptance_texts(task):
    acceptance = task.get('acceptance')
    if not isinstance(acceptance, list) or not acceptance:
        raise ValueError('task.json needs nonempty acceptance')
    texts = [c.get('text') if isinstance(c, dict) else c for c in acceptance]
    if any(not filled(t) for t in texts):
        raise ValueError('every acceptance criterion needs text')
    return texts


def git(project, *args):
    return subprocess.run(['git', *args], cwd=project, text=True, capture_output=True, check=True).stdout.strip()


class Conflict(ValueError):
    pass


class IncompleteRetest(ValueError):
    """Valid progress evidence that cannot advance the stage."""
    def __init__(self, evidence):
        super().__init__('partial retest cannot finish the request')
        self.evidence = evidence


def atomic_json(path, value):
    path = Path(path)
    fd, temp = tempfile.mkstemp(prefix='.pending-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


class Store:
    def __init__(self, root):
        supplied = Path(root).absolute()
        if supplied.is_symlink():
            raise ValueError('runtime root must not be a symlink')
        supplied.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.root = supplied.resolve()
        for name in ('queue', 'queue/taken', 'queue/done', 'runtime'):
            path = self.path(name)
            path.mkdir(exist_ok=True, mode=0o700)
        self.db = self.path('runtime.sqlite3')
        for suffix in ('-wal', '-shm', '-journal'):
            self.path(self.db.name + suffix)
        with self.connect() as conn:
            conn.executescript('''
                CREATE TABLE IF NOT EXISTS requests (
                    request_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, action TEXT NOT NULL,
                    comment TEXT NOT NULL, ts REAL NOT NULL, status TEXT NOT NULL, stage TEXT NOT NULL,
                    rounds INTEGER NOT NULL DEFAULT 0, attempt_id TEXT, head_sha TEXT,
                    last_error TEXT, result TEXT);
                CREATE UNIQUE INDEX IF NOT EXISTS one_active_task ON requests(task_id) WHERE status != 'done';
                CREATE TABLE IF NOT EXISTS events (
                    seq INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL,
                    request_id TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL);
            ''')
        os.chmod(self.db, 0o600)

    def path(self, relative):
        path = Path(relative)
        if path.is_absolute() or '..' in path.parts:
            raise ValueError('path must stay inside runtime root')
        target = self.root / path
        # Reject every symlink, including links back into root: no aliasing of state files.
        cursor = self.root
        for part in path.parts:
            cursor /= part
            if cursor.is_symlink():
                raise ValueError(f'symlink not allowed: {relative}')
        target.resolve().relative_to(self.root)
        return target

    @contextmanager
    def connect(self):
        conn = sqlite3.connect(self.db, timeout=10, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute('PRAGMA synchronous=FULL')
        try:
            conn.execute('BEGIN IMMEDIATE')
            yield conn
            conn.commit()
        except BaseException:
            conn.rollback()
            raise
        finally:
            conn.close()

    @contextmanager
    def consumer(self):
        path = self.path('runtime/consumer.lock')
        with path.open('a+') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise Conflict('another consumer is active') from exc
            try:
                yield lock
            finally:
                fcntl.flock(lock, fcntl.LOCK_UN)

    def event(self, conn, request_id, kind, detail):
        conn.execute('INSERT INTO events(ts,request_id,kind,detail) VALUES(?,?,?,?)',
                     (time.time(), request_id, kind, json.dumps(detail, ensure_ascii=False, allow_nan=False)))

    def task(self, task_id):
        if not isinstance(task_id, str) or not ID.fullmatch(task_id):
            raise ValueError('invalid task_id')
        value = json.loads(self.path(f'tasks/{task_id}/task.json').read_text(encoding='utf-8'))
        if not isinstance(value, dict):
            raise ValueError('invalid task.json')
        return value

    def enqueue(self, task_id, action='execute', comment='', request_id=None, legacy_taken=False):
        task = self.task(task_id)
        if not isinstance(action, str) or action not in FIRST:
            raise ValueError('invalid action')
        if not isinstance(comment, str) or len(comment) > 4000:
            raise ValueError('comment must be text, at most 4000 characters')
        if action != 'execute' and not (task.get('branch') or task.get('pr')):
            raise Conflict('task has no implementation yet')
        request_id = request_id or uuid.uuid4().hex
        if not isinstance(request_id, str) or not ID.fullmatch(request_id):
            raise ValueError('invalid request_id')
        try:
            with self.connect() as conn:
                conn.execute('INSERT INTO requests(request_id,task_id,action,comment,ts,status,stage,last_error) VALUES(?,?,?,?,?,?,?,?)',
                             (request_id, task_id, action, comment, time.time(), 'blocked' if legacy_taken else 'queued', FIRST[action],
                              'legacy taken request: reconcile previous work before resume' if legacy_taken else None))
                self.event(conn, request_id, 'imported' if legacy_taken else 'enqueued', {'action': action})
        except sqlite3.IntegrityError as exc:
            raise Conflict('task already pending or request_id already exists') from exc
        self.export()
        return self.get(request_id)

    def import_queue(self):
        # Explicit migration: JSON files not recorded in SQLite are accepted once.
        candidates = [(p, taken) for taken, folder in ((True, 'queue/taken'), (False, 'queue'))
                      for p in sorted(self.path(folder).glob('*.json'))]
        for path, taken in candidates:
            self.path(path.relative_to(self.root))
            record = json.loads(path.read_text(encoding='utf-8'))
            if not isinstance(record, dict):
                raise ValueError(f'invalid queue record: {path.name}')
            request_id = record.get('request_id', path.stem)
            if request_id != path.stem:
                raise ValueError(f'queue filename does not match request_id: {path.name}')
            with self.connect() as conn:
                if conn.execute('SELECT 1 FROM requests WHERE request_id=?', (request_id,)).fetchone():
                    continue
            self.enqueue(record.get('task_id'), record.get('action', 'execute'), record.get('comment', ''), request_id, taken)
        self.export()

    def get(self, request_id):
        with self.connect() as conn:
            row = conn.execute('SELECT * FROM requests WHERE request_id=?', (request_id,)).fetchone()
        if row is None:
            raise ValueError('unknown request_id')
        return self.decode(row)

    @staticmethod
    def decode(row):
        value = dict(row)
        if value.get('result'):
            value['result'] = json.loads(value['result'])
        return value

    def snapshot(self):
        with self.connect() as conn:
            return [self.decode(r) for r in conn.execute('SELECT * FROM requests ORDER BY ts,request_id')]

    def export(self):
        # An interrupted export is repaired from the committed database by recover/import.
        with self.connect() as conn:
            rows = [self.decode(r) for r in conn.execute('SELECT * FROM requests ORDER BY ts,request_id')]
            for row in rows:
                folder = 'queue/done' if row['status'] == 'done' else 'queue' if row['status'] == 'queued' else 'queue/taken'
                target = self.path(f"{folder}/{row['request_id']}.json")
                atomic_json(target, row)
                for other in ('queue', 'queue/taken', 'queue/done'):
                    path = self.path(f"{other}/{row['request_id']}.json")
                    if path != target:
                        path.unlink(missing_ok=True)
            atomic_json(self.path('state.json'), {'schema_version': 1, 'requests': rows})
            events = [dict(e) for e in conn.execute('SELECT * FROM events ORDER BY seq')]
            for event in events:
                event['detail'] = json.loads(event['detail'])
            atomic_json(self.path('runtime/events.json'), events)

    def recover(self):
        # Caller holds consumer lock; never infer completion of an interrupted external command.
        with self.connect() as conn:
            for row in conn.execute("SELECT * FROM requests WHERE status='running'").fetchall():
                error = 'interrupted stage: inspect artifacts/external effects, then explicitly resume'
                conn.execute("UPDATE requests SET status='blocked',last_error=? WHERE request_id=?", (error, row['request_id']))
                self.event(conn, row['request_id'], 'interrupted', {'stage': row['stage'], 'attempt_id': row['attempt_id']})
        self.export()

    def resume(self, request_id, comment=None):
        if comment is not None and (not isinstance(comment, str) or len(comment) > 4000):
            raise ValueError('comment must be text, at most 4000 characters')
        with self.connect() as conn:
            row = conn.execute('SELECT * FROM requests WHERE request_id=?', (request_id,)).fetchone()
            if row is None or row['status'] != 'blocked':
                raise Conflict('only blocked requests can be resumed')
            if row['rounds'] >= 3 and row['stage'] == 'COUNCIL':
                raise Conflict('three correction rounds exhausted; revise the task before a new request')
            # The answer (e.g. to the business review questions) is added to what was asked, never in its place.
            text = row['comment'] if not comment else f"{row['comment']}\n\nAnswer: {comment}" if row['comment'] else comment
            if len(text) > 4000:
                raise ValueError('the request and its answers exceed 4000 characters; start a revised task')
            conn.execute("UPDATE requests SET status='ready',last_error=NULL,comment=? WHERE request_id=?", (text, request_id))
            self.event(conn, request_id, 'resumed', {'stage': row['stage'], **({'comment': comment} if comment else {})})
        self.export()

    def request(self, task_id, action='execute', comment=''):
        """The page's Dev Loop button: answer a blocked request, else start a new one; never two at once."""
        active = [r for r in self.snapshot() if r['task_id'] == task_id and r['status'] != 'done']
        if not active:
            return self.enqueue(task_id, action, comment)
        current = active[0]
        if current['status'] != 'blocked':
            raise Conflict('this task is already in progress')
        self.resume(current['request_id'], comment or None)
        return self.get(current['request_id'])

    def start(self, head_sha):
        with self.connect() as conn:
            if conn.execute("SELECT 1 FROM requests WHERE status='running'").fetchone():
                raise Conflict('a stage is already running; recover only after its owner stops')
            row = conn.execute("SELECT * FROM requests WHERE status IN ('queued','ready') ORDER BY CASE status WHEN 'ready' THEN 0 ELSE 1 END, ts LIMIT 1").fetchone()
            if row is None:
                return None
            attempt = uuid.uuid4().hex
            conn.execute("UPDATE requests SET status='running',attempt_id=?,head_sha=?,last_error=NULL WHERE request_id=?", (attempt, head_sha, row['request_id']))
            self.event(conn, row['request_id'], 'started', {'stage': row['stage'], 'attempt_id': attempt, 'head_sha': head_sha})
        self.export()
        return self.get(row['request_id'])

    def block(self, request_id, attempt_id, error):
        with self.connect() as conn:
            row = conn.execute('SELECT * FROM requests WHERE request_id=?', (request_id,)).fetchone()
            if row is None or row['status'] != 'running' or row['attempt_id'] != attempt_id:
                raise Conflict('stale or inactive attempt')
            conn.execute("UPDATE requests SET status='blocked',last_error=? WHERE request_id=?", (str(error)[:4000], request_id))
            self.event(conn, request_id, 'blocked', {'error': str(error)[:4000], 'stage': row['stage']})
        self.export()

    def evidence(self, record, result, key, json_file=True):
        relative = result.get('artifacts', {}).get(key)
        if not isinstance(relative, str) or not relative.startswith(f"tasks/{record['task_id']}/"):
            raise ValueError(f'{key}: evidence must belong to this task')
        path = self.path(relative)
        data = path.read_bytes()
        if not data:
            raise ValueError(f'{key}: empty evidence')
        return (json.loads(data) if json_file else data), {'path': relative, 'sha256': hashlib.sha256(data).hexdigest()}

    def validate(self, record, result, current_sha):
        if not isinstance(result, dict) or result.get('completed') is not True:
            raise ValueError('worker did not complete stage')
        for key in ('request_id', 'stage', 'attempt_id'):
            if result.get(key) != record[key]:
                raise ValueError(f'result {key} does not match active attempt')
        if result.get('head_sha') != current_sha:
            raise ValueError('result does not describe current HEAD')
        stage = record['stage']
        if stage not in ('EXECUTE', 'FIX') and current_sha != record['head_sha']:
            raise ValueError('HEAD changed during a read-only stage')
        if not isinstance(result.get('artifacts'), dict):
            raise ValueError('artifacts required')
        hashes = {}
        def read(key, json_file=True):
            value, digest = self.evidence(record, result, key, json_file)
            hashes[key] = digest
            return value
        questions = None
        if stage == 'BRIEF':
            brief = read('brief')
            task = self.task(record['task_id'])
            texts = acceptance_texts(task)
            if not isinstance(brief, dict):
                raise ValueError('business review must be an object')
            gaps = brief.get('gaps')
            if not isinstance(gaps, list) or any(not isinstance(g, dict) or g.get('kind') not in GAP_KINDS or not filled(g.get('text'))
                                                 or type(g.get('blocking')) is not bool for g in gaps):
                raise ValueError('business review gaps need kind design|data|product, text and blocking true/false')
            if brief.get('metric') is None:
                if not any(g['kind'] == 'product' for g in gaps):
                    raise ValueError('no business metric: ask for it as a product gap instead of leaving it out')
            elif not filled(brief.get('metric')):
                raise ValueError('business metric is empty')
            if not filled(brief.get('summary')) or not isinstance(brief.get('dod'), list) or not brief['dod'] or not all(filled(x) for x in brief['dod']):
                raise ValueError('business review needs a plain summary and Definition of Done items')
            cases = brief.get('cases')
            if (not isinstance(cases, list) or not cases or any(not isinstance(c, dict) or not all(filled(c.get(k)) for k in ('text', 'given', 'when', 'then')) for c in cases)):
                raise ValueError('business review needs Given / When / Then cases with their acceptance text')
            if sorted(c['text'] for c in cases) != sorted(texts):
                raise ValueError('the Given / When / Then cases must be exactly the task acceptance criteria (write them into task.json)')
            base = brief.get('base_sha')
            if not isinstance(base, str) or not re.fullmatch(r'[0-9a-f]{40}', base) or task.get('base_sha') != base:
                raise ValueError('business review needs the base commit, the same in task.json base_sha')
            blocking = [g for g in gaps if g['blocking']]
            if blocking:
                # Saved as evidence; the request waits for the person's answer (the Dev Loop button with a comment).
                questions = 'business review: ' + '; '.join(f"{g['kind']}: {g['text']}" for g in blocking)
                target = 'BRIEF'
            else:
                target = 'PLAN'
        elif stage == 'PLAN':
            plan = read('plan', json_file=False)
            if len(plan.decode('utf-8', 'replace').strip()) < 200:
                raise ValueError('technical solution is too short to build from')
            target = 'QA'
        elif stage == 'QA':
            qa = read('qa')
            texts = acceptance_texts(self.task(record['task_id']))
            if not isinstance(qa, dict) or not filled(qa.get('author')) or type(qa.get('independent')) is not bool:
                raise ValueError('QA cases need their author and whether they are independent')
            cases = qa.get('cases')
            if (not isinstance(cases, list) or not cases or any(not isinstance(c, dict) or c.get('criterion') not in texts
                                                                 or not all(filled(c.get(k)) for k in ('title', 'given', 'when', 'then')) for c in cases)):
                raise ValueError('every QA case needs a title, Given / When / Then and one acceptance criterion')
            missing = [t for t in texts if not any(c['criterion'] == t for c in cases)]
            if missing:
                raise ValueError(f'no QA case for: {missing[0]}')
            target = 'EXECUTE'
        elif stage in ('EXECUTE', 'FIX'):
            checks = read('checks')
            commands = checks.get('commands') if isinstance(checks, dict) else None
            if (not isinstance(checks, dict) or checks.get('passed') is not True
                    or checks.get('head_sha') != current_sha or not isinstance(commands, list) or not commands
                    or any(not isinstance(c, dict) or not isinstance(c.get('argv'), list) or not c['argv']
                           or any(not isinstance(a, str) or not a for a in c['argv'])
                           or type(c.get('exit_code')) is not int or c['exit_code'] != 0 for c in commands)):
                raise ValueError('successful checks for current HEAD required')
            if stage == 'EXECUTE':
                branch = self.task(record['task_id']).get('branch')
                current = git(self.root.parent, 'rev-parse', '--abbrev-ref', 'HEAD')
                if not filled(branch) or branch in PROTECTED or current != branch:
                    raise ValueError('commit the task on its own branch (task.json branch), never on main')
            target = 'REVIEW'
        elif stage == 'PR':
            pr = read('pr')
            if (not isinstance(pr, dict) or type(pr.get('number')) is not int or pr['number'] < 1
                    or not isinstance(pr.get('url'), str) or not pr['url'].startswith('https://') or pr.get('head_sha') != current_sha):
                raise ValueError('invalid or stale PR evidence')
            target = 'REVIEW'
        elif stage == 'REVIEW':
            review, threads = read('review'), read('threads')
            if not isinstance(review, dict) or review.get('completed') is not True or not isinstance(review.get('findings'), list):
                raise ValueError('completed structured review required')
            if not isinstance(threads, list) or any(not isinstance(t, dict) or type(t.get('resolved')) is not bool or not isinstance(t.get('body'), str) for t in threads):
                raise ValueError('invalid threads')
            if any(not isinstance(f, dict) or not f.get('body') or not any(t['body'] == f['body'] for t in threads) for f in review['findings']):
                raise ValueError('local findings missing from collected threads')
            target = 'COUNCIL' if any(not t['resolved'] for t in threads) else 'RETEST'
        elif stage == 'COUNCIL':
            verdict = read('verdict')
            if (not isinstance(verdict, dict) or not verdict.get('decision') or not isinstance(verdict.get('must'), list)
                    or not verdict['must'] or any(not isinstance(m, dict) or not m.get('evidence') for m in verdict['must'])):
                raise ValueError('council has no evidenced actionable decision; reconcile before resuming')
            target = 'FIX'
        elif stage == 'RETEST':
            report = read('report')
            task = self.task(record['task_id'])
            criteria = report.get('criteria') if isinstance(report, dict) else None
            acceptance = task.get('acceptance')
            if not isinstance(acceptance, list) or not acceptance or not isinstance(criteria, list) or not criteria:
                raise ValueError('nonempty task acceptance and retest criteria required')
            expected = [c.get('text') if isinstance(c, dict) else c for c in acceptance]
            actual = [c.get('text') if isinstance(c, dict) else None for c in criteria]
            if any(not isinstance(t, str) or not t for t in expected) or sorted(expected) != sorted(actual, key=str):
                raise ValueError('retest must cover exactly the task acceptance criteria')
            if report.get('head_sha') != current_sha:
                raise ValueError('retest evidence is for another commit')
            for key in ('task_id', 'request_id', 'attempt_id'):
                if key in report and report[key] != record[key]:
                    raise ValueError(f'report {key} does not match active attempt')
            if any(c.get('verdict') not in ('pass', 'fail', 'partial') for c in criteria):
                raise ValueError('invalid criterion verdict')
            if report.get('status') == 'pass' and all(c['verdict'] == 'pass' for c in criteria):
                for c in criteria:
                    after = c.get('after')
                    if not isinstance(after, str) or not re.fullmatch(r'runs/\d+/after/.+\.png', after):
                        raise ValueError('passing criterion needs an after screenshot')
                    shot = self.path(f"tasks/{record['task_id']}/{after}")
                    try:
                        from PIL import Image
                    except ImportError as exc:
                        raise ValueError('Pillow is required to validate retest screenshots') from exc
                    data = shot.read_bytes()
                    if not data.startswith(b'\x89PNG\r\n\x1a\n'):
                        raise ValueError('invalid after screenshot')
                    with Image.open(shot) as im:
                        im.verify()
                    with Image.open(shot) as im:
                        im.load()
                    hashes['screenshot:' + after] = {'path': str(shot.relative_to(self.root)),
                                                     'sha256': hashlib.sha256(data).hexdigest()}
                target = 'DONE'
            elif report.get('status') == 'fail' and any(c['verdict'] == 'fail' for c in criteria):
                target = 'COUNCIL'
            elif (report.get('status') == 'partial' and any(c['verdict'] == 'partial' for c in criteria)
                  and not any(c['verdict'] == 'fail' for c in criteria)):
                raise IncompleteRetest(hashes)
            else:
                raise ValueError('partial/inconsistent retest cannot finish the request')
        else:
            raise ValueError('unknown stage')
        return target, hashes, questions

    def complete(self, request_id, result, current_sha):
        record = self.get(request_id)
        if record['status'] != 'running':
            raise Conflict('request is not running')
        try:
            target, hashes, questions = self.validate(record, result, current_sha)
        except IncompleteRetest as exc:
            # Preserve this attempt's partial observations without acknowledging completion.
            with self.connect() as conn:
                active = conn.execute('SELECT status,attempt_id FROM requests WHERE request_id=?',
                                      (request_id,)).fetchone()
                if active['status'] != 'running' or active['attempt_id'] != record['attempt_id']:
                    raise Conflict('active attempt changed')
                self.event(conn, request_id, 'progress', {'stage': record['stage'], 'attempt_id': record['attempt_id'],
                                                        'head_sha': current_sha, 'evidence': exc.evidence})
            self.export()
            raise
        rounds = record['rounds'] + (target == 'FIX')
        exhausted = rounds > 3 or (target == 'COUNCIL' and rounds >= 3)
        status = 'blocked' if exhausted or questions else 'done' if target == 'DONE' else 'ready'
        error = 'three correction rounds exhausted' if exhausted else questions[:4000] if questions else None
        with self.connect() as conn:
            changed = conn.execute('UPDATE requests SET status=?,stage=?,rounds=?,head_sha=?,last_error=?,result=? WHERE request_id=? AND status=? AND attempt_id=?',
                                   (status, target, rounds, current_sha, error, json.dumps(result, ensure_ascii=False), request_id, 'running', record['attempt_id'])).rowcount
            if changed != 1:
                raise Conflict('active attempt changed')
            self.event(conn, request_id, 'completed', {'from': record['stage'], 'to': target, 'status': status, 'evidence': hashes})
        self.export()
        return self.get(request_id)


def git_head(project):
    result = subprocess.run(['git', 'rev-parse', '--verify', 'HEAD'], cwd=project, text=True, capture_output=True, check=True)
    dirty = subprocess.run(['git', 'status', '--porcelain', '--', '.', ':(exclude).devloop'], cwd=project, text=True, capture_output=True, check=True)
    if dirty.stdout.strip():
        raise ValueError('project has uncommitted changes outside .devloop; isolate/commit them before running')
    return result.stdout.strip()
