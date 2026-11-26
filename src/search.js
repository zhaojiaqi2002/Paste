// Search over in-memory metadata. No index files, no dependencies.
// Substring matching (CJK has no word boundaries) with a small relevance model.

const MAX_TERMS = 8;
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

function haystack(entry) {
  if (entry._hay) return entry._hay;
  const parts = [entry.preview || ''];
  for (const f of entry.files || []) parts.push(f.name);
  parts.push(entry.day, typeLabel(entry.type));
  entry._hay = parts.join('\n').toLowerCase();
  return entry._hay;
}

function typeLabel(type) {
  return { text: '文本 text', image: '图片 image', files: '文件 files', video: '视频 video' }[type] || '';
}

function splitTerms(query) {
  const raw = String(query || '').trim().toLowerCase();
  if (!raw) return [];
  // Split on whitespace; keep CJK runs intact so "会议纪要" stays one term.
  const terms = raw.split(/\s+/).filter(Boolean);
  if (terms.length === 1 && CJK.test(terms[0])) return terms;
  return terms.slice(0, MAX_TERMS);
}

/**
 * Every term must match (AND). Score rewards phrase hits, word-start hits and
 * recent items; ties fall back to newest first.
 */
export function search(entries, query, hayOf = haystack) {
  const terms = splitTerms(query);
  if (!terms.length) return entries;

  const phrase = terms.join(' ');
  const scored = [];
  for (const entry of entries) {
    const hay = hayOf(entry);
    let total = 0;
    let ok = true;
    for (const term of terms) {
      const at = hay.indexOf(term);
      if (at < 0) { ok = false; break; }
      total += 1;
      if (at === 0) total += 3;
      else if (/[\s/._\-(（【]/.test(hay[at - 1])) total += 2;
      if (term.length > 3) total += 1;
    }
    if (!ok) continue;
    if (terms.length > 1 && hay.includes(phrase)) total += 3;
    scored.push({ entry, score: total });
  }

  scored.sort((a, b) => b.score - a.score || b.entry.createdAt - a.entry.createdAt);
  return scored.map((s) => s.entry);
}

/** Index ranges for highlighting the first occurrence of each term. */
export function ranges(text, query) {
  const out = [];
  const hay = String(text || '').toLowerCase();
  for (const term of splitTerms(query)) {
    let from = 0;
    for (let i = 0; i < 20; i++) {
      const at = hay.indexOf(term, from);
      if (at < 0) break;
      out.push([at, at + term.length]);
      from = at + term.length;
    }
  }
  out.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const range of out) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  return merged;
}

/**
 * A short excerpt around the first match, so a result always shows why it
 * matched — even when the hit is thousands of characters into the text.
 */
export function snippetOf(text, query, radius = 78) {
  const terms = splitTerms(query);
  if (!terms.length || !text) return null;
  const lower = text.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const found = lower.indexOf(term);
    if (found >= 0 && (at < 0 || found < at)) at = found;
  }
  if (at < 0) return null;
  const start = Math.max(0, at - radius);
  const end = Math.min(text.length, at + radius * 2);
  let out = text.slice(start, end).replace(/\s+/g, ' ').trim();
  if (start > 0) out = '…' + out;
  if (end < text.length) out += '…';
  return out;
}
