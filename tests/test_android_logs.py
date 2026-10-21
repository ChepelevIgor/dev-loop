import json
import subprocess
from unittest.mock import patch
from test_regressions import WorkspaceTest, module

logs = module('android_logs', 'skills/sim-verify-task/scripts/android_logs.py')


class AndroidLogsTests(WorkspaceTest):
    def test_second_snapshot_only_new_messages(self):
        a='100.000001 12 12 I App: first\n'
        b='101.000001 12 12 I App: second\n'
        output,cursor=logs.delta(a)
        self.assertEqual(output,a)
        output,_=logs.delta(a+b,cursor)
        self.assertEqual(output,b)

    def test_new_duplicate_at_same_timestamp_preserved(self):
        a='100.000001 12 12 I App: repeated\n'
        _,cursor=logs.delta(a)
        output,cursor=logs.delta(a+a,cursor)
        self.assertEqual(output,a)
        self.assertEqual(logs.delta(a+a,cursor)[0],'')

    def test_clock_reset_and_multiline(self):
        _,cursor=logs.delta('100.000001 12 12 E App: first\n')
        new='1.000001 12 12 E App: reset\n    at stack.line\n'
        output,_=logs.delta(new,cursor)
        self.assertEqual(output,new)

    def test_bad_format_is_error(self):
        with self.assertRaises(ValueError): logs.delta('unexpected format\n')

    def test_failed_adb_preserves_output_and_cursor(self):
        output=self.root/'log.txt'; output.write_text('preserve')
        with patch.object(logs.subprocess,'run',side_effect=subprocess.CalledProcessError(1,'adb')):
            with self.assertRaises(subprocess.CalledProcessError): logs.collect('device',output,self.root/'state')
        self.assertEqual(output.read_text(),'preserve')
        self.assertEqual(list((self.root/'state').glob('*.json')),[])

    def test_filter_cursors_are_independent(self):
        capture=subprocess.CompletedProcess([],0,'100.000001 12 12 I AppA: first\n101.000001 14 14 I AppB: second\n','')
        with patch.object(logs.subprocess,'run',return_value=capture) as run:
            logs.collect('device',self.root/'a.log',self.root/'state','AppA')
            logs.collect('device',self.root/'b.log',self.root/'state','AppB')
        self.assertIn('first',(self.root/'a.log').read_text())
        self.assertIn('second',(self.root/'b.log').read_text())
        self.assertEqual(len(list((self.root/'state').glob('*.json'))),2)
        self.assertNotIn('-c',run.call_args[0][0])
