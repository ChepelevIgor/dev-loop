#!/usr/bin/env python3
"""Build a self-contained «is it a bug» page from .devloop/bugs/<id>/runs/<n>/bug-report.json.

    build_bug_report.py .devloop/bugs/TASK-12            -> .devloop/bugs/TASK-12/report.html (latest run)
    build_bug_report.py .devloop/bugs/TASK-12 --check    -> validate the latest run only, write nothing

Screenshots are embedded as they are (PNG bytes, no resizing), so the page works offline and can be attached to the
task. A report that breaks the verdict rules is refused with every error listed; nothing is written then.
"""
import argparse
import base64
import io
import json
from pathlib import Path
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'sim-verify-task' / 'scripts'))
from build_report import source_url, write_page  # noqa: E402

TEMPLATE = Path(__file__).resolve().parents[1] / 'templates' / 'bug.html'
VERDICTS = ('bug', 'not-a-bug', 'cannot-reproduce', 'needs-info')
SOURCES = ('task', 'design', 'code', 'spec', 'docs')
LOGIC = ('matches', 'differs', 'missing', 'unclear')
PNG = b'\x89PNG\r\n\x1a\n'


def runs(bug_dir):
    # a run folder without its report is a check still in progress (screenshots being taken), not a run yet
    found = [int(p.name) for p in (bug_dir / 'runs').glob('*')
             if p.is_dir() and p.name.isdigit() and (p / 'bug-report.json').is_file()]
    return sorted(found)


def shot_path(bug_dir, run, value):
    """A task-relative PNG under runs/<run>/shots/, inside the bug folder, existing and really a PNG."""
    if not isinstance(value, str) or not re.fullmatch(rf'runs/{run}/shots/[\w.-]+\.png', value) or '..' in value:
        raise ValueError(f'screenshot path must be runs/{run}/shots/<name>.png: {value!r}')
    path = bug_dir / value
    path.resolve().relative_to(bug_dir.resolve())
    if not path.is_file():
        raise ValueError(f'missing screenshot: {value}')
    data = path.read_bytes()
    if not data.startswith(PNG):
        raise ValueError(f'not a PNG: {value}')
    try:
        from PIL import Image
    except ImportError as e:
        raise ValueError('Pillow is required to validate PNG screenshots') from e
    try:
        with Image.open(io.BytesIO(data)) as image:
            image.verify()
        # verify() checks chunk integrity; load() also checks the compressed pixel data.
        with Image.open(io.BytesIO(data)) as image:
            image.load()
    except (OSError, SyntaxError, ValueError, Image.DecompressionBombError) as e:
        raise ValueError(f'invalid PNG screenshot: {value}') from e
    return path


def errors_of(report, bug_dir, run):
    """Every reason the report cannot be shown as a verdict. Empty list = valid."""
    errs = []
    need = lambda v: isinstance(v, str) and v.strip()  # noqa: E731
    if report.get('bug_id') != bug_dir.name:
        errs.append(f'bug_id must be {bug_dir.name} (the task being checked)')
    if report.get('run') != run:
        errs.append(f'run must be {run} (the folder it is in)')
    verdict = report.get('verdict')
    if verdict not in VERDICTS:
        errs.append(f'verdict must be one of {", ".join(VERDICTS)}')
    if not need(report.get('summary')):
        errs.append('summary: one or two plain sentences are required')
    build = report.get('build') or {}
    if verdict in ('bug', 'not-a-bug', 'cannot-reproduce') and not (need(build.get('commit')) and need(report.get('device'))):
        errs.append('build.commit and device are required when the app was run')
    steps = report.get('steps')
    if not isinstance(steps, list):
        errs.append('steps must be a list')
        steps = []
    shots = set()
    for i, step in enumerate(steps, 1):
        if not isinstance(step, dict) or not need(step.get('action')):
            errs.append(f'step {i}: action is required')
            continue
        if step.get('shot'):
            try:
                shot_path(bug_dir, run, step['shot'])
                shots.add(i)
            except ValueError as e:
                errs.append(f'step {i}: {e}')
    expected = report.get('expected') or {}
    has_source = expected.get('source') in SOURCES and need(expected.get('ref'))
    if verdict == 'bug':
        if not shots:
            errs.append('bug: at least one screenshot of the wrong behavior is required')
        if not need(report.get('actual')):
            errs.append('bug: actual (what really happens) is required')
        if not (need(expected.get('text')) and expected.get('source') in SOURCES):
            errs.append(f'bug: expected.text and expected.source ({"/".join(SOURCES)}) are required')
    if verdict == 'not-a-bug':
        if not shots:
            errs.append('not-a-bug: at least one screenshot of the observed behavior is required')
        if not (need(expected.get('text')) and has_source):
            errs.append('not-a-bug: cite where the intended behavior comes from — expected.text, expected.source and '
                        'expected.ref (task text, design, code path or spec); without it the verdict is needs-info')
    if verdict == 'cannot-reproduce':
        if not steps:
            errs.append('cannot-reproduce: list the steps that were tried')
        if not shots:
            errs.append('cannot-reproduce: at least one screenshot of the result is required')
    questions = report.get('questions')
    if questions is not None and not (isinstance(questions, list) and all(need(q) for q in questions)):
        errs.append('questions must be a list of non-empty strings')
    if verdict == 'needs-info' and not questions:
        errs.append('needs-info: ask at least one question')
    if verdict in ('bug', 'not-a-bug', 'cannot-reproduce') and not report.get('logic'):
        errs.append('logic: list the business rules of the task and whether the app follows them now (at least the expected behavior)')
    errs += logic_errors(report.get('logic'), steps, shots)
    return errs


def logic_errors(logic, steps, valid_shots):
    """Business rules of the task against the app now: each with its source, a status and the evidence it rests on."""
    if logic is None:
        return []
    if not isinstance(logic, list):
        return ['logic must be a list']
    errs = []
    need = lambda v: isinstance(v, str) and v.strip()  # noqa: E731
    for i, rule in enumerate(logic, 1):
        if not isinstance(rule, dict) or not need(rule.get('rule')):
            errs.append(f'logic {i}: rule (the business rule in plain words) is required')
            continue
        if rule.get('source') not in SOURCES or not need(rule.get('ref')):
            errs.append(f'logic {i}: source ({"/".join(SOURCES)}) and ref (where the rule is written) are required')
        status = rule.get('status')
        if status not in LOGIC:
            errs.append(f'logic {i}: status must be one of {", ".join(LOGIC)}')
            continue
        step, code = rule.get('step'), rule.get('code')
        valid_step = type(step) is int and 1 <= step <= len(steps)
        if step is not None and not valid_step:
            errs.append(f'logic {i}: step must be the number of a listed step (1..{len(steps)})')
        if status != 'unclear' and valid_step and step not in valid_shots:
            errs.append(f'logic {i}: step {step} needs a valid screenshot to serve as evidence')
        if status != 'unclear' and step is None and not need(code):
            errs.append(f'logic {i}: {status} needs evidence — a step with its screenshot (step) or the mobile code (code: path:line)')
        if status in ('differs', 'missing', 'unclear') and not need(rule.get('note')):
            errs.append(f'logic {i}: {status} needs a note — what the app does instead, or what is unknown')
    return errs


def logic_score(logic):
    """How much of the task's business logic the app follows now: matched of the rules that could be checked."""
    rules = logic or []
    checked = [r for r in rules if r.get('status') != 'unclear']
    matched = sum(r.get('status') == 'matches' for r in checked)
    return {'total': len(rules), 'checked': len(checked), 'matches': matched,
            'unclear': len(rules) - len(checked), 'percent': round(100 * matched / len(checked)) if checked else None}


def embed(report, bug_dir, run):
    report = json.loads(json.dumps(report))
    for step in report.get('steps', []):
        if step.get('shot'):
            data = shot_path(bug_dir, run, step['shot']).read_bytes()
            step['shot'] = 'data:image/png;base64,' + base64.b64encode(data).decode()
    return report


def build(bug_dir, check=False):
    bug_dir = Path(bug_dir)
    meta_file = bug_dir / 'bug.json'
    if not meta_file.is_file():
        raise ValueError(f'{meta_file} is missing: save the issue (id, title, steps, expected, actual) first')
    meta = json.loads(meta_file.read_text())
    if meta.get('id') != bug_dir.name:
        raise ValueError(f'bug.json id {meta.get("id")!r} does not match the folder {bug_dir.name!r}')
    meta['source_url'] = source_url(meta.get('source_url'))
    found = runs(bug_dir)
    report = None
    if found:
        run = found[-1]
        report = json.loads((bug_dir / 'runs' / str(run) / 'bug-report.json').read_text())
        errs = errors_of(report, bug_dir, run)
        if errs:
            raise ValueError('bug-report.json is refused:\n- ' + '\n- '.join(errs))
        if check:
            return {'ok': True, 'run': run, 'verdict': report['verdict']}
        report = embed(report, bug_dir, run)
        if report.get('logic'):
            report['logic_score'] = logic_score(report['logic'])
    elif check:
        raise ValueError('no runs yet')
    history = []
    for n in found[:-1]:
        try:
            old = json.loads((bug_dir / 'runs' / str(n) / 'bug-report.json').read_text())
            if not isinstance(old, dict) or old.get('bug_id') != meta['id']:
                raise ValueError('history report belongs to another task')
            history.append({'run': n, 'verdict': old.get('verdict'), 'summary': old.get('summary'), 'at': old.get('at')})
        except (OSError, ValueError):
            history.append({'run': n, 'verdict': None, 'summary': 'invalid or unreadable report'})
    out = bug_dir / 'report.html'
    write_page(TEMPLATE.read_text(encoding='utf-8'), {'bug': meta, 'report': report, 'history': history}, out)
    return {'ok': True, 'page': str(out.resolve()), 'run': found[-1] if found else None,
            'verdict': report['verdict'] if report else 'pending', 'logic': (report or {}).get('logic_score')}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('bug_dir', help='.devloop/bugs/<id>')
    parser.add_argument('--check', action='store_true', help='validate the latest run, write nothing')
    args = parser.parse_args()
    try:
        print(json.dumps(build(args.bug_dir, args.check), ensure_ascii=False))
    except (OSError, ValueError) as e:
        print(f'build_bug_report: {e}', file=sys.stderr)
        sys.exit(2)


if __name__ == '__main__':
    main()
