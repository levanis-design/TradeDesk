'use strict';
// How one finished analysis is shown: a plain-language briefing first, then the full reports, then news.
// Used by the Analyze page, the Watchlist detail pane and the saved-analysis viewer.
(function () {
  const { h, clear, toast, money, pct, qty, duration } = U;

  const SOURCE = {
    decision: 'Portfolio manager', trader: 'Trader', research: 'Research manager', bull: 'Bull researcher', bear: 'Bear researcher',
    market: 'Market analyst', sentiment: 'Sentiment analyst', news: 'News analyst', fundamentals: 'Fundamentals analyst', risk: 'Risk team',
  };
  const REPORT_TABS = [
    ['decision', 'Decision', [['decision', 'Portfolio manager decision'], ['trader_plan', 'Trader proposal'], ['research_plan', 'Research manager plan']]],
    ['debate', 'Bull and bear', [['bull', 'Bull case'], ['bear', 'Bear case']]],
    ['risk', 'Risk team', [['risk_aggressive', 'Aggressive'], ['risk_conservative', 'Conservative'], ['risk_neutral', 'Neutral']]],
    ['analysts', 'Analyst reports', [['market', 'Market'], ['sentiment', 'Sentiment'], ['news', 'News'], ['fundamentals', 'Fundamentals']]],
  ];

  function positionText(position, price) {
    if (!position) return 'No position recorded';
    let t = `${qty(position.quantity)} units`;
    if (position.averagePrice != null) t += ` at ${money(position.averagePrice)}`;
    if (position.averagePrice != null && price && price.close) t += ` · last close ${money(price.close)} (${pct(price.close / position.averagePrice - 1)} vs cost)`;
    return t;
  }
  TD.positionText = positionText;

  // Weight of one holding in the portfolio, using fresh prices when we have them.
  function weightFor(ticker) {
    const hd = TD.state.holdings || { positions: [], cash: null };
    return window.Portfolio.weightOf(ticker, hd.positions || [], hd.cash, TD.priceMap());
  }

  function reasonList(items, kind) {
    if (!items || !items.length) return h('div', { class: 'empty-note' }, kind === 'against' ? 'No counter-arguments were found in the reports.' : 'Nothing could be matched to the reports.');
    return h('ul', { class: 'reasons ' + kind }, items.map((it) => h('li', null,
      h('div', { class: 'why' }, it.text),
      h('details', { class: 'src' }, h('summary', null, `Source: ${SOURCE[it.source] || it.source}`),
        h('blockquote', null, '“' + it.quote + '”')))));
  }

  // The part to read first: what is asked of you, then the reasons on each side.
  TD.renderBriefing = function ({ entry, result, position }, opts = {}) {
    const box = h('div', { class: 'briefing' });
    const brief = result && result.brief;
    const price = entry.priceAtAnalysis && entry.priceAtAnalysis.close;
    const q = TD.cachedQuote(entry.ticker, 5) || TD.cachedQuote(entry.ticker, 1);
    const hd = TD.state.holdings || {};
    const cashSetting = TD.state.settings && TD.state.settings.cashOverride !== '' && TD.state.settings.cashOverride != null ? Number(TD.state.settings.cashOverride) : hd.cash;
    const A = window.Advice.decide({
      ticker: entry.ticker, rating: entry.rating, position: position || null,
      price: q && q.ok && q.price != null ? q.price : (position && position.lastPrice) || price || null,
      cash: Number.isFinite(cashSetting) ? cashSetting : null, weight: weightFor(entry.ticker),
      watchFor: brief && brief.would_change ? brief.would_change.map((x) => x.text) : [],
    });
    const stale = entry.date && entry.date < U.today();

    box.append(h('div', { class: `decision-card ${A.tone}` },
      h('div', { class: 'dc-top' }, U.ratingBadge(entry.rating), h('span', { class: 'dc-label' }, A.label), h('span', { class: 'hint' }, `analysis as of ${entry.date}`)),
      h('div', { class: 'dc-q' }, A.question),
      h('div', { class: 'hint' }, A.lean),
      h('ul', { class: 'dc-opts' }, A.options.map((o) => h('li', null, h('b', null, o.label + ': '), o.detail))),
      A.facts.length ? h('div', { class: 'dc-facts' }, A.facts.map((f) => h('div', null, f))) : null,
      A.cautions.map((c) => h('div', { class: 'callout warn small' }, c)),
      stale ? h('div', { class: 'hint' }, `Prices have moved since ${entry.date}. The figures above use the latest price available, but the reasoning is from that date.`) : null));

    if (opts.record) box.append(opts.record);

    if (!brief) {
      const btn = h('button', { class: 'btn', 'data-needs-idle': '', onclick: async () => {
        btn.disabled = true; btn.textContent = 'Writing the briefing…';
        const r = await td.makeBrief({ id: entry.id });
        if (!r.ok) { btn.disabled = false; btn.textContent = 'Write the briefing'; return toast(r.error, 'error'); }
        result.brief = r.brief;
        if (opts.onUpdate) opts.onUpdate(); else { const fresh = TD.renderBriefing({ entry, result, position }, opts); box.replaceWith(fresh); }
      } }, 'Write the briefing');
      box.append(h('div', { class: 'callout' }, 'This analysis was saved before briefings existed, so the reasons are not summarised yet. ', btn,
        h('div', { class: 'hint' }, 'It uses your deep model once and takes about a minute on a local model.')));
      return box;
    }

    box.append(h('div', { class: 'cols2' },
      h('section', null, h('h4', { class: 'sec for' }, 'Reasons for this rating'), reasonList(brief.for, 'for')),
      h('section', null, h('h4', { class: 'sec against' }, 'Reasons against, and risks'), reasonList(brief.against, 'against'))));
    if (brief.would_change && brief.would_change.length) {
      box.append(h('section', null, h('h4', { class: 'sec' }, 'What would change the call'), reasonList(brief.would_change, 'change')));
    }
    box.append(h('div', { class: 'hint brief-note' },
      brief.mode === 'model'
        ? `Written by your model from its own reports. Every quote was checked against the reports; ${brief.dropped ? brief.dropped + ' that could not be matched ' + (brief.dropped === 1 ? 'was' : 'were') + ' left out.' : 'none had to be left out.'}`
        : `Written by simple rules from the reports because the model's summary could not be verified. ${brief.note || ''}`));
    box.append(h('div', { class: 'disc-line' }, A.disclaimer));
    return box;
  };

  // Headlines (today) plus the News analyst's reading (as of the analysis date).
  TD.renderNews = function ({ entry, result }) {
    const box = h('div', { class: 'newsview' });
    const list = h('div', { class: 'headlines' }, h('div', { class: 'hint' }, 'Loading headlines…'));
    box.append(h('h4', { class: 'sec' }, 'Recent headlines'), list,
      h('div', { class: 'hint' }, `Headlines come from Yahoo Finance as of today. The analysis itself used news up to ${entry.date}.`),
      h('h4', { class: 'sec' }, 'What the News analyst made of it'));
    const text = ((result && result.sections && result.sections.news) || '').trim();
    box.append(text ? U.markdown(text) : h('div', { class: 'empty-note' }, 'The News analyst was not part of this run.'));
    TD.quote([entry.ticker], { years: 1, news: true }).then((m) => {
      clear(list).append(TD.headlineList((m[entry.ticker] && m[entry.ticker].news) || [], m[entry.ticker] && m[entry.ticker].ok === false ? m[entry.ticker].error : null));
    }).catch((e) => { clear(list).append(h('div', { class: 'hint bad' }, e.message)); });
    return box;
  };

  TD.headlineList = function (news, err) {
    if (err) return h('div', { class: 'hint bad' }, err);
    if (!news.length) return h('div', { class: 'empty-note' }, 'No headlines were returned.');
    return h('ul', { class: 'heads' }, news.map((n) => h('li', null,
      h('div', { class: 'ht' }, n.title),
      h('div', { class: 'hint' }, [n.publisher, n.date].filter(Boolean).join(' · ')),
      n.summary ? h('details', { class: 'src' }, h('summary', null, 'Summary'), h('div', { class: 'hint' }, n.summary)) : null)));
  };

  // Full result: Briefing, News and the four report tabs, then the decision log.
  TD.renderResult = function ({ entry, result, position }, opts = {}) {
    const s = (result && result.sections) || {};
    const m = (result && result.model) || entry.model || {};
    const wrap = h('div', { class: opts.bare ? 'resultbox' : 'card' });
    wrap.append(h('div', { class: 'result-head' }, h('h2', null, entry.ticker), U.ratingBadge(entry.rating), h('span', { class: 'hint' }, `as of ${entry.date}`)));
    wrap.append(h('div', { class: 'meta' },
      h('span', null, 'Model: ', h('b', null, `${m.provider || '?'} · ${m.quick || '?'}${m.deep && m.deep !== m.quick ? ' / ' + m.deep : ''}`)),
      h('span', null, 'Debate rounds: ', h('b', null, String(m.debate_rounds ?? '?'))),
      entry.profile && entry.profile !== 'standard' ? h('span', null, 'Run type: ', h('b', null, entry.profile)) : null,
      h('span', null, 'Run time: ', h('b', null, duration(entry.seconds))),
      entry.priceAtAnalysis ? h('span', null, `Close ${entry.priceAtAnalysis.date}: `, h('b', null, money(entry.priceAtAnalysis.close))) : h('span', null, 'Close price: data to be confirmed'),
      h('span', null, 'Your position: ', h('b', null, positionText(position, entry.priceAtAnalysis)))));
    if (entry.rating === 'REVIEW') wrap.append(h('div', { class: 'callout warn' }, 'The model did not produce a readable rating. Read the text and decide for yourself; do not treat this as a Hold.'));
    if (s.memory_note) wrap.append(h('div', { class: 'hint' }, s.memory_note));

    const tabs = h('div', { class: 'tabs', role: 'tablist' });
    const body = h('div');
    const ALL = [['briefing', 'Briefing'], ['news', 'News'], ...REPORT_TABS.map((t) => [t[0], t[1]])];
    const show = (id) => {
      if (opts.onTab) opts.onTab(id);
      U.$$('.tab', tabs).forEach((b) => { b.classList.toggle('active', b.dataset.tab === id); b.setAttribute('aria-selected', String(b.dataset.tab === id)); });
      clear(body);
      if (id === 'briefing') { body.append(TD.renderBriefing({ entry, result, position }, { onUpdate: () => show('briefing') })); return; }
      if (id === 'news') { body.append(TD.renderNews({ entry, result })); return; }
      const def = REPORT_TABS.find((t) => t[0] === id) || REPORT_TABS[0];
      for (const [key, title] of def[2]) {
        const text = (s[key] || '').trim();
        body.append(h('h4', { class: 'sec' }, title));
        body.append(text ? U.markdown(text) : h('div', { class: 'empty-note' }, 'Not produced in this run.'));
      }
    };
    ALL.forEach(([id, label]) => tabs.append(h('button', { class: 'tab', role: 'tab', dataset: { tab: id }, onclick: () => show(id) }, label)));
    wrap.append(tabs, body);
    show(opts.tab || 'briefing');

    wrap.append(TD.actionForm(entry));
    wrap.append(h('div', { class: 'row center', style: { marginTop: '12px' } },
      h('button', { class: 'btn', onclick: async () => {
        const r = await td.journalExport({ id: entry.id });
        if (r.ok && !r.canceled) toast('Brief saved: ' + r.path, 'ok'); else if (!r.ok) toast(r.error, 'error');
      } }, 'Export brief (.md)'),
      entry.reportPath ? h('button', { class: 'btn', onclick: async () => { const r = await td.showReport({ id: entry.id }); if (!r.ok) toast(r.error, 'error'); } }, 'Show saved report files') : null));
    return wrap;
  };

  const ACTIONS = [['', 'Not decided yet'], ['bought', 'Bought'], ['added', 'Added to position'], ['sold', 'Sold'], ['trimmed', 'Trimmed'], ['held', 'Kept holding'], ['passed', 'Passed'], ['waiting', 'Waiting for a better price']];

  TD.actionForm = function (entry) {
    const a = entry.action || {};
    const type = h('select', { class: 'acttype', 'aria-label': 'What you did' }, ACTIONS.map(([v, l]) => h('option', { value: v, selected: v === (a.type || '') }, l)));
    const q = h('input', { type: 'number', step: 'any', min: 0, value: a.quantity ?? '', placeholder: 'units', style: { width: '100px' } });
    const p = h('input', { type: 'number', step: 'any', min: 0, value: a.price ?? '', placeholder: 'price', style: { width: '100px' } });
    const note = h('input', { type: 'text', value: a.note || '', placeholder: 'Why (optional)', style: { flex: '1', minWidth: '160px' } });
    const status = h('span', { class: 'hint' }, a.at ? `Saved ${new Date(a.at).toLocaleString()}` : '');
    const save = h('button', { class: 'btn primary', onclick: async () => {
      const r = await td.journalAction({ id: entry.id, action: type.value ? { type: type.value, quantity: q.value, price: p.value, note: note.value } : null });
      if (!r.ok) return toast(r.error, 'error');
      entry.action = r.entry.action;
      clear(status).append(type.value ? 'Saved to the journal.' : 'Cleared.');
    } }, 'Save');
    return h('div', { class: 'callout', style: { marginTop: '14px' } },
      h('div', { style: { fontWeight: 650, marginBottom: '6px' } }, 'What did you decide?'),
      h('div', { class: 'hint', style: { marginBottom: '8px' } }, 'TradeDesk does not trade. Record what you did so the track record can compare it with how the call turned out.'),
      h('div', { class: 'row center' }, type, q, p, note, save, status));
  };

  // What this model's own backtests say about calls with this rating. Small samples are called small.
  TD.recordLine = async function (rating) {
    const r = await td.record();
    if (!r.ok) return null;
    const v = r.byRating && r.byRating[rating];
    if (!v || !v.n) return h('div', { class: 'recline' }, h('b', null, 'This model\'s record: '), `no backtest yet with ${rating} calls on ${r.model}. `, h('button', { class: 'btn link', onclick: () => TD.go('track') }, 'Run a backtest'));
    return h('div', { class: 'recline' }, h('b', null, 'This model\'s record: '),
      `${v.n} ${rating} call${v.n === 1 ? '' : 's'} in your backtests on ${r.model}`,
      v.hitRate != null ? `, direction right ${Math.round(v.hitRate * 100)}% of the time` : '',
      v.meanAlpha != null ? `, average edge ${pct(v.meanAlpha)} against the benchmark` : '', '. ',
      v.n < 20 ? h('span', { class: 'hint' }, 'That is a small sample and proves little.') : null);
  };
})();
