"""Deterministic local-only worker for exercising the runtime, not a real reviewer."""
import json
from pathlib import Path
import sys
from PIL import Image

request = json.load(sys.stdin)
root = Path(request['root'])
task_dir = f"tasks/{request['task_id']}"
output_dir = f"{task_dir}/evidence/{request['attempt_id']}"
(root/output_dir).mkdir(parents=True)
artifacts = {}

def write(key, value):
    relative = f'{output_dir}/{key}.json'
    (root/relative).write_text(json.dumps(value))
    artifacts[key] = relative

stage = request['stage']
scenario = request['task'].get('scenario', 'normal')
sha = request['head_sha']
task = request['task']
texts = [c.get('text') if isinstance(c, dict) else c for c in task['acceptance']]
if stage == 'BRIEF':
    # brief_blocks: a product question stops the work until the person answers it (a comment on resume)
    blocking = scenario == 'brief_blocks' and not request.get('comment')
    write('brief', {'metric': 'Onboarding completion', 'summary': 'The fixture screen works for the user.', 'dod': ['The screen works'],
                    'cases': [{'text': t, 'given': 'a user', 'when': 'they open the screen', 'then': 'it works'} for t in texts],
                    'gaps': [{'kind': 'product', 'text': 'Which plan gets the feature?', 'blocking': True}] if blocking else [],
                    'base_sha': task['base_sha']})
elif stage == 'PLAN':
    relative = f'{output_dir}/plan.md'
    (root/relative).write_text('# Technical solution\n' + 'Change the fixture screen in one module, keep the API unchanged, add a test. ' * 4)
    artifacts['plan'] = relative
elif stage == 'QA':
    criteria = ['Something else'] if scenario == 'qa_gap' else texts
    write('qa', {'author': 'fixture', 'independent': False, 'cases': [{'title': 'Open the screen', 'criterion': t, 'given': 'a user', 'when': 'they open it', 'then': 'it works'} for t in criteria]})
elif stage in ('EXECUTE', 'FIX'):
    write('checks', {'passed': True, 'head_sha': sha, 'commands': [{'argv': ['fixture-check'], 'exit_code': 0}], 'fixture': True})
elif stage == 'PR':
    write('pr', {'number': 1, 'url': 'https://example.test/pr/1', 'head_sha': sha})
elif stage == 'REVIEW':
    finding = {'body': 'Fixture regression', 'severity': 'major', 'category': 'correctness'}
    findings = [finding] if scenario == 'review_once' and request['rounds'] == 0 else []
    write('review', {'completed': True, 'findings': findings})
    write('threads', [{**finding, 'resolved': False}] if findings else [])
elif stage == 'COUNCIL':
    write('verdict', {'decision': 'fix', 'must': [{'text': 'Fix fixture', 'evidence': ['test']}], 'confidence': .99})
elif stage == 'RETEST':
    fail = scenario == 'fail_forever'
    verdict = 'partial' if scenario == 'partial_retest' else 'fail' if fail else 'pass'
    image = f'{task_dir}/runs/1/after/c1.png'
    (root/image).parent.mkdir(parents=True, exist_ok=True)
    Image.new('RGB', (2, 2), 'white').save(root/image)
    criteria = [{'text': request['task']['acceptance'][0], 'verdict': verdict, 'after': 'runs/1/after/c1.png'}]
    write('report', {'head_sha': sha, 'status': verdict, 'criteria': [] if scenario == 'empty_criteria' else criteria})
result = {key:request[key] for key in ('request_id', 'attempt_id', 'stage', 'head_sha')}
result.update(completed=True, artifacts=artifacts)
print(json.dumps(result))
