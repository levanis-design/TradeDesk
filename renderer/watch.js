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
    const wsplit = h('div', { class: 'wsplit' });
    const wleft = h('div', { class: 'wleft' },
      h('div', { class: 'card compact' }, h('div', { class: 'row center' }, h('h2', null, 'Watchlist'), h('div', { class: 'spacer' }),
          h('button', { class: 'btn small', id: 'wUpload', title: 'Upload a table with ticker, price, buy zones and why', onclick: () => TD.watchImportFlow(() => { S.sel = (TD.state.watch[0] || {}).ticker || S.sel; paintList(); selectLoad(); loadAllQuotes(); }) }, 'Upload watchlist')),
        h('div', { class: 'row' }, h('div', { class: 'field' }, h('label', { for: 'wtk' }, 'Ticker'), tk), h('div', { class: 'field grow' }, h('label', { for: 'wnote' }, 'Note'), note),
          h('button', { class: 'btn primary', onclick: add }, 'Add')),
        h('div', { class: 'hint', style: { marginTop: '6px' } }, 'The watchlist is only for stocks you do not hold. Your holdings are listed separately below; choose which to show. Upload a spreadsheet to add many at once, with price, buy zones and why each matters.')),
      h('div', { class: 'card', id: 'wlist' }),
      h('div', { class: 'card compact', id: 'wrun' }));
    wsplit.append(wleft,
      TD.splitter({ dir: 'col', grid: wsplit, prop: '--wlw', first: () => wleft, min: 280, minOther: 360, id: 'watch-cols', label: 'Resize the list and the detail' }),
      h('div', { class: 'wright' }, h('div', { class: 'card', id: 'wdetail' })));
    el.append(wsplit);
    paintList(); paintRun(); paintDetail();
    const j = await td.journal();
    if (j.ok && myGen === gen && mounted()) { S.entries = j.entries; S.median = j.medianSeconds; paintList(); paintRun(); if (!S.sel && TD.tickersFor(TD.getListView('watchlist', 'watch'))[0]) S.sel = TD.tickersFor(TD.getListView('watchlist', 'watch'))[0].ticker; paintList(); selectLoad(); }
    const items = TD.tickersFor('both').map((w) => w.ticker);
    if (items.length && (TD.state.info || {}).engineInstalled) {
      TD.quote(items, { years: 1 }).then(() => { if (myGen === gen && mounted()) paintList(); }).catch(() => {});
    }
    loadListPrices();
  };

  async function loadAllQuotes() {
    const items = TD.tickersFor('both').map((w) => w.ticker);
    if (!items.length || !(TD.state.info || {}).engineInstalled) return;
    try { await TD.quote(items, { years: 1 }); } catch { /* rows show no price */ }
    if (mounted()) { paintList(); paintDetail(); }
    loadListPrices();
  }

  // An older uploaded list is compared by date, which needs more history than the default year.
  async function loadListPrices() {
    const old = (TD.state.watch || []).filter((w) => w.listDate && w.listPrice == null).map((w) => w.ticker);
    if (!old.length || !(TD.state.info || {}).engineInstalled) return;
    try { await TD.quote(old.slice(0, 40), { years: 5 }); if (mounted()) { paintList(); paintDetail(); } } catch { /* shown as not available */ }
  }

  const hist = (t) => { const q = TD.cachedQuote(t, 5) || TD.cachedQuote(t, 1); return q && q.ok ? q : null; };
  // Price in the list: from the file, else the close on the list date.
  function thenPrice(w) {
    if (!w) return null;
    if (typeof w.listPrice === 'number') return { price: w.listPrice, from: 'file' };
    const q = w.listDate ? hist(w.ticker) : null;
    const p = q ? Zones.priceOn(q.history || [], w.listDate) : null;
    return p == null ? null : { price: p, from: 'close' };
  }
  const nowPrice = (t) => { const q = hist(t); return q && typeof q.price === 'number' ? q.price : null; };

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
    const view = TD.getListView('watchlist', 'watch');
    const items = TD.tickersFor(view).map((x) => ({ ...x }));
    S.shown = items.map((i) => i.ticker);
    if (!items.length) { box.append(h('div', { class: 'row center' }, h('div', { class: 'spacer' }), TD.listSelector('watchlist', view, () => { paintList(); })), h('div', { class: 'empty-note' }, view === 'held' ? 'No holdings yet. Import them on the Holdings page.' : 'Nothing here yet. Add a ticker above.')); return; }
    const key = (i) => { const e = latestEntry(i.ticker); return S.sort === 'rating' ? (e ? RANK[e.rating] ?? 9 : 10) : i.ticker; };
    items.sort((a, b) => (key(a) > key(b) ? 1 : key(a) < key(b) ? -1 : 0));
    box.append(h('div', { class: 'row center' }, h('h2', null, `${items.length} ticker${items.length === 1 ? '' : 's'}`), h('div', { class: 'spacer' }),
      TD.listSelector('watchlist', view, () => { paintList(); }), h('label', { class: 'hint' }, 'Sort '), h('select', { id: 'wsort', onchange: (e) => { S.sort = e.target.value; paintList(); } },
        h('option', { value: 'ticker', selected: S.sort === 'ticker' }, 'A to Z'), h('option', { value: 'rating', selected: S.sort === 'rating' }, 'Best rated first'))));
    box.append(h('div', { class: 'wl' }, items.map((i) => {
      const p = TD.positionFor(i.ticker);
      const e = latestEntry(i.ticker);
      const q = TD.cachedQuote(i.ticker, 1);
      return h('button', { class: 'wl-row' + (i.ticker === S.sel ? ' sel' : ''), type: 'button', dataset: { ticker: i.ticker }, onclick: () => select(i.ticker) },
        h('span', { class: 'wt' }, h('b', null, i.ticker), p ? h('span', { class: 'held-dot', title: `You hold ${qty(p.quantity)} units` }, '●') : h('span', { class: 'watch-dot', title: 'On your watchlist' }, '◇'), zoneBadge(i.ticker)),
        q && q.ok ? TDCharts.spark((q.history || []).slice(-126).map((r) => r[1]), { w: 64 }) : h('span', { class: 'spark' }),
        e ? h('span', { class: 'wr' }, U.ratingBadge(e.rating), h('span', { class: 'hint' }, ' ' + e.date)) : h('span', { class: 'hint' }, 'not analysed'));
    })));
  }

  function zoneBadge(t) {
    const w = (TD.state.watch || []).find((x) => x.ticker === t);
    if (!w || !Zones.hasZones(w)) return null;
    const np = nowPrice(t);
    const z = np != null ? Zones.zoneFor(np, w) : null;
    return h('span', { class: `zone z-${z ? z.key : 'none'}`, title: z ? `${money(np)} is inside your ${z.label} zone (${z.text})` : np == null ? 'No current price yet' : `${money(np)} is outside every zone that can be compared` }, z ? z.label : np == null ? 'no price' : 'no zone');
  }

  function paintRun() {
    if (!mounted() || !$('#wrun')) return;
    const box = clear($('#wrun'));
    const shown = S.shown || (TD.state.watch || []).map((w) => w.ticker);
    const n = shown.length;
    const date = h('input', { type: 'date', value: U.today(), max: U.today(), id: 'wdate' });
    const inc = h('input', { type: 'checkbox', checked: true, id: 'winc' });
    const profile = h('select', { id: 'wprofile' }, ['fast', 'standard', 'thorough'].map((p) => h('option', { value: p, selected: p === 'standard' }, p[0].toUpperCase() + p.slice(1))));
    const go = h('button', { class: 'btn primary', disabled: !n, title: 'Adds every ticker to the Queue so you can cancel them one by one or all together', onclick: async () => {
      const nr = TD.notReady(); if (nr) return toast(nr, 'error');
      const r = await td.queueAdd({ items: shown, date: date.value, includePortfolio: inc.checked, profile: profile.value });
      if (!r.ok) return toast(r.error, 'error');
      TD.setQueue(r.queue); toast(`${r.added} added to the queue.`, 'ok'); TD.showQueueTab();
    } }, `Queue all ${n}`);
    box.append(h('h2', null, 'Run the list shown'),
      h('div', { class: 'row center' }, h('div', { class: 'field' }, h('label', null, 'As of'), date), h('div', { class: 'field' }, h('label', null, 'Depth'), profile), h('label', { class: 'check' }, inc, 'Use my holdings'), h('div', { class: 'spacer' }), go),
      h('div', { class: 'hint', style: { marginTop: '8px' } }, S.median && n ? `About ${U.duration(S.median * n)} in total at your recent pace of ${U.duration(S.median)} per ticker. Leave the computer on and awake. Progress is in the Queue tab on Analyze.` : 'Time per ticker depends on your model. After your first run this shows an estimate.'));
  }

  function zonePanel(w) {
    const np = nowPrice(w.ticker);
    const z = np != null ? Zones.zoneFor(np, w) : null;
    const then = thenPrice(w);
    const rows = [];
    if (then) {
      const chg = np != null && then.price ? (np / then.price - 1) * 100 : null;
      rows.push(h('div', { class: 'row center', id: 'zoneCompare' }, h('span', { class: 'hint' }, w.listDate ? `Price on ${w.listDate}${then.from === 'close' ? ' (close)' : ' (your file)'}` : 'Price in your file'), h('b', null, money(then.price)),
        np != null ? h('span', { class: 'hint' }, 'Today') : null, np != null ? h('b', null, money(np)) : null,
        chg != null ? h('span', { class: chg >= 0 ? 'pos' : 'neg' }, `${chg >= 0 ? '+' : '−'}${Math.abs(chg).toFixed(1)}%`) : null));
    } else if (w.listDate) rows.push(h('div', { class: 'hint' }, hist(w.ticker) ? `The price on ${w.listDate} is not available: the file has none and the Yahoo history loaded does not reach back that far. Data to be confirmed.` : `The price on ${w.listDate} is not available yet: the file has none and no market data has loaded for ${w.ticker}. Data to be confirmed.`));
    if (Zones.hasZones(w)) rows.push(h('div', { class: 'zonegrid', id: 'zoneGrid' }, Zones.ORDER.map((f) => h('div', { class: `zcell z-${f}` + (z && z.key === f ? ' on' : '') }, h('div', { class: 'k' }, Zones.LABEL[f]), h('div', { class: 'v' }, w[f] || '—')))),
      h('div', { class: 'hint' }, z ? `Today's price ${money(np)} is inside your ${z.label} zone. This compares numbers you uploaded; it is not a rating from the analysis.` : np == null ? 'No current price yet, so no zone is highlighted.' : `Today's price ${money(np)} is not inside any zone that could be compared. Text zones are never compared.`));
    if (w.why) rows.push(h('div', { class: 'callout small' }, h('b', null, 'Why it is a priority: '), w.why));
    return h('div', { class: 'card compact zonepanel' }, h('div', { class: 'row center' }, h('h2', null, 'Your buy zones'), h('div', { class: 'spacer' }), h('span', { class: 'hint' }, w.listSource ? `from ${w.listSource}` : '')), ...rows);
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
      item ? h('button', { class: 'btn small', onclick: async () => {
        const r = await td.watchRemove({ ticker: t });
        if (r.ok) { TD.state.watch = r.items; S.sel = r.items[0] ? r.items[0].ticker : ''; paintList(); selectLoad(); }
      } }, 'Remove') : h('span', { class: 'badge plain' }, 'In your holdings')));
    if (item && item.note) box.append(h('div', { class: 'callout small' }, 'Your note: ' + item.note));
    if (item && (Zones.hasZones(item) || item.why || item.listPrice != null || item.listDate)) box.append(zonePanel(item));
    // Use the same cached quote as the buy-zone comparison. Loading an older
    // list can refresh five-year history after the detail's one-year snapshot.
    const q = hist(t) || S.detail[t];
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
