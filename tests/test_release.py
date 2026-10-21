import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('release',ROOT/'tools/build_release.py')
release=importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)/'source'
        self.root.mkdir()
        for path in release.files(ROOT):
            target=self.root/path.relative_to(ROOT)
            target.parent.mkdir(parents=True,exist_ok=True)
            shutil.copy2(path,target)

    def test_archive_excludes_local_data_and_is_reproducible(self):
        for path in ('hooks/hooks.json','.agents/plugins/marketplace.json','.venv/key','private.env','tests/fixture.py','dev-loop-fixes.patch','.devloop/runtime.sqlite3'):
            target=self.root/path
            target.parent.mkdir(parents=True,exist_ok=True)
            target.write_text('private content')
        one,audit=release.build(self.root,self.root/'dist',draft=True)
        first=one.read_bytes()
        two,_=release.build(self.root,self.root/'dist',draft=True)
        self.assertEqual(first,two.read_bytes())
        with zipfile.ZipFile(one) as archive:
            self.assertIn('plugin.json',archive.namelist())
            self.assertTrue(all(not p.startswith(('hooks/','.','tests/')) for p in archive.namelist()))
            self.assertNotIn('private.env',archive.namelist())
            self.assertNotIn('dev-loop-fixes.patch',archive.namelist())
        self.assertFalse(audit['local_preflight_passed'])

    def test_ready_mode_rejects_missing_publisher_materials(self):
        manifest=json.loads((self.root/'plugin.json').read_text())
        manifest['extensions']['com.openai']['interface'].pop('supportURL',None)
        (self.root/'plugin.json').write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError,'supportURL'):
            release.build(self.root,self.root/'dist')
        self.assertFalse(list((self.root/'dist').glob('*.zip')))

    def test_ready_archive_requires_explicit_publication_authorization(self):
        with self.assertRaisesRegex(ValueError,'Publisher authorization'):
            release.build(self.root,self.root/'dist')

    def test_authorized_ready_archive_contains_public_metadata(self):
        publication=self.root/'publication'
        publication.mkdir()
        (publication/'publisher.json').write_text(json.dumps({'publication_authorized':True}))
        archive,audit=release.build(self.root,self.root/'dist')
        version = json.loads((self.root/'plugin.json').read_text())['version']
        self.assertEqual(archive.name, f'dev-loop-{version}.zip')
        self.assertTrue(audit['local_preflight_passed'])
        self.assertEqual(audit['publication_pending'],[])
        with zipfile.ZipFile(archive) as zip:
            manifest=json.loads(zip.read('plugin.json'))
            self.assertTrue(manifest['extensions']['com.openai']['interface']['privacyPolicyURL'].startswith('https://'))
            self.assertNotIn('publication/publisher.json',zip.namelist())

    def test_symlink_inside_allowed_tree_is_rejected(self):
        outside=Path(self.temp.name)/'private.txt'
        outside.write_text('private')
        (self.root/'skills/start-task/references/leak.txt').symlink_to(outside)
        with self.assertRaisesRegex(ValueError,'symlink'):
            release.build(self.root,self.root/'dist',draft=True)

    def test_manifest_hooks_are_rejected_not_silently_shipped(self):
        manifest=json.loads((self.root/'plugin.json').read_text())
        manifest['extensions']['com.openai']['hooks']={}
        (self.root/'plugin.json').write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError,'hooks'):
            release.build(self.root,self.root/'dist',draft=True)

    def test_unexpected_secret_file_in_skills_is_rejected(self):
        (self.root/'skills/start-task/.env').write_text('a private file')
        with self.assertRaisesRegex(ValueError,'unexpected packaged file'):
            release.build(self.root,self.root/'dist',draft=True)

    def test_release_blocks_credential_formats_without_echoing_values(self):
        # Synthetic values are assembled here; no live account is contacted.
        payloads = {
            'Linear': 'lin_' + 'api_' + 'Ab9' * 12,
            'Linear OAuth': 'lin_' + 'oauth_' + 'Cd8' * 12,
            'GitHub': 'gho_' + 'Ef7' * 12,
            'GitHub fine-grained': 'github_' + 'pat_' + 'Gh6' * 12,
            'OpenAI': 'sk-' + 'proj-' + 'Ij5' * 12,
            'previously detected short key': 'sk-' + 'proj-' + 'Ij5K' * 5,
            'Anthropic': 'sk-' + 'ant-api03-' + 'Kl4' * 12,
            'AWS': 'AKIA' + 'AB12' * 4,
            'Google': 'AIza' + 'Mn3Pq' * 7,
            'Slack': 'xoxb-' + '1234567890-' * 3,
            'Stripe': 'sk_' + 'live_' + 'Rs2' * 12,
            'SendGrid': 'SG.' + 'Tu1V' * 5 + '.' + 'Wx0Y' * 8,
            'npm': 'npm_' + 'Za9' * 12,
            'JWT': 'eyJ' + 'Ab8C' * 4 + '.' + 'De7F' * 4 + '.' + 'Gh6I' * 8,
            'unencrypted private key': '-----BEGIN ' + 'PRIVATE KEY-----',
            'encrypted private key': '-----BEGIN ' + 'ENCRYPTED PRIVATE KEY-----',
            'OpenSSH private key': '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----',
            'PGP private key': '-----BEGIN ' + 'PGP PRIVATE KEY BLOCK-----',
            'database URL': 'postgresql://fixture:' + 'Ab9Cd8' * 4 + '@db.invalid/app',
            'literal key': 'CUSTOM_API_KEY = "' + 'Ef7Gh6' * 6 + '"',
            'authorization': 'Authorization: "Bearer ' + 'Ij5Kl4' * 6 + '"',
        }
        for label, value in payloads.items():
            for draft in (False, True):
                with self.subTest(kind=label, draft=draft):
                    (self.root/'README.md').write_text(value)
                    with self.assertRaises(ValueError) as caught:
                        release.build(self.root, self.root/'dist', draft=draft)
                    self.assertIn('credential-like content', str(caught.exception))
                    self.assertNotIn(value, str(caught.exception))
                    audits = list((self.root/'dist').glob('*.audit.json'))
                    self.assertTrue(audits)
                    for audit in audits:
                        self.assertNotIn(value, audit.read_text())
                    self.assertFalse(list((self.root/'dist').glob('*.zip')))

    def test_secret_scan_covers_binary_assets_and_nested_supporting_files(self):
        value = ('lin_' + 'api_' + 'Qw7Er8' * 6).encode()
        for name in ('assets/screenshot.png', 'skills/help/references/example.txt'):
            with self.subTest(path=name):
                file = self.root/name
                file.write_bytes(b'\x89PNG\r\n\x1a\n\x00' + value + b'\x00')
                try:
                    with self.assertRaisesRegex(ValueError, 'credential-like content'):
                        release.build(self.root, self.root/'dist', draft=True)
                    self.assertFalse(list((self.root/'dist').glob('*.zip')))
                finally:
                    file.unlink()

    def test_extracted_scripts_find_their_packaged_dependencies(self):
        archive,_=release.build(self.root,self.root/'dist',draft=True)
        extracted=Path(self.temp.name)/'installed'
        with zipfile.ZipFile(archive) as zip: zip.extractall(extracted)
        for script in ('skills/check-bug/scripts/build_bug_report.py','skills/start-task/scripts/devloop.py','skills/sim-verify-task/scripts/report_server.py',
                       'skills/sim-verify-task/scripts/artifact_bridge.py', 'skills/sim-verify-task/scripts/imgdiff.py',
                       'skills/close-threads/scripts/collect_threads.py'):
            result=subprocess.run([sys.executable,str(extracted/script),'--help'],cwd=extracted,capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr)

    def test_extracted_guide_and_translated_skill_metadata_are_complete(self):
        archive, _ = release.build(self.root, self.root/'dist', draft=True)
        extracted = Path(self.temp.name)/'installed with spaces'
        with zipfile.ZipFile(archive) as zip:
            zip.extractall(extracted)
        docs = extracted/'skills/help/references/guide.md'
        self.assertTrue(docs.is_file())
        for name in release.EXPECTED_SKILLS:
            self.assertTrue((extracted/'skills'/name/'SKILL.md').is_file())
            metadata = extracted/'skills'/name/'agents/openai.yaml'
            self.assertTrue(metadata.is_file())
            result = subprocess.run(
                [sys.executable, str(extracted/'skills/help/scripts/help.py'), name],
                cwd=Path(self.temp.name), capture_output=True, text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(result.stdout.startswith(f'## {name}\n'))
        result = subprocess.run(
            [sys.executable, str(extracted/'skills/start-task/scripts/devloop.py'), 'help'],
            cwd=Path(self.temp.name), capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), docs.read_text().strip())
        self.assertFalse((Path(self.temp.name)/'.devloop').exists())

    def test_extracted_handoff_scripts_load(self):
        node=shutil.which('node')
        if not node: self.skipTest('Node.js is not installed')
        archive,_=release.build(self.root,self.root/'dist',draft=True)
        extracted=Path(self.temp.name)/'installed-handoff'
        with zipfile.ZipFile(archive) as zip: zip.extractall(extracted)
        scripts=sorted((extracted/'skills/filter-design/scripts').glob('*.mjs'))
        self.assertTrue(scripts)
        for script in scripts:
            result=subprocess.run([node,'--check',str(script)],cwd=extracted,capture_output=True,text=True)
            self.assertEqual(result.returncode,0,f'{script.name}: {result.stderr}')
        self.assertTrue((extracted/'skills/filter-design/scripts/designs-page.html').is_file())
        # match-design imports filter-design's helpers by a relative path: it must run from the installed tree
        result=subprocess.run([node,str(extracted/'skills/match-design/scripts/match.mjs'),'--help'],cwd=extracted,capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertIn('match.mjs prep',result.stdout)
        self.assertTrue((extracted/'skills/match-design/scripts/page.html').is_file())
        self.assertTrue((extracted/'skills/check-bug/templates/bug.html').is_file())
