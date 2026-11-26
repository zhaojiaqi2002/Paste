// Boot sequence. Everything is wired here, in one readable order:
// config -> store -> bundles -> lan -> capture -> server.

import fs from 'node:fs';
import path from 'node:path';
import { defaultDataDir, loadConfig, paths, saveConfig } from './config.js';
import { Store, summarize } from './store.js';
import { createBundles } from './transfer.js';
import { createLan } from './lan.js';
import { createCapture } from './capture.js';
import { createServer } from './server.js';
import { initLogger, log, logError } from './log.js';

const dataDir = defaultDataDir();
const p = paths(dataDir);
initLogger(p.log);

const config = loadConfig(dataDir);
const save = () => saveConfig(dataDir, config);

async function alreadyRunning(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(800) });
    const body = await res.json();
    return body && body.app === 'paste';
  } catch {
    return false;
  }
}

if (await alreadyRunning(config.port)) {
  log(`[boot] Paste already running on ${config.port}`);
  process.exit(0);
}

const store = await Store.open(dataDir, { retentionDays: config.retentionDays });
const bundles = createBundles({ dataDir, store });

let broadcast = () => {};
const lan = createLan({
  config,
  store,
  saveConfig: save,
  onChange: (peers) => broadcast('peers', peers),
  onProgress: (progress) => broadcast('transfer', progress),
});
const capture = createCapture({ store, dataDir, config });
const app = createServer({ config, dataDir, store, bundles, lan, capture, saveConfig: save });
broadcast = app.broadcast;

store.on('add', (meta) => broadcast('item', summarize(meta)));
store.on('remove', (meta) => broadcast('removed', { id: meta.id }));
store.on('sweep', (info) => broadcast('reset', info));

const port = await app.start().catch((err) => {
  logError('[boot] cannot bind port', config.port, err.message);
  process.exit(2);
});

fs.writeFileSync(path.join(dataDir, 'runtime.json'), JSON.stringify({
  port,
  pid: process.pid,
  startedAt: Date.now(),
  url: `http://127.0.0.1:${port}`,
}));

lan.start();
capture.start();

const hourly = setInterval(() => {
  const removed = store.sweep();
  store.sweepInbox();
  bundles.sweep();
  if (removed) {
    log(`[retention] removed ${removed} expired items`);
    broadcast('reset', { removed });
  }
}, 60 * 60 * 1000);
hourly.unref?.();

store.sweepInbox();
bundles.sweep();

log(`[boot] ${config.name} · ${store.stats().count} items · ${config.retentionDays}d retention · ${config.peers.length} paired`);

let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  log(`[boot] ${signal}, closing`);
  try { capture.stop(); } catch { /* ignore */ }
  try { lan.stop(); } catch { /* ignore */ }
  try { app.stop(); } catch { /* ignore */ }
  try { fs.rmSync(path.join(dataDir, 'runtime.json'), { force: true }); } catch { /* ignore */ }
  setTimeout(() => process.exit(0), 200).unref?.();
  setTimeout(() => process.exit(0), 1500);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => logError('[boot] uncaught', err));
process.on('unhandledRejection', (err) => logError('[boot] unhandled rejection', err));

