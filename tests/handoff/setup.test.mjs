// node --test tests/*.test.mjs — a designer's machine from nothing: setup full / light from a local «GitHub».
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const S = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../skills/filter-design/scripts/setup.mjs');
const D = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../skills/filter-design/scripts/designs.mjs');
const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

/** A bare «GitHub» repo with the design repo's shape (theme, screens, task rules, plus a big unrelated part). */
function remote() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-'));
  const seed = path.join(root, 'seed');
  for (const d of ['app/(tabs)', 'src/shared/theme', 'knowledge-base/tasks', 'src/features/other']) fs.mkdirSync(path.join(seed, d), { recursive: true });
  fs.writeFileSync(path.join(seed, 'workbench.config.json'), JSON.stringify({ name: 'design', port: 18090, linear: { team: 'TASK' } }));
  fs.writeFileSync(path.join(seed, 'package.json'), '{"name":"design","scripts":{}}');
  fs.writeFileSync(path.join(seed, 'app/(tabs)/home.tsx'), 'export default () => null;\n');
  fs.writeFileSync(path.join(seed, 'src/shared/theme/colors.ts'), "export const Colors = {\n  green: '#5D7A50',\n};\n");
  fs.writeFileSync(path.join(seed, 'knowledge-base/tasks/issue-templates.md'), '# templates\n');
  fs.writeFileSync(path.join(seed, 'src/features/other/big.ts'), 'export const x = 1;\n');
  g(seed, 'init', '-q', '-b', 'main');
  g(seed, 'add', '.');
  g(seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  const bare = path.join(root, 'design.git');
  g(root, 'clone', '-q', '--bare', seed, bare);
  g(bare, 'config', 'uploadpack.allowFilter', 'true');
  return { root, bare, url: `file://${bare}`, config: path.join(root, 'handoff.json') };
}
const run = (cmd, env, ...args) => {
  const r = spawnSync(process.execPath, [cmd, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(r.stderr.trim().split('\n').pop());
  return JSON.parse(r.stdout.trim().split('\n').pop());
};

test('setup from nothing (full): the design repo is cloned, ~/.handoff.json points at it, a re-run keeps it', () => {
  const r = remote();
  const env = { HANDOFF_CONFIG: r.config };
  const s = run(S, env, 'run', '--repo-url', r.url, '--dir', path.join(r.root, 'workspace'), '--no-install');
  assert.equal(s.mode, 'full');
  assert.ok(fs.existsSync(path.join(s.target, 'src/features/other/big.ts')));
  assert.equal(JSON.parse(fs.readFileSync(r.config, 'utf8')).target, s.target);
  const again = run(S, env, 'run', '--repo-url', r.url, '--dir', path.join(r.root, 'workspace'), '--no-install');
  assert.match(again.steps[0], /already there/);
  const st = run(S, env, 'status');
  assert.equal(st.mode, 'full');
  assert.ok(st.items.find((x) => /Design repo/.test(x.what)).ok);
});

test('setup light: only the theme, screens and task rules; the designs flow works on it', () => {
  const r = remote();
  const env = { HANDOFF_CONFIG: r.config };
  const s = run(S, env, 'run', '--light', '--repo-url', r.url, '--dir', path.join(r.root, 'workspace'));
  assert.equal(s.mode, 'light');
  assert.ok(fs.existsSync(path.join(s.target, 'src/shared/theme/colors.ts')));
  assert.ok(fs.existsSync(path.join(s.target, 'knowledge-base/tasks/issue-templates.md')));
  assert.ok(!fs.existsSync(path.join(s.target, 'src/features/other/big.ts')), 'nothing else is downloaded');
  assert.equal(run(S, env, 'status').mode, 'light');
  // no --target: the plugin finds the light copy through ~/.handoff.json
  const html = path.join(r.root, 'home.html');
  fs.writeFileSync(html, '<h1>home</h1>');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhere-'));
  const add = spawnSync(process.execPath, [D, 'add', '--batch', 'b1', '--from', html], { encoding: 'utf8', cwd, env: { ...process.env, ...env } });
  assert.equal(add.status, 0, add.stderr);
  fs.writeFileSync(path.join(r.root, 'd.json'), JSON.stringify({ D1: { title: 'Home', route: '/home' } }));
  const d = spawnSync(process.execPath, [D, 'describe', '--batch', 'b1', '--file', path.join(r.root, 'd.json')], { encoding: 'utf8', cwd, env: { ...process.env, ...env } });
  assert.equal(JSON.parse(d.stdout.trim()).list[0].isNew, false);
});

test('nothing set up: the plugin says how to start instead of failing obscurely', () => {
  const r = remote();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhere-'));
  const res = spawnSync(process.execPath, [D, 'status', '--batch', 'b1'], { encoding: 'utf8', cwd, env: { ...process.env, HANDOFF_CONFIG: r.config, HANDOFF_TARGET: '' } });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /set up handoff/);
});
