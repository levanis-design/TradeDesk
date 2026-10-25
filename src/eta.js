'use strict';
// Time-remaining estimates. A run passes fixed milestones (each analyst report, the research manager,
// the trader, the portfolio manager, the end). We record when each was first seen, keep that timeline with
// every finished run, and predict the rest of a new run from what the same model did before.
// With no history the estimate is only a rough guess and is labelled as one.

const ANALYST_KEY = { market: 'market_report', social: 'sentiment_report', news: 'news_report', fundamentals: 'fundamentals_report' };

function milestones(analysts) {
  const a = (analysts && analysts.length ? analysts : Object.keys(ANALYST_KEY)).map((k) => ANALYST_KEY[k]).filter(Boolean);
  return [...a, 'investment_plan', 'trader_investment_plan', 'final_trade_decision', 'briefing', 'end'];
}

const median = (xs) => {
  const s = xs.filter((x) => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Seconds spent between consecutive milestones that the timeline reached.
function segments(timeline, ms) {
  const seg = {};
  let prev = 0;
  for (const k of ms) {
    const t = timeline && timeline[k];
    if (typeof t === 'number' && Number.isFinite(t) && t >= prev) { seg[k] = t - prev; prev = t; }
  }
  return seg;
}

// history: [{ seconds, timeline? }] of finished runs on the same model, newest first.
function fullEstimate(history) {
  return median((history || []).map((h) => h.seconds));
}

function estimate({ elapsed, timeline = {}, ms, history = [] }) {
  const reached = ms.filter((k) => typeof timeline[k] === 'number');
  const lastAt = reached.length ? Math.max(...reached.map((k) => timeline[k])) : 0;
  const remainingKeys = ms.filter((k) => typeof timeline[k] !== 'number');
  if (!remainingKeys.length) return { remaining: 0, confidence: 'history', n: history.length };

  const withTimeline = history.filter((h) => h.timeline && Object.keys(segments(h.timeline, ms)).length >= 2);
  if (withTimeline.length) {
    const segs = withTimeline.map((h) => segments(h.timeline, ms));
    const total = fullEstimate(history);
    const known = {};
    for (const k of ms) known[k] = median(segs.map((s) => s[k]).filter((x) => x != null));
    const sumKnown = ms.reduce((a, k) => a + (known[k] || 0), 0);
    const unknownKeys = ms.filter((k) => known[k] == null);
    const share = total != null && unknownKeys.length ? Math.max(0, total - sumKnown) / unknownKeys.length : 0;
    const exp = (k) => (known[k] != null ? known[k] : share);
    const next = remainingKeys[0];
    const spent = Math.max(0, elapsed - lastAt);
    const eNext = exp(next);
    const curLeft = Math.max(eNext * 0.15, eNext - spent);
    const later = remainingKeys.slice(1).reduce((a, k) => a + exp(k), 0);
    return { remaining: curLeft + later, confidence: 'history', n: withTimeline.length };
  }
  const total = fullEstimate(history);
  if (total != null) return { remaining: Math.max(total * 0.1, total - elapsed), confidence: 'rough', n: history.length, basis: 'totals' };
  if (reached.length) {
    const f = reached.length / (ms.length - 1);
    if (f > 0 && f < 1) return { remaining: Math.max(0, (elapsed * (1 - f)) / f), confidence: 'rough', n: 0, basis: 'progress' };
  }
  return null;
}

// Queue rows: the running one has its own estimate; each waiting one starts when the ones ahead end.
// fulls is one full-run estimate per waiting item (null when unknown).
function schedule({ runningRemaining, hasRunning = true, fulls = [], waitingCount, fullEst }) {
  const list = fulls.length ? fulls : Array.from({ length: waitingCount || 0 }, () => (fullEst == null ? null : fullEst));
  const firstFull = list.length && list[0] != null ? list[0] : null;
  let cum = !hasRunning ? 0 : (runningRemaining != null ? runningRemaining : firstFull);
  const out = [];
  for (const f of list) {
    if (cum == null || f == null) { out.push(null); cum = null; continue; }
    cum += f;
    out.push(cum);
  }
  return out;
}

module.exports = { milestones, segments, estimate, fullEstimate, schedule, median };
