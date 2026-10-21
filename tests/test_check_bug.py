import base64, json, re, subprocess, sys, tempfile, unittest, zlib, struct
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / 'skills/check-bug/scripts/build_bug_report.py'


def png(path):
    """A 1×1 white PNG without Pillow."""
    def chunk(kind, body):
        return struct.pack('>I', len(body)) + kind + body + struct.pack('>I', zlib.crc32(kind + body) & 0xffffffff)
    data = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 2, 0, 0, 0)) \
        + chunk(b'IDAT', zlib.compress(b'\x00\xff\xff\xff')) + chunk(b'IEND', b'')
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def report(**over):
    r = {'bug_id': 'TASK-12', 'run': 1, 'verdict': 'bug', 'summary': 'Имя сбрасывается после перезапуска.',
         'expected': {'text': 'Имя остаётся', 'source': 'task', 'ref': 'TASK-12 acceptance 2'},
         'actual': 'Старое имя', 'build': {'ref': 'main', 'commit': 'abc1234'}, 'device': 'ios:TEST',
         'steps': [{'action': 'Открыть профиль', 'shot': 'runs/1/shots/01.png'},
                   {'action': 'Перезапустить', 'shot': 'runs/1/shots/02.png', 'bad': True}],
         'logic': [{'rule': 'Имя сохраняется после перезапуска', 'source': 'task', 'ref': 'TASK-12 #2', 'status': 'differs', 'step': 2, 'note': 'старое имя'},
                   {'rule': 'Имя до 40 символов', 'source': 'design', 'ref': '/profile', 'status': 'matches', 'code': 'src/NameField.tsx:18'},
                   {'rule': 'Пустое имя нельзя сохранить', 'source': 'task', 'ref': 'TASK-12', 'status': 'matches', 'step': 1},
                   {'rule': 'Офлайн сохраняется позже', 'source': 'spec', 'ref': 'docs/profile.md', 'status': 'unclear', 'note': 'нет сети в симуляторе'}],
         'questions': []}
    r.update(over)
    return r


class CheckBugTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.bug = Path(self.tmp.name) / '.devloop/bugs/TASK-12'
        self.bug.mkdir(parents=True)
        (self.bug / 'bug.json').write_text(json.dumps({'id': 'TASK-12', 'title': 'Имя не сохраняется',
                                                       'source_url': 'https://linear.app/team/issue/TASK-12?token=x'}))
        png(self.bug / 'runs/1/shots/01.png')
        png(self.bug / 'runs/1/shots/02.png')

    def build(self, value, *extra, run=1):
        (self.bug / f'runs/{run}').mkdir(parents=True, exist_ok=True)
        (self.bug / f'runs/{run}/bug-report.json').write_text(json.dumps(value))
        return subprocess.run([sys.executable, str(BUILD), str(self.bug), *extra], capture_output=True, text=True)

    def test_page_before_any_run_and_a_valid_bug_with_embedded_screenshots(self):
        r = subprocess.run([sys.executable, str(BUILD), str(self.bug)], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout)['verdict'], 'pending')
        r = self.build(report())
        self.assertEqual(r.returncode, 0, r.stderr)
        html = (self.bug / 'report.html').read_text()
        self.assertEqual(len(re.findall(r'data:image/png;base64,', html)), 2)
        self.assertNotIn('runs/1/shots', html)
        self.assertNotIn('token=x', html, 'a source URL with a query is dropped')
        self.assertNotIn('/*__DATA__*/', html)
        # business logic now: 2 of the 3 checkable rules match, the unclear one is counted apart
        self.assertEqual(json.loads(r.stdout)['logic'], {'total': 4, 'checked': 3, 'matches': 2, 'unclear': 1, 'percent': 67})

    def test_verdict_rules_refuse_unsupported_claims(self):
        cases = {
            'not-a-bug without a cited source': report(verdict='not-a-bug', expected={'text': 'Так задумано', 'source': 'task'}),
            'bug without a screenshot': report(steps=[{'action': 'Открыть профиль'}]),
            'bug without expected source': report(expected={'text': 'Имя остаётся'}),
            'needs-info without questions': report(verdict='needs-info', steps=[]),
            'unknown verdict': report(verdict='maybe'),
            'run without a build': report(build={}),
            'screenshot outside the run': report(steps=[{'action': 'x', 'shot': 'runs/1/shots/../../../bug.json'}]),
            'screenshot of another run': report(steps=[{'action': 'x', 'shot': 'runs/2/shots/01.png'}]),
            'run without business rules': report(logic=[]),
            'rule without a source': report(logic=[{'rule': 'r', 'status': 'matches', 'step': 1}]),
            'matches without evidence': report(logic=[{'rule': 'r', 'source': 'task', 'ref': 'x', 'status': 'matches'}]),
            'differs without a note': report(logic=[{'rule': 'r', 'source': 'task', 'ref': 'x', 'status': 'differs', 'step': 1}]),
            'step out of range': report(logic=[{'rule': 'r', 'source': 'task', 'ref': 'x', 'status': 'matches', 'step': 9}]),
        }
        for name, value in cases.items():
            with self.subTest(name):
                r = self.build(value)
                self.assertEqual(r.returncode, 2, name)
                self.assertIn('refused', r.stderr)
        self.assertFalse((self.bug / 'report.html').exists(), 'a refused report writes no page')

    def test_not_a_bug_with_source_and_needs_info_with_questions_pass_and_history_is_kept(self):
        r = self.build(report(verdict='not-a-bug', expected={'text': 'Имя сбрасывается по дизайну', 'source': 'design', 'ref': '/profile'}))
        self.assertEqual(r.returncode, 0, r.stderr)
        r = self.build(report(run=2, verdict='needs-info', steps=[], build={}, device=None, logic=None, questions=['Какая версия?']), run=2)
        self.assertEqual(r.returncode, 0, r.stderr)
        out = json.loads(r.stdout)
        self.assertEqual((out['run'], out['verdict']), (2, 'needs-info'))
        html = (self.bug / 'report.html').read_text()
        self.assertIn('"history": [{"run": 1, "verdict": "not-a-bug"', html)

    def test_check_mode_writes_nothing(self):
        r = self.build(report(), '--check')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertFalse((self.bug / 'report.html').exists())

    def test_cannot_reproduce_requires_a_result_screenshot_even_with_code_evidence(self):
        value = report(verdict='cannot-reproduce', steps=[{'action': 'Перезапустить'}],
                       logic=[{'rule': 'Имя сохраняется', 'source': 'task', 'ref': 'TASK-12',
                               'status': 'matches', 'code': 'src/profile.ts:10'}])
        for args in ((), ('--check',)):
            with self.subTest(args=args):
                result = self.build(value, *args)
                self.assertEqual(result.returncode, 2, result.stdout)
                self.assertIn('cannot-reproduce', result.stderr)
                self.assertIn('screenshot', result.stderr)
        self.assertFalse((self.bug / 'report.html').exists())
        value['steps'][0]['shot'] = 'runs/1/shots/01.png'
        result = self.build(value)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['verdict'], 'cannot-reproduce')

    def test_rule_cannot_cite_a_step_without_a_screenshot(self):
        for status in ('matches', 'differs', 'missing'):
            with self.subTest(status=status):
                value = report(logic=[{'rule': 'Имя сохраняется', 'source': 'task', 'ref': 'TASK-12',
                                      'status': status, 'step': 2, 'note': 'Проверка после перезапуска'}])
                del value['steps'][1]['shot']
                # Step 1 still has a valid screenshot; it must not support a claim about step 2.
                result = self.build(value)
                self.assertEqual(result.returncode, 2, result.stdout)
                self.assertIn('logic 1', result.stderr)
                self.assertIn('screenshot', result.stderr)
        self.assertFalse((self.bug / 'report.html').exists())

    def test_wrong_or_missing_bug_id_is_refused_without_overwriting_the_page(self):
        result = self.build(report())
        self.assertEqual(result.returncode, 0, result.stderr)
        page = (self.bug / 'report.html').read_bytes()
        for bug_id in ('TASK-999', None):
            for args in ((), ('--check',)):
                with self.subTest(bug_id=bug_id, args=args):
                    value = report(bug_id=bug_id)
                    if bug_id is None:
                        del value['bug_id']
                    result = self.build(value, *args)
                    self.assertEqual(result.returncode, 2, result.stdout)
                    self.assertIn('bug_id', result.stderr)
                    self.assertEqual((self.bug / 'report.html').read_bytes(), page)

    def test_foreign_history_is_not_shown_as_this_tasks_result(self):
        foreign = report(bug_id='TASK-999', summary='Foreign task verdict')
        self.build(foreign)
        result = self.build(report(run=2, verdict='needs-info', steps=[], logic=None,
                                   questions=['Какая версия?']), run=2)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('Foreign task verdict', (self.bug / 'report.html').read_text())

    def test_corrupt_pngs_are_refused_in_build_and_check_modes(self):
        shot = self.bug / 'runs/1/shots/01.png'
        good = shot.read_bytes()
        idat = good.index(b'IDAT')
        length = struct.unpack('>I', good[idat - 4:idat])[0]
        # Valid chunk CRC but invalid compressed pixels: verify() alone must not be enough.
        bad_pixels = b'\0' * length
        invalid_stream = (good[:idat + 4] + bad_pixels
                          + struct.pack('>I', zlib.crc32(b'IDAT' + bad_pixels) & 0xffffffff)
                          + good[idat + 4 + length + 4:])
        corrupt_crc = bytearray(good)
        corrupt_crc[idat + 4 + length] ^= 1
        cases = {'signature only': good[:8], 'truncated': good[:-16],
                 'bad CRC': bytes(corrupt_crc), 'invalid pixels': invalid_stream}
        for name, data in cases.items():
            for args in ((), ('--check',)):
                with self.subTest(name=name, args=args):
                    shot.write_bytes(data)
                    result = self.build(report(), *args)
                    self.assertEqual(result.returncode, 2, result.stdout)
                    self.assertIn('PNG', result.stderr)
                    self.assertIn('step 1', result.stderr)
        self.assertFalse((self.bug / 'report.html').exists())
        shot.write_bytes(good)
        result = self.build(report())
        self.assertEqual(result.returncode, 0, result.stderr)
        html = (self.bug / 'report.html').read_text()
        self.assertIn('data:image/png;base64,' + base64.b64encode(good).decode(), html)


if __name__ == '__main__':
    unittest.main()
