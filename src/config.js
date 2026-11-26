// Platform paths and the one JSON config file this app keeps.
// Config is the only mutable global state; everything else lives per item.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newCode, newId, normalizeCode, platformLabel, prettyName, readJson, writeJsonAtomic } from './util.js';

export const DEFAULT_PORT = 47810;
export const DISCOVERY_PORT = 47811;

export function defaultDataDir() {
  if (process.env.PASTE_DATA) return path.resolve(process.env.PASTE_DATA);
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Paste');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Paste');
  return path.join(home, '.paste');
}

export function paths(dataDir) {
  return {
    data: dataDir,
    config: path.join(dataDir, 'config.json'),
    items: path.join(dataDir, 'items'),
    inbox: path.join(dataDir, 'inbox'),
    trash: path.join(dataDir, 'trash'),
    tmp: path.join(dataDir, 'tmp'),
    log: path.join(dataDir, 'paste.log'),
  };
}

export function loadConfig(dataDir) {
  const p = paths(dataDir);
  fs.mkdirSync(p.items, { recursive: true });
  fs.mkdirSync(p.inbox, { recursive: true });
  fs.mkdirSync(p.tmp, { recursive: true });

  const stored = readJson(p.config, null) || {};
  const config = {
    schema: 1,
    id: stored.id || newId(),
    name: stored.name || prettyName(),
    code: normalizeCode(stored.code) || newCode(),
    port: Number(stored.port) || Number(process.env.PASTE_PORT) || DEFAULT_PORT,
    retentionDays: Number(stored.retentionDays) || 30,
    capture: stored.capture !== false,
    peers: Array.isArray(stored.peers) ? stored.peers.filter((x) => x && x.id && x.token) : [],
    createdAt: stored.createdAt || Date.now(),
  };
  // Environment wins so two instances can share one config file during testing.
  if (process.env.PASTE_PORT) config.port = Number(process.env.PASTE_PORT);
  if (process.env.PASTE_RETENTION) config.retentionDays = Number(process.env.PASTE_RETENTION);
  if (process.env.PASTE_NO_CAPTURE === '1') config.capture = false;

  saveConfig(dataDir, config);
  return config;
}

export function saveConfig(dataDir, config) {
  writeJsonAtomic(paths(dataDir).config, config);
}

/** Public shape shared with the browser and with peers. Never leaks tokens. */
export function publicConfig(config) {
  return {
    id: config.id,
    name: config.name,
    code: config.code,
    port: config.port,
    platform: platformLabel(),
    retentionDays: config.retentionDays,
    capture: config.capture,
    peers: config.peers.map(publicPeer),
  };
}

export function publicPeer(peer) {
  return { id: peer.id, name: peer.name, addedAt: peer.addedAt, lastSeen: peer.lastSeen || null };
}
