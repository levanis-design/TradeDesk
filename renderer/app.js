'use strict';
// Shell: navigation, shared state, status chips, modal. Pages register on TD.pages.
(function () {
  const { h, $, clear, toast } = U;

  // Daily work on top; configuration and help in the footer group.
  const PAGES = [
    { id: 'analyze', title: 'Analyze', ico: 'analyze' },
    { id: 'watch', title: 'Watchlist', ico: 'watch' },
    { id: 'holdings', title: 'Holdings', ico: 'holdings' },
    { id: 'calendar', title: 'Calendar', ico: 'calendar' },
    { id: 'track', title: 'Track record', ico: 'track' },
    { id: 'setup', title: 'Setup', ico: 'setup', foot: true },
    { id: 'how', title: 'How it works', ico: 'how', foot: true },
  ];

  // Line icons, 24 by 24, drawn with strokes so they follow the text colour in both themes.
  const ICONS = {
    analyze: ['M4 19V5', 'M4 19h16', 'M8 15l3-4 3 2 5-7'],
    watch: ['M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z', 'M12 14.6a2.6 2.6 0 100-5.2 2.6 2.6 0 000 5.2z'],
    holdings: ['M3 7.5h18v11.5H3z', 'M8.5 7.5V5.2A1.2 1.2 0 019.7 4h4.6a1.2 1.2 0 011.2 1.2v2.3', 'M3 12.5h18'],
    calendar: ['M4 6h16v14H4z', 'M4 10.5h16', 'M8.5 3.5v4', 'M15.5 3.5v4'],
    track: ['M4 12a8 8 0 102.4-5.7', 'M4 4.5v3.8h3.8', 'M12 8v4.2l2.8 1.8'],
    setup: ['M12 15.2a3.2 3.2 0 100-6.4 3.2 3.2 0 000 6.4z', 'M19.2 13.5l1.6 1.2-1.7 2.9-1.9-.6a7 7 0 01-1.6.9l-.4 2h-3.4l-.4-2a7 7 0 01-1.6-.9l-1.9.6-1.7-2.9 1.6-1.2a7 7 0 010-1.9L4.6 10.4l1.7-2.9 1.9.6a7 7 0 011.6-.9l.4-2h3.4l.4 2a7 7 0 011.6.9l1.9-.6 1.7 2.9-1.6 1.2a7 7 0 010 1.9z'],
    how: ['M12 21a9 9 0 100-18 9 9 0 000 18z', 'M9.6 9.4a2.5 2.5 0 114 2c-.9.6-1.6 1-1.6 2.1', 'M12 16.8v.2'],
    chevL: ['M14.5 6l-6 6 6 6'],
    chevR: ['M9.5 6l6 6-6 6'],
  };
  const NSV = 'http://www.w3.org/2000/svg';
  function icon(name) {
    const svg = document.createElementNS(NSV, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '20'); svg.setAttribute('height', '20');
    svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.8');
    svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round'); svg.setAttribute('aria-hidden', 'true');
    (ICONS[name] || []).forEach((d) => { const p = document.createElementNS(NSV, 'path'); p.setAttribute('d', d); svg.appendChild(p); });
    return svg;
  }

  const TD = (window.TD = {
    state: { settings: null, secrets: {}, info: null, engine: { installed: false }, holdings: { positions: [], cash: null }, watch: [], queue: [], running: null, page: null, quotes: {} },
    pages: {},
    onShow: {},
  });

  // ---- results from main come as {ok:false,error}; this turns them into thrown errors
  TD.call = async function (fn, arg) {
    const r = await fn(arg);
    if (r && r.ok === false && !r.canceled) {
      const e = new Error(r.error || 'Something went wrong.');
      e.detail = r;
      throw e;
    }
    return r;
  };
  TD.guard = async function (fn, onError) {
    try { return await fn(); } catch (e) {
      toast(e.message, 'error');
      if (onError) onError(e);
      return null;
    }
  };

  // ---- navigation
  TD.go = function (id) {
    const page = PAGES.find((p) => p.id === id) || PAGES[0];
    TD.state.page = page.id;
    if (TD.disposePage) { try { TD.disposePage(); } catch (e) { console.error(e); } TD.disposePage = null; }
    $('#pageTitle').textContent = page.title;
    U.$$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.page === page.id));
    const view = clear($('#view'));
    view.dataset.page = page.id;
    TD.pages[page.id](view);
    view.scrollTop = 0;
    if (TD.paintBusy) TD.paintBusy();
  };
  TD.isVisible = (id) => TD.state.page === id && document.body.contains($('#view'));

  const navStore = {
    get() { try { return window.localStorage.getItem('tradedesk.nav') === 'collapsed'; } catch { return false; } },
    set(v) { try { window.localStorage.setItem('tradedesk.nav', v ? 'collapsed' : 'open'); } catch { /* not remembered */ } },
  };
  TD.setNavCollapsed = function (collapsed, remember = true) {
    const app = $('.app');
    app.classList.toggle('collapsed', !!collapsed);
    const t = $('#navToggle');
    if (t) {
      clear(t).append(icon(collapsed ? 'chevR' : 'chevL'));
      t.setAttribute('aria-expanded', String(!collapsed));
      const label = collapsed ? 'Expand the menu' : 'Collapse the menu';
      t.setAttribute('aria-label', label); t.title = `${label} (Ctrl+B)`;
    }
    if (remember) navStore.set(!!collapsed);
  };

  function buildNav() {
    const nav = clear($('#nav'));
    const foot = clear($('#navFoot'));
    PAGES.forEach((p, i) => (p.foot ? foot : nav).appendChild(h('button', { class: 'nav-btn', type: 'button', dataset: { page: p.id }, title: `${p.title} (Alt+${i + 1})`, 'aria-label': p.title, onclick: () => TD.go(p.id) },
      h('span', { class: 'ico', 'aria-hidden': 'true' }, icon(p.ico)), h('span', { class: 'txt' }, p.title),
      p.id === 'setup' ? h('span', { class: 'nav-badge', id: 'setupBadge', hidden: true, title: 'Setup is not finished' }, '!') : null,
      p.id === 'analyze' ? h('span', { class: 'nav-count', id: 'qCount', hidden: true, title: 'Analyses running or waiting' }) : null)));
    const t = $('#navToggle');
    if (t && !t.dataset.bound) { t.dataset.bound = '1'; t.addEventListener('click', () => TD.setNavCollapsed(!$('.app').classList.contains('collapsed'))); }
    TD.setNavCollapsed(navStore.get(), false);
  }
  // Quick keys: Ctrl+B folds the menu, Alt+1 to Alt+7 jump to a section.
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && !e.altKey && !e.shiftKey && (e.key === 'b' || e.key === 'B')) { e.preventDefault(); TD.setNavCollapsed(!$('.app').classList.contains('collapsed')); return; }
    if (e.altKey && !e.ctrlKey && !e.metaKey && /^[1-9]$/.test(e.key) && !(TD.modalLocked || !$('#modal').hidden)) {
      const p = PAGES[Number(e.key) - 1];
      if (p) { e.preventDefault(); TD.go(p.id); }
    }
  });

  // Setup is "done" once the engine is installed and the model check has passed on this computer.
  TD.setupDone = () => {
    const info = TD.state.info || {};
    return !!(info.engineInstalled && info.modelChecked);
  };

  // ---- status
  TD.refreshStatus = async function () {
    const [info, st] = await Promise.all([td.info(), td.getSettings()]);
    TD.state.info = info;
    if (st.ok) { TD.state.settings = st.settings; TD.state.secrets = st.secrets; }
    const hl = await td.getHoldings();
    if (hl.ok) TD.state.holdings = hl.holdings;
    const wl = await td.watchList();
    if (wl.ok) TD.state.watch = wl.items;
    const qs = await td.queueState();
    if (qs.ok) TD.setQueue(qs.queue);
    TD.paintChips();
    const es = await td.engineStatus();
    TD.state.engine = es.ok ? es : { installed: false, error: es.error };
    TD.paintChips();
  };

  TD.paintChips = function () {
    const e = TD.state.engine;
    const info = TD.state.info || {};
    const chip = clear($('#engineChip'));
    let kind = 'bad';
    let text = 'Engine not installed';
    if (info.engineInstalled || e.installed) {
      if (e.healthy) { kind = 'ok'; text = `Engine ready${e.info && e.info.tradingagents ? ' · v' + e.info.tradingagents : ''}`; }
      else if (e.healthy === false) { kind = 'bad'; text = 'Engine needs repair'; }
      else { kind = 'warn'; text = 'Checking engine…'; }
    }
    chip.className = `chip ${kind}`;
    chip.append(h('span', { class: 'dot' }), text);
    const badge = $('#setupBadge');
    if (badge) badge.hidden = TD.setupDone();
    const s = TD.state.settings;
    const model = clear($('#modelChip'));
    if (s) model.append(`${s.provider === 'ollama' ? 'Local' : s.provider} · ${s.quickModel}`);
  };

  const activeQueue = () => (TD.state.queue || []).filter((i) => i.status === 'queued' || i.status === 'running');
  TD.setRunning = function (kind) { TD.state.running = kind; TD.paintBusy(); };
  TD.paintBusy = function () {
    const act = activeQueue();
    const busy = !!TD.state.running || act.length > 0;
    const chip = clear($('#jobChip'));
    $('#cancelBtn').hidden = !busy;
    chip.hidden = !busy;
    if (busy) {
      const parts = [];
      if (TD.state.running) parts.push(`Running: ${TD.state.running}`);
      if (act.length) parts.push(`Queue: ${act.length} left`);
      chip.className = 'chip job'; chip.append(h('span', { class: 'dot' }), parts.join(' · '));
    }
    U.$$('[data-needs-idle]').forEach((b) => { b.disabled = busy; });
    const qc = $('#qCount');
    if (qc) { qc.hidden = !act.length; qc.textContent = String(act.length); }
  };
  TD.setQueue = function (q) {
    TD.state.queue = q || [];
    TD.paintBusy();
    if (TD.paintQueue) TD.paintQueue();
    if (TD.paintTabCounts) TD.paintTabCounts();
    if (TD.onQueueChange) TD.onQueueChange(TD.state.queue);
  };

  // ---- time remaining: elements carry the estimate and the moment it was made; one timer keeps them live.
  function etaText(el) {
    const d = el.dataset;
    const age = (Date.now() - Number(d.at)) / 1000;
    const rem = Number(d.rem) - age;
    const mins = (x) => (x < 90 ? `${Math.max(1, Math.round(x / 60))} min` : U.duration(x));
    if (d.mode === 'plain') return rem < 45 ? 'under 1 min' : `about ${mins(rem)}`;
    if (d.mode === 'finish') return rem < 45 ? 'done in under 1 min' : `done in about ${mins(rem)}`;
    if (rem <= 0) return 'taking longer than usual';
    if (rem < 45) return 'under 1 min left';
    return `${d.conf === 'rough' ? 'roughly' : 'about'} ${mins(rem)} left`;
  }
  const etaTitle = (conf, n) => (conf === 'rough'
    ? 'A rough guess. It gets better after a few finished runs on this model.'
    : `Based on ${n} earlier run${n === 1 ? '' : 's'} on this model, stage by stage.`);
  TD.etaSpan = function (e) {
    if (!e || e.remaining == null) return h('span', { class: 'hint' }, 'estimating…');
    const el = h('span', { class: 'eta', title: etaTitle(e.confidence, e.n), dataset: { mode: 'left', rem: String(e.remaining), at: String(e.at), conf: e.confidence || 'rough' } });
    el.textContent = etaText(el);
    return el;
  };
  TD.plainEta = function (rem, at) {
    const el = h('span', { class: 'eta', dataset: { mode: 'plain', rem: String(rem), at: String(at), conf: 'history' } });
    el.textContent = etaText(el);
    return el;
  };
  TD.finishSpan = function (finishIn, finishAt) {
    if (finishIn == null) return h('span', { class: 'hint', title: 'Appears after your first finished run on this model.' }, '—');
    const el = h('span', { class: 'eta', title: 'Waits for the ones ahead of it, at your recent pace on this model.', dataset: { mode: 'finish', rem: String(finishIn), at: String(finishAt), conf: 'history' } });
    el.textContent = etaText(el);
    return el;
  };
  setInterval(() => { U.$$('.eta').forEach((el) => { if (document.body.contains(el)) el.textContent = etaText(el); }); }, 1000);

  // ---- modal
  TD.modal = function (...kids) {
    const m = clear($('#modal'));
    m.hidden = false;
    m.appendChild(h('div', { class: 'modal-box', role: 'dialog', 'aria-modal': 'true' }, kids));
    const first = m.querySelector('button, input, select');
    if (first) first.focus();
  };
  TD.closeModal = () => { const m = $('#modal'); m.hidden = true; m.classList.remove('locked'); clear(m); TD.modalLocked = false; };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#modal').hidden && !TD.modalLocked) TD.closeModal(); });

  // ---- job events fan out to whoever is listening
  const jobListeners = new Set();
  TD.onJob = (fn) => { jobListeners.add(fn); return () => jobListeners.delete(fn); };
  TD.initEvents = function () {
    td.onJob((msg) => jobListeners.forEach((fn) => { try { fn(msg); } catch (e) { console.error(e); } }));
    td.onQueue((q) => TD.setQueue(q));
    td.onQueueTotal((t) => { TD.state.queueTotal = t; if (TD.paintQueue) TD.paintQueue(); });
    $('#cancelBtn').addEventListener('click', async () => { await td.cancel(); toast('Cancelling everything…'); });
  };

  // ---- page-level tabs. Returns {bar, setBadge}. The caller owns the content area.
  TD.tabs = function (items, active, onChange) {
    const bar = h('div', { class: 'pagetabs', role: 'tablist' });
    const paint = (id) => U.$$('.ptab', bar).forEach((b) => { b.classList.toggle('active', b.dataset.tab === id); b.setAttribute('aria-selected', String(b.dataset.tab === id)); });
    items.forEach((t) => bar.append(h('button', { class: 'ptab', role: 'tab', type: 'button', dataset: { tab: t.id }, onclick: () => { paint(t.id); onChange(t.id); } },
      t.label, t.badge ? h('span', { class: 'tab-count', dataset: { for: t.id }, hidden: true }) : null)));
    paint(active);
    return { bar, paint, setBadge: (id, n) => { const b = bar.querySelector(`.tab-count[data-for="${id}"]`); if (b) { b.hidden = !n; b.textContent = String(n || ''); } } };
  };

  // ---- market data (read only, from the engine). Cached here for the session and in main for five minutes.
  TD.quote = async function (tickers, { years = 5, news = false, force = false } = {}) {
    const list = [...new Set(tickers.map((t) => String(t).toUpperCase()))];
    if (force) TD.state.bars = {};
    const r = await td.quote({ tickers: list, years, news, force });
    if (!r.ok) throw new Error(r.error);
    for (const it of r.items) {
      const key = `${it.ticker}|${years}`;
      TD.state.quotes[key] = { at: Date.now(), item: it };
    }
    return Object.fromEntries(r.items.map((it) => [it.ticker, it]));
  };
  // Bars at an interval (candles). Cached for a minute here and in main.
  TD.bars = async function (tickers, interval, rangeLabel) {
    const list = [...new Set(tickers.map((t) => String(t).toUpperCase()))];
    const r = await td.bars({ tickers: list, interval, range: window.Portfolio.PERIODS[rangeLabel] });
    if (!r.ok) throw new Error(r.error);
    TD.state.bars = TD.state.bars || {};
    for (const it of r.items) TD.state.bars[`${it.ticker}|${interval}|${rangeLabel}`] = { at: Date.now(), item: it };
    return r.items;
  };
  TD.cachedBars = (ticker, interval, rangeLabel) => { const c = (TD.state.bars || {})[`${ticker}|${interval}|${rangeLabel}`]; return c && Date.now() - c.at < 60000 ? c.item : null; };
  TD.cachedQuote = (ticker, years = 5) => { const c = TD.state.quotes[`${ticker}|${years}`]; return c ? c.item : null; };
  // Latest known price for a ticker: a fresh quote, else the price stored with the holding.
  TD.priceMap = () => {
    const out = {};
    for (const p of TD.state.holdings.positions || []) {
      const q = TD.cachedQuote(p.ticker, 1) || TD.cachedQuote(p.ticker, 5);
      if (q && q.ok && q.price != null) out[p.ticker] = q.price;
      if (Number(p.manualPrice) > 0) out[p.ticker] = Number(p.manualPrice);
    }
    return out;
  };

  TD.buildNav = buildNav;
  TD.PAGES = PAGES;

  // small shared bits
  TD.settingsLine = function () {
    const s = TD.state.settings;
    if (!s) return '';
    return `${s.provider} · ${s.quickModel}${s.deepModel !== s.quickModel ? ' / ' + s.deepModel : ''} · ${s.debateRounds} debate round${s.debateRounds > 1 ? 's' : ''}`;
  };
  TD.positionFor = (ticker) => (TD.state.holdings.positions || []).find((p) => p.ticker === ticker) || null;
  TD.notReady = function () {
    const info = TD.state.info || {};
    return info.engineInstalled ? null : 'The analysis engine is not installed. Open Setup and install it first.';
  };
})();
