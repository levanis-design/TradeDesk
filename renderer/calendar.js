'use strict';
// Market calendar: dated events that can move prices. Company dates and the Fed, inflation and jobs schedule come from
// the engine. Anything with no fixed date in a public feed (product events, conferences) is added by hand.
(function () {
  const { h, clear, toast } = U;
  const KINDS = {
    earnings: 'Company results', dividend: 'Dividends', fed: 'Federal Reserve', macro: 'Economic data', expiry: 'Options expiry', custom: 'Your events',
  };
  const IMPACT = { high: 'High impact', medium: 'Medium impact', low: 'Low impact' };
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  const SHAPE = { earnings: 'circle', dividend: 'ring', fed: 'square', macro: 'diamond', expiry: 'triangle', custom: 'bar' };
  const S = { days: 90, hidden: new Set(), mine: false, month: null, day: null, data: null, custom: null, loading: false, err: null, gen: 0, sel: null, move: null };
  const MACRO_SHORT = [[/consumer price/i, 'CPI'], [/jobs report|employment/i, 'Jobs'], [/producer price/i, 'PPI'], [/job openings|jolts/i, 'JOLTS']];
  // Short text for a day cell: who or what, since the shape and colour already say the type.
  const shortLabel = (e) => {
    if (e.kind === 'earnings' || e.kind === 'dividend') return e.ticker || KINDS[e.kind];
    if (e.kind === 'fed') return 'Fed';
    if (e.kind === 'expiry') return 'Expiry';
    if (e.kind === 'macro') { const m = MACRO_SHORT.find(([re]) => re.test(e.title)); return m ? m[1] : 'Data'; }
    return e.title.length > 12 ? e.title.slice(0, 11) + '…' : e.title;
  };
  const marker = (kind) => h('span', { class: `dot k-${kind} sh-${SHAPE[kind] || 'circle'}`, 'aria-hidden': 'true' });
  const evKey = (e) => `${e.kind}|${e.ticker || ''}|${e.date}|${e.title}`;
  const shortDate = (d) => new Date(d + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const todayIso = () => iso(new Date());
  const prettyDate = (d) => new Date(d + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const tickersToWatch = () => [...new Set([...(TD.state.holdings.positions || []).map((p) => p.ticker), ...(TD.state.watch || []).map((w) => w.ticker)].filter(Boolean))].slice(0, 40);

  TD.pages.calendar = function (el) {
    TD.renderCalendar(el);
  };
  TD.renderCalendar = function (el) {
    const gen = ++S.gen;
    const root = h('div', { class: 'cal', id: 'calroot' });
    el.append(root);
    if (!S.month) S.month = todayIso().slice(0, 7);

    async function load(force) {
      if (!(TD.state.info || {}).engineInstalled) { S.err = 'The engine is not installed, so market events cannot be fetched. Open Setup.'; paint(); return; }
      S.loading = true; S.err = null; paint();
      try {
        const [r, c] = await Promise.all([td.calendar({ tickers: tickersToWatch(), days: S.days, back: 365, force: !!force }), td.events()]);
        if (!r.ok) throw new Error(r.error);
        S.data = r; S.custom = c.ok ? c.events : [];
      } catch (e) { S.err = e.message; }
      S.loading = false;
      if (gen === S.gen && document.body.contains(root)) paint();
    }

    const allEvents = () => {
      const fetched = (S.data && S.data.events) || [];
      const mine = (S.custom || []).map((e) => ({ ...e, kind: 'custom', source: 'you' }));
      const held = new Set((TD.state.holdings.positions || []).map((p) => p.ticker));
      const watch = new Set((TD.state.watch || []).map((w) => w.ticker));
      return fetched.concat(mine).filter((e) => !S.hidden.has(e.kind) && (!S.mine || e.ticker && (held.has(e.ticker) || watch.has(e.ticker)) || e.kind === 'custom'))
        .sort((a, b) => a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || ''));
    };

    function paint() {
      clear(root);
      const evs = allEvents();
      root.append(controls());
      if (S.err) root.append(h('div', { class: 'callout warn' }, S.err));
      if (S.loading) root.append(h('div', { class: 'hint' }, 'Fetching events…'));
      if (S.data && S.data.notes && S.data.notes.length) root.append(h('div', { class: 'callout small' }, S.data.notes.map((n) => h('div', null, n))));
      // Three panes that can be dragged: month and agenda side by side, the market-move panel underneath. Each scrolls inside its own frame.
      const stage = h('div', { class: 'calstage', id: 'calstage' });
      const top = h('div', { class: 'caltop', id: 'caltop' });
      const monthEl = monthCard(evs); const agendaEl = agendaCard(evs);
      top.append(monthEl, TD.splitter({ dir: 'col', grid: top, prop: '--calc', first: () => monthEl, min: 320, minOther: 240, id: 'cal-cols', label: 'Resize the month and the agenda' }), agendaEl);
      stage.append(top, TD.splitter({ dir: 'row', grid: stage, prop: '--calr', first: () => top, min: 200, minOther: 160, id: 'cal-rows', label: 'Resize the calendar and what the market did' }), movePanel(evs));
      root.append(stage);
      root.append(h('div', { class: 'hint' }, `${S.data ? `Fetched ${new Date(S.data.fetchedAt).toLocaleTimeString()}. ` : ''}Company dates come from Yahoo Finance, the Fed schedule from federalreserve.gov (2027 dates are tentative until the Fed confirms them), inflation and jobs releases from the Bureau of Labor Statistics, option expiry is calculated. Product launches, conferences and other announcements with no fixed date are not in any free feed, so add the ones you care about yourself. This is a list of dates, not a forecast of what the price will do.`));
    }

    function controls() {
      const days = h('select', { id: 'caldays', 'aria-label': 'How far ahead', onchange: (e) => { S.days = Number(e.target.value); S.day = null; load(false); } },
        [[30, 'Next 30 days'], [90, 'Next 90 days'], [180, 'Next 6 months'], [365, 'Next year']].map(([v, l]) => h('option', { value: v }, l)));
      days.value = String(S.days);
      const chips = Object.entries(KINDS).map(([k, label]) => h('button', { class: `kchip k-${k}` + (S.hidden.has(k) ? '' : ' on'), type: 'button', 'aria-pressed': String(!S.hidden.has(k)), dataset: { kind: k },
        onclick: () => { if (S.hidden.has(k)) S.hidden.delete(k); else S.hidden.add(k); paint(); } }, label));
      return h('div', { class: 'card compact calctl' },
        h('div', { class: 'row center' }, h('div', { class: 'field' }, h('label', { for: 'caldays' }, 'Look ahead'), days),
          h('label', { class: 'check' }, h('input', { type: 'checkbox', id: 'calmine', checked: S.mine, onchange: (e) => { S.mine = e.target.checked; paint(); } }), 'Only my holdings and watchlist'),
          h('div', { class: 'spacer' }),
          h('button', { class: 'btn', onclick: () => load(true), disabled: S.loading }, 'Refresh'),
          h('button', { class: 'btn primary', onclick: () => addForm() }, 'Add an event')),
        h('div', { class: 'kchips' }, chips));
    }

    function monthCard(evs) {
      const [y, m] = S.month.split('-').map(Number);
      const first = new Date(y, m - 1, 1);
      const offset = (first.getDay() + 6) % 7;
      const dim = new Date(y, m, 0).getDate();
      const byDay = {};
      evs.forEach((e) => { (byDay[e.date] = byDay[e.date] || []).push(e); });
      const cells = [];
      for (let i = 0; i < offset; i++) cells.push(h('div', { class: 'cc empty' }));
      const t = todayIso();
      for (let d = 1; d <= dim; d++) {
        const date = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const list = byDay[date] || [];
        const worst = list.some((e) => e.impact === 'high') ? 'high' : list.length ? 'other' : '';
        const shown = list.slice(0, 3);
        cells.push(h('button', { class: 'cc' + (date === t ? ' today' : '') + (date === S.day ? ' sel' : '') + (date < t ? ' past' : '') + (worst ? ` has-${worst}` : ''), type: 'button', dataset: { date },
          'aria-label': `${prettyDate(date)}${date < t ? ', past' : ''}: ${list.length ? list.map((e) => e.title).join('; ') : 'no events'}`,
          title: list.map((e) => `${e.title}${e.time ? ` (${e.time} Eastern)` : ''}`).join('\n') || undefined,
          onclick: () => pickDay(date, byDay[date] || []) },
        h('span', { class: 'dn' }, String(d)),
        h('span', { class: 'clabels' }, shown.map((e) => h('span', { class: `clab k-${e.kind}${S.sel && evKey(S.sel) === evKey(e) ? ' on' : ''}` }, marker(e.kind), h('span', { class: 'ct' }, shortLabel(e))))),
        list.length > 3 ? h('span', { class: 'more' }, `+${list.length - 3} more`) : null));
      }
      const go = (n) => { const d = new Date(y, m - 1 + n, 1); S.month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; S.day = null; paint(); };
      const legend = h('div', { class: 'callegend', 'aria-label': 'What the markers mean' },
        Object.entries(KINDS).map(([k, label]) => h('span', { class: 'lg' }, marker(k), label)),
        h('span', { class: 'lg' }, h('span', { class: 'ringkey', 'aria-hidden': 'true' }), 'High-impact day'),
        h('span', { class: 'lg' }, h('span', { class: 'pastkey', 'aria-hidden': 'true' }), 'Past day'));
      return h('div', { class: 'card' },
        h('div', { class: 'row center' }, h('h2', null, `${MONTHS[m - 1]} ${y}`), h('div', { class: 'spacer' }),
          h('button', { class: 'btn small', 'aria-label': 'Previous month', onclick: () => go(-1) }, '‹'),
          h('button', { class: 'btn small', onclick: () => { S.month = todayIso().slice(0, 7); S.day = null; paint(); } }, 'Today'),
          h('button', { class: 'btn small', 'aria-label': 'Next month', onclick: () => go(1) }, '›')),
        h('div', { class: 'cgrid' }, DOW.map((d) => h('div', { class: 'dow' }, d)), cells),
        legend,
        h('div', { class: 'hint' }, 'Each day lists up to three events: the shape and colour give the type, the text says who or what. Select a day to see its events. Select a past day to see how the market moved.'));
    }

    // A past day with events opens the first one in the market-move section below.
    function pickDay(date, list) {
      S.day = S.day === date ? null : date;
      if (S.day && date <= todayIso() && list.length) selectEvent(list[0], false); else if (!S.day) { S.sel = null; S.move = null; }
      paint();
    }

    function agendaCard(evs) {
      const t = todayIso();
      const list = S.day ? evs.filter((e) => e.date === S.day) : evs.filter((e) => e.date >= t || e.kind === 'custom' && e.date >= t);
      const card = h('div', { class: 'card agenda' }, h('div', { class: 'row center' }, h('h2', null, S.day ? prettyDate(S.day) : 'Coming up'), h('div', { class: 'spacer' }),
        S.day ? h('button', { class: 'btn small', onclick: () => { S.day = null; S.sel = null; S.move = null; paint(); } }, 'Show all') : null));
      if (!list.length) { card.append(h('div', { class: 'empty-note' }, S.loading ? 'Loading…' : S.day ? 'Nothing listed for this day.' : 'No events in this window with the filters you have set.')); return card; }
      let lastDate = null;
      const box = h('div', { class: 'evlist' });
      list.slice(0, 200).forEach((e) => {
        if (e.date !== lastDate) { lastDate = e.date; box.append(h('div', { class: 'evdate' }, S.day ? '' : prettyDate(e.date))); }
        box.append(eventRow(e));
      });
      card.append(box);
      return card;
    }

    function eventRow(e) {
      const pos = e.ticker ? TD.positionFor(e.ticker) : null;
      const weight = pos ? window.Portfolio.weightOf(e.ticker, TD.state.holdings.positions || [], TD.state.holdings.cash, TD.priceMap()) : null;
      const happened = e.date <= todayIso();
      const row = h('div', { class: `ev k-${e.kind} imp-${e.impact}` + (S.sel && evKey(S.sel) === evKey(e) ? ' sel' : ''), dataset: { kind: e.kind, date: e.date } },
        h('div', { class: 'evhead', onclick: (ev) => { if (ev.target.closest('button')) return; row.classList.toggle('open'); } },
          marker(e.kind),
          h('span', { class: `kbadge k-${e.kind}` }, KINDS[e.kind] || e.kind),
          h('b', null, e.title),
          h('span', { class: `impact ${e.impact}` }, IMPACT[e.impact] || ''),
          h('span', { class: 'hint' }, [e.time ? `${e.time} Eastern` : '', e.date < todayIso() ? 'past' : ''].filter(Boolean).join(', '))),
        e.detail ? h('div', { class: 'evdetail' }, e.detail) : null,
        h('div', { class: 'evfoot hint' },
          pos ? `You hold ${U.qty(pos.quantity)} ${e.ticker}${weight != null ? `, about ${(weight * 100).toFixed(0)}% of what you hold` : ''}. ` : '',
          happened ? h('button', { class: 'btn link movebtn', onclick: () => { selectEvent(e, true); paint(); } }, 'See market move') : null,
          e.ticker ? h('button', { class: 'btn link', onclick: () => TD.openAnalyze(e.ticker) }, `Analyse ${e.ticker}`) : null,
          h('span', null, ` Source: ${e.source}.`),
          e.kind === 'custom' ? h('button', { class: 'btn link', onclick: () => removeCustom(e.id) }, 'Remove') : null));
      return row;
    }

    // ---- bottom section: what the market did around the selected event
    const symbolsFor = (e) => (e.ticker ? (e.ticker === 'SPY' ? ['SPY', 'QQQ'] : [e.ticker, 'SPY']) : ['SPY', 'QQQ']);
    function selectEvent(e, scroll) {
      S.sel = e;
      const key = evKey(e);
      S.move = { key, loading: true, data: null, err: null };
      if (e.date > todayIso()) { S.move = { key, loading: false, data: null, err: null, future: true }; return; }
      td.eventMove({ symbols: symbolsFor(e), date: e.date, time: e.time || '' }).then((r) => {
        if (!S.move || S.move.key !== key) return;
        S.move.loading = false;
        if (r.ok) S.move.data = r; else S.move.err = r.error;
        if (gen === S.gen && document.body.contains(root)) { paint(); if (scroll) { const p = root.querySelector('#movepanel'); if (p && p.scrollIntoView) p.scrollIntoView({ block: 'nearest' }); } }
      }).catch((er) => { if (S.move && S.move.key === key) { S.move.loading = false; S.move.err = er.message; if (gen === S.gen && document.body.contains(root)) paint(); } });
    }

    const arrow = (v) => (typeof v !== 'number' ? '' : v > 0 ? '▲ ' : v < 0 ? '▼ ' : '');
    const mv = (v, extra) => h('span', { class: typeof v !== 'number' ? 'hint' : v >= 0 ? 'pos' : 'neg' }, typeof v === 'number' ? `${arrow(v)}${U.pct(v)}` : '—', extra || null);
    const TIMING = {
      before_open: (e) => `Announced at ${e.time} Eastern, before the market opened, so the reaction is in the opening gap and the same day.`,
      during: (e) => `Announced at ${e.time} Eastern, while the market was open. The intraday figures below start at that time.`,
      after_close: (e) => `Announced at ${e.time} Eastern, after the market closed, so the reaction shows on the next trading day.`,
      unknown: () => 'No announcement time on file. Companies report before the open or after the close, so the day itself and the next day are both shown.',
    };

    function movePanel(evs) {
      const card = h('div', { class: 'card movecard', id: 'movepanel' }, h('h2', null, 'What the market did'));
      const e = S.sel;
      if (!e) {
        const t = todayIso();
        const recent = evs.filter((x) => x.date <= t && x.kind !== 'expiry').sort((a, b) => b.date.localeCompare(a.date)).slice(0, 10);
        card.append(h('div', { class: 'sub' }, 'Select a past date or event above to see how prices moved when it was announced or took place.'));
        if (recent.length) card.append(h('div', { class: 'recent' }, h('span', { class: 'hint' }, 'Recent events: '), recent.map((x) => h('button', { class: 'btn small recentbtn', type: 'button', onclick: () => { S.month = x.date.slice(0, 7); S.day = x.date; selectEvent(x, true); paint(); } }, marker(x.kind), `${shortDate(x.date)} ${shortLabel(x)}`))));
        else card.append(h('div', { class: 'empty-note' }, S.loading ? 'Loading events…' : 'No past events are listed with the filters you have set.'));
        return card;
      }
      const m = S.move || {};
      card.append(h('div', { class: 'row center movehead' }, marker(e.kind), h('span', { class: `kbadge k-${e.kind}` }, KINDS[e.kind] || e.kind), h('b', null, e.title), h('span', { class: 'hint' }, `${prettyDate(e.date)}${e.time ? `, ${e.time} Eastern` : ''}`),
        h('div', { class: 'spacer' }), h('button', { class: 'btn small', onclick: () => { S.sel = null; S.move = null; paint(); } }, 'Clear')));
      if (m.future) { card.append(h('div', { class: 'empty-note' }, 'This has not happened yet. Come back after it does.')); return card; }
      if (m.loading) { card.append(h('div', { class: 'hint', role: 'status' }, 'Fetching prices around this date…')); return card; }
      if (m.err) { card.append(h('div', { class: 'callout warn' }, m.err)); return card; }
      const d = m.data;
      if (!d) return card;
      const ok = d.items.filter((i) => i.ok && !i.pending);
      if (!ok.length) { card.append(h('div', { class: 'callout warn' }, (d.items.find((i) => i.error) || {}).error || 'No prices were returned for this date.')); return card; }
      card.append(h('div', { class: 'sub' }, (TIMING[d.timing] || TIMING.unknown)(e)));
      const shifted = ok.find((i) => i.shiftedFromWeekend);
      if (shifted) card.append(h('div', { class: 'hint' }, `${prettyDate(e.date)} is not a trading day, so the move is measured on ${shifted.tradingDay}.`));
      const bench = d.items.find((i) => i.ticker === 'SPY' && i.ok);
      const reactKey = (i) => (d.timing === 'after_close' ? 'day1' : d.timing === 'unknown' ? (Math.abs(i.day1 || 0) > Math.abs(i.day0 || 0) ? 'day1' : 'day0') : 'day0');
      const head = ['', 'Opening gap', 'Day of', 'Next day', '5 trading days', 'Day of vs S&P 500'];
      const rows = ok.map((i) => {
        const rk = reactKey(i);
        const cell = (k, label) => h('td', { class: 'num' + (rk === k && label ? ' react' : '') }, mv(i[k]), rk === k && label ? h('div', { class: 'hint' }, 'likely reaction') : null);
        const vs = bench && i.ticker !== 'SPY' && typeof i.day0 === 'number' && typeof bench.day0 === 'number' ? i.day0 - bench.day0 : null;
        return h('tr', { dataset: { ticker: i.ticker } }, h('th', { scope: 'row' }, i.ticker), h('td', { class: 'num' }, mv(i.gap)), cell('day0', true), cell('day1', true), h('td', { class: 'num' }, mv(i.day5)),
          h('td', { class: 'num' }, vs == null ? h('span', { class: 'hint' }, i.ticker === 'SPY' ? 'benchmark' : '—') : h('span', { class: vs >= 0 ? 'pos' : 'neg' }, `${arrow(vs)}${(Math.abs(vs) * 100).toFixed(1)} pts ${vs >= 0 ? 'ahead' : 'behind'}`)));
      });
      card.append(h('div', { class: 'tablewrap' }, h('table', { class: 'list movetable' }, h('thead', null, h('tr', null, head.map((t) => h('th', null, t)))), h('tbody', null, rows))));
      const first = ok[0];
      card.append(h('div', { class: 'moverow' },
        h('div', { class: 'movechart' }, h('h3', null, 'Change from the close before the event'),
          TDCharts.compare({ series: ok.map((i) => ({ name: i.ticker, points: i.series.map(([dt, c]) => [dt, c / i.base - 1]) })), mark: first.tradingDay, markLabel: 'event', height: 210, name: `Price change around ${e.title}` }),
          h('div', { class: 'hint' }, `Daily closes, from ${first.series[0][0]} to ${first.series[first.series.length - 1][0]}.`)),
        intradayBlock(ok, d)));
      card.append(h('div', { class: 'hint' }, 'A price move on the day of an event is not proof the event caused it: other news and the whole market move prices on the same day, which is why the S&P 500 is shown. Gap is the open against the previous close. Figures use Yahoo Finance prices, are not adjusted for splits or dividends, and describe what happened, not what will.'));
      return card;
    }

    function intradayBlock(ok, d) {
      const box = h('div', { class: 'moveintra' });
      const withIntra = ok.filter((i) => i.intraday && i.intraday.at);
      if (!withIntra.length) {
        box.append(h('h3', null, 'During the day'),
          h('div', { class: 'hint' }, d.timing === 'during'
            ? 'Minute-level prices are only kept for about two months, so the reaction after the announcement time is not available for this date.'
            : d.timing === 'unknown'
              ? 'No announcement time on file, so there is no in-session reaction to time. The opening gap, the day itself and the next day carry it.'
              : 'Announced outside trading hours, so there is no in-session reaction to time. The opening gap and the next day carry it.'));
        return box;
      }
      box.append(h('h3', null, `From ${withIntra[0].intraday.at} Eastern`),
        h('table', { class: 'list movetable' }, h('thead', null, h('tr', null, ['', '+30 minutes', '+2 hours', 'To the close'].map((t) => h('th', null, t)))),
          h('tbody', null, withIntra.map((i) => h('tr', null, h('th', { scope: 'row' }, i.ticker), h('td', { class: 'num' }, mv(i.intraday.m30)), h('td', { class: 'num' }, mv(i.intraday.m120)), h('td', { class: 'num' }, mv(i.intraday.close)))))),
        h('div', { class: 'hint' }, 'Measured from the price at the announcement time, on five minute bars.'));
      return box;
    }

    async function removeCustom(id) {
      const r = await td.saveEvents({ events: (S.custom || []).filter((e) => e.id !== id) });
      if (!r.ok) return toast(r.error, 'error');
      S.custom = r.events; paint();
    }

    function addForm() {
      const date = h('input', { type: 'date', id: 'evdate', value: S.day || todayIso() });
      const time = h('input', { type: 'time', id: 'evtime' });
      const title = h('input', { type: 'text', id: 'evtitle', placeholder: 'For example: Apple product event', style: { width: '100%' } });
      const tk = h('input', { type: 'text', id: 'evticker', class: 'ticker', placeholder: 'optional', style: { width: '100px' } });
      const imp = h('select', { id: 'evimpact' }, ['high', 'medium', 'low'].map((v) => h('option', { value: v }, IMPACT[v])));
      imp.value = 'medium';
      const note = h('input', { type: 'text', id: 'evnote', placeholder: 'Why it matters (optional)', style: { width: '100%' } });
      const err = h('div', { class: 'hint' });
      const body = h('div', { class: 'evform' },
        h('div', { class: 'field' }, h('label', { for: 'evtitle' }, 'What is happening'), title),
        h('div', { class: 'row' }, h('div', { class: 'field' }, h('label', { for: 'evdate' }, 'Date'), date), h('div', { class: 'field' }, h('label', { for: 'evtime' }, 'Time, Eastern'), time),
          h('div', { class: 'field' }, h('label', { for: 'evticker' }, 'Ticker'), tk), h('div', { class: 'field' }, h('label', { for: 'evimpact' }, 'Impact'), imp)),
        h('div', { class: 'field' }, h('label', { for: 'evnote' }, 'Note'), note), err);
      const add = h('button', { class: 'btn primary', id: 'evadd', onclick: async () => {
        if (!title.value.trim() || !date.value) { clear(err).append('Give the event a name and a date.'); return; }
        const r = await td.saveEvents({ events: (S.custom || []).concat([{ title: title.value, date: date.value, time: time.value, ticker: tk.value, detail: note.value, impact: imp.value }]) });
        if (!r.ok) { clear(err).append(r.error); return; }
        S.custom = r.events; S.month = date.value.slice(0, 7); TD.closeModal(); paint();
      } }, 'Add event');
      TD.modal(h('h2', null, 'Add an event'), body,
        h('div', { class: 'row center', style: { marginTop: '12px' } }, h('div', { class: 'spacer' }), h('button', { class: 'btn', onclick: TD.closeModal }, 'Cancel'), add));
    }

    paint();
    load(false);
  };
})();
