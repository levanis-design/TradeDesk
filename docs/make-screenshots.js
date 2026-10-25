'use strict';
// Rebuilds the pictures in docs/images from an invented sample portfolio, a fake local model and fake prices.
// Nothing here is real market data or a real position.
//
//   TD_PY=/path/to/venv/python NODE_PATH=$(npm root -g) node docs/make-screenshots.js
//
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const { createStore } = require(path.join(ROOT, 'src', 'store'));
const { createIpc } = require(path.join(ROOT, 'src', 'ipc'));
const PY = process.env.TD_PY;
if (!PY || !fs.existsSync(PY)) { console.error('Set TD_PY to a Python with TradingAgents installed.'); process.exit(2); }
const OUT = path.join(__dirname, 'images');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DARK = !!process.env.DARK;

(async () => {
  const llm = spawn(PY, [path.join(ROOT, 'tests', 'fake_llm_server.py'), '12101'], { env: { ...process.env, FAKE_DELAY_MS: '0', FAKE_DEMO: '1' }, stdio: 'ignore' });
  await sleep(1500);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'td-shots-'));
  const store = createStore(path.join(tmp, 'data'), { encrypt: (s) => Buffer.from('ENC:' + s), decrypt: (b) => b.toString().replace(/^ENC:/, ''), canEncrypt: () => true });
  store.setSettings({ ollamaUrl: 'http://127.0.0.1:12101', quickModel: 'qwen3:latest', deepModel: 'qwen3:latest' });
  const handlers = new Map();
  let page = null;
  const paths = { userData: tmp, engineDir: path.join(tmp, 'engine'), dataDir: path.join(tmp, 'ta'), enginePython: PY, engineScript: path.join(tmp, 'engine_demo.py') };
  // The app starts the engine with a trimmed environment, so the fake's price scale is set inside a small wrapper script.
  fs.writeFileSync(paths.engineScript, `import os, runpy, sys\nos.environ['TD_FAKE_SCALE'] = '0.12'\nsys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'tests'))})\nrunpy.run_path(${JSON.stringify(path.join(ROOT, 'tests', 'engine_fake_all.py'))}, run_name='__main__')\n`);
  const ipc = createIpc({
    store, dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showSaveDialog: async () => ({ canceled: true }) },
    shell: { showItemInFolder() {}, openExternal() {} }, safeStorage: { isEncryptionAvailable: () => true },
    send: (ch, payload) => { if (page) page.evaluate(([c, p]) => window.__emit && window.__emit(c, p), [ch, payload]).catch(() => {}); },
    getWindow: () => null, version: 'docs', paths, validateSender: () => true,
  });
  ipc.register({ handle: (n, fn) => handlers.set(n, fn) });

  // Invented portfolio. Costs sit near the fake prices so the profit and loss figures look ordinary.
  store.setHoldings({ cash: 4200, positions: [
    { ticker: 'AAPL', quantity: 40, averagePrice: 96 }, { ticker: 'MSFT', quantity: 18, averagePrice: 101 },
    { ticker: 'NVDA', quantity: 25, averagePrice: 88 }, { ticker: 'VOO', quantity: 30, averagePrice: 104 }, { ticker: 'JNJ', quantity: 22, averagePrice: 118 },
  ] });
  ['GOOG', 'AMZN', 'TSLA'].forEach((t) => store.addWatch(t, ''));

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 }, colorScheme: DARK ? 'dark' : 'light', deviceScaleFactor: 1 });
  page = await ctx.newPage();
  page.on('dialog', (d) => d.accept());
  await page.exposeFunction('__ipc', async (ch, arg) => { const fn = handlers.get(ch); if (!fn) throw new Error('no handler ' + ch); return JSON.parse(JSON.stringify(await fn(null, arg))); });
  const preloadSrc = fs.readFileSync(path.join(ROOT, 'src', 'preload.js'), 'utf8');
  await page.addInitScript(`(() => {
    const L = {};
    window.__emit = (ch, p) => (L[ch] || []).forEach((h) => h({}, p));
    const electron = { contextBridge: { exposeInMainWorld: (n, o) => { window[n] = o; } },
      ipcRenderer: { invoke: (ch, a) => window.__ipc(ch, a), on: (ch, h) => { (L[ch] = L[ch] || []).push(h); }, removeListener: (ch, h) => { L[ch] = (L[ch] || []).filter((x) => x !== h); } } };
    const require = (m) => { if (m === 'electron') return electron; throw new Error(m); };
    ${preloadSrc}
  })();`);
  const shot = async (name, sel) => { await sleep(500); await (sel ? page.locator(sel).first() : page).screenshot({ path: path.join(OUT, name + (DARK ? '-dark' : '') + '.png') }); console.log('saved', name); };
  const nav = (id) => page.click(`.nav-btn[data-page="${id}"]`);

  await page.goto('file://' + path.join(ROOT, 'renderer', 'index.html'));
  await page.waitForSelector('#termsok', { timeout: 60000 });
  await page.check('#termsok'); await page.click('#termsgo');
  await page.waitForSelector('#engineChip.ok', { timeout: 60000 });

  // Pass the model check and run two analyses so the screens have content.
  const mc = await handlers.get('engine:modelcheck')(null, {});
  console.log('model check passed:', mc.passed);
  await page.evaluate(() => TD.refreshStatus());
  const day = new Date().toISOString().slice(0, 10);
  for (const t of ['NVDA', 'AAPL']) { const r = await handlers.get('analyze:run')(null, { ticker: t, date: day, includePortfolio: true }); console.log('analysis', t, r.ok ? 'ok' : r.error); }
  await page.evaluate(() => TD.refreshStatus());

  await nav('setup'); await page.waitForSelector('.comp'); await shot('setup-components');
  await page.getByRole('tab', { name: 'This computer' }).click(); await page.waitForSelector('#hwbody table', { timeout: 20000 }); await shot('setup-computer');

  await nav('analyze'); await page.click('.ptab[data-tab="work"]'); await page.waitForSelector('#tkr');
  await page.fill('#tkr', 'nvda'); await page.press('#tkr', 'Enter');
  await page.waitForSelector('#stats svg.chart-svg', { timeout: 30000 });
  await sleep(800); await shot('analyze');

  await page.locator('#sum').scrollIntoViewIfNeeded().catch(() => {});
  await nav('watch'); await sleep(1500); await shot('watchlist');

  await nav('holdings'); await page.waitForSelector('.donut, svg', { timeout: 20000 }); await sleep(1500); await shot('holdings');
  await page.evaluate(() => { const m = document.querySelector('#view'); if (m) m.scrollTo(0, 99999); }); await shot('holdings-positions');

  await nav('calendar'); await page.waitForSelector('#calroot .ev', { timeout: 30000 }); await shot('calendar');
  await page.locator('.recentbtn').first().click(); await page.waitForSelector('#movepanel .movetable', { timeout: 30000 });
  await page.locator('#movepanel').scrollIntoViewIfNeeded(); await shot('calendar-market-move');

  await nav('track'); await sleep(1200); await shot('journal');

  await page.click('#navToggle'); await nav('analyze'); await sleep(800); await shot('menu-collapsed');
  await browser.close(); llm.kill();
  process.exit(0);
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
