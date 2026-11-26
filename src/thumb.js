// Image derivatives via the tools the OS already ships.
// macOS: sips. Windows: System.Drawing through PowerShell. No npm image deps.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { exists, sniffImageFile } from './util.js';

const PS_RESIZE = path.join(import.meta.dirname, 'resize.ps1');

function run(cmd, args, timeout = 15000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    } catch {
      return resolve(false);
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(false);
    }, timeout);
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', () => { clearTimeout(timer); resolve(false); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

/**
 * Normalise any raster the OS can read into a real PNG. The decision is made on
 * the file's magic bytes, never on its name: a .png that actually holds TIFF is
 * exactly the case that produced blank previews in the browser.
 */
export async function toPng(src, dest) {
  if (sniffImageFile(src) === 'png') {
    if (path.resolve(src) !== path.resolve(dest)) fs.copyFileSync(src, dest);
    return true;
  }

  if (process.platform === 'darwin' && exists('/usr/bin/sips')) {
    return run('/usr/bin/sips', ['-s', 'format', 'png', src, '--out', dest]);
  }
  if (process.platform === 'win32') {
    const ok = await run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', PS_RESIZE, '-Mode', 'convert', '-In', src, '-Out', dest,
    ]);
    return ok && exists(dest);
  }
  return false;
}

/** Square-ish preview no larger than `max` px on the long edge. */
export async function makeThumb(src, dest, max = 480) {
  try {
    if (process.platform === 'darwin' && exists('/usr/bin/sips')) {
      const ok = await run('/usr/bin/sips', ['-Z', String(max), '-s', 'format', 'png', src, '--out', dest]);
      return ok && exists(dest);
    }
    if (process.platform === 'win32') {
      const ok = await run('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', PS_RESIZE, '-Mode', 'resize', '-In', src, '-Out', dest, '-Max', String(max),
      ]);
      return ok && exists(dest);
    }
  } catch {
    return false;
  }
  return false;
}
