import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const lib = new URL('../../skills/filter-design/scripts/lib.mjs', import.meta.url).href;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-target-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'design');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  fs.writeFileSync(path.join(repo, 'workbench.config.json'), '{}');
  const config = path.join(root, 'settings.json');
  const local = path.join(repo, '.workbench-cache/stand.local.json');
  fs.mkdirSync(path.dirname(local));
  const mobile = (name) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    execFileSync('git', ['init', '-q', dir]);
    return dir;
  };
  const resolve = (env = {}) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
    `import { target } from ${JSON.stringify(lib)}; console.log(JSON.stringify(target(process.argv[1]).mobile));`, repo], {
    encoding: 'utf8', env: { ...process.env, HANDOFF_CONFIG: config, HANDOFF_MOBILE: '', ...env },
  }));
  return { root, config, local, mobile, resolve };
}

test('mobile lookup uses explicit settings in order, then the neutral environment variable', (t) => {
  const f = fixture(t);
  const envMobile = f.mobile('env-mobile');
  const configured = f.mobile('configured-mobile');
  const local = f.mobile('local-mobile');
  const env = { HANDOFF_MOBILE: envMobile };
  assert.equal(f.resolve(env), envMobile);
  fs.writeFileSync(f.config, JSON.stringify({ mobile: configured }));
  assert.equal(f.resolve(env), configured);
  fs.writeFileSync(f.local, JSON.stringify({ mobileClone: local }));
  assert.equal(f.resolve(env), local);
  fs.writeFileSync(f.local, JSON.stringify({ mobileClone: path.join(f.root, 'missing') }));
  assert.equal(f.resolve(env), configured);
});

test('mobile lookup stays unset without configuration and rejects non-repository paths', (t) => {
  const f = fixture(t);
  f.mobile('mobile');
  f.mobile('app.mobile');
  assert.equal(f.resolve(), null);
  const ordinary = path.join(f.root, 'ordinary-folder');
  fs.mkdirSync(ordinary);
  assert.equal(f.resolve({ HANDOFF_MOBILE: ordinary }), null);
  assert.equal(f.resolve({ HANDOFF_MOBILE: path.join(f.root, 'missing') }), null);
});
