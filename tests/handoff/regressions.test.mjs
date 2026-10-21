// Real CLI processes and a local GraphQL fixture; no account, browser or model backend needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { once } from 'node:events';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validatePlan } from '../../skills/filter-design/scripts/designs.mjs';

const skill = fileURLToPath(new URL('../../skills/filter-design/', import.meta.url));
const D = path.join(skill, 'scripts/designs.mjs');
const json = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const body = '### Context\nA complete task for this screen.';
const review = { metric: 'Onboarding completion', summary: 'The screen gets the new layout from the designer.', dod: ['The new layout is shown'], cases: [{ given: 'a user', when: 'they open the screen', then: 'they see the new layout' }], gaps: [] };
function fixture(t, existing = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-regression-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'design');
  fs.mkdirSync(repo);
  json(path.join(repo, 'workbench.config.json'), { linear: { team: 'TEST' } });
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('-c', 'user.name=test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'fixture');
  const dir = path.join(root, '.design-handoff/state/batches/b1');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'shots'));
  const designs = [1, 2].map((n) => ({ id: `D${n}`, file: `${n}.html`, title: `Screen ${n}`, route: `/screen-${n}`, shot: `shots/D${n}.png` }));
  for (const d of designs) {
    fs.writeFileSync(path.join(dir, 'src', d.file), `<h1>${d.title}</h1>`);
    fs.writeFileSync(path.join(dir, d.shot), Buffer.from([137, 80, 78, 71, Number(d.id.slice(1))]));
  }
  json(path.join(dir, 'designs.json'), { list: designs });
  const tasks = designs.map((d, i) => ({ id: `T${i + 1}`, title: d.title, side: 'client', designs: [d.id], body, review, team: 'TEST', ...(existing && i === 0 ? { existing: 'TEST-9' } : {}) }));
  json(path.join(dir, 'plan.json'), { tasks });
  const env = { ...process.env, HANDOFF_CONFIG: path.join(root, 'config.json'), HANDOFF_TARGET: '', HANDOFF_MOBILE: '', LINEAR_API_KEY: '' };
  json(env.HANDOFF_CONFIG, { mobileRepo: null });
  return { root, repo, dir, designs, tasks, env };
}
const argsFor = (f, args) => [D, ...args, '--batch', 'b1', '--target', f.repo];
function run(f, ...args) {
  const r = spawnSync(process.execPath, argsFor(f, args), { env: f.env, encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 0, r.stderr || String(r.error));
  return JSON.parse(r.stdout.trim().split('\n').pop());
}
function start(f, ...args) {
  const p = spawn(process.execPath, argsFor(f, args), { env: f.env, timeout: 20000 });
  let stdout = '', stderr = '';
  p.stdout.on('data', (b) => { stdout += b; });
  p.stderr.on('data', (b) => { stderr += b; });
  const done = once(p, 'close').then(([code]) => ({ code, stdout, stderr, data: code === 0 ? JSON.parse(stdout.trim().split('\n').pop()) : null }));
  return { p, done };
}
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

async function mockLinear(t, f) {
  const model = { issues: [], comments: [], searches: 0, commentPages: [], attachments: 0 };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (b) => { raw += b; });
    req.on('end', async () => {
      const reply = (data) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data })); };
      if (req.method === 'PUT') return reply({});
      const { query, variables: v } = JSON.parse(raw);
      if (query.includes('issues(filter:')) {
        model.searches++;
        if (model.searches === 1 && model.holdSearch) {
          model.searchStarted.resolve();
          await model.holdSearch.promise;
        }
        return reply({ issues: { nodes: model.issues.filter((i) => i.description.includes(v.q)) } });
      }
      if (query.includes('teams(')) return reply({ teams: { nodes: [{ id: 'team' }] } });
      if (query.includes('issueCreate')) {
        const i = { id: `id-${model.issues.length + 1}`, identifier: `TEST-${model.issues.length + 1}`, url: 'https://linear.example.test/issue', ...v.i };
        model.issues.push(i);
        return reply({ issueCreate: { success: true, issue: i } });
      }
      if (query.includes('comments(first:')) {
        model.commentPages.push(v.after);
        if (model.failLookup) return reply({ issue: null });
        const more = model.paginate && model.comments.length > 0 && !v.after;
        return reply({ issue: { comments: { nodes: more ? [{ id: 'unrelated', body: 'unrelated' }] : model.comments, pageInfo: { hasNextPage: Boolean(more), endCursor: more ? 'next-page' : null } } } });
      }
      if (query.includes('issue(id:')) return reply({ issue: { id: 'existing', identifier: 'TEST-9', url: 'https://linear.example.test/TEST-9' } });
      if (query.includes('commentCreate')) {
        const c = { id: `comment-${model.comments.length + 1}`, url: 'https://linear.example.test/comment', body: v.i.body };
        model.comments.push(c);
        if (model.loseCommentResponse) { model.loseCommentResponse = false; return res.destroy(); }
        return reply({ commentCreate: { success: true, comment: c } });
      }
      if (query.includes('fileUpload')) return reply({ fileUpload: { success: true, uploadFile: { uploadUrl: `http://127.0.0.1:${server.address().port}/put`, assetUrl: `https://uploads.example.test/${v.fn}`, headers: [] } } });
      if (query.includes('attachmentCreate')) {
        model.attachments++;
        if (model.failAttachment) { model.failAttachment = false; return reply({ attachmentCreate: { success: false } }); }
        return reply({ attachmentCreate: { success: true, attachment: { id: `a-${model.attachments}` } } });
      }
      res.writeHead(400);
      res.end(JSON.stringify({ errors: [{ message: 'Unexpected fixture query' }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  f.env.LINEAR_API_KEY = 'test-local-only';
  f.env.LINEAR_API_URL = `http://127.0.0.1:${server.address().port}`;
  return model;
}

test('concurrent CLI publications cannot both create a task, and the lock is released', { timeout: 20000 }, async (t) => {
  const f = fixture(t);
  const v = run(f, 'status').version;
  const m = await mockLinear(t, f);
  m.holdSearch = deferred();
  m.searchStarted = deferred();
  const first = start(f, 'linear', '--version', v, '--take', 'D1');
  try {
    await m.searchStarted.promise;
    const second = await start(f, 'linear', '--version', v, '--take', 'D1').done;
    assert.notEqual(second.code, 0, 'the second process must not enter the publication');
    assert.match(second.stderr, /another Linear operation/);
  } finally {
    m.holdSearch.resolve();
    const result = await first.done;
    assert.equal(result.code, 0, result.stderr);
  }
  assert.equal(m.issues.length, 1);
  assert.equal(m.searches, 1);
  assert.equal(read(path.join(f.dir, 'linear.json')).T1.id, m.issues[0].id);
  assert.ok(!fs.existsSync(path.join(f.dir, 'linear.lock')));
  const retry = await start(f, 'linear', '--version', v, '--take', 'D1').done;
  assert.equal(retry.code, 0, retry.stderr);
  assert.equal(retry.data.created.length, 0);
  assert.equal(m.issues.length, 1);
});

test('duplicate task IDs are refused by validation and by publication of a saved plan', (t) => {
  const f = fixture(t);
  const invalid = { tasks: f.tasks.map((x) => ({ ...x, id: 'T1' })) };
  assert.match(validatePlan(invalid, f.designs).join('\n'), /duplicate task id: T1/);
  const input = path.join(f.root, 'invalid.json');
  json(input, invalid);
  const p = spawnSync(process.execPath, argsFor(f, ['plan', '--file', input]), { env: f.env, encoding: 'utf8' });
  assert.notEqual(p.status, 0);
  assert.match(p.stderr, /duplicate task id/);
  assert.deepEqual(read(path.join(f.dir, 'plan.json')).tasks, f.tasks);
  json(path.join(f.dir, 'plan.json'), invalid);
  const v = run(f, 'status').version;
  const r = spawnSync(process.execPath, argsFor(f, ['linear', '--version', v, '--take', 'D1,D2', '--dry-run']), { env: f.env, encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /duplicate task id/);
  assert.ok(!fs.existsSync(path.join(f.dir, 'linear.lock')), 'a validation failure releases the lock');
});

test('an old lock is never silently stolen while a remote write may still be in flight', (t) => {
  const f = fixture(t);
  const v = run(f, 'status').version;
  const lock = path.join(f.dir, 'linear.lock');
  const helper = pathToFileURL(path.join(skill, 'scripts/lib.mjs')).href;
  const crash = spawnSync(process.execPath, ['--input-type=module', '-e', `const { withFileLock } = await import(${JSON.stringify(helper)}); await withFileLock(process.argv[1], () => process.exit(7));`, lock], { env: f.env, encoding: 'utf8' });
  assert.equal(crash.status, 7, crash.stderr);
  assert.ok(fs.existsSync(lock), 'an abrupt exit must retain the lock for reconciliation');
  const owner = { ...read(lock), startedAt: '2000-01-01T00:00:00Z' };
  json(lock, owner);
  const old = new Date('2000-01-01T00:00:00Z');
  fs.utimesSync(lock, old, old);
  const r = spawnSync(process.execPath, argsFor(f, ['linear', '--version', v, '--take', 'D1', '--dry-run']), { env: f.env, encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /confirm the owner/);
  assert.deepEqual(read(lock), owner);
  assert.ok(!fs.existsSync(path.join(f.dir, 'linear.json')));
});

test('attachment retry resumes the checkpoint without a second comment', async (t) => {
  const f = fixture(t, true);
  const pg = run(f, 'page');
  const m = await mockLinear(t, f);
  m.failAttachment = true;
  const args = ['linear', '--version', pg.version, '--take', 'D1'];
  const failed = await start(f, ...args).done;
  assert.notEqual(failed.code, 0);
  assert.match(failed.stderr, /did not attach/);
  assert.equal(m.comments.length, 1);
  assert.equal(read(path.join(f.dir, 'linear-progress.json')).T1.comment, 'comment-1');
  assert.ok(!fs.existsSync(path.join(f.dir, 'linear.lock')));
  const retry = await start(f, ...args).done;
  assert.equal(retry.code, 0, retry.stderr);
  assert.equal(m.comments.length, 1);
  assert.equal(m.attachments, 2);
  assert.equal(retry.data.sent.T1.identifier, 'TEST-9');
  assert.deepEqual(read(path.join(f.dir, 'linear-progress.json')), {});
  const updated = read(path.join(f.dir, 'page-render.json'));
  assert.equal(updated.version, pg.version);
  assert.notEqual(updated.revision, pg.revision);
  assert.match(fs.readFileSync(path.join(f.dir, 'page/standalone.html'), 'utf8'), /TEST-9/);
});

test('a lost comment response is recovered from later comment pages, without replay', async (t) => {
  const f = fixture(t, true);
  const v = run(f, 'status').version;
  const m = await mockLinear(t, f);
  m.loseCommentResponse = true;
  m.paginate = true;
  const args = ['linear', '--version', v, '--take', 'D1'];
  assert.notEqual((await start(f, ...args).done).code, 0);
  assert.equal(m.comments.length, 1);
  assert.ok(!fs.existsSync(path.join(f.dir, 'linear-progress.json')));
  const retry = await start(f, ...args).done;
  assert.equal(retry.code, 0, retry.stderr);
  assert.equal(m.comments.length, 1);
  assert.deepEqual(m.commentPages, [null, null, 'next-page']);
});

test('an unavailable comment lookup cannot be treated as permission to post again', async (t) => {
  const f = fixture(t, true);
  const v = run(f, 'status').version;
  const m = await mockLinear(t, f);
  m.failLookup = true;
  const r = await start(f, 'linear', '--version', v, '--take', 'D1').done;
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /cannot safely retry/);
  assert.equal(m.comments.length, 0);
});

test('changed checks and screenshot bytes invalidate approval, including missing screenshots', (t) => {
  const f = fixture(t);
  const d = read(path.join(f.dir, 'designs.json'));
  d.list[0].now = 'shots/now.png';
  json(path.join(f.dir, 'designs.json'), d);
  fs.writeFileSync(path.join(f.dir, 'shots/now.png'), 'old baseline');
  const mutations = [
    () => json(path.join(f.dir, 'checks.json'), { D1: { backend: { status: 'missing', summary: 'Required endpoint is absent' } } }),
    () => fs.appendFileSync(path.join(f.dir, 'shots/D1.png'), 'new pixels'),
    () => fs.writeFileSync(path.join(f.dir, 'shots/now.png'), 'new baseline'),
    () => fs.unlinkSync(path.join(f.dir, 'shots/now.png')),
  ];
  for (const mutate of mutations) {
    const pg = run(f, 'page');
    mutate();
    const v = run(f, 'status').version;
    assert.notEqual(v, pg.version);
    const r = spawnSync(process.execPath, argsFor(f, ['linear', '--version', pg.version, '--take', 'D1', '--dry-run']), { env: f.env, encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /there were reworks after the page/);
    const rebuilt = run(f, 'page');
    assert.equal(rebuilt.version, v);
    assert.equal(run(f, 'linear', '--version', v, '--take', 'D1', '--dry-run').would.length, 1);
  }
});

function browser(html, url) {
  const elements = new Map();
  let poll, reloads = 0;
  const location = new URL(url);
  location.reload = () => { reloads++; };
  const context = vm.createContext({
    URLSearchParams, location, window: {}, localStorage: { getItem: () => null, setItem() {} },
    fetch: (u) => fetch(new URL(u, url)),
    setInterval: (fn) => { poll = fn; },
    document: {
      addEventListener() {},
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, { textContent: '', innerHTML: '', hidden: false, addEventListener() {} });
        return elements.get(id);
      },
    },
  });
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
  return { elements, poll: () => poll(), reloads: () => reloads };
}

test('the live page refreshes sent links without changing approval or reloading an unbuilt revision', { timeout: 20000 }, async (t) => {
  const f = fixture(t);
  const pg = run(f, 'page');
  fs.unlinkSync(path.join(f.dir, 'page-render.json')); // an existing page from before display revisions
  const p = spawn(process.execPath, argsFor(f, ['serve', '--port', '0']), { env: f.env });
  const closed = once(p, 'close');
  t.after(async () => { p.kill(); await closed; });
  let stdout = '';
  const url = await new Promise((resolve, reject) => {
    p.stdout.on('data', (b) => {
      stdout += b;
      const m = /"url":"([^"]+)"/.exec(stdout);
      if (m) resolve(m[1]);
    });
    p.once('error', reject);
    p.once('close', () => reject(new Error('page server exited before listening')));
  });
  const view = browser(await (await fetch(url)).text(), url);
  await view.poll();
  assert.equal(view.reloads(), 0);
  run(f, 'linear', '--version', pg.version, '--take', 'D1', '--record', 'T1=TEST-1@https://linear.example.test/TEST-1');
  assert.equal(run(f, 'status').version, pg.version);
  await view.poll();
  assert.equal(view.reloads(), 1, 'sent state must refresh even though approval is unchanged');
  const rendered = browser(await (await fetch(url)).text(), url);
  assert.match(rendered.elements.get('tasks').innerHTML, /in Linear · TEST-1/);
  await rendered.poll();
  assert.equal(rendered.reloads(), 0);
  json(path.join(f.dir, 'checks.json'), { D1: { backend: { status: 'missing' } } });
  await rendered.poll();
  assert.equal(rendered.reloads(), 0, 'do not advertise source changes before the HTML is ready');
  run(f, 'page');
  await rendered.poll();
  assert.equal(rendered.reloads(), 1);
});

test('CLI entry points, defaults and templates work in paths with spaces and URL characters', async (t) => {
  const f = fixture(t);
  const copy = path.join(f.root, 'plugin with spaces #% \u00e9');
  fs.cpSync(skill, copy, { recursive: true });
  const exec = (name, args) => spawnSync(process.execPath, [path.join(copy, 'scripts', name), ...args, '--target', f.repo], { env: f.env, encoding: 'utf8' });
  const st = exec('designs.mjs', ['status', '--batch', 'b1']);
  assert.equal(st.status, 0, st.stderr);
  assert.equal(JSON.parse(st.stdout).batch, 'b1');
  const pg = exec('designs.mjs', ['page', '--batch', 'b1']);
  assert.equal(pg.status, 0, pg.stderr);
  assert.ok(fs.readFileSync(JSON.parse(pg.stdout).standalone, 'utf8').includes('Screen 1'));
  const check = exec('check.mjs', ['mobile', '--route', '/one']);
  assert.equal(check.status, 0, check.stderr);
  assert.equal(JSON.parse(check.stdout).status, 'unknown');
  const module = await import(pathToFileURL(path.join(copy, 'scripts/lib.mjs')));
  assert.equal(module.HOME, fs.realpathSync(copy));
  assert.deepEqual(module.DEFAULTS.lightPaths, read(path.join(copy, 'defaults.json')).lightPaths);
  const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(path.join(copy, 'scripts/designs.mjs')).href)})`], { env: f.env, encoding: 'utf8' });
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout, '', 'importing the module must not execute the CLI');
});
