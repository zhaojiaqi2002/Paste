// Tiny append-only logger. Keeps the last ~1MB so a runaway capture loop can
// never fill the disk, and doubles as a debugging aid for support.

import fs from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 1024 * 1024;
let file = null;

export function initLogger(filePath) {
  file = filePath;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (fs.existsSync(filePath) && fs.statSync(filePath).size > MAX_BYTES) {
      fs.renameSync(filePath, `${filePath}.1`);
    }
  } catch { /* logging is best-effort */ }
}

export function log(...args) {
  const line = `[${new Date().toISOString()}] ${args
    .map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.stack || a.message : JSON.stringify(a)))
    .join(' ')}\n`;
  process.stdout.write(line);
  if (!file) return;
  try {
    fs.appendFileSync(file, line);
  } catch { /* ignore */ }
}

export function logError(...args) {
  log('[error]', ...args);
}
