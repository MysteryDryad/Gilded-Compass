// Gilded Compass Worker (multi-user).
// - Anyone signs in with their own Torn API key: the key is used once to ask Torn who they are, then forgotten.
//   They get a random sign-in token; only its hash is stored.
// - Each user's bazaar purchases (sent by the userscript) are stored under their player id and only shown to them.
// - A cron job keeps bazaar Open/Closed flags and usernames fresh with the site's own Public key (TORN_API_KEY).
// - Free plan budget (per day, reset 00:00 UTC): 100,000 rows written, 5,000,000 rows read. Writes are the scarce part:
//   purchases are stored in bundles (one row per upload), each player's seller list is one row, a seller's status row is
//   only written when something about them changed, and every index costs an extra row per write.
import {
  parseBazaar, parseName, roundRobin, statusChanged, validIds, validBuy, newToken, sha256hex, bearer, looksLikeKey,
  MAX_TORN_PER_RUN, PARALLEL, MAX_NAMES_PER_RUN
} from './logic.mjs';

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS users (uid INTEGER PRIMARY KEY, name TEXT, created INTEGER NOT NULL, last_upload INTEGER NOT NULL DEFAULT 0)',
  'CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, uid INTEGER NOT NULL, created INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS sessions_uid ON sessions(uid)',
  // one row per upload: data = JSON [[ts, seller, [[item, qty]], cost_each, cost_total, log id], ...]
  'CREATE TABLE IF NOT EXISTS pbatches (seq INTEGER PRIMARY KEY, uid INTEGER NOT NULL, n INTEGER NOT NULL, data TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS pbatches_uid ON pbatches(uid)',
  // one row per player: JSON list of the sellers they bought from
  'CREATE TABLE IF NOT EXISTS usets (uid INTEGER PRIMARY KEY, sellers TEXT NOT NULL)',
  // each player's top 100 sellers (worked out by their page); a seller in anyone's top 100 is checked more often
  'CREATE TABLE IF NOT EXISTS tops (uid INTEGER NOT NULL, seller INTEGER NOT NULL, PRIMARY KEY (uid, seller)) WITHOUT ROWID',
  'CREATE INDEX IF NOT EXISTS tops_seller ON tops(seller)',
  'CREATE TABLE IF NOT EXISTS status (id INTEGER PRIMARY KEY, is_open INTEGER, has_bazaar INTEGER, missing INTEGER NOT NULL DEFAULT 0, t INTEGER NOT NULL DEFAULT 0, top INTEGER NOT NULL DEFAULT 0, kind INTEGER NOT NULL DEFAULT 2, name TEXT, name_t INTEGER NOT NULL DEFAULT 0, u INTEGER NOT NULL DEFAULT 0)',
  'CREATE INDEX IF NOT EXISTS status_kind ON status(kind)',
  'CREATE INDEX IF NOT EXISTS status_u ON status(u)',
  'CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)',
  "INSERT OR IGNORE INTO meta (k, v) VALUES ('schemaV', '4')"
];
const FATAL_CODES = new Set([1, 2, 10, 13, 16, 18]); // key missing, wrong, owner jailed, inactive, too low, paused
const SESSION_DAYS = 180;
const USER_COOLDOWN = 30;      // seconds between one user's Check now presses
const CHECK_WINDOW = 30;       // all users together: at most 30 Check now lookups per 30 s (cron adds 36/min: under Torn's 100/min)
const TOP_TIER = 100;
// One player per day (generous for a real first sync; stops one person draining the shared allowance).
const DAY_CAP = { purchases: 60000, sellers: 8000, uploads: 500, tops: 40 };
const NEW_USER_LOOKBACK = 90;  // days of history a new player starts with (they can widen it in Settings)
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
const SCHEMA_VERSION = 4;
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
      'DROP TABLE IF EXISTS purchases', 'DROP TABLE IF EXISTS user_sellers']
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
const KIND_SQL = top => `CASE WHEN missing = 1 THEN 0 WHEN has_bazaar = 0 THEN 3 WHEN ${top} THEN 1 ELSE 2 END`;

/* ---------- Torn ---------- */
async function torn(env, path, key) {
  const base = env.TORN_BASE || 'https://api.torn.com/v2';
  let r;
  try { r = await fetch(`${base}${path}${path.includes('?') ? '&' : '?'}key=${encodeURIComponent(key || env.TORN_API_KEY || '')}`, { headers: { 'User-Agent': 'GildedCompass' } }); }
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

// Bazaar or name lookups, 10 at a time. Stops early on "too many requests" or a bad key.
async function runJobs(env, jobs) {
  const bazaar = [], names = [];
  let rate = false, fatal = null, done = 0;
  for (let i = 0; i < jobs.length && !rate && !fatal; i += PARALLEL) {
    const wave = jobs.slice(i, i + PARALLEL);
    const res = await Promise.all(wave.map(j => torn(env, j.kind === 'name' ? `/user/${j.id}/basic` : `/user/${j.id}/bazaar`)));
    const t = now();
    res.forEach((r, k) => {
      const j = wave[k];
      if (r.rate) { rate = true; return; }
      if (r.fatal) { fatal = r.fatal; return; }
      if (r.retry) return;
      done++;
      if (j.kind === 'name') names.push([j.id, r.missing ? '(not found)' : (parseName(r.data) || '(unknown)'), r.missing ? 1 : 0, t]);
      else {
        const b = r.missing ? { is_open: 0, has_bazaar: 0 } : parseBazaar(r.data);
        if (b) bazaar.push([j.id, b.is_open, b.has_bazaar, r.missing ? 1 : 0, t]);
      }
    });
  }
  return { bazaar, names, rate, fatal, done };
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
       u = MAX(u, COALESCE(json_extract(j.value, '$[4]'), 0), COALESCE(json_extract(j.value, '$[7]'), 0)),
       kind = CASE WHEN MAX(missing, COALESCE(json_extract(j.value, '$[3]'), 0), COALESCE(json_extract(j.value, '$[6]'), 0)) = 1 THEN 0
                   WHEN COALESCE(json_extract(j.value, '$[2]'), has_bazaar) = 0 THEN 3 WHEN top = 1 THEN 1 ELSE 2 END
     FROM json_each(?1) AS j WHERE status.id = json_extract(j.value, '$[0]')`).bind(JSON.stringify(rows)));
  if (out.fatal) st.push(metaSet(env, 'error', JSON.stringify({ msg: out.fatal, t: now() })));
  else if (out.done) st.push(env.DB.prepare("DELETE FROM meta WHERE k = 'error'"));
  return st;
}

/* ---------- cron: every minute ---------- */
// Each run checks the next few sellers of each kind in turn (round robin) and remembers where it stopped in one small row.
// Subrequests (free plan allows 50): 2 D1 reads + at most 36 Torn calls + 1-2 D1 writes (+ a schema check per Worker start).
const PER_RUN = { 1: 14, 3: 2 }; // top sellers, sellers with no bazaar; the other sellers get the rest of the 36
const BRAKE_WRITES = 60000;       // the cron's own writes today; above this it checks fewer sellers (safety brake)
async function cron(env, scheduledTime) {
  if (!env.TORN_API_KEY) return;
  await migrate(env);
  let rr = {}; try { rr = JSON.parse(firstV(await metaGet(env, 'rr').run()) || '{}'); } catch (e) { /* start over */ }
  const day = Math.floor(now() / 86400);
  if (rr.d !== day) { rr.d = day; rr.w = 0; rr.lw = 0; }
  rr.w = (rr.w || 0) + (rr.lw || 0); // the last run's writes, counted now
  const braked = rr.w > BRAKE_WRITES;
  const max = braked ? 10 : MAX_TORN_PER_RUN;
  const cur = k => Number(rr['c' + k]) || 0;
  const q = (kind, after, n) => env.DB.prepare('SELECT id, is_open, has_bazaar, missing, name_t FROM status WHERE kind = ?1 AND id > ?2 ORDER BY id LIMIT ?3').bind(kind, after, n);
  const [a1, w1, a2, w2, a3, w3, itemsAt] = await env.DB.batch([
    q(1, cur(1), PER_RUN[1]), q(1, 0, PER_RUN[1]), q(2, cur(2), max), q(2, 0, max), q(3, cur(3), PER_RUN[3]), q(3, 0, PER_RUN[3]),
    metaGet(env, 'itemsAt')
  ]);
  const st = [];
  let budget = max, names = 0;
  // Torn's item list (id -> name and type), refreshed weekly with the site's own key.
  if (now() - (Number(firstV(itemsAt)) || 0) > 7 * 86400) {
    budget--;
    const r = await torn(env, '/torn/items');
    if (r.data) {
      const list = Array.isArray(r.data.items) ? r.data.items : Object.entries(r.data.items || {}).map(([id, v]) => Object.assign({ id }, v));
      const map = {};
      list.forEach(i => { if (i && i.id) map[i.id] = [i.name, i.type || 'Unknown', i.sub_type || null]; });
      if (Object.keys(map).length) st.push(metaSet(env, 'items', JSON.stringify(map)), metaSet(env, 'itemsAt', now()));
    }
  }
  const jobs = [], old = new Map();
  const take = rows => {
    const used = [];
    for (const r of rows) {
      if (budget <= 0) break;
      jobs.push({ kind: 'bazaar', id: r.id }); old.set(r.id, r); budget--; used.push(r);
      if (!r.name_t && !braked && names < MAX_NAMES_PER_RUN && budget > 0) { jobs.push({ kind: 'name', id: r.id }); budget--; names++; } // names come along the first time round
    }
    return used;
  };
  const used = { 1: take(roundRobin(a1.results, w1.results, PER_RUN[1])), 3: take(roundRobin(a3.results, w3.results, PER_RUN[3])) };
  used[2] = take(roundRobin(a2.results, w2.results, max));
  const out = jobs.length ? await runJobs(env, jobs) : { bazaar: [], names: [], done: 0 };
  const checked = new Set(out.bazaar.map(r => r[0]));
  for (const k of [1, 2, 3]) { // carry on after the last seller actually checked
    const last = used[k].filter(r => checked.has(r.id)).pop();
    if (last) rr['c' + k] = last.id;
  }
  st.push(...saveStatements(env, out, old));
  if (new Date(scheduledTime || Date.now()).getUTCMinutes() === 0) {
    st.push(env.DB.prepare('DELETE FROM sessions WHERE created < ?1').bind(now() - SESSION_DAYS * 86400));
  }
  rr.at = now();
  rr.lw = 1; // this run's writes, added to today's total by the next run: 1 if it only wrote this row
  const res = await env.DB.batch(st.concat(metaSet(env, 'rr', JSON.stringify(rr))));
  const written = res.reduce((n, r) => n + ((r.meta && r.meta.rows_written) || 0), 0);
  if (written > 1) { rr.lw = written + 1; await metaSet(env, 'rr', JSON.stringify(rr)).run(); } // +1 for this extra row
  console.log(`cron: checked ${out.bazaar.length}, changed ${out.changed.length}, names ${out.names.length}, rows written ${written}, today ${rr.w + rr.lw}${braked ? ' (brake on)' : ''}${out.fatal ? ', error: ' + out.fatal : ''}${out.rate ? ', Torn rate limit' : ''}`);
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
    // a new player starts with 90 days of history (a lighter first sync); existing players keep their setting
    env.DB.prepare('INSERT OR IGNORE INTO meta (k, v) SELECT ?1, ?2 WHERE NOT EXISTS (SELECT 1 FROM users WHERE uid = ?3)')
      .bind('set:' + uid, JSON.stringify({ lookback: NEW_USER_LOOKBACK }), uid),
    env.DB.prepare('INSERT INTO users (uid, name, created) VALUES (?1, ?2, ?3) ON CONFLICT(uid) DO UPDATE SET name = excluded.name').bind(uid, p.name || null, now()),
    env.DB.prepare('INSERT INTO sessions (hash, uid, created) VALUES (?1, ?2, ?3)').bind(await sha256hex(token), uid, now())
  ]);
  return json({ token, uid, name: p.name || null });
}

/* ---------- the user's settings ---------- */
// lookback: how many days back to look for purchases (0 = all of your history). Read by the page and by the userscript.
const LOOKBACK_CHOICES = [0, 30, 90, 180, 365];
const DEFAULT_SETTINGS = { lookback: 0 };
async function getSettings(env, uid) {
  const v = firstV(await metaGet(env, 'set:' + uid).run());
  try { return Object.assign({}, DEFAULT_SETTINGS, v ? JSON.parse(v) : {}); } catch (e) { return Object.assign({}, DEFAULT_SETTINGS); }
}
async function putSettings(req, env, me) {
  if (!isJson(req)) return json({ error: 'JSON body required' }, 415);
  let body; try { body = await req.json(); } catch (e) { return json({ error: 'Bad JSON' }, 400); }
  const cur = await getSettings(env, me.uid);
  if (body && body.lookback !== undefined) {
    const d = Number(body.lookback);
    if (!LOOKBACK_CHOICES.includes(d)) return json({ error: 'lookback must be one of ' + LOOKBACK_CHOICES.join(', ') }, 400);
    cur.lookback = d;
  }
  await metaSet(env, 'set:' + me.uid, JSON.stringify(cur)).run();
  return json(cur);
}

/* ---------- the user's data ---------- */
// Raw purchases [ts, seller, items, cost_each, cost_total, log id] plus Torn's item list; the browser adds them up.
// `after`: only bundles stored after that one (an open page fetches just the new ones). `last` says where to carry on.
async function getData(env, me, after) {
  const [b, items, u, set, tp] = await env.DB.batch([
    env.DB.prepare('SELECT seq, data FROM pbatches WHERE uid = ?1 AND seq > ?2 ORDER BY seq').bind(me.uid, after),
    metaGet(env, 'items'), env.DB.prepare('SELECT last_upload AS v FROM users WHERE uid = ?1').bind(me.uid), metaGet(env, 'set:' + me.uid),
    env.DB.prepare('SELECT seller FROM tops WHERE uid = ?1').bind(me.uid)
  ]);
  const parts = b.results.map(r => inner(r.data)).filter(Boolean);
  const last = b.results.length ? b.results[b.results.length - 1].seq : after;
  const settings = Object.assign({}, DEFAULT_SETTINGS, JSON.parse(firstV(set) || '{}'));
  return rawJson(`{"me":${JSON.stringify(me)},"purchases":[${parts.join(',')}],"items":${firstV(items) || '{}'},` +
    `"settings":${JSON.stringify(settings)},"tops":${JSON.stringify(tp.results.map(r => r.seller))},` +
    `"last":${Number(last) || 0},"lastUpload":${Number(firstV(u)) || 0},"now":${now()}}`);
}
// Only this user's sellers. First load (since = 0): walk the player's seller list once. Later polls: find the few rows
// changed since `since` through the u index first, then keep the player's own (doing it the other way round reads the
// whole seller list on every poll: 12,000 rows for a player with 4,000 sellers).
const POLL_MAX = 5000;
async function getStatus(env, me, since) {
  const others = [metaGet(env, 'error'), metaGet(env, 'rr'), env.DB.prepare('SELECT last_upload AS v FROM users WHERE uid = ?1').bind(me.uid)];
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
  const [err, rr, u] = rest;
  let cronAt = 0; try { cronAt = Number(JSON.parse(firstV(rr) || '{}').at) || 0; } catch (e) { /* none yet */ }
  return rawJson(`{"rows":${rowsJson},"until":${until},"error":${firstV(err) || 'null'},"cronAt":${cronAt},` +
    `"lastUpload":${Number(firstV(u)) || 0},"now":${now()}}`);
}

async function checkNow(req, env, me, url) {
  if (!isJson(req)) return json({ error: 'JSON body required' }, 415);
  if (req.headers.get('Origin') !== url.origin) return json({ error: 'Wrong origin' }, 403);
  let body; try { body = await req.json(); } catch (e) { return json({ error: 'Bad JSON' }, 400); }
  let ids = validIds(body && body.ids);
  if (!ids) return json({ error: 'ids must be 1 to 30 player ids (digits only)' }, 400);
  if (!env.TORN_API_KEY) return json({ checked: 0, partial: true, error: 'The site owner has not set TORN_API_KEY yet' });
  const t = now(), win = Math.floor(t / CHECK_WINDOW);
  const [mine, cool, used] = await env.DB.batch([
    env.DB.prepare(`SELECT s.id AS seller, s.is_open, s.has_bazaar, s.missing FROM status s
                    WHERE s.id IN (SELECT value FROM json_each(?2)) AND s.id IN ${MY_SELLERS}`).bind(me.uid, JSON.stringify(ids)),
    metaGet(env, 'cool:' + me.uid), metaGet(env, 'win:' + win)
  ]);
  ids = mine.results.map(r => r.seller); // only sellers this user bought from
  const wait = USER_COOLDOWN - (t - (Number(firstV(cool)) || 0));
  if (wait > 0) return json({ checked: 0, partial: true, error: `Please wait ${wait}s`, wait }, 429);
  const room = CHECK_WINDOW - (Number(firstV(used)) || 0);
  if (room <= 0) { const w = CHECK_WINDOW - (t % CHECK_WINDOW); return json({ checked: 0, partial: true, error: `Busy, try again in ${w}s`, wait: w }, 429); }
  ids = ids.slice(0, room);
  await env.DB.batch([metaSet(env, 'cool:' + me.uid, t), metaSet(env, 'win:' + win, (Number(firstV(used)) || 0) + ids.length),
    env.DB.prepare("DELETE FROM meta WHERE k LIKE 'win:%' AND k <> ?1").bind('win:' + win)]);
  const old = new Map(mine.results.map(r => [r.seller, r]));
  const out = await runJobs(env, ids.map(id => ({ kind: 'bazaar', id })));
  const st = saveStatements(env, out, old);
  if (st.length) await env.DB.batch(st);
  return json({ checked: out.bazaar.length, partial: out.bazaar.length < ids.length, error: out.fatal || (out.rate ? 'Torn says too many requests, try again in a minute' : null) });
}

// Daily counters for one player (uploads, purchases, new sellers, top-100 updates).
async function dayCounter(env, uid) {
  let q = {}; try { q = JSON.parse(firstV(await metaGet(env, 'day:' + uid).run()) || '{}'); } catch (e) { /* start over */ }
  const d = Math.floor(now() / 86400);
  return q.d === d ? q : { d, uploads: 0, purchases: 0, sellers: 0, tops: 0 };
}
const capMsg = what => `Daily limit for one player reached (${what}). The rest is sent automatically after midnight UTC.`;

// Purchases from the userscript: one bundle row per upload. The page skips any purchase it already has (same log id).
async function upload(req, env, me) {
  if (!isJson(req)) return json({ error: 'JSON body required' }, 415);
  if (Number(req.headers.get('Content-Length') || 0) > 4e6) return json({ error: 'Too large, send smaller chunks' }, 413);
  let body; try { body = await req.json(); } catch (e) { return json({ error: 'Bad JSON' }, 400); }
  const buys = (Array.isArray(body && body.buys) ? body.buys : []).map(validBuy).filter(Boolean);
  if (buys.length > 2000) return json({ error: 'At most 2000 purchases per request' }, 413);
  const q = await dayCounter(env, me.uid);
  const S = JSON.stringify([...new Set(buys.map(b => b.s))]);
  let fresh = 0;
  if (buys.length) fresh = (await env.DB.prepare('SELECT COUNT(*) AS n FROM json_each(?1) WHERE value NOT IN (SELECT id FROM status)').bind(S).first()).n;
  if (q.uploads + 1 > DAY_CAP.uploads) return json({ error: capMsg('uploads') }, 429);
  if (q.purchases + buys.length > DAY_CAP.purchases) return json({ error: capMsg('purchases') }, 429);
  if (q.sellers + fresh > DAY_CAP.sellers) return json({ error: capMsg('new sellers') }, 429);
  q.uploads++; q.purchases += buys.length; q.sellers += fresh;
  const st = [];
  if (buys.length) st.push(
    env.DB.prepare('INSERT INTO pbatches (uid, n, data) VALUES (?1, ?2, ?3)').bind(me.uid, buys.length, JSON.stringify(buys.map(b => [b.ts, b.s, b.it, b.ce, b.ct, b.id]))),
    env.DB.prepare(`INSERT INTO usets (uid, sellers) VALUES (?1, ?2) ON CONFLICT(uid) DO UPDATE SET sellers =
        (SELECT json_group_array(value) FROM (SELECT value FROM json_each(usets.sellers) UNION SELECT value FROM json_each(excluded.sellers)))`).bind(me.uid, S),
    env.DB.prepare('INSERT OR IGNORE INTO status (id) SELECT value FROM json_each(?1)').bind(S));
  st.push(env.DB.prepare('UPDATE users SET last_upload = ?2 WHERE uid = ?1').bind(me.uid, now()), metaSet(env, 'day:' + me.uid, JSON.stringify(q)));
  await env.DB.batch(st);
  return json({ ok: true, received: buys.length, inserted: buys.length });
}
// Your page works out your top 100 sellers and sends it here; only the differences are written.
// A seller in anyone's top 100 is checked more often (kind 1).
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
    env.DB.prepare(`UPDATE status SET top = EXISTS (SELECT 1 FROM tops x WHERE x.seller = status.id),
                      kind = ${KIND_SQL('EXISTS (SELECT 1 FROM tops x WHERE x.seller = status.id)')}
                    WHERE id IN (SELECT value FROM json_each(?1)) AND top <> EXISTS (SELECT 1 FROM tops x WHERE x.seller = status.id)`).bind(JSON.stringify(add.concat(del))),
    metaSet(env, 'day:' + me.uid, JSON.stringify(q))
  ]);
  return json({ ok: true, changed: add.length + del.length });
}
// Deletes everything stored for this user. Their sellers stay in the shared bazaar list (public info) but drop out of the top tier.
async function forget(env, me) {
  await env.DB.batch([
    env.DB.prepare(`UPDATE status SET top = EXISTS (SELECT 1 FROM tops x WHERE x.seller = status.id AND x.uid <> ?1),
                      kind = ${KIND_SQL('EXISTS (SELECT 1 FROM tops x WHERE x.seller = status.id AND x.uid <> ?1)')}
                    WHERE id IN (SELECT seller FROM tops WHERE uid = ?1)`).bind(me.uid),
    env.DB.prepare('DELETE FROM pbatches WHERE uid = ?1').bind(me.uid),
    env.DB.prepare('DELETE FROM usets WHERE uid = ?1').bind(me.uid),
    env.DB.prepare('DELETE FROM tops WHERE uid = ?1').bind(me.uid),
    env.DB.prepare('DELETE FROM sessions WHERE uid = ?1').bind(me.uid),
    env.DB.prepare('DELETE FROM users WHERE uid = ?1').bind(me.uid),
    env.DB.prepare('DELETE FROM meta WHERE k IN (?1, ?2, ?3, ?4)').bind('set:' + me.uid, 'cool:' + me.uid, 'retop:' + me.uid, 'day:' + me.uid)
  ]);
  return json({ ok: true });
}

// Raw Torn bazaar replies for 3 of this user's sellers, to confirm the open flag before relying on it.
async function probe(env, me) {
  const ids = (await env.DB.prepare('SELECT value AS seller FROM json_each((SELECT sellers FROM usets WHERE uid = ?1)) LIMIT 3').bind(me.uid).all()).results.map(r => r.seller);
  const out = {};
  for (const id of ids) {
    const r = await fetch(`${env.TORN_BASE || 'https://api.torn.com/v2'}/user/${id}/bazaar?key=${encodeURIComponent(env.TORN_API_KEY || '')}`);
    const text = await r.text();
    let raw; try { raw = JSON.parse(text); } catch (e) { raw = text.slice(0, 500); }
    out[id] = { http: r.status, raw, read_as: parseBazaar(raw) };
  }
  return json(out);
}

// The site key works whatever capitals its name was saved with (TORN_API_KEY, Torn_api_key, ...).
function withSiteKey(env) {
  if (env.TORN_API_KEY) return env;
  const name = Object.keys(env).find(n => n.toLowerCase() === 'torn_api_key');
  return name ? Object.assign({}, env, { TORN_API_KEY: env[name] }) : env;
}

export default {
  // Only /api/* reaches this code; the page itself is served straight from public/.
  async fetch(req, env) {
    env = withSiteKey(env);
    const url = new URL(req.url), p = url.pathname, m = req.method;
    if (!p.startsWith('/api/')) return env.ASSETS.fetch(req);
    try { return await handle(req, env, url, p, m); }
    catch (e) {
      console.error('api error', p, e && e.stack || e);
      const msg = String(e && e.message || e);
      const limit = /limit|exceeded|quota/i.test(msg);
      return json({ error: limit ? 'The site is over its free daily database limit. It resets at midnight UTC; please try again later.' : 'Server error: ' + msg.slice(0, 200) }, limit ? 503 : 500);
    }
  },
  async scheduled(event, env) {
    env = withSiteKey(env);
    try { await withSchema(env, () => cron(env, event && event.scheduledTime)); }
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
      return json(Object.assign({}, me, { hasPurchases: has, purchases: has ? 1 : 0, settings: await getSettings(env, me.uid) }));
    }
    if (p === '/api/data' && m === 'GET') return getData(env, me, Math.max(0, Number(url.searchParams.get('after')) || 0));
    if (p === '/api/status' && m === 'GET') return getStatus(env, me, Math.max(0, Number(url.searchParams.get('since')) || 0));
    if (p === '/api/check-now' && m === 'POST') return checkNow(req.clone(), env, me, url);
    if (p === '/api/purchases' && m === 'POST') return upload(req.clone(), env, me);
    if (p === '/api/tops' && m === 'POST') return putTops(req.clone(), env, me);
    if (p === '/api/logout' && m === 'POST') {
      await env.DB.prepare('DELETE FROM sessions WHERE hash = ?1').bind(await sha256hex(bearer(req.headers.get('Authorization')))).run();
      return json({ ok: true });
    }
    if (p === '/api/forget' && m === 'POST') return forget(env, me);
    if (p === '/api/settings' && m === 'GET') return json(await getSettings(env, me.uid));
    if (p === '/api/settings' && m === 'POST') return putSettings(req.clone(), env, me);
    if (p === '/api/probe' && m === 'GET') return probe(env, me);
    return json({ error: 'Not found' }, 404);
  });
}
