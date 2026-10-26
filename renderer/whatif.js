'use strict';
// What if I invest X: a scenario calculator limited to money you already hold as cash.
// It shows what an amount could lose and what the price did before, and sets out options with the risk each one carries.
// It never says how much to invest and never ranks the options.
(function () {
  const { h, clear } = U;
  const W = { ticker: '', amount: '', limit: '', exit: '', months: '3', result: null };
  const DROPS = [0.1, 0.2, 0.3, 0.5, 1];

  const cashOnHand = () => {
    const s = TD.state.settings || {};
    if (s.cashOverride !== '' && s.cashOverride != null && Number.isFinite(Number(s.cashOverride))) return Number(s.cashOverride);
    const c = (TD.state.holdings || {}).cash;
    return typeof c === 'number' && Number.isFinite(c) ? c : null;
  };
  const m0 = (n) => U.money(n, 0);
  const p1 = (v) => (typeof v === 'number' ? `${(v * 100).toFixed(1)}%` : '—');
  const neg = (v) => (typeof v !== 'number' ? '—' : v >= 0 ? '0.0%' : `−${Math.abs(v * 100).toFixed(1)}%`);
  const signed = (v) => (typeof v === 'number' ? `${v < 0 ? '−' : '+'}${Math.abs(v * 100).toFixed(1)}%` : '—');
  const stat = (k, v, cls) => h('div', { class: 'stat' }, h('div', { class: `v ${cls || ''}` }, v), h('div', { class: 'k' }, k));
  const card = (id, title, ...kids) => h('div', { class: 'card', id }, h('h2', null, title), ...kids);

  TD.pages.whatif = function (el) {
    const held = (TD.state.holdings.positions || []).map((p) => p.ticker);
    const cash = cashOnHand();
    const tk = h('input', { type: 'text', id: 'wiTicker', class: 'ticker', value: W.ticker, placeholder: 'AAPL', list: 'wiList' });
    const list = h('datalist', { id: 'wiList' }, [...new Set([...held, ...(TD.state.watch || []).map((w) => w.ticker)])].map((t) => h('option', { value: t })));
    const amt = h('input', { type: 'number', id: 'wiAmount', step: 'any', min: 0, value: W.amount, placeholder: 'amount', style: { width: '140px' } });
    const lim = h('input', { type: 'number', id: 'wiLimit', step: 'any', min: 0, value: W.limit, placeholder: 'optional', style: { width: '140px' } });
    const ext = h('input', { type: 'number', id: 'wiExit', step: 'any', min: 0, value: W.exit, placeholder: 'optional', style: { width: '140px' } });
    const mo = h('select', { id: 'wiMonths' }, [1, 3, 6, 12].map((m) => h('option', { value: m }, m === 12 ? '12 months' : `${m} month${m > 1 ? 's' : ''}`)));
    mo.value = W.months;
    const go = h('button', { class: 'btn primary', id: 'wiGo', onclick: run }, 'Show the risks');
    const out = h('div', { id: 'wiOut' });

    el.append(
      h('div', { class: 'card compact' },
        h('h2', null, 'What if I invest an amount in a stock?'),
        h('div', { class: 'sub' }, 'A scenario calculator, not advice. It uses only cash you already hold, so nothing here is borrowed. It shows what the amount could lose and what the price did before, then sets out options and the risk each one carries. It does not tell you what to do or how much.'),
        h('div', { class: 'stats' }, stat('Cash you hold', cash == null ? 'not set' : m0(cash)), stat('Positions you hold', String(held.length))),
        cash == null ? h('div', { class: 'callout warn', id: 'wiNoCash' }, 'Your cash is not set. Add it on the Holdings page (or under Setup, Cash), because this page only models money you already hold.') : null,
        h('div', { class: 'row' },
          h('div', { class: 'field' }, h('label', { for: 'wiTicker' }, 'Stock'), tk, list),
          h('div', { class: 'field' }, h('label', { for: 'wiAmount' }, 'Amount to invest'), amt),
          h('div', { class: 'field' }, h('label', { for: 'wiLimit' }, 'Most I could accept losing'), lim),
          h('div', { class: 'field' }, h('label', { for: 'wiExit' }, 'Exit price I would use'), ext),
          h('div', { class: 'field' }, h('label', { for: 'wiMonths' }, 'How long I would hold'), mo), go)),
      out);
    [tk, amt, lim, ext].forEach((i) => i.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); }));
    if (W.result) paint(out, W.result);

    async function run() {
      W.ticker = tk.value.trim().toUpperCase(); W.amount = amt.value; W.limit = lim.value; W.exit = ext.value; W.months = mo.value;
      const amount = Number(W.amount); const limit = Number(W.limit) || null; const exit = Number(W.exit) || null;
      const c = cashOnHand();
      clear(out);
      if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(W.ticker)) return out.append(h('div', { class: 'callout warn' }, 'Enter a stock ticker.'));
      if (!(amount > 0)) return out.append(h('div', { class: 'callout warn' }, 'Enter an amount above zero.'));
      if (c == null) return out.append(h('div', { class: 'callout warn' }, 'Set your cash first. This page only models money you already hold.'));
      if (amount > c) return out.append(h('div', { class: 'callout bad', id: 'wiOver' }, `${m0(amount)} is more than the ${m0(c)} of cash you hold. This page models only money you already have, so it does not run. Enter a smaller amount, or update your cash if it is out of date.`));
      const busy = TD.notReady();
      if (busy) return out.append(h('div', { class: 'callout warn' }, busy));
      go.disabled = true; out.append(h('div', { class: 'hint' }, 'Reading five years of prices…'));
      try {
        const q = await TD.quote([W.ticker, 'SPY'], { years: 5 });
        const item = q[W.ticker];
        if (!item || !item.ok) throw new Error((item && item.error) || `No price history for ${W.ticker}.`);
        let filings = null;
        if (TD.state.settings && TD.state.settings.secUserAgent) {
          const f = await td.filings({ tickers: [W.ticker], forms: ['8-K'], days: 45 }).catch(() => null);
          if (f && f.ok) filings = f.items;
        }
        W.result = { ticker: W.ticker, amount, limit, exit, months: Number(W.months), cash: c, item, bench: q.SPY && q.SPY.ok ? q.SPY : null, filings, positions: (TD.state.holdings.positions || []).map((p) => ({ ...p })), prices: TD.priceMap() };
        clear(out); paint(out, W.result);
      } catch (e) {
        clear(out).append(h('div', { class: 'callout bad' }, e.message));
      } finally { go.disabled = false; }
    }
  };

  function paint(out, R) {
    const closes = R.item.history.map((r) => r[1]);
    const st = Risk.stats(closes);
    const price = R.item.price;
    const horizon = R.months * Risk.MONTH;
    const wt = Risk.weights({ ticker: R.ticker, amount: R.amount, positions: R.positions, cash: R.cash, prices: R.prices });
    const portfolio = wt.total;
    if (!st) { out.append(h('div', { class: 'callout warn' }, `${R.ticker} has too little price history to measure how it behaved.`)); }

    // 1. where this puts you
    out.append(card('wiWhere', 'What this amount is, for you',
      h('div', { class: 'stats' },
        stat('Amount', m0(R.amount)),
        stat('Share of your cash', p1(R.amount / R.cash)),
        stat('Cash left', m0(wt.cashAfter)),
        stat('Share of your portfolio', portfolio > 0 ? p1(R.amount / portfolio) : '—'),
        stat(`${R.ticker} as a share of the portfolio`, wt.afterWeight == null ? '—' : `${p1(wt.before)} now, ${p1(wt.afterWeight)} after`)),
      wt.afterWeight != null && wt.afterWeight > 0.25 ? h('div', { class: 'callout warn small' }, `${R.ticker} would be about ${Math.round(wt.afterWeight * 100)}% of the portfolio. When one company is that large a share, its bad news moves the whole portfolio noticeably.`) : null,
      wt.largestOther && wt.largestOther.weight > wt.afterWeight ? null : (wt.largestOther ? h('div', { class: 'hint' }, `That would make ${R.ticker} larger than your biggest other holding (${wt.largestOther.ticker}, ${p1(wt.largestOther.weight)}).`) : null),
      wt.unpriced ? h('div', { class: 'hint warn' }, `${wt.unpriced} position${wt.unpriced > 1 ? 's have' : ' has'} no price, so the portfolio total is understated.`) : null));

    // 2. if the price falls
    const sc = Risk.scenarios(R.amount, DROPS, { cash: R.cash, portfolio });
    out.append(card('wiFalls', 'If the price falls',
      h('div', { class: 'sub' }, 'Plain arithmetic on your amount. These are not predictions: they show the size of a loss so you can judge it against what you can bear.'),
      h('div', { class: 'tablewrap' }, h('table', { class: 'list', id: 'wiFallTable' },
        h('thead', null, h('tr', null, ['If the price falls', 'You lose', 'Of the amount is left', 'As a share of your cash', 'As a share of your portfolio'].map((x, k) => h('th', { class: k ? 'num' : '' }, x)))),
        h('tbody', null, sc.map((r) => h('tr', null, h('th', { scope: 'row' }, r.drop === 1 ? 'To zero (the company fails)' : `${Math.round(r.drop * 100)}%`),
          h('td', { class: 'num neg' }, `−${m0(r.loss)}`), h('td', { class: 'num' }, m0(r.left)), h('td', { class: 'num' }, p1(r.ofCash)), h('td', { class: 'num' }, p1(r.ofPortfolio)))))))));

    // 3. what it did before
    if (st) {
      const wins = Risk.windowReturns(closes, horizon);
      const p05 = Risk.percentile(wins, 0.05); const p50 = Risk.percentile(wins, 0.5); const p95 = Risk.percentile(wins, 0.95);
      const sameYears = st.years.toFixed(1);
      const rb = R.bench ? Risk.rebase(R.item.history, R.bench.history) : null;
      out.append(card('wiHistory', `What ${R.ticker} did over the last ${sameYears} years`,
        h('div', { class: 'stats' },
          stat('Worst single day', neg(st.worstDay), 'neg'), stat('Worst 21 trading days', neg(st.worstMonth), 'neg'),
          stat('Largest fall from a peak', neg(st.maxDrawdown), 'neg'), stat('Typical yearly swing', p1(st.annualVol))),
        wins.length ? h('div', null, h('h3', null, `Every ${R.months}-month stretch in that period (${wins.length.toLocaleString('en-US')} overlapping windows)`),
          h('div', { class: 'tablewrap' }, h('table', { class: 'list', id: 'wiWindows' }, h('thead', null, h('tr', null, ['', 'Return', `On ${m0(R.amount)}`].map((x, k) => h('th', { class: k ? 'num' : '' }, x)))),
            h('tbody', null, [['1 in 20 stretches ended below', p05], ['The middle stretch ended at', p50], ['1 in 20 stretches ended above', p95]].map(([label, v]) => h('tr', null, h('th', { scope: 'row' }, label), h('td', { class: `num ${v < 0 ? 'neg' : 'pos'}` }, signed(v)), h('td', { class: `num ${v < 0 ? 'neg' : 'pos'}` }, `${v < 0 ? '−' : '+'}${m0(Math.abs(R.amount * v))}`))))))) : h('div', { class: 'hint' }, 'Too little history for stretches this long.'),
        rb ? h('div', null, h('h3', null, `${R.ticker} against the S&P 500 over the last year`), TDCharts.compare({ series: [{ name: R.ticker, points: rb.a }, { name: 'SPY', points: rb.b }], height: 200, name: `${R.ticker} and SPY price change over the last year` })) : null,
        h('div', { class: 'hint' }, 'This is what happened, not what will. Overlapping windows are not independent samples, one period may have been unusually calm or rough, and a company can change. Prices are Yahoo Finance closes and are not adjusted for splits or dividends.')));
    }

    // 4. their own limit
    if (R.limit) {
      const L = Risk.lossLimit(R.amount, R.limit, closes);
      out.append(card('wiLimitCard', `Your limit of ${m0(R.limit)}`,
        L.covers ? h('div', { class: 'callout small' }, `Your limit is at least the whole amount, so even a total loss stays inside it.`)
          : h('div', null, h('div', { class: 'row center' }, stat('Fall that uses up your limit', neg(L.fall), 'neg'), stat('Price at that level', price ? U.money(price * (1 - L.fall)) : '—')),
            h('div', { class: 'tablewrap' }, h('table', { class: 'list', id: 'wiLimitTable' }, h('thead', null, h('tr', null, ['Within', 'How often a fall that big happened', 'Out of'].map((x, k) => h('th', { class: k ? 'num' : '' }, x)))),
              h('tbody', null, L.frequencies.map((f) => h('tr', null, h('th', { scope: 'row' }, f.days >= 252 ? '12 months' : `${Math.round(f.days / 21)} month${f.days > 21 ? 's' : ''}`),
                h('td', { class: 'num' }, f.share == null ? '—' : p1(f.share)), h('td', { class: 'num' }, f.windows ? `${f.windows.toLocaleString('en-US')} start days` : '—'))))))),
        h('div', { class: 'hint' }, 'Counted as: starting on any past day, did the price touch this level within the period. It describes the past of this one stock, and a loss limit is only as good as your willingness to act when it is reached.')));
    }

    // 5. exit
    if (R.exit) {
      const E = price ? Risk.exitRisk({ amount: R.amount, price, exit: R.exit, worstDay: st && st.worstDay }) : null;
      out.append(card('wiExitCard', `If you exit at ${U.money(R.exit)}`,
        !E ? h('div', { class: 'hint' }, 'No current price, so this cannot be worked out.') : E.invalid ? h('div', { class: 'callout warn small' }, `The exit price must be below the current price (${U.money(price)}).`)
          : h('div', null, h('div', { class: 'stats' }, stat('Current price', U.money(price)), stat('Fall to the exit', neg(E.fall), 'neg'), stat('Loss if sold there', `−${m0(E.loss)}`, 'neg'), stat('Loss as a share of your cash', p1(E.loss / R.cash))),
            E.gapLoss && E.gapLoss > E.loss * 1.05 ? h('div', { class: 'callout warn small' }, `A price can jump past an exit level, for example after bad news overnight. This stock's worst day in the period was ${neg(st.worstDay)}, which on this amount would be a loss of about ${m0(E.gapLoss)}.`) : null),
        h('div', { class: 'hint' }, 'Nothing here places an order. An exit price only helps if you are there to use it.')));
    }

    // 6. dates and filings
    const next = R.item.nextEarnings;
    const important = (R.filings || []).filter((f) => f.important);
    out.append(card('wiEvents', 'Things that can move the price',
      next ? h('div', { class: 'row center' }, h('span', { class: 'badge warn' }, 'Earnings'), h('span', null, `Next report expected ${next}. `), h('span', { class: 'hint' }, next <= horizonEnd(horizon) ? 'That falls inside the period you chose.' : 'That is after the period you chose.'))
        : h('div', { class: 'hint' }, 'No earnings date on file for this stock (data to be confirmed).'),
      R.filings == null ? h('div', { class: 'hint' }, 'Add your SEC contact under Setup to also list this company’s recent filings here.')
        : important.length ? h('div', null, h('h3', null, 'Recent filings of the kind that often matter'), h('ul', null, important.slice(0, 5).map((f) => h('li', null, `${new Date(f.time).toISOString().slice(0, 10)}: ${f.items.filter((x) => x.important).map((x) => x.label).join(', ') || f.title}`))))
          : h('div', { class: 'hint' }, 'No major filings in the last 45 days.')));

    // 7. options
    out.append(optionsCard(R, closes, st, sc, horizon));

    // 8. questions
    out.append(card('wiQuestions', 'Questions only you can answer',
      h('ul', null, [
        'When will I need this money back? A fall can take years to recover, and some do not.',
        'If this lost 30% next month, would I hold, sell or add, and have I decided that now rather than then?',
        `Do I already own ${R.ticker} through a fund or through my other holdings?`,
        'What is my reason for this stock, and what would make me drop it?',
        'Is this money I could leave alone for the whole period without needing it?']
        .map((q) => h('li', null, q)))));

    out.append(h('div', { class: 'hint', id: 'wiFoot' }, 'Scenario calculator. It uses your inputs and past prices only. It makes no forecast, gives no recommended amount, and places no orders. News, earnings and the wider market can change a price in ways past data does not show.'));
  }

  const horizonEnd = (days) => { const d = new Date(); d.setDate(d.getDate() + Math.round(days * 365 / 252)); return d.toISOString().slice(0, 10); };

  // Options are listed in a fixed order and never ranked. Each says what it does, what it guards against and what risk remains.
  function optionsCard(R, closes, st, sc, horizon) {
    const a = R.amount;
    const at = (d) => sc.find((r) => r.drop === d);
    const split = Risk.lumpVsSplit(closes, { parts: 6, gap: Risk.MONTH });
    const bstat = R.bench ? Risk.stats(R.bench.history.map((r) => r[1])) : null;
    const opt = (id, title, does, guards, left) => h('div', { class: 'option', id }, h('h3', null, title),
      h('div', { class: 'optrow' }, h('strong', null, 'What it does. '), does),
      h('div', { class: 'optrow' }, h('strong', null, 'Risk it reduces. '), guards),
      h('div', { class: 'optrow' }, h('strong', null, 'Risk that remains or is added. '), left));
    const cards = [];
    cards.push(opt('wiOptAll', 'Invest the whole amount now',
      `Puts ${m0(a)} in at today’s price.`, 'Nothing is left waiting, so you are not out of the market if the price rises.',
      `All of it is exposed from day one: a 20% fall costs ${m0(at(0.2).loss)} and a 50% fall ${m0(at(0.5).loss)}. If the price drops right after you buy, there is no later, cheaper purchase.`));
    cards.push(opt('wiOptSplit', 'Invest in six equal parts, one a month',
      `Buys ${m0(a / 6)} a month for six months.`, 'Lowers the chance that everything is bought at a short-term high.',
      split ? `In ${split.windows.toLocaleString('en-US')} past six-month stretches of this stock, investing all at once ended ahead of splitting in ${p1(split.lumpAheadShare)} of them and behind in ${p1(1 - split.lumpAheadShare)}. In the worst 1 in 20, all at once ended at ${signed(split.lump.p05)} (${m0(Math.abs(a * split.lump.p05))} ${split.lump.p05 < 0 ? 'lost' : 'gained'}) and splitting at ${signed(split.split.p05)} (${m0(Math.abs(a * split.split.p05))} ${split.split.p05 < 0 ? 'lost' : 'gained'}). Money waiting earns nothing here and the price can rise while you wait.`
        : 'Not enough history to compare this for this stock.'));
    cards.push(opt('wiOptSmaller', 'Invest a smaller amount',
      `Puts in ${m0(a / 2)} (half) and keeps ${m0(a / 2)} as cash.`, `Halves the size of every loss: a 20% fall would cost ${m0(at(0.2).loss / 2)} and a 50% fall ${m0(at(0.5).loss / 2)}.`,
      'Halves any gain too, and the cash that stays idle can lose buying power to inflation. The smaller amount is still all in one company.'));
    cards.push(opt('wiOptIndex', 'Use a broad index fund instead of one company',
      'Buys a fund that holds many companies, such as one that follows the S&P 500.', 'Spreads the risk of a single company failing or having bad news.',
      bstat && st ? `A broad fund still falls with the market: the S&P 500 (SPY) had a largest fall of ${neg(bstat.maxDrawdown)} and a worst 21 days of ${neg(bstat.worstMonth)} over the same period, against ${neg(st.maxDrawdown)} and ${neg(st.worstMonth)} for ${R.ticker}. You also give up the chance of beating the market with one stock.` : 'It still falls with the market, and you give up the chance of beating it with one stock.'));
    cards.push(opt('wiOptWait', 'Keep the cash',
      `Leaves ${m0(a)} where it is.`, 'No price risk on this amount.',
      'You may miss a rise, inflation slowly reduces what the cash buys, and nothing guarantees a lower price later. The cost of waiting cannot be known in advance.'));
    return h('div', { class: 'card', id: 'wiOptions' }, h('h2', null, 'Options and the risk each one carries'),
      h('div', { class: 'sub' }, 'These are choices people consider, listed in no order of preference. None is recommended, and doing nothing is one of them. The figures use this stock’s own past, so treat them as a guide to size, not a promise.'),
      ...cards);
  }
})();
