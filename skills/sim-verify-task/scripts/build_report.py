#!/usr/bin/env python3
"""Build an HTML task index and a portable page linked to each task."""
import argparse
import base64
import copy
import hashlib
import io
import json
from pathlib import Path
import re
import sqlite3
from urllib.parse import urlsplit


def artifact_url(value):
    return value if isinstance(value, str) and re.fullmatch(
        r'https://claude\.ai/code/artifact/[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}', value) else None


def source_url(value):
    """Keep explicit task links, never credentials or local report tokens."""
    if not isinstance(value, str):
        return None
    try:
        url = urlsplit(value)
        if (url.scheme == 'https' and url.hostname and url.username is None
                and url.password is None and not url.query and not url.fragment):
            return value
    except ValueError:
        pass
    return None


def stage_files(task_dir):
    """What the stages before the code wrote: business review, technical solution, QA cases (shown as text)."""
    out = {}
    for key, name in (('brief', 'brief.json'), ('qa', 'qa.json')):
        path = task_dir / name
        if path.is_file() and not path.is_symlink():
            try:
                value = json.loads(path.read_text(encoding='utf-8'))
            except ValueError:
                continue
            if isinstance(value, dict):
                out[key] = value
    plan = task_dir / 'plan.md'
    if plan.is_file() and not plan.is_symlink():
        out['plan'] = plan.read_text(encoding='utf-8')[:20000]
    return out


def runtime_snapshot(root):
    """Read requests and evidence together without creating or updating runtime state."""
    db = root / 'runtime.sqlite3'
    if db.is_symlink():
        raise ValueError('symlink runtime database is not allowed')
    if db.exists():
        conn = sqlite3.connect(db.resolve().as_uri() + '?mode=ro', uri=True)
        conn.row_factory = sqlite3.Row
        try:
            conn.execute('BEGIN')
            rows = [dict(r) for r in conn.execute('SELECT * FROM requests ORDER BY ts,request_id')]
            events = [dict(e) for e in conn.execute('SELECT * FROM events ORDER BY seq')]
            for event in events:
                event['detail'] = json.loads(event['detail'])
            return rows, events
        finally:
            conn.close()
    # Exported state remains usable when viewing a copy without the database.
    state = root / 'state.json'
    journal = root / 'runtime/events.json'
    rows = json.loads(state.read_text(encoding='utf-8')).get('requests', []) if state.is_file() else []
    events = json.loads(journal.read_text(encoding='utf-8')) if journal.is_file() else []
    return sorted(rows, key=lambda r: (r['ts'], r['request_id'])), events


STAGE_ARTIFACTS = {'BRIEF': ('brief',), 'PLAN': ('plan',), 'QA': ('qa',),
                   'REVIEW': ('review', 'threads'), 'RETEST': ('report',)}


def task_bytes(task_dir, relative):
    relative = Path(relative)
    if relative.is_absolute() or '..' in relative.parts or relative.parts[:2] != ('tasks', task_dir.name):
        raise ValueError('evidence must belong to this task')
    path = task_dir.parent.parent
    for part in relative.parts:
        path /= part
        if path.is_symlink():
            raise ValueError('symlink evidence is not allowed')
    return path.read_bytes()


def report_run(report, path=''):
    """A worker may save JSON outside runs/, while its screenshots still identify the run."""
    if isinstance(report, dict) and type(report.get('run')) is int and report['run'] > 0:
        return report['run']
    match = re.fullmatch(r'tasks/[^/]+/runs/(\d+)/report\.json', path)
    if match:
        return int(match[1])
    if isinstance(report, dict):
        for key in ('after', 'before'):
            numbers = {int(m[1]) for c in report.get('criteria', []) if isinstance(c, dict)
                       and isinstance(c.get(key), str)
                       and (m := re.fullmatch(r'runs/(\d+)/(?:before|after)/.+\.png', c[key]))}
            if len(numbers) == 1:
                return numbers.pop()
    return None


def request_files(task_dir, request, events):
    """Completed evidence and partial retest progress, scoped to this request and attempt."""
    recorded = {}
    attempt = None
    report_attempt = None
    for event in events:
        if event.get('request_id') != request['request_id']:
            continue
        detail = event['detail']
        if event['kind'] == 'started':
            stage = detail['stage']
            attempt = detail['attempt_id']
            # Retrying a stage or changing code makes its older result historical.
            for key in STAGE_ARTIFACTS.get(stage, ()):
                recorded.pop(key, None)
            if stage in ('EXECUTE', 'FIX'):
                recorded.pop('review', None)
                recorded.pop('threads', None)
                recorded.pop('report', None)
        elif event['kind'] == 'completed':
            for key in STAGE_ARTIFACTS.get(detail['from'], ()):
                recorded[key] = detail['evidence'][key]
                if key == 'report':
                    report_attempt = attempt
        elif (event['kind'] == 'progress' and detail.get('stage') == 'RETEST'
              and detail.get('attempt_id') == attempt):
            recorded['report'] = detail['evidence']['report']
            report_attempt = attempt

    values, warnings = {}, []
    for key, evidence in recorded.items():
        try:
            data = task_bytes(task_dir, evidence['path'])
            if hashlib.sha256(data).hexdigest() != evidence['sha256']:
                raise ValueError('evidence changed since recording')
            value = data.decode('utf-8')[:20000] if key == 'plan' else json.loads(data)
            if key != 'plan' and not isinstance(value, list if key == 'threads' else dict):
                raise ValueError('unexpected evidence type')
            if key == 'report':
                expected = {'task_id': request['task_id'], 'request_id': request['request_id'],
                            'attempt_id': report_attempt}
                if any(k in value and value[k] != v for k, v in expected.items()):
                    raise ValueError('report identifiers do not match recorded attempt')
            values[key] = value
        except (OSError, ValueError, KeyError, TypeError):
            warnings.append(f'The recorded {key} could not be loaded or has changed. Recheck this stage.')
    return values, warnings, recorded


def supplemental_report(task_dir, task, request, events, runs, recorded_run, report_recorded):
    """Select a later standalone run, or a partial preview explicitly bound to this attempt."""
    finished = max((e['ts'] for e in events if e['request_id'] == request['request_id']
                    and e['kind'] == 'completed' and e['detail'].get('status') == 'done'), default=None)
    standalone = request['status'] == 'done' and finished is not None
    preview = request['stage'] == 'RETEST' and request['status'] in ('running', 'blocked') and not report_recorded
    if not standalone and not preview:
        return None
    for run, path in reversed(runs):
        if standalone and ((recorded_run is not None and run <= recorded_run) or path.stat().st_mtime <= finished):
            continue
        try:
            report = json.loads(task_bytes(task_dir, path.relative_to(task_dir.parent.parent)))
            if not isinstance(report, dict):
                raise ValueError('report must be an object')
        except (OSError, ValueError):
            if standalone:
                raise
            # Unrecorded, unreadable drafts are not evidence for this active attempt.
            continue
        if standalone:
            # Bound results belong to their managed cycle, even if copied into a newer folder.
            if report.get('request_id') or report.get('attempt_id'):
                continue
            return report, run
        if (report.get('task_id', task_dir.name) != task_dir.name
                or any(report.get(k) != request.get(k) for k in ('request_id', 'attempt_id', 'head_sha'))
                or report.get('status') != 'partial'):
            continue
        criteria = report.get('criteria')
        expected = [c.get('text') if isinstance(c, dict) else c for c in task.get('acceptance', [])]
        if (not isinstance(criteria, list) or not criteria or not expected
                or any(not isinstance(c, dict) or not isinstance(c.get('text'), str)
                       or c.get('verdict') not in ('pass', 'partial') for c in criteria)
                or any(not isinstance(text, str) for text in expected)
                or sorted(c['text'] for c in criteria) != sorted(expected)
                or not any(c['verdict'] == 'partial' for c in criteria)):
            continue
        return report, run
    return None


def review_findings(review, threads):
    """Keep thread metadata and distinct GitHub IDs, without repeating local findings."""
    findings, seen = [], set()
    def content(f):
        return (f.get('file'), f.get('line'), f.get('body'))
    for thread in threads or []:
        if not isinstance(thread, dict):
            continue
        identity = (('github', thread['gh_thread_id']) if thread.get('gh_thread_id') else
                    ('id', thread.get('source'), thread['id']) if thread.get('id') else
                    ('content', thread.get('source'), *content(thread)))
        identity = json.dumps(identity, sort_keys=True)
        if identity not in seen:
            findings.append(thread)
            seen.add(identity)
    for finding in (review or {}).get('findings', []):
        if isinstance(finding, dict) and not any(content(finding) == content(f) for f in findings):
            findings.append(finding)
    return findings


def pending_report(task):
    criteria = [{'id': f'c{i + 1}', 'text': c.get('text', '') if isinstance(c, dict) else str(c),
                 'verdict': 'pending', 'note': 'Verification has not run yet.'}
                for i, c in enumerate(task.get('acceptance', []))]
    return {'status': 'pending', 'criteria': criteria, 'steps': []}


def write_page(template, reports, out):
    payload = json.dumps(reports, ensure_ascii=False).replace('<', '\\u003c').replace('>', '\\u003e').replace('&', '\\u0026')
    html = template.replace('/*__DATA__*/[]', payload)
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.is_symlink():
        raise ValueError(f'symlink output is not allowed: {out}')
    out.write_text(html, encoding='utf-8')
    return html


def embed_images(report, task_dir, max_width, allow_unavailable=False):
    """Return index and portable data, keeping partial observations if a capture is unavailable."""
    report = copy.deepcopy(report)
    result = copy.deepcopy(report)
    warnings = []
    for i, (source, criterion) in enumerate(zip(report.get('criteria', []), result.get('criteria', [])), 1):
        for key in ('before', 'after', 'diff'):
            if not criterion.get(key):
                continue
            from PIL import Image
            try:
                path = screenshot(task_dir, criterion[key])
                with Image.open(path) as im:
                    im.thumbnail((max_width, max_width * 4))
                    buffer = io.BytesIO()
                    im.save(buffer, 'PNG', optimize=True)
            except (OSError, ValueError, SyntaxError, Image.DecompressionBombError):
                if not allow_unavailable:
                    raise
                source.pop(key)
                criterion.pop(key)
                warnings.append(f'Criterion {i}: {key} screenshot is unavailable or invalid and was omitted. Re-run this capture.')
                continue
            criterion[key] = 'data:image/png;base64,' + base64.b64encode(buffer.getvalue()).decode()
    if warnings:
        existing = report.get('warnings')
        report['warnings'] = (existing if isinstance(existing, list) else []) + warnings
        result['warnings'] = list(report['warnings'])
    return report, result


def screenshot(task_dir, value):
    if not isinstance(value, str) or not re.fullmatch(r"runs/\d+/(before|after|diff)/.+\.png", value):
        raise ValueError(f"invalid screenshot path: {value!r}")
    path = Path(value)
    if path.is_absolute() or ".." in path.parts:
        raise ValueError(f"invalid screenshot path: {value!r}")
    result = task_dir / path
    result.resolve().relative_to(task_dir.resolve())
    if not result.is_file():
        raise ValueError(f"missing screenshot: {result}")
    return result


def build(tasks, out, embed=False, max_width=600, task_id=None):
    if max_width <= 0:
        raise ValueError("max-width must be positive")
    template = (Path(__file__).parent.parent / "templates" / "report.html").read_text(encoding="utf-8")
    requests, events = runtime_snapshot(Path(tasks).parent)
    latest = {r['task_id']: r for r in requests}
    data = []
    for task_dir in sorted(Path(tasks).iterdir()):
        if task_id is not None and task_dir.name != task_id:
            continue
        if not task_dir.is_dir() or not (task_dir / 'task.json').is_file():
            continue
        if task_dir.is_symlink():
            raise ValueError(f'symlink task directory is not allowed: {task_dir}')
        runs = sorted((int(p.parent.name), p) for p in (task_dir / "runs").glob("*/report.json") if p.parent.name.isdigit())
        task = json.loads((task_dir / "task.json").read_text(encoding="utf-8"))
        request = latest.get(task_dir.name)
        run = None
        if request:
            artifacts, warnings, recorded = request_files(task_dir, request, events)
            run = report_run(artifacts.get('report'), recorded.get('report', {}).get('path', ''))
            supplement = supplemental_report(task_dir, task, request, events, runs, run, 'report' in recorded)
            report = artifacts.pop('report', None)
            standalone = supplement is not None and request['status'] == 'done'
            if supplement:
                report, run = supplement
            report = report or pending_report(task)
            # Stage fields embedded in an older report are not evidence for this request.
            for key in ('brief', 'plan', 'qa', 'loop'):
                report.pop(key, None)
            if not standalone:
                review, threads = artifacts.pop('review', None), artifacts.pop('threads', None)
                if review is not None or threads is not None:
                    report['findings'] = review_findings(review, threads)
                report.update(artifacts)
                report['loop'] = {k: request.get(k) for k in ('request_id', 'status', 'stage', 'rounds', 'last_error', 'comment')}
                if warnings:
                    report['warnings'] = warnings
        elif runs:
            report = json.loads(runs[-1][1].read_text(encoding='utf-8'))
            run = runs[-1][0]
        else:
            report = pending_report(task)
        if not request:
            report.update(stage_files(task_dir))
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", task_dir.name):
            raise ValueError(f"invalid task directory: {task_dir.name}")
        if task.get('id', task_dir.name) != task_dir.name:
            raise ValueError(f'task id does not match directory: {task_dir}')
        if report.get("task_id", task_dir.name) != task_dir.name:
            raise ValueError(f"task_id does not match directory: {task_dir}")
        report["task_id"] = task_dir.name
        report.setdefault("title", task.get("title", ""))
        report.setdefault("run", run)
        report.setdefault("baseline_kind", "base-branch")
        for key in ('source_url', 'artifact_url'):
            report.pop(key, None)
            if (artifact_url if key == 'artifact_url' else source_url)(task.get(key)):
                report[key] = task[key]
        if not (task.get("branch") or task.get("pr")):
            report["status"] = "not-implemented"
        criteria = report.get("criteria", [])
        if not isinstance(criteria, list) or any(not isinstance(c, dict) for c in criteria):
            raise ValueError(f"invalid criteria: {task_dir}")
        if report.get("status") == "pass" and (not criteria or any(c.get("verdict") != "pass" for c in criteria)):
            report["status"] = "fail" if any(c.get("verdict") == "fail" for c in criteria) else "partial"
        partial_retest = request is not None and request['stage'] == 'RETEST' and report.get('status') == 'partial'
        report, portable = embed_images(report, task_dir, max_width, allow_unavailable=partial_retest)
        html = write_page(template, [portable], task_dir / 'report.html')
        # A durable local association, not a claim that an external task was updated.
        attachment = {'task_id': task_dir.name, 'kind': 'local-html', 'path': 'report.html',
                      'title': report['title'], 'run': report['run'], 'sha256': hashlib.sha256(html.encode()).hexdigest()}
        for key in ('source_url', 'artifact_url'):
            if report.get(key):
                attachment[key] = report[key]
        attachment_file = task_dir / 'report-page.json'
        if attachment_file.is_symlink():
            raise ValueError(f'symlink output is not allowed: {attachment_file}')
        attachment_file.write_text(json.dumps(attachment, indent=2) + '\n', encoding='utf-8')
        data.append(portable if embed else report)
    html = write_page(template, data, out)
    print(f"{len(data)} tasks → {out} ({len(html.encode())/1e6:.1f} MB)")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tasks")
    parser.add_argument("--out", required=True)
    parser.add_argument("--embed", action="store_true")
    parser.add_argument("--max-width", type=int, default=600)
    args = parser.parse_args()
    try:
        build(args.tasks, args.out, args.embed, args.max_width)
    except (ValueError, OSError, sqlite3.Error) as exc:
        parser.exit(2, f"report error: {exc}\n")


if __name__ == "__main__":
    main()
