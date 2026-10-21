import json, subprocess, sys, tempfile, unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ARGUE = ROOT / 'skills/debate/scripts/argue.py'
CHECK = ROOT / 'skills/debate/scripts/check_verdict.py'


def debate(tmp):
    """Two rounds: product's claim survives, ux.1 is defeated; product and skeptic prefer B, ux prefers A."""
    d = Path(tmp)
    moves = {
        'product': ([{'id': 'product.1', 'type': 'claim', 'text': 'B lifts trial starts', 'p': 0.8, 'evidence': ['metrics.csv']}], {'A': 0.2, 'B': 0.8}),
        'ux': ([{'id': 'ux.1', 'type': 'claim', 'text': 'A is clearer', 'p': 0.6, 'evidence': ['test.md']}], {'A': 0.7, 'B': 0.3}),
        'skeptic': ([{'id': 'skeptic.1', 'type': 'attack', 'target': 'ux.1', 'text': 'Five users only', 'p': 0.8, 'evidence': ['test.md:3']}], {'A': 0.4, 'B': 0.6}),
    }
    (d / 'round_1').mkdir()
    for role, (m, o) in moves.items():
        (d / f'round_1/{role}.json').write_text(json.dumps({'role': role, 'round': 1, 'moves': m, 'options': o}))
    subprocess.run([sys.executable, str(ARGUE), str(d), '--round', '1'], check=True, capture_output=True)
    return d


def verdict(d, **over):
    v = {'question': 'q', 'decision': 'B', 'confidence': 0.7, 'must': [{'text': 'Ship B', 'evidence': ['product.1']}], 'should': [], 'wont': [],
         'dissent': [{'role': 'ux', 'text': 'Prefers A', 'p': 0.7}], 'open_questions': [], 'rationale': 'product.1 stands; skeptic.1 defeats ux.1.',
         'judge': {'independent': True, 'by': 'subagent'}}
    v.update(over)
    (d / 'verdict.json').write_text(json.dumps(v))
    r = subprocess.run([sys.executable, str(CHECK), str(d)], capture_output=True, text=True)
    return r.returncode, json.loads(r.stdout)


class DebateTests(unittest.TestCase):
    def test_topic_roles_from_the_debate_folder_are_weighted_and_replace_library_roles(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            (d / 'roles').mkdir()
            # a role written for the topic, and a topic version of a library role
            (d / 'roles/store-reviewer.md').write_text('---\nrole: store-reviewer\nweight: {paywall: 1.7, default: 0.9}\n---\n# Store reviewer\n')
            (d / 'roles/skeptic.md').write_text('---\nrole: skeptic\nweight: {default: 0.5}\n---\n# Skeptic for this topic\n')
            (d / 'round_1').mkdir()
            for role, pref in (('store-reviewer', {'A': 0.8, 'B': 0.2}), ('skeptic', {'A': 0.3, 'B': 0.7}), ('product', {'A': 0.6, 'B': 0.4})):
                (d / f'round_1/{role}.json').write_text(json.dumps({'role': role, 'round': 1, 'moves': [
                    {'id': f'{role}.1', 'type': 'claim', 'text': 'x', 'p': 0.7, 'evidence': ['brief.md']}], 'options': pref}))
            r = subprocess.run([sys.executable, str(ARGUE), str(d), '--round', '1', '--tags', 'paywall'], capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)
            w = json.loads((d / 'state.json').read_text())['weights']
            self.assertEqual(w['store-reviewer'], 1.7)
            self.assertEqual(w['skeptic'], 0.5, 'the topic role replaces the library skeptic')
            self.assertEqual(w['product'], 0.8, 'library roles still come from the skill')

    def test_a_sound_independent_verdict_passes(self):
        with tempfile.TemporaryDirectory() as tmp:
            code, out = verdict(debate(tmp))
            self.assertEqual((code, out['errors'], out['warnings']), (0, [], []))

    def test_the_judge_cannot_rest_must_on_a_defeated_claim_invent_ids_or_drop_dissent(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = debate(tmp)
            code, out = verdict(d, must=[{'text': 'Make it clearer', 'evidence': ['ux.1']}])
            self.assertEqual(code, 1)
            self.assertIn('must[0] rests on ux.1, which did not survive objections', out['errors'])
            _, out = verdict(d, rationale='product.7 settles it')
            self.assertIn('product.7 is cited but is not a move of the debate', out['errors'])
            _, out = verdict(d, dissent=[])
            self.assertIn('ux preferred another option: its dissent is missing', out['errors'])
            _, out = verdict(d, decision='C')
            self.assertTrue(any('is not an option' in e for e in out['errors']))
            _, out = verdict(d, decision=None, confidence=0.4, must=[], dissent=[])
            self.assertIn('no decision: confidence must be 0', out['errors'])

    def test_a_withdrawn_claim_may_be_mentioned_but_not_relied_on(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = debate(tmp)
            (d / 'round_2').mkdir()
            for role, o in (('product', {'A': 0.2, 'B': 0.8}), ('ux', {'A': 0.7, 'B': 0.3}), ('skeptic', {'A': 0.4, 'B': 0.6})):
                moves = [{'id': 'ux.1', 'p': 0}] if role == 'ux' else []
                (d / f'round_2/{role}.json').write_text(json.dumps({'role': role, 'round': 2, 'moves': moves, 'options': o}))
            subprocess.run([sys.executable, str(ARGUE), str(d), '--round', '2'], check=True, capture_output=True)
            code, out = verdict(d, wont=[{'text': 'Do not rely on ux.1: it was withdrawn', 'evidence': ['ux.1']}])
            self.assertEqual((code, out['errors']), (0, []))
            _, out = verdict(d, must=[{'text': 'Ship A', 'evidence': ['ux.1']}])
            self.assertIn('must[0] rests on ux.1, which was withdrawn', out['errors'])

    def test_unknown_roles_and_claims_cannot_support_a_verdict(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = debate(tmp)
            for evidence in (['invented.999'], ['product.1', 'invented.999'], ['skeptic.1']):
                with self.subTest(evidence=evidence):
                    code, out = verdict(d, must=[{'text': 'Ship B', 'evidence': evidence}])
                    self.assertEqual(code, 1)
                    self.assertTrue(any('did not survive objections' in e for e in out['errors']))
            code, out = verdict(d, rationale='invented.999 settles this')
            self.assertEqual(code, 1)
            self.assertIn('invented.999 is cited but is not a move of the debate', out['errors'])
            for reference in ('(invented.999).', '`invented.999`',
                              '[invented.999](https://example.test/notes)',
                              'product.1\ninvented.999'):
                with self.subTest(reference=reference):
                    code, out = verdict(d, rationale=reference)
                    self.assertEqual(code, 1)
                    self.assertIn('invented.999 is cited but is not a move of the debate', out['errors'])
            for section in ('should', 'wont'):
                code, out = verdict(d, **{section: [{'text': 'A proposal', 'evidence': ['invented.999']}]})
                self.assertEqual(code, 1)
                self.assertIn('invented.999 is cited but is not a move of the debate', out['errors'])

    def test_paths_urls_and_versions_are_not_mistaken_for_move_references(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = debate(tmp)
            for resource in ('benchmarks/v1.2/results.csv', 'v1.2/results.csv',
                             'release.2.csv', '/tmp/product.7', r'C:\benchmarks\v1.2\results.csv',
                             'https://example.test/v1.2?claim=invented.999'):
                with self.subTest(resource=resource):
                    code, out = verdict(d, rationale=f'product.1 is supported by {resource}.',
                                        must=[{'text': f'Ship B using {resource}',
                                               'evidence': ['product.1', resource]}])
                    self.assertEqual((code, out['errors']), (0, []))
            code, out = verdict(d, rationale='product.1 supports upgrading from v1.2 to v1.3.0.')
            self.assertEqual((code, out['errors']), (0, []))
            # Evidence entries that consist only of role.N are explicit IDs, even for a version-like role.
            code, out = verdict(d, should=[{'text': 'A proposal', 'evidence': ['v1.2']}])
            self.assertEqual(code, 1)
            self.assertIn('v1.2 is cited but is not a move of the debate', out['errors'])

    def test_the_judge_must_say_who_judged_and_a_moderator_verdict_is_flagged(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = debate(tmp)
            code, out = verdict(d, judge=None)
            self.assertEqual(code, 1)
            self.assertTrue(any(e.startswith('judge:') for e in out['errors']))
            code, out = verdict(d, judge={'independent': False, 'by': 'moderator'})
            self.assertEqual(code, 0)
            self.assertIn('not independent', out['warnings'][0])

    def test_skill_documents_size_settings_and_generated_roles(self):
        text = (ROOT / 'skills/debate/SKILL.md').read_text()
        for part in ('debaters | 2–10', 'rounds | 1–5', 'коротко / обычно / подробно', 'generated for the topic', 'an independent judge', 'check_verdict.py'):
            self.assertIn(part, text)


if __name__ == '__main__':
    unittest.main()
