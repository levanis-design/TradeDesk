'use strict';
// Shared pieces: the saved-analysis viewer, holdings import/paste flows, and the Journal and Backtest views used by Track record.
(function () {
  const { h, $, clear, toast, money, pct, qty, duration } = U;

  // ---------------------------------------------------------- entry viewer
  TD.viewEntry = async function (id) {
    const r = await td.journalGet({ id });
    if (!r.ok) return toast(r.error, 'error');
    TD.modal(
      TD.renderResult({ entry: r.entry, result: r.result, position: r.position }, {}),
      h('div', { class: 'row', style: { marginTop: '8px' } }, h('div', { class: 'spacer' }), h('button', { class: 'btn', onclick: TD.closeModal }, 'Close')));
  };

  const FIELD_LABELS = {
    ticker: 'Ticker or symbol', quantity: 'Units or shares', avgPrice: 'Average cost per unit (Purchase Price)', totalCost: 'Total cost (if no per-unit column)',
    price: 'Current price', marketValue: 'Current total (market value)', pnl: 'Profit or loss', boughtAt: 'Bought at (date)', account: 'Account',
  };

  // Paste a table copied from Excel or Google Sheets, header row included.
  TD.pasteFlow = pasteFlow;
  TD.importFlow = importFlow;
  function pasteFlow(onDone) {
    const ta = h('textarea', { rows: 10, spellcheck: false, placeholder: 'Stock\tQTY\tCurrent Price\tPurchase Price\tCurrent total\tBought At\tProfit/Loss\nNVDA\t10\t180.50\t120.00\t1805.00\t3/14/2024\t605.00', style: { width: '100%', fontFamily: 'ui-monospace, Consolas, monospace', fontSize: '12px' } });
    const go = h('button', { class: 'btn primary', onclick: async () => {
      const r = await td.pasteHoldings({ text: ta.value });
      if (!r.ok) return toast(r.error, 'error');
      TD.closeModal();
      importFlow(null, onDone, r);
    } }, 'Read this table');
    TD.modal(h('h2', null, 'Paste from your spreadsheet'),
      h('div', { class: 'hint', style: { marginBottom: '8px' } }, 'In Excel or Google Sheets select the table, including the header row, copy it, and paste it here. You get a preview and can fix the column matching before anything is saved.'),
      ta, h('div', { class: 'row center', style: { marginTop: '12px' } }, h('div', { class: 'spacer' }), h('button', { class: 'btn', onclick: TD.closeModal }, 'Cancel'), go));
  }

  async function importFlow(parent, onDone, preloaded) {
    const r = preloaded || await td.pickHoldings();
    if (!r.ok) return toast(r.error, 'error');
    if (r.canceled) return;
    let sheet = r.sheets.findIndex((s) => s.preview.ok);
    if (sheet < 0) sheet = 0;
    let mapping = r.sheets[sheet].preview.mapping;
    let headerRow = r.sheets[sheet].preview.headerRow;
    let preview = r.sheets[sheet].preview;
    const cash = h('input', { type: 'number', step: 'any', min: 0, style: { width: '240px' } });
    const area = h('div');
    const modeSel = h('select', null, h('option', { value: 'replace' }, 'Replace all my holdings'), h('option', { value: 'merge' }, 'Add to my current holdings'));
    const commit = h('button', { class: 'btn primary', onclick: async () => {
      const c = await td.commitHoldings({ token: r.token, sheet, mapping, headerRow, cash: cash.value, mode: modeSel.value });
      if (!c.ok) return toast(c.error, 'error');
      TD.state.holdings = c.holdings; TD.closeModal(); onDone(c.holdings); toast(`Imported ${c.holdings.positions.length} positions.`, 'ok');
    } }, 'Import these positions');

    const refresh = async () => {
      const p = await td.previewHoldings({ token: r.token, sheet, mapping, headerRow });
      if (!p.ok) return toast(p.error, 'error');
      preview = p.preview; paintArea();
    };
    const paintArea = () => {
      clear(area);
      commit.disabled = !preview.ok || !preview.positions.length;
      if (r.sheets.length > 1) {
        area.append(h('div', { class: 'field', style: { maxWidth: '300px', marginBottom: '10px' } }, h('label', null, 'Sheet'),
          h('select', { onchange: (e) => { sheet = Number(e.target.value); mapping = r.sheets[sheet].preview.mapping; headerRow = r.sheets[sheet].preview.headerRow; preview = r.sheets[sheet].preview; paintArea(); } },
            r.sheets.map((s) => h('option', { value: s.index, selected: s.index === sheet }, `${s.name} (${s.rows} rows)`)))));
      }
      const headers = preview.headers || [];
      area.append(h('div', { class: 'row', style: { marginBottom: '10px' } },
        Object.entries(FIELD_LABELS).map(([f, label]) => h('div', { class: 'field' }, h('label', null, label),
          h('select', { onchange: (e) => { const v = e.target.value; mapping = { ...mapping }; if (v === '') delete mapping[f]; else mapping[f] = Number(v); refresh(); } },
            h('option', { value: '' }, '— none —'), headers.map((c, i) => h('option', { value: i, selected: mapping[f] === i }, c || `(column ${i + 1})`))))),
        h('div', { class: 'field' }, h('label', null, 'Header row'), h('input', { type: 'number', min: 1, value: headerRow + 1, style: { width: '80px' }, onchange: (e) => { headerRow = Math.max(0, Number(e.target.value) - 1); mapping = undefined; refresh(); } }))));
      if (!preview.ok) { area.append(h('div', { class: 'callout bad' }, preview.error)); return; }
      (preview.warnings || []).forEach((w) => area.append(h('div', { class: 'callout warn' }, w)));
      area.append(h('div', { class: 'tablewrap', style: { maxHeight: '280px' } }, h('table', { class: 'list' },
        h('thead', null, h('tr', null, ['Ticker', 'Units', 'Average cost', 'Last price', 'Bought', 'Accounts'].map((t) => h('th', null, t)))),
        h('tbody', null, preview.positions.map((p) => h('tr', null, h('td', null, h('b', null, p.ticker)), h('td', null, qty(p.quantity)), h('td', null, p.averagePrice != null ? money(p.averagePrice) : '—'),
          h('td', null, p.lastPrice != null ? money(p.lastPrice) : '—'), h('td', null, p.boughtAt || '—'),
          h('td', { class: 'summary-cell' }, Object.entries(p.accounts).map(([a, q]) => `${a} ${qty(q)}`).join(', '))))))));
      if (preview.skipped.length) area.append(h('details', { style: { marginTop: '8px' } }, h('summary', null, `${preview.skipped.length} row${preview.skipped.length === 1 ? '' : 's'} skipped`),
        h('div', { class: 'hint' }, preview.skipped.map((s) => `Row ${s.row}: ${s.ticker || '(blank)'} — ${s.reason}`).join('\n').split('\n').map((l) => h('div', null, l)))));
      area.append(h('div', { class: 'hint', style: { marginTop: '8px' } }, preview.cash != null ? `Cash found in the file: ${money(preview.cash)}. It will be used unless you enter an override below.` : 'No cash row found in the file. You can enter cash below or on the Holdings page.'));
      cash.placeholder = preview.cash != null ? `${preview.cash} (found in file)` : 'optional';
    };
    paintArea();
    TD.modal(h('h2', null, `Import ${r.file}`),
      h('div', { class: 'hint', style: { marginBottom: '10px' } }, 'Check that each column is matched correctly. Nothing is saved until you press Import.'),
      area,
      h('div', { class: 'row center', style: { marginTop: '12px' } }, h('div', { class: 'field' }, h('label', null, 'Cash override (optional)'), cash), h('div', { class: 'field' }, h('label', null, 'When importing'), modeSel), h('div', { class: 'spacer' }),
        h('button', { class: 'btn', onclick: TD.closeModal }, 'Cancel'), commit));
  }

  // --------------------------------------------------------------- journal
  let scored = null;
  TD.renderJournal = async function (el) {
    const r = await td.journal();
    if (!r.ok) return el.append(h('div', { class: 'callout bad' }, r.error));
    const entries = r.entries;
    const filter = h('input', { type: 'text', placeholder: 'Filter by ticker', style: { width: '160px' } });
    const scoreBtn = h('button', { class: 'btn primary', 'data-needs-idle': '', onclick: async () => {
      scoreBtn.disabled = true; scoreBtn.textContent = 'Fetching prices…';
      const s = await td.journalScore();
      scoreBtn.disabled = false; scoreBtn.textContent = 'Score outcomes';
      if (!s.ok) return toast(s.error, 'error');
      scored = s; paintAll();
    } }, 'Score outcomes');
    const head = h('div', { class: 'card' }, h('h2', null, 'Decision journal'),
      h('div', { class: 'sub' }, 'Every analysis is kept here. Scoring compares each call with how the stock actually moved against the benchmark, from the first close after the analysis date.'),
      h('div', { class: 'row center' }, scoreBtn, h('div', { class: 'spacer' }), filter));
    const summary = h('div');
    const table = h('div', { class: 'card' });
    el.append(head, summary, table);

    function paintAll() {
      clear(summary);
      if (scored && scored.rows.length) {
        const a = scored.aggregate;
        summary.append(h('div', { class: 'card' }, h('h2', null, `Track record against ${scored.benchmark}`),
          h('div', { class: 'stats' },
            stat(a.scored, 'scored decisions'), stat(a.hitRate == null ? '—' : `${Math.round(a.hitRate * 100)}%`, 'direction called right'),
            stat(a.meanAlpha == null ? '—' : pct(a.meanAlpha), 'average edge vs benchmark'), stat(a.pending, 'too early to score'), stat(a.noData, 'no price data')),
          a.caution ? h('div', { class: 'callout warn' }, a.caution) : null,
          a.byRating.length ? h('div', { class: 'tablewrap' }, h('table', { class: 'list' }, h('thead', null, h('tr', null, ['Rating', 'Decisions', 'Direction right', 'Average edge'].map((t) => h('th', null, t)))),
            h('tbody', null, a.byRating.map((x) => h('tr', null, h('td', null, U.ratingBadge(x.rating)), h('td', null, x.n), h('td', null, x.hitRate == null ? 'no direction claimed' : `${Math.round(x.hitRate * 100)}%`), h('td', { class: x.meanAlpha >= 0 ? 'pos' : 'neg' }, pct(x.meanAlpha))))))) : null,
          adherenceBlock(scored.adherence),
          h('div', { class: 'hint', style: { marginTop: '8px' } }, 'Edge is the stock\'s return minus the benchmark\'s over the same days. Hold calls claim no direction, so they are not counted as right or wrong.')));
      }
      paintTable();
    }
    function adherenceBlock(ad) {
      if (!ad.followed.n && !ad.notFollowed.n) return h('div', { class: 'hint', style: { marginTop: '8px' } }, 'Record what you did on each analysis and this will compare following the rating with not following it.');
      const line = (label, g) => h('tr', null, h('td', null, label), h('td', null, g.n), h('td', null, g.scored), h('td', { class: g.meanAlpha >= 0 ? 'pos' : 'neg' }, g.meanAlpha == null ? '—' : pct(g.meanAlpha)));
      return h('div', { class: 'tablewrap', style: { marginTop: '10px' } }, h('table', { class: 'list' }, h('thead', null, h('tr', null, ['What you did', 'Decisions', 'Scored', 'Average edge of the call'].map((t) => h('th', null, t)))),
        h('tbody', null, line('Followed the rating', ad.followed), line('Went against it', ad.notFollowed))));
    }
    const stat = (v, k) => h('div', { class: 'stat' }, h('div', { class: 'v' }, String(v)), h('div', { class: 'k' }, k));

    function paintTable() {
      clear(table);
      const f = filter.value.trim().toUpperCase();
      const list = entries.filter((e) => !f || e.ticker.includes(f));
      table.append(h('h2', null, `${list.length} analys${list.length === 1 ? 'is' : 'es'}`));
      if (!list.length) { table.append(h('div', { class: 'empty-note' }, entries.length ? 'No match.' : 'Nothing yet. Run an analysis and it appears here.')); return; }
      const byId = scored ? Object.fromEntries(scored.rows.map((x) => [x.id, x])) : {};
      table.append(h('div', { class: 'tablewrap' }, h('table', { class: 'list' },
        h('thead', null, h('tr', null, ['Date', 'Ticker', 'Rating', 'You did', 'Outcome', 'Summary', ''].map((t) => h('th', null, t)))),
        h('tbody', null, list.map((e) => {
          const s = byId[e.id];
          return h('tr', { class: 'clickable', onclick: (ev) => { if (!ev.target.closest('button')) TD.viewEntry(e.id); } },
            h('td', null, e.date), h('td', null, h('b', null, e.ticker), e.held ? h('span', { class: 'badge plain', style: { marginLeft: '6px' } }, 'held') : null),
            h('td', null, U.ratingBadge(e.rating)), h('td', null, e.action ? e.action.type : '—'), h('td', null, outcome(s)),
            h('td', { class: 'summary-cell' }, e.summary || ''),
            h('td', { class: 'num' }, h('button', { class: 'btn small', onclick: async () => {
              if (!confirm(`Delete the ${e.ticker} analysis from ${e.date}?`)) return;
              const d = await td.journalDelete({ id: e.id }); if (d.ok) { entries.splice(0, entries.length, ...d.entries); paintAll(); }
            } }, 'Delete')));
        })))));
    }
    function outcome(s) {
      if (!s) return h('span', { class: 'hint' }, 'not scored');
      if (s.status === 'scored') return h('span', { class: s.alpha >= 0 ? 'pos' : 'neg', title: `Return ${pct(s.return)} vs benchmark ${pct(s.benchReturn)} over ${s.days} trading days` },
        `${pct(s.alpha)} edge`, s.hit === true ? ' ✓' : s.hit === false ? ' ✗' : '');
      if (s.status === 'too-early') return h('span', { class: 'hint' }, s.note);
      return h('span', { class: 'hint' }, s.note || s.status);
    }
    filter.addEventListener('input', paintTable);
    paintAll();
  };

  // -------------------------------------------------------------- backtest
  let bt = { running: false, progress: null, result: null, error: null };
  let bRoot = null;
  const bMounted = () => bRoot && document.body.contains(bRoot);
  TD.onJob((msg) => {
    if (msg.kind !== 'backtest') return;
    if (msg.ev.type === 'progress') { bt.progress = msg.ev; if (bMounted()) paintBt(); }
  });

  TD.renderBacktest = async function (el) {
    bRoot = el;
    const tk = h('input', { type: 'text', placeholder: 'NVDA, GOOG, AVGO', style: { width: '260px' }, id: 'btk' });
    const start = h('input', { type: 'date', id: 'bstart', max: U.today() });
    const end = h('input', { type: 'date', id: 'bend', max: U.today(), value: U.today() });
    const every = h('input', { type: 'number', min: 1, max: 60, value: 7, style: { width: '80px' }, id: 'bevery' });
    const d0 = new Date(); d0.setDate(d0.getDate() - 56); start.value = `${d0.getFullYear()}-${String(d0.getMonth() + 1).padStart(2, '0')}-${String(d0.getDate()).padStart(2, '0')}`;
    const est = h('div', { class: 'hint', id: 'best' });
    const j = await td.backtests();
    const median = j.ok ? j.medianSeconds : null;
    const cells = () => {
      const t = tk.value.split(',').map((x) => x.trim()).filter(Boolean).length;
      const s = new Date(start.value); const e = new Date(end.value); const step = Math.max(1, Number(every.value) || 7);
      if (!t || isNaN(s) || isNaN(e) || e < s) return 0;
      return t * (Math.floor((e - s) / 86400000 / step) + 1);
    };
    const upd = () => {
      const c = cells();
      clear(est).append(c ? `${c} analyses. ${median ? `At your recent pace of ${duration(median)} each, about ${duration(median * c)}.` : 'Time per analysis is not known yet; run a single analysis first to get an estimate.'}` : 'Enter tickers and a valid range.');
    };
    [tk, start, end, every].forEach((x) => x.addEventListener('input', upd));
    upd();
    const run = h('button', { class: 'btn primary', 'data-needs-idle': '', onclick: async () => {
      const nr = TD.notReady(); if (nr) return toast(nr, 'error');
      const c = cells();
      if (!c) return toast('Enter tickers and a valid date range.', 'error');
      if (c > 12 && !confirm(`This will run ${c} full analyses${median ? `, roughly ${duration(median * c)}` : ''}. Continue?`)) return;
      bt = { running: true, progress: null, result: null, error: null };
      TD.setRunning('backtest'); paintBt();
      const r = await td.backtest({ tickers: tk.value.split(',').map((x) => x.trim()).filter(Boolean), start: start.value, end: end.value, every: Number(every.value) });
      TD.setRunning(null); bt.running = false;
      if (r.canceled) bt.error = 'Cancelled.'; else if (!r.ok) bt.error = r.error; else bt.result = r.result;
      paintBt();
    } }, 'Run backtest');
    el.append(h('div', { class: 'card' }, h('h2', null, 'Backtest'),
      h('div', { class: 'sub' }, 'Run the agents on past dates, then see how their ratings did against the benchmark. Do this before trusting a model with real decisions.'),
      h('div', { class: 'row' }, h('div', { class: 'field' }, h('label', { for: 'btk' }, 'Tickers (comma separated)'), tk), h('div', { class: 'field' }, h('label', null, 'From'), start),
        h('div', { class: 'field' }, h('label', null, 'To'), end), h('div', { class: 'field' }, h('label', null, 'Every N days'), every), run),
      h('div', { style: { marginTop: '8px' } }, est),
      h('div', { class: 'callout warn', style: { marginTop: '12px' } }, 'Read the results with care. A model may have seen the period in its training data, news and filings are not archived, and a few dozen decisions prove very little. The last days before today cannot be scored yet.')));
    el.append(h('div', { id: 'bres' }));
    paintBt();
    if (j.ok && j.runs.length) el.append(h('div', { class: 'card' }, h('h2', null, 'Earlier backtests'), h('div', { class: 'tablewrap' }, h('table', { class: 'list' },
      h('thead', null, h('tr', null, ['Run', 'Tickers', 'Range', 'Every', 'Resolved', 'Pending', 'Model'].map((t) => h('th', null, t)))),
      h('tbody', null, j.runs.map((b) => h('tr', null, h('td', null, new Date(b.createdAt).toLocaleDateString()), h('td', null, b.tickers.join(', ')), h('td', null, `${b.start} to ${b.end}`), h('td', null, `${b.every} d`), h('td', null, b.resolved), h('td', null, b.pending), h('td', { class: 'summary-cell' }, b.model))))))));
  };

  function paintBt() {
    if (!bMounted()) return;
    const box = clear($('#bres'));
    if (bt.running) {
      const p = bt.progress;
      box.append(h('div', { class: 'card' }, h('h2', null, 'Running'), h('div', { class: 'bar', style: { margin: '8px 0' } }, h('span', { style: { width: p ? `${((p.done - 1) / p.total) * 100}%` : '2%' } })),
        h('div', { class: 'hint' }, p ? `Analysis ${p.done} of ${p.total}: ${p.ticker} on ${p.date}` : 'Starting…')));
    } else if (bt.error) box.append(h('div', { class: 'callout bad' }, bt.error));
    else if (bt.result) {
      const r = bt.result;
      box.append(h('div', { class: 'card' }, h('h2', null, 'Result'),
        h('div', { class: 'stats' }, [[r.cells_run, 'analyses run'], [r.resolved, 'scored'], [r.pending, 'pending'], [r.failures.length, 'failed']].map(([v, k]) => h('div', { class: 'stat' }, h('div', { class: 'v' }, String(v)), h('div', { class: 'k' }, k)))),
        Object.keys(r.by_rating).length ? h('div', { class: 'tablewrap' }, h('table', { class: 'list' }, h('thead', null, h('tr', null, ['Rating', 'Decisions', 'Direction right', 'Average edge'].map((t) => h('th', null, t)))),
          h('tbody', null, Object.entries(r.by_rating).map(([k, v]) => h('tr', null, h('td', null, U.ratingBadge(k)), h('td', null, v.count), h('td', null, v.hit_rate == null ? 'no direction claimed' : `${Math.round(v.hit_rate * 100)}%`), h('td', { class: v.mean_alpha >= 0 ? 'pos' : 'neg' }, pct(v.mean_alpha))))))) : h('div', { class: 'empty-note' }, 'Nothing was scored yet. Recent dates need a few trading days to pass.'),
        r.failures.length ? h('details', null, h('summary', null, `${r.failures.length} failed`), r.failures.map((f) => h('div', { class: 'hint' }, `${f[0]} ${f[1]}: ${f[2]}`))) : null,
        h('pre', { class: 'hint', style: { whiteSpace: 'pre-wrap', marginTop: '10px' } }, r.text)));
    }
  }
})();
