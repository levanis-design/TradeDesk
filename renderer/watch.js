'use strict';
// Watchlist: the list on the left, what the analysis said about the selected ticker on the right.
(function () {
  const { h, $, clear, toast, money, pct, qty } = U;
  let S = { sel: '', entries: [], latest: {}, detail: {}, sort: 'ticker' };
  let root = null;
  let gen = 0;
  const mounted = () => root && document.body.contains(root);
  const latestEntry = (t) => S.entries.find((e) => e.ticker === t) || null;
  const RANK = { Buy: 0, Overweight: 1, Hold: 2, Underweight: 3, Sell: 4, REVIEW: 5 };

  TD.pages.watch = async function (el) {
    root = el; gen++;
    const myGen = gen;
    const tk = h('input', { type: 'text', class: 'ticker', placeholder: 'AVGO', autocomplete: 'off', spellcheck: false, id: 'wtk' });
    const note = h('input', { type: 'text', placeholder: 'Note, for example "buy under 390"', id: 'wnote' });
    const add = async () => {
      const r = await td.watchAdd({ ticker: tk.value, note: note.value });
      if (!r.ok) return toast(r.error, 'error');
      TD.state.watch = r.items; S.sel = tk.value.trim().toUpperCase() || S.sel; tk.value = ''; note.value = '';
      paintList(); selectLoad();
    };
    [tk, note].forEach((i) => i.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); }));
    const addHoldings = h('button', { class: 'btn', onclick: async () => {
      const held = TD.state.holdings.positions || [];
      if (!held.length) return toast('No holdings yet. Import them on the Holdings page first.', 'error');
      let items = TD.state.watch;
      for (const p of held) { const r = await td.watchAdd({ ticker: p.ticker, note: 'held' }); if (r.ok) items = r.items; }
      TD.state.watch = items; paintList();
    } }, 'Add all my holdings');
    const wsplit = h('div', { class: 'wsplit' });
    const wleft = h('div', { class: 'wleft' },
      h('div', { class: 'card compact' }, h('h2', null, 'Watchlist'),
        h('div', { class: 'row' }, h('div', { class: 'field' }, h('label', { for: 'wtk' }, 'Ticker'), tk), h('div', { class: 'field grow' }, h('label', { for: 'wnote' }, 'Note'), note),
          h('button', { class: 'btn primary', onclick: add }, 'Add')),
        h('div', { class: 'row', style: { marginTop: '8px' } }, addHoldings)),
      h('div', { class: 'card', id: 'wlist' }),
      h('div', { class: 'card compact', id: 'wrun' }));
    wsplit.append(wleft,
      TD.splitter({ dir: 'col', grid: wsplit, prop: '--wlw', first: () => wleft, min: 280, minOther: 360, id: 'watch-cols', label: 'Resize the list and the detail' }),
      h('div', { class: 'wright' }, h('div', { class: 'card', id: 'wdetail' })));
    el.append(wsplit);
    paintList(); paintRun(); paintDetail();
    const j = await td.journal();
    if (j.ok && myGen === gen && mounted()) { S.entries = j.entries; S.median = j.medianSeconds; paintList(); paintRun(); if (!S.sel && TD.state.watch[0]) S.sel = TD.state.watch[0].ticker; paintList(); selectLoad(); }
    const items = TD.state.watch.map((w) => w.ticker);
    if (items.length && (TD.state.info || {}).engineInstalled) {
      TD.quote(items, { years: 1 }).then(() => { if (myGen === gen && mounted()) paintList(); }).catch(() => {});
    }
  };

  async function selectLoad() {
    const t = S.sel;
    if (!t) { paintDetail(); return; }
    paintDetail();
    const e = latestEntry(t);
    if (e && !(S.latest[t] && S.latest[t].entry.id === e.id)) {
      const r = await td.journalGet({ id: e.id });
      if (r.ok) S.latest[t] = { entry: r.entry, result: r.result, position: r.position };
    }
    if ((TD.state.info || {}).engineInstalled && !S.detail[t]) {
      try { const m = await TD.quote([t], { years: 1, news: false }); S.detail[t] = m[t]; } catch { S.detail[t] = { ok: false }; }
    }
    if (mounted() && S.sel === t) paintDetail();
  }

  function select(t) { S.sel = t; paintList(); selectLoad(); }

  function paintList() {
    paintListInner();
    paintRun();
  }

  function paintListInner() {
    if (!mounted() || !$('#wlist')) return;
    const box = clear($('#wlist'));
    const items = (TD.state.watch || []).slice();
    if (!items.length) { box.append(h('div', { class: 'empty-note' }, 'Nothing here yet. Add a ticker above.')); return; }
    const key = (i) => { const e = latestEntry(i.ticker); return S.sort === 'rating' ? (e ? RANK[e.rating] ?? 9 : 10) : i.ticker; };
    items.sort((a, b) => (key(a) > key(b) ? 1 : key(a) < key(b) ? -1 : 0));
    box.append(h('div', { class: 'row center' }, h('h2', null, `${items.length} ticker${items.length === 1 ? '' : 's'}`), h('div', { class: 'spacer' }),
      h('label', { class: 'hint' }, 'Sort '), h('select', { id: 'wsort', onchange: (e) => { S.sort = e.target.value; paintList(); } },
        h('option', { value: 'ticker', selected: S.sort === 'ticker' }, 'A to Z'), h('option', { value: 'rating', selected: S.sort === 'rating' }, 'Best rated first'))));
    box.append(h('div', { class: 'wl' }, items.map((i) => {
      const p = TD.positionFor(i.ticker);
      const e = latestEntry(i.ticker);
      const q = TD.cachedQuote(i.ticker, 1);
      return h('button', { class: 'wl-row' + (i.ticker === S.sel ? ' sel' : ''), type: 'button', dataset: { ticker: i.ticker }, onclick: () => select(i.ticker) },
        h('span', { class: 'wt' }, h('b', null, i.ticker), p ? h('span', { class: 'held-dot', title: `You hold ${qty(p.quantity)} units` }, '●') : null),
        q && q.ok ? TDCharts.spark((q.history || []).slice(-126).map((r) => r[1]), { w: 64 }) : h('span', { class: 'spark' }),
        e ? h('span', { class: 'wr' }, U.ratingBadge(e.rating), h('span', { class: 'hint' }, ' ' + e.date)) : h('span', { class: 'hint' }, 'not analysed'));
    })));
  }

  function paintRun() {
    if (!mounted() || !$('#wrun')) return;
    const box = clear($('#wrun'));
    const n = (TD.state.watch || []).length;
    const date = h('input', { type: 'date', value: U.today(), max: U.today(), id: 'wdate' });
    const inc = h('input', { type: 'checkbox', checked: true, id: 'winc' });
    const profile = h('select', { id: 'wprofile' }, ['fast', 'standard', 'thorough'].map((p) => h('option', { value: p, selected: p === 'standard' }, p[0].toUpperCase() + p.slice(1))));
    const go = h('button', { class: 'btn primary', disabled: !n, title: 'Adds every ticker to the Queue so you can cancel them one by one or all together', onclick: async () => {
      const nr = TD.notReady(); if (nr) return toast(nr, 'error');
      const r = await td.queueAdd({ items: TD.state.watch.map((i) => i.ticker), date: date.value, includePortfolio: inc.checked, profile: profile.value });
      if (!r.ok) return toast(r.error, 'error');
      TD.setQueue(r.queue); toast(`${r.added} added to the queue.`, 'ok'); TD.showQueueTab();
    } }, `Queue all ${n}`);
    box.append(h('h2', null, 'Run the list'),
      h('div', { class: 'row center' }, h('div', { class: 'field' }, h('label', null, 'As of'), date), h('div', { class: 'field' }, h('label', null, 'Depth'), profile), h('label', { class: 'check' }, inc, 'Use my holdings'), h('div', { class: 'spacer' }), go),
      h('div', { class: 'hint', style: { marginTop: '8px' } }, S.median && n ? `About ${U.duration(S.median * n)} in total at your recent pace of ${U.duration(S.median)} per ticker. Leave the computer on and awake. Progress is in the Queue tab on Analyze.` : 'Time per ticker depends on your model. After your first run this shows an estimate.'));
  }

  function paintDetail() {
    if (!mounted() || !$('#wdetail')) return;
    const box = clear($('#wdetail'));
    const t = S.sel;
    if (!t) { box.append(h('h2', null, 'Details'), h('div', { class: 'empty-note' }, 'Select a ticker on the left to see what the latest analysis said.')); return; }
    const item = (TD.state.watch || []).find((w) => w.ticker === t);
    const e = latestEntry(t);
    box.append(h('div', { class: 'row center' }, h('h2', null, t), e ? U.ratingBadge(e.rating) : null, h('div', { class: 'spacer' }),
      h('button', { class: 'btn small', onclick: () => TD.openAnalyze(t) }, 'Open in Analyze'),
      h('button', { class: 'btn small', onclick: async () => {
        const nr = TD.notReady(); if (nr) return toast(nr, 'error');
        const r = await td.queueAdd({ items: [t], date: U.today(), includePortfolio: true });
        if (!r.ok) return toast(r.error, 'error'); TD.setQueue(r.queue); toast(r.added ? `${t} added to the queue.` : `${t} is already waiting.`, 'ok');
      } }, 'Analyze now'),
      h('button', { class: 'btn small', onclick: async () => {
        const r = await td.watchRemove({ ticker: t });
        if (r.ok) { TD.state.watch = r.items; S.sel = r.items[0] ? r.items[0].ticker : ''; paintList(); selectLoad(); }
      } }, 'Remove')));
    if (item && item.note) box.append(h('div', { class: 'callout small' }, 'Your note: ' + item.note));
    const q = S.detail[t];
    if (q && q.ok) {
      const up = (q.changePct || 0) >= 0;
      box.append(h('div', { class: 'row center', style: { margin: '6px 0' } }, h('b', { class: 'px2' }, money(q.price)), h('span', { class: up ? 'pos' : 'neg' }, pct(q.changePct)), h('span', { class: 'hint' }, `close of ${q.asOf}`)),
        TDCharts.line({ points: q.history || [], ranges: ['1M', '3M', '6M', '1Y'], range: '6M', height: 140, fmt: (v) => money(v), name: `${t} closing price` }));
    }
    if (!e) { box.append(h('div', { class: 'empty-note', style: { marginTop: '10px' } }, `No analysis of ${t} yet. Use "Analyze now".`)); return; }
    const data = S.latest[t];
    if (!data) { box.append(h('div', { class: 'hint', style: { marginTop: '10px' } }, 'Loading the saved analysis…')); return; }
    box.append(h('div', { class: 'detail-brief' }, TD.renderBriefing({ entry: data.entry, result: data.result, position: data.position }, { onUpdate: paintDetail })),
      h('div', { class: 'row center sumtools' }, h('button', { class: 'btn', onclick: () => TD.viewEntry(data.entry.id) }, 'Open full report')));
  }
})();
