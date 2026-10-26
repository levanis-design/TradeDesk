'use strict';
// IPC handlers, free of Electron globals so tests can drive them with fakes.
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { trustedSender } = require('./security');

const { cleanTicker, PROVIDERS } = require('./store');
const { runEngine } = require('./engine');
const { createBatch, rankResults } = require('./batch');
const eta = require('./eta');
const profiles = require('./profiles');
const models = require('./models');
const { snapshot, ollamaStatus } = require('./hardware');
const { installEngine, venvPython, PINNED_SHA } = require('./setup');
const holdingsLib = require('./holdings');
const reqs = require('./requests');
const scoring = require('./scoring');
const { buildBrief } = require('./brief');
const { createComponents } = require('./components');

function createIpc(ctx) {
  const { store, dialog, shell, safeStorage, send, getWindow, version, paths } = ctx;
  const fetchFn = ctx.fetchFn || fetch;
  let heavy = null;
  let currentBatch = null;
  const quoteCache = new Map();
  const quoteMiss = new Map();
  const QUOTE_TTL = 5 * 60 * 1000;
  let quoteChain = Promise.resolve();
  const barsCache = new Map();
  const calCache = new Map();
  const moveCache = new Map();
  let readChain = Promise.resolve();
  const importCache = new Map();

  const engineDir = () => paths.engineDir;
  const dataDir = () => paths.dataDir;
  const enginePython = () => paths.enginePython || venvPython(path.join(engineDir(), 'venv'));
  const engineScript = () => paths.engineScript;
  const fail = (msg) => ({ ok: false, error: msg });
  const engineReady = () => fs.existsSync(enginePython());

  const components = ctx.components || createComponents({
    fetchFn, getSettings: () => store.getSettings(), engineReady, enginePython,
  });

  function secretsFor(settings) {
    const all = store.getSecrets();
    const out = {};
    if (settings.provider === 'anthropic' && all.ANTHROPIC_API_KEY) out.ANTHROPIC_API_KEY = all.ANTHROPIC_API_KEY;
    if (settings.provider === 'openai' && all.OPENAI_API_KEY) out.OPENAI_API_KEY = all.OPENAI_API_KEY;
    if (all.FRED_API_KEY) out.FRED_API_KEY = all.FRED_API_KEY;
    if (all.ALPHA_VANTAGE_API_KEY) out.ALPHA_VANTAGE_API_KEY = all.ALPHA_VANTAGE_API_KEY;
    return out;
  }

  function startEngine(req, { onEvent } = {}) {
    const settings = store.getSettings();
    return runEngine({
      exe: enginePython(),
      args: [engineScript()],
      req,
      env: reqs.engineEnv(settings, secretsFor(settings)),
      onEvent,
      cwd: paths.userData,
    });
  }

  function claim(kind) {
    if (heavy) throw new Error(`Another job is running (${heavy.kind}). Wait for it or cancel it first.`);
    if (!engineReady()) throw new Error('The analysis engine is not installed yet. Open Setup and install it.');
    heavy = { kind, cancel: () => {} };
  }
  const release = () => { heavy = null; setImmediate(() => { pump().catch(() => {}); }); };

  // ---- analysis queue: several analyses lined up, run one after another, all cancellable together.
  const queue = { items: [], seq: 0, working: false };
  const QUEUE_MAX = 100;
  const qSnapshot = () => {
    const waiting = queue.items.filter((i) => i.status === 'queued').map((i) => i.profile);
    const sched = scheduleFor(waiting);
    let w = 0;
    return queue.items.map((i) => {
      const o = {
        id: i.id, ticker: i.ticker, date: i.date, includePortfolio: i.includePortfolio, profile: i.profile, status: i.status,
        rating: i.rating || null, entryId: i.entryId || null, error: i.error || null, seconds: i.seconds || null, startedAt: i.startedAt || null, summary: i.summary || null,
      };
      if (i.status === 'running') o.eta = etaPack(liveEstimate());
      if (i.status === 'queued') { const v = sched[w++]; o.finishIn = v == null ? null : Math.round(v); o.finishAt = Date.now(); }
      return o;
    });
  };
  const qSend = () => { send('queue:update', qSnapshot()); send('queue:total', totalEta(queue.items.filter((i) => i.status === 'queued').map((i) => i.profile))); };

  async function pump() {
    if (queue.working || heavy || !engineReady()) return;
    if (!queue.items.some((i) => i.status === 'queued')) return;
    queue.working = true;
    heavy = { kind: 'queue', cancel: () => {} };
    try {
      const pf = await preflight().catch((e) => e.message);
      if (pf) {
        for (const i of queue.items) if (i.status === 'queued') { i.status = 'failed'; i.error = pf; }
        qSend();
      }
      for (;;) {
        const it = queue.items.find((i) => i.status === 'queued');
        if (!it) break;
        it.status = 'running'; it.startedAt = Date.now(); queue.current = it; qSend();
        let res;
        try { res = await analyzeOne({ ticker: it.ticker, date: it.date, includePortfolio: it.includePortfolio, profile: it.profile, batchId: 'queue', jobId: 'queue', forward: true }); } catch (e) { res = { ok: false, error: e.message }; }
        queue.current = null;
        it.seconds = Math.round((Date.now() - it.startedAt) / 1000);
        if (res.canceled || it.cancelRequested) it.status = 'canceled';
        else if (res.ok) { it.status = 'done'; it.rating = res.rating; it.entryId = res.entryId; it.summary = res.summary; }
        else { it.status = 'failed'; it.error = res.error || 'Unknown error'; }
        qSend();
      }
    } finally {
      queue.working = false; queue.current = null; heavy = null; qSend();
      setImmediate(() => { pump().catch(() => {}); });
    }
  }

  function cancelEverything() {
    if (currentBatch) currentBatch.cancel();
    let n = 0;
    for (const i of queue.items) if (i.status === 'queued') { i.status = 'canceled'; n++; }
    if (queue.current) { queue.current.cancelRequested = true; n++; }
    if (heavy) { heavy.cancel(); heavy.cancelNow = true; }
    if (n) qSend();
    return n;
  }

  // Local Ollama: both models named in Settings must exist, and Ollama must be running.
  async function preflight() {
    const st = store.getSettings();
    if (st.provider !== 'ollama') return null;
    const o = await ollamaStatus(st.ollamaUrl, fetchFn);
    if (!o.running) return `Ollama is not reachable at ${o.url} (${o.error}). Start Ollama, or correct the address in Setup, and run again.`;
    const names = o.models.map((m) => m.name);
    const missing = models.missingModels(st, names);
    return missing.length ? models.message(st, missing, names) : null;
  }

  function validateDate(d) {
    const err = reqs.validDate(d);
    if (err) throw new Error(err);
    return d;
  }

  // ---- time remaining. `live` describes the analysis that is running right now.
  let live = null;
  const etaPack = (est) => (est ? { remaining: Math.round(est.remaining), confidence: est.confidence, n: est.n || 0, at: Date.now() } : null);
  const liveEstimate = () => (live ? eta.estimate({ elapsed: (Date.now() - live.t0) / 1000, timeline: live.timeline, ms: live.ms, history: live.hist }) : null);
  const currentHist = (profile = 'standard') => { const st = store.getSettings(); return store.etaHistory(st.provider, st.quickModel, 10, profiles.clean(profile)); };
  // waiting is the list of profiles of the waiting items, in order.
  function scheduleFor(waiting) {
    if (!waiting.length) return [];
    const est = liveEstimate();
    const cache = {};
    const full = (p) => (p in cache ? cache[p] : (cache[p] = eta.fullEstimate(currentHist(p))));
    return eta.schedule({ runningRemaining: est ? est.remaining : null, hasRunning: !!live, fulls: waiting.map(full) });
  }
  function annotateRows(rows) {
    const waiting = rows.filter((r) => r.status === 'queued').map(() => 'standard');
    const sched = scheduleFor(waiting);
    let w = 0;
    return rows.map((r) => {
      const o = { ...r };
      if (r.status === 'running') o.eta = etaPack(liveEstimate());
      else if (r.status === 'queued') { const v = sched[w++]; o.finishIn = v == null ? null : Math.round(v); o.finishAt = Date.now(); }
      return o;
    });
  }
  function totalEta(waiting) {
    const est = liveEstimate();
    const sched = scheduleFor(waiting);
    const last = sched.length ? sched[sched.length - 1] : (est ? est.remaining : null);
    return last == null ? null : { remaining: Math.round(last), at: Date.now() };
  }

  // One analysis. Shared by the single run, the watchlist batch and the queue.
  async function analyzeOne({ ticker, date, includePortfolio, profile = 'standard', batchId, jobId, forward = true }) {
    profile = profiles.clean(profile);
    const settings = profiles.apply(store.getSettings(), profile);
    const holdings = store.getHoldings();
    const portfolio = reqs.portfolioFor(holdings, settings, includePortfolio);
    const position = holdings.positions.find((p) => p.ticker === ticker) || null;
    const req = reqs.analyzeRequest({ settings, dataDir: dataDir(), ticker, date, portfolio });
    live = { ticker, t0: Date.now(), timeline: {}, ms: eta.milestones(settings.analysts), hist: currentHist(profile) };
    const mine = live;
    const onEvent = (ev) => {
      if (ev.type === 'stage' && mine.timeline[ev.key] == null) mine.timeline[ev.key] = (Date.now() - mine.t0) / 1000;
      if (forward) send('job:event', { jobId, kind: 'analyze', ticker, ev, eta: etaPack(liveEstimate()) });
      if (ev.type === 'start' || ev.type === 'stage') {
        if (jobId === 'batch' && currentBatch) send('batch:update', annotateRows(currentBatch.rows));
        if (jobId === 'queue') qSend();
      }
    };
    const job = startEngine(req, { onEvent });
    heavy.cancel = job.cancel;
    if (heavy.cancelNow) job.cancel();
    const res = await job.promise;
    const timeline = { ...mine.timeline, end: (Date.now() - mine.t0) / 1000 };
    if (live === mine) live = null;
    if (res.canceled) return { ok: false, canceled: true };
    if (!res.ok) return { ok: false, error: res.error, trace: res.trace, stderr: res.stderrTail };
    const entry = store.addRun(res.result, {
      held: !!position,
      position: position ? { quantity: position.quantity, averagePrice: position.averagePrice } : null,
      batchId,
      timeline,
      profile,
    });
    return { ok: true, entry, result: res.result, rating: entry.rating, entryId: entry.id, summary: entry.summary };
  }

  function register(ipcMain) {
    const validateSender = ctx.validateSender || ((event) => trustedSender(event, getWindow(),
      pathToFileURL(path.join(__dirname, '..', 'renderer', 'index.html')).href));
    const h = (name, fn) => ipcMain.handle(name, async (event, arg) => {
      try {
        if (!validateSender(event)) return fail('Untrusted IPC sender.');
        return await fn(arg || {});
      } catch (e) { return fail(e.message || String(e)); }
    });

    h('app:quit', () => { if (ctx.quit) ctx.quit(); return { ok: true }; });

    h('app:info', () => ({
      ok: true, version, dataDir: dataDir(), userData: paths.userData, pinned: PINNED_SHA,
      secureStorage: safeStorage.isEncryptionAvailable(), engineInstalled: engineReady(),
      providers: PROVIDERS, platform: process.platform,
      modelChecked: store.getMeta().modelChecked || null, profiles: profiles.PROFILES,
    }));

    // ---- settings and keys
    h('settings:get', () => ({ ok: true, settings: store.getSettings(), secrets: store.secretStatus() }));
    h('settings:set', (patch) => ({ ok: true, settings: store.setSettings(patch) }));
    h('secrets:set', ({ name, value }) => { store.setSecret(name, value); return { ok: true, secrets: store.secretStatus() }; });

    // ---- hardware and engine
    h('hw:snapshot', async () => ({ ok: true, ...(await snapshot({ ollamaUrl: store.getSettings().ollamaUrl })) }));

    h('components:status', async () => { try { return await components.status(); } catch (e) { return fail(e.message || String(e)); } });
    h('components:install', async ({ id }) => {
      if (typeof id !== 'string' || id.length > 120) return fail('Unknown component.');
      const key = id === 'start:ollama' ? 'ollama-start' : id;
      return components.install(key, (p) => send('component:progress', { ...p, id }));
    });
    h('components:cancel', () => ({ ok: true, canceled: components.cancel() }));

    h('engine:status', async () => {
      if (!engineReady()) return { ok: true, installed: false };
      const job = startEngine({ cmd: 'doctor' });
      const res = await job.promise;
      return { ok: true, installed: true, healthy: !!(res.ok && res.result.ok), info: res.ok ? res.result : null, error: res.ok ? (res.result.error || null) : res.error };
    });

    h('engine:install', async () => {
      if (heavy) return fail(`Another job is running (${heavy.kind}).`);
      heavy = { kind: 'install', cancel: () => {} };
      try {
        const r = await installEngine({
          baseDir: engineDir(), preferred: store.getSettings().pythonPath,
          onLog: (line) => send('setup:log', line.slice(0, 400)),
        });
        return r;
      } finally { release(); }
    });

    h('engine:modelcheck', async () => {
      claim('model check');
      try {
        const pf = await preflight();
        if (pf) return { ok: true, passed: false, checks: [{ name: 'models installed', ok: false, detail: pf }] };
        const settings = store.getSettings();
        const job = startEngine({ cmd: 'modelcheck', settings: reqs.engineSettings(settings, dataDir()) },
          { onEvent: (ev) => send('job:event', { jobId: 'modelcheck', kind: 'modelcheck', ev }) });
        heavy.cancel = job.cancel;
        const res = await job.promise;
        if (res.canceled) return { ok: false, canceled: true };
        if (!res.ok) return { ok: false, error: res.error, stderr: res.stderrTail };
        if (res.result.ok) store.setMeta({ modelChecked: { at: new Date().toISOString(), provider: settings.provider, quick: settings.quickModel, deep: settings.deepModel } });
        return { ok: true, passed: res.result.ok, checks: res.result.checks };
      } finally { release(); }
    });

    h('job:cancel', () => ({ ok: true, queuedCanceled: cancelEverything() }));

    // ---- queue
    h('queue:add', async ({ items, date, includePortfolio = true, profile = 'standard' }) => {
      if (!engineReady()) return fail('The analysis engine is not installed yet. Open Setup and install it.');
      const list = [...new Set((items || []).map(cleanTicker).filter(Boolean))];
      if (!list.length) return fail('Add at least one ticker.');
      validateDate(date);
      const pf = await preflight();
      if (pf) return fail(pf);
      let added = 0;
      for (const t of list) {
        if (queue.items.some((i) => i.ticker === t && i.date === date && (i.status === 'queued' || i.status === 'running'))) continue;
        if (queue.items.filter((i) => i.status === 'queued').length >= QUEUE_MAX) return fail(`The queue is limited to ${QUEUE_MAX} waiting analyses.`);
        queue.items.push({ id: 'q' + (++queue.seq), ticker: t, date, includePortfolio: !!includePortfolio, profile: profiles.clean(profile), status: 'queued' });
        added++;
      }
      qSend();
      setImmediate(() => { pump().catch(() => {}); });
      return { ok: true, added, queue: qSnapshot() };
    });
    h('queue:state', () => ({ ok: true, queue: qSnapshot() }));
    h('queue:cancel', ({ id }) => {
      const it = queue.items.find((i) => i.id === id);
      if (!it) return fail('That item is no longer in the queue.');
      if (it.status === 'queued') it.status = 'canceled';
      else if (it.status === 'running') { it.cancelRequested = true; if (heavy) { heavy.cancel(); heavy.cancelNow = true; } }
      qSend();
      return { ok: true, queue: qSnapshot() };
    });
    h('queue:clear', () => {
      queue.items = queue.items.filter((i) => i.status === 'queued' || i.status === 'running');
      qSend();
      return { ok: true, queue: qSnapshot() };
    });
    h('job:status', () => ({ ok: true, running: heavy ? heavy.kind : null }));

    // ---- holdings
    h('holdings:get', () => ({ ok: true, holdings: store.getHoldings() }));

    h('holdings:pick', async () => {
      const r = await dialog.showOpenDialog(getWindow(), {
        title: 'Choose a holdings file', properties: ['openFile'],
        filters: [{ name: 'Spreadsheets', extensions: ['xlsx', 'csv'] }],
      });
      if (r.canceled || !r.filePaths[0]) return { ok: true, canceled: true };
      const file = r.filePaths[0];
      const parsed = await holdingsLib.readFileRows(file);
      const token = Math.random().toString(36).slice(2);
      importCache.set(token, { file, sheets: parsed.sheets });
      if (importCache.size > 5) importCache.delete(importCache.keys().next().value);
      return {
        ok: true, token, file: path.basename(file),
        sheets: parsed.sheets.map((s, i) => ({ index: i, name: s.name, rows: s.rows.length, preview: holdingsLib.importRows(s.rows) })),
      };
    });

    // Text pasted from a spreadsheet (tab separated) or typed as CSV.
    h('holdings:paste', ({ text }) => {
      const t = String(text || '');
      if (t.trim().length < 3) return fail('Paste your table first, including the header row.');
      if (t.length > 2_000_000) return fail('That is too much text. Paste only the table.');
      const rows = holdingsLib.parseTable(t);
      const token = Math.random().toString(36).slice(2);
      importCache.set(token, { file: 'pasted data', sheets: [{ name: 'Pasted', rows }] });
      if (importCache.size > 5) importCache.delete(importCache.keys().next().value);
      return { ok: true, token, file: 'pasted data', sheets: [{ index: 0, name: 'Pasted', rows: rows.length, preview: holdingsLib.importRows(rows) }] };
    });

    h('holdings:preview', ({ token, sheet = 0, mapping, headerRow }) => {
      const c = importCache.get(token);
      if (!c || !c.sheets[sheet]) return fail('That import expired. Choose the file again.');
      return { ok: true, preview: holdingsLib.importRows(c.sheets[sheet].rows, { mapping, headerRow }) };
    });

    h('holdings:commit', ({ token, sheet = 0, mapping, headerRow, cash, mode = 'replace' }) => {
      const c = importCache.get(token);
      if (!c || !c.sheets[sheet]) return fail('That import expired. Choose the file again.');
      const prev = holdingsLib.importRows(c.sheets[sheet].rows, { mapping, headerRow });
      if (!prev.ok) return fail(prev.error);
      const useCash = cash === '' || cash == null ? prev.cash : Number(cash);
      const cur = store.getHoldings();
      if (mode === 'merge') {
        return { ok: true, holdings: store.setHoldings({
          positions: holdingsLib.mergePositions(cur.positions, prev.positions),
          cash: useCash != null ? useCash : cur.cash, byAccount: { ...(cur.byAccount || {}), ...prev.byAccount },
          source: `${cur.source || 'earlier import'} + ${path.basename(c.file)}`,
        }) };
      }
      return { ok: true, holdings: store.setHoldings({ positions: prev.positions, cash: useCash, byAccount: prev.byAccount, source: path.basename(c.file) }) };
    });

    h('holdings:save', ({ positions, cash }) => ({ ok: true, holdings: store.setHoldings({ ...store.getHoldings(), positions, cash }) }));

    // ---- watchlist upload: a file or pasted table with ticker, price, four buy zones and a reason
    const watchLib = require('./watchlist');
    const watchPreview = (file, rows) => {
      const token = Math.random().toString(36).slice(2);
      importCache.set(token, { file, sheets: [{ name: 'Watchlist', rows }] });
      if (importCache.size > 5) importCache.delete(importCache.keys().next().value);
      const p = watchLib.parseWatchRows(rows);
      return p.ok ? { ok: true, token, file, preview: p } : fail(p.error);
    };
    h('watch:pick', async () => {
      const r = await dialog.showOpenDialog(getWindow(), { title: 'Choose a watchlist file', properties: ['openFile'], filters: [{ name: 'Spreadsheets', extensions: ['xlsx', 'csv'] }] });
      if (r.canceled || !r.filePaths[0]) return { ok: true, canceled: true };
      const parsed = await holdingsLib.readFileRows(r.filePaths[0]);
      const sheet = parsed.sheets.find((s) => watchLib.parseWatchRows(s.rows).ok) || parsed.sheets[0];
      if (!sheet) return fail('The file has no sheets.');
      return watchPreview(path.basename(r.filePaths[0]), sheet.rows);
    });
    h('watch:paste', ({ text }) => {
      const t = String(text || '');
      if (t.trim().length < 3) return fail('Paste your table first, including the header row.');
      if (t.length > 2_000_000) return fail('That is too much text. Paste only the table.');
      return watchPreview('pasted data', holdingsLib.parseTable(t));
    });
    h('watch:commit', ({ token, mode = 'merge', listDate = '' }) => {
      const c = importCache.get(token);
      if (!c) return fail('That import expired. Choose the file again.');
      const p = watchLib.parseWatchRows(c.sheets[0].rows);
      if (!p.ok) return fail(p.error);
      if (listDate && (!watchLib.isIsoDate(listDate) || listDate > reqs.todayLocal())) return fail('The list date must be a past or present date.');
      const clean = watchLib.cleanItems(p.items, listDate);
      return { ok: true, added: clean.items.length, items: store.importWatch(clean.items, { mode: mode === 'replace' ? 'replace' : 'merge', listDate: clean.listDate, source: c.file }) };
    });

    // ---- watchlist
    h('watch:list', () => ({ ok: true, items: store.getWatchlist() }));
    h('watch:add', ({ ticker, note }) => ({ ok: true, items: store.addWatch(ticker, note) }));
    h('watch:remove', ({ ticker }) => ({ ok: true, items: store.removeWatch(ticker) }));

    // ---- analysis
    h('analyze:run', async ({ ticker, date, includePortfolio = true, profile = 'standard' }) => {
      const t = cleanTicker(ticker);
      validateDate(date);
      claim('analysis');
      try {
        const pf = await preflight();
        if (pf) return fail(pf);
        return await analyzeOne({ ticker: t, date, includePortfolio, profile, jobId: 'single' });
      } finally { release(); }
    });

    h('batch:run', async ({ tickers, date, includePortfolio = true }) => {
      const list = [...new Set((tickers || []).map(cleanTicker))];
      if (!list.length) return fail('Add at least one ticker.');
      if (list.length > 40) return fail('A batch is limited to 40 tickers.');
      validateDate(date);
      claim('batch');
      const batchId = 'batch-' + Date.now();
      try {
        const pf = await preflight();
        if (pf) return fail(pf);
        currentBatch = createBatch({
          tickers: list,
          runOne: (ticker) => analyzeOne({ ticker, date, includePortfolio, batchId, jobId: 'batch', forward: true }),
          onUpdate: (rows) => send('batch:update', annotateRows(rows)),
          cancelCurrent: () => heavy && heavy.cancel(),
        });
        const rows = await currentBatch.start();
        return { ok: true, rows: rankResults(rows), canceled: currentBatch.canceled };
      } finally { currentBatch = null; release(); }
    });

    // ---- journal and scoring
    h('journal:list', () => ({ ok: true, entries: store.listJournal(), medianSeconds: store.medianSeconds(store.getSettings().provider) }));
    h('journal:get', ({ id }) => {
      const run = store.getRun(id);
      if (!run) return fail('That run was not found.');
      const holdings = store.getHoldings();
      return { ok: true, ...run, position: run.entry.position || holdings.positions.find((p) => p.ticker === run.entry.ticker) || null };
    });
    h('journal:action', ({ id, action }) => ({ ok: true, entry: store.setAction(id, action) }));
    h('journal:delete', ({ id }) => ({ ok: true, entries: store.deleteEntry(id) }));

    h('journal:score', async () => {
      const entries = store.listJournal();
      if (!entries.length) return { ok: true, rows: [], aggregate: scoring.aggregate([]), adherence: scoring.adherence([], {}) };
      if (!engineReady()) return fail('The engine is needed to fetch prices. Open Setup and install it.');
      const items = entries.map((e) => ({ id: e.id, ticker: e.ticker, date: e.date }));
      const job = startEngine({ cmd: 'prices', items, benchmark: store.getSettings().benchmark });
      const res = await job.promise;
      if (!res.ok) return fail(res.error);
      const pxById = Object.fromEntries(res.result.items.map((i) => [i.id, i]));
      const rows = entries.map((e) => scoring.scoreEntry(e, pxById[e.id]));
      const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
      return { ok: true, rows, aggregate: scoring.aggregate(rows), adherence: scoring.adherence(entries, byId), benchmark: res.result.benchmark };
    });

    h('journal:export', async ({ id }) => {
      const run = store.getRun(id);
      if (!run) return fail('That run was not found.');
      const holdings = store.getHoldings();
      const position = run.entry.position || holdings.positions.find((p) => p.ticker === run.entry.ticker) || null;
      const md = buildBrief({ entry: run.entry, result: run.result, position });
      const r = await dialog.showSaveDialog(getWindow(), {
        title: 'Save decision brief', defaultPath: `${run.entry.ticker}-${run.entry.date}-brief.md`,
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      });
      if (r.canceled || !r.filePath) return { ok: true, canceled: true };
      fs.writeFileSync(r.filePath, md, 'utf8');
      return { ok: true, path: r.filePath };
    });

    h('journal:showReport', ({ id }) => {
      const e = store.listJournal().find((x) => x.id === id);
      if (!e || !e.reportPath) return fail('No saved report for that run.');
      const resolved = path.resolve(e.reportPath);
      if (!resolved.startsWith(path.resolve(dataDir()) + path.sep)) return fail('That path is outside the TradeDesk data folder.');
      shell.showItemInFolder(resolved);
      return { ok: true };
    });


    // ---- market data for the Analyze and Holdings pages. Read only; never takes the heavy lock.
    async function getQuotes({ tickers, years = 5, news = false, force = false }) {
      const list = [...new Set((tickers || []).map(cleanTicker).filter(Boolean))].slice(0, 40);
      if (!list.length) return fail('Give at least one ticker.');
      if (!engineReady()) return fail('The analysis engine is not installed yet, so market data cannot be fetched. Open Setup.');
      const yrs = Math.max(1, Math.min(10, Math.round(Number(years) || 5)));
      const key = (t) => `${t}|${yrs}|${news ? 1 : 0}`;
      const cached = (t) => { const c = quoteCache.get(key(t)); return c && Date.now() - c.at < QUOTE_TTL ? c.item : null; };
      const requested = Date.now();
      // a forced refresh skips the cache, but still shares one fetch between callers that arrive together
      const fresh = (t) => { const c = quoteCache.get(key(t)); return c && (force ? c.at >= requested : Date.now() - c.at < QUOTE_TTL) ? c.item : null; };
      const missing = list.filter((t) => !fresh(t));
      if (missing.length) {
        const run = quoteChain.then(async () => {
          const still = missing.filter((t) => !fresh(t));
          if (!still.length) return;
          const job = startEngine({ cmd: 'quote', tickers: still, years: yrs, news: !!news });
          const res = await job.promise;
          if (!res.ok) throw new Error(res.error || 'Market data request failed.');
          for (const it of res.result.items || []) {
            if (it.ok) quoteCache.set(key(it.ticker), { at: Date.now(), item: it });
            else quoteMiss.set(key(it.ticker), it);
          }
        });
        quoteChain = run.catch(() => {});
        await run;
      }
      const items = list.map((t) => cached(t) || quoteMiss.get(key(t)) || { ticker: t, ok: false, error: 'No data returned.' });
      return { ok: true, items };
    }
    h('quote:get', (args) => getQuotes(args));

    // ---- candles at a chosen interval. Read only, cached for a minute.
    h('bars:get', async ({ tickers, interval = '1d', range = '1y' }) => {
      const list = [...new Set((tickers || []).map(cleanTicker).filter(Boolean))].slice(0, 40);
      if (!list.length) return fail('Give at least one ticker.');
      if (!engineReady()) return fail('The analysis engine is not installed yet, so market data cannot be fetched. Open Setup.');
      if (!/^(1m|5m|15m|1h|1d|1wk)$/.test(interval) || !/^(1d|5d|1mo|3mo|6mo|1y|5y|max)$/.test(range)) return fail('Unsupported interval or range.');
      const key = (t) => `${t}|${interval}|${range}`;
      const fresh = (t) => { const c = barsCache.get(key(t)); return c && Date.now() - c.at < 60 * 1000 ? c.item : null; };
      const missing = list.filter((t) => !fresh(t));
      let failure = null;
      if (missing.length) {
        const run = readChain.then(async () => {
          const job = startEngine({ cmd: 'bars', tickers: missing, interval, range });
          const res = await job.promise;
          if (!res.ok) throw new Error(res.error || 'Market data request failed.');
          for (const it of res.result.items || []) if (it.ok) barsCache.set(key(it.ticker), { at: Date.now(), item: it }); else failure = it;
        });
        readChain = run.catch(() => {});
        await run;
      }
      const items = list.map((t) => fresh(t) || (failure && failure.ticker === t ? failure : { ticker: t, ok: false, error: 'No bars returned for this interval.' }));
      return { ok: true, items };
    });

    // ---- market heat map: percent change for a list of tickers. Read only, cached for five minutes.
    const heatCache = new Map();
    h('heatmap:get', async ({ tickers, force = false } = {}) => {
      const list = [...new Set((tickers || []).map((x) => { try { return cleanTicker(x); } catch { return ''; } }).filter(Boolean))].slice(0, 150);
      if (!list.length) return fail('Give at least one ticker.');
      if (!engineReady()) return fail('The analysis engine is not installed yet, so market data cannot be fetched. Open Setup.');
      const key = list.slice().sort().join(',');
      const c = heatCache.get(key);
      if (!force && c && Date.now() - c.at < 5 * 60 * 1000) return { ok: true, items: c.items, fetchedAt: c.fetchedAt, cached: true };
      const run = readChain.then(async () => {
        const res = await startEngine({ cmd: 'heatmap', tickers: list }).promise;
        if (!res.ok) throw new Error(res.error || 'Market data request failed.');
        return res.result.items || [];
      });
      readChain = run.catch(() => {});
      const items = await run;
      const fetchedAt = new Date().toISOString();
      heatCache.set(key, { at: Date.now(), items, fetchedAt });
      return { ok: true, items, fetchedAt };
    });

    // ---- upcoming events that can move prices, plus the ones the person added by hand
    h('calendar:get', async ({ tickers, days = 90, back = 365, force = false } = {}) => {
      const list = [...new Set((tickers || []).map(cleanTicker).filter(Boolean))].slice(0, 40);
      if (!engineReady()) return fail('The analysis engine is not installed yet, so market events cannot be fetched. Open Setup.');
      const d = Math.max(7, Math.min(365, Math.round(Number(days) || 90)));
      const b = Math.max(1, Math.min(400, Math.round(Number(back) || 365)));
      const key = `${list.slice().sort().join(',')}|${d}|${b}`;
      const c = calCache.get(key);
      if (!force && c && Date.now() - c.at < 30 * 60 * 1000) return { ok: true, ...c.data, cached: true };
      const run = readChain.then(async () => {
        const job = startEngine({ cmd: 'calendar', tickers: list, days: d, back: b });
        const res = await job.promise;
        if (!res.ok) throw new Error(res.error || 'Calendar request failed.');
        return { events: res.result.events || [], notes: res.result.notes || [], start: res.result.start, end: res.result.end, fetchedAt: new Date().toISOString() };
      });
      readChain = run.catch(() => {});
      const data = await run;
      calCache.set(key, { at: Date.now(), data });
      return { ok: true, ...data };
    });

    // How prices moved around one past event. Cached ten minutes: past prices do not change, today's can.
    h('event:move', async ({ symbols, date, time = '', force = false } = {}) => {
      if (!engineReady()) return fail('The analysis engine is not installed yet, so market data cannot be fetched. Open Setup.');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return fail('That is not a valid event date.');
      const t = /^\d{2}:\d{2}$/.test(String(time || '')) ? String(time) : '';
      const list = [...new Set((symbols || []).map((x) => { try { return cleanTicker(x); } catch { return ''; } }).filter(Boolean))].slice(0, 4);
      if (!list.length) return fail('Name at least one symbol.');
      const key = `${list.join(',')}|${date}|${t}`;
      const c = moveCache.get(key);
      if (!force && c && Date.now() - c.at < 10 * 60 * 1000) return { ok: true, ...c.data, cached: true };
      const run = readChain.then(async () => {
        const job = startEngine({ cmd: 'eventmove', symbols: list, date, time: t });
        const res = await job.promise;
        if (!res.ok) throw new Error(res.error || 'Market data request failed.');
        return { date: res.result.date, time: res.result.time, timing: res.result.timing, items: res.result.items || [] };
      });
      readChain = run.catch(() => {});
      const data = await run;
      moveCache.set(key, { at: Date.now(), data });
      return { ok: true, ...data };
    });
    h('events:get', () => ({ ok: true, events: store.getMeta().customEvents || [] }));
    h('events:save', ({ events }) => {
      const clean = (Array.isArray(events) ? events : []).slice(0, 300).map((e) => ({
        id: String(e.id || '').slice(0, 40) || `ev${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        date: /^\d{4}-\d{2}-\d{2}$/.test(e.date || '') ? e.date : null,
        time: /^\d{2}:\d{2}$/.test(e.time || '') ? e.time : '',
        title: String(e.title || '').trim().slice(0, 140),
        ticker: (() => { try { return e.ticker ? cleanTicker(e.ticker) : ''; } catch { return ''; } })(),
        detail: String(e.detail || '').trim().slice(0, 400),
        impact: ['high', 'medium', 'low'].includes(e.impact) ? e.impact : 'medium',
      })).filter((e) => e.date && e.title);
      store.setMeta({ customEvents: clean });
      return { ok: true, events: clean };
    });


    // Write the "reasons" briefing for a run that was made before briefings existed (or re-write it).
    h('brief:make', async ({ id }) => {
      const run = store.getRun(id);
      if (!run) return fail('That run was not found.');
      claim('briefing');
      try {
        const pf = await preflight();
        if (pf) return fail(pf);
        const settings = store.getSettings();
        const job = startEngine({
          cmd: 'brief', ticker: run.entry.ticker, rating: run.entry.rating, sections: (run.result && run.result.sections) || {},
          settings: reqs.engineSettings(settings, dataDir()),
        }, { onEvent: (ev) => send('job:event', { jobId: 'brief', kind: 'brief', ev }) });
        heavy.cancel = job.cancel;
        const res = await job.promise;
        if (res.canceled) return { ok: false, canceled: true };
        if (!res.ok) return { ok: false, error: res.error, stderr: res.stderrTail };
        store.setBrief(id, res.result.brief);
        return { ok: true, brief: res.result.brief };
      } finally { release(); }
    });

    // What this model's own backtests say about each rating. Small samples are reported as such, never hidden.
    h('record:for', () => {
      const st = store.getSettings();
      const runs = store.listBacktests().filter((r) => r.model === st.quickModel);
      const acc = {};
      for (const r of runs) {
        for (const [rating, v] of Object.entries(r.byRating || {})) {
          const a = acc[rating] || (acc[rating] = { n: 0, hits: 0, hitN: 0, alphaSum: 0, alphaN: 0 });
          a.n += v.count || 0;
          if (typeof v.hit_rate === 'number') { a.hits += v.hit_rate * v.count; a.hitN += v.count; }
          if (typeof v.mean_alpha === 'number') { a.alphaSum += v.mean_alpha * v.count; a.alphaN += v.count; }
        }
      }
      const byRating = {};
      for (const [k, a] of Object.entries(acc)) {
        byRating[k] = { n: a.n, hitRate: a.hitN ? a.hits / a.hitN : null, meanAlpha: a.alphaN ? a.alphaSum / a.alphaN : null };
      }
      return { ok: true, model: st.quickModel, backtests: runs.length, byRating };
    });

    // ---- backtest
    h('backtest:list', () => ({ ok: true, runs: store.listBacktests(), medianSeconds: store.medianSeconds(store.getSettings().provider) }));
    h('backtest:run', async ({ tickers, start, end, every = 7 }) => {
      const list = [...new Set((tickers || []).map(cleanTicker))];
      if (!list.length) return fail('Add at least one ticker.');
      if (list.length > 10) return fail('A backtest is limited to 10 tickers.');
      validateDate(start); validateDate(end);
      if (start > end) return fail('The start date must be before the end date.');
      const step = Math.min(60, Math.max(1, Math.round(Number(every) || 7)));
      claim('backtest');
      try {
        const pf = await preflight();
        if (pf) return fail(pf);
        const settings = store.getSettings();
        const holdings = store.getHoldings();
        const job = startEngine({
          cmd: 'backtest', tickers: list, start, end, every: step, analysts: settings.analysts,
          settings: reqs.engineSettings(settings, dataDir()),
          portfolio: null,       // a backtest on past dates must not be shown today's holdings
        }, { onEvent: (ev) => send('job:event', { jobId: 'backtest', kind: 'backtest', ev }) });
        heavy.cancel = job.cancel;
        const res = await job.promise;
        void holdings;
        if (res.canceled) return { ok: false, canceled: true };
        if (!res.ok) return { ok: false, error: res.error, stderr: res.stderrTail };
        const r = res.result;
        store.addBacktest({ runId: r.run_id, tickers: list, start, end, every: step, cellsRun: r.cells_run, failures: r.failures.length, resolved: r.resolved, pending: r.pending, byRating: r.by_rating, text: r.text, model: settings.quickModel });
        return { ok: true, result: r };
      } finally { release(); }
    });

    // ---- research: SEC filings, reported results, House disclosures. Public records only.
    const researchCache = new Map();
    async function research(cmd, req, key, ttl, force) {
      if (!engineReady()) return fail('The analysis engine is not installed yet. Open Setup.');
      const ua = store.getSettings().secUserAgent;
      if (cmd !== 'congress' && !ua) return fail('The SEC asks every program to identify itself. Open Setup, enter your name and email under SEC contact, and try again.');
      const c = researchCache.get(key);
      if (!force && c && Date.now() - c.at < ttl) return { ok: true, ...c.data, cached: true };
      const run = readChain.then(async () => {
        const job = startEngine({ cmd, ...req, secUserAgent: ua });
        const res = await job.promise;
        if (!res.ok) throw new Error(res.error || 'The request failed.');
        const { type, cmd: _c, ...data } = res.result;
        return { ...data, fetchedAt: new Date().toISOString() };
      });
      readChain = run.catch(() => {});
      const data = await run;
      researchCache.set(key, { at: Date.now(), data });
      return { ok: true, ...data };
    }
    const tickerList = (arr, max) => [...new Set((arr || []).map((x) => { try { return cleanTicker(x); } catch { return ''; } }).filter(Boolean))].slice(0, max);
    h('research:filings', ({ tickers, forms, days = 90, force = false } = {}) => {
      const list = tickerList(tickers, 25);
      if (!list.length) return fail('Give at least one ticker.');
      const f = (Array.isArray(forms) ? forms : ['8-K']).filter((x) => ['8-K', '10-Q', '10-K'].includes(x));
      const d = Math.max(1, Math.min(365, Math.round(Number(days) || 90)));
      return research('filings', { tickers: list, forms: f.length ? f : ['8-K'], days: d }, `f|${list.slice().sort()}|${f}|${d}`, 10 * 60 * 1000, force);
    });
    h('research:filing', ({ link, form } = {}) => {
      if (!/^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/\d{1,10}\/\d{18}\/\d{10}-\d{2}-\d{6}-index\.html?$/.test(String(link || ''))) return fail('That is not a filing link on sec.gov.');
      const f = ['8-K', '8-K/A', '10-Q', '10-K'].includes(form) ? form : '';
      return research('filing', { link, form: f }, `d|${link}`, 24 * 60 * 60 * 1000, false);
    });
    h('research:facts', ({ ticker, force = false } = {}) => {
      const t = tickerList([ticker], 1)[0];
      if (!t) return fail('Enter a ticker.');
      return research('facts', { ticker: t }, `x|${t}`, 60 * 60 * 1000, force);
    });
    h('research:congress', ({ members, tickers, days = 60, year, limit = 12, force = false } = {}) => {
      const m = (Array.isArray(members) ? members : []).map((x) => String(x).replace(/[^\p{L} ,.'-]/gu, '').trim().slice(0, 60)).filter(Boolean).slice(0, 10);
      const t = tickerList(tickers, 25);
      const d = Math.max(1, Math.min(365, Math.round(Number(days) || 60)));
      const y = Math.max(2014, Math.min(new Date().getFullYear(), Math.round(Number(year) || new Date().getFullYear())));
      const lim = Math.max(1, Math.min(25, Math.round(Number(limit) || 12)));
      return research('congress', { members: m, tickers: t, days: d, year: y, limit: lim, cacheDir: path.join(paths.userData, 'ptr-cache') },
        `c|${m}|${t}|${d}|${y}|${lim}`, 60 * 60 * 1000, force);
    });

    // ---- price alerts: stored on this computer, checked while the app is open
    const cleanAlert = (a) => {
      let ticker = '';
      try { ticker = a.ticker ? cleanTicker(a.ticker) : ''; } catch { ticker = ''; }
      const price = Number(a.price);
      if (!ticker || !Number.isFinite(price) || price <= 0) return null;
      return {
        id: String(a.id || '').replace(/[^0-9a-z]/gi, '').slice(0, 40) || `al${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        ticker, direction: a.direction === 'below' ? 'below' : 'above', price: Math.round(price * 10000) / 10000,
        note: String(a.note || '').trim().slice(0, 120), active: a.active !== false,
        createdAt: typeof a.createdAt === 'string' ? a.createdAt.slice(0, 30) : new Date().toISOString(),
        firedAt: typeof a.firedAt === 'string' ? a.firedAt.slice(0, 30) : null,
        firedPrice: Number.isFinite(Number(a.firedPrice)) && a.firedPrice !== null ? Number(a.firedPrice) : null,
      };
    };
    const alertList = () => (store.getMeta().alerts || []).map(cleanAlert).filter(Boolean);
    h('alerts:get', () => ({ ok: true, alerts: alertList() }));
    h('alerts:save', ({ alerts } = {}) => {
      const clean = (Array.isArray(alerts) ? alerts : []).slice(0, 100).map(cleanAlert).filter(Boolean);
      store.setMeta({ alerts: clean });
      return { ok: true, alerts: clean };
    });
    // Fetch current prices, mark alerts whose line was crossed, tell the person once.
    h('alerts:check', async () => {
      const all = alertList();
      const live = all.filter((a) => a.active && !a.firedAt);
      if (!live.length) return { ok: true, alerts: all, fired: [] };
      const res = await getQuotes({ tickers: [...new Set(live.map((a) => a.ticker))], years: 1, force: true });
      if (!res.ok) return res;
      const px = {};
      for (const it of res.items) if (it.ok && Number.isFinite(it.price)) px[it.ticker] = it.price;
      const fired = [];
      for (const a of live) {
        const p = px[a.ticker];
        if (p === undefined) continue;
        if ((a.direction === 'above' && p >= a.price) || (a.direction === 'below' && p <= a.price)) {
          a.firedAt = new Date().toISOString(); a.firedPrice = p; fired.push(a);
        }
      }
      const byId = new Map(fired.map((a) => [a.id, a]));
      const next = all.map((a) => byId.get(a.id) || a);
      if (fired.length) {
        store.setMeta({ alerts: next });
        for (const a of fired) if (ctx.notify) ctx.notify({ title: `${a.ticker} crossed ${a.price}`, body: `Last price ${a.firedPrice}. This is your own price alert, not advice.` });
      }
      return { ok: true, alerts: next, fired, checkedAt: new Date().toISOString() };
    });

    h('shell:open', async ({ url }) => {
      let u;
      try { u = new URL(url); } catch { return fail('Invalid link.'); }
      if (u.protocol !== 'https:' || u.username || u.password || u.port || !['github.com', 'ollama.com', 'www.python.org', 'git-scm.com', 'www.sec.gov', 'disclosures-clerk.house.gov'].includes(u.hostname)) return fail('That link is not on the allowed list.');
      await shell.openExternal(u.href);
      return { ok: true };
    });
  }

  return { register, cancelAll() { cancelEverything(); }, _queue: queue };
}

module.exports = { createIpc };
