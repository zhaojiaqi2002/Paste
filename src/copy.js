// Copy an item back onto the OS clipboard, so ⌘V works in other apps.

import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { log } from './log.js';

const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';
const MAC_SCRIPT = path.join(import.meta.dirname, 'clipboard', 'copy-mac.mjs');
const WIN_SCRIPT = path.join(import.meta.dirname, 'clipboard', 'copy-win.ps1');

/** Can this process actually read the file? TCC denies open(2), not stat(2). */
function readable(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

function run(cmd, args, timeout = 20000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      return resolve({ ok: false, error: String(err && err.message) });
    }
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, timeout);
    child.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, error: String(err && err.message) }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, error: (stderr || `exit ${code}`).slice(0, 400) });
    });
  });
}

/**
 * Low-level writer: put one payload on the system clipboard.
 * mode is 'text' (single path to a utf8 file), 'image' (single png) or
 * 'files' (one or more paths, pasted as file URLs).
 *
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function copyRaw(mode, paths) {
  if (!IS_MAC && !IS_WIN) return { ok: false, error: 'platform not supported' };
  if (!paths || !paths.length) return { ok: false, error: 'nothing to copy', reason: 'empty' };

  // macOS drops file flavors whose file this process cannot read, which would
  // leave the clipboard empty while reporting success. Refuse up front instead,
  // and leave whatever the user already had on the clipboard untouched.
  const usable = paths.filter(readable);
  const skipped = paths.length - usable.length;
  if (!usable.length) {
    return {
      ok: false,
      reason: 'unreadable',
      error: skipped ? '原始文件在受保护的位置，无法读取' : 'nothing to copy',
    };
  }

  const result = IS_MAC
    ? await run('/usr/bin/osascript', ['-l', 'JavaScript', MAC_SCRIPT, mode, ...paths])
    : await run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Sta', '-ExecutionPolicy', 'Bypass', '-File', WIN_SCRIPT,
      '-Mode', mode, ...(mode === 'files' ? ['-Paths', ...paths] : ['-Value', paths[0]]),
    ]);

  if (!result.ok) log('[copy] failed', mode, result.error);
  return { ...result, skipped };
}

/**
 * Copy one stored item.
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function copyToClipboard(store, meta) {
  let mode;
  let args;
  const first = meta.files[0];
  if (meta.type === 'text') {
    mode = 'text';
    args = [store.textPath(meta)];
  } else if (meta.type === 'image' && first && !first.missing && first.mime === 'image/png') {
    mode = 'image';
    args = [store.filePath(meta, 0)];
  } else {
    // Unreadable files are represented by their original path, which is still a
    // valid thing to put on the pasteboard.
    mode = 'files';
    args = meta.files
      .map((file, i) => (file.missing ? file.origin : store.filePath(meta, i)))
      .filter((p) => p && fs.existsSync(p));
    if (!args.length) {
      // A reference whose original is gone cannot be pasted; saying "已复制"
      // here would be a lie the user only discovers in Finder.
      return { ok: false, error: '原始文件已不存在' };
    }
  }

  if (!args.length) return { ok: false, error: 'nothing to copy' };
  return copyRaw(mode, args);
}
