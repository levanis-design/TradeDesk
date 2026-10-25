'use strict';
// Journal scoring. Same direction convention as TradingAgents' own backtest:
// Buy/Overweight claim up, Underweight/Sell claim down, Hold claims nothing.
// Alpha here is the asset's simple return minus the benchmark's over the same
// window, measured from the first close AFTER the analysis date.

const DIRECTION = { Buy: 1, Overweight: 1, Hold: 0, Underweight: -1, Sell: -1 };
const RATING_ORDER = ['Buy', 'Overweight', 'Hold', 'Underweight', 'Sell', 'REVIEW'];
const MIN_TRADING_DAYS = 5;   // TradingAgents' default holding window

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

function scoreEntry(entry, px, minDays = MIN_TRADING_DAYS) {
  const out = { id: entry.id, rating: entry.rating, status: 'pending' };
  if (!px || px.error) return { ...out, status: 'no-data', note: px && px.error ? px.error : 'no price data' };
  const a = px.asset;
  const b = px.bench;
  if (!a || !isNum(a.entry) || !isNum(a.latest)) return { ...out, status: 'no-data', note: 'no closes after the analysis date yet' };
  const days = a.closes_after;
  const ret = a.latest / a.entry - 1;
  out.days = days;
  out.entryDate = a.entry_date;
  out.latestDate = a.latest_date;
  out.entry = a.entry;
  out.latest = a.latest;
  out.return = ret;
  if (b && isNum(b.entry) && isNum(b.latest)) {
    out.benchReturn = b.latest / b.entry - 1;
    out.alpha = ret - out.benchReturn;
  }
  if (days < minDays) { out.status = 'too-early'; out.note = `${days} of ${minDays} trading days elapsed`; return out; }
  if (out.alpha == null) { out.status = 'no-benchmark'; return out; }
  const dir = DIRECTION[entry.rating];
  out.status = 'scored';
  if (dir === undefined) { out.status = 'unscored'; out.note = 'rating has no direction'; return out; }
  out.direction = dir;
  out.hit = dir === 0 ? null : (out.alpha * dir > 0);
  return out;
}

function aggregate(scored) {
  const done = scored.filter((s) => s.status === 'scored');
  const byRating = {};
  for (const s of done) {
    const g = (byRating[s.rating] = byRating[s.rating] || { n: 0, hits: 0, directional: 0, alphaSum: 0 });
    g.n++;
    g.alphaSum += s.alpha;
    if (s.hit !== null) { g.directional++; if (s.hit) g.hits++; }
  }
  const rows = RATING_ORDER.filter((r) => byRating[r]).map((r) => {
    const g = byRating[r];
    return { rating: r, n: g.n, hitRate: g.directional ? g.hits / g.directional : null, meanAlpha: g.alphaSum / g.n };
  });
  const directional = done.filter((s) => s.hit !== null);
  return {
    scored: done.length,
    directional: directional.length,
    hitRate: directional.length ? directional.filter((s) => s.hit).length / directional.length : null,
    meanAlpha: done.length ? done.reduce((a, s) => a + s.alpha, 0) / done.length : null,
    pending: scored.filter((s) => s.status === 'too-early').length,
    noData: scored.filter((s) => s.status === 'no-data' || s.status === 'no-benchmark').length,
    byRating: rows,
    caution: done.length < 20
      ? `Only ${done.length} scored decision${done.length === 1 ? '' : 's'}. Hit rates on samples this small are noise. Treat them as a record, not as evidence about the model.`
      : null,
  };
}

// Did the user act in line with the rating? Only actions that took a side are compared.
const ACTION_SIDE = { bought: 1, added: 1, sold: -1, trimmed: -1, passed: 0, held: 0, waiting: 0 };
function followed(entry) {
  const a = entry.action && entry.action.type;
  if (!a || !(a in ACTION_SIDE)) return null;
  const dir = DIRECTION[entry.rating];
  if (dir === undefined) return null;
  return ACTION_SIDE[a] === dir;   // passing/holding follows a Hold; anything else against a directional call does not
}

function adherence(entries, scoredById) {
  const rows = { followed: { n: 0, alphaSum: 0, scored: 0 }, notFollowed: { n: 0, alphaSum: 0, scored: 0 } };
  for (const e of entries) {
    const f = followed(e);
    if (f === null) continue;
    const g = f ? rows.followed : rows.notFollowed;
    g.n++;
    const s = scoredById[e.id];
    if (s && s.status === 'scored') { g.scored++; g.alphaSum += s.alpha; }
  }
  const fin = (g) => ({ n: g.n, scored: g.scored, meanAlpha: g.scored ? g.alphaSum / g.scored : null });
  return { followed: fin(rows.followed), notFollowed: fin(rows.notFollowed) };
}

module.exports = { DIRECTION, RATING_ORDER, MIN_TRADING_DAYS, scoreEntry, aggregate, followed, adherence };
