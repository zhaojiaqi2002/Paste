// Small, dependency-free helpers shared by the store, server and capture layer.
// Everything here is pure: no I/O beyond the explicit file helpers.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const APP = 'Paste';
export const VERSION = '1.0.0';
export const SCHEMA = 1;

/** Sortable, collision-resistant id: ms timestamp in base36 + 3 random bytes. */
export function newId() {
  return Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}

export function token(bytes = 4) {
  return crypto.randomBytes(bytes).toString('hex').toUpperCase();
}

/** Pairing code: 10 chars from an unambiguous alphabet, shown as XXXXX-XXXXX. */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export function newCode() {
  const bytes = crypto.randomBytes(10);
  let out = '';
  for (let i = 0; i < 10; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out.slice(0, 5) + '-' + out.slice(5);
}

/** Accepts "abcde-fghij", "ABCDE FGHIJ" or lowercase; returns canonical form. */
export function normalizeCode(raw) {
  const clean = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (clean.length !== 10) return null;
  return clean.slice(0, 5) + '-' + clean.slice(5);
}

export function sha1(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

export function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// ---------------------------------------------------------------- time

/** Local calendar day key, e.g. "2026-11-26". Local, because users mean their day. */
export function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Day key `days` days before today (local midnight). Used for retention and grouping. */
export function dayKeyBefore(days, from = Date.now()) {
  const d = new Date(from);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - days);
  return dayKey(d.getTime());
}

function pad(n) {
  return String(n).padStart(2, '0');
}

// ---------------------------------------------------------------- files

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Write via temp + rename so a crash can never leave a half-written meta.json. */
export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

export function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Strip path separators and control chars; keeps unicode, trims length. */
export function safeName(name, fallback = 'file') {
  const base = String(name || '')
    .replace(/[\\/]+/g, '-')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .replace(/^\.+/, '');
  return (base || fallback).slice(0, 180);
}

export function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function sizeOf(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------- mime + type

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', heic: 'image/heic', heif: 'image/heif',
  bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff', svg: 'image/svg+xml',
  mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v', webm: 'video/webm',
  mkv: 'video/x-matroska', avi: 'video/x-msvideo',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac',
  flac: 'audio/flac', ogg: 'audio/ogg',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown',
  json: 'application/json', csv: 'text/csv', html: 'text/html',
  zip: 'application/zip', rar: 'application/vnd.rar', gz: 'application/gzip',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  key: 'application/vnd.apple.keynote', pages: 'application/vnd.apple.pages',
  numbers: 'application/vnd.apple.numbers', sketch: 'application/zip',
  psd: 'image/vnd.adobe.photoshop', ai: 'application/postscript',
};

export function extOf(name) {
  const m = /\.([a-z0-9]{1,8})$/i.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

export function mimeOf(name) {
  return MIME[extOf(name)] || 'application/octet-stream';
}

/** Coarse content kind used for classification and icons. */
export function kindOf(name) {
  const mime = mimeOf(name);
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
}

/** The four user-facing categories, in the order the UI shows them. */
export const TYPES = ['text', 'image', 'files', 'video'];

/**
 * A clipboard entry's category. Files win over text because an OS file copy
 * also carries the filename as text, and the file is what the user meant.
 */
export function classify(files) {
  if (!files || files.length === 0) return 'text';
  const kinds = files.map((f) => kindOf(f.name));
  if (kinds.every((k) => k === 'video')) return 'video';
  if (kinds.every((k) => k === 'image')) return 'image';
  return 'files';
}

// ---------------------------------------------------------------- image sniffing

/**
 * Identify an image by its magic bytes. A file named .png is not necessarily a
 * PNG: macOS pasteboards and some apps hand out TIFF data under a png name.
 * Returns 'png' | 'jpeg' | 'gif' | 'webp' | 'tiff' | 'bmp' | null.
 */
export function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.toString('ascii', 0, 3) === 'GIF') return 'gif';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  const le = buf.toString('latin1', 0, 4);
  if (le === 'II*\u0000' || le === 'MM\u0000*') return 'tiff';
  if (buf.toString('ascii', 0, 2) === 'BM') return 'bmp';
  return null;
}

/** Sniff a file by reading only its first bytes. */
export function sniffImageFile(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(16);
    const read = fs.readSync(fd, buf, 0, 16, 0);
    return sniffImage(buf.subarray(0, read));
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

/** Formats a browser can render directly. */
export function browserImage(kind) {
  return kind === 'png' || kind === 'jpeg' || kind === 'gif' || kind === 'webp';
}

// ---------------------------------------------------------------- image size

/** Read pixel dimensions from a PNG/JPEG/GIF/WebP header without decoding. */
export function imageSize(buf) {
  if (!buf || buf.length < 24) return null;
  try {
    // PNG: signature + IHDR
    if (buf.readUInt32BE(0) === 0x89504e47) {
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    }
    // GIF
    if (buf.toString('ascii', 0, 3) === 'GIF') {
      return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
    }
    // WebP (VP8X / VP8 / VP8L)
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      const kind = buf.toString('ascii', 12, 16);
      if (kind === 'VP8X') return { w: buf.readUIntLE(24, 3) + 1, h: buf.readUIntLE(27, 3) + 1 };
      if (kind === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
      if (kind === 'VP8L') {
        const bits = buf.readUInt32LE(21);
        return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
      }
    }
    // JPEG: walk segments to the first SOF marker
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1];
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
        }
        const len = buf.readUInt16BE(i + 2);
        if (len < 2) return null;
        i += 2 + len;
      }
    }
  } catch {
    return null;
  }
  return null;
}

// ---------------------------------------------------------------- misc

export function prettyName() {
  const host = (process.env.PASTE_NAME || '').trim();
  if (host) return host;
  const raw = (process.env.COMPUTERNAME || os.hostname() || '').replace(/\.local\.?$/i, '');
  return raw || (process.platform === 'win32' ? 'Windows' : 'Mac');
}

export function platformLabel() {
  if (process.platform === 'darwin') return 'macOS';
  if (process.platform === 'win32') return 'Windows';
  return process.platform;
}
