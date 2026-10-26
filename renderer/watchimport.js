'use strict';
// Upload or paste a watchlist: ticker, price, Strong Buy, Good Buy, Acceptable, Avoid and why it is a priority.
// Used from the Watchlist and from Analyze. Nothing is saved until Import is pressed.
(function () {
  const { h, clear, toast, money } = U;
  const HEAD = ['Ticker', "Today's price", 'Strong Buy', 'Good Buy', 'Acceptable', 'Avoid', "Why it's priority"];

  TD.watchImportFlow = function (onDone) {
    const ta = h('textarea', { rows: 8, id: 'wiPaste', spellcheck: false, placeholder: `${HEAD.join('\t')}\nNVDA\t182.50\tunder 150\t150-170\t170-190\t250\tAI demand`, style: { width: '100%', fontFamily: 'ui-monospace, Consolas, monospace', fontSize: '12px' } });
    const fromFile = async () => { const r = await td.pickWatch(); if (!r.ok) return toast(r.error, 'error'); if (r.canceled) return; preview(r); };
    const fromPaste = async () => { const r = await td.pasteWatch({ text: ta.value }); if (!r.ok) return toast(r.error, 'error'); preview(r); };
    TD.modal(h('h2', null, 'Upload a watchlist'),
      h('div', { class: 'hint', style: { marginBottom: '8px' } }, `Use an Excel or CSV file, or paste a table from a spreadsheet. Name the columns in the first row: ${HEAD.join(', ')}. Only Ticker is required, and the other columns can be left out or empty. Column names are matched by wording, so "Price" or "Symbol" also work.`),
      h('div', { class: 'row center' }, h('button', { class: 'btn primary', id: 'wiFile', onclick: fromFile }, 'Choose Excel or CSV file'), h('span', { class: 'hint' }, 'or paste below')),
      h('div', { style: { marginTop: '10px' } }, ta),
      h('div', { class: 'row center', style: { marginTop: '12px' } }, h('div', { class: 'spacer' }), h('button', { class: 'btn', onclick: TD.closeModal }, 'Cancel'), h('button', { class: 'btn primary', id: 'wiRead', onclick: fromPaste }, 'Read this table')));

    function preview(r) {
      const p = r.preview;
      const today = U.today();
      const date = h('input', { type: 'date', id: 'wiDate', max: today, 'aria-label': 'Date of the prices in the list' });
      const mode = h('select', { id: 'wiMode' }, h('option', { value: 'merge' }, 'Add to my watchlist and update tickers already on it'), h('option', { value: 'replace' }, 'Replace my watchlist (holdings are not touched)'));
      const go = h('button', { class: 'btn primary', id: 'wiGo', onclick: async () => {
        const c = await td.commitWatch({ token: r.token, mode: mode.value, listDate: date.value });
        if (!c.ok) return toast(c.error, 'error');
        TD.state.watch = c.items;
        try { window.localStorage.setItem('tradedesk.listview.analyze', 'watch'); window.localStorage.setItem('tradedesk.listview.watchlist', 'watch'); } catch { /* not remembered */ }
        TD.closeModal(); toast(`${c.added} ticker${c.added === 1 ? '' : 's'} imported. Showing your watchlist.`, 'ok'); if (onDone) onDone(c.items);
      } }, `Import ${p.total} ticker${p.total === 1 ? '' : 's'}`);
      const cell = (v) => h('td', null, v || '—');
      TD.modal(h('h2', null, `Upload ${r.file}`),
        h('div', { class: 'hint', style: { marginBottom: '8px' } }, 'Check the columns that were found. Nothing is saved until you press Import.'),
        h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } }, p.columns.map((c) => h('span', { class: 'badge ok', title: `Your column "${c.header}"` }, `${c.label}`))),
        p.missing.length ? h('div', { class: 'hint', id: 'wiMissing', style: { margin: '6px 0' } }, `Not in your file: ${p.missing.join(', ')}. Those stay empty.`) : null,
        ...(p.warnings || []).map((w) => h('div', { class: 'callout warn small' }, w)),
        h('div', { class: 'tablewrap', style: { maxHeight: '260px', marginTop: '8px' } }, h('table', { class: 'list', id: 'wiTable' },
          h('thead', null, h('tr', null, HEAD.map((t) => h('th', null, t)))),
          h('tbody', null, p.items.slice(0, 50).map((i) => h('tr', null, h('td', null, h('b', null, i.ticker)), h('td', { class: 'num' }, i.price != null ? money(i.price) : '—'), cell(i.strongBuy), cell(i.goodBuy), cell(i.acceptable), cell(i.avoid), h('td', { class: 'summary-cell' }, i.why || '—')))))),
        p.total > 50 ? h('div', { class: 'hint' }, `Showing the first 50 of ${p.total}. All are imported.`) : null,
        p.skipped.length ? h('details', { style: { marginTop: '8px' } }, h('summary', null, `${p.skipped.length} row${p.skipped.length === 1 ? '' : 's'} skipped`), h('div', { class: 'hint' }, p.skipped.map((s) => h('div', null, s)))) : null,
        h('div', { class: 'row', style: { marginTop: '12px' } },
          h('div', { class: 'field' }, h('label', { for: 'wiDate' }, 'Date of the prices (leave blank for today)'), date),
          h('div', { class: 'field grow' }, h('label', { for: 'wiMode' }, 'When importing'), mode)),
        h('div', { class: 'hint' }, 'For an older list, choose the date it was made. The Watchlist then compares the price in the file, or the closing price on that date when the file has none, with today\'s price. A zone is compared with the price only when it is a number or a range such as "100-120" or "under 90"; a single number counts as "at or below" for the three buy zones and "at or above" for Avoid. Text is shown as written.'),
        h('div', { class: 'row center', style: { marginTop: '12px' } }, h('button', { class: 'btn', onclick: () => TD.watchImportFlow(onDone) }, 'Back'), h('div', { class: 'spacer' }), h('button', { class: 'btn', onclick: TD.closeModal }, 'Cancel'), go));
    }
  };
})();
