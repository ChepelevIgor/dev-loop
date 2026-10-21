#!/usr/bin/env node
// Real-time screenshot over the Chrome DevTools Protocol (no virtual time), for
// screens that wait on onLayout / timers / animations. Used by `REALTIME=1 scripts/shot.sh`.
//   node scripts/shot-cdp.mjs <url> <out.png> [waitMs=6000] [width=1440] [height=940]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [url, out, waitMs = '6000', width = '1440', height = '940'] = process.argv.slice(2);
if (!url || !out) {
  console.error('usage: shot-cdp.mjs <url> <out.png> [waitMs] [width] [height]');
  process.exit(2);
}
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const port = 9300 + Math.floor(Math.random() * 500);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-cdp-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, `--window-size=${width},${height}`, 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function targetWs() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* chrome still starting */
    }
    await sleep(200);
  }
  throw new Error('chrome did not start');
}

try {
  const ws = new WebSocket(await targetWs());
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const mid = ++id;
      pending.set(mid, resolve);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  await send('Emulation.setDeviceMetricsOverride', { width: +width, height: +height, deviceScaleFactor: 1, mobile: false });
  await send('Page.enable');
  await send('Page.navigate', { url });
  await sleep(+waitMs);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
  ws.close();
  console.log(`${out} ← ${url} (real time ${waitMs}ms)`);
} finally {
  chrome.kill();
  // Chrome may still be flushing its profile; cleanup is best-effort.
  await new Promise((r) => chrome.once('exit', r));
  try {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* temp dir, OS cleans it */
  }
}
