#!/usr/bin/env python3
"""Check a judge's verdict against the debate it judges.

  check_verdict.py DEBATE_DIR

Reads verdict.json and state.json (written by argue.py). Prints {"ok", "errors", "warnings"} and exits 1 on errors:
- the decision is not one of the options, or a tie got a decision without a rationale;
- confidence is outside [0, 1], or above zero without a decision;
- a `must` item cites no claim, a withdrawn claim, or a claim that did not survive objections (not in `grounded`);
- an ID cited anywhere in the verdict is not a move of the debate;
- a role whose preferred option differs from the decision is missing from `dissent`;
- `judge` is missing or malformed.
A verdict by the moderator (judge.independent false) passes with a warning: the report must say it is not independent.
"""
import json
import re
import sys
from pathlib import Path

ID = re.compile(r'\b[a-z][a-z0-9_-]*\.\d+\b')
# Prose references must be whole tokens, not path segments, filenames or parts of version numbers.
PROSE_ID = re.compile(r'(?<![\w./\\@#-])[a-z][a-z0-9_-]*\.\d+(?![\w/\\-]|\.\w)')
URL = re.compile(r'\b[a-z][a-z0-9+.-]*://[^\s<>"`]+', re.I)
VERSION = re.compile(r'v\d+\.\d+', re.I)


def references(value, roles, evidence=False):
    """Read actual string values: JSON escaping must not become part of a cited ID."""
    if isinstance(value, dict):
        for key, child in value.items():
            yield from references(child, roles, evidence=key == 'evidence')
    elif isinstance(value, list):
        for child in value:
            yield from references(child, roles, evidence=evidence)
    elif isinstance(value, str):
        # A bare role.N evidence entry explicitly cites a move, including an unknown role.
        if evidence and ID.fullmatch(value):
            yield value
        else:
            for ref in PROSE_ID.findall(URL.sub('', value)):
                if not VERSION.fullmatch(ref) or ref.split('.')[0] in roles:
                    yield ref


def check(d):
    d = Path(d)
    errors, warnings = [], []
    try:
        v = json.loads((d / 'verdict.json').read_text())
        st = json.loads((d / 'state.json').read_text())
    except (OSError, ValueError) as e:
        return [f'cannot read verdict.json / state.json: {e}'], warnings
    # every move ever made, withdrawn ones too: a verdict may say a claim was withdrawn (argue.py drops it from the state)
    made = {m.get('id') for f in d.glob('round_*/*.json') for m in (json.loads(f.read_text()).get('moves') or []) if isinstance(m, dict)}
    known = set(st.get('move_signature', {})) | set(st.get('claims', {})) | made
    live = set(st.get('move_signature', {}))
    grounded = set(st.get('grounded', []))
    options = set(st.get('option_scores', {}))

    j = v.get('judge')
    if not isinstance(j, dict) or not isinstance(j.get('independent'), bool) or not str(j.get('by') or '').strip():
        errors.append('judge: {"independent": true|false, "by": "subagent | claude -p | codex exec | moderator"} is required')
    elif not j['independent']:
        warnings.append(f"the verdict is not independent (judged by {j['by']}): say so in the report")

    dec = v.get('decision')
    if dec is not None and options and dec not in options:
        errors.append(f'decision {dec!r} is not an option ({", ".join(sorted(options))})')
    if dec is not None and st.get('tie') and not str(v.get('rationale') or '').strip():
        errors.append('the debate is tied: a decision needs a rationale citing the claims that resolve it')
    c = v.get('confidence')
    if type(c) not in (int, float) or not 0 <= c <= 1:
        errors.append('confidence must be a number in [0, 1]')
    elif dec is None and c > 0:
        errors.append('no decision: confidence must be 0')

    def cited(item):
        return [e for e in item.get('evidence', []) if isinstance(e, str) and ID.fullmatch(e)]

    for i, item in enumerate(v.get('must') or []):
        ids = cited(item)
        if not ids:
            errors.append(f'must[{i}] cites no claim of the debate')
        for e in ids:
            if e in made and e not in live:
                errors.append(f'must[{i}] rests on {e}, which was withdrawn')
            elif e not in grounded:
                errors.append(f'must[{i}] rests on {e}, which did not survive objections')
    roles = {e.split('.')[0] for e in known if isinstance(e, str)}
    sections = {k: v.get(k) for k in ('must', 'should', 'wont', 'rationale', 'dissent')}
    for e in sorted(set(references(sections, roles))):
        if e not in known:
            errors.append(f'{e} is cited but is not a move of the debate')

    if dec is not None:
        named = {x.get('role') for x in v.get('dissent') or [] if isinstance(x, dict)}
        for role, dist in (st.get('options') or {}).items():
            top = max(dist.values())
            if dist.get(dec, 0) < top and role not in named:
                errors.append(f'{role} preferred another option: its dissent is missing')
    return errors, warnings


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if len(argv) != 1:
        print(__doc__.strip().splitlines()[2].strip(), file=sys.stderr)
        return 2
    errors, warnings = check(argv[0])
    print(json.dumps({'ok': not errors, 'errors': errors, 'warnings': warnings}, ensure_ascii=False))
    return 1 if errors else 0


if __name__ == '__main__':
    sys.exit(main())
