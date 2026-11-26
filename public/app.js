// Paste — the whole UI. No framework, no build step: one file you can read.
//
// State lives in `S`. Rendering is a pure function of `S`: list, detail, filters,
// popover. Live updates arrive over SSE, so a copy on any paired device appears
// here without polling.

const boot = JSON.parse(document.getElementById('boot').textContent);
const $ = (sel) => document.querySelector(sel);

const TYPES = [
  { id: 'all', label: '全部' },
  { id: 'text', label: '文本' },
  { id: 'image', label: '图片' },
  { id: 'files', label: '文件' },
  { id: 'video', label: '视频' },
];

const TYPE_LABEL = { text: '文本', image: '图片', files: '文件', video: '视频' };
const DEFAULT_PORT = 47810;

const ICON = {
  copy: '<rect x="5.4" y="5.4" width="7.4" height="8.4" rx="1.9"/><path d="M10.4 3.3a1.8 1.8 0 0 0-1.7-1.3H4.4a1.9 1.9 0 0 0-1.9 1.9v5.5c0 .8.5 1.5 1.2 1.8"/>',
  send: '<path d="M13.8 2.2 7.2 8.8M13.8 2.2 9.5 13.8 7.2 8.8 1.8 6.5 13.8 2.2Z"/>',
  trash: '<path d="M2.6 4.3h10.8M6.5 4.3V3.1c0-.5.4-.9.9-.9h1.2c.5 0 .9.4.9.9v1.2M4.1 4.3l.6 8.1c0 .5.4.9.9.9h4.8c.5 0 .9-.4.9-.9l.6-8.1"/>',
  plus: '<path d="M8 3.4v9.2M3.4 8h9.2"/>',
  download: '<path d="M8 2.9v7.2M4.9 7.3 8 10.4l3.1-3.1M3.1 13.1h9.8"/>',
  back: '<path d="M9.9 3.4 5.3 8l4.6 4.6"/>',

  video: '<rect x="1.9" y="4.1" width="8.1" height="7.8" rx="1.7"/><path d="M10 7.2 13.9 5v6l-3.9-2.2"/>',
  image: '<rect x="2.3" y="3.1" width="11.4" height="9.8" rx="1.7"/><circle cx="5.9" cy="6.5" r="1.05"/><path d="M3 11.7 6.3 8.6l2.3 2.1 1.9-1.5 2.5 2.5"/>',
  text: '<path d="M3.4 4.2h9.2M3.4 8h9.2M3.4 11.8h5.4"/>',
  check: '<path d="M3.4 8.5 6.5 11.6 12.7 4.9"/>',
  paste: '<rect x="4.1" y="3.3" width="7.8" height="10.2" rx="1.9"/><path d="M6.2 3.3v-.8c0-.4.4-.8.8-.8h2c.4 0 .8.4.8.8v.8"/>',
  search: '<circle cx="7" cy="7" r="4.4"/><path d="M10.4 10.4 13.6 13.6"/>',
  close: '<path d="M4.2 4.2 11.8 11.8M11.8 4.2 4.2 11.8"/>',
};

const S = {
  items: boot.items || [],
  total: boot.total || 0,
  hasMore: false,
  type: 'all',
  q: '',
  // One selection set is the single source of truth for both single and multi
  // selection. `selectedId` is derived from it, never assigned.
  selection: new Set(boot.items && boot.items[0] ? [boot.items[0].id] : []),
  anchorId: boot.items && boot.items[0] ? boot.items[0].id : null,
  focusId: boot.items && boot.items[0] ? boot.items[0].id : null,
  collapsed: false,
  device: boot.device,
  peers: boot.peers || [],
  seq: 0,
};

Object.defineProperty(S, 'selectedId', {
  get() {
    return S.selection.size === 1 ? [...S.selection][0] : null;
  },
});

const bodies = new Map();
let toastTimer = null;
let pairingFor = null;
let manualOpen = false;
let explainedProtectedFile = false;

// ---------------------------------------------------------------- DOM helpers

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) node.setAttribute(key, '');
    else if (value !== false && value != null) node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

function icon(name) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  node.setAttribute('viewBox', '0 0 16 16');
  node.setAttribute('class', 'i');
  node.setAttribute('aria-hidden', 'true');
  node.innerHTML = ICON[name] || ICON.text;
  return node;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function dayOf(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function groupLabel(day) {
  const today = dayOf(Date.now());
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (day === today) return '今天';
  if (day === dayOf(yesterday.getTime())) return '昨天';
  const d = new Date(`${day}T00:00:00`);
  if (d.getFullYear() === new Date().getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

function hhmm(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function stamp(ts) {
  if (dayOf(ts) === dayOf(Date.now())) return hhmm(ts);
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hhmm(ts)}`;
}

function bytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

function extOf(name) {
  const m = /\.([a-z0-9]{1,5})$/i.exec(name || '');
  return m ? m[1].toUpperCase() : 'FILE';
}

/**
 * A row shows at most two lines of text. Multi-line content gets a title plus a
 * remainder; a short opener like "{" or "#" is collapsed into the title instead
 * of becoming a meaningless title of its own.
 */
function textParts(preview) {
  const raw = String(preview || '').replace(/\r\n?/g, '\n');
  const lines = raw.split('\n').filter((line) => line.trim());
  if (!lines.length) return ['', ''];
  const first = lines[0].trim();
  if (first.length < 4 && lines.length > 1) {
    return [raw.replace(/\s+/g, ' ').trim(), ''];
  }
  return [first, lines.slice(1).join(' ').replace(/\s+/g, ' ').trim()];
}

function highlighted(text, query) {
  const frag = document.createDocumentFragment();
  const terms = String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length || !text) {
    frag.append(document.createTextNode(text || ''));
    return frag;
  }
  const lower = text.toLowerCase();
  let cursor = 0;
  while (cursor < text.length) {
    let bestAt = -1;
    let bestLen = 0;
    for (const term of terms) {
      const at = lower.indexOf(term, cursor);
      if (at >= 0 && (bestAt < 0 || at < bestAt)) { bestAt = at; bestLen = term.length; }
    }
    if (bestAt < 0) break;
    if (bestAt > cursor) frag.append(document.createTextNode(text.slice(cursor, bestAt)));
    frag.append(el('mark', {}, text.slice(bestAt, bestAt + bestLen)));
    cursor = bestAt + bestLen;
  }
  if (cursor < text.length) frag.append(document.createTextNode(text.slice(cursor)));
  return frag;
}

/**
 * JSON in, JSON out, never throws: every caller wants `{ ok, data }` and a
 * message to show. File uploads keep using fetch directly.
 */
async function api(path, options = {}) {
  const opts = { ...options };
  if (typeof opts.body === 'string') {
    opts.headers = { 'content-type': 'application/json', ...(opts.headers || {}) };
  }
  try {
    const res = await fetch(path, opts);
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: {} };
  }
}

function openPermissionSettings() {
  api('/api/system/fda', { method: 'POST' });
}

function toast(message, options = {}) {
  const node = $('#toast');
  node.replaceChildren(el('span', {}, message));
  if (options.action) {
    const button = el('button', { type: 'button' }, options.action);
    button.addEventListener('click', () => {
      hideToast();
      if (options.onAction) options.onAction();
    });
    node.append(button);
  }
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, options.duration || 2600);
}

function hideToast() {
  $('#toast').classList.remove('show');
}

// ---------------------------------------------------------------- list

function renderFilters() {
  const nav = $('#filters');
  nav.replaceChildren();
  for (const type of TYPES) {
    const button = el('button', {
      type: 'button',
      role: 'tab',
      'aria-selected': String(S.type === type.id),
    }, type.label);
    button.addEventListener('click', () => setType(type.id));
    nav.append(button);
  }
}

function rowMedia(item) {
  if (item.type === 'image') {
    const box = el('div', { class: 'row-media' });
    if (item.thumb) {
      const img = el('img', { src: `/api/items/${item.id}/thumb`, loading: 'lazy', alt: '' });
      box.append(img);
    } else {
      box.append(icon('image'));
    }
    return box;
  }
  if (item.type === 'files') {
    const first = item.files[0];
    return el('div', { class: 'row-media' }, el('span', { class: 'ext' }, first ? extOf(first.name).slice(0, 4) : 'FILE'));
  }
  if (item.type === 'video') {
    const box = el('div', { class: 'row-media' });
    if (item.poster) box.append(el('img', { src: `/api/items/${item.id}/poster`, loading: 'lazy', alt: '' }));
    else box.append(icon('video'));
    return box;
  }
  return null;
}

function rowFor(item) {
  const media = rowMedia(item);
  let title;
  let sub;

  if (item.type === 'text') {
    if (S.q && item.snippet) {
      // A search hit is shown as the excerpt itself, so the match is always visible.
      title = el('div', { class: 'row-title clamp2' }, highlighted(item.snippet, S.q));
    } else {
      const [first, rest] = textParts(item.preview);
      // One overflowing line may wrap to two; no filler labels.
      const twoLines = !rest && first.length > 34;
      title = el('div', { class: twoLines ? 'row-title clamp2' : 'row-title' }, highlighted(first, S.q));
      sub = rest ? el('div', { class: 'row-sub' }, highlighted(rest, S.q)) : null;
    }
  } else if (item.type === 'image') {
    const file = item.files[0] || {};
    const unread = file.missing;
    title = el('div', { class: 'row-title' }, highlighted(unread ? (file.name || '图片') : (file.w ? `${file.w} × ${file.h}` : file.name || '图片'), S.q));
    sub = el('div', { class: 'row-sub' }, item.files.length > 1
      ? `${item.files.length} 张 · ${bytes(item.size)}${unread ? ' · 未读取' : ''}`
      : `${bytes(file.size)}${unread ? ' · 未读取' : ''}`);
  } else if (item.type === 'video') {
    const file = item.files[0] || {};
    title = el('div', { class: 'row-title' }, highlighted(file.name || '视频', S.q));
    sub = el('div', { class: 'row-sub' }, `${bytes(file.size)}${file.missing ? ' · 未读取' : ''}`);
  } else {
    const file = item.files[0] || {};
    title = el('div', { class: 'row-title' }, highlighted(file.name || '文件', S.q));
    sub = el('div', { class: 'row-sub' }, `${item.files.length > 1 ? `${item.files.length} 个文件 · ` : ''}${bytes(item.size)}${item.missing ? ' · 未读取' : ''}`);
  }

  const selected = S.selection.has(item.id);
  const row = el(
    'div',
    {
      class: media ? 'row has-media' : 'row',
      role: 'option',
      tabindex: '-1',
      dataset: { id: item.id },
      'aria-selected': String(selected),
      title: item.type === 'text'
        ? `${TYPE_LABEL.text} · ${item.preview.slice(0, 160)}`
        : `${TYPE_LABEL[item.type] || ''} · ${(item.files[0] && item.files[0].name) || ''}`.trim(),
    },
    el('span', { class: 'check', role: 'checkbox', 'aria-checked': String(selected) }, icon('check')),
    media,
    el('div', { class: 'row-main' }, title, sub,
      item.note ? el('div', { class: 'row-note' }, item.note) : null),
    S.collapsed ? el('div', { class: 'row-actions' },
      el('button', {
        class: 'act',
        type: 'button',
        'aria-label': '复制',
        title: '复制',
        onclick: (event) => { event.stopPropagation(); copyItem(item); },
      }, icon('copy')),
      el('button', {
        class: 'act danger',
        type: 'button',
        'aria-label': '删除',
        title: '删除',
        onclick: (event) => { event.stopPropagation(); deleteItems([item.id]); },
      }, icon('trash')),
    ) : null,
    el('div', { class: 'row-time' }, hhmm(item.createdAt)),
  );

  row.addEventListener('click', (event) => {
    if (event.target.closest('.check')) {
      event.stopPropagation();
      toggleSelect(item.id);
      return;
    }
    if (event.target.closest('.row-actions')) return;
    if (event.metaKey || event.ctrlKey) { toggleSelect(item.id); return; }
    if (event.shiftKey) { extendSelect(item.id); return; }
    select(item.id, { open: true });
  });

  row.addEventListener('dblclick', (event) => {
    if (event.target.closest('.row-actions') || event.target.closest('.check')) return;
    select(item.id);
    copyItem(item);
  });
  return row;
}

function emptyState(message, glyph = 'paste') {
  return el('div', { class: 'empty' }, icon(glyph), el('div', {}, message));
}

function renderList() {
  const list = $('#list');
  const keep = list.scrollTop;
  list.replaceChildren();

  // A truly empty library reads better as one full-width surface than as an
  // empty rail beside an empty pane. Filters and search still use the rail.
  const libraryEmpty = !S.items.length && !S.q && S.type === 'all';
  $('#split').classList.toggle('is-empty', libraryEmpty);
  if (libraryEmpty) $('#split').classList.remove('detail-open');

  if (!S.items.length) {
    list.append(emptyState(S.q ? '没有匹配' : '复制即可记录', S.q ? 'search' : 'paste'));
    return;
  }

  let lastDay = null;
  const frag = document.createDocumentFragment();
  for (const item of S.items) {
    if (item.day !== lastDay) {
      frag.append(el('div', { class: 'group-label' }, groupLabel(item.day)));
      lastDay = item.day;
    }
    frag.append(rowFor(item));
  }
  list.append(frag);
  list.scrollTop = keep;

  if (S.hasMore) {
    const more = el('button', { class: 'row', type: 'button' }, el('div', { class: 'row-main' },
      el('div', { class: 'row-sub' }, `载入更早的 · 还剩 ${Math.max(0, S.total - S.items.length)}`)));
    more.addEventListener('click', () => loadMore());
    list.append(more);
  }
}

function scrollRowIntoView(id) {
  const row = $(`#list .row[data-id="${CSS.escape(id)}"]`);
  if (row) row.scrollIntoView({ block: 'nearest' });
}

function markSelection() {
  const list = $('#list');
  for (const row of list.querySelectorAll('.row[data-id]')) {
    const on = S.selection.has(row.dataset.id);
    row.setAttribute('aria-selected', String(on));
    const check = row.querySelector('.check');
    if (check) check.setAttribute('aria-checked', String(on));
  }
  list.classList.toggle('selecting', S.selection.size > 1);
  renderBulkBar();
}

function setSelection(ids, options = {}) {
  S.selection = new Set(ids);
  if (options.anchor !== undefined) S.anchorId = options.anchor;
  else if (!S.selection.size) S.anchorId = null;
  markSelection();
  renderDetail();
}

function select(id, options = {}) {
  S.focusId = id || null;
  setSelection(id ? [id] : [], { anchor: id || null });
  if (options.scroll !== false && id) scrollRowIntoView(id);
  if (options.open && !S.collapsed) $('#split').classList.add('detail-open');
}

function toggleSelect(id) {
  const next = new Set(S.selection);
  if (next.has(id)) next.delete(id);
  else {
    next.add(id);
    S.anchorId = id;
  }
  S.selection = next;
  S.focusId = id;
  markSelection();
  renderDetail();
  scrollRowIntoView(id);
}

function extendSelect(id) {
  const ids = S.items.map((item) => item.id);
  const target = ids.indexOf(id);
  if (target < 0) return;
  let anchorIndex = ids.indexOf(S.anchorId);
  if (anchorIndex < 0) anchorIndex = target;
  const from = Math.min(anchorIndex, target);
  const to = Math.max(anchorIndex, target);
  S.anchorId = ids[anchorIndex];
  S.focusId = id;
  setSelection(ids.slice(from, to + 1), { anchor: S.anchorId });
  scrollRowIntoView(id);
}

function selectAllVisible() {
  if (!S.items.length) return;
  setSelection(S.items.map((item) => item.id), { anchor: S.anchorId || S.items[0].id });
}

function clearSelection() {
  if (S.selection.size > 1) {
    const keep = S.anchorId && S.selection.has(S.anchorId) ? S.anchorId : [...S.selection][0];
    select(keep);
    scrollRowIntoView(keep);
  } else {
    select(null);
  }
}

function selectedItems() {
  const byId = new Map(S.items.map((item) => [item.id, item]));
  return [...S.selection].map((id) => byId.get(id)).filter(Boolean);
}

function moveSelection(delta, extend = false) {
  if (!S.items.length) return;
  const from = extend ? (S.focusId || S.anchorId) : (S.selection.size > 1 ? S.anchorId : S.selectedId);
  let index = S.items.findIndex((item) => item.id === from);
  if (index < 0) index = 0;
  else index = Math.min(S.items.length - 1, Math.max(0, index + delta));
  const id = S.items[index].id;
  if (extend && S.selection.size) {
    S.focusId = id;
    extendSelect(id);
  } else {
    select(id);
  }
}

// ---------------------------------------------------------------- detail

function codeLike(text) {
  const s = text.slice(0, 6000).trim();
  if (!s) return false;

  // Strong structural signals first; a stray word like "export." in prose must
  // never flip a paragraph into a monospace view.
  if (/^[[{]/.test(s) && /[\]}][\s;]*$/.test(s)) {
    try { JSON.parse(s); return true; } catch { /* not json */ }
  }
  if (/^\s*<(!doctype|html|\?xml|[a-z][\w-]*[\s>])/i.test(s)) return true;
  if (/^\s*(#!\/|import\s+[\w{*]|from\s+['"][^'"]+['"]\s*$|package\s+[\w.]+;|using\s+[\w.]+;)/m.test(s)) return true;
  if (/(^|\n)\s*(export\s+(default|const|function|class|async)|function|const|let|var|class|def|async\s+function)\s+[\w$]+\s*[({=:]/m.test(s)) return true;
  if (/=>\s*[{(\w]/.test(s) && /[;{}]/.test(s)) return true;
  if (/\b(SELECT|INSERT INTO|UPDATE|DELETE FROM|CREATE TABLE)\b/.test(s) && /;/.test(s)) return true;
  if (/(^|\n)\s*(npm|pnpm|yarn|npx|git|curl|wget|ssh|scp|rsync|cd|ls|mkdir|rm|cp|mv|node|deno|bun|python3?|pip3?|docker|brew|cargo|go|make|dotnet|mvn|gradle)\s+[-\w./@:]/m.test(s)) return true;

  const braces = (s.match(/[{}();=<>]/g) || []).length;
  if (s.length > 24 && /[{}]/.test(s) && braces / s.length > 0.06) return true;
  return false;
}

function metaLine(item) {
  const parts = [stamp(item.createdAt)];
  if (item.origin && item.origin.deviceName) parts.push(`来自 ${item.origin.deviceName}`);
  if (item.type === 'files' && item.size) parts.push(bytes(item.size));
  if (item.type === 'text' && item.chars > 20000) parts.push(`${(item.chars / 1000).toFixed(0)}k 字`);
  const node = el('div', { class: 'meta' });
  parts.forEach((part, index) => {
    if (index) node.append(el('span', { class: 'sep' }, '·'));
    node.append(el('span', {}, part));
  });
  return node;
}

function noteField(item) {
  const input = el('input', {
    class: 'note-input',
    type: 'text',
    value: item.note || '',
    placeholder: '备注',
    maxlength: '500',
    spellcheck: 'false',
    'aria-label': '备注',
  });
  const commit = async () => {
    const value = input.value.trim();
    if (value === (item.note || '')) return;
    const { ok, data } = await api(`/api/items/${item.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ note: value }),
    });
    if (ok && data.item) patchItem(data.item);
    else toast('备注保存失败');
  };
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') input.blur();
    if (event.key === 'Escape') {
      input.value = item.note || '';
      input.blur();
    }
  });
  return el('div', { class: 'note-row' }, input);
}

function fileRow(item, index) {
  const file = item.files[index] || {};
  const chip = el('span', { class: 'file-chip' }, extOf(file.name).slice(0, 4));

  // A file we could not read is still pasteable: it is represented by its
  // original path, so there is nothing to download and we say so once.
  if (file.missing) {
    return el('div', { class: 'file missing', title: '原始文件在受保护的位置；复制这条记录仍会把该文件放回剪贴板' },
      chip,
      el('span', { class: 'file-name' }, file.name || ''),
      el('span', { class: 'file-size' }, `${bytes(file.size)} · 未读取`));
  }

  return el('a', {
    class: 'file',
    href: `/api/items/${item.id}/file/${index}?download=1`,
    title: file.name || '',
  },
  chip,
  el('span', { class: 'file-name' }, file.name || ''),
  el('span', { class: 'file-size' }, bytes(file.size)),
  icon('download'));
}

function missingNotice(item) {
  if (!item.files.some((file) => file.missing)) return null;
  return el('div', { class: 'notice' },
    el('span', { class: 'notice-text' }, '原始文件未读取'),
    el('button', {
      class: 'notice-link',
      type: 'button',
      onclick: async (event) => {
        event.currentTarget.disabled = true;
        const { data } = await api(`/api/items/${item.id}/import`, { method: 'POST' });
        event.currentTarget.disabled = false;
        if (data.item) patchItem(data.item);
        toast(data.item && !data.item.missing ? '已读取原始文件' : '仍然无法读取，请先授权');
      },
    }, '重试'),
    el('button', { class: 'notice-link', type: 'button', onclick: openPermissionSettings }, '授权'));
}

function patchItem(item) {
  const index = S.items.findIndex((entry) => entry.id === item.id);
  if (index < 0) return;
  S.items[index] = item;
  renderList();
  // Never rebuild the detail under someone's cursor while they type a note.
  if (S.selectedId === item.id && !document.activeElement?.classList.contains('note-input')) {
    renderDetail();
  }
}

function fileList(item) {
  const notice = missingNotice(item);
  if (notice) {
    const wrap = el('div', {}, notice);
    const files = el('div', { class: 'files' });
    item.files.forEach((_, index) => files.append(fileRow(item, index)));
    wrap.append(files);
    return wrap;
  }
  const files = el('div', { class: 'files' });
  item.files.forEach((_, index) => files.append(fileRow(item, index)));
  return files;
}

function countByType(items) {
  const counts = new Map();
  for (const item of items) counts.set(item.type, (counts.get(item.type) || 0) + 1);
  return [...counts].map(([type, n]) => `${n} ${TYPE_LABEL[type] || type}`).join(' · ');
}

/** The three actions a multi-selection always offers, in both layouts. */
function bulkActionButtons(items, compact) {
  const cls = compact ? 'bulkbar-btn' : 'bulk-btn';
  return [
    el('button', { class: cls, type: 'button', onclick: () => copySelection() }, '复制'),
    el('button', {
      class: cls,
      type: 'button',
      onclick: (event) => { event.stopPropagation(); openSendMenu(event.currentTarget, items); },
    }, '发送'),
    el('button', {
      class: `${cls} danger`,
      type: 'button',
      onclick: () => deleteItems(items.map((item) => item.id)),
    }, '删除'),
  ];
}

function bulkPanel() {
  const items = selectedItems();
  return el('div', { class: 'bulk' },
    el('div', { class: 'bulk-count' }, `${items.length} 项`),
    el('div', { class: 'bulk-sub' }, countByType(items)),
    el('div', { class: 'bulk-actions' },
      ...bulkActionButtons(items, false),
      el('span', { class: 'bulk-sep' }),
      el('button', { class: 'bulk-link', type: 'button', onclick: () => selectAllVisible() }, '全选'),
      el('button', { class: 'bulk-link', type: 'button', onclick: () => clearSelection() }, '取消'),
    ),
  );
}

/** When the preview is collapsed there is nowhere to show the bulk panel,
 *  so the same actions float above the list instead. */
function renderBulkBar() {
  const bar = $('#bulkbar');
  if (!bar) return;
  const items = selectedItems();
  const show = S.collapsed && items.length > 1;
  bar.hidden = !show;
  bar.replaceChildren();
  if (!show) return;
  bar.append(
    el('span', { class: 'bulkbar-count' }, `${items.length} 项`),
    el('span', { class: 'bulkbar-sep' }),
    ...bulkActionButtons(items, true),
    el('button', { class: 'bulkbar-close', type: 'button', 'aria-label': '取消选择', onclick: () => clearSelection() }, icon('close')),
  );
}

function setCollapsed(collapsed) {
  S.collapsed = collapsed;
  try { localStorage.setItem('paste.collapsed', collapsed ? '1' : '0'); } catch { /* private mode */ }
  $('#split').classList.toggle('collapsed', collapsed);
  const button = $('#collapseBtn');
  button.setAttribute('aria-pressed', String(collapsed));
  button.title = collapsed ? '展开预览  ⌘\\' : '收起预览  ⌘\\';
  button.setAttribute('aria-label', collapsed ? '展开预览' : '收起预览');
  renderList();
  renderDetail();
  renderBulkBar();
}

function renderDetail() {
  const detail = $('#detail');
  detail.replaceChildren();
  detail.classList.remove('scrolled');

  if (S.selection.size > 1) {
    detail.append(bulkPanel());
    return;
  }

  const item = S.items.find((entry) => entry.id === S.selectedId);
  if (!item) {
    detail.append(el('div', { class: 'nothing' }, ''));
    $('#split').classList.remove('detail-open');
    return;
  }

  const head = el('div', { class: 'detail-head' },
    el('button', { class: 'act back', type: 'button', 'aria-label': '返回', onclick: () => $('#split').classList.remove('detail-open') }, icon('back')),
    metaLine(item),
    el('div', { class: 'actions' },
      el('button', { class: 'act', type: 'button', 'aria-label': '复制', title: '复制  ⏎', onclick: () => copyItem(item) }, icon('copy')),
      el('button', {
        class: 'act',
        type: 'button',
        'aria-label': '发送',
        title: '发送到设备',
        // The document listens for clicks to dismiss popovers; opening one from
        // here must not be undone by that same click.
        onclick: (event) => { event.stopPropagation(); openSendMenu(event.currentTarget, [item]); },
      }, icon('send')),
      el('button', { class: 'act danger', type: 'button', 'aria-label': '删除', title: '删除  ⌘⌫', onclick: () => deleteItems([item.id]) }, icon('trash')),
    ),
  );

  const body = el('div', { class: 'detail-body' });
  body.append(noteField(item));

  if (item.type === 'text') {
    body.classList.add('text');
    const pre = el('pre', { class: 'text' });
    const cached = bodies.get(item.id);
    const initial = cached || item.preview;
    pre.textContent = initial;
    if (codeLike(initial)) pre.classList.add('mono');
    body.append(pre);

    if (!cached) {
      loadBody(item).then((text) => {
        if (!text || S.selectedId !== item.id) return;
        pre.textContent = text;
        if (codeLike(text)) pre.classList.add('mono');
      });
    }
  } else if (item.type === 'image' && item.files[0] && item.files[0].missing) {
    body.append(fileList(item));
  } else if (item.type === 'image') {
    const file = item.files[0] || {};
    const img = el('img', {
      src: `/api/items/${item.id}/file/0`,
      alt: file.name || '',
    });
    const frame = el('button', { class: 'image-frame', type: 'button', 'aria-label': '查看大图', onclick: () => openLightbox(img.src) }, img);
    // A blob the browser cannot decode must not leave a blank frame behind.
    img.addEventListener('error', () => {
      if (S.selectedId !== item.id) return;
      body.replaceChildren(fileList(item));
    });
    body.append(frame);
    const caption = [file.w && file.h ? `${file.w} × ${file.h}` : null, bytes(file.size), item.files.length > 1 ? `${item.files.length} 张` : null]
      .filter(Boolean).join('  ·  ');
    body.append(el('div', { class: 'caption' }, caption));
    if (item.files.length > 1) {
      const rest = el('div', { class: 'files' });
      rest.style.marginTop = '18px';
      item.files.forEach((_, index) => rest.append(fileRow(item, index)));
      body.append(rest);
    }
  } else if (item.type === 'video' && item.files[0] && item.files[0].missing) {
    body.append(fileList(item));
  } else if (item.type === 'video') {
    const posterUrl = item.poster ? `/api/items/${item.id}/poster` : null;
    const player = el('video', {
      src: `/api/items/${item.id}/file/0`,
      poster: posterUrl,
      controls: true,
      preload: 'metadata',
    });
    // QuickTime/.mov and other codecs the browser cannot decode fall back to the
    // stored still frame plus a button that opens the system player.
    player.addEventListener('error', () => {
      if (S.selectedId !== item.id) return;
      body.replaceChildren(videoFallback(item, posterUrl));
    });
    body.append(player);
    if (posterUrl) {
      body.append(el('div', { class: 'caption' },
        el('button', { class: 'link-btn', type: 'button', onclick: () => openInPlayer(item) }, '用默认播放器打开')));
    }
    if (item.files.length > 1) {
      const rest = fileList(item);
      rest.style.marginTop = '18px';
      body.append(rest);
    }
  } else {
    const only = item.files.length === 1 ? item.files[0] : null;
    if (only && only.mime.startsWith('audio/')) {
      body.append(el('audio', { src: `/api/items/${item.id}/file/0`, controls: true, preload: 'metadata' }));
      body.append(el('div', { class: 'caption' }, bytes(only.size)));
    } else {
      body.append(fileList(item));
    }
  }

  detail.append(head, body);
}

async function loadBody(item) {
  try {
    const res = await fetch(`/api/items/${item.id}/body`);
    const text = res.ok ? await res.text() : '';
    bodies.set(item.id, text);
    return text;
  } catch {
    return '';
  }
}

function openInPlayer(item) {
  api(`/api/items/${item.id}/open`, { method: 'POST' })
    .then(({ data }) => { if (!data.ok) toast(data.error || '无法打开'); });
}

/** A codec the browser cannot decode still gets a still frame and a way out. */
function videoFallback(item, posterUrl) {
  const wrap = el('div', {});
  if (posterUrl) {
    wrap.append(el('button', {
      class: 'image-frame',
      type: 'button',
      'aria-label': '用默认播放器打开',
      onclick: () => openInPlayer(item),
    }, el('img', { src: posterUrl, alt: '' })));
  }
  wrap.append(el('div', { class: 'video-actions' },
    el('button', { class: 'bulk-btn', type: 'button', onclick: () => openInPlayer(item) }, '用默认播放器打开')));
  wrap.append(fileList(item));
  return wrap;
}

function openLightbox(src) {
  const box = $('#lightbox');
  $('#lightboxImg').src = src;
  box.hidden = false;
}

function closeLightbox() {
  const box = $('#lightbox');
  box.hidden = true;
  $('#lightboxImg').removeAttribute('src');
}

// ---------------------------------------------------------------- actions

async function copyItem(item) {
  const { data } = await api(`/api/items/${item.id}/copy`, { method: 'POST' });
  if (data.ok) toast(data.skipped ? `已复制（${data.skipped} 个文件不可读）` : '已复制');
  else if (data.reason === 'unreadable') toast(data.error, { action: '授权', duration: 9000, onAction: openPermissionSettings });
  else toast(data.error || '复制失败');
}

async function copySelection() {
  const items = selectedItems();
  if (!items.length) return;
  if (items.length === 1) {
    await copyItem(items[0]);
    return;
  }
  const { data } = await api('/api/items/bulk-copy', {
    method: 'POST',
    body: JSON.stringify({ ids: items.map((item) => item.id) }),
  });
  if (data.ok && !data.error) {
    const skipped = data.skipped ? `（${data.skipped} 个不可读）` : '';
    toast(data.mode === 'files' ? `已复制 ${data.count} 个文件${skipped}` : `已复制 ${data.count} 条文本`);
  } else if (data.reason === 'unreadable') {
    toast(data.error, { action: '授权', duration: 9000, onAction: openPermissionSettings });
  } else {
    toast(data.error || '复制失败');
  }
}

async function deleteItems(ids) {
  if (!ids.length) return;
  const { ok, data } = await api('/api/items/bulk-delete', {
    method: 'POST',
    body: JSON.stringify({ ids }),
  });
  const removed = (ok && data.ids) || [];
  if (!ok) {
    toast('删除失败');
    return;
  }
  if (!removed.length) return;

  const removedSet = new Set(removed);
  const firstIndex = S.items.findIndex((entry) => removedSet.has(entry.id));
  S.items = S.items.filter((entry) => !removedSet.has(entry.id));
  S.total = Math.max(0, S.total - removed.length);
  for (const id of removed) bodies.delete(id);

  const remaining = [...S.selection].filter((id) => !removedSet.has(id));
  const next = remaining.length
    ? remaining
    : (S.items[Math.min(Math.max(firstIndex, 0), S.items.length - 1)] || []).id
      ? [S.items[Math.min(Math.max(firstIndex, 0), S.items.length - 1)].id]
      : [];
  setSelection(next);
  renderList();

  toast(removed.length > 1 ? `已删除 ${removed.length} 项` : '已删除', {
    action: '撤销',
    duration: 12000,
    onAction: async () => {
      await api('/api/items/bulk-restore', { method: 'POST', body: JSON.stringify({ ids: removed }) });
      await load();
      setSelection(removed);
      toast('已恢复');
    },
  });
}

function deleteSelected() {
  deleteItems([...S.selection]);
}

async function sendItems(items, peer) {
  if (!items || !items.length) return;
  toast(items.length > 1 ? `正在发送 ${items.length} 项到 ${peer.name}` : `正在发送到 ${peer.name}`);
  const { data } = await api(`/api/peers/${peer.id}/send`, {
    method: 'POST',
    body: JSON.stringify({ itemIds: items.map((item) => item.id) }),
  });
  if (data.ok) {
    toast(items.length > 1 ? `已发送 ${data.sent} 项到 ${peer.name}` : `已发送到 ${peer.name}`);
  } else {
    const first = data.failed && data.failed[0];
    toast((first && first.error) || data.error || '发送失败');
  }
}

// ---------------------------------------------------------------- popovers

function closePopover() {
  const pop = $('#popover');
  pop.hidden = true;
  pop.replaceChildren();
  pop.style.left = '';
  pop.style.right = '';
  pop.style.top = '';
  pairingFor = null;
  manualOpen = false;
  $('#devicesBtn').setAttribute('aria-expanded', 'false');
}

function openPopover(content, anchor) {
  const pop = $('#popover');
  pop.replaceChildren(content);
  pop.hidden = false;
  if (anchor) {
    const rect = anchor.getBoundingClientRect();
    pop.style.right = 'auto';
    pop.style.left = `${Math.max(12, Math.min(window.innerWidth - 328, rect.right - 316))}px`;
    pop.style.top = `${rect.bottom + 6}px`;
  } else {
    pop.style.left = '';
    pop.style.right = '12px';
    pop.style.top = `calc(var(--bar) + 6px)`;
  }
}

function openSendMenu(anchor, items) {
  const peers = S.peers.filter((peer) => peer.trusted);
  const content = el('div', {},
    el('div', { class: 'pop-head' }, '发送到'),
    peers.length
      ? peers.map((peer) => {
        const row = el('button', {
          class: 'peer',
          type: 'button',
          onclick: () => { closePopover(); sendItems(items, peer); },
        },
        el('span', { class: `status ${peer.online ? 'on' : ''}` }),
        el('span', { class: 'peer-name' }, peer.name));
        return row;
      })
      : el('button', {
        class: 'peer',
        type: 'button',
        onclick: () => { closePopover(); $('#devicesBtn').click(); },
      }, el('span', { class: 'status' }), el('span', { class: 'peer-name' }, '尚未配对设备')),
  );
  openPopover(content, anchor);
}

function renderDevices() {
  const content = el('div', {});

  content.append(el('div', { class: 'pop-head' },
    '设备',
    el('button', {
      class: 'icon-btn',
      type: 'button',
      'aria-label': '添加设备',
      onclick: () => { manualOpen = !manualOpen; renderDevices(); },
    }, icon('plus')),
  ));

  if (!S.peers.length) {
    content.append(el('div', { class: 'self-name' }, '局域网内暂无设备'));
  }

  for (const peer of S.peers) {
    const row = el('div', { class: 'peer' },
      el('span', { class: `status ${peer.online ? 'on' : ''}` }),
      el('span', { class: 'peer-name' }, peer.name));

    if (peer.trusted) {
      const unlink = el('button', {
        class: 'ghost',
        type: 'button',
        onclick: async () => {
          await api(`/api/peers/${peer.id}`, { method: 'DELETE' });
          toast(`已解除 ${peer.name}`);
          closePopover();
        },
      }, '解除');
      unlink.style.opacity = '0';
      row.addEventListener('mouseenter', () => { unlink.style.opacity = '1'; });
      row.addEventListener('mouseleave', () => { unlink.style.opacity = '0'; });
      row.append(unlink);
    } else if (pairingFor === peer.id) {
      const input = el('input', {
        type: 'text',
        placeholder: '配对码',
        maxlength: '11',
        autocomplete: 'off',
        spellcheck: 'false',
      });
      input.addEventListener('keydown', async (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        await pairWith({ host: peer.host, port: peer.port, code: input.value });
      });
      row.append(input);
      queueMicrotask(() => input.focus());
    } else {
      row.append(el('button', {
        class: 'ghost',
        type: 'button',
        onclick: () => { pairingFor = peer.id; renderDevices(); },
      }, '配对'));
    }

    content.append(row);
  }

  if (manualOpen) {
    const host = el('input', {
      class: 'wide',
      type: 'text',
      placeholder: '地址 192.168.1.5:47810',
      autocomplete: 'off',
      spellcheck: 'false',
    });
    const code = el('input', { type: 'text', placeholder: '配对码', maxlength: '11', autocomplete: 'off', spellcheck: 'false' });
    const submit = async () => {
      const value = host.value.trim();
      if (!value) return host.focus();
      const [address, port] = value.replace(/^https?:\/\//, '').split(':');
      await pairWith({ host: address, port: Number(port) || DEFAULT_PORT, code: code.value });
    };
    code.addEventListener('keydown', (event) => { if (event.key === 'Enter') submit(); });
    host.addEventListener('keydown', (event) => { if (event.key === 'Enter') code.focus(); });
    content.append(el('div', { class: 'peer stacked' }, host));
    content.append(el('div', { class: 'peer stacked' }, code,
      el('button', { class: 'ghost', type: 'button', onclick: submit }, '连接')));
    queueMicrotask(() => host.focus());
  }

  content.append(el('div', { class: 'pop-sep' }));

  const code = el('div', { class: 'code-row' },
    el('span', { class: 'label' }, '配对码'),
    el('span', { class: 'code' }, S.device.code));
  code.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(S.device.code);
      toast('配对码已复制');
    } catch {
      toast(S.device.code);
    }
  });
  content.append(code);

  const name = el('input', { type: 'text', value: S.device.name || '', spellcheck: 'false' });
  name.addEventListener('keydown', async (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    name.blur();
  });
  name.addEventListener('blur', async () => {
    const value = name.value.trim();
    if (!value || value === S.device.name) return;
    const { ok, data } = await api('/api/device', {
      method: 'PATCH',
      body: JSON.stringify({ name: value }),
    });
    if (ok) {
      S.device = data.device;
      toast('已重命名');
    }
  });
  content.append(el('div', { class: 'self-name' }, name));

  openPopover(content, null);
}

async function pairWith({ host, port, code }) {
  toast('正在配对');
  const { ok, data } = await api('/api/peers/pair', {
    method: 'POST',
    body: JSON.stringify({ host, port, code }),
  });
  if (!ok) {
    toast(data.error || '配对失败');
    return;
  }
  S.peers = data.peers;
  pairingFor = null;
  manualOpen = false;
  closePopover();
  toast(`已配对 ${data.peer.name}`);
}

// ---------------------------------------------------------------- data flow

async function load() {
  const seq = ++S.seq;
  const params = new URLSearchParams({ type: S.type, q: S.q, limit: '200' });
  try {
    const { ok, data } = await api(`/api/items?${params}`);
    if (seq !== S.seq) return;
    // A failed refresh must not blank the list the user is looking at.
    if (!ok || !Array.isArray(data.items)) {
      toast('无法连接');
      return;
    }
    S.items = data.items || [];
    S.total = data.total || 0;
    S.hasMore = !!data.hasMore;

    // Keep whatever is still visible selected; otherwise fall back to the first row.
    const visible = new Set(S.items.map((item) => item.id));
    const kept = [...S.selection].filter((id) => visible.has(id));
    if (kept.length) {
      S.selection = new Set(kept);
      if (!S.selection.has(S.anchorId)) S.anchorId = kept[0];
    } else {
      S.selection = new Set(S.items.length ? [S.items[0].id] : []);
      S.anchorId = S.items.length ? S.items[0].id : null;
    }
    renderList();
    renderDetail();
    renderBulkBar();
  } catch {
    toast('无法连接');
  }
}

async function loadMore() {
  const params = new URLSearchParams({ type: S.type, q: S.q, limit: '200', offset: String(S.items.length) });
  try {
    const { ok, data } = await api(`/api/items?${params}`);
    if (!ok || !Array.isArray(data.items)) return;
    S.items = S.items.concat(data.items);
    S.hasMore = !!data.hasMore;
    renderList();
  } catch {
    toast('无法载入');
  }
}

function setType(id) {
  if (S.type === id) return;
  S.type = id;
  renderFilters();
  load();
}

let searchTimer = null;
$('#q').addEventListener('input', (event) => {
  S.q = event.target.value.trim();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(load, 110);
});

$('#q').addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.target.value = '';
    S.q = '';
    load();
    event.target.blur();
  }
  if (event.key === 'Enter' || event.key === 'ArrowDown') {
    event.preventDefault();
    event.target.blur();
    select(S.items.length ? S.items[0].id : null);
    moveSelection(0);
  }
});

// ---------------------------------------------------------------- SSE

function connect() {
  const source = new EventSource('/events');

  source.addEventListener('item', (event) => {
    const item = JSON.parse(event.data);
    const matches = (S.type === 'all' || item.type === S.type) && !S.q;
    if (item.source === 'lan' && item.origin) toast(`收到来自 ${item.origin.deviceName} 的记录`);
    if (item.missing && !explainedProtectedFile) {
      explainedProtectedFile = true;
      toast('受保护的文件：已记录名称与位置', {
        action: '授权',
        duration: 9000,
        onAction: openPermissionSettings,
      });
    }
    if (!matches) {
      if (S.q) load();
      return;
    }
    S.items = [item, ...S.items.filter((entry) => entry.id !== item.id)];
    S.total += 1;
    const wasEmpty = S.items.length === 1;
    renderList();
    if (wasEmpty || !S.selection.size) select(item.id);
  });

  source.addEventListener('update', (event) => {
    patchItem(JSON.parse(event.data));
  });

  source.addEventListener('removed', (event) => {
    const { id } = JSON.parse(event.data);
    S.items = S.items.filter((item) => item.id !== id);
    S.total = Math.max(0, S.total - 1);
    if (S.selection.has(id)) {
      const next = new Set(S.selection);
      next.delete(id);
      setSelection([...next]);
    }
    renderList();
  });

  source.addEventListener('peers', (event) => {
    S.peers = JSON.parse(event.data);
    updatePeerDot();
    if (!$('#popover').hidden) renderDevices();
  });

  source.addEventListener('device', (event) => {
    S.device = JSON.parse(event.data);
  });

  source.addEventListener('reset', () => load());

  source.addEventListener('transfer', (event) => {
    const data = JSON.parse(event.data);
    if (data.phase === 'error') toast(data.error || '发送失败');
  });

  source.addEventListener('error', () => {
    // EventSource retries on its own; nothing to do.
  });
}

function updatePeerDot() {
  const dot = $('#peerDot');
  const untrusted = S.peers.some((peer) => !peer.trusted);
  dot.hidden = !untrusted;
}

// ---------------------------------------------------------------- interactions

$('#devicesBtn').addEventListener('click', (event) => {
  event.stopPropagation();
  if (!$('#popover').hidden) {
    closePopover();
    return;
  }
  $('#devicesBtn').setAttribute('aria-expanded', 'true');
  renderDevices();
});

$('#popover').addEventListener('click', (event) => event.stopPropagation());

document.addEventListener('click', () => {
  if (!$('#popover').hidden) closePopover();
});

$('#lightbox').addEventListener('click', closeLightbox);

$('#collapseBtn').addEventListener('click', (event) => {
  event.stopPropagation();
  setCollapsed(!S.collapsed);
});

document.addEventListener('keydown', (event) => {
  const meta = event.metaKey || event.ctrlKey;

  if (meta && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    const input = $('#q');
    input.focus();
    input.select();
    return;
  }

  if (meta && /^[1-5]$/.test(event.key)) {
    event.preventDefault();
    setType(TYPES[Number(event.key) - 1].id);
    return;
  }

  if (meta && event.key === '\\') {
    event.preventDefault();
    setCollapsed(!S.collapsed);
    return;
  }

  if (meta && event.key.toLowerCase() === 'a' && event.target !== $('#q')) {
    event.preventDefault();
    selectAllVisible();
    return;
  }

  if (event.key === 'Escape') {
    if (!$('#lightbox').hidden) return closeLightbox();
    if (!$('#popover').hidden) return closePopover();
    if (S.selection.size > 1) return clearSelection();
    if ($('#split').classList.contains('detail-open')) $('#split').classList.remove('detail-open');
    return;
  }

  if (event.target === $('#q')) return;

  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    moveSelection(event.key === 'ArrowDown' ? 1 : -1, event.shiftKey);
    return;
  }

  if (event.key === 'Enter' && S.selection.size) {
    event.preventDefault();
    copySelection();
    return;
  }

  if (meta && event.key === 'Backspace') {
    event.preventDefault();
    deleteSelected();
    return;
  }

  if (event.key === 'j') moveSelection(1);
  if (event.key === 'k') moveSelection(-1);
});

// scroll shadow on the detail pane
$('#detail').addEventListener('scroll', (event) => {
  event.currentTarget.classList.toggle('scrolled', event.currentTarget.scrollTop > 4);
});

// ---------------------------------------------------------------- drag & drop

let dragDepth = 0;

function hasFiles(event) {
  return Array.from(event.dataTransfer?.types || []).includes('Files');
}

window.addEventListener('dragenter', (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth += 1;
  $('#dropzone').hidden = false;
});

window.addEventListener('dragover', (event) => {
  if (hasFiles(event)) event.preventDefault();
});

window.addEventListener('dragleave', (event) => {
  if (!hasFiles(event)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) $('#dropzone').hidden = true;
});

window.addEventListener('drop', async (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth = 0;
  $('#dropzone').hidden = true;
  const files = Array.from(event.dataTransfer.files || []);
  if (!files.length) return;

  toast(`正在记录 ${files.length} 个文件`);
  try {
    const created = (await api('/api/bundles', {
      method: 'POST',
      body: JSON.stringify({ count: files.length }),
    })).data;

    for (let i = 0; i < files.length; i++) {
      const res = await fetch(`/api/bundles/${created.bundle}/blob?slot=${i}&name=${encodeURIComponent(files[i].name)}`, {
        method: 'PUT',
        body: files[i],
        headers: { 'content-type': 'application/octet-stream' },
      });
      if (!res.ok) throw new Error('upload failed');
    }

    const done = (await api(`/api/bundles/${created.bundle}/commit`, { method: 'POST', body: '{}' })).data;
    toast(done.duplicate ? '此内容已记录' : '已记录');
  } catch {
    toast('记录失败');
  }
});

// ---------------------------------------------------------------- boot

renderFilters();
setCollapsed(localStorage.getItem('paste.collapsed') === '1');
updatePeerDot();
connect();

// Refresh peers quietly; the first paint already came from the server.
api('/api/state').then(({ data }) => {
  if (Array.isArray(data.peers)) S.peers = data.peers;
  updatePeerDot();
});
