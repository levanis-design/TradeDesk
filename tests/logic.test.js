'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const H = require('../src/holdings');
const S = require('../src/scoring');
const { createStore, cleanSettings, cleanTicker } = require('../src/store');
const R = require('../src/requests');
const B = require('../src/batch');
const { buildBrief } = require('../src/brief');
const HW = require('../src/hardware');
const SETUP = require('../src/setup');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'td-'));

// ------------------------------------------------------------------ holdings
test('parseNumber handles currency, commas, negatives and junk', () => {
  assert.equal(H.parseNumber('$1,234.50'), 1234.5);
  assert.equal(H.parseNumber('(12.5)'), -12.5);
  assert.equal(H.parseNumber('-3'), -3);
  assert.equal(H.parseNumber(7), 7);
  assert.equal(H.parseNumber(''), null);
  assert.equal(H.parseNumber('abc'), null);
  assert.equal(H.parseNumber('1e3'), 1000);
  assert.equal(H.parseNumber(NaN), null);
});

test('parseCsv handles quotes, doubled quotes, CRLF and BOM', () => {
  const rows = H.parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n\r\nlast,1');
  assert.deepEqual(rows, [['a', 'b'], ['x, y', 'say "hi"'], ['last', '1']]);
});

const CSV = [
  'Report generated 2026-10-24,,,',
  'Account,Symbol,Shares,Average Cost,Name',
  'Savings,NVDA,4.065662,219.06,Nvidia',
  'Chase,NVDA,3.76,201.58,Nvidia',
  'Savings,SCHD,96.7,"$32.10",Schwab',
  'Joint,SCHD,9.58,31.00,',
  'Joint,CASH,848.98,,',
  'Savings,Total,,,',
  'Savings,XYZ,0,10,',
  'Savings,,5,1,',
  'Savings,BAD TICKER!,5,1,',
  'Savings,JEPQ,abc,50,',
].join('\n');

test('import: header found below a title row, accounts merged, weighted average cost', () => {
  const r = H.importRows(H.parseCsv(CSV));
  assert.equal(r.ok, true);
  assert.equal(r.headerRow, 1);
  const nvda = r.positions.find((p) => p.ticker === 'NVDA');
  assert.equal(nvda.quantity, 7.825662);
  // (4.065662*219.06 + 3.76*201.58) / 7.825662
  const expected = (4.065662 * 219.06 + 3.76 * 201.58) / 7.825662;
  assert.ok(Math.abs(nvda.averagePrice - expected) < 1e-3);
  assert.deepEqual(Object.keys(nvda.accounts).sort(), ['Chase', 'Savings']);
  const schd = r.positions.find((p) => p.ticker === 'SCHD');
  assert.equal(schd.quantity, 106.28);
  assert.equal(r.cash, 848.98);
  const reasons = Object.fromEntries(r.skipped.map((s) => [s.ticker, s.reason]));
  assert.equal(reasons.TOTAL, 'total row');
  assert.equal(reasons.XYZ, 'zero quantity');
  assert.equal(reasons.JEPQ, 'quantity not a number');
  assert.match(reasons['BAD TICKER!'] || '', /company name/);
  assert.equal(r.positions.length, 2);
});

test('import: average derived from total cost when no per-unit column', () => {
  const r = H.importRows(H.parseCsv('Ticker,Qty,Cost Basis\nAAA,10,"$1,500.00"\nBBB,2,100'));
  assert.equal(r.positions.find((p) => p.ticker === 'AAA').averagePrice, 150);
  assert.equal(r.positions.find((p) => p.ticker === 'BBB').averagePrice, 50);
});

test('import: no cost column warns and leaves average blank', () => {
  const r = H.importRows(H.parseCsv('Symbol,Quantity\nAAA,3'));
  assert.equal(r.positions[0].averagePrice, null);
  assert.ok(r.warnings.some((w) => /No cost column/.test(w)));
});

test('import: partial cost coverage is reported, not hidden', () => {
  const r = H.importRows(H.parseCsv('Account,Symbol,Quantity,Average Cost\nA,AAA,10,5\nB,AAA,10,'));
  assert.ok(r.warnings.some((w) => /AAA: average price is missing for part/.test(w)));
});

test('import: file without usable columns fails clearly', () => {
  const r = H.importRows(H.parseCsv('foo,bar\n1,2'));
  assert.equal(r.ok, false);
  assert.match(r.error, /header row/);
});

test('import: explicit mapping overrides detection', () => {
  const rows = H.parseCsv('A,B,C\nNVDA,5,100');
  const r = H.importRows(rows, { headerRow: 0, mapping: { ticker: 0, quantity: 1, avgPrice: 2 } });
  assert.equal(r.positions[0].averagePrice, 100);
  const bad = H.importRows(rows, { headerRow: 0, mapping: { ticker: 0 } });
  assert.equal(bad.ok, false);
});

test('import: short positions keep their sign', () => {
  const r = H.importRows(H.parseCsv('Symbol,Quantity,Average Cost\nAAA,-5,10'));
  assert.equal(r.positions[0].quantity, -5);
});

test('xlsx round trip through exceljs, formula results used', async () => {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Holdings');
  ws.addRow(['Symbol', 'Quantity', 'Average Cost']);
  ws.addRow(['NVDA', 12, 219.06]);
  ws.addRow(['GOOG', { formula: 'A1*0+8', result: 8 }, 330]);
  const file = path.join(tmp(), 'h.xlsx');
  await wb.xlsx.writeFile(file);
  const parsed = await H.readFileRows(file);
  assert.equal(parsed.kind, 'xlsx');
  const r = H.importRows(parsed.sheets[0].rows);
  assert.equal(r.positions.find((p) => p.ticker === 'GOOG').quantity, 8);
  assert.equal(r.positions.find((p) => p.ticker === 'NVDA').averagePrice, 219.06);
});

test('unsupported file type is refused', async () => {
  await assert.rejects(() => H.readFileRows('/x/holdings.pdf'), /Unsupported/);
});

test('toPortfolio keeps empty book distinct from no context', () => {
  assert.equal(R.portfolioFor(null, { cashOverride: '' }), null);
  assert.equal(R.portfolioFor({ positions: [], cash: null }, { cashOverride: '' }), null);
  const withCash = R.portfolioFor({ positions: [], cash: 100 }, { cashOverride: '' });
  assert.deepEqual(withCash, { cash: 100, currency: 'USD', positions: [] });
  assert.equal(R.portfolioFor({ positions: [{ ticker: 'A', quantity: 1, averagePrice: 2 }], cash: 5 }, { cashOverride: '' }, false), null);
  const o = R.portfolioFor({ positions: [{ ticker: 'A', quantity: 1, averagePrice: 2 }], cash: 5 }, { cashOverride: '900' });
  assert.equal(o.cash, 900);
  assert.deepEqual(o.positions[0], { ticker: 'A', quantity: 1, average_price: 2 });
});

// ------------------------------------------------------------------- scoring
const px = (aE, aL, bE, bL, n = 10) => ({
  asset: { entry_date: 'd1', entry: aE, latest_date: 'd2', latest: aL, closes_after: n },
  bench: { entry_date: 'd1', entry: bE, latest_date: 'd2', latest: bL, closes_after: n },
});

test('scoring: bullish call that beat the benchmark is a hit', () => {
  const s = S.scoreEntry({ id: 1, rating: 'Buy' }, px(100, 110, 100, 102));
  assert.equal(s.status, 'scored');
  assert.ok(Math.abs(s.alpha - 0.08) < 1e-9);
  assert.equal(s.hit, true);
});

test('scoring: bearish call on a stock that lagged is a hit; Hold is never a hit or miss', () => {
  assert.equal(S.scoreEntry({ id: 1, rating: 'Sell' }, px(100, 95, 100, 101)).hit, true);
  assert.equal(S.scoreEntry({ id: 1, rating: 'Underweight' }, px(100, 120, 100, 101)).hit, false);
  assert.equal(S.scoreEntry({ id: 1, rating: 'Hold' }, px(100, 120, 100, 101)).hit, null);
});

test('scoring: too early, no data, no benchmark, unscored rating', () => {
  assert.equal(S.scoreEntry({ rating: 'Buy' }, px(100, 101, 100, 100, 2)).status, 'too-early');
  assert.equal(S.scoreEntry({ rating: 'Buy' }, null).status, 'no-data');
  assert.equal(S.scoreEntry({ rating: 'Buy' }, { error: 'x' }).status, 'no-data');
  assert.equal(S.scoreEntry({ rating: 'Buy' }, { asset: null }).status, 'no-data');
  assert.equal(S.scoreEntry({ rating: 'Buy' }, { asset: px(1, 2, 1, 1).asset, bench: null }).status, 'no-benchmark');
  assert.equal(S.scoreEntry({ rating: 'REVIEW' }, px(100, 110, 100, 100)).status, 'unscored');
});

test('scoring: aggregate by rating, small-sample caution', () => {
  const rows = [
    S.scoreEntry({ id: 1, rating: 'Buy' }, px(100, 110, 100, 100)),
    S.scoreEntry({ id: 2, rating: 'Buy' }, px(100, 90, 100, 100)),
    S.scoreEntry({ id: 3, rating: 'Sell' }, px(100, 90, 100, 100)),
    S.scoreEntry({ id: 4, rating: 'Hold' }, px(100, 101, 100, 100)),
    S.scoreEntry({ id: 5, rating: 'Buy' }, px(100, 101, 100, 100, 1)),
  ];
  const a = S.aggregate(rows);
  assert.equal(a.scored, 4);
  assert.equal(a.directional, 3);
  assert.ok(Math.abs(a.hitRate - 2 / 3) < 1e-9);
  assert.equal(a.pending, 1);
  assert.match(a.caution, /Only 4 scored/);
  const buy = a.byRating.find((r) => r.rating === 'Buy');
  assert.equal(buy.n, 2);
  assert.equal(buy.hitRate, 0.5);
  assert.equal(a.byRating.find((r) => r.rating === 'Hold').hitRate, null);
});

test('scoring: adherence compares what you did with what was rated', () => {
  const entries = [
    { id: 'a', rating: 'Buy', action: { type: 'bought' } },
    { id: 'b', rating: 'Buy', action: { type: 'passed' } },
    { id: 'c', rating: 'Hold', action: { type: 'held' } },
    { id: 'd', rating: 'Sell', action: { type: 'sold' } },
    { id: 'e', rating: 'Buy', action: null },
  ];
  assert.equal(S.followed(entries[0]), true);
  assert.equal(S.followed(entries[1]), false);
  assert.equal(S.followed(entries[2]), true);
  assert.equal(S.followed(entries[3]), true);
  assert.equal(S.followed(entries[4]), null);
  const byId = {
    a: { status: 'scored', alpha: 0.1 }, b: { status: 'scored', alpha: 0.2 },
    c: { status: 'scored', alpha: 0 }, d: { status: 'scored', alpha: -0.05 },
  };
  const ad = S.adherence(entries, byId);
  assert.equal(ad.followed.n, 3);
  assert.equal(ad.notFollowed.n, 1);
  assert.equal(ad.notFollowed.meanAlpha, 0.2);
});

// --------------------------------------------------------------------- store
function mkStore(opts = {}) {
  const dir = tmp();
  const store = createStore(dir, {
    encrypt: (s) => Buffer.from('ENC:' + s),
    decrypt: (b) => b.toString().replace(/^ENC:/, ''),
    canEncrypt: () => opts.canEncrypt !== false,
    now: () => new Date('2026-10-24T15:00:00Z'),
  });
  return { dir, store };
}

test('settings: defaults, clamping and sanitising', () => {
  const { store } = mkStore();
  assert.equal(store.getSettings().provider, 'ollama');
  const s = store.setSettings({ provider: 'evil', debateRounds: 99, riskRounds: -4, analysts: ['market', 'x'], temperature: '9', benchmark: 'spy; rm', cashOverride: '-5' });
  assert.equal(s.provider, 'ollama');
  assert.equal(s.debateRounds, 3);
  assert.equal(s.riskRounds, 1);
  assert.deepEqual(s.analysts, ['market']);
  assert.equal(s.temperature, '2');
  assert.equal(s.benchmark, 'SPYRM');
  assert.equal(s.cashOverride, '');
  assert.throws(() => store.setSettings({ ollamaUrl: 'file:///etc/passwd' }), /http/);
  assert.throws(() => store.setSettings({ backendUrl: 'http://user:pw@host' }), /username/);
  assert.equal(cleanSettings({ deepModel: '' , quickModel: 'abc'}).deepModel, 'abc');
});

test('secrets: encrypted on disk, never plaintext, refused when encryption unavailable', () => {
  const { dir, store } = mkStore();
  store.setSecret('ANTHROPIC_API_KEY', 'sk-test-123');
  const raw = fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8');
  assert.ok(!raw.includes('sk-test-123'));
  assert.equal(store.getSecrets().ANTHROPIC_API_KEY, 'sk-test-123');
  assert.equal(store.secretStatus().ANTHROPIC_API_KEY, true);
  store.setSecret('ANTHROPIC_API_KEY', '');
  assert.equal(store.secretStatus().ANTHROPIC_API_KEY, false);
  assert.throws(() => store.setSecret('NOPE', 'x'), /Unknown/);
  const no = mkStore({ canEncrypt: false });
  assert.throws(() => no.store.setSecret('OPENAI_API_KEY', 'sk'), /not available/);
  assert.equal(fs.existsSync(path.join(no.dir, 'secrets.json')), false);
});

test('ticker validation', () => {
  assert.equal(cleanTicker(' brk.b '), 'BRK.B');
  assert.equal(cleanTicker('xrp-usd'), 'XRP-USD');
  assert.throws(() => cleanTicker('../etc'), /ticker/);
  assert.throws(() => cleanTicker(''), /ticker/);
});

test('journal: add run, summary, action, delete; path traversal in ids refused', () => {
  const { dir, store } = mkStore();
  const result = { ticker: 'NVDA', date: '2026-10-23', rating: 'Overweight', seconds: 120, price: { date: '2026-10-23', close: 225 },
    model: { provider: 'ollama', quick: 'q', deep: 'd', debate_rounds: 1 },
    sections: { decision: '**Rating**: Overweight\n\n**Executive Summary**: Strong demand, valuation full.\n\n**Investment Thesis**: x' } };
  const e = store.addRun(result, { held: true, position: { quantity: 4, averagePrice: 200 } });
  assert.equal(e.summary, 'Strong demand, valuation full.');
  assert.equal(store.listJournal().length, 1);
  assert.equal(store.getRun(e.id).result.ticker, 'NVDA');
  assert.equal(store.getRun('../../etc/passwd'), null);
  store.setAction(e.id, { type: 'bought', price: '224.5', quantity: '2', note: 'starter' });
  assert.deepEqual(store.listJournal()[0].action.type, 'bought');
  assert.equal(store.getRun(e.id).entry.action.type, 'bought', 'a saved run reflects the action recorded afterwards');
  assert.equal(store.listJournal()[0].action.price, 224.5);
  assert.throws(() => store.setAction(e.id, { type: 'yolo' }), /Unknown action/);
  assert.throws(() => store.setAction('missing', { type: 'sold' }), /not found/);
  assert.equal(store.medianSeconds('ollama'), 120);
  store.deleteEntry(e.id);
  assert.equal(store.listJournal().length, 0);
  assert.equal(fs.existsSync(path.join(dir, 'runs', `${e.id}.json`)), false);
});

test('holdings and watchlist persistence', () => {
  const { store } = mkStore();
  const h = store.setHoldings({ positions: [{ ticker: 'nvda', quantity: 5, averagePrice: 200 }, { ticker: 'ZERO', quantity: 0 }], cash: '100' });
  assert.equal(h.positions.length, 1);
  assert.equal(h.positions[0].ticker, 'NVDA');
  assert.equal(h.cash, 100);
  store.addWatch('avgo', 'under 390');
  store.addWatch('AVGO');
  assert.equal(store.getWatchlist().length, 1);
  assert.throws(() => store.addWatch('bad ticker'), /ticker/);
  store.removeWatch('avgo');
  assert.equal(store.getWatchlist().length, 0);
});

// ------------------------------------------------------------------ requests
test('requests: date validation and request shape', () => {
  const now = new Date('2026-10-24T12:00:00');
  assert.equal(R.validDate('2026-10-23', now), null);
  assert.match(R.validDate('2026-10-25', now), /future/);
  assert.match(R.validDate('2026-02-31', now), /real date/);
  assert.match(R.validDate('10/23/2026', now), /YYYY-MM-DD/);
  assert.equal(R.todayLocal(new Date(2026, 9, 4)), '2026-10-04');
  const settings = cleanSettings({ provider: 'ollama', ollamaUrl: 'http://localhost:11434/', quickModel: 'qwen3:latest', temperature: '0.2' });
  const req = R.analyzeRequest({ settings, dataDir: '/d', ticker: 'XRP-USD', date: '2026-10-23', portfolio: null });
  assert.equal(req.asset_type, 'crypto');
  assert.equal(req.settings.temperature, 0.2);
  assert.equal(req.portfolio, null);
  assert.equal(R.engineEnv(settings, { FRED_API_KEY: 'k' }).OLLAMA_BASE_URL, 'http://localhost:11434/v1');
  assert.equal(R.engineEnv(settings).TRADINGAGENTS_NO_UPDATE_CHECK, '1');
  assert.equal(R.estimate(4, null), null);
  assert.equal(R.estimate(4, 600).totalSeconds, 2400);
});

// --------------------------------------------------------------------- batch
test('batch: sequential, ranked, failures kept, cancel stops the rest', async () => {
  const order = [];
  const b = B.createBatch({
    tickers: ['AAA', 'BBB', 'CCC', 'AAA'],
    runOne: async (t) => {
      order.push(t);
      if (t === 'BBB') return { ok: false, error: 'model timeout' };
      return { ok: true, rating: t === 'AAA' ? 'Hold' : 'Buy', entryId: t, summary: 's' };
    },
  });
  const rows = await b.start();
  assert.deepEqual(order, ['AAA', 'BBB', 'CCC']);
  const ranked = B.rankResults(rows).map((r) => `${r.ticker}:${r.status}`);
  assert.deepEqual(ranked, ['CCC:done', 'AAA:done', 'BBB:failed']);

  let cancelCalls = 0;
  const b2 = B.createBatch({
    tickers: ['X', 'Y', 'Z'],
    runOne: async (t) => { if (t === 'X') b2.cancel(); return t === 'X' ? { ok: false, canceled: true } : { ok: true, rating: 'Buy' }; },
    cancelCurrent: () => { cancelCalls++; },
  });
  const r2 = await b2.start();
  assert.deepEqual(r2.map((r) => r.status), ['canceled', 'canceled', 'canceled']);
  assert.equal(cancelCalls, 1);
});

// --------------------------------------------------------------------- brief
test('brief: carries the run, the position and the disclaimer, adds nothing', () => {
  const md = buildBrief({
    entry: { ticker: 'NVDA', rating: 'Overweight', date: '2026-10-23', priceAtAnalysis: { date: '2026-10-23', close: 225 },
      action: { type: 'bought', quantity: 2, price: 224.5, note: 'starter', at: '2026-10-24T15:00:00Z' } },
    result: { sections: { decision: 'DECISION TEXT', bull: 'BULL', bear: '', market: 'MKT' }, model: { provider: 'ollama', quick: 'q', deep: 'd', debate_rounds: 1 } },
    position: { quantity: 15.83, averagePrice: 219.06 },
  });
  assert.match(md, /# NVDA decision brief/);
  assert.match(md, /Rating: Overweight/);
  assert.match(md, /DECISION TEXT/);
  assert.match(md, /average cost 219\.06/);
  assert.match(md, /not financial advice/);
  assert.match(md, /What you did/);
  assert.ok(!md.includes('## Bear case'), 'empty sections are omitted');
});

// ------------------------------------------------------------------ hardware
test('hardware: fit levels', () => {
  assert.equal(HW.fit(5, { vramGB: 16, ramGB: 32 }).level, 'gpu');
  assert.equal(HW.fit(13, { vramGB: 12, ramGB: 32 }).level, 'split');
  assert.equal(HW.fit(13, { vramGB: 0, ramGB: 32 }).level, 'cpu');
  assert.equal(HW.fit(40, { vramGB: 8, ramGB: 16 }).level, 'no');
});

test('hardware: ollama status parses tags and reports offline', async () => {
  const fetchOk = async (u) => ({ ok: true, json: async () => (u.endsWith('/api/tags')
    ? { models: [{ name: 'qwen3:latest', size: 5.2 * 1024 ** 3, details: { parameter_size: '8B', quantization_level: 'Q4_K_M' } }] }
    : { version: '0.12.0' }) });
  const ok = await HW.ollamaStatus('http://localhost:11434/', fetchOk);
  assert.equal(ok.running, true);
  assert.equal(ok.models[0].sizeGB, 5.2);
  assert.equal(ok.version, '0.12.0');
  const down = await HW.ollamaStatus('http://localhost:11434', async () => { throw new Error('ECONNREFUSED'); });
  assert.equal(down.running, false);
  assert.match(down.error, /ECONNREFUSED/);
  const gpu = await HW.detectGpu((c, a, o, cb) => cb(null, 'NVIDIA GeForce RTX 4080, 12282\n'));
  assert.deepEqual(gpu, { name: 'NVIDIA GeForce RTX 4080', vramGB: 12 });
  assert.equal(await HW.detectGpu((c, a, o, cb) => cb(new Error('not found'))), null);
});

// --------------------------------------------------------------------- setup
test('setup: picks a tested Python, skips 3.14 when 3.12 exists, rejects 3.10', async () => {
  const outputs = { '3.14': '3.14.3', '3.12': '3.12.8', '3.10': '3.10.9' };
  const runFn = async (exe, args) => {
    const flag = args.find((a) => /^-3\.\d+$/.test(a));
    const v = flag ? outputs[flag.slice(1)] : '3.14.3';
    return v ? { code: 0, out: v + '\n' } : { code: 1, out: 'no' };
  };
  const { pick } = await SETUP.findPython({ platform: 'win32', runFn });
  assert.equal(pick.text, '3.12.8');
  const only314 = await SETUP.findPython({ platform: 'win32', runFn: async () => ({ code: 0, out: '3.14.3' }) });
  assert.equal(only314.pick.tested, false);
  const old = await SETUP.findPython({ platform: 'win32', runFn: async () => ({ code: 0, out: '3.10.9' }) });
  assert.equal(old.pick, null);
});

test('setup: install falls back to the second source and reports failure honestly', async () => {
  const base = tmp();
  const calls = [];
  const runFn = async (exe, args) => {
    calls.push(args.join(' '));
    if (args.includes('-c')) return { code: 0, out: '3.12.8' };
    if (args.includes('venv')) { fs.mkdirSync(path.join(base, 'venv', 'bin'), { recursive: true }); fs.writeFileSync(path.join(base, 'venv', 'bin', 'python'), ''); return { code: 0, out: '' }; }
    if (args.some((a) => /\.zip$/.test(a))) return { code: 1, out: 'HTTP 403' };
    return { code: 0, out: 'ok' };
  };
  const r = await SETUP.installEngine({ baseDir: base, platform: 'linux', runFn });
  assert.equal(r.ok, true);
  assert.ok(calls.some((c) => c.includes('git+https')));
  const bad = await SETUP.installEngine({ baseDir: tmp(), platform: 'linux', runFn: async (e, a) => (a.includes('-c') ? { code: 0, out: '3.12.8' } : { code: a.includes('venv') ? 0 : 1, out: 'nope' }) });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /install failed/);
  const none = await SETUP.installEngine({ baseDir: tmp(), platform: 'linux', runFn: async () => ({ code: 1, out: '' }) });
  assert.match(none.error, /Python 3\.11/);
});

test('setup: the app finds the engine exactly where the installer puts it', async () => {
  const { createIpc } = require('../src/ipc');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'td-eng-'));
  const handlers = {};
  const ipc = createIpc({
    validateSender: () => true, // In-process test driver; no Electron frame.
    store: { getSettings: () => ({}), getSecrets: () => ({}), getMeta: () => ({}) }, dialog: {}, shell: {}, safeStorage: { isEncryptionAvailable: () => true },
    send: () => {}, getWindow: () => null, version: 't',
    paths: { userData: base, engineDir: base, dataDir: path.join(base, 'ta'), engineScript: 'x.py' },
  });
  ipc.register({ handle: (n, fn) => { handlers[n] = fn; } });
  assert.equal((await handlers['app:info']({}, {})).engineInstalled, false);
  const runFn = async (exe, args) => {
    if (args.includes('-c') && !args.some((a) => /import tradingagents/.test(a))) return { code: 0, out: '3.12.8' };
    if (args.includes('venv')) { const d = path.dirname(SETUP.venvPython(path.join(base, 'venv'))); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(SETUP.venvPython(path.join(base, 'venv')), ''); return { code: 0, out: '' }; }
    return { code: 0, out: 'ok' };
  };
  const r = await SETUP.installEngine({ baseDir: base, runFn });
  assert.equal(r.ok, true);
  assert.equal((await handlers['app:info']({}, {})).engineInstalled, true);
});

test('holdings: the Stock / QTY / Current Price / Purchase Price / Current total / Bought At / Profit/Loss layout', () => {
  const text = [
    'Stock\tQTY\tCurrent Price\tPurchase Price\tCurrent total\tBought At\tProfit/Loss',
    'NVDA\t10\t$180.50\t$120.00\t$1,805.00\t3/14/2024\t$605.00',
    'AAPL\t5\t250\t200\t1250\t2023-06-01\t250',
    'BRK B\t2\t480\t450\t960\t10/1/2022\t60',
    'Tesla Inc\t3\t200\t100\t600\t1/1/2024\t300',
    'MSFT\t4\t400\t\t1600\t5/5/2024\t$200',
    'GOOG\t1\t100\t90\t100\t1/2/2024\t999',
    'Total\t\t\t\t$5,215\t\t',
  ].join('\n');
  const r = H.importRows(H.parseTable(text));
  assert.equal(r.ok, true);
  assert.deepEqual(r.mapping, { ticker: 0, quantity: 1, avgPrice: 3, price: 2, marketValue: 4, pnl: 6, boughtAt: 5 });
  const by = Object.fromEntries(r.positions.map((p) => [p.ticker, p]));
  assert.equal(by.NVDA.quantity, 10);
  assert.equal(by.NVDA.averagePrice, 120);
  assert.equal(by.NVDA.lastPrice, 180.5);
  assert.equal(by.NVDA.boughtAt, '2024-03-14');
  assert.equal(by['BRK-B'].averagePrice, 450);
  assert.equal(by.MSFT.averagePrice, 350, 'cost worked out from price and profit when the cost cell is empty');
  assert.ok(r.skipped.some((s) => /company name/.test(s.reason)), 'a company name is not accepted as a ticker');
  assert.ok(r.skipped.some((s) => s.reason === 'total row'));
  assert.ok(r.warnings.some((w) => /MSFT/.test(w) && /worked out/.test(w)));
  assert.ok(r.warnings.some((w) => /GOOG/.test(w) && /does not match/.test(w)), 'inconsistent profit is flagged, not silently accepted');
  assert.ok(!r.warnings.some((w) => /NVDA: Profit/.test(w)));
});

test('holdings: dates, tickers, delimiters and merging', () => {
  assert.equal(H.parseDate('3/14/2024'), '2024-03-14');
  assert.equal(H.parseDate('2024-03-14'), '2024-03-14');
  assert.equal(H.parseDate('14 Mar 2024'), '2024-03-14');
  assert.equal(H.parseDate('Mar 14, 2024'), '2024-03-14');
  assert.equal(H.parseDate('13/45/2024'), null);
  assert.equal(H.parseDate('120.5'), null);
  assert.equal(H.parseDate(45000), '2023-03-15');
  assert.equal(H.extractTicker('NVIDIA (NVDA)').ticker, 'NVDA');
  assert.equal(H.extractTicker('brk.b').ticker, 'BRK.B');
  assert.equal(H.extractTicker('Apple Inc').name, true);
  assert.equal(H.parseNumber('+12.5'), 12.5);
  assert.equal(H.parseNumber('($1,234.50)'), -1234.5);
  assert.deepEqual(H.parseTable('a;b\n1;2'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(H.parseTable('a\tb\n"x y"\t2'), [['a', 'b'], ['x y', '2']]);
  const m = H.mergePositions([{ ticker: 'A', quantity: 10, averagePrice: 10, accounts: { x: 10 } }], [{ ticker: 'A', quantity: 10, averagePrice: 20, accounts: { y: 10 } }, { ticker: 'B', quantity: 1, averagePrice: null, accounts: {} }]);
  assert.equal(m.find((p) => p.ticker === 'A').quantity, 20);
  assert.equal(m.find((p) => p.ticker === 'A').averagePrice, 15);
  // Bought At holding a price, when there is no other cost column
  const r = H.importRows(H.parseTable('Stock\tQTY\tBought At\nAAA\t2\t$50.25'));
  assert.equal(r.positions[0].averagePrice, 50.25);
});

test('eta: predicts the rest of a run from earlier runs, stage by stage', () => {
  const ETA = require('../src/eta');
  const ms = ETA.milestones(['market', 'news']);
  assert.deepEqual(ms, ['market_report', 'news_report', 'investment_plan', 'trader_investment_plan', 'final_trade_decision', 'briefing', 'end']);
  // two earlier runs: 60 s market, 40 s news, 100 s plan, 20 s trader, 120 s decision, 10 s end = 350 s
  const run = { seconds: 350, timeline: { market_report: 60, news_report: 100, investment_plan: 200, trader_investment_plan: 220, final_trade_decision: 340, briefing: 346, end: 350 } };
  const hist = [run, run];
  // nothing yet, 10 s in: whole run minus the time spent in the first stage
  let e = ETA.estimate({ elapsed: 10, timeline: {}, ms, history: hist });
  assert.equal(e.confidence, 'history');
  assert.ok(Math.abs(e.remaining - 340) < 1, String(e.remaining));
  // market and news done at 100 s, 30 s into the plan stage (100 s long): 70 + 20 + 120 + 10 = 220
  e = ETA.estimate({ elapsed: 130, timeline: { market_report: 60, news_report: 100 }, ms, history: hist });
  assert.ok(Math.abs(e.remaining - 220) < 1, String(e.remaining));
  // far slower than before: never claims zero while stages remain
  e = ETA.estimate({ elapsed: 900, timeline: { market_report: 60, news_report: 100 }, ms, history: hist });
  assert.ok(e.remaining > 0 && e.remaining < 220 + 1);
  // finished
  assert.equal(ETA.estimate({ elapsed: 400, timeline: Object.fromEntries(ms.map((k) => [k, 1])), ms, history: hist }).remaining, 0);
});

test('eta: honest about weak evidence', () => {
  const ETA = require('../src/eta');
  const ms = ETA.milestones();
  // no history and nothing reached: no number at all
  assert.equal(ETA.estimate({ elapsed: 30, timeline: {}, ms, history: [] }), null);
  // old runs without timelines: a rough total-based guess, labelled rough
  let e = ETA.estimate({ elapsed: 100, timeline: {}, ms, history: [{ seconds: 600, timeline: null }] });
  assert.equal(e.confidence, 'rough'); assert.equal(e.remaining, 500);
  // no history, progress made: extrapolation, labelled rough
  e = ETA.estimate({ elapsed: 100, timeline: { market_report: 100, sentiment_report: 100 }, ms, history: [] });
  assert.equal(e.confidence, 'rough'); assert.ok(e.remaining > 0);
});

test('eta: waiting items start when the ones ahead finish', () => {
  const ETA = require('../src/eta');
  assert.deepEqual(ETA.schedule({ runningRemaining: 100, waitingCount: 3, fullEst: 300 }), [400, 700, 1000]);
  assert.deepEqual(ETA.schedule({ runningRemaining: null, hasRunning: false, waitingCount: 2, fullEst: 300 }), [300, 600]);
  assert.deepEqual(ETA.schedule({ runningRemaining: 50, waitingCount: 2, fullEst: null }), [null, null]);
  assert.deepEqual(ETA.schedule({ runningRemaining: null, hasRunning: true, waitingCount: 1, fullEst: 300 }), [600]);
});

test('store: the timeline is kept with the run and used as history', () => {
  const st = createStore(tmp(), { encrypt: (s) => Buffer.from(s), decrypt: (b) => b.toString(), canEncrypt: () => true });
  st.addRun({ ticker: 'AAA', date: '2026-01-02', rating: 'Hold', seconds: 300, model: { provider: 'ollama', quick: 'm1' }, sections: { decision: 'x' } }, { timeline: { market_report: 50.123, end: 300, 'bad key!': 1, evil: 'x' } });
  st.addRun({ ticker: 'BBB', date: '2026-01-02', rating: 'Hold', seconds: 100, model: { provider: 'ollama', quick: 'other' }, sections: { decision: 'x' } }, {});
  const h = st.etaHistory('ollama', 'm1');
  assert.equal(h.length, 1);
  assert.deepEqual(h[0].timeline, { market_report: 50.1, end: 300 });
});

test('models: both the quick and the deep model must exist in Ollama', () => {
  const M = require('../src/models');
  assert.equal(M.norm('qwen3'), 'qwen3:latest');
  assert.equal(M.norm('Qwen3:8B'), 'qwen3:8b');
  assert.deepEqual(M.missingModels({ quickModel: 'qwen3:8b', deepModel: 'qwen3:8b' }, ['qwen3:8b']), []);
  assert.deepEqual(M.missingModels({ quickModel: 'qwen3', deepModel: 'qwen3:latest' }, ['qwen3:latest']), [], 'qwen3 and qwen3:latest are the same model');
  const miss = M.missingModels({ quickModel: 'qwen3:8b', deepModel: 'qwen3:latest' }, ['qwen3:8b', 'llama3.1:8b']);
  assert.deepEqual(miss, [{ role: 'deep', name: 'qwen3:latest' }]);
  const msg = M.message({}, miss, ['qwen3:8b', 'llama3.1:8b']);
  assert.match(msg, /deep model "qwen3:latest" is not installed/i);
  assert.match(msg, /Installed models: llama3\.1:8b, qwen3:8b/);
  assert.match(M.message({}, [{ role: 'quick', name: 'x' }], []), /no models installed/);
  assert.equal(M.missingModels({ quickModel: 'a', deepModel: 'a' }, []).length, 1, 'one message when both fields name the same missing model');
});

// ---- v2.0.0 main-process pieces
test('profiles: fast and thorough change depth, standard follows Setup, unknown falls back', () => {
  const P = require('../src/profiles');
  const base = { analysts: ['market', 'social', 'news', 'fundamentals'], debateRounds: 1, riskRounds: 1 };
  assert.deepEqual(P.apply(base, 'fast').analysts, ['market', 'news']);
  assert.equal(P.apply({ ...base, debateRounds: 3 }, 'fast').debateRounds, 1);
  assert.equal(P.apply(base, 'thorough').debateRounds, 2);
  assert.equal(P.apply({ ...base, debateRounds: 3 }, 'thorough').debateRounds, 3);
  assert.deepEqual(P.apply(base, 'standard'), base);
  assert.equal(P.clean('bogus'), 'standard');
  assert.notEqual(P.apply(base, 'fast'), base);
});

test('eta: waiting items use their own depth and the schedule accumulates', () => {
  const E = require('../src/eta');
  assert.deepEqual(E.schedule({ runningRemaining: 10, fulls: [100, 50, 200] }), [110, 160, 360]);
  assert.deepEqual(E.schedule({ runningRemaining: null, hasRunning: false, fulls: [100, 50] }), [100, 150]);
  assert.deepEqual(E.schedule({ runningRemaining: 10, fulls: [100, null, 50] }), [110, null, null]);
});

test('store: briefing can be written back to a saved run, and meta persists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-st-'));
  const st = require('../src/store').createStore(dir, { encrypt: (s) => Buffer.from(s), decrypt: (b) => b.toString(), canEncrypt: () => true });
  const e = st.addRun({ ticker: 'X', date: '2026-01-01', rating: 'Hold', seconds: 5, sections: { decision: 'd' }, model: { provider: 'ollama', quick: 'q' } }, { profile: 'thorough' });
  assert.equal(e.profile, 'thorough');
  assert.equal(st.setBrief(e.id, { for: [], against: [], would_change: [], mode: 'rules' }), true);
  assert.equal(st.getRun(e.id).result.brief.mode, 'rules');
  assert.equal(st.setBrief('../x', {}), false);
  st.setMeta({ modelChecked: { quick: 'q' } });
  assert.equal(st.getMeta().modelChecked.quick, 'q');
  assert.equal(st.etaHistory('ollama', 'q', 10, 'thorough').length, 1);
  assert.equal(st.etaHistory('ollama', 'q', 10, 'standard').length, 0);
});
