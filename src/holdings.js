'use strict';
// Holdings import: CSV and Excel in, one position per ticker out.
// Column names vary between brokers and personal spreadsheets, so columns are
// matched by synonym and shown to the user for confirmation before use.

const FIELDS = {
  ticker: ['ticker', 'symbol', 'instrument', 'security', 'stock', 'asset', 'holding', 'name'],
  quantity: ['quantity', 'qty', 'shares', 'units', 'shares held', 'share count', 'amount', 'position'],
  avgPrice: ['average cost', 'avg cost', 'average price', 'avg price', 'average buy price', 'cost per share',
    'avg cost/share', 'average cost per share', 'unit cost', 'cost/share', 'purchase price', 'avg. cost'],
  totalCost: ['total cost', 'cost basis', 'cost', 'total cost basis', 'invested', 'book value'],
  account: ['account', 'portfolio', 'acct', 'account name', 'brokerage'],
  price: ['price', 'last price', 'current price', 'market price', 'last', 'current'],
  marketValue: ['current total', 'market value', 'current value', 'total value', 'market val', 'value', 'current market value'],
  pnl: ['profit/loss', 'profit loss', 'p/l', 'pnl', 'p&l', 'gain/loss', 'gain loss', 'unrealized p/l', 'unrealized gain/loss', 'total gain/loss', 'profit', 'gain'],
  boughtAt: ['bought at', 'bought', 'purchase date', 'date bought', 'buy date', 'acquired', 'date acquired', 'date purchased', 'date'],
};

const CASH_TICKERS = new Set(['CASH', 'USD', 'CASH & CASH INVESTMENTS', 'CASH BALANCE', 'BUYING POWER', 'POWER']);
const SKIP_TICKERS = new Set(['TOTAL', 'TOTALS', 'GRAND TOTAL', 'SUBTOTAL', 'PORTFOLIO TOTAL']);

const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[_\-]/g, ' ').replace(/\s+/g, ' ').trim();

function parseNumber(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v).trim();
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[$€£,\s]/g, '').replace(/%$/, '');
  if (s.startsWith('-') || s.startsWith('\u2212')) { neg = !neg; s = s.slice(1); }
  else if (s.startsWith('+')) s = s.slice(1);
  if (!/^\d*\.?\d+(e[+-]?\d+)?$/i.test(s)) return null;
  const n = parseFloat(s);
  return neg ? -n : n;
}

// Minimal RFC 4180 parser: quoted fields, doubled quotes, CRLF, embedded newlines.
function parseCsv(text, delim = ',') {
  const rows = [];
  let row = [];
  let field = '';
  let q = false;
  const src = String(text).replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else q = false;
      } else field += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((x) => x !== '')) rows.push(row);
  return rows;
}

// Text copied from a spreadsheet is tab separated; files are usually comma or semicolon separated.
function parseTable(text) {
  const src = String(text).replace(/^\uFEFF/, '');
  const first = src.split(/\r?\n/).find((l) => l.trim()) || '';
  const count = (ch) => first.split(ch).length - 1;
  const delim = count('\t') > 0 ? '\t' : count(';') > count(',') ? ';' : ',';
  return parseCsv(src, delim);
}

// Dates in a sheet: ISO, US style m/d/y, Excel serial numbers and Date objects. Returns YYYY-MM-DD or null.
function parseDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(s);
  if (m) return ok(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s);
  if (m) return ok(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[1], +m[2]);
  m = /^(\d{1,2})[ -]([A-Za-z]{3})[a-z]*[ -,]*(\d{2}|\d{4})$/.exec(s);
  if (m) {
    const mon = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m[2].toLowerCase());
    if (mon >= 0) return ok(m[3].length === 2 ? 2000 + +m[3] : +m[3], mon + 1, +m[1]);
  }
  m = /^([A-Za-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})$/.exec(s);
  if (m) {
    const mon = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m[1].toLowerCase());
    if (mon >= 0) return ok(+m[3], mon + 1, +m[2]);
  }
  if (typeof v === 'number' && v > 20000 && v < 80000) { // Excel serial date
    return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
  }
  return null;
  function ok(y, mo, d) {
    if (y < 1990 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCMonth() !== mo - 1) return null;
    return dt.toISOString().slice(0, 10);
  }
}

// Find the header row: the first of the top rows that names a ticker-like and a quantity-like column.
function detectHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const cells = rows[i].map(norm);
    const hasT = cells.some((c) => FIELDS.ticker.includes(c));
    const hasQ = cells.some((c) => FIELDS.quantity.includes(c));
    if (hasT && hasQ) return i;
  }
  return -1;
}

function autoMap(headers) {
  const cells = headers.map(norm);
  const map = {};
  for (const [field, names] of Object.entries(FIELDS)) {
    // exact synonym first, in synonym priority order
    for (const n of names) {
      const idx = cells.indexOf(n);
      if (idx >= 0 && !Object.values(map).includes(idx)) { map[field] = idx; break; }
    }
  }
  return map;
}

// Accepts "NVDA", "nvda ", "NVIDIA (NVDA)", "BRK B". A company name on its own is not a ticker.
function extractTicker(v) {
  const raw = String(v == null ? '' : v).trim();
  if (!raw) return { ticker: '' };
  const paren = /\(([A-Za-z0-9.\-=^]{1,12})\)\s*$/.exec(raw);
  if (paren) return { ticker: paren[1].toUpperCase() };
  const cls = /^([A-Za-z]{1,5})[ .]([A-Za-z])$/.exec(raw);
  if (cls && raw === raw.toUpperCase()) return { ticker: `${cls[1]}-${cls[2]}`.toUpperCase() };
  if (/\s/.test(raw)) return { ticker: raw.toUpperCase().replace(/\s+/g, ''), name: true };
  return { ticker: raw.toUpperCase() };
}

function cleanTicker(v) {
  const t = String(v == null ? '' : v).trim().toUpperCase().replace(/\s+/g, '');
  return t;
}

const TICKER_RE = /^[A-Z0-9][A-Z0-9.\-=^]{0,14}$/;

/**
 * rows: array of arrays (first matching header row detected unless headerRow given)
 * Returns { headers, headerRow, mapping, positions, byAccount, cash, warnings, skipped }
 *
 * Besides ticker and quantity the importer understands a cost column (per unit or total), the current price,
 * the current total (market value), profit or loss and a purchase date or price ("Bought At").
 */
function importRows(rows, opts = {}) {
  const warnings = [];
  const headerRow = opts.headerRow != null ? opts.headerRow : detectHeader(rows);
  if (headerRow < 0) {
    return { ok: false, error: 'Could not find a header row with a ticker/symbol column and a quantity/shares column.',
      headers: rows[0] || [], headerRow: 0, mapping: {}, positions: [], byAccount: {}, cash: null, warnings, skipped: [] };
  }
  const headers = rows[headerRow].map((h) => String(h == null ? '' : h));
  const mapping = opts.mapping || autoMap(headers);
  if (mapping.ticker == null || mapping.quantity == null) {
    return { ok: false, error: 'Ticker and quantity columns must be mapped.', headers, headerRow, mapping,
      positions: [], byAccount: {}, cash: null, warnings, skipped: [] };
  }

  const lots = [];
  const skipped = [];
  const derived = new Set();
  const mismatches = [];
  let cash = null;
  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r];
    const ex = extractTicker(row[mapping.ticker]);
    const label = ex.ticker;
    if (!label) continue;
    if (SKIP_TICKERS.has(label)) { skipped.push({ row: r + 1, ticker: label, reason: 'total row' }); continue; }
    const qty = parseNumber(row[mapping.quantity]);
    if (CASH_TICKERS.has(label)) {
      const cashVal = mapping.marketValue != null ? parseNumber(row[mapping.marketValue]) : null;
      const c = cashVal != null ? cashVal : qty;
      if (c != null) cash = (cash || 0) + c;
      skipped.push({ row: r + 1, ticker: label, reason: 'treated as cash' });
      continue;
    }
    if (ex.name) { skipped.push({ row: r + 1, ticker: String(row[mapping.ticker]).trim(), reason: 'looks like a company name, not a ticker symbol' }); continue; }
    if (!TICKER_RE.test(label)) { skipped.push({ row: r + 1, ticker: label, reason: 'not a ticker' }); continue; }
    if (qty == null) { skipped.push({ row: r + 1, ticker: label, reason: 'quantity not a number' }); continue; }
    if (qty === 0) { skipped.push({ row: r + 1, ticker: label, reason: 'zero quantity' }); continue; }

    let avg = mapping.avgPrice != null ? parseNumber(row[mapping.avgPrice]) : null;
    if (avg == null && mapping.totalCost != null) {
      const total = parseNumber(row[mapping.totalCost]);
      if (total != null && qty) avg = Math.abs(total / qty);
    }
    let price = mapping.price != null ? parseNumber(row[mapping.price]) : null;
    const mv = mapping.marketValue != null ? parseNumber(row[mapping.marketValue]) : null;
    if (price == null && mv != null && qty) price = Math.abs(mv / qty);
    const pnlRaw = mapping.pnl != null ? row[mapping.pnl] : null;
    const pnl = pnlRaw == null ? null : (/%/.test(String(pnlRaw)) ? null : parseNumber(pnlRaw));

    // "Bought At" can be a date or a price. A date is kept as the purchase date; a number is used as the
    // per-unit price only when there is no other cost column.
    let boughtAt = null;
    if (mapping.boughtAt != null) {
      const cell = row[mapping.boughtAt];
      boughtAt = parseDate(cell);
      if (!boughtAt && avg == null) {
        const n = parseNumber(cell);
        if (n != null && n > 0) avg = n;
      }
    }
    // Cost from the profit or loss, when nothing else gives it: cost = price - pnl / quantity.
    if (avg == null && price != null && pnl != null && qty) {
      const c = price - pnl / qty;
      if (c > 0) { avg = c; derived.add(label); }
    }
    // Cross-check the sheet against itself.
    if (avg != null && price != null && pnl != null && !derived.has(label)) {
      const expected = (price - avg) * qty;
      const tol = Math.max(1, Math.abs(avg * qty) * 0.01);
      if (Math.abs(expected - pnl) > tol) mismatches.push(`${label}: Profit/Loss in the sheet is ${pnl.toFixed(2)}, but (price − cost) × quantity gives ${expected.toFixed(2)}`);
    }
    lots.push({
      ticker: label,
      quantity: qty,
      avgPrice: avg,
      lastPrice: price,
      marketValue: mv != null ? mv : (price != null ? price * qty : null),
      boughtAt,
      account: mapping.account != null ? String(row[mapping.account] == null ? '' : row[mapping.account]).trim() || 'Unassigned' : 'Unassigned',
    });
  }

  // One position per ticker across accounts: quantities add, average price is quantity-weighted.
  const byTicker = new Map();
  const byAccount = Object.create(null);
  for (const l of lots) {
    const e = byTicker.get(l.ticker) || { ticker: l.ticker, quantity: 0, costNum: 0, costQty: 0, accounts: Object.create(null), lastPrice: null, boughtAt: null };
    e.quantity += l.quantity;
    if (l.avgPrice != null) { e.costNum += l.avgPrice * Math.abs(l.quantity); e.costQty += Math.abs(l.quantity); }
    if (l.lastPrice != null) e.lastPrice = l.lastPrice;
    if (l.boughtAt && (!e.boughtAt || l.boughtAt < e.boughtAt)) e.boughtAt = l.boughtAt;
    e.accounts[l.account] = (e.accounts[l.account] || 0) + l.quantity;
    byTicker.set(l.ticker, e);
    (byAccount[l.account] = byAccount[l.account] || []).push({ ticker: l.ticker, quantity: l.quantity, avgPrice: l.avgPrice });
  }
  const positions = [...byTicker.values()].map((e) => {
    const hasCost = e.costQty > 0;
    if (hasCost && e.costQty < Math.abs(e.quantity) - 1e-9) {
      warnings.push(`${e.ticker}: average price is missing for part of the position, so it covers only ${e.costQty.toFixed(4)} of ${Math.abs(e.quantity).toFixed(4)} units.`);
    }
    return {
      ticker: e.ticker,
      quantity: round(e.quantity, 6),
      averagePrice: hasCost ? round(e.costNum / e.costQty, 4) : null,
      lastPrice: e.lastPrice != null ? round(e.lastPrice, 4) : null,
      boughtAt: e.boughtAt,
      accounts: e.accounts,
    };
  }).sort((a, b) => a.ticker.localeCompare(b.ticker));

  if (!positions.length) warnings.push('No positions found below the header row.');
  if (mapping.avgPrice == null && mapping.totalCost == null && mapping.boughtAt == null && !derived.size) warnings.push('No cost column mapped, so average prices are blank. The agents will see quantities only.');
  if (derived.size) warnings.push(`Average cost was worked out from price and Profit/Loss for ${[...derived].join(', ')}. Check it against your records.`);
  if (mismatches.length) warnings.push(`${mismatches.length} row${mismatches.length === 1 ? '' : 's'} where Profit/Loss does not match price and cost (data to be confirmed): ${mismatches.slice(0, 4).join('; ')}${mismatches.length > 4 ? '; …' : ''}`);
  return { ok: true, headers, headerRow, mapping, positions, byAccount, cash, warnings, skipped };
}

// Add imported positions to existing ones: quantities add, average cost is quantity-weighted.
function mergePositions(existing, incoming) {
  const map = new Map();
  for (const p of [...(existing || []), ...(incoming || [])]) {
    const e = map.get(p.ticker) || { ticker: p.ticker, quantity: 0, costNum: 0, costQty: 0, accounts: Object.create(null), lastPrice: null, boughtAt: null };
    e.quantity += p.quantity;
    if (p.averagePrice != null) { e.costNum += p.averagePrice * Math.abs(p.quantity); e.costQty += Math.abs(p.quantity); }
    if (p.lastPrice != null) e.lastPrice = p.lastPrice;
    if (p.boughtAt && (!e.boughtAt || p.boughtAt < e.boughtAt)) e.boughtAt = p.boughtAt;
    for (const [a, q] of Object.entries(p.accounts || {})) e.accounts[a] = (e.accounts[a] || 0) + q;
    map.set(p.ticker, e);
  }
  return [...map.values()].filter((e) => e.quantity !== 0).map((e) => ({
    ticker: e.ticker, quantity: round(e.quantity, 6), averagePrice: e.costQty > 0 ? round(e.costNum / e.costQty, 4) : null,
    lastPrice: e.lastPrice, boughtAt: e.boughtAt, accounts: e.accounts,
  })).sort((a, b) => a.ticker.localeCompare(b.ticker));
}

function round(n, d) { const f = 10 ** d; return Math.round(n * f) / f; }

async function readXlsxRows(filePath) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const sheets = wb.worksheets.map((ws) => {
    const rows = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const out = [];
      row.eachCell({ includeEmpty: true }, (cell, col) => {
        let v = cell.value;
        if (v && typeof v === 'object') {
          if ('result' in v) v = v.result;               // formula result, not the formula
          else if ('text' in v) v = v.text;               // hyperlink
          else if (Array.isArray(v.richText)) v = v.richText.map((t) => t.text).join('');
          else if (v instanceof Date) v = v.toISOString().slice(0, 10);
          else v = null;
        }
        out[col - 1] = v == null ? '' : v;
      });
      rows.push(out);
    });
    return { name: ws.name, rows };
  });
  return sheets;
}

async function readFileRows(filePath, fs = require('fs')) {
  if (/\.xlsx$/i.test(filePath)) {
    const sheets = await readXlsxRows(filePath);
    return { kind: 'xlsx', sheets };
  }
  if (/\.csv$/i.test(filePath) || /\.txt$/i.test(filePath)) {
    const text = fs.readFileSync(filePath, 'utf8');
    return { kind: 'csv', sheets: [{ name: 'CSV', rows: parseCsv(text) }] };
  }
  throw new Error('Unsupported file type. Use .xlsx or .csv (export older .xls files as .xlsx).');
}

// Convert confirmed import into the shape the engine/portfolio uses.
function toPortfolio(holdings, cash, currency = 'USD') {
  return {
    cash: cash == null ? null : cash,
    currency,
    positions: (holdings || []).map((p) => ({ ticker: p.ticker, quantity: p.quantity, average_price: p.averagePrice })),
  };
}

module.exports = { parseNumber, parseCsv, parseTable, parseDate, extractTicker, mergePositions, detectHeader, autoMap, importRows, readFileRows, readXlsxRows, toPortfolio, FIELDS };
