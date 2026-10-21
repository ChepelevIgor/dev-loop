import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openapi } from '../../skills/filter-design/scripts/check.mjs';

test('backend lookup makes no request without explicit project configuration', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('unexpected request'); });
  await assert.rejects(openapi({ cfg: {}, work: '/unused' }), /backend address is not set/);
  assert.equal(fetch.mock.calls.length, 0);
});

test('backend lookup uses only the selected project API or explicit schema URL', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-backend-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const urls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    urls.push(url);
    return { ok: true, json: async () => ({ openapi: '3.0.0', paths: {} }) };
  });
  await openapi({ cfg: { dev: { backend: { api: 'https://api.example.test/' } } }, work: path.join(root, 'one') });
  await openapi({ cfg: { handoff: { openapi: 'https://schema.example.test/spec.json' }, dev: { backend: { api: 'https://unused.example.test' } } }, work: path.join(root, 'two') });
  assert.deepEqual(urls, ['https://api.example.test/v1/openapi.json', 'https://schema.example.test/spec.json']);
});
