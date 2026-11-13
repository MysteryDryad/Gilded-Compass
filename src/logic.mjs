// Pure logic used by the Worker (tested in test.js, no Cloudflare needed).
// Totals per seller are worked out in the browser (public/aggregate.js), not here.

export const TOP_TIER = 100;             // top 100 sellers are checked more often
// Check kinds: 1 = in someone's top 100, 2 = other sellers, 3 = had no bazaar last time (re-checked slowly, in case they
// open one), 0 = account not found (never). Each run checks a few of each kind in turn (PER_RUN in worker.js).
export const kindOf = (missing, hasBazaar, top) => (missing ? 0 : hasBazaar === 0 ? 3 : top ? 1 : 2);
export const MAX_TORN_PER_RUN = 36;
export const PARALLEL = 10;
export const MAX_NAMES_PER_RUN = 12;

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

// Round robin: the next rows after where the last run stopped (`after`), topped up from the start of the list
// (`fromStart`) when the end is reached. Each seller is checked in turn without storing a time per seller.
export function roundRobin(after, fromStart, n) {
  const out = after.slice(0, n), seen = new Set(out.map(r => r.id));
  for (const r of fromStart) { if (out.length >= n) break; if (!seen.has(r.id)) { out.push(r); seen.add(r.id); } }
  return out;
}
// Did a bazaar check find something new? Only then is the seller's row written (database writes are the scarce thing).
export function statusChanged(old, is_open, has_bazaar, missing) {
  if (!old) return true;
  return old.is_open !== is_open || old.has_bazaar !== has_bazaar || (old.missing || 0) !== missing;
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
