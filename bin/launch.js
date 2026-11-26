// Launcher: make sure the daemon is up, then open the UI as a chromeless window.
//
// A browser in --app mode has no tabs, no address bar and no site chrome, so the
// window contains only the app's own bar. That is the "轻软件" shell: no Electron,
// no bundled runtime, one shared codebase for macOS and Windows.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { DEFAULT_PORT, defaultDataDir } from '../src/config.js';

const ROOT = path.join(import.meta.dirname, '..');
const dataDir = defaultDataDir();
const runtimeFile = path.join(dataDir, 'runtime.json');

async function probe(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(800) });
    const body = await res.json();
    return body && body.app === 'paste' ? body : null;
  } catch {
    return null;
  }
}

function runtime() {
  try {
    return JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
  } catch {
    return null;
  }
}

async function ensureServer() {
  const saved = runtime();
  if (saved && saved.port && await probe(saved.port)) return saved.port;

  const port = Number(process.env.PASTE_PORT) || DEFAULT_PORT;
  if (await probe(port)) return port;

  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'main.js')], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: process.env,
  });
  child.unref();

  for (let i = 0; i < 100; i++) {
    await sleep(150);
    const fresh = runtime();
    if (fresh && fresh.port && await probe(fresh.port)) return fresh.port;
    if (await probe(port)) return port;
  }
  throw new Error('Paste 启动超时，请运行 npm start 查看日志');
}

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function candidates() {
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      `${process.env.HOME}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
  }
  if (process.platform === 'win32') {
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = process.env.LOCALAPPDATA || '';
    return [
      `${pf}\\Google\\Chrome\\Application\\chrome.exe`,
      `${pf86}\\Google\\Chrome\\Application\\chrome.exe`,
      `${local}\\Google\\Chrome\\Application\\chrome.exe`,
      `${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`,
    ];
  }
  return ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
}

function openWindow(url) {
  const browser = candidates().find(exists);
  if (browser) {
    const child = spawn(browser, [`--app=${url}`, '--window-size=1200,780', '--no-first-run', '--no-default-browser-check'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    return 'app';
  }

  if (process.platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    return 'browser';
  }
  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return 'browser';
  }
  spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  return 'browser';
}

try {
  const port = await ensureServer();
  const url = `http://127.0.0.1:${port}`;
  const mode = openWindow(url);
  console.log(`Paste · ${url} · ${mode === 'app' ? 'app window' : 'default browser'}`);
  process.exit(0);
} catch (err) {
  console.error(String(err && err.message ? err.message : err));
  process.exit(1);
}
