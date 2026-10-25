'use strict';
// Draggable dividers. A divider sits between two grid tracks; dragging it sets a CSS variable on the grid, which the
// grid template reads. Sizes are remembered on this computer. Arrow keys move it, double click resets it.
(function () {
  const { h } = U;
  const KEY = 'tradedesk.split.';
  const store = {
    get(k) { try { return window.localStorage.getItem(KEY + k); } catch { return null; } },
    set(k, v) { try { if (v == null) window.localStorage.removeItem(KEY + k); else window.localStorage.setItem(KEY + k, v); } catch { /* storage unavailable: the size just is not remembered */ } },
  };

  // opts: { dir:'col'|'row', grid, prop, first (element before the divider), min, minOther, id, label }
  TD.splitter = function (opts) {
    const col = opts.dir === 'col';
    const el = h('div', { class: `gutter ${col ? 'gv' : 'gh'}`, role: 'separator', tabindex: '0', 'aria-orientation': col ? 'vertical' : 'horizontal', 'aria-label': opts.label || 'Resize panes', title: 'Drag to resize. Double click to reset.' });
    const min = opts.min || 160; const minOther = opts.minOther || 200;
    const size = () => { const r = opts.first().getBoundingClientRect(); return col ? r.width : r.height; };
    const total = () => { const r = opts.grid.getBoundingClientRect(); return col ? r.width : r.height; };
    const apply = (px) => {
      const v = Math.round(Math.max(min, Math.min(px, total() - minOther - 16)));
      opts.grid.style.setProperty(opts.prop, `${v}px`);
      el.setAttribute('aria-valuenow', String(v));
      return v;
    };
    const saved = store.get(opts.id);
    if (saved && Number.isFinite(Number(saved))) opts.grid.style.setProperty(opts.prop, `${Number(saved)}px`);
    let start = null;
    el.addEventListener('pointerdown', (e) => {
      if (e.button != null && e.button !== 0) return;
      start = { at: col ? e.clientX : e.clientY, size: size() };
      el.setPointerCapture(e.pointerId);
      el.classList.add('drag'); document.body.classList.add('dragging');
      e.preventDefault();
    });
    el.addEventListener('pointermove', (e) => { if (start) apply(start.size + (col ? e.clientX : e.clientY) - start.at); });
    const end = (e) => {
      if (!start) return;
      start = null; el.classList.remove('drag'); document.body.classList.remove('dragging');
      try { el.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      store.set(opts.id, String(Math.round(size())));
      window.dispatchEvent(new Event('resize'));
    };
    el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
    el.addEventListener('dblclick', () => { opts.grid.style.removeProperty(opts.prop); store.set(opts.id, null); window.dispatchEvent(new Event('resize')); });
    el.addEventListener('keydown', (e) => {
      const dec = col ? 'ArrowLeft' : 'ArrowUp'; const inc = col ? 'ArrowRight' : 'ArrowDown';
      if (e.key !== dec && e.key !== inc && e.key !== 'Home') return;
      e.preventDefault();
      if (e.key === 'Home') { opts.grid.style.removeProperty(opts.prop); store.set(opts.id, null); return; }
      const v = apply(size() + (e.key === inc ? 24 : -24));
      store.set(opts.id, String(v));
    });
    return el;
  };
  TD.splitStore = store;
})();
