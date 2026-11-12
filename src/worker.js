// Gilded Compass Worker: serves the page behind a password, stores purchases (D1),
// and keeps bazaar Open/Closed flags and usernames fresh with a cron job (Torn Public key).
import {
  aggregate, byRank, parseBazaar, parseName, pickDue, validIds, validBuy, safeEqual, basicPassword,
  TOP_TIER, MAX_TORN_PER_RUN, PARALLEL, MAX_NAMES_PER_RUN
} from './logic.mjs';

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS purchases (id TEXT PRIMARY KEY, ts INTEGER NOT NULL, seller INTEGER NOT NULL, items TEXT NOT NULL, ce REAL, ct REAL)',
  'CREATE TABLE IF NOT EXISTS status (id INTEGER PRIMARY KEY, is_open INTEGER, has_bazaar INTEGER, missing INTEGER NOT NULL DEFAULT 0, t INTEGER NOT NULL DEFAULT 0, tier INTEGER NOT NULL DEFAULT 2, name TEXT, name_t INTEGER NOT NULL DEFAULT 0)',
  'CREATE INDEX IF NOT EXISTS status_tier_t ON status(tier, t)',
  'CREATE INDEX IF NOT EXISTS status_t ON status(t)',
  'CREATE INDEX IF NOT EXISTS status_name ON status(name_t, tier)',
  'CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)'
];
const FATAL_CODES = new Set([1, 2, 10, 13, 16, 18]); // key missing, wrong, owner jailed, inactive, too low, paused
const COOLDOWN = 30;
const now = () => Math.floor(Date.now() / 1000);
const SECURITY = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...SECURITY } });
}
// Run fn; if the tables do not exist yet (first ever run), create them and try once more.
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

/* ---------- Torn ---------- */
async function torn(env, path) {
  const base = env.TORN_BASE || 'https://api.torn.com/v2';
  let r;
  try { r = await fetch(`${base}${path}${path.includes('?') ? '&' : '?'}key=${encodeURIComponent(env.TORN_API_KEY || '')}`, { headers: { 'User-Agent': 'GildedCompass' } }); }
  catch (e) { return { retry: true }; }
  if (r.status === 429) return { rate: true };
  if (r.status >= 500) return { retry: true };
  let j; try { j = await r.json(); } catch (e) { return { retry: true }; }
  const er = j && j.error;
  if (er) {
    if (er.code === 5) return { rate: true };
    if (er.code === 6 || er.code === 7) return { missing: true };
    if (FATAL_CODES.has(er.code)) return { fatal: `Torn error ${er.code}: ${er.error}` };
    return { retry: true, err: `Torn error ${er.code}: ${er.error}` };
  }
  return { data: j };
}

// Runs jobs (bazaar or name lookups) 10 at a time. Stops early when Torn says too many requests or the key is bad.
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
      if (j.kind === 'name') {
        names.push([j.id, r.missing ? '(not found)' : (parseName(r.data) || '(unknown)'), r.missing ? 1 : 0, t]);
      } else {
        const b = r.missing ? { is_open: 0, has_bazaar: 0 } : parseBazaar(r.data);
        if (b) bazaar.push([j.id, b.is_open, b.has_bazaar, r.missing ? 1 : 0, t]);
      }
    });
  }
  return { bazaar, names, rate, fatal, done };
}
// One D1 call that saves every result (UPDATE only: ids not in the directory are never added).
function saveStatements(env, out) {
  const st = [];
  if (out.bazaar.length) st.push(env.DB.prepare(
    `UPDATE status SET is_open = json_extract(j.value, '$[1]'), has_bazaar = json_extract(j.value, '$[2]'), missing = json_extract(j.value, '$[3]'), t = json_extract(j.value, '$[4]')
     FROM json_each(?1) AS j WHERE status.id = json_extract(j.value, '$[0]')`).bind(JSON.stringify(out.bazaar)));
  if (out.names.length) st.push(env.DB.prepare(
    `UPDATE status SET name = json_extract(j.value, '$[1]'), missing = MAX(missing, json_extract(j.value, '$[2]')), name_t = json_extract(j.value, '$[3]')
     FROM json_each(?1) AS j WHERE status.id = json_extract(j.value, '$[0]')`).bind(JSON.stringify(out.names)));
  if (out.fatal) st.push(metaSet(env, 'error', JSON.stringify({ msg: out.fatal, t: now() })));
  else if (out.done) st.push(env.DB.prepare("DELETE FROM meta WHERE k = 'error'"));
  return st;
}

/* ---------- cron: every minute ---------- */
// Subrequest budget (free plan: 50): 1 D1 read + up to 36 Torn calls + 1 D1 write = 38.
async function cron(env) {
  if (!env.TORN_API_KEY) return;
  const [t1, t2, unnamed] = (await env.DB.batch([
    env.DB.prepare('SELECT id, t, tier FROM status WHERE tier = 1 ORDER BY t LIMIT ?1').bind(MAX_TORN_PER_RUN),
    env.DB.prepare('SELECT id, t, tier FROM status WHERE tier = 2 ORDER BY t LIMIT ?1').bind(MAX_TORN_PER_RUN),
    env.DB.prepare('SELECT id FROM status WHERE name_t = 0 ORDER BY tier, id LIMIT ?1').bind(MAX_NAMES_PER_RUN)
  ])).map(r => r.results);
  const nameJobs = unnamed.map(r => ({ kind: 'name', id: r.id }));
  const due = pickDue(t1.concat(t2), now(), MAX_TORN_PER_RUN - nameJobs.length);
  const jobs = nameJobs.concat(due.map(id => ({ kind: 'bazaar', id })));
  const out = jobs.length ? await runJobs(env, jobs) : { bazaar: [], names: [], done: 0 };
  await env.DB.batch(saveStatements(env, out).concat(metaSet(env, 'cronAt', now())));
}

/* ---------- routes ---------- */
async function getData(env) {
  const [p, items, up] = await env.DB.batch([
    env.DB.prepare('SELECT ts, seller, items, ce, ct FROM purchases'),
    metaGet(env, 'items'), metaGet(env, 'lastUpload')
  ]);
  const itemTypes = JSON.parse(firstV(items) || '{}');
  const { sellers, typeTotals } = aggregate(p.results, itemTypes);
  return { sellers, typeTotals, purchases: p.results.length, lastUpload: Number(firstV(up)) || 0, now: now() };
}

async function getStatus(env, since) {
  const [rows, err, cronAt, up] = await env.DB.batch([
    env.DB.prepare(`SELECT id, is_open, has_bazaar, missing, t, name, name_t FROM status WHERE t >= ?1 AND t > 0
                    UNION SELECT id, is_open, has_bazaar, missing, t, name, name_t FROM status WHERE name_t >= ?1 AND name_t > 0`).bind(since),
    metaGet(env, 'error'), metaGet(env, 'cronAt'), metaGet(env, 'lastUpload')
  ]);
  return {
    rows: rows.results.map(r => [r.id, r.is_open, r.has_bazaar, r.missing, r.t, r.name, r.name_t]),
    error: firstV(err) ? JSON.parse(firstV(err)) : null,
    cronAt: Number(firstV(cronAt)) || 0, lastUpload: Number(firstV(up)) || 0, now: now()
  };
}

async function checkNow(req, env, url) {
  if (!/^application\/json\b/i.test(req.headers.get('Content-Type') || '')) return json({ error: 'JSON body required' }, 415);
  if (req.headers.get('Origin') !== url.origin) return json({ error: 'Wrong origin' }, 403);
  let body; try { body = await req.json(); } catch (e) { return json({ error: 'Bad JSON' }, 400); }
  const ids = validIds(body && body.ids);
  if (!ids) return json({ error: 'ids must be 1 to 30 player ids (digits only)' }, 400);
  if (!env.TORN_API_KEY) return json({ checked: 0, partial: true, error: 'TORN_API_KEY secret is not set' });
  const last = Number(firstV(await metaGet(env, 'cooldown').run())) || 0;
  const wait = COOLDOWN - (now() - last);
  if (wait > 0) return json({ checked: 0, partial: true, error: `Please wait ${wait}s`, wait }, 429);
  await metaSet(env, 'cooldown', now()).run();
  const out = await runJobs(env, ids.map(id => ({ kind: 'bazaar', id })));
  const st = saveStatements(env, out);
  if (st.length) await env.DB.batch(st);
  return json({ checked: out.bazaar.length, partial: out.bazaar.length < ids.length, error: out.fatal || (out.rate ? 'Torn says too many requests, try again in a minute' : null) });
}

// Purchases from the userscript. Saving is idempotent (same log id = same purchase).
async function upload(req, env) {
  if (!/^application\/json\b/i.test(req.headers.get('Content-Type') || '')) return json({ error: 'JSON body required' }, 415);
  if (Number(req.headers.get('Content-Length') || 0) > 4e6) return json({ error: 'Too large, send smaller chunks' }, 413);
  let body; try { body = await req.json(); } catch (e) { return json({ error: 'Bad JSON' }, 400); }
  const buys = (Array.isArray(body && body.buys) ? body.buys : []).map(validBuy).filter(Boolean);
  if (buys.length > 5000) return json({ error: 'At most 5000 purchases per request' }, 413);
  const st = [];
  if (buys.length) st.push(env.DB.prepare(
    `INSERT OR IGNORE INTO purchases (id, ts, seller, items, ce, ct)
     SELECT json_extract(value, '$.id'), json_extract(value, '$.ts'), json_extract(value, '$.s'), json(json_extract(value, '$.it')), json_extract(value, '$.ce'), json_extract(value, '$.ct')
     FROM json_each(?1)`).bind(JSON.stringify(buys)));
  if (body && body.items && typeof body.items === 'object' && !Array.isArray(body.items)) st.push(metaSet(env, 'items', JSON.stringify(body.items)));
  st.push(metaSet(env, 'lastUpload', now()));
  const res = await env.DB.batch(st);
  const inserted = buys.length ? res[0].meta.changes : 0;
  if (inserted || (body && body.items)) await rerank(env);
  return json({ ok: true, received: buys.length, inserted });
}
// Top 100 sellers by purchases (then items) become tier 1. New sellers get a status row. Only changed rows are written.
async function rerank(env) {
  const [p, cur] = await env.DB.batch([
    env.DB.prepare('SELECT seller, items, ce, ct, ts FROM purchases'),
    env.DB.prepare('SELECT id, tier FROM status')
  ]);
  const ranked = aggregate(p.results, {}).sellers.sort(byRank(s => s.tot));
  const have = new Map(cur.results.map(r => [r.id, r.tier]));
  const changes = [];
  ranked.forEach((s, i) => { const tier = i < TOP_TIER ? 1 : 2; if (have.get(s.id) !== tier) changes.push([s.id, tier]); });
  if (!changes.length) return;
  await env.DB.prepare(
    `INSERT INTO status (id, tier) SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?1) WHERE true
     ON CONFLICT(id) DO UPDATE SET tier = excluded.tier`).bind(JSON.stringify(changes)).run();
}

// Shows Torn's raw bazaar replies for 3 sellers, to confirm the open flag before relying on it.
async function probe(env, url) {
  let ids = validIds((url.searchParams.get('ids') || '').split(',').filter(Boolean), 3);
  if (!ids) ids = (await env.DB.prepare('SELECT id FROM status WHERE tier = 1 ORDER BY id LIMIT 3').all()).results.map(r => r.id);
  const out = {};
  for (const id of ids) {
    const base = env.TORN_BASE || 'https://api.torn.com/v2';
    const r = await fetch(`${base}/user/${id}/bazaar?key=${encodeURIComponent(env.TORN_API_KEY || '')}`);
    const text = await r.text();
    let raw; try { raw = JSON.parse(text); } catch (e) { raw = text.slice(0, 500); }
    out[id] = { http: r.status, raw, read_as: parseBazaar(raw) };
  }
  return json(out);
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (!env.PAGE_PASSWORD) return new Response('PAGE_PASSWORD secret is not set yet.', { status: 503, headers: SECURITY });
    const pw = basicPassword(req.headers.get('Authorization'));
    if (pw == null || !(await safeEqual(pw, env.PAGE_PASSWORD))) {
      return new Response('Password required', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Gilded Compass", charset="UTF-8"', 'Cache-Control': 'no-store', ...SECURITY } });
    }
    const m = req.method, p = url.pathname;
    const api = await withSchema(env, async () => {
      if (p === '/data.json' && m === 'GET') return json(await getData(env));
      if (p === '/status.json' && m === 'GET') return json(await getStatus(env, Math.max(0, Number(url.searchParams.get('since')) || 0)));
      if (p === '/check-now' && m === 'POST') return checkNow(req.clone(), env, url);
      if (p === '/api/purchases' && m === 'POST') return upload(req.clone(), env);
      if (p === '/api/ping') return json({ ok: true });
      if (p === '/probe' && m === 'GET') return probe(env, url);
      return null;
    });
    if (api) return api;
    const res = await env.ASSETS.fetch(req);
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(SECURITY)) out.headers.set(k, v);
    if ((out.headers.get('Content-Type') || '').includes('text/html')) out.headers.set('Cache-Control', 'no-cache');
    return out;
  },
  async scheduled(event, env, ctx) {
    await withSchema(env, () => cron(env));
  }
};
