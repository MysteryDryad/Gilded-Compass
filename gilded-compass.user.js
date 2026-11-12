// ==UserScript==
// @name         Gilded Compass
// @namespace    gilded-compass
// @version      0.1.0
// @description  Ranks the Torn bazaar sellers you buy from, by item type. Reads your own bazaar purchase log. Read-only, never acts in the game.
// @author       MysteryDryad
// @homepageURL  https://github.com/MysteryDryad/Gilded-Compass
// @supportURL   https://github.com/MysteryDryad/Gilded-Compass/issues
// @match        https://www.torn.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      api.torn.com
// @run-at       document-idle
// ==/UserScript==

/*
 * GILDED COMPASS: who you buy from in Torn bazaars (Torn PDA and Tampermonkey/Violentmonkey)
 *
 * What it does
 * - Adds a 🧭 button to Torn. Sync reads YOUR "Bazaar buy" log entries and the Torn item list.
 * - Ranks the sellers you bought from (purchases, items, money spent, item types).
 *
 * Privacy and safety
 * - Read-only: it never performs game actions, clicks or purchases for you.
 * - Your Torn API key (a Custom key with user basic + log and torn items + logtypes) is sent only to api.torn.com
 *   and stored only on this device (script storage). In Torn PDA it can use PDA's own key.
 *
 * Troubleshooting: 🧭 > "Copy debug sample" (contains no API key).
 */
(function () {
  'use strict';

  /* ===================== environment helpers ===================== */
  const NS = 'gc_';
  const PDA_KEY = '###PDA-APIKEY###';
  const IN_PDA = PDA_KEY[0] !== '#';
  const VERSION = '0.1.0'; // keep equal to @version above (test.js checks this)
  const hasGM = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';
  const PAUSE = 1200; // ms between log pages: stays well under Torn's 100 calls a minute even with Arbitrage sharing the key

  function sget(k, d) {
    try {
      const v = hasGM ? GM_getValue(NS + k) : localStorage.getItem(NS + k);
      if (v == null || v === '') return d;
      return typeof v === 'string' ? JSON.parse(v) : v;
    } catch (e) { return d; }
  }
  function sset(k, v) {
    try { const s = JSON.stringify(v); if (hasGM) GM_setValue(NS + k, s); else localStorage.setItem(NS + k, s); return true; }
    catch (e) { console.warn('[GC] save failed', e); return false; }
  }

  function http(url) {
    return new Promise((resolve, reject) => {
      if (typeof PDA_httpGet === 'function') {
        PDA_httpGet(url, {}).then(r => { if (!r) { reject(Object.assign(new Error('No reply from the network (Torn PDA returned nothing)'), { noReply: true })); return; } resolve({ status: r.status || r.statusCode, text: r.responseText }); }).catch(reject);
        return;
      }
      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({ method: 'GET', url, timeout: 30000, onload: r => resolve({ status: r.status, text: r.responseText }), onerror: reject, ontimeout: reject });
        return;
      }
      fetch(url).then(async r => resolve({ status: r.status, text: await r.text() })).catch(reject);
    });
  }
  // A request that got no reply is tried again a few times before giving up.
  async function httpRetry(url) {
    for (let t = 0; ; t++) {
      try { const r = await http(url); if (r) return r; throw Object.assign(new Error('No reply from the network'), { noReply: true }); }
      catch (e) { if (t < 4 && (e.noReply || /undefined is not an object|network|failed to fetch|connection|timed? ?out|socket|reset|ssl|tls/i.test(String(e && e.message)))) { await sleep(3000 * (t + 1)); continue; } throw e; }
    }
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = n => Number(n || 0).toLocaleString('en-US');
  const money = n => '$' + fmt(Math.round(n || 0));
  const hideKey = s => String(s).replace(/key=[A-Za-z0-9]+/g, 'key=HIDDEN');

  /* ===================== Torn API ===================== */
  function getKey() { return sget('apikey', '') || (IN_PDA ? PDA_KEY : ''); }
  const KEYURL = 'https://www.torn.com/preferences.php#tab=api?step=addNewKey&title=GildedCompass&user=basic,log&torn=items,logtypes';
  async function apiUrl(url, key) {
    key = key || getKey();
    if (!key) throw new Error('No API key set yet.');
    const r = await httpRetry(url + (url.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(key));
    if (r.status === 429 || r.status >= 500) throw Object.assign(new Error('Torn is busy (HTTP ' + r.status + '). Progress is saved, tap Continue in a minute.'), { rate: true });
    let j; try { j = JSON.parse(r.text); } catch (e) { throw new Error('Bad API response (HTTP ' + (r && r.status) + ')'); }
    const er = j && j.error;
    if (er && er.code === 16) throw Object.assign(new Error('Your API key does not have enough access. Reading your log needs a Custom key with the user log ticked ("Create the key for me"), or a Full Access key; a Limited Access key is refused.'), { code: 16 });
    if (er && er.code === 2) throw Object.assign(new Error('Torn rejected the API key as incorrect.'), { code: 2 });
    if (er && er.code === 5) throw Object.assign(new Error('Torn is limiting requests (too many in one minute). Progress is saved, tap Continue in a minute.'), { rate: true, code: 5 });
    if (er) throw Object.assign(new Error('Torn API: ' + (er.error || er.code) + ' (code ' + er.code + ')'), { code: er.code });
    return j;
  }
  function api(path, params, key) {
    const qs = Object.entries(params || {}).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
    return apiUrl('https://api.torn.com/v2/' + path + (qs ? '?' + qs : ''), key);
  }
  // Rate limits and busy replies: wait and try again a few times before stopping.
  async function apiPatient(path, params) {
    for (let t = 0; ; t++) {
      try { return await api(path, params); }
      catch (e) { if (e.rate && t < 3) { setProgress('Torn is busy, waiting 15s…'); await sleep(15000); continue; } throw e; }
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
  // One log entry -> compact purchase record, or null when the shape is not what we expect.
  function parseBuy(e) {
    const d = (e && e.data) || {};
    const seller = Number(d.seller != null ? d.seller : d.user != null ? d.user : d.seller_id);
    const list = Array.isArray(d.items) ? d.items : d.item != null ? [{ id: d.item, qty: d.quantity }] : [];
    const it = list.map(i => [Number(i.id), Number(i.qty != null ? i.qty : i.quantity != null ? i.quantity : 1)]).filter(i => i[0] > 0 && i[1] > 0);
    if (!(seller > 0) || !it.length || !e.timestamp) return null;
    const num = v => (v == null || v === '' || isNaN(Number(v)) ? null : Number(v));
    return { id: String(e.id), ts: Number(e.timestamp), s: seller, it, ce: num(d.cost_each), ct: num(d.cost_total) };
  }
  // Price per item for one purchase: cost_each, or cost_total split by quantity.
  function eachPrice(b) {
    const qty = b.it.reduce((s, i) => s + i[1], 0);
    if (b.ce != null) return b.ce;
    if (b.ct != null && qty) return b.ct / qty;
    return null;
  }
  function spentOf(b) {
    const qty = b.it.reduce((s, i) => s + i[1], 0), each = eachPrice(b);
    return each == null ? 0 : each * qty;
  }
  // Per-seller totals. types: item type -> items bought. ones: purchases at $1 or less per item.
  function summarize(buys, itemTypes) {
    const by = {};
    Object.values(buys || {}).forEach(b => {
      const s = by[b.s] = by[b.s] || { id: b.s, purchases: 0, items: 0, spent: 0, last: 0, ones: 0, types: {} };
      s.purchases++;
      s.spent += spentOf(b);
      if (b.ts > s.last) s.last = b.ts;
      const each = eachPrice(b);
      if (each != null && each <= 1) s.ones++;
      b.it.forEach(([id, qty]) => {
        s.items += qty;
        const t = (itemTypes && itemTypes[id] && itemTypes[id][1]) || 'Unknown';
        s.types[t] = (s.types[t] || 0) + qty;
      });
    });
    return Object.values(by).sort((a, b) => b.purchases - a.purchases || b.items - a.items || a.id - b.id);
  }
  const topTypes = (s, n) => Object.entries(s.types).sort((a, b) => b[1] - a[1]).slice(0, n).map(x => x[0]);

  /* ===================== state ===================== */
  // buys: log id -> purchase. bad: log ids we could not read (kept so they are not re-read). resume: half-done read.
  function loadState() {
    const s = sget('state', null) || {};
    return Object.assign({ buys: {}, bad: {}, lastSync: 0, resume: null, logIds: null, badSamples: [], rawSamples: [], lastError: null, syncedAt: 0 }, s);
  }
  let state = loadState();
  const save = () => sset('state', state);
  let itemTypes = sget('items', {}); // id -> [name, type]

  async function ensureLogIds() {
    if (state.logIds && state.logIds.length) return state.logIds;
    const list = logTypeList(await apiPatient('torn/logtypes'));
    state.logTypesSeen = list.filter(t => isBazaarBuy(t.title));
    state.logIds = state.logTypesSeen.map(t => Number(t.id)).filter(Boolean);
    if (!state.logIds.length) throw new Error('Could not find the "Bazaar buy" log types in Torn\'s list.');
    save();
    return state.logIds;
  }
  async function ensureItems() {
    if (Object.keys(itemTypes).length && Date.now() - (sget('itemsAt', 0) || 0) < 7 * 86400000) return;
    const j = await apiPatient('torn/items');
    const list = Array.isArray(j.items) ? j.items : Object.entries(j.items || {}).map(([id, v]) => Object.assign({ id }, v));
    const out = {};
    list.forEach(i => { if (i && i.id) out[i.id] = [i.name, i.type || 'Unknown', i.sub_type || null]; });
    if (Object.keys(out).length) { itemTypes = out; sset('items', out); sset('itemsAt', Date.now()); }
    state.itemSample = list.slice(0, 2);
  }

  /* ===================== sync ===================== */
  let syncRunning = false, progressText = '';
  function setProgress(t) { progressText = t; const b = document.querySelector('#gc-panel [data-act="sync"]'); if (b && syncRunning) b.textContent = t || 'Syncing…'; }

  // Newest first. First sync reads all history; later syncs only read entries newer than the last one.
  // Saves after every page, so if it stops (rate limit, closed tab), Continue picks up where it left off.
  async function syncLog(opts) {
    if (syncRunning) return 'A sync is already running.';
    syncRunning = true; state.lastError = null;
    try {
      if (opts && opts.fromStart) { state.lastSync = 0; state.resume = null; state.buys = {}; state.bad = {}; state.badSamples = []; state.rawSamples = []; }
      const ids = await ensureLogIds();
      await ensureItems();
      const r = state.resume;
      const from = r ? r.from : (state.lastSync ? state.lastSync + 1 : 0);
      let to = r ? r.to : null, newest = r ? r.newest : (state.lastSync || 0), pages = r ? r.pages : 0, added = 0;
      for (;;) {
        const params = { log: ids.join(','), limit: 100, sort: 'desc' };
        if (from) params.from = from;
        if (to) params.to = to;
        const arr = normalizeLog((await apiPatient('user/log', params)).log);
        pages++;
        let fresh = 0, oldest = Infinity;
        arr.forEach(e => {
          const ts = Number(e.timestamp);
          if (ts > newest) newest = ts;
          if (ts && ts < oldest) oldest = ts;
          const id = String(e.id);
          if (state.buys[id] || state.bad[id]) return;
          fresh++;
          if (state.rawSamples.length < 3) state.rawSamples.push(e);
          const b = parseBuy(e);
          if (b) { state.buys[id] = b; added++; }
          else { state.bad[id] = 1; if (state.badSamples.length < 5) state.badSamples.push(e); }
        });
        if (arr.length < 100 || !fresh || oldest === Infinity) break;
        to = oldest;
        state.resume = { from, to, newest, pages };
        save();
        setProgress('Page ' + pages + ' · ' + fmt(Object.keys(state.buys).length) + ' purchases');
        await sleep(PAUSE);
      }
      state.lastSync = newest; state.resume = null; state.syncedAt = Date.now(); state.lastPages = pages;
      save();
      return added ? 'Added ' + fmt(added) + ' new purchase' + (added === 1 ? '' : 's') + '.' : 'Up to date, no new purchases.';
    } catch (e) {
      state.lastError = hideKey(e.message || e); save();
      throw e;
    } finally { syncRunning = false; progressText = ''; }
  }

  /* ===================== UI ===================== */
  const CSS = `
  #gc-btn{position:absolute;z-index:2147483645;cursor:pointer;font:700 15px/1 Arial;padding:4px 7px;border-radius:8px;border:1px solid #8a7330;background:#151c2e;color:#d4af37;touch-action:none;-webkit-user-select:none;user-select:none}
  #gc-panel{position:fixed;z-index:2147483646;top:56px;right:8px;width:min(420px,calc(100vw - 16px));max-height:calc(100vh - 72px);overflow:auto;box-sizing:border-box;
    background:#0d1220;color:#ece6d6;border:1px solid #8a7330;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.5);font:14px/1.45 system-ui,-apple-system,Segoe UI,Arial,sans-serif}
  #gc-panel[hidden]{display:none!important}
  #gc-panel *{box-sizing:border-box}
  #gc-panel .gc-hd{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-bottom:1px solid #2a3350;position:sticky;top:0;background:#0d1220}
  #gc-panel .gc-hd b{color:#d4af37;font-size:15px}
  #gc-panel .gc-sub{color:#9aa0b0;font-size:12px}
  #gc-panel .gc-body{padding:12px}
  #gc-panel button,#gc-panel .gc-a{font:inherit;cursor:pointer;border-radius:8px;border:1px solid #2a3350;background:#151c2e;color:#ece6d6;padding:7px 10px;text-decoration:none;display:inline-block}
  #gc-panel button:disabled{opacity:.5;cursor:default}
  #gc-panel .gc-gold{background:#d4af37;border-color:#d4af37;color:#1a1405;font-weight:700;width:100%;padding:10px}
  #gc-panel input{width:100%;padding:8px;border-radius:8px;border:1px solid #2a3350;background:#151c2e;color:#ece6d6;font:inherit;margin:6px 0}
  #gc-panel .gc-note{color:#9aa0b0;font-size:12px;margin:8px 0}
  #gc-panel .gc-err{color:#e0605a;margin:8px 0}
  #gc-panel .gc-ok{color:#5fbf7a;margin:8px 0}
  #gc-panel .gc-row{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}
  #gc-panel ol{margin:10px 0 0;padding-left:22px}
  #gc-panel li{margin:4px 0}
  #gc-panel li a{color:#d4af37}
  #gc-panel .gc-meta{color:#9aa0b0;font-size:12px}
  `;
  let ui = { msg: '', msgOk: true, keyStep: false };

  function render() {
    const p = document.getElementById('gc-panel'); if (!p) return;
    const key = getKey();
    const n = Object.keys(state.buys).length;
    let body = '';
    if (!key || ui.keyStep) {
      body = `<p>Gilded Compass reads your <b>Bazaar buy</b> log. It needs a <b>Custom</b> API key with your log ticked (a Limited key is refused by Torn).</p>
        <a class="gc-a" href="${KEYURL}" target="_blank" rel="noopener">Create the key for me ↗</a>
        <input id="gc-key" type="password" autocomplete="off" placeholder="Paste the new key here">
        ${ui.msg ? `<div class="${ui.msgOk ? 'gc-ok' : 'gc-err'}">${esc(ui.msg)}</div>` : ''}
        <div class="gc-row"><button data-act="savekey" class="gc-gold">Save key</button></div>
        ${IN_PDA ? '<div class="gc-row"><button data-act="usepda">Use Torn PDA\'s key instead</button></div>' : ''}
        ${key ? '<div class="gc-row"><button data-act="cancelkey">Cancel</button></div>' : ''}
        <p class="gc-note">Your key is sent only to api.torn.com and stays on this device.</p>`;
    } else {
      const sellers = summarize(state.buys, itemTypes);
      const label = syncRunning ? (progressText || 'Syncing…') : state.resume ? 'Continue sync' : '⟳ Sync purchases';
      const when = state.syncedAt ? ' · synced ' + ago(state.syncedAt) : '';
      body = `<button data-act="sync" class="gc-gold" ${syncRunning ? 'disabled' : ''}>${esc(label)}</button>
        ${ui.msg ? `<div class="${ui.msgOk ? 'gc-ok' : 'gc-err'}">${esc(ui.msg)}</div>` : ''}
        ${!ui.msg && state.lastError ? `<div class="gc-err">${esc(state.lastError)}</div>` : ''}
        <p class="gc-meta">${fmt(n)} purchases from ${fmt(sellers.length)} sellers${when}</p>
        ${sellers.length ? `<ol>${sellers.slice(0, 10).map(s => `<li><a href="https://www.torn.com/profiles.php?XID=${s.id}" target="_blank" rel="noopener">[${s.id}]</a>
            ${fmt(s.purchases)} buys · ${fmt(s.items)} items · ${money(s.spent)}<br><span class="gc-meta">Mostly: ${esc(topTypes(s, 3).join(', '))}</span></li>`).join('')}</ol>` : ''}
        <div class="gc-row">
          <button disabled title="Comes with the website step">Open full site (soon)</button>
          <button data-act="debug">Copy debug sample</button>
        </div>
        <div class="gc-row">
          <button data-act="resync">Re-sync from start</button>
          <button data-act="changekey">Change key</button>
        </div>
        <p class="gc-note">Read-only: never acts in the game. Data and key stay on this device.</p>`;
    }
    p.innerHTML = `<div class="gc-hd"><span><b>🧭 Gilded Compass</b> <span class="gc-sub">v${VERSION}</span></span><button data-act="close">✕</button></div><div class="gc-body">${body}</div>`;
  }
  function ago(ms) {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    return s < 60 ? 'just now' : s < 3600 ? Math.round(s / 60) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' d ago';
  }

  async function onAction(ev) {
    const el = ev.target.closest('[data-act]'); if (!el) return;
    const act = el.getAttribute('data-act');
    if (act === 'close') { document.getElementById('gc-panel').hidden = true; return; }
    if (act === 'changekey') { ui.keyStep = true; ui.msg = ''; render(); return; }
    if (act === 'cancelkey') { ui.keyStep = false; render(); return; }
    if (act === 'usepda') { sset('apikey', ''); ui.keyStep = false; ui.msg = ''; render(); return; }
    if (act === 'savekey') {
      const k = (document.getElementById('gc-key').value || '').trim();
      if (!k) return;
      el.disabled = true; el.textContent = 'Checking…';
      try {
        await api('user/log', { limit: 1 }, k); // the log is the part that needs the right access
        sset('apikey', k); ui.keyStep = false; ui.msg = 'Key works. Tap Sync.'; ui.msgOk = true;
      } catch (e) { ui.msg = hideKey(e.message || e); ui.msgOk = false; }
      render(); return;
    }
    if (act === 'sync' || act === 'resync') {
      if (act === 'resync' && el.getAttribute('data-sure') !== '1') { el.setAttribute('data-sure', '1'); el.textContent = 'Tap again to re-read everything'; return; }
      ui.msg = ''; const run = syncLog({ fromStart: act === 'resync' }); render();
      try { ui.msg = await run; ui.msgOk = true; } catch (e) { ui.msg = hideKey(e.message || e); ui.msgOk = false; }
      render(); return;
    }
    if (act === 'debug') {
      const sample = { version: VERSION, inPDA: IN_PDA, usingPdaKey: IN_PDA && !sget('apikey', ''), logTypes: state.logTypesSeen || null, logIds: state.logIds,
        purchases: Object.keys(state.buys).length, unreadable: Object.keys(state.bad).length, lastSync: state.lastSync, lastPages: state.lastPages || null,
        resume: state.resume, lastError: state.lastError, itemTypes: Object.keys(itemTypes).length,
        types: [...new Set(Object.values(itemTypes).map(v => v[1]))].sort(), itemSample: state.itemSample || null,
        rawSamples: state.rawSamples, badSamples: state.badSamples, parsedSample: Object.values(state.buys).slice(0, 3) };
      const ok = await copyText(hideKey(JSON.stringify(sample, null, 1)));
      el.textContent = ok ? 'Copied ✔' : 'Copy failed';
      setTimeout(() => { el.textContent = 'Copy debug sample'; }, 2000);
    }
  }
  function copyText(text) {
    try { if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).then(() => true).catch(() => legacyCopy(text)); }
    catch (e) { /* fall through */ }
    return Promise.resolve(legacyCopy(text));
  }
  function legacyCopy(text) {
    try { const t = document.createElement('textarea'); t.value = text; t.style.position = 'fixed'; t.style.opacity = '0'; document.body.appendChild(t); t.select(); const ok = document.execCommand('copy'); t.remove(); return ok; }
    catch (e) { return false; }
  }

  function openPanel() {
    const p = document.getElementById('gc-panel'); if (!p) return;
    p.hidden = !p.hidden;
    if (!p.hidden) { ui.msg = ''; render(); }
  }
  function placeBtn(b, pos) {
    const de = document.documentElement;
    b.style.left = Math.min(Math.max(0, pos.left), Math.max(0, de.scrollWidth - 40)) + 'px';
    b.style.top = Math.min(Math.max(0, pos.top), Math.max(0, de.scrollHeight - 40)) + 'px';
  }
  // PC: drag to move, position is remembered. Tap without moving opens the panel.
  function attachDrag(b) {
    let sx = 0, sy = 0, ox = 0, oy = 0, moved = false, down = false;
    b.addEventListener('pointerdown', ev => {
      ev.stopPropagation(); down = true; moved = false; sx = ev.clientX; sy = ev.clientY;
      const r = b.getBoundingClientRect(); ox = r.left + window.pageXOffset; oy = r.top + window.pageYOffset;
      try { b.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
    });
    b.addEventListener('pointermove', ev => {
      if (!down) return;
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (!moved && Math.hypot(dx, dy) < 8) return;
      moved = true; placeBtn(b, { left: ox + dx, top: oy + dy });
    });
    b.addEventListener('pointerup', ev => {
      ev.stopPropagation(); if (!down) return; down = false;
      if (moved) { const r = b.getBoundingClientRect(); sset('btnpos', { left: r.left + window.pageXOffset, top: r.top + window.pageYOffset }); }
      else openPanel();
    });
    ['mousedown', 'touchstart', 'click'].forEach(t => b.addEventListener(t, ev => { ev.stopPropagation(); if (t === 'click') ev.preventDefault(); }));
  }
  function mount() {
    if (!document.body) return;
    if (!document.getElementById('gc-style')) { const s = document.createElement('style'); s.id = 'gc-style'; s.textContent = CSS; document.head.appendChild(s); }
    if (!document.getElementById('gc-panel')) {
      const p = document.createElement('div'); p.id = 'gc-panel'; p.hidden = true;
      p.addEventListener('click', onAction);
      document.body.appendChild(p);
    }
    if (!document.getElementById('gc-btn')) {
      const b = document.createElement('button'); b.id = 'gc-btn'; b.textContent = '🧭'; b.title = 'Gilded Compass';
      if (window.innerWidth < 700) { // phones: fixed spot next to Arbitrage's 💰, not draggable
        placeBtn(b, { left: 164, top: 4 });
        b.addEventListener('click', ev => { ev.stopPropagation(); ev.preventDefault(); openPanel(); });
        ['mousedown', 'touchstart'].forEach(t => b.addEventListener(t, ev => ev.stopPropagation()));
      } else {
        placeBtn(b, sget('btnpos', null) || { left: Math.max(8, window.innerWidth - 160), top: 8 });
        attachDrag(b);
      }
      document.body.appendChild(b);
    }
  }
  function init() {
    if (window.top !== window.self) return; // not inside Torn's iframes
    mount();
    setInterval(mount, 3000); // Torn sometimes rebuilds the page
  }

  if (typeof module !== 'undefined') {
    module.exports = { VERSION, parseBuy, eachPrice, spentOf, summarize, normalizeLog, logTypeList, isBazaarBuy, topTypes };
  }
  if (typeof document !== 'undefined' && !globalThis.__GC_TEST) init();
})();
