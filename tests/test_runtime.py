import concurrent.futures
import contextlib
import http.client
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
import time
from unittest.mock import patch

from test_regressions import ROOT, WorkspaceTest, server, builder
sys.path.insert(0, str(ROOT/'skills/start-task/scripts'))
from runtime import Conflict, Store, git_head
import devloop

CLI = ROOT/'skills/start-task/scripts/devloop.py'
WORKER = ROOT/'tests/fixtures/stage_worker.py'


class Loop(WorkspaceTest):
    def setUp(self):
        super().setUp()
        subprocess.run(['git', 'init', '-q', str(self.root)], check=True)
        (self.root/'app.txt').write_text('fixture')
        subprocess.run(['git', '-C', str(self.root), 'add', 'app.txt'], check=True)
        subprocess.run(['git', '-C', str(self.root), '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture'], check=True)
        subprocess.run(['git', '-C', str(self.root), 'checkout', '-qb', 'fixture'], check=True)
        self.state = self.root/'.devloop'
        self.store = Store(self.state)
        self.sha = git_head(self.root)
        self.task('T1')
        self.config = self.state/'workers.json'
        self.config.write_text(json.dumps({'stages': {stage:{'argv':[sys.executable,str(WORKER)],'timeout':10} for stage in devloop.STAGES}}))

    def task(self, name, scenario='normal'):
        path = self.state/'tasks'/name/'task.json'
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({'id':name,'branch':'fixture','base_sha':self.sha,'acceptance':['The screen works'],'scenario':scenario}))

    def run_cycle(self, max_steps=32):
        return subprocess.run([sys.executable,str(CLI),'--root',str(self.state),'run','--config',str(self.config),'--max-steps',str(max_steps)], capture_output=True, text=True, timeout=30)

    def at_execute(self):
        """Run the business review, the technical solution and the QA cases; the next stage is the code."""
        record = self.store.enqueue('T1')
        self.assertEqual(self.run_cycle(max_steps=3).returncode,3)
        self.assertEqual(self.store.get(record['request_id'])['stage'],'EXECUTE')
        return self.store.start(self.sha)


class RuntimeTests(Loop):
    def test_full_execute_cycle_and_evidence_journal(self):
        record = self.store.enqueue('T1')
        result = self.run_cycle()
        self.assertEqual(result.returncode, 0, result.stderr)
        state = self.store.get(record['request_id'])
        self.assertEqual((state['status'],state['stage']), ('done','DONE'))
        self.assertTrue((self.state/'queue/done'/f"{record['request_id']}.json").exists())
        events = json.loads((self.state/'runtime/events.json').read_text())
        completed = [e for e in events if e['kind']=='completed']
        self.assertEqual([e['detail']['from'] for e in completed], ['BRIEF','PLAN','QA','EXECUTE','REVIEW','RETEST'])
        self.assertTrue(all(e['detail']['evidence'] for e in completed))

    def test_retest_and_pr_route_before_execute(self):
        for action, expected in [('retest',['RETEST']),('pr',['PR','REVIEW','RETEST'])]:
            record = self.store.enqueue('T1', action)
            result = self.run_cycle()
            self.assertEqual(result.returncode, 0, result.stderr)
            events = json.loads((self.state/'runtime/events.json').read_text())
            self.assertEqual([e['detail']['from'] for e in events if e['request_id']==record['request_id'] and e['kind']=='completed'],expected)

    def test_findings_trigger_fix_and_repeat_review(self):
        self.task('T1','review_once')
        record = self.store.enqueue('T1')
        result = self.run_cycle()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.store.get(record['request_id'])['rounds'],1)

    def test_three_failed_rounds_block_without_done(self):
        self.task('T1','fail_forever')
        record = self.store.enqueue('T1','retest')
        result = self.run_cycle()
        self.assertEqual(result.returncode,2,result.stderr)
        current = self.store.get(record['request_id'])
        self.assertEqual(current['status'],'blocked')
        self.assertEqual(current['rounds'],3)
        self.assertFalse(list((self.state/'queue/done').glob('*.json')))
        with self.assertRaises(Conflict): self.store.resume(record['request_id'])

    def test_empty_criteria_never_pass(self):
        self.task('T1','empty_criteria')
        record = self.store.enqueue('T1','retest')
        self.assertEqual(self.run_cycle().returncode,2)
        self.assertEqual(self.store.get(record['request_id'])['status'],'blocked')

    def test_database_survives_projection_crash(self):
        with patch.object(self.store,'export',side_effect=OSError('power failure')):
            with self.assertRaises(OSError): self.store.enqueue('T1')
        self.assertEqual(len(self.store.snapshot()),1)
        self.assertFalse(list((self.state/'queue').glob('*.json')))
        with self.store.consumer(): self.store.recover()
        self.assertEqual(len(list((self.state/'queue').glob('*.json'))),1)
        with self.assertRaises(Conflict): self.store.enqueue('T1')

    def test_recovery_blocks_interrupted_pr_until_explicit_resume(self):
        record = self.store.enqueue('T1','pr')
        with self.store.consumer(): self.store.start(self.sha)
        with self.store.consumer(): self.store.recover()
        current = self.store.get(record['request_id'])
        self.assertEqual((current['stage'],current['status']),('PR','blocked'))
        self.assertEqual(self.run_cycle().returncode,2)
        self.store.resume(record['request_id'])
        self.assertEqual(self.run_cycle().returncode,0)

    def test_parallel_enqueue_has_one_winner(self):
        def submit(_):
            try: return Store(self.state).enqueue('T1')['request_id']
            except Conflict: return None
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            winners = [r for r in pool.map(submit,range(6)) if r]
        self.assertEqual(len(winners),1)
        self.assertEqual(len(self.store.snapshot()),1)

    def test_second_consumer_is_rejected(self):
        with self.store.consumer():
            result = subprocess.run([sys.executable,str(CLI),'--root',str(self.state),'recover'],capture_output=True,text=True)
        self.assertEqual(result.returncode,2)
        self.assertIn('another consumer',result.stderr)

    def test_forged_or_stale_result_cannot_ack(self):
        self.store.enqueue('T1')
        record = self.store.start(self.sha)
        forged = {**record,'attempt_id':'wrong','completed':True,'artifacts':{}}
        with self.assertRaises(ValueError): self.store.complete(record['request_id'],forged,self.sha)
        self.assertEqual(self.store.get(record['request_id'])['status'],'running')

    def evidence_result(self, record, key, value):
        relative = f"tasks/T1/{key}.json"
        (self.state/relative).write_text(json.dumps(value))
        return {**{k:record[k] for k in ('request_id','attempt_id','stage','head_sha')},
                'completed':True,'artifacts':{key:relative}}

    def test_failed_or_stale_checks_cannot_advance_to_review(self):
        record = self.at_execute()
        for check in ({'passed':False,'head_sha':self.sha,'commands':[{'argv':['test'],'exit_code':1}]},
                      {'passed':True,'head_sha':'old','commands':[{'argv':['test'],'exit_code':0}]},
                      {'passed':True,'head_sha':self.sha,'commands':[]},
                      {'passed':True,'head_sha':self.sha,'commands':[{'argv':['test'],'exit_code':1}]}):
            result = self.evidence_result(record,'checks',check)
            with self.assertRaisesRegex(ValueError,'successful checks'):
                self.store.complete(record['request_id'],result,self.sha)
        self.assertEqual(self.store.get(record['request_id'])['stage'],'EXECUTE')

    def test_read_only_stage_cannot_complete_after_head_changes(self):
        self.store.enqueue('T1','pr')
        record = self.store.start(self.sha)
        result = self.evidence_result(record,'pr',{'number':1,'url':'https://example.test/pr/1','head_sha':'new'})
        result['head_sha']='new'
        with self.assertRaisesRegex(ValueError,'HEAD changed'):
            self.store.complete(record['request_id'],result,'new')

    def test_truncated_screenshot_cannot_complete_retest(self):
        self.store.enqueue('T1','retest')
        record = self.store.start(self.sha)
        image = self.state/'tasks/T1/runs/1/after/c1.png'
        image.parent.mkdir(parents=True)
        image.write_bytes(b'\x89PNG\r\n\x1a\n')
        report = {'head_sha':self.sha,'status':'pass','criteria':[{'text':'The screen works','verdict':'pass','after':'runs/1/after/c1.png'}]}
        result = self.evidence_result(record,'report',report)
        with self.assertRaises((ValueError,OSError)):
            self.store.complete(record['request_id'],result,self.sha)
        self.assertEqual(self.store.get(record['request_id'])['status'],'running')

    def test_cross_task_or_outside_evidence_cannot_complete(self):
        record = self.at_execute()
        result = self.evidence_result(record,'checks',{'passed':True,'head_sha':self.sha,'commands':[{'argv':['test'],'exit_code':0}]})
        for path in ('tasks/T2/checks.json','tasks/T1/../../outside.json'):
            result['artifacts']['checks']=path
            with self.assertRaises(ValueError): self.store.complete(record['request_id'],result,self.sha)

    def test_retest_journal_contains_image_digest(self):
        import hashlib
        self.store.enqueue('T1','retest')
        self.assertEqual(self.run_cycle().returncode,0)
        events=json.loads((self.state/'runtime/events.json').read_text())
        evidence=next(e['detail']['evidence'] for e in events if e['kind']=='completed')
        saved=evidence['screenshot:runs/1/after/c1.png']
        self.assertEqual(saved['sha256'],hashlib.sha256((self.state/saved['path']).read_bytes()).hexdigest())

    def test_missing_worker_blocks(self):
        self.config.write_text('{"stages":{}}')
        record = self.store.enqueue('T1')
        self.assertEqual(self.run_cycle().returncode,2)
        self.assertIn('no configured worker',self.store.get(record['request_id'])['last_error'])

    def test_worker_timeout_blocks(self):
        stages = json.loads(self.config.read_text())['stages']
        stages['EXECUTE'] = {'argv':[sys.executable,'-c','import time;time.sleep(5)'],'timeout':.1}
        self.config.write_text(json.dumps({'stages':stages}))
        record = self.store.enqueue('T1')
        self.assertEqual(self.run_cycle().returncode,2)
        self.assertIn('timed out',self.store.get(record['request_id'])['last_error'])

    def test_step_budget_is_persistent_and_resumable(self):
        record = self.store.enqueue('T1')
        self.assertEqual(self.run_cycle(max_steps=1).returncode,3)
        self.assertEqual(self.store.get(record['request_id'])['stage'],'PLAN')
        self.assertEqual(self.run_cycle().returncode,0)

    def test_manual_json_move_does_not_forge_completion(self):
        record = self.store.enqueue('T1','retest')
        source = self.state/'queue'/f"{record['request_id']}.json"
        source.rename(self.state/'queue/done'/source.name)
        self.store.export()
        self.assertTrue(source.exists())
        self.assertEqual(self.store.get(record['request_id'])['status'],'queued')

    def test_shell_text_in_comment_is_data(self):
        marker = self.root/'pwned'
        self.store.enqueue('T1','retest',f'$(touch {marker}); `touch {marker}`')
        self.assertEqual(self.run_cycle().returncode,0)
        self.assertFalse(marker.exists())

    def test_http_enqueue_to_runner_to_done(self):
        (self.state/'report.html').write_text('fixture')
        httpd = server.make_server(self.state,0)
        thread = threading.Thread(target=httpd.serve_forever,daemon=True)
        thread.start()
        try:
            connection = http.client.HTTPConnection('127.0.0.1',httpd.server_address[1],timeout=3)
            headers={'X-Devloop-Token':httpd.token,'Content-Type':'application/json'}
            connection.request('POST','/send',json.dumps({'task_id':'T1','action':'retest'}),headers)
            response=connection.getresponse();record=json.loads(response.read());connection.close()
            self.assertEqual(response.status,200)
            self.assertEqual(self.run_cycle().returncode,0)
            self.assertEqual(httpd.store.get(record['request_id'])['status'],'done')
        finally:
            httpd.shutdown();httpd.server_close();thread.join()

    def test_second_server_cannot_enqueue_duplicate(self):
        (self.state/'report.html').write_text('fixture')
        with server.make_server(self.state,0) as first, server.make_server(self.state,0) as second:
            first.store.enqueue('T1')
            with self.assertRaises(Conflict): second.store.enqueue('T1')
            self.assertNotEqual(first.cookie_name,second.cookie_name)

    def test_symlink_queue_rejected(self):
        other = self.root/'outside'
        other.mkdir()
        (self.state/'queue/link').symlink_to(other,target_is_directory=True)
        with self.assertRaises(ValueError): self.store.path('queue/link/x.json')

    def test_dirty_project_stops_before_worker(self):
        (self.root/'app.txt').write_text('uncommitted')
        self.store.enqueue('T1')
        result = self.run_cycle()
        self.assertEqual(result.returncode,2)
        self.assertIn('uncommitted',result.stderr)
        self.assertEqual(self.store.snapshot()[0]['status'],'queued')


class LoopTests(Loop):
    """The stages before the code and the Dev Loop button: business review, technical solution, QA, local review."""

    def page(self):
        builder.build(self.state/'tasks', self.state/'report.html')
        html = (self.state/'tasks/T1/report.html').read_text()
        return json.loads(html.rsplit('const APP = startReport(', 1)[1].split(', /*__TOKEN__*/', 1)[0])[0]

    def result(self, record, key, value, name=None):
        relative = f"tasks/T1/{name or key + '.json'}"
        (self.state/relative).write_text(value if isinstance(value, str) else json.dumps(value))
        return {**{k:record[k] for k in ('request_id','attempt_id','stage','head_sha')}, 'completed':True, 'artifacts':{key:relative}}

    def brief(self, **change):
        value = {'metric':'Onboarding completion','summary':'The screen works for the user.','dod':['The screen works'],
                 'cases':[{'text':'The screen works','given':'a user','when':'they open it','then':'it works'}],'gaps':[],'base_sha':self.sha}
        value.update(change)
        return value

    def test_business_review_rules(self):
        self.store.enqueue('T1')
        record = self.store.start(self.sha)
        self.assertEqual(record['stage'],'BRIEF')
        bad = [({'metric':None},'product gap'),
               ({'cases':[{'text':'Other','given':'a','when':'b','then':'c'}]},'exactly the task acceptance'),
               ({'cases':[{'text':'The screen works','given':'a','when':'','then':'c'}]},'Given / When / Then'),
               ({'dod':[]},'Definition of Done'),
               ({'base_sha':'0'*40},'base commit'),
               ({'gaps':[{'kind':'product','text':'x'}]},'blocking true/false')]
        for change, message in bad:
            with self.assertRaisesRegex(ValueError, message):
                self.store.complete(record['request_id'], self.result(record,'brief',self.brief(**change)), self.sha)
        ok = self.brief(metric=None, gaps=[{'kind':'product','text':'Which metric?','blocking':False}])
        self.assertEqual(self.store.complete(record['request_id'], self.result(record,'brief',ok), self.sha)['stage'],'PLAN')

    def test_blocking_question_waits_and_the_answer_continues(self):
        self.task('T1','brief_blocks')
        record = self.store.enqueue('T1')
        self.assertEqual(self.run_cycle().returncode,2)
        waiting = self.store.get(record['request_id'])
        self.assertEqual((waiting['stage'],waiting['status']),('BRIEF','blocked'))
        self.assertIn('Which plan gets the feature?',waiting['last_error'])
        # the page's Dev Loop button on a blocked request: the comment is the answer, the same request continues
        answered = self.store.request('T1','execute','Only the paid plan')
        self.assertEqual((answered['request_id'],answered['status'],answered['comment']),(record['request_id'],'ready','Only the paid plan'))
        self.assertEqual(self.run_cycle().returncode,0)
        self.assertEqual(self.store.get(record['request_id'])['status'],'done')
        # after DONE the button starts a new loop with the new comment
        again = self.store.request('T1','execute','Make the title bigger')
        self.assertNotEqual(again['request_id'],record['request_id'])
        self.assertEqual((again['stage'],again['comment']),('BRIEF','Make the title bigger'))
        with self.assertRaisesRegex(Conflict,'in progress'): self.store.request('T1','execute','twice')

    def test_qa_must_cover_every_criterion(self):
        self.task('T1','qa_gap')
        record = self.store.enqueue('T1')
        self.assertEqual(self.run_cycle().returncode,2)
        current = self.store.get(record['request_id'])
        self.assertEqual((current['stage'],current['status']),('QA','blocked'))
        self.assertIn('acceptance criterion',current['last_error'])

    def test_plan_is_a_real_document(self):
        self.store.enqueue('T1')
        self.assertEqual(self.run_cycle(max_steps=1).returncode,3)
        record = self.store.start(self.sha)
        self.assertEqual(record['stage'],'PLAN')
        with self.assertRaisesRegex(ValueError,'too short'):
            self.store.complete(record['request_id'], self.result(record,'plan','# Plan\nDo it.', 'plan.md'), self.sha)

    def test_code_goes_on_the_task_branch_and_review_needs_no_pr(self):
        record = self.at_execute()
        subprocess.run(['git','-C',str(self.root),'checkout','-q','-B','main'],check=True)
        checks = {'passed':True,'head_sha':self.sha,'commands':[{'argv':['test'],'exit_code':0}]}
        with self.assertRaisesRegex(ValueError,'own branch'):
            self.store.complete(record['request_id'], self.result(record,'checks',checks), self.sha)
        subprocess.run(['git','-C',str(self.root),'checkout','-q','fixture'],check=True)
        moved = self.store.complete(record['request_id'], self.result(record,'checks',checks), self.sha)
        self.assertEqual(moved['stage'],'REVIEW', 'the code goes to review, not to a PR')
        review = self.store.start(self.sha)
        finding = {'body':'Null name is saved','severity':'major'}
        result = self.result(review,'review',{'completed':True,'findings':[finding]})
        (self.state/'tasks/T1/threads.json').write_text(json.dumps([{**finding,'resolved':False}]))
        result['artifacts']['threads'] = 'tasks/T1/threads.json'
        self.assertEqual(self.store.complete(review['request_id'], result, self.sha)['stage'],'COUNCIL')

    def test_page_button_answers_a_blocked_request_over_http(self):
        self.task('T1','brief_blocks')
        record = self.store.enqueue('T1')
        self.assertEqual(self.run_cycle().returncode,2)
        (self.state/'report.html').write_text('fixture')
        httpd = server.make_server(self.state,0)
        thread = threading.Thread(target=httpd.serve_forever,daemon=True)
        thread.start()
        try:
            connection = http.client.HTTPConnection('127.0.0.1',httpd.server_address[1],timeout=3)
            headers={'X-Devloop-Token':httpd.token,'Content-Type':'application/json'}
            connection.request('POST','/send',json.dumps({'task_id':'T1','comment':'Only the paid plan'}),headers)
            response=connection.getresponse();body=json.loads(response.read());connection.close()
            self.assertEqual((response.status,body['request_id'],body['stage']),(200,record['request_id'],'BRIEF'))
            connection = http.client.HTTPConnection('127.0.0.1',httpd.server_address[1],timeout=3)
            connection.request('POST','/send',json.dumps({'task_id':'T1','comment':'again'}),headers)
            self.assertEqual(connection.getresponse().status,409)
            connection.close()
        finally:
            httpd.shutdown();httpd.server_close();thread.join()

    def test_report_shows_the_stages_and_where_the_loop_waits(self):
        self.task('T1','brief_blocks')
        self.store.enqueue('T1')
        self.assertEqual(self.run_cycle().returncode,2)
        task = self.state/'tasks/T1'
        (task/'brief.json').write_text(json.dumps(self.brief(metric='Unrecorded metric')))
        (task/'plan.md').write_text('# Unrecorded technical solution')
        (task/'qa.json').write_text(json.dumps({'author':'codex','independent':True,'cases':[]}))
        script = ROOT/'skills/sim-verify-task/scripts/build_report.py'
        result = subprocess.run([sys.executable,str(script),str(self.state/'tasks'),'--out',str(self.state/'report.html')],capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stderr)
        page = (task/'report.html').read_text()
        for part in ('"metric": "Onboarding completion"','"status": "blocked"','Which plan gets the feature?'):
            self.assertIn(part, page)
        for part in ('Unrecorded metric', 'Unrecorded technical solution', '"author": "codex"'):
            self.assertNotIn(part, page)

    def test_report_loads_completed_stages_from_recorded_nested_paths(self):
        request = self.store.enqueue('T1')
        self.assertEqual(self.run_cycle(max_steps=3).returncode, 3)
        page = self.page()
        self.assertEqual(page['brief']['cases'][0]['text'], 'The screen works')
        self.assertIn('Change the fixture screen', page['plan'])
        self.assertEqual(page['qa']['author'], 'fixture')
        self.assertEqual(page['loop']['request_id'], request['request_id'])
        self.assertEqual(page['status'], 'pending')
        self.assertEqual(self.run_cycle().returncode, 0)
        page = self.page()
        self.assertEqual(page['status'], 'pass')
        self.assertEqual(page['loop']['status'], 'done')
        self.assertTrue(page['criteria'][0]['after'].startswith('data:image/png;base64,'))

    def test_new_loop_does_not_reuse_previous_stages_or_success(self):
        first = self.store.enqueue('T1')
        self.assertEqual(self.run_cycle().returncode, 0)
        previous = self.page()
        self.assertEqual(previous['status'], 'pass')
        # Leave the canonical files and a numeric report as an interactive session would.
        task_dir = self.state/'tasks/T1'
        for event in json.loads((self.state/'runtime/events.json').read_text()):
            if event['kind'] != 'completed':
                continue
            for key, evidence in event['detail']['evidence'].items():
                if key in ('brief', 'plan', 'qa', 'report'):
                    name = 'runs/1/report.json' if key == 'report' else 'plan.md' if key == 'plan' else key+'.json'
                    (task_dir/name).write_bytes((self.state/evidence['path']).read_bytes())
        old_report = (task_dir/'runs/1/report.json').read_bytes()
        task = json.loads((task_dir/'task.json').read_text())
        task.update(acceptance=['The NEW feature works'], scenario='brief_blocks')
        (task_dir/'task.json').write_text(json.dumps(task))
        second = self.store.request('T1')
        # Even before the first stage runs, none of the old evidence is current.
        page = self.page()
        self.assertEqual(page['status'], 'pending')
        for key in ('brief', 'plan', 'qa', 'findings'):
            self.assertNotIn(key, page)
        self.assertEqual(self.run_cycle().returncode, 2)
        page = self.page()
        self.assertEqual(page['loop']['request_id'], second['request_id'])
        self.assertEqual((page['loop']['stage'], page['loop']['status']), ('BRIEF', 'blocked'))
        self.assertEqual(page['brief']['cases'][0]['text'], 'The NEW feature works')
        self.assertEqual(page['criteria'][0]['text'], 'The NEW feature works')
        self.assertEqual(page['criteria'][0]['verdict'], 'pending')
        self.assertEqual(page['status'], 'pending')
        self.assertIsNone(page['run'])
        for key in ('plan', 'qa', 'findings'):
            self.assertNotIn(key, page)
        self.assertEqual((task_dir/'runs/1/report.json').read_bytes(), old_report)
        self.assertEqual(self.store.get(first['request_id'])['status'], 'done')

    def test_report_uses_database_if_exports_are_stale_and_supports_exported_copies(self):
        self.store.enqueue('T1')
        old_state = (self.state/'state.json').read_bytes()
        old_events = (self.state/'runtime/events.json').read_bytes()
        self.assertEqual(self.run_cycle(max_steps=3).returncode, 3)
        (self.state/'state.json').write_bytes(old_state)
        (self.state/'runtime/events.json').write_bytes(old_events)
        self.assertEqual(self.page()['qa']['author'], 'fixture')
        self.store.export()
        # A copied report directory without SQLite can still use its exported journal.
        (self.state/'runtime.sqlite3').rename(self.root/'saved-runtime.sqlite3')
        self.assertEqual(self.page()['qa']['author'], 'fixture')
        self.assertFalse((self.state/'runtime.sqlite3').exists(), 'building a report must not create a database')

    def test_changed_evidence_is_not_displayed_as_completed(self):
        self.store.enqueue('T1')
        self.assertEqual(self.run_cycle(max_steps=3).returncode, 3)
        events = json.loads((self.state/'runtime/events.json').read_text())
        plan = next(e['detail']['evidence']['plan']['path'] for e in events
                    if e['kind'] == 'completed' and e['detail']['from'] == 'PLAN')
        (self.state/plan).write_text('Replaced after completion')
        page = self.page()
        self.assertNotIn('plan', page)
        self.assertTrue(any('plan' in warning for warning in page['warnings']))
        self.assertIn('brief', page)
        self.assertIn('qa', page)

    def test_recorded_evidence_cannot_follow_a_symlink_outside_the_task(self):
        self.store.enqueue('T1')
        self.assertEqual(self.run_cycle(max_steps=3).returncode, 3)
        events = json.loads((self.state/'runtime/events.json').read_text())
        plan = next(e['detail']['evidence']['plan']['path'] for e in events
                    if e['kind'] == 'completed' and e['detail']['from'] == 'PLAN')
        original = self.state/plan
        outside = self.root/'outside-plan.md'
        outside.write_bytes(original.read_bytes())  # Same digest: the path itself must be refused.
        original.unlink()
        original.symlink_to(outside)
        page = self.page()
        self.assertNotIn('plan', page)
        self.assertTrue(any('plan' in warning for warning in page['warnings']))

    def test_fix_invalidates_report_from_previous_attempt_in_same_request(self):
        self.task('T1', 'fail_forever')
        self.store.enqueue('T1', 'retest')
        self.assertEqual(self.run_cycle(max_steps=1).returncode, 3)
        self.assertEqual(self.page()['status'], 'fail')
        # COUNCIL and FIX complete, REVIEW is next: the old retest is no longer current.
        self.assertEqual(self.run_cycle(max_steps=2).returncode, 3)
        page = self.page()
        self.assertEqual(page['status'], 'pending')
        self.assertEqual(page['criteria'][0]['verdict'], 'pending')
        self.assertNotIn('after', page['criteria'][0])

    def test_waiting_server_stays_open_for_the_answer(self):
        self.task('T1','brief_blocks')
        record = self.store.enqueue('T1','execute','Make the title bigger')
        # the fixture blocks only without a comment: clear it so BRIEF asks
        with self.store.connect() as conn: conn.execute("UPDATE requests SET comment='' WHERE request_id=?",(record['request_id'],))
        self.assertEqual(self.run_cycle().returncode,2)
        with self.store.connect() as conn: conn.execute("UPDATE requests SET comment='Make the title bigger' WHERE request_id=?",(record['request_id'],))
        (self.state/'report.html').write_text('fixture')
        script = ROOT/'skills/sim-verify-task/scripts/report_server.py'
        proc = subprocess.Popen([sys.executable,str(script),str(self.state),'--port','0','--wait','20'],stdout=subprocess.PIPE,text=True)
        try:
            line = proc.stdout.readline()
            url = line.split('report: ',1)[1].strip()
            time.sleep(1)
            self.assertIsNone(proc.poll(), 'a question waiting for the person is not work: the page must stay open')
            port, token = url.split(':')[2].split('/')[0], url.split('t=',1)[1]
            connection = http.client.HTTPConnection('127.0.0.1',int(port),timeout=3)
            connection.request('POST','/send',json.dumps({'task_id':'T1','comment':'Only the paid plan'}),{'X-Devloop-Token':token,'Content-Type':'application/json','Host':f'127.0.0.1:{port}'})
            self.assertEqual(connection.getresponse().status,200)
            connection.close()
            self.assertEqual(proc.wait(timeout=10),0)
        finally:
            if proc.poll() is None: proc.kill()
        current = self.store.get(record['request_id'])
        self.assertEqual(current['status'],'ready')
        self.assertEqual(current['comment'],'Make the title bigger\n\nAnswer: Only the paid plan', 'the answer is added, the request is kept')
