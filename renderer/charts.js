'use strict';
// Small SVG charts built with the DOM, no libraries and no inline style attributes (the page forbids them).
// Colours come from CSS classes and variables, so light and dark themes both work.
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  const { h, clear } = U;

  function s(tag, attrs, ...kids) {
    const el = document.createElementNS(NS, tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) { if (v != null && v !== false) el.setAttribute(k, v === true ? '' : String(v)); }
    for (const k of kids.flat(Infinity)) { if (k != null && k !== false) el.appendChild(k instanceof Node ? k : document.createTextNode(String(k))); }
    return el;
  }

  const num = (x) => typeof x === 'number' && Number.isFinite(x);
  const compact = (v) => {
    const a = Math.abs(v);
    if (a >= 1e9) return (v / 1e9).toFixed(a >= 1e10 ? 0 : 1) + 'B';
    if (a >= 1e6) return (v / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M';
    if (a >= 1e4) return (v / 1e3).toFixed(0) + 'k';
    if (a >= 100) return v.toFixed(0);
    return v.toFixed(2);
  };

  // Nice y ticks
  function ticks(min, max, n = 4) {
    if (min === max) { min -= 1; max += 1; }
    const span = max - min;
    const step0 = span / n;
    const mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= step0) || step0;
    const lo = Math.floor(min / step) * step;
    const out = [];
    for (let v = lo; v <= max + step * 0.5; v += step) out.push(+v.toFixed(10));
    return out;
  }
  const dayMs = (d) => Date.parse(d + 'T00:00:00Z');
  const monthShort = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dateLabel = (d, spanDays) => {
    const [y, m, dd] = d.split('-').map(Number);
    return spanDays > 400 ? `${monthShort[m - 1]} ${y}` : `${monthShort[m - 1]} ${dd}${spanDays > 200 ? ' ' + String(y).slice(2) : ''}`;
  };

  // opts: { points:[[date,value]], height, fmt, ranges:[..], range, lines:[{y,label,cls}], cost, name, onRange }
  function line(opts) {
    const P = window.Portfolio;
    const fmt = opts.fmt || ((v) => compact(v));
    let range = opts.range || (opts.ranges && opts.ranges[opts.ranges.length - 1]);
    const H = opts.height || 220;
    const wrap = h('div', { class: 'chart' });
    const bar = h('div', { class: 'chart-bar' });
    const stage = h('div', { class: 'chart-stage' });
    const tip = h('div', { class: 'chart-tip', hidden: true });
    const summary = h('span', { class: 'chart-sum' });
    wrap.append(h('div', { class: 'chart-top' }, summary, h('div', { class: 'spacer' }), bar), stage);
    stage.append(tip);
    let svg = null;
    let state = null;

    const data = () => (opts.ranges && range ? P.slice(opts.points, range) : opts.points);

    function draw() {
      if (svg) svg.remove();
      const pts = data();
      const W = Math.max(260, stage.clientWidth || 560);
      svg = s('svg', { class: 'chart-svg', width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': opts.name || 'Chart' });
      stage.insertBefore(svg, tip);
      clear(summary);
      if (pts.length < 2) { svg.append(s('text', { x: W / 2, y: H / 2, class: 'chart-empty', 'text-anchor': 'middle' }, 'Not enough data to draw this.')); state = null; return; }
      const ch = P.change(pts);
      if (ch) {
        summary.append(h('b', null, fmt(pts[pts.length - 1][1])), ' ',
          h('span', { class: ch.pct >= 0 ? 'pos' : 'neg' }, `${ch.pct >= 0 ? '+' : '−'}${(Math.abs(ch.pct) * 100).toFixed(1)}%`),
          h('span', { class: 'hint' }, ` over ${range || 'the period'}`));
      }
      const pad = { l: 54, r: 10, t: 8, b: 22 };
      const vals = pts.map((p) => p[1]);
      const extra = [];
      const dmin = Math.min(...vals); const dmax = Math.max(...vals);
      // A cost line far from the prices would flatten the chart, so it is only drawn when it is near them.
      const cost = num(opts.cost) && opts.cost >= dmin * 0.6 && opts.cost <= dmax * 1.4 ? opts.cost : null;
      if (cost != null) extra.push(cost);
      (opts.lines || []).forEach((l) => { if (num(l.y)) extra.push(l.y); });
      let lo = Math.min(...vals, ...extra); let hi = Math.max(...vals, ...extra);
      const padv = (hi - lo) * 0.06 || Math.abs(hi) * 0.02 || 1;
      lo -= padv; hi += padv;
      if (dmin >= 0 && lo < 0) lo = 0;
      const yt = ticks(lo, hi, 4);
      lo = Math.max(dmin >= 0 ? 0 : -Infinity, Math.min(lo, yt[0])); hi = Math.max(hi, yt[yt.length - 1]);
      const t0 = dayMs(pts[0][0]); const t1 = dayMs(pts[pts.length - 1][0]);
      const X = (d) => pad.l + ((dayMs(d) - t0) / (t1 - t0 || 1)) * (W - pad.l - pad.r);
      const Y = (v) => pad.t + (1 - (v - lo) / (hi - lo || 1)) * (H - pad.t - pad.b);
      const g = s('g');
      yt.forEach((v) => {
        if (v < lo || v > hi) return;
        g.append(s('line', { class: 'grid', x1: pad.l, x2: W - pad.r, y1: Y(v), y2: Y(v) }), s('text', { class: 'axis', x: pad.l - 6, y: Y(v) + 4, 'text-anchor': 'end' }, fmt(v)));
      });
      const spanDays = (t1 - t0) / 86400000;
      [0, 1, 2, 3].forEach((i) => {
        const idx = Math.round((pts.length - 1) * (i / 3));
        const anchor = i === 0 ? 'start' : i === 3 ? 'end' : 'middle';
        g.append(s('text', { class: 'axis', x: X(pts[idx][0]), y: H - 6, 'text-anchor': anchor }, dateLabel(pts[idx][0], spanDays)));
      });
      (opts.lines || []).forEach((l) => {
        if (!num(l.y)) return;
        g.append(s('line', { class: `refline ${l.cls || ''}`, x1: pad.l, x2: W - pad.r, y1: Y(l.y), y2: Y(l.y) }),
          s('text', { class: `refname ${l.cls || ''}`, x: W - pad.r - 2, y: Y(l.y) - 3, 'text-anchor': 'end' }, l.label));
      });
      if (cost != null) {
        g.append(s('line', { class: 'refline cost', x1: pad.l, x2: W - pad.r, y1: Y(cost), y2: Y(cost) }),
          s('text', { class: 'refname cost', x: pad.l + 4, y: Y(cost) - 3 }, opts.costLabel || 'cost basis'));
      }
      const d = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join('');
      const up = pts[pts.length - 1][1] >= pts[0][1];
      g.append(s('path', { class: 'area', d: `${d}L${X(pts[pts.length - 1][0]).toFixed(1)},${H - pad.b}L${X(pts[0][0]).toFixed(1)},${H - pad.b}Z` }));
      g.append(s('path', { class: `ln ${up ? 'up' : 'down'}`, d }));
      const cross = s('line', { class: 'cross', y1: pad.t, y2: H - pad.b, hidden: true });
      const dot = s('circle', { class: `dot ${up ? 'up' : 'down'}`, r: 4, hidden: true });
      g.append(cross, dot);
      svg.append(g);
      state = { pts, X, Y, pad, W, cross, dot };
    }

    stage.addEventListener('mousemove', (e) => {
      if (!state) return;
      const r = svg.getBoundingClientRect();
      const x = e.clientX - r.left;
      let best = 0; let bd = Infinity;
      state.pts.forEach((p, i) => { const dd = Math.abs(state.X(p[0]) - x); if (dd < bd) { bd = dd; best = i; } });
      const p = state.pts[best];
      const px = state.X(p[0]); const py = state.Y(p[1]);
      state.cross.setAttribute('x1', px); state.cross.setAttribute('x2', px); state.cross.removeAttribute('hidden');
      state.dot.setAttribute('cx', px); state.dot.setAttribute('cy', py); state.dot.removeAttribute('hidden');
      clear(tip).append(h('div', { class: 'hint' }, p[0]), h('b', null, fmt(p[1])));
      tip.hidden = false;
      const left = Math.min(Math.max(4, px + 10), state.W - 110);
      tip.style.left = `${left}px`;
      tip.style.top = `${Math.max(2, py - 44)}px`;
    });
    stage.addEventListener('mouseleave', () => { tip.hidden = true; if (state) { state.cross.setAttribute('hidden', ''); state.dot.setAttribute('hidden', ''); } });

    if (opts.ranges) {
      opts.ranges.forEach((r) => bar.append(h('button', { class: 'rng' + (r === range ? ' active' : ''), type: 'button', dataset: { range: r }, onclick: () => {
        range = r; if (opts.onRange) opts.onRange(r);
        U.$$('.rng', bar).forEach((b) => b.classList.toggle('active', b.dataset.range === r));
        draw();
      } }, r)));
    }
    let lastW = 0;
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { const w = stage.clientWidth; if (w && Math.abs(w - lastW) > 2) { lastW = w; draw(); } }) : null;
    if (ro) ro.observe(stage);
    requestAnimationFrame(() => { if (!lastW) draw(); });
    wrap.redraw = draw;
    return wrap;
  }


  // Several series as percent change from a common starting point, spaced by trading day, with a vertical marker.
  // opts: { series:[{name, points:[[date, fraction]]}], mark:'YYYY-MM-DD', markLabel, height }
  function compare(opts) {
    const H = opts.height || 220;
    const wrap = h('div', { class: 'chart' });
    const stage = h('div', { class: 'chart-stage' });
    wrap.append(stage);
    const sign = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(1)}%`;
    let svg = null;
    function draw() {
      if (svg) svg.remove();
      const W = Math.max(260, stage.clientWidth || 560);
      svg = s('svg', { class: 'chart-svg', width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': opts.name || 'Price change around the event' });
      stage.append(svg);
      const dates = [...new Set(opts.series.flatMap((x) => x.points.map((p) => p[0])))].sort();
      if (dates.length < 2) { svg.append(s('text', { x: W / 2, y: H / 2, class: 'chart-empty', 'text-anchor': 'middle' }, 'Not enough data to draw this.')); return; }
      const all = opts.series.flatMap((x) => x.points.map((p) => p[1])).concat([0]);
      let lo = Math.min(...all); let hi = Math.max(...all);
      const padv = (hi - lo) * 0.1 || 0.01; lo -= padv; hi += padv;
      const yt = ticks(lo * 100, hi * 100, 4).map((v) => v / 100);
      lo = Math.min(lo, yt[0]); hi = Math.max(hi, yt[yt.length - 1]);
      const pad = { l: 50, r: 46, t: 10, b: 22 };
      const X = (d) => pad.l + (dates.indexOf(d) / (dates.length - 1)) * (W - pad.l - pad.r);
      const Y = (v) => pad.t + (1 - (v - lo) / (hi - lo || 1)) * (H - pad.t - pad.b);
      const g = s('g');
      yt.forEach((v) => { if (v < lo || v > hi) return; g.append(s('line', { class: v === 0 ? 'grid zero' : 'grid', x1: pad.l, x2: W - pad.r, y1: Y(v), y2: Y(v) }), s('text', { class: 'axis', x: pad.l - 6, y: Y(v) + 4, 'text-anchor': 'end' }, `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v * 100).toFixed(Math.abs(v) < 0.1 ? 1 : 0)}%`)); });
      [0, Math.floor((dates.length - 1) / 2), dates.length - 1].forEach((i, k) => g.append(s('text', { class: 'axis', x: X(dates[i]), y: H - 6, 'text-anchor': k === 0 ? 'start' : k === 2 ? 'end' : 'middle' }, dateLabel(dates[i], 30))));
      if (opts.mark && dates.includes(opts.mark)) {
        const mx = X(opts.mark);
        g.append(s('line', { class: 'eventmark', x1: mx, x2: mx, y1: pad.t, y2: H - pad.b }), s('text', { class: 'axis eventname', x: mx + 4, y: pad.t + 10 }, opts.markLabel || 'event'));
      }
      const usedY = [];
      opts.series.forEach((x, i) => {
        const pts = x.points.filter((p) => dates.includes(p[0]));
        if (pts.length < 2) return;
        g.append(s('path', { class: `cmpline cs${i}`, d: pts.map((p, j) => `${j ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join('') }));
        pts.forEach((p) => g.append(s('circle', { class: `cmpdot cs${i}`, cx: X(p[0]), cy: Y(p[1]), r: 2.6 }, s('title', null, `${x.name}, ${p[0]}: ${sign(p[1])}`))));
        const last = pts[pts.length - 1];
        let ly = Y(last[1]) + 4;
        while (usedY.some((u) => Math.abs(u - ly) < 12)) ly += 12;
        usedY.push(ly);
        g.append(s('text', { class: `cmplabel cs${i}`, x: X(last[0]) + 5, y: ly }, x.name));
      });
      svg.append(g);
    }
    let lastW = 0;
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { const w = stage.clientWidth; if (w && Math.abs(w - lastW) > 2) { lastW = w; draw(); } }) : null;
    if (ro) ro.observe(stage);
    requestAnimationFrame(() => { if (!lastW) draw(); });
    wrap.redraw = draw;
    return wrap;
  }

  // Candles or a close line over bars, spaced by bar rather than by clock so nights and weekends leave no gaps.
  // opts: { bars:[[time,o,h,l,c,v]], style:'candles'|'line', height, fmt, name, showVolume, approx }
  function ohlc(opts) {
    const P = window.Portfolio;
    const fmt = opts.fmt || ((v) => compact(v));
    const H = opts.height || 260;
    const wrap = h('div', { class: 'chart' });
    const stage = h('div', { class: 'chart-stage' });
    const tip = h('div', { class: 'chart-tip wide', hidden: true });
    const summary = h('span', { class: 'chart-sum' });
    wrap.append(h('div', { class: 'chart-top' }, summary), stage);
    stage.append(tip);
    let svg = null; let state = null;
    const intraday = (t) => t.length > 10;
    const dayOf = (t) => t.slice(0, 10);

    function draw() {
      if (svg) svg.remove();
      const W = Math.max(260, stage.clientWidth || 560);
      svg = s('svg', { class: 'chart-svg', width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': opts.name || 'Price chart' });
      stage.insertBefore(svg, tip);
      clear(summary);
      const pad = { l: 54, r: 10, t: 8, b: 22 };
      const plotW = W - pad.l - pad.r;
      const bars = P.aggregate((opts.bars || []).filter((b) => b && b.length >= 5), Math.max(20, Math.floor(plotW / 4)));
      if (bars.length < 2) { svg.append(s('text', { x: W / 2, y: H / 2, class: 'chart-empty', 'text-anchor': 'middle' }, 'Not enough data to draw this.')); state = null; return; }
      const first = bars[0][1]; const last = bars[bars.length - 1][4];
      if (first) summary.append(h('b', null, fmt(last)), ' ', h('span', { class: last >= first ? 'pos' : 'neg' }, `${last >= first ? '+' : '−'}${(Math.abs(last / first - 1) * 100).toFixed(1)}%`), h('span', { class: 'hint' }, ` from the first open, ${bars.length} bar${bars.length === 1 ? '' : 's'}`));
      const line = opts.style === 'line';
      let lo = Math.min(...bars.map((b) => (line ? b[4] : b[3]))); let hi = Math.max(...bars.map((b) => (line ? b[4] : b[2])));
      const dmin = lo;
      const padv = (hi - lo) * 0.06 || Math.abs(hi) * 0.02 || 1;
      lo -= padv; hi += padv;
      if (dmin >= 0 && lo < 0) lo = 0;
      const yt = ticks(lo, hi, 4);
      lo = Math.max(dmin >= 0 ? 0 : -Infinity, Math.min(lo, yt[0])); hi = Math.max(hi, yt[yt.length - 1]);
      const step = plotW / bars.length;
      const X = (i) => pad.l + (i + 0.5) * step;
      const Y = (v) => pad.t + (1 - (v - lo) / (hi - lo || 1)) * (H - pad.t - pad.b);
      const g = s('g');
      yt.forEach((v) => { if (v < lo || v > hi) return; g.append(s('line', { class: 'grid', x1: pad.l, x2: W - pad.r, y1: Y(v), y2: Y(v) }), s('text', { class: 'axis', x: pad.l - 6, y: Y(v) + 4, 'text-anchor': 'end' }, fmt(v))); });
      // day dividers and labels
      const isIntra = intraday(bars[0][0]);
      const marks = [];
      if (isIntra) {
        bars.forEach((b, i) => { if (i === 0 || dayOf(b[0]) !== dayOf(bars[i - 1][0])) marks.push(i); });
        if (marks.length > 1) marks.slice(1).forEach((i) => g.append(s('line', { class: 'dayline', x1: pad.l + i * step, x2: pad.l + i * step, y1: pad.t, y2: H - pad.b })));
      }
      const labelAt = (i) => {
        const t = bars[i][0];
        if (!isIntra) { const spanDays = (dayMs(dayOf(bars[bars.length - 1][0])) - dayMs(dayOf(bars[0][0]))) / 86400000; return dateLabel(dayOf(t), spanDays); }
        return marks.length > 1 ? dateLabel(dayOf(t), 30) : t.slice(11);
      };
      let idxs;
      if (isIntra && marks.length > 1) { idxs = marks.filter((i, k) => k === 0 || (i - marks[k - 1]) * step >= 54).slice(0, 8); } else { idxs = [0, 1, 2, 3].map((k) => Math.round((bars.length - 1) * (k / 3))); }
      idxs.forEach((i) => g.append(s('text', { class: 'axis', x: Math.min(Math.max(X(i), pad.l + 14), W - pad.r - 14), y: H - 6, 'text-anchor': 'middle' }, labelAt(i))));
      if (line) {
        const d = bars.map((b, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(b[4]).toFixed(1)}`).join('');
        const up = last >= bars[0][4];
        g.append(s('path', { class: 'area', d: `${d}L${X(bars.length - 1).toFixed(1)},${H - pad.b}L${X(0).toFixed(1)},${H - pad.b}Z` }), s('path', { class: `ln ${up ? 'up' : 'down'}`, d }));
      } else {
        const bw = Math.max(1, Math.min(14, step * 0.68));
        bars.forEach((b, i) => {
          const up = b[4] >= b[1]; const x = X(i);
          const top = Y(Math.max(b[1], b[4])); const bot = Y(Math.min(b[1], b[4]));
          g.append(s('line', { class: `wick ${up ? 'up' : 'down'}`, x1: x, x2: x, y1: Y(b[2]), y2: Y(b[3]) }),
            s('rect', { class: `cd ${up ? 'up' : 'down'}`, x: x - bw / 2, y: top, width: bw, height: Math.max(1, bot - top) }));
        });
      }
      const cross = s('line', { class: 'cross', y1: pad.t, y2: H - pad.b, hidden: true });
      g.append(cross);
      svg.append(g);
      state = { bars, X, Y, W, step, pad, cross };
    }

    stage.addEventListener('mousemove', (e) => {
      if (!state) return;
      const r = svg.getBoundingClientRect();
      const i = Math.max(0, Math.min(state.bars.length - 1, Math.floor((e.clientX - r.left - state.pad.l) / state.step)));
      const b = state.bars[i]; const px = state.X(i);
      state.cross.setAttribute('x1', px); state.cross.setAttribute('x2', px); state.cross.removeAttribute('hidden');
      const col = (k, v) => h('span', { class: 'ohlc-k' }, k + ' ', h('b', null, fmt(v)));
      clear(tip).append(h('div', { class: 'hint' }, b[0]), h('div', { class: 'ohlc' }, col('O', b[1]), col('H', b[2]), col('L', b[3]), col('C', b[4])),
        !opts.hideVolume && b[5] ? h('div', { class: 'hint' }, `volume ${compact(b[5])}`) : null);
      tip.hidden = false;
      tip.style.left = `${Math.min(Math.max(4, px + 12), state.W - 190)}px`;
      tip.style.top = '4px';
    });
    stage.addEventListener('mouseleave', () => { tip.hidden = true; if (state) state.cross.setAttribute('hidden', ''); });
    let lastW = 0;
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { const w = stage.clientWidth; if (w && Math.abs(w - lastW) > 2) { lastW = w; draw(); } }) : null;
    if (ro) ro.observe(stage);
    requestAnimationFrame(() => { if (!lastW) draw(); });
    wrap.redraw = draw;
    return wrap;
  }

  // A tiny trend line for lists.
  function spark(values, { w = 84, hgt = 26 } = {}) {
    const v = (values || []).filter(num);
    const svg = s('svg', { class: 'spark', width: w, height: hgt, viewBox: `0 0 ${w} ${hgt}`, 'aria-hidden': 'true' });
    if (v.length < 2) return svg;
    const lo = Math.min(...v); const hi = Math.max(...v);
    const d = v.map((x, i) => `${i ? 'L' : 'M'}${((i / (v.length - 1)) * (w - 2) + 1).toFixed(1)},${((1 - (x - lo) / (hi - lo || 1)) * (hgt - 4) + 2).toFixed(1)}`).join('');
    svg.append(s('path', { class: `ln ${v[v.length - 1] >= v[0] ? 'up' : 'down'}`, d }));
    return svg;
  }

  // Donut for allocation. items: [{name,value,weight,cash,rolled}]
  function donut(items, { size = 190, center } = {}) {
    const r = size / 2; const ro = r - 2; const ri = r * 0.6;
    const svg = s('svg', { class: 'donut', width: size, height: size, viewBox: `0 0 ${size} ${size}`, role: 'img', 'aria-label': 'Share of the portfolio by holding' });
    let a0 = -Math.PI / 2;
    const arc = (a, b) => {
      const big = b - a > Math.PI ? 1 : 0;
      const p = (rad, ang) => `${(r + rad * Math.cos(ang)).toFixed(2)},${(r + rad * Math.sin(ang)).toFixed(2)}`;
      return `M${p(ro, a)}A${ro},${ro} 0 ${big} 1 ${p(ro, b)}L${p(ri, b)}A${ri},${ri} 0 ${big} 0 ${p(ri, a)}Z`;
    };
    items.forEach((it, i) => {
      const span = it.weight * Math.PI * 2;
      if (span <= 0) return;
      const cls = it.cash ? 'slice cashc' : it.name === 'Other' ? 'slice otherc' : `slice c${i % 8}`;
      const path = items.length === 1 ? s('circle', { class: cls, cx: r, cy: r, r: (ro + ri) / 2, 'stroke-width': ro - ri, fill: 'none' }) : s('path', { class: cls, d: arc(a0, a0 + Math.min(span, Math.PI * 2 - 0.0001)) });
      path.append(s('title', null, `${it.name}: ${(it.weight * 100).toFixed(1)}%`));
      svg.append(path);
      a0 += span;
    });
    if (center) svg.append(s('text', { class: 'donut-big', x: r, y: r - 2, 'text-anchor': 'middle' }, center[0]), s('text', { class: 'donut-sm', x: r, y: r + 16, 'text-anchor': 'middle' }, center[1]));
    return svg;
  }
  const colorClass = (it, i) => (it.cash ? 'cashc' : it.name === 'Other' ? 'otherc' : `c${i % 8}`);

  // Horizontal bars either side of zero. rows: [{name, value}]
  function bars(rows, { fmt = compact, width = 420 } = {}) {
    const rowH = 24; const padR = 70;
    const hasNeg0 = rows.some((r) => r.value < 0);
    const padL = 64 + (hasNeg0 ? 58 : 0);
    const H = rows.length * rowH + 6;
    const svg = s('svg', { class: 'bars', width, height: H, viewBox: `0 0 ${width} ${H}`, role: 'img', 'aria-label': 'Profit or loss by holding' });
    const vals = rows.map((r) => r.value);
    const mx = Math.max(...vals.map(Math.abs), 1e-9);
    const hasNeg = vals.some((v) => v < 0); const hasPos = vals.some((v) => v > 0);
    const inner = width - padL - padR;
    const zero = padL + (hasNeg && hasPos ? inner / 2 : hasNeg ? inner : 0);
    const scale = (hasNeg && hasPos ? inner / 2 : inner) / mx;
    svg.append(s('line', { class: 'grid', x1: zero, x2: zero, y1: 0, y2: H }));
    rows.forEach((r, i) => {
      const y = i * rowH + 4; const w = Math.abs(r.value) * scale;
      const x = r.value >= 0 ? zero : zero - w;
      svg.append(s('text', { class: 'axis', x: 0, y: y + 13, 'text-anchor': 'start' }, r.name),
        s('rect', { class: r.value >= 0 ? 'barpos' : 'barneg', x, y, width: Math.max(1, w), height: 16, rx: 2 }),
        s('text', { class: 'axis', x: r.value >= 0 ? x + w + 4 : x - 4, y: y + 13, 'text-anchor': r.value >= 0 ? 'start' : 'end' }, `${r.value >= 0 ? '+' : '−'}${fmt(Math.abs(r.value))}`));
    });
    return svg;
  }

  // A track from low to high with a marker for where the price is.
  function rangeBar(low, high, price, fmt) {
    const wrap = h('div', { class: 'rangebar' });
    if (!num(low) || !num(high) || !num(price) || high <= low) return h('span', { class: 'hint' }, '—');
    const frac = Math.min(1, Math.max(0, (price - low) / (high - low)));
    const mark = h('span', { class: 'mark' });
    mark.style.left = `${(frac * 100).toFixed(1)}%`;
    wrap.append(h('div', { class: 'track' }, mark), h('div', { class: 'ends' }, h('span', null, fmt(low)), h('span', null, `${Math.round(frac * 100)}% of the way up`), h('span', null, fmt(high))));
    return wrap;
  }

  window.TDCharts = { line, compare, ohlc, spark, donut, bars, rangeBar, colorClass, compact, s };
})();
