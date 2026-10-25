'use strict';
// DOM helpers. No innerHTML anywhere: model output and spreadsheet cells are untrusted text.
(function () {
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k.startsWith('on') && typeof v === 'function') el[k.toLowerCase()] = v;
        else if (k in el && k !== 'list' && k !== 'form') { try { el[k] = v; } catch { el.setAttribute(k, v); } }
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    append(el, kids);
    return el;
  }
  function append(el, kids) {
    for (const k of kids.flat(Infinity)) {
      if (k == null || k === false) continue;
      el.appendChild(k instanceof Node ? k : document.createTextNode(String(k)));
    }
    return el;
  }
  const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  // ---- minimal Markdown to DOM (headings, lists, tables, bold, italic, code, rules)
  function inline(text) {
    const out = [];
    const re = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\*[^*\s][^*]*\*)/g;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > last) out.push(text.slice(last, m.index));
      const t = m[0];
      if (t.startsWith('**') || t.startsWith('__')) out.push(h('strong', null, t.slice(2, -2)));
      else if (t.startsWith('`')) out.push(h('code', null, t.slice(1, -1)));
      else out.push(h('em', null, t.slice(1, -1)));
      last = m.index + t.length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  }

  function markdown(src) {
    const root = h('div', { class: 'md' });
    const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
    let i = 0;
    let para = [];
    const flush = () => { if (para.length) { root.appendChild(h('p', null, inline(para.join(' ')))); para = []; } };
    while (i < lines.length) {
      const line = lines[i];
      const t = line.trim();
      if (!t) { flush(); i++; continue; }
      let m;
      if ((m = /^(#{1,4})\s+(.*)$/.exec(t))) {
        flush();
        root.appendChild(h('h' + Math.min(6, m[1].length + 2), null, inline(m[2])));
        i++; continue;
      }
      if (/^(-{3,}|\*{3,})$/.test(t)) { flush(); root.appendChild(h('hr')); i++; continue; }
      if (/^\|.*\|$/.test(t) && i + 1 < lines.length && /^\|[\s:|-]+\|$/.test(lines[i + 1].trim())) {
        flush();
        const cells = (s) => s.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        const head = cells(t);
        i += 2;
        const body = [];
        while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) { body.push(cells(lines[i])); i++; }
        root.appendChild(h('div', { class: 'tablewrap' }, h('table', null,
          h('thead', null, h('tr', null, head.map((c) => h('th', null, inline(c))))),
          h('tbody', null, body.map((r) => h('tr', null, r.map((c) => h('td', null, inline(c)))))))));
        continue;
      }
      if (/^([-*+]|\d+[.)])\s+/.test(t)) {
        flush();
        const ordered = /^\d/.test(t);
        const list = h(ordered ? 'ol' : 'ul');
        while (i < lines.length && /^([-*+]|\d+[.)])\s+/.test(lines[i].trim())) {
          list.appendChild(h('li', null, inline(lines[i].trim().replace(/^([-*+]|\d+[.)])\s+/, ''))));
          i++;
        }
        root.appendChild(list);
        continue;
      }
      para.push(t);
      i++;
    }
    flush();
    return root;
  }

  // ---- formatting
  const money = (n, d = 2) => (typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—');
  const pct = (n, d = 1) => (typeof n === 'number' && Number.isFinite(n) ? `${n >= 0 ? '+' : ''}${(n * 100).toFixed(d)}%` : '—');
  const qty = (n) => (typeof n === 'number' ? String(Math.round(n * 1e6) / 1e6) : '—');
  function duration(sec) {
    if (sec == null || !Number.isFinite(sec)) return '—';
    sec = Math.round(sec);
    if (sec < 90) return `${sec} s`;
    const m = Math.round(sec / 60);
    if (m < 90) return `${m} min`;
    return `${Math.floor(m / 60)} h ${m % 60} min`;
  }
  const today = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

  const RATING = {
    Buy: { cls: 'bull2', glyph: '▲▲', note: 'strongly favours adding' },
    Overweight: { cls: 'bull1', glyph: '▲', note: 'leans towards adding' },
    Hold: { cls: 'neutral', glyph: '■', note: 'no change' },
    Underweight: { cls: 'bear1', glyph: '▼', note: 'leans towards reducing' },
    Sell: { cls: 'bear2', glyph: '▼▼', note: 'strongly favours reducing' },
    REVIEW: { cls: 'review', glyph: '?', note: 'no readable rating, read the text' },
  };
  function ratingBadge(r) {
    const k = RATING[r] || RATING.REVIEW;
    return h('span', { class: `badge rating ${k.cls}`, title: k.note }, h('span', { class: 'glyph', 'aria-hidden': 'true' }, k.glyph), ' ', r || 'REVIEW');
  }

  function toast(msg, kind = 'info') {
    const box = $('#toasts');
    const t = h('div', { class: `toast ${kind}`, role: 'status' }, msg);
    box.appendChild(t);
    setTimeout(() => t.remove(), kind === 'error' ? 9000 : 4000);
  }

  window.U = { h, append, clear, $, $$, markdown, money, pct, qty, duration, today, ratingBadge, RATING, toast };
})();
