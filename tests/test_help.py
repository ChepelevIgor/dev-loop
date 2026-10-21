import importlib.util
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
HELP = ROOT / 'skills/help/scripts/help.py'
QUEUE = ROOT / 'skills/start-task/scripts/devloop.py'
spec = importlib.util.spec_from_file_location('plugin_help', HELP)
guide = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guide)


class HelpTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = {
            **os.environ, 'HOME': str(self.root), 'HANDOFF_CONFIG': str(self.root/'settings.json'),
            'HANDOFF_TARGET': str(self.root/'missing-project'), 'PYTHONDONTWRITEBYTECODE': '1',
        }
        self.env.pop('LINEAR_API_KEY', None)

    def call(self, *args):
        result = subprocess.run(args, cwd=self.root, env=self.env, capture_output=True, text=True, timeout=10)
        self.assertEqual(list(self.root.iterdir()), [], 'help must not create project state or settings')
        return result

    def test_full_guide_and_each_installed_skill_are_reachable_without_a_project(self):
        text = guide.GUIDE.read_text()
        result = self.call(sys.executable, str(HELP))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), text.strip())
        topics = guide.sections(text)
        listing = self.call(sys.executable, str(HELP), '--list')
        self.assertEqual(listing.returncode, 0, listing.stderr)
        self.assertEqual({line.split(':')[0] for line in listing.stdout.splitlines()}, set(topics))
        for skill in (ROOT/'skills').glob('*/SKILL.md'):
            with self.subTest(skill=skill.parent.name):
                name = skill.parent.name
                self.assertIn(name, topics)
                result = self.call(sys.executable, str(HELP), name)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.strip(), topics[name])

    def test_old_names_resolve_to_current_topics(self):
        for old, current in guide.ALIASES.items():
            with self.subTest(old=old):
                result = self.call(sys.executable, str(HELP), old)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.strip(), guide.sections(guide.GUIDE.read_text())[current])

    def test_unknown_topic_and_path_like_input_do_not_open_other_files(self):
        for topic in ('unknown-topic', '../README.md', str(ROOT/'README.md')):
            result = self.call(sys.executable, str(HELP), topic)
            self.assertEqual(result.returncode, 2)
            self.assertEqual(result.stdout, '')

    def test_queue_help_does_not_initialize_store_or_require_git(self):
        for topic in (None, 'sim-verify-task', 'handoff'):
            args = [topic] if topic else []
            result = self.call(sys.executable, str(QUEUE), 'help', *args)
            expected = self.call(sys.executable, str(HELP), *args)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, expected.stdout)
        result = self.call(sys.executable, str(QUEUE), 'help', 'unknown-topic')
        self.assertEqual(result.returncode, 2)

    def test_design_help_does_not_require_repositories_or_start_setup(self):
        node = shutil.which('node')
        if not node:
            self.skipTest('Node.js is not installed')
        for script in ('designs.mjs', 'check.mjs', 'handoff.mjs', 'setup.mjs', 'tasks.mjs'):
            for args in ([], ['--help'], ['help'], ['-h']):
                with self.subTest(script=script, args=args):
                    result = self.call(node, str(ROOT/'skills/filter-design/scripts'/script), *args)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertIn(script, result.stdout)
                    self.assertEqual(result.stderr, '')
        # Even a mutating subcommand must short-circuit before setup/publication.
        for script, command in (('setup.mjs', 'run'), ('designs.mjs', 'linear'), ('handoff.mjs', 'push')):
            result = self.call(node, str(ROOT/'skills/filter-design/scripts'/script), command, '--help')
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_simulator_help_does_not_need_a_device(self):
        for args in ([], ['--help'], ['help'], ['-h']):
            result = self.call('bash', str(ROOT/'skills/sim-verify-task/scripts/sim.sh'), *args)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('sim.sh', result.stdout)

    def test_skill_document_links_resolve_after_renaming(self):
        for skill in (ROOT/'skills').glob('*/SKILL.md'):
            for dest in re.findall(r'\[[^]]+\]\(([^)]+)\)', skill.read_text()):
                if '://' in dest:
                    continue
                path, _, anchor = dest.partition('#')
                target = (skill.parent/path).resolve() if path else skill
                with self.subTest(skill=skill.parent.name, link=dest):
                    self.assertTrue(target.is_file(), dest)
                    if target == guide.GUIDE and anchor:
                        self.assertIn(anchor, guide.sections(target.read_text()))
