'use strict';
// The launch notice (shown every time the app opens) and the "How it works" page.
(function () {
  const { h, $, clear } = U;

  const POINTS = [
    'TradeDesk is a research tool. Nothing it shows is a recommendation, an offer, or advice to buy, sell or hold anything.',
    'The analysis is written by language models. They can be wrong, can invent facts, and can sound sure when they should not. Check anything that matters against primary sources.',
    'Market data, news and company figures come from third parties (mainly Yahoo Finance) and may be late, incomplete or wrong.',
    'Past results, including backtests and your own track record, do not predict future results. A small number of decisions proves very little.',
    'TradeDesk never places trades or touches your accounts. Any decision to buy or sell is yours alone, and so are the gains, the losses and the tax.',
    'The people who built and share TradeDesk are not financial advisers and accept no responsibility for decisions you make or for losses you suffer. It is provided as is, without warranty.',
  ];

  TD.showTerms = function () {
    return new Promise((resolve) => {
      const ok = h('input', { type: 'checkbox', id: 'termsok' });
      const go = h('button', { class: 'btn primary', id: 'termsgo', disabled: true, onclick: () => { TD.closeModal(); resolve(); } }, 'Continue');
      ok.addEventListener('change', () => { go.disabled = !ok.checked; });
      TD.modal(
        h('h2', null, 'Before you use TradeDesk'),
        h('div', { class: 'callout warn' }, h('b', null, 'This is not a trading recommendation. '), 'It helps you think. You decide.'),
        h('ul', { class: 'terms' }, POINTS.map((p) => h('li', null, p))),
        h('div', { class: 'hint' }, 'Read the longer version under How it works in the sidebar. Laws differ by country; you are responsible for following the ones that apply to you.'),
        h('label', { class: 'check termscheck', for: 'termsok' }, ok, 'I have read this. I understand TradeDesk gives no financial advice and that every decision is mine.'),
        h('div', { class: 'row center', style: { marginTop: '14px' } }, h('div', { class: 'spacer' }), h('button', { class: 'btn', id: 'termsquit', onclick: () => td.quit() }, 'Quit'), go));
      TD.modalLocked = true;
      $('#modal').classList.add('locked');
    });
  };

  const sec = (title, ...kids) => h('div', { class: 'card' }, h('h2', null, title), ...kids);

  TD.pages.how = function (el) {
    el.append(
      sec('What TradeDesk does',
        h('p', null, 'You give it a ticker and a date. A team of language-model "agents" then researches it: four analysts (market, sentiment, news, fundamentals), a bull and a bear who argue, a research manager, a trader, a three-sided risk debate and finally a portfolio manager who gives one of five ratings: Buy, Overweight, Hold, Underweight or Sell.'),
        h('p', null, 'TradeDesk adds your holdings so the rating can tell adding to a position from opening one, then writes a short briefing: what is being asked of you, and the reasons on each side.'),
        h('p', { class: 'hint' }, 'The research engine is the open-source TradingAgents framework by TauricResearch (Apache-2.0). TradeDesk is a separate desktop app around it and is not affiliated with that project.')),
      sec('How to read a result',
        h('ul', { class: 'md-ul' },
          h('li', null, h('b', null, 'Rating. '), 'A leaning, not a prediction. Buy and Sell are strong; Overweight and Underweight are mild; Hold means no change.'),
          h('li', null, h('b', null, 'Decision for you. '), 'Plain words built by fixed rules from the rating, what you hold and your cash. It states the choice. It never sizes a trade.'),
          h('li', null, h('b', null, 'Reasons for and against. '), 'Written by your model from its own reports. Each reason carries a quote; TradeDesk checks the quote really appears in the reports and drops any that does not. A checked quote shows the reason came from the reports, not that the reason is true.'),
          h('li', null, h('b', null, 'This model\'s record. '), 'How the same rating did in your backtests on this model. Treat fewer than about 20 calls as an anecdote.'),
          h('li', null, h('b', null, 'Depth. '), 'Fast uses two analysts and one debate round. Standard follows Setup. Thorough uses all four analysts and two rounds. Slower runs are not proven better; compare them in the Track record.'))),
      sec('Where numbers come from',
        h('ul', { class: 'md-ul' },
          h('li', null, 'Prices, ranges, statistics and headlines: Yahoo Finance through the open-source yfinance library. Their terms limit it to personal use. Data to be confirmed for splits and dividends.'),
          h('li', null, 'The holdings chart values the positions you hold today at past closing prices. It is not your account history.'),
          h('li', null, 'Analyst target, P/E, beta and similar figures are Yahoo\'s, not TradeDesk\'s.'),
          h('li', null, 'Your holdings, journal and settings stay in a folder on this computer. Language-model calls go to the model you chose in Setup: local models stay on your machine; cloud models send the research text to that provider.'))),
      sec('Limits you should know',
        h('ul', { class: 'md-ul' },
          h('li', null, 'Language models can produce confident text that is wrong. A briefing that quotes its sources is easier to check, not guaranteed correct.'),
          h('li', null, 'Backtests may be flattered because a model could have seen the period when it was trained, and old news and filings are not archived.'),
          h('li', null, 'Small local models are weaker at tools and structured output. Run the model check in Setup and read the result.'),
          h('li', null, 'Taxes, fees, liquidity, your goals and your circumstances are not part of the analysis.'))),
      sec('Terms of use',
        h('ol', { class: 'md-ul' }, POINTS.map((p) => h('li', null, p))),
        h('p', { class: 'hint' }, 'If you share TradeDesk with others, they are bound by the same points. This page is a plain-language notice and is not legal advice.')));
  };
})();
