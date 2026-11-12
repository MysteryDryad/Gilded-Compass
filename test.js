// Tests: node test.js (no installs needed)
globalThis.__GC_TEST = true;
const fs = require('fs');
const T = require('./gilded-compass.user.js');
let fail = 0;
const eq = (name, a, b) => { const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) fail++; console.log(ok ? 'PASS' : 'FAIL', name, ok ? '' : JSON.stringify(a) + ' != ' + JSON.stringify(b)); };

// version in the header matches VERSION
const head = fs.readFileSync(__dirname + '/gilded-compass.user.js', 'utf8').match(/@version\s+(\S+)/)[1];
eq('@version matches VERSION', head, T.VERSION);

// log types: list or object form, both "Bazaar buy" titles, nothing else
eq('logtypes list', T.logTypeList({ logtypes: [{ id: 1225, title: 'Bazaar buy' }, { id: 9, title: 'Bazaar sell' }] }).filter(t => T.isBazaarBuy(t.title)).map(t => t.id), [1225]);
eq('logtypes object', T.logTypeList({ logtypes: { 1225: 'Bazaar buy', 1226: 'Bazaar buy (legacy)', 3: 'Attack' } }).filter(t => T.isBazaarBuy(t.title)).map(t => t.id), [1225, 1226]);

// parsing
const e1 = { id: 'a', timestamp: 100, details: { title: 'Bazaar buy' }, data: { seller: 55, items: [{ id: 186, uid: null, qty: 3 }], cost_each: 1, cost_total: 3 } };
eq('parse normal entry', T.parseBuy(e1), { id: 'a', ts: 100, s: 55, it: [[186, 3]], ce: 1, ct: 3 });
eq('parse missing seller -> null', T.parseBuy({ id: 'b', timestamp: 1, data: { items: [{ id: 1, qty: 1 }] } }), null);
eq('parse no items -> null', T.parseBuy({ id: 'c', timestamp: 1, data: { seller: 5 } }), null);
const onlyTotal = T.parseBuy({ id: 'd', timestamp: 200, data: { seller: 55, items: [{ id: 260, qty: 4 }], cost_total: 1000 } });
eq('cost_total split by quantity', T.eachPrice(onlyTotal), 250);
eq('spent with only total', T.spentOf(onlyTotal), 1000);
eq('normalize object log', T.normalizeLog({ x: { timestamp: 1 } }), [{ id: 'x', timestamp: 1 }]);

// summary: ranking by purchases, ties by items; $1 count; types
const items = { 186: ['Sheep Plushie', 'Plushie'], 260: ['Dahlia', 'Flower'] };
const buys = {
  a: T.parseBuy(e1), d: onlyTotal,
  e: T.parseBuy({ id: 'e', timestamp: 300, data: { seller: 77, items: [{ id: 260, qty: 10 }], cost_each: 500 } }),
  f: T.parseBuy({ id: 'f', timestamp: 50, data: { seller: 88, items: [{ id: 186, qty: 1 }], cost_each: 2000 } })
};
const S = T.summarize(buys, items);
eq('rank order (purchases, then items)', S.map(s => s.id), [55, 77, 88]);
eq('seller 55 totals', [S[0].purchases, S[0].items, S[0].spent, S[0].ones, S[0].last], [2, 7, 1003, 1, 200]);
eq('seller 55 types', S[0].types, { Plushie: 3, Flower: 4 });
eq('top types', T.topTypes(S[0], 3), ['Flower', 'Plushie']);

console.log(fail ? `\n${fail} FAILED` : '\nAll passed');
process.exit(fail ? 1 : 0);
