// Headless Chrome over the DevTools protocol, real time: open a page at a viewport, wait, screenshot or evaluate.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run fn({ send, evaluate, screenshot }) on `url` in a fresh headless Chrome; always cleans up. `scale` = device pixel ratio. */
export async function withPage(url, { width = 430, height = 932, wait = 6000, scale = 1 } = {}, fn) {
  if (!fs.existsSync(CHROME)) throw new Error(`Google Chrome not found (${CHROME}) — set CHROME=<path>`);
  const port = 9400 + Math.floor(Math.random() * 500);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-cdp-'));
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, `--window-size=${width},${height}`, 'about:blank'], { stdio: 'ignore' });
  try {
    let wsUrl = null;
    for (let i = 0; i < 60 && !wsUrl; i++) {
      try {
        wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl ?? null;
      } catch {
        /* starting */
      }
      if (!wsUrl) await sleep(200);
    }
    if (!wsUrl) throw new Error('Chrome did not start');
    const ws = new WebSocket(wsUrl);
    await new Promise((r, j) => {
      ws.addEventListener('open', r, { once: true });
      ws.addEventListener('error', j, { once: true });
    });
    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
      }
    });
    const send = (method, params = {}) =>
      new Promise((resolve) => {
        const mid = ++id;
        pending.set(mid, resolve);
        ws.send(JSON.stringify({ id: mid, method, params }));
      });
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
    await send('Page.enable');
    await send('Page.navigate', { url });
    await sleep(wait);
    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.result?.exceptionDetails) throw new Error(`page: ${r.result.exceptionDetails.text}`);
      return r.result?.result?.value;
    };
    const screenshot = async (out) => {
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
      return out;
    };
    const res = await fn({ send, evaluate, screenshot });
    ws.close();
    return res;
  } finally {
    chrome.kill();
    await new Promise((r) => chrome.once('exit', r));
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* temp */
    }
  }
}

export const shoot = (url, out, opts = {}) => withPage(url, opts, ({ screenshot }) => screenshot(out));
