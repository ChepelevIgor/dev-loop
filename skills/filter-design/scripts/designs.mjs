#!/usr/bin/env node
// Several designs at once → one decision page → Linear tasks and/or "Push to design". This file never pushes code itself:
// push-plan says what to push, handoff.mjs builds and pushes it, pushed records the PR on the page and the Linear task.
//   node scripts/designs.mjs auto     --batch <b> --from <file|folder> … [--title "…"] [--engine claude|codex] [--budget 2]
//                                     everything below in one go: an agent (claude -p / codex exec, read-only, JSON schema)
//                                     writes describe / analysis / plan; the plan is validated and sent back once on errors
//   node scripts/designs.mjs add      --batch <b> --from <file|folder> [<file|folder> …]   designs D1, D2, … (copies)
//   node scripts/designs.mjs describe --batch <b> --file <designs.json>   {D1: {title, route, note, condition, query}} — what
//                                     each one is and under which data it is drawn (query: how the app shows that data)
//   node scripts/designs.mjs analysis --batch <b> --file <analysis.json>  {D1: {backend:{needed,why,ok,missing}, ds:[…], words}}
//   node scripts/designs.mjs render   --batch <b> [--ids D1,D2]           design screenshots + "now" of existing screens (under
//                                     each design's condition) + the pixel difference between them
//   node scripts/designs.mjs plan     --batch <b> --file <plan.json>      how the designs split into Linear tasks (validated)
//   node scripts/designs.mjs page     --batch <b> [--title "…"]           the decision page: standalone.html (one file, pictures
//                                     inside — opened in a browser, attached to the tasks) + index.html (for a Claude artifact)
//   node scripts/designs.mjs serve    --batch <b> [--port N] [--wait <sec>] [--open]   the page on 127.0.0.1 with working
//                                     buttons; --wait exits with the first decision (0) or on timeout (3)
//   node scripts/designs.mjs artifact --batch <b> --url <claude.ai link>  the page was published as an artifact: shown on
//                                     the page, attached to the tasks
//   node scripts/designs.mjs attach   --batch <b> --task TASK-1234          attach the page(s) to a task the designer named
//   node scripts/designs.mjs linear   --batch <b> --version <v> --take D1,D3 [--rework D2] [--skip D4] [--dry-run]
//                                     [--record T1=TASK-5@https://…]       create the tasks (once each, pictures inside)
//                                     [--link T1=TASK-12,T2=new]           the page's choice: attach to a found task or create one
//   node scripts/designs.mjs match    --batch <b> [--file <matches.json>] Linear tasks that may already cover each planned task
//                                     (search; without a key the agent searches through MCP and saves them with --file)
//   node scripts/designs.mjs push-plan --batch <b> --version <v> --take … [--rework …] [--skip …]   what "Push to design"
//                                     pushes: one taken design per app task, its copy, a slug, its Linear task
//   node scripts/designs.mjs pushed   --batch <b> --task T1 --pr <url> --branch <b> --sha <commit>   the PR on the page + task
//   node scripts/designs.mjs comment  --batch <b> --task T1 --text "…" [--ids D2]   a rework of a sent design → comment
//   node scripts/designs.mjs status   --batch <b>
// Common: --target <design repo>. The designer's files are only read: designs and their reworks live in copies.
import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { HOME, cliHelp, isMain, readJson, routeIn, routesAt, say, sha256, slugOk, target, treeDir, tryGit, withFileLock, writeJson } from './lib.mjs';
import { shoot } from './cdp.mjs';
import { compare as diffPng } from './img-diff.mjs';
import { bundleError, prepareTree, serve } from './stand.mjs';
import { checkBatch } from './check.mjs';
import { client, linearKey } from './linear.mjs';
import { ensureLinearMcp } from './linear-mcp.mjs';
import { analysisPrompt, describePrompt, planPrompt, runAgent } from './agents.mjs';
import { serveSources } from './source-server.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0];
const arg = (k, d = null) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const list = (k) => String(arg(k, '') || '').split(',').map((x) => x.trim()).filter(Boolean);
const flag = (k) => argv.includes(k);
const out = (v) => console.log(JSON.stringify(v));
const VIEW = { width: 430, height: 932 };
/** How the app is opened for "now" when the design names no reproducible condition. */
export const DEFAULT_QUERY = 'wb.data=fixtures';
const queryOk = (q) => typeof q === 'string' && q.length <= 200 && /^[\w.\-=&%,:]*$/.test(q) && !q.startsWith('&');
/** Data states the design repo can open: knowledge-base/api-recordings/<user>@<state> → ["board@care-empty", …]. */
export function recordedStates(repo) {
  const d = path.join(repo, 'knowledge-base', 'api-recordings');
  return fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name.includes('@')).map((e) => e.name).sort() : [];
}
/** A query naming a wb.user / wb.state the repo has no recording for: the reason, else null. */
export function unknownState(query, states) {
  const q = new URLSearchParams(query || '');
  const st = q.get('wb.state');
  if (!st) return null;
  const user = q.get('wb.user');
  const ok = states.some((s) => s.endsWith(`@${st}`) && (!user || s.startsWith(`${user}@`)));
  return ok ? null : `no recorded state ${user ? `${user}@` : ''}${st} in knowledge-base/api-recordings`;
}
/** Does the query open the design's condition: a wb.state the repo has a recording for. */
export const conditionMatched = (query, states) => Boolean(new URLSearchParams(query || '').get('wb.state')) && !unknownState(query, states);
/** The condition a design is drawn under, as a key: variants share it, states of one screen differ in it. */
export const conditionKey = (x) => String(x?.condition ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

const bdir = (t, b) => path.join(t.work, 'state', 'batches', b);
function batchOf(t) {
  const b = arg('--batch');
  if (!slugOk(b)) throw new Error('--batch: latin letters, digits and dashes (e.g. onboarding-oct)');
  return b;
}
const designsOf = (t, b) => readJson(path.join(bdir(t, b), 'designs.json')) ?? { list: [] };
const comparisonKey = (x) => JSON.stringify([x.route, x.query || DEFAULT_QUERY, conditionKey(x)]);
function clearComparison(x) {
  for (const k of ['now', 'nowQuery', 'nowFrom', 'nowError', 'diff', 'changed', 'regions', 'diffError']) delete x[k];
  x.matched = false;
}

// ── add: copy each source (the designer's files stay untouched); every HTML file inside is one design ──
function add(t, b) {
  const dir = bdir(t, b);
  const src = path.join(dir, 'src');
  const d = designsOf(t, b);
  const froms = argv.slice(argv.indexOf('--from') + 1).filter((x, i, a) => !x.startsWith('--') && !(i > 0 && a[i - 1].startsWith('--')));
  if (!froms.length) throw new Error('--from <file|folder> …');
  for (const f of froms) {
    const abs = path.resolve(f);
    if (!fs.existsSync(abs)) throw new Error(`no such path: ${abs}`);
    const name = `${String((fs.existsSync(src) ? fs.readdirSync(src).length : 0) + 1).padStart(2, '0')}-${path.basename(abs)}`;
    fs.cpSync(abs, path.join(src, name), { recursive: true, filter: (p) => !/(^|\/)(node_modules|\.git)(\/|$)/.test(p) });
    const htmls = fs.statSync(abs).isDirectory() ? walk(path.join(src, name)).filter((x) => /\.html?$/i.test(x)).map((x) => path.join(name, x)) : [name];
    for (const h of htmls) d.list.push({ id: `D${d.list.length + 1}`, file: h, from: fs.statSync(abs).isDirectory() ? path.join(abs, path.relative(name, h)) : abs, title: path.basename(h).replace(/\.html?$/i, ''), route: null });
  }
  writeJson(path.join(dir, 'designs.json'), d);
  return d;
}
function walk(dir, rel = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name), `${rel}${e.name}/`) : [`${rel}${e.name}`]));
}

// ── describe / analysis: what the agent understood about each design ──
function describe(t, b) {
  const j = readJson(path.resolve(arg('--file')));
  if (!j) throw new Error('--file <json>');
  return describeWith(t, b, j);
}
function describeWith(t, b, j) {
  const d = designsOf(t, b);
  for (const x of d.list) {
    const v = j[x.id];
    if (!v) continue;
    if (v.query != null && v.query !== '' && !queryOk(v.query)) throw new Error(`${x.id}: query must be a URL query without "?" (letters, digits, = & . - _ , : %): ${v.query}`);
    const previous = comparisonKey(x);
    Object.assign(x, { title: String(v.title ?? x.title).slice(0, 120), route: v.route ? String(v.route) : x.route, note: String(v.note ?? '').slice(0, 500),
      condition: v.condition != null ? String(v.condition).trim().slice(0, 200) : x.condition ?? '', query: v.query != null ? String(v.query) : x.query ?? '' });
    if (comparisonKey(x) !== previous) clearComparison(x);
  }
  // A requested condition is not evidence: only a successful shot under that query can match it.
  const states = recordedStates(fs.existsSync(treeDir(t, 'main')) ? treeDir(t, 'main') : t.root);
  for (const x of d.list) x.matched = Boolean(x.now && !x.nowError && x.nowQuery === (x.query || DEFAULT_QUERY) && conditionMatched(x.nowQuery, states));
  // what the design repo has now: the «main» copy, else origin/<base>, else the checkout's HEAD (a repo without a remote)
  const onMain = fs.existsSync(treeDir(t, 'main')) ? routesAt(treeDir(t, 'main')) : tryGit(t.root, 'rev-parse', '--verify', `origin/${t.base}`).ok ? routesAt(t.root, `origin/${t.base}`) : routesAt(t.root, 'HEAD');
  for (const x of d.list) x.isNew = x.route ? !routeIn(x.route, onMain) : null;
  writeJson(path.join(bdir(t, b), 'designs.json'), d);
  return d;
}
function analysis(t, b) {
  const j = readJson(path.resolve(arg('--file')));
  if (!j) throw new Error('--file <json>');
  return analysisWith(t, b, j);
}
function analysisWith(t, b, j) {
  const prev = readJson(path.join(bdir(t, b), 'analysis.json'), {});
  writeJson(path.join(bdir(t, b), 'analysis.json'), { ...prev, ...j });
  return { ...prev, ...j };
}

// ── render: the design itself (its HTML) and the screen as it is now (main), at the same viewport ──
export async function render(t, b, {
  ids = list('--ids'), capture = shoot, prepare = prepareTree, startServer = serve, checkBundle = bundleError,
} = {}) {
  const dir = bdir(t, b);
  const d = designsOf(t, b);
  const todo = d.list.filter((x) => !ids.length || ids.includes(x.id));
  // "now" is shared by designs of the same screen and query, including variants outside --ids.
  const open = (x) => `${x.route}?${x.query || DEFAULT_QUERY}`;
  const existing = [...new Set(todo.filter((x) => x.route && x.isNew === false).map(open))];
  const compared = d.list.filter((x) => todo.includes(x) || (x.isNew === false && existing.includes(open(x))));
  // Persist invalidation before any fallible work, including preparing main and taking design shots.
  for (const x of compared) clearComparison(x);
  writeJson(path.join(dir, 'designs.json'), d);
  let mainHead = null;
  if (t.light) tryGit(t.root, 'pull', '-q', '--depth', '1', '--rebase=false'); // the light copy follows main
  else {
    tryGit(t.root, 'fetch', '-q', 'origin', t.base);
    mainHead = prepare(t, treeDir(t, 'main'), null).head;
  }
  for (const x of todo) {
    await capture(pathToFileURL(path.join(dir, 'src', x.file)).href, path.join(dir, 'shots', `${x.id}.png`), { ...VIEW, wait: 1500 });
    x.shot = `shots/${x.id}.png`;
    say(`${x.id}: design shot`);
  }
  // "now" is opened under the same condition as the design (its query), one shot per screen and condition
  if (existing.length && t.light) for (const x of compared.filter((y) => existing.includes(open(y)))) x.nowError = 'light mode: no "now" shot (full mode: "set up handoff fully")';
  else if (existing.length) {
    const port = t.cfg.handoff?.ports?.before ?? t.ports.before;
    const states = recordedStates(treeDir(t, 'main'));
    let err;
    try {
      await startServer(t, 'main', port);
      const buildError = await checkBundle(port, existing[0].split('?')[0]);
      if (buildError) err = `the main version does not build: ${buildError}`;
    } catch (e) {
      err = `could not open the main version: ${String(e.message ?? e).slice(0, 300)}`;
    }
    for (const u of existing) {
      const [r, q] = u.split('?');
      const file = `shots/now-${r.replace(/^\//, '').replace(/[^\w-]+/g, '-') || 'root'}${q === DEFAULT_QUERY ? '' : `-${sha256(q).slice(0, 8)}`}.png`;
      const same = compared.filter((x) => x.isNew === false && open(x) === u);
      try {
        if (err) throw new Error(err);
        await capture(`http://localhost:${port}${u}`, path.join(dir, file), { ...VIEW, wait: 9000 });
        // where "now" comes from, so a person can open the same screen and check it: repo, branch, commit, address
        const nowFrom = { repo: t.gh ?? t.name, ref: t.base, sha: mainHead ?? null, url: `http://localhost:${port}${u}`, at: new Date().toISOString() };
        for (const x of same) Object.assign(x, { now: file, nowQuery: q, nowFrom, matched: conditionMatched(q, states) });
        say(`${u}: "now" shot`);
      } catch (e) {
        for (const x of same) x.nowError = String(e.message ?? e).slice(0, 400);
      }
    }
  }
  for (const x of compared) diffOf(dir, x);
  writeJson(path.join(dir, 'designs.json'), d);
  return d;
}

/**
 * Pixel perfect: the design against "now", pixel by pixel (img-diff) → the diff picture, the changed share and the
 * changed regions (0–1 of the screen). A failed comparison is recorded, never thrown: the page shows why.
 */
export function diffOf(dir, x) {
  for (const k of ['diff', 'changed', 'regions', 'diffError']) delete x[k];
  if (!x.shot || !x.now || !fs.existsSync(path.join(dir, x.shot)) || !fs.existsSync(path.join(dir, x.now))) return x;
  try {
    const c = diffPng(path.join(dir, x.now), path.join(dir, x.shot), path.join(dir, 'shots', `diff-${x.id}.png`));
    const [w, h] = c.size;
    Object.assign(x, { diff: `shots/diff-${x.id}.png`, changed: Math.round(c.changed_frac * 1000) / 10,
      regions: c.boxes.slice(0, 12).map(([x0, y0, x1, y1]) => ({ x: x0 / w, y: y0 / h, w: (x1 - x0 + 1) / w, h: (y1 - y0 + 1) / h })) });
  } catch (e) {
    x.diffError = String(e.message ?? e).slice(0, 200);
  }
  return x;
}

// ── business review: what every task must say before it goes to Linear ──
const GAP_KINDS = ['design', 'data', 'product'];
const filled = (x) => typeof x === 'string' && x.trim().length > 0;
export function reviewErrors(tk) {
  const r = tk.review;
  const id = tk.id ?? '?';
  if (!r || typeof r !== 'object') return [`${id}: no business review (metric, summary, dod, cases, gaps)`];
  const errs = [];
  const gaps = Array.isArray(r.gaps) ? r.gaps : null;
  if (!gaps) errs.push(`${id}: review.gaps must be a list (empty when nothing is missing)`);
  else for (const g of gaps) if (!GAP_KINDS.includes(g?.kind) || !filled(g?.text)) errs.push(`${id}: a gap needs kind design|data|product and a text`);
  if (r.metric != null && !filled(r.metric)) errs.push(`${id}: review.metric is empty — give the metric or null with a "product" gap`);
  if (r.metric == null && !gaps?.some((g) => g?.kind === 'product')) errs.push(`${id}: no business metric — ask for it as a "product" gap instead of leaving it out`);
  if (!filled(r.summary) || r.summary.trim().length < 20) errs.push(`${id}: review.summary — a plain description of what changes for the user`);
  if (!Array.isArray(r.dod) || !r.dod.length || !r.dod.every(filled)) errs.push(`${id}: review.dod — at least one Definition of Done item`);
  if (!Array.isArray(r.cases) || !r.cases.length || !r.cases.every((c) => filled(c?.given) && filled(c?.when) && filled(c?.then))) errs.push(`${id}: review.cases — at least one complete Given / When / Then case`);
  return errs;
}
const cleanReview = (r) => ({
  metric: filled(r.metric) ? r.metric.trim().slice(0, 300) : null,
  summary: r.summary.trim().slice(0, 1200),
  dod: r.dod.map((x) => x.trim().slice(0, 300)).slice(0, 12),
  cases: r.cases.map((c) => ({ given: c.given.trim().slice(0, 400), when: c.when.trim().slice(0, 400), then: c.then.trim().slice(0, 400) })).slice(0, 16),
  gaps: r.gaps.map((g) => ({ kind: g.kind, text: g.text.trim().slice(0, 400) })).slice(0, 16),
});
/** Gaps the files show by themselves, next to the agent's: a picture that is not there, a check that found holes. */
export function computedGaps(tk, designs, checks) {
  const out = [];
  for (const x of designs.filter((y) => tk.designs.includes(y.id))) {
    if (!x.shot) out.push({ kind: 'design', text: `${x.id}: no picture of the design`, auto: true });
    // our setup's limitation (light mode, main does not build), not the designer's: shown on the page, kept out of Linear
    if (x.isNew === false && !x.now) out.push({ kind: 'design', text: `${x.id}: no picture of the screen as it is now${x.nowError ? ` (${x.nowError})` : ''}`, auto: true, setup: true });
    if (!x.route) out.push({ kind: 'design', text: `${x.id}: the screen is not known`, auto: true });
    if (!conditionKey(x)) out.push({ kind: 'design', text: `${x.id}: the condition is not stated — under which data the screen looks like this (e.g. no scan history or a history of scans)`, auto: true });
    // "now" was taken under default data, not under the design's condition: the pixel difference mixes in data
    else if (x.isNew === false && x.now && !x.matched) out.push({ kind: 'design', text: `${x.id}: "now" is shown with the default data${x.query ? ` (?${x.query})` : ''}, not under "${x.condition}" — no recorded data state (wb.state) opens this condition, so the comparison includes data differences`, auto: true, setup: true });
    const b = checks[x.id]?.backend;
    if (b?.status === 'missing') out.push({ kind: 'data', text: `${x.id}: the backend lacks what the screen needs — ${b.summary}${b.items?.length ? `: ${b.items.slice(0, 3).join('; ')}` : ''}`, auto: true });
    if (b?.status === 'unknown') out.push({ kind: 'data', text: `${x.id}: whether the backend has the data was not checked — ${b.summary}`, auto: true });
  }
  return out;
}
const allGaps = (tk, designs, checks) => [...(tk.review?.gaps ?? []), ...computedGaps(tk, designs, checks)];

// ── plan: how the designs split into tasks (the agent decides; this enforces the rules) ──
export function validatePlan(plan, designs) {
  const ids = new Set(designs.map((x) => x.id));
  const errs = [];
  if (!Array.isArray(plan?.tasks) || !plan.tasks.length) errs.push('no tasks');
  const client = new Map();
  const taskIds = new Set();
  for (const tk of plan?.tasks ?? []) {
    if (!/^T\d+$/.test(tk.id ?? '')) errs.push(`a task without an id like T1: ${tk.title ?? '?'}`);
    if (taskIds.has(tk.id)) errs.push(`duplicate task id: ${tk.id}`);
    taskIds.add(tk.id);
    if (String(tk.title ?? '').trim().length < 5) errs.push(`${tk.id}: title too short`);
    if (String(tk.body ?? '').trim().length < 20) errs.push(`${tk.id}: no body from the template`);
    if (!['client', 'backend'].includes(tk.side)) errs.push(`${tk.id}: side must be client or backend`);
    if (tk.existing != null && !/^[A-Z][A-Z0-9]*-\d+$/.test(tk.existing)) errs.push(`${tk.id}: existing must be an issue key like TASK-1234`);
    if (!Array.isArray(tk.designs) || !tk.designs.length) errs.push(`${tk.id}: designs is empty`);
    errs.push(...reviewErrors(tk));
    for (const d of tk.designs ?? []) {
      if (!ids.has(d)) errs.push(`${tk.id}: no design ${d}`);
      if (tk.side === 'client') client.set(d, [...(client.get(d) ?? []), tk.id]);
    }
  }
  for (const d of ids) {
    const n = client.get(d)?.length ?? 0;
    if (n === 0) errs.push(`${d} is in no app task`);
    if (n > 1) errs.push(`${d} is in several app tasks: ${client.get(d).join(', ')}`);
  }
  // designs of one screen are alternatives: one client task, never two tasks for the same screen
  const byRoute = new Map();
  for (const x of designs.filter((y) => y.route)) byRoute.set(x.route, [...(byRoute.get(x.route) ?? []), x.id]);
  for (const [r, ds] of byRoute) {
    const tasks = new Set(ds.flatMap((d) => client.get(d) ?? []));
    if (tasks.size > 1) errs.push(`screen ${r}: variants ${ds.join(', ')} are split across tasks (${[...tasks].join(', ')}) — variants of one screen are one task`);
  }
  return errs;
}
function plan(t, b) {
  return planWith(t, b, readJson(path.resolve(arg('--file'))));
}
function planWith(t, b, p) {
  const errs = validatePlan(p, designsOf(t, b).list);
  if (errs.length) throw new Error(`the plan is not valid:\n- ${errs.join('\n- ')}`);
  const v = { tasks: p.tasks.map((tk) => ({ id: tk.id, title: String(tk.title).trim().slice(0, 240), side: tk.side, kind: ['feature', 'bug', 'chore'].includes(tk.kind) ? tk.kind : 'feature', designs: tk.designs, body: String(tk.body).trim(), team: tk.team ?? t.cfg.linear?.team ?? null, labels: (tk.labels ?? []).map(String).slice(0, 8), why: String(tk.why ?? '').slice(0, 300), existing: tk.existing ?? null, review: cleanReview(tk.review) })) };
  if (v.tasks.some((tk) => !tk.team)) throw new Error('no Linear team: team in the plan or workbench.config.json → linear.team');
  writeJson(path.join(bdir(t, b), 'plan.json'), v);
  return v;
}

/** Approval covers the designs, plan, checks and the exact screenshots the person sees. */
function version(t, b) {
  const dir = bdir(t, b);
  const h = [];
  for (const f of walk(path.join(dir, 'src')).sort()) h.push(`${f}:${sha256(fs.readFileSync(path.join(dir, 'src', f)))}`);
  const d = designsOf(t, b);
  h.push(JSON.stringify(d.list));
  for (const f of ['plan.json', 'checks.json']) h.push(`${f}:${fs.existsSync(path.join(dir, f)) ? sha256(fs.readFileSync(path.join(dir, f))) : 'missing'}`);
  for (const x of d.list) for (const k of ['shot', 'now', 'diff']) {
    const f = x[k] && path.join(dir, x[k]);
    h.push(`${x.id}:${k}:${f && fs.existsSync(f) ? sha256(fs.readFileSync(f)) : 'missing'}`);
  }
  return sha256(h.join('\n')).slice(0, 12);
}

// ── auto: the whole handoff with an agent doing the judgment steps (no JSON written by hand) ──
async function auto(t, b) {
  if (argv.includes('--from')) add(t, b);
  const dir = bdir(t, b);
  const engine = arg('--engine') ?? undefined;
  const budget = Number(arg('--budget', 2));
  const noRender = flag('--no-render');
  let cost = 0;
  const log = [];
  const ask = (step, prompt, extra = {}) => {
    say(`${step}: asking the agent`);
    const r = runAgent({ step, prompt, engine, budget, ...extra });
    cost += r.cost ?? 0;
    log.push(step);
    return r.value;
  };
  const byId = (list, what) => {
    const ids = designsOf(t, b).list.map((x) => x.id);
    const m = Object.fromEntries((list ?? []).filter((x) => ids.includes(x.id)).map((x) => [x.id, x]));
    const lost = ids.filter((id) => !m[id]);
    if (lost.length) throw new Error(`the ${what} agent skipped ${lost.join(', ')}`);
    return m;
  };
  // 1. the designs themselves (routes are not known yet, so no «now» shots)
  if (!noRender) await render(t, b);
  const base = !t.light && fs.existsSync(treeDir(t, 'main')) ? treeDir(t, 'main') : t.root;
  // 2. what each design is
  let d = designsOf(t, b);
  const desc = byId(ask('describe', describePrompt({ designs: d.list, dir, routes: routesAt(base), states: recordedStates(base), registry: fs.existsSync(path.join(base, 'src/web/registry')) ? path.join(base, 'src/web/registry') : null }), { cwd: base, addDirs: [dir] }).designs, 'describe');
  for (const x of Object.values(desc)) if (!/^\/[\w\-/[\]]*$/.test(x.route)) throw new Error(`${x.id}: the agent gave no usable route (${x.route})`);
  // a query the app could not take is dropped: "now" falls back to the default data and the page says so
  for (const x of Object.values(desc)) if (x.query && !queryOk(x.query.replace(/^\?/, ''))) x.query = '';
  for (const x of Object.values(desc)) if (x.query) x.query = x.query.replace(/^\?/, '');
  // a state the repo has no recording for would open an empty screen: no query, the page says the data differs
  for (const x of Object.values(desc)) if (x.query && unknownState(x.query, recordedStates(base))) x.query = '';
  describeWith(t, b, desc);
  // 3. «now» of the existing screens
  if (!noRender) await render(t, b);
  d = designsOf(t, b);
  // 4. backend and design-system needs (the live API through check.mjs)
  const checkScript = path.join(HOME, 'scripts/check.mjs');
  const an = byId(ask('analysis', analysisPrompt({ designs: d.list, dir, describe: desc, checkScript, repoDir: base }), { cwd: base, addDirs: [dir], allowed: `Read,Glob,Grep,Bash(node ${checkScript} api:*)` }).designs, 'analysis');
  analysisWith(t, b, Object.fromEntries(Object.entries(an).map(([id, x]) => [id, { backend: x.backend.needed ? { needed: true, why: x.backend.why, ok: x.backend.ok, missing: x.backend.missing } : { needed: false, why: x.backend.why }, ds: x.ds, words: x.words }])));
  // 5. the filter
  if (!flag('--no-check')) await checkBatch(t, b);
  // 6. the split into tasks — validated; refused once → back to the agent with the errors
  const checks = readJson(path.join(dir, 'checks.json'), {});
  const tf = path.join(base, 'knowledge-base/tasks/issue-templates.md');
  const templates = fs.existsSync(tf) ? fs.readFileSync(tf, 'utf8').slice(0, 9000) : '';
  let errors = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const p = ask('plan', planPrompt({ designs: d.list, describe: desc, analysis: an, checks, templates, team: t.cfg.linear?.team, errors }), { cwd: base, addDirs: [dir] });
    p.tasks = p.tasks.map((tk) => ({ ...tk, existing: tk.existing || null, team: tk.team || t.cfg.linear?.team }));
    errors = validatePlan(p, d.list);
    if (!errors.length) {
      planWith(t, b, p);
      break;
    }
    if (attempt === 2) throw new Error(`the plan agent could not follow the rules:\n- ${errors.join('\n- ')}`);
  }
  // 7. Linear tasks that may already cover this work (best effort: the page works without them)
  let matched = 'not searched: no Linear key (search through the MCP, then match --file)';
  if (linearKey(t.root)) {
    try {
      await match(t, b);
      matched = 'searched';
    } catch (e) {
      matched = `not searched: ${String(e.message ?? e).slice(0, 200)}`;
    }
  }
  const pg = page(t, b);
  const run = { at: new Date().toISOString(), steps: log, cost: Math.round(cost * 100) / 100, engine: engine ?? process.env.HANDOFF_AGENT ?? 'claude', matched };
  writeJson(path.join(dir, 'auto.json'), run);
  return { ...pg, ...run };
}

// ── page ──
function page(t, b) {
  const dir = bdir(t, b);
  const d = designsOf(t, b);
  const p = readJson(path.join(dir, 'plan.json'));
  if (!p) throw new Error('run plan first');
  const errors = validatePlan(p, d.list);
  if (errors.length) throw new Error(`the plan is not valid:\n- ${errors.join('\n- ')}`);
  const checks = readJson(path.join(dir, 'checks.json'), {});
  const sent = readJson(path.join(dir, 'linear.json'), {});
  const pg = path.join(dir, 'page');
  fs.rmSync(pg, { recursive: true, force: true });
  fs.mkdirSync(path.join(pg, 'shots'), { recursive: true });
  const files = {};
  for (const x of d.list)
    for (const k of ['shot', 'now', 'diff'])
      if (x[k] && fs.existsSync(path.join(dir, x[k]))) {
        fs.copyFileSync(path.join(dir, x[k]), path.join(pg, x[k]));
        files[x[k]] = path.join(pg, x[k]);
      }
  // title / summary are kept: a rebuild after a rework keeps them without repeating the flags
  const meta = { ...readJson(path.join(dir, 'page.json'), {}), ...(arg('--title') ? { title: arg('--title') } : {}), ...(arg('--summary') ? { summary: arg('--summary') } : {}) };
  writeJson(path.join(dir, 'page.json'), meta);
  const artifact = readJson(path.join(dir, 'artifact.json'))?.url ?? null;
  const matches = readJson(path.join(dir, 'matches.json'), {});
  const pushedTo = readJson(path.join(dir, 'pushed.json'), {});
  const designs = d.list.map((x) => {
    const source = path.join(dir, 'src', x.file);
    return { ...x, localSource: fs.existsSync(source) ? pathToFileURL(source).href : null };
  });
  const data = { batch: b, version: version(t, b), repo: t.gh ?? t.name, light: t.light, title: meta.title ?? b, summary: meta.summary ?? '', designs, checks,
    tasks: p.tasks.map((tk) => ({ ...tk, gaps: allGaps(tk, d.list, checks), sent: sent[tk.id] ?? null, matches: matches[tk.id] ?? null, pushed: pushedTo[tk.id] ?? null })), artifact, at: new Date().toISOString() };
  const tpl = fs.readFileSync(path.join(HOME, 'scripts/designs-page.html'), 'utf8');
  // Display changes (sent links, title, artifact) must refresh the browser without invalidating approval.
  data.revision = sha256(JSON.stringify({ ...data, at: null }) + tpl).slice(0, 12);
  const fill = (v) => tpl.replace('/*__DATA__*/null', () => JSON.stringify(v).replace(/</g, '\\u003c')).replace('__TITLE__', () => `Designs: ${v.title}`.replace(/[<&]/g, ''));
  // index.html: for a Claude artifact (pictures as files beside it)
  fs.writeFileSync(path.join(pg, 'index.html'), fill(data));
  // standalone.html: one file with the pictures inside — the browser page, and what gets attached to the tasks
  const inline = (f) => (f && fs.existsSync(path.join(dir, f)) ? `data:image/png;base64,${fs.readFileSync(path.join(dir, f)).toString('base64')}` : f);
  // a document of its own (the artifact skeleton isn't there in a browser): doctype → standards mode
  const doc = (body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>:root{color-scheme:light dark}body{margin:0}img{max-width:100%}</style></head><body>${body}</body></html>`;
  fs.writeFileSync(path.join(pg, 'standalone.html'), doc(fill({ ...data, designs: designs.map((x) => ({ ...x, shot: inline(x.shot), now: inline(x.now), diff: inline(x.diff) })) })));
  // Publish the revision last; /state must never advertise a page that has not been rendered yet.
  writeJson(path.join(dir, 'page-render.json'), { version: data.version, revision: data.revision, artifact });
  return { batch: b, version: data.version, revision: data.revision, page: path.join(pg, 'index.html'), standalone: path.join(pg, 'standalone.html'), files, capabilities: { comments: {}, db: {}, user: {} } };
}

function refreshPage(t, b) {
  if (fs.existsSync(path.join(bdir(t, b), 'page', 'standalone.html'))) page(t, b);
}

// ── linear: the tasks whose designs were taken (none under rework), once each, with their pictures ──
function reviewLines(tk, gaps) {
  const r = tk.review;
  const lines = ['## Business review', '', `**Metric:** ${r.metric ?? '_not defined — a product decision is needed (see Open questions)_'}`, '', `**In short:** ${r.summary}`, '', '### Definition of done', ...r.dod.map((x) => `- [ ] ${x}`), '', '### Cases', ...r.cases.map((c) => `- **Given** ${c.given} **When** ${c.when} **Then** ${c.then}`)];
  if (gaps.length) lines.push('', '### Open questions', ...gaps.map((g) => `- ⚠️ ${g.kind}: ${g.text}`));
  return [...lines, '', '---', ''];
}
function taskBody(tk, designs, checks, images, marker) {
  const lines = [...reviewLines(tk, allGaps(tk, designs, checks).filter((g) => !g.setup)), tk.body, '', '### Designs'];
  for (const x of designs) {
    lines.push('', `**${x.id} — ${x.title}**${x.route ? ` · \`${x.route}\`${x.isNew ? ' (new screen)' : ''}` : ''}`);
    if (images[x.id]?.design) lines.push(`![${x.id} design](${images[x.id].design})`);
    if (images[x.id]?.now) lines.push(`Now in the app: ![${x.route} now](${images[x.id].now})`);
    const c = checks[x.id] ?? {};
    for (const k of ['ds', 'backend', 'mobile']) if (c[k]) lines.push(`- ${c[k].title}: ${c[k].summary}`);
  }
  lines.push('', '---', `<!-- ${marker} -->`);
  return lines.join('\n');
}
/** The page's Linear choice per task: `T1=TASK-12,T2=new` → { T1: 'TASK-12', T2: 'new' }. */
export function parseLinks(s, taskIds = null) {
  const links = {};
  for (const part of String(s ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
    const m = /^(T\d+)=([A-Z][A-Z0-9]*-\d+|new)$/.exec(part);
    if (!m) throw new Error(`--link T1=TASK-12 or T1=new: ${part}`);
    if (taskIds && !taskIds.includes(m[1])) throw new Error(`--link: the plan has no task ${m[1]}`);
    if (links[m[1]] && links[m[1]] !== m[2]) throw new Error(`--link: ${m[1]} is given twice`);
    links[m[1]] = m[2];
  }
  return links;
}
/** The page version the person decided on must be the current one (no reworks or new checks after it). */
function pinned(t, b) {
  const v = arg('--version');
  if (!v) throw new Error('--version: the version from the page');
  const cur = version(t, b);
  if (v !== cur) throw new Error(`the page has version ${v}, now it is ${cur} — there were reworks after the page. Publish the page again`);
  return v;
}
/** take / rework / skip from the decision, checked against the batch. */
function choices(d) {
  const take = new Set(list('--take'));
  const rework = new Set(list('--rework'));
  for (const id of [...take, ...rework, ...list('--skip')]) if (!d.list.some((x) => x.id === id)) throw new Error(`no design ${id}`);
  return { take, rework };
}
async function linear(t, b) {
  const dir = bdir(t, b);
  const v = pinned(t, b);
  const d = designsOf(t, b);
  const p = readJson(path.join(dir, 'plan.json'));
  const errors = validatePlan(p, d.list);
  if (errors.length) throw new Error(`the plan is not valid:\n- ${errors.join('\n- ')}`);
  const checks = readJson(path.join(dir, 'checks.json'), {});
  const { take, rework } = choices(d);
  // the page's choice wins over the plan's `existing`; the plan itself is not edited (it is part of the approval)
  const links = parseLinks(arg('--link'), p.tasks.map((tk) => tk.id));
  for (const tk of p.tasks) if (links[tk.id]) tk.existing = links[tk.id] === 'new' ? null : links[tk.id];
  const sentFile = path.join(dir, 'linear.json');
  const sent = readJson(sentFile, {});
  const due = p.tasks.filter((tk) => !sent[tk.id] && tk.designs.some((x) => take.has(x)) && !tk.designs.some((x) => rework.has(x)));
  const waiting = p.tasks.filter((tk) => !sent[tk.id] && tk.designs.some((x) => rework.has(x))).map((tk) => tk.id);
  // the MCP path: tasks created by the agent through the Linear MCP are recorded, not created again
  for (const r of list('--record')) {
    const m = /^(T\d+)=([A-Z][A-Z0-9]*-\d+)@(https?:\/\/\S+)$/.exec(r);
    if (!m) throw new Error(`--record T1=TASK-5@https://…: ${r}`);
    sent[m[1]] = { identifier: m[2], url: m[3], via: 'mcp', at: new Date().toISOString(), designs: p.tasks.find((x) => x.id === m[1])?.designs.filter((x) => take.has(x)) ?? [] };
  }
  if (list('--record').length) {
    writeJson(sentFile, sent);
    refreshPage(t, b);
    return { batch: b, created: [], recorded: list('--record'), waiting, sent };
  }
  const plan = due.map((tk) => ({ task: tk, designs: d.list.filter((x) => tk.designs.includes(x.id) && take.has(x.id)) }));
  const key = linearKey(t.root);
  if (flag('--dry-run') || (!key && plan.length)) {
    const pv = path.join(dir, 'linear-preview');
    fs.mkdirSync(pv, { recursive: true });
    for (const { task, designs } of plan) fs.writeFileSync(path.join(pv, `${task.id}.md`), `# ${task.title}\n\n${taskBody(task, designs, checks, {}, `handoff:${t.name}:${b}:${task.id}`)}\n`);
    const preview = { batch: b, would: plan.map((x) => ({ task: x.task.id, title: x.task.title, designs: x.designs.map((y) => y.id), existing: x.task.existing ?? null })), waiting, preview: pv };
    if (flag('--dry-run')) return { ...preview, dryRun: true };
    return { ...preview, status: 'needs_mcp', published: false, created: [], connection: ensureLinearMcp(t.root),
      next: 'Use the Linear MCP in Claude to publish the approved preview after a read-only access check. A task with `existing` gets the designs as a comment on that issue, never a new issue. Search each task marker before creating or commenting, then record each confirmed issue with --record. Keep this preview if sign-in is pending.' };
  }
  if (!plan.length) return { batch: b, created: [], waiting, note: waiting.length ? 'everything taken waits for a rework' : 'nothing to create' };
  const L = client(key);
  const created = [];
  const progressFile = path.join(dir, 'linear-progress.json');
  const progress = readJson(progressFile, {});
  const images = async (designs) => {
    const out = {};
    for (const x of designs) out[x.id] = { design: x.shot ? await L.upload(path.join(dir, x.shot)) : null, now: x.now ? await L.upload(path.join(dir, x.now)) : null };
    return out;
  };
  for (const { task, designs } of plan) {
    const marker = `handoff:${t.name}:${b}:${task.id}`;
    const selection = designs.map((x) => x.id);
    const goal = task.existing ?? 'new';
    let checkpoint = progress[task.id];
    if (checkpoint && (checkpoint.version !== v || JSON.stringify(checkpoint.record.designs) !== JSON.stringify(selection) || (checkpoint.target ?? (checkpoint.record.existing ? checkpoint.record.identifier : 'new')) !== goal)) {
      throw new Error(`${task.id}: an earlier publication is incomplete for another version, selection or Linear task; reconcile it before retrying`);
    }
    if (!checkpoint) {
      let issue;
      let comment = null;
      let found = false;
      if (task.existing) {
        issue = await L.issueByKey(task.existing);
        // Also recover a remote success whose response/checkpoint was lost.
        comment = await L.findCommentByMarker(issue.id, marker);
        found = Boolean(comment);
        if (!comment) comment = await L.comment(issue.id, taskBody(task, designs, checks, await images(designs), marker));
      } else {
        issue = await L.findByMarker(marker);
        found = Boolean(issue);
        if (!issue) {
          const teamId = await L.teamId(task.team);
          issue = await L.create({ teamId, title: task.title, description: taskBody(task, designs, checks, await images(designs), marker), labelIds: await L.labelIds(teamId, task.labels) });
        }
      }
      checkpoint = { version: v, target: goal, comment: comment?.id ?? null, record: { id: issue.id, identifier: issue.identifier, url: issue.url, via: 'api', reused: found, existing: Boolean(task.existing), designs: selection, at: new Date().toISOString() } };
      progress[task.id] = checkpoint;
      writeJson(progressFile, progress); // save the remote write before attempting any attachments
    }
    await attachPages(t, b, L, checkpoint.record);
    sent[task.id] = checkpoint.record;
    writeJson(sentFile, sent); // after every task: a failure on the next one doesn't lose this one
    delete progress[task.id];
    writeJson(progressFile, progress);
    created.push({ task: task.id, ...sent[task.id] });
    say(`${task.id}: ${sent[task.id].identifier}${sent[task.id].reused ? ' (already there)' : ''}`);
  }
  refreshPage(t, b);
  return { batch: b, created, waiting, sent };
}

/**
 * The decision page on the task: the standalone HTML (uploaded once per page version) and, if published, the Claude
 * artifact. Attachments are idempotent by URL, so a repeat updates instead of piling up.
 */
async function attachPages(t, b, L, issue) {
  const dir = bdir(t, b);
  const meta = readJson(path.join(dir, 'page.json'), {});
  const v = version(t, b);
  const file = path.join(dir, 'page', 'standalone.html');
  const up = readJson(path.join(dir, 'page-upload.json'));
  let asset = up?.version === v ? up.url : null;
  if (!asset && fs.existsSync(file)) {
    asset = await L.upload(file, 'text/html');
    writeJson(path.join(dir, 'page-upload.json'), { version: v, url: asset });
  }
  const done = [];
  if (asset) done.push(await L.attach(issue.id, asset, `Designs "${meta.title ?? b}" — page (HTML)`, `version ${v}`));
  const art = readJson(path.join(dir, 'artifact.json'))?.url;
  if (art) done.push(await L.attach(issue.id, art, `Designs "${meta.title ?? b}" — Claude page`));
  return done;
}
async function attach(t, b) {
  const key = linearKey(t.root);
  if (!key) return { batch: b, status: 'needs_mcp', published: false, task: arg('--task'), connection: ensureLinearMcp(t.root),
    next: 'Use the Linear MCP in Claude to attach page/standalone.html and the saved artifact link to the named issue. Confirm each attachment; report unsupported file uploads.' };
  const L = client(key);
  const issue = await L.issueByKey(arg('--task'));
  const ids = await attachPages(t, b, L, issue);
  const f = path.join(bdir(t, b), 'attached.json');
  writeJson(f, { ...readJson(f, {}), [issue.identifier]: { url: issue.url, at: new Date().toISOString() } });
  return { batch: b, task: issue.identifier, url: issue.url, attachments: ids.length };
}
/** The page was published as a Claude artifact: remember the link, show it on the page, put it on tasks already sent. */
async function artifact(t, b) {
  const url = arg('--url');
  if (!/^https:\/\/claude\.ai\/(code\/)?artifact\//.test(url ?? '')) throw new Error('--url: a claude.ai artifact link');
  const dir = bdir(t, b);
  writeJson(path.join(dir, 'artifact.json'), { url, at: new Date().toISOString() });
  refreshPage(t, b);
  const sent = readJson(path.join(dir, 'linear.json'), {});
  const key = linearKey(t.root);
  let attached = 0;
  if (key) {
    const L = client(key);
    const meta = readJson(path.join(dir, 'page.json'), {});
    for (const s of Object.values(sent).filter((x) => x.id)) {
      await L.attach(s.id, url, `Designs "${meta.title ?? b}" — Claude page`);
      attached++;
    }
  }
  return { batch: b, artifact: url, attached, ...(!key && Object.keys(sent).length ? { status: 'needs_mcp', connection: ensureLinearMcp(t.root) } : {}),
    note: !key && Object.keys(sent).length ? 'Attach the artifact link through the Linear MCP in Claude; no Linear attachment has been confirmed yet.' : null };
}

/**
 * The page in a browser with working buttons: 127.0.0.1 only, a token in the link, the Host checked. A decision is
 * appended to decisions.jsonl and printed; with --wait the server exits on the first one (0) or on timeout (3) — run it
 * in the background and react. The page reloads itself when it was rebuilt (a rework, new links).
 */
async function serveCmd(t, b) {
  const dir = bdir(t, b);
  const file = path.join(dir, 'page', 'standalone.html');
  if (!fs.existsSync(file)) throw new Error('run page first');
  if (!fs.existsSync(path.join(dir, 'page-render.json'))) page(t, b); // upgrade pages built before display revisions
  let port = Number(arg('--port', t.cfg.handoff?.ports?.page ?? t.port + 302));
  const token = crypto.randomBytes(12).toString('hex');
  const hosts = new Set();
  let sourceBase = null;
  const wait = Number(arg('--wait', 0));
  const server = http.createServer((req, res) => {
    const send = (code, type, body) => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
      res.end(body);
    };
    if (!hosts.has(String(req.headers.host))) return send(403, 'text/plain', 'host');
    let u;
    try { u = new URL(req.url, `http://127.0.0.1:${port}`); }
    catch { return send(400, 'text/plain', 'invalid URL'); }
    // Other local origins (including the designer's HTML) cannot read the page or submit decisions.
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return send(403, 'text/plain', 'origin');
    if (u.searchParams.get('t') !== token) return send(403, 'text/plain; charset=utf-8', 'the link with the token is needed (serve prints it)');
    if (req.method === 'GET' && u.pathname === '/') {
      try {
        const html = fs.readFileSync(file, 'utf8').replace(/^const SOURCE_BASE = \/\*__SOURCE_BASE__\*\/null;$/m, () => `const SOURCE_BASE = ${JSON.stringify(sourceBase)};`);
        return send(200, 'text/html; charset=utf-8', html);
      } catch { return send(404, 'text/plain', 'page unavailable'); }
    }
    if (req.method === 'GET' && u.pathname === '/state') return send(200, 'application/json', JSON.stringify(readJson(path.join(dir, 'page-render.json'), {})));
    if (req.method === 'POST' && u.pathname === '/decision') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let text = '';
        try {
          text = String(JSON.parse(body).text ?? '').slice(0, 4000);
        } catch {
          /* bad body */
        }
        if (!/^\[handoff-designs /.test(text)) return send(400, 'text/plain', 'bad decision');
        const rec = { text, at: new Date().toISOString() };
        fs.appendFileSync(path.join(dir, 'decisions.jsonl'), `${JSON.stringify(rec)}\n`);
        console.log(JSON.stringify({ decision: rec }));
        send(200, 'application/json', '{"ok":true}');
        if (wait) setTimeout(() => process.exit(0), 100);
      });
      return;
    }
    return send(404, 'text/plain', 'not found');
  });
  await new Promise((r, j) => server.listen(port, '127.0.0.1', r).on('error', j));
  port = server.address().port;
  hosts.add(`127.0.0.1:${port}`);
  hosts.add(`localhost:${port}`);
  try {
    const sources = await serveSources(path.join(dir, 'src'));
    sourceBase = sources.baseUrl;
    server.on('close', () => sources.server.close());
  } catch (e) {
    server.close();
    throw e;
  }
  const url = `http://127.0.0.1:${port}/?t=${token}`;
  writeJson(path.join(dir, 'server.json'), { url, port, pid: process.pid, at: new Date().toISOString() });
  console.log(JSON.stringify({ batch: b, url }));
  if (flag('--open')) spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
  if (wait) setTimeout(() => process.exit(3), wait * 1000);
  return new Promise(() => {}); // runs until stopped (or --wait)
}

/** A design that already went to Linear was reworked: the task gets a comment with the new picture, never a twin. */
async function comment(t, b) {
  const dir = bdir(t, b);
  const sent = readJson(path.join(dir, 'linear.json'), {});
  const tk = sent[arg('--task')];
  if (!tk) throw new Error(`task ${arg('--task')} is not created yet`);
  const key = linearKey(t.root);
  if (!key) return { batch: b, status: 'needs_mcp', published: false, task: tk.identifier, connection: ensureLinearMcp(t.root),
    next: 'Use the Linear MCP in Claude to add the requested rework comment and updated screenshots to this existing issue. Do not create a new issue.' };
  if (!tk.id) throw new Error('this issue was recorded through MCP; add the comment through the connected Linear MCP using its identifier');
  const L = client(key);
  const d = designsOf(t, b);
  const lines = [arg('--text', 'Design updated')];
  for (const x of d.list.filter((y) => list('--ids').includes(y.id) && y.shot)) lines.push('', `**${x.id} — ${x.title}**`, `![${x.id}](${await L.upload(path.join(dir, x.shot))})`);
  const c = await L.comment(tk.id, lines.join('\n'));
  return { batch: b, task: arg('--task'), comment: c.url ?? c.id };
}

// ── match: Linear tasks that may already cover a planned task (the page offers them next to "new task") ──
const matchCand = (x) => ({ identifier: String(x.identifier), title: String(x.title ?? '').slice(0, 200), url: /^https:\/\//.test(x.url ?? '') ? x.url : null, state: x.state ? String(x.state).slice(0, 40) : null });
async function match(t, b) {
  const dir = bdir(t, b);
  const p = readJson(path.join(dir, 'plan.json'));
  if (!p) throw new Error('run plan first');
  const ids = p.tasks.map((tk) => tk.id);
  const file = path.join(dir, 'matches.json');
  if (arg('--file')) {
    // the agent searched (MCP, or judged the API results): { T1: { candidates: [{identifier,title,url,state}], suggested: "TASK-12" | null } }
    const j = readJson(path.resolve(arg('--file')));
    if (!j) throw new Error('--file <matches.json>');
    const v = {};
    for (const [id, m] of Object.entries(j)) {
      if (!ids.includes(id)) throw new Error(`matches: the plan has no task ${id}`);
      const candidates = (m.candidates ?? []).map(matchCand);
      for (const c of candidates) if (!/^[A-Z][A-Z0-9]*-\d+$/.test(c.identifier)) throw new Error(`matches ${id}: not an issue key: ${c.identifier}`);
      if (m.suggested && !candidates.some((c) => c.identifier === m.suggested)) throw new Error(`matches ${id}: suggested ${m.suggested} is not among the candidates`);
      v[id] = { candidates: candidates.slice(0, 8), suggested: m.suggested ?? null, why: String(m.why ?? '').slice(0, 300) };
    }
    writeJson(file, { ...readJson(file, {}), ...v });
    refreshPage(t, b);
    return { batch: b, matches: readJson(file, {}) };
  }
  const key = linearKey(t.root);
  const todo = p.tasks.filter((tk) => !tk.existing);
  if (!key) return { batch: b, status: 'needs_mcp', tasks: todo.map((tk) => ({ task: tk.id, title: tk.title, team: tk.team, routes: designsOf(t, b).list.filter((x) => tk.designs.includes(x.id)).map((x) => x.route).filter(Boolean) })), connection: ensureLinearMcp(t.root),
    next: 'Search Linear through the MCP for each task (title words, the screen route), keep open tasks that really describe the same work, then save them with match --file (candidates + suggested or null). Read-only: create nothing.' };
  const L = client(key);
  const v = readJson(file, {});
  const teams = {};
  for (const tk of todo) {
    teams[tk.team] ??= await L.teamId(tk.team);
    const routes = designsOf(t, b).list.filter((x) => tk.designs.includes(x.id)).map((x) => x.route).filter(Boolean);
    const seen = new Map();
    for (const term of [tk.title, ...routes]) for (const c of await L.search(term, { teamId: teams[tk.team] })) if (!['completed', 'canceled'].includes(c.stateType)) seen.set(c.identifier, matchCand(c));
    // the search finds candidates; whether one is the same work is the agent's call (match --file … suggested)
    v[tk.id] = { candidates: [...seen.values()].slice(0, 8), suggested: v[tk.id]?.suggested && seen.has(v[tk.id].suggested) ? v[tk.id].suggested : null, why: v[tk.id]?.why ?? '' };
  }
  writeJson(file, v);
  refreshPage(t, b);
  return { batch: b, matches: v };
}

/** Taken designs of the same screen and condition are variants: the first such group (ids), else null. */
export function variantClash(designs) {
  const by = new Map();
  for (const x of designs) {
    const key = JSON.stringify([x.route ?? null, conditionKey(x)]);
    by.set(key, [...(by.get(key) ?? []), x.id]);
  }
  return [...by.values()].find((ids) => ids.length > 1) ?? null;
}
/** A design-repo slug for a task of the batch: deterministic, valid, never «main». */
export function pushSlug(b, taskId) {
  const s = `${b}-${taskId.toLowerCase()}`;
  return slugOk(s) && s !== 'main' ? s : `${b.slice(0, 38).replace(/-+$/, '')}-${sha256(s).slice(0, 8)}`;
}
// ── push-plan: one capture per app task, with every taken screen and condition from the batch's copy ──
function pushPlan(t, b) {
  if (t.light) throw new Error('Push to design needs the full mode: "set up handoff fully" (node scripts/setup.mjs run)');
  const dir = bdir(t, b);
  const v = pinned(t, b);
  const d = designsOf(t, b);
  const p = readJson(path.join(dir, 'plan.json'));
  const errors = validatePlan(p, d.list);
  if (errors.length) throw new Error(`the plan is not valid:\n- ${errors.join('\n- ')}`);
  const { take, rework } = choices(d);
  const sent = readJson(path.join(dir, 'linear.json'), {});
  const pushed = readJson(path.join(dir, 'pushed.json'), {});
  const items = [];
  const refused = [];
  for (const tk of p.tasks.filter((x) => x.side === 'client' && !pushed[x.id])) {
    const taken = tk.designs.filter((x) => take.has(x));
    if (!taken.length || tk.designs.some((x) => rework.has(x))) continue;
    // Variants share both a screen and a condition; other screens and states are all built.
    const clash = variantClash(taken.map((id) => d.list.find((y) => y.id === id)));
    if (clash) {
      refused.push({ task: tk.id, why: `variants ${clash.join(', ')} are all taken — code can hold one: take one, skip the rest` });
      continue;
    }
    const xs = taken.map((id) => d.list.find((y) => y.id === id));
    const unknown = xs.find((x) => !x.route);
    if (unknown) {
      refused.push({ task: tk.id, why: `${unknown.id}: the screen is not known` });
      continue;
    }
    const x = xs[0];
    const slug = pushSlug(b, tk.id);
    // the batch copy (reworks live there), with its folder: relative pictures and styles come along
    const top = (y) => y.file.split(/[\\/]/)[0];
    let from = path.join(dir, 'src', top(x));
    if (xs.length > 1) {
      // Screens and states go as one capture: their folders side by side, with routes in states.json.
      from = path.join(dir, 'push', slug);
      fs.rmSync(from, { recursive: true, force: true });
      for (const y of xs) fs.cpSync(path.join(dir, 'src', top(y)), path.join(from, top(y)), { recursive: true });
      writeJson(path.join(from, 'states.json'), Object.fromEntries(xs.map((y) => [y.id, { route: y.route, isNew: y.isNew, condition: y.condition, query: y.query || DEFAULT_QUERY, file: y.file }])));
    }
    const states = xs.map((y) => ({ design: y.id, route: y.route, isNew: y.isNew, condition: y.condition || null, query: y.query || DEFAULT_QUERY, file: path.join(dir, 'src', y.file) }));
    const routes = [...new Set(states.map((s) => s.route))];
    // Keep the single-screen fields for older callers, without silently pointing multi-screen tasks at the first.
    items.push({ task: tk.id, title: tk.title, design: x.id, designs: xs.map((y) => y.id), states, routes, route: routes.length === 1 ? x.route : null, isNew: routes.length === 1 ? x.isNew : null, from, file: path.join(dir, 'src', x.file), slug, linear: sent[tk.id] ? { id: sent[tk.id].identifier, url: sent[tk.id].url } : null });
  }
  const unsent = items.filter((x) => !x.linear).map((x) => x.task);
  return { batch: b, version: v, push: items, refused, ...(unsent.length ? { note: `create or link the Linear tasks first (linear … --link): ${unsent.join(', ')}` } : {}) };
}
// ── pushed: the PR is on the page and on the Linear task ──
async function pushed(t, b) {
  const dir = bdir(t, b);
  const id = arg('--task');
  const p = readJson(path.join(dir, 'plan.json'));
  if (!p?.tasks.some((tk) => tk.id === id && tk.side === 'client')) throw new Error(`--task: no app task ${id} in the plan`);
  const pr = arg('--pr');
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(pr ?? '')) throw new Error('--pr: a github.com pull request link');
  const file = path.join(dir, 'pushed.json');
  const all = readJson(file, {});
  all[id] = { pr, branch: arg('--branch'), sha: arg('--sha'), at: new Date().toISOString() };
  writeJson(file, all);
  refreshPage(t, b);
  const issue = readJson(path.join(dir, 'linear.json'), {})[id];
  if (!issue) return { batch: b, task: id, pr, linear: null, note: 'no Linear task for it yet' };
  const key = linearKey(t.root);
  if (!key || !issue.id) return { batch: b, task: id, pr, linear: issue.identifier, status: 'needs_mcp', connection: key ? undefined : ensureLinearMcp(t.root),
    next: `Attach ${pr} to ${issue.identifier} through the Linear MCP in Claude (a link attachment); do not change its status.` };
  await client(key).attach(issue.id, pr, `Design PR — ${p.tasks.find((tk) => tk.id === id).title}`.slice(0, 200));
  return { batch: b, task: id, pr, linear: issue.identifier, attached: true };
}

async function main() {
  if (cliHelp(argv, import.meta.url)) return;
  const t = target(arg('--target'));
  const b = batchOf(t);
  switch (cmd) {
    case 'add':
      return out(add(t, b));
    case 'auto':
      return out(await auto(t, b));
    case 'describe':
      return out(describe(t, b));
    case 'analysis':
      return out(analysis(t, b));
    case 'render':
      return out(await render(t, b));
    case 'check':
      return out(await checkBatch(t, b));
    case 'plan':
      return out(plan(t, b));
    case 'page':
      return out(page(t, b));
    case 'linear':
      return out(await withFileLock(path.join(bdir(t, b), 'linear.lock'), () => linear(t, b)));
    case 'comment':
      return out(await comment(t, b));
    case 'serve':
      return serveCmd(t, b);
    case 'artifact':
      return out(await artifact(t, b));
    case 'attach':
      return out(await attach(t, b));
    case 'match':
      return out(await match(t, b));
    case 'push-plan':
      return out(pushPlan(t, b));
    case 'pushed':
      return out(await pushed(t, b));
    case 'status':
      return out({ batch: b, version: version(t, b), light: t.light, designs: designsOf(t, b).list, plan: readJson(path.join(bdir(t, b), 'plan.json')), matches: readJson(path.join(bdir(t, b), 'matches.json'), {}), sent: readJson(path.join(bdir(t, b), 'linear.json'), {}), pushed: readJson(path.join(bdir(t, b), 'pushed.json'), {}) });
    default:
      console.error('commands: auto · add · describe · analysis · render · check · plan · match · page · serve · artifact · linear · attach · comment · push-plan · pushed · status');
      process.exit(2);
  }
}
if (isMain(import.meta.url))
  main().catch((e) => {
    console.error(`✗ ${e.message ?? e}`);
    process.exit(1);
  });
