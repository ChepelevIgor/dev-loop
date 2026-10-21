import concurrent.futures
import hashlib
import json
import threading
import time

from test_regressions import WorkspaceTest, builder, module
import test_regressions as regression

bridge_module = module('artifact_test', 'skills/sim-verify-task/scripts/artifact_bridge.py')
URL = 'https://claude.ai/code/artifact/00000000-0000-0000-0000-000000000001'


class ArtifactBridgeTests(WorkspaceTest):
    def setUp(self):
        super().setUp()
        self.write('tasks/T1/task.json', {'id': 'T1', 'title': 'Selected task', 'acceptance': ['Preserve evidence']})
        self.write('tasks/T2/task.json', {'id': 'T2', 'title': 'Unrelated private task'})
        builder.build(self.root/'tasks', self.root/'report.html')
        self.bridge = bridge_module.Bridge(self.root)

    def listener(self):
        result = []
        thread = threading.Thread(target=lambda: result.append(self.bridge.listen(2)))
        thread.start()
        self.addCleanup(thread.join)
        deadline = time.monotonic() + 1
        while not self.bridge.status('T1')['available']:
            if time.monotonic() > deadline:
                self.fail('listener did not start')
            time.sleep(.01)
        return thread, result

    def claim(self):
        thread, result = self.listener()
        request = self.bridge.request('T1')
        thread.join(3)
        self.assertEqual(result[0]['id'], request['id'])
        return result[0]

    def test_no_listener_does_not_claim_to_publish(self):
        with self.assertRaisesRegex(ValueError, 'No Claude session'):
            self.bridge.request('T1')
        self.assertNotIn('status', self.bridge.status('T1'))

    def test_full_local_handoff_and_stable_link(self):
        request = self.claim()
        source = self.bridge.store.path('runtime/artifact-' + request['id'] + '.html').read_bytes()
        self.assertEqual(hashlib.sha256(source).hexdigest(), request['source_sha256'])
        self.assertIn(b'Preserve evidence', source)
        self.assertNotIn(b'Unrelated private task', source)
        self.assertIn(b"/*__TOKEN__*/'', true", source)
        self.assertFalse(self.bridge.status('T1')['available'])
        # An unrelated broken report must not block recording this task's publish.
        (self.root/'tasks/T2/task.json').write_text('invalid unrelated JSON')
        self.bridge.complete(request['id'], URL)
        self.bridge.complete(request['id'], URL)  # recording can be safely retried
        state = self.bridge.status('T1')
        self.assertEqual(state['status'], 'published')
        self.assertEqual(state['artifact_url'], URL)
        association = json.loads((self.root/'tasks/T1/report-page.json').read_text())
        self.assertEqual(association['artifact_url'], URL)
        self.assertIn(URL, (self.root/'tasks/T1/report.html').read_text())
        update = self.claim()
        self.assertEqual(update['previous_url'], URL)
        with self.assertRaisesRegex(ValueError, 'preserve its URL'):
            self.bridge.complete(update['id'], URL[:-1]+'2')
        self.bridge.complete(update['id'], URL)

    def test_duplicate_clicks_and_restart_do_not_republish(self):
        self.listener()
        with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
            results = list(pool.map(lambda _: self.bridge.request('T1'), range(5)))
        self.assertEqual(len({r['id'] for r in results}), 1)
        restarted = bridge_module.Bridge(self.root)
        self.assertEqual(restarted.request('T1')['id'], results[0]['id'])

    def test_uncertain_claim_is_not_retried_and_error_is_explicit(self):
        request = self.claim()
        self.assertEqual(self.bridge.request('T1')['id'], request['id'])
        self.bridge.fail(request['id'], 'Native artifact capability is unavailable')
        self.assertEqual(self.bridge.status('T1')['status'], 'failed')
        with self.assertRaisesRegex(ValueError, 'No Claude session'):
            self.bridge.request('T1')

    def test_url_validation_and_source_integrity(self):
        request = self.claim()
        for url in ('https://evil.example/artifact/1', URL+'?token=secret', URL.replace('claude.ai', 'claude.ai.evil.test'), URL.replace('https://', 'https://user:secret@')):
            with self.assertRaises(ValueError):
                self.bridge.complete(request['id'], url)
        self.bridge.store.path('runtime/artifact-'+request['id']+'.html').write_text('changed')
        with self.assertRaisesRegex(ValueError, 'source changed'):
            self.bridge.complete(request['id'], URL)
        self.assertNotIn('artifact_url', json.loads((self.root/'tasks/T1/task.json').read_text()))

    def test_listener_timeout_and_concurrency(self):
        thread, result = self.listener()
        with self.assertRaisesRegex(ValueError, 'another artifact listener'):
            self.bridge.listen(1)
        thread.join(3)
        self.assertIsNone(result[0])
        self.assertFalse(self.bridge.status('T1')['available'])

    def test_symlink_page_and_task_id_rejected(self):
        page = self.root/'tasks/T1/report.html'
        page.unlink()
        page.symlink_to(self.root/'tasks/T2/report.html')
        with self.assertRaisesRegex(ValueError, 'symlink'):
            self.bridge.request('T1')
        with self.assertRaises(ValueError):
            self.bridge.status('../T2')


class ArtifactHTTPTests(WorkspaceTest):
    request = regression.ReportServerTests.request
    auth = regression.ReportServerTests.auth
    stop = regression.ReportServerTests.stop

    def setUp(self):
        super().setUp()
        self.write('tasks/T1/task.json', {'id': 'T1'})
        self.httpd = regression.server.make_server(self.root, 0)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop)

    def test_artifact_endpoint_authentication_and_availability(self):
        builder.build(self.root/'tasks', self.root/'report.html')
        self.assertEqual(self.request('GET', '/artifact?task_id=T1')[0], 403)
        self.assertEqual(self.request('POST', '/artifact', {'task_id': 'T1'})[0], 403)
        self.assertEqual(self.request('POST', '/artifact', {'task_id': 'T1'}, {**self.auth(), 'Origin': 'https://evil.example'})[0], 403)
        self.assertEqual(self.request('POST', '/artifact', {'task_id': 'T1'}, self.auth())[0], 409)
        status, _, data = self.request('GET', '/artifact?task_id=T1', headers=self.auth())
        self.assertEqual(status, 200)
        self.assertFalse(json.loads(data)['available'])
        self.assertEqual(self.request('GET', '/artifact?task_id=../T1', headers=self.auth())[0], 404)
