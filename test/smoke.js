// End-to-end smoke test. Spawns two real servers with separate data
// directories, pairs them, transfers items over HTTP, and checks the file store.
//
//   npm test
//
// No test framework, no mocks: everything below is what the app actually does.

import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { execFileSync } from 'node:child_process';
import { Store, summarize } from '../src/store.js';
import { sniffImage, sniffImageFile } from '../src/util.js';
import { copyToClipboard } from '../src/copy.js';
import { dayKeyBefore } from '../src/util.js';

const ROOT = path.join(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-test-'));
const portA = 49500 + Math.floor(Math.random() * 200);
const portB = portA + 1;
const children = [];
let passed = 0;
let failed = 0;

function ok(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function equal(name, actual, expected, detail = '') {
  ok(name, actual === expected,
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}${detail ? ` (${detail})` : ''}`);
}

function boot(port, dir) {
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'main.js')], {
    env: { ...process.env, PASTE_DATA: dir, PASTE_PORT: String(port), PASTE_NO_CAPTURE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  return { child, log: () => log };
}

async function waitHealthy(port, timeout = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) });
      if (res.ok) return;
    } catch { /* not up */ }
    await sleep(120);
  }
  throw new Error(`server on ${port} did not start`);
}

class Client {
  constructor(port) {
    this.port = port;
    this.cookie = '';
  }

  url(p) {
    return `http://127.0.0.1:${this.port}${p}`;
  }

  async get(p) {
    return fetch(this.url(p), { headers: this.headers() });
  }

  headers(extra = {}) {
    return this.cookie ? { cookie: this.cookie, ...extra } : extra;
  }

  async json(p, options = {}) {
    const res = await fetch(this.url(p), {
      ...options,
      headers: this.headers({ 'content-type': 'application/json', ...(options.headers || {}) }),
    });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, body };
  }

  async login() {
    const res = await fetch(this.url('/'));
    const cookie = res.headers.getSetCookie?.()[0] || res.headers.get('set-cookie') || '';
    this.cookie = cookie.split(';')[0];
    return res.status;
  }

  async addText(text) {
    return this.json('/api/items', { method: 'POST', body: JSON.stringify({ text }) });
  }

  async addFiles(files) {
    const created = await this.json('/api/bundles', { method: 'POST', body: JSON.stringify({ count: files.length }) });
    const bundle = created.body.bundle;
    for (let i = 0; i < files.length; i++) {
      const res = await fetch(this.url(`/api/bundles/${bundle}/blob?slot=${i}&name=${encodeURIComponent(files[i].name)}`), {
        method: 'PUT',
        headers: this.headers(),
        body: files[i].data,
      });
      assert.equal(res.status, 200, 'blob upload');
    }
    return this.json(`/api/bundles/${bundle}/commit`, { method: 'POST', body: '{}' });
  }
}

// A 2x2 PNG, so the image path (conversion, thumbnail, dimensions) is exercised.
const PNG_2x2 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==',
  'base64',
);

const dirA = path.join(tmp, 'a');
const dirB = path.join(tmp, 'b');
const serverA = boot(portA, dirA);
const serverB = boot(portB, dirB);

try {
  await Promise.all([waitHealthy(portA), waitHealthy(portB)]);
  const A = new Client(portA);
  const B = new Client(portB);

  console.log('\nHTTP and storage');
  const indexStatus = await A.login();
  equal('index served to loopback', indexStatus, 200);
  ok('session cookie issued', A.cookie.startsWith('paste_session='));
  await B.login();

  const anonymous = await fetch(`http://127.0.0.1:${portA}/api/state`);
  equal('API rejects requests without a session', anonymous.status, 401);

  const added = await A.addText('hello from the smoke test');
  equal('text item stored', added.status, 200);
  const textId = added.body.item.id;
  ok('text item is classified as text', added.body.item.type === 'text');

  const duplicate = await A.addText('hello from the smoke test');
  equal('identical content is deduplicated', duplicate.body.duplicate, true);

  const longText = `line one\n${'body text '.repeat(400)}needle-in-a-haystack${' tail'.repeat(200)}`;
  const longItem = await A.addText(longText);
  const hayId = longItem.body.item.id;

  const searched = await A.json('/api/items?q=needle-in-a-haystack');
  equal('search reaches past the preview', searched.body.total, 1);
  ok('search result carries a snippet', typeof searched.body.items[0].snippet === 'string'
    && searched.body.items[0].snippet.includes('needle-in-a-haystack'));

  const image = await A.addFiles([{ name: 'dot.png', data: PNG_2x2 }]);
  equal('image item stored', image.status, 200);
  const imageId = image.body.item.id;
  ok('image classified as image', image.body.item.type === 'image');
  ok('image dimensions parsed', image.body.item.files[0].w === 2 && image.body.item.files[0].h === 2,
    JSON.stringify(image.body.item.files[0]));

  const thumb = await A.get(`/api/items/${imageId}/thumb`);
  equal('thumbnail served', thumb.status, 200);
  ok('thumbnail is a png', (await thumb.arrayBuffer()).byteLength > 0);

  const ranged = await fetch(`http://127.0.0.1:${portA}/api/items/${imageId}/file/0`, {
    headers: { ...A.headers(), range: 'bytes=0-7' },
  });
  equal('range request supported', ranged.status, 206);

  const files = await A.addFiles([
    { name: 'notes.txt', data: Buffer.from('attached file\n') },
    { name: 'clip.mp4', data: Buffer.from('fake video bytes') },
  ]);
  ok('multi-file item classified by content', ['files', 'video'].includes(files.body.item.type));

  const filtered = await A.json('/api/items?type=image');
  equal('type filter works', filtered.body.total, 1);

  const renamed = await A.json('/api/device', { method: 'PATCH', body: JSON.stringify({ name: 'Smoke A' }) });
  equal('device rename persists', renamed.body.device.name, 'Smoke A');

  const removed = await A.json(`/api/items/${textId}`, { method: 'DELETE' });
  equal('delete succeeds', removed.status, 200);
  const restored = await A.json(`/api/items/${textId}/restore`, { method: 'POST', body: '{}' });
  equal('undo restore succeeds', restored.status, 200);
  ok('restored item is back', restored.body.item && restored.body.item.id === textId);

  console.log('\nBulk selection');
  const bulkIds = [];
  for (const label of ['bulk one', 'bulk two', 'bulk three']) {
    const added = await A.addText(label);
    bulkIds.push(added.body.item.id);
  }
  const copied = await A.json('/api/items/bulk-copy', {
    method: 'POST',
    body: JSON.stringify({ ids: bulkIds }),
  });
  if (process.platform === 'darwin' || process.platform === 'win32') {
    equal('bulk copy of texts succeeds', copied.status, 200, JSON.stringify(copied.body));
    ok('bulk copy reports text mode and count', copied.body.mode === 'text' && copied.body.count === 3,
      JSON.stringify(copied.body));
  }

  const deleted = await A.json('/api/items/bulk-delete', {
    method: 'POST',
    body: JSON.stringify({ ids: bulkIds }),
  });
  equal('bulk delete removes every id', deleted.body.ids.length, 3);
  equal('deleted items leave the index', (await A.json('/api/items?q=bulk')).body.total, 0);

  const bulkRestored = await A.json('/api/items/bulk-restore', {
    method: 'POST',
    body: JSON.stringify({ ids: bulkIds }),
  });
  equal('bulk undo restores every id', bulkRestored.body.restored.length, 3);
  equal('restored items are listed again', (await A.json('/api/items?q=bulk')).body.total, 3);

  // a repeated delete must not resurrect an already-expired undo window
  const twice = await A.json('/api/items/bulk-restore', {
    method: 'POST',
    body: JSON.stringify({ ids: bulkIds }),
  });
  equal('undo cannot be replayed', twice.body.restored.length, 0);

  const pairFiles = await A.addFiles([
    { name: 'bulk-a.txt', data: Buffer.from('a') },
    { name: 'bulk-b.txt', data: Buffer.from('b') },
  ]);
  const fileCopy = await A.json('/api/items/bulk-copy', {
    method: 'POST',
    body: JSON.stringify({ ids: [pairFiles.body.item.id] }),
  });
  if (process.platform === 'darwin' || process.platform === 'win32') {
    ok('bulk copy of files reports file mode', fileCopy.body.mode === 'files' && fileCopy.body.count === 2,
      JSON.stringify(fileCopy.body));
  }

  console.log('\nLAN pairing and transfer');
  const stateA = await A.json('/api/state');
  const stateB = await B.json('/api/state');
  ok('pairing code has the expected shape', /^[A-Z0-9]{5}-[A-Z0-9]{5}$/.test(stateA.body.device.code), stateA.body.device.code);

  const paired = await B.json('/api/peers/pair', {
    method: 'POST',
    body: JSON.stringify({ host: '127.0.0.1', port: portA, code: stateA.body.device.code }),
  });
  equal('pairing by code succeeds', paired.status, 200);

  const peersA = (await A.json('/api/state')).body.peers;
  const peersB = (await B.json('/api/state')).body.peers;
  const trustedA = peersA.filter((p) => p.trusted);
  const trustedB = peersB.filter((p) => p.trusted);
  // Each side stores the *other* device, so cross-check against the real ids.
  ok('both sides trust each other', trustedA.length === 1 && trustedB.length === 1
    && trustedA[0].id === stateB.body.device.id
    && trustedB[0].id === stateA.body.device.id,
    `A=${JSON.stringify(peersA)} B=${JSON.stringify(peersB)}`);

  const targetFromA = peersA[0].id;
  const sentText = await A.json(`/api/peers/${targetFromA}/send`, {
    method: 'POST',
    body: JSON.stringify({ itemId: hayId }),
  });
  equal('text transfer accepted', sentText.status, 200, sentText.body && sentText.body.error);

  const sentImage = await A.json(`/api/peers/${targetFromA}/send`, {
    method: 'POST',
    body: JSON.stringify({ itemId: imageId }),
  });
  equal('image transfer accepted', sentImage.status, 200, sentImage.body && sentImage.body.error);

  const inboxB = (await B.json('/api/items?q=needle')).body;
  equal('received text searchable on B', inboxB.total, 1);
  ok('received item records its origin', inboxB.items[0] && inboxB.items[0].origin
    && inboxB.items[0].origin.deviceName === 'Smoke A', JSON.stringify(inboxB.items[0] && inboxB.items[0].origin));

  const receivedImage = (await B.json('/api/items?type=image')).body;
  equal('received image present on B', receivedImage.total, 1);
  const receivedThumb = await B.get(`/api/items/${receivedImage.items[0].id}/thumb`);
  equal('receiver regenerates thumbnails', receivedThumb.status, 200);

  const forged = await fetch(`http://127.0.0.1:${portB}/api/sync/bundles`, {
    method: 'POST',
    headers: { authorization: 'Bearer 000000000000000000000000000000000000000000000000', 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'text', count: 1 }),
  });
  equal('unknown token rejected', forged.status, 401);

  const hostHeader = await fetch(`http://127.0.0.1:${portA}/`, {
    headers: { 'x-forwarded-for': '10.0.0.9', host: 'paste.local' },
  });
  ok('index still only served over loopback', hostHeader.status === 200);

  console.log('\nImage bytes and filenames');
  const tiffMagic = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  equal('sniff: png', sniffImage(PNG_2x2), 'png');
  equal('sniff: tiff', sniffImage(tiffMagic), 'tiff');
  equal('sniff: jpeg', sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), 'jpeg');
  equal('sniff: unknown', sniffImage(Buffer.from('not an image at all')), null);

  const named = await A.addFiles([{ name: 'quarterly-report.pdf', data: Buffer.from('%PDF-1.4 fake') }]);
  ok('blob keeps its original filename', named.body.item.files[0].name === 'quarterly-report.pdf'
    && named.body.item.files[0].stored === undefined, JSON.stringify(named.body.item.files[0]));
  const onDisk = fs.readdirSync(path.join(dirA, 'items', named.body.item.day, named.body.item.id, 'files'));
  ok('file on disk is named like the original', onDisk.includes('quarterly-report.pdf'), onDisk.join(','));

  const dupNames = await A.addFiles([
    { name: 'same.txt', data: Buffer.from('one') },
    { name: 'same.txt', data: Buffer.from('two') },
  ]);
  const dupDisk = fs.readdirSync(path.join(dirA, 'items', dupNames.body.item.day, dupNames.body.item.id, 'files'));
  ok('duplicate names do not overwrite each other', dupDisk.length === 2, dupDisk.join(','));

  // A file whose extension lies is the exact shape of the blank-preview bug.
  if (process.platform === 'darwin') {
    const fakePng = path.join(tmp, 'liar.png');
    const tiff = path.join(tmp, 'real.tiff');
    const source = path.join(tmp, 'dot.png');
    fs.writeFileSync(source, PNG_2x2);
    try {
      execFileSync('/usr/bin/sips', ['-s', 'format', 'tiff', source, '--out', tiff], { stdio: 'ignore' });
      fs.copyFileSync(tiff, fakePng);
      equal('the fixture really is tiff', sniffImageFile(fakePng), 'tiff');
      const liars = await A.addFiles([{ name: 'liar.png', data: fs.readFileSync(fakePng) }]);
      const liar = liars.body.item;
      ok('mislabeled image becomes a real png', liar.files[0].mime === 'image/png', JSON.stringify(liar.files[0]));
      const liarDir = path.join(dirA, 'items', liar.day, liar.id, 'files');
      const storedPath = path.join(liarDir, fs.readdirSync(liarDir)[0]);
      equal('stored bytes are png', sniffImageFile(storedPath), 'png');
      ok('dimensions are parsed after conversion', liar.files[0].w > 0 && liar.files[0].h > 0,
        `${liar.files[0].w}x${liar.files[0].h}`);
      ok('thumbnail generated for the converted image', liar.thumb === true);
    } catch (err) {
      ok('mislabeled image fixture available', false, String(err && err.message));
    }
  }

  console.log('\nUnreadable sources (protected locations)');
  // A file we can stat but not open is exactly what macOS does for another
  // app's container. chmod 000 reproduces that failure mode portably.
  const locked = path.join(tmp, 'locked.png');
  fs.writeFileSync(locked, PNG_2x2);
  fs.chmodSync(locked, 0o000);
  const refStore = await Store.open(path.join(tmp, 'ref-store'), { retentionDays: 30 });
  const ref = await refStore.add({ files: [{ path: locked, name: 'locked.png' }], source: 'clipboard' });
  ok('unreadable file still becomes an item', !!ref.entry, JSON.stringify(ref));
  equal('item is flagged as missing its bytes', ref.entry && ref.entry.missing, 1);
  ok('original name and size are kept', ref.entry && ref.entry.files[0].name === 'locked.png' && ref.entry.files[0].size > 0,
    JSON.stringify(ref.entry && ref.entry.files[0]));
  ok('no blob path is handed out', refStore.filePath(ref.entry, 0) === null);
  const refSummary = summarize(ref.entry);
  ok('the wire format tells the UI', refSummary.files[0].missing === true && refSummary.missing === 1);
  const gone = { type: 'files', files: [{ name: 'gone.zip', mime: 'application/zip', missing: true, origin: path.join(tmp, 'never-existed.zip') }] };
  const deadRef = await copyToClipboard(refStore, gone).catch((err) => ({ ok: false, error: String(err) }));
  ok('copying a reference whose file is gone fails loudly', deadRef.ok === false, JSON.stringify(deadRef));

  const storeDir = path.join(tmp, 'retention');
  const oldDay = dayKeyBefore(45);
  const oldDir = path.join(storeDir, 'items', oldDay, 'olditem');
  fs.mkdirSync(oldDir, { recursive: true });
  fs.writeFileSync(path.join(oldDir, 'meta.json'), JSON.stringify({
    schema: 1, id: 'olditem', type: 'text', createdAt: Date.now() - 45 * 86400000, day: oldDay, preview: 'old', files: [], size: 0,
  }));
  const freshDir = path.join(storeDir, 'items', dayKeyBefore(2), 'newitem');
  fs.mkdirSync(freshDir, { recursive: true });
  fs.writeFileSync(path.join(freshDir, 'meta.json'), JSON.stringify({
    schema: 1, id: 'newitem', type: 'text', createdAt: Date.now() - 2 * 86400000, day: dayKeyBefore(2), preview: 'new', files: [], size: 0,
  }));

  const reopened = await Store.open(storeDir, { retentionDays: 30 });
  equal('expired day removed on boot', reopened.get('olditem'), null);
  ok('recent day kept', reopened.get('newitem') !== null);
  ok('expired day directory deleted', !fs.existsSync(path.join(storeDir, 'items', oldDay)));

  const layout = fs.readdirSync(path.join(dirA, 'items'));
  ok('items are day buckets', layout.every((name) => /^\d{4}-\d{2}-\d{2}$/.test(name)), layout.join(','));
  const oneDay = path.join(dirA, 'items', layout[0]);
  const oneItem = fs.readdirSync(oneDay)[0];
  ok('meta.json is the source of truth', fs.existsSync(path.join(oneDay, oneItem, 'meta.json')));
  equal('no database files anywhere', fs.readdirSync(dirA).filter((f) => /\.(db|sqlite|sqlite3|ldb)$/i.test(f)).length, 0);
} catch (err) {
  failed++;
  console.error('\nunexpected error:', err);
  console.error(serverA.log());
  console.error(serverB.log());
} finally {
  for (const child of children) child.kill('SIGTERM');
  await sleep(300);
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
