'use strict';
// Market heat map: a treemap of large US stocks (a fixed sample, not the whole index) or of your own holdings and watchlist.
// Tile area is company size (sample) or position value (yours). Colour is the price change over the chosen period, and the number is always printed on the tile.
(function () {
  const { h, clear } = U;

  // Fixed sample of large US companies. Size is a rough market value in billions of dollars, used only to set tile area.
  // It is not refreshed live. The sample is not an index and leaves many companies out.
  const SAMPLE = {
    Technology: { NVDA: 4500, MSFT: 3800, AAPL: 3900, AVGO: 1500, ORCL: 600, AMD: 350, CRM: 250, CSCO: 280, IBM: 250, NOW: 200, ADBE: 170, QCOM: 170, TXN: 170, MU: 180, AMAT: 160, INTC: 120 },
    'Communication': { GOOGL: 3000, META: 1800, NFLX: 500, TMUS: 260, DIS: 200, VZ: 190, T: 170, CMCSA: 130 },
    'Consumer cyclical': { AMZN: 2400, TSLA: 1200, HD: 380, MCD: 210, BKNG: 170, LOW: 140, TJX: 140, SBUX: 110, NKE: 100 },
    'Consumer defensive': { WMT: 750, COST: 420, PG: 380, KO: 300, PM: 230, PEP: 200, MO: 100, MDLZ: 90, CL: 70 },
    Financials: { 'BRK-B': 1000, JPM: 800, V: 650, MA: 520, BAC: 350, WFC: 250, GS: 220, MS: 220, AXP: 220, C: 180, SCHW: 170, BLK: 160 },
    'Health care': { LLY: 800, JNJ: 450, ABBV: 380, UNH: 300, MRK: 250, ABT: 230, TMO: 210, ISRG: 200, AMGN: 160, PFE: 150, DHR: 150 },
    Industrials: { GE: 300, CAT: 260, RTX: 220, BA: 150, HON: 140, UNP: 140, ETN: 130, DE: 130, LMT: 110, UPS: 90 },
    Energy: { XOM: 480, CVX: 280, COP: 130, EOG: 70, SLB: 60 },
    Utilities: { NEE: 150, SO: 100, CEG: 100, DUK: 90 },
    'Real estate': { PLD: 100, AMT: 90, EQIX: 80, O: 50 },
    Materials: { LIN: 210, SHW: 90, NEM: 70, FCX: 60 },
  };
  const INDEXES = [['SPY', 'S&P 500'], ['QQQ', 'Nasdaq 100'], ['DIA', 'Dow 30'], ['IWM', 'Russell 2000']];
  const PERIODS = [['1d', '1 day'], ['1w', '1 week'], ['1m', '1 month'], ['3m', '3 months']];
  const H = { universe: 'market', period: '1d', data: null, loading: false, error: '', view: null };

  // Colour buckets by percent change; the scale widens for longer periods so one tile does not saturate everything.
  const STEP = { '1d': 1, '1w': 2, '1m': 4, '3m': 8 };
  function bucket(v, period) {
    if (typeof v !== 'number') return 'na';
    const s = STEP[period];
    const k = Math.min(3, Math.floor(Math.abs(v) / s));
    return (v < 0 ? 'neg' : 'pos') + k;
  }
  const fmt = (v) => (typeof v === 'number' ? `${v < 0 ? '−' : '+'}${Math.abs(v).toFixed(2)}%` : 'n/a');

  // Squarified treemap (Bruls, Huizing and van Wijk). items: [{value, ...}] sorted large to small. Returns items with x, y, w, h.
  function squarify(items, x, y, w, hgt) {
    const total = items.reduce((a, i) => a + i.value, 0);
    const out = [];
    if (!items.length || total <= 0 || w <= 0 || hgt <= 0) return out;
    const scale = (w * hgt) / total;
    let rest = items.map((i) => ({ item: i, area: i.value * scale }));
    let rx = x, ry = y, rw = w, rh = hgt;
    const worst = (row, side) => {
      const s = row.reduce((a, r) => a + r.area, 0);
      const mx = Math.max(...row.map((r) => r.area)), mn = Math.min(...row.map((r) => r.area));
      return Math.max((side * side * mx) / (s * s), (s * s) / (side * side * mn));
    };
    while (rest.length) {
      const side = Math.min(rw, rh);
      let row = [rest[0]];
      let i = 1;
      while (i < rest.length && worst([...row, rest[i]], side) <= worst(row, side)) { row.push(rest[i]); i++; }
      rest = rest.slice(row.length);
      const sum = row.reduce((a, r) => a + r.area, 0);
      if (rw >= rh) {
        const colw = sum / rh; let cy = ry;
        for (const r of row) { const ih = r.area / colw; out.push({ ...r.item, x: rx, y: cy, w: colw, h: ih }); cy += ih; }
        rx += colw; rw -= colw;
      } else {
        const rowh = sum / rw; let cx = rx;
        for (const r of row) { const iw = r.area / rowh; out.push({ ...r.item, x: cx, y: ry, w: iw, h: rowh }); cx += iw; }
        ry += rowh; rh -= rowh;
      }
    }
    return out;
  }

  function groups() {
    const by = new Map(H.data ? H.data.map((d) => [d.ticker, d]) : []);
    if (H.universe === 'market') {
      return Object.entries(SAMPLE).map(([name, m]) => ({ name, tiles: Object.entries(m).map(([t, cap]) => ({ ticker: t, value: cap, d: by.get(t) })) }));
    }
    const view = TD.getListView('heatmap', 'both');
    const heldQ = new Map((TD.state.holdings.positions || []).map((p) => [p.ticker, Number(p.quantity) || 0]));
    const list = TD.tickersFor(view);
    const heldTiles = [], watchTiles = [];
    for (const it of list) {
      const d = by.get(it.ticker);
      if (it.held) { const px = d && d.ok ? d.price : 0; heldTiles.push({ ticker: it.ticker, value: Math.max(heldQ.get(it.ticker) * px, 0) || 1, d }); } else watchTiles.push({ ticker: it.ticker, value: 0, d });
    }
    // Watchlist-only tiles have no position, so they share a modest equal size next to the holdings.
    const avg = heldTiles.length ? heldTiles.reduce((a, t) => a + t.value, 0) / heldTiles.length : 1;
    watchTiles.forEach((t) => { t.value = Math.max(avg * 0.6, 1); });
    const out = [];
    if (heldTiles.length) out.push({ name: 'Holdings', tiles: heldTiles });
    if (watchTiles.length) out.push({ name: 'Watchlist', tiles: watchTiles });
    return out;
  }

  function tickerSet() {
    if (H.universe === 'market') return [...new Set([...INDEXES.map((x) => x[0]), ...Object.values(SAMPLE).flatMap((m) => Object.keys(m))])];
    return TD.tickersFor(TD.getListView('heatmap', 'both')).map((x) => x.ticker);
  }

  function layout(stage) {
    clear(stage);
    const W = stage.clientWidth, HT = stage.clientHeight;
    if (W < 50 || HT < 50) return;
    const gs = groups().filter((g) => g.tiles.length);
    if (!gs.length) { stage.append(h('div', { class: 'hint pad' }, H.universe === 'market' ? 'No tickers.' : 'Nothing to show. Add holdings or watchlist tickers first.')); return; }
    const sized = gs.map((g) => ({ ...g, value: g.tiles.reduce((a, t) => a + t.value, 0) })).sort((a, b) => b.value - a.value);
    const boxes = squarify(sized, 0, 0, W, HT);
    for (const b of boxes) {
      const g = h('div', { class: 'hm-group', dataset: { sector: b.name } });
      const hd = 16;
      const showHead = b.h > 46 && b.w > 70;
      g.style.left = `${b.x}px`; g.style.top = `${b.y}px`; g.style.width = `${b.w}px`; g.style.height = `${b.h}px`;
      if (showHead) g.append(h('div', { class: 'hm-head' }, b.name));
      const inner = squarify(b.tiles.slice().sort((p, q) => q.value - p.value), 1, showHead ? hd : 1, b.w - 2, b.h - (showHead ? hd : 1) - 1);
      for (const t of inner) {
        const v = t.d && t.d.ok ? t.d[H.period] : null;
        const tile = h('button', { type: 'button', class: `hm-tile ${bucket(v, H.period)}`, dataset: { ticker: t.ticker },
          title: `${t.ticker}: ${fmt(v)} over ${PERIODS.find((p) => p[0] === H.period)[1]}. Click to open in Analyze.`,
          'aria-label': `${t.ticker}, ${fmt(v)}, open in Analyze`, onclick: () => TD.openAnalyze(t.ticker) });
        tile.style.left = `${t.x}px`; tile.style.top = `${t.y}px`; tile.style.width = `${Math.max(t.w - 1, 0)}px`; tile.style.height = `${Math.max(t.h - 1, 0)}px`;
        if (t.w > 34 && t.h > 22) tile.append(h('span', { class: 'hm-t' }, t.ticker));
        if (t.w > 52 && t.h > 38) tile.append(h('span', { class: 'hm-v' }, fmt(v)));
        g.append(tile);
      }
      stage.append(g);
    }
  }

  TD.pages.heatmap = function (el) {
    const stage = h('div', { class: 'hm-stage', id: 'hmstage' });
    const status = h('div', { class: 'hint', id: 'hmstatus', 'aria-live': 'polite' });
    const idx = h('div', { class: 'hm-idx', id: 'hmidx' });
    const legend = h('div', { class: 'hm-legend', id: 'hmlegend' });
    const ctl = h('div', { class: 'row center wrap' });

    const paintLegend = () => {
      clear(legend);
      const s = STEP[H.period];
      legend.append(h('span', { class: 'hint' }, 'Colour scale:'));
      [['neg3', `−${3 * s}% or lower`], ['neg1', `−${s}%`], ['neg0', 'down a little'], ['pos0', 'up a little'], ['pos1', `+${s}%`], ['pos3', `+${3 * s}% or higher`]]
        .forEach(([c, l]) => legend.append(h('span', { class: 'hm-key' }, h('span', { class: `hm-sw ${c}` }), l)));
      legend.append(h('span', { class: 'hint' }, 'Grey means no price was returned.'));
    };
    const paintIdx = () => {
      clear(idx);
      if (H.universe !== 'market' || !H.data) return;
      const by = new Map(H.data.map((d) => [d.ticker, d]));
      INDEXES.forEach(([t, name]) => { const d = by.get(t); const v = d && d.ok ? d[H.period] : null;
        idx.append(h('span', { class: `hm-ix ${bucket(v, H.period)}`, title: `${t} tracks ${name}` }, h('b', null, name), ` ${fmt(v)}`)); });
    };
    const paint = () => { paintIdx(); paintLegend(); layout(stage); };

    const load = async (force) => {
      const list = tickerSet();
      H.error = '';
      if (!list.length) { H.data = []; paint(); status.textContent = ''; return; }
      status.textContent = `Fetching ${list.length} prices from Yahoo Finance…`;
      H.loading = true;
      const r = await td.heatmap({ tickers: list, force: !!force });
      H.loading = false;
      if (!document.body.contains(stage)) return;
      if (!r.ok) { H.error = r.error; status.textContent = ''; clear(stage).append(h('div', { class: 'callout bad', id: 'hmerr' }, r.error)); return; }
      H.data = r.items;
      const bad = r.items.filter((x) => !x.ok).length;
      const asof = r.items.find((x) => x.ok);
      status.textContent = `Prices as of the last close on ${asof ? asof.asof : 'n/a'}${r.cached ? ' (saved a moment ago)' : ''}.${bad ? ` ${bad} ticker${bad > 1 ? 's' : ''} had no data.` : ''}`;
      paint();
    };

    const seg = (items, cur, set, idp) => h('div', { class: 'listsel', role: 'group' }, items.map(([v, l]) => h('button', { type: 'button', id: `${idp}-${v}`, class: 'rng' + (v === cur ? ' active' : ''), 'aria-pressed': String(v === cur), onclick: () => set(v) }, l)));
    const drawCtl = () => {
      clear(ctl);
      ctl.append(...[
        seg([['market', 'Large US stocks'], ['mine', 'My holdings and watchlist']], H.universe, (v) => { H.universe = v; H.data = null; drawCtl(); load(false); }, 'hmu'),
        seg(PERIODS, H.period, (v) => { H.period = v; drawCtl(); paint(); }, 'hmp'),
        H.universe === 'mine' ? TD.listSelector('heatmap', TD.getListView('heatmap', 'both'), () => { H.data = null; drawCtl(); load(false); }) : null,
        h('div', { class: 'spacer' }),
        h('button', { class: 'btn small', type: 'button', id: 'hmrefresh', onclick: () => load(true) }, 'Refresh')].filter(Boolean));
    };
    drawCtl();

    el.append(h('div', { class: 'card compact hm-card' },
      h('h2', null, 'Market heat map'),
      h('div', { class: 'sub' }, H.universe === 'market'
        ? 'A fixed sample of about 100 large US companies, grouped by sector. Tile size is a rough company size, not a live market value. The sample is not an index and leaves many companies out.'
        : 'Your own tickers. Holdings are sized by what you hold; watchlist tickers get a modest equal size. Click a tile to open it in Analyze.'),
      ctl, idx, stage, legend, status,
      h('div', { class: 'hint' }, 'Colour shows the price change over the period, and the number is printed on every tile large enough to hold it. Prices come from Yahoo Finance, are not live, and may lag. A colour is a description of what already happened, not a signal.')));

    let timer = 0;
    if (window.ResizeObserver) new ResizeObserver(() => { clearTimeout(timer); timer = setTimeout(() => { if (H.data) layout(stage); }, 80); }).observe(stage);
    if (H.data && !H.error) paint();
    load(false);
  };
})();
