// Gilded Compass Worker (multi-user).
// - Anyone signs in with their own Torn API key: the key is used once to ask Torn who they are, then forgotten.
//   They get a random sign-in token; only its hash is stored.
// - Each user's bazaar purchases (sent by the userscript) are stored under their player id and only shown to them.
// - A cron job keeps bazaar Open/Closed flags and usernames fresh with the site's own Public key (TORN_API_KEY).
import {
  parseBazaar, parseName, pickDue, validIds, validBuy, newToken, sha256hex, bearer, looksLikeKey,
  TOP_TIER, MAX_TORN_PER_RUN, PARALLEL, MAX_NAMES_PER_RUN
} from './logic.mjs';

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS users (uid INTEGER PRIMARY KEY, name TEXT, created INTEGER NOT NULL, last_upload INTEGER NOT NULL DEFAULT 0)',
  'CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, uid INTEGER NOT NULL, created INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS sessions_uid ON sessions(uid)',
  'CREATE TABLE IF NOT EXISTS purchases (uid INTEGER NOT NULL, id TEXT NOT NULL, ts INTEGER NOT NULL, seller INTEGER NOT NULL, items TEXT NOT NULL, ce REAL, ct REAL, PRIMARY KEY (uid, id))',
  'CREATE TABLE IF NOT EXISTS user_sellers (uid INTEGER NOT NULL, seller INTEGER NOT NULL, top INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (uid, seller))',
  'CREATE INDEX IF NOT EXISTS user_sellers_seller ON user_sellers(seller, top)',
  'CREATE TABLE IF NOT EXISTS status (id INTEGER PRIMARY KEY, is_open INTEGER, has_bazaar INTEGER, missing INTEGER NOT NULL DEFAULT 0, t INTEGER NOT NULL DEFAULT 0, top INTEGER NOT NULL DEFAULT 0, kind INTEGER NOT NULL DEFAULT 2, name TEXT, name_t INTEGER NOT NULL DEFAULT 0)',
  'CREATE INDEX IF NOT EXISTS status_kind_t ON status(kind, t)',
  'CREATE INDEX IF NOT EXISTS status_t ON status(t)',
  'CREATE INDEX IF NOT EXISTS status_name ON status(name_t, kind)',
  'CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)'
];
const FATAL_CODES = new Set([1, 2, 10, 13, 16, 18]); // key missing, wrong, owner jailed, inactive, too low, paused
const SESSION_DAYS = 180;
const USER_COOLDOWN = 30;      // seconds between one user's Check now presses
const CHECK_WINDOW = 30;       // all users together: at most 30 Check now lookups per 30 s (cron adds 36/min: under Torn's 100/min)
const CHUNK_ROWS = 20000; // purchases per database read (keeps each reply well under D1's 2 MB limit)
const now = () => Math.floor(Date.now() / 1000);
const HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: HEADERS });
// Free Workers get about 10 ms of CPU per request, so big replies are built as JSON text by the database
// and only glued together here (no parsing or looping over thousands of rows).
const rawJson = text => new Response(text, { headers: HEADERS });
const inner = arr => (arr && arr.length > 2 ? arr.slice(1, -1) : ''); // "[a,b]" -> "a,b"

async function withSchema(env, fn) {
  try { return await fn(); }
  catch (e) {
    if (!/no such table/i.test(String(e && e.message))) throw e;
    await env.DB.batch(SCHEMA.map(s => env.DB.prepare(s)));
    return fn();
  }
}
const metaSet = (env, k, v) => env.DB.prepare('INSERT INTO meta (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(k, v == null ? null : String(v));
const metaGet = (env, k) => env.DB.prepare('SELECT v FROM meta WHERE k = ?1').bind(k);
const firstV = r => (r && r.results && r.results[0] ? r.results[0].v : null);
const isJson = req => /^application\/json\b/i.test(req.headers.get('Content-Type') || '');

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
// Saves results (UPDATE only: ids not already tracked are never added). kind decides how often a seller is checked next.
function saveStatements(env, out) {
  const st = [];
  if (out.bazaar.length) st.push(env.DB.prepare(
    `UPDATE status SET is_open = json_extract(j.value, '$[1]'), has_bazaar = json_extract(j.value, '$[2]'),
       missing = MAX(missing, json_extract(j.value, '$[3]')), t = json_extract(j.value, '$[4]'),
       kind = CASE WHEN MAX(missing, json_extract(j.value, '$[3]')) = 1 THEN 0 WHEN json_extract(j.value, '$[2]') = 0 THEN 3 WHEN top = 1 THEN 1 ELSE 2 END
     FROM json_each(?1) AS j WHERE status.id = json_extract(j.value, '$[0]')`).bind(JSON.stringify(out.bazaar)));
  if (out.names.length) st.push(env.DB.prepare(
    `UPDATE status SET name = json_extract(j.value, '$[1]'), missing = MAX(missing, json_extract(j.value, '$[2]')), name_t = json_extract(j.value, '$[3]'),
       kind = CASE WHEN MAX(missing, json_extract(j.value, '$[2]')) = 1 THEN 0 ELSE kind END
     FROM json_each(?1) AS j WHERE status.id = json_extract(j.value, '$[0]')`).bind(JSON.stringify(out.names)));
  if (out.fatal) st.push(metaSet(env, 'error', JSON.stringify({ msg: out.fatal, t: now() })));
  else if (out.done) st.push(env.DB.prepare("DELETE FROM meta WHERE k = 'error'"));
  return st;
}

/* ---------- cron: every minute ---------- */
// Subrequests (free plan allows 50): 1 D1 read + at most 36 Torn calls + 1 D1 write.
async function cron(env, scheduledTime) {
  if (!env.TORN_API_KEY) return;
  const [k1, k2, k3, unnamed, itemsAt] = await env.DB.batch([
    env.DB.prepare('SELECT id, t, kind AS tier FROM status WHERE kind = 1 ORDER BY t LIMIT ?1').bind(MAX_TORN_PER_RUN),
    env.DB.prepare('SELECT id, t, kind AS tier FROM status WHERE kind = 2 ORDER BY t LIMIT ?1').bind(MAX_TORN_PER_RUN),
    env.DB.prepare('SELECT id, t, kind AS tier FROM status WHERE kind = 3 ORDER BY t LIMIT ?1').bind(MAX_TORN_PER_RUN),
    env.DB.prepare('SELECT id FROM status WHERE name_t = 0 AND kind > 0 ORDER BY kind, id LIMIT ?1').bind(MAX_NAMES_PER_RUN),
    metaGet(env, 'itemsAt')
  ]);
  const st = [];
  let budget = MAX_TORN_PER_RUN;
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
  const nameJobs = unnamed.results.slice(0, budget).map(r => ({ kind: 'name', id: r.id }));
  const due = pickDue(k1.results.concat(k2.results, k3.results), now(), budget - nameJobs.length);
  const jobs = nameJobs.concat(due.map(id => ({ kind: 'bazaar', id })));
  const out = jobs.length ? await runJobs(env, jobs) : { bazaar: [], names: [], done: 0 };
  st.push(...saveStatements(env, out), metaSet(env, 'cronAt', now()));
  if (new Date(scheduledTime || Date.now()).getUTCMinutes() === 0) {
    st.push(env.DB.prepare('DELETE FROM sessions WHERE created < ?1').bind(now() - SESSION_DAYS * 86400));
  }
  await env.DB.batch(st);
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

/* ---------- the user's data ---------- */
// Raw purchases [ts, seller, items, cost_each, cost_total] plus Torn's item list; the browser adds them up.
async function getData(env, me) {
  const parts = [];
  let after = 0;
  for (;;) {
    const r = await env.DB.prepare(`SELECT json_group_array(json_array(ts, seller, json(items), ce, ct)) AS j, MAX(r) AS last, COUNT(*) AS n FROM
        (SELECT rowid AS r, ts, seller, items, ce, ct FROM purchases WHERE uid = ?1 AND rowid > ?2 ORDER BY rowid LIMIT ?3)`)
      .bind(me.uid, after, CHUNK_ROWS).first();
    if (r && r.n) parts.push(inner(r.j));
    if (!r || r.n < CHUNK_ROWS) break;
    after = r.last;
  }
  const [items, u] = await env.DB.batch([metaGet(env, 'items'), env.DB.prepare('SELECT last_upload AS v FROM users WHERE uid = ?1').bind(me.uid)]);
  return rawJson(`{"me":${JSON.stringify(me)},"purchases":[${parts.filter(Boolean).join(',')}],"items":${firstV(items) || '{}'},` +
    `"lastUpload":${Number(firstV(u)) || 0},"now":${now()}}`);
}
// Only this user's sellers, only rows changed since `since`.
async function getStatus(env, me, since) {
  const [rows, err, cronAt, u] = await env.DB.batch([
    env.DB.prepare(`SELECT json_group_array(json_array(id, is_open, has_bazaar, missing, t, name, name_t)) AS v FROM status s
                    WHERE ((s.t >= ?2 AND s.t > 0) OR (s.name_t >= ?2 AND s.name_t > 0))
                      AND EXISTS (SELECT 1 FROM user_sellers us WHERE us.uid = ?1 AND us.seller = s.id)`).bind(me.uid, since),
    metaGet(env, 'error'), metaGet(env, 'cronAt'),
    env.DB.prepare('SELECT last_upload AS v FROM users WHERE uid = ?1').bind(me.uid)
  ]);
  return rawJson(`{"rows":${firstV(rows) || '[]'},"error":${firstV(err) || 'null'},"cronAt":${Number(firstV(cronAt)) || 0},` +
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
    env.DB.prepare('SELECT seller FROM user_sellers WHERE uid = ?1 AND seller IN (SELECT value FROM json_each(?2))').bind(me.uid, JSON.stringify(ids)),
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
  const out = await runJobs(env, ids.map(id => ({ kind: 'bazaar', id })));
  const st = saveStatements(env, out);
  if (st.length) await env.DB.batch(st);
  return json({ checked: out.bazaar.length, partial: out.bazaar.length < ids.length, error: out.fatal || (out.rate ? 'Torn says too many requests, try again in a minute' : null) });
}

// Purchases from the userscript. Saving is idempotent (same log id = same purchase).
async function upload(req, env, me) {
  if (!isJson(req)) return json({ error: 'JSON body required' }, 415);
  if (Number(req.headers.get('Content-Length') || 0) > 4e6) return json({ error: 'Too large, send smaller chunks' }, 413);
  let body; try { body = await req.json(); } catch (e) { return json({ error: 'Bad JSON' }, 400); }
  const buys = (Array.isArray(body && body.buys) ? body.buys : []).map(validBuy).filter(Boolean);
  if (buys.length > 5000) return json({ error: 'At most 5000 purchases per request' }, 413);
  const sellers = [...new Set(buys.map(b => b.s))];
  const st = [env.DB.prepare('UPDATE users SET last_upload = ?2 WHERE uid = ?1').bind(me.uid, now())];
  if (buys.length) {
    const B = JSON.stringify(buys), S = JSON.stringify(sellers);
    st.unshift(
      env.DB.prepare(`INSERT OR IGNORE INTO purchases (uid, id, ts, seller, items, ce, ct)
        SELECT ?1, json_extract(value, '$.id'), json_extract(value, '$.ts'), json_extract(value, '$.s'), json(json_extract(value, '$.it')), json_extract(value, '$.ce'), json_extract(value, '$.ct')
        FROM json_each(?2)`).bind(me.uid, B),
      env.DB.prepare('INSERT OR IGNORE INTO user_sellers (uid, seller) SELECT ?1, value FROM json_each(?2)').bind(me.uid, S),
      env.DB.prepare('INSERT OR IGNORE INTO status (id) SELECT value FROM json_each(?1)').bind(S));
  }
  const res = await env.DB.batch(st);
  const inserted = buys.length ? res[0].meta.changes : 0;
  if (inserted) await retop(env, me.uid);
  return json({ ok: true, received: buys.length, inserted });
}
// This user's top 100 sellers (purchases, then items). A seller in anyone's top 100 is checked about every 5 minutes.
// All done inside the database, so it costs the Worker no CPU however many purchases there are.
const STATUS_TOP_SQL = (exclude) => `UPDATE status SET top = n.top,
      kind = CASE WHEN status.missing = 1 THEN 0 WHEN status.has_bazaar = 0 THEN 3 WHEN n.top = 1 THEN 1 ELSE 2 END
    FROM (SELECT us.seller AS id, EXISTS (SELECT 1 FROM user_sellers x WHERE x.seller = us.seller AND x.top = 1${exclude ? ' AND x.uid <> ?1' : ''}) AS top
          FROM user_sellers us WHERE us.uid = ?1) AS n
    WHERE status.id = n.id AND status.top <> n.top`;
async function retop(env, uid) {
  await env.DB.batch([
    env.DB.prepare(`WITH ranked AS (
        SELECT p.seller AS seller FROM purchases p, json_each(p.items) j WHERE p.uid = ?1
        GROUP BY p.seller ORDER BY COUNT(DISTINCT p.id) DESC, SUM(json_extract(j.value, '$[1]')) DESC, p.seller LIMIT ?2)
      UPDATE user_sellers SET top = (seller IN (SELECT seller FROM ranked))
      WHERE uid = ?1 AND top <> (seller IN (SELECT seller FROM ranked))`).bind(uid, TOP_TIER),
    env.DB.prepare(STATUS_TOP_SQL(false)).bind(uid)
  ]);
}
// Deletes everything stored for this user. Their sellers stay in the shared bazaar list (public info) but drop out of the top tier.
async function forget(env, me) {
  await env.DB.batch([
    env.DB.prepare(STATUS_TOP_SQL(true)).bind(me.uid),
    env.DB.prepare('DELETE FROM purchases WHERE uid = ?1').bind(me.uid),
    env.DB.prepare('DELETE FROM user_sellers WHERE uid = ?1').bind(me.uid),
    env.DB.prepare('DELETE FROM sessions WHERE uid = ?1').bind(me.uid),
    env.DB.prepare('DELETE FROM users WHERE uid = ?1').bind(me.uid)
  ]);
  return json({ ok: true });
}

// Raw Torn bazaar replies for this user's top 3 sellers, to confirm the open flag before relying on it.
async function probe(env, me) {
  const ids = (await env.DB.prepare('SELECT seller FROM user_sellers WHERE uid = ?1 ORDER BY top DESC, seller LIMIT 3').bind(me.uid).all()).results.map(r => r.seller);
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
    return withSchema(env, async () => {
      if (p === '/api/login' && m === 'POST') return login(req.clone(), env);
      const me = await signedIn(req, env);
      if (!me) return json({ error: 'Please sign in' }, 401);
      if (p === '/api/me' && m === 'GET') return json(me);
      if (p === '/api/data' && m === 'GET') return getData(env, me);
      if (p === '/api/status' && m === 'GET') return getStatus(env, me, Math.max(0, Number(url.searchParams.get('since')) || 0));
      if (p === '/api/check-now' && m === 'POST') return checkNow(req.clone(), env, me, url);
      if (p === '/api/purchases' && m === 'POST') return upload(req.clone(), env, me);
      if (p === '/api/logout' && m === 'POST') {
        await env.DB.prepare('DELETE FROM sessions WHERE hash = ?1').bind(await sha256hex(bearer(req.headers.get('Authorization')))).run();
        return json({ ok: true });
      }
      if (p === '/api/forget' && m === 'POST') return forget(env, me);
      if (p === '/api/probe' && m === 'GET') return probe(env, me);
      return json({ error: 'Not found' }, 404);
    });
  },
  async scheduled(event, env) {
    env = withSiteKey(env);
    await withSchema(env, () => cron(env, event && event.scheduledTime));
  }
};
