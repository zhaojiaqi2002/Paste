// The storage engine. One directory per item, one JSON file per item, one blob
// per file. Nothing to migrate, nothing to corrupt, readable with `ls`.
//
//   data/items/<YYYY-MM-DD>/<id>/
//     meta.json      the record (also the in-memory index entry)
//     body.txt       text items only
//     f0.png f1.mov   stored blobs
//     thumb.png      first image's preview
//
// Invariants:
//   * meta.json is the only source of truth; the in-memory list is derived.
//   * every write of meta.json is atomic (temp + rename).
//   * a day directory older than retentionDays is deleted whole.

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { makePoster, makeThumb, toPng } from './thumb.js';
import { search, snippetOf } from './search.js';
import {
  browserImage, classify, dayKey, dayKeyBefore, imageSize, isDir, mimeOf,
  newId, readJson, safeName, sha1, sniffImageFile, writeJsonAtomic,
} from './util.js';

const PREVIEW_CHARS = 2000;
const LIST_PREVIEW_CHARS = 600;


/**
 * Normalise a stored image blob. macOS pasteboards (and some apps) hand out
 * TIFF under a .png name, which no browser can decode, so the real format is
 * decided by magic bytes and converted when needed. `resolvePng` maps a wanted
 * file name onto one that is free inside the item.
 */
async function normalizeImageBlob(dir, storedRel, name, resolvePng = (n) => n) {
  let stored = storedRel;
  let outName = name;
  let kind = sniffImageFile(path.join(dir, stored));
  let converted = false;

  if (!browserImage(kind)) {
    const stem = outName.replace(/\.[^.]+$/, '') || 'image';
    const pngName = resolvePng(`${stem}.png`);
    const conv = path.join(dir, 'files', `${pngName}.tmp.png`);
    if (await toPng(path.join(dir, stored), conv)) {
      fs.rmSync(path.join(dir, stored), { force: true });
      fs.renameSync(conv, path.join(dir, 'files', pngName));
      stored = `files/${pngName}`;
      outName = pngName;
      kind = 'png';
      converted = true;
    } else {
      fs.rmSync(conv, { force: true });
    }
  }

  const abs = path.join(dir, stored);
  const buf = fs.readFileSync(abs);
  const dims = browserImage(kind) ? imageSize(buf) : null;
  return {
    stored,
    name: outName,
    size: buf.length,
    mime: mimeOf(outName),
    w: dims ? dims.w : null,
    h: dims ? dims.h : null,
    converted,
  };
}

export class Store extends EventEmitter {
  constructor(dataDir, options = {}) {
    super();
    this.dataDir = dataDir;
    this.itemsDir = path.join(dataDir, 'items');
    this.inboxDir = path.join(dataDir, 'inbox');
    this.trashDir = path.join(dataDir, 'trash');
    this.tmpDir = path.join(dataDir, 'tmp');
    this.retentionDays = Number(options.retentionDays) || 30;
    this.entries = [];
    this.byId = new Map();
    this.hashes = new Map();
    this.hayCache = new Map();
  }

  static async open(dataDir, options) {
    const store = new Store(dataDir, options);
    store.#load();
    store.purgeTrash();
    store.sweep();
    return store;
  }

  // ------------------------------------------------------------ boot

  #load() {
    for (const dir of [this.itemsDir, this.inboxDir, this.trashDir, this.tmpDir]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    let days = [];
    try {
      days = fs.readdirSync(this.itemsDir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
    } catch {
      return;
    }
    for (const day of days) {
      const dayDir = path.join(this.itemsDir, day);
      if (!isDir(dayDir)) continue;
      let ids = [];
      try {
        ids = fs.readdirSync(dayDir);
      } catch {
        continue;
      }
      for (const id of ids) {
        const meta = readJson(path.join(dayDir, id, 'meta.json'), null);
        if (!meta || !meta.id) continue;
        this.#insert(meta);
      }
    }
    this.entries.sort((a, b) => b.createdAt - a.createdAt);
    // tmp files are scratch; nothing here survives a restart.
    try {
      for (const f of fs.readdirSync(this.tmpDir)) fs.rmSync(path.join(this.tmpDir, f), { recursive: true, force: true });
    } catch { /* ignore */ }
  }

  #insert(meta) {
    if (this.byId.has(meta.id)) return;
    this.byId.set(meta.id, meta);
    if (meta.hash) this.hashes.set(meta.hash, meta.id);
    this.entries.push(meta);
    this.entries.sort((a, b) => b.createdAt - a.createdAt);
  }

  #drop(id) {
    const meta = this.byId.get(id);
    if (!meta) return null;
    this.byId.delete(id);
    if (meta.hash) this.hashes.delete(meta.hash);
    const at = this.entries.indexOf(meta);
    if (at >= 0) this.entries.splice(at, 1);
    return meta;
  }

  // ------------------------------------------------------------ write

  /**
   * @param {{text?: string, files?: Array<{name?: string, data?: Buffer, path?: string}>,
   *          type?: string, source?: string, origin?: object|null, createdAt?: number}} input
   */
  async add(input) {
    const source = input.source || 'clipboard';
    const origin = input.origin || null;
    const createdAt = Number(input.createdAt) || Date.now();
    const text = typeof input.text === 'string' ? input.text : '';
    const files = Array.isArray(input.files) ? input.files.filter((f) => f && (f.data || f.path)) : [];

    if (!text && files.length === 0) return { duplicate: false, entry: null, empty: true };

    const type = input.type || classify(files);
    const hash = await this.#hash(type, text, files);
    const existing = this.hashes.get(hash);
    if (existing) return { duplicate: true, entry: this.byId.get(existing) || null };

    const id = newId();
    const day = dayKey(createdAt);
    const dir = path.join(this.itemsDir, day, id);
    fs.mkdirSync(path.join(dir, 'files'), { recursive: true });

    try {
      const stored = [];
      if (type === 'text') {
        fs.writeFileSync(path.join(dir, 'body.txt'), text, 'utf8');
      } else {
        const used = new Set();
        let index = 0;

        /** Keep the original filename so pasting elsewhere produces the same name. */
        const unique = (name) => {
          const base = safeName(name, `file-${index}`);
          const dot = base.lastIndexOf('.');
          const stem = dot > 0 ? base.slice(0, dot) : base;
          const ext = dot > 0 ? base.slice(dot) : '';
          let candidate = base;
          let n = 2;
          while (used.has(candidate.toLowerCase())) candidate = `${stem}-${n++}${ext}`;
          used.add(candidate.toLowerCase());
          return candidate;
        };

        for (const file of files) {
          const original = safeName(file.name || (file.path ? path.basename(file.path) : 'file'));
          const mime = mimeOf(original);
          const target = unique(original);
          const dest = path.join(dir, 'files', target);

          // macOS protects other apps' containers, and TCC can protect Desktop,
          // Documents and Downloads. A file we cannot read is still a real
          // clipboard event: keep the name, size and original location so the
          // item stays listed and can still be pasted back.
          let missing = false;
          try {
            if (file.path) fs.copyFileSync(file.path, dest);
            else fs.writeFileSync(dest, file.data);
          } catch (err) {
            if (!err || (err.code !== 'EPERM' && err.code !== 'EACCES')) throw err;
            missing = true;
            fs.rmSync(dest, { force: true });
            used.delete(target.toLowerCase());
          }

          if (missing) {
            let size = Number(file.size) || 0;
            try { size = fs.statSync(file.path).size; } catch { /* stat may work when read does not */ }
            stored.push({ name: original, stored: null, origin: file.path || null, size, mime, w: null, h: null, missing: true });
            index++;
            continue;
          }

          let storedName = target;
          let size = fs.statSync(dest).size;
          let finalMime = mime;
          let w = null;
          let h = null;

          if (mime.startsWith('image/')) {
            // Free the provisional name so a converted blob can keep it.
            used.delete(target.toLowerCase());
            const normal = await normalizeImageBlob(dir, `files/${target}`, target, (candidate) => unique(candidate));
            used.add(normal.name.toLowerCase());
            storedName = normal.name;
            size = normal.size;
            finalMime = normal.mime;
            w = normal.w;
            h = normal.h;
          }

          stored.push({ name: storedName, stored: `files/${storedName}`, size, mime: finalMime, w, h });
          index++;
        }
      }

      const totalSize = stored.reduce((n, f) => n + f.size, 0);
      const missingCount = stored.filter((f) => f.missing).length;

      let hasThumb = false;
      if (type === 'image' && stored[0] && !stored[0].missing) {
        const firstAbs = path.join(dir, stored[0].stored);
        hasThumb = await makeThumb(firstAbs, path.join(dir, 'thumb.png'));
        if (!hasThumb) fs.rmSync(path.join(dir, 'thumb.png'), { force: true });
      }

      // A still frame for videos: browsers cannot decode every codec (QuickTime
      // .mov in particular), and a preview beats a broken player.
      let hasPoster = false;
      // Quick Look can stall on files that are not really videos; only bother
      // with payloads that could plausibly be one.
      if (type === 'video' && stored[0] && !stored[0].missing && stored[0].size > 8192) {
        const videoAbs = path.join(dir, stored[0].stored);
        hasPoster = await makePoster(videoAbs, path.join(dir, 'poster.png'));
        if (!hasPoster) fs.rmSync(path.join(dir, 'poster.png'), { force: true });
      }

      const meta = {
        schema: 1,
        id,
        type,
        createdAt,
        day,
        source,
        origin,
        hash,
        chars: text.length,
        preview: text.slice(0, PREVIEW_CHARS),
        files: stored,
        size: totalSize,
        thumb: hasThumb,
        poster: hasPoster,
        missing: missingCount,
      };
      writeJsonAtomic(path.join(dir, 'meta.json'), meta);
      this.#insert(meta);
      this.emit('add', meta);
      return { duplicate: false, entry: meta };
    } catch (err) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw err;
    }
  }

  async #hash(type, text, files) {
    if (type === 'text') return 't' + sha1(text);
    const parts = [];
    for (const file of files) {
      const name = safeName(file.name || (file.path ? path.basename(file.path) : 'file'));
      if (file.data) {
        parts.push(`${name}:${sha1(file.data)}`);
      } else {
        let size = 0;
        let mtime = 0;
        try {
          const st = fs.statSync(file.path);
          size = st.size;
          mtime = Math.floor(st.mtimeMs);
        } catch { /* ignore */ }
        parts.push(`${name}:${size}:${mtime}`);
      }
    }
    return 'f' + sha1(parts.join('|'));
  }

  // ------------------------------------------------------------ read

  get(id) {
    return this.byId.get(id) || null;
  }

  itemDir(meta) {
    return path.join(this.itemsDir, meta.day, meta.id);
  }

  textPath(meta) {
    return path.join(this.itemDir(meta), 'body.txt');
  }

  filePath(meta, index) {
    const file = meta.files[index];
    if (!file || !file.stored) return null;
    return path.join(this.itemDir(meta), file.stored);
  }

  thumbPath(meta) {
    const p = path.join(this.itemDir(meta), 'thumb.png');
    return fs.existsSync(p) ? p : null;
  }

  posterPath(meta) {
    const p = path.join(this.itemDir(meta), 'poster.png');
    return fs.existsSync(p) ? p : null;
  }

  readText(meta) {
    try {
      return fs.readFileSync(this.textPath(meta), 'utf8');
    } catch {
      return meta.preview || '';
    }
  }

  /**
   * Lower-cased search corpus for one item: full body text (lazily read, capped),
   * filenames, day and type label. Cached because searching is per keystroke.
   */
  hayOf(meta) {
    const hit = this.hayCache.get(meta.id);
    if (hit !== undefined) return hit;
    let text = meta.preview || '';
    if ((meta.chars || 0) > text.length) {
      try {
        text = fs.readFileSync(this.textPath(meta), 'utf8').slice(0, 120000);
      } catch { /* keep the preview */ }
    }
    const typeLabel = { text: '文本', image: '图片', files: '文件', video: '视频' }[meta.type] || '';
    const hay = `${text}\n${meta.note || ''}\n${(meta.files || []).map((f) => f.name).join('\n')}\n${meta.day} ${typeLabel}`.toLowerCase();
    if (this.hayCache.size > 800) this.hayCache.delete(this.hayCache.keys().next().value);
    this.hayCache.set(meta.id, hay);
    return hay;
  }

  snippet(meta, q) {
    if (!q) return null;
    try {
      return snippetOf(this.hayOf(meta), q);
    } catch {
      return null;
    }
  }

  list({ type = 'all', q = '', limit = 120, offset = 0 } = {}) {
    let rows = this.entries;
    if (type && type !== 'all') rows = rows.filter((e) => e.type === type);
    if (q) rows = search(rows, q, (entry) => this.hayOf(entry));
    const start = Math.max(0, Number(offset) || 0);
    const take = Math.min(400, Math.max(1, Number(limit) || 120));
    const items = rows.slice(start, start + take).map((meta) => {
      const summary = summarize(meta);
      if (q) {
        const snippet = this.snippet(meta, q);
        if (snippet) summary.snippet = snippet;
      }
      return summary;
    });
    return { items, total: rows.length, hasMore: start + take < rows.length };
  }

  stats() {
    const bytes = this.entries.reduce((n, e) => n + (e.size || 0), 0);
    const days = new Set(this.entries.map((e) => e.day)).size;
    return { count: this.entries.length, bytes, days, retentionDays: this.retentionDays };
  }

  /**
   * Re-read the bytes of files that were unreadable when the item was captured
   * (macOS protected another app's container, or TCC hid a folder). After the
   * user grants access, this fills the record in place instead of asking them
   * to copy it again — the temporary original may already be gone.
   */
  async importMissing(id) {
    const meta = this.byId.get(id);
    if (!meta || !meta.files) return null;
    const dir = this.itemDir(meta);
    let changed = false;

    for (const file of meta.files) {
      if (!file.missing || !file.origin) continue;
      const target = safeName(file.name || path.basename(file.origin));
      const dest = path.join(dir, 'files', target);
      try {
        fs.copyFileSync(file.origin, dest);
      } catch {
        continue; // still protected
      }

      file.stored = `files/${target}`;
      file.missing = false;
      file.size = fs.statSync(dest).size;
      file.mime = mimeOf(file.name);

      if (file.mime.startsWith('image/')) {
        const normal = await normalizeImageBlob(dir, file.stored, file.name);
        file.stored = normal.stored;
        file.name = normal.name;
        file.size = normal.size;
        file.mime = normal.mime;
        file.w = normal.w;
        file.h = normal.h;
      }
      changed = true;
    }

    if (!changed) return meta;
    meta.missing = meta.files.filter((f) => f.missing).length;
    if (meta.type === 'image' && meta.files[0] && !meta.files[0].missing) {
      meta.thumb = await makeThumb(this.filePath(meta, 0), path.join(dir, 'thumb.png'));
    }
    if (meta.type === 'video' && meta.files[0] && !meta.files[0].missing) {
      meta.poster = await makePoster(this.filePath(meta, 0), path.join(dir, 'poster.png'));
    }
    writeJsonAtomic(path.join(dir, 'meta.json'), meta);
    this.hayCache.delete(meta.id);
    this.emit('update', meta);
    return meta;
  }

  /** A short annotation the user attaches to an item. Lives in meta.json. */
  setNote(id, note) {
    const meta = this.byId.get(id);
    if (!meta) return null;
    const clean = String(note == null ? '' : note).trim().slice(0, 500);
    if (clean) meta.note = clean;
    else delete meta.note;
    writeJsonAtomic(path.join(this.itemDir(meta), 'meta.json'), meta);
    this.hayCache.delete(id);
    this.emit('update', meta);
    return meta;
  }

  // ------------------------------------------------------------ delete

  remove(id) {
    this.hayCache.delete(id);
    const meta = this.byId.get(id);
    if (!meta) return null;
    const dir = this.itemDir(meta);
    const trash = path.join(this.trashDir, `${meta.id}`);
    try {
      fs.mkdirSync(this.trashDir, { recursive: true });
      fs.renameSync(dir, trash);
    } catch {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    this.#drop(id);
    this.#pruneDay(meta.day);
    this.emit('remove', meta);
    return meta;
  }

  restore(meta) {
    if (!meta || this.byId.has(meta.id)) return null;
    const trash = path.join(this.trashDir, meta.id);
    const dir = path.join(this.itemsDir, meta.day, meta.id);
    try {
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      fs.renameSync(trash, dir);
    } catch {
      return null;
    }
    this.#insert(meta);
    this.emit('add', meta);
    return meta;
  }

  /** Drop one deleted item's holding directory (used when its undo window closes). */
  discardTrash(id) {
    try {
      fs.rmSync(path.join(this.trashDir, String(id)), { recursive: true, force: true });
    } catch { /* ignore */ }
  }

  purgeTrash(maxAgeMs = 0) {
    let names = [];
    try {
      names = fs.readdirSync(this.trashDir);
    } catch {
      return 0;
    }
    let n = 0;
    for (const name of names) {
      const p = path.join(this.trashDir, name);
      try {
        const age = Date.now() - fs.statSync(p).mtimeMs;
        if (maxAgeMs === 0 || age > maxAgeMs) {
          fs.rmSync(p, { recursive: true, force: true });
          n++;
        }
      } catch { /* ignore */ }
    }
    return n;
  }

  #pruneDay(day) {
    try {
      const dir = path.join(this.itemsDir, day);
      if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    } catch { /* ignore */ }
  }

  // ------------------------------------------------------------ retention

  /** Delete whole days older than the retention window. Returns removed count. */
  sweep(now = Date.now()) {
    const cutoff = dayKeyBefore(this.retentionDays, now);
    let removed = 0;
    let days = [];
    try {
      days = fs.readdirSync(this.itemsDir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
    } catch {
      return 0;
    }
    for (const day of days) {
      if (day >= cutoff) continue;
      const dayDir = path.join(this.itemsDir, day);
      const ids = new Set((() => { try { return fs.readdirSync(dayDir); } catch { return []; } })());
      for (const id of ids) {
        const meta = this.byId.get(id);
        if (meta) { this.#drop(id); removed++; }
      }
      fs.rmSync(dayDir, { recursive: true, force: true });
    }
    if (removed) this.emit('sweep', { removed });
    return removed;
  }

  /** Bundles that were never committed (crash, cancelled transfer). */
  sweepInbox(maxAgeMs = 6 * 60 * 60 * 1000) {
    let names = [];
    try {
      names = fs.readdirSync(this.inboxDir);
    } catch {
      return;
    }
    for (const name of names) {
      const p = path.join(this.inboxDir, name);
      try {
        if (Date.now() - fs.statSync(p).mtimeMs > maxAgeMs) fs.rmSync(p, { recursive: true, force: true });
      } catch { /* ignore */ }
    }
  }
}

/** The list document sent to the browser: small, no absolute paths, no internals. */
export function summarize(meta) {
  return {
    id: meta.id,
    type: meta.type,
    createdAt: meta.createdAt,
    day: meta.day,
    source: meta.source,
    origin: meta.origin || null,
    chars: meta.chars || 0,
    size: meta.size || 0,
    preview: (meta.preview || '').slice(0, LIST_PREVIEW_CHARS),
    files: (meta.files || []).map((f) => ({
      name: f.name,
      size: f.size,
      mime: f.mime,
      w: f.w || null,
      h: f.h || null,
      missing: !!f.missing,
    })),
    thumb: !!meta.thumb,
    poster: !!meta.poster,
    note: meta.note || '',
    missing: meta.missing || 0,
  };
}
