// Pure logic shared by the Worker (tested in test.js, no Cloudflare needed).

export const ONE_DOLLAR = '$1 items';
export const TOP_TIER = 100;             // top 100 sellers are checked more often
// Check kinds: 1 = in someone's top 100 (about every 5 min), 2 = other sellers (about every 45 min),
// 3 = had no bazaar last time (once a day, in case they open one), 0 = account not found (never).
export const TARGET = { 1: 300, 2: 2700, 3: 86400 };
export const kindOf = (missing, hasBazaar, top) => (missing ? 0 : hasBazaar === 0 ? 3 : top ? 1 : 2);
export const MAX_TORN_PER_RUN = 36;
export const PARALLEL = 10;
export const MAX_NAMES_PER_RUN = 12;

const itemsOf = r => (typeof r.items === 'string' ? JSON.parse(r.items) : r.items || r.it || []);

// Price per item: cost_each, or cost_total split by quantity.
export function eachPrice(r) {
  const qty = itemsOf(r).reduce((s, i) => s + Number(i[1]), 0);
  if (r.ce != null) return Number(r.ce);
  if (r.ct != null && qty) return Number(r.ct) / qty;
  return null;
}

// rows: purchases {seller|s, items|it: [[itemId, qty]], ce, ct, ts}; itemTypes: id -> [name, type]
// Per seller: tot = [purchases, items, spent], t = { type: [purchases, items, spent] }, last = newest purchase time.
// "$1 items" is a pseudo type for purchases at $1 or less per item; it never changes the overall totals.
export function aggregate(rows, itemTypes) {
  const by = new Map(), typeTotals = {};
  for (const r of rows) {
    const id = Number(r.seller != null ? r.seller : r.s);
    const items = itemsOf(r), each = eachPrice(r);
    let s = by.get(id);
    if (!s) by.set(id, s = { id, last: 0, tot: [0, 0, 0], t: {} });
    const ts = Number(r.ts) || 0;
    if (ts > s.last) s.last = ts;
    s.tot[0]++;
    const seen = new Set();
    let qtyAll = 0, spentAll = 0;
    for (const [itemId, qtyRaw] of items) {
      const qty = Number(qtyRaw), spent = each == null ? 0 : each * qty;
      const type = (itemTypes && itemTypes[itemId] && itemTypes[itemId][1]) || 'Unknown';
      const t = s.t[type] || (s.t[type] = [0, 0, 0]);
      if (!seen.has(type)) { t[0]++; seen.add(type); }
      t[1] += qty; t[2] += spent;
      typeTotals[type] = (typeTotals[type] || 0) + qty;
      qtyAll += qty; spentAll += spent;
    }
    s.tot[1] += qtyAll; s.tot[2] += spentAll;
    if (each != null && each <= 1) {
      const t = s.t[ONE_DOLLAR] || (s.t[ONE_DOLLAR] = [0, 0, 0]);
      t[0]++; t[1] += qtyAll; t[2] += spentAll;
      typeTotals[ONE_DOLLAR] = (typeTotals[ONE_DOLLAR] || 0) + qtyAll;
    }
  }
  const sellers = [...by.values()].sort(byRank(s => s.tot));
  for (const s of sellers) { s.tot[2] = Math.round(s.tot[2]); for (const k in s.t) s.t[k][2] = Math.round(s.t[k][2]); }
  return { sellers, typeTotals };
}
// Rank: purchases, then items, then lower id (stable).
export const byRank = get => (a, b) => get(b)[0] - get(a)[0] || get(b)[1] - get(a)[1] || a.id - b.id;

// Torn's /user/{id}/bazaar reply -> { is_open, has_bazaar } or null when the shape is unknown.
export function parseBazaar(j) {
  if (!j || typeof j !== 'object') return null;
  const pick = (o, ks) => { for (const k of ks) if (o && o[k] !== undefined && o[k] !== null) return o[k]; return undefined; };
  let open = pick(j, ['bazaar_is_open', 'is_open']), exists = pick(j, ['bazaar_exists', 'exists']);
  if (open === undefined && j.bazaar && typeof j.bazaar === 'object' && !Array.isArray(j.bazaar)) {
    open = pick(j.bazaar, ['bazaar_is_open', 'is_open']); exists = pick(j.bazaar, ['bazaar_exists', 'exists']);
  }
  if (open === undefined) return null;
  return { is_open: open ? 1 : 0, has_bazaar: exists === undefined ? (open ? 1 : 0) : (exists ? 1 : 0) };
}
export function parseName(j) {
  const p = (j && (j.profile || j)) || {};
  return typeof p.name === 'string' && p.name ? p.name : null;
}

// candidates: [{id, t, tier}] -> the most overdue ids (age / target interval >= 1), most overdue first.
export function pickDue(candidates, now, max) {
  return candidates
    .map(c => ({ id: c.id, score: (now - (c.t || 0)) / (TARGET[c.tier] || TARGET[2]) }))
    .filter(c => c.score >= 1)
    .sort((a, b) => b.score - a.score || a.id - b.id)
    .slice(0, max)
    .map(c => c.id);
}

// Check now: only digit ids, at most 30, no repeats.
export function validIds(ids, max = 30) {
  if (!Array.isArray(ids) || !ids.length || ids.length > max) return null;
  const out = [];
  for (const x of ids) {
    const s = String(x);
    if (!/^\d{1,10}$/.test(s) || Number(s) <= 0) return null;
    if (!out.includes(Number(s))) out.push(Number(s));
  }
  return out;
}

// Purchases sent by the userscript.
export function validBuy(b) {
  if (!b || typeof b !== 'object') return null;
  const id = String(b.id || ''), ts = Number(b.ts), s = Number(b.s);
  if (!id || id.length > 64 || !(ts > 0) || !(s > 0) || !Number.isInteger(s) || !Array.isArray(b.it) || !b.it.length || b.it.length > 50) return null;
  const it = [];
  for (const p of b.it) {
    if (!Array.isArray(p) || !(Number(p[0]) > 0) || !(Number(p[1]) > 0)) return null;
    it.push([Math.trunc(Number(p[0])), Number(p[1])]);
  }
  const num = v => (v == null || v === '' || !isFinite(Number(v)) ? null : Number(v));
  return { id, ts: Math.trunc(ts), s, it, ce: num(b.ce), ct: num(b.ct) };
}

// Sign-in tokens: random, and only their SHA-256 is stored in the database.
export function newToken() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export async function sha256hex(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, '0')).join('');
}
export function bearer(header) {
  const m = /^Bearer\s+([A-Za-z0-9_-]{20,100})\s*$/.exec(header || '');
  return m ? m[1] : null;
}
// Torn API keys are 16 letters and digits.
export const looksLikeKey = k => /^[A-Za-z0-9]{16}$/.test(String(k || ''));
