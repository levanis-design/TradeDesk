'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Advice = require('../renderer/advice');
const P = require('../renderer/portfolio');

const held = { quantity: 10, averagePrice: 100 };

test('advice: a Buy on something you hold asks about adding, and flags concentration', () => {
  const a = Advice.decide({ ticker: 'NVDA', rating: 'Buy', position: held, price: 150, cash: 500, weight: 0.4 });
  assert.equal(a.label, 'Add');
  assert.match(a.question, /Add to your NVDA/);
  assert.ok(a.cautions.some((c) => /40%/.test(c)));
  assert.ok(a.facts.some((f) => /gain of 500\.00 \(\+50\.0%\)/.test(f)), a.facts.join('|'));
  assert.match(a.disclaimer, /not financial advice/);
});
test('advice: a Buy on something you do not hold asks about opening, never sizes the trade', () => {
  const a = Advice.decide({ ticker: 'AVGO', rating: 'Buy', position: null, cash: 1000 });
  assert.equal(a.label, 'Open a position');
  assert.ok(a.options.some((o) => /does not size/.test(o.detail)));
  assert.ok(a.facts.some((f) => /no AVGO/.test(f)));
});
test('advice: Sell on a held position carries the tax note; on an unheld one it says do not touch', () => {
  const s = Advice.decide({ ticker: 'X', rating: 'Sell', position: held, price: 150 });
  assert.equal(s.label, 'Exit');
  assert.ok(s.cautions.includes(Advice.TAX));
  const loss = Advice.decide({ ticker: 'X', rating: 'Underweight', position: held, price: 80 });
  assert.equal(loss.label, 'Trim');
  assert.ok(!loss.cautions.includes(Advice.TAX));
  const none = Advice.decide({ ticker: 'X', rating: 'Sell', position: null });
  assert.equal(none.label, 'Do not touch');
});
test('advice: Hold means no action when not held, keep holding when held', () => {
  assert.equal(Advice.decide({ ticker: 'X', rating: 'Hold', position: null }).label, 'No action');
  assert.equal(Advice.decide({ ticker: 'X', rating: 'Hold', position: held }).label, 'Keep holding');
});
test('advice: REVIEW is never presented as a Hold', () => {
  const a = Advice.decide({ ticker: 'X', rating: 'REVIEW', position: held });
  assert.equal(a.label, 'Read it yourself');
  assert.match(a.options[0].detail, /Do not treat this as a Hold/);
});

test('portfolio: totals use fresh prices over stored ones and report what is missing', () => {
  const pos = [{ ticker: 'A', quantity: 10, averagePrice: 10, lastPrice: 11 }, { ticker: 'B', quantity: 5, averagePrice: 20 }];
  const t = P.totals(pos, { A: 12 });
  assert.equal(t.value, 120);
  assert.deepEqual(t.missing, ['B']);
  assert.equal(t.cost, 200);
  assert.ok(Math.abs(t.pl - 20) < 1e-9);
});
test('portfolio: allocation rolls the tail into Other and adds cash', () => {
  const pos = Array.from({ length: 12 }, (_, i) => ({ ticker: 'T' + i, quantity: 1, lastPrice: 100 - i }));
  const a = P.allocation(pos, 50, {}, 5);
  assert.equal(a.items.length, 6);
  assert.equal(a.items[4].name, 'Other');
  assert.equal(a.items[5].name, 'Cash');
  assert.ok(Math.abs(a.items.reduce((s, r) => s + r.weight, 0) - 1) < 1e-9);
  assert.equal(P.weightOf('T0', pos.slice(0, 2), 0), 100 / 199);
});
test('portfolio: the timeline starts when every held ticker has a price, and forward fills', () => {
  const pos = [{ ticker: 'A', quantity: 2, averagePrice: 10 }, { ticker: 'B', quantity: 1, averagePrice: 5 }, { ticker: 'C', quantity: 1 }];
  const hist = {
    A: [['2024-01-01', 10], ['2024-01-02', 11], ['2024-01-03', 12]],
    B: [['2024-01-02', 5], ['2024-01-04', 7]],
  };
  const t = P.timeline(pos, hist);
  assert.deepEqual(t.skipped, ['C']);
  assert.equal(t.start, '2024-01-02');
  assert.deepEqual(t.points, [['2024-01-02', 27], ['2024-01-03', 29], ['2024-01-04', 31]]);
  assert.equal(t.cost, 25);   // cost covers the same positions the line covers
  assert.equal(P.timeline([pos[0], { ticker: 'B', quantity: 1 }], hist).cost, null);
});
test('portfolio: range slicing keeps the end and change() is relative to the first point', () => {
  const pts = Array.from({ length: 400 }, (_, i) => [new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10), 100 + i]);
  const m = P.slice(pts, '1M');
  assert.ok(m.length >= 30 && m.length <= 33);
  assert.equal(m[m.length - 1], pts[399]);
  assert.equal(P.slice(pts, 'Max').length, 400);
  const c = P.change([['a', 100], ['b', 125]]);
  assert.equal(c.pct, 0.25);
});

test('aggregate merges neighbouring bars and keeps open, high, low, close and volume', () => {
  const bars = [['a', 10, 12, 9, 11, 5], ['b', 11, 15, 10, 14, 6], ['c', 14, 14, 8, 9, 7], ['d', 9, 10, 9, 10, 1]];
  assert.equal(P.aggregate(bars, 10), bars);
  const g = P.aggregate(bars, 2);
  assert.deepEqual(g, [['a', 10, 15, 9, 14, 11], ['c', 14, 14, 8, 10, 8]]);
});
test('candles add up each holding by bar, fill a missing bar with the last close, and start when every holding has data', () => {
  const by = {
    A: [['2026-10-01', 10, 11, 9, 10, 1], ['2026-10-02', 10, 12, 10, 11, 1], ['2026-10-03', 11, 13, 11, 12, 1]],
    B: [['2026-10-02', 100, 101, 99, 100, 5], ['2026-10-03', 100, 105, 100, 104, 5]],
  };
  const r = P.candles([{ ticker: 'A', quantity: 2 }, { ticker: 'B', quantity: 1 }, { ticker: 'C', quantity: 3 }], by);
  assert.deepEqual(r.skipped, ['C']);
  assert.equal(r.start, '2026-10-02');
  assert.deepEqual(r.bars[0], ['2026-10-02', 120, 125, 119, 122, 6]);
  assert.deepEqual(r.bars[1], ['2026-10-03', 122, 131, 122, 128, 6]);
  const gap = P.candles([{ ticker: 'A', quantity: 1 }, { ticker: 'B', quantity: 1 }], { A: by.A, B: [by.B[0]] });
  // B has no bar on the 3rd, so it is carried at its last close (100) with no range
  assert.deepEqual(gap.bars[1], ['2026-10-03', 110, 113, 111, 112, 1].map((v, i) => (i === 1 ? 11 + 100 : i === 2 ? 13 + 100 : i === 3 ? 11 + 100 : i === 4 ? 12 + 100 : v)));
});
test('sortRows sorts numbers and text, puts missing values last either way, and is stable', () => {
  const rows = [{ t: 'b', v: 2 }, { t: 'a', v: null }, { t: 'c', v: 10 }, { t: 'd', v: 2 }];
  const get = (r, k) => r[k];
  assert.deepEqual(P.sortRows(rows, 'v', 'asc', get).map((r) => r.t), ['b', 'd', 'c', 'a']);
  assert.deepEqual(P.sortRows(rows, 'v', 'desc', get).map((r) => r.t), ['c', 'b', 'd', 'a']);
  assert.deepEqual(P.sortRows(rows, 't', 'desc', get).map((r) => r.t), ['d', 'c', 'b', 'a']);
});
test('every interval offers only ranges Yahoo has data for, and each maps to a period', () => {
  for (const [k, v] of Object.entries(P.INTERVALS)) for (const r of v.ranges) assert.ok(P.PERIODS[r], `${k} ${r}`);
  assert.deepEqual(P.INTERVALS['1m'].ranges, ['1D', '5D']);
});
