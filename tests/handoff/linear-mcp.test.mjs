import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureLinearMcp, LINEAR_MCP_URL } from '../../skills/filter-design/scripts/linear-mcp.mjs';
import { readTasks, taskIds } from '../../skills/filter-design/scripts/tasks.mjs';
import { client } from '../../skills/filter-design/scripts/linear.mjs';
import { mockClaude } from './mcp-fixture.mjs';

function cli(results) {
  const calls = [];
  const run = (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd, timeout: options.timeout });
    assert.ok(results.length, 'unexpected CLI call');
    const next = results.shift();
    return typeof next === 'string' ? { status: 0, stdout: next } : next;
  };
  return { run, calls };
}

test('reuse the official Linear server under its existing name without adding or authenticating again', () => {
  const mock = cli(['team-linear: https://mcp.linear.app/mcp (HTTP) - ✓ Connected']);
  const result = ensureLinearMcp('/project', mock);
  assert.equal(result.status, 'connected');
  assert.equal(result.server, 'team-linear');
  assert.equal(result.added, false);
  assert.equal(mock.calls.length, 1);
});

test('register official HTTP MCP in local scope, then distinguish OAuth from a usable connection', () => {
  const mock = cli(['No MCP servers configured.', 'Added', 'linear-server: https://mcp.linear.app/mcp (HTTP) - ! Needs authentication']);
  const result = ensureLinearMcp('/project', mock);
  assert.equal(result.status, 'needs_authentication');
  assert.equal(result.added, true);
  assert.deepEqual(mock.calls[1], {
    command: 'claude', args: ['mcp', 'add', '--transport', 'http', '--scope', 'local', 'linear-server', LINEAR_MCP_URL],
    cwd: '/project', timeout: 10_000,
  });
  assert.match(result.next, /\/mcp/);
});

test('existing auth, read-only, pending approval and legacy connections are not overwritten', () => {
  for (const [listing, status] of [
    ['linear: https://mcp.linear.app/mcp (HTTP) - ! Needs authentication', 'needs_authentication'],
    ['linear: https://mcp.linear.app/mcp/readonly (HTTP) - ✓ Connected', 'read_only'],
    ['linear: https://mcp.linear.app/mcp (HTTP) - ⏸ Pending approval', 'approval_required'],
    ['linear: npx -y mcp-remote https://mcp.linear.app/sse - ✓ Connected', 'connection_unverified'],
    ['linear-server: https://another.example/mcp (HTTP) - ✓ Connected', 'name_conflict'],
  ]) {
    const mock = cli([listing]);
    assert.equal(ensureLinearMcp('/project', mock).status, status);
    assert.equal(mock.calls.length, 1);
  }
});

test('unavailable or ambiguous discovery and failed registration retain sanitized actionable state', () => {
  const sensitive = 'do-not-echo-credential-value';
  for (const [response, status] of [
    [{ error: { code: 'ENOENT' }, stderr: sensitive }, 'cli_missing'],
    [{ error: { code: 'ETIMEDOUT' }, stderr: sensitive }, 'discovery_failed'],
    [{ status: 1, stderr: sensitive }, 'discovery_failed'],
    [{ status: 0, stdout: sensitive }, 'discovery_failed'],
  ]) {
    const mock = cli([response]);
    const result = ensureLinearMcp('/project', mock);
    assert.equal(result.status, status);
    assert.ok(!JSON.stringify(result).includes(sensitive));
    assert.equal(mock.calls.length, 1);
  }
  const failed = cli(['No MCP servers configured.', { status: 1, stderr: sensitive }]);
  const result = ensureLinearMcp('/project', failed);
  assert.equal(result.status, 'configuration_failed');
  assert.ok(!JSON.stringify(result).includes(sensitive));
});

test('check-only mode never registers; a successful add is not treated as authentication', () => {
  const check = cli(['No MCP servers configured.']);
  assert.equal(ensureLinearMcp('/project', { ...check, connect: false }).status, 'not_configured');
  assert.equal(check.calls.length, 1);
  const add = cli(['No MCP servers configured.', 'Added', { status: 1 }]);
  assert.equal(ensureLinearMcp('/project', add).status, 'registered');
});

test('task IDs accept one or several tasks and reject ambiguous input before connection', async () => {
  assert.deepEqual(taskIds(['t-10', 'T-11,T-10']), ['T-10', 'T-11']);
  for (const ids of [[], [''], ['T-10,'], ['T-10', '../secret'], ['a task']]) {
    await assert.rejects(readTasks(ids, { key: null, connect: () => assert.fail('must not connect') }), /task IDs/);
  }
});

test('task lookup without a key preserves exact IDs for the Claude MCP read-only handoff', async () => {
  const result = await readTasks(['T-10', 'T-11'], {
    root: '/app-project', key: null, getClient: () => assert.fail('must not call API'),
    connect: (root) => { assert.equal(root, '/app-project'); return { status: 'needs_authentication' }; },
  });
  assert.equal(result.status, 'needs_mcp');
  assert.equal(result.operation, 'read_tasks');
  assert.deepEqual(result.identifiers, ['T-10', 'T-11']);
  assert.deepEqual(result.tasks, []);
  assert.match(result.next, /read-only/);
});

test('API task lookup keeps each task separate and can report unavailable IDs without losing successful ones', async () => {
  const calls = [];
  const result = await readTasks(['T-10', 'T-11', 'T-12'], {
    key: 'local-test-key', connect: () => assert.fail('a key is already available'),
    getClient: () => ({ taskDetails: async (id) => {
      calls.push(id);
      if (id === 'T-11') throw new Error('do-not-echo-credential-value');
      return { identifier: id, description: `Scope for ${id}`, attachments: [] };
    } }),
  });
  assert.deepEqual(calls, ['T-10', 'T-11', 'T-12']);
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.tasks.map((x) => x.identifier), ['T-10', 'T-12']);
  assert.deepEqual(result.unavailable.map((x) => x.identifier), ['T-11']);
  assert.ok(!JSON.stringify(result).includes('do-not-echo-credential-value'));
});

test('read-only task context includes PR links from later attachment pages', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const calls = [];
  globalThis.fetch = async (_url, opts) => {
    const { query, variables } = JSON.parse(opts.body);
    assert.ok(query.startsWith('query'));
    calls.push(variables);
    const more = variables.after === null;
    return { ok: true, json: async () => ({ data: { issue: {
      id: 'uuid', identifier: 'T-10', title: 'Save profile', description: 'The name survives a restart.',
      url: 'https://linear.app/team/issue/T-10', branchName: 'suggested-only',
      attachments: { nodes: more ? [] : [{ title: 'PR', url: 'https://github.com/team/app/pull/10' }],
        pageInfo: { hasNextPage: more, endCursor: more ? 'next' : null } },
    } } }) };
  };
  const task = await client('local-test-key').taskDetails('T-10');
  assert.deepEqual(calls, [{ id: 'T-10', after: null }, { id: 'T-10', after: 'next' }]);
  assert.equal(task.attachments[0].url, 'https://github.com/team/app/pull/10');
  assert.equal(task.suggestedBranch, 'suggested-only');
});

test('task context refuses mismatched issues and incomplete or looping attachment pages', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  for (const issue of [
    { identifier: 'T-11' },
    { identifier: 'T-10', attachments: {} },
    { identifier: 'T-10', attachments: { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'same' } } },
  ]) {
    let count = 0;
    globalThis.fetch = async () => { assert.ok(++count <= 2); return { ok: true, json: async () => ({ data: { issue } }) }; };
    await assert.rejects(client('local-test-key').taskDetails('T-10'), /requested task|incomplete task links|invalid task link cursor/);
  }
});

test('task and setup CLIs use the MCP fallback in the requested app project, without a design repository', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'linear-task-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, ...mockClaude(root), LINEAR_API_KEY: '' };
  const scripts = fileURLToPath(new URL('../../skills/filter-design/scripts/', import.meta.url));
  const run = (script, ...args) => {
    const r = spawnSync(process.execPath, [path.join(scripts, script), ...args], { cwd: root, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const check = run('setup.mjs', 'linear', '--check');
  assert.equal(check.status, 'not_configured');
  assert.equal(fs.existsSync(env.MCP_TEST_STATE), false);
  const pending = run('tasks.mjs', 'show', 'T-10', 'T-11', '--root', root);
  assert.deepEqual(pending.identifiers, ['T-10', 'T-11']);
  assert.equal(pending.connection.status, 'needs_authentication');
  assert.equal(fs.existsSync(path.join(root, '.devloop')), false);
  assert.equal(fs.existsSync(path.join(root, '.mcp.json')), false);
  const before = fs.readFileSync(env.MCP_TEST_LOG, 'utf8');
  fs.writeFileSync(path.join(root, '.env.local'), 'LINEAR_API_KEY=fixture-only-key\n');
  delete env.LINEAR_API_KEY;
  assert.equal(run('setup.mjs', 'linear').status, 'key_available');
  assert.equal(fs.readFileSync(env.MCP_TEST_LOG, 'utf8'), before, 'a local key must bypass Claude');
});
