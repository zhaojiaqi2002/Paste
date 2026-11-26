// LAN presence and transfer, without any cloud.
//
// Discovery: UDP broadcast on DISCOVERY_PORT, 3s heartbeat. Peers are matched by
// device id, never by address, and expire after 12s of silence.
//
// Trust: the pairing code *is* the peer's token. Device A enters B's code; A
// calls B's /api/sync/pair with that code, and B immediately trusts the token A
// presents. One entry pairs both directions. Tokens never appear in broadcasts.

import dgram from 'node:dgram';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import crypto from 'node:crypto';
import { platformLabel, normalizeCode } from './util.js';
import { DISCOVERY_PORT } from './config.js';
import { log } from './log.js';

const ANNOUNCE_MS = 3000;
const EXPIRE_MS = 12000;

function request(url, { method = 'GET', headers = {}, body = null, file = null, size = 0, idle = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const allHeaders = { ...headers };
    if (body != null) {
      allHeaders['content-length'] = Buffer.byteLength(body);
      allHeaders['content-type'] = allHeaders['content-type'] || 'application/json';
    }
    if (file) {
      allHeaders['content-length'] = size;
      allHeaders['content-type'] = 'application/octet-stream';
    }
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: allHeaders },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { data += d; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(data); } catch { /* not json */ }
          resolve({ status: res.statusCode, json, text: data });
        });
      },
    );
    req.setTimeout(idle, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (file) {
      const stream = fs.createReadStream(file);
      stream.on('error', reject);
      stream.pipe(req);
    } else {
      if (body != null) req.write(body);
      req.end();
    }
  });
}

export function createLan({ config, store, saveConfig, onChange, onProgress }) {
  const discovered = new Map();
  const lastAnswer = new Map();
  let socket = null;
  let announceTimer = null;
  let lastSignature = '';

  function broadcastTargets() {
    const targets = new Set(['255.255.255.255', '127.0.0.1']);
    for (const list of Object.values(os.networkInterfaces())) {
      for (const addr of list || []) {
        if (addr.family !== 'IPv4' || addr.internal || !addr.netmask) continue;
        const ip = addr.address.split('.').map(Number);
        const mask = addr.netmask.split('.').map(Number);
        if (ip.length !== 4 || mask.length !== 4) continue;
        targets.add(ip.map((n, i) => ((n & mask[i]) | (~mask[i] & 255)) & 255).join('.'));
      }
    }
    return [...targets];
  }

  function payload() {
    return JSON.stringify({
      app: 'paste',
      v: 1,
      id: config.id,
      name: config.name,
      port: config.port,
      platform: platformLabel(),
    });
  }

  function announce() {
    if (!socket) return;
    const frame = payload();
    for (const host of broadcastTargets()) {
      socket.send(frame, DISCOVERY_PORT, host, () => { /* best effort */ });
    }
  }

  // Broadcast can reach only one of several sockets bound to the same port
  // (SO_REUSEPORT), so answer every new announcer directly. Unicast makes
  // discovery bidirectional even when a broadcast is missed.
  function answer(host) {
    if (!socket) return;
    socket.send(payload(), DISCOVERY_PORT, host, () => { /* best effort */ });
  }

  function signatureOf(list) {
    return list.map((p) => `${p.id}:${p.trusted ? 1 : 0}:${p.online ? 1 : 0}:${p.name}`).join('|');
  }

  function peers() {
    const now = Date.now();
    const out = [];
    for (const peer of config.peers) {
      const live = discovered.get(peer.id);
      const online = !!live && now - live.seenAt < EXPIRE_MS;
      out.push({
        id: peer.id,
        name: (online && live.name) || peer.name,
        trusted: true,
        online,
        host: online ? live.host : peer.host,
        port: online ? live.port : peer.port,
        platform: online ? live.platform : null,
        lastSeen: online ? live.seenAt : peer.lastSeen || null,
      });
    }
    for (const live of discovered.values()) {
      if (config.peers.some((p) => p.id === live.id)) continue;
      if (now - live.seenAt >= EXPIRE_MS) continue;
      out.push({
        id: live.id,
        name: live.name,
        trusted: false,
        online: true,
        host: live.host,
        port: live.port,
        platform: live.platform,
        lastSeen: live.seenAt,
      });
    }
    out.sort((a, b) => (b.trusted - a.trusted) || (b.online - a.online) || a.name.localeCompare(b.name));
    return out;
  }

  function notify() {
    const list = peers();
    const sig = signatureOf(list);
    for (const peer of config.peers) {
      const live = discovered.get(peer.id);
      if (live) peer.lastSeen = live.seenAt;
    }
    if (sig !== lastSignature) {
      lastSignature = sig;
      if (onChange) onChange(list);
    }
  }

  function handleMessage(buf, rinfo) {
    let msg;
    try { msg = JSON.parse(buf.toString('utf8')); } catch { return; }
    if (!msg || msg.app !== 'paste' || !msg.id || msg.id === config.id) return;
    const port = Number(msg.port);
    if (!port || port < 1 || port > 65535) return;
    discovered.set(msg.id, {
      id: msg.id,
      name: String(msg.name || '设备').slice(0, 60),
      host: rinfo.address,
      port,
      platform: msg.platform || null,
      seenAt: Date.now(),
    });
    if (Date.now() - (lastAnswer.get(msg.id) || 0) > 10000) {
      lastAnswer.set(msg.id, Date.now());
      answer(rinfo.address);
    }
    notify();
  }

  function start() {
    try {
      socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    } catch (err) {
      log('[lan] discovery unavailable:', err.message);
      return;
    }
    socket.on('error', (err) => {
      log('[lan] socket error:', err.message);
      try { socket.close(); } catch { /* ignore */ }
      socket = null;
    });
    socket.on('message', handleMessage);
    socket.bind(DISCOVERY_PORT, () => {
      try { socket.setBroadcast(true); } catch { /* ignore */ }
      announce();
    });
    announceTimer = setInterval(() => {
      announce();
      notify();
    }, ANNOUNCE_MS);
    announceTimer.unref?.();
  }

  function stop() {
    clearInterval(announceTimer);
    if (socket) {
      try { socket.close(); } catch { /* ignore */ }
      socket = null;
    }
  }

  function remember(peer) {
    config.peers = config.peers.filter((p) => p.id !== peer.id).concat(peer);
    saveConfig();
    lastSignature = '';
    notify();
  }

  function forget(id) {
    config.peers = config.peers.filter((p) => p.id !== id);
    saveConfig();
    lastSignature = '';
    notify();
  }

  /** Enter a peer's code and become mutually trusted. */
  async function pair({ host, port, code }) {
    const token = normalizeCode(code);
    if (!token) throw new Error('配对码应为 10 位');
    if (!host) throw new Error('填写设备地址');
    const target = `http://${host}:${Number(port) || config.port}`;
    const mySecret = crypto.randomBytes(24).toString('hex');
    const res = await request(`${target}/api/sync/pair`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        id: config.id,
        name: config.name,
        port: config.port,
        token: config.code,
        secret: mySecret,
      }),
      idle: 8000,
    }).catch(() => {
      throw new Error('无法连接该设备');
    });
    if (res.status === 401) throw new Error('配对码不正确');
    if (res.status === 400) throw new Error('不能与本机配对');
    if (res.status !== 200 || !res.json || !res.json.id) throw new Error('设备未响应');
    if (res.json.id === config.id) throw new Error('不能与本机配对');
    if (!res.json.secret) throw new Error('设备版本过旧，请更新');
    const peer = {
      id: res.json.id,
      name: res.json.name || '设备',
      token,
      secretOut: mySecret,
      secretIn: res.json.secret,
      host,
      port: Number(res.json.port) || Number(port) || config.port,
      addedAt: Date.now(),
      lastSeen: Date.now(),
    };
    remember(peer);
    log(`[lan] paired with ${peer.name} ${peer.host}:${peer.port}`);
    return peer;
  }

  /** Push one item to a trusted peer: create bundle, stream blobs, commit. */
  async function send({ peerId, itemId }) {
    const peer = config.peers.find((p) => p.id === peerId);
    if (!peer) throw new Error('设备未配对');
    const meta = store.get(itemId);
    if (!meta) throw new Error('记录不存在');

    const live = discovered.get(peer.id);
    const host = live ? live.host : peer.host;
    const port = live ? live.port : peer.port;
    if (!host) throw new Error('设备地址未知');

    if (!peer.secretOut) throw new Error('请重新配对这台设备');
    const base = `http://${host}:${port}`;
    const auth = { authorization: `Bearer ${peer.secretOut}` };
    const blobs = meta.type === 'text'
      ? [{ name: 'body.txt', file: store.textPath(meta) }]
      : meta.files.map((f, i) => ({ name: f.name, file: store.filePath(meta, i) })).filter((b) => b.file);

    if (onProgress) onProgress({ itemId, peerId, phase: 'sending', name: peer.name });

    try {
      const created = await request(`${base}/api/sync/bundles`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ type: meta.type, createdAt: meta.createdAt, count: blobs.length }),
      });
      if (created.status !== 200 || !created.json || !created.json.bundle) {
        throw new Error(created.json && created.json.error ? created.json.error : `设备返回 ${created.status}`);
      }
      const bundle = created.json.bundle;

      for (let i = 0; i < blobs.length; i++) {
        const size = fs.statSync(blobs[i].file).size;
        const res = await request(
          `${base}/api/sync/bundles/${bundle}/blob?slot=${i}&name=${encodeURIComponent(blobs[i].name)}`,
          { method: 'PUT', headers: auth, file: blobs[i].file, size, idle: 60000 },
        );
        if (res.status !== 200) throw new Error(`传输失败 (${res.status})`);
      }

      const commit = await request(`${base}/api/sync/bundles/${bundle}/commit`, {
        method: 'POST',
        headers: auth,
        body: '{}',
      });
      if (commit.status !== 200) {
        throw new Error(commit.json && commit.json.error ? commit.json.error : '接收设备写入失败');
      }

      peer.lastSeen = Date.now();
      saveConfig();
      if (onProgress) onProgress({ itemId, peerId, phase: 'done', name: peer.name });
      log(`[lan] sent ${itemId} -> ${peer.name} (${blobs.length} blob${blobs.length === 1 ? '' : 's'})`);
      return { ok: true, duplicate: !!commit.json.duplicate };
    } catch (err) {
      if (onProgress) onProgress({ itemId, peerId, phase: 'error', name: peer.name, error: err.message });
      throw err;
    }
  }

  return { start, stop, peers, pair, send, remember, forget };
}
