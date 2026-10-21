// Shared helpers: which design repo we work on, where its copies live, how to run things.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const HOME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const isMain = (url) => Boolean(process.argv[1]) && url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
/** Print usage before looking up a project or starting any external work. */
export function cliHelp(argv, scriptUrl) {
  if (argv.length && argv[0] !== 'help' && !argv.includes('--help') && !argv.includes('-h')) return false;
  const source = fs.readFileSync(fileURLToPath(scriptUrl), 'utf8').split('\n');
  const header = [];
  for (const line of source.slice(1)) {
    if (!line.startsWith('//')) break;
    header.push(line.replace(/^\/\/ ?/, ''));
  }
  console.log(header.join('\n'));
  console.log('\nFull plugin guide: use the help skill, or run:');
  const helper = path.join(HOME, '../help/scripts/help.py').replace(/'/g, "'\\''");
  console.log(`python3 '${helper}'`);
  return true;
}
/** The person's settings: where their design repo is, which repos the team uses (written by setup). $HANDOFF_CONFIG for tests. */
export const CONFIG_FILE = process.env.HANDOFF_CONFIG ?? path.join(os.homedir(), '.handoff.json');
/** Generic defaults (skills/filter-design/defaults.json) under the team's own settings from ~/.handoff.json. */
export const DEFAULTS = (() => {
  let base = {};
  try {
    base = JSON.parse(fs.readFileSync(path.join(HOME, 'defaults.json'), 'utf8'));
  } catch {
    /* none */
  }
  let mine = {};
  try {
    mine = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    /* not set up yet */
  }
  const pick = (k) => (mine[k] != null ? mine[k] : base[k]);
  return { designRepo: pick('designRepo'), mobileRepo: pick('mobileRepo'), home: pick('home'), base: pick('base'), lightPaths: pick('lightPaths') };
})();
export const expandHome = (p) => (p ? p.replace(/^~(?=$|\/)/, os.homedir()) : p);
export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
export const readJson = (f, d = null) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return d;
  }
};
export const writeJson = (f, v) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const temp = `${f}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(v, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temp, f);
  } finally {
    fs.rmSync(temp, { force: true });
  }
};
/** Exclusive across CLI processes; never expire a lock while a remote write might still be running. */
export async function withFileLock(file, fn) {
  let fd;
  try {
    fd = fs.openSync(file, 'wx', 0o600);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    throw new Error(`another Linear operation owns ${file}; retry when it finishes. After an interrupted process, confirm the owner in this file has stopped before removing the lock`);
  }
  const release = () => {
    if (fd === undefined) return;
    fs.closeSync(fd);
    fd = undefined;
    fs.unlinkSync(file);
  };
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString() }));
    return await fn();
  } finally {
    release();
  }
}
export const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
export const tryGit = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 << 20 });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
};
export const slugOk = (s) => /^[a-z0-9][a-z0-9-]{0,47}$/.test(String(s ?? ''));

/**
 * The design repo: --target, $HANDOFF_TARGET, the current folder (if it has workbench.config.json), or ~/.handoff.json
 * → { target }. Everything else is read from the repo itself — no project names in this plugin.
 */
export function target(argTarget = null) {
  const conf = readJson(CONFIG_FILE, {});
  const cands = [argTarget, process.env.HANDOFF_TARGET, process.cwd(), conf.target].filter(Boolean).map(expandHome);
  const root = cands.map((c) => path.resolve(c)).find((c) => fs.existsSync(path.join(c, 'workbench.config.json')) && fs.existsSync(path.join(c, '.git')));
  if (!root) throw new Error('the workspace is not set up: ask Claude to "set up handoff" (node scripts/setup.mjs run) — it downloads the design repo; or pass --target <folder with workbench.config.json>');
  // light mode: a shallow, sparse copy of the repo (theme, screens, task rules) — no app to run, no "now" shots
  const light = fs.existsSync(path.join(root, '.handoff-light'));
  const cfg = readJson(path.join(root, 'workbench.config.json'), {});
  const local = readJson(path.join(root, '.workbench-cache/stand.local.json'), {});
  const origin = tryGit(root, 'remote', 'get-url', 'origin').out;
  const gh = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(origin)?.[1] ?? null;
  const name = path.basename(root);
  const work = path.join(path.dirname(root), `.${name}-handoff`); // hidden sibling: never inside the repo
  const mobile = [local.mobileClone, conf.mobile, process.env.HANDOFF_MOBILE].filter(Boolean).map(expandHome)
    .find((d) => fs.existsSync(path.join(d, '.git'))) ?? null;
  const port = Number(cfg.port ?? 8090);
  return { root, cfg, name, origin, gh, work, mobile, mobileRepo: conf.mobileRepo ?? DEFAULTS.mobileRepo ?? null, light, port, base: cfg.handoff?.base ?? DEFAULTS.base ?? 'main', ports: { before: port + 300, after: port + 301 } };
}
export const stateDir = (t, slug) => path.join(t.work, 'state', slug);
export const treeDir = (t, which) => path.join(t.work, which); // «main» (before) or the slug (after)

/** Expo Router files → routes: «(group)» folders dropped, index → its folder, _layout / +html etc. skipped. */
export function routesOf(files) {
  return files
    .filter((f) => /^app\/.+\.(tsx|ts|jsx|js)$/.test(f) && !/(^|\/)(_layout|\+[\w-]+)\.\w+$/.test(f))
    .map((f) => `/${f.replace(/^app\//, '').replace(/\.\w+$/, '').split('/').filter((x) => !/^\(.*\)$/.test(x)).join('/')}`.replace(/\/index$/, '') || '/');
}
/** Does one of these route patterns ([id] = any segment) match the route? */
export function routeIn(route, routes) {
  const pattern = (m) => m.split('/').map((seg) => (/^\[.+\]$/.test(seg) ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/');
  return routes.some((m) => new RegExp(`^${pattern(m)}/?$`).test(route));
}
/** Routes a git tree has (a ref of a repo, or a working dir). */
export function routesAt(dir, ref = null) {
  const files = ref ? tryGit(dir, 'ls-tree', '-r', '--name-only', ref, 'app/').out.split('\n') : listFiles(path.join(dir, 'app')).map((f) => `app/${f}`);
  return routesOf(files.filter(Boolean));
}
/** Routes of a GitHub repo's app/ at a ref, without a clone (gh api) — the light mode's mobile check. */
export function routesRemote(repo, ref = 'main') {
  const r = spawnSync('gh', ['api', `repos/${repo}/git/trees/${ref}?recursive=1`, '--jq', '.tree[].path'], { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`gh api ${repo}: ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
  return routesOf(r.stdout.split('\n').filter((f) => f.startsWith('app/')));
}
function listFiles(dir, rel = '') {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listFiles(path.join(dir, e.name), `${rel}${e.name}/`) : [`${rel}${e.name}`]));
}
export const say = (s) => console.error(`[${new Date().toTimeString().slice(0, 8)}] ${s}`);
