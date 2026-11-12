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
  const items = { 186: ['Sheep Plushie', 'Plushie'], 260: ['Dahlia', 'Flower'] };
  const rows = [
    { seller: 55, ts: 100, items: '[[186,3]]', ce: 1, ct: 3 },              // $1 plushies
    { seller: 55, ts: 200, items: '[[260,4]]', ce: null, ct: 1000 },        // only total: 250 each
    { seller: 77, ts: 300, items: [[260, 10]], ce: 500, ct: null },
    { seller: 88, ts: 50, items: [[186, 1], [260, 2]], ce: 2000, ct: null }  // two types in one purchase
  ];
  eq('each price from total', L.eachPrice(rows[1]), 250);
  const A = L.aggregate(rows, items);
  eq('rank by purchases then items', A.sellers.map(s => s.id), [55, 77, 88]);
  const s55 = A.sellers[0];
  eq('seller totals [purchases, items, spent]', s55.tot, [2, 7, 1003]);
  eq('seller last purchase', s55.last, 200);
  eq('per type', [s55.t.Plushie, s55.t.Flower], [[1, 3, 3], [1, 4, 1000]]);
  eq('$1 pseudo type (not double counted in tot)', s55.t[L.ONE_DOLLAR], [1, 3, 3]);
  eq('two types in one purchase count once each', [A.sellers[2].tot[0], A.sellers[2].t.Plushie[0], A.sellers[2].t.Flower[0]], [1, 1, 1]);
  eq('type totals for chips', A.typeTotals, { Plushie: 4, [L.ONE_DOLLAR]: 3, Flower: 16 });
  eq('unknown item type', Object.keys(L.aggregate([{ seller: 1, ts: 1, items: [[999, 1]], ce: 5 }], items).sellers[0].t), ['Unknown']);

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
