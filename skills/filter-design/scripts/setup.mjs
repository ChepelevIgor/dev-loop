#!/usr/bin/env node
// Getting a designer's machine ready, from nothing.
//   node scripts/setup.mjs status                     what's there: GitHub sign-in, git-lfs, Node, Chrome, the design repo,
//                                                     mobile, Linear — and what's missing, in plain words
//   node scripts/setup.mjs run --repo <owner/name> [--mobile-repo <owner/name>] [--light] [--with-mobile] [--dir …]
//       --repo / --mobile-repo: which design (and mobile) repo the team uses — asked once, remembered in ~/.handoff.json
//       full  (default): clone the design repo (~/.handoff.json → designRepo, set with --repo owner/name) into <dir>, its images (git-lfs),
//             its dependencies (npm ci, a few minutes once) — everything works, "now" screenshots included
//       light: a shallow copy of only what the checks read (theme, screens, task rules — defaults.json →
//             lightPaths), a few MB, no install — everything except "now in the app"
//       --with-mobile: the mobile repo next to it (the "is the screen in mobile" check); in light mode mobile is read
//             from GitHub without a clone
//   Writes ~/.handoff.json { target, mobile?, mode }. Safe to re-run: what exists is kept and updated.
//   --repo-url / --mobile-url override where to clone from (tests, mirrors).
//   node scripts/setup.mjs linear [--target <project>] [--check]
//       no API key: discover Linear in Claude Code; add its official MCP locally if missing.
//       --check only inspects; OAuth is completed in Claude's /mcp menu.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CONFIG_FILE, DEFAULTS, cliHelp, expandHome, readJson, say, writeJson } from './lib.mjs';
import { linearKey } from './linear.mjs';
import { ensureLinearMcp } from './linear-mcp.mjs';

const argv = process.argv.slice(2);
const arg = (k, d = null) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const flag = (k) => argv.includes(k);
const out = (v) => console.log(JSON.stringify(v));
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 << 20, ...opts });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim(), missing: r.error?.code === 'ENOENT' };
};
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function status() {
  const conf = readJson(CONFIG_FILE, {});
  const gh = run('gh', ['auth', 'status']);
  const lfs = run('git', ['lfs', 'version']);
  const node = process.versions.node.split('.').map(Number);
  const target = conf.target && expandHome(conf.target);
  const repoOk = Boolean(target && fs.existsSync(path.join(target, 'workbench.config.json')));
  const light = repoOk && fs.existsSync(path.join(target, '.handoff-light'));
  const deps = repoOk && !light && fs.existsSync(path.join(target, 'node_modules'));
  const linear = Boolean(linearKey(target || process.cwd()));
  const items = [
    { what: 'GitHub sign-in (gh)', ok: gh.ok, fix: gh.missing ? 'install: brew install gh' : 'once: gh auth login (sign in in the browser)' },
    { what: 'git-lfs (the repo images)', ok: lfs.ok, fix: 'brew install git-lfs && git lfs install', optional: true },
    { what: 'Node 22+', ok: node[0] >= 22, fix: 'brew install node@22' },
    { what: 'Google Chrome (screenshots, token check)', ok: fs.existsSync(CHROME), fix: 'install Google Chrome' },
    { what: `Design repo (${DEFAULTS.designRepo ?? '?'})`, ok: repoOk, fix: 'node scripts/setup.mjs run (or --light)' },
    { what: 'Repo dependencies (for "now in the app")', ok: deps, fix: light ? 'light mode: no "now" shots; full mode — setup run' : 'node scripts/setup.mjs run', optional: true },
    { what: 'Mobile (the "is the screen there" check)', ok: Boolean(conf.mobile && fs.existsSync(expandHome(conf.mobile))) || (light && gh.ok), fix: 'setup run --with-mobile', optional: true },
    { what: 'Linear access', ok: linear ? true : null, transport: linear ? 'api' : 'mcp_not_checked', fix: 'No API key needed: run setup.mjs linear in the target project to try the Linear MCP in Claude, then sign in through /mcp if needed.', optional: true },
  ];
  return { ready: items.filter((x) => !x.optional).every((x) => x.ok), mode: repoOk ? (light ? 'light' : 'full') : null, target: target ?? null, items, config: CONFIG_FILE };
}

function setupRun() {
  const light = flag('--light');
  const home = path.resolve(expandHome(arg('--dir', DEFAULTS.home ?? '~/handoff')));
  const repo = arg('--repo') ?? DEFAULTS.designRepo;
  const mobileRepo = arg('--mobile-repo') ?? DEFAULTS.mobileRepo;
  if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('--repo: owner/name, e.g. acme/design-workbench');
  const url = arg('--repo-url') ?? (repo ? `https://github.com/${repo}.git` : null);
  if (!url) throw new Error('which design repo? Ask the user once and run: setup.mjs run --repo <owner/name> (remembered in ~/.handoff.json)');
  if (!arg('--repo-url')) {
    const gh = run('gh', ['auth', 'status']);
    if (!gh.ok) throw new Error(gh.missing ? 'no GitHub CLI: brew install gh, then gh auth login' : 'not signed in to GitHub: once gh auth login (sign in in the browser), then retry');
    run('gh', ['auth', 'setup-git']); // git clone over https with the gh sign-in
  }
  fs.mkdirSync(home, { recursive: true });
  const name = repo ? repo.split('/')[1] : path.basename(url, '.git');
  const dir = path.join(home, light ? `${name}-light` : name);
  const steps = [];
  if (fs.existsSync(path.join(dir, '.git'))) {
    // ours to update: a light copy follows main; a full clone only fetches (the person may have work in it)
    const r = light ? run('git', ['-C', dir, 'pull', '-q', '--depth', '1', '--rebase=false']) : run('git', ['-C', dir, 'fetch', '-q', 'origin']);
    steps.push(`${dir}: already there, ${r.ok ? 'updated' : `could not update: ${r.out.slice(0, 160)}`}`);
  } else if (light) {
    say('light mode: taking only the theme, screens and task rules');
    const r = run('git', ['clone', '-q', '--depth', '1', '--filter=blob:none', '--sparse', url, dir], { env: { ...process.env, GIT_LFS_SKIP_SMUDGE: '1' } });
    if (!r.ok) throw new Error(`${repo ?? url} did not download: ${r.out.slice(0, 300)} — do you have access to the repo?`);
    const paths = DEFAULTS.lightPaths ?? ['workbench.config.json', 'app', 'src/shared/theme', 'knowledge-base/tasks'];
    const sp = run('git', ['-C', dir, 'sparse-checkout', 'set', '--no-cone', ...paths.map((p) => `/${p}`)]);
    if (!sp.ok) throw new Error(`sparse-checkout: ${sp.out.slice(0, 200)}`);
    fs.writeFileSync(path.join(dir, '.handoff-light'), 'light copy (setup --light): theme, screens, task rules only\n');
    fs.appendFileSync(path.join(dir, '.git/info/exclude'), '.handoff-light\n');
    steps.push(`${dir}: light copy`);
  } else {
    say(`downloading ${repo ?? url} into ${dir}`);
    const r = run('git', ['clone', '-q', url, dir]);
    if (!r.ok) throw new Error(`${repo ?? url} did not download: ${r.out.slice(0, 300)} — do you have access to the repo?`);
    steps.push(`${dir}: downloaded`);
  }
  if (!light) {
    const lfs = run('git', ['-C', dir, 'lfs', 'pull']);
    steps.push(lfs.ok ? 'images (git-lfs): done' : `images (git-lfs): failed — ${lfs.missing ? 'brew install git-lfs' : lfs.out.slice(0, 120)}`);
    if (!fs.existsSync(path.join(dir, 'node_modules')) && fs.existsSync(path.join(dir, 'package.json')) && !flag('--no-install')) {
      say('installing dependencies (npm ci, a few minutes, once)');
      const ci = run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: dir, timeout: 1_800_000 });
      steps.push(ci.ok ? 'dependencies: done' : `dependencies: failed — ${ci.out.split('\n').slice(-3).join(' ').slice(0, 200)}`);
    }
  }
  const conf = { ...readJson(CONFIG_FILE, {}), target: dir, mode: light ? 'light' : 'full', ...(repo ? { designRepo: repo } : {}), ...(mobileRepo ? { mobileRepo } : {}) };
  if (flag('--with-mobile') && !light) {
    const murl = arg('--mobile-url') ?? (mobileRepo ? `https://github.com/${mobileRepo}.git` : null);
    if (murl) {
      const mdir = path.join(home, mobileRepo ? mobileRepo.split('/')[1] : 'mobile');
      const r = fs.existsSync(path.join(mdir, '.git')) ? run('git', ['-C', mdir, 'fetch', '-q', 'origin']) : run('git', ['clone', '-q', '--filter=blob:none', '--no-checkout', murl, mdir], { env: { ...process.env, GIT_LFS_SKIP_SMUDGE: '1' } });
      steps.push(r.ok ? `mobile: ${mdir}` : `mobile did not download: ${r.out.slice(0, 160)}`);
      if (r.ok) conf.mobile = mdir;
    }
  }
  writeJson(CONFIG_FILE, conf);
  return { mode: conf.mode, target: dir, steps, config: CONFIG_FILE, next: status().items.filter((x) => !x.ok).map((x) => `${x.what}: ${x.fix}`) };
}

try {
  if (cliHelp(argv, import.meta.url)) { /* Read-only help works without setup. */ }
  else if (argv[0] === 'status') out(status());
  else if (argv[0] === 'linear') {
    const root = path.resolve(expandHome(arg('--target', process.cwd())));
    out(linearKey(root) ? { transport: 'api', status: 'key_available' } : ensureLinearMcp(root, { connect: !flag('--check') }));
  }
  else if (argv[0] === 'run') out(setupRun());
  else {
    console.error('commands: status · run [--light] [--with-mobile] [--dir …] · linear [--target <project>] [--check]');
    process.exit(2);
  }
} catch (e) {
  console.error(`✗ ${e.message ?? e}`);
  process.exit(1);
}
