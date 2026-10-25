'use strict';
// Sequential watchlist run. One model on one machine: running tickers in parallel
// would only make each of them slower. Results are ranked by rating, not scored
// with an invented confidence.

const RANK = { Buy: 0, Overweight: 1, Hold: 2, Underweight: 3, Sell: 4, REVIEW: 5 };

function rankResults(rows) {
  return [...rows].sort((a, b) => {
    const ra = a.status === 'done' ? (RANK[a.rating] ?? 5) : 9;
    const rb = b.status === 'done' ? (RANK[b.rating] ?? 5) : 9;
    return ra - rb || a.ticker.localeCompare(b.ticker);
  });
}

function createBatch({ tickers, runOne, onUpdate = () => {}, cancelCurrent = () => {} }) {
  const list = [...new Set(tickers)];
  const rows = list.map((ticker) => ({ ticker, status: 'queued' }));
  let canceled = false;

  async function start() {
    for (const row of rows) {
      if (canceled) { row.status = 'canceled'; onUpdate(rows); continue; }
      row.status = 'running';
      row.startedAt = Date.now();
      onUpdate(rows);
      let res;
      try { res = await runOne(row.ticker); } catch (e) { res = { ok: false, error: e.message }; }
      row.seconds = Math.round((Date.now() - row.startedAt) / 1000);
      if (res && res.canceled) row.status = 'canceled';
      else if (res && res.ok) {
        row.status = 'done';
        row.rating = res.rating;
        row.entryId = res.entryId;
        row.summary = res.summary;
      } else {
        row.status = 'failed';
        row.error = (res && res.error) || 'Unknown error';
      }
      onUpdate(rows);
    }
    return rows;
  }
  return {
    rows,
    start,
    cancel() { canceled = true; cancelCurrent(); },
    get canceled() { return canceled; },
  };
}

module.exports = { createBatch, rankResults, RANK };
