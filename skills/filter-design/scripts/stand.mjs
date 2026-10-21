// Copies of the design repo beside it (../.<repo>-handoff/<name>) and their Expo web servers on spare ports.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { git, readJson, treeDir, tryGit, writeJson } from './lib.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A worktree of the repo: detached at origin/<base> (branch = null, follows main) or on `branch`; deps, LFS, env in. */
export function prepareTree(t, dir, branch) {
  const fresh = !fs.existsSync(path.join(dir, '.git'));
  if (fresh) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    if (branch) {
      const exists = tryGit(t.root, 'rev-parse', '--verify', `refs/heads/${branch}`).ok;
      git(t.root, 'worktree', 'add', '-q', ...(exists ? [dir, branch] : ['-b', branch, dir, `origin/${t.base}`]));
    } else git(t.root, 'worktree', 'add', '-q', '--detach', dir, `origin/${t.base}`);
  } else if (!branch) git(dir, 'checkout', '-q', '--detach', `origin/${t.base}`); // «before» follows main
  // images live in Git LFS: fill them from the repo's own LFS store (no network)
  tryGit(dir, 'lfs', 'checkout');
  // dependencies: an APFS clone of the repo's node_modules (copy-on-write, seconds) — a real folder, Metro is happy
  if (!fs.existsSync(path.join(dir, 'node_modules')) && fs.existsSync(path.join(t.root, 'node_modules'))) {
    const r = spawnSync('cp', ['-cR', path.join(t.root, 'node_modules'), path.join(dir, 'node_modules')]);
    if (r.status !== 0) spawnSync('cp', ['-R', path.join(t.root, 'node_modules'), path.join(dir, 'node_modules')]);
  }
  // local env (git-ignored): the copy talks to the same mocks / dev backend as the repo
  for (const f of fs.readdirSync(t.root).filter((f) => /^\.env(\..*)?\.local$|^\.env\.local$/.test(f))) fs.copyFileSync(path.join(t.root, f), path.join(dir, f));
  return { dir, fresh, head: git(dir, 'rev-parse', 'HEAD') };
}

// ── servers: one Expo web per copy, on spare ports, stopped after 15 idle minutes ──
export async function up(port) {
  try {
    return (await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(3000) })).ok;
  } catch {
    return false;
  }
}
export async function serve(t, which, port) {
  const dir = treeDir(t, which);
  const pidFile = path.join(t.work, 'state', `server-${port}.json`);
  const cur = readJson(pidFile);
  if (cur && cur.dir === dir && alive(cur.pid) && (await up(port))) return touch(pidFile, cur);
  if (cur && alive(cur.pid)) try { process.kill(-cur.pid, 'SIGTERM'); } catch { /* gone */ }
  if (await up(port)) throw new Error(`port ${port} is taken by another process — free it or set workbench.config.json → handoff.ports`);
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  const log = fs.openSync(path.join(t.work, 'state', `server-${port}.log`), 'w');
  const child = spawn(path.join(dir, 'node_modules/.bin/expo'), ['start', '--web', '--port', String(port)], { cwd: dir, detached: true, stdio: ['ignore', log, log], env: { ...process.env, BROWSER: 'none', EXPO_NO_TELEMETRY: '1' } });
  child.unref();
  const rec = { pid: child.pid, dir, port, startedAt: new Date().toISOString() };
  writeJson(pidFile, rec);
  for (let i = 0; i < 120 && !(await up(port)); i++) await sleep(1000);
  if (!(await up(port))) throw new Error(`the "${which}" copy did not start on :${port} — log: ${path.join(t.work, 'state', `server-${port}.log`)}`);
  return touch(pidFile, rec);
}
function touch(pidFile, rec) {
  writeJson(pidFile, { ...rec, touchedAt: Date.now() });
  // the idle stop: a detached sleeper ends the server 15 minutes after the last use
  spawn(process.execPath, ['-e', `setTimeout(()=>{try{const fs=require('fs');const r=JSON.parse(fs.readFileSync(${JSON.stringify(pidFile)},'utf8'));if(Date.now()-r.touchedAt<890000)process.exit(0);process.kill(-r.pid,'SIGTERM');fs.rmSync(${JSON.stringify(pidFile)},{force:true})}catch{}},900000)`], { detached: true, stdio: 'ignore' }).unref();
  return rec;
}
export function stopAll(t) {
  const dir = path.join(t.work, 'state');
  const stopped = [];
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => /^server-\d+\.json$/.test(x)) : []) {
    const r = readJson(path.join(dir, f));
    if (r && alive(r.pid)) try { process.kill(-r.pid, 'SIGTERM'); stopped.push(r.port); } catch { /* gone */ }
    fs.rmSync(path.join(dir, f), { force: true });
  }
  return { stopped };
}
/** First compile takes a minute: warm the bundle, and fail with Metro's own message when it doesn't build. */
export async function bundleError(port, route) {
  const html = await (await fetch(`http://localhost:${port}${route}`)).text();
  const src = /<script src="([^"]*bundle[^"]*)"/.exec(html)?.[1];
  if (!src) return null;
  const r = await fetch(`http://localhost:${port}${src}`, { signal: AbortSignal.timeout(600_000) });
  if (r.ok) return null;
  try {
    return String(JSON.parse(await r.text()).message).split('\n')[0];
  } catch {
    return `the bundle answered ${r.status}`;
  }
}

