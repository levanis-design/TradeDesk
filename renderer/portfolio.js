'use strict';
// Portfolio arithmetic for the Holdings page and the Analyze page. Pure, so it is unit tested.
// The timeline is NOT your account history. It values the positions you hold today at past closing prices,
// which is what the data supports. It says nothing about trades you made or sold.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Portfolio = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

  // price: a map ticker -> latest price that overrides the stored lastPrice
  function totals(positions, price = {}) {
    let value = 0; let cost = 0; let pricedCost = 0; let pricedValue = 0;
    const missing = [];
    const rows = positions.map((p) => {
      const last = isNum(price[p.ticker]) ? price[p.ticker] : (isNum(p.lastPrice) ? p.lastPrice : null);
      const v = last != null ? last * p.quantity : null;
      const c = isNum(p.averagePrice) ? Math.abs(p.quantity) * p.averagePrice : null;
      if (v == null) missing.push(p.ticker); else { value += v; pricedValue += v; }
      if (c != null) cost += c;
      if (v != null && c != null) pricedCost += c;
      return { ticker: p.ticker, quantity: p.quantity, price: last, value: v, cost: c, pl: v != null && c != null ? v - c : null, plPct: v != null && c ? v / c - 1 : null };
    });
    const pl = pricedCost ? pricedValue - pricedCost : null;
    return { rows, value, cost, pl, plPct: pricedCost ? pricedValue / pricedCost - 1 : null, missing };
  }

  // Weights over priced positions plus cash. Positions beyond `top` roll into "Other".
  function allocation(positions, cash, price = {}, top = 8) {
    const t = totals(positions, price);
    const items = t.rows.filter((r) => r.value != null && r.value > 0).map((r) => ({ name: r.ticker, value: r.value }));
    items.sort((a, b) => b.value - a.value);
    let shown = items;
    if (items.length > top) {
      const rest = items.slice(top - 1);
      shown = items.slice(0, top - 1).concat([{ name: 'Other', value: rest.reduce((a, r) => a + r.value, 0), rolled: rest.map((r) => r.name) }]);
    }
    if (isNum(cash) && cash > 0) shown = shown.concat([{ name: 'Cash', value: cash, cash: true }]);
    const total = shown.reduce((a, r) => a + r.value, 0);
    return { items: shown.map((r) => ({ ...r, weight: total ? r.value / total : 0 })), total, missing: t.missing };
  }

  const weightOf = (ticker, positions, cash, price = {}) => {
    const a = allocation(positions, cash, price, 1000);
    const it = a.items.find((r) => r.name === ticker);
    return it ? it.weight : null;
  };

  // histories: { TICKER: [[YYYY-MM-DD, close], ...] } ascending.
  // The series starts on the latest of the first dates, so every held ticker has a price from day one.
  function timeline(positions, histories) {
    const use = positions.filter((p) => p.quantity && histories[p.ticker] && histories[p.ticker].length);
    const skipped = positions.filter((p) => !use.includes(p)).map((p) => p.ticker);
    if (!use.length) return { points: [], cost: null, skipped };
    const start = use.map((p) => histories[p.ticker][0][0]).reduce((a, b) => (a > b ? a : b));
    const dates = [...new Set(use.flatMap((p) => histories[p.ticker].map((r) => r[0])))].filter((d) => d >= start).sort();
    const idx = Object.fromEntries(use.map((p) => [p.ticker, 0]));
    const last = {};
    const points = [];
    for (const d of dates) {
      let v = 0; let ok = true;
      for (const p of use) {
        const h = histories[p.ticker];
        let i = idx[p.ticker];
        while (i < h.length && h[i][0] <= d) { last[p.ticker] = h[i][1]; i++; }
        idx[p.ticker] = i;
        if (last[p.ticker] == null) { ok = false; break; }
        v += last[p.ticker] * p.quantity;
      }
      if (ok) points.push([d, v]);
    }
    const cost = use.every((p) => isNum(p.averagePrice)) ? use.reduce((a, p) => a + Math.abs(p.quantity) * p.averagePrice, 0) : null;
    return { points, cost, skipped, start };
  }

  const RANGES = { '1M': 31, '3M': 92, '6M': 183, '1Y': 366, '5Y': 1827, 'Max': Infinity };
  function slice(points, range) {
    if (!points.length || !RANGES[range] || RANGES[range] === Infinity) return points.slice();
    const end = new Date(points[points.length - 1][0] + 'T00:00:00Z');
    const from = new Date(end.getTime() - RANGES[range] * 86400000).toISOString().slice(0, 10);
    const out = points.filter((p) => p[0] >= from);
    return out.length >= 2 ? out : points.slice(-2);
  }
  const change = (points) => (points.length >= 2 && points[0][1] ? { abs: points[points.length - 1][1] - points[0][1], pct: points[points.length - 1][1] / points[0][1] - 1 } : null);

  // ---- candles. A bar is [time, open, high, low, close, volume]; time is YYYY-MM-DD or YYYY-MM-DD HH:MM.
  // Which ranges Yahoo provides for each interval. Label -> Yahoo period.
  const PERIODS = { '1D': '1d', '5D': '5d', '1M': '1mo', '3M': '3mo', '6M': '6mo', '1Y': '1y', '5Y': '5y', 'Max': 'max' };
  const INTERVALS = {
    '1m': { label: '1 minute', ranges: ['1D', '5D'] },
    '5m': { label: '5 minutes', ranges: ['1D', '5D', '1M'] },
    '15m': { label: '15 minutes', ranges: ['5D', '1M'] },
    '1h': { label: '1 hour', ranges: ['1M', '3M', '6M', '1Y'] },
    '1d': { label: '1 day', ranges: ['1M', '3M', '6M', '1Y', '5Y', 'Max'] },
    '1wk': { label: '1 week', ranges: ['1Y', '5Y', 'Max'] },
  };

  // Merge neighbouring bars until there are at most maxN, so a year of minutes stays readable.
  function aggregate(bars, maxN) {
    if (!maxN || bars.length <= maxN) return bars;
    const k = Math.ceil(bars.length / maxN);
    const out = [];
    for (let i = 0; i < bars.length; i += k) {
      const g = bars.slice(i, i + k);
      out.push([g[0][0], g[0][1], Math.max(...g.map((b) => b[2])), Math.min(...g.map((b) => b[3])), g[g.length - 1][4], g.reduce((a, b) => a + (b[5] || 0), 0)]);
    }
    return out;
  }

  // The value of the positions you hold today, bar by bar. barsBy: { TICKER: [bar, ...] } ascending.
  // The high and low are sums of each holding's own high and low, so they assume every holding peaked
  // at the same moment. They are an upper and lower bound, not what a statement would show.
  function candles(positions, barsBy) {
    const use = positions.filter((p) => p.quantity && barsBy[p.ticker] && barsBy[p.ticker].length);
    const skipped = positions.filter((p) => !use.includes(p)).map((p) => p.ticker);
    if (!use.length) return { bars: [], skipped, start: null };
    const start = use.map((p) => barsBy[p.ticker][0][0]).reduce((a, b) => (a > b ? a : b));
    const times = [...new Set(use.flatMap((p) => barsBy[p.ticker].map((b) => b[0])))].filter((t) => t >= start).sort();
    const idx = Object.fromEntries(use.map((p) => [p.ticker, 0]));
    const lastClose = {};
    const out = [];
    for (const t of times) {
      let o = 0; let hi = 0; let lo = 0; let c = 0; let v = 0; let ok = true;
      for (const p of use) {
        const arr = barsBy[p.ticker];
        let i = idx[p.ticker];
        let bar = null;
        while (i < arr.length && arr[i][0] <= t) { if (arr[i][0] === t) bar = arr[i]; lastClose[p.ticker] = arr[i][4]; i++; }
        idx[p.ticker] = i;
        if (!bar) { const lc = lastClose[p.ticker]; if (lc == null) { ok = false; break; } bar = [t, lc, lc, lc, lc, 0]; }
        const q = p.quantity;
        o += bar[1] * q; hi += (q >= 0 ? bar[2] : bar[3]) * q; lo += (q >= 0 ? bar[3] : bar[2]) * q; c += bar[4] * q; v += bar[5] || 0;
      }
      if (ok) out.push([t, o, hi, lo, c, v]);
    }
    return { bars: out, skipped, start };
  }

  // Rows sorted by a column. Missing values always go last, whichever way the column runs.
  function sortRows(rows, key, dir, get) {
    const d = dir === 'desc' ? -1 : 1;
    return rows.map((r, i) => ({ r, i })).sort((a, b) => {
      const x = get(a.r, key); const y = get(b.r, key);
      const xn = x == null || x === '' || (typeof x === 'number' && !Number.isFinite(x));
      const yn = y == null || y === '' || (typeof y === 'number' && !Number.isFinite(y));
      if (xn || yn) return xn && yn ? a.i - b.i : xn ? 1 : -1;
      const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: 'base' });
      return c ? c * d : a.i - b.i;
    }).map((x) => x.r);
  }

  return { totals, allocation, weightOf, timeline, slice, change, RANGES, PERIODS, INTERVALS, aggregate, candles, sortRows };
});
