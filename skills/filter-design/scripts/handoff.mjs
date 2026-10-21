#!/usr/bin/env node
// filter-design (design code) — update a design in code: what a designer made (HTML, an artifact, edits in their own clone) → the design repo's own
// layout on a branch → "before / after" screenshots + what's missing (design system, backend, mobile) → a page to decide →
// "Push to design" → branch + PR. One command per step; every step prints one JSON line on stdout (logs go to stderr).
//
//   node scripts/handoff.mjs capture  --slug <s> (--from <file|folder> | --from-repo <designer's clone>) [--note "…"]
//   node scripts/handoff.mjs prepare  --slug <s>            copies: «main» (= origin/main) and «<s>» on design/<s>
//   node scripts/handoff.mjs snapshot --slug <s> -m "…"     commit what the agent built in the «<s>» copy
//   node scripts/handoff.mjs compare  --slug <s> --routes /a,/b [--query <data query>]   keeps each state at this commit
//   node scripts/handoff.mjs checks   --slug <s> --routes /a,/b   design system · backend · mobile · npm run check
//   node scripts/handoff.mjs page     --slug <s> [--title "…"]    the before/after page (+ its pictures) to publish
//   node scripts/handoff.mjs push     --slug <s> --sha <commit on the page> [--task TASK-1 --task-url …] [--artifact <url>] [--no-pr]
//   node scripts/handoff.mjs stop | status
// Common: --target <design repo> (default: the current folder, $HANDOFF_TARGET or ~/.handoff.json).
// Safety: the designer's files and the design repo's own checkout are only read; everything is built in copies next to
// the repo (../.<repo>-handoff/). Nothing reaches GitHub except `push` (the person's "Push to design"), and never main.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { HOME, cliHelp, git, isMain, readJson, routeIn, routesAt, say, sha256, slugOk, stateDir, target, treeDir, tryGit, writeJson } from './lib.mjs';
import { compare as diffPng } from './img-diff.mjs';
import { bundleError, prepareTree, serve, stopAll } from './stand.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0];
const arg = (k, d = null) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const flag = (k) => argv.includes(k);
const out = (v) => console.log(JSON.stringify(v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function need(slug) {
  if (!slugOk(slug)) throw new Error('--slug: latin letters, digits and dashes, up to 48 characters (e.g. welcome-new-hero)');
  if (slug === 'main') throw new Error('--slug main is reserved for the baseline copy; choose another slug');
  return slug;
}

// ── capture: the designer's work as it is now, hashed; their files are only read ──
function capture(t, slug) {
  const dir = path.join(stateDir(t, slug), 'input');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const files = [];
  const take = (src, rel) => {
    const buf = fs.readFileSync(src);
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), buf);
    files.push({ path: rel, sha256: sha256(buf), bytes: buf.length });
  };
  let kind;
  let base = null;
  if (arg('--from')) {
    kind = 'files';
    const src = path.resolve(arg('--from'));
    if (!fs.existsSync(src)) throw new Error(`no such path: ${src}`);
    const walk = (p, rel) => {
      for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        const abs = path.join(p, e.name);
        if (e.isDirectory()) walk(abs, `${rel}${e.name}/`);
        else if (fs.statSync(abs).size < 25 << 20) take(abs, `${rel}${e.name}`);
      }
    };
    if (fs.statSync(src).isDirectory()) walk(src, '');
    else take(src, path.basename(src));
  } else if (arg('--from-repo')) {
    // edits in the designer's own clone of the design repo: the patch against origin/<base> + new files
    kind = 'repo';
    const repo = path.resolve(arg('--from-repo'));
    tryGit(repo, 'fetch', '-q', 'origin', t.base);
    base = git(repo, 'merge-base', 'HEAD', `origin/${t.base}`);
    const patch = execFileSync('git', ['diff', '--binary', base], { cwd: repo, maxBuffer: 256 << 20 });
    fs.writeFileSync(path.join(dir, 'changes.patch'), patch);
    files.push({ path: 'changes.patch', sha256: sha256(patch), bytes: patch.length });
    for (const f of git(repo, 'ls-files', '--others', '--exclude-standard').split('\n').filter(Boolean)) take(path.join(repo, f), `new/${f}`);
    files.push(...git(repo, 'diff', '--name-only', base).split('\n').filter(Boolean).map((f) => ({ path: `changed/${f}`, sha256: null, bytes: 0 })));
  } else throw new Error('capture: --from <file|folder> or --from-repo <the designer clone>');
  const m = { slug, kind, from: path.resolve(arg('--from') ?? arg('--from-repo')), base, note: arg('--note', ''), at: new Date().toISOString(), files };
  writeJson(path.join(stateDir(t, slug), 'input.json'), m);
  return m;
}

// ── prepare: two copies next to the repo — «main» (before) and the slug's branch (after) ──
function prepare(t, slug) {
  const f = tryGit(t.root, 'fetch', '-q', 'origin', t.base);
  if (!f.ok) say(`fetch origin/${t.base} failed — using what is there: ${f.out.slice(0, 200)}`);
  const before = prepareTree(t, treeDir(t, 'main'), null);
  const after = prepareTree(t, treeDir(t, slug), `design/${slug}`);
  const input = readJson(path.join(stateDir(t, slug), 'input.json'));
  let applied = null;
  // the designer worked in their own clone: their patch is the starting point (the agent then puts it in order)
  if (input?.kind === 'repo' && after.fresh) {
    const p = path.join(stateDir(t, slug), 'input', 'changes.patch');
    const r = fs.statSync(p).size ? tryGit(after.dir, 'apply', '--3way', '--whitespace=nowarn', p) : { ok: true, out: '' };
    const newDir = path.join(stateDir(t, slug), 'input', 'new');
    if (fs.existsSync(newDir)) fs.cpSync(newDir, after.dir, { recursive: true });
    applied = { ok: r.ok, note: r.ok ? 'the designer edits are applied' : `some edits did not apply: ${r.out.slice(0, 400)}` };
  }
  return { slug, branch: `design/${slug}`, before, after, applied };
}

// ── snapshot: what the agent built becomes one commit; the page shows exactly that commit ──
function snapshot(t, slug) {
  const dir = treeDir(t, slug);
  git(dir, 'add', '-A');
  const staged = git(dir, 'diff', '--cached', '--name-only');
  if (staged) git(dir, '-c', 'user.name=workbench handoff', '-c', 'user.email=handoff@workbench.local', 'commit', '-q', '-m', arg('-m', `design: ${slug}`));
  const files = git(dir, 'diff', '--name-only', `origin/${t.base}...HEAD`).split('\n').filter(Boolean);
  return { slug, sha: git(dir, 'rev-parse', 'HEAD'), committed: Boolean(staged), files };
}

// ── compare: the same route, the same viewport, both copies ──
const VIEW = { w: 430, h: 932 };
function regions(list, w, h) {
  const pad = 14;
  let rs = list.map((b) => [...b]);
  for (let merged = true; merged; ) {
    merged = false;
    for (let i = 0; i < rs.length && !merged; i++)
      for (let j = i + 1; j < rs.length && !merged; j++) {
        const [a, b] = [rs[i], rs[j]];
        if (a[0] - pad <= b[2] && b[0] - pad <= a[2] && a[1] - pad <= b[3] && b[1] - pad <= a[3]) {
          rs[i] = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
          rs.splice(j, 1);
          merged = true;
        }
      }
  }
  return rs
    .filter(([x0, y0, x1, y1]) => (x1 - x0) * (y1 - y0) > 64)
    .sort((a, b) => a[1] - b[1])
    .slice(0, 12)
    .map(([x0, y0, x1, y1]) => ({ x: x0 / w, y: y0 / h, w: (x1 - x0 + 1) / w, h: (y1 - y0 + 1) / h }));
}
const captureScreen = (url, file) => execFileSync(process.execPath, [path.join(HOME, 'scripts/shot-cdp.mjs'), url, file, '9000', String(VIEW.w), String(VIEW.h)], { stdio: 'ignore', timeout: 120_000 });
const normalizedQuery = (query) => {
  const params = new URLSearchParams(query);
  params.sort();
  return params.toString();
};
const comparisonKey = (r) => JSON.stringify([r.route, normalizedQuery(r.query ?? 'wb.data=fixtures')]);

export async function compare(t, slug, routes, {
  query = arg('--query', 'wb.data=fixtures'), startServer = serve, checkBundle = bundleError, capture = captureScreen,
} = {}) {
  query = normalizedQuery(query);
  const st = stateDir(t, slug);
  const shots = path.join(st, 'shots');
  fs.mkdirSync(shots, { recursive: true });
  const sha = git(treeDir(t, slug), 'rev-parse', 'HEAD');
  const base = git(treeDir(t, 'main'), 'rev-parse', 'HEAD');
  const previous = readJson(path.join(st, 'compare.json'));
  const ports = { before: t.cfg.handoff?.ports?.before ?? t.ports.before, after: t.cfg.handoff?.ports?.after ?? t.ports.after };
  const onMain = routesAt(treeDir(t, 'main'));
  const needBefore = routes.some((r) => routeIn(r, onMain));
  say(`"after" copy on :${ports.after}${needBefore ? `, "before" on :${ports.before}` : ''}`);
  await startServer(t, slug, ports.after);
  if (needBefore) await startServer(t, 'main', ports.before);
  const errAfter = await checkBundle(ports.after, routes[0]);
  const errBefore = needBefore ? await checkBundle(ports.before, routes.find((r) => routeIn(r, onMain))) : null;
  const shoot = (port, route, file) => capture(`http://localhost:${port}${route}${route.includes('?') ? '&' : '?'}${query}`, file);
  const res = [];
  for (const route of routes) {
    const label = route.replace(/^\//, '').replace(/[^\w-]+/g, '-').slice(0, 80) || 'root';
    const name = `${label}-${sha256(comparisonKey({ route, query })).slice(0, 12)}`;
    const r = { route, query, name, isNew: !routeIn(route, onMain), after: `shots/${name}.after.png` };
    try {
      if (errAfter) throw new Error(`the new version does not build: ${errAfter}`);
      await shoot(ports.after, route, path.join(st, r.after));
      if (!r.isNew) {
        if (errBefore) throw new Error(`the main version does not build: ${errBefore}`);
        r.before = `shots/${name}.before.png`;
        await shoot(ports.before, route, path.join(st, r.before));
        const c = diffPng(path.join(st, r.before), path.join(st, r.after), path.join(st, `shots/${name}.diff.png`));
        r.diff = `shots/${name}.diff.png`;
        r.changed = Math.round(c.changed_frac * 1000) / 10;
        r.regions = regions(c.boxes, c.size[0], c.size[1]);
      }
    } catch (e) {
      r.error = String(e.message ?? e).slice(0, 400);
    }
    res.push(r);
    say(`${route}?${query}: ${r.error ?? (r.isNew ? 'new screen' : `${r.changed}% of the screen, regions ${r.regions.length}`)}`);
  }
  // Keep other conditions only when both copies and the viewport still match. A retry replaces its own condition.
  const sameRevision = previous?.sha === sha && previous.base === base
    && previous.viewport?.w === VIEW.w && previous.viewport?.h === VIEW.h;
  const combined = new Map((sameRevision ? previous.routes : []).map((r) => [comparisonKey(r), r]));
  for (const r of res) combined.set(comparisonKey(r), r);
  const v = { slug, sha, base, at: new Date().toISOString(), viewport: VIEW, routes: [...combined.values()] };
  writeJson(path.join(st, 'compare.json'), v);
  return v;
}

// ── checks: what's missing around the screen; a check that couldn't run is «unknown», never «ok» ──
function npm(dir, script, args = [], timeout = 900_000) {
  const r = spawnSync('npm', ['run', '-s', script, ...(args.length ? ['--', ...args] : [])], { cwd: dir, encoding: 'utf8', timeout, maxBuffer: 64 << 20 });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, timedOut: r.error?.code === 'ETIMEDOUT' };
}
/** Problem lines of a tool's output, without line numbers (a moved line is the same problem). */
const problems = (out) => new Set(out.split('\n').map((l) => l.trim().replace(/(\.\w+):\d+(:\d+)?\b/g, '$1').replace(/^\d+\s+/, '').replace(/\s+/g, ' ')).filter((l) => /error|warning|✗|⚠|✖|DS-|fail/i.test(l) && !/^Design system:|^By rule:|^npm (error|ERR)/.test(l)));
/** What this work added: problems in the copy that main doesn't have (main's own debt is not the designer's). */
const added = (after, before) => [...problems(after)].filter((l) => !problems(before).has(l));
/**
 * The design analysis (design-implement, or the agent in step 3): what each screen needs —
 * .workbench-cache/designs/<slug>/decision.json
 *   { "screens": { "/route": { "files": ["…"], "backend": { "needed": false, "why": "text only" } |
 *                                               { "needed": true, "ok": ["…"], "missing": ["…"] },
 *                              "ds": ["what the layout asked for that the design system doesn't have"] } } }
 * The older one-screen shape { screen, backend: {ok, missing}, ds: {missing} } still reads, for its screen only.
 */
function analysisOf(dir, slug) {
  const d = readJson(path.join(dir, '.workbench-cache/designs', slug, 'decision.json'));
  if (!d) return {};
  if (d.screens) return d.screens;
  return d.screen ? { [d.screen]: { files: d.files, backend: { needed: true, ok: d.backend?.ok ?? [], missing: [...(d.backend?.missing ?? []), ...(d.missing ?? [])] }, ds: d.ds?.missing ?? [] } } : {};
}
const text = (x) => (typeof x === 'string' ? x : x?.what ?? x?.field ?? JSON.stringify(x));

function checks(t, slug, routes) {
  const dir = treeDir(t, slug);
  const main = treeDir(t, 'main');
  const pkg = readJson(path.join(dir, 'package.json'), {});
  const has = (s) => Boolean(pkg.scripts?.[s]);
  const changed = git(dir, 'diff', '--name-only', `origin/${t.base}...HEAD`).split('\n').filter(Boolean);
  const isCode = (f) => /\.(tsx?|jsx?)$/.test(f) && fs.existsSync(path.join(dir, f));
  const screens = analysisOf(dir, slug);
  const forks = readJson(path.join(dir, 'mobile-forks.json'), {});
  let mob = null;
  if (t.mobile) {
    tryGit(t.mobile, 'fetch', '-q', 'origin');
    mob = routesAt(t.mobile, 'origin/main');
  }
  const onMain = routesAt(main);

  /** New design-system problems in these files (main's own debt is not counted). */
  function ds(files, notes) {
    const code = files.filter(isCode);
    let c;
    if (!has('ds:lint')) c = { status: code.length ? 'unknown' : 'ok', summary: code.length ? 'the repo has no ds:lint' : 'no code changed', items: [] };
    else if (!code.length) c = { status: 'ok', summary: 'no code of this screen changed', items: [] };
    else {
      const r = npm(dir, 'ds:lint', code, 300_000);
      const old = code.filter((f) => fs.existsSync(path.join(main, f)));
      const b = old.length ? npm(main, 'ds:lint', old, 300_000) : { out: '' };
      const fresh = added(r.out, b.out);
      const ran = /\d+ error\(s\) · \d+ warning\(s\)|No design-system violations/.test(r.out);
      c = { status: !ran ? 'unknown' : fresh.length ? 'missing' : 'ok', summary: !ran ? 'the check did not run' : fresh.length ? `new violations ${fresh.length} (what main already had is not counted)` : 'no new violations', items: fresh.slice(0, 12) };
    }
    if (notes.length) c = { status: c.status === 'unknown' ? 'unknown' : 'missing', summary: `${c.summary}; from the design analysis: ${notes.length}`, items: [...notes, ...c.items] };
    return { title: 'Design system', ...c };
  }
  /** What the screen needs from the backend — from the analysis, or the screen's backend-gaps map; else "not checked". */
  function backend(route, a) {
    const title = 'Backend';
    if (a?.backend?.needed === false) return { title, status: 'ok', summary: `not needed${a.backend.why ? `: ${a.backend.why}` : ''}`, items: [] };
    if (a?.backend) {
      const miss = (a.backend.missing ?? []).map(text).slice(0, 12);
      return { title, status: miss.length ? 'missing' : 'ok', summary: miss.length ? `missing on the dev backend: ${miss.length}` : 'everything the screen needs is there', items: [...miss, ...(a.backend.ok ?? []).map((x) => `there: ${text(x)}`)].slice(0, 12) };
    }
    const gf = path.join(dir, 'knowledge-base/backend-gaps', `${route.replace(/^\//, '').replace(/[^\w-]+/g, '-')}.json`);
    if (fs.existsSync(gf)) {
      const blocks = readJson(gf, {}).blocks ?? [];
      const miss = blocks.filter((x) => x.status === 'missing' || x.status === 'partial');
      return { title, status: miss.length ? 'missing' : 'ok', summary: `${blocks.filter((x) => x.status === 'ok').length} of ${blocks.length} there`, items: miss.map((x) => `${x.title}: ${x.status === 'missing' ? 'missing' : 'fields missing'}${x.missing?.length ? ` (${x.missing.slice(0, 3).join(', ')})` : ''}`).slice(0, 12) };
    }
    return { title, status: 'unknown', summary: 'not checked: no analysis of this screen and no backend map for it', items: [] };
  }
  /** Mobile: does the screen exist there, which mobile files change / are new (new design screens are expected). */
  function mobile(route, files) {
    const title = 'Mobile';
    if (!mob) return { title, status: 'unknown', summary: 'no mobile clone found', items: [] };
    const touched = files.filter((f) => forks[f]).map((f) => forks[f].origin ?? f);
    const fresh = files.filter((f) => !forks[f] && /^src\/(?!web\/).+\.(tsx?|jsx?)$/.test(f));
    const there = routeIn(route, mob);
    return {
      title,
      status: !there && routeIn(route, onMain) ? 'missing' : 'ok',
      summary: `${there ? 'the screen exists in mobile' : 'a new screen — it goes to mobile with the port'}; mobile files changed ${touched.length}, new ${fresh.length}`,
      items: [...touched.slice(0, 8).map((f) => `changes ${f}`), ...fresh.slice(0, 8).map((f) => `new ${f}`)],
    };
  }

  // files of each screen: from the analysis; without it every screen is judged by all changed files
  const perRoute = {};
  for (const route of routes) {
    const a = screens[route];
    const files = Array.isArray(a?.files) && a.files.length ? a.files.filter((f) => changed.includes(f)) : changed;
    perRoute[route] = { files, ds: ds(files, (a?.ds ?? []).map(text)), backend: backend(route, a), mobile: mobile(route, files) };
  }

  // the repo's own definition of done — one for the whole work
  let check;
  if (has('check') && !flag('--no-check')) {
    const r = npm(dir, 'check', [], 900_000);
    if (r.ok) check = { status: 'ok', summary: 'green', items: [] };
    else if (r.timedOut) check = { status: 'unknown', summary: 'did not finish in 15 minutes', items: [] };
    else {
      // red: is it this work, or is main red the same way?
      const b = npm(main, 'check', [], 900_000);
      const fresh = added(r.out, b.out);
      check = b.ok
        ? { status: 'missing', summary: 'red (green in main)', items: (fresh.length ? fresh : r.out.trim().split('\n').slice(-10)).slice(0, 12) }
        : { status: fresh.length ? 'missing' : 'ok', summary: fresh.length ? `red; new problems ${fresh.length} (main is red too)` : 'red the same way as main — no new problems', items: fresh.slice(0, 12) };
    }
  } else check = { status: 'unknown', summary: has('check') ? 'skipped (--no-check)' : 'the repo has no npm run check', items: [] };

  const v = { slug, sha: git(dir, 'rev-parse', 'HEAD'), at: new Date().toISOString(), changed, routes: perRoute, check: { title: 'Repo checks (npm run check)', ...check } };
  writeJson(path.join(stateDir(t, slug), 'checks.json'), v);
  return v;
}

// ── page: the decision page (HTML + pictures as files beside it) ──
function page(t, slug) {
  const st = stateDir(t, slug);
  const cmp = readJson(path.join(st, 'compare.json'));
  const chk = readJson(path.join(st, 'checks.json'));
  const input = readJson(path.join(st, 'input.json'), {});
  if (!cmp) throw new Error('run compare first');
  if (chk && chk.sha !== cmp.sha) throw new Error('checks and compare ran on different commits — run both again');
  const dir = path.join(st, 'page');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'shots'), { recursive: true });
  const files = {};
  for (const r of cmp.routes)
    for (const k of ['before', 'after', 'diff'])
      if (r[k] && fs.existsSync(path.join(st, r[k]))) {
        fs.copyFileSync(path.join(st, r[k]), path.join(dir, r[k]));
        files[r[k]] = path.join(dir, r[k]);
      }
  const data = {
    slug,
    sha: cmp.sha,
    branch: `design/${slug}`,
    repo: t.gh ?? t.name,
    title: arg('--title', input.note || slug),
    summary: arg('--summary', ''),
    routes: cmp.routes,
    checks: chk?.routes ?? {}, // per screen: ds · backend · mobile
    check: chk?.check ?? null, // the whole work: npm run check
    changed: chk?.changed ?? [],
    task: arg('--task') ? { id: arg('--task'), url: arg('--task-url', '') } : null,
    at: cmp.at,
  };
  const tpl = fs.readFileSync(path.join(HOME, 'scripts/page.html'), 'utf8');
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  // function replacers: «$» in the data must not be read as a replacement pattern
  const html = tpl.replace('/*__DATA__*/null', () => json).replace('__TITLE__', () => `Before and after: ${data.title}`.replace(/[<&]/g, ''));
  fs.writeFileSync(path.join(dir, 'index.html'), html);
  return { slug, sha: cmp.sha, page: path.join(dir, 'index.html'), files, capabilities: { comments: {}, db: {}, user: {} } };
}

// ── push: only the commit the person saw; an existing PR is reused, never duplicated; never main ──
function push(t, slug) {
  const dir = treeDir(t, slug);
  const branch = `design/${slug}`;
  const sha = arg('--sha');
  if (!sha) throw new Error('--sha: the commit from the page');
  const head = git(dir, 'rev-parse', 'HEAD');
  // the page's commit, or the page's commit + only the Linear link (knowledge-base/linear.json)
  const linkOnly = () => {
    const parent = tryGit(dir, 'rev-parse', 'HEAD~1').out;
    return parent.startsWith(sha) && git(dir, 'diff', '--name-only', 'HEAD~1', 'HEAD') === 'knowledge-base/linear.json';
  };
  if (!head.startsWith(sha) && !linkOnly()) throw new Error(`the page has commit ${sha.slice(0, 8)}, the copy is at ${head.slice(0, 8)} — there were edits after the page. Publish the page again`);
  // the Linear task this work belongs to (made by the main handoff skill): its id goes into the PR title
  const lin = arg('--task') ? { id: arg('--task'), url: arg('--task-url', '') } : null;
  if (git(dir, 'status', '--porcelain')) throw new Error('the copy has uncommitted edits — snapshot and a new page first');
  if (git(dir, 'rev-parse', '--abbrev-ref', 'HEAD') !== branch) throw new Error(`the copy is not on branch ${branch}`);
  // the PR shows the before/after and the checks of exactly this commit — never of an earlier snapshot
  const shown = git(dir, 'rev-parse', `${sha}^{commit}`);
  const cmp = readJson(path.join(stateDir(t, slug), 'compare.json'));
  const chk = readJson(path.join(stateDir(t, slug), 'checks.json'));
  if (!cmp || cmp.sha !== shown) throw new Error(`compare did not run on ${shown.slice(0, 8)} — run compare and checks on this commit first`);
  if (chk && chk.sha !== shown) throw new Error(`checks ran on ${String(chk.sha).slice(0, 8)}, not on ${shown.slice(0, 8)} — run checks on this commit first`);
  const remote = arg('--remote', 'origin');
  const isGh = /github\.com/.test(tryGit(dir, 'config', '--get', `remote.${remote}.url`).out); // the configured URL, as written
  const prOn = isGh && !flag('--no-pr');
  let pr = null;
  if (prOn) {
    const r = spawnSync('gh', ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'url', '--limit', '1'], { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`could not check whether a PR already exists: ${(r.stderr || r.stdout).slice(0, 300)}`);
    pr = JSON.parse(r.stdout || '[]')[0]?.url ?? null;
  }
  const p = tryGit(dir, 'push', '-u', remote, `${branch}:${branch}`);
  if (!p.ok) throw new Error(`push failed: ${p.out.slice(0, 400)}`);
  if (prOn && !pr) {
    const mark = (c) => (c.status === 'ok' ? '✅' : c.status === 'missing' ? '⚠️' : '❔');
    const lines = [
      ...Object.entries(chk?.routes ?? {}).flatMap(([r, c]) => [`**${r}**`, ...['ds', 'backend', 'mobile'].map((k) => `- ${mark(c[k])} ${c[k].title}: ${c[k].summary}`)]),
      ...(chk?.check ? [`- ${mark(chk.check)} ${chk.check.title}: ${chk.check.summary}`] : []),
    ];
    const body = [arg('--summary', ''), '', lin ? `Linear: ${lin.url ? `[${lin.id}](${lin.url})` : lin.id}` : '', '', '## Before / after', ...cmp.routes.map((r) => `- \`${r.route}\`${r.query ? ` (data: \`${r.query}\`)` : ''}: ${r.error ? `not compared — ${r.error}` : r.isNew ? 'a new screen' : `${r.changed}% of the screen changed, regions ${r.regions?.length ?? 0}`}`), arg('--artifact') ? `Decision page: ${arg('--artifact')}` : '', '', chk ? '' : '_The checks did not run._', '', '## What is missing around the screen', ...lines, '', `The commit the designer saw: \`${head.slice(0, 8)}\`.`, '', '_Prepared by workbench-handoff on "Push to design" on the page._'].join('\n');
    const r = spawnSync('gh', ['pr', 'create', '--base', t.base, '--head', branch, '--title', `${lin ? `[${lin.id}] ` : ''}Design: ${arg('--title', slug)}`, '--body', body], { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`PR not created: ${(r.stderr || r.stdout).slice(0, 300)}`);
    pr = r.stdout.trim().split('\n').pop();
  }
  const v = { slug, branch, sha: head, pushed: true, pr, linear: lin ? { id: lin.id, url: lin.url } : null, note: prOn ? null : isGh ? 'no PR created (--no-pr)' : 'the remote is not GitHub — no PR' };
  writeJson(path.join(stateDir(t, slug), 'push.json'), { ...v, at: new Date().toISOString() });
  return v;
}

async function main() {
  if (cliHelp(argv, import.meta.url)) return;
  const t = target(arg('--target'));
  if (t.light && !['status', 'stop'].includes(cmd)) throw new Error('pushing to the design repo needs the full mode: "set up handoff fully" (node scripts/setup.mjs run)');
  const slug = arg('--slug');
  const routes = String(arg('--routes', '')).split(',').filter(Boolean);
  switch (cmd) {
    case 'capture':
      return out(capture(t, need(slug)));
    case 'prepare':
      return out(prepare(t, need(slug)));
    case 'snapshot':
      return out(snapshot(t, need(slug)));
    case 'compare':
      if (!routes.length) throw new Error('--routes /screen,…');
      return out(await compare(t, need(slug), routes));
    case 'checks':
      return out(checks(t, need(slug), routes));
    case 'page':
      return out(page(t, need(slug)));
    case 'push':
      return out(push(t, need(slug)));
    case 'stop':
      return out(stopAll(t));
    case 'status':
      return out({ target: t.root, gh: t.gh, work: t.work, mobile: t.mobile, ports: t.ports, slugs: fs.existsSync(path.join(t.work, 'state')) ? fs.readdirSync(path.join(t.work, 'state')).filter((x) => slugOk(x)) : [] });
    default:
      console.error('commands: capture · prepare · snapshot · compare · checks · page · push · stop · status (details in the file header)');
      process.exit(2);
  }
}
if (isMain(import.meta.url)) main().catch((e) => {
  console.error(`✗ ${e.message ?? e}`);
  process.exit(1);
});
