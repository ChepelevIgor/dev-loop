// node --test tests/   — real git repos in a temp folder; «origin» is a local bare repo; gh is a fake on PATH.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { routesOf, routeIn, target } from '../../skills/filter-design/scripts/lib.mjs';
import { compare } from '../../skills/filter-design/scripts/handoff.mjs';
import { encodePng } from '../../skills/filter-design/scripts/img-diff.mjs';

const H = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../skills/filter-design/scripts/handoff.mjs');
const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
const id = ['-c', 'user.name=t', '-c', 'user.email=t@t'];

/** A design repo with origin = a bare repo, routes /home and /items/[id]; plus a designer's clone. */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-'));
  const bare = path.join(root, 'origin.git');
  g(root, 'init', '-q', '--bare', '-b', 'main', bare);
  const seed = path.join(root, 'seed');
  fs.mkdirSync(path.join(seed, 'app/(tabs)/items'), { recursive: true });
  fs.writeFileSync(path.join(seed, 'workbench.config.json'), JSON.stringify({ name: 'design', port: 18090 }));
  fs.writeFileSync(path.join(seed, 'app/(tabs)/home.tsx'), 'export default () => null;\n');
  fs.writeFileSync(path.join(seed, 'app/(tabs)/items/[id].tsx'), 'export default () => null;\n');
  fs.writeFileSync(path.join(seed, 'app/_layout.tsx'), 'export default () => null;\n');
  g(seed, 'init', '-q', '-b', 'main');
  g(seed, 'add', '.');
  g(seed, ...id, 'commit', '-qm', 'init');
  g(seed, 'remote', 'add', 'origin', bare);
  g(seed, 'push', '-q', 'origin', 'main');
  const repo = path.join(root, 'design'); // the design repo the plugin targets
  g(root, 'clone', '-q', bare, repo);
  const designer = path.join(root, 'designer'); // the designer's own clone with uncommitted work
  g(root, 'clone', '-q', bare, designer);
  fs.writeFileSync(path.join(designer, 'app/(tabs)/home.tsx'), 'export default () => "new home";\n');
  fs.writeFileSync(path.join(designer, 'app/(tabs)/promo.tsx'), 'export default () => "promo";\n');
  return { root, bare, repo, designer };
}
/** What compare / checks leave behind (they need Chrome and npm; not part of these tests). */
function compared(f, slug, sha, extra = {}) {
  const st = path.join(path.dirname(f.repo), '.design-handoff', 'state', slug);
  fs.mkdirSync(st, { recursive: true });
  fs.writeFileSync(path.join(st, 'compare.json'), JSON.stringify({ slug, sha, routes: [{ route: '/home', isNew: false, changed: 12.5, regions: [{}, {}] }, { route: '/promo', isNew: true }] }));
  if (extra.checks !== undefined) fs.writeFileSync(path.join(st, 'checks.json'), JSON.stringify({ slug, sha: extra.checks, routes: {} }));
}
const run = (f, ...args) => {
  const r = spawnSync(process.execPath, [H, ...args, '--target', f.repo], { encoding: 'utf8', env: { ...process.env, ...(f.env ?? {}) } });
  if (r.status !== 0) throw new Error(r.stderr.trim().split('\n').pop());
  return JSON.parse(r.stdout.trim().split('\n').pop());
};

test('routes: groups dropped, index → folder, layouts skipped, [id] matches any segment', () => {
  const rs = routesOf(['app/(tabs)/home.tsx', 'app/index.tsx', 'app/_layout.tsx', 'app/(tabs)/items/[id].tsx', 'app/+html.tsx', 'app/settings/index.tsx']);
  assert.deepEqual(rs, ['/home', '/', '/items/[id]', '/settings']);
  assert.ok(routeIn('/items/42', rs));
  assert.ok(!routeIn('/promo', rs));
});

test('capture: the designer\'s files are hashed and copied; nothing of theirs changes', () => {
  const f = fixture();
  const before = g(f.designer, 'status', '--porcelain');
  const m = run(f, 'capture', '--slug', 'promo', '--from-repo', f.designer, '--note', 'Promo screen');
  assert.equal(m.kind, 'repo');
  assert.ok(m.files.some((x) => x.path === 'changes.patch' && /^[0-9a-f]{64}$/.test(x.sha256)));
  assert.ok(m.files.some((x) => x.path === 'new/app/(tabs)/promo.tsx'));
  assert.equal(g(f.designer, 'status', '--porcelain'), before);
  const html = path.join(f.root, 'screen.html');
  fs.writeFileSync(html, '<h1>new</h1>');
  const h = run(f, 'capture', '--slug', 'promo-html', '--from', html);
  assert.equal(h.files[0].sha256.length, 64);
});

test('prepare: «main» and design/<slug> copies beside the repo; the designer\'s work applied; the repo itself untouched', () => {
  const f = fixture();
  run(f, 'capture', '--slug', 'promo', '--from-repo', f.designer);
  const p = run(f, 'prepare', '--slug', 'promo');
  assert.ok(p.applied.ok, p.applied.note);
  assert.equal(path.dirname(path.dirname(p.after.dir)), path.dirname(f.repo), 'copies live in a hidden sibling folder');
  assert.match(fs.readFileSync(path.join(p.after.dir, 'app/(tabs)/home.tsx'), 'utf8'), /new home/);
  assert.ok(fs.existsSync(path.join(p.after.dir, 'app/(tabs)/promo.tsx')));
  assert.equal(g(p.after.dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'design/promo');
  assert.equal(g(f.repo, 'status', '--porcelain'), '', 'the repo checkout is not touched');
  assert.doesNotMatch(fs.readFileSync(path.join(p.before.dir, 'app/(tabs)/home.tsx'), 'utf8'), /new home/);
});

test('main is reserved: no operation can use the baseline as the editable copy', () => {
  const f = fixture();
  const p = run(f, 'prepare', '--slug', 'promo');
  const head = g(p.before.dir, 'rev-parse', 'HEAD');
  for (const command of ['capture', 'prepare', 'snapshot', 'checks', 'page', 'push']) {
    assert.throws(() => run(f, command, '--slug', 'main'), /main is reserved/);
  }
  assert.equal(g(p.before.dir, 'rev-parse', 'HEAD'), head);
  assert.equal(g(p.before.dir, 'status', '--porcelain'), '');
  assert.equal(g(p.after.dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'design/promo');
});

test('compare keeps every condition, replaces retries and drops evidence from other revisions', async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const copies = run(f, 'prepare', '--slug', 'states');
  const project = target(f.repo);
  const st = path.join(project.work, 'state/states');
  const empty = 'wb.data=fixtures&wb.state=empty';
  const history = 'wb.data=fixtures&wb.state=history';
  const dependencies = {
    startServer: async () => {}, checkBundle: async () => null,
    capture: (url, file) => {
      const data = new Uint8Array(8 * 12 * 4).fill(url.includes('history') ? 120 : 255);
      for (let i = 3; i < data.length; i += 4) data[i] = 255;
      fs.writeFileSync(file, encodePng({ width: 8, height: 12, data }));
    },
  };
  const check = (query, extra = {}) => compare(project, 'states', ['/home'], { ...dependencies, query, ...extra });
  const first = await check(empty);
  const before = fs.readFileSync(path.join(st, first.routes[0].after));
  const second = await check(history);
  assert.deepEqual(second.routes.map((r) => r.query), [empty, history]);
  assert.equal(new Set(second.routes.flatMap((r) => [r.before, r.after, r.diff])).size, 6);
  assert.deepEqual(fs.readFileSync(path.join(st, first.routes[0].after)), before, 'the first state screenshot survives');
  const retry = await check('wb.state=empty&wb.data=fixtures');
  assert.equal(retry.routes.length, 2, 'equivalent queries replace their own state');
  const pg = run(f, 'page', '--slug', 'states', '--title', 'Both states');
  assert.equal(Object.keys(pg.files).length, 6, 'the portable page carries both before/after pairs and diffs');
  const html = fs.readFileSync(pg.page, 'utf8');
  const data = JSON.parse(html.match(/const DATA = (.+);/)[1]);
  assert.deepEqual(data.routes.map((r) => r.query), [empty, history]);
  assert.match(html, /Data: <code>/);
  const failed = await check(empty, { capture: () => { throw new Error('capture unavailable'); } });
  assert.equal(failed.routes.length, 2);
  assert.match(failed.routes.find((r) => r.query === empty).error, /capture unavailable/);
  assert.equal(failed.routes.find((r) => r.query === history).error, undefined);
  g(copies.after.dir, ...id, 'commit', '--allow-empty', '-qm', 'new implementation');
  assert.deepEqual((await check(empty)).routes.map((r) => r.query), [empty], 'a changed implementation drops old states');
  await check(history);
  g(copies.before.dir, ...id, 'commit', '--allow-empty', '-qm', 'new baseline');
  assert.deepEqual((await check(history)).routes.map((r) => r.query), [history], 'a changed baseline drops old states');
});

test('push: only the commit on the page, to design/<slug> (never main), a clean tree; a non-GitHub remote gets no PR', () => {
  const f = fixture();
  run(f, 'capture', '--slug', 'promo', '--from-repo', f.designer);
  run(f, 'prepare', '--slug', 'promo');
  const s = run(f, 'snapshot', '--slug', 'promo', '-m', 'design: promo');
  assert.ok(s.committed);
  assert.throws(() => run(f, 'push', '--slug', 'promo', '--sha', '0000000'), /there were edits after the page/);
  const dir = path.join(path.dirname(f.repo), '.design-handoff', 'promo');
  fs.writeFileSync(path.join(dir, 'app/(tabs)/home.tsx'), 'export default () => "again";\n');
  assert.throws(() => run(f, 'push', '--slug', 'promo', '--sha', s.sha), /uncommitted/);
  g(dir, 'checkout', '--', '.');
  assert.throws(() => run(f, 'push', '--slug', 'promo', '--sha', s.sha), /compare did not run/);
  compared(f, 'promo', '0'.repeat(40));
  assert.throws(() => run(f, 'push', '--slug', 'promo', '--sha', s.sha), /compare did not run/, 'an earlier snapshot\'s compare does not count');
  compared(f, 'promo', s.sha, { checks: '1'.repeat(40) });
  assert.throws(() => run(f, 'push', '--slug', 'promo', '--sha', s.sha), /checks ran on 11111111/);
  compared(f, 'promo', s.sha, { checks: s.sha });
  const p = run(f, 'push', '--slug', 'promo', '--sha', s.sha);
  assert.equal(p.pr, null);
  assert.match(p.note, /not GitHub/);
  assert.equal(g(f.bare, 'rev-parse', 'refs/heads/design/promo'), s.sha);
  assert.notEqual(g(f.bare, 'rev-parse', 'refs/heads/main'), s.sha, 'main is untouched');
});

test('push to GitHub: an open PR for the branch is reused, never a second one', () => {
  const f = fixture();
  run(f, 'capture', '--slug', 'promo', '--from-repo', f.designer);
  run(f, 'prepare', '--slug', 'promo');
  const s = run(f, 'snapshot', '--slug', 'promo');
  compared(f, 'promo', s.sha);
  // the remote looks like GitHub (so a PR is due) but pushes land in the local bare repo
  const gh = 'https://github.com/acme/design.git';
  g(f.repo, 'remote', 'set-url', 'origin', gh);
  g(f.repo, 'config', `url.${f.bare}.insteadOf`, gh);
  const bin = path.join(f.root, 'bin');
  fs.mkdirSync(bin);
  const log = path.join(f.root, 'gh.log');
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/bash\necho "$*" >> ${log}\n[ "$1 $2" = "pr list" ] && echo '[{"url":"https://github.com/acme/design/pull/5"}]'\nexit 0\n`, { mode: 0o755 });
  f.env = { PATH: `${bin}:${process.env.PATH}` };
  const p = run(f, 'push', '--slug', 'promo', '--sha', s.sha);
  assert.equal(p.pr, 'https://github.com/acme/design/pull/5');
  assert.doesNotMatch(fs.readFileSync(log, 'utf8'), /pr create/);
  assert.equal(g(f.bare, 'rev-parse', 'refs/heads/design/promo'), s.sha);
});

test('push to GitHub: a new PR carries the before/after of the pushed commit and the Linear task id', () => {
  const f = fixture();
  run(f, 'capture', '--slug', 'promo', '--from-repo', f.designer);
  run(f, 'prepare', '--slug', 'promo');
  const s = run(f, 'snapshot', '--slug', 'promo');
  compared(f, 'promo', s.sha);
  const gh = 'https://github.com/acme/design.git';
  g(f.repo, 'remote', 'set-url', 'origin', gh);
  g(f.repo, 'config', `url.${f.bare}.insteadOf`, gh);
  const bin = path.join(f.root, 'bin');
  fs.mkdirSync(bin);
  const log = path.join(f.root, 'gh.log');
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/bash\nprintf '%s\\n' "$@" >> ${log}\n[ "$1 $2" = "pr list" ] && echo '[]'\n[ "$1 $2" = "pr create" ] && echo 'https://github.com/acme/design/pull/9'\nexit 0\n`, { mode: 0o755 });
  f.env = { PATH: `${bin}:${process.env.PATH}` };
  const p = run(f, 'push', '--slug', 'promo', '--sha', s.sha, '--task', 'TASK-12', '--task-url', 'https://linear.app/x/TASK-12', '--title', 'Promo');
  assert.equal(p.pr, 'https://github.com/acme/design/pull/9');
  const sent = fs.readFileSync(log, 'utf8');
  assert.match(sent, /\[TASK-12\] Design: Promo/);
  assert.match(sent, /`\/home`: 12\.5% of the screen changed, regions 2/);
  assert.match(sent, /`\/promo`: a new screen/);
  assert.match(sent, /The checks did not run/);
});
