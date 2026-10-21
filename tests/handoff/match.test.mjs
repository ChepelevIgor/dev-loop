// node --test tests/handoff/match.test.mjs — a mobile screenshot (whole or a piece) against workbench shots:
// density and insets, locating a fragment, ranking screens by their texts, the diff and the page.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { crop, findingsErrors, guessScale, insets, locate, logicErrors, logicScore, looksFull, resize, routeFor, shoot, strength } from '../../skills/match-design/scripts/match.mjs';
import { encodePng } from '../../skills/filter-design/scripts/img-diff.mjs';
import { target } from '../../skills/filter-design/scripts/lib.mjs';

const M = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../skills/match-design/scripts/match.mjs');
const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

/** A "screen": light background with random colored blocks — enough structure to be found. */
function screen(w, h, seed = 7) {
  const data = new Uint8Array(w * h * 4).fill(245);
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let k = 0; k < 40; k++) {
    const x = Math.floor(rnd() * (w - 60));
    const y = Math.floor(rnd() * (h - 30));
    const bw = 10 + rnd() * 50;
    const bh = 6 + rnd() * 24;
    const c = Math.floor(rnd() * 200);
    for (let yy = y; yy < y + bh; yy++) for (let xx = x; xx < x + bw; xx++) data.set([c, (c * 3) % 255, 255 - c], (yy * w + xx) * 4);
  }
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return { width: w, height: h, data };
}

test('density, insets and "whole screen" are guessed from the size; scores read as words', () => {
  assert.equal(guessScale(1179), 3);
  assert.equal(guessScale(828), 2);
  assert.equal(guessScale(300), 1);
  assert.deepEqual(insets(852), { top: 59, bottom: 34 });
  assert.deepEqual(insets(667), { top: 20, bottom: 0 });
  assert.deepEqual(insets(800, true), { top: 24, bottom: 0 });
  assert.ok(looksFull(1179, 2556));
  assert.ok(!looksFull(600, 200), 'a wide strip is a fragment');
  assert.equal(strength(0.9), 'strong');
  assert.equal(strength(0.6), 'possible');
  assert.equal(strength(0.2), 'weak');
  assert.equal(routeFor('app/(tabs)/profile/index.tsx'), '/profile');
  assert.equal(routeFor('app/index.tsx'), '/');
});

test('locate finds a fragment, a whole screen without its status bar, and a fragment at another density', () => {
  const shot = screen(393, 852);
  const a = locate(crop(shot, 100, 400, 180, 90), shot);
  assert.ok(Math.abs(a.x - 100) <= 3 && Math.abs(a.y - 400) <= 3, JSON.stringify(a));
  assert.ok(a.score > 0.9);
  const b = locate(crop(shot, 0, 59, 393, 852 - 59 - 34), shot);
  assert.ok(Math.abs(b.y - 59) <= 3 && b.w >= 390, JSON.stringify(b));
  const c = locate(resize(crop(shot, 50, 200, 200, 100), 300, 150), shot);
  assert.ok(Math.abs(c.x - 50) <= 6 && Math.abs(c.y - 200) <= 6 && Math.abs(c.scale - 2 / 3) < 0.05, JSON.stringify(c));
  const flat = { width: 50, height: 50, data: new Uint8Array(50 * 50 * 4).fill(200) };
  assert.throws(() => locate(flat, shot), /no detail/);
});

test('findings are checked before the page: verdict, candidate, every difference with kind, place and severity', () => {
  const cands = [{ id: 'profile' }];
  const logic = [{ rule: 'Кнопка неактивна при пустом имени', source: 'design', ref: 'card.tsx:44', status: 'matches', mobile: 'NameForm.tsx:51' }];
  assert.deepEqual(findingsErrors({ verdict: 'match', candidate: 'profile', summary: 'Совпадает', differences: [], logic }, cands), []);
  assert.match(findingsErrors({ verdict: 'match', candidate: 'profile', summary: 'Совпадает', differences: [] }, cands).join(), /business rules/);
  assert.deepEqual(findingsErrors({ verdict: 'not-found', summary: 'Нет такого экрана' }, cands), []);
  const bad = findingsErrors({ verdict: 'differs', candidate: 'other', summary: '', differences: [{ kind: 'vibe', where: '', severity: 'huge' }] }, cands);
  assert.equal(bad.length, 6, bad.join('\n'));
  assert.match(findingsErrors({ verdict: 'differs', candidate: 'profile', summary: 'x', differences: [], logic }, cands).join(), /list the differences/);
});

test('business logic: every rule has a source, a status and evidence; unclear rules are counted apart', () => {
  const ok = [
    { rule: 'Пустое состояние с кнопкой', source: 'design', ref: 'index.tsx · no-items', status: 'missing', mobile: 'profile.tsx:30', note: 'нет кнопки' },
    { rule: 'Кнопка неактивна', source: 'design', ref: 'card.tsx:44', status: 'matches', seen: true },
    { rule: 'Лимит 40 символов', source: 'design', ref: 'card.tsx:12', status: 'matches', mobile: 'NameForm.tsx:9' },
    { rule: 'Офлайн-очередь', source: 'docs', ref: 'kb/profile.md', status: 'unclear', note: 'нет в коде мобилки' },
  ];
  assert.deepEqual(logicErrors(ok), []);
  assert.deepEqual(logicScore(ok), { total: 4, checked: 3, matches: 2, unclear: 1, percent: 67 });
  assert.equal(logicScore([{ status: 'unclear' }]).percent, null);
  const bad = logicErrors([
    { rule: 'x', source: 'vibes', ref: 'r', status: 'matches', seen: true },
    { rule: 'x', source: 'design', ref: 'r', status: 'matches' },
    { rule: 'x', source: 'design', ref: 'r', status: 'differs', mobile: 'a.tsx:1' },
    { rule: 'x', source: 'design', ref: 'r', status: 'maybe' },
    { source: 'design' },
  ]);
  assert.equal(bad.length, 5, bad.join('\n'));
});

function fixture({ light = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'match-'));
  const repo = path.join(root, 'design');
  fs.mkdirSync(path.join(repo, 'app/(tabs)/profile'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src/screens/profile'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'workbench.config.json'), JSON.stringify({ name: 'design', port: 18190 }));
  fs.writeFileSync(path.join(repo, 'app/(tabs)/profile/index.tsx'), 'export default () => "Профиль";\n');
  fs.writeFileSync(path.join(repo, 'src/screens/profile/card.tsx'), 'const a = "Сохранить"; const b = "Видно всем";\n');
  fs.writeFileSync(path.join(repo, 'app/(tabs)/home.tsx'), 'export default () => "Главная Сохранить";\n');
  if (light) fs.writeFileSync(path.join(repo, '.handoff-light'), '');
  g(repo, 'init', '-q', '-b', 'main');
  g(repo, 'add', '.');
  g(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  const env = { HANDOFF_CONFIG: path.join(root, 'settings.json'), HANDOFF_TARGET: repo };
  return { root, repo, env };
}
const run = (f, ...args) => {
  const r = spawnSync(process.execPath, [M, ...args, '--target', f.repo], { encoding: 'utf8', env: { ...process.env, ...f.env } });
  if (r.status !== 0) throw new Error(r.stderr.trim());
  return JSON.parse(r.stdout.trim().split('\n').pop());
};

test('routes ranks screens by how many of the screenshot texts their code has', () => {
  const f = fixture({ light: true });
  const r = run(f, 'routes', '--words', 'Профиль,Сохранить,Видно всем');
  assert.equal(r.hits[0].route, '/profile', JSON.stringify(r));
  assert.deepEqual(new Set(r.hits[0].words), new Set(['Профиль', 'Сохранить', 'Видно всем']));
  assert.ok(r.hits.some((h) => h.route === '/home'));
});

test('a whole screenshot: prep cuts the status bar, locate finds it in the workbench shot, diff and page work; light mode refuses to shoot', () => {
  const f = fixture({ light: true });
  // the "workbench" shot at 3x and the "device" screenshot = the same screen with a status bar and one changed block
  const design = screen(1179, 2556, 11);
  const device = { width: 1179, height: 2556, data: Uint8Array.from(design.data) };
  for (let y = 0; y < 59 * 3; y++) for (let x = 0; x < 1179; x++) device.data.set([0, 0, 0], (y * 1179 + x) * 4);
  for (let y = 1000; y < 1100; y++) for (let x = 200; x < 500; x++) device.data.set([255, 0, 0], (y * 1179 + x) * 4);
  const src = path.join(f.root, 'device.png');
  fs.writeFileSync(src, encodePng(device));
  const p = run(f, 'prep', '--shot', src, '--session', 'profile-1');
  assert.equal(p.full, true);
  assert.equal(p.scale, 3);
  assert.deepEqual(p.viewport, { width: 393, height: 852 });
  assert.deepEqual(p.crop, { top: 59, bottom: 34 });
  assert.throws(() => run(f, 'shoot', '--session', 'profile-1', '--routes', '/profile'), /light mode/);
  // inject the shot `shoot` would have taken
  const dir = p.dir;
  fs.mkdirSync(path.join(dir, 'shots'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'shots/profile.png'), encodePng(design));
  fs.writeFileSync(path.join(dir, 'shots/home.png'), encodePng(screen(1179, 2556, 99)));
  const s = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8'));
  s.candidates = [{ id: 'home', route: '/home', query: 'wb.data=fixtures', shot: 'shots/home.png' }, { id: 'profile', route: '/profile', query: 'wb.data=fixtures', shot: 'shots/profile.png' }];
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify(s));
  const l = run(f, 'locate', '--session', 'profile-1');
  assert.equal(l.best, 'profile');
  assert.notEqual(l.candidates[0].strength, 'weak', 'a changed block lowers the score, but the screen is still found');
  assert.ok(Math.abs(l.candidates[0].y - 177) <= 4, JSON.stringify(l.candidates[0]));
  assert.ok(l.candidates[1].score < l.candidates[0].score);
  const d = run(f, 'diff', '--session', 'profile-1');
  assert.equal(d.candidate, 'profile');
  assert.ok(d.changed > 0.5 && d.changed < 5, `changed ${d.changed}`);
  assert.ok(d.regions.length >= 1);
  for (const k of ['design', 'mobile', 'diff']) assert.ok(fs.existsSync(d[k]), k);
  const findings = path.join(f.root, 'findings.json');
  fs.writeFileSync(findings, JSON.stringify({ verdict: 'differs', candidate: 'profile', summary: 'Красный блок в мобилке', differences: [{ kind: 'extra', where: 'середина экрана', mobile: 'красный блок', design: '—', severity: 'high' }],
    logic: [{ rule: 'Блок показан только с данными', source: 'design', ref: 'app/(tabs)/profile/index.tsx', status: 'differs', seen: true, note: 'мобилка показывает его всегда' },
      { rule: 'Сохранить доступно', source: 'design', ref: 'src/screens/profile/card.tsx:1', status: 'matches', seen: true }] }));
  const pg = run(f, 'page', '--session', 'profile-1', '--file', findings, '--title', 'Профиль <script>');
  const html = fs.readFileSync(pg.page, 'utf8');
  assert.equal(pg.verdict, 'differs');
  assert.deepEqual(pg.logic, { total: 2, checked: 2, matches: 1, unclear: 0, percent: 50 });
  assert.equal((html.match(/data:image\/png;base64,/g) ?? []).length, 4);
  assert.doesNotMatch(html, /Профиль <script>/, 'data is escaped inside the script');
  fs.writeFileSync(findings, JSON.stringify({ verdict: 'differs', candidate: 'nope', summary: 'x', differences: [], logic: [] }));
  assert.throws(() => run(f, 'page', '--session', 'profile-1', '--file', findings), /findings refused/);
});

/** A completed review; only the external app and browser are replaced by deterministic captures. */
async function reviewedSession(t) {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const original = screen(160, 320);
  const src = path.join(f.root, 'device.png');
  fs.writeFileSync(src, encodePng(original));
  const p = run(f, 'prep', '--shot', src, '--session', 'refresh', '--full', '--scale', '1', '--crop-top', '0', '--crop-bottom', '0');
  const design = target(f.repo);
  const options = {
    name: 'refresh', routes: '/profile',
    prepare: () => ({ head: 'old-sha' }),
    startServer: async () => {}, checkBundle: async () => null,
    capture: async (url, file) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.copyFileSync(src, file);
    },
  };
  await shoot(design, options);
  run(f, 'locate', '--session', 'refresh');
  assert.equal(run(f, 'diff', '--session', 'refresh').changed, 0);
  const findings = path.join(f.root, 'findings.json');
  fs.writeFileSync(findings, JSON.stringify({
    verdict: 'match', candidate: 'profile', summary: 'Matches the original design', differences: [],
    logic: [{ rule: 'Profile is shown', source: 'design', ref: 'app/(tabs)/profile/index.tsx:1', status: 'matches', seen: true }],
  }));
  const page = run(f, 'page', '--session', 'refresh', '--file', findings).page;
  assert.equal(run(f, 'page', '--session', 'refresh').verdict, 'match', 'unchanged evidence can reuse its review');
  return { f, design, options, original, dir: p.dir, page };
}

test('recapture cannot attach the previous verdict to a changed screen and new commit', async (t) => {
  const { f, design, options, original, dir, page } = await reviewedSession(t);
  const changed = { ...original, data: Uint8Array.from(original.data, (v, i) => i % 4 === 3 ? v : Math.floor(v / 2)) };
  await shoot(design, {
    ...options, prepare: () => ({ head: 'new-sha' }),
    capture: async (url, file) => fs.writeFileSync(file, encodePng(changed)),
  });
  assert.ok(!fs.existsSync(page), 'the previous standalone page must not remain the current result');
  const state = run(f, 'status', '--session', 'refresh');
  assert.equal(state.findings, undefined);
  assert.equal(state.best, undefined);
  assert.equal(state.compared, undefined);
  assert.equal(state.candidates[0].match, undefined);
  assert.equal(state.candidates[0].diff, undefined);
  assert.equal(state.candidates[0].from.sha, 'new-sha');
  assert.throws(() => run(f, 'diff', '--session', 'refresh'), /run locate/);
  run(f, 'locate', '--session', 'refresh');
  assert.ok(run(f, 'diff', '--session', 'refresh').changed > 90);
  const result = run(f, 'page', '--session', 'refresh');
  assert.equal(result.verdict, 'not judged yet');
  assert.equal(result.logic, null);
  const html = fs.readFileSync(path.join(dir, 'standalone.html'), 'utf8');
  assert.match(html, /"findings":null/);
  assert.doesNotMatch(html, /Matches the original design/);
});

test('failed refresh invalidates old evidence before preparation, server startup, bundle or capture', async (t) => {
  const failures = [
    { prepare: () => { throw new Error('prepare failed'); } },
    { startServer: async () => { throw new Error('server failed'); } },
    { checkBundle: async () => 'bundle failed' },
    { capture: async (url, file) => {
      fs.writeFileSync(file, 'partial capture');
      throw new Error('capture failed');
    } },
  ];
  for (const failure of failures) {
    await t.test(Object.keys(failure)[0], async (t) => {
      const { f, design, options, page } = await reviewedSession(t);
      await assert.rejects(shoot(design, { ...options, ...failure }), /failed/);
      assert.ok(!fs.existsSync(page));
      const state = run(f, 'status', '--session', 'refresh');
      assert.equal(state.findings, undefined);
      assert.deepEqual(state.candidates, []);
      assert.throws(() => run(f, 'diff', '--session', 'refresh'), /run locate/);
      assert.equal(run(f, 'page', '--session', 'refresh').verdict, 'not judged yet');
    });
  }
});

test('relocating a screen invalidates the comparison and its saved verdict', async (t) => {
  const { f, page } = await reviewedSession(t);
  run(f, 'locate', '--session', 'refresh');
  assert.ok(!fs.existsSync(page));
  const state = run(f, 'status', '--session', 'refresh');
  assert.ok(state.candidates[0].match);
  assert.equal(state.candidates[0].diff, undefined);
  assert.equal(state.findings, undefined);
  assert.equal(state.compared, undefined);
  assert.equal(run(f, 'page', '--session', 'refresh').verdict, 'not judged yet');
});
