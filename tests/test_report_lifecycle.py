import hashlib
import json
import os
import zlib

from PIL import Image

from test_runtime import Loop
from test_regressions import builder


class ReportLifecycleTests(Loop):
    def save(self, relative, value):
        path = self.state/relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value))
        return relative

    def page(self):
        builder.build(self.state/'tasks', self.state/'report.html')
        html = (self.state/'tasks/T1/report.html').read_text()
        return json.loads(html.rsplit('const APP = startReport(', 1)[1].split(', /*__TOKEN__*/', 1)[0])[0]

    def report(self, status, **extra):
        return {'task_id': 'T1', 'head_sha': self.sha, 'status': status,
                'criteria': [{'text': 'The screen works', 'verdict': status}], **extra}

    def result(self, record, **artifacts):
        return {**{k: record[k] for k in ('request_id', 'attempt_id', 'stage', 'head_sha')},
                'completed': True, 'artifacts': artifacts}

    def test_standalone_failure_after_done_replaces_old_success(self):
        request = self.store.enqueue('T1', 'retest')
        self.assertEqual(self.run_cycle().returncode, 0)
        self.assertEqual(self.page()['status'], 'pass')
        self.save('tasks/T1/runs/2/report.json', self.report('fail', run=2, summary='Fresh verification failed'))
        page = self.page()
        self.assertEqual((page['status'], page['run']), ('fail', 2))
        self.assertEqual(page['summary'], 'Fresh verification failed')
        self.assertNotIn('loop', page, 'the completed cycle does not describe the new standalone run')
        self.assertEqual(self.store.get(request['request_id'])['status'], 'done')
        # Starting another managed cycle must still discard this unrelated standalone result.
        self.store.request('T1', 'execute', 'Make a new change')
        page = self.page()
        self.assertEqual(page['status'], 'pending')
        self.assertNotIn('summary', page)

    def test_old_numeric_report_does_not_replace_completed_evidence(self):
        old = self.save('tasks/T1/runs/99/report.json', self.report('fail', summary='Old unrelated run'))
        os.utime(self.state/old, (1, 1))
        self.store.enqueue('T1', 'retest')
        self.assertEqual(self.run_cycle().returncode, 0)
        page = self.page()
        self.assertEqual(page['status'], 'pass')
        self.assertNotIn('summary', page)

    def test_reports_bound_to_other_requests_are_not_standalone(self):
        self.store.enqueue('T1', 'retest')
        self.assertEqual(self.run_cycle().returncode, 0)
        self.save('tasks/T1/runs/2/report.json', self.report('fail', request_id='another-request'))
        self.assertEqual(self.page()['status'], 'pass')

    def partial_report(self, record, **extra):
        image = self.state/'tasks/T1/runs/2/before/c1.png'
        image.parent.mkdir(parents=True, exist_ok=True)
        Image.new('RGB', (2, 2), 'white').save(image)
        return self.report('partial', request_id=record['request_id'], attempt_id=record['attempt_id'],
                           summary='Before captured; emulator unavailable',
                           criteria=[{'text': 'The screen works', 'verdict': 'partial',
                                      'note': 'Cannot launch updated app', 'before': 'runs/2/before/c1.png'}],
                           **extra)

    def test_rejected_partial_retest_keeps_evidence_without_completing(self):
        self.store.enqueue('T1', 'retest')
        record = self.store.start(self.sha)
        path = self.save('tasks/T1/evidence/partial.json', self.partial_report(record))
        with self.assertRaises(ValueError):
            self.store.complete(record['request_id'], self.result(record, report=path), self.sha)
        self.store.block(record['request_id'], record['attempt_id'], 'Emulator unavailable')
        page = self.page()
        self.assertEqual(page['status'], 'partial')
        self.assertEqual(page['loop']['status'], 'blocked')
        self.assertEqual(page['summary'], 'Before captured; emulator unavailable')
        self.assertEqual(page['criteria'][0]['note'], 'Cannot launch updated app')
        self.assertTrue(page['criteria'][0]['before'].startswith('data:image/png;base64,'))
        events = json.loads((self.state/'runtime/events.json').read_text())
        self.assertFalse(any(e['kind'] == 'completed' for e in events))
        self.assertTrue(any(e['kind'] == 'progress' for e in events))
        # Resuming creates a fresh attempt and must not reuse the previous partial result.
        self.store.resume(record['request_id'])
        self.store.start(self.sha)
        self.assertEqual(self.page()['status'], 'pending')

    def test_directly_blocked_retest_can_show_only_its_own_partial_preview(self):
        self.store.enqueue('T1', 'retest')
        record = self.store.start(self.sha)
        partial = self.partial_report(record)
        path = self.save('tasks/T1/runs/2/report.json', partial)
        # A broken draft from another run must not hide the current attempt's preview.
        broken = self.state/self.save('tasks/T1/runs/99/report.json', {})
        broken.write_text('{')
        self.store.block(record['request_id'], record['attempt_id'], 'Emulator unavailable')
        self.assertEqual(self.page()['status'], 'partial')
        for change in ({'attempt_id': 'old'}, {'request_id': 'other'}, {'task_id': 'other'}, {'head_sha': 'old'},
                       {'status': 'pass'}, {'criteria': [{'text': 'Other task', 'verdict': 'partial'}]}):
            with self.subTest(change=change):
                self.save(path, {**partial, **change})
                self.assertEqual(self.page()['status'], 'pending')

    def test_changed_recorded_partial_cannot_bypass_digest_check_as_a_preview(self):
        self.store.enqueue('T1', 'retest')
        record = self.store.start(self.sha)
        partial = self.partial_report(record)
        path = self.save('tasks/T1/runs/2/report.json', partial)
        with self.assertRaises(ValueError):
            self.store.complete(record['request_id'], self.result(record, report=path), self.sha)
        self.store.block(record['request_id'], record['attempt_id'], 'Emulator unavailable')
        self.save(path, {**partial, 'summary': 'Changed after recording'})
        page = self.page()
        self.assertEqual(page['status'], 'pending')
        self.assertTrue(any('report' in warning for warning in page['warnings']))
        self.assertNotIn('summary', page)

    def test_invalid_partial_result_is_not_recorded_as_progress(self):
        self.store.enqueue('T1', 'retest')
        record = self.store.start(self.sha)
        path = self.save('tasks/T1/evidence/partial.json', self.partial_report(record))
        result = self.result(record, report=path)
        for key in ('attempt_id', 'request_id', 'head_sha'):
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.store.complete(record['request_id'], {**result, key: 'stale'}, self.sha)
        self.save(path, self.report('partial', criteria=[{'text': 'Other task', 'verdict': 'partial'}]))
        with self.assertRaises(ValueError):
            self.store.complete(record['request_id'], result, self.sha)
        events = json.loads((self.state/'runtime/events.json').read_text())
        self.assertFalse(any(e['kind'] in ('progress', 'completed') for e in events))
        self.assertEqual(self.page()['status'], 'pending')

    def test_worker_partial_result_stays_blocked_and_visible(self):
        self.task('T1', 'partial_retest')
        request = self.store.enqueue('T1', 'retest')
        self.assertEqual(self.run_cycle().returncode, 2)
        page = self.page()
        self.assertEqual((page['status'], page['loop']['status']), ('partial', 'blocked'))
        self.assertTrue(page['criteria'][0]['after'].startswith('data:image/png;base64,'))
        self.task('T1', 'normal')
        self.store.resume(request['request_id'])
        self.assertEqual(self.run_cycle().returncode, 0)
        self.assertEqual(self.page()['status'], 'pass')

    def check_partial_images(self, damage, preview=False):
        self.store.enqueue('T1', 'retest')
        record = self.store.start(self.sha)
        report = self.partial_report(record)
        # Keep a real baseline while the later captures are unavailable.
        for key in ('after', 'diff'):
            report['criteria'][0][key] = f'runs/2/{key}/c1.png'
        path = self.save('tasks/T1/runs/2/report.json' if preview else 'tasks/T1/evidence/partial.json', report)
        if not preview:
            with self.assertRaises(ValueError):
                self.store.complete(record['request_id'], self.result(record, report=path), self.sha)
        self.store.block(record['request_id'], record['attempt_id'], 'Capture unavailable')
        if damage in ('corrupt', 'bad_chunk'):
            content = b'\x89PNG\r\n\x1a\n'
            if damage == 'bad_chunk':
                # Valid PNG header followed by an empty IDAT and an invalid chunk ID.
                # Pillow opens this image, then fails while decoding the pixels.
                header = (self.state/'tasks/T1/runs/2/before/c1.png').read_bytes()[:33]
                content = header + b'\0\0\0\0IDAT' + zlib.crc32(b'IDAT').to_bytes(4, 'big') + b'\0\0\0\0!!!!\0\0\0\0'
            for key in ('after', 'diff'):
                image = self.state/f'tasks/T1/runs/2/{key}/c1.png'
                image.parent.mkdir(parents=True, exist_ok=True)
                image.write_bytes(content)
        self.task('T2')
        source = (self.state/path).read_bytes()
        page = self.page()
        self.assertEqual((page['status'], page['loop']['status']), ('partial', 'blocked'))
        self.assertEqual(page['summary'], report['summary'])
        self.assertEqual(page['criteria'][0]['note'], report['criteria'][0]['note'])
        self.assertTrue(page['criteria'][0]['before'].startswith('data:image/png;base64,'))
        for key in ('after', 'diff'):
            self.assertNotIn(key, page['criteria'][0])
            self.assertTrue(any(key in warning and 'screenshot' in warning for warning in page['warnings']))
        # The index and portable page must both omit broken links, without editing the evidence.
        index = (self.state/'report.html').read_text()
        data = json.loads(index.rsplit('const APP = startReport(', 1)[1].split(', /*__TOKEN__*/', 1)[0])
        self.assertEqual([t['task_id'] for t in data], ['T1', 'T2'])
        self.assertEqual(data[0]['criteria'][0]['before'], 'runs/2/before/c1.png')
        self.assertNotIn('after', data[0]['criteria'][0])
        self.assertNotIn('diff', data[0]['criteria'][0])
        self.assertEqual(data[0]['warnings'], page['warnings'])
        self.assertEqual((self.state/path).read_bytes(), source)
        self.assertFalse(any(e['kind'] == 'completed' for e in json.loads((self.state/'runtime/events.json').read_text())))

    def test_partial_report_missing_images_preserves_notes_and_available_images(self):
        self.check_partial_images('missing')

    def test_partial_report_corrupt_images_preserves_notes_and_available_images(self):
        self.check_partial_images('corrupt')

    def test_partial_report_with_broken_png_chunk_still_renders(self):
        self.check_partial_images('bad_chunk')

    def test_direct_partial_preview_with_corrupt_images_still_renders(self):
        self.check_partial_images('corrupt', preview=True)

    def test_standalone_partial_with_missing_image_is_still_rejected(self):
        report = self.report('partial')
        report['criteria'][0]['after'] = 'runs/2/after/missing.png'
        self.save('tasks/T1/runs/2/report.json', report)
        with self.assertRaisesRegex(ValueError, 'missing screenshot'):
            self.page()

    def test_resumed_retest_rejects_report_from_previous_attempt(self):
        self.store.enqueue('T1', 'retest')
        first = self.store.start(self.sha)
        path = self.save('tasks/T1/evidence/partial.json', self.partial_report(first))
        with self.assertRaises(ValueError):
            self.store.complete(first['request_id'], self.result(first, report=path), self.sha)
        self.store.block(first['request_id'], first['attempt_id'], 'Retry capture')
        self.store.resume(first['request_id'])
        current = self.store.start(self.sha)
        with self.assertRaisesRegex(ValueError, 'report attempt_id'):
            self.store.complete(current['request_id'], self.result(current, report=path), self.sha)
        self.store.block(current['request_id'], current['attempt_id'], 'Stale report rejected')
        page = self.page()
        self.assertEqual(page['status'], 'pending')
        self.assertNotIn('summary', page)
        self.assertNotIn('before', page['criteria'][0])
        events = json.loads((self.state/'runtime/events.json').read_text())
        self.assertEqual(sum(e['kind'] == 'progress' for e in events), 1)
        self.assertFalse(any(e['kind'] == 'completed' for e in events))

    def test_retest_rejects_mismatched_identifiers_inside_report(self):
        self.store.enqueue('T1', 'retest')
        record = self.store.start(self.sha)
        after = self.state/'tasks/T1/runs/2/after/c1.png'
        after.parent.mkdir(parents=True, exist_ok=True)
        Image.new('RGB', (2, 2), 'white').save(after)
        for status in ('partial', 'pass', 'fail'):
            for key in ('task_id', 'request_id', 'attempt_id'):
                for value in ('another', None):
                    with self.subTest(status=status, key=key, value=value):
                        report = self.report(status, request_id=record['request_id'], attempt_id=record['attempt_id'])
                        report['criteria'][0]['after'] = 'runs/2/after/c1.png'
                        report[key] = value
                        path = self.save('tasks/T1/evidence/report.json', report)
                        with self.assertRaisesRegex(ValueError, f'report {key}'):
                            self.store.complete(record['request_id'], self.result(record, report=path), self.sha)
        events = json.loads((self.state/'runtime/events.json').read_text())
        self.assertFalse(any(e['kind'] in ('progress', 'completed') for e in events))

    def test_old_progress_with_stale_report_identifiers_is_not_displayed(self):
        self.store.enqueue('T1', 'retest')
        record = self.store.start(self.sha)
        for key in ('task_id', 'request_id', 'attempt_id'):
            with self.subTest(key=key):
                report = self.partial_report(record)
                report[key] = 'stale'
                path = self.save('tasks/T1/runs/2/report.json', report)
                # Recreate the inconsistent event that 7e55e54 could persist.
                with self.store.connect() as conn:
                    self.store.event(conn, record['request_id'], 'progress', {
                        'stage': 'RETEST', 'attempt_id': record['attempt_id'], 'head_sha': self.sha,
                        'evidence': {'report': {'path': path, 'sha256': hashlib.sha256((self.state/path).read_bytes()).hexdigest()}}})
                page = self.page()
                self.assertEqual(page['status'], 'pending')
                self.assertTrue(any('report' in warning for warning in page['warnings']))
                self.assertNotIn('summary', page)

    def test_bound_failed_report_remains_visible_during_council_attempt(self):
        self.store.enqueue('T1', 'retest')
        record = self.store.start(self.sha)
        report = self.report('fail', request_id=record['request_id'], attempt_id=record['attempt_id'])
        path = self.save('tasks/T1/evidence/report.json', report)
        self.store.complete(record['request_id'], self.result(record, report=path), self.sha)
        council = self.store.start(self.sha)
        self.assertNotEqual(record['attempt_id'], council['attempt_id'])
        page = self.page()
        self.assertEqual((page['status'], page['loop']['stage']), ('fail', 'COUNCIL'))

    def test_github_threads_and_local_review_are_merged_without_duplicates(self):
        self.store.enqueue('T1', 'pr')
        self.assertEqual(self.run_cycle(max_steps=1).returncode, 3)
        record = self.store.start(self.sha)
        local = {'body': 'Local finding', 'file': 'app.py', 'line': 1, 'severity': 'major'}
        github = {'body': 'GitHub finding', 'file': 'app.py', 'line': 2, 'severity': 'major',
                  'source': 'github', 'gh_thread_id': 'GH1', 'resolved': False}
        review = self.save('tasks/T1/evidence/review.json', {'completed': True, 'findings': [local]})
        threads = self.save('tasks/T1/evidence/threads.json',
                            [{**local, 'source': 'codex', 'id': 'local-1', 'resolved': False},
                             github, github, {**github, 'gh_thread_id': 'GH2'}])
        self.store.complete(record['request_id'], self.result(record, review=review, threads=threads), self.sha)
        page = self.page()
        self.assertEqual(page['loop']['stage'], 'COUNCIL')
        self.assertEqual(len(page['findings']), 3)
        self.assertEqual(sum(f['body'] == 'Local finding' for f in page['findings']), 1)
        self.assertEqual({f.get('gh_thread_id') for f in page['findings']}, {None, 'GH1', 'GH2'})
        # A new code version invalidates both local and GitHub review evidence.
        self.assertEqual(self.run_cycle(max_steps=2).returncode, 3)
        self.assertNotIn('findings', self.page())

    def test_github_only_finding_is_visible_with_an_empty_local_review(self):
        self.store.enqueue('T1', 'pr')
        self.assertEqual(self.run_cycle(max_steps=1).returncode, 3)
        record = self.store.start(self.sha)
        review = self.save('tasks/T1/review.json', {'completed': True, 'findings': []})
        threads = self.save('tasks/T1/threads.json', [
            {'body': 'Null dereference', 'source': 'github', 'gh_thread_id': 'GH1', 'resolved': False}])
        self.store.complete(record['request_id'], self.result(record, review=review, threads=threads), self.sha)
        self.assertEqual(self.page()['findings'][0]['gh_thread_id'], 'GH1')
