'use strict';
// Reads the Strong Buy, Good Buy, Acceptable and Avoid cells of an uploaded watchlist and says which one a price falls in.
// A cell is compared only when it is a number or a range. Anything else ("wait for earnings") is shown as written and never compared.
// A single number is read as "at or below" for the three buy zones and "at or above" for Avoid.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.Zones = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const ORDER = ['strongBuy', 'goodBuy', 'acceptable', 'avoid'];
  const LABEL = { strongBuy: 'Strong Buy', goodBuy: 'Good Buy', acceptable: 'Acceptable', avoid: 'Avoid' };
  const num = (s) => { const n = Number(String(s).replace(/[$,\s]/g, '')); return Number.isFinite(n) && String(s).trim() !== '' ? n : null; };
  const N = '\\$?\\s*(\\d[\\d,]*(?:\\.\\d+)?)';

  // Returns {lo, hi} (either may be null for open ended) or null when the text is not a number or range.
  function parseZone(text, field) {
    const t = String(text == null ? '' : text).trim().toLowerCase().replace(/−/g, '-');
    if (!t) return null;
    let m;
    if ((m = new RegExp(`^${N}\\s*(?:-|–|—|to)\\s*${N}$`).exec(t))) { const a = num(m[1]), b = num(m[2]); return a == null || b == null ? null : { lo: Math.min(a, b), hi: Math.max(a, b) }; }
    if ((m = new RegExp(`^(?:<=|<|≤|under|below|up to|at or below|max)\\s*${N}$`).exec(t))) return { lo: null, hi: num(m[1]) };
    if ((m = new RegExp(`^(?:>=|>|≥|over|above|at or above|min)\\s*${N}$`).exec(t))) return { lo: num(m[1]), hi: null };
    if ((m = new RegExp(`^${N}\\s*(?:\\+|or more|or higher|and above)$`).exec(t))) return { lo: num(m[1]), hi: null };
    if ((m = new RegExp(`^${N}\\s*(?:or less|or lower|and below)$`).exec(t))) return { lo: null, hi: num(m[1]) };
    if ((m = new RegExp(`^${N}$`).exec(t))) { const v = num(m[1]); return field === 'avoid' ? { lo: v, hi: null } : { lo: null, hi: v }; }
    return null;
  }

  // The first zone, in the order Strong Buy, Good Buy, Acceptable, Avoid, whose range holds the price. Null when none does.
  function zoneFor(price, item) {
    if (typeof price !== 'number' || !Number.isFinite(price) || !item) return null;
    for (const f of ORDER) {
      const z = parseZone(item[f], f);
      if (!z) continue;
      if ((z.lo == null || price >= z.lo) && (z.hi == null || price <= z.hi)) return { key: f, label: LABEL[f], text: item[f] };
    }
    return null;
  }
  const hasZones = (item) => !!item && ORDER.some((f) => item[f]);

  // Close on or before a date from [[date, close], ...] history. Null when the history does not reach back that far.
  function priceOn(history, date) {
    if (!Array.isArray(history) || !history.length || !date) return null;
    if (history[0][0] > date) return null;
    let best = null;
    for (const [d, c] of history) { if (d <= date) best = c; else break; }
    return typeof best === 'number' ? best : null;
  }
  return { parseZone, zoneFor, hasZones, priceOn, ORDER, LABEL };
});
