// One HTTP server, two trust zones:
//
//   loopback + session cookie  -> the UI (browser, Chromium app window)
//   Bearer peer token          -> /api/sync/*, used by other machines on the LAN
//
// There is no framework. Routes are matched by segments, bodies are read with
// backpressure, and SSE keeps the UI live.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { publicConfig } from './config.js';
import { copyRaw, copyToClipboard } from './copy.js';
import { log, logError } from './log.js';
import { summarize } from './store.js';
import { normalizeCode, safeEqual } from './util.js';

const PUBLIC_DIR = path.join(import.meta.dirname, '..', 'public');
const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

const RESTORE_TTL = 15000;

export function createServer({ config, dataDir, store, bundles, lan, capture, saveConfig }) {
  const session = crypto.randomBytes(20).toString('hex');
  const clients = new Set();
  const restorable = new Map();
  let server = null;

  // ---------------------------------------------------------------- helpers

  function rememberRestorable(id, meta) {
    restorable.set(id, meta);
    const timer = setTimeout(() => {
      restorable.delete(id);
      store.discardTrash(id);
    }, RESTORE_TTL);
    timer.unref?.();
  }

  function broadcast(event, data) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) {
      try { res.write(frame); } catch { clients.delete(res); }
    }
  }

  function json(res, status, payload) {
    const body = Buffer.from(JSON.stringify(payload));
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': body.length,
      'cache-control': 'no-store',
    });
    res.end(body);
  }

  function text(res, status, body) {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
  }

  function isLoopback(req) {
    const ip = req.socket.remoteAddress || '';
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  }

  function sessionValid(req) {
    const cookie = req.headers.cookie || '';
    const match = /(?:^|;\s*)paste_session=([^;]+)/.exec(cookie);
    return !!match && safeEqual(match[1], session);
  }

  function isLocal(req) {
    return isLoopback(req) && sessionValid(req);
  }

  function bearer(req) {
    const raw = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    if (!raw) return null;
    return normalizeCode(raw) || raw;
  }

  /** Pairing is authenticated with this device's own code: knowing it is the consent. */
  function codeAuth(req) {
    const token = bearer(req);
    return !!token && safeEqual(token, config.code);
  }

  /**
   * Transfers are authenticated with the per-peer secret issued at pairing.
   * Secrets are one-way gifts: the pairer sends one, the pair-ee returns one,
   * so each side can verify the other without reusing either device code.
   */
  function peerAuth(req) {
    const token = bearer(req);
    if (!token) return null;
    return config.peers.find((peer) => peer.secretIn && safeEqual(token, peer.secretIn)) || null;
  }

  function readBody(req, limit = 4 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > limit) {
          reject(Object.assign(new Error('body too large'), { status: 413 }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  async function readJson(req, limit) {
    const buf = await readBody(req, limit);
    if (!buf.length) return {};
    try {
      return JSON.parse(buf.toString('utf8'));
    } catch {
      throw Object.assign(new Error('invalid json'), { status: 400 });
    }
  }

  function serveFile(req, res, file, { mime, name, download = false, cache = 'private, max-age=31536000, immutable' } = {}) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return text(res, 404, 'not found');
    }
    const encoded = encodeURIComponent(name || path.basename(file));
    const headers = {
      'content-type': mime || 'application/octet-stream',
      'accept-ranges': 'bytes',
      'cache-control': cache,
      'content-disposition': `${download ? 'attachment' : 'inline'}; filename="${encoded}"; filename*=UTF-8''${encoded}`,
    };

    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (m) {
        let start = m[1] === '' ? null : Number(m[1]);
        let end = m[2] === '' ? null : Number(m[2]);
        if (start === null && end !== null) { start = Math.max(0, stat.size - end); end = stat.size - 1; }
        if (start !== null && end === null) end = stat.size - 1;
        if (start !== null && end !== null && start <= end && start < stat.size) {
          end = Math.min(end, stat.size - 1);
          res.writeHead(206, {
            ...headers,
            'content-range': `bytes ${start}-${end}/${stat.size}`,
            'content-length': end - start + 1,
          });
          return fs.createReadStream(file, { start, end }).pipe(res);
        }
        res.writeHead(416, { 'content-range': `bytes */${stat.size}` });
        return res.end();
      }
    }

    res.writeHead(200, { ...headers, 'content-length': stat.size });
    return fs.createReadStream(file).pipe(res);
  }

  // ---------------------------------------------------------------- static

  function serveStatic(req, res, pathname) {
    const rel = pathname.replace(/^\/+/, '');
    const file = path.join(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return text(res, 403, 'forbidden');
    const ext = path.extname(file).toLowerCase();
    if (!STATIC_TYPES[ext]) return text(res, 404, 'not found');
    return serveFile(req, res, file, { mime: STATIC_TYPES[ext], cache: 'no-cache' });
  }

  function serveIndex(req, res) {
    let html;
    try {
      html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
    } catch (err) {
      return text(res, 500, 'missing public/index.html');
    }
    const boot = {
      device: publicConfig(config),
      items: store.list({ limit: 200 }).items,
      total: store.stats().count,
      peers: lan.peers(),
      stats: store.stats(),
      capture: capture ? capture.status() : null,
      platform: process.platform,
    };
    // Escape "<" so item text can never terminate the script tag.
    const safe = JSON.stringify(boot).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    html = html.replace('__BOOT__', safe);
    const body = Buffer.from(html, 'utf8');
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': body.length,
      'cache-control': 'no-store',
      'set-cookie': `paste_session=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
    });
    res.end(body);
  }

  // ---------------------------------------------------------------- SSE

  function handleEvents(req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    res.write(`event: hello\ndata: ${JSON.stringify({ now: Date.now() })}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
  }

  // ---------------------------------------------------------------- local API

  // Route index for the loopback session API:
  //   GET    /api/state
  //   GET    /api/items                    POST /api/items
  //   GET    /api/items/:id                PATCH (note) / DELETE
  //   POST   /api/items/:id/{copy,restore,import,open}
  //   GET    /api/items/:id/{body,thumb,poster,file/:i}
  //   POST   /api/items/{bulk-delete,bulk-restore,bulk-copy}
  //   POST   /api/bundles                  PUT /api/bundles/:id/blob   POST /api/bundles/:id/commit
  //   PATCH  /api/device                   POST /api/peers/pair       DELETE /api/peers/:id
  //   POST   /api/peers/:id/send           POST /api/system/fda
  async function handleApi(req, res, pathname, url) {
    const method = req.method;
    const segments = pathname.split('/').filter(Boolean); // ['api', ...]
    const rest = segments.slice(1);
    const query = url.searchParams;

    if (rest[0] === 'state' && method === 'GET') {
      return json(res, 200, {
        device: publicConfig(config),
        peers: lan.peers(),
        stats: store.stats(),
        capture: capture ? capture.status() : null,
      });
    }

    if (rest[0] === 'items' && rest.length === 1) {
      if (method === 'GET') {
        const result = store.list({
          type: query.get('type') || 'all',
          q: query.get('q') || '',
          limit: Number(query.get('limit')) || 120,
          offset: Number(query.get('offset')) || 0,
        });
        return json(res, 200, result);
      }
      if (method === 'POST') {
        const body = await readJson(req, 32 * 1024 * 1024);
        const content = typeof body.text === 'string' ? body.text : '';
        if (!content.trim()) return json(res, 400, { error: 'empty' });
        const added = await store.add({ text: content, source: 'manual' });
        return json(res, 200, { item: added.entry ? summarize(added.entry) : null, duplicate: added.duplicate });
      }
    }

    if (rest[0] === 'items' && rest.length === 2 && method === 'POST'
      && ['bulk-delete', 'bulk-restore', 'bulk-copy'].includes(rest[1])) {
      const body = await readJson(req, 64 * 1024);
      const ids = [...new Set(Array.isArray(body.ids) ? body.ids.map(String) : [])].slice(0, 500);

      if (rest[1] === 'bulk-delete') {
        const removed = [];
        for (const id of ids) {
          const meta = store.remove(id);
          if (!meta) continue;
          rememberRestorable(id, meta);
          removed.push(id);
        }
        return json(res, 200, { ok: true, ids: removed, undo: RESTORE_TTL });
      }

      if (rest[1] === 'bulk-restore') {
        const restored = [];
        for (const id of ids) {
          const pending = restorable.get(id);
          if (!pending) continue;
          restorable.delete(id);
          if (store.restore(pending)) restored.push(id);
        }
        return json(res, 200, { ok: true, restored });
      }

      // Copy several items at once: files win (a paste target expects files),
      // otherwise texts are joined with a blank line.
      const metas = ids.map((id) => store.get(id)).filter(Boolean);
      if (!metas.length) return json(res, 400, { error: '没有选中项' });

      const filePaths = [];
      for (const meta of metas) {
        meta.files.forEach((file, index) => {
          const p = file.missing ? file.origin : store.filePath(meta, index);
          if (p && fs.existsSync(p)) filePaths.push(p);
        });
      }
      if (filePaths.length) {
        const result = await copyRaw('files', filePaths);
        if (result.ok && capture) capture.ignoreNext(['files', 'image']);
        return json(res, result.ok ? 200 : 500, {
          ...result,
          mode: 'files',
          count: filePaths.length - (result.skipped || 0),
        });
      }

      const texts = metas.filter((meta) => meta.type === 'text').map((meta) => store.readText(meta));
      if (!texts.length) return json(res, 400, { error: '没有可复制的内容' });
      const tmp = path.join(dataDir, 'tmp', `bulk-${Date.now().toString(36)}.txt`);
      fs.mkdirSync(path.dirname(tmp), { recursive: true });
      fs.writeFileSync(tmp, texts.join('\n\n'), 'utf8');
      const result = await copyRaw('text', [tmp]);
      fs.rmSync(tmp, { force: true });
      if (result.ok && capture) capture.ignoreNext(['text']);
      return json(res, result.ok ? 200 : 500, { ...result, mode: 'text', count: texts.length });
    }

    if (rest[0] === 'items' && rest.length >= 2) {
      const id = rest[1];

      // Undo must run before the existence check: a deleted item is intentionally
      // absent from the index while its undo window is open.
      if (rest[2] === 'restore' && method === 'POST') {
        const pending = restorable.get(id);
        if (!pending) return json(res, 410, { error: 'expired' });
        restorable.delete(id);
        const restored = store.restore(pending);
        return json(res, restored ? 200 : 409, { ok: !!restored, item: restored ? summarize(restored) : null });
      }

      const meta = store.get(id);
      if (!meta) return json(res, 404, { error: 'not found' });

      if (rest.length === 2 && method === 'GET') {
        const item = summarize(meta);
        item.preview = (meta.preview || '').slice(0, 20000);
        return json(res, 200, { item });
      }

      if (rest.length === 2 && method === 'PATCH') {
        const body = await readJson(req, 8192);
        const note = String(body.note == null ? '' : body.note)
          .replace(/[\u0000-\u001f]/g, ' ')
          .trim()
          .slice(0, 500);
        const updated = store.setNote(id, note);
        broadcast('update', summarize(updated));
        return json(res, 200, { ok: true, item: summarize(updated) });
      }

      if (rest.length === 2 && method === 'DELETE') {
        const removed = store.remove(id);
        if (!removed) return json(res, 404, { error: 'not found' });
        rememberRestorable(id, removed);
        return json(res, 200, { ok: true, id, undo: RESTORE_TTL });
      }

      if (rest[2] === 'copy' && method === 'POST') {
        const result = await copyToClipboard(store, meta);
        // An image is written as pixels plus a file URL, so the watcher may
        // report either shape; ignore both.
        if (result.ok && capture) {
          capture.ignoreNext(meta.type === 'text' ? ['text'] : meta.type === 'image' ? ['image', 'files'] : ['files']);
        }
        return json(res, result.ok ? 200 : 500, result);
      }

      if (rest[2] === 'import' && method === 'POST') {
        const updated = await store.importMissing(id);
        if (!updated) return json(res, 404, { error: 'not found' });
        broadcast('update', summarize(updated));
        return json(res, 200, { ok: true, item: summarize(updated) });
      }

      if (rest[2] === 'thumb' && method === 'GET') {
        const thumb = store.thumbPath(meta);
        if (!thumb) return text(res, 404, 'no thumb');
        return serveFile(req, res, thumb, { mime: 'image/png' });
      }

      if (rest[2] === 'poster' && method === 'GET') {
        const poster = store.posterPath(meta);
        if (!poster) return text(res, 404, 'no poster');
        return serveFile(req, res, poster, { mime: 'image/png' });
      }

      if (rest[2] === 'open' && method === 'POST') {
        // Hand the file to the OS default app — the escape hatch for codecs the
        // browser cannot decode.
        const file = store.filePath(meta, 0);
        if (!file) return json(res, 404, { error: '原始文件未读取' });
        try {
          if (process.platform === 'darwin') {
            spawn('open', [file], { detached: true, stdio: 'ignore' }).unref();
          } else if (process.platform === 'win32') {
            spawn('cmd', ['/c', 'start', '', file], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
          } else {
            spawn('xdg-open', [file], { detached: true, stdio: 'ignore' }).unref();
          }
          return json(res, 200, { ok: true });
        } catch (err) {
          return json(res, 500, { ok: false, error: err.message });
        }
      }

      if (rest[2] === 'body' && method === 'GET') {
        if (meta.type !== 'text') return text(res, 404, 'no body');
        return serveFile(req, res, store.textPath(meta), { mime: 'text/plain; charset=utf-8' });
      }

      if (rest[2] === 'file' && method === 'GET') {
        const index = Number(rest[3]);
        const file = store.filePath(meta, index);
        const descriptor = meta.files[index];
        if (!descriptor) return text(res, 404, 'not found');
        if (!file) return text(res, 404, 'original file was unreadable');
        return serveFile(req, res, file, {
          mime: descriptor.mime,
          name: descriptor.name,
          download: query.get('download') === '1',
        });
      }
    }

    if (rest[0] === 'bundles' && method === 'POST' && rest.length === 1) {
      const body = await readJson(req, 64 * 1024);
      const manifest = bundles.create({ type: body.type || 'files', count: body.count || 1, owner: 'local' });
      return json(res, 200, { bundle: manifest.id, count: manifest.count });
    }

    if (rest[0] === 'bundles' && rest.length === 3 && rest[2] === 'blob' && method === 'PUT') {
      const slot = Number(query.get('slot'));
      const name = query.get('name') || `file-${slot}`;
      const bytes = await bundles.writeBlob(rest[1], slot, name, req);
      return json(res, 200, { ok: true, bytes });
    }

    if (rest[0] === 'bundles' && rest.length === 3 && rest[2] === 'commit' && method === 'POST') {
      await readJson(req, 64 * 1024);
      const result = await bundles.commit(rest[1], { source: 'drop' });
      return json(res, 200, {
        ok: true,
        duplicate: !!result.duplicate,
        item: result.entry ? summarize(result.entry) : null,
      });
    }

    if (rest[0] === 'system' && rest[1] === 'fda' && method === 'POST') {
      if (process.platform !== 'darwin') return json(res, 400, { error: 'macOS only' });
      spawn('open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'], {
        detached: true,
        stdio: 'ignore',
      }).unref();
      return json(res, 200, { ok: true, hint: process.execPath });
    }

    if (rest[0] === 'device' && method === 'PATCH') {
      const body = await readJson(req, 4096);
      const name = String(body.name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40);
      if (!name) return json(res, 400, { error: 'empty name' });
      config.name = name;
      saveConfig();
      broadcast('device', publicConfig(config));
      return json(res, 200, { device: publicConfig(config) });
    }

    if (rest[0] === 'peers' && rest.length === 2 && rest[1] === 'pair' && method === 'POST') {
      const body = await readJson(req, 4096);
      try {
        const peer = await lan.pair({ host: String(body.host || '').trim(), port: body.port, code: body.code });
        broadcast('peers', lan.peers());
        return json(res, 200, { peer: { id: peer.id, name: peer.name }, peers: lan.peers(), device: publicConfig(config) });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }

    if (rest[0] === 'peers' && rest.length === 2 && method === 'DELETE') {
      lan.forget(rest[1]);
      broadcast('peers', lan.peers());
      return json(res, 200, { ok: true });
    }

    if (rest[0] === 'peers' && rest.length === 3 && rest[2] === 'send' && method === 'POST') {
      const body = await readJson(req, 4096);
      const ids = Array.isArray(body.itemIds) && body.itemIds.length
        ? [...new Set(body.itemIds.map(String))].slice(0, 200)
        : (body.itemId ? [String(body.itemId)] : []);
      if (!ids.length) return json(res, 400, { error: '没有选中项' });

      let sent = 0;
      const failed = [];
      for (const itemId of ids) {
        try {
          await lan.send({ peerId: rest[1], itemId });
          sent += 1;
        } catch (err) {
          failed.push({ id: itemId, error: err.message });
        }
      }
      return json(res, failed.length && !sent ? 502 : 200, { ok: sent > 0, sent, failed });
    }

    return json(res, 404, { error: 'not found' });
  }

  // ---------------------------------------------------------------- peer API

  async function handleSync(req, res, pathname) {
    const segments = pathname.split('/').filter(Boolean); // ['api','sync',...]
    const rest = segments.slice(2);
    const method = req.method;
    const url = new URL(req.url, 'http://localhost');
    const query = url.searchParams;

    if (rest[0] === 'pair' && method === 'POST') {
      if (!codeAuth(req)) return json(res, 401, { error: 'bad code' });
      const body = await readJson(req, 8192);
      const id = String(body.id || '').trim();
      const token = normalizeCode(body.token);
      const secret = String(body.secret || '');
      const host = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
      const port = Number(body.port);
      if (!id || !token || !/^[a-f0-9]{32,64}$/.test(secret)) return json(res, 400, { error: 'bad payload' });
      if (id === config.id) return json(res, 400, { error: 'same device' });
      if (!port || port < 1 || port > 65535) return json(res, 400, { error: 'bad port' });

      // `secret` arrives from the pairer: the value it will present to us.
      // `secretOut` is ours to keep: the value we present when we call them.
      const mySecret = crypto.randomBytes(24).toString('hex');
      lan.remember({
        id,
        name: String(body.name || '设备').slice(0, 60),
        token,
        secretIn: secret,
        secretOut: mySecret,
        host,
        port,
        addedAt: Date.now(),
        lastSeen: Date.now(),
      });
      broadcast('peers', lan.peers());
      log(`[lan] trusted ${body.name} ${host}:${port}`);
      return json(res, 200, { id: config.id, name: config.name, port: config.port, secret: mySecret });
    }

    const who = peerAuth(req);
    if (!who) return json(res, 401, { error: 'unauthorized' });

    if (rest[0] === 'bundles' && method === 'POST' && rest.length === 1) {
      const body = await readJson(req, 8192);
      const manifest = bundles.create({
        type: body.type || 'files',
        createdAt: body.createdAt,
        count: body.count || 1,
        owner: crypto.createHash('sha1').update(who.secretIn).digest('hex'),
      });
      return json(res, 200, { bundle: manifest.id, count: manifest.count });
    }

    if (rest[0] === 'bundles' && rest.length === 3 && rest[2] === 'blob' && method === 'PUT') {
      const bundle = bundles.read(rest[1]);
      const owner = crypto.createHash('sha1').update(who.secretIn).digest('hex');
      if (bundle.owner !== owner) return json(res, 403, { error: 'forbidden' });
      const slot = Number(query.get('slot'));
      const bytes = await bundles.writeBlob(rest[1], slot, query.get('name'), req);
      return json(res, 200, { ok: true, bytes });
    }

    if (rest[0] === 'bundles' && rest.length === 3 && rest[2] === 'commit' && method === 'POST') {
      const bundle = bundles.read(rest[1]);
      const owner = crypto.createHash('sha1').update(who.secretIn).digest('hex');
      if (bundle.owner !== owner) return json(res, 403, { error: 'forbidden' });
      await readJson(req, 8192);
      const result = await bundles.commit(rest[1], {
        source: 'lan',
        origin: { deviceId: who.id, deviceName: who.name },
      });
      return json(res, 200, {
        ok: true,
        duplicate: !!result.duplicate,
        id: result.entry ? result.entry.id : null,
      });
    }

    return json(res, 404, { error: 'not found' });
  }

  // ---------------------------------------------------------------- dispatch

  async function handle(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return text(res, 400, 'bad request');
    }
    const pathname = url.pathname;

    try {
      if (req.method === 'GET' && pathname === '/api/health') {
        return json(res, 200, { ok: true, app: 'paste', name: config.name, port: config.port });
      }
      if (pathname === '/events' && req.method === 'GET') {
        if (!isLocal(req)) return text(res, 403, 'forbidden');
        return handleEvents(req, res);
      }
      if (pathname.startsWith('/api/sync/')) {
        return await handleSync(req, res, pathname);
      }
      if (pathname === '/' || pathname === '/index.html') {
        if (!isLoopback(req)) return text(res, 403, 'Paste is local-only. Pair devices in the app.');
        return serveIndex(req, res);
      }
      if (pathname.startsWith('/api/')) {
        if (!isLocal(req)) return json(res, 401, { error: 'unauthorized' });
        return await handleApi(req, res, pathname, url);
      }
      if (req.method === 'GET') return serveStatic(req, res, pathname);
      return text(res, 405, 'method not allowed');
    } catch (err) {
      const status = err && err.status ? err.status : 500;
      if (status >= 500) logError('[server]', err);
      if (!res.headersSent) return json(res, status, { error: (err && err.message) || 'error' });
      try { res.end(); } catch { /* ignore */ }
    }
  }

  function start() {
    server = http.createServer((req, res) => {
      handle(req, res).catch((err) => {
        logError('[server] unhandled', err);
        try { res.writeHead(500); res.end(); } catch { /* ignore */ }
      });
    });
    server.requestTimeout = 0;
    server.headersTimeout = 0;
    server.timeout = 0;
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, '0.0.0.0', () => {
        const addr = server.address();
        log(`[server] http://127.0.0.1:${addr.port}`);
        resolve(addr.port);
      });
    });
  }

  function stop() {
    for (const res of clients) {
      try { res.end(); } catch { /* ignore */ }
    }
    clients.clear();
    if (server) server.close();
  }

  // Keep SSE connections alive through sleep/wake and quiet periods.
  const heartbeat = setInterval(() => {
    for (const res of clients) {
      try { res.write(': hi\n\n'); } catch { clients.delete(res); }
    }
  }, 25000);
  heartbeat.unref?.();

  return { start, stop, broadcast };
}
