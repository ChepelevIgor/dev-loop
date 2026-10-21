import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { serve } from '../../skills/filter-design/scripts/stand.mjs';

test('first server launch creates its state directory before opening the log', async (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'stand-first-'));
  let started = false;
  let log;
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    if (log !== undefined) fs.closeSync(log);
    fs.rmSync(work, { recursive: true, force: true });
  });
  // Exercise the real server setup without launching Expo, a sleeper, or opening sockets.
  t.mock.method(globalThis, 'fetch', async () => ({ ok: started }));
  t.mock.method(childProcess, 'spawn', (command, args, options) => {
    if (command.endsWith('/node_modules/.bin/expo')) {
      log = options.stdio[1];
      fs.writeSync(log, 'fixture server started');
      started = true;
    }
    return { pid: process.pid, unref() {} };
  });
  syncBuiltinESMExports();
  const result = await serve({ work }, 'main', 18490);
  assert.ok(started);
  assert.equal(result.dir, path.join(work, 'main'));
  assert.equal(fs.readFileSync(path.join(work, 'state/server-18490.log'), 'utf8'), 'fixture server started');
  assert.equal(JSON.parse(fs.readFileSync(path.join(work, 'state/server-18490.json'))).dir, result.dir);
});
