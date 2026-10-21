import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serveSources } from '../../skills/filter-design/scripts/source-server.mjs';

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'design-source-test-'));
  const src = path.join(root, 'src');
  fs.mkdirSync(path.join(src, 'design'), { recursive: true });
  fs.writeFileSync(path.join(src, 'design/index.html'), '<link rel="stylesheet" href="style.css"><h1>Design</h1>');
  fs.writeFileSync(path.join(src, 'design/style.css'), 'h1 { color: blue }');
  const { server, baseUrl } = await serveSources(src);
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, src, baseUrl };
}

test('source files load relative resources on a read-only server without an API', async (t) => {
  const { baseUrl } = await fixture(t);
  const html = await fetch(`${baseUrl}design/index.html`);
  assert.equal(html.status, 200);
  assert.equal(html.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(html.headers.get('x-content-type-options'), 'nosniff');
  assert.match(html.headers.get('content-security-policy'), /sandbox/);
  assert.match(await html.text(), /style.css/);
  assert.equal(await (await fetch(new URL('style.css', `${baseUrl}design/index.html`))).text(), 'h1 { color: blue }');
  assert.equal((await fetch(`${baseUrl}design/index.html`, { method: 'POST', body: 'write' })).status, 405);
  const url = new URL(baseUrl);
  assert.equal((await fetch(`${url.origin}/decision`, { method: 'POST', body: '{}' })).status, 405);
  assert.equal((await fetch(`${url.origin}/state`)).status, 403);
  assert.equal((await fetch(`${url.origin}/src/wrong/design/index.html`)).status, 403);
});

test('source file and directory symlinks cannot escape the source root', async (t) => {
  const { root, src, baseUrl } = await fixture(t);
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'marker.txt'), 'private test marker');
  fs.symlinkSync(path.join(outside, 'marker.txt'), path.join(src, 'file-link.txt'));
  fs.symlinkSync(outside, path.join(src, 'dir-link'));
  fs.symlinkSync(path.join(root, 'missing'), path.join(src, 'broken'));
  for (const relative of ['file-link.txt', 'dir-link/marker.txt', 'broken', '..%2Foutside%2Fmarker.txt']) {
    const response = await fetch(baseUrl + relative);
    assert.equal(response.status, 404, relative);
    assert.doesNotMatch(await response.text(), /private test marker/);
  }
  assert.equal((await fetch(`${baseUrl}design/index.html`)).status, 200);
});

test('malformed and removed resources return errors without stopping the server', async (t) => {
  const { src, baseUrl } = await fixture(t);
  for (const relative of ['%ZZ', '%', '%E0%A4%A', '%00']) {
    assert.equal((await fetch(baseUrl + relative)).status, 400, relative);
    assert.equal((await fetch(`${baseUrl}design/index.html`)).status, 200);
  }
  fs.rmSync(path.join(src, 'design/style.css'));
  assert.equal((await fetch(`${baseUrl}design/style.css`)).status, 404);
  assert.equal((await fetch(`${baseUrl}design/`)).status, 404);
  assert.equal((await fetch(`${baseUrl}design/index.html`)).status, 200);
});
