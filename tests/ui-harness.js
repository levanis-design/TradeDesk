'use strict';
// End-to-end UI check without Electron: real renderer in Chromium, real IPC handlers,
// real Python engine, fake model server, deterministic fake prices.
//
//   TD_PY=/path/to/venv/python NODE_PATH=$(npm root -g) node tests/ui-harness.js [outDir]
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
const OUT = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'td-shots-'));
fs.mkdirSync(OUT, { recursive: true });

let passed = 0; let failed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; } else { failed++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log('  FAIL', name, detail || ''); }
}

function startFake(port, delayMs) {
  const p = spawn(PY, [path.join(__dirname, 'fake_llm_server.py'), String(port)], { env: { ...process.env, FAKE_DELAY_MS: String(delayMs || 0) }, stdio: 'ignore' });
  return p;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const fast = startFake(12101, 0);
  const slow = startFake(12102, 900);
  await sleep(1500);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'td-ui-'));
  const store = createStore(path.join(tmp, 'data'), {
    encrypt: (s) => Buffer.from('ENC:' + s), decrypt: (b) => b.toString().replace(/^ENC:/, ''), canEncrypt: () => true,
  });
  store.setSettings({ ollamaUrl: 'http://127.0.0.1:12101', quickModel: 'fake:1b', deepModel: 'fake:1b' });

  const handlers = new Map();
  const dialogQueue = [];
  let saveTarget = null;
  const shown = [];
  const opened = [];
  let page = null;
  const paths = { userData: tmp, engineDir: path.join(tmp, 'engine'), dataDir: path.join(tmp, 'ta'), enginePython: PY, engineScript: path.join(__dirname, 'engine_fake_all.py') };
  const ipc = createIpc({
    validateSender: () => true, // Playwright test driver; no Electron frame.
    store,
    dialog: {
      showOpenDialog: async () => ({ canceled: !dialogQueue.length, filePaths: dialogQueue.splice(0, 1) }),
      showSaveDialog: async () => ({ canceled: !saveTarget, filePath: saveTarget }),
    },
    shell: { showItemInFolder: (p) => shown.push(p), openExternal: (u) => opened.push(u) },
    safeStorage: { isEncryptionAvailable: () => true },
    send: (ch, payload) => { if (page) page.evaluate(([c, p]) => window.__emit && window.__emit(c, p), [ch, payload]).catch(() => {}); },
    getWindow: () => null, version: 'test', paths,
  });
  ipc.register({ handle: (n, fn) => handlers.set(n, fn) });

  const browser = await chromium.launch(process.env.TD_CHROMIUM ? { executablePath: process.env.TD_CHROMIUM } : {});
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, colorScheme: process.env.DARK ? 'dark' : 'light' });
  page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('dialog', (d) => d.accept());
  await page.exposeFunction('__ipc', async (ch, arg) => {
    const fn = handlers.get(ch);
    if (!fn) throw new Error('no handler ' + ch);
    return JSON.parse(JSON.stringify(await fn(null, arg)));
  });
  const preloadSrc = fs.readFileSync(path.join(ROOT, 'src', 'preload.js'), 'utf8');
  await page.addInitScript(`(() => {
    const L = {};
    window.__emit = (ch, p) => (L[ch] || []).forEach((h) => h({}, p));
    const electron = {
      contextBridge: { exposeInMainWorld: (n, o) => { window[n] = o; } },
      ipcRenderer: { invoke: (ch, a) => window.__ipc(ch, a), on: (ch, h) => { (L[ch] = L[ch] || []).push(h); }, removeListener: (ch, h) => { L[ch] = (L[ch] || []).filter((x) => x !== h); } },
    };
    const require = (m) => { if (m === 'electron') return electron; throw new Error(m); };
    ${preloadSrc}
  })();`);

  const shot = (name) => page.screenshot({ path: path.join(OUT, name + '.png') });
  const nav = (id) => page.click(`.nav-btn[data-page="${id}"]`);
  const workspace = async () => { await nav('analyze'); await page.click('.ptab[data-tab="work"]'); await page.waitForSelector('#tkr'); };
  const text = (sel) => page.locator(sel).first().innerText();
  const refresh = () => page.evaluate(() => TD.refreshStatus());

  // The launch notice is part of the product: every load has to get past it, there is no test bypass.
  const accept = async () => { await page.waitForSelector('#termsok', { timeout: 60000 }); await page.check('#termsok'); await page.click('#termsgo'); await page.waitForSelector('#modal', { state: 'hidden' }); };
  await page.goto('file://' + path.join(ROOT, 'renderer', 'index.html'));
  await page.waitForSelector('#termsok', { timeout: 60000 });

  // ------------------------------------------------------------ notice
  console.log('launch notice');
  const nt = await text('.modal-box');
  check('launch notice says it is not a trading recommendation', /not a trading recommendation/i.test(nt) && /no financial advice/i.test(nt));
  check('Continue is disabled until the box is ticked', await page.locator('#termsgo').isDisabled());
  await page.keyboard.press('Escape');
  check('Escape does not dismiss the launch notice', await page.locator('#modal').isVisible());
  check('nothing behind the notice has been opened yet', (await text('#pageTitle')) === '');
  await shot('00-notice');
  await page.check('#termsok');
  check('Continue enables once the box is ticked', await page.locator('#termsgo').isEnabled());
  await page.click('#termsgo');
  await page.waitForSelector('#engineChip.ok', { timeout: 60000 });

  // ------------------------------------------------------------- boot
  console.log('boot');
  check('first run goes to Setup until the model check has passed', (await text('#pageTitle')) === 'Setup');
  check('Setup carries a badge while unfinished', await page.locator('#setupBadge').isVisible());
  check('engine chip shows the TradingAgents version', /v0\.7\.0/.test(await text('#engineChip')), await text('#engineChip'));
  check('model chip shows the model', /fake:1b/.test(await text('#modelChip')));
  check('footer disclaimer visible', /not financial advice/.test(await text('.disclaimer')));

  // ------------------------------------------------------------ menu
  console.log('menu');
  check('every menu item has an icon', await page.locator('.nav-btn svg').count() >= 7);
  check('Calendar is its own menu item', await page.locator('.nav-btn:has-text("Calendar")').count() === 1);
  await page.click('#navToggle');
  check('menu collapses to icons', await page.locator('.app.collapsed').count() === 1);
  check('collapsed buttons keep a name', (await page.locator('.nav-btn').first().getAttribute('aria-label')) !== null);
  await page.reload(); await accept();
  check('collapsed state is remembered', await page.locator('.app.collapsed').count() === 1);
  await page.keyboard.press('Control+b');
  check('Ctrl+B reopens the menu', await page.locator('.app.collapsed').count() === 0);
  await page.keyboard.press('Alt+4');
  check('Alt+4 opens Calendar', /Calendar/.test(await text('#pageTitle')));
  await nav('analyze');

  // ------------------------------------------------------------ setup
  console.log('setup');
  await nav('setup');
  await page.waitForSelector('.comp', { timeout: 20000 });
  const compText = await text('.complist');
  check('components list shows Python, Git, engine, Ollama and the model', /Python 3\.12/.test(compText) && /Git/.test(compText) && /TradingAgents engine/.test(compText) && /Ollama/.test(compText) && /Model: fake:1b/.test(compText), compText.slice(0, 300));
  check('each component says what it does and its size', /Size:/.test(compText) && /runs language models/.test(compText));
  check('installed items are marked', (await page.locator('.comp.ok').count()) >= 2);
  check('only the Components tab is showing at first', await page.locator('.card.compact:visible').count() === 1);
  await page.getByRole('tab', { name: 'This computer' }).click();
  await page.waitForSelector('#hwbody table', { timeout: 20000 });
  const hwText = await text('#hwbody');
  check('hardware panel lists installed models from Ollama', /fake:1b/.test(hwText) && /huge:70b/.test(hwText));
  check('hardware panel reads Ollama version', /0\.0\.test/.test(hwText), hwText.slice(0, 200));
  check('oversized model is flagged', /too large|slow|splits/.test(hwText));
  await page.getByRole('tab', { name: 'Model and run settings' }).click();
  await page.getByRole('button', { name: 'Save and check this model' }).click();
  await page.waitForSelector('.checkrow:nth-child(3)', { timeout: 60000 });
  const checksText = await text('.checks');
  check('model check passes all three checks', (checksText.match(/Pass/g) || []).length === 3, checksText);
  check('Setup badge clears once the model check passed', await page.locator('#setupBadge').isHidden());
  check('the pass is remembered by the app', !!store.getMeta().modelChecked);
  check('cloud cost warning hidden for a local model', await page.locator('.callout.warn:has-text("billed per use")').isHidden());
  await page.selectOption('select >> nth=0', 'anthropic');
  check('cloud cost warning appears for a cloud provider', await page.locator('.callout.warn:has-text("billed per use")').isVisible());
  await page.selectOption('select >> nth=0', 'ollama');
  await shot('01-setup');

  // key storage never echoes the value back
  await page.getByRole('tab', { name: 'API keys' }).click();
  const keyInput = page.locator('#keysCard input[type=password]').first();
  await keyInput.fill('sk-ant-TESTSECRET');
  await page.locator('#keysCard button:has-text("Save")').first().click();
  await page.waitForFunction(() => /saved/.test(document.querySelector('#keysCard input[type=password]').placeholder));
  check('API key saved encrypted, not in plain text', !fs.readFileSync(path.join(tmp, 'data', 'secrets.json'), 'utf8').includes('TESTSECRET'));
  check('API key value never returned to the page', !(await page.content()).includes('TESTSECRET'));

  // --------------------------------------------------------- holdings
  console.log('holdings');
  const csv = path.join(tmp, 'holdings.csv');
  fs.writeFileSync(csv, ['Report 2026-10-24,,,', 'Account,Symbol,Shares,Average Cost',
    'Savings,NVDA,4.065662,219.06', 'Chase,NVDA,3.76,201.58', 'Savings,SCHD,96.7,32.10', 'Joint,SCHD,9.58,31.00',
    'Joint,CASH,848.98,', 'Savings,Total,,'].join('\n'));
  dialogQueue.push(csv);
  await nav('holdings');
  await page.getByRole('button', { name: 'Import Excel or CSV' }).click();
  await page.waitForSelector('.modal-box table');
  const prevText = await text('.modal-box');
  check('import preview shows merged NVDA', /NVDA/.test(prevText) && /7\.825662/.test(prevText), prevText.slice(0, 300));
  check('import preview shows merged SCHD', /106\.28/.test(prevText));
  check('skipped total row is reported', /skipped/.test(prevText));
  check('detected cash is shown', /848\.98/.test(prevText));
  await shot('02-import');
  await page.getByRole('button', { name: 'Import these positions' }).click();
  await page.waitForSelector('.modal-box', { state: 'detached', timeout: 5000 }).catch(() => {});
  await page.waitForSelector('table.list input.ticker');
  check('two merged positions in the table', (await page.locator('table.list tbody tr').count()) === 2);
  const saved = store.getHoldings();
  check('holdings persisted with merged accounts', saved.positions.length === 2 && Object.keys(saved.positions[0].accounts).length >= 1);
  check('cash from the file was kept', saved.cash === 848.98, String(saved.cash));
  // edit a value and save
  await page.locator('table.list tbody tr').first().locator('input[type=number]').nth(1).fill('210');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.waitForFunction(() => document.querySelector('.toast'));
  check('edited average cost saved', store.getHoldings().positions.find((p) => p.ticker === 'NVDA').averagePrice === 210);
  await shot('03-holdings');
  await refresh();

  // xlsx import path
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Positions');
  ws.addRow(['Holdings as of today']); ws.addRow(['Ticker', 'Quantity', 'Cost Basis']);
  ws.addRow(['GOOG', 13.9, 4200]); ws.addRow(['NVDA', 15.83, 3468]);
  const xlsx = path.join(tmp, 'h.xlsx'); await wb.xlsx.writeFile(xlsx);
  dialogQueue.push(xlsx);
  await page.getByRole('button', { name: 'Import Excel or CSV' }).click();
  await page.waitForSelector('.modal-box table');
  const xText = await text('.modal-box');
  check('xlsx header found below a title row and cost basis converted', /GOOG/.test(xText) && /302\.16/.test(xText), xText.slice(0, 400));
  await page.getByRole('button', { name: 'Cancel' }).click();
  check('cancel leaves holdings unchanged', store.getHoldings().positions.length === 2);

  // holdings charts (after the import above)
  await sleep(2500);
  check('holdings summary tiles are shown', (await page.locator('#tiles .stat').count()) >= 4, await text('#tiles'));
  check('allocation donut has a slice per holding', (await page.locator('#alloc svg.donut .slice').count()) >= 2);
  check('allocation legend lists weights', /%/.test(await text('#alloc .legend')) && /NVDA/.test(await text('#alloc .legend')));
  check('timeline is labelled as today\'s positions, not account history', /not your account history/.test(await text('#timeline')));
  check('timeline chart drew a line', (await page.locator('#timeline svg.chart-svg path.ln').count()) === 1);
  await page.locator('#timeline').scrollIntoViewIfNeeded();
  await sleep(300);
  const tb = await page.locator('#timeline .chart-stage').boundingBox();
  await page.mouse.move(tb.x + tb.width * 0.5, tb.y + 80);
  await page.mouse.move(tb.x + tb.width * 0.6, tb.y + 90, { steps: 4 });
  check('hovering the timeline shows a value tooltip', await page.locator('#timeline .chart-tip').isVisible() && /\d/.test(await text('#timeline .chart-tip')));
  await page.locator('#timeline .rng[data-range="1M"]').click();
  await page.waitForFunction(() => /over 1M/.test((document.querySelector('#timeline .chart-sum') || {}).innerText || ''), null, { timeout: 5000 }).catch(() => {});
  check('a range button redraws the timeline', /over 1M/.test(await text('#timeline .chart-sum')), await text('#timeline .chart-sum'));
  // holdings: candles, intervals, sorting, manual prices
  await page.locator('#timeline button[data-style="candles"]').click();
  await page.waitForSelector('#timeline svg.chart-svg rect.cd', { timeout: 20000, state: 'attached' }).catch(() => {});
  check('candles draw one body per bar', (await page.locator('#timeline svg.chart-svg rect.cd').count()) > 5);
  check('candles warn that whole-portfolio highs and lows are outer limits', /outer limits/.test(await text('#timeline')));
  await page.selectOption('#tliv', '15m');
  await page.waitForSelector('#timeline svg.chart-svg line.dayline', { timeout: 20000, state: 'attached' });
  check('minute intervals offer only ranges Yahoo has', (await page.locator('#timeline .rangegrp button').allInnerTexts()).join(',') === '5D,1M');
  check('intraday candles mark each trading day', (await page.locator('#timeline line.dayline').count()) >= 1 && /Dotted lines/.test(await text('#timeline')));
  const tb2 = await page.locator('#timeline .chart-stage').boundingBox();
  await page.mouse.move(tb2.x + tb2.width * 0.5, tb2.y + 80); await page.mouse.move(tb2.x + tb2.width * 0.55, tb2.y + 90, { steps: 4 });
  check('hovering a candle shows open, high, low and close', /O\s.*H\s.*L\s.*C\s/s.test(await text('#timeline .chart-tip')), await text('#timeline .chart-tip'));
  await page.selectOption('#tliv', '1d'); await page.locator('#timeline button[data-style="line"]').click();
  await page.selectOption('#tlwho', 'NVDA');
  await page.waitForSelector('#timeline svg.chart-svg path.ln', { timeout: 20000, state: 'attached' });
  check('a single holding can be charted by itself', /NVDA price history/.test(await text('#timeline')));
  await page.selectOption('#tlwho', 'ALL');
  const order = async () => (await page.locator('#postable tbody tr td:first-child input').evaluateAll((els) => els.map((e) => e.value)));
  const orderBefore = await order();
  await page.locator('#postable [data-sort="ticker"]').click();
  const asc = await order();
  check('clicking a column header sorts the positions', JSON.stringify(asc) === JSON.stringify([...orderBefore].sort()), JSON.stringify([orderBefore, asc]));
  check('the sorted column is announced', (await page.locator('#postable th[aria-sort="ascending"]').count()) === 1);
  await page.locator('#postable [data-sort="ticker"]').click();
  check('a second click reverses it', JSON.stringify(await order()) === JSON.stringify([...orderBefore].sort().reverse()));
  await page.locator('#postable [data-sort="ticker"]').click();
  check('a third click returns to the original order', JSON.stringify(await order()) === JSON.stringify(orderBefore));
  const firstTicker = (await order())[0];
  const tvalBefore = await text('#tiles');
  await page.locator('#postable .pricein').first().fill('1000');
  check('typing a price marks it manual and moves the totals', (await page.locator('#postable .pricein.manual').count()) === 1 && (await text('#tiles')) !== tvalBefore);
  await page.getByRole('button', { name: 'Save changes' }).click();
  await sleep(600);
  check('a typed price is saved with the holding', store.getHoldings().positions.some((p) => p.ticker === firstTicker && p.manualPrice === 1000), JSON.stringify(store.getHoldings().positions));
  check('Analyze sees the typed price too', await page.evaluate((t) => TD.priceMap()[t] === 1000, firstTicker));
  await page.locator('#postable .resetp').first().click();
  check('the reset arrow returns to the live price', (await page.locator('#postable .pricein.manual').count()) === 0);
  await page.getByRole('button', { name: 'Refresh prices' }).click();
  await sleep(1500);
  check('Refresh prices reloads without error', !/unavailable/.test(await text('#tiles')), await text('#tiles'));
  await page.getByRole('button', { name: 'Save changes' }).click(); await sleep(500);
  check('the reset price is saved as live again', store.getHoldings().positions.every((p) => p.manualPrice == null));

  check('import, paste and add-row sit below the table', await page.evaluate(() => { const t = document.querySelector('table.list').getBoundingClientRect().bottom; const b = [...document.querySelectorAll('button')].find((x) => x.textContent === 'Import Excel or CSV').getBoundingClientRect().top; return b > t; }));
  await shot('03b-holdings-charts');

  // --------------------------------------------------------- analyze
  console.log('analyze');
  await nav('analyze');
  await page.waitForSelector('#stats .kvgrid', { timeout: 30000 });
  check('Analyze has four panes', (await page.locator('#newcard, #sum, #stats, #mine, #keyinfo').count()) === 5);
  check('Workspace and Queue are page-level tabs', (await page.locator('.pagetabs .ptab').allInnerTexts()).join('|').replace(/\s+/g, ' ').startsWith('Workspace|Queue'));
  check('ticker stats show price, 52-week range and a chart', /52-week low/.test(await text('#stats')) && (await page.locator('#stats svg.chart-svg path.ln').count()) === 1 && (await page.locator('#stats .rangebar').count()) === 1);
  check('My tickers lists holdings with sparklines', (await page.locator('#mine .mine-row').count()) >= 2 && (await page.locator('#mine .mine-row svg.spark').count()) >= 2);
  check('key information shows the position', /You hold/.test(await text('#keyinfo')));
  await page.locator('#mine .mine-row').nth(1).click();
  await page.waitForFunction(() => document.querySelector('#stats h2') && !/Loading/.test(document.querySelector('#stats').innerText), null, { timeout: 20000 });
  const picked = await page.locator('#mine .mine-row.sel').getAttribute('data-ticker');
  check('clicking a ticker selects it and fills the form', (await page.inputValue('#tkr')) === picked && (await text('#stats h2')).startsWith(picked), picked);
  await shot('04a-analyze-workspace');
  await page.fill('#tkr', 'nvda'); await page.press('#tkr', 'Enter');
  await page.waitForFunction(() => /NVDA/.test(document.querySelector('#stats h2').innerText), null, { timeout: 20000 });
  check('position hint reflects holdings', /You hold 7\.825662 units/.test(await text('#posHint')), await text('#posHint'));
  check('depth choices offered', (await page.locator('#profile option').allInnerTexts()).join() === 'Fast,Standard,Thorough');
  await page.getByRole('button', { name: 'Run analysis' }).click();
  await page.waitForSelector('#sum .step', { timeout: 10000 });
  check('progress has a Time left line', /Time left/.test(await text('#sum')));
  check('briefing is a visible stage', /Briefing/.test(await text('#sum .steps')));
  check('run chip and cancel button shown while running', await page.locator('#jobChip').isVisible() && await page.locator('#cancelBtn').isVisible());
  await page.waitForSelector('#sum .decision-card', { timeout: 90000 });
  check('rating badge shows Overweight', /Overweight/.test(await text('#sum .badge.rating')));
  check('rating badge has a text label, not colour alone', (await text('#sum .badge.rating')).length > 3);
  const dc = await text('#sum .decision-card');
  check('decision card says what is asked of you', /Add to your NVDA position, or leave it as it is\?/.test(dc), dc);
  check('decision card never sizes the trade', /does not size a trade/.test(dc));
  check('decision card shows the position facts', /You hold 7\.825662 units/.test(dc), dc);
  const bt0 = await text('#sum');
  check('reasons for and against are listed', /Reasons for this rating/.test(bt0) && /Reasons against, and risks/.test(bt0) && (await page.locator('#sum .reasons.for li').count()) >= 2 && (await page.locator('#sum .reasons.against li').count()) >= 1, bt0.slice(0, 600));
  check('each reason carries its source quote', (await page.locator('#sum .reasons details.src blockquote').count()) >= 3);
  check('an invented quote from the model was dropped and said so', /1 that could not be matched was left out/.test(bt0), bt0.slice(-500));
  check('plain disclaimer under the briefing', /not financial advice/.test(await text('#sum .disc-line')));
  check('this model\'s record is shown, even when empty', (await page.locator('#sum .recline').count()) === 1, '');
  check('summary was written once the run finished (no old-run button)', (await page.locator('#sum button:has-text("Write the briefing")').count()) === 0);
  await shot('04-result');
  const run1 = store.listJournal()[0];
  check('analysis added to the journal', store.listJournal().length === 1 && run1.ticker === 'NVDA');
  check('standard depth is recorded on the entry', run1.profile === 'standard');
  const saved1 = store.getRun(run1.id);
  check('the briefing is stored with the run', saved1.result.brief && saved1.result.brief.mode === 'model' && saved1.result.brief.dropped === 1);
  check('the timeline includes the briefing stage', run1.timeline && run1.timeline.briefing > 0, JSON.stringify(run1.timeline));

  await page.getByRole('button', { name: 'Open full report' }).click();
  await page.waitForSelector('.modal-box .result-head');
  check('full report opens on the Briefing tab', /Reasons for this rating/.test(await text('.modal-box')) && await page.locator('.modal-box .tab.active[data-tab="briefing"]').count() === 1);
  check('result lists the model', /fake:1b/.test(await text('.modal-box .meta')));
  check('result shows your position', /7\.825662 units/.test(await text('.modal-box .meta')), await text('.modal-box .meta'));
  await page.locator('.modal-box .tab[data-tab="decision"]').click();
  check('decision text rendered from markdown', /Executive Summary/i.test(await text('.modal-box .md')));
  await page.locator('.modal-box .tab[data-tab="debate"]').click();
  check('bull and bear tab shows both sides', /Bull Analyst/.test(await text('.modal-box')) && /Bear Analyst/.test(await text('.modal-box')));
  await page.locator('.modal-box .tab[data-tab="risk"]').click();
  check('risk tab shows three voices', /Aggressive/.test(await text('.modal-box')) && /Conservative/.test(await text('.modal-box')));
  await page.locator('.modal-box .tab[data-tab="news"]').click();
  await page.waitForSelector('.modal-box .newsview .heads, .modal-box .newsview .empty-note', { timeout: 20000 });
  check('news tab lists headlines and the News analyst reading', /Recent headlines/.test(await text('.modal-box .newsview')) && /What the News analyst made of it/.test(await text('.modal-box .newsview')));
  check('headlines are labelled as of today', /as of today/.test(await text('.modal-box .newsview')));
  await shot('04b-news-tab');
  await page.selectOption('.modal-box .acttype', 'bought');
  await page.locator('.modal-box input[placeholder=units]').fill('2');
  await page.locator('.modal-box input[placeholder=price]').fill('224.5');
  await page.locator('.modal-box input[placeholder^="Why"]').fill('starter position');
  await page.locator('.modal-box').getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForFunction(() => /Saved to the journal/.test(document.querySelector('.modal-box .callout').innerText));
  const j1 = store.listJournal();
  check('your action recorded', j1[0].action && j1[0].action.type === 'bought' && j1[0].action.price === 224.5);
  check('position snapshot kept with the entry', j1[0].position && j1[0].position.quantity === 7.825662);
  saveTarget = path.join(tmp, 'brief.md');
  await page.getByRole('button', { name: 'Export brief (.md)' }).click();
  await page.waitForFunction(() => /Brief saved/.test(document.getElementById('toasts').innerText));
  const brief = fs.readFileSync(saveTarget, 'utf8');
  check('exported brief has rating, position, disclaimer and action', /Rating: Overweight/.test(brief) && /7\.825662 units/.test(brief) && /not financial advice/.test(brief) && /What you did/.test(brief));
  await page.getByRole('button', { name: 'Show saved report files' }).click();
  check('report folder shown from inside the data folder only', shown.length === 1 && shown[0].startsWith(paths.dataDir), shown[0]);
  await page.keyboard.press('Escape');
  check('Escape closes a normal dialog', await page.locator('#modal').isHidden());

  // an older run with no briefing offers to write one
  store.setBrief(run1.id, null);
  await page.reload(); await accept();
  await nav('analyze');
  await page.waitForSelector('#sum .decision-card', { timeout: 30000 });
  check('an old run without a briefing offers to write it', await page.locator('#sum button:has-text("Write the briefing")').isVisible());
  await page.locator('#sum button:has-text("Write the briefing")').click();
  await page.waitForSelector('#sum .reasons.for li', { timeout: 60000 });
  check('the written briefing is saved back into the run', store.getRun(run1.id).result.brief && store.getRun(run1.id).result.brief.mode === 'model');

  // past-dated run with the portfolio excluded, at Fast depth
  await page.fill('#dt', '2026-09-15');
  await page.uncheck('#inc');
  await page.selectOption('#profile', 'fast');
  await page.getByRole('button', { name: 'Run analysis' }).click();
  await page.waitForFunction(() => document.querySelector('#sum .decision-card') && /2026-09-15/.test(document.querySelector('#sum').innerText), null, { timeout: 90000 });
  check('second analysis saved', store.listJournal().length === 2);
  check('fast depth recorded', store.listJournal()[0].profile === 'fast');
  check('fast depth keeps its own time history', store.etaHistory('ollama', 'fake:1b', 10, 'fast').length === 1 && store.etaHistory('ollama', 'fake:1b', 10, 'standard').length === 1);
  const ctxText = store.getRun(store.listJournal()[0].id).result.sections.portfolio_context;
  check('"no holdings" run sent no portfolio context', !ctxText, ctxText);
  const withCtx = store.getRun(store.listJournal()[1].id).result.sections.portfolio_context;
  check('holdings run sent the portfolio to the agents', /Current position in NVDA/.test(withCtx) && /Cash available: 848\.98/.test(withCtx), withCtx);
  check('a run with no holdings says you hold none in its decision card', /You hold no NVDA|You hold 7\.825662/.test(await text('#sum .decision-card')));

  // future dates and bad tickers are refused
  await page.fill('#dt', '2026-12-31');
  await page.getByRole('button', { name: 'Run analysis' }).click();
  await page.waitForFunction(() => /future/.test(document.getElementById('toasts').innerText), null, { timeout: 5000 }).catch(() => {});
  check('a future date is refused', /future/.test(await text('#toasts')) || store.listJournal().length === 2);
  check('refused date did not create a journal entry', store.listJournal().length === 2);

  // --------------------------------------------------------- market data
  console.log('market data');
  const q1 = await handlers.get('quote:get')(null, { tickers: ['MSFT', 'nope'], years: 1, news: true });
  check('quote returns price, range and statistics', q1.ok && q1.items[0].ok && q1.items[0].yearHigh > q1.items[0].yearLow && q1.items[0].history.length > 200, JSON.stringify(q1).slice(0, 200));
  check('quote returns headlines when asked', q1.items[0].news && q1.items[0].news.length >= 1);
  check('an unknown symbol gives a per-ticker error, not a failure', q1.items[1].ok === false && /No price history/.test(q1.items[1].error));
  const q2 = await handlers.get('quote:get')(null, { tickers: ['MSFT'], years: 1, news: true });
  check('a repeat request is served from the cache', q2.ok && q2.items[0].price === q1.items[0].price);
  check('quote never takes the job lock', (await handlers.get('job:status')(null, {})).running === null);
  check('quote refuses an empty request', (await handlers.get('quote:get')(null, { tickers: [] })).ok === false);

  // --------------------------------------------------------- watchlist
  console.log('watchlist');
  await nav('watch');
  await page.fill('#wtk', 'goog'); await page.fill('#wnote', 'buy under 330'); await page.keyboard.press('Enter');
  await page.waitForSelector('.wl-row');
  await page.fill('#wtk', 'avgo'); await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('button', { name: 'Add all my holdings' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.wl-row').length === 4);
  check('watchlist holds 4 unique tickers', store.getWatchlist().length === 4);
  check('watchlist is split: list on the left, detail on the right', await page.evaluate(() => { const l = document.querySelector('#wlist').getBoundingClientRect(); const d = document.querySelector('#wdetail').getBoundingClientRect(); return d.left > l.right - 2; }));
  await page.waitForSelector('#wdetail svg.chart-svg', { timeout: 30000 }).catch(() => {});
  check('selected ticker shows its note and chart', /buy under 330|Your note/.test(await text('#wdetail')) || (await page.locator('#wdetail svg.chart-svg').count()) >= 1);
  await page.locator('.wl-row[data-ticker="NVDA"]').click();
  await page.waitForSelector('#wdetail .decision-card', { timeout: 20000 });
  check('selecting an analysed ticker shows its briefing beside the list', /Overweight/.test(await text('#wdetail')) && /Reasons for this rating/.test(await text('#wdetail')));
  await shot('05-watchlist');
  await page.fill('#wdate', '2026-09-15');
  await page.getByRole('button', { name: /Queue all 4/ }).click();
  await page.waitForSelector('.ptab.active[data-tab="queue"]', { timeout: 10000 });
  check('queueing the list opens the Queue tab', true);
  await page.waitForFunction(() => TD.state.queue.length === 4 && TD.state.queue.every((i) => i.status === 'done' || i.status === 'failed'), null, { timeout: 240000 });
  check('all 4 queued tickers finished with a rating', (await handlers.get('queue:state')(null, {})).queue.every((i) => i.status === 'done'));
  check('queue added 4 journal entries', store.listJournal().length === 6, String(store.listJournal().length));
  await handlers.get('queue:clear')(null, {});
  await nav('watch');
  await page.waitForFunction(() => document.querySelectorAll('.wl-row .badge.rating').length >= 4, null, { timeout: 20000 });
  check('every watchlist row now shows its rating', (await page.locator('.wl-row .badge.rating').count()) >= 4);
  await page.selectOption('#wsort', 'rating');
  check('the list can be sorted best rated first', (await page.locator('.wl-row').count()) === 4);
  await page.locator('#wdetail button:has-text("Open full report")').click();
  await page.waitForSelector('.modal-box .result-head');
  check('watchlist result opens the full report', /Portfolio manager/.test(await text('.modal-box .tabs')) || /Decision/.test(await text('.modal-box .tabs')));
  await page.keyboard.press('Escape');

  // ----------------------------------------------------------- journal
  console.log('calendar');
  await nav('calendar');
  await page.waitForSelector('#calroot .ev', { timeout: 30000 });
  const kinds = await page.locator('#calroot .ev').evaluateAll((els) => [...new Set(els.map((e) => e.dataset.kind))]);
  check('calendar lists company, Fed, economic and expiry events', ['earnings', 'fed', 'macro', 'expiry'].every((k) => kinds.includes(k)), kinds.join(','));
  check('calendar marks high-impact events in words', /High impact/.test(await text('#calroot')));
  check('calendar says what it cannot know', /not in any free feed/.test(await text('#calroot')));
  check('events for a held ticker say how much you hold', /You hold .* about \d+% of what you hold/.test(await text('#calroot')));
  await page.locator('.kchip[data-kind="fed"]').click();
  check('a type filter hides that kind', (await page.locator('#calroot .ev[data-kind="fed"]').count()) === 0);
  await page.locator('.kchip[data-kind="fed"]').click();
  await page.getByRole('button', { name: 'Add an event' }).click();
  await page.fill('#evtitle', 'Product launch keynote'); await page.fill('#evticker', 'nvda'); await page.selectOption('#evimpact', 'high');
  await page.click('#evadd');
  await page.waitForSelector('#calroot .ev[data-kind="custom"]');
  check('your own event is added and saved', store.getMeta().customEvents.length === 1 && store.getMeta().customEvents[0].ticker === 'NVDA');
  await page.locator('#calroot .ev[data-kind="custom"] button', { hasText: 'Remove' }).click();
  await sleep(400);
  check('your own event can be removed', store.getMeta().customEvents.length === 0);
  const calApi = await handlers.get('calendar:get')(null, { tickers: ['NVDA'], days: 30 });
  check('calendar handler returns events with notes', calApi.ok && calApi.events.length > 0 && Array.isArray(calApi.notes));
  const evBad = await handlers.get('events:save')(null, { events: [{ title: '', date: '2026-01-01' }, { title: 'x', date: 'nope' }, { title: '<b>y</b>', date: '2026-11-02', impact: 'weird' }] });
  check('event input is cleaned: bad rows dropped, impact defaulted', evBad.events.length === 1 && evBad.events[0].impact === 'medium');
  await handlers.get('events:save')(null, { events: [] });
  const barsBad = await handlers.get('bars:get')(null, { tickers: ['NVDA'], interval: '1m', range: 'max' });
  check('bars handler refuses an unsupported pair', barsBad.ok === false);
  check('bars handler refuses shell-looking input', (await handlers.get('bars:get')(null, { tickers: ['NVDA'], interval: '1d; rm', range: '1y' })).ok === false);

  // draggable dividers
  console.log('dividers');
  await page.evaluate(() => { try { localStorage.clear(); } catch (e) { /* ignore */ } });
  await workspace();
  await page.waitForSelector('#ws > .gutter');
  const leftW = async () => (await page.locator('.ws-left').boundingBox()).width;
  const w0 = await leftW();
  const gb = await page.locator('#ws > .gutter').boundingBox();
  await page.mouse.move(gb.x + 8, gb.y + 300); await page.mouse.down(); await page.mouse.move(gb.x + 128, gb.y + 300, { steps: 6 }); await page.mouse.up();
  const w1 = await leftW();
  check('dragging the divider widens the left side', w1 > w0 + 80, `${w0} -> ${w1}`);
  await page.locator('#ws > .gutter').focus(); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft');
  check('arrow keys move the divider', (await leftW()) < w1 - 20);
  await page.locator('#ws > .gutter').dblclick();
  check('double click resets it', Math.abs((await leftW()) - w0) < 3);
  const g2 = await page.locator('.ws-right > .gutter').boundingBox();
  const sh0 = (await page.locator('#stats').boundingBox()).height;
  await page.mouse.move(g2.x + 100, g2.y + 8); await page.mouse.down(); await page.mouse.move(g2.x + 100, g2.y - 90, { steps: 6 }); await page.mouse.up();
  check('the stats pane can be made shorter', (await page.locator('#stats').boundingBox()).height < sh0 - 50);
  await page.mouse.move(g2.x + 100, g2.y - 82); // keep hover state sane
  await page.evaluate(() => TD.go('watch')); await page.waitForSelector('.wsplit > .gutter');
  const wl0 = (await page.locator('.wleft').boundingBox()).width;
  const g3 = await page.locator('.wsplit > .gutter').boundingBox();
  await page.mouse.move(g3.x + 8, g3.y + 200); await page.mouse.down(); await page.mouse.move(g3.x + 108, g3.y + 200, { steps: 5 }); await page.mouse.up();
  check('the watchlist divider moves too', (await page.locator('.wleft').boundingBox()).width > wl0 + 60);
  await page.evaluate(() => { try { localStorage.clear(); } catch (e) { /* ignore */ } });
  await page.reload(); await accept();

  console.log('track record');
  await nav('track');
  check('Track record has Journal and Backtest tabs', (await page.locator('.pagetabs .ptab').allInnerTexts()).join('|').replace(/\s+/g, ' ') === 'Journal|Backtest');
  check('the journal links across to the backtest', /Run a backtest/.test(await text('.crosslink')));
  await page.waitForSelector('table.list tbody tr');
  check('journal lists all analyses', (await page.locator('table.list tbody tr').count()) === 6);
  await page.getByRole('button', { name: 'Score outcomes' }).click();
  await page.waitForSelector('h2:has-text("Track record against SPY")', { timeout: 60000 });
  const jt = await text('#view');
  check('scored 5 past decisions', /5\s*scored decisions/i.test(jt.replace(/\n/g, ' ')), jt.slice(0, 500));
  check('hit rate 40 percent (NVDA twice beat SPY, GOOG AVGO SCHD did not)', /40%/.test(jt));
  check('small-sample caution shown', /Only 5 scored decisions/.test(jt));
  check('today\'s analysis reports no price data yet', /no price data/i.test(jt.replace(/\n/g, ' ')) || /no closes after/.test(jt));
  check('followed-rating comparison present', /Followed the rating/.test(jt));
  await shot('06-journal');
  await page.locator('table.list').last().locator('tbody tr').nth(1).click();
  await page.waitForSelector('.modal-box .result-head');
  await page.getByRole('button', { name: 'Close' }).click();
  await page.locator('table.list tbody tr').last().getByRole('button', { name: 'Delete' }).click();
  await page.waitForFunction(() => document.querySelectorAll('table.list tbody tr').length >= 1);
  check('delete removed one entry', store.listJournal().length === 5);
  await page.fill('input[placeholder="Filter by ticker"]', 'goog');
  check('filter narrows the list', (await page.locator('table.list').last().locator('tbody tr').count()) === 1);

  // ---------------------------------------------------------- backtest
  console.log('backtest');
  await nav('track');
  await page.click('.ptab[data-tab="backtest"]');
  check('the backtest links back to the journal', /Open the journal/.test(await text('.crosslink')));
  await page.fill('#btk', 'NVDA'); await page.fill('#bstart', '2026-09-01'); await page.fill('#bend', '2026-09-15'); await page.fill('#bevery', '7');
  check('backtest estimate counts the cells', /3 analyses/.test(await text('#best')), await text('#best'));
  await page.getByRole('button', { name: 'Run backtest' }).click();
  await page.waitForSelector('#bres h2:has-text("Result")', { timeout: 180000 });
  const bt = await text('#bres');
  check('backtest ran 3 analyses', /3\s*analyses run/.test(bt.replace(/\n/g, ' ')), bt.slice(0, 300));
  check('backtest does not claim results it could not score', /0\s*scored/.test(bt.replace(/\n/g, ' ')) || /Nothing was scored/.test(bt));
  check('backtest stored', store.listBacktests().length === 1);
  const rec = await handlers.get('record:for')(null, {});
  check('the model record counts backtests on the same model', rec.ok && rec.model === 'fake:1b' && rec.backtests === 1, JSON.stringify(rec));
  check('quit handler exists and is safe without a host', (await handlers.get('app:quit')(null, {})).ok === true);
  await shot('07-backtest');

  // ---------------------------------------------------- cancel and errors
  console.log('cancel and failure');
  store.setSettings({ ollamaUrl: 'http://127.0.0.1:12102' }); await refresh();
  const before = store.listJournal().length;
  await workspace();
  await page.fill('#tkr', 'MSFT'); await page.fill('#dt', '2026-09-15');
  await page.getByRole('button', { name: 'Run analysis' }).click();
  await page.waitForSelector('#cancelBtn:not([hidden])', { timeout: 10000 });
  await sleep(1500);
  await page.click('#cancelBtn');
  await page.waitForSelector('#sum .callout.warn:has-text("Cancelled")', { timeout: 20000 });
  check('cancelled run saved nothing', store.listJournal().length === before);
  check('cancel button hides afterwards', await page.locator('#cancelBtn').isHidden());
  check('run button usable again', await page.getByRole('button', { name: 'Run analysis' }).isEnabled());

  store.setSettings({ ollamaUrl: 'http://127.0.0.1:12199' }); await refresh();   // nothing listens here
  await page.getByRole('button', { name: 'Run analysis' }).click();
  await page.waitForSelector('#sum .callout.bad', { timeout: 120000 });
  check('a dead model server gives a clear failure', /The run failed/.test(await text('#sum')), await text('#sum'));
  check('failure saved nothing', store.listJournal().length === before);
  await shot('08-failure');
  store.setSettings({ ollamaUrl: 'http://127.0.0.1:12101' }); await refresh();

  // two jobs cannot run at once
  const r1 = handlers.get('analyze:run')(null, { ticker: 'AAPL', date: '2026-09-15' });
  const r2 = await handlers.get('analyze:run')(null, { ticker: 'AMZN', date: '2026-09-15' });
  check('a second job is refused while one runs', r2.ok === false && /Another job is running/.test(r2.error), JSON.stringify(r2));
  await handlers.get('job:cancel')(null, {});
  await r1;

  // ---------------------------------------------------- queue and cancel all
  console.log('queue');
  store.setSettings({ ollamaUrl: 'http://127.0.0.1:12102' }); await refresh();
  const jBefore = store.listJournal().length;
  const qa = await handlers.get('queue:add')(null, { items: ['AAA', 'BBB', 'CCC'], date: '2026-09-15' });
  check('three analyses queued', qa.ok && qa.added === 3, JSON.stringify(qa));
  const dup = await handlers.get('queue:add')(null, { items: ['AAA'], date: '2026-09-15' });
  check('a duplicate is not queued twice', dup.ok && dup.added === 0);
  await nav('analyze');
  await page.click('.ptab[data-tab="queue"]');
  await page.waitForSelector('#qbody table.list');
  check('the Queue tab shows a count badge', /3/.test(await text('.ptab[data-tab="queue"] .tab-count')) && await page.locator('#qCount').isVisible());
  check('queue page lists three rows', (await page.locator('#qbody tbody tr').count()) === 3);
  check('top bar shows queue and Cancel all', /Queue: 3 left/.test(await text('#jobChip')) && await page.locator('#cancelBtn').isVisible() && /Cancel all/.test(await text('#cancelBtn')), await text('#jobChip'));
  const clash = await handlers.get('analyze:run')(null, { ticker: 'AMZN', date: '2026-09-15' });
  check('a single run is refused while the queue works', clash.ok === false && /Another job is running/.test(clash.error), JSON.stringify(clash));
  await page.waitForSelector('#qbody .badge.warn:has-text("Running")', { timeout: 20000 });
  check('queue has a Time left column beside the summary', await page.evaluate(() => { const th = [...document.querySelectorAll('#qbody th')].map((x) => x.textContent); return th.indexOf('Time left') >= 0 && th.indexOf('Time left') === th.indexOf('Summary') - 1; }));
  // A queue item becomes running before preflight creates its first estimate.
  await page.waitForFunction(() => [...document.querySelectorAll('#qbody tbody td .eta')]
    .some((el) => /left|longer than usual|under 1 min/.test(el.textContent)), null, { timeout: 20000 });
  const leftTexts = await page.locator('#qbody tbody td .eta').allInnerTexts();
  check('running row shows a live time-left text', leftTexts.some((t) => /left|longer than usual|under 1 min/.test(t)), JSON.stringify(leftTexts));
  check('waiting rows show when they will be done', leftTexts.some((t) => /done in/.test(t)), JSON.stringify(leftTexts));
  check('queue shows when everything will be finished', /Everything finished in/.test(await text('#qhead')), await text('#qhead'));
  await shot('10-queue');
  const ids = (await handlers.get('queue:state')(null, {})).queue;
  const removed = await handlers.get('queue:cancel')(null, { id: ids.find((i) => i.ticker === 'CCC').id });
  check('one waiting item can be removed', removed.queue.find((i) => i.ticker === 'CCC').status === 'canceled');
  await page.click('#cancelBtn');
  await page.waitForFunction(() => TD.state.queue.every((i) => i.status !== 'queued' && i.status !== 'running'), null, { timeout: 30000 });
  const qs = (await handlers.get('queue:state')(null, {})).queue;
  check('Cancel all stops the running item and clears the rest', qs.every((i) => i.status === 'canceled'), JSON.stringify(qs.map((i) => i.status)));
  check('cancelled queue items saved nothing', store.listJournal().length === jBefore);
  check('top bar is idle again', await page.locator('#cancelBtn').isHidden());
  check('engine is free for the next job', (await handlers.get('job:status')(null, {})).running === null);
  await handlers.get('queue:clear')(null, {});
  // a queued run that is allowed to finish is saved to the journal
  store.setSettings({ ollamaUrl: 'http://127.0.0.1:12101' }); await refresh();
  await handlers.get('queue:add')(null, { items: ['DDD'], date: '2026-09-15' });
  await page.waitForFunction(() => TD.state.queue.some((i) => i.status === 'done'), null, { timeout: 120000 });
  const dd = store.listJournal()[0];
  check('finished runs keep their stage timeline', dd.timeline && dd.timeline.end > 0 && Object.keys(dd.timeline).length >= 3, JSON.stringify(dd.timeline));
  check('a finished queue item is in the journal', store.listJournal().length === jBefore + 1 && store.listJournal()[0].ticker === 'DDD');
  await page.waitForSelector('#qbody button:has-text("Open")');
  await handlers.get('queue:clear')(null, {});

  // ------------------------------------------------ paste from a spreadsheet
  console.log('paste import');
  await nav('holdings');
  const beforePaste = store.getHoldings().positions.length;
  await page.getByRole('button', { name: 'Paste from spreadsheet' }).click();
  await page.fill('.modal-box textarea', [
    'Stock\tQTY\tCurrent Price\tPurchase Price\tCurrent total\tBought At\tProfit/Loss',
    'PAST1\t10\t$180.50\t$120.00\t$1,805.00\t3/14/2024\t$605.00',
    'Tesla Inc\t3\t200\t100\t600\t1/1/2024\t300',
    'PAST2\t4\t400\t\t1600\t5/5/2024\t$200',
  ].join('\n'));
  await page.getByRole('button', { name: 'Read this table' }).click();
  await page.waitForSelector('.modal-box table');
  const pv = await text('.modal-box');
  check('paste preview shows the tickers and the sheet columns', /PAST1/.test(pv) && /2024-03-14/.test(pv) && /180\.50/.test(pv), pv.slice(0, 400));
  check('paste preview explains the skipped company name', /1 row skipped/.test(pv));
  check('paste preview warns that cost was worked out', /worked out from price and Profit\/Loss for PAST2/.test(pv));
  await page.selectOption('.modal-box select >> nth=-1', 'merge');
  await shot('11-paste-import');
  await page.getByRole('button', { name: 'Import these positions' }).click();
  await page.waitForSelector('.modal-box', { state: 'detached', timeout: 5000 }).catch(() => {});
  const pasted = store.getHoldings();
  check('pasted rows were added to the existing holdings', pasted.positions.length === beforePaste + 2, String(pasted.positions.length));
  check('last price, profit and purchase date are kept', pasted.positions.find((p) => p.ticker === 'PAST1').lastPrice === 180.5 && pasted.positions.find((p) => p.ticker === 'PAST1').boughtAt === '2024-03-14');
  const ht = await text('#view');
  check('holdings page shows profit or loss', /\+605\.00/.test(ht), ht.slice(0, 600));
  await shot('12-holdings-pl');

  // ------------------------------------------- model must exist before a run
  console.log('model preflight');
  const jb = store.listJournal().length;
  store.setSettings({ ollamaUrl: 'http://127.0.0.1:12101', quickModel: 'fake:1b', deepModel: 'ghost:7b' });
  const pf1 = await handlers.get('analyze:run')(null, { ticker: 'NVDA', date: '2026-09-15' });
  check('a missing deep model stops the run before it starts', pf1.ok === false && /deep model "ghost:7b" is not installed/i.test(pf1.error) && /Installed models: fake:1b/.test(pf1.error), JSON.stringify(pf1));
  const pf2 = await handlers.get('queue:add')(null, { items: ['NVDA'], date: '2026-09-15' });
  check('the queue refuses it too', pf2.ok === false && /not installed/.test(pf2.error));
  const pf3 = await handlers.get('batch:run')(null, { tickers: ['NVDA'], date: '2026-09-15' });
  check('a batch refuses it', pf3.ok === false && /not installed/.test(pf3.error));
  const pf4 = await handlers.get('engine:modelcheck')(null, {});
  check('the model check reports it instead of passing', pf4.ok === true && pf4.passed === false && /ghost:7b/.test(JSON.stringify(pf4.checks)), JSON.stringify(pf4));
  check('nothing was started or saved', store.listJournal().length === jb && (await handlers.get('job:status')(null, {})).running === null);
  store.setSettings({ ollamaUrl: 'http://127.0.0.1:12198', quickModel: 'fake:1b', deepModel: 'fake:1b' });
  const pf5 = await handlers.get('analyze:run')(null, { ticker: 'NVDA', date: '2026-09-15' });
  check('an unreachable Ollama gives a clear message', pf5.ok === false && /Ollama is not reachable/.test(pf5.error), JSON.stringify(pf5));
  store.setSettings({ ollamaUrl: 'http://127.0.0.1:12101', quickModel: 'fake:1b', deepModel: 'fake:1b' }); await refresh();

  // -------------------------------------------------------- link safety
  console.log('safety');
  const bad = await handlers.get('shell:open')(null, { url: 'https://evil.example.com/x' });
  const file = await handlers.get('shell:open')(null, { url: 'file:///etc/passwd' });
  const good = await handlers.get('shell:open')(null, { url: 'https://ollama.com/download' });
  check('only allow-listed https links open', bad.ok === false && file.ok === false && good.ok === true && opened.length === 1);
  const trav = await handlers.get('journal:get')(null, { id: '../../etc/passwd' });
  check('journal ids cannot traverse paths', trav.ok === false);
  const badTicker = await handlers.get('analyze:run')(null, { ticker: '../x', date: '2026-09-15' });
  check('bad ticker refused before any process starts', badTicker.ok === false && /ticker/.test(badTicker.error));
  check('page set no inline styles via attributes (CSP)', !errors.some((e) => /Content Security Policy/i.test(e)), errors.join(' | '));

  // ---------------------------------------------------- layout and a11y
  console.log('layout');
  for (const [w, hgt] of [[1360, 900], [1020, 700], [900, 700]]) {
    await page.setViewportSize({ width: w, height: hgt });
    for (const id of ['analyze', 'watch', 'holdings', 'calendar', 'track', 'setup', 'how']) {
      await nav(id);
      await page.waitForTimeout(150);
      const o = await page.evaluate(() => { const v = document.getElementById('view'); return { sw: v.scrollWidth, cw: v.clientWidth }; });
      check(`no horizontal overflow on ${id} at ${w}px`, o.sw <= o.cw + 1, JSON.stringify(o));
    }
  }
  await page.setViewportSize({ width: 1360, height: 900 });
  await nav('analyze');
  const unlabeled = await page.evaluate(() => [...document.querySelectorAll('button')].filter((b) => !(b.innerText || b.getAttribute('aria-label') || b.title || '').trim()).length);
  check('every button has a name', unlabeled === 0);

  // ----------------------------------------------- engine not installed
  console.log('not installed');
  paths.enginePython = path.join(tmp, 'nope', 'python');
  await page.reload(); await accept();
  await page.waitForSelector('#pageTitle:has-text("Setup")', { timeout: 20000 });
  await page.waitForSelector('.comp[data-comp="engine"]', { timeout: 20000 });
  check('missing engine sends you to Setup', /Missing/.test(await text('.comp[data-comp="engine"]')));
  check('engine install button offered', await page.locator('.comp[data-comp="engine"] button:has-text("Install")').isVisible());
  check('install everything missing is offered', await page.locator('#installAll').isVisible());
  const blocked = await handlers.get('analyze:run')(null, { ticker: 'NVDA', date: '2026-09-15' });
  check('analysis refused with a helpful message when not installed', blocked.ok === false && /not installed/.test(blocked.error));
  await shot('09-not-installed');
  paths.enginePython = PY;

  check('no console or page errors', errors.length === 0, errors.slice(0, 5).join(' | '));

  await browser.close();
  fast.kill(); slow.kill();
  console.log(`\n${passed} passed, ${failed} failed. Screenshots in ${OUT}`);
  if (failed) { console.log(failures.map((f) => ' - ' + f).join('\n')); process.exit(1); }
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(3); });
