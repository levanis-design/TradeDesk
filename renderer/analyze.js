'use strict';
// Analyze: a four-pane workspace (new analysis + summary | ticker stats | my tickers + key information) and the Queue tab.
(function () {
  const { h, $, clear, toast, money, pct, qty, duration } = U;

  const ANALYST_KEY = { market: 'market_report', social: 'sentiment_report', news: 'news_report', fundamentals: 'fundamentals_report' };
  const STAGES = [
    ['market_report', 'Market analyst'], ['sentiment_report', 'Sentiment analyst'], ['news_report', 'News analyst'],
    ['fundamentals_report', 'Fundamentals analyst'], ['debate', 'Bull and bear debate'], ['investment_plan', 'Research manager'],
    ['trader_investment_plan', 'Trader'], ['risk', 'Risk team'], ['final_trade_decision', 'Portfolio manager'], ['briefing', 'Briefing'],
  ];
  const ANALYST_KEYS = ['market_report', 'sentiment_report', 'news_report', 'fundamentals_report'];
  const PROFILE_NOTE = {
    fast: 'Market and news analysts, one debate round. Quickest and thinnest.',
    standard: 'The analysts and debate rounds chosen in Setup.',
    thorough: 'All four analysts and two debate rounds. Slowest.',
  };

  let A = fresh();                       // the run in progress or the last one
  let W = { sel: '', tab: 'work', entries: [], latest: {}, detail: {}, mineLoaded: false, seenDone: {} };
  let root = null;
  let body = null;
  let gen = 0;                           // bumps on every page build so stale async work can tell it is stale

  function fresh() { return { phase: 'idle', ticker: '', date: '', seen: {}, feed: [], entry: null, result: null, error: null, started: 0, eta: null }; }
  const mounted = () => root && document.body.contains(root);
  const workMounted = () => mounted() && W.tab === 'work' && $('#ws');

  function visibleStages() {
    const used = new Set(((TD.state.settings && TD.state.settings.analysts) || ['market', 'social', 'news', 'fundamentals']).map((a) => ANALYST_KEY[a]));
    return STAGES.filter(([k]) => !ANALYST_KEYS.includes(k) || used.has(k));
  }
  function stageState(key) {
    const list = visibleStages();
    const idx = STAGES.findIndex(([k]) => k === key);
    const maxSeq = Math.max(-1, ...Object.keys(A.seen).map((k) => STAGES.findIndex(([x]) => x === k)).filter((i) => i >= 4));
    if (A.phase === 'done') return 'done';
    if (ANALYST_KEYS.includes(key)) {
      if (A.seen[key] || maxSeq >= 4) return 'done';
      return A.phase === 'running' ? 'active' : 'pending';
    }
    if (idx < maxSeq) return 'done';
    if (idx === maxSeq) return key === 'debate' || key === 'risk' || key === 'briefing' ? 'active' : 'done';
    const firstPending = list.find(([k]) => !ANALYST_KEYS.includes(k) && STAGES.findIndex(([x]) => x === k) > maxSeq);
    const allAnalystsDone = list.filter(([k]) => ANALYST_KEYS.includes(k)).every(([k]) => A.seen[k] || maxSeq >= 4);
    return firstPending && firstPending[0] === key && allAnalystsDone && A.phase === 'running' ? 'active' : 'pending';
  }

  function onEvent(msg) {
    if (msg.kind !== 'analyze' || msg.jobId !== 'single' || A.phase !== 'running') return;
    const ev = msg.ev;
    if (msg.eta) A.eta = msg.eta;
    if (ev.type === 'stage') A.seen[ev.key] = true;
    if (ev.type === 'activity' || ev.type === 'stage') {
      const text = ev.type === 'stage' ? `${ev.title}: ${ev.text}` : ev.text;
      A.feed.push(text);
      if (A.feed.length > 40) A.feed.shift();
    }
    if (workMounted()) paintSummary();
  }
  TD.onJob(onEvent);

  // ---------------------------------------------------------------- page
  TD.pages.analyze = function (el) {
    root = el; gen++;
    const tabs = TD.tabs([{ id: 'work', label: 'Workspace' }, { id: 'queue', label: 'Queue', badge: true }], W.tab, (id) => { W.tab = id; paintTab(); });
    body = h('div', { id: 'tabbody' });
    el.append(tabs.bar, body);
    TD.paintTabCounts = () => tabs.setBadge('queue', (TD.state.queue || []).filter((i) => i.status === 'queued' || i.status === 'running').length);
    TD.onQueueChange = onQueueChange;
    TD.disposePage = () => { TD.paintTabCounts = null; TD.onQueueChange = null; };
    paintTab();
    TD.paintTabCounts();
  };
  TD.openAnalyze = (ticker) => { if (ticker) W.sel = String(ticker).toUpperCase(); W.tab = 'work'; TD.go('analyze'); };
  TD.showQueueTab = () => { W.tab = 'queue'; TD.go('analyze'); };

  function paintTab() {
    clear(body);
    if (TD.setTabActive) TD.setTabActive();
    if (W.tab === 'queue') { TD.renderQueue(body); return; }
    buildWorkspace(body);
  }

  async function reloadEntries() {
    const j = await td.journal();
    if (j.ok) { W.entries = j.entries; W.median = j.medianSeconds; }
  }
  const latestEntry = (t) => W.entries.find((e) => e.ticker === t) || null;

  function onQueueChange(q) {
    if (!workMounted()) return;
    const newDone = q.filter((i) => i.status === 'done' && i.entryId && !W.seenDone[i.entryId]);
    if (!newDone.length) return;
    newDone.forEach((i) => { W.seenDone[i.entryId] = true; delete W.latest[i.ticker]; });
    reloadEntries().then(() => { if (workMounted()) { paintMine(); loadLatest(W.sel); } });
  }

  // ----------------------------------------------------------- workspace
  function buildWorkspace(c) {
    const myGen = gen;
    const s = TD.state.settings || {};
    const held = TD.state.holdings.positions || [];
    const list = [...new Set([...held.map((p) => p.ticker), ...(TD.state.watch || []).map((w) => w.ticker)])];

    const ticker = h('input', { type: 'text', class: 'ticker', id: 'tkr', placeholder: 'NVDA', list: 'tkrs', autocomplete: 'off', spellcheck: false, value: W.sel || A.ticker || '' });
    const date = h('input', { type: 'date', id: 'dt', value: A.date || U.today(), max: U.today() });
    const profile = h('select', { id: 'profile' }, ['fast', 'standard', 'thorough'].map((p) => h('option', { value: p, selected: p === (W.profile || 'standard') }, p[0].toUpperCase() + p.slice(1))));
    const profNote = h('div', { class: 'hint' }, PROFILE_NOTE[W.profile || 'standard']);
    profile.addEventListener('change', () => { W.profile = profile.value; clear(profNote).append(PROFILE_NOTE[profile.value]); });
    const inc = h('input', { type: 'checkbox', id: 'inc', checked: true });
    const posHint = h('div', { class: 'hint', id: 'posHint' });
    const estHint = h('div', { class: 'hint', id: 'estHint' });
    const runBtn = h('button', { class: 'btn primary', 'data-needs-idle': '', onclick: run }, 'Run analysis');
    const queueBtn = h('button', { class: 'btn', title: 'Line this analysis up behind any that are running', onclick: async () => {
      const t = ticker.value.trim().toUpperCase();
      if (!/^[A-Z0-9][A-Z0-9.\-=^]{0,14}$/.test(t)) return toast('Enter a ticker, for example NVDA.', 'error');
      if (!date.value) return toast('Pick a date.', 'error');
      const nr = TD.notReady(); if (nr) return toast(nr, 'error');
      const r = await td.queueAdd({ items: [t], date: date.value, includePortfolio: inc.checked, profile: profile.value });
      if (!r.ok) return toast(r.error, 'error');
      TD.setQueue(r.queue);
      toast(r.added ? `${t} added to the queue.` : `${t} is already in the queue for that date.`, r.added ? 'ok' : undefined);
    } }, 'Add to queue');

    const form = h('div', { class: 'card compact', id: 'newcard' },
      h('h2', null, 'New analysis'),
      h('div', { class: 'row' },
        h('div', { class: 'field' }, h('label', { for: 'tkr' }, 'Ticker'), ticker, h('datalist', { id: 'tkrs' }, list.map((t) => h('option', { value: t })))),
        h('div', { class: 'field' }, h('label', { for: 'dt' }, 'As of'), date),
        h('div', { class: 'field' }, h('label', { for: 'profile' }, 'Depth'), profile)),
      h('div', { class: 'row center', style: { marginTop: '8px' } }, h('label', { class: 'check', for: 'inc' }, inc, 'Use my holdings'), h('div', { class: 'spacer' }), queueBtn, runBtn),
      h('div', { class: 'formhints' }, profNote, posHint, estHint));

    const ws = h('div', { class: 'ws', id: 'ws' });
    const sumCard = h('div', { class: 'card', id: 'sum' });
    const left = h('div', { class: 'ws-left' });
    const right = h('div', { class: 'ws-right' });
    const bottom = h('div', { class: 'ws-bottom' });
    const statsCard = h('div', { class: 'card', id: 'stats' });
    const mineCard = h('div', { class: 'card', id: 'mine' });
    left.append(form, TD.splitter({ dir: 'row', grid: left, prop: '--wsln', first: () => form, min: 120, minOther: 160, id: 'ws-left-rows', label: 'Resize new analysis and summary' }), sumCard);
    bottom.append(mineCard, TD.splitter({ dir: 'col', grid: bottom, prop: '--wsb', first: () => mineCard, min: 220, minOther: 220, id: 'ws-bottom-cols', label: 'Resize my tickers and key information' }), h('div', { class: 'card', id: 'keyinfo' }));
    right.append(statsCard, TD.splitter({ dir: 'row', grid: right, prop: '--wsrt', first: () => statsCard, min: 200, minOther: 140, id: 'ws-right-rows', label: 'Resize ticker stats and the lists below' }), bottom);
    ws.append(left, TD.splitter({ dir: 'col', grid: ws, prop: '--wsl', first: () => left, min: 300, minOther: 420, id: 'ws-cols', label: 'Resize the left and right sides' }), right);
    c.append(ws);
    if (!(TD.state.info || {}).engineInstalled) form.append(h('div', { class: 'callout warn' }, 'The analysis engine is not installed yet. Open Setup and install it, then check your model.'));

    const pick = () => { const t = ticker.value.trim().toUpperCase(); if (/^[A-Z0-9][A-Z0-9.\-=^]{0,14}$/.test(t) && t !== W.sel) selectTicker(t); updatePos(); };
    ticker.addEventListener('change', pick);
    ticker.addEventListener('keydown', (e) => { if (e.key === 'Enter') { pick(); } });
    function updatePos() {
      const t = ticker.value.trim().toUpperCase();
      const p = TD.positionFor(t);
      clear(posHint);
      if (t) posHint.append(p ? `You hold ${qty(p.quantity)} units${p.averagePrice != null ? ` at an average cost of ${money(p.averagePrice)}` : ''}.` : 'No position recorded for this ticker.');
    }
    ticker.addEventListener('input', updatePos);
    updatePos();

    paintSummary(); paintStats(); paintMine(); paintKey();
    reloadEntries().then(() => {
      if (myGen !== gen || !workMounted()) return;
      clear(estHint).append(W.median ? `Your recent runs on this model took about ${duration(W.median)} each.` : 'No timing yet. A first run on a local model can take several minutes to over an hour.');
      paintMine(); loadLatest(W.sel);
      if (!W.sel) {
        const first = (held[0] && held[0].ticker) || (TD.state.watch[0] && TD.state.watch[0].ticker) || (W.entries[0] && W.entries[0].ticker);
        if (first) selectTicker(first);
      } else selectTicker(W.sel, true);
    });
    loadMine();
    if (A.phase === 'running') TD.setRunning('analysis');
  }

  function selectTicker(t, keep) {
    W.sel = t;
    const inp = $('#tkr'); if (inp && inp.value.trim().toUpperCase() !== t) inp.value = t;
    const pos = $('#posHint');
    if (pos && inp) { const p = TD.positionFor(t); clear(pos).append(p ? `You hold ${qty(p.quantity)} units${p.averagePrice != null ? ` at an average cost of ${money(p.averagePrice)}` : ''}.` : 'No position recorded for this ticker.'); }
    if (!keep) W.detail[t] = W.detail[t] || null;
    paintStats(); paintKey(); paintMine(); paintSummary();
    loadLatest(t);
    if (!(TD.state.info || {}).engineInstalled) return;
    const myGen = gen;
    W.loading = t;
    TD.quote([t], { years: 5, news: true }).then((m) => {
      W.detail[t] = m[t];
      if (myGen === gen && workMounted() && W.sel === t) { paintStats(); paintKey(); paintSummary(); }
    }).catch((e) => {
      W.detail[t] = { ticker: t, ok: false, error: e.message };
      if (myGen === gen && workMounted() && W.sel === t) { paintStats(); paintKey(); }
    });
  }

  async function loadLatest(t) {
    if (!t) return;
    const e = latestEntry(t);
    if (!e) { paintSummary(); return; }
    if (W.latest[t] && W.latest[t].entry.id === e.id) { paintSummary(); return; }
    const r = await td.journalGet({ id: e.id });
    if (r.ok) W.latest[t] = { entry: r.entry, result: r.result, position: r.position };
    if (workMounted() && W.sel === t) paintSummary();
  }

  // --------------------------------------------------------- summary pane
  function paintSummary() {
    const box = $('#sum');
    if (!box) return;
    clear(box);
    if (A.phase === 'running') { paintProgress(box); return; }
    const t = W.sel;
    if (A.phase === 'error' && A.ticker === t) { paintProgress(box); return; }
    if (A.phase === 'canceled' && A.ticker === t) { paintProgress(box); return; }
    const data = (A.phase === 'done' && A.ticker === t) ? { entry: A.entry, result: A.result, position: A.entry.position || TD.positionFor(t) } : W.latest[t];
    box.append(h('h2', null, t ? `Summary · ${t}` : 'Summary'));
    if (!t) { box.append(h('div', { class: 'empty-note' }, 'Pick a ticker to see its latest analysis, or run a new one.')); return; }
    if (!data) { box.append(h('div', { class: 'empty-note' }, latestEntry(t) ? 'Loading the saved analysis…' : `No analysis of ${t} yet. Run one on the left.`)); return; }
    const rec = h('div');
    TD.recordLine(data.entry.rating).then((el) => { if (el) rec.append(el); }).catch(() => {});
    box.append(TD.renderBriefing({ entry: data.entry, result: data.result, position: data.position }, { record: rec, onUpdate: paintSummary }));
    box.append(h('div', { class: 'row center sumtools' },
      h('button', { class: 'btn', onclick: () => TD.viewEntry(data.entry.id) }, 'Open full report'),
      h('span', { class: 'hint' }, 'Debate, risk team, analyst reports and news')));
    box.append(h('details', { class: 'recdetails' }, h('summary', null, 'Record what you decided'), TD.actionForm(data.entry)));
  }

  function paintProgress(box) {
    box.append(h('h2', null, `${A.ticker} · ${A.date}`));
    if (A.phase === 'running') {
      box.append(h('div', { class: 'hint' }, 'Working. Local models are slow: expect minutes per stage. You can leave this page; the run continues.'));
      box.append(h('div', { class: 'row center', style: { margin: '6px 0 8px' } }, h('b', null, 'Time left: '), TD.etaSpan(A.eta)));
      box.append(h('div', { class: 'steps' }, visibleStages().map(([k, label]) => h('div', { class: `step ${stageState(k)}` }, h('span', { class: 'bullet' }), label))));
      box.append(h('div', { class: 'feed', 'aria-live': 'off' }, A.feed.slice(-6).map((l) => h('div', null, l.slice(0, 200))), A.feed.length ? null : h('div', null, 'Starting the agents…')));
    } else if (A.phase === 'canceled') {
      box.append(h('div', { class: 'callout warn' }, 'Cancelled. Nothing was saved.'));
    } else if (A.phase === 'error') {
      box.append(h('div', { class: 'callout bad' }, h('b', null, 'The run failed. '), A.error));
      if (/tool|structured|function/i.test(A.error || '')) box.append(h('div', { class: 'hint' }, 'This often means the model cannot call tools or return structured output. Use Setup, then Check this model.'));
      if (A.stderr) box.append(h('details', null, h('summary', null, 'Technical detail'), h('pre', { class: 'consolebox' }, A.stderr)));
    }
  }

  async function run() {
    const ticker = $('#tkr').value.trim().toUpperCase();
    const date = $('#dt').value;
    if (!/^[A-Z0-9][A-Z0-9.\-=^]{0,14}$/.test(ticker)) return toast('Enter a ticker, for example NVDA.', 'error');
    if (!date) return toast('Pick a date.', 'error');
    const nr = TD.notReady();
    if (nr) return toast(nr, 'error');
    const profile = $('#profile').value;
    if (ticker !== W.sel) selectTicker(ticker);
    A = fresh();
    Object.assign(A, { phase: 'running', ticker, date, started: Date.now() });
    TD.setRunning('analysis');
    paintSummary();
    const r = await td.analyze({ ticker, date, includePortfolio: $('#inc').checked, profile });
    TD.setRunning(null);
    if (r.canceled) A.phase = 'canceled';
    else if (!r.ok) { A.phase = 'error'; A.error = r.error; A.stderr = r.stderr; }
    else { A.phase = 'done'; A.entry = r.entry; A.result = r.result; delete W.latest[ticker]; }
    if (A.phase === 'done') { await reloadEntries(); toast(`${ticker}: ${A.entry.rating}`, 'ok'); }
    if (workMounted()) { paintSummary(); paintMine(); paintKey(); }
  }

  // ------------------------------------------------------ ticker stats pane
  const big = (n) => (n == null ? '—' : Math.abs(n) >= 1e12 ? (n / 1e12).toFixed(2) + ' T' : Math.abs(n) >= 1e9 ? (n / 1e9).toFixed(1) + ' B' : Math.abs(n) >= 1e6 ? (n / 1e6).toFixed(1) + ' M' : money(n, 0));
  const dash = (n, f) => (n == null ? '—' : f(n));
  const stat = (k, v, title) => h('div', { class: 'kv', title }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v));

  function paintStats() {
    const box = $('#stats');
    if (!box) return;
    clear(box);
    const t = W.sel;
    if (!t) { box.append(h('h2', null, 'Ticker'), h('div', { class: 'empty-note' }, 'Pick a ticker from the list below, or type one on the left, to see its price, range and chart.')); return; }
    const q = W.detail[t];
    if (!(TD.state.info || {}).engineInstalled) { box.append(h('h2', null, t), h('div', { class: 'callout warn' }, 'Prices come through the analysis engine. Install it in Setup to see charts and statistics.')); return; }
    if (!q) { box.append(h('h2', null, t), h('div', { class: 'hint' }, 'Loading price data…')); return; }
    if (!q.ok) { box.append(h('h2', null, t), h('div', { class: 'callout bad' }, q.error || 'No data came back.'), h('div', { class: 'hint' }, 'Yahoo Finance may be unreachable or not know this symbol. Crypto needs the quote currency, for example XRP-USD.')); return; }
    const up = (q.changePct || 0) >= 0;
    const cur = q.currency ? ' ' + q.currency : '';
    const pos = TD.positionFor(t);
    box.append(h('div', { class: 'stats-head' },
      h('div', null, h('h2', null, t, q.name ? h('span', { class: 'co' }, ' · ' + q.name) : null), h('div', { class: 'hint' }, [q.exchange, q.sector, q.industry].filter(Boolean).join(' · ') || ' ')),
      h('div', { class: 'spacer' }),
      h('div', { class: 'pricebox' }, h('div', { class: 'px' }, money(q.price), h('span', { class: 'cur' }, cur)),
        h('div', { class: up ? 'pos' : 'neg' }, q.change == null ? '—' : `${up ? '+' : '−'}${money(Math.abs(q.change))} (${pct(q.changePct)}) today`),
        h('div', { class: 'hint' }, `close of ${q.asOf}`))));
    box.append(h('div', { class: 'kvgrid' },
      stat('Day range', q.dayLow != null ? `${money(q.dayLow, q.price >= 1000 ? 0 : 2)} – ${money(q.dayHigh, q.price >= 1000 ? 0 : 2)}` : '—'),
      stat('52-week low', money(q.yearLow)), stat('52-week high', money(q.yearHigh)),
      stat('Volume', q.volume != null ? big(q.volume) : '—', q.avgVolume ? `Average over 3 months: ${big(q.avgVolume)}` : undefined),
      stat('Market cap', big(q.marketCap)), stat('P/E', dash(q.pe, (n) => n.toFixed(1))), stat('Forward P/E', dash(q.forwardPe, (n) => n.toFixed(1))),
      stat('Beta', dash(q.beta, (n) => n.toFixed(2)), 'How strongly the stock has moved with the market. Above 1 means more.'),
      stat('Dividend yield', q.dividendYield == null ? '—' : q.dividendYield === 0 ? 'none' : (q.dividendYield * 100).toFixed(2) + '%', 'Payments in the last 12 months divided by the price.'),
      stat('Analyst target', q.targetMean != null ? `${money(q.targetMean)} (${pct(q.targetMean / q.price - 1, 0)})` : '—', 'Average target of analysts covering the stock, from Yahoo Finance. Not a TradeDesk figure.'),
      stat('Next earnings', q.nextEarnings || '—')));
    box.append(h('div', { class: 'rangewrap' }, h('div', { class: 'k' }, 'Where the price sits in its 52-week range'), TDCharts.rangeBar(q.yearLow, q.yearHigh, q.price, (n) => money(n))));
    box.append(TDCharts.line({
      points: q.history || [], ranges: ['1M', '3M', '6M', '1Y', '5Y'], range: W.range || '1Y', height: 180, fmt: (v) => money(v),
      cost: pos && pos.averagePrice != null ? pos.averagePrice : null, costLabel: 'your average cost', name: `${t} closing price`,
      onRange: (r) => { W.range = r; },
    }));
    box.append(h('div', { class: 'hint' }, 'Daily closes from Yahoo Finance. Data to be confirmed for splits and dividends: closes are not adjusted.'));
  }

  // ------------------------------------------------------------ my tickers
  function mineList() {
    const held = (TD.state.holdings.positions || []).map((p) => p.ticker);
    const watch = (TD.state.watch || []).map((w) => w.ticker);
    const recent = W.entries.slice(0, 12).map((e) => e.ticker);
    return [...new Set([...held, ...watch, ...recent])].slice(0, 30);
  }
  async function loadMine() {
    if (!(TD.state.info || {}).engineInstalled) return;
    const myGen = gen;
    const list = mineList();
    if (!list.length) { paintMine(); return; }
    try {
      const m = await TD.quote(list, { years: 1 });
      W.mineErr = null; W.mineLoaded = true;
      void m;
    } catch (e) { W.mineErr = e.message; }
    if (myGen === gen && workMounted()) paintMine();
  }

  function paintMine() {
    const box = $('#mine');
    if (!box) return;
    clear(box);
    const list = mineList();
    box.append(h('div', { class: 'row center' }, h('h2', null, 'My tickers'), h('div', { class: 'spacer' }),
      h('button', { class: 'btn small', title: 'Fetch prices again', onclick: () => { loadMine(); } }, 'Refresh')));
    if (!list.length) { box.append(h('div', { class: 'empty-note' }, 'Your holdings, watchlist and recent analyses appear here. Import holdings or add to the watchlist to fill it.')); return; }
    if (W.mineErr) box.append(h('div', { class: 'hint bad' }, W.mineErr));
    const rows = h('div', { class: 'minelist' });
    list.forEach((t) => {
      const q = TD.cachedQuote(t, 1) || TD.cachedQuote(t, 5);
      const e = latestEntry(t);
      const held = !!TD.positionFor(t);
      const up = q && q.ok && (q.changePct || 0) >= 0;
      rows.append(h('button', { class: 'mine-row' + (t === W.sel ? ' sel' : ''), type: 'button', dataset: { ticker: t }, onclick: () => selectTicker(t) },
        h('span', { class: 'mt' }, h('b', null, t), held ? h('span', { class: 'held-dot', title: 'In your holdings' }, '●') : null),
        q && q.ok ? TDCharts.spark((q.history || []).slice(-126).map((r) => r[1])) : h('span', { class: 'spark' }),
        h('span', { class: 'mp' }, q && q.ok ? h('span', null, money(q.price), h('span', { class: up ? 'pos' : 'neg' }, ' ' + pct(q.changePct))) : h('span', { class: 'hint' }, q && !q.ok ? 'no data' : '…')),
        e ? U.ratingBadge(e.rating) : h('span', { class: 'hint' }, 'no analysis')));
    });
    box.append(rows);
  }

  // ------------------------------------------------------- key information
  function paintKey() {
    const box = $('#keyinfo');
    if (!box) return;
    clear(box);
    const t = W.sel;
    box.append(h('h2', null, t ? `Key information · ${t}` : 'Key information'));
    if (!t) { box.append(h('div', { class: 'empty-note' }, 'Your position and the latest headlines appear here.')); return; }
    const pos = TD.positionFor(t);
    const q = W.detail[t];
    const price = q && q.ok ? q.price : (pos && pos.lastPrice) || null;
    if (pos) {
      const t0 = window.Portfolio.totals([pos], price != null ? { [t]: price } : {});
      const r = t0.rows[0];
      const w = window.Portfolio.weightOf(t, TD.state.holdings.positions, TD.state.holdings.cash, TD.priceMap());
      box.append(h('div', { class: 'kvgrid two' },
        stat('You hold', `${qty(pos.quantity)} units`), stat('Average cost', pos.averagePrice != null ? money(pos.averagePrice) : '—'),
        stat('Value now', r.value != null ? money(r.value) : '—'),
        stat('Profit or loss', r.pl != null ? h('span', { class: r.pl >= 0 ? 'pos' : 'neg' }, `${r.pl >= 0 ? '+' : '−'}${money(Math.abs(r.pl))} (${pct(r.plPct)})`) : '—'),
        stat('Share of portfolio', w != null ? `${(w * 100).toFixed(1)}%` : '—'), stat('Bought', pos.boughtAt || '—')));
    } else box.append(h('div', { class: 'hint' }, `${t} is not in your holdings.`));
    const wl = (TD.state.watch || []).find((x) => x.ticker === t);
    if (wl && wl.note) box.append(h('div', { class: 'callout small' }, 'Your note: ' + wl.note));
    box.append(h('h4', { class: 'sec' }, 'Headlines'));
    if (!q) box.append(h('div', { class: 'hint' }, 'Loading…'));
    else if (!q.ok) box.append(h('div', { class: 'hint' }, 'Unavailable.'));
    else box.append(TD.headlineList((q.news || []).slice(0, 6)));
    box.append(h('div', { class: 'hint' }, 'Headlines show what Yahoo Finance lists today. The News tab of a full report reads them against the analysis date.'));
  }
})();
