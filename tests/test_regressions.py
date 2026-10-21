import contextlib
import http.client
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def module(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


server = module('report_server', 'skills/sim-verify-task/scripts/report_server.py')
builder = module('build_report', 'skills/sim-verify-task/scripts/build_report.py')
collector = module('collect_threads', 'skills/close-threads/scripts/collect_threads.py')
argue = module('argue', 'skills/debate/scripts/argue.py')


class WorkspaceTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def write(self, relative, value):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value), encoding='utf-8')
        return path


class ReportServerTests(WorkspaceTest):
    def setUp(self):
        super().setUp()
        self.write('tasks/T1/task.json', {'id': 'T1', 'branch': 'feature'})
        (self.root / 'report.html').write_text("<script>const TOKEN = /*__TOKEN__*/'';</script>")
        self.write('state.json', {'secret': 'private'})
        shot = self.root / 'tasks/T1/runs/1/before/a.png'
        shot.parent.mkdir(parents=True)
        shot.write_bytes(b'png-fixture')
        self.httpd = server.make_server(self.root, 0)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop)

    def stop(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join()

    def request(self, method, path, body=None, headers=None, raw=None):
        headers = dict(headers or {})
        if body is not None:
            raw = json.dumps(body).encode()
            headers.setdefault('Content-Type', 'application/json')
        connection = http.client.HTTPConnection('127.0.0.1', self.httpd.server_address[1], timeout=3)
        connection.request(method, path, body=raw, headers=headers)
        response = connection.getresponse()
        result = response.status, dict(response.getheaders()), response.read()
        connection.close()
        return result

    def auth(self):
        return {'X-Devloop-Token': self.httpd.token}

    def test_all_reads_require_authentication(self):
        for path in ('/', '/queue', '/state.json', '/tasks/T1/report.html', '/tasks/T1/runs/1/before/a.png'):
            self.assertEqual(self.request('GET', path)[0], 403)
        self.assertEqual(self.request('HEAD', '/queue')[0], 403)

    def test_task_page_uses_authenticated_canonical_route(self):
        page = self.root / 'tasks/T1/report.html'
        page.write_text("<h1>T1</h1><script>const TOKEN = /*__TOKEN__*/'';</script>")
        code, headers, body = self.request('GET', '/tasks/T1/report.html?t=' + self.httpd.token)
        self.assertEqual(code, 200)
        self.assertIn(self.httpd.token.encode(), body)
        self.assertIn('HttpOnly', headers['Set-Cookie'])
        for path in ('/tasks/T1/report-page.json', '/tasks/T1/other.html', '/tasks/../report.html'):
            self.assertEqual(self.request('GET', path, headers=self.auth())[0], 404)
        with tempfile.TemporaryDirectory() as outer:
            private = Path(outer) / 'private.html'
            private.write_text('private')
            page.unlink()
            page.symlink_to(private)
            self.assertEqual(self.request('GET', '/tasks/T1/report.html', headers=self.auth())[0], 404)

    def test_cookie_images_and_private_file_allowlist(self):
        code, headers, body = self.request('GET', '/?t=' + self.httpd.token)
        self.assertEqual(code, 200)
        self.assertIn(self.httpd.token.encode(), body)
        cookie = {'Cookie': headers['Set-Cookie'].split(';')[0]}
        self.assertEqual(self.request('GET', '/tasks/T1/runs/1/before/a.png', headers=cookie)[0], 200)
        for path in ('/state.json', '/report.html', '/tasks/T1/task.json', '/queue/x.json'):
            self.assertEqual(self.request('GET', path, headers=cookie)[0], 404)

    def test_foreign_host_and_origin_rejected(self):
        for headers in ({'Host': 'evil.example'}, {'Origin': 'https://evil.example'}, {'Origin': 'https://127.0.0.1:' + str(self.httpd.server_address[1])}):
            self.assertEqual(self.request('GET', '/queue', headers={**self.auth(), **headers})[0], 403)
        self.assertEqual(self.request('POST', '/send', {'task_id': 'T1'}, {**self.auth(), 'Origin': 'null'})[0], 403)

    def test_unicode_and_malformed_tokens_fail_without_crash(self):
        self.assertEqual(self.request('GET', '/?t=%D1%82')[0], 403)
        self.assertEqual(self.request('GET', '/queue', headers={'X-Devloop-Token': '\xe9'})[0], 403)

    def test_traversal_and_external_symlink_not_served(self):
        with tempfile.TemporaryDirectory() as outer:
            secret = Path(outer) / 'outside.png'
            secret.write_bytes(b'secret')
            (self.root / 'tasks/T1/runs/1/before/link.png').symlink_to(secret)
            for path in ('/tasks/T1/runs/1/before/link.png', '/tasks/T1/runs/1/before/../../../../state.json', '/tasks/T1/runs/1/before/%2e%2e/state.png'):
                self.assertEqual(self.request('GET', path, headers=self.auth())[0], 404)

    def test_invalid_actions_and_body_types(self):
        for body in ([], {'task_id': 'T1', 'action': []}, {'task_id': '../T1'}, {'task_id': 'T1', 'comment': {}}, {'task_id': 'T1', 'comment': 'x'*4001}):
            self.assertEqual(self.request('POST', '/send', body, self.auth())[0], 400)
        self.assertEqual(self.request('POST', '/send', {'task_id': 'unknown'}, self.auth())[0], 404)
        self.assertEqual(self.request('POST', '/send', {'task_id': 'T1'})[0], 403)

    def test_request_size_and_content_type(self):
        self.assertEqual(self.request('POST', '/send', headers={**self.auth(), 'Content-Type': 'text/plain'}, raw=b'{}')[0], 415)
        self.assertEqual(self.request('POST', '/send', headers={**self.auth(), 'Content-Type': 'application/json'}, raw=b'x'*32769)[0], 413)
        self.assertEqual(self.request('POST', '/send', headers={**self.auth(), 'Content-Type': 'application/json'}, raw=b'{')[0], 400)

    def test_queue_unique_atomic_no_overwrite_and_no_manual_ack(self):
        body = {'task_id': 'T1', 'action': 'retest', 'comment': 'original'}
        self.assertEqual(self.request('POST', '/send', body, self.auth())[0], 200)
        paths = list((self.root/'queue').glob('*.json'))
        self.assertEqual(len(paths), 1)
        self.assertEqual(json.loads(paths[0].read_text())['action'], 'retest')
        self.assertEqual(self.request('POST', '/send', {**body, 'comment': 'replacement'}, self.auth())[0], 409)
        self.assertEqual(json.loads(paths[0].read_text())['comment'], 'original')
        taken = self.root/'queue/taken'
        taken.mkdir(exist_ok=True)
        claimed = taken/paths[0].name
        paths[0].rename(claimed)
        self.assertEqual(self.request('POST', '/send', body, self.auth())[0], 409)
        done = self.root/'queue/done'
        done.mkdir(exist_ok=True)
        claimed.rename(done/claimed.name)
        self.assertEqual(self.request('POST', '/send', body, self.auth())[0], 409)
        self.httpd.store.export()
        self.assertEqual(next((self.root/'queue').glob('*.json')).name, claimed.name)

    def test_unimplemented_actions_restricted(self):
        self.write('tasks/T1/task.json', {'id': 'T1'})
        for action in ('pr', 'retest'):
            self.assertEqual(self.request('POST', '/send', {'task_id': 'T1', 'action': action}, self.auth())[0], 409)
        self.assertEqual(self.request('POST', '/send', {'task_id': 'T1'}, self.auth())[0], 200)

    def test_wait_detects_preexisting_queue(self):
        self.write('queue/pending.json', {'task_id': 'T1', 'action': 'execute'})
        with server.make_server(self.root, 0) as other:
            self.assertTrue(other.done.is_set())


class ReportBuildTests(WorkspaceTest):
    def test_page_and_attachment_exist_before_first_run(self):
        self.write('tasks/T1/task.json', {'id': 'T1', 'title': 'First task', 'acceptance': ['Show the profile'],
                                        'source_url': 'https://github.com/example/app/issues/1'})
        self.write('tasks/T2/task.json', {'id': 'T2', 'title': 'Unrelated private task', 'acceptance': []})
        builder.build(self.root/'tasks', self.root/'report.html')
        page = (self.root/'tasks/T1/report.html').read_text()
        self.assertIn('Show the profile', page)
        self.assertIn('"verdict": "pending"', page)
        self.assertNotIn('Unrelated private task', page)
        attachment = json.loads((self.root/'tasks/T1/report-page.json').read_text())
        self.assertEqual(attachment['task_id'], 'T1')
        self.assertEqual(attachment['path'], 'report.html')
        self.assertEqual(attachment['source_url'], 'https://github.com/example/app/issues/1')
        self.assertEqual(attachment['kind'], 'local-html')
        self.assertIsNone(attachment['run'])
        task_file = self.root/'tasks/T1/task.json'
        task = json.loads(task_file.read_text())
        task['artifact_url'] = 'https://claude.ai/code/artifact/00000000-0000-0000-0000-000000000001'
        task_file.write_text(json.dumps(task))
        builder.build(self.root/'tasks', self.root/'report.html')
        rebuilt = json.loads((self.root/'tasks/T1/report-page.json').read_text())
        self.assertEqual(rebuilt['artifact_url'], task['artifact_url'])
        self.assertIn(task['artifact_url'], (self.root/'tasks/T1/report.html').read_text())

    def test_individual_page_embeds_images_and_updates_same_attachment(self):
        from PIL import Image
        self.report('runs/1/before/a.png')
        image = self.root/'tasks/T1/runs/1/before/a.png'
        image.parent.mkdir(parents=True)
        Image.new('RGB', (2, 2), 'red').save(image)
        builder.build(self.root/'tasks', self.root/'report.html')
        page = (self.root/'tasks/T1/report.html').read_text()
        self.assertIn('data:image/png;base64,', page)
        self.assertIn('runs/1/before/a.png', (self.root/'report.html').read_text())
        attachment = json.loads((self.root/'tasks/T1/report-page.json').read_text())
        self.write('tasks/T1/runs/2/report.json', {'criteria': [], 'title': 'Updated'})
        builder.build(self.root/'tasks', self.root/'report.html')
        updated = json.loads((self.root/'tasks/T1/report-page.json').read_text())
        self.assertEqual(updated['path'], attachment['path'])
        self.assertEqual(updated['run'], 2)
        self.assertNotEqual(updated['sha256'], attachment['sha256'])

    def test_task_links_reject_credentials_tokens_and_scripts(self):
        for url in ('javascript:alert(1)', 'https://user:secret@example.com/1', 'https://example.com/1?token=secret',
                    'http://localhost:8765/?t=secret', 'https://example.com/1#secret'):
            self.write('tasks/T1/task.json', {'id': 'T1', 'source_url': url})
            builder.build(self.root/'tasks', self.root/'report.html')
            self.assertNotIn('"source_url"', (self.root/'tasks/T1/report-page.json').read_text())
            self.assertNotIn(url, (self.root/'tasks/T1/report.html').read_text())

    def test_page_cannot_overwrite_external_symlink_target(self):
        self.write('tasks/T1/task.json', {'id': 'T1'})
        with tempfile.TemporaryDirectory() as outer:
            private = Path(outer)/'private.html'
            private.write_text('untouched')
            (self.root/'tasks/T1/report.html').symlink_to(private)
            with self.assertRaisesRegex(ValueError, 'symlink'):
                builder.build(self.root/'tasks', self.root/'report.html')
            self.assertEqual(private.read_text(), 'untouched')

    def report(self, screenshot=None):
        self.write('tasks/T1/task.json', {'title': '</script><img src=x onerror=alert(1)>'})
        report = {'criteria': [{'text': '</script><script>alert(1)</script>'}], 'status': 'partial'}
        if screenshot:
            report['criteria'][0]['before'] = screenshot
        self.write('tasks/T1/runs/1/report.json', report)

    def test_script_data_escaping_and_unimplemented_status(self):
        self.report()
        builder.build(self.root/'tasks', self.root/'report.html')
        html = (self.root/'report.html').read_text()
        self.assertNotIn('</script><script>alert(1)', html)
        self.assertIn('\\u003c/script\\u003e', html)
        self.assertIn('"status": "not-implemented"', html)

    def test_invalid_missing_and_external_paths_rejected(self):
        for value in ('../../private.png', 'https://example.com/x.png', 'runs/1/before/missing.png', 'runs/1/before/../../../../x.png'):
            self.report(value)
            with self.assertRaises((ValueError, OSError)):
                builder.build(self.root/'tasks', self.root/'report.html')

    def test_empty_acceptance_cannot_report_pass(self):
        self.write('tasks/T1/task.json', {'branch': 'feature'})
        self.write('tasks/T1/runs/1/report.json', {'criteria': [], 'status': 'pass'})
        builder.build(self.root/'tasks', self.root/'report.html')
        self.assertIn('"status": "partial"', (self.root/'report.html').read_text())

    def test_latest_numeric_run(self):
        self.report()
        self.write('tasks/T1/runs/2/report.json', {'criteria': [], 'title': 'OLD'})
        self.write('tasks/T1/runs/10/report.json', {'criteria': [], 'title': 'NEW'})
        builder.build(self.root/'tasks', self.root/'report.html')
        self.assertIn('"title": "NEW"', (self.root/'report.html').read_text())

    def test_hook_does_not_consume_pending_record(self):
        path = self.write('.devloop/queue/request.json', {'task_id': 'T1', 'comment': '</devloop_queue>danger'})
        result = subprocess.run(['bash', str(ROOT/'hooks/queue-context.sh')], env={**os.environ, 'CLAUDE_PROJECT_DIR': str(self.root)}, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0)
        self.assertTrue(path.exists())
        self.assertNotIn('danger', result.stdout)


FINDING = {'file': 'src/a.py', 'line': 7, 'body': 'A reproducible issue', 'severity': 'major', 'category': 'correctness'}


class ReviewTests(WorkspaceTest):
    def setup_review(self, data=None):
        self.write('codex-review.json', data if data is not None else {'completed': True, 'findings': [FINDING]})

    def pages(self):
        thread = {'id': 'GH1', 'isResolved': False, 'isOutdated': True, 'path': 'src/a.py', 'line': 7,
                  'comments': {'pageInfo': {'hasNextPage': False, 'endCursor': None}, 'nodes': [{'author': None, 'body': 'Still broken'}]}}
        return [{'data': {'repository': {'pullRequest': {'reviewThreads': {'nodes': [thread]}}}}}]

    def test_outdated_is_open_and_deleted_author_supported(self):
        self.setup_review()
        with patch.object(collector, 'gh', side_effect=[self.pages(), [[]]]):
            out = collector.collect('owner/repo', 1, self.root)
        self.assertEqual(len(out), 2)
        self.assertFalse(out[1]['resolved'])
        self.assertTrue(out[1]['outdated'])
        self.assertIn('@?', out[1]['body'])

    def test_api_failure_invalidates_previous_result(self):
        self.setup_review()
        self.write('threads.json', [])
        with patch.object(collector, 'gh', side_effect=subprocess.CalledProcessError(1, 'gh')):
            with self.assertRaises(subprocess.CalledProcessError):
                collector.collect('owner/repo', 1, self.root)
        self.assertFalse((self.root/'threads.json').exists())

    def test_text_review_never_means_no_findings(self):
        (self.root/'codex.log').write_text('Critical bug in a.py:7')
        with self.assertRaises(ValueError):
            collector.collect('owner/repo', 1, self.root)

    def test_json_array_and_pretty_jsonl_are_collected(self):
        self.write('agent-review.jsonl', [FINDING])
        with patch.object(collector, 'gh', side_effect=[self.pages(), [[]]]):
            out = collector.collect('owner/repo', 1, self.root)
        self.assertEqual(out[0]['body'], FINDING['body'])

    def test_invalid_incomplete_or_event_output_fails(self):
        for data in ({'completed': False, 'findings': []}, {'type': 'turn.completed'}, [dict(FINDING, severity='anything')], [dict(FINDING, line=-1)]):
            with self.assertRaises(ValueError):
                collector.normalize_findings(data)

    def test_explicit_empty_completed_review_valid(self):
        self.assertEqual(collector.normalize_findings({'completed': True, 'findings': []}), [])

    def test_extra_comment_pages_collected(self):
        self.setup_review()
        pages = self.pages()
        comments = pages[0]['data']['repository']['pullRequest']['reviewThreads']['nodes'][0]['comments']
        comments['pageInfo'] = {'hasNextPage': True, 'endCursor': 'cursor1'}
        more = [{'data': {'node': {'comments': {'nodes': [{'author': {'login': 'qa'}, 'body': 'Later evidence'}]}}}}]
        with patch.object(collector, 'gh', side_effect=[pages, more, [[]]]):
            out = collector.collect('owner/repo', 1, self.root)
        self.assertIn('Later evidence', out[1]['body'])

    def test_github_only_cli_collects_existing_pr_discussion_without_local_review(self):
        pages = self.pages()
        comments = pages[0]['data']['repository']['pullRequest']['reviewThreads']['nodes'][0]['comments']
        comments['pageInfo'] = {'hasNextPage': True, 'endCursor': 'cursor1'}
        more = [{'data': {'node': {'comments': {'nodes': [{'author': {'login': 'qa'}, 'body': 'Later evidence'}]}}}}]
        reviews = [[{'id': 9, 'state': 'CHANGES_REQUESTED', 'body': 'Handle server failure'}]]
        discussion = [
            [{'id': 10, 'body': 'Should this retry?', 'user': {'login': 'author'}, 'html_url': 'https://github.com/owner/repo/pull/2#issuecomment-10'}],
            [{'id': 11, 'body': 'Use the same retry policy', 'user': None}],
        ]
        with patch.object(collector, 'gh', side_effect=[pages, more, reviews, discussion]) as api:
            with patch.object(sys, 'argv', ['collect_threads.py', 'owner/repo', '2', str(self.root), '--github-only']):
                self.assertEqual(collector.main(), 0)
        saved = json.loads((self.root/'github-threads.json').read_text())
        self.assertEqual({x['id'] for x in saved}, {'GH1', 'github-review-9', 'github-comment-10', 'github-comment-11'})
        self.assertTrue(all(x['source'] == 'github' for x in saved))
        self.assertIn('Later evidence', saved[0]['body'])
        self.assertTrue(saved[0]['outdated'])
        self.assertFalse(saved[0]['resolved'])
        self.assertEqual(api.call_args.args, ('repos/owner/repo/issues/2/comments', '--paginate', '--slurp'))
        self.assertFalse((self.root/'threads.json').exists())
        # Discussion alone cannot masquerade as a completed independent review.
        with patch.object(collector, 'gh') as api:
            with self.assertRaisesRegex(ValueError, 'no structured local review'):
                collector.collect('owner/repo', 2, self.root)
            api.assert_not_called()

    def test_github_only_ignores_local_review_and_preserves_full_review_output(self):
        (self.root/'codex-review.json').write_text('unfinished local review')
        original = self.write('threads.json', [FINDING]).read_bytes()
        with patch.object(collector, 'gh', side_effect=[self.pages(), [[]], [[]]]):
            out = collector.collect('owner/repo', 2, self.root, github_only=True)
        self.assertEqual([x['id'] for x in out], ['GH1'])
        self.assertEqual((self.root/'threads.json').read_bytes(), original)

    def test_failed_discussion_refresh_invalidates_only_discussion_evidence(self):
        self.write('github-threads.json', [])
        original = self.write('threads.json', [FINDING]).read_bytes()
        with patch.object(collector, 'gh', side_effect=[self.pages(), [[]], subprocess.CalledProcessError(1, 'gh')]):
            with self.assertRaises(subprocess.CalledProcessError):
                collector.collect('owner/repo', 2, self.root, github_only=True)
        self.assertFalse((self.root/'github-threads.json').exists())
        self.assertEqual((self.root/'threads.json').read_bytes(), original)


class CouncilTests(WorkspaceTest):
    def round(self, n, moves, options=None, role='qa'):
        self.write(f'round_{n}/{role}.json', {'role': role, 'round': n, 'moves': moves, 'options': options or {'A': .5, 'B': .5}})

    def run_round(self, n, success=True):
        result = subprocess.run([sys.executable, str(ROOT/'skills/debate/scripts/argue.py'), str(self.root), '--round', str(n)], capture_output=True, text=True)
        if not success:
            self.assertNotEqual(result.returncode, 0)
            return
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads((self.root/f'state_{n}.json').read_text())

    def claim(self):
        return {'id': 'qa.1', 'type': 'claim', 'text': 'Testable claim', 'p': .8, 'evidence': ['a.py:7']}

    def test_equal_votes_have_no_arbitrary_winner(self):
        self.round(1, [self.claim()])
        state = self.run_round(1)
        self.assertTrue(state['tie'])
        self.assertIsNone(state['decision'])
        self.assertEqual(state['option_scores']['A'], state['option_scores']['B'])

    def test_retracted_claim_disappears_and_not_converged(self):
        self.round(1, [self.claim()])
        self.run_round(1)
        self.round(2, [{'id': 'qa.1', 'p': 0}])
        state = self.run_round(2)
        self.assertNotIn('qa.1', state['grounded'])
        self.assertNotIn('qa.1', state['claim_probs'])
        self.assertFalse(state['converged'])

    def test_option_change_prevents_false_convergence(self):
        self.round(1, [self.claim()], {'A': .9, 'B': .1})
        self.run_round(1)
        self.round(2, [], {'A': .1, 'B': .9})
        self.assertFalse(self.run_round(2)['converged'])

    def test_stable_round_converges_and_rerun_is_idempotent(self):
        self.round(1, [self.claim()])
        self.run_round(1)
        self.round(2, [])
        state = self.run_round(2)
        self.assertTrue(state['converged'])
        self.assertEqual(state, self.run_round(2))

    def test_nonfinite_probability_and_invalid_votes_rejected(self):
        self.round(1, [dict(self.claim(), p=float('nan'))])
        self.run_round(1, False)
        self.round(1, [self.claim()], {'A': 2, 'B': -1})
        self.run_round(1, False)

    def test_missing_round_and_cross_role_id_rejected(self):
        self.run_round(1, False)
        self.round(1, [dict(self.claim(), id='perf.1')])
        self.run_round(1, False)

    def test_sigmoid_handles_large_opposing_evidence(self):
        self.assertEqual(argue.sigm(-10000), 0)
        self.assertEqual(argue.sigm(10000), 1)


class SimulatorTests(WorkspaceTest):
    def test_missing_arguments_fail_before_device_command(self):
        for arguments in (['tap', '1'], ['shot'], ['open'], ['install']):
            result = subprocess.run(['bash', str(ROOT/'skills/sim-verify-task/scripts/sim.sh'), *arguments], env={**os.environ, 'SIM_PLATFORM': 'ios', 'SIM_DEVICE': 'test'}, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('usage:', result.stderr)

    def test_detect_prefers_emulator_over_connected_phone(self):
        xcrun = self.root/'xcrun'
        xcrun.write_text('#!/bin/sh\nexit 1\n')
        xcrun.chmod(0o755)
        adb = self.root/'adb'
        adb.write_text('#!/bin/sh\nprintf "List of devices attached\\nUSB-PHONE device\\nemulator-5554 device\\n"\n')
        adb.chmod(0o755)
        result = subprocess.run(['bash', str(ROOT/'skills/sim-verify-task/scripts/sim.sh'), 'detect'], env={**os.environ, 'PATH': str(self.root)+os.pathsep+os.environ['PATH']}, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), 'android emulator-5554')

    def test_log_failure_propagates_and_never_clears_device_buffer(self):
        adb = self.root/'adb'
        adb.write_text('#!/bin/sh\nprintf "%s\\n" "$*" >> "$CALLS"\nexit 9\n')
        adb.chmod(0o755)
        calls = self.root/'calls'
        result = subprocess.run(['bash', str(ROOT/'skills/sim-verify-task/scripts/sim.sh'), 'log', str(self.root/'log'), 'app'], cwd=self.root, env={**os.environ, 'PATH': str(self.root)+os.pathsep+os.environ['PATH'], 'CALLS': str(calls), 'SIM_PLATFORM': 'android', 'SIM_DEVICE': 'emulator'}, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('logcat -c', calls.read_text())


if __name__ == '__main__':
    unittest.main()
