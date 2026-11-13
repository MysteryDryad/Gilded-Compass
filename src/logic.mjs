// Pure logic used by the Worker (tested in test.js, no Cloudflare needed).
// Totals per seller are worked out in the browser (public/aggregate.js), and bazaar checks are done by the players'
// userscripts with their own keys (gilded-compass.user.js), so neither is here.

// Did a bazaar check (sent by a userscript) find something new? Only then is the seller's row written (database writes are the scarce thing).
export function statusChanged(old, is_open, has_bazaar, missing) {
  if (!old) return true;
  return old.is_open !== is_open || old.has_bazaar !== has_bazaar || (old.missing || 0) !== missing;
}

// Lists of player ids: only digits, at most `max`, no repeats.
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

// A bazaar check result sent by a userscript: [id, is_open, has_bazaar, missing] (0 or 1) -> clean copy or null.
export function validResult(r) {
  if (!Array.isArray(r) || !/^\d{1,10}$/.test(String(r[0])) || !(Number(r[0]) > 0)) return null;
  const b = v => (v === 0 || v === 1 || v === true || v === false ? Number(v) : null);
  const o = b(r[1]), h = b(r[2]), m = b(r[3] || 0);
  if (o === null || h === null || m === null) return null;
  return [Number(r[0]), o, h, m];
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
