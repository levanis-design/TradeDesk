'use strict';
// Research: SEC filings, reported results, House disclosures, and price alerts. Public records, read only.
(function () {
  const { h, clear, toast } = U;
  let tab = 'filings';
  const S = { filings: null, facts: null, congress: null, alerts: [], busy: false };

  const own = () => [...new Set([...(TD.state.holdings.positions || []).map((p) => p.ticker), ...(TD.state.watch || []).map((w) => w.ticker)])];
  const hasContact = () => !!(TD.state.settings && TD.state.settings.secUserAgent);
  const money = (n) => {
    if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
    const a = Math.abs(n); const sign = n < 0 ? '−' : '';
    if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}B`;
    if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(1)}M`;
    return `${sign}$${a.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  };
  const pctv = (v) => (typeof v === 'number' ? `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(1)}%` : '—');
  const pctPlain = (v) => (typeof v === 'number' ? `${(v * 100).toFixed(1)}%` : '—');
  const when = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); };
  const parseList = (text) => [...new Set(String(text || '').toUpperCase().split(/[\s,;]+/).filter((t) => /^[A-Z][A-Z0-9.\-]{0,9}$/.test(t)))].slice(0, 25);
  const openLink = async (url) => { const r = await td.openLink({ url }); if (!r.ok) toast(r.error, 'error'); };
  const linkBtn = (url, label = 'Open') => h('button', { class: 'btn link', type: 'button', onclick: () => openLink(url) }, label);


  // A drop-down of what you hold and watch, with a box for anything else.
  function tickerPicker(id, initial, onChange) {
    const held = (TD.state.holdings.positions || []).map((p) => p.ticker).filter(Boolean);
    const watch = (TD.state.watch || []).map((w) => w.ticker).filter((t) => !held.includes(t));
    const sel = h('select', { id: `${id}Sel`, 'aria-label': 'Pick one of your tickers', style: { width: '190px' } },
      h('option', { value: '' }, 'Choose from my tickers…'),
      held.length ? h('optgroup', { label: 'Holdings' }, held.map((t) => h('option', { value: t }, t))) : null,
      watch.length ? h('optgroup', { label: 'Watchlist' }, watch.map((t) => h('option', { value: t }, t))) : null);
    const box = h('input', { type: 'text', id, class: 'ticker', value: initial || '', placeholder: 'or type one', autocomplete: 'off', spellcheck: false });
    if (initial && [...held, ...watch].includes(initial)) sel.value = initial;
    sel.addEventListener('change', () => { if (sel.value) { box.value = sel.value; if (onChange) onChange(sel.value); } });
    box.addEventListener('input', () => { sel.value = [...held, ...watch].includes(box.value.trim().toUpperCase()) ? box.value.trim().toUpperCase() : ''; });
    return { sel, box };
  }
  const section = (title, ...kids) => h('div', { class: 'sumsec' }, h('h3', null, title), ...kids);

  async function openFiling(f) {
    const body = h('div', { class: 'filingbody', id: 'filingModal' }, h('div', { class: 'hint' }, 'Reading the filing from sec.gov…'));
    TD.modal(h('div', { class: 'row center' }, h('h2', null, `${f.ticker} ${f.form}`), h('span', { class: 'hint' }, `filed ${when(f.time)}`), h('div', { class: 'spacer' }), h('button', { class: 'btn', onclick: TD.closeModal }, 'Close')), body);
    const r = await td.filingDetail({ link: f.link, form: f.form });
    if (!document.body.contains(body)) return;
    clear(body);
    if (!r.ok) { body.append(h('div', { class: 'callout bad' }, r.error), f.link ? linkBtn(f.link, 'Open on sec.gov') : null); return; }
    if (r.meaning) body.append(h('p', { class: 'lead' }, r.meaning));
    for (const sct of r.sections) {
      body.append(h('div', { class: 'sumitem' + (sct.important ? ' important' : '') },
        h('div', { class: 'row center' }, h('b', null, `Item ${sct.code}, ${sct.label}`), sct.important ? h('span', { class: 'badge warn' }, 'often matters') : null),
        sct.meaning ? h('div', { class: 'meaning' }, sct.meaning) : null,
        h('div', { class: 'excerpt' }, h('div', { class: 'lbl' }, 'What the filing says'), h('div', { class: 'quote' }, sct.text))));
    }
    if (r.exhibit) {
      body.append(section('From the attached press release',
        r.exhibit.lines.length ? h('ul', null, r.exhibit.lines.map((l) => h('li', null, l))) : h('div', { class: 'quote' }, r.exhibit.start),
        h('div', { class: 'hint' }, 'These lines are the ones that carry a figure and a result word. The full release has the rest and the context.'),
        linkBtn(r.exhibit.url, 'Open the press release')));
    }
    (r.notes || []).forEach((n) => body.append(h('div', { class: 'callout small' }, n)));
    body.append(h('div', { class: 'hint' }, 'This is a reading aid, not the filing. Explanations are general, the quoted text is cut to its start, and nothing here says whether the news is good or bad for the stock.'), linkBtn(f.link, 'Open the whole filing on sec.gov'));
  }

  // Everything a House report says, set out plainly.
  function openReport(rep) {
    const T = rep.trades || [];
    const sum = { buy: 0, sell: 0, other: 0, low: 0, high: 0, late: 0, tickers: new Set() };
    for (const t of T) {
      if (t.type === 'P') sum.buy++; else if (/^S/.test(t.type || '')) sum.sell++; else sum.other++;
      sum.low += t.amount_low || 0; sum.high += t.amount_high || t.amount_low || 0;
      if (t.late) sum.late++; if (t.ticker) sum.tickers.add(t.ticker);
    }
    const dollars = (n) => `$${Math.round(n).toLocaleString('en-US')}`;
    const body = h('div', { class: 'filingbody', id: 'reportModal' });
    body.append(h('div', { class: 'row center' }, h('span', { class: 'badge plain' }, rep.district || ''), h('span', { class: 'hint' }, `Report ${rep.doc_id}, filed ${rep.filed || '—'}`)));
    if (!rep.read) body.append(h('div', { class: 'callout small' }, 'TradeDesk could not read this PDF, so it cannot summarize it. Install the PDF reader in Setup, Components, or open the original.'));
    else if (!T.length) body.append(h('div', { class: 'hint' }, 'No trades matched your filters in this report.'));
    else {
      body.append(h('div', { class: 'stats' },
        stat('Transactions', String(T.length)), stat('Purchases', String(sum.buy)), stat('Sales', String(sum.sell)), stat('Companies', String(sum.tickers.size)),
        stat('Combined size, as ranges', `${dollars(sum.low)} to ${dollars(sum.high)}`)),
      h('div', { class: 'hint' }, `Amounts are the ranges the filer reported, added together, so the real total is somewhere inside this span.${sum.late ? ` ${sum.late} transaction${sum.late > 1 ? 's were' : ' was'} reported later than the 45 days the rules allow.` : ''}`));
      const byTicker = {};
      for (const t of T) { const k = t.ticker || t.asset; (byTicker[k] = byTicker[k] || []).push(t); }
      body.append(section('By company', h('div', { class: 'tablewrap' }, h('table', { class: 'list' },
        h('thead', null, h('tr', null, ['Company', 'Purchases', 'Sales', 'Reported range'].map((x, i) => h('th', { class: i ? 'num' : '' }, x)))),
        h('tbody', null, Object.entries(byTicker).map(([k, list]) => h('tr', null, h('th', { scope: 'row' }, k, h('div', { class: 'hint' }, list[0].asset)),
          h('td', { class: 'num' }, String(list.filter((t) => t.type === 'P').length)), h('td', { class: 'num' }, String(list.filter((t) => /^S/.test(t.type || '')).length)),
          h('td', { class: 'num' }, `${dollars(list.reduce((a, t) => a + (t.amount_low || 0), 0))} to ${dollars(list.reduce((a, t) => a + (t.amount_high || t.amount_low || 0), 0))}`))))))));
      const opts = T.filter((t) => t.option);
      if (opts.length) body.append(section('Options', h('ul', null, opts.map((t) => h('li', null, `${t.ticker || t.asset}: ${t.option.contracts} ${t.option.kind} contract${t.option.contracts > 1 ? 's' : ''}, strike ${t.option.strike}, expiring ${t.option.expires}${t.option.exercised ? ' (exercised)' : ''}.`)))));
      body.append(section('Each transaction', h('div', { class: 'tablewrap' }, h('table', { class: 'list' },
        h('thead', null, h('tr', null, ['Traded', 'Owner', 'Type', 'Asset', 'Amount (range)', 'Reported after'].map((x) => h('th', null, x)))),
        h('tbody', null, T.map((t) => h('tr', null, h('td', null, t.date || '—'), h('td', null, t.owner_name || t.owner || 'self'), h('td', null, t.type_name || t.type), h('td', null, t.ticker ? h('strong', null, t.ticker + ' ') : null, t.asset),
          h('td', { class: 'num' }, t.amount), h('td', { class: 'num' }, t.days_to_disclose != null ? `${t.days_to_disclose} days` : '—'))))))));
    }
    body.append(h('div', { class: 'hint' }, 'Only what the report lists: who traded, what, when and in what size range. It does not say why. Public records, filed up to 45 days after the trade, not a signal.'), linkBtn(rep.url, 'Open the original PDF'));
    TD.modal(h('div', { class: 'row center' }, h('h2', null, rep.name), h('div', { class: 'spacer' }), h('button', { class: 'btn', onclick: TD.closeModal }, 'Close')), body);
  }

  function needContact() {
    return h('div', { class: 'callout warn', id: 'needContact' },
      'The SEC asks every program to identify itself. Enter your name and email under ',
      h('button', { class: 'btn link', type: 'button', onclick: () => TD.go('setup') }, 'Setup, SEC contact'),
      '. It is sent only to the SEC with each request.');
  }

  TD.pages.research = function (el) {
    const body = h('div', { id: 'researchbody' });
    const t = TD.tabs([{ id: 'filings', label: 'Filings' }, { id: 'facts', label: 'Company results' }, { id: 'congress', label: 'Congress trades' }, { id: 'alerts', label: 'Price alerts' }], tab, (id) => { tab = id; paint(); });
    el.append(t.bar, body);
    function paint() {
      clear(body); t.paint(tab);
      ({ filings, facts, congress, alerts })[tab](body);
    }
    paint();
  };

  // ------------------------------------------------------------------ filings
  function filings(box) {
    const tick = h('input', { type: 'text', id: 'fltickers', value: own().slice(0, 12).join(', '), placeholder: 'AAPL, KO', style: { width: '320px' } });
    const fill = (view) => { tick.value = TD.tickersFor(view).map((x) => x.ticker).slice(0, 25).join(', '); };
    const quickFill = h('div', { class: 'field' }, h('label', null, 'Fill from'), h('div', { class: 'row center' },
      h('button', { class: 'btn small', type: 'button', id: 'flHeld', onclick: () => fill('held') }, 'Holdings'), h('button', { class: 'btn small', type: 'button', id: 'flWatch', onclick: () => fill('watch') }, 'Watchlist'), h('button', { class: 'btn small', type: 'button', id: 'flBoth', onclick: () => fill('both') }, 'Both')));
    const days = h('select', { id: 'fldays' }, [30, 90, 180, 365].map((d) => h('option', { value: d }, `Last ${d} days`)));
    days.value = '90';
    const forms = ['8-K', '10-Q', '10-K'].map((f) => h('label', { class: 'check' }, h('input', { type: 'checkbox', dataset: { form: f }, checked: f === '8-K' }), f));
    const out = h('div', { id: 'flout' });
    const go = h('button', { class: 'btn primary', id: 'flgo', onclick: () => load(true) }, 'Show filings');
    box.append(h('div', { class: 'card compact' },
      h('h2', null, 'What companies told the SEC'),
      h('div', { class: 'sub' }, '8-Ks report events as they happen: results, deals, leadership changes, legal trouble. 10-Qs and 10-Ks are the quarterly and yearly reports. Source: SEC EDGAR.'),
      hasContact() ? null : needContact(),
      h('div', { class: 'row' }, h('div', { class: 'field' }, h('label', { for: 'fltickers' }, 'Tickers'), tick), quickFill, h('div', { class: 'field' }, h('label', { for: 'fldays' }, 'Period'), days),
        h('div', { class: 'field' }, h('label', null, 'Forms'), h('div', { class: 'row center' }, forms)), go)), out);
    async function load(force) {
      const list = parseList(tick.value);
      if (!list.length) { clear(out).append(h('div', { class: 'callout warn' }, 'Enter at least one ticker.')); return; }
      go.disabled = true; clear(out).append(h('div', { class: 'hint' }, 'Reading SEC filings…'));
      const fs = U.$$('[data-form]', box).filter((c) => c.checked).map((c) => c.dataset.form);
      const r = await td.filings({ tickers: list, forms: fs.length ? fs : ['8-K'], days: Number(days.value), force });
      go.disabled = false;
      if (!r.ok) { clear(out).append(h('div', { class: 'callout bad' }, r.error)); return; }
      S.filings = r; show(r);
    }
    function show(r) {
      clear(out);
      if (r.errors && r.errors.length) out.append(h('div', { class: 'callout warn small' }, r.errors.join(' · ')));
      if (!r.items.length) { out.append(h('div', { class: 'card' }, h('div', { class: 'hint' }, `No filings of these types in the last ${r.days} days.`))); return; }
      out.append(h('div', { class: 'card' }, h('div', { class: 'tablewrap' }, h('table', { class: 'list', id: 'fltable' },
        h('thead', null, h('tr', null, ['Filed', 'Ticker', 'Form', 'What it covers', ''].map((x) => h('th', null, x)))),
        h('tbody', null, r.items.map((i) => h('tr', { class: (i.important ? 'important ' : '') + 'clickrow', tabindex: '0', title: 'Click for a plain-language summary', onclick: (e) => { if (!e.target.closest('button')) openFiling(i); }, onkeydown: (e) => { if (e.key === 'Enter') openFiling(i); } },
          h('td', null, when(i.time)), h('th', { scope: 'row' }, i.ticker), h('td', null, i.form),
          h('td', null, i.items.length ? i.items.map((x) => h('span', { class: `badge ${x.important ? 'warn' : 'plain'}`, title: `Item ${x.code}` }, x.label)) : h('span', { class: 'hint' }, i.summary || '')),
          h('td', null, h('button', { class: 'btn small', type: 'button', onclick: () => openFiling(i) }, 'Explain'), i.link ? linkBtn(i.link, 'Open on sec.gov') : null))))))),
      h('div', { class: 'hint' }, 'Highlighted items are the kinds that often matter most: earnings, leadership changes, bankruptcy, delisting notices, restated results. Click a row for a plain-language summary. A filing is a company statement, not a verdict on the stock.'));
    }
    if (S.filings) show(S.filings);
  }

  // ------------------------------------------------------------------ company results
  function facts(box) {
    const P = tickerPicker('fxticker', (S.facts && S.facts.ticker) || own()[0] || '', () => load());
    const tick = P.box;
    const out = h('div', { id: 'fxout' });
    const go = h('button', { class: 'btn primary', id: 'fxgo', onclick: () => load() }, 'Show results');
    box.append(h('div', { class: 'card compact' }, h('h2', null, 'Reported results, from the company’s own filings'),
      h('div', { class: 'sub' }, 'Revenue, profit and margins by quarter, read from SEC data. Numbers only: this page does not say whether a stock is a buy.'),
      hasContact() ? null : needContact(),
      h('div', { class: 'row' }, h('div', { class: 'field' }, h('label', { for: 'fxticker' }, 'Ticker'), h('div', { class: 'row center' }, P.sel, tick)), go)), out);
    tick.addEventListener('keydown', (e) => { if (e.key === 'Enter') load(); });
    async function load() {
      const t = parseList(tick.value)[0];
      if (!t) { clear(out).append(h('div', { class: 'callout warn' }, 'Enter a ticker.')); return; }
      go.disabled = true; clear(out).append(h('div', { class: 'hint' }, 'Reading SEC data…'));
      const r = await td.companyFacts({ ticker: t });
      go.disabled = false;
      if (!r.ok) { clear(out).append(h('div', { class: 'callout bad' }, r.error)); return; }
      S.facts = r; show(r);
    }
    function show(r) {
      clear(out);
      const T = r.ttm || {};
      out.append(h('div', { class: 'card' }, h('h2', null, `${r.entity || r.ticker} (${r.ticker})`),
        h('div', { class: 'stats' },
          stat('Revenue, last 4 quarters', T.revenue != null ? money(T.revenue) : '—'),
          stat('Net income, last 4 quarters', T.net_income != null ? money(T.net_income) : '—'),
          stat('Diluted EPS, last 4 quarters', T.eps_diluted != null ? `$${T.eps_diluted.toFixed(2)}` : '—')),
        r.stale ? h('div', { class: 'callout warn small' }, r.stale) : null,
        h('div', { class: 'tablewrap' }, h('table', { class: 'list', id: 'fxtable' },
          h('thead', null, h('tr', null, ['Quarter ending', 'Revenue', 'vs year ago', 'Net income', 'vs year ago', 'EPS', 'Gross margin', 'Operating margin'].map((x, k) => h('th', { class: k ? 'num' : '' }, x)))),
          h('tbody', null, r.rows.map((q) => h('tr', null,
            h('th', { scope: 'row' }, q.end, q.derived ? h('span', { class: 'badge plain', title: 'The fourth quarter is the full year minus the first three, so it is calculated, not reported.' }, 'calculated') : null),
            h('td', { class: 'num' }, money(q.revenue)), h('td', { class: `num ${q.revenue_yoy >= 0 ? 'pos' : 'neg'}` }, pctv(q.revenue_yoy)),
            h('td', { class: 'num' }, money(q.net_income)), h('td', { class: `num ${q.net_income_yoy >= 0 ? 'pos' : 'neg'}` }, pctv(q.net_income_yoy)),
            h('td', { class: 'num' }, q.eps_diluted != null ? `$${q.eps_diluted.toFixed(2)}` : '—'),
            h('td', { class: 'num' }, pctPlain(q.gross_margin)), h('td', { class: 'num' }, pctPlain(q.operating_margin))))))),
        r.changes && r.changes.length ? h('div', null, h('h3', null, 'What changed in the latest quarter'), h('ul', null, r.changes.map((c) => h('li', null, c)))) : null,
        h('div', { class: 'row center' },
          r.filings && r.filings.report ? h('span', null, `Latest ${r.filings.report.form}, filed ${r.filings.report.filed}: `, linkBtn(r.filings.report.url, 'open')) : null,
          r.filings && r.filings.earnings_8k ? h('span', null, `Latest earnings release, filed ${r.filings.earnings_8k.filed}: `, linkBtn(r.filings.earnings_8k.exhibit || r.filings.earnings_8k.url, 'open')) : null)),
      h('div', { class: 'hint' }, 'Banks and insurers report revenue differently, so their margins can be blank. Calculated quarters are approximate. Always read the filing for anything you act on.'));
    }
    if (S.facts) show(S.facts);
  }
  const stat = (k, v) => h('div', { class: 'stat' }, h('div', { class: 'v' }, v), h('div', { class: 'k' }, k));

  // ------------------------------------------------------------------ congress
  function congress(box) {
    const members = h('input', { type: 'text', id: 'cgmembers', placeholder: 'optional: Pelosi, Gottheimer', style: { width: '280px' } });
    const days = h('select', { id: 'cgdays', style: { width: '210px' } }, [30, 60, 90, 180].map((d) => h('option', { value: d }, `Filed in the last ${d} days`)));
    days.value = '60';
    const mine = h('input', { type: 'checkbox', id: 'cgmine' });
    const out = h('div', { id: 'cgout' });
    const go = h('button', { class: 'btn primary', id: 'cggo', onclick: () => load() }, 'Show disclosures');
    box.append(h('div', { class: 'card compact' }, h('h2', null, 'Stock trades reported by members of the House'),
      h('div', { class: 'sub' }, 'Periodic transaction reports from the House Clerk. They are filed up to 45 days after the trade and give dollar ranges, not exact amounts. They are public records, not tips, and trading on them is not a strategy this app supports.'),
      h('div', { class: 'row' }, h('div', { class: 'field' }, h('label', { for: 'cgmembers' }, 'Members'), members), h('div', { class: 'field' }, h('label', { for: 'cgdays' }, 'Period'), days),
        h('label', { class: 'check' }, mine, 'Only my holdings and watchlist'), go)), out);
    async function load() {
      go.disabled = true; clear(out).append(h('div', { class: 'hint' }, 'Reading the House Clerk index and filings. This can take a minute…'));
      const r = await td.congress({ members: members.value.split(/[;,]/).map((x) => x.trim()).filter(Boolean), tickers: mine.checked ? own() : [], days: Number(days.value) });
      go.disabled = false;
      if (!r.ok) { clear(out).append(h('div', { class: 'callout bad' }, r.error)); return; }
      S.congress = r; show(r);
    }
    function show(r) {
      clear(out);
      out.append(h('div', { class: 'hint' }, `${r.total} filing${r.total === 1 ? '' : 's'} in this period${r.shown < r.total ? `, showing the newest ${r.shown}` : ''}.${r.unread ? ` ${r.unread} could not be read here and link to the original PDF.` : ''}`));
      if (r.errors && r.errors.length) out.append(h('div', { class: 'callout warn small' }, r.errors.join(' · ')));
      if (r.unread && r.reports.some((x) => !x.read)) out.append(h('div', { class: 'callout small' }, 'To read the PDFs inside TradeDesk, install the PDF reader under Setup, Components, then run this again.'));
      if (!r.reports.length) { out.append(h('div', { class: 'card' }, h('div', { class: 'hint' }, 'Nothing matched.'))); return; }
      for (const rep of r.reports) {
        out.append(h('div', { class: 'card compact cgrep' },
          h('div', { class: 'row center' }, h('h2', null, h('button', { class: 'btn link namebtn', type: 'button', title: 'Summary of this report', onclick: () => openReport(rep) }, rep.name)), h('span', { class: 'badge plain' }, rep.district || ''), h('span', { class: 'hint' }, `filed ${rep.filed || '—'}`), h('div', { class: 'spacer' }), h('button', { class: 'btn small', type: 'button', onclick: () => openReport(rep) }, 'Summary'), linkBtn(rep.url, 'Original PDF')),
          !rep.read ? h('div', { class: 'hint' }, 'Not read here.') : !rep.trades.length ? h('div', { class: 'hint' }, 'No matching trades.') :
            h('div', { class: 'tablewrap' }, h('table', { class: 'list' },
              h('thead', null, h('tr', null, ['Traded', 'Owner', 'Type', 'Asset', 'Amount (range)', 'Reported after'].map((x) => h('th', null, x)))),
              h('tbody', null, rep.trades.map((t) => h('tr', null, h('td', null, t.date || '—'), h('td', null, t.owner_name || t.owner || 'self'), h('td', null, t.type_name || t.type),
                h('td', null, t.ticker ? h('strong', null, t.ticker + ' ') : null, t.asset), h('td', { class: 'num' }, t.amount),
                h('td', { class: 'num' }, t.days_to_disclose != null ? `${t.days_to_disclose} days` : '—', t.late ? h('span', { class: 'badge warn' }, 'late') : null))))))));
      }
      out.append(h('div', { class: 'hint' }, 'Federal law limits using these records to sell products or raise money, so this page is for your own reading. Owner shows whose account made the trade (self, spouse, joint, dependent child).'));
    }
    if (S.congress) show(S.congress);
  }

  // ------------------------------------------------------------------ price alerts
  function alerts(box) {
    const tk = h('input', { type: 'text', id: 'altick', class: 'ticker', placeholder: 'AAPL' });
    const dir = h('select', { id: 'aldir' }, h('option', { value: 'above' }, 'rises to or above'), h('option', { value: 'below' }, 'falls to or below'));
    const px = h('input', { type: 'number', id: 'alprice', step: 'any', min: 0, placeholder: 'price', style: { width: '120px' } });
    const note = h('input', { type: 'text', id: 'alnote', placeholder: 'Why (optional)', style: { width: '220px' } });
    const list = h('div', { id: 'allist' });
    const err = h('div', { class: 'hint bad' });
    box.append(h('div', { class: 'card compact' }, h('h2', null, 'Tell me when a price is reached'),
      h('div', { class: 'sub' }, 'Alerts stay on this computer. TradeDesk checks every five minutes while it is open and the engine is installed, then shows a notice once. Prices come from Yahoo Finance and can lag. An alert is a reminder you set, not a signal.'),
      h('div', { class: 'row' }, h('div', { class: 'field' }, h('label', { for: 'altick' }, 'Ticker'), tk), h('div', { class: 'field' }, h('label', { for: 'aldir' }, 'When it'), dir),
        h('div', { class: 'field' }, h('label', { for: 'alprice' }, 'Price'), px), h('div', { class: 'field' }, h('label', { for: 'alnote' }, 'Note'), note),
        h('button', { class: 'btn primary', id: 'aladd', onclick: add }, 'Add alert'),
        h('button', { class: 'btn', id: 'alcheck', onclick: checkNow }, 'Check now')), err), list);
    async function add() {
      clear(err);
      const t = parseList(tk.value)[0]; const p = Number(px.value);
      if (!t || !(p > 0)) { err.append('Enter a ticker and a price above zero.'); return; }
      const r = await td.saveAlerts({ alerts: S.alerts.concat([{ ticker: t, direction: dir.value, price: p, note: note.value }]) });
      if (!r.ok) { err.append(r.error); return; }
      S.alerts = r.alerts; tk.value = ''; px.value = ''; note.value = ''; TD.alertsChanged(); paintList();
    }
    async function checkNow() {
      const r = await TD.checkAlerts(true);
      if (r && r.ok) { S.alerts = r.alerts; paintList(); if (!r.fired.length) toast('No alert has been reached.', 'info'); }
    }
    async function update(next) { const r = await td.saveAlerts({ alerts: next }); if (r.ok) { S.alerts = r.alerts; TD.alertsChanged(); paintList(); } else toast(r.error, 'error'); }
    function paintList() {
      clear(list);
      if (!S.alerts.length) { list.append(h('div', { class: 'card' }, h('div', { class: 'hint' }, 'No alerts yet.'))); return; }
      list.append(h('div', { class: 'card' }, h('div', { class: 'tablewrap' }, h('table', { class: 'list' },
        h('thead', null, h('tr', null, ['Ticker', 'Condition', 'Status', 'Note', ''].map((x) => h('th', null, x)))),
        h('tbody', null, S.alerts.map((a) => h('tr', { dataset: { alert: a.id } },
          h('th', { scope: 'row' }, a.ticker), h('td', null, `${a.direction === 'above' ? 'rises to or above' : 'falls to or below'} ${U.money(a.price)}`),
          h('td', null, a.firedAt ? h('span', { class: 'badge ok' }, `reached ${U.money(a.firedPrice)} on ${when(a.firedAt)}`) : a.active ? h('span', { class: 'badge plain' }, 'waiting') : h('span', { class: 'badge plain' }, 'paused')),
          h('td', null, a.note), h('td', null, h('div', { class: 'row center' },
            a.firedAt ? h('button', { class: 'btn small', onclick: () => update(S.alerts.map((x) => (x.id === a.id ? { ...x, firedAt: null, firedPrice: null, active: true } : x))) }, 'Set again')
              : h('button', { class: 'btn small', onclick: () => update(S.alerts.map((x) => (x.id === a.id ? { ...x, active: !x.active } : x))) }, a.active ? 'Pause' : 'Resume'),
            h('button', { class: 'btn small danger', onclick: () => update(S.alerts.filter((x) => x.id !== a.id)) }, 'Remove'))))))))));
    }
    td.alerts().then((r) => { if (r.ok) { S.alerts = r.alerts; paintList(); } });
    paintList();
  }

  // ---- background check, started once at launch
  let timer = null;
  TD.alertsChanged = () => { TD.state.alertCount = S.alerts.filter((a) => a.active && !a.firedAt).length; };
  TD.checkAlerts = async function (manual) {
    if (!manual && !TD.state.alertCount) return null;
    if (TD.notReady()) return null;
    const r = await td.checkAlerts();
    if (r && r.ok) {
      S.alerts = r.alerts; TD.alertsChanged();
      for (const a of r.fired || []) toast(`${a.ticker} ${a.direction === 'above' ? 'rose to' : 'fell to'} ${U.money(a.firedPrice)} (your alert: ${U.money(a.price)}).`, 'info');
    } else if (manual && r) toast(r.error || 'The check failed.', 'error');
    return r;
  };
  TD.startAlerts = async function () {
    const r = await td.alerts();
    if (r.ok) { S.alerts = r.alerts; TD.alertsChanged(); }
    if (timer) clearInterval(timer);
    timer = setInterval(() => { TD.checkAlerts(false).catch(() => {}); }, 5 * 60 * 1000);
  };
})();
