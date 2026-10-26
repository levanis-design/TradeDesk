'use strict';
// Watchlist import: a table with a ticker and, optionally, a price, four buy zones and a reason.
// Zone cells are kept exactly as written. The app only compares a price with a zone when the cell is a number or a range.
const holdings = require('./holdings');

const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/['’`]/g, '').replace(/[_\-]/g, ' ').replace(/\s+/g, ' ').trim();

const COLS = {
  ticker: ['ticker', 'symbol', 'stock', 'tickers', 'symbols'],
  price: ['todays price', 'today price', 'price today', 'price', 'current price', 'last price', 'price then', 'price on date', 'price at date'],
  strongBuy: ['strong buy', 'strong buy zone', 'strong buy price', 'strongbuy'],
  goodBuy: ['good buy', 'good buy zone', 'good buy price', 'goodbuy'],
  acceptable: ['acceptable', 'acceptable buy', 'acceptable zone', 'acceptable price'],
  avoid: ['avoid', 'avoid zone', 'avoid price'],
  why: ['why its priority', 'why it is priority', 'why priority', 'why its a priority', 'priority', 'why', 'reason', 'notes', 'note', 'thesis'],
  date: ['price date', 'as of', 'as of date', 'date'],
};
const LABELS = { ticker: 'Ticker', price: 'Price', strongBuy: 'Strong Buy', goodBuy: 'Good Buy', acceptable: 'Acceptable', avoid: 'Avoid', why: 'Why it is a priority', date: 'Date' };
const ZONES = ['strongBuy', 'goodBuy', 'acceptable', 'avoid'];

const clip = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);

function detectHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const cells = (rows[i] || []).map(norm);
    if (cells.some((c) => COLS.ticker.includes(c))) return i;
  }
  return -1;
}

function mapColumns(headers) {
  const cells = headers.map(norm);
  const map = {};
  for (const [field, names] of Object.entries(COLS)) {
    for (const n of names) { const idx = cells.indexOf(n); if (idx >= 0 && !Object.values(map).includes(idx)) { map[field] = idx; break; } }
  }
  return map;
}

const isIsoDate = (s) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false; const d = new Date(`${s}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s; };

function parseWatchRows(rows) {
  const headerRow = detectHeader(rows || []);
  if (headerRow < 0) return { ok: false, error: 'No header row with a Ticker or Symbol column was found. The first row of your table should name the columns.' };
  const map = mapColumns(rows[headerRow]);
  const items = new Map(); const skipped = []; const warnings = [];
  for (let i = headerRow + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const raw = r[map.ticker];
    if (raw == null || String(raw).trim() === '') continue;
    const { ticker } = holdings.extractTicker(raw);
    if (!/^[A-Z0-9][A-Z0-9.\-=^]{0,14}$/.test(ticker) || ['TOTAL', 'TOTALS'].includes(ticker)) { skipped.push(`row ${i + 1}: "${clip(raw, 30)}" is not a ticker`); continue; }
    const price = map.price != null ? holdings.parseNumber(r[map.price]) : null;
    const item = { ticker, price: price != null && price > 0 ? price : null, why: map.why != null ? clip(r[map.why], 400) : '' };
    for (const z of ZONES) item[z] = map[z] != null ? clip(r[map[z]], 60) : '';
    if (map.date != null) { const d = holdings.parseDate(r[map.date]); if (d) item.date = d; }
    if (items.has(ticker)) warnings.push(`${ticker} appears more than once; the last row is used.`);
    items.set(ticker, item);
  }
  if (!items.size) return { ok: false, error: 'No tickers were found under the header row.' };
  const found = Object.keys(map);
  return { ok: true, headerRow, columns: found.map((f) => ({ field: f, label: LABELS[f], header: clip(rows[headerRow][map[f]], 40) })),
    missing: Object.keys(COLS).filter((f) => !found.includes(f) && f !== 'date').map((f) => LABELS[f]),
    items: [...items.values()].slice(0, 200), total: items.size, skipped: skipped.slice(0, 20), warnings: [...new Set(warnings)].slice(0, 10) };
}

// Clean items from the interface before they are saved.
function cleanItems(list, listDate) {
  const out = [];
  for (const it of Array.isArray(list) ? list.slice(0, 200) : []) {
    const t = String(it && it.ticker || '').trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9.\-=^]{0,14}$/.test(t)) continue;
    const price = Number(it.price);
    const o = { ticker: t, price: Number.isFinite(price) && price > 0 ? price : null, why: clip(it.why, 400) };
    for (const z of ZONES) o[z] = clip(it[z], 60);
    out.push(o);
  }
  return { items: out, listDate: listDate && isIsoDate(listDate) ? listDate : '' };
}

module.exports = { parseWatchRows, cleanItems, isIsoDate, COLS, ZONES };
