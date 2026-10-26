'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../renderer/risk');

const rising = Array.from({ length: 400 }, (_, i) => 100 + i * 0.1);
const crash = [...Array.from({ length: 200 }, () => 100), ...Array.from({ length: 5 }, (_, i) => 100 - (i + 1) * 5), ...Array.from({ length: 200 }, () => 75)];

test('risk: percentile interpolates and ignores junk', () => {
  assert.equal(R.percentile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(R.percentile([10, 20], 0.25), 12.5);
  assert.equal(R.percentile([], 0.5), null);
  assert.equal(R.percentile([NaN, 4], 0.5), 4);
});

test('risk: stats needs enough history, and finds the worst day and drawdown', () => {
  assert.equal(R.stats(rising.slice(0, 20)), null);
  const s = R.stats(crash);
  assert.ok(Math.abs(s.worstDay - (-5 / 80)) < 1e-9);
  assert.ok(Math.abs(s.maxDrawdown - (-0.25)) < 1e-9);
  assert.ok(s.annualVol > 0);
  assert.equal(R.stats(rising).maxDrawdown, 0);
});

test('risk: reachFrequency counts windows where the line was touched, not just the end price', () => {
  const dip = [...Array.from({ length: 50 }, () => 100), 85, 100, ...Array.from({ length: 50 }, () => 100)];
  const r = R.reachFrequency(dip, 0.1, 5);
  assert.ok(r.hit >= 5 && r.share > 0 && r.share < 0.2);
  assert.equal(R.reachFrequency(rising, 0.1, 21).share, 0);
  assert.equal(R.reachFrequency(rising, 0, 21), null);
});

test('risk: scenarios put a loss against cash and the whole portfolio', () => {
  const s = R.scenarios(1000, [0.1, 0.5], { cash: 4000, portfolio: 20000 });
  assert.equal(s[0].loss, 100);
  assert.equal(s[1].left, 500);
  assert.equal(s[1].ofCash, 0.125);
  assert.equal(s[1].ofPortfolio, 0.025);
  assert.equal(R.scenarios(1000, [0.1], {})[0].ofCash, null);
});

test('risk: weights move cash into the position without changing the total', () => {
  const w = R.weights({ ticker: 'AAA', amount: 2000, cash: 5000, positions: [{ ticker: 'AAA', quantity: 10, lastPrice: 100 }, { ticker: 'BBB', quantity: 20, lastPrice: 100 }] });
  assert.equal(w.total, 8000);
  assert.equal(w.before, 1000 / 8000);
  assert.equal(w.afterWeight, 3000 / 8000);
  assert.equal(w.cashAfter, 3000);
  assert.deepEqual(w.largestOther, { ticker: 'BBB', weight: 0.25 });
  const none = R.weights({ ticker: 'ZZZ', amount: 500, cash: 500, positions: [] });
  assert.equal(none.afterWeight, 1);
  assert.equal(R.weights({ ticker: 'A', amount: 1, cash: 10, positions: [{ ticker: 'B', quantity: 1 }] }).unpriced, 1);
});

test('risk: lump sum against splitting on a steadily rising price favours the lump sum every time', () => {
  const r = R.lumpVsSplit(rising, { parts: 6, gap: 21 });
  assert.equal(r.lumpAheadShare, 1);
  assert.ok(r.lump.median > r.split.median);
  assert.equal(R.lumpVsSplit(rising.slice(0, 100), { parts: 6 }), null);
});

test('risk: on a falling price splitting loses less than the lump sum', () => {
  const falling = Array.from({ length: 400 }, (_, i) => 200 - i * 0.2);
  const r = R.lumpVsSplit(falling, { parts: 4, gap: 21 });
  assert.equal(r.lumpAheadShare, 0);
  assert.ok(r.split.worst > r.lump.worst);
});

test('risk: a loss limit converts to the fall that uses it up', () => {
  const l = R.lossLimit(5000, 500, crash);
  assert.equal(l.fall, 0.1);
  assert.equal(l.covers, false);
  assert.equal(l.frequencies.length, 3);
  assert.equal(R.lossLimit(500, 800, crash).covers, true);
  assert.equal(R.lossLimit(0, 100, crash), null);
});

test('risk: an exit level gives the planned loss and a worse loss if the price gaps through', () => {
  const e = R.exitRisk({ amount: 1000, price: 50, exit: 45, worstDay: -0.18 });
  assert.equal(e.shares, 20);
  assert.equal(e.loss, 100);
  assert.equal(e.gapLoss, 180);
  assert.equal(R.exitRisk({ amount: 1000, price: 50, exit: 55 }).invalid, true);
  assert.equal(R.exitRisk({ amount: 1000, price: 50, exit: 0 }), null);
});

test('risk: rebase aligns two series on shared dates', () => {
  const a = [['2026-01-01', 10], ['2026-01-02', 11], ['2026-01-03', 12]];
  const b = [['2026-01-02', 100], ['2026-01-03', 90]];
  const r = R.rebase(a, b);
  assert.deepEqual(r.a.map((x) => x[0]), ['2026-01-02', '2026-01-03']);
  assert.ok(Math.abs(r.a[1][1] - (12 / 11 - 1)) < 1e-12);
  assert.ok(Math.abs(r.b[1][1] - (-0.1)) < 1e-12);
  assert.equal(R.rebase(a, [['x', 1]]), null);
});

test('risk: the module gives no recommendation words', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'renderer', 'risk.js'), 'utf8');
  assert.ok(!/\b(should buy|recommend(ed)? amount|optimal size|safe amount)\b/i.test(src.replace(/\/\/.*$/gm, '')));
});
