// Tests: node test.js (no installs needed)
globalThis.__GC_TEST = true;
const fs = require('fs');
const U = require('./gilded-compass.user.js');
let fail = 0;
const eq = (name, a, b) => { const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) fail++; console.log(ok ? 'PASS' : 'FAIL', name, ok ? '' : JSON.stringify(a) + ' != ' + JSON.stringify(b)); };

(async () => {
  const L = await import('./src/logic.mjs');

  /* ---------- userscript ---------- */
  const head = fs.readFileSync(__dirname + '/gilded-compass.user.js', 'utf8').match(/@version\s+(\S+)/)[1];
  eq('@version matches VERSION', head, U.VERSION);
  eq('logtypes list', U.logTypeList({ logtypes: [{ id: 1225, title: 'Bazaar buy' }, { id: 9, title: 'Bazaar sell' }] }).filter(t => U.isBazaarBuy(t.title)).map(t => t.id), [1225]);
  eq('logtypes object', U.logTypeList({ logtypes: { 1225: 'Bazaar buy', 1226: 'Bazaar buy (legacy)', 3: 'Attack' } }).filter(t => U.isBazaarBuy(t.title)).map(t => t.id), [1225, 1226]);
  const e1 = { id: 'a', timestamp: 100, details: { title: 'Bazaar buy' }, data: { seller: 55, items: [{ id: 186, uid: null, qty: 3 }], cost_each: 1, cost_total: 3 } };
  eq('parse normal entry', U.parseBuy(e1), { id: 'a', ts: 100, s: 55, it: [[186, 3]], ce: 1, ct: 3 });
  eq('parse missing seller -> null', U.parseBuy({ id: 'b', timestamp: 1, data: { items: [{ id: 1, qty: 1 }] } }), null);
  eq('parse no items -> null', U.parseBuy({ id: 'c', timestamp: 1, data: { seller: 5 } }), null);
  eq('normalize object log', U.normalizeLog({ x: { timestamp: 1 } }), [{ id: 'x', timestamp: 1 }]);
  eq('only bazaar buys pass', [
    U.isFromBazaar({ details: { id: 1225, title: 'Bazaar buy' } }, [1225]),
    U.isFromBazaar({ details: { id: 1112, title: 'Item market buy' } }, [1225]),
    U.isFromBazaar({ details: { id: 1225 } }, [1225]),
    U.isFromBazaar({ details: { id: 4 } }, [1225])], [true, false, true, false]);

  /* ---------- worker logic ---------- */
  /* ---------- totals (public/aggregate.js, runs in the browser) ---------- */
  const G = require('./public/aggregate.js');
  const items = { 186: ['Sheep Plushie', 'Plushie'], 260: ['Dahlia', 'Flower'] };
  const rows = [            // [ts, seller, items, cost_each, cost_total]
    [100, 55, [[186, 3]], 1, 3],             // $1 plushies
    [200, 55, [[260, 4]], null, 1000],       // only total: 250 each
    [300, 77, [[260, 10]], 500, null],
    [50, 88, [[186, 1], [260, 2]], 2000, null] // two types in one purchase
  ];
  eq('each price from total', G.eachPrice(rows[1][2], rows[1][3], rows[1][4]), 250);
  const A = G.aggregate(rows, items);
  eq('rank by purchases then items', A.sellers.map(s => s.id), [55, 77, 88]);
  const s55 = A.sellers[0];
  eq('seller totals [purchases, items, spent]', s55.tot, [2, 7, 1003]);
  eq('seller last purchase', s55.last, 200);
  eq('per type', [s55.t.Plushie, s55.t.Flower], [[1, 3, 3], [1, 4, 1000]]);
  eq('$1 pseudo type (not double counted in tot)', s55.t[G.ONE], [1, 3, 3]);
  eq('two types in one purchase count once each', [A.sellers[2].tot[0], A.sellers[2].t.Plushie[0], A.sellers[2].t.Flower[0]], [1, 1, 1]);
  eq('date range and count', [A.first, A.last, A.count], [50, 300, 4]);
  eq('unknown item type', Object.keys(G.aggregate([[1, 1, [[999, 1]], 5, null]], items).sellers[0].t), ['Unknown']);
  { // speed: a big history like the reference (23k purchases, ~5k sellers) adds up quickly in a browser
    const big = []; for (let i = 0; i < 23094; i++) big.push([1780000000 + i, 1000 + (i % 4944), [[i % 2 ? 186 : 260, 1 + (i % 5)]], i % 9 ? 1500 : 1, null]);
    const t0 = Date.now(); const B = G.aggregate(big, items); const ms = Date.now() - t0;
    eq('23k purchases -> 4944 sellers', B.sellers.length, 4944);
    console.log('     (added up 23,094 purchases in ' + ms + ' ms)');
  }

  eq('bazaar open', L.parseBazaar({ bazaar_is_open: true, bazaar_exists: true, bazaar: [] }), { is_open: 1, has_bazaar: 1 });
  eq('bazaar closed', L.parseBazaar({ bazaar_is_open: false, bazaar_exists: true }), { is_open: 0, has_bazaar: 1 });
  eq('no bazaar', L.parseBazaar({ bazaar_is_open: false, bazaar_exists: false }), { is_open: 0, has_bazaar: 0 });
  eq('unknown shape -> null', L.parseBazaar({ bazaar: [] }), null);
  eq('name from profile', L.parseName({ profile: { id: 1, name: 'Duke' } }), 'Duke');

  const now = 100000;
  const due = L.pickDue([
    { id: 1, t: now - 200, tier: 1 },    // 200/300 -> not due
    { id: 2, t: now - 600, tier: 1 },    // 2.0
    { id: 3, t: now - 2800, tier: 2 },   // 1.04
    { id: 4, t: 0, tier: 2 },            // never checked: most overdue
    { id: 5, t: now - 900, tier: 2 }     // 0.33 -> not due
  ], now, 36);
  eq('pickDue order and filter', due, [4, 2, 3]);
  eq('pickDue respects max', L.pickDue([{ id: 1, t: 0, tier: 1 }, { id: 2, t: 0, tier: 1 }], now, 1).length, 1);

  eq('validIds ok', L.validIds(['12', 34, '12']), [12, 34]);
  eq('validIds rejects non digits', L.validIds(['12; DROP']), null);
  eq('validIds rejects > 30', L.validIds(Array.from({ length: 31 }, (_, i) => i + 1)), null);
  eq('validIds rejects empty', L.validIds([]), null);
  eq('validBuy ok', L.validBuy({ id: 'x', ts: 5, s: 9, it: [[1, 2]], ce: '3' }), { id: 'x', ts: 5, s: 9, it: [[1, 2]], ce: 3, ct: null });
  eq('validBuy rejects bad seller', L.validBuy({ id: 'x', ts: 5, s: 'abc', it: [[1, 2]] }), null);

  eq('token is url-safe and long', /^[A-Za-z0-9_-]{43}$/.test(L.newToken()), true);
  eq('tokens differ', L.newToken() !== L.newToken(), true);
  eq('sha256hex', await L.sha256hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  eq('bearer header', L.bearer('Bearer ' + 'a'.repeat(43)), 'a'.repeat(43));
  eq('bearer garbage', L.bearer('Basic abc'), null);
  eq('key shape', [L.looksLikeKey('AbCdEfGh12345678'), L.looksLikeKey('short'), L.looksLikeKey('AbCdEfGh1234567!')], [true, false, false]);
  eq('check kinds: top, other, no bazaar, gone', [L.kindOf(0, 1, 1), L.kindOf(0, null, 0), L.kindOf(0, 0, 1), L.kindOf(1, 1, 1)], [1, 2, 3, 0]);
  eq('no-bazaar sellers re-checked daily', L.pickDue([{ id: 9, t: 1000, tier: 3 }], 1000 + 86400, 5), [9]);
  eq('no-bazaar sellers not before a day', L.pickDue([{ id: 9, t: 1000, tier: 3 }], 1000 + 3600, 5), []);

  console.log(fail ? `\n${fail} FAILED` : '\nAll passed');
  process.exit(fail ? 1 : 0);
})();
