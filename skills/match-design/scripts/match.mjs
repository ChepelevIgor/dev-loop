#!/usr/bin/env node
// A screenshot of the mobile app (a whole screen or a piece of it) → the same screen in the design repo (workbench) →
// where it sits there, the pixel difference and a comparison page. Read-only: nothing is written to the design repo.
//   node scripts/match.mjs prep    --shot <png|jpg|heic> [--session <s>] [--scale 3] [--fragment|--full]
//                                  [--crop-top <pt>] [--crop-bottom <pt>] [--width <pt>] [--height <pt>]
//                                  copies the screenshot into a session, finds its density and the viewport, cuts off the
//                                  status bar and the home indicator of a whole screen
//   node scripts/match.mjs routes  [--words "Профиль,Сохранить"] [--limit 15]   screens of the design repo, ranked by
//                                  how many of the screenshot's words their code has; recorded data states
//   node scripts/match.mjs shoot   --session <s> --routes /a,/b [--query "wb.data=fixtures&…"]   the workbench screens at
//                                  the screenshot's viewport and density (full mode)
//   node scripts/match.mjs locate  --session <s>                where the screenshot sits in each shot, and how well
//   node scripts/match.mjs diff    --session <s> [--candidate <id>]   the matched region against the screenshot, pixel
//                                  by pixel → design.png, mobile-fit.png, diff.png, changed %, boxes
//   node scripts/match.mjs page    --session <s> [--file <findings.json>] [--title "…"] [--open]   standalone.html
//   node scripts/match.mjs status  --session <s>
// Common: --target <design repo>. Sessions live beside the design repo's copies (<work>/match/<s>).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cliHelp, isMain, readJson, routesAt, say, slugOk, target, treeDir, tryGit, writeJson } from '../../filter-design/scripts/lib.mjs';
import { decodePng, encodePng, compare as diffPng } from '../../filter-design/scripts/img-diff.mjs';
import { prepareTree, serve, bundleError } from '../../filter-design/scripts/stand.mjs';
import { shoot as shot } from '../../filter-design/scripts/cdp.mjs';

const argv = process.argv.slice(2);
const arg = (k, d = null) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const flag = (k) => argv.includes(k);
const out = (v) => console.log(JSON.stringify(v));
const DEFAULT_QUERY = 'wb.data=fixtures';
const queryOk = (q) => typeof q === 'string' && q.length <= 200 && /^[\w.\-=&%,:]*$/.test(q) && !q.startsWith('&');

// ── pictures ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Known phone screenshot widths (px) → density. Anything else: a guess by size, overridable with --scale. */
const DENSITY = { 1320: 3, 1290: 3, 1284: 3, 1242: 3, 1206: 3, 1179: 3, 1170: 3, 1125: 3, 1080: 2.625, 1440: 3.5, 828: 2, 750: 2, 640: 2 };
export function guessScale(width) {
  if (DENSITY[width]) return DENSITY[width];
  return width >= 1000 ? 3 : width >= 600 ? 2 : 1;
}
/** Status bar / home indicator of a whole iPhone screen, in points, by its height. Android: a 24 dp status bar. */
export function insets(heightPt, android = false) {
  if (android) return { top: 24, bottom: 0 };
  if (heightPt >= 852) return { top: 59, bottom: 34 };
  if (heightPt >= 812) return { top: 47, bottom: 34 };
  return { top: 20, bottom: 0 };
}
/** A whole phone screen: portrait, a known width or a phone-like aspect. */
export function looksFull(w, h) {
  const aspect = h / w;
  return aspect >= 1.7 && aspect <= 2.4 && (Boolean(DENSITY[w]) || w >= 600);
}

export function crop(img, x, y, w, h) {
  x = Math.max(0, Math.round(x));
  y = Math.max(0, Math.round(y));
  w = Math.min(img.width - x, Math.round(w));
  h = Math.min(img.height - y, Math.round(h));
  if (w <= 0 || h <= 0) throw new Error('crop is outside the picture');
  const data = new Uint8Array(w * h * 4);
  for (let r = 0; r < h; r++) data.set(img.data.subarray(((y + r) * img.width + x) * 4, ((y + r) * img.width + x + w) * 4), r * w * 4);
  return { width: w, height: h, data };
}

/** Bilinear resize of RGBA. */
export function resize(img, nw, nh) {
  nw = Math.max(1, Math.round(nw));
  nh = Math.max(1, Math.round(nh));
  const data = new Uint8Array(nw * nh * 4);
  const sx = img.width / nw;
  const sy = img.height / nh;
  for (let y = 0; y < nh; y++) {
    const fy = Math.min(img.height - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(img.height - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < nw; x++) {
      const fx = Math.min(img.width - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(img.width - 1, x0 + 1);
      const tx = fx - x0;
      for (let c = 0; c < 4; c++) {
        const a = img.data[(y0 * img.width + x0) * 4 + c];
        const b = img.data[(y0 * img.width + x1) * 4 + c];
        const d = img.data[(y1 * img.width + x0) * 4 + c];
        const e = img.data[(y1 * img.width + x1) * 4 + c];
        data[(y * nw + x) * 4 + c] = Math.round((a * (1 - tx) + b * tx) * (1 - ty) + (d * (1 - tx) + e * tx) * ty);
      }
    }
  }
  return { width: nw, height: nh, data };
}

/** RGBA → a gray copy of size nw×nh, by area averaging (an integral image: any downscale, no aliasing). */
export function grayAt(img, nw, nh) {
  const W = img.width;
  const H = img.height;
  const I = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      row += 0.299 * img.data[o] + 0.587 * img.data[o + 1] + 0.114 * img.data[o + 2];
      I[(y + 1) * (W + 1) + x + 1] = I[y * (W + 1) + x + 1] + row;
    }
  }
  const g = new Float32Array(nw * nh);
  const sx = W / nw;
  const sy = H / nh;
  for (let y = 0; y < nh; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < nw; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      const s = I[y1 * (W + 1) + x1] - I[y0 * (W + 1) + x1] - I[y1 * (W + 1) + x0] + I[y0 * (W + 1) + x0];
      g[y * nw + x] = s / ((x1 - x0) * (y1 - y0));
    }
  }
  return { width: nw, height: nh, data: g };
}

/** Normalized cross-correlation of template t at every (x, y) in the window list of picture p → best { x, y, score }. */
function nccSearch(p, t, xs, ys) {
  const n = t.width * t.height;
  let tm = 0;
  for (let i = 0; i < n; i++) tm += t.data[i];
  tm /= n;
  let tv = 0;
  const tc = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    tc[i] = t.data[i] - tm;
    tv += tc[i] * tc[i];
  }
  if (tv < 1e-6 * n) return null; // a flat template matches everything and nothing
  let best = { x: 0, y: 0, score: -2 };
  for (const y of ys)
    for (const x of xs) {
      let s = 0;
      let pm = 0;
      let pv = 0;
      for (let r = 0; r < t.height; r++) {
        const po = (y + r) * p.width + x;
        const to = r * t.width;
        for (let c = 0; c < t.width; c++) {
          const v = p.data[po + c];
          pm += v;
          pv += v * v;
          s += v * tc[to + c];
        }
      }
      const varP = pv - (pm * pm) / n;
      const score = varP <= 1e-6 * n ? 0 : s / Math.sqrt(varP * tv);
      if (score > best.score) best = { x, y, score };
    }
  return best;
}
const range = (a, b) => Array.from({ length: Math.max(0, b - a + 1) }, (_, i) => a + i);

/**
 * Where does `frag` (RGBA) sit in `shot` (RGBA)? Both are in device pixels; `scales` are the fragment's size relative
 * to the shot (1 = same density). Coarse search on a ~160 px wide gray copy, then a fine one around the best hit.
 * → { x, y, w, h, scale, score } in shot pixels; score is the NCC (1 = identical up to brightness).
 */
export function locate(frag, shot, scales = [1, 0.95, 1.05, 0.9, 1.1, 0.8, 1.25, 2 / 3, 1.5, 0.5, 2]) {
  const coarse = Math.min(1, 160 / shot.width);
  const P = grayAt(shot, Math.max(1, Math.round(shot.width * coarse)), Math.max(1, Math.round(shot.height * coarse)));
  let best = null;
  for (const s of scales) {
    const tw = Math.round(frag.width * s * coarse);
    const th = Math.round(frag.height * s * coarse);
    if (tw < 4 || th < 4 || tw > P.width || th > P.height) continue;
    const hit = nccSearch(P, grayAt(frag, tw, th), range(0, P.width - tw), range(0, P.height - th));
    if (hit && (!best || hit.score > best.score)) best = { ...hit, s, tw, th };
  }
  if (!best) throw new Error('the screenshot is larger than the screen, or has no detail to match');
  // fine: ~3× the coarse resolution, around the coarse hit and its scale
  const fine = Math.min(1, coarse * 3);
  const F = grayAt(shot, Math.max(1, Math.round(shot.width * fine)), Math.max(1, Math.round(shot.height * fine)));
  const k = fine / coarse;
  let top = null;
  for (const s of [best.s * 0.97, best.s, best.s * 1.03]) {
    const tw = Math.round(frag.width * s * fine);
    const th = Math.round(frag.height * s * fine);
    if (tw < 4 || th < 4 || tw > F.width || th > F.height) continue;
    const cx = Math.round(best.x * k);
    const cy = Math.round(best.y * k);
    const r = Math.ceil(k) + 2;
    const hit = nccSearch(F, grayAt(frag, tw, th), range(Math.max(0, cx - r), Math.min(F.width - tw, cx + r)), range(Math.max(0, cy - r), Math.min(F.height - th, cy + r)));
    if (hit && (!top || hit.score > top.score)) top = { ...hit, s, tw, th };
  }
  const m = top ?? { x: best.x * k, y: best.y * k, s: best.s, tw: best.tw * k, th: best.th * k, score: best.score };
  return { x: Math.round(m.x / fine), y: Math.round(m.y / fine), w: Math.round(m.tw / fine), h: Math.round(m.th / fine), scale: Math.round(m.s * 1000) / 1000, score: Math.round(m.score * 1000) / 1000 };
}
/** How to read a match score: the page and the agent use the same words. */
export const strength = (score) => (score >= 0.8 ? 'strong' : score >= 0.55 ? 'possible' : 'weak');

const readPng = (file) => decodePng(fs.readFileSync(file), path.basename(file));
const writePng = (file, img) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encodePng(img));
};

// ── sessions ────────────────────────────────────────────────────────────────────────────────────────────────────────

const sdir = (t, s) => path.join(t.work, 'match', s);
function session(t, s = arg('--session')) {
  if (!slugOk(s)) throw new Error('--session <latin-name> is required (from prep)');
  const dir = sdir(t, s);
  const j = readJson(path.join(dir, 'session.json'));
  if (!j) throw new Error(`no session ${s}: run prep first`);
  return { s, dir, j, save: () => writeJson(path.join(dir, 'session.json'), j) };
}

/** Any picture → PNG (macOS sips for JPEG / HEIC). The user's file is only read. */
function toPng(src, dest) {
  const head = fs.readFileSync(src).subarray(0, 8);
  if (head.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    fs.copyFileSync(src, dest);
  } else {
    const r = spawnSync('sips', ['-s', 'format', 'png', src, '--out', dest], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`cannot convert ${path.basename(src)} to PNG (sips: ${(r.stderr || r.stdout).trim().slice(0, 160)}) — save it as PNG`);
  }
  try {
    return readPng(dest);
  } catch {
    // 16-bit or interlaced PNG: normalize through sips once
    const tmp = `${dest}.tmp.png`;
    const r = spawnSync('sips', ['-s', 'format', 'png', '-s', 'formatOptions', 'normal', dest, '--out', tmp], { encoding: 'utf8' });
    if (r.status === 0) fs.renameSync(tmp, dest);
    return readPng(dest);
  }
}

function prep(t) {
  const src = arg('--shot');
  if (!src || !fs.existsSync(src)) throw new Error('--shot <file> is required');
  const name = arg('--session') ?? `m-${crypto.createHash('sha256').update(fs.readFileSync(src)).digest('hex').slice(0, 8)}`;
  if (!slugOk(name)) throw new Error('--session: latin letters, digits and dashes');
  const dir = sdir(t, name);
  fs.mkdirSync(dir, { recursive: true });
  const img = toPng(src, path.join(dir, 'source.png'));
  const full = flag('--fragment') ? false : flag('--full') ? true : looksFull(img.width, img.height);
  const fScale = Number(arg('--scale', 0)) || (full ? guessScale(img.width) : 3);
  const android = flag('--android');
  const width = Number(arg('--width', 0)) || (full ? Math.round(img.width / fScale) : 393);
  const height = Number(arg('--height', 0)) || (full ? Math.round(img.height / fScale) : 852);
  const ins = full ? insets(height, android) : { top: 0, bottom: 0 };
  const top = Number(arg('--crop-top', ins.top));
  const bottom = Number(arg('--crop-bottom', ins.bottom));
  const cut = crop(img, 0, top * fScale, img.width, img.height - (top + bottom) * fScale);
  writePng(path.join(dir, 'mobile.png'), cut);
  const j = { session: name, from: path.resolve(src), at: new Date().toISOString(), size: [img.width, img.height], full, scale: fScale,
    viewport: { width, height }, crop: { top, bottom }, mobile: 'mobile.png', candidates: [] };
  writeJson(path.join(dir, 'session.json'), j);
  return { session: name, dir, full, scale: fScale, viewport: j.viewport, crop: j.crop, mobile: path.join(dir, 'mobile.png'),
    note: full ? 'a whole screen: the status bar and the home indicator are cut off' : 'a fragment: located inside each screen; viewport defaults to 393×852 @3 (--width/--height/--scale to change)' };
}

/** Routes of the design repo, ranked by how many of the words their files (and same-named folders) contain. */
function routes(t) {
  const words = String(arg('--words', '') || '').split(',').map((w) => w.trim()).filter((w) => w.length >= 2);
  const limit = Number(arg('--limit', 15));
  const ref = t.light ? 'HEAD' : `origin/${t.base}`;
  if (!t.light) tryGit(t.root, 'fetch', '-q', 'origin', t.base);
  const all = routesAt(t.root, tryGit(t.root, 'rev-parse', '--verify', ref).ok ? ref : null);
  const states = fs.existsSync(path.join(t.root, 'knowledge-base/api-recordings'))
    ? fs.readdirSync(path.join(t.root, 'knowledge-base/api-recordings')).filter((d) => d.includes('@')) : [];
  if (!words.length) return { routes: all, states, hits: [], note: 'pass --words with the texts visible on the screenshot to rank screens' };
  const r = spawnSync('git', ['grep', '-I', '-i', '-c', '-F', ...words.flatMap((w) => ['-e', w]), ref, '--', 'app', 'src'], { cwd: t.root, encoding: 'utf8', maxBuffer: 64 << 20 });
  const counts = r.stdout.split('\n').filter(Boolean).map((l) => {
    const m = /^[^:]+:(.+):(\d+)$/.exec(l);
    return m ? { file: m[1], n: Number(m[2]) } : null;
  }).filter(Boolean);
  // per file: which distinct words it has (one more grep per word keeps "3 different words" above "one word 3 times")
  const distinct = new Map();
  for (const w of words) {
    const g = spawnSync('git', ['grep', '-I', '-i', '-l', '-F', '-e', w, ref, '--', 'app', 'src'], { cwd: t.root, encoding: 'utf8', maxBuffer: 64 << 20 });
    for (const l of g.stdout.split('\n').filter(Boolean)) {
      const f = l.replace(/^[^:]+:/, '');
      distinct.set(f, [...(distinct.get(f) ?? []), w]);
    }
  }
  const score = (f) => (distinct.get(f)?.length ?? 0) * 10 + (counts.find((c) => c.file === f)?.n ?? 0);
  const hits = [];
  for (const route of all) {
    const seg = route.split('/').filter(Boolean).pop() ?? 'index';
    const files = counts.map((c) => c.file).filter((f) => (f.startsWith('app/') && routeFor(f) === route) || (!f.startsWith('app/') && new RegExp(`(^|/)${seg.replace(/[^\w-]/g, '')}(/|\\.|$)`, 'i').test(f) && seg !== 'index'));
    if (files.length) hits.push({ route, score: files.reduce((a, f) => a + score(f), 0), words: [...new Set(files.flatMap((f) => distinct.get(f) ?? []))], files: files.slice(0, 6) });
  }
  hits.sort((a, b) => b.score - a.score);
  const other = counts.map((c) => c.file).filter((f) => !hits.some((h) => h.files.includes(f))).sort((a, b) => score(b) - score(a)).slice(0, 10);
  return { words, hits: hits.slice(0, limit), other, states, total: all.length };
}
/** app/(tabs)/profile/index.tsx → /profile */
export function routeFor(file) {
  return `/${file.replace(/^app\//, '').replace(/\.\w+$/, '').split('/').filter((x) => !/^\(.*\)$/.test(x)).join('/')}`.replace(/\/index$/, '') || '/';
}

export async function shoot(t, {
  name = arg('--session'), routes = arg('--routes', ''), query = arg('--query', DEFAULT_QUERY),
  prepare = prepareTree, startServer = serve, checkBundle = bundleError, capture = shot,
} = {}) {
  const S = session(t, name);
  if (t.light) throw new Error('light mode: workbench screens cannot be shot — "set up handoff fully" (setup.mjs run) to compare');
  const list = String(routes || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!list.length) throw new Error('--routes /a,/b is required');
  const bad = list.filter((r) => !r.startsWith('/') || /[[\]]/.test(r));
  if (bad.length) throw new Error(`concrete routes only (a dynamic [id] needs a real id from the fixtures): ${bad.join(', ')}`);
  if (!queryOk(query)) throw new Error('--query: a URL query without "?", e.g. wb.data=fixtures&wb.user=board&wb.state=empty');
  const planned = list.map((route) => ({
    route,
    id: `${route.replace(/^\//, '').replace(/[^\w-]+/g, '-') || 'root'}${query === DEFAULT_QUERY ? '' : `-${crypto.createHash('sha256').update(query).digest('hex').slice(0, 6)}`}`,
  }));
  // Persist invalidation before any fallible work: an interrupted refresh must not reuse an old verdict or shot.
  clearReview(S);
  S.j.candidates = S.j.candidates.filter((c) => !planned.some((p) => p.id === c.id));
  S.save();
  tryGit(t.root, 'fetch', '-q', 'origin', t.base);
  const head = prepare(t, treeDir(t, 'main'), null).head;
  const port = t.cfg.handoff?.ports?.before ?? t.ports.before;
  await startServer(t, 'main', port);
  const err = await checkBundle(port, list[0]);
  if (err) throw new Error(`the main version of the design repo does not build: ${err}`);
  const { width, height } = S.j.viewport;
  const done = [];
  for (const { route, id } of planned) {
    const file = `shots/${id}.png`;
    const url = `http://localhost:${port}${route}?${query}`;
    // a fragment can sit below the fold: shoot a tall page so it is in the picture
    await capture(url, path.join(S.dir, file), { width, height: S.j.full ? height : Math.max(height, 1600), scale: S.j.scale, wait: 9000 });
    S.j.candidates = S.j.candidates.filter((c) => c.id !== id);
    S.j.candidates.push({ id, route, query, shot: file, from: { repo: t.gh ?? t.name, ref: t.base, sha: head, url } });
    S.save();
    done.push(id);
    say(`${route}: shot`);
  }
  return { session: S.s, shot: done, dir: path.join(S.dir, 'shots') };
}

function clearReview(S) {
  delete S.j.findings;
  delete S.j.best;
  delete S.j.compared;
  fs.rmSync(path.join(S.dir, 'standalone.html'), { force: true });
}

function locateCmd(t) {
  const S = session(t);
  if (!S.j.candidates.length) throw new Error('no workbench shots yet: run shoot');
  clearReview(S);
  for (const c of S.j.candidates) {
    delete c.match;
    delete c.matchError;
    delete c.diff;
  }
  S.save();
  const frag = readPng(path.join(S.dir, S.j.mobile));
  for (const c of S.j.candidates) {
    try {
      c.match = locate(frag, readPng(path.join(S.dir, c.shot)));
      c.match.strength = strength(c.match.score);
    } catch (e) {
      c.matchError = String(e.message ?? e).slice(0, 200);
    }
  }
  S.j.candidates.sort((a, b) => (b.match?.score ?? -2) - (a.match?.score ?? -2));
  S.j.best = S.j.candidates[0]?.match ? S.j.candidates[0].id : null;
  S.save();
  return { session: S.s, best: S.j.best, candidates: S.j.candidates.map((c) => ({ id: c.id, route: c.route, query: c.query, ...(c.match ?? { error: c.matchError }) })) };
}

function diffCmd(t) {
  const S = session(t);
  const id = arg('--candidate', S.j.best);
  const c = S.j.candidates.find((x) => x.id === id);
  if (!c?.match) throw new Error(id ? `candidate ${id} has no match: run locate` : 'run locate first');
  const shot = readPng(path.join(S.dir, c.shot));
  const design = crop(shot, c.match.x, c.match.y, c.match.w, c.match.h);
  const fit = resize(readPng(path.join(S.dir, S.j.mobile)), design.width, design.height);
  const d = path.join(S.dir, 'compare', c.id);
  writePng(path.join(d, 'design.png'), design);
  writePng(path.join(d, 'mobile-fit.png'), fit);
  const r = diffPng(path.join(d, 'design.png'), path.join(d, 'mobile-fit.png'), path.join(d, 'diff.png'));
  const [w, h] = r.size;
  c.diff = { dir: `compare/${c.id}`, changed: Math.round(r.changed_frac * 1000) / 10, ssim: r.ssim,
    regions: r.boxes.slice(0, 20).map(([x0, y0, x1, y1]) => ({ x: x0 / w, y: y0 / h, w: (x1 - x0 + 1) / w, h: (y1 - y0 + 1) / h })) };
  S.j.compared = c.id;
  S.save();
  return { session: S.s, candidate: c.id, route: c.route, ...c.diff, design: path.join(d, 'design.png'), mobile: path.join(d, 'mobile-fit.png'), diff: path.join(d, 'diff.png'),
    note: 'device vs browser rendering (fonts, anti-aliasing) always differs a little: read the diff as a map of where to look, then compare the two pictures yourself' };
}

// ── page ────────────────────────────────────────────────────────────────────────────────────────────────────────────

const KINDS = ['text', 'color', 'spacing', 'size', 'font', 'icon', 'missing', 'extra', 'order', 'state', 'other'];
const VERDICTS = ['match', 'differs', 'not-found'];
export function findingsErrors(f, candidates) {
  const e = [];
  if (!VERDICTS.includes(f?.verdict)) e.push(`verdict: ${VERDICTS.join(' | ')}`);
  if (typeof f?.summary !== 'string' || !f.summary.trim()) e.push('summary: a plain sentence or two');
  if (f?.verdict !== 'not-found' && !candidates.some((c) => c.id === f?.candidate)) e.push('candidate: the id of the compared workbench shot (from locate)');
  if (!Array.isArray(f?.differences ?? [])) e.push('differences must be a list');
  for (const [i, d] of (f?.differences ?? []).entries()) {
    if (!KINDS.includes(d?.kind)) e.push(`differences[${i}].kind: ${KINDS.join(' | ')}`);
    if (typeof d?.where !== 'string' || !d.where.trim()) e.push(`differences[${i}].where is required`);
    if (!['high', 'medium', 'low'].includes(d?.severity)) e.push(`differences[${i}].severity: high | medium | low`);
  }
  if (f?.verdict === 'differs' && !(f.differences ?? []).length) e.push('differs: list the differences');
  if (f?.verdict !== 'not-found' && !(Array.isArray(f?.logic) && f.logic.length)) e.push('logic: the screen\'s business rules in the design and whether mobile follows them now');
  return e.concat(logicErrors(f?.logic));
}

const SOURCES = ['design', 'task', 'spec', 'docs'];
const LOGIC = ['matches', 'differs', 'missing', 'unclear'];
const said = (v) => typeof v === 'string' && v.trim().length > 0;
/** The screen's business rules (from the design repo) against mobile now: a source, a status and evidence each. */
export function logicErrors(logic) {
  if (logic == null) return [];
  if (!Array.isArray(logic)) return ['logic must be a list'];
  const e = [];
  for (const [i, r] of logic.entries()) {
    if (!said(r?.rule)) {
      e.push(`logic[${i}].rule: the business rule in plain words`);
      continue;
    }
    if (!SOURCES.includes(r.source) || !said(r.ref)) e.push(`logic[${i}]: source (${SOURCES.join(' | ')}) and ref (where it is in the design repo) are required`);
    if (!LOGIC.includes(r.status)) {
      e.push(`logic[${i}].status: ${LOGIC.join(' | ')}`);
      continue;
    }
    if (r.status !== 'unclear' && !said(r.mobile) && r.seen !== true) e.push(`logic[${i}]: ${r.status} needs evidence — mobile (code path:line) or seen: true (visible on the screenshot)`);
    if (r.status !== 'matches' && !said(r.note)) e.push(`logic[${i}]: ${r.status} needs a note — what mobile does instead, or what is unknown`);
  }
  return e;
}
/** Matched of the rules that could be checked; unclear ones apart, never as matches. */
export function logicScore(logic) {
  const rules = logic ?? [];
  const checked = rules.filter((r) => r.status !== 'unclear');
  const matches = checked.filter((r) => r.status === 'matches').length;
  return { total: rules.length, checked: checked.length, matches, unclear: rules.length - checked.length, percent: checked.length ? Math.round((100 * matches) / checked.length) : null };
}
const b64 = (file) => (fs.existsSync(file) ? `data:image/png;base64,${fs.readFileSync(file).toString('base64')}` : null);

function page(t) {
  const S = session(t);
  const file = arg('--file');
  let f = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : S.j.findings ?? null;
  if (f) {
    const errs = findingsErrors(f, S.j.candidates);
    if (errs.length) throw new Error(`findings refused:\n- ${errs.join('\n- ')}`);
    S.j.findings = f;
  }
  const c = S.j.candidates.find((x) => x.id === (f?.candidate ?? S.j.compared));
  const data = {
    title: arg('--title', S.j.title ?? 'Мобилка и дизайн'), at: new Date().toISOString(), session: S.s, full: S.j.full, viewport: S.j.viewport, scale: S.j.scale,
    findings: f, logic: f?.logic?.length ? logicScore(f.logic) : null, candidate: c ? { id: c.id, route: c.route, query: c.query, from: c.from, match: c.match, diff: c.diff } : null,
    mobile: b64(path.join(S.dir, 'source.png')),
    pics: c?.diff ? { design: b64(path.join(S.dir, c.diff.dir, 'design.png')), mobile: b64(path.join(S.dir, c.diff.dir, 'mobile-fit.png')), diff: b64(path.join(S.dir, c.diff.dir, 'diff.png')) } : null,
    others: S.j.candidates.filter((x) => x !== c).map((x) => ({ id: x.id, route: x.route, query: x.query, score: x.match?.score ?? null, strength: x.match?.strength ?? null, error: x.matchError ?? null })),
  };
  S.j.title = data.title;
  S.save();
  const tpl = fs.readFileSync(new URL('./page.html', import.meta.url), 'utf8');
  const json = JSON.stringify(data).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  const outFile = path.join(S.dir, 'standalone.html');
  fs.writeFileSync(outFile, tpl.replace('/*__DATA__*/null', () => json));
  if (flag('--open')) spawnSync('open', [outFile]);
  return { session: S.s, page: outFile, verdict: f?.verdict ?? 'not judged yet', logic: data.logic };
}

function status(t) {
  const S = session(t);
  return { dir: S.dir, ...S.j };
}

async function main() {
  if (cliHelp(argv, import.meta.url)) return;
  const t = target(arg('--target'));
  switch (argv[0]) {
    case 'prep': return out(prep(t));
    case 'routes': return out(routes(t));
    case 'shoot': return out(await shoot(t));
    case 'locate': return out(locateCmd(t));
    case 'diff': return out(diffCmd(t));
    case 'page': return out(page(t));
    case 'status': return out(status(t));
    default:
      console.error('commands: prep · routes · shoot · locate · diff · page · status (--help)');
      process.exit(1);
  }
}
if (isMain(import.meta.url)) main().catch((e) => {
  console.error(`match: ${e.message ?? e}`);
  process.exit(2);
});
