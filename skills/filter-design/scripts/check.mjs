#!/usr/bin/env node
// The filter: a design through the design system (tokens), the backend and the real mobile app.
//   node scripts/check.mjs tokens <design.html …>             colors / fonts / spacing / radius against the repo's theme
//   node scripts/check.mjs api --find <words…>                  what the dev backend offers (its live OpenAPI)
//   node scripts/check.mjs mobile --route </r> [--words "…"]    is the screen in mobile; similar components (npm run reuse)
//   node scripts/check.mjs batch --batch <b>                    all of it for every design of a batch → checks.json
// Common: --target <design repo>. A check that couldn't run says "not checked", never "ready".
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { cliHelp, isMain, readJson, routeIn, routesAt, routesRemote, say, target, treeDir, tryGit, writeJson } from './lib.mjs';
import { audit, themeOf } from './tokens.mjs';

const argv = process.argv.slice(2);
const arg = (k, d = null) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const out = (v) => console.log(JSON.stringify(v));

/** The dev backend's OpenAPI, cached for an hour next to the copies. */
export async function openapi(t) {
  const base = t.cfg.handoff?.openapi ?? (t.cfg.dev?.backend?.api ? `${t.cfg.dev.backend.api.replace(/\/$/, '')}/v1/openapi.json` : null);
  if (!base) throw new Error('the dev backend address is not set (workbench.config.json → dev.backend.api or handoff.openapi)');
  const cache = path.join(t.work, 'state', 'openapi.json');
  if (fs.existsSync(cache) && Date.now() - fs.statSync(cache).mtimeMs < 3_600_000) return readJson(cache);
  const r = await fetch(base, { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`the dev backend OpenAPI answered ${r.status}`);
  const j = await r.json();
  writeJson(cache, j);
  return j;
}
/** Endpoints and schema fields that mention any of the words. */
export function findApi(spec, words) {
  const ws = words.map((w) => w.toLowerCase());
  const hit = (s) => ws.some((w) => String(s ?? '').toLowerCase().includes(w));
  const paths = [];
  for (const [p, ops] of Object.entries(spec.paths ?? {}))
    for (const [m, op] of Object.entries(ops)) if (hit(p) || hit(op.summary) || hit(op.operationId)) paths.push(`${m.toUpperCase()} ${p}${op.summary ? ` — ${op.summary}` : ''}`);
  const fields = [];
  for (const [name, sch] of Object.entries(spec.components?.schemas ?? {})) for (const f of Object.keys(sch.properties ?? {})) if (hit(f)) fields.push(`${name}.${f}`);
  return { words, paths: paths.slice(0, 30), fields: fields.slice(0, 30) };
}

const remoteRoutes = new Map();
export function mobileCheck(t, route, words = '') {
  let mob;
  if (t.mobile) {
    tryGit(t.mobile, 'fetch', '-q', 'origin');
    mob = routesAt(t.mobile, 'origin/main');
  } else if (t.mobileRepo) {
    // no clone (light mode): mobile's screens straight from GitHub
    try {
      if (!remoteRoutes.has(t.mobileRepo)) remoteRoutes.set(t.mobileRepo, routesRemote(t.mobileRepo));
      mob = remoteRoutes.get(t.mobileRepo);
    } catch (e) {
      return { status: 'unknown', summary: `cannot read mobile from GitHub: ${String(e.message).slice(0, 120)}`, items: [] };
    }
  } else return { status: 'unknown', summary: 'mobile is not connected', items: [] };
  const there = routeIn(route, mob);
  const items = [];
  const main = fs.existsSync(treeDir(t, 'main')) ? treeDir(t, 'main') : t.root;
  const pkg = t.light ? {} : readJson(path.join(main, 'package.json'), {});
  if (words && pkg.scripts?.reuse) {
    const r = spawnSync('npm', ['run', '-s', 'reuse', '--', ...words.split(/\s+/).filter(Boolean)], { cwd: main, encoding: 'utf8', timeout: 120_000 });
    items.push(...String(r.stdout ?? '').split('\n').filter((l) => /src\//.test(l)).slice(0, 5).map((l) => `similar in mobile: ${l.trim().slice(0, 140)}`));
  }
  return { status: 'ok', there, summary: there ? 'the screen exists in mobile' : 'a new screen — not in mobile yet, it goes there with the port', items };
}

/** Every design of a batch: tokens (its HTML), backend (from the analysis), mobile (its route). */
export async function checkBatch(t, batch) {
  const dir = path.join(t.work, 'state', 'batches', batch);
  const designs = readJson(path.join(dir, 'designs.json'));
  if (!designs) throw new Error('run designs.mjs add/describe first');
  const analysis = readJson(path.join(dir, 'analysis.json'), {});
  const theme = themeOf(treeDir(t, 'main'), t.cfg) ?? themeOf(t.root, t.cfg);
  const res = {};
  for (const d of designs.list.filter((x) => !argv.includes('--ids') || arg('--ids').split(',').includes(x.id))) {
    const a = analysis[d.id] ?? {};
    let ds;
    try {
      const r = await audit(path.join(dir, 'src', d.file), theme);
      ds = r.unknown
        ? { status: 'unknown', summary: r.unknown, items: [] }
        : { status: r.errors.length ? 'missing' : r.warnings.length ? 'warn' : 'ok', summary: `${r.score}% of elements on tokens; errors ${r.errors.length}, notes ${r.warnings.length}`, items: [...(a.ds ?? []), ...r.errors.map((e) => `✕ ${e.what} (${e.count}) — ${e.where.join('; ')}`), ...r.warnings.map((w) => `⚠ ${w.what} (${w.count})`)].slice(0, 12), source: r.theme.files };
    } catch (e) {
      ds = { status: 'unknown', summary: `the check did not run: ${String(e.message).slice(0, 160)}`, items: [] };
    }
    if (a.ds?.length && ds.status === 'ok') ds = { ...ds, status: 'warn' };
    const b = a.backend;
    const backend = b?.needed === false
      ? { status: 'ok', summary: `not needed${b.why ? `: ${b.why}` : ''}`, items: [] }
      : b
        ? { status: (b.missing ?? []).length ? 'missing' : 'ok', summary: (b.missing ?? []).length ? `missing on the dev backend: ${b.missing.length}` : 'everything needed is there', items: [...(b.missing ?? []).map((x) => `✕ ${x}`), ...(b.ok ?? []).map((x) => `there: ${x}`)].slice(0, 12) }
        : { status: 'unknown', summary: 'not checked: no analysis for this design', items: [] };
    const mobile = d.route ? mobileCheck(t, d.route, a.words ?? '') : { status: 'unknown', summary: 'the design screen is not known', items: [] };
    res[d.id] = { ds: { title: 'Design system', ...ds }, backend: { title: 'Backend', ...backend }, mobile: { title: 'Mobile', ...mobile } };
    say(`${d.id}: tokens ${ds.status}, backend ${backend.status}, mobile ${mobile.status}`);
  }
  const prev = readJson(path.join(dir, 'checks.json'), {});
  const all = { ...prev, ...res };
  writeJson(path.join(dir, 'checks.json'), all);
  return all;
}

async function main() {
  if (cliHelp(argv, import.meta.url)) return;
  const t = target(arg('--target'));
  const cmd = argv[0];
  if (cmd === 'tokens') {
    const files = argv.slice(1).filter((a, i, all) => !a.startsWith('--') && all[i] !== undefined && argv[argv.indexOf(a) - 1] !== '--target');
    const theme = themeOf(treeDir(t, 'main'), t.cfg) ?? themeOf(t.root, t.cfg);
    const res = [];
    for (const f of files) res.push({ file: f, ...(await audit(f, theme)) });
    return out(res);
  }
  if (cmd === 'api') return out(findApi(await openapi(t), argv.slice(argv.indexOf('--find') + 1).filter((a) => !a.startsWith('--') && a !== arg('--target'))));
  if (cmd === 'mobile') return out(mobileCheck(t, arg('--route', '/'), arg('--words', '')));
  if (cmd === 'batch') return out(await checkBatch(t, arg('--batch')));
  console.error('commands: tokens · api · mobile · batch (details in the file header)');
  process.exit(2);
}
if (isMain(import.meta.url))
  main().catch((e) => {
    console.error(`✗ ${e.message ?? e}`);
    process.exit(1);
  });
