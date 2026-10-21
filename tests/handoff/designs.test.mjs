// node --test tests/*.test.mjs — the designs → Linear flow: plan rules, the page version pin, one task per task
// with its pictures uploaded (a fake Linear in this process), the MCP record path.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { computedGaps, conditionMatched, diffOf, parseLinks, pushSlug, recordedStates, render, reviewErrors, unknownState, validatePlan, variantClash } from '../../skills/filter-design/scripts/designs.mjs';
import { encodePng } from '../../skills/filter-design/scripts/img-diff.mjs';
import { target, treeDir } from '../../skills/filter-design/scripts/lib.mjs';
import { mockClaude } from './mcp-fixture.mjs';

const review = { metric: 'Share of new users who finish onboarding', summary: 'The home screen shows the item card first, so a new user sees what to do next.', dod: ['A new user sees the item card on the home screen'], cases: [{ given: 'a new user with one item', when: 'they open the home screen', then: 'the item card is the first block' }], gaps: [] };
const D = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../skills/filter-design/scripts/designs.mjs');
const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'designs-'));
  const repo = path.join(root, 'design');
  fs.mkdirSync(path.join(repo, 'app/(tabs)'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'workbench.config.json'), JSON.stringify({ name: 'design', port: 18090, linear: { team: 'TASK' } }));
  fs.writeFileSync(path.join(repo, 'app/(tabs)/home.tsx'), 'export default () => null;\n');
  g(repo, 'init', '-q', '-b', 'main');
  g(repo, 'add', '.');
  g(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  const dz = path.join(root, 'from-designer');
  fs.mkdirSync(dz);
  fs.writeFileSync(path.join(dz, 'home-a.html'), '<h1>A</h1>');
  fs.writeFileSync(path.join(dz, 'home-b.html'), '<h1>B</h1>');
  fs.writeFileSync(path.join(root, 'details.html'), '<h1>P</h1>');
  return { root, repo, dz };
}
const run = (f, ...args) => {
  const r = spawnSync(process.execPath, [D, ...args, '--target', f.repo], { encoding: 'utf8', env: { ...process.env, ...(f.env ?? {}) } });
  if (r.status !== 0) throw new Error(r.stderr.trim().split('\n').pop());
  return JSON.parse(r.stdout.trim().split('\n').pop());
};
const runAsync = (f, ...args) =>
  new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [D, ...args, '--target', f.repo], { env: { ...process.env, ...(f.env ?? {}) } });
    let out = '';
    let err = '';
    p.stdout.on('data', (c) => (out += c));
    p.stderr.on('data', (c) => (err += c));
    p.on('close', (code) => (code === 0 ? resolve(JSON.parse(out.trim().split('\n').pop())) : reject(new Error(err.trim().split('\n').pop()))));
  });
const json = (f, name, v) => {
  const p = path.join(f.root, name);
  fs.writeFileSync(p, JSON.stringify(v));
  return p;
};

test('plan rules: every design in exactly one app task; variants of one screen never split; bad plans are refused', () => {
  const ds = [{ id: 'D1', route: '/home' }, { id: 'D2', route: '/home' }, { id: 'D3', route: '/details' }];
  const body = 'x'.repeat(30);
  const ok = { tasks: [{ id: 'T1', title: 'Home redesign', side: 'client', designs: ['D1', 'D2'], body, review }, { id: 'T2', title: 'Details screen', side: 'client', designs: ['D3'], body, review }, { id: 'T3', title: 'Details API', side: 'backend', designs: ['D3'], body, review }] };
  assert.deepEqual(validatePlan(ok, ds), []);
  const split = { tasks: [{ id: 'T1', title: 'Home variant A', side: 'client', designs: ['D1'], body, review }, { id: 'T2', title: 'Home variant B', side: 'client', designs: ['D2', 'D3'], body, review }] };
  assert.ok(validatePlan(split, ds).some((e) => /variants D1, D2/.test(e)));
  const lost = { tasks: [{ id: 'T1', title: 'Home redesign', side: 'client', designs: ['D1', 'D2'], body, review }] };
  assert.ok(validatePlan(lost, ds).some((e) => /D3 is in no app task/.test(e)));
  const twice = { tasks: [{ id: 'T1', title: 'Home redesign', side: 'client', designs: ['D1', 'D2', 'D3'], body, review }, { id: 'T2', title: 'Details screen', side: 'client', designs: ['D3'], body, review }] };
  assert.ok(validatePlan(twice, ds).some((e) => /D3 is in several/.test(e)));
});

/** A batch of three designs (two variants of /home, a new /details) with a plan of two app tasks. */
function batch(f) {
  run(f, 'add', '--batch', 'b1', '--from', f.dz, path.join(f.root, 'details.html'));
  run(f, 'describe', '--batch', 'b1', '--file', json(f, 'd.json', { D1: { title: 'Home A', route: '/home', condition: 'a user with one item' }, D2: { title: 'Home B', route: '/home', condition: 'A user with one  item' }, D3: { title: 'Details', route: '/details', condition: 'a item without a details' } }));
  run(f, 'plan', '--batch', 'b1', '--file', json(f, 'p.json', { tasks: [{ id: 'T1', title: 'Home redesign', side: 'client', designs: ['D1', 'D2'], body: '### Context\nNew home from the designer.', review }, { id: 'T2', title: 'Item details', side: 'client', designs: ['D3'], body: '### Context\nA new details screen.', review }] }));
  // pictures as render would leave them (render needs Chrome and the app; not part of this test)
  const dir = path.join(path.dirname(f.repo), '.design-handoff/state/batches/b1');
  const d = JSON.parse(fs.readFileSync(path.join(dir, 'designs.json'), 'utf8'));
  fs.mkdirSync(path.join(dir, 'shots'), { recursive: true });
  for (const x of d.list) {
    fs.writeFileSync(path.join(dir, 'shots', `${x.id}.png`), Buffer.from([137, 80, 78, 71]));
    x.shot = `shots/${x.id}.png`;
  }
  fs.writeFileSync(path.join(dir, 'designs.json'), JSON.stringify(d));
  return { dir, version: run(f, 'status', '--batch', 'b1').version };
}

test('add: every HTML is a design; the designer\'s files are copied, never touched; new vs existing screens known', () => {
  const f = fixture();
  const before = fs.readFileSync(path.join(f.dz, 'home-a.html'), 'utf8');
  run(f, 'add', '--batch', 'b1', '--from', f.dz, path.join(f.root, 'details.html'));
  const d = run(f, 'describe', '--batch', 'b1', '--file', json(f, 'd.json', { D3: { title: 'Details', route: '/details' }, D1: { title: 'Home A', route: '/home' } }));
  assert.deepEqual(d.list.map((x) => x.id), ['D1', 'D2', 'D3']);
  assert.equal(d.list.find((x) => x.id === 'D3').isNew, true);
  assert.equal(d.list.find((x) => x.id === 'D1').isNew, false);
  assert.equal(fs.readFileSync(path.join(f.dz, 'home-a.html'), 'utf8'), before);
});

test('linear: a stale page version is refused; tasks with a design on rework wait; each task once, pictures uploaded into it', async () => {
  const f = fixture();
  const { dir, version } = batch(f);
  const seen = { creates: 0, puts: 0, descriptions: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.method === 'PUT') {
        seen.puts++;
        return res.end('{}');
      }
      const { query, variables } = JSON.parse(body);
      const port = server.address().port;
      if (query.includes('fileUpload')) return res.end(JSON.stringify({ data: { fileUpload: { success: true, uploadFile: { uploadUrl: `http://127.0.0.1:${port}/put/${variables.fn}`, assetUrl: `https://uploads.linear.app/${variables.fn}`, headers: [{ key: 'x-goog-meta', value: '1' }] } } } }));
      if (query.includes('issueCreate')) {
        seen.creates++;
        seen.descriptions.push(variables.i.description);
        return res.end(JSON.stringify({ data: { issueCreate: { success: true, issue: { id: `uuid-${seen.creates}`, identifier: `TASK-${70 + seen.creates}`, url: `https://linear.app/x/TASK-${70 + seen.creates}` } } } }));
      }
      if (query.includes('teams')) return res.end(JSON.stringify({ data: { teams: { nodes: [{ id: 'team-1' }] } } }));
      return res.end(JSON.stringify({ data: { issues: { nodes: [] } } }));
    });
  });
  await new Promise((r) => server.listen(0, r));
  f.env = { LINEAR_API_KEY: 'lin_api_test', LINEAR_API_URL: `http://127.0.0.1:${server.address().port}/graphql` };
  try {
    await assert.rejects(runAsync(f, 'linear', '--batch', 'b1', '--version', 'deadbeef0000', '--take', 'D1,D3'), /there were reworks after the page/);
    // D2 (a variant of T1) on rework → T1 waits; T2 is created with its picture
    const r1 = await runAsync(f, 'linear', '--batch', 'b1', '--version', version, '--take', 'D1,D3', '--rework', 'D2');
    assert.deepEqual(r1.created.map((x) => x.task), ['T2']);
    assert.deepEqual(r1.waiting, ['T1']);
    assert.equal(seen.puts, 1);
    assert.match(seen.descriptions[0], /!\[D3 design\]\(https:\/\/uploads\.linear\.app\/D3\.png\)/);
    // D2 dropped later: T1 is created now with D1 only; T2 is not created again
    const r2 = await runAsync(f, 'linear', '--batch', 'b1', '--version', version, '--take', 'D1,D3', '--skip', 'D2');
    assert.deepEqual(r2.created.map((x) => x.task), ['T1']);
    assert.equal(seen.creates, 2);
    assert.doesNotMatch(seen.descriptions[1], /D2 design/);
    const r3 = await runAsync(f, 'linear', '--batch', 'b1', '--version', version, '--take', 'D1,D3', '--skip', 'D2');
    assert.equal(r3.created.length, 0, 'nothing twice');
    assert.equal(seen.creates, 2);
  } finally {
    server.close();
  }
  // the page shows the sent tasks as links
  const p = run(f, 'page', '--batch', 'b1');
  const html = fs.readFileSync(p.page, 'utf8');
  assert.match(html, /TASK-71/);
  assert.ok(fs.existsSync(path.join(dir, 'linear.json')));
});

test('linear without a key tries Claude MCP, keeps an unpublished preview and records confirmed issues', () => {
  const f = fixture();
  const { version } = batch(f);
  f.env = { ...mockClaude(f.root), LINEAR_API_KEY: '' };
  const dry = run(f, 'linear', '--batch', 'b1', '--version', version, '--take', 'D1,D2,D3', '--dry-run');
  assert.equal(fs.existsSync(f.env.MCP_TEST_LOG), false, 'a preview must not change MCP setup');
  assert.deepEqual(dry.would.map((x) => x.task), ['T1', 'T2']);
  assert.ok(fs.existsSync(path.join(dry.preview, 'T1.md')));
  const pending = run(f, 'linear', '--batch', 'b1', '--version', version, '--take', 'D1,D2,D3');
  assert.equal(pending.status, 'needs_mcp');
  assert.equal(pending.published, false);
  assert.deepEqual(pending.created, []);
  assert.equal(pending.connection.status, 'needs_authentication');
  assert.equal(pending.preview, dry.preview);
  const callCount = () => fs.readFileSync(f.env.MCP_TEST_LOG, 'utf8').trim().split('\n').length;
  const calls = callCount();
  const rec = run(f, 'linear', '--batch', 'b1', '--version', version, '--take', 'D1,D2,D3', '--record', 'T1=TASK-5@https://linear.app/x/TASK-5');
  assert.equal(rec.sent.T1.identifier, 'TASK-5');
  assert.equal(callCount(), calls, 'recording a successful MCP write must not reconnect');
  const again = run(f, 'linear', '--batch', 'b1', '--version', version, '--take', 'D1,D2,D3', '--dry-run');
  assert.deepEqual(again.would.map((x) => x.task), ['T2']);
  const attachment = run(f, 'attach', '--batch', 'b1', '--task', 'TASK-5');
  assert.equal(attachment.status, 'needs_mcp');
  assert.equal(attachment.published, false);
  const comment = run(f, 'comment', '--batch', 'b1', '--task', 'T1', '--text', 'Reworked');
  assert.equal(comment.status, 'needs_mcp');
  assert.equal(comment.task, 'TASK-5');
  const artifact = run(f, 'artifact', '--batch', 'b1', '--url', 'https://claude.ai/artifact/example');
  assert.equal(artifact.status, 'needs_mcp');
  assert.equal(artifact.attached, 0);
});

test('the decision page isolates source files and accepts only its own origin and token', async (t) => {
  const f = fixture();
  batch(f);
  run(f, 'page', '--batch', 'b1', '--title', 'Demo');
  const port = 18000 + Math.floor(Math.random() * 1000);
  const p = spawn(process.execPath, [D, 'serve', '--batch', 'b1', '--port', String(port), '--wait', '20', '--target', f.repo]);
  t.after(() => p.kill());
  let out = '';
  p.stdout.on('data', (c) => (out += c));
  const url = await new Promise((r) => { const i = setInterval(() => { const m = /"url":"([^"]+)"/.exec(out); if (m) { clearInterval(i); r(m[1]); } }, 50); });
  const token = new URL(url).searchParams.get('t');
  assert.equal((await fetch(`http://127.0.0.1:${port}/?t=wrong`)).status, 403);
  const response = await fetch(url);
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  const page = await response.text();
  assert.match(page, /data:image\/png;base64/, 'one file: pictures inside');
  const sourceBase = JSON.parse(page.match(/const SOURCE_BASE = (.+);/)[1]);
  const source = new URL(sourceBase);
  assert.notEqual(source.origin, new URL(url).origin, 'designer scripts run on another origin');
  const sourceToken = source.pathname.split('/')[2];
  assert.notEqual(sourceToken, token, 'the read-only capability cannot authorize decisions');
  const rendered = pageScript(page, new URL(url)).el('designs').innerHTML;
  assert.ok(rendered.includes(`href="${sourceBase}01-from-designer/home-a.html"`));
  assert.match(rendered, /rel="noopener noreferrer" referrerpolicy="no-referrer"/);
  assert.equal(await (await fetch(`${sourceBase}01-from-designer/home-a.html`)).text(), '<h1>A</h1>');
  assert.equal((await fetch(`http://127.0.0.1:${port}/src/${token}/01-from-designer/home-a.html`)).status, 403);
  const decision = JSON.stringify({ text: '[handoff-designs b1 v] Push to design: take D1' });
  assert.equal((await fetch(`http://127.0.0.1:${port}/decision?t=${sourceToken}`, { method: 'POST', body: decision })).status, 403);
  for (const origin of [source.origin, 'null', 'https://example.invalid']) {
    assert.equal((await fetch(`http://127.0.0.1:${port}/decision?t=${token}`, { method: 'POST', headers: { origin }, body: decision })).status, 403);
  }
  assert.equal((await fetch(`http://127.0.0.1:${port}/state?t=${token}`, { headers: { origin: source.origin } })).status, 403);
  assert.equal((await fetch(sourceBase + '%ZZ')).status, 400);
  assert.equal((await fetch(url)).status, 200, 'bad source URLs leave the decision session running');
  assert.doesNotMatch(out, /"decision":/);
  const bad = await fetch(`http://127.0.0.1:${port}/decision?t=${token}`, { method: 'POST', body: JSON.stringify({ text: 'rm -rf /' }) });
  assert.equal(bad.status, 400);
  const ok = await fetch(`http://127.0.0.1:${port}/decision?t=${token}`, { method: 'POST', headers: { origin: new URL(url).origin }, body: JSON.stringify({ text: '[handoff-designs b1 v] Rework D2: bigger' }) });
  assert.equal(ok.status, 200);
  const code = await new Promise((r) => p.on('close', r));
  assert.equal(code, 0);
  assert.match(out, /Rework D2: bigger/);
});

test('tasks get the page attached (HTML file + the artifact); a task the designer named gets a comment, no new task', async () => {
  const f = fixture();
  const { dir } = batch(f);
  // T2 goes to an existing task the designer named
  run(f, 'plan', '--batch', 'b1', '--file', json(f, 'p2.json', { tasks: [{ id: 'T1', title: 'Home redesign', side: 'client', designs: ['D1', 'D2'], body: '### Context\nNew home from the designer.', review }, { id: 'T2', title: 'Item details', side: 'client', designs: ['D3'], body: '### Context\nA new details screen.', existing: 'TASK-9', review }] }));
  run(f, 'page', '--batch', 'b1', '--title', 'Demo');
  run(f, 'artifact', '--batch', 'b1', '--url', 'https://claude.ai/artifact/abc');
  const version = run(f, 'status', '--batch', 'b1').version;
  const seen = { creates: 0, comments: 0, attach: [], uploads: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.method === 'PUT') return res.end('{}');
      const { query, variables } = JSON.parse(body);
      const port = server.address().port;
      if (query.includes('fileUpload')) { seen.uploads.push(variables.ct); return res.end(JSON.stringify({ data: { fileUpload: { success: true, uploadFile: { uploadUrl: `http://127.0.0.1:${port}/put`, assetUrl: `https://uploads.linear.app/${variables.fn}`, headers: [] } } } })); }
      if (query.includes('attachmentCreate')) { seen.attach.push([variables.i.issueId, variables.i.url]); return res.end(JSON.stringify({ data: { attachmentCreate: { success: true, attachment: { id: `a${seen.attach.length}` } } } })); }
      if (query.includes('commentCreate')) { seen.comments++; return res.end(JSON.stringify({ data: { commentCreate: { success: true, comment: { id: 'c1', url: 'https://linear.app/x/c1' } } } })); }
      if (query.includes('comments(first:')) return res.end(JSON.stringify({ data: { issue: { comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } }));
      if (query.includes('issue(id')) return res.end(JSON.stringify({ data: { issue: { id: 'uuid-9', identifier: 'TASK-9', url: 'https://linear.app/x/TASK-9', title: 'Details' } } }));
      if (query.includes('issueCreate')) { seen.creates++; return res.end(JSON.stringify({ data: { issueCreate: { success: true, issue: { id: 'uuid-1', identifier: 'TASK-71', url: 'https://linear.app/x/TASK-71' } } } })); }
      if (query.includes('teams')) return res.end(JSON.stringify({ data: { teams: { nodes: [{ id: 'team-1' }] } } }));
      return res.end(JSON.stringify({ data: { issues: { nodes: [] } } }));
    });
  });
  await new Promise((r) => server.listen(0, r));
  f.env = { LINEAR_API_KEY: 'lin_api_test', LINEAR_API_URL: `http://127.0.0.1:${server.address().port}/graphql` };
  try {
    const r = await runAsync(f, 'linear', '--batch', 'b1', '--version', version, '--take', 'D1,D2,D3');
    assert.deepEqual(r.created.map((x) => [x.task, x.identifier]), [['T1', 'TASK-71'], ['T2', 'TASK-9']]);
    assert.equal(seen.creates, 1, 'only T1 is new');
    assert.equal(seen.comments, 1, 'TASK-9 gets the designs as a comment');
    assert.equal(seen.uploads.filter((x) => x === 'text/html').length, 1, 'the page is uploaded once and reused');
    for (const issue of ['uuid-1', 'uuid-9']) {
      assert.ok(seen.attach.some(([i, u]) => i === issue && /standalone\.html$/.test(u)), `${issue}: the HTML page`);
      assert.ok(seen.attach.some(([i, u]) => i === issue && u === 'https://claude.ai/artifact/abc'), `${issue}: the artifact`);
    }
  } finally {
    server.close();
  }
});

test('auto: the agent writes describe / analysis / plan itself; a plan that breaks the rules goes back once with the errors', () => {
  const f = fixture();
  const bin = path.join(f.root, 'bin');
  fs.mkdirSync(bin);
  const count = path.join(f.root, 'plan-calls');
  // a fake `claude -p`: answers by the STEP line of the prompt; the first plan splits the variants (refused), the second is right
  fs.writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env node
const fs = require('fs');
const prompt = process.argv[process.argv.indexOf('-p') + 1];
const step = /STEP: (\\w+)/.exec(prompt)[1];
const body = '### Context\\nFrom the designer.';
let v;
if (step === 'describe') v = { designs: [{ id: 'D1', title: 'Home A', route: '/home', note: 'a' }, { id: 'D2', title: 'Home B', route: '/home', note: 'b' }, { id: 'D3', title: 'Details', route: '/details', note: 'new' }] };
if (step === 'analysis') v = { designs: ['D1', 'D2', 'D3'].map((id) => ({ id, backend: { needed: id === 'D3', why: id === 'D3' ? 'shows item data' : 'copy only', ok: [], missing: id === 'D3' ? ['description'] : [] }, ds: [], words: 'home' })) };
if (step === 'plan') {
  const n = fs.existsSync('${count}') ? Number(fs.readFileSync('${count}', 'utf8')) + 1 : 1;
  fs.writeFileSync('${count}', String(n));
  const t = (id, title, side, designs) => ({ id, title, side, kind: 'feature', designs, body, team: 'TASK', labels: [], why: 'w', existing: null, review: ${JSON.stringify(review)} });
  v = { tasks: n === 1 ? [t('T1', 'Home variant A', 'client', ['D1']), t('T2', 'Home variant B', 'client', ['D2']), t('T3', 'Details screen', 'client', ['D3'])]
                       : [t('T1', 'Home redesign', 'client', ['D1', 'D2']), t('T2', 'Details screen', 'client', ['D3']), t('T3', 'Backend: description', 'backend', ['D3'])] };
  if (n === 2 && !/refused/.test(prompt)) v = { tasks: [] };
}
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: v, total_cost_usd: 0.01 }));
`, { mode: 0o755 });
  f.env = { PATH: `${bin}:${process.env.PATH}`, LINEAR_API_KEY: '' };
  const r = run(f, 'auto', '--batch', 'b1', '--from', f.dz, path.join(f.root, 'details.html'), '--no-render', '--no-check', '--title', 'Demo');
  assert.deepEqual(r.steps, ['describe', 'analysis', 'plan', 'plan']);
  assert.equal(fs.readFileSync(count, 'utf8'), '2');
  const st = run(f, 'status', '--batch', 'b1');
  assert.deepEqual(st.plan.tasks.map((x) => [x.id, x.designs.join('+')]), [['T1', 'D1+D2'], ['T2', 'D3'], ['T3', 'D3']]);
  assert.equal(st.designs.find((x) => x.id === 'D3').isNew, true);
  assert.ok(fs.existsSync(r.standalone));
});

/** A fake Linear: answers by the query, records what was asked. */
async function fakeLinear(f, handlers = {}) {
  const seen = { creates: 0, comments: 0, attach: [], searches: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.method === 'PUT') return res.end('{}');
      const { query, variables } = JSON.parse(body);
      const port = server.address().port;
      const send = (data) => res.end(JSON.stringify({ data }));
      if (query.includes('searchIssues')) { seen.searches.push(variables); return send({ searchIssues: { nodes: handlers.search ?? [] } }); }
      if (query.includes('fileUpload')) return send({ fileUpload: { success: true, uploadFile: { uploadUrl: `http://127.0.0.1:${port}/put`, assetUrl: `https://uploads.linear.app/${variables.fn}`, headers: [] } } });
      if (query.includes('attachmentCreate')) { seen.attach.push([variables.i.issueId, variables.i.url]); return send({ attachmentCreate: { success: true, attachment: { id: `a${seen.attach.length}` } } }); }
      if (query.includes('commentCreate')) { seen.comments++; return send({ commentCreate: { success: true, comment: { id: 'c1', url: 'https://linear.app/x/c1' } } }); }
      if (query.includes('comments(first:')) return send({ issue: { comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } });
      if (query.includes('issue(id')) return send({ issue: { id: `uuid-${variables.id}`, identifier: variables.id, url: `https://linear.app/x/${variables.id}`, title: 'Existing' } });
      if (query.includes('issueCreate')) { seen.creates++; return send({ issueCreate: { success: true, issue: { id: `uuid-new-${seen.creates}`, identifier: `TASK-${80 + seen.creates}`, url: `https://linear.app/x/TASK-${80 + seen.creates}` } } }); }
      if (query.includes('teams')) return send({ teams: { nodes: [{ id: 'team-1' }] } });
      return send({ issues: { nodes: [] } });
    });
  });
  await new Promise((r) => server.listen(0, r));
  f.env = { LINEAR_API_KEY: 'lin_api_test', LINEAR_API_URL: `http://127.0.0.1:${server.address().port}/graphql` };
  return { seen, close: () => server.close() };
}

test('--link: T1=TASK-12 or T1=new; bad keys, unknown tasks and contradictions are refused', () => {
  assert.deepEqual(parseLinks('T1=TASK-12, T2=new', ['T1', 'T2']), { T1: 'TASK-12', T2: 'new' });
  assert.deepEqual(parseLinks('', ['T1']), {});
  assert.throws(() => parseLinks('T1=item-12', ['T1']), /--link/);
  assert.throws(() => parseLinks('T1=TASK-12;rm', ['T1']), /--link/);
  assert.throws(() => parseLinks('T9=new', ['T1']), /no task T9/);
  assert.throws(() => parseLinks('T1=new,T1=TASK-3', ['T1']), /twice/);
});

test('push slugs are valid, deterministic and never main', () => {
  assert.equal(pushSlug('onboarding-oct', 'T1'), 'onboarding-oct-t1');
  const long = pushSlug('a'.repeat(47), 'T12');
  assert.match(long, /^[a-z0-9][a-z0-9-]{0,47}$/);
  assert.equal(long, pushSlug('a'.repeat(47), 'T12'));
  assert.notEqual(pushSlug('main', 'T1'), 'main');
});

test('linear --link: the chosen existing task gets a comment, "new" creates one; a checkpoint for another target is refused', async () => {
  const f = fixture();
  const { dir, version } = batch(f);
  const L = await fakeLinear(f);
  try {
    // an interrupted earlier press created T1 as a new task; now the page says TASK-12 → must not do both
    fs.writeFileSync(path.join(dir, 'linear-progress.json'), JSON.stringify({ T1: { version, target: 'new', comment: null, record: { id: 'uuid-x', identifier: 'TASK-70', url: 'https://linear.app/x/TASK-70', designs: ['D1'] } } }));
    await assert.rejects(runAsync(f, 'linear', '--batch', 'b1', '--version', version, '--take', 'D1,D3', '--skip', 'D2', '--link', 'T1=TASK-12'), /another version, selection or Linear task/);
    fs.rmSync(path.join(dir, 'linear-progress.json'));
    const r = await runAsync(f, 'linear', '--batch', 'b1', '--version', version, '--take', 'D1,D3', '--skip', 'D2', '--link', 'T1=TASK-12,T2=new');
    assert.deepEqual(r.created.map((x) => [x.task, x.identifier]), [['T1', 'TASK-12'], ['T2', 'TASK-81']]);
    assert.equal(L.seen.creates, 1);
    assert.equal(L.seen.comments, 1);
    await assert.rejects(runAsync(f, 'linear', '--batch', 'b1', '--version', version, '--take', 'D1', '--link', 'T1=TASK-12;x'), /--link/);
  } finally {
    L.close();
  }
  // the plan itself is not edited by the choice: the approval version stays
  assert.equal(run(f, 'status', '--batch', 'b1').version, version);
});

test('match: API candidates (open tasks only) on the page; the agent\'s choice is validated; without a key → needs_mcp', async () => {
  const f = fixture();
  batch(f);
  run(f, 'page', '--batch', 'b1');
  const L = await fakeLinear(f, { search: [
    { id: 'i1', identifier: 'TASK-12', title: 'Home redesign', url: 'https://linear.app/x/TASK-12', state: { name: 'Todo', type: 'unstarted' } },
    { id: 'i2', identifier: 'TASK-3', title: 'Old home', url: 'https://linear.app/x/TASK-3', state: { name: 'Done', type: 'completed' } },
  ] });
  try {
    const m = await runAsync(f, 'match', '--batch', 'b1');
    assert.deepEqual(m.matches.T1.candidates.map((x) => x.identifier), ['TASK-12']);
    assert.equal(m.matches.T1.suggested, null, 'the search does not decide');
    assert.ok(L.seen.searches.every((v) => v.t === 'team-1'));
  } finally {
    L.close();
  }
  assert.throws(() => run(f, 'match', '--batch', 'b1', '--file', json(f, 'm.json', { T1: { candidates: [], suggested: 'TASK-12' } })), /not among the candidates/);
  run(f, 'match', '--batch', 'b1', '--file', json(f, 'm2.json', { T1: { candidates: [{ identifier: 'TASK-12', title: 'Home redesign', url: 'https://linear.app/x/TASK-12', state: 'Todo' }], suggested: 'TASK-12', why: 'same screen' } }));
  const html = fs.readFileSync(run(f, 'page', '--batch', 'b1').page, 'utf8');
  assert.match(html, /"suggested":"TASK-12"/);
  f.env = { ...mockClaude(f.root), LINEAR_API_KEY: '' };
  const pending = run(f, 'match', '--batch', 'b1');
  assert.equal(pending.status, 'needs_mcp');
  assert.deepEqual(pending.tasks.map((x) => x.task), ['T1', 'T2']);
});

test('push-plan: one taken variant per app task from the batch copy; several taken are refused; stale page and light mode refused', () => {
  const f = fixture();
  const { dir, version } = batch(f);
  assert.throws(() => run(f, 'push-plan', '--batch', 'b1', '--version', 'deadbeef0000', '--take', 'D1'), /reworks after the page/);
  const both = run(f, 'push-plan', '--batch', 'b1', '--version', version, '--take', 'D1,D2,D3');
  assert.deepEqual(both.push.map((x) => x.task), ['T2']);
  assert.match(both.refused[0].why, /D1, D2 are all taken/);
  const one = run(f, 'push-plan', '--batch', 'b1', '--version', version, '--take', 'D1,D3', '--skip', 'D2');
  const t1 = one.push.find((x) => x.task === 'T1');
  assert.equal(t1.design, 'D1');
  assert.equal(t1.route, '/home');
  assert.deepEqual(t1.routes, ['/home']);
  assert.equal(t1.states[0].route, '/home');
  assert.ok(t1.from.startsWith(path.join(dir, 'src')), 'the batch copy, not the designer\'s file');
  assert.equal(t1.slug, 'b1-t1');
  assert.match(one.note, /Linear tasks first/);
  // a rework of D1 holds T1 back
  assert.deepEqual(run(f, 'push-plan', '--batch', 'b1', '--version', version, '--take', 'D3', '--rework', 'D1').push.map((x) => x.task), ['T2']);
  fs.writeFileSync(path.join(f.repo, '.handoff-light'), '');
  assert.throws(() => run(f, 'push-plan', '--batch', 'b1', '--version', run(f, 'status', '--batch', 'b1').version, '--take', 'D3'), /full mode/);
  const html = fs.readFileSync(run(f, 'page', '--batch', 'b1').page, 'utf8');
  assert.match(html, /"light":true/);
  assert.match(html, /\$\('push'\)\.disabled = DATA\.light \|\|/);
});

test('pushed: the PR goes on the page and onto the Linear task; a non-GitHub link is refused', async () => {
  const f = fixture();
  const { dir } = batch(f);
  run(f, 'page', '--batch', 'b1');
  fs.writeFileSync(path.join(dir, 'linear.json'), JSON.stringify({ T1: { id: 'uuid-12', identifier: 'TASK-12', url: 'https://linear.app/x/TASK-12', designs: ['D1'] } }));
  const L = await fakeLinear(f);
  try {
    await assert.rejects(runAsync(f, 'pushed', '--batch', 'b1', '--task', 'T1', '--pr', 'https://evil.example/pull/1'), /github\.com pull request/);
    const r = await runAsync(f, 'pushed', '--batch', 'b1', '--task', 'T1', '--pr', 'https://github.com/o/design/pull/7', '--branch', 'design/b1-t1', '--sha', 'abc');
    assert.equal(r.attached, true);
    assert.deepEqual(L.seen.attach, [['uuid-12', 'https://github.com/o/design/pull/7']]);
  } finally {
    L.close();
  }
  assert.match(fs.readFileSync(path.join(dir, 'page', 'index.html'), 'utf8'), /pull\/7/);
  const again = run(f, 'push-plan', '--batch', 'b1', '--version', run(f, 'status', '--batch', 'b1').version, '--take', 'D1,D3', '--skip', 'D2');
  assert.deepEqual(again.push.map((x) => x.task), ['T2'], 'a pushed task is not pushed twice');
});

/** Run the page's own script on a tiny DOM: what the buttons show and the line a press sends. */
function pageScript(html, location = { protocol: 'file:', hostname: '', search: '' }) {
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const els = new Map();
  const el = (id) => {
    if (!els.has(id)) els.set(id, { id, innerHTML: '', textContent: '', title: '', hidden: false, disabled: false, href: '', listeners: {}, addEventListener(k, fn) { this.listeners[k] = fn; }, focus() {} });
    return els.get(id);
  };
  const doc = { listeners: {}, getElementById: el, addEventListener(k, fn) { this.listeners[k] = fn; } };
  const ctx = vm.createContext({ document: doc, window: {}, location, URLSearchParams, localStorage: { getItem: () => null, setItem() {} }, setInterval() {}, setTimeout, console });
  vm.runInContext(script, ctx);
  return { el, doc };
}

test('the page: Push to design is off in light mode; a press sends the choices with each task\'s Linear target', async () => {
  const f = fixture();
  batch(f);
  run(f, 'match', '--batch', 'b1', '--file', json(f, 'm.json', { T1: { candidates: [{ identifier: 'TASK-12', title: 'Home redesign', url: 'https://linear.app/x/TASK-12', state: 'Todo' }], suggested: 'TASK-12' } }));
  const full = pageScript(fs.readFileSync(run(f, 'page', '--batch', 'b1').standalone, 'utf8'));
  // every design starts as taken: T1 has two taken variants → only T2 can be pushed, and the page says why
  assert.equal(full.el('push').disabled, false);
  assert.match(full.el('push').textContent, /\(1\)/);
  assert.match(full.el('push-note').textContent, /take one variant of D1, D2/);
  assert.match(full.el('tasks').innerHTML, /<option value="TASK-12" selected>/);
  await full.el('push').listeners.click();
  assert.match(full.el('status').innerHTML, /Push to design: take D1,D2,D3; rework —; skip —; link T1=TASK-12,T2=new/);
  fs.writeFileSync(path.join(f.repo, '.handoff-light'), '');
  const light = pageScript(fs.readFileSync(run(f, 'page', '--batch', 'b1').standalone, 'utf8'));
  assert.equal(light.el('push').disabled, true);
  assert.match(light.el('push-note').textContent, /full setup/);
  assert.equal(light.el('create').disabled, false, 'Create Linear tasks still works');
});

test('business review: metric, plain summary, DoD and Given/When/Then are required; no metric only as a product question', () => {
  const tk = (r) => ({ id: 'T1', review: r });
  assert.deepEqual(reviewErrors(tk(review)), []);
  assert.match(reviewErrors({ id: 'T1' }).join(), /no business review/);
  assert.match(reviewErrors(tk({ ...review, metric: null })).join(), /no business metric/);
  assert.deepEqual(reviewErrors(tk({ ...review, metric: null, gaps: [{ kind: 'product', text: 'Which metric does this move?' }] })), []);
  assert.match(reviewErrors(tk({ ...review, dod: [] })).join(), /Definition of Done/);
  assert.match(reviewErrors(tk({ ...review, cases: [{ given: 'a', when: '', then: 'b' }] })).join(), /Given \/ When \/ Then/);
  assert.match(reviewErrors(tk({ ...review, summary: 'short' })).join(), /plain description/);
  assert.match(reviewErrors(tk({ ...review, gaps: [{ kind: 'mood', text: 'x' }] })).join(), /design\|data\|product/);
});

test('business review: missing pictures and backend holes are flagged by themselves and go into the Linear task', async () => {
  const designs = [{ id: 'D1', route: '/home', isNew: false, shot: 'shots/D1.png', nowError: 'the main version does not build', condition: 'one item' }, { id: 'D2', route: null, shot: null, condition: 'no items' }];
  const gaps = computedGaps({ designs: ['D1', 'D2'] }, designs, { D1: { backend: { status: 'missing', summary: 'missing on the dev backend: 1', items: ['description'] } } });
  assert.deepEqual(gaps.map((g) => g.kind), ['design', 'data', 'design', 'design']);
  assert.match(gaps[0].text, /as it is now \(the main version does not build\)/);
  assert.match(gaps[1].text, /description/);
  const f = fixture();
  const { dir, version } = batch(f);
  // D3 lost its picture: the page and the task say so
  const d = JSON.parse(fs.readFileSync(path.join(dir, 'designs.json'), 'utf8'));
  delete d.list.find((x) => x.id === 'D3').shot;
  fs.writeFileSync(path.join(dir, 'designs.json'), JSON.stringify(d));
  const html = fs.readFileSync(run(f, 'page', '--batch', 'b1').page, 'utf8');
  assert.match(html, /D3: no picture of the design/);
  const cur = run(f, 'status', '--batch', 'b1').version;
  assert.notEqual(cur, version);
  f.env = { ...mockClaude(f.root), LINEAR_API_KEY: '' };
  const pv = run(f, 'linear', '--batch', 'b1', '--version', cur, '--take', 'D1,D3', '--skip', 'D2', '--dry-run');
  const t2 = fs.readFileSync(path.join(pv.preview, 'T2.md'), 'utf8');
  for (const part of ['## Business review', '**Metric:** Share of new users', '### Definition of done', '- [ ] A new user sees', '**Given** a new user with one item **When**', '### Open questions', 'design: D3: no picture of the design', '### Context'])
    assert.ok(t2.includes(part), part);
  // no «now» shot of /home is our setup's limitation: on the page, not in the Linear task
  assert.match(html, /D1: no picture of the screen as it is now/);
  assert.doesNotMatch(fs.readFileSync(path.join(pv.preview, 'T1.md'), 'utf8'), /Open questions/);
});

test('conditions: a design without one is an open question; "now" under default data is flagged as ours, not sent to Linear', () => {
  const tk = { designs: ['D1', 'D2', 'D3'] };
  const gaps = computedGaps(tk, [
    { id: 'D1', route: '/scans', isNew: false, shot: 's', now: 'n' },
    { id: 'D2', route: '/scans', isNew: false, shot: 's', now: 'n', condition: 'no scan history' },
    { id: 'D3', route: '/scans', isNew: false, shot: 's', now: 'n', condition: 'three scans', query: 'wb.data=fixtures&wb.state=scans-3', matched: true },
  ], {});
  assert.equal(gaps.length, 2);
  assert.match(gaps[0].text, /D1: the condition is not stated/);
  assert.ok(!gaps[0].setup, 'a missing condition goes to Linear');
  assert.match(gaps[1].text, /D2: "now" is shown with the default data, not under "no scan history"/);
  assert.equal(gaps[1].setup, true);
});

test('conditions: same condition = variants (one is pushed), different conditions = states (all are pushed together)', () => {
  assert.deepEqual(variantClash([{ id: 'D1', condition: 'No history' }, { id: 'D2', condition: 'no  history' }]), ['D1', 'D2']);
  assert.equal(variantClash([{ id: 'D1', condition: 'no history' }, { id: 'D2', condition: '3 scans' }]), null);
  const f = fixture();
  const { dir } = batch(f);
  assert.throws(() => run(f, 'describe', '--batch', 'b1', '--file', json(f, 'bad.json', { D1: { query: '?x=1 && rm' } })), /URL query/);
  run(f, 'describe', '--batch', 'b1', '--file', json(f, 's.json', { D1: { condition: 'no scan history', query: 'wb.data=empty' }, D2: { condition: '3 scans in history', query: '' } }));
  const version = run(f, 'status', '--batch', 'b1').version;
  const r = run(f, 'push-plan', '--batch', 'b1', '--version', version, '--take', 'D1,D2,D3');
  assert.deepEqual(r.refused, []);
  const t1 = r.push.find((x) => x.task === 'T1');
  assert.deepEqual(t1.designs, ['D1', 'D2']);
  assert.deepEqual(t1.states.map((x) => [x.design, x.condition, x.query]), [['D1', 'no scan history', 'wb.data=empty'], ['D2', '3 scans in history', 'wb.data=fixtures']]);
  assert.ok(t1.from.startsWith(path.join(dir, 'push')), 'both states in one capture folder');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(t1.from, 'states.json'), 'utf8'))), ['D1', 'D2']);
  const pg = pageScript(fs.readFileSync(run(f, 'page', '--batch', 'b1').standalone, 'utf8'));
  assert.match(pg.el('push').textContent, /\(2\)/, 'both tasks can be pushed: D1 and D2 are states, not variants');
  assert.match(pg.el('designs').innerHTML, /no scan history/);
});

test('push-plan preserves every screen and state of a connected task, including equal conditions on different screens', (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  batch(f);
  run(f, 'describe', '--batch', 'b1', '--file', json(f, 'connected.json', {
    D1: { condition: 'no items', query: 'wb.data=fixtures&wb.state=empty' },
    D2: { condition: 'one item', query: 'wb.data=fixtures&wb.state=one' },
    D3: { condition: 'No  items', query: 'wb.data=fixtures&wb.state=empty' },
  }));
  run(f, 'plan', '--batch', 'b1', '--file', json(f, 'connected-plan.json', {
    tasks: [{ id: 'T1', title: 'Connected home and details', side: 'client', designs: ['D1', 'D2', 'D3'],
      body: 'Build the connected home and details flow.', review }],
  }));
  const version = run(f, 'status', '--batch', 'b1').version;
  const result = run(f, 'push-plan', '--batch', 'b1', '--version', version, '--take', 'D1,D2,D3');
  assert.deepEqual(result.refused, [], 'the same condition on different routes is not a variant clash');
  assert.equal(result.push.length, 1);
  const item = result.push[0];
  assert.deepEqual(item.routes, ['/home', '/details'], 'checks must receive every route, without duplicates');
  assert.equal(item.route, null, 'a multi-screen task must not advertise the first screen as its sole route');
  assert.equal(item.isNew, null);
  assert.deepEqual(item.states.map((s) => [s.design, s.route, s.isNew, s.query]), [
    ['D1', '/home', false, 'wb.data=fixtures&wb.state=empty'],
    ['D2', '/home', false, 'wb.data=fixtures&wb.state=one'],
    ['D3', '/details', true, 'wb.data=fixtures&wb.state=empty'],
  ]);
  const manifest = JSON.parse(fs.readFileSync(path.join(item.from, 'states.json'), 'utf8'));
  for (const state of item.states) {
    assert.equal(manifest[state.design].route, state.route);
    assert.equal(manifest[state.design].isNew, state.isNew);
    assert.equal(manifest[state.design].query, state.query);
    assert.ok(fs.existsSync(path.join(item.from, manifest[state.design].file)));
  }
  const pg = pageScript(fs.readFileSync(run(f, 'page', '--batch', 'b1').standalone, 'utf8'));
  assert.equal(pg.el('push').disabled, false);
  assert.match(pg.el('push').textContent, /\(1\)/);
  assert.doesNotMatch(pg.el('push-note').textContent, /take one variant/);
});

test('pixel perfect: render compares the design with "now" — a diff picture, the changed share and areas; other sizes give a reason', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-'));
  fs.mkdirSync(path.join(dir, 'shots'));
  const png = (w, h, paint) => {
    const data = new Uint8Array(w * h * 4).fill(255);
    paint?.(data, w);
    return encodePng({ width: w, height: h, data });
  };
  fs.writeFileSync(path.join(dir, 'shots/now.png'), png(20, 40));
  fs.writeFileSync(path.join(dir, 'shots/D1.png'), png(20, 40, (d, w) => { for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) d.set([200, 0, 0], (y * w + x) * 4); }));
  const x = diffOf(dir, { id: 'D1', shot: 'shots/D1.png', now: 'shots/now.png' });
  assert.equal(x.diff, 'shots/diff-D1.png');
  assert.ok(fs.existsSync(path.join(dir, x.diff)));
  assert.equal(x.changed, 12.5);
  assert.deepEqual(x.regions, [{ x: 0, y: 0, w: 0.5, h: 0.25 }]);
  fs.writeFileSync(path.join(dir, 'shots/now.png'), png(20, 20));
  const y = diffOf(dir, x);
  assert.equal(y.diff, undefined, 'a stale diff is dropped');
  assert.match(y.diffError, /sizes differ/);
  // the page: the toggle switches the card between side by side, overlay, difference and the changes map
  const f = fixture();
  const b = batch(f);
  const d = JSON.parse(fs.readFileSync(path.join(b.dir, 'designs.json'), 'utf8'));
  const d1 = d.list.find((z) => z.id === 'D1');
  Object.assign(d1, { isNew: false, now: 'shots/now.png', diff: 'shots/diff-D1.png', changed: 12.5, regions: [{ x: 0, y: 0, w: 0.5, h: 0.25 }] });
  fs.copyFileSync(path.join(dir, 'shots/D1.png'), path.join(b.dir, 'shots/now.png'));
  fs.copyFileSync(path.join(dir, 'shots/diff-D1.png'), path.join(b.dir, 'shots/diff-D1.png'));
  fs.writeFileSync(path.join(b.dir, 'designs.json'), JSON.stringify(d));
  const pg = pageScript(fs.readFileSync(run(f, 'page', '--batch', 'b1').standalone, 'utf8'));
  assert.match(pg.el('designs').innerHTML, /Pixel perfect:/);
  assert.match(pg.el('designs').innerHTML, /changed 12\.5%/);
  const click = (view) => pg.doc.listeners.click({ target: { closest: (sel) => (sel === 'button[data-view]' ? { dataset: { id: 'D1', view } } : null) } });
  click('changes');
  assert.match(pg.el('designs').innerHTML, /Changed: 12\.5% of the screen · 1 area/);
  assert.match(pg.el('designs').innerHTML, /class="box" style="left:0%;top:0%;width:50%;height:25%"/);
  click('difference');
  assert.match(pg.el('designs').innerHTML, /phone stack difference/);
  // the design is moved by hand over "now": a drag in shown pixels becomes shot pixels; arrows nudge; Reset puts it back
  const top = { style: {}, dataset: { drag: 'D1' }, parentElement: { getBoundingClientRect: () => ({ width: 215 }) } };
  pg.el('top-D1').style = top.style;
  pg.doc.listeners.pointerdown({ target: top, clientX: 10, clientY: 10, preventDefault() {} });
  pg.doc.listeners.pointermove({ clientX: 10, clientY: 25 });
  pg.doc.listeners.pointerup({});
  assert.equal(pg.el('shift-D1').textContent, '0, 30 px');
  assert.equal(top.style.transform, `translate(0%, ${(30 / 932) * 100}%)`);
  pg.doc.listeners.keydown({ target: top, key: 'ArrowUp', shiftKey: true, preventDefault() {} });
  assert.equal(pg.el('shift-D1').textContent, '0, 20 px');
  pg.doc.listeners.click({ target: { closest: (sel) => (sel === 'button[data-reset]' ? { dataset: { reset: 'D1' } } : null) } });
  assert.match(pg.el('designs').innerHTML, /translate\(0%, 0%\)/);
});

test('conditions: the repo\'s recorded data states are found; a query naming a state that is not recorded is caught', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
  for (const s of ['board', 'board@care-empty', 'qa-main@no-items']) fs.mkdirSync(path.join(repo, 'knowledge-base/api-recordings', s), { recursive: true });
  assert.deepEqual(recordedStates(repo), ['board@care-empty', 'qa-main@no-items']);
  const states = recordedStates(repo);
  assert.equal(unknownState('wb.data=fixtures&wb.user=board&wb.state=care-empty', states), null);
  assert.equal(unknownState('wb.data=fixtures&wb.state=no-items', states), null);
  assert.equal(unknownState('wb.data=fixtures', states), null);
  assert.match(unknownState('wb.data=fixtures&wb.user=board&wb.state=no-items', states), /no recorded state board@no-items/);
  // a user without a state opens default data: not the design's condition (the real AI Scan run: history drawn, board has none)
  assert.equal(conditionMatched('wb.data=fixtures&wb.user=board', states), false);
  assert.equal(conditionMatched('wb.data=fixtures&wb.user=board&wb.state=care-empty', states), true);
  assert.equal(conditionMatched('wb.data=fixtures&wb.state=nope', states), false);
});

test('the page says what is compared with what: the repo, branch, commit, data of "now" and the batch copy, with links', () => {
  const f = fixture();
  const b = batch(f);
  const d = JSON.parse(fs.readFileSync(path.join(b.dir, 'designs.json'), 'utf8'));
  Object.assign(d.list.find((x) => x.id === 'D1'), { isNew: false, now: 'shots/D1.png', nowQuery: 'wb.data=fixtures&wb.state=scans-history', nowFrom: { repo: 'o/design', ref: 'main', sha: 'abcdef1234567', url: 'http://localhost:8490/home?wb.data=fixtures&wb.state=scans-history' } });
  fs.writeFileSync(path.join(b.dir, 'designs.json'), JSON.stringify(d));
  const html = pageScript(fs.readFileSync(run(f, 'page', '--batch', 'b1').standalone, 'utf8')).el('designs').innerHTML;
  assert.match(html, /<b>Now<\/b> — the screen <code>\/home<\/code> in the design repo <code>o\/design<\/code>, branch <code>main<\/code> at <a href="https:\/\/github.com\/o\/design\/tree\/abcdef1234567"/);
  assert.match(html, /data <code>\?wb.data=fixtures&amp;wb.state=scans-history<\/code>/);
  assert.match(html, /href="http:\/\/localhost:8490\/home\?wb.data=fixtures&amp;wb.state=scans-history"[^>]*>Open this screen/);
  assert.match(html, /<b>New design<\/b> — the batch copy <code>01-from-designer\/home-a\.html<\/code>/);
  assert.match(html, /Now · design repo/);
});

// Exercise the real render / describe / page flow, substituting only Chrome and the app server.
function renderFixture(t) {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const { dir } = batch(f);
  const targetRepo = target(f.repo);
  const main = treeDir(targetRepo, 'main');
  fs.cpSync(path.join(f.repo, 'app'), path.join(main, 'app'), { recursive: true });
  for (const state of ['empty', 'history']) fs.mkdirSync(path.join(main, 'knowledge-base/api-recordings', `board@${state}`), { recursive: true });
  const query = 'wb.data=fixtures&wb.user=board&wb.state=empty';
  run(f, 'describe', '--batch', 'b1', '--file', json(f, 'states.json', {
    D1: { condition: 'no scan history', query }, D2: { condition: 'no scan history', query },
  }));
  const captures = [];
  const options = {
    ids: ['D1', 'D2'],
    prepare: () => ({ head: g(f.repo, 'rev-parse', 'HEAD') }),
    startServer: async () => {},
    checkBundle: async () => null,
    capture: async (url, file) => {
      captures.push(url);
      const data = new Uint8Array(20 * 40 * 4).fill(255);
      if (url.startsWith('file:')) for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) data.set([200, 0, 0], (y * 20 + x) * 4);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, encodePng({ width: 20, height: 40, data }));
    },
  };
  const stateFile = path.join(dir, 'designs.json');
  const read = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const card = () => pageScript(fs.readFileSync(run(f, 'page', '--batch', 'b1').standalone, 'utf8'))
    .el('designs').innerHTML.match(/<article[^>]*id="card-D1">([\s\S]*?)<\/article>/)[1];
  return { f, dir, targetRepo, options, captures, stateFile, read, card, query };
}
function assertNoComparison(x) {
  for (const key of ['now', 'nowQuery', 'nowFrom', 'diff', 'changed', 'regions', 'diffError']) assert.equal(x[key], undefined, `${key} must not survive an invalidated comparison`);
  assert.equal(x.matched, false);
}

test('render: a changed state followed by a failed main build cannot show the old comparison; a successful retry restores it', async (t) => {
  const r = renderFixture(t);
  const initial = await render(r.targetRepo, 'b1', r.options);
  const old = initial.list[0];
  assert.equal(old.matched, true);
  assert.equal(old.nowQuery, r.query);
  assert.equal(old.changed, 12.5);
  assert.match(r.card(), /Both under: no scan history/);
  const query = r.query.replace('state=empty', 'state=history');
  run(r.f, 'describe', '--batch', 'b1', '--file', json(r.f, 'history.json', {
    D1: { condition: 'three scans in history', query },
  }));
  assertNoComparison(r.read().list[0]);
  assert.doesNotMatch(r.card(), /Both under:|Pixel perfect:/);

  const failed = await render(r.targetRepo, 'b1', { ...r.options, ids: ['D1'], checkBundle: async () => 'synthetic main build failure' });
  assertNoComparison(failed.list[0]);
  assert.match(failed.list[0].nowError, /the main version does not build: synthetic main build failure/);
  assert.deepEqual(r.read(), failed, 'failure and invalidation are saved for the page command');
  assert.deepEqual(failed.list[1], initial.list[1], 'an unselected variant keeps its comparison');
  assert.ok(fs.existsSync(path.join(r.dir, old.now)), 'an old file on disk is not reused as evidence');
  assert.ok(fs.existsSync(path.join(r.dir, old.diff)));
  const html = r.card();
  assert.match(html, /synthetic main build failure/);
  assert.match(html, /three scans in history\. Now: comparison unavailable/);
  assert.doesNotMatch(html, /Both under:|Pixel perfect:|changed 12\.5%|alt="Now · design repo"/);
  assert.match(html, /alt="New design · designer's file"/, 'the current design remains visible');

  const retry = await render(r.targetRepo, 'b1', { ...r.options, ids: ['D1'] });
  const current = retry.list[0];
  assert.equal(current.nowError, undefined);
  assert.equal(current.nowQuery, query);
  assert.equal(current.matched, true);
  assert.equal(current.changed, 12.5);
  assert.notEqual(current.now, old.now, 'different states have separate images');
  assert.ok(r.captures.includes(current.nowFrom.url));
  assert.match(r.card(), /Both under: three scans in history/);
  assert.match(r.card(), /Pixel perfect:/);
  assert.deepEqual(retry.list[1], initial.list[1]);
});

test('describe invalidates changed queries, routes and conditions, but preserves comparisons for text-only edits', async (t) => {
  const r = renderFixture(t);
  const initial = await render(r.targetRepo, 'b1', r.options);
  const text = run(r.f, 'describe', '--batch', 'b1', '--file', json(r.f, 'text.json', { D1: { title: 'New title', note: 'New explanation' } }));
  assert.equal(text.list[0].now, initial.list[0].now);
  assert.equal(text.list[0].diff, initial.list[0].diff);
  assert.equal(text.list[0].matched, true);
  for (const change of [{ query: r.query.replace('state=empty', 'state=history') }, { route: '/details' }, { condition: 'three scans in history' }]) {
    fs.writeFileSync(r.stateFile, JSON.stringify(initial));
    const updated = run(r.f, 'describe', '--batch', 'b1', '--file', json(r.f, 'changed.json', { D1: change }));
    assertNoComparison(updated.list[0]);
    assert.deepEqual(updated.list[1], initial.list[1]);
  }
});

test('render retries invalidate old evidence even when the route and query have not changed', async (t) => {
  const r = renderFixture(t);
  const initial = await render(r.targetRepo, 'b1', r.options);
  const failures = [
    { name: 'build', options: { checkBundle: async () => 'broken build' }, error: /broken build/ },
    { name: 'server', options: { startServer: async () => { throw new Error('server unavailable'); } }, error: /server unavailable/ },
    { name: 'capture', options: { capture: async (url, file) => {
      if (url.startsWith('http:')) throw new Error('capture failed');
      return r.options.capture(url, file);
    } }, error: /capture failed/ },
    { name: 'light mode', light: true, error: /light mode/ },
    { name: 'prepare', options: { prepare: () => { throw new Error('prepare failed'); } }, thrown: /prepare failed/ },
  ];
  for (const failure of failures) await t.test(failure.name, async () => {
    fs.writeFileSync(r.stateFile, JSON.stringify(initial));
    const pending = render({ ...r.targetRepo, light: failure.light ?? false }, 'b1', { ...r.options, ids: ['D1'], ...failure.options });
    if (failure.thrown) await assert.rejects(pending, failure.thrown);
    else await pending;
    const result = r.read();
    assertNoComparison(result.list[0]);
    if (failure.error) {
      assert.match(result.list[0].nowError, failure.error);
      assert.match(r.card(), failure.error);
    }
    assertNoComparison(result.list[1]);
    assert.equal(result.list[1].nowError, result.list[0].nowError, 'a variant sharing the same snapshot also loses stale evidence');
    assert.deepEqual(result.list[2], initial.list[2], 'unrelated screens are unaffected by --ids D1');
    assert.doesNotMatch(r.card(), /Both under:|Pixel perfect:|changed 12\.5%/);
  });
});

test('local pages open the reworked batch copy, including escaped paths, and omit the link if that copy is missing', (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const { dir } = batch(f);
  const stateFile = path.join(dir, 'designs.json');
  const d = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const design = d.list[0];
  const original = fs.readFileSync(design.from, 'utf8');
  const previousCopy = path.join(dir, 'src', design.file);
  design.file = '01-from-designer/home #1%.html';
  const copy = path.join(dir, 'src', design.file);
  fs.renameSync(previousCopy, copy);
  fs.writeFileSync(copy, '<h1>Reworked design</h1>');
  fs.writeFileSync(stateFile, JSON.stringify(d));
  const card = (file, location) => pageScript(fs.readFileSync(file, 'utf8'), location).el('designs').innerHTML
    .match(/<article[^>]*id="card-D1">([\s\S]*?)<\/article>/)[1];
  const pages = run(f, 'page', '--batch', 'b1');
  for (const file of [pages.standalone, pages.page]) {
    const html = card(file);
    const href = html.match(/href="([^"]+)"[^>]*>Open the design/)[1];
    assert.match(href, /home%20%231%25\.html$/);
    assert.equal(fs.readFileSync(new URL(href), 'utf8'), '<h1>Reworked design</h1>');
    assert.equal(fs.readFileSync(design.from, 'utf8'), original, 'the designer original stays intact');
    assert.match(html, /the batch copy/);
    assert.doesNotMatch(card(file, new URL('https://example.invalid/artifact')), /Open the design/, 'an external artifact cannot open local files');
  }
  fs.rmSync(copy);
  const missing = run(f, 'page', '--batch', 'b1');
  assert.doesNotMatch(card(missing.standalone), /Open the design/, 'do not fall back to the unchanged original');
});
