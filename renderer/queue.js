'use strict';
// Queue tab: analyses lined up to run one after another. Cancel one, or cancel everything.
(function () {
  const { h, $, clear, toast, duration } = U;
  let root = null;
  const mounted = () => root && document.body.contains(root);
  let tick = null;

  const badge = (i) => {
    if (i.status === 'done') return U.ratingBadge(i.rating);
    if (i.status === 'running') return h('span', { class: 'badge warn' }, 'Running');
    if (i.status === 'queued') return h('span', { class: 'badge plain' }, 'Waiting');
    if (i.status === 'canceled') return h('span', { class: 'badge plain' }, 'Cancelled');
    return h('span', { class: 'badge bad' }, 'Failed');
  };

  TD.paintQueue = function () {
    if (!mounted() || !$('#qhead')) return;
    const items = TD.state.queue || [];
    const active = items.filter((i) => i.status === 'queued' || i.status === 'running');
    const finished = items.length - active.length;
    const head = clear($('#qhead'));
    head.append(
      h('div', { class: 'row center' },
        h('div', null, h('b', null, active.length ? `${active.length} in progress or waiting` : 'Nothing waiting'), finished ? h('span', { class: 'hint' }, `  ${finished} finished`) : null,
          active.length && TD.state.queueTotal && TD.state.queueTotal.remaining != null ? h('div', { class: 'hint' }, 'Everything finished in ', TD.plainEta(TD.state.queueTotal.remaining, TD.state.queueTotal.at)) : null),
        h('div', { class: 'spacer' }),
        h('button', { class: 'btn', disabled: !finished, onclick: async () => { const r = await td.queueClear(); if (r.ok) TD.setQueue(r.queue); } }, 'Clear finished'),
        h('button', { class: 'btn danger', disabled: !active.length && !TD.state.running, onclick: async () => { await td.cancel(); toast('Cancelling everything…'); } }, 'Cancel all')));
    const body = clear($('#qbody'));
    if (!items.length) { body.append(h('div', { class: 'empty-note' }, 'The queue is empty. Use "Add to queue" in the Workspace, or "Queue the whole list" on the Watchlist page.')); return; }
    body.append(h('div', { class: 'tablewrap' }, h('table', { class: 'list' },
      h('thead', null, h('tr', null, ['Ticker', 'As of', 'Depth', 'Status', 'Time taken', 'Time left', 'Summary', ''].map((t) => h('th', null, t)))),
      h('tbody', null, items.map((i) => h('tr', null,
        h('td', null, h('b', null, i.ticker)),
        h('td', null, i.date),
        h('td', null, i.profile && i.profile !== 'standard' ? h('span', { class: 'badge plain' }, i.profile) : h('span', { class: 'hint' }, 'standard')),
        h('td', null, badge(i)),
        h('td', null, i.status === 'running' && i.startedAt ? duration(Math.round((Date.now() - i.startedAt) / 1000)) : i.seconds ? duration(i.seconds) : '—'),
        h('td', null, i.status === 'running' ? TD.etaSpan(i.eta) : i.status === 'queued' ? TD.finishSpan(i.finishIn, i.finishAt) : '—'),
        h('td', { class: 'summary-cell' }, i.status === 'failed' ? h('span', { class: 'hint bad' }, (i.error || '').slice(0, 300)) : (i.summary || '')),
        h('td', { class: 'num' },
          i.entryId ? h('button', { class: 'btn small', onclick: () => TD.viewEntry(i.entryId) }, 'Open') : null,
          (i.status === 'queued' || i.status === 'running') ? h('button', { class: 'btn small', onclick: async () => { const r = await td.queueCancel({ id: i.id }); if (r.ok) TD.setQueue(r.queue); else toast(r.error, 'error'); } }, i.status === 'running' ? 'Stop' : 'Remove') : null)))))));
  };

  TD.renderQueue = function (el) {
    root = el;
    el.append(h('div', { class: 'card' }, h('h2', null, 'Analysis queue'),
      h('div', { class: 'sub' }, 'Line up several analyses and leave them to run one after another. Local models handle one at a time, so they wait their turn. Each finished analysis is saved and appears in the Workspace and the Track record. The queue is held in memory: closing TradeDesk cancels what is still waiting.'),
      h('div', { id: 'qhead' })), h('div', { class: 'card', id: 'qbody' }));
    TD.paintQueue();
    clearInterval(tick);
    tick = setInterval(() => { if (!mounted()) { clearInterval(tick); return; } if ((TD.state.queue || []).some((i) => i.status === 'running')) TD.paintQueue(); }, 5000);
  };
})();
