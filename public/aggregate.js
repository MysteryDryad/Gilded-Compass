// Totals per seller and per item type. Runs in the browser (so the free Worker never does heavy work)
// and in node for tests: node test.js
(function (root) {
  'use strict';
  const ONE = '$1 items';

  // Price per item: cost_each, or cost_total split by quantity.
  function eachPrice(items, ce, ct) {
    const qty = items.reduce((s, i) => s + Number(i[1]), 0);
    if (ce != null) return Number(ce);
    if (ct != null && qty) return Number(ct) / qty;
    return null;
  }

  // purchases: [ts, seller, [[itemId, qty]], cost_each, cost_total]; itemTypes: id -> [name, type, sub_type]
  // Each seller: tot = [purchases, items, spent], t = { type: [purchases, items, spent] }, last = newest purchase.
  // "$1 items" is a pseudo type (price per item $1 or less); it never changes the overall totals.
  function aggregate(purchases, itemTypes) {
    const by = new Map();
    let first = 0, last = 0;
    for (const p of purchases) {
      const ts = Number(p[0]) || 0, id = Number(p[1]), items = p[2] || [], each = eachPrice(items, p[3], p[4]);
      if (ts && (!first || ts < first)) first = ts;
      if (ts > last) last = ts;
      let s = by.get(id);
      if (!s) by.set(id, s = { id, last: 0, tot: [0, 0, 0], t: {} });
      if (ts > s.last) s.last = ts;
      s.tot[0]++;
      const seen = new Set();
      let qtyAll = 0, spentAll = 0;
      for (const [itemId, q] of items) {
        const qty = Number(q), spent = each == null ? 0 : each * qty;
        const type = (itemTypes && itemTypes[itemId] && itemTypes[itemId][1]) || 'Unknown';
        const t = s.t[type] || (s.t[type] = [0, 0, 0]);
        if (!seen.has(type)) { t[0]++; seen.add(type); }
        t[1] += qty; t[2] += spent;
        qtyAll += qty; spentAll += spent;
      }
      s.tot[1] += qtyAll; s.tot[2] += spentAll;
      if (each != null && each <= 1) {
        const t = s.t[ONE] || (s.t[ONE] = [0, 0, 0]);
        t[0]++; t[1] += qtyAll; t[2] += spentAll;
      }
    }
    const sellers = [...by.values()].sort(byRank);
    for (const s of sellers) { s.tot[2] = Math.round(s.tot[2]); for (const k in s.t) s.t[k][2] = Math.round(s.t[k][2]); }
    return { sellers, first, last, count: purchases.length };
  }
  // Rank: purchases, then items, then lower id.
  function byRank(a, b) { return b.tot[0] - a.tot[0] || b.tot[1] - a.tot[1] || a.id - b.id; }

  const api = { ONE, aggregate, eachPrice };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GCAgg = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
