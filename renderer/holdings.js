'use strict';
// Holdings: how the portfolio stands (value, allocation, profit or loss, timeline), then the editable table with import at the bottom.
(function () {
  const { h, $, clear, toast, money, pct, qty } = U;
  const P = () => window.Portfolio;
  let root = null;
  let gen = 0;
  const tl = { style: 'line', interval: '1d', range: '1Y', who: 'ALL' };
  let sortBy = { key: null, dir: 'asc' };
  let live = { at: null, err: null, loading: false };

  const mounted = () => root && document.body.contains(root);

  TD.pages.holdings = function (el) {
    root = el; gen++;
    const myGen = gen;
    const H = JSON.parse(JSON.stringify(TD.state.holdings));
    let rows = (H.positions || []).map((p) => ({ ...p }));
    const cash = h('input', { type: 'number', step: 'any', min: 0, value: H.cash ?? '', style: { width: '150px' }, id: 'cash' });
    const info = h('div', { class: 'hint' });
    const tiles = h('div', { class: 'stats tiles', id: 'tiles' });
    const timeline = h('div', { class: 'card', id: 'timeline' });
    const alloc = h('div', { class: 'card', id: 'alloc' });
    const plcard = h('div', { class: 'card', id: 'plcard' });
    const body = h('div');
    const unsaved = () => clear(info).append(`${rows.length} position${rows.length === 1 ? '' : 's'}. Unsaved changes.`);

    const cashNum = () => (cash.value === '' ? null : Number(cash.value));
    const prices = () => {
      const pm = TD.priceMap();
      for (const r of rows) if (r.ticker && Number(r.manualPrice) > 0) pm[r.ticker] = Number(r.manualPrice);
      return pm;
    };
    const priced = () => rows.map((r) => ({ ...r, quantity: Number(r.quantity) }));

    function paintTiles() {
      clear(tiles);
      const pm = prices();
      const t = P().totals(priced(), pm);
      const total = t.value + (cashNum() || 0);
      const stat = (v, k, cls) => h('div', { class: 'stat' }, h('div', { class: 'v ' + (cls || '') }, v), h('div', { class: 'k' }, k));
      tiles.append(
        stat(money(total, 0), cashNum() ? 'total value incl. cash' : 'total value'),
        stat(money(t.cost, 0), 'cost basis'),
        stat(t.pl == null ? '—' : `${t.pl >= 0 ? '+' : '−'}${money(Math.abs(t.pl), 0)}`, t.plPct == null ? 'profit or loss' : `profit or loss (${pct(t.plPct)})`, t.pl == null ? '' : t.pl >= 0 ? 'pos' : 'neg'),
        stat(String(rows.length), 'positions'),
        stat(cashNum() != null ? money(cashNum(), 0) : '—', 'cash'));
      const stamp = live.loading ? 'Fetching current prices…' : live.err ? `Live prices unavailable: ${live.err}. Showing prices from your sheet.` : live.at ? `Prices from Yahoo Finance, ${new Date(live.at).toLocaleTimeString()}.` : 'Prices from your sheet.';
      tiles.append(h('div', { class: 'tilenote hint' }, stamp, t.missing.length ? ` No price for ${t.missing.join(', ')}.` : '',
        ' ', h('button', { class: 'btn link', onclick: () => loadLive(true) }, 'Refresh')));
    }

    function paintAlloc() {
      clear(alloc);
      alloc.append(h('h2', null, 'Allocation'));
      const a = P().allocation(priced(), cashNum(), prices(), 8);
      if (!a.items.length) { alloc.append(h('div', { class: 'empty-note' }, 'Nothing to show yet. Add prices or import holdings with prices.')); return; }
      alloc.append(h('div', { class: 'allocwrap' },
        TDCharts.donut(a.items, { center: [money(a.total, 0), 'priced total'] }),
        h('ul', { class: 'legend' }, a.items.map((it, i) => h('li', null, h('span', { class: `sw ${TDCharts.colorClass(it, i)}` }), h('span', { class: 'ln' }, it.name), h('span', { class: 'num' }, `${(it.weight * 100).toFixed(1)}%`),
          it.rolled ? h('span', { class: 'hint', title: it.rolled.join(', ') }, ` ${it.rolled.length} smaller`) : null)))));
      const top = a.items.find((x) => !x.cash && x.name !== 'Other');
      if (top && top.weight >= window.Advice.CONCENTRATED) alloc.append(h('div', { class: 'callout warn small' }, `${top.name} is ${(top.weight * 100).toFixed(0)}% of what you hold. One stock that big moves the whole portfolio.`));
      if (a.missing.length) alloc.append(h('div', { class: 'hint' }, `Left out, no price: ${a.missing.join(', ')}.`));
    }

    function paintPL() {
      clear(plcard);
      plcard.append(h('h2', null, 'Profit or loss by position'));
      const t = P().totals(priced(), prices());
      const list = t.rows.filter((r) => r.pl != null).sort((a, b) => b.pl - a.pl);
      if (!list.length) { plcard.append(h('div', { class: 'empty-note' }, 'Needs an average cost and a price for each position.')); return; }
      plcard.append(TDCharts.bars(list.map((r) => ({ name: r.ticker, value: r.pl })), { fmt: (v) => TDCharts.compact(v), width: 420 }));
      plcard.append(h('div', { class: 'hint' }, 'Unrealised: what the position would show if it were valued now, before tax and costs.'));
    }

    // ---- holdings over time: line or candles, at a minute, hour, day or week interval
    let tlSeq = 0;
    function tlNote(text) { return h('div', { class: 'hint' }, text); }
    function paintTimeline() {
      clear(timeline);
      timeline.append(h('h2', null, 'Holdings over time'));
      const tickers = [...new Set(rows.map((r) => r.ticker).filter(Boolean))];
      if (!tickers.length) { timeline.append(h('div', { class: 'empty-note' }, 'Import holdings to see this.')); return; }
      const I = P().INTERVALS;
      if (!I[tl.interval]) tl.interval = '1d';
      if (!I[tl.interval].ranges.includes(tl.range)) tl.range = I[tl.interval].ranges.includes('1Y') ? '1Y' : I[tl.interval].ranges[I[tl.interval].ranges.length - 1];
      if (tl.who !== 'ALL' && !tickers.includes(tl.who)) tl.who = 'ALL';
      const whoSel = h('select', { id: 'tlwho', 'aria-label': 'What to chart', onchange: (e) => { tl.who = e.target.value; paintTimeline(); } },
        h('option', { value: 'ALL' }, 'Whole portfolio'), tickers.map((t) => h('option', { value: t, selected: t === tl.who }, t)));
      whoSel.value = tl.who;
      const ivSel = h('select', { id: 'tliv', 'aria-label': 'Interval', onchange: (e) => { tl.interval = e.target.value; paintTimeline(); } },
        Object.entries(I).map(([k, v]) => h('option', { value: k }, v.label)));
      ivSel.value = tl.interval;
      const seg = (id, label, on) => h('button', { class: 'rng' + (tl.style === id ? ' active' : ''), type: 'button', dataset: { style: id }, onclick: on }, label);
      const ctl = h('div', { class: 'chartctl' },
        h('div', { class: 'grp' }, h('span', { class: 'lbl' }, 'Show'), whoSel),
        h('div', { class: 'grp' }, h('span', { class: 'lbl' }, 'Chart'), seg('line', 'Line', () => { tl.style = 'line'; paintTimeline(); }), seg('candles', 'Candles', () => { tl.style = 'candles'; paintTimeline(); })),
        h('div', { class: 'grp' }, h('span', { class: 'lbl' }, 'Each bar is'), ivSel),
        h('div', { class: 'grp rangegrp' }, I[tl.interval].ranges.map((r) => h('button', { class: 'rng' + (r === tl.range ? ' active' : ''), type: 'button', dataset: { range: r }, onclick: () => { tl.range = r; paintTimeline(); } }, r))));
      timeline.append(h('div', { class: 'sub' }, tl.who === 'ALL' ? 'Your current positions valued at each past price. This is not your account history: it ignores when you bought and anything you sold since.' : `${tl.who} price history.`), ctl);
      const box = h('div', { class: 'tlbox' });
      timeline.append(box);
      const foot = (arr) => arr.filter(Boolean).forEach((t) => timeline.append(tlNote(t)));
      const single = tl.who !== 'ALL';
      const pos = single ? [{ ticker: tl.who, quantity: 1 }] : priced().filter((r) => r.quantity);
      const fmt = single ? (v) => (Math.abs(v) >= 1000 ? TDCharts.compact(v) : v.toFixed(2)) : (v) => TDCharts.compact(v);

      if (tl.style === 'line' && tl.interval === '1d') {
        const hist = {};
        for (const t of single ? [tl.who] : tickers) { const q = TD.cachedQuote(t, 5); if (q && q.ok) hist[t] = q.history; }
        const t = P().timeline(pos, hist);
        if (t.points.length < 2) { box.append(h('div', { class: 'empty-note' }, live.loading ? 'Loading price history…' : live.err ? 'Price history could not be loaded.' : 'No price history yet.')); return; }
        const pts = P().slice(t.points, tl.range);
        box.append(TDCharts.line({ points: pts, range: tl.range, height: 240, fmt, cost: single ? null : t.cost, costLabel: 'cost basis', name: single ? `${tl.who} price over time` : 'Value of current holdings over time' }));
        foot([t.skipped.length ? `Not included, no price history: ${t.skipped.join(', ')}.` : '', !single && t.start ? `The line starts ${t.start}, the first day every included holding has a price.` : '']);
        return;
      }

      // everything else needs bars from Yahoo
      const seq = ++tlSeq;
      box.append(h('div', { class: 'empty-note' }, 'Loading bars…'));
      const want = single ? [tl.who] : tickers;
      const key = `${tl.interval}|${tl.range}`;
      const have = () => want.every((t) => TD.cachedBars(t, tl.interval, tl.range));
      const render = () => {
        if (seq !== tlSeq || !mounted()) return;
        clear(box);
        const by = {}; const missing = [];
        for (const t of want) { const b = TD.cachedBars(t, tl.interval, tl.range); if (b && b.ok) by[t] = b.bars; else missing.push(t); }
        let bars; let skipped = missing; let start = null;
        if (single) bars = by[tl.who] || [];
        else { const c = P().candles(pos, by); bars = c.bars; skipped = c.skipped; start = c.start; }
        if (bars.length < 2) { box.append(h('div', { class: 'empty-note' }, `No ${I[tl.interval].label} bars came back${live.err ? ': ' + live.err : ''}. Yahoo only keeps minute bars for a few days and short intervals for a few weeks, and markets are closed at weekends.`)); }
        else box.append(TDCharts.ohlc({ bars, style: tl.style, height: 260, fmt, hideVolume: !single, name: single ? `${tl.who} ${tl.style}` : 'Value of current holdings, by bar' }));
        foot([
          skipped.length ? `Not included, no bars: ${skipped.join(', ')}.` : '',
          !single && tl.style === 'candles' && bars.length ? 'Candles for the whole portfolio add up each holding’s own open, high, low and close. The high and low assume every holding peaked at the same moment, so they are outer limits, not what a statement would show.' : '',
          !single && start && bars.length ? `The chart starts at ${start}, the first bar every included holding has.` : '',
          I[tl.interval].ranges.length && ['1m', '5m', '15m', '1h'].includes(tl.interval) ? 'Intraday bars cover market hours only. Dotted lines mark the start of each trading day.' : '']);
      };
      if (have()) { render(); return; }
      TD.bars(want, tl.interval, tl.range).then(() => { live.err = null; render(); }).catch((e) => { live.err = e.message; render(); });
    }

    const plCell = (r) => {
      const last = lastOf(r);
      if (last == null || r.averagePrice == null) return h('td', { class: 'num' }, '—');
      const v = (last - r.averagePrice) * r.quantity;
      return h('td', { class: `num ${v >= 0 ? 'pos' : 'neg'}` }, `${v >= 0 ? '+' : '−'}${money(Math.abs(v))}`);
    };
    const plPctCell = (r) => {
      const last = lastOf(r);
      if (last == null || !r.averagePrice) return h('td', { class: 'num' }, '—');
      const p = (last - r.averagePrice) / r.averagePrice;
      return h('td', { class: `num ${p >= 0 ? 'pos' : 'neg'}` }, pct(p));
    };
    const lastOf = (r) => { if (Number(r.manualPrice) > 0) return Number(r.manualPrice); const pm = prices(); return pm[r.ticker] != null ? pm[r.ticker] : r.lastPrice != null ? r.lastPrice : null; };

    // columns: key, header, how to read a row for sorting
    const COLS = [
      ['ticker', 'Ticker', (r) => (r.ticker || '').toUpperCase() || null],
      ['quantity', 'Units', (r) => Number(r.quantity)],
      ['avg', 'Average cost', (r) => (r.averagePrice == null ? null : Number(r.averagePrice))],
      ['cost', 'Cost basis', (r) => (r.averagePrice == null ? null : Math.abs(r.quantity) * r.averagePrice)],
      ['last', 'Current price', (r) => lastOf(r)],
      ['today', 'Today', (r) => { const q = TD.cachedQuote(r.ticker, 5) || TD.cachedQuote(r.ticker, 1); return q && q.ok ? q.changePct : null; }],
      ['value', 'Market value', (r) => { const l = lastOf(r); return l != null ? l * r.quantity : null; }],
      ['share', 'Share', (r) => { const l = lastOf(r); return l != null ? l * r.quantity : null; }],
      ['pl', 'Profit or loss', (r) => { const l = lastOf(r); return l != null && r.averagePrice != null ? (l - r.averagePrice) * r.quantity : null; }],
      ['plpct', 'Profit or loss %', (r) => { const l = lastOf(r); return l != null && r.averagePrice ? (l - r.averagePrice) / r.averagePrice : null; }],
      ['bought', 'Bought', (r) => r.boughtAt || null],
      ['accounts', 'Accounts', (r) => Object.keys(r.accounts || {}).sort().join(', ') || null],
    ];
    const NUMCOL = new Set(['quantity', 'avg', 'cost', 'last', 'today', 'value', 'share', 'pl', 'plpct']);
    const livePrice = (r) => { const pm = TD.priceMap(); return pm[r.ticker] != null ? pm[r.ticker] : r.lastPrice != null ? r.lastPrice : null; };
    function sortedRows() {
      if (!sortBy.key) return rows.slice();
      const col = COLS.find((c) => c[0] === sortBy.key);
      return P().sortRows(rows, sortBy.key, sortBy.dir, (r) => col[2](r));
    }
    function setSort(key) {
      if (sortBy.key !== key) sortBy = { key, dir: NUMCOL.has(key) && key !== 'avg' ? 'desc' : 'asc' };
      else if (sortBy.dir === (NUMCOL.has(key) && key !== 'avg' ? 'desc' : 'asc')) sortBy.dir = sortBy.dir === 'asc' ? 'desc' : 'asc';
      else sortBy = { key: null, dir: 'asc' };
      paintTable();
    }

    function paintTable() {
      clear(body);
      if (!rows.length) { body.append(h('div', { class: 'empty-note' }, 'No holdings yet. Import a spreadsheet, paste it from Excel, or add rows by hand using the buttons below.')); return; }
      const total = P().totals(priced(), prices()).value + (cashNum() || 0);
      const head = h('tr', null, COLS.map(([key, label]) => {
        const on = sortBy.key === key;
        return h('th', { class: NUMCOL.has(key) ? 'num' : '', 'aria-sort': on ? (sortBy.dir === 'asc' ? 'ascending' : 'descending') : 'none' },
          h('button', { class: 'thsort' + (on ? ' on' : ''), type: 'button', dataset: { sort: key }, title: 'Sort by ' + label.toLowerCase(), onclick: () => setSort(key) }, label, h('span', { class: 'arrow', 'aria-hidden': 'true' }, on ? (sortBy.dir === 'asc' ? ' ▲' : ' ▼') : '')));
      }).concat([h('th', null, '')]));
      body.append(h('div', { class: 'tablewrap' }, h('table', { class: 'list', id: 'postable' },
        h('thead', null, head),
        h('tbody', null, sortedRows().map((r) => {
          const last = lastOf(r);
          const manual = Number(r.manualPrice) > 0;
          const q = TD.cachedQuote(r.ticker, 5) || TD.cachedQuote(r.ticker, 1);
          const val = last != null ? last * r.quantity : null;
          const avgIn = h('input', { type: 'number', step: 'any', min: 0, value: r.averagePrice ?? '', class: 'avgin', 'aria-label': `Average cost of ${r.ticker}`, oninput: (e) => { r.averagePrice = e.target.value === '' ? null : Number(e.target.value); syncCost(); unsaved(); refreshViews(); } });
          const costIn = h('input', { type: 'number', step: 'any', min: 0, value: r.averagePrice != null ? +(Math.abs(r.quantity) * r.averagePrice).toFixed(2) : '', class: 'costin', 'aria-label': `Cost basis of ${r.ticker}`, oninput: (e) => {
            const v = e.target.value === '' ? null : Number(e.target.value);
            r.averagePrice = v == null || !r.quantity ? r.averagePrice : v / Math.abs(r.quantity);
            if (r.averagePrice != null) avgIn.value = +r.averagePrice.toFixed(4);
            unsaved(); refreshViews();
          } });
          const syncCost = () => { costIn.value = r.averagePrice != null ? +(Math.abs(r.quantity) * r.averagePrice).toFixed(2) : ''; };
          const priceIn = h('input', { type: 'number', step: 'any', min: 0, class: 'pricein' + (manual ? ' manual' : ''), value: last != null ? +Number(last).toFixed(4) : '', placeholder: 'price', 'aria-label': `Current price of ${r.ticker}`, title: manual ? 'Typed by you. Press the arrow to go back to the live price.' : 'Type a price to override the live one.', oninput: (e) => {
            r.manualPrice = e.target.value === '' ? null : Number(e.target.value);
            priceIn.classList.toggle('manual', Number(r.manualPrice) > 0);
            unsaved(); refreshViews();
          }, onchange: () => paintTable() });
          return h('tr', null,
            h('td', null, h('input', { type: 'text', value: r.ticker, class: 'ticker', style: { width: '100px' }, 'aria-label': 'Ticker', oninput: (e) => { r.ticker = e.target.value.toUpperCase(); unsaved(); } })),
            h('td', { class: 'num' }, h('input', { type: 'number', step: 'any', value: r.quantity, 'aria-label': `Units of ${r.ticker}`, oninput: (e) => { r.quantity = Number(e.target.value); syncCost(); unsaved(); refreshViews(); } })),
            h('td', { class: 'num' }, avgIn),
            h('td', { class: 'num' }, costIn),
            h('td', { class: 'num pricecell' }, priceIn, manual ? h('button', { class: 'btn link resetp', type: 'button', title: livePrice(r) != null ? `Back to the live price, ${money(livePrice(r))}` : 'Remove the price you typed', 'aria-label': `Use the live price for ${r.ticker}`, onclick: () => { r.manualPrice = null; unsaved(); paintAll(); } }, '↺') : null),
            h('td', { class: `num ${q && q.ok && q.changePct != null ? (q.changePct >= 0 ? 'pos' : 'neg') : ''}` }, q && q.ok && q.changePct != null ? pct(q.changePct) : '—'),
            h('td', { class: 'num' }, val != null ? money(val) : '—'),
            h('td', { class: 'num' }, val != null && total ? `${((val / total) * 100).toFixed(1)}%` : '—'),
            plCell(r),
            plPctCell(r),
            h('td', { class: 'num' }, r.boughtAt || '—'),
            h('td', { class: 'summary-cell' }, Object.entries(r.accounts || {}).map(([a, qn]) => `${a} ${qty(qn)}`).join(', ') || '—'),
            h('td', { class: 'num' }, h('button', { class: 'btn small', onclick: () => { rows.splice(rows.indexOf(r), 1); unsaved(); paintAll(); } }, 'Remove')));
        })))));
    }

    function refreshViews() { paintTiles(); paintAlloc(); paintPL(); paintTimeline(); }
    function paintAll() { refreshViews(); paintTable(); }

    async function loadLive(force) {
      const tickers = [...new Set(rows.map((r) => r.ticker).filter(Boolean))];
      if (!tickers.length || !(TD.state.info || {}).engineInstalled) return;
      if (!force && tickers.every((t) => TD.cachedQuote(t, 5))) { live.at = live.at || Date.now(); return; }
      live.loading = true; live.err = null; paintTiles(); paintTimeline();
      try { await TD.quote(tickers, { years: 5, force: !!force }); live.at = Date.now(); } catch (e) { live.err = e.message; }
      live.loading = false;
      if (myGen === gen && mounted()) paintAll();
    }

    const save = async () => {
      const r = await td.saveHoldings({ positions: rows.map((p) => ({ ...p, quantity: Number(p.quantity), averagePrice: p.averagePrice })), cash: cashNum() });
      if (!r.ok) return toast(r.error, 'error');
      TD.state.holdings = r.holdings; toast('Holdings saved.', 'ok'); loadLive(true);
    };
    const onImported = (hh) => { Object.assign(H, hh); rows = hh.positions.map((p) => ({ ...p })); cash.value = hh.cash ?? ''; clear(info).append(`${rows.length} positions imported.`); paintAll(); loadLive(true); };
    cash.addEventListener('input', () => { unsaved(); refreshViews(); });

    el.append(
      h('div', { class: 'pagehead' }, h('div', null, h('div', { class: 'hint' }, 'The agents see these, so a rating can tell adding to a full position from opening a new one. They stay on this computer. Positions from all accounts are merged into one line per ticker.'))),
      tiles, timeline, h('div', { class: 'grid2 tight' }, alloc, plcard),
      h('div', { class: 'card' }, h('h2', null, 'Positions'), h('div', { style: { margin: '4px 0 10px' } }, info), body,
        h('div', { class: 'row center holdtools' },
          h('button', { class: 'btn primary', onclick: () => TD.importFlow(el, onImported) }, 'Import Excel or CSV'),
          h('button', { class: 'btn primary', onclick: () => TD.pasteFlow(onImported) }, 'Paste from spreadsheet'),
          h('button', { class: 'btn', id: 'refreshprices', onclick: () => loadLive(true) }, 'Refresh prices'),
          h('button', { class: 'btn', onclick: () => { rows.push({ ticker: '', quantity: 0, averagePrice: null, accounts: {} }); unsaved(); paintTable(); } }, 'Add a row'),
          h('div', { class: 'spacer' }),
          h('div', { class: 'field' }, h('label', { for: 'cash' }, 'Cash available'), cash),
          h('button', { class: 'btn primary', onclick: save }, 'Save changes'))),
      h('div', { class: 'hint' }, 'Cash is optional. If you leave it blank the agents are told your positions but not your cash. Crypto holdings are passed as entered; use Yahoo-style symbols such as XRP-USD if you want charts and analysis for them.'));
    clear(info).append(H.importedAt ? `Imported ${new Date(H.importedAt).toLocaleString()} from ${H.source || 'a file'}. ` : 'Nothing imported yet. ', `${rows.length} position${rows.length === 1 ? '' : 's'}.`);
    paintAll();
    loadLive(false);
  };
})();
