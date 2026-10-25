'use strict';
// Track record: what the model said and how it turned out. Journal (live calls) and Backtest (past dates).
(function () {
  const { h, clear } = U;
  let tab = 'journal';

  TD.pages.track = function (el) {
    const body = h('div', { id: 'trackbody' });
    const t = TD.tabs([{ id: 'journal', label: 'Journal' }, { id: 'backtest', label: 'Backtest' }], tab, (id) => { tab = id; paint(); });
    el.append(t.bar, body);
    function paint() {
      clear(body);
      t.paint(tab);
      const link = tab === 'journal'
        ? h('div', { class: 'crosslink' }, 'Not sure this model is any good? ', h('button', { class: 'btn link', onclick: () => { tab = 'backtest'; paint(); } }, 'Run a backtest →'))
        : h('div', { class: 'crosslink' }, 'Want to see how your real analyses turned out? ', h('button', { class: 'btn link', onclick: () => { tab = 'journal'; paint(); } }, 'Open the journal →'));
      const inner = h('div');
      body.append(link, inner);
      if (tab === 'journal') TD.renderJournal(inner); else TD.renderBacktest(inner);
    }
    paint();
  };
})();
