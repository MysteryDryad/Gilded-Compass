// ==UserScript==
// @name         Gilded Compass
// @namespace    gilded-compass
// @version      0.5.2
// @description  Ranks the Torn bazaar sellers you buy from and shows whose bazaar is open. Reads your bazaar purchases and checks those sellers' bazaars with your own key, and sends the results to the Gilded Compass site (only you see your purchases). Read-only, never acts in the game.
// @author       MysteryDryad
// @homepageURL  https://github.com/MysteryDryad/Gilded-Compass
// @supportURL   https://github.com/MysteryDryad/Gilded-Compass/issues
// @match        https://www.torn.com/*
// @match        https://gilded-compass.mysterydryad.workers.dev/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      api.torn.com
// @connect      workers.dev
// @updateURL    https://update.greasyfork.org/scripts/605140/Gilded%20Compass.user.js
// @downloadURL  https://update.greasyfork.org/scripts/605140/Gilded%20Compass.user.js
// @run-at       document-idle
// ==/UserScript==

/*
 * GILDED COMPASS (Torn PDA and Tampermonkey/Violentmonkey)
 *
 * What it does
 * - 🧭 button on Torn: tap opens the Gilded Compass site, signed in as you. Hold it (or use the Tampermonkey menu) for your key.
 *   Everything else (how far back to look, debug sample, delete data) is under ⚙ on the Gilded Compass page.
 *   Drag it anywhere (phone and computer); where you leave it is remembered. It steps aside while a Torn pop-up (chat, menu) covers it.
 * - On the Gilded Compass page, "Check now" asks this script to read your log for new purchases first (no button there).
 * - In the background (when you tap 🧭, and every 15 minutes while Torn is open) it reads YOUR new "Bazaar buy"
 *   log entries (bazaar purchases only) and sends them to the site, where only you can see them.
 * - It checks whether the bazaars of sellers you bought from are open (and their names), with YOUR key: a few every couple
 *   of minutes while the site is open, a few every 10 minutes while Torn is open, and the ones on screen when you press
 *   Check now. These are public Torn facts; the site keeps them and shares them with other players who buy from the same sellers.
 *   It stays gentle (your key's 100 calls a minute are shared with Torn PDA and your other scripts) and backs off when Torn says so.
 *
 * Privacy and safety
 * - Read-only: it never performs game actions, clicks or purchases for you.
 * - Your Torn API key (Custom: user basic, log, bazaar; torn logtypes, items) is stored only on this device. It is sent to
 *   api.torn.com, and once to the Gilded Compass site to confirm who you are (the site does not store it). In Torn PDA it can
 *   use PDA's key.
 */
(function () {
  'use strict';

  /* ===================== environment helpers ===================== */
  const NS = 'gc_';
  const PDA_KEY = '###PDA-APIKEY###';
  const IN_PDA = PDA_KEY[0] !== '#';
  const VERSION = '0.5.2'; // keep equal to @version above (test.js checks this)
  const hasGM = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';
  const PAUSE = 1200;               // ms between log pages (Torn allows 100 calls a minute, shared with other tools)
  const AUTO_EVERY = 15 * 60000;    // background sync interval while Torn is open
  const HISTORY_DAYS = 60;          // the site keeps the last 60 days of purchases for everyone, so it never reads further back
  const CHUNK = 1000;               // purchases per upload

  // Torn PDA keeps each website's storage apart, but its PDA_storage is shared by every page this script runs on
  // (as in Arbitrage). The few things the Gilded Compass page also needs are kept there too.
  const SHARED = ['apikey', 'token', 'me', 'sync', 'btnpos', 'btnpos_phone', 'ckpos', 'ckat', 'itemsat'];
  const pda = () => (typeof PDA_storage !== 'undefined' && PDA_storage && typeof PDA_storage.get === 'function' ? PDA_storage : null);
  const cache = {};
  async function loadShared() {
    const n = pda(); if (!n) return;
    for (const k of SHARED) {
      try { const v = await n.get(NS + k, null); if (v != null && v !== '') cache[k] = typeof v === 'string' ? JSON.parse(v) : v; }
      catch (e) { /* keep this page's own copy */ }
    }
    for (const k of SHARED) if (!(k in cache)) { const v = sgetLocal(k, null); if (v != null) sset(k, v); } // first run after updating: copy across
  }
  function sget(k, d) {
    if (k in cache) return cache[k] == null || cache[k] === '' ? d : cache[k];
    return sgetLocal(k, d);
  }
  function sgetLocal(k, d) {
    try {
      const v = hasGM ? GM_getValue(NS + k) : localStorage.getItem(NS + k);
      if (v == null || v === '') return d;
      return typeof v === 'string' ? JSON.parse(v) : v;
    } catch (e) { return d; }
  }
  function sset(k, v) {
    const n = SHARED.includes(k) && pda();
    if (n) {
      cache[k] = v;
      try { Promise.resolve(n.set(NS + k, JSON.stringify(v))).catch(() => {}); } catch (e) { /* ignore */ }
    }
    try { const s = JSON.stringify(v); if (hasGM) GM_setValue(NS + k, s); else localStorage.setItem(NS + k, s); return true; }
    catch (e) { console.warn('[GC] save failed', e); return false; }
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hideKey = s => String(s).replace(/key=[A-Za-z0-9]+/g, 'key=HIDDEN');

  // GET or POST through Torn PDA, then the userscript manager, then plain fetch.
  function http(method, url, headers, body) {
    return new Promise((resolve, reject) => {
      const pda = method === 'POST' ? (typeof PDA_httpPost === 'function' ? PDA_httpPost : null) : (typeof PDA_httpGet === 'function' ? PDA_httpGet : null);
      if (pda) {
        const p = method === 'POST' ? pda(url, headers || {}, body || '') : pda(url, headers || {});
        p.then(r => { if (!r) { reject(Object.assign(new Error('No reply from the network (Torn PDA returned nothing)'), { noReply: true })); return; } resolve({ status: r.status || r.statusCode, text: r.responseText }); }).catch(reject);
        return;
      }
      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({ method, url, headers: headers || {}, data: body, timeout: 60000, onload: r => resolve({ status: r.status, text: r.responseText }), onerror: reject, ontimeout: reject });
        return;
      }
      fetch(url, { method, headers, body }).then(async r => resolve({ status: r.status, text: await r.text() })).catch(reject);
    });
  }
  // A request that got no reply is tried again a few times before giving up.
  async function httpRetry(method, url, headers, body) {
    for (let t = 0; ; t++) {
      try { const r = await http(method, url, headers, body); if (r) return r; throw Object.assign(new Error('No reply from the network'), { noReply: true }); }
      catch (e) { if (t < 4 && (e.noReply || /undefined is not an object|network|failed to fetch|connection|timed? ?out|socket|reset|ssl|tls/i.test(String(e && e.message)))) { await sleep(3000 * (t + 1)); continue; } throw e; }
    }
  }

  /* ===================== settings ===================== */
  const SITE = 'https://gilded-compass.mysterydryad.workers.dev'; // the Gilded Compass website
  const cfg = {
    key: () => sget('apikey', '') || (IN_PDA ? PDA_KEY : ''),
    site: () => String(sget('site', '') || SITE).replace(/\/+$/, ''), // 'site' in storage only overrides it for testing
    ready: () => !!cfg.key()
  };
  const KEYURL = 'https://www.torn.com/preferences.php#tab=api?step=addNewKey&title=GildedCompass&user=basic,log,bazaar&torn=logtypes,items';
  const KEY_WRONG = 'Torn says your saved key is wrong (it may have been deleted or replaced on Torn). Paste your current key below and tap Save.';
  const KEY_NO_BAZAAR = 'Your key can\'t look at bazaars yet. Make a new key with "Create the key for me" (it now ticks bazaar), then paste it in the 🧭 settings on Torn.';

  /* ===================== the site ===================== */
  function siteCall(method, path, body, token) {
    const h = { 'Content-Type': 'application/json' };
    if (token) h.Authorization = 'Bearer ' + token;
    return httpRetry(method, cfg.site() + path, h, body == null ? undefined : JSON.stringify(body));
  }
  // Signs in with the Torn key (the site asks Torn who owns it, then forgets it) and keeps the sign-in token here.
  async function signIn(key) {
    const r = await siteCall('POST', '/api/login', { key: key || cfg.key() });
    let j = {}; try { j = JSON.parse(r.text); } catch (e) { /* not json */ }
    if (r.status !== 200 || !j.token) throw Object.assign(new Error('Could not sign in to the site: ' + (j.error || 'HTTP ' + r.status)), { setup: r.status === 401 || r.status === 400 });
    sset('token', j.token); sset('me', { uid: j.uid, name: j.name });
    return j.token;
  }
  async function token() { return sget('token', '') || signIn(); }

  /* ===================== Torn API ===================== */
  async function apiUrl(url, key) {
    key = key || cfg.key();
    if (!key) throw new Error('No Torn API key set yet.');
    const r = await httpRetry('GET', url + (url.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(key));
    if (r.status === 429 || r.status >= 500) throw Object.assign(new Error('Torn is busy (HTTP ' + r.status + ').'), { rate: true });
    let j; try { j = JSON.parse(r.text); } catch (e) { throw new Error('Bad API response (HTTP ' + (r && r.status) + ')'); }
    const er = j && j.error;
    if (er && er.code === 16) throw Object.assign(new Error('This key can\'t read your log (Public and Limited keys can\'t). Tap "Create the key for me", make that key, then paste it here.'), { code: 16 });
    if (er && er.code === 2) throw Object.assign(new Error('Torn rejected the API key as incorrect.'), { code: 2 });
    if (er && er.code === 5) throw Object.assign(new Error('Torn is limiting requests (too many in one minute).'), { rate: true, code: 5 });
    if (er) throw Object.assign(new Error('Torn API: ' + (er.error || er.code) + ' (code ' + er.code + ')'), { code: er.code });
    return j;
  }
  async function api(path, params, key) {
    const qs = Object.entries(params || {}).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
    const url = 'https://api.torn.com/v2/' + path + (qs ? '?' + qs : '');
    const used = key || cfg.key();
    try { return await apiUrl(url, used); }
    catch (e) {
      if (e.code !== 2 || key) throw e; // a key typed in the settings box is tested as it is
      const good = await recoverKey(used);
      if (!good) throw Object.assign(new Error(KEY_WRONG), { code: 2 });
      return apiUrl(url, good);
    }
  }
  // Torn said "wrong key". In Torn PDA every open Torn tab (and the Gilded Compass page) keeps its own copy of the key, and one
  // can be out of date, for example after you made a new key. Before asking you to set up again, try the shared copy, this
  // page's copy and Torn PDA's key (and the same key once more, in case Torn had a hiccup); keep whichever works.
  const keyShape = k => /^[A-Za-z0-9]{16}$/.test(String(k || ''));
  let recovering = null;
  function recoverKey(bad) {
    if (recovering) return recovering;
    recovering = (async () => {
      try { await loadShared(); } catch (e) { /* use what this page has */ }
      const pdaKey = IN_PDA ? PDA_KEY : '';
      const tries = [sget('apikey', ''), sgetLocal('apikey', ''), pdaKey].filter(k => keyShape(k) && k !== bad);
      tries.push(bad);
      for (const k of [...new Set(tries)]) {
        if (!keyShape(k)) continue;
        try {
          await apiUrl('https://api.torn.com/v2/user/log?limit=1', k);
          if (k !== bad || sget('apikey', '') !== (k === pdaKey ? '' : k)) sset('apikey', k === pdaKey ? '' : k); // every copy now has the key that works
          state.keyFixedAt = Date.now();
          return k;
        } catch (e) { if (e.rate) return null; }
      }
      return null;
    })();
    recovering.finally(() => { recovering = null; });
    return recovering;
  }
  // Rate limits and busy replies: wait and try again a few times before stopping (progress is saved).
  async function apiPatient(path, params) {
    for (let t = 0; ; t++) {
      try { return await api(path, params); }
      catch (e) { if (e.rate && t < 3) { await sleep(15000); continue; } throw e; }
    }
  }

  /* ===================== parsing (pure, tested in test.js) ===================== */
  function normalizeLog(log) {
    if (Array.isArray(log)) return log;
    return Object.entries(log || {}).map(([id, e]) => Object.assign({ id }, e));
  }
  function logTypeList(j) {
    const t = j && (j.logtypes || j);
    return Array.isArray(t) ? t : Object.entries(t || {}).map(([id, title]) => ({ id: Number(id), title: typeof title === 'string' ? title : title && title.title }));
  }
  const isBazaarBuy = title => /^bazaar buy/i.test(String(title || '').trim());
  // Torn already filters by log type; this double-checks each entry is a "Bazaar buy" one.
  function isFromBazaar(e, ids) {
    const d = (e && e.details) || {};
    const type = Number(d.id != null ? d.id : e && e.log);
    const title = d.title || (e && e.title);
    if (title) return isBazaarBuy(title);
    return type ? ids.map(Number).includes(type) : true;
  }
  // One log entry -> compact purchase { id, ts, s: seller, it: [[itemId, qty]], ce: cost_each, ct: cost_total }, or null.
  function parseBuy(e) {
    const d = (e && e.data) || {};
    const seller = Number(d.seller != null ? d.seller : d.user != null ? d.user : d.seller_id);
    const list = Array.isArray(d.items) ? d.items : d.item != null ? [{ id: d.item, qty: d.quantity }] : [];
    const it = list.map(i => [Number(i.id), Number(i.qty != null ? i.qty : i.quantity != null ? i.quantity : 1)]).filter(i => i[0] > 0 && i[1] > 0);
    if (!(seller > 0) || !it.length || !e.timestamp) return null;
    const num = v => (v == null || v === '' || isNaN(Number(v)) ? null : Number(v));
    return { id: String(e.id), ts: Number(e.timestamp), s: seller, it, ce: num(d.cost_each), ct: num(d.cost_total) };
  }

  /* ===================== state ===================== */
  // pending: purchases read from the log but not yet accepted by the site. resume: a half-done log read.
  function loadState() {
    return Object.assign({ pending: {}, lastSync: 0, resume: null, logIds: null, sent: 0, badCount: 0,
      rawSamples: [], badSamples: [], lastError: null, lastRun: 0, syncedAt: 0 }, sget('state', null) || {});
  }
  let state = loadState();
  const save = () => sset('state', state);
  // The small part another page (the Gilded Compass page in PDA) needs to carry on where this one stopped.
  const shareSync = () => sset('sync', { lastSync: state.lastSync, oldest: state.oldest, logIds: state.logIds, sent: state.sent, syncedAt: state.syncedAt });
  function mergeShared() {
    const sh = sget('sync', null); if (!sh) return;
    if (!state.resume && (sh.lastSync || 0) > (state.lastSync || 0)) state.lastSync = sh.lastSync;
    if (!(state.logIds && state.logIds.length) && sh.logIds) state.logIds = sh.logIds;
    if (!state.resume && sh.oldest != null && (state.oldest == null || sh.oldest < state.oldest)) state.oldest = sh.oldest;
    state.sent = Math.max(state.sent || 0, sh.sent || 0);
    state.syncedAt = Math.max(state.syncedAt || 0, sh.syncedAt || 0);
  }

  async function ensureLogIds() {
    if (state.logIds && state.logIds.length) return state.logIds;
    const list = logTypeList(await apiPatient('torn/logtypes'));
    state.logTypesSeen = list.filter(t => isBazaarBuy(t.title));
    state.logIds = state.logTypesSeen.map(t => Number(t.id)).filter(Boolean);
    if (!state.logIds.length) throw new Error('Could not find the "Bazaar buy" log types in Torn\'s list.');
    save();
    return state.logIds;
  }
  /* ===================== sync: log -> site ===================== */
  // Reads one stretch of your log, newest first, from `toStart` (null = now) back to `from` (0 = the very beginning).
  // kind 'new' = entries since the last sync; 'older' = an older stretch inside the 60 days not read yet (e.g. after an earlier, shorter range).
  // Progress is saved every page, so a stopped read carries on next time.
  // onChunk: called whenever 1,000 purchases are waiting, so the site fills in while a long read is still going.
  async function readRange(from, toStart, kind, onChunk) {
    const ids = await ensureLogIds();
    const r = state.resume && (state.resume.kind || 'new') === kind ? state.resume : null;
    if (r) from = r.from;
    let to = r ? r.to : toStart, newest = r ? r.newest : (kind === 'new' ? state.lastSync || 0 : 0), added = r ? r.added || 0 : 0, seen = (r && r.seen) || {};
    const sellers = new Set();
    for (;;) {
      const params = { log: ids.join(','), limit: 100, sort: 'desc' };
      if (from) params.from = from;
      if (to) params.to = to;
      const arr = normalizeLog((await apiPatient('user/log', params)).log);
      let fresh = 0, oldest = Infinity;
      arr.forEach(e => {
        if (!isFromBazaar(e, ids)) return; // bazaar purchases only
        const ts = Number(e.timestamp);
        if (ts > newest) newest = ts;
        if (ts && ts < oldest) oldest = ts;
        const id = String(e.id);
        if (state.pending[id] || seen[id]) return;
        fresh++;
        if (state.rawSamples.length < 3) state.rawSamples.push(e);
        const b = parseBuy(e);
        if (b) { state.pending[id] = b; added++; sellers.add(b.s); }
        else { state.badCount++; if (state.badSamples.length < 5) state.badSamples.push(e); }
      });
      if (arr.length < 100 || !fresh || oldest === Infinity) break;
      // ids at the page edge can repeat on the next page: remember them so they are not counted twice
      seen = {}; arr.forEach(e => { if (Number(e.timestamp) === oldest) seen[String(e.id)] = 1; });
      to = oldest;
      state.resume = { kind, from, to, newest, seen, added };
      save();
      setStatus(`Reading your log… ${added.toLocaleString('en-US')} purchases found so far`);
      if (onChunk && Object.keys(state.pending).length >= CHUNK) await onChunk();
      await sleep(PAUSE);
    }
    state.resume = null;
    save();
    return { added, sellers: [...sellers], newest, from };
  }
  // final = 'first' at the end of your very first full sync: the site then ranks your top sellers once
  // (otherwise it does that at most every 6 hours, to save its daily database allowance).
  async function sendToSite(final) {
    const ids = Object.keys(state.pending);
    if (!ids.length && final !== 'first') return;
    for (let i = 0; i < Math.max(ids.length, 1); i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const body = { buys: chunk.map(id => state.pending[id]) };
      if (final === 'first' && i + CHUNK >= ids.length) body.final = 'first';
      let r = await siteCall('POST', '/api/purchases', body, await token());
      if (r.status === 401) { sset('token', ''); r = await siteCall('POST', '/api/purchases', body, await signIn()); }
      if (r.status !== 200) {
        let msg = ''; try { msg = JSON.parse(r.text).error || ''; } catch (e) { msg = String(r.text || '').slice(0, 120); }
        throw new Error('The site answered HTTP ' + r.status + (msg ? ': ' + msg : ''));
      }
      chunk.forEach(id => delete state.pending[id]);
      state.sent += chunk.length;
      save();
    }
  }

  // What the site knows about you: { purchases, settings: { lookback } } (null if it could not say).
  async function siteMe() {
    let r = await siteCall('GET', '/api/me', null, await token());
    if (r.status === 401) { sset('token', ''); r = await siteCall('GET', '/api/me', null, await signIn()); }
    try { const j = JSON.parse(r.text); return r.status === 200 ? j : null; } catch (e) { return null; }
  }
  let running = false;
  // Reads new log entries (and any older stretch of the last 60 days not read yet) and sends them.
  // Returns { added, sellers } (or { busy } / { error }).
  async function run(why) {
    if (running) return { busy: true };
    if (!cfg.ready()) return { error: 'Set up the 🧭 userscript on Torn first.' };
    const lock = sget('lock', 0);
    if (Date.now() - lock < 3 * 60000 && why !== 'tap') return { busy: true }; // another Torn tab is syncing
    running = true; sset('lock', Date.now()); setBtn('busy');
    try {
      try { await loadShared(); } catch (e) { /* fine without */ }
      mergeShared(); // carry on from where another page (e.g. the Gilded Compass page in PDA) got to
      const site = await siteMe();
      const days = Number(site && site.settings && site.settings.lookback) || HISTORY_DAYS;
      const start = Math.floor(Date.now() / 1000) - days * 86400; // how far back to look (the site keeps 60 days)
      if (state.lastSync && state.oldest == null) state.oldest = 0; // earlier versions always read everything
      // Self-repair: if the site holds none of your purchases (for example after "Delete my data"), read the log again.
      if (state.lastSync && !state.resume && !Object.keys(state.pending).length && site && site.purchases === 0) { state.lastSync = 0; state.oldest = null; save(); }
      let added = 0, sellers = [];
      const firstSync = !state.lastSync;
      const take = x => { added += x.added; sellers = sellers.concat(x.sellers); };
      if (state.resume && state.resume.kind === 'older') { const x = await readRange(start, null, 'older', sendToSite); take(x); state.oldest = x.from; }
      if (!state.lastSync) { // first read: back to the start of your history range
        const x = await readRange(start, null, 'new', sendToSite); take(x);
        if (x.newest) state.lastSync = x.newest;
        state.oldest = start;
      } else {
        const x = await readRange(state.lastSync + 1, null, 'new', sendToSite); take(x);
        if (x.newest > state.lastSync) state.lastSync = x.newest;
        if (state.oldest != null && start < state.oldest) { // range widened on the site: read the older stretch too
          const y = await readRange(start, state.oldest - 1, 'older', sendToSite); take(y);
          state.oldest = start;
        }
      }
      if (Object.keys(state.pending).length || (firstSync && added)) await sendToSite(firstSync && added ? 'first' : false);
      state.lastError = null; state.needsSetup = false; state.syncedAt = Date.now(); save(); shareSync(); setStatus('');
      itemsIfDue();
      if (added) sellersCache = null; // new sellers: fetch the list again before the next checks
      setBtn('ok', added ? `Sent ${added} new purchase${added === 1 ? '' : 's'}` : 'Up to date');
      return { added, sellers: [...new Set(sellers)] };
    } catch (e) {
      state.lastError = hideKey(e.message || e); state.lastErrorAt = Date.now();
      if (e.setup || e.code === 2 || e.code === 16) state.needsSetup = true;
      setBtn('err', state.lastError);
      return { error: state.lastError };
    } finally {
      state.lastRun = Date.now(); save(); sset('lock', 0); running = false;
    }
  }
  // For "Copy debug sample" on the Gilded Compass page (never contains a key).
  function debugSample() {
    return { version: VERSION, inPDA: IN_PDA, usingPdaKey: IN_PDA && !sget('apikey', ''), signedIn: !!sget('token', ''), logTypes: state.logTypesSeen || null,
      keyLooksRight: keyShape(cfg.key()), keyCopiesMatch: sget('apikey', '') === sgetLocal('apikey', ''), keyFixedAt: state.keyFixedAt || null, lastErrorAt: state.lastErrorAt || null,
      logIds: state.logIds, sent: state.sent, pending: Object.keys(state.pending).length, unreadable: state.badCount, lastSync: state.lastSync,
      oldest: state.oldest, resume: state.resume ? Object.assign({}, state.resume, { seen: undefined }) : null, lastError: state.lastError,
      lastCheckAt: state.lastCheckAt || null, lastCheckError: state.lastCheckError || null, keyNoBazaar: !!state.keyNoBazaar,
      rawSamples: state.rawSamples, badSamples: state.badSamples, parsedSample: state.rawSamples.map(parseBuy) };
  }

  /* ===================== bazaar checks with your own key ===================== */
  // Same reading of Torn's replies as the site used to do (src/logic.mjs).
  function parseBazaar(j) {
    if (!j || typeof j !== 'object') return null;
    const pick = (o, ks) => { for (const k of ks) if (o && o[k] !== undefined && o[k] !== null) return o[k]; return undefined; };
    let open = pick(j, ['bazaar_is_open', 'is_open']), exists = pick(j, ['bazaar_exists', 'exists']);
    if (open === undefined && j.bazaar && typeof j.bazaar === 'object' && !Array.isArray(j.bazaar)) {
      open = pick(j.bazaar, ['bazaar_is_open', 'is_open']); exists = pick(j.bazaar, ['bazaar_exists', 'exists']);
    }
    if (open === undefined) return null;
    return { is_open: open ? 1 : 0, has_bazaar: exists === undefined ? (open ? 1 : 0) : (exists ? 1 : 0) };
  }
  function parseName(j) { const p = (j && (j.profile || j)) || {}; return typeof p.name === 'string' && p.name ? p.name : null; }
  const CHECK_PAUSE = 1500; // ms between background checks
  let sellersCache = null;  // your sellers and top 100, from the site
  async function mySellers() {
    if (sellersCache && Date.now() - sellersCache.at < 30 * 60000) return sellersCache;
    let r = await siteCall('GET', '/api/sellers', null, await token());
    if (r.status === 401) { sset('token', ''); r = await siteCall('GET', '/api/sellers', null, await signIn()); }
    let j = {}; try { j = JSON.parse(r.text); } catch (e) { /* none */ }
    sellersCache = { at: Date.now(), sellers: Array.isArray(j.sellers) ? j.sellers : [], tops: Array.isArray(j.tops) ? j.tops : [] };
    return sellersCache;
  }
  // The next few sellers to check, in turn: mostly your top 100, plus the rest of your sellers.
  async function nextToCheck(n) {
    const { sellers, tops } = await mySellers();
    if (!sellers.length) return [];
    const pos = sget('ckpos', { t: 0, a: 0 });
    const pick = (list, from, k) => { const out = []; for (let i = 0; i < Math.min(k, list.length); i++) out.push(list[(from + i) % list.length]); return out; };
    const a = pick(tops, pos.t || 0, tops.length ? Math.ceil(n * 0.6) : 0), b = pick(sellers, pos.a || 0, n - a.length);
    sset('ckpos', { t: ((pos.t || 0) + a.length) % Math.max(1, tops.length), a: ((pos.a || 0) + b.length) % Math.max(1, sellers.length) });
    return [...new Set(a.concat(b))];
  }
  async function postChecks(body) {
    let r = await siteCall('POST', '/api/bazaar', body, await token());
    if (r.status === 401) { sset('token', ''); r = await siteCall('POST', '/api/bazaar', body, await signIn()); }
    let j = {}; try { j = JSON.parse(r.text); } catch (e) { /* not json */ }
    if (r.status !== 200) throw new Error(j.error || 'The site answered HTTP ' + r.status);
    return j;
  }
  let checking = false, hurry = false;
  // Runs fn for each id: fast = 4 at a time with no pause (Check now), otherwise one every 1.5 s, stopping early when a
  // Check now is waiting. An error thrown by fn stops the rest.
  async function paced(ids, fn, fast) {
    if (fast) { for (let i = 0; i < ids.length; i += 4) await Promise.all(ids.slice(i, i + 4).map(fn)); return; }
    for (const id of ids) { if (hurry) return; await fn(id); await sleep(CHECK_PAUSE); }
  }
  // Checks these sellers' bazaars with your key and sends the results, then looks up the names the site doesn't have yet.
  async function checkBazaars(ids, fast) {
    if (checking && fast) { hurry = true; for (let i = 0; checking && i < 150; i++) await sleep(200); }
    if (checking) return { busy: true };
    hurry = false;
    if (!cfg.ready()) return { error: 'Set up the 🧭 userscript on Torn first.' };
    if (!ids.length) return { checked: 0, changed: 0 };
    checking = true;
    const results = [], names = [];
    let error = null, changed = 0;
    const tornError = e => {
      if (e.code === 16) { state.keyNoBazaar = Date.now(); return Object.assign(new Error(KEY_NO_BAZAAR), { stop: true }); }
      if (e.rate) return new Error('Torn says your key is busy right now; the rest are checked a bit later.');
      if (e.code === 2) state.needsSetup = true;
      return e;
    };
    try {
      await paced(ids, async id => {
        try { const b = parseBazaar(await api(`user/${id}/bazaar`)); if (b) results.push([id, b.is_open, b.has_bazaar, 0]); }
        catch (e) { if (e.code === 6 || e.code === 7) results.push([id, 0, 0, 1]); else if (e.code || e.rate) throw tornError(e); }
      }, fast);
    } catch (e) { error = hideKey(e.message || e); }
    try {
      if (results.length) {
        if (!error) state.keyNoBazaar = 0;
        const j = await postChecks({ results });
        changed += j.changed || 0;
        // names come along the first time a seller is checked (a few per round, so your key stays unhurried)
        if (!error) {
          await paced((j.needName || []).slice(0, fast ? 16 : 8), async id => {
            try { const nm = parseName(await api(`user/${id}/basic`)); if (nm) names.push([id, nm, 0]); }
            catch (e) { if (e.code === 6 || e.code === 7) names.push([id, '(not found)', 1]); else if (e.code || e.rate) throw tornError(e); }
          }, fast).catch(e => { error = hideKey(e.message || e); });
        }
        if (names.length) changed += (await postChecks({ names })).changed || 0;
      }
    } catch (e) { error = error || hideKey(e.message || e); }
    checking = false;
    state.lastCheckAt = Date.now(); state.lastCheckError = error; save(); sset('ckat', state.lastCheckAt);
    const de = typeof document !== 'undefined' && document.documentElement;
    if (de && de.hasAttribute('data-gc-userscript')) { de.setAttribute('data-gc-checkedat', String(state.lastCheckAt)); de.setAttribute('data-gc-keyerr', state.keyNoBazaar ? KEY_NO_BAZAAR : ''); }
    return { checked: results.length, named: names.length, changed, error };
  }
  // Torn's item list (names and types for the filters), weekly, for your page. Skipped if your key can't read it.
  async function itemsIfDue() {
    if (Date.now() - (sget('itemsat', 0) || 0) < 7 * 86400000) return;
    sset('itemsat', Date.now());
    try {
      const j = await api('torn/items');
      const list = Array.isArray(j.items) ? j.items : Object.entries(j.items || {}).map(([id, v]) => Object.assign({ id }, v));
      const items = {};
      list.forEach(i => { if (i && i.id && i.name) items[i.id] = [String(i.name).slice(0, 79), String(i.type || 'Unknown').slice(0, 39), i.sub_type || null]; });
      if (Object.keys(items).length >= 100) {
        let r = await siteCall('POST', '/api/items', { items }, await token());
        if (r.status === 401) { sset('token', ''); await siteCall('POST', '/api/items', { items }, await signIn()); }
      }
    } catch (e) { /* the site keeps its shared list */ }
  }

  /* ===================== UI: the 🧭 button and a one-time setup card ===================== */
  const CSS = `
  #gc-btn{position:absolute;z-index:2147483645;cursor:pointer;font:700 15px/1 Arial;padding:4px 7px;border-radius:8px;border:1px solid #8a7330;background:#111a2e;color:#d4af37;touch-action:none;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}
  #gc-btn.drag{cursor:grabbing;opacity:.85;box-shadow:0 0 0 3px rgba(212,175,55,.35)}
  #gc-btn.aside{visibility:hidden;pointer-events:none}
  #gc-btn.busy{animation:gc-p 1.2s ease-in-out infinite}
  #gc-btn.err:after{content:"";position:absolute;top:-3px;right:-3px;width:8px;height:8px;border-radius:50%;background:#e0605a;border:1px solid #111a2e}
  @keyframes gc-p{50%{box-shadow:0 0 0 4px rgba(212,175,55,.35)}}
  #gc-setup{position:fixed;z-index:2147483646;top:56px;right:8px;width:min(400px,calc(100vw - 16px));max-height:calc(100vh - 72px);overflow:auto;box-sizing:border-box;padding:14px;
    background:#0b1020;color:#ece6d6;border:1px solid #8a7330;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.5);font:14px/1.45 system-ui,-apple-system,Segoe UI,Arial,sans-serif}
  #gc-setup[hidden]{display:none!important}
  #gc-setup *{box-sizing:border-box}
  #gc-setup h3{margin:0 0 8px;color:#d4af37;font-size:16px;display:flex;justify-content:space-between;align-items:center}
  #gc-setup label{display:block;margin-top:10px;color:#9aa3b5;font-size:12px}
  #gc-setup input{width:100%;padding:8px;border-radius:8px;border:1px solid #26324f;background:#111a2e;color:#ece6d6;font:inherit;margin-top:3px}
  #gc-setup button,#gc-setup a.gc-a{font:inherit;cursor:pointer;border-radius:8px;border:1px solid #26324f;background:#111a2e;color:#ece6d6;padding:7px 10px;text-decoration:none;display:inline-block;margin-top:8px}
  #gc-setup .gc-gold{background:#d4af37;border-color:#d4af37;color:#1a1405;font-weight:700;width:100%;padding:10px}
  #gc-setup .gc-note{color:#9aa3b5;font-size:12px;margin:8px 0 0}
  #gc-setup .gc-err{color:#ff8a65;margin-top:8px}
  #gc-setup .gc-ok{color:#4fd184;margin-top:8px}
  `;
  let msg = { text: '', ok: true };

  function setBtn(kind, title) {
    const b = document.getElementById('gc-btn'); if (!b) return;
    b.classList.toggle('busy', kind === 'busy');
    b.classList.toggle('err', kind === 'err');
    b.title = 'Gilded Compass' + (kind === 'busy' ? ': syncing…' : title ? ': ' + title : '') + '\n(tap: open site · hold: settings)';
  }
  function renderSetup() {
    const p = document.getElementById('gc-setup'); if (!p) return;
    const usingPda = IN_PDA && !sget('apikey', '');
    const me = sget('me', null);
    p.innerHTML = `<h3><span>🧭 Gilded Compass <small style="color:#9aa3b5;font-weight:400">v${VERSION}</small></span><button data-act="close">✕</button></h3>
      <p class="gc-note" style="margin-top:0">Ranks the bazaars you buy from. It reads only your <b>Bazaar buy</b> log, and only you can see your list.</p>
      ${me ? `<p class="gc-note">Signed in as <b style="color:#ece6d6">${esc(me.name || '')}</b> [${esc(me.uid)}]</p>` : ''}
      <label>Torn API key (Custom: log and bazaar ticked)<input id="gc-key" type="password" autocomplete="off" placeholder="${usingPda ? 'using Torn PDA\'s key' : sget('apikey', '') ? 'saved (leave empty to keep)' : 'paste the new key'}"></label>
      <a class="gc-a" href="${KEYURL}" target="_blank" rel="noopener">Create the key for me ↗</a>
      ${IN_PDA && !usingPda ? '<button data-act="usepda">Use Torn PDA\'s key</button>' : ''}
      <div id="gc-msg">${msg.text ? `<div class="${msg.ok ? 'gc-ok' : 'gc-err'}">${esc(msg.text)}</div>` : state.lastError ? `<div class="gc-err">Last sync${state.lastErrorAt ? ' (' + esc(new Date(state.lastErrorAt).toLocaleString()) + ')' : ''}: ${esc(state.lastError)}</div>` : ''}</div>
      <button data-act="save" class="gc-gold">Save and sign in</button>
      <p class="gc-note" id="gc-status">${statusText()}</p>
      <p class="gc-note">How far back to look, debug sample and deleting your data: <b>⚙</b> on your Gilded Compass page.</p>
      <p class="gc-note">Read-only: never acts in the game. Your key stays on this device. It reads your bazaar purchases and checks whether those sellers' bazaars are open (public info, shared with the site). It goes to api.torn.com, and once to the Gilded Compass site to confirm who you are (not stored there).</p>`;
  }
  function statusText() {
    return (state.sent ? `${state.sent.toLocaleString('en-US')} purchases sent so far` : 'Nothing sent yet')
      + (state.syncedAt ? ', last sync ' + new Date(state.syncedAt).toLocaleString() : '') + '.';
  }
  // Live progress in the settings card (if it is open) and on the 🧭 button's label.
  function setStatus(text) {
    const el = typeof document !== 'undefined' && document.getElementById('gc-status');
    if (el) el.textContent = text || statusText();
    const b = typeof document !== 'undefined' && document.getElementById('gc-btn');
    if (b && text) b.title = 'Gilded Compass: ' + text;
  }
  // Messages update in place, so whatever was typed in the boxes stays.
  function setMsg(text, ok) {
    msg = { text, ok };
    const m = document.getElementById('gc-msg');
    if (m) m.innerHTML = `<div class="${ok ? 'gc-ok' : 'gc-err'}">${esc(text)}</div>`;
  }
  function openSetup() {
    const p = document.getElementById('gc-setup'); if (!p) return;
    msg = { text: '', ok: true }; renderSetup(); p.hidden = false;
  }
  async function onSetup(ev) {
    const el = ev.target.closest('[data-act]'); if (!el) return;
    const act = el.getAttribute('data-act');
    if (act === 'close') { document.getElementById('gc-setup').hidden = true; return; }
    if (act === 'usepda') { sset('apikey', ''); el.remove(); document.getElementById('gc-key').placeholder = 'using Torn PDA\'s key'; return; }
    if (act === 'save') {
      const key = (document.getElementById('gc-key').value || '').trim() || cfg.key();
      if (!key) { setMsg('Paste your Torn API key first.', false); return; }
      // Phones only allow a new tab straight after a tap, so open it now and fill it in once signed in.
      let tab = null;
      if (!IN_PDA) { try { tab = window.open('', '_blank'); if (tab) tab.document.write('<p style="font:16px system-ui;padding:24px;color:#9a7412">Signing you in to Gilded Compass…</p>'); } catch (e) { /* blocked */ } }
      el.disabled = true; el.textContent = 'Checking…';
      try {
        await api('user/log', { limit: 1 }, key); // the log is the part that needs the right access
        await signIn(key);
        let noBazaar = false; // can it also look at bazaars? (checked on your own bazaar)
        try { await api(`user/${(sget('me', {}) || {}).uid}/bazaar`, {}, key); } catch (e) { if (e.code === 16) noBazaar = true; }
        state.keyNoBazaar = noBazaar ? Date.now() : 0;
        if (key !== (IN_PDA ? PDA_KEY : '')) sset('apikey', key);
        state.needsSetup = false; state.lastError = null; save();
        const me = sget('me', {});
        run('tap'); // starts sending your purchases; your list fills in as they arrive
        if (noBazaar) {
          if (tab && !tab.closed) { try { tab.close(); } catch (x) { /* ignore */ } }
          setMsg(`Signed in${me.name ? ' as ' + me.name : ''}, and your purchases are being sent. ` + KEY_NO_BAZAAR, false);
        } else if (openSite(tab)) {
          setMsg(`All good${me.name ? ', ' + me.name : ''}. Your list is opening; it fills in while your purchases are sent.`, true);
          setTimeout(() => { const p = document.getElementById('gc-setup'); if (p) p.hidden = true; }, 2500);
        } else showOpenLink(`All good${me.name ? ', ' + me.name : ''}. Your purchases are being sent.`);
      } catch (e) {
        if (tab && !tab.closed) { try { tab.close(); } catch (x) { /* ignore */ } }
        setMsg(hideKey(e.message || e), false);
      }
      el.disabled = false; el.textContent = 'Save and sign in';
      return;
    }
    if (act === 'open') { setTimeout(() => { document.getElementById('gc-setup').hidden = true; }, 300); return; } // the link itself opens the site
  }
  const siteUrl = () => { const t = sget('token', ''); return cfg.site() + '/' + (t ? '#t=' + t : ''); }; // the token after # never reaches any server log
  // Opens the site in a new tab (or in a tab opened earlier, while the tap was still fresh). Returns false if the phone blocked it.
  function openSite(tab) {
    const url = siteUrl();
    if (tab && !tab.closed) { try { tab.location.href = url; tab.opener = null; return true; } catch (e) { /* fall through */ } }
    const w = window.open(url, '_blank');
    if (w) { try { w.opener = null; } catch (e) { /* ignore */ } return true; }
    return false;
  }
  // The 🧭 box opened because of an earlier error: test the key now. If it works, the error was old (or from another tab).
  async function recheckKey() {
    setMsg('Checking your key…', true);
    try {
      await api('user/log', { limit: 1 });
      state.needsSetup = false; state.lastError = null; save();
      showOpenLink('Your key works ✓ (that error was from earlier).');
      run('tap');
    } catch (e) {
      state.lastError = hideKey(e.message || e); state.lastErrorAt = Date.now(); save();
      setMsg(state.lastError, false);
    }
  }
  // When a new tab can't be opened automatically, a plain link always works.
  function showOpenLink(text) {
    const p = document.getElementById('gc-setup');
    if (p && p.hidden) openSetup();
    setMsg(text, true);
    const m = document.getElementById('gc-msg');
    if (m) m.insertAdjacentHTML('beforeend', `<a class="gc-a gc-gold" data-act="open" href="${esc(siteUrl())}" target="_blank" rel="noopener" style="text-align:center">Open my list →</a>`);
  }
  function tap() {
    if (!cfg.ready()) { openSetup(); return; }
    if (state.needsSetup) { openSetup(); recheckKey(); return; }
    if (!openSite()) {
      if (IN_PDA) showOpenLink('Tap below to open your list.');
      else location.href = siteUrl(); // pop-up blocked: open it here instead
    }
    run('tap');
  }
  // Torn's pop-ups (chat windows, menus, dialogs) come first: while one covers the 🧭 button's spot, the button steps aside.
  // A pop-up is something pinned to the screen (fixed or sticky) that is not a thin full-width bar like Torn's header.
  function isPopup(el) {
    for (let n = el; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      const pos = getComputedStyle(n).position;
      if (pos === 'fixed' || pos === 'sticky') {
        const r = n.getBoundingClientRect();
        return r.width < window.innerWidth * 0.95 || r.height > window.innerHeight * 0.3;
      }
    }
    return false;
  }
  function stepAside() {
    const b = document.getElementById('gc-btn');
    if (!b || b.classList.contains('drag')) return;
    const r = b.getBoundingClientRect();
    if (!r.width || r.bottom < 0 || r.top > window.innerHeight) return;
    let covered = false;
    for (const [x, y] of [[r.left + r.width / 2, r.top + r.height / 2], [r.left + 2, r.top + 2], [r.right - 2, r.bottom - 2]]) {
      const under = document.elementsFromPoint(x, y).find(el => el !== b && !b.contains(el)); // the first thing beneath the button
      if (under && isPopup(under)) { covered = true; break; }
    }
    b.classList.toggle('aside', covered);
  }
  // Phone and computer layouts differ, so each remembers its own spot.
  const posKey = () => (window.innerWidth < 700 ? 'btnpos_phone' : 'btnpos');
  const defaultPos = () => (window.innerWidth < 700 ? { left: 164, top: 4 } : { left: Math.max(8, window.innerWidth - 160), top: 8 }); // phone: next to Arbitrage's 💰
  function placeBtn(b, pos) {
    const de = document.documentElement, w = b.offsetWidth || 36, h = b.offsetHeight || 28;
    b.style.left = Math.min(Math.max(0, pos.left), Math.max(0, de.scrollWidth - w)) + 'px';
    b.style.top = Math.min(Math.max(0, pos.top), Math.max(0, de.scrollHeight - h)) + 'px';
  }
  // Tap opens the site; hold 0.6 s (without moving) for settings; drag to move it anywhere, on phones too.
  function attachPointer(b) {
    let sx = 0, sy = 0, ox = 0, oy = 0, moved = false, down = false, held = false, timer = null;
    b.addEventListener('pointerdown', ev => {
      ev.stopPropagation(); down = true; moved = false; held = false; sx = ev.clientX; sy = ev.clientY;
      const r = b.getBoundingClientRect(); ox = r.left + window.pageXOffset; oy = r.top + window.pageYOffset;
      timer = setTimeout(() => { if (down && !moved) { held = true; openSetup(); } }, 600);
      try { b.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
    });
    b.addEventListener('pointermove', ev => {
      if (!down || held) return;
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (!moved && Math.hypot(dx, dy) < 8) return;
      if (!moved) { moved = true; clearTimeout(timer); b.classList.add('drag'); }
      ev.preventDefault();
      placeBtn(b, { left: ox + dx, top: oy + dy });
    });
    const end = ev => {
      ev.stopPropagation(); clearTimeout(timer); if (!down) return; down = false;
      b.classList.remove('drag');
      if (moved) { const r = b.getBoundingClientRect(); sset(posKey(), { left: r.left + window.pageXOffset, top: r.top + window.pageYOffset }); }
      else if (!held && ev.type === 'pointerup') tap();
    };
    b.addEventListener('pointerup', end);
    b.addEventListener('pointercancel', end);
    b.addEventListener('contextmenu', ev => ev.preventDefault());
    ['mousedown', 'touchstart', 'click'].forEach(t => b.addEventListener(t, ev => { ev.stopPropagation(); if (t === 'click') ev.preventDefault(); }));
    b.addEventListener('touchmove', ev => { if (down) ev.preventDefault(); }, { passive: false }); // keep the page still while dragging
  }
  function mount() {
    if (!document.body) return;
    if (!document.getElementById('gc-style')) { const s = document.createElement('style'); s.id = 'gc-style'; s.textContent = CSS; document.head.appendChild(s); }
    if (!document.getElementById('gc-setup')) {
      const p = document.createElement('div'); p.id = 'gc-setup'; p.hidden = true;
      p.addEventListener('click', onSetup);
      document.body.appendChild(p);
    }
    if (!document.getElementById('gc-btn')) {
      const b = document.createElement('button'); b.id = 'gc-btn'; b.textContent = '🧭';
      attachPointer(b);
      document.body.appendChild(b);
      placeBtn(b, sget(posKey(), null) || defaultPos());
      window.addEventListener('resize', () => placeBtn(b, sget(posKey(), null) || defaultPos()));
      setBtn(state.lastError ? 'err' : 'ok', state.lastError || '');
    }
  }
  // On the Gilded Compass page: no button. "Check now" there asks this script to read your log first.
  function initSite() {
    const de = document.documentElement;
    de.setAttribute('data-gc-userscript', VERSION);
    if (state.lastCheckAt) de.setAttribute('data-gc-checkedat', String(state.lastCheckAt));
    de.setAttribute('data-gc-keyerr', state.keyNoBazaar ? KEY_NO_BAZAAR : '');
    // the page signs in through this script (it holds your key): a fresh sign-in when the page's has expired
    document.addEventListener('gc:signin', async () => {
      let res;
      try {
        if (!cfg.ready()) throw new Error('No Torn key in the 🧭 userscript yet. On Torn, tap 🧭 and paste your key.');
        res = { token: await signIn(), me: sget('me', null) };
      } catch (e) { res = { error: hideKey(e.message || e) }; }
      de.setAttribute('data-gc-signin-result', JSON.stringify(res));
      document.dispatchEvent(new Event('gc:signedin'));
    });
    // the page asks who is signed in on this device (so it can sign itself in)
    document.addEventListener('gc:token', () => { const t = sget('token', ''); if (t) de.setAttribute('data-gc-token', t); de.setAttribute('data-gc-me', JSON.stringify(sget('me', null))); });
    // Check now: the sellers on screen, with your key, straight away
    document.addEventListener('gc:check', async () => {
      let ids = []; try { ids = JSON.parse(de.getAttribute('data-gc-check-ids') || '[]').map(Number).filter(x => x > 0).slice(0, 40); } catch (e) { /* none */ }
      const res = await checkBazaars(ids, true);
      de.setAttribute('data-gc-check-result', JSON.stringify(res || {}));
      document.dispatchEvent(new Event('gc:checked'));
    });
    // while this page is open: a few of your sellers every 2 minutes, in turn
    const bg = async () => {
      if (document.hidden || !cfg.ready() || state.needsSetup || (state.keyNoBazaar && Date.now() - state.keyNoBazaar < 30 * 60000)) return;
      try { await checkBazaars(await nextToCheck(12), false); } catch (e) { /* next time */ }
    };
    setTimeout(bg, 60000); setInterval(bg, 120000); // the page asks for a quick check of the cards on screen when it opens
    document.addEventListener('gc:debug', () => { de.setAttribute('data-gc-debug', hideKey(JSON.stringify(debugSample()))); });
    document.addEventListener('gc:resetpos', () => { sset('btnpos', null); sset('btnpos_phone', null); de.setAttribute('data-gc-resetpos', String(Date.now())); });
    document.addEventListener('gc:sync', async () => {
      const res = await run('tap');
      de.setAttribute('data-gc-sync-result', JSON.stringify(res || {}));
      document.dispatchEvent(new Event('gc:synced'));
    });
  }
  async function init() {
    if (window.top !== window.self) return; // not inside Torn's iframes
    try { await loadShared(); } catch (e) { /* fine without */ }
    state = loadState(); mergeShared();
    if (location.origin === cfg.site()) { initSite(); return; }
    mount();
    setInterval(mount, 3000); // Torn sometimes rebuilds the page
    setInterval(stepAside, 400);
    window.addEventListener('scroll', stepAside, { passive: true });
    if (typeof GM_registerMenuCommand === 'function') GM_registerMenuCommand('Gilded Compass settings', openSetup);
    const auto = () => { if (!document.hidden && cfg.ready() && !state.needsSetup && Date.now() - (state.lastRun || 0) > AUTO_EVERY) run('auto'); };
    setTimeout(auto, 5000);
    setInterval(auto, 60000);
    // while Torn is open: a few of your sellers' bazaars every 10 minutes, with your key
    const bg = async () => {
      if (document.hidden || !cfg.ready() || state.needsSetup || Date.now() - Math.max(state.lastCheckAt || 0, sget('ckat', 0)) < 10 * 60000) return;
      if (state.keyNoBazaar && Date.now() - state.keyNoBazaar < 30 * 60000) return; // the key can't look at bazaars: wait for a new one
      try { await checkBazaars(await nextToCheck(8), false); } catch (e) { /* next time */ }
    };
    setTimeout(bg, 20000); setInterval(bg, 60000);
  }

  if (typeof module !== 'undefined') {
    module.exports = { VERSION, parseBuy, normalizeLog, logTypeList, isBazaarBuy, isFromBazaar,
      // everything the button, the settings box and the site page call; a missing one makes the test fail to load
      wired: { tap, openSite, siteUrl, showOpenLink, openSetup, renderSetup, onSetup, setMsg, setStatus, statusText, run, readRange,
        sendToSite, siteMe, signIn, token, debugSample, initSite, init, mount, attachPointer, placeBtn, stepAside, setBtn,
        checkBazaars, paced, nextToCheck, mySellers, postChecks, itemsIfDue, parseBazaar, parseName, recoverKey, recheckKey } };
  }
  if (typeof document !== 'undefined' && !globalThis.__GC_TEST) init();
})();
