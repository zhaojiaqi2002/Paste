// Supervises the platform clipboard watcher and turns its line-delimited JSON
// into stored items. One child process, restarted with backoff if it dies.
//
// Ignoring our own writes: before we put something on the system clipboard we
// arm `ignoreNext(type)`. The watcher will report that change within ~350ms and
// the next event of the same type inside the window is dropped. Content hashes
// would be fragile here (the OS may re-encode images).

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { classify, isDir, sizeOf } from './util.js';
import { log, logError } from './log.js';

const DEBUG = process.env.PASTE_DEBUG === '1';
const MAX_TEXT_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = Number(process.env.PASTE_MAX_FILE_MB || 2048) * 1024 * 1024;

/** Actually open the file: TCC denies open(2), while access(2) still says yes. */
function canRead(file) {
  try {
    const fd = fs.openSync(file, 'r');
    fs.closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

export function createCapture({ store, dataDir, config }) {
  const tmpDir = path.join(dataDir, 'tmp');
  const supported = process.platform === 'darwin' || process.platform === 'win32';

  const state = {
    supported,
    state: supported ? 'starting' : 'unsupported',
    lastAt: null,
    restarts: 0,
    pid: null,
  };

  let child = null;
  let stopping = false;
  let restartTimer = null;
  let backoff = 500;
  let ignore = { type: null, until: 0 };

  function ignoreNext(type, ms = 2500) {
    ignore = { type, until: Date.now() + ms };
  }

  function takeIgnore(type) {
    if (ignore.type && ignore.type === type && Date.now() < ignore.until) {
      ignore = { type: null, until: 0 };
      return true;
    }
    return false;
  }

  function command() {
    if (process.platform === 'darwin') {
      return {
        cmd: '/usr/bin/osascript',
        args: ['-l', 'JavaScript', path.join(import.meta.dirname, 'clipboard', 'mac.mjs'), tmpDir],
      };
    }
    return {
      cmd: 'powershell.exe',
      args: [
        '-NoProfile', '-NonInteractive', '-Sta', '-ExecutionPolicy', 'Bypass',
        '-File', path.join(import.meta.dirname, 'clipboard', 'watcher-win.ps1'), '-TmpDir', tmpDir,
      ],
    };
  }

  async function ingest(message) {
    state.lastAt = Date.now();
    if (DEBUG) log('[capture]', message.t, message.path || '', message.paths ? message.paths.length : '');

    if (message.t === 'text') {
      if (typeof message.text !== 'string') return;
      if (!message.text.trim()) return;
      if (Buffer.byteLength(message.text, 'utf8') > MAX_TEXT_BYTES) {
        log('[capture] text too large, skipped');
        return;
      }
      if (takeIgnore('text')) return;
      const res = await store.add({ text: message.text, source: 'clipboard' });
      if (res.entry && !res.duplicate) log(`[capture] text ${res.entry.id} ${res.entry.chars}c`);
      return;
    }

    if (message.t === 'image') {
      if (!message.path || !fs.existsSync(message.path)) return;
      if (takeIgnore('image')) return;
      const name = `图片${path.extname(message.path) || '.png'}`;
      const res = await store.add({ type: 'image', files: [{ path: message.path, name }], source: 'clipboard' });
      if (res.entry && !res.duplicate) log(`[capture] image ${res.entry.id} ${res.entry.files[0] ? res.entry.files[0].size : 0}b`);
      return;
    }

    if (message.t === 'files') {
      const paths = (message.paths || []).filter((p) => p && fs.existsSync(p) && !isDir(p));
      if (!paths.length) return;
      if (takeIgnore('files')) return;

      // macOS protects other apps' containers (and TCC protects Desktop,
      // Documents, Downloads). open(2) is what actually gets denied, so probe
      // that instead of guessing from permissions.
      const readable = paths.map(canRead);
      if (readable.every((r) => !r)) {
        if (message.image && fs.existsSync(message.image)) {
          log('[capture] files unreadable, using pasteboard image data instead');
          const image = await store.add({
            type: 'image',
            files: [{ path: message.image, name: '图片.png' }],
            source: 'clipboard',
          });
          if (image.entry && !image.duplicate) log(`[capture] image ${image.entry.id} (fallback)`);
          return;
        }
        log(`[capture] files unreadable (${paths[0]}) — storing a reference; grant 完全磁盘访问权限 for full capture`);
      }

      let total = 0;
      const files = [];
      for (const p of paths) {
        const size = sizeOf(p);
        if (!size) continue;
        if (total + size > MAX_TOTAL_BYTES) {
          log(`[capture] ${path.basename(p)} exceeds size budget, skipped`);
          continue;
        }
        total += size;
        files.push({ path: p, name: path.basename(p), size });
      }
      if (!files.length) return;
      const type = classify(files);
      const res = await store.add({ type, files, source: 'clipboard' });
      if (res.entry && !res.duplicate) {
        log(`[capture] ${type} ${res.entry.id} ${files.length}f ${total}b${res.entry.missing ? ` (${res.entry.missing} unreadable)` : ''}`);
      }
    }
  }

  function start() {
    if (!supported || stopping) return;
    const { cmd, args } = command();
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      logError('[capture] spawn failed', err);
      return;
    }
    state.pid = child.pid;
    state.state = 'running';

    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      const text = line.trim();
      if (!text) return;
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        log('[capture] non-json output:', text.slice(0, 200));
        return;
      }
      ingest(message).catch((err) => logError('[capture] ingest failed', err));
    });

    child.stderr.on('data', (buf) => {
      const text = String(buf).trim();
      if (text) log('[watcher]', text.slice(0, 500));
    });

    child.on('error', (err) => logError('[capture] child error', err));

    child.on('exit', (code, signal) => {
      child = null;
      state.pid = null;
      state.state = 'stopped';
      if (stopping) return;
      state.restarts++;
      log(`[capture] watcher exited code=${code} signal=${signal}; restart in ${backoff}ms`);
      restartTimer = setTimeout(start, backoff);
      backoff = Math.min(backoff * 2, 30000);
      if (state.restarts > 20) {
        state.state = 'failed';
        logError('[capture] too many restarts, giving up until next app launch');
        return;
      }
    });
  }

  function stop() {
    stopping = true;
    clearTimeout(restartTimer);
    if (child) child.kill('SIGTERM');
    child = null;
  }

  return {
    start() {
      if (!config.capture) {
        state.state = 'disabled';
        log('[capture] disabled by config');
        return;
      }
      start();
    },
    stop,
    ignoreNext,
    status: () => ({ ...state, lastAt: state.lastAt }),
  };
}
