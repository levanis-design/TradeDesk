'use strict';
// Risk arithmetic for the What-if page. Pure, so it is unit tested.
// It describes what an amount could lose and what the price did before. It never says how much to invest.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Risk = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
  const DAY = 1; const MONTH = 21; const YEAR = 252;

  const clean = (closes) => (closes || []).filter((c) => isNum(c) && c > 0);

  function percentile(values, p) {
    const a = values.filter(isNum).slice().sort((x, y) => x - y);
    if (!a.length) return null;
    const pos = (a.length - 1) * p;
    const lo = Math.floor(pos); const hi = Math.ceil(pos);
    return a[lo] + (a[hi] - a[lo]) * (pos - lo);
  }

  // Return over every n-day window that fits in the series.
  function windowReturns(closes, n) {
    const c = clean(closes);
    const out = [];
    for (let i = 0; i + n < c.length; i++) out.push(c[i + n] / c[i] - 1);
    return out;
  }

  function maxDrawdown(closes) {
    const c = clean(closes);
    let peak = -Infinity; let worst = 0;
    for (const v of c) { if (v > peak) peak = v; worst = Math.min(worst, v / peak - 1); }
    return worst;
  }

  function stats(closes) {
    const c = clean(closes);
    if (c.length < 60) return null;
    const r = windowReturns(c, 1);
    const mean = r.reduce((a, b) => a + b, 0) / r.length;
    const sd = Math.sqrt(r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1));
    const month = windowReturns(c, MONTH);
    return {
      days: c.length, years: c.length / YEAR,
      dailyVol: sd, annualVol: sd * Math.sqrt(YEAR),
      worstDay: Math.min(...r), worstMonth: month.length ? Math.min(...month) : null,
      maxDrawdown: maxDrawdown(c),
    };
  }

  // Share of start days on which the price touched `fall` below the start within `horizon` days.
  function reachFrequency(closes, fall, horizon) {
    const c = clean(closes);
    if (!(fall > 0) || c.length <= horizon) return null;
    let hit = 0; let total = 0;
    for (let i = 0; i + horizon < c.length; i++) {
      total++;
      const line = c[i] * (1 - fall);
      for (let k = 1; k <= horizon; k++) if (c[i + k] <= line) { hit++; break; }
    }
    return total ? { share: hit / total, windows: total, hit } : null;
  }

  // What a fall in the price would cost, set against cash and the whole portfolio.
  function scenarios(amount, drops, { cash = null, portfolio = null } = {}) {
    return drops.map((d) => {
      const loss = amount * d;
      return { drop: d, loss, left: amount - loss,
        ofCash: isNum(cash) && cash > 0 ? loss / cash : null,
        ofPortfolio: isNum(portfolio) && portfolio > 0 ? loss / portfolio : null };
    });
  }

  // Weight of one ticker before and after adding `amount` of cash to it. Cash moves into the position, so the total stays put.
  function weights({ ticker, amount, positions = [], cash = 0, prices = {} }) {
    let held = 0; let total = isNum(cash) ? cash : 0; let unpriced = 0;
    const values = {};
    for (const p of positions) {
      const px = isNum(prices[p.ticker]) ? prices[p.ticker] : (isNum(p.lastPrice) ? p.lastPrice : null);
      if (px == null || !isNum(p.quantity)) { unpriced++; continue; }
      const v = px * p.quantity;
      values[p.ticker] = (values[p.ticker] || 0) + v;
      total += v;
    }
    held = values[ticker] || 0;
    const after = held + amount;
    const others = Object.entries(values).filter(([k]) => k !== ticker).sort((a, b) => b[1] - a[1]);
    return {
      total, held, after, unpriced,
      before: total > 0 ? held / total : 0, afterWeight: total > 0 ? after / total : null,
      cashAfter: (isNum(cash) ? cash : 0) - amount,
      largestOther: others.length ? { ticker: others[0][0], weight: total > 0 ? others[0][1] / total : null } : null,
    };
  }

  // Buying in equal parts, one every `gap` days, against putting it all in on day one. Both judged on the last day.
  function lumpVsSplit(closes, { parts = 6, gap = MONTH } = {}) {
    const c = clean(closes);
    const H = parts * gap;
    if (parts < 2 || c.length <= H + 30) return null;
    const lump = []; const split = [];
    for (let i = 0; i + H < c.length; i += 5) {
      lump.push(c[i + H] / c[i] - 1);
      let value = 0;
      for (let j = 0; j < parts; j++) value += (1 / parts) * (c[i + H] / c[i + j * gap]);
      split.push(value - 1);
    }
    const higher = lump.filter((v, k) => v > split[k]).length;
    return {
      windows: lump.length, parts, gap, days: H,
      lumpAheadShare: higher / lump.length,
      lump: { median: percentile(lump, 0.5), p05: percentile(lump, 0.05), worst: Math.min(...lump) },
      split: { median: percentile(split, 0.5), p05: percentile(split, 0.05), worst: Math.min(...split) },
    };
  }

  // The fall that would use up a loss limit, and how often the price has fallen that far before.
  function lossLimit(amount, limit, closes, horizons = [MONTH, 3 * MONTH, YEAR]) {
    if (!(amount > 0) || !(limit > 0)) return null;
    const fall = Math.min(1, limit / amount);
    return { fall, covers: limit >= amount, frequencies: horizons.map((h) => ({ days: h, ...(reachFrequency(closes, fall, h) || { share: null, windows: 0, hit: 0 }) })) };
  }

  // Loss if the price reaches an exit level. A gap through the level costs more than the plan, so the worst day is shown beside it.
  function exitRisk({ amount, price, exit, worstDay }) {
    if (!(amount > 0) || !(price > 0) || !(exit > 0)) return null;
    if (exit >= price) return { invalid: true };
    const shares = amount / price;
    const loss = shares * (price - exit);
    return { shares, loss, fall: 1 - exit / price, ofAmount: loss / amount,
      gapLoss: isNum(worstDay) && worstDay < 0 ? Math.max(loss, amount * -worstDay) : null };
  }

  // Closes of two series re-based to 1 over the last `days` rows they share, for a side by side chart.
  function rebase(a, b, days = YEAR) {
    const mapB = new Map(b.map((r) => [r[0], r[1]]));
    const rows = a.filter((r) => mapB.has(r[0])).slice(-days);
    if (rows.length < 2) return null;
    const a0 = rows[0][1]; const b0 = mapB.get(rows[0][0]);
    return { a: rows.map((r) => [r[0], r[1] / a0 - 1]), b: rows.map((r) => [r[0], mapB.get(r[0]) / b0 - 1]) };
  }

  return { percentile, windowReturns, maxDrawdown, stats, reachFrequency, scenarios, weights, lumpVsSplit, lossLimit, exitRisk, rebase, DAY, MONTH, YEAR };
});
