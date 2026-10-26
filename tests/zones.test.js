'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Z = require('../renderer/zones');
const W = require('../src/watchlist');

test('zone text: ranges, limits and single numbers', () => {
  assert.deepStrictEqual(Z.parseZone('$100 - $120', 'goodBuy'), { lo: 100, hi: 120 });
  assert.deepStrictEqual(Z.parseZone('100 to 90', 'goodBuy'), { lo: 90, hi: 100 });
  assert.deepStrictEqual(Z.parseZone('under 85', 'strongBuy'), { lo: null, hi: 85 });
  assert.deepStrictEqual(Z.parseZone('1,200+', 'avoid'), { lo: 1200, hi: null });
  assert.deepStrictEqual(Z.parseZone('95', 'strongBuy'), { lo: null, hi: 95 });
  assert.deepStrictEqual(Z.parseZone('150', 'avoid'), { lo: 150, hi: null });
  assert.strictEqual(Z.parseZone('wait for earnings', 'avoid'), null);
  assert.strictEqual(Z.parseZone('', 'avoid'), null);
});
test('a price falls in the first matching zone, or none', () => {
  const it = { strongBuy: 'under 100', goodBuy: '100-120', acceptable: '120-140', avoid: '150' };
  assert.strictEqual(Z.zoneFor(90, it).key, 'strongBuy');
  assert.strictEqual(Z.zoneFor(110, it).key, 'goodBuy');
  assert.strictEqual(Z.zoneFor(145, it), null);
  assert.strictEqual(Z.zoneFor(160, it).key, 'avoid');
  assert.strictEqual(Z.zoneFor(100, it).key, 'strongBuy');
  assert.strictEqual(Z.zoneFor(null, it), null);
});
test('price on a date uses the last close on or before it', () => {
  const h = [['2026-01-02', 10], ['2026-01-05', 11], ['2026-01-06', 12]];
  assert.strictEqual(Z.priceOn(h, '2026-01-04'), 10);
  assert.strictEqual(Z.priceOn(h, '2026-01-06'), 12);
  assert.strictEqual(Z.priceOn(h, '2025-12-01'), null);
});
test('the watchlist table is read by header name, with the user columns', () => {
  const rows = [['My list'], ['Ticker', "Today's price", 'Strong Buy', 'Good Buy', 'Acceptable', 'Avoid', "Why it's priority"],
    ['nvda', '$182.5', 'under 150', '150-170', '170-190', '250', 'AI demand'], ['NVIDIA (AVGO)', '', '', '', '', '', ''], ['', '', ''], ['bad ticker!', 1], ['NVDA', 190, '', '', '', '', 'later row wins']];
  const p = W.parseWatchRows(rows);
  assert.ok(p.ok);
  assert.strictEqual(p.headerRow, 1);
  assert.deepStrictEqual(p.items.map((i) => i.ticker), ['NVDA', 'AVGO']);
  assert.strictEqual(p.items[0].price, 190);
  assert.strictEqual(p.items[0].why, 'later row wins');
  assert.ok(p.warnings.some((w) => /NVDA/.test(w)));
  assert.strictEqual(p.skipped.length, 1);
  assert.deepStrictEqual(p.missing, []);
});
test('a table with no ticker header is refused with a reason', () => {
  assert.strictEqual(W.parseWatchRows([['a', 'b'], [1, 2]]).ok, false);
  assert.strictEqual(W.parseWatchRows([['Ticker'], ['']]).ok, false);
});
test('saved items are cleaned and dates checked', () => {
  const c = W.cleanItems([{ ticker: 'abc', price: '12', why: 'x'.repeat(900), strongBuy: 'y'.repeat(200) }, { ticker: '<b>' }], '2026-02-30');
  assert.strictEqual(c.items.length, 1);
  assert.strictEqual(c.items[0].why.length, 400);
  assert.strictEqual(c.items[0].strongBuy.length, 60);
  assert.strictEqual(c.listDate, '');
});
