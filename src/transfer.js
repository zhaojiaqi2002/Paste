// Staged uploads ("bundles"). A bundle is a directory under data/inbox/<id>/
// that collects blobs until commit, then becomes one item.
//
// The browser uses it for drag & drop; the LAN receiver uses it for peer sends.
// Same code path, so a dropped folder of files behaves exactly like one sent
// from another Mac.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { log } from './log.js';
import { readJson, safeName, writeJsonAtomic } from './util.js';

const MAX_BLOBS = 64;
const MAX_BLOB_BYTES = 4 * 1024 * 1024 * 1024;
const ID_RE = /^[a-z0-9]{16,40}$/;

export function createBundles({ dataDir, store }) {
  const root = path.join(dataDir, 'inbox');
  fs.mkdirSync(root, { recursive: true });

  function dirOf(id) {
    if (!ID_RE.test(String(id || ''))) throw new Error('bad bundle id');
    return path.join(root, id);
  }

  function manifestPath(id) {
    return path.join(dirOf(id), 'manifest.json');
  }

  function create({ type, createdAt, count, owner, origin = null }) {
    const id = crypto.randomBytes(10).toString('hex');
    const dir = path.join(root, id);
    fs.mkdirSync(dir, { recursive: true });
    const manifest = {
      id,
      owner: owner || 'local',
      type: type || 'files',
      createdAt: Number(createdAt) || Date.now(),
      origin,
      count: Math.min(MAX_BLOBS, Math.max(1, Number(count) || 1)),
      names: {},
      received: 0,
      openedAt: Date.now(),
    };
    writeJsonAtomic(path.join(dir, 'manifest.json'), manifest);
    return manifest;
  }

  function read(id) {
    const manifest = readJson(manifestPath(id), null);
    if (!manifest) throw new Error('unknown bundle');
    return manifest;
  }

  /** Stream a raw request body into slot N. Returns bytes written. */
  function writeBlob(id, slot, rawName, req) {
    const manifest = read(id);
    const index = Number(slot);
    if (!Number.isInteger(index) || index < 0 || index >= manifest.count) {
      const err = new Error('bad slot');
      err.status = 400;
      throw err;
    }
    const dir = dirOf(id);
    const name = safeName(rawName || `file-${index}`, `file-${index}`);
    const dest = path.join(dir, `blob-${index}`);
    return new Promise((resolve, reject) => {
      const out = fs.createWriteStream(dest);
      let size = 0;
      let aborted = false;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BLOB_BYTES) {
          aborted = true;
          req.destroy(new Error('blob too large'));
        }
      });
      req.on('aborted', () => {
        out.destroy();
        reject(new Error('upload aborted'));
      });
      req.pipe(out);
      out.on('error', reject);
      out.on('finish', () => {
        if (aborted) return reject(new Error('blob too large'));
        manifest.names[index] = name;
        manifest.received += 1;
        writeJsonAtomic(path.join(dir, 'manifest.json'), manifest);
        resolve(size);
      });
    });
  }

  /** Turn the staged blobs into a stored item and remove the staging dir. */
  async function commit(id, { source = 'lan', origin = null } = {}) {
    const manifest = read(id);
    const dir = dirOf(id);
    const items = [];

    if (manifest.type === 'text') {
      const body = path.join(dir, 'blob-0');
      if (!fs.existsSync(body)) throw new Error('missing text blob');
      const text = fs.readFileSync(body, 'utf8');
      items.push({ path: null, name: 'body.txt', text });
    } else {
      for (let i = 0; i < manifest.count; i++) {
        const p = path.join(dir, `blob-${i}`);
        if (!fs.existsSync(p)) continue;
        items.push({ path: p, name: manifest.names[i] || `file-${i}` });
      }
    }

    if (!items.length) throw new Error('nothing uploaded');

    // Text stays text; images/videos keep their kind; anything else is
    // re-classified from the actual files so a dropped .png lands as an image.
    const payload = { source, origin, createdAt: manifest.createdAt };
    if (manifest.type === 'text') {
      payload.text = items[0].text;
    } else {
      payload.files = items;
      if (manifest.type === 'image' || manifest.type === 'video') payload.type = manifest.type;
    }

    const result = await store.add(payload);
    fs.rmSync(dir, { recursive: true, force: true });
    log(`[bundle] committed ${id} -> ${result.entry ? result.entry.id : 'duplicate'}`);
    return result;
  }

  function sweep(maxAgeMs = 6 * 60 * 60 * 1000) {
    let names = [];
    try {
      names = fs.readdirSync(root);
    } catch {
      return;
    }
    for (const name of names) {
      const p = path.join(root, name);
      try {
        if (Date.now() - fs.statSync(p).mtimeMs > maxAgeMs) fs.rmSync(p, { recursive: true, force: true });
      } catch { /* ignore */ }
    }
  }

  return { create, read, writeBlob, commit, sweep };
}
