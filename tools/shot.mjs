// Dev-only: deterministic screenshots through the Chrome DevTools Protocol.
//
//   node tools/shot.mjs --out /tmp/a.png --theme dark --width 1280 --height 820 \
//        --url http://127.0.0.1:48211/ [--wait 400] [--eval "dom script"] [--full]
//
// Kept in the repo because it is also how an agent verifies UI changes.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = process.env.CHROME_BIN
  || (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, all) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
    return acc;
  }, []),
);

const url = args.url || 'http://127.0.0.1:48211/';
const out = args.out || '/tmp/shot.png';
const width = Number(args.width) || 1280;
const height = Number(args.height) || 820;
const scale = Number(args.scale) || 2;
const theme = args.theme === 'dark' ? 'dark' : 'light';
const wait = Number(args.wait ?? 450);
const port = 9333 + Math.floor(Math.random() * 200);
const profile = path.join(os.tmpdir(), `paste-shot-${port}`);

fs.rmSync(profile, { recursive: true, force: true });
const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--no-sandbox',
  '--hide-scrollbars',
  '--allow-insecure-localhost',
  'about:blank',
], { stdio: 'ignore' });

async function devtools() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return (await res.json()).webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(150);
  }
  throw new Error('chrome did not expose devtools');
}

const browserWs = await devtools();
const targetRes = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
const target = await targetRes.json();

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});

let nextId = 0;
const pending = new Map();
const events = new Map();

ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(`${msg.error.message}`));
    else resolve(msg.result);
    return;
  }
  if (msg.method && events.has(msg.method)) {
    for (const fn of events.get(msg.method)) fn(msg.params);
  }
});

function send(method, params = {}) {
  const id = ++nextId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

function once(method, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), timeout);
    const list = events.get(method) || [];
    const fn = (params) => {
      clearTimeout(timer);
      events.set(method, (events.get(method) || []).filter((x) => x !== fn));
      resolve(params);
    };
    list.push(fn);
    events.set(method, list);
  });
}

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width, height, deviceScaleFactor: scale, mobile: false,
});
await send('Emulation.setEmulatedMedia', {
  features: [
    { name: 'prefers-color-scheme', value: theme },
    { name: 'prefers-reduced-motion', value: 'reduce' },
  ],
});

const loaded = once('Page.loadEventFired');
await send('Page.navigate', { url });
await loaded.catch(() => {});
await sleep(wait);

if (args.eval) {
  const result = await send('Runtime.evaluate', { expression: args.eval, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) console.error('eval error:', result.exceptionDetails.text, result.exceptionDetails.exception?.description);
  else if (result.result && result.result.value !== undefined) console.log(JSON.stringify(result.result.value));
  await sleep(320);
}

const shot = await send('Page.captureScreenshot', {
  format: 'png',
  captureBeyondViewport: args.full === 'true',
});
fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log(`wrote ${out}`);

ws.close();
chrome.kill('SIGKILL');
fs.rmSync(profile, { recursive: true, force: true });
process.exit(0);
