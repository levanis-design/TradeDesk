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

  const S = { days: 90, hidden: new Set(), mine: false, month: null, day: null, data: null, custom: null, loading: false, err: null, gen: 0 };
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
        const [r, c] = await Promise.all([td.calendar({ tickers: tickersToWatch(), days: S.days, force: !!force }), td.events()]);
        if (!r.ok) throw new Error(r.error);
        S.data = r; S.custom = c.ok ? c.events : [];
      } catch (e) { S.err = e.message; }
      S.loading = false;
      if (gen === S.gen && document.body.contains(root)) paint();
    }

    const allEvents = () => {
      const fetched = (S.data && S.data.events) || [];
      const mine = (S.custom || []).map((e) => ({ ...e, kind: 'custom', source: 'you' }));
      const lo = todayIso();
      const held = new Set((TD.state.holdings.positions || []).map((p) => p.ticker));
      const watch = new Set((TD.state.watch || []).map((w) => w.ticker));
      return fetched.concat(mine).filter((e) => !S.hidden.has(e.kind) && (!S.mine || e.ticker && (held.has(e.ticker) || watch.has(e.ticker)) || e.kind === 'custom'))
        .filter((e) => e.date >= lo || e.kind === 'custom' || (S.day && e.date === S.day))
        .sort((a, b) => a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || ''));
    };

    function paint() {
      clear(root);
      const evs = allEvents();
      root.append(controls());
      if (S.err) root.append(h('div', { class: 'callout warn' }, S.err));
      if (S.loading) root.append(h('div', { class: 'hint' }, 'Fetching events…'));
      if (S.data && S.data.notes && S.data.notes.length) root.append(h('div', { class: 'callout small' }, S.data.notes.map((n) => h('div', null, n))));
      root.append(h('div', { class: 'calgrid2' }, monthCard(evs), agendaCard(evs)));
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
        cells.push(h('button', { class: 'cc' + (date === t ? ' today' : '') + (date === S.day ? ' sel' : '') + (worst ? ` has-${worst}` : ''), type: 'button', dataset: { date },
          'aria-label': `${prettyDate(date)}, ${list.length} event${list.length === 1 ? '' : 's'}`, onclick: () => { S.day = S.day === date ? null : date; paint(); } },
        h('span', { class: 'dn' }, String(d)),
        h('span', { class: 'dots' }, list.slice(0, 4).map((e) => h('span', { class: `dot k-${e.kind}`, title: e.title }))),
        list.length > 4 ? h('span', { class: 'more' }, `+${list.length - 4}`) : null));
      }
      const go = (n) => { const d = new Date(y, m - 1 + n, 1); S.month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; S.day = null; paint(); };
      return h('div', { class: 'card' },
        h('div', { class: 'row center' }, h('h2', null, `${MONTHS[m - 1]} ${y}`), h('div', { class: 'spacer' }),
          h('button', { class: 'btn small', 'aria-label': 'Previous month', onclick: () => go(-1) }, '‹'),
          h('button', { class: 'btn small', onclick: () => { S.month = todayIso().slice(0, 7); S.day = null; paint(); } }, 'Today'),
          h('button', { class: 'btn small', 'aria-label': 'Next month', onclick: () => go(1) }, '›')),
        h('div', { class: 'cgrid' }, DOW.map((d) => h('div', { class: 'dow' }, d)), cells),
        h('div', { class: 'hint' }, 'A ring marks a day with a high-impact event. Select a day to list only that day.'));
    }

    function agendaCard(evs) {
      const shown = S.day ? evs.filter((e) => e.date === S.day) : evs.filter((e) => e.date.slice(0, 7) === S.month || (!S.day && e.date >= todayIso() && false));
      const list = S.day ? shown : evs;
      const card = h('div', { class: 'card agenda' }, h('div', { class: 'row center' }, h('h2', null, S.day ? prettyDate(S.day) : 'Coming up'), h('div', { class: 'spacer' }),
        S.day ? h('button', { class: 'btn small', onclick: () => { S.day = null; paint(); } }, 'Show all') : null));
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
      const row = h('div', { class: `ev k-${e.kind} imp-${e.impact}`, dataset: { kind: e.kind, date: e.date } },
        h('div', { class: 'evhead' },
          h('span', { class: `kbadge k-${e.kind}` }, KINDS[e.kind] || e.kind),
          h('b', null, e.title),
          h('span', { class: `impact ${e.impact}` }, IMPACT[e.impact] || ''),
          h('span', { class: 'hint' }, [e.time ? `${e.time} Eastern` : '', S.day ? '' : ''].filter(Boolean).join(' '))),
        e.detail ? h('div', { class: 'evdetail' }, e.detail) : null,
        h('div', { class: 'evfoot hint' },
          pos ? `You hold ${U.qty(pos.quantity)} ${e.ticker}${weight != null ? `, about ${(weight * 100).toFixed(0)}% of what you hold` : ''}. ` : '',
          e.ticker ? h('button', { class: 'btn link', onclick: () => TD.openAnalyze(e.ticker) }, `Analyse ${e.ticker}`) : null,
          h('span', null, ` Source: ${e.source}.`),
          e.kind === 'custom' ? h('button', { class: 'btn link', onclick: () => removeCustom(e.id) }, 'Remove') : null));
      return row;
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
