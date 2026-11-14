// Gilded Compass Worker (multi-user).
// - Anyone signs in with their own Torn API key: the key is used once to ask Torn who they are, then forgotten.
//   They get a random sign-in token; only its hash is stored.
// - Each user's bazaar purchases (sent by the userscript) are stored under their player id and only shown to them.
// - Bazaar Open/Closed flags and seller names are checked by each player's own 🧭 userscript with their own key
//   (public Torn info) and sent here; the site never calls Torn for them. The site only works with the userscript.
// - Free plan budget (per day, reset 00:00 UTC): 100,000 rows written, 5,000,000 rows read. Writes are the scarce part:
//   purchases are stored in bundles (one row per upload), each player's seller list is one row, a seller's status row is
//   only written when something about them changed, and every index costs an extra row per write.
import { statusChanged, validIds, validBuy, validResult, newToken, sha256hex, bearer, looksLikeKey } from './logic.mjs';

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS users (uid INTEGER PRIMARY KEY, name TEXT, created INTEGER NOT NULL, last_upload INTEGER NOT NULL DEFAULT 0)',
  'CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, uid INTEGER NOT NULL, created INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS sessions_uid ON sessions(uid)',
  // one row per upload: data = JSON [[ts, seller, [[item, qty]], cost_each, cost_total, log id], ...]
  'CREATE TABLE IF NOT EXISTS pbatches (seq INTEGER PRIMARY KEY, uid INTEGER NOT NULL, n INTEGER NOT NULL, data TEXT NOT NULL, tmax INTEGER NOT NULL DEFAULT 0)',
  'CREATE INDEX IF NOT EXISTS pbatches_uid ON pbatches(uid)',
  // one row per player: JSON list of the sellers they bought from
  'CREATE TABLE IF NOT EXISTS usets (uid INTEGER PRIMARY KEY, sellers TEXT NOT NULL)',
  // each player's top 100 sellers (worked out by their page); their userscript checks these more often
  'CREATE TABLE IF NOT EXISTS tops (uid INTEGER NOT NULL, seller INTEGER NOT NULL, PRIMARY KEY (uid, seller)) WITHOUT ROWID',
  'CREATE TABLE IF NOT EXISTS status (id INTEGER PRIMARY KEY, is_open INTEGER, has_bazaar INTEGER, missing INTEGER NOT NULL DEFAULT 0, t INTEGER NOT NULL DEFAULT 0, top INTEGER NOT NULL DEFAULT 0, kind INTEGER NOT NULL DEFAULT 2, name TEXT, name_t INTEGER NOT NULL DEFAULT 0, u INTEGER NOT NULL DEFAULT 0)',
  'CREATE INDEX IF NOT EXISTS status_u ON status(u)',
  'CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)',
  // sellers a player pinned or wrote a note for (only that a note exists; the text stays on their device): never dropped
  'CREATE TABLE IF NOT EXISTS keeps (uid INTEGER NOT NULL, seller INTEGER NOT NULL, pin INTEGER NOT NULL DEFAULT 0, note INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (uid, seller)) WITHOUT ROWID',
  "INSERT OR IGNORE INTO meta (k, v) VALUES ('schemaV', '7')"
];
const FATAL_CODES = new Set([1, 2, 10, 13, 16, 18]); // key missing, wrong, owner jailed, inactive, too low, paused
const SESSION_DAYS = 180;
const TOP_TIER = 100;
// One player per day (generous for a real first sync; stops one person draining the shared allowance).
// Workers Paid (since 2026-11-13) includes 50 million rows written a month; these caps keep one player's worst day near
// 150,000 written rows (a few cents), while a real first sync of a big history (26,000 purchases, 4,000 sellers) fits easily.
const DAY_CAP = { purchases: 300000, sellers: 40000, uploads: 2000, tops: 200, changes: 20000, items: 5, keeps: 3000 };
const KEEP_MAX = 1000; // pinned or noted sellers per player
// Everyone's list covers the last 60 days of bazaar purchases: older purchases are refused and deleted, and a seller not
// bought from in 60 days drops off (new sellers take their place). Keeps the database small.
const HISTORY_DAYS = 60;
const historyStart = () => now() - HISTORY_DAYS * 86400;
const now = () => Math.floor(Date.now() / 1000);
const HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: HEADERS });
// Free Workers get about 10 ms of CPU per request, so big replies are glued together as text (no parsing of purchases).
const rawJson = text => new Response(text, { headers: HEADERS });
const inner = arr => (arr && arr.length > 2 ? arr.slice(1, -1) : ''); // "[a,b]" -> "a,b"
const MY_SELLERS = '(SELECT value FROM json_each((SELECT sellers FROM usets WHERE uid = ?1)))'; // the signed-in player's sellers

async function withSchema(env, fn) {
  try { return await fn(); }
  catch (e) {
    if (!/no such table/i.test(String(e && e.message))) throw e;
    await env.DB.batch(SCHEMA.map(s => env.DB.prepare(s)));
    return fn();
  }
}
// Changes for databases made earlier. v2: fewer indexes (each one adds a written row to every write).
// v3: one `u` column (when anything about a seller last changed) with an index, so the status poll reads only changed rows.
// v4: purchases in bundles, seller lists as one row per player, top 100 in its own small table (old tables copied, then dropped).
// v5: bazaar checks moved to the players' userscripts; the old cron's indexes (each an extra written row per change) go.
// v6: 60 days of history for everyone: each bundle knows its newest purchase (tmax) so old ones can be dropped; no per-player range.
// v7: pinned sellers and sellers with a note (keeps) stay on the list for good.
const SCHEMA_VERSION = 7;
const MIGRATIONS = {
  2: ['CREATE INDEX IF NOT EXISTS status_kind ON status(kind)', 'DROP INDEX IF EXISTS status_kind_t', 'DROP INDEX IF EXISTS status_name'],
  3: ['ALTER TABLE status ADD COLUMN u INTEGER NOT NULL DEFAULT 0', 'UPDATE status SET u = MAX(t, name_t) WHERE u = 0 AND (t > 0 OR name_t > 0)',
      'CREATE INDEX IF NOT EXISTS status_u ON status(u)', 'DROP INDEX IF EXISTS status_t'],
  4: ['CREATE TABLE IF NOT EXISTS pbatches (seq INTEGER PRIMARY KEY, uid INTEGER NOT NULL, n INTEGER NOT NULL, data TEXT NOT NULL)',
      'CREATE INDEX IF NOT EXISTS pbatches_uid ON pbatches(uid)',
      'CREATE TABLE IF NOT EXISTS usets (uid INTEGER PRIMARY KEY, sellers TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS tops (uid INTEGER NOT NULL, seller INTEGER NOT NULL, PRIMARY KEY (uid, seller)) WITHOUT ROWID',
      'CREATE INDEX IF NOT EXISTS tops_seller ON tops(seller)',
      'INSERT INTO pbatches (uid, n, data) SELECT uid, COUNT(*), json_group_array(json_array(ts, seller, json(items), ce, ct, id)) FROM purchases GROUP BY uid, rowid / 1000',
      'INSERT OR IGNORE INTO usets (uid, sellers) SELECT uid, json_group_array(seller) FROM user_sellers GROUP BY uid',
      'INSERT OR IGNORE INTO tops (uid, seller) SELECT uid, seller FROM user_sellers WHERE top = 1',
      'DROP TABLE IF EXISTS purchases', 'DROP TABLE IF EXISTS user_sellers'],
  5: ['DROP INDEX IF EXISTS status_kind', 'DROP INDEX IF EXISTS tops_seller', "DELETE FROM meta WHERE k IN ('error', 'rr', 'itemsAt') OR k LIKE 'win:%' OR k LIKE 'cool:%' OR k LIKE 'retop:%'"],
  6: ['ALTER TABLE pbatches ADD COLUMN tmax INTEGER NOT NULL DEFAULT 0',
      "UPDATE pbatches SET tmax = (SELECT MAX(json_extract(value, '$[0]')) FROM json_each(pbatches.data))",
      "DELETE FROM meta WHERE k LIKE 'set:%'"],
  7: ['CREATE TABLE IF NOT EXISTS keeps (uid INTEGER NOT NULL, seller INTEGER NOT NULL, pin INTEGER NOT NULL DEFAULT 0, note INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (uid, seller)) WITHOUT ROWID']
};
let migrated = false;
async function migrate(env) {
  if (migrated) return;
  const v = Number(firstV(await metaGet(env, 'schemaV').run())) || 1;
  for (let n = v + 1; n <= SCHEMA_VERSION; n++) {
    if (n === 3) { // one by one: the column may already exist
      for (const q of MIGRATIONS[n]) {
        try { await env.DB.prepare(q).run(); }
        catch (e) { if (!/duplicate column/i.test(String(e && e.message))) throw e; }
      }
      await metaSet(env, 'schemaV', n).run();
    } else { // all or nothing
      await env.DB.batch(MIGRATIONS[n].map(q => env.DB.prepare(q)).concat(metaSet(env, 'schemaV', n)));
    }
  }
  migrated = true;
}
const metaSet = (env, k, v) => env.DB.prepare('INSERT INTO meta (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(k, v == null ? null : String(v));
const metaGet = (env, k) => env.DB.prepare('SELECT v FROM meta WHERE k = ?1').bind(k);
const firstV = r => (r && r.results && r.results[0] ? r.results[0].v : null);
const isJson = req => /^application\/json\b/i.test(req.headers.get('Content-Type') || '');

/* ---------- Torn (only at sign-in, with the player's own key) ---------- */
async function torn(env, path, key) {
  const base = env.TORN_BASE || 'https://api.torn.com/v2';
  let r;
  try { r = await fetch(`${base}${path}${path.includes('?') ? '&' : '?'}key=${encodeURIComponent(key || '')}`, { headers: { 'User-Agent': 'GildedCompass' } }); }
  catch (e) { return { retry: true }; }
  if (r.status === 429) return { rate: true };
  if (r.status >= 500) return { retry: true };
  let j; try { j = await r.json(); } catch (e) { return { retry: true }; }
  const er = j && j.error;
  if (er) {
    if (er.code === 5) return { rate: true };
    if (er.code === 6 || er.code === 7) return { missing: true };
    if (FATAL_CODES.has(er.code)) return { fatal: `Torn error ${er.code}: ${er.error}`, code: er.code };
    return { retry: true, err: `Torn error ${er.code}: ${er.error}` };
  }
  return { data: j };
}

// Saves results, one UPDATE row per seller (a name found together with the first check goes in the same row write).
// `old` (id -> row as it was): bazaar answers are only written when they changed; t = when the last change was seen.
function saveStatements(env, out, old) {
  const st = [], by = new Map();
  for (const r of out.bazaar) if (!old || statusChanged(old.get(r[0]), r[1], r[2], r[3])) by.set(r[0], { b: r });
  for (const n of out.names) { const e = by.get(n[0]) || {}; e.n = n; by.set(n[0], e); }
  out.changed = [...by.values()].filter(e => e.b).map(e => e.b);
  // [id, is_open, has_bazaar, missing, t, name, name_missing, name_t] (null = leave as it is)
  const rows = [...by.entries()].map(([id, e]) => [id, e.b ? e.b[1] : null, e.b ? e.b[2] : null, e.b ? e.b[3] : null, e.b ? e.b[4] : null,
    e.n ? e.n[1] : null, e.n ? e.n[2] : null, e.n ? e.n[3] : null]);
  if (rows.length) st.push(env.DB.prepare(
    `UPDATE status SET
       is_open = COALESCE(json_extract(j.value, '$[1]'), is_open),
       has_bazaar = COALESCE(json_extract(j.value, '$[2]'), has_bazaar),
       missing = MAX(missing, COALESCE(json_extract(j.value, '$[3]'), 0), COALESCE(json_extract(j.value, '$[6]'), 0)),
       t = COALESCE(json_extract(j.value, '$[4]'), t),
       name = COALESCE(json_extract(j.value, '$[5]'), name),
       name_t = COALESCE(json_extract(j.value, '$[7]'), name_t),
       u = MAX(u, COALESCE(json_extract(j.value, '$[4]'), 0), COALESCE(json_extract(j.value, '$[7]'), 0))
     FROM json_each(?1) AS j WHERE status.id = json_extract(j.value, '$[0]')`).bind(JSON.stringify(rows)));
  return st;
}

/* ---------- cron: hourly housekeeping ---------- */
// No Torn calls: bazaar checks come from the players' userscripts. This only upgrades the database and drops old sign-ins.
async function cron(env) {
  await migrate(env);
  await env.DB.prepare('DELETE FROM sessions WHERE created < ?1').bind(now() - SESSION_DAYS * 86400).run();
  await prune(env);
}
// Once a day: drop purchases older than 60 days, sellers nobody has bought from in 60 days, and what hangs off them.
// Pinned sellers and sellers with a note (keeps) always stay on their player's list.
// A bundle is dropped when its newest purchase is old; a bundle that straddles the line stays until then (the page and the
// seller lists only count the purchases inside the 60 days).
async function prune(env) {
  const day = new Date().toISOString().slice(0, 10);
  if (firstV(await metaGet(env, 'pruned').run()) === day) return;
  const start = historyStart();
  const r = await env.DB.batch([
    env.DB.prepare('DELETE FROM pbatches WHERE tmax < ?1').bind(start),
    // each player's seller list: sellers with a purchase in the last 60 days, plus the ones they pinned or wrote a note for
    env.DB.prepare(`UPDATE usets SET sellers = n.s FROM (SELECT uid, json_group_array(DISTINCT s) AS s FROM (
        SELECT b.uid AS uid, json_extract(p.value, '$[1]') AS s FROM pbatches b, json_each(b.data) p WHERE json_extract(p.value, '$[0]') >= ?1
        UNION ALL SELECT uid, seller FROM keeps) GROUP BY uid) AS n WHERE usets.uid = n.uid`).bind(start),
    env.DB.prepare(`DELETE FROM usets WHERE uid NOT IN (SELECT b.uid FROM pbatches b, json_each(b.data) p WHERE json_extract(p.value, '$[0]') >= ?1
        UNION SELECT uid FROM keeps)`).bind(start),
    env.DB.prepare('DELETE FROM tops WHERE NOT EXISTS (SELECT 1 FROM usets u, json_each(u.sellers) j WHERE u.uid = tops.uid AND j.value = tops.seller)'),
    env.DB.prepare('DELETE FROM status WHERE id NOT IN (SELECT j.value FROM usets u, json_each(u.sellers) j)'),
    metaSet(env, 'pruned', day)
  ]);
  console.log('prune: bundles', r[0].meta.changes, 'players', r[2].meta.changes, 'tops', r[3].meta.changes, 'sellers', r[4].meta.changes);
}

/* ---------- sign in ---------- */
async function signedIn(req, env) {
  const token = bearer(req.headers.get('Authorization'));
  if (!token) return null;
  const row = await env.DB.prepare('SELECT s.uid, u.name FROM sessions s JOIN users u ON u.uid = s.uid WHERE s.hash = ?1 AND s.created > ?2')
    .bind(await sha256hex(token), now() - SESSION_DAYS * 86400).first();
  return row ? { uid: row.uid, name: row.name } : null;
}
// The key is used for one call (who owns it?) and is never stored.
async function login(req, env) {
  if (!isJson(req)) return json({ error: 'JSON body required' }, 415);
  let body; try { body = await req.json(); } catch (e) { return json({ error: 'Bad JSON' }, 400); }
  const key = body && String(body.key || '').trim();
  if (!looksLikeKey(key)) return json({ error: 'That does not look like a Torn API key (16 letters and numbers).' }, 400);
  const r = await torn(env, '/user/basic', key);
  if (r.rate) return json({ error: 'Torn says too many requests for this key. Try again in a minute.' }, 429);
  if (r.fatal) return json({ error: r.code === 2 ? 'Torn says this key is incorrect.' : r.fatal }, 401);
  const p = r.data && (r.data.profile || r.data);
  const uid = p && Number(p.id || p.player_id);
  if (!(uid > 0)) return json({ error: 'Torn did not say who owns this key. Try again.' }, 502);
  const token = newToken();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO users (uid, name, created) VALUES (?1, ?2, ?3) ON CONFLICT(uid) DO UPDATE SET name = excluded.name').bind(uid, p.name || null, now()),
    env.DB.prepare('INSERT INTO sessions (hash, uid, created) VALUES (?1, ?2, ?3)').bind(await sha256hex(token), uid, now())
  ]);
  return json({ token, uid, name: p.name || null });
}

/* ---------- the user's settings ---------- */
// lookback: how many days back the page and the userscript look for purchases. The same 60 days for everyone (no choice).
const SETTINGS = { lookback: HISTORY_DAYS };

/* ---------- the user's data ---------- */
// Raw purchases [ts, seller, items, cost_each, cost_total, log id] plus Torn's item list; the browser adds them up.
// `after`: only bundles stored after that one (an open page fetches just the new ones). `last` says where to carry on.
async function getData(env, me, after) {
  const [b, items, u, tp, kp] = await env.DB.batch([
    env.DB.prepare('SELECT seq, data FROM pbatches WHERE uid = ?1 AND seq > ?2 AND tmax >= ?3 ORDER BY seq').bind(me.uid, after, historyStart()),
    env.DB.prepare("SELECT v FROM meta WHERE k IN (?1, 'items') ORDER BY k = 'items' LIMIT 1").bind('items:' + me.uid), env.DB.prepare('SELECT last_upload AS v FROM users WHERE uid = ?1').bind(me.uid),
    env.DB.prepare('SELECT seller FROM tops WHERE uid = ?1').bind(me.uid),
    env.DB.prepare('SELECT seller, pin, note FROM keeps WHERE uid = ?1').bind(me.uid)
  ]);
  const parts = b.results.map(r => inner(r.data)).filter(Boolean);
  const last = b.results.length ? b.results[b.results.length - 1].seq : after;
  return rawJson(`{"me":${JSON.stringify(me)},"purchases":[${parts.join(',')}],"items":${firstV(items) || '{}'},` +
    `"settings":${JSON.stringify(SETTINGS)},"tops":${JSON.stringify(tp.results.map(r => r.seller))},` +
    `"keeps":${JSON.stringify(kp.results.map(r => [r.seller, r.pin, r.note]))},` +
    `"last":${Number(last) || 0},"lastUpload":${Number(firstV(u)) || 0},"now":${now()}}`);
}
// Only this user's sellers. First load (since = 0): walk the player's seller list once. Later polls: find the few rows
// changed since `since` through the u index first, then keep the player's own (doing it the other way round reads the
// whole seller list on every poll: 12,000 rows for a player with 4,000 sellers).
const POLL_MAX = 5000;
async function getStatus(env, me, since) {
  const others = [env.DB.prepare('SELECT last_upload AS v FROM users WHERE uid = ?1').bind(me.uid)];
  let rowsJson, rest, until = 0;
  if (!since) {
    const [rows] = await env.DB.batch([env.DB.prepare(`SELECT json_group_array(json_array(s.id, s.is_open, s.has_bazaar, s.missing, s.t, s.name, s.name_t)) AS v
        FROM json_each((SELECT sellers FROM usets WHERE uid = ?1)) j JOIN status s ON s.id = j.value WHERE s.u > 0`).bind(me.uid)]);
    rowsJson = firstV(rows) || '[]';
    rest = await env.DB.batch(others);
  } else {
    const res = await env.DB.batch([
      env.DB.prepare('SELECT id, is_open, has_bazaar, missing, t, name, name_t FROM status INDEXED BY status_u WHERE u >= ?1 ORDER BY u LIMIT ?2').bind(since, POLL_MAX),
      env.DB.prepare('SELECT sellers FROM usets WHERE uid = ?1').bind(me.uid), ...others]);
    const mine = new Set(JSON.parse((res[1].results[0] && res[1].results[0].sellers) || '[]'));
    rowsJson = JSON.stringify(res[0].results.filter(r => mine.has(r.id)).map(r => [r.id, r.is_open, r.has_bazaar, r.missing, r.t, r.name, r.name_t]));
    if (res[0].results.length) until = Math.max(...res[0].results.map(r => Math.max(r.t || 0, r.name_t || 0))); // carry on from here even if none were yours
    rest = res.slice(2);
  }
  const [u] = rest;
  return rawJson(`{"rows":${rowsJson},"until":${until},"error":null,` +
    `"lastUpload":${Number(firstV(u)) || 0},"now":${now()}}`);
}

// Daily counters for one player (uploads, purchases, new sellers, top-100 updates).
async function dayCounter(env, uid) {
  let q = {}; try { q = JSON.parse(firstV(await metaGet(env, 'day:' + uid).run()) || '{}'); } catch (e) { /* start over */ }
  const d = Math.floor(now() / 86400);
  return q.d === d ? q : { d, uploads: 0, purchases: 0, sellers: 0, tops: 0, changes: 0, items: 0, keeps: 0 };
}
const capMsg = what => `Daily limit for one player reached (${what}). The rest is sent automatically after midnight UTC.`;

// Purchases from the userscript: one bundle row per upload. The page skips any purchase it already has (same log id).
async function upload(req, env, me) {
  if (!isJson(req)) return json({ error: 'JSON body required' }, 415);
  if (Number(req.headers.get('Content-Length') || 0) > 4e6) return json({ error: 'Too large, send smaller chunks' }, 413);
  let body; try { body = await req.json(); } catch (e) { return json({ error: 'Bad JSON' }, 400); }
  const all = (Array.isArray(body && body.buys) ? body.buys : []).map(validBuy).filter(Boolean);
  if (all.length > 2000) return json({ error: 'At most 2000 purchases per request' }, 413);
  const start = historyStart(), buys = all.filter(b => b.ts >= start); // older than 60 days: accepted but not kept
  if (!buys.length) return json({ ok: true, received: all.length, inserted: 0 });
  const q = await dayCounter(env, me.uid);
  const S = JSON.stringify([...new Set(buys.map(b => b.s))]);
  const fresh = (await env.DB.prepare('SELECT COUNT(*) AS n FROM json_each(?1) WHERE value NOT IN (SELECT id FROM status)').bind(S).first()).n;
  if (q.uploads + 1 > DAY_CAP.uploads) return json({ error: capMsg('uploads') }, 429);
  if (q.purchases + buys.length > DAY_CAP.purchases) return json({ error: capMsg('purchases') }, 429);
  if (q.sellers + fresh > DAY_CAP.sellers) return json({ error: capMsg('new sellers') }, 429);
  q.uploads++; q.purchases += buys.length; q.sellers += fresh;
  const st = [];
  st.push(
    env.DB.prepare('INSERT INTO pbatches (uid, n, data, tmax) VALUES (?1, ?2, ?3, ?4)')
      .bind(me.uid, buys.length, JSON.stringify(buys.map(b => [b.ts, b.s, b.it, b.ce, b.ct, b.id])), Math.max(...buys.map(b => b.ts))),
    env.DB.prepare(`INSERT INTO usets (uid, sellers) VALUES (?1, ?2) ON CONFLICT(uid) DO UPDATE SET sellers =
        (SELECT json_group_array(value) FROM (SELECT value FROM json_each(usets.sellers) UNION SELECT value FROM json_each(excluded.sellers)))`).bind(me.uid, S),
    env.DB.prepare('INSERT OR IGNORE INTO status (id) SELECT value FROM json_each(?1)').bind(S));
  st.push(env.DB.prepare('UPDATE users SET last_upload = ?2 WHERE uid = ?1').bind(me.uid, now()), metaSet(env, 'day:' + me.uid, JSON.stringify(q)));
  await env.DB.batch(st);
  return json({ ok: true, received: all.length, inserted: buys.length });
}
// Your page works out your top 100 sellers and sends it here; only the differences are written.
// Your 🧭 userscript checks these bazaars more often.
async function putTops(req, env, me) {
  if (!isJson(req)) return json({ error: 'JSON body required' }, 415);
  let body; try { body = await req.json(); } catch (e) { return json({ error: 'Bad JSON' }, 400); }
  const ids = Array.isArray(body && body.ids) && body.ids.length === 0 ? [] : validIds(body && body.ids, TOP_TIER);
  if (!ids) return json({ error: `ids must be up to ${TOP_TIER} player ids` }, 400);
  const q = await dayCounter(env, me.uid);
  if (q.tops + 1 > DAY_CAP.tops) return json({ error: capMsg('top-100 updates') }, 429);
  const [cur, mine] = await env.DB.batch([
    env.DB.prepare('SELECT seller FROM tops WHERE uid = ?1').bind(me.uid),
    env.DB.prepare(`SELECT value AS seller FROM json_each(?2) WHERE value IN ${MY_SELLERS}`).bind(me.uid, JSON.stringify(ids))
  ]);
  const want = new Set(mine.results.map(r => r.seller)), have = new Set(cur.results.map(r => r.seller));
  const add = [...want].filter(x => !have.has(x)), del = [...have].filter(x => !want.has(x));
  if (!add.length && !del.length) return json({ ok: true, changed: 0 });
  q.tops++;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM tops WHERE uid = ?1 AND seller IN (SELECT value FROM json_each(?2))').bind(me.uid, JSON.stringify(del)),
    env.DB.prepare('INSERT OR IGNORE INTO tops (uid, seller) SELECT ?1, value FROM json_each(?2)').bind(me.uid, JSON.stringify(add)),
    metaSet(env, 'day:' + me.uid, JSON.stringify(q))
  ]);
  return json({ ok: true, changed: add.length + del.length });
}
// Deletes everything stored for this user. Their sellers stay in the shared bazaar list (public info) but drop out of the top tier.
async function forget(env, me) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM pbatches WHERE uid = ?1').bind(me.uid),
    env.DB.prepare('DELETE FROM usets WHERE uid = ?1').bind(me.uid),
    env.DB.prepare('DELETE FROM tops WHERE uid = ?1').bind(me.uid),
    env.DB.prepare('DELETE FROM keeps WHERE uid = ?1').bind(me.uid),
    env.DB.prepare('DELETE FROM sessions WHERE uid = ?1').bind(me.uid),
    env.DB.prepare('DELETE FROM users WHERE uid = ?1').bind(me.uid),
    env.DB.prepare('DELETE FROM meta WHERE k IN (?1, ?2)').bind('day:' + me.uid, 'items:' + me.uid)
  ]);
  return json({ ok: true });
}

/* ---------- pins and notes: sellers that stay on your list for good ---------- */
// items: [[seller, pin, note]] with 0 or 1 (null = leave as it is). Only what changed is written; a seller with neither is
// removed from keeps (and drops off at the next daily cleanup if not bought from in 60 days). A seller not on the player's
// list yet (e.g. a note kept on their device for a seller dropped before pins existed) is added back, so it is checked again.
async function postKeep(req, env, me) {
  if (!isJson(req)) return json({ error: 'JSON body required' }, 415);
  let body; try { body = await req.json(); } catch (e) { return json({ error: 'Bad JSON' }, 400); }
  const raw = body && body.items;
  if (!Array.isArray(raw) || raw.length > 200) return json({ error: 'items must be up to 200 [seller, pin, note]' }, 400);
  const flag = v => (v === null || v === undefined ? null : v === 1 || v === true ? 1 : v === 0 || v === false ? 0 : undefined);
  const items = [];
  for (const r of raw) {
    const ok = Array.isArray(r) && /^\d{1,10}$/.test(String(r[0])) && Number(r[0]) > 0 && flag(r[1]) !== undefined && flag(r[2]) !== undefined;
    if (!ok) return json({ error: 'Bad item: ' + JSON.stringify(r).slice(0, 60) }, 400);
    items.push([Number(r[0]), flag(r[1]), flag(r[2])]);
  }
  const [cur, set] = await env.DB.batch([
    env.DB.prepare('SELECT seller, pin, note FROM keeps WHERE uid = ?1').bind(me.uid),
    env.DB.prepare('SELECT sellers AS v FROM usets WHERE uid = ?1').bind(me.uid)
  ]);
  const have = new Map(cur.results.map(r => [r.seller, { pin: r.pin, note: r.note }]));
  const mine = new Set(JSON.parse(firstV(set) || '[]'));
  const ups = new Map(), dels = new Set(), add = new Set();
  for (const [id, pin, note] of items) {
    const o = have.get(id) || { pin: 0, note: 0 };
    const n = { pin: pin === null ? o.pin : pin, note: note === null ? o.note : note };
    if (n.pin === o.pin && n.note === o.note) continue;
    if (!n.pin && !n.note) { have.delete(id); ups.delete(id); dels.add(id); }
    else { have.set(id, n); ups.set(id, [id, n.pin, n.note]); dels.delete(id); if (!mine.has(id)) add.add(id); }
  }
  const list = () => [...have.entries()].map(([id, k]) => [id, k.pin, k.note]);
  if (!ups.size && !dels.size) return json({ ok: true, changed: 0, keeps: list() });
  if (have.size > KEEP_MAX) return json({ error: `At most ${KEEP_MAX.toLocaleString('en-US')} pinned or noted sellers` }, 400);
  const q = await dayCounter(env, me.uid);
  const n = ups.size + dels.size;
  if ((q.keeps || 0) + n > DAY_CAP.keeps) return json({ error: capMsg('pins and notes') }, 429);
  q.keeps = (q.keeps || 0) + n;
  const st = [];
  if (ups.size) st.push(env.DB.prepare(`INSERT INTO keeps (uid, seller, pin, note)
      SELECT ?1, json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]') FROM json_each(?2) WHERE 1
      ON CONFLICT(uid, seller) DO UPDATE SET pin = excluded.pin, note = excluded.note`).bind(me.uid, JSON.stringify([...ups.values()])));
  if (dels.size) st.push(env.DB.prepare('DELETE FROM keeps WHERE uid = ?1 AND seller IN (SELECT value FROM json_each(?2))').bind(me.uid, JSON.stringify([...dels])));
  if (add.size) {
    const A = JSON.stringify([...add]);
    st.push(env.DB.prepare(`INSERT INTO usets (uid, sellers) VALUES (?1, ?2) ON CONFLICT(uid) DO UPDATE SET sellers =
        (SELECT json_group_array(value) FROM (SELECT value FROM json_each(usets.sellers) UNION SELECT value FROM json_each(excluded.sellers)))`).bind(me.uid, A),
      env.DB.prepare('INSERT OR IGNORE INTO status (id) SELECT value FROM json_each(?1)').bind(A));
  }
  st.push(metaSet(env, 'day:' + me.uid, JSON.stringify(q)));
  await env.DB.batch(st);
  return json({ ok: true, changed: n, added: [...add], keeps: list() });
}

/* ---------- what the 🧭 userscript checks with the player's own key ---------- */
// The player's sellers (and top 100) so their userscript knows which bazaars to check.
async function getSellers(env, me) {
  const [set, tp] = await env.DB.batch([
    env.DB.prepare('SELECT sellers AS v FROM usets WHERE uid = ?1').bind(me.uid),
    env.DB.prepare('SELECT seller FROM tops WHERE uid = ?1').bind(me.uid)
  ]);
  return rawJson(`{"sellers":${firstV(set) || '[]'},"tops":${JSON.stringify(tp.results.map(r => r.seller))}}`);
}
// Results of bazaar checks done by the player's userscript: [[id, is_open, has_bazaar, missing]] and names [[id, name, missing]].
// Only for sellers in that player's own list; only real changes are written; changes are capped per player per day.
async function postBazaar(req, env, me) {
  if (!isJson(req)) return json({ error: 'JSON body required' }, 415);
  let body; try { body = await req.json(); } catch (e) { return json({ error: 'Bad JSON' }, 400); }
  const results = (Array.isArray(body && body.results) ? body.results : []).slice(0, 100).map(r => validResult(r)).filter(Boolean);
  const names = (Array.isArray(body && body.names) ? body.names : []).slice(0, 100)
    .filter(n => Array.isArray(n) && /^\d{1,10}$/.test(String(n[0])) && typeof n[1] === 'string' && n[1].length <= 40)
    .map(n => [Number(n[0]), n[1], n[2] ? 1 : 0]);
  const ids = [...new Set(results.map(r => r[0]).concat(names.map(n => n[0])))];
  if (!ids.length) return json({ ok: true, changed: 0, needName: [] });
  const [set, rows] = await env.DB.batch([
    env.DB.prepare('SELECT sellers AS v FROM usets WHERE uid = ?1').bind(me.uid),
    env.DB.prepare('SELECT id, is_open, has_bazaar, missing, name, name_t FROM status WHERE id IN (SELECT value FROM json_each(?1))').bind(JSON.stringify(ids))
  ]);
  const mine = new Set(JSON.parse(firstV(set) || '[]'));
  const old = new Map(rows.results.filter(r => mine.has(r.id)).map(r => [r.id, r]));
  const t = now();
  const out = {
    bazaar: results.filter(r => old.has(r[0])).map(r => [r[0], r[1], r[2], r[3], t]),
    names: names.filter(n => { const o = old.get(n[0]); return o && (!o.name_t || (o.name !== n[1] && t - o.name_t > 7 * 86400)); }).map(n => [n[0], n[1], n[2], t])
  };
  const st = saveStatements(env, out, old);
  const changes = out.changed.length + out.names.length;
  const named = new Set(names.map(n => n[0]));
  const needName = results.map(r => r[0]).filter(id => old.has(id) && !old.get(id).name_t && !named.has(id));
  if (changes) {
    const q = await dayCounter(env, me.uid);
    if ((q.changes || 0) + changes > DAY_CAP.changes) return json({ error: capMsg('bazaar changes'), changed: 0, needName }, 429);
    q.changes = (q.changes || 0) + changes;
    await env.DB.batch(st.concat(metaSet(env, 'day:' + me.uid, JSON.stringify(q))));
  }
  return json({ ok: true, checked: out.bazaar.length, changed: changes, needName });
}
// Torn's item list (names and types) as fetched by the player's userscript, kept for that player only.
async function postItems(req, env, me) {
  if (!isJson(req)) return json({ error: 'JSON body required' }, 415);
  if (Number(req.headers.get('Content-Length') || 0) > 2e6) return json({ error: 'Too large' }, 413);
  let body; try { body = await req.json(); } catch (e) { return json({ error: 'Bad JSON' }, 400); }
  const items = body && body.items;
  const ok = items && typeof items === 'object' && !Array.isArray(items) && Object.keys(items).length >= 100 &&
    Object.entries(items).every(([k, v]) => /^\d{1,6}$/.test(k) && Array.isArray(v) && typeof v[0] === 'string' && typeof v[1] === 'string' && v[0].length < 80 && v[1].length < 40);
  if (!ok) return json({ error: 'Bad item list' }, 400);
  const q = await dayCounter(env, me.uid);
  if ((q.items || 0) + 1 > DAY_CAP.items) return json({ error: capMsg('item list updates') }, 429);
  q.items = (q.items || 0) + 1;
  await env.DB.batch([metaSet(env, 'items:' + me.uid, JSON.stringify(items)), metaSet(env, 'day:' + me.uid, JSON.stringify(q))]);
  return json({ ok: true });
}

export default {
  // Only /api/* reaches this code; the page itself is served straight from public/.
  async fetch(req, env) {
    const url = new URL(req.url), p = url.pathname, m = req.method;
    if (!p.startsWith('/api/')) return env.ASSETS.fetch(req);
    try { return await handle(req, env, url, p, m); }
    catch (e) {
      console.error('api error', p, e && e.stack || e);
      const msg = String(e && e.message || e);
      const limit = /limit|exceeded|quota/i.test(msg);
      return json({ error: limit ? 'The site\'s database is at a limit right now. Please try again in a few minutes.' : 'Server error: ' + msg.slice(0, 200) }, limit ? 503 : 500);
    }
  },
  async scheduled(event, env) {
    try { await withSchema(env, () => cron(env)); }
    catch (e) { console.error('cron error', e && e.stack || e); }
  }
};

async function handle(req, env, url, p, m) {
  return withSchema(env, async () => {
    if (p === '/api/login' && m === 'POST') return login(req.clone(), env);
    const me = await signedIn(req, env);
    if (!me) return json({ error: 'Please sign in' }, 401);
    await migrate(env); // the tables below are in the v4 layout
    if (p === '/api/me' && m === 'GET') {
      const c = await env.DB.prepare('SELECT EXISTS (SELECT 1 FROM pbatches WHERE uid = ?1) AS has').bind(me.uid).first();
      const has = !!(c && c.has); // `purchases` stays for older userscripts: 0 = none, 1 = some
      return json(Object.assign({}, me, { hasPurchases: has, purchases: has ? 1 : 0, settings: SETTINGS }));
    }
    if (p === '/api/data' && m === 'GET') return getData(env, me, Math.max(0, Number(url.searchParams.get('after')) || 0));
    if (p === '/api/status' && m === 'GET') return getStatus(env, me, Math.max(0, Number(url.searchParams.get('since')) || 0));
    if (p === '/api/purchases' && m === 'POST') return upload(req.clone(), env, me);
    if (p === '/api/tops' && m === 'POST') return putTops(req.clone(), env, me);
    if (p === '/api/logout' && m === 'POST') {
      await env.DB.prepare('DELETE FROM sessions WHERE hash = ?1').bind(await sha256hex(bearer(req.headers.get('Authorization')))).run();
      return json({ ok: true });
    }
    if (p === '/api/forget' && m === 'POST') return forget(env, me);
    if (p === '/api/settings' && m === 'GET') return json(SETTINGS);
    if (p === '/api/settings' && m === 'POST') return json(SETTINGS); // nothing to choose any more (history is 60 days for everyone)
    if (p === '/api/sellers' && m === 'GET') return getSellers(env, me);
    if (p === '/api/bazaar' && m === 'POST') return postBazaar(req.clone(), env, me);
    if (p === '/api/items' && m === 'POST') return postItems(req.clone(), env, me);
    if (p === '/api/keep' && m === 'POST') return postKeep(req.clone(), env, me);
    return json({ error: 'Not found' }, 404);
  });
}
