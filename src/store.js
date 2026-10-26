'use strict';
// Local persistence. Plain JSON files under the app data folder, written atomically.
// API keys are encrypted with the OS (Electron safeStorage, injected so tests can
// run without Electron). If encryption is unavailable a key is refused, never
// written in plain text.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROVIDERS = ['ollama', 'openai_compatible', 'anthropic', 'openai'];
const LOCAL_PROVIDERS = new Set(['ollama', 'openai_compatible']);
const ANALYSTS = ['market', 'social', 'news', 'fundamentals'];
const SECRET_NAMES = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'FRED_API_KEY', 'ALPHA_VANTAGE_API_KEY'];
const ACTIONS = ['bought', 'added', 'sold', 'trimmed', 'held', 'passed', 'waiting'];

const DEFAULTS = {
  provider: 'ollama',
  ollamaUrl: 'http://localhost:11434',
  backendUrl: '',
  quickModel: 'qwen3:latest',
  deepModel: 'qwen3:latest',
  debateRounds: 1,
  riskRounds: 1,
  language: 'English',
  analysts: ['market', 'social', 'news', 'fundamentals'],
  temperature: '',
  pythonPath: '',
  benchmark: 'SPY',
  cashOverride: '',
  secUserAgent: '',
};

const clampInt = (v, lo, hi, d) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};

function cleanUrl(u) {
  const s = String(u || '').trim().replace(/\/+$/, '');
  if (!s) return '';
  let url;
  try { url = new URL(s); } catch { throw new Error('That address is not a valid URL.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http and https addresses are allowed.');
  if (url.username || url.password) throw new Error('Do not put a username or password in the address.');
  return s;
}

function cleanSettings(input, base = DEFAULTS) {
  const s = { ...base, ...input };
  const out = {};
  out.provider = PROVIDERS.includes(s.provider) ? s.provider : DEFAULTS.provider;
  out.ollamaUrl = cleanUrl(s.ollamaUrl) || DEFAULTS.ollamaUrl;
  out.backendUrl = cleanUrl(s.backendUrl);
  out.quickModel = String(s.quickModel || '').trim().slice(0, 120) || DEFAULTS.quickModel;
  out.deepModel = String(s.deepModel || '').trim().slice(0, 120) || out.quickModel;
  out.debateRounds = clampInt(s.debateRounds, 1, 3, 1);
  out.riskRounds = clampInt(s.riskRounds, 1, 3, 1);
  out.language = String(s.language || 'English').trim().slice(0, 40) || 'English';
  const an = (Array.isArray(s.analysts) ? s.analysts : []).filter((a) => ANALYSTS.includes(a));
  out.analysts = an.length ? [...new Set(an)] : DEFAULTS.analysts.slice();
  const t = String(s.temperature === undefined || s.temperature === null ? '' : s.temperature).trim();
  out.temperature = t === '' ? '' : String(Math.min(2, Math.max(0, Number(t) || 0)));
  out.pythonPath = String(s.pythonPath || '').trim().slice(0, 400);
  out.benchmark = String(s.benchmark || 'SPY').trim().toUpperCase().replace(/[^A-Z0-9.\-^=]/g, '').slice(0, 15) || 'SPY';
  const c = String(s.cashOverride === undefined || s.cashOverride === null ? '' : s.cashOverride).trim();
  out.cashOverride = c === '' || !Number.isFinite(Number(c)) || Number(c) < 0 ? '' : String(Number(c));
  const ua = String(s.secUserAgent || '').trim().replace(/[\r\n]+/g, ' ').slice(0, 200);
  out.secUserAgent = /^[^@\s]+.*\S+@\S+\.\S+$/.test(ua) && !ua.includes('you@example.com') ? ua : '';
  return out;
}

function cleanTicker(t) {
  const s = String(t || '').trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9.\-=^]{0,14}$/.test(s)) throw new Error(`"${t}" does not look like a ticker.`);
  return s;
}

function createStore(dir, deps = {}) {
  const now = deps.now || (() => new Date());
  const enc = deps.encrypt || null;
  const dec = deps.decrypt || null;
  const canEncrypt = deps.canEncrypt || (() => false);
  fs.mkdirSync(path.join(dir, 'runs'), { recursive: true });

  const file = (n) => path.join(dir, n);
  function read(name, fallback) {
    try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch { return fallback; }
  }
  function write(name, data) {
    const tmp = file(name + '.' + crypto.randomBytes(4).toString('hex') + '.tmp');
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file(name));
  }
  const id = () => now().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14) + '-' + crypto.randomBytes(3).toString('hex');

  const api = {
    dir,
    DEFAULTS,

    // ---- settings
    getSettings() { return cleanSettings(read('settings.json', {})); },
    setSettings(patch) {
      const next = cleanSettings(patch, api.getSettings());
      write('settings.json', next);
      return next;
    },
    isLocalProvider(settings = api.getSettings()) { return LOCAL_PROVIDERS.has(settings.provider); },

    // ---- secrets (encrypted at rest)
    secretStatus() {
      const s = read('secrets.json', {});
      return Object.fromEntries(SECRET_NAMES.map((n) => [n, !!s[n]]));
    },
    setSecret(name, value) {
      if (!SECRET_NAMES.includes(name)) throw new Error('Unknown key name.');
      const s = read('secrets.json', {});
      if (!value) { delete s[name]; write('secrets.json', s); return; }
      if (!canEncrypt() || !enc) throw new Error('Secure storage is not available on this computer, so the key was not saved.');
      s[name] = enc(String(value).trim()).toString('base64');
      write('secrets.json', s);
    },
    getSecrets() {
      const s = read('secrets.json', {});
      const out = {};
      for (const n of SECRET_NAMES) {
        if (!s[n] || !dec) continue;
        try { out[n] = dec(Buffer.from(s[n], 'base64')); } catch { /* unreadable on this machine: skip */ }
      }
      return out;
    },

    // ---- holdings
    getHoldings() { return read('holdings.json', { positions: [], cash: null, byAccount: {}, importedAt: null, source: null }); },
    setHoldings(h) {
      const clean = {
        positions: (h.positions || []).map((p) => ({
          ticker: cleanTicker(p.ticker),
          quantity: Number(p.quantity),
          averagePrice: p.averagePrice == null || p.averagePrice === '' ? null : Number(p.averagePrice),
          lastPrice: p.lastPrice == null || p.lastPrice === '' || !Number.isFinite(Number(p.lastPrice)) ? null : Number(p.lastPrice),
          manualPrice: p.manualPrice == null || p.manualPrice === '' || !Number.isFinite(Number(p.manualPrice)) || Number(p.manualPrice) <= 0 ? null : Number(p.manualPrice),
          boughtAt: /^\d{4}-\d{2}-\d{2}$/.test(p.boughtAt || '') ? p.boughtAt : null,
          accounts: p.accounts || {},
        })).filter((p) => Number.isFinite(p.quantity) && p.quantity !== 0),
        cash: h.cash == null || h.cash === '' ? null : Number(h.cash),
        byAccount: h.byAccount || {},
        importedAt: now().toISOString(),
        source: h.source || null,
      };
      write('holdings.json', clean);
      return clean;
    },

    // ---- watchlist
    getWatchlist() { return read('watchlist.json', { items: [] }).items; },
    addWatch(ticker, note = '') {
      const t = cleanTicker(ticker);
      const items = api.getWatchlist();
      if (!items.find((i) => i.ticker === t)) items.push({ ticker: t, note: String(note).slice(0, 200), addedAt: now().toISOString() });
      write('watchlist.json', { items });
      return items;
    },
    // Upload from a spreadsheet: adds or updates tickers with a price, four buy zones and a reason. Holdings are never touched.
    importWatch(items, { mode = 'merge', listDate = '', source = '' } = {}) {
      const stamp = now().toISOString();
      const cur = mode === 'replace' ? [] : api.getWatchlist();
      const by = new Map(cur.map((i) => [i.ticker, i]));
      for (const it of items) {
        const old = by.get(it.ticker) || { ticker: it.ticker, note: '', addedAt: stamp };
        by.set(it.ticker, { ...old, why: it.why, strongBuy: it.strongBuy, goodBuy: it.goodBuy, acceptable: it.acceptable, avoid: it.avoid,
          listPrice: it.price, listDate: listDate || '', listSource: String(source).slice(0, 120), importedAt: stamp });
      }
      const next = [...by.values()];
      write('watchlist.json', { items: next });
      return next;
    },
    removeWatch(ticker) {
      const t = cleanTicker(ticker);
      const items = api.getWatchlist().filter((i) => i.ticker !== t);
      write('watchlist.json', { items });
      return items;
    },

    // ---- journal (index) and runs (full output)
    listJournal() { return read('journal.json', { entries: [] }).entries; },
    addRun(result, extra = {}) {
      const entryId = id();
      const entry = {
        id: entryId,
        ticker: result.ticker,
        date: result.date,
        rating: result.rating,
        seconds: result.seconds,
        priceAtAnalysis: result.price || null,
        model: result.model || null,
        createdAt: now().toISOString(),
        held: !!extra.held,
        position: extra.position || null,
        batchId: extra.batchId || null,
        action: null,
        reportPath: result.report_dir || null,
        summary: summarize(result.sections && result.sections.decision),
        timeline: cleanTimeline(extra.timeline),
        profile: /^(fast|standard|thorough)$/.test(extra.profile || '') ? extra.profile : 'standard',
      };
      write(`runs/${entryId}.json`, { entry, result });
      const entries = api.listJournal();
      entries.unshift(entry);
      write('journal.json', { entries });
      return entry;
    },
    // Replace the briefing stored with a run (used when an older run gets a briefing written later).
    setBrief(entryId, brief) {
      if (!/^[0-9a-f-]+$/i.test(entryId)) return false;
      const run = read(`runs/${entryId}.json`, null);
      if (!run) return false;
      run.result = { ...run.result, brief };
      write(`runs/${entryId}.json`, run);
      return true;
    },

    // Small facts about the app itself, such as whether the model check ever passed.
    getMeta() { return read('meta.json', {}); },
    setMeta(patch) { const m = { ...api.getMeta(), ...patch }; write('meta.json', m); return m; },

    getRun(entryId) {
      if (!/^[0-9a-f-]+$/i.test(entryId)) return null;
      const run = read(`runs/${entryId}.json`, null);
      if (!run) return null;
      // The journal index is the source of truth: it carries the action you recorded later.
      const live = api.listJournal().find((e) => e.id === entryId);
      return { ...run, entry: live || run.entry };
    },
    setAction(entryId, action) {
      const entries = api.listJournal();
      const e = entries.find((x) => x.id === entryId);
      if (!e) throw new Error('Journal entry not found.');
      if (action === null) e.action = null;
      else {
        if (!ACTIONS.includes(action.type)) throw new Error('Unknown action.');
        const price = action.price === '' || action.price == null ? null : Number(action.price);
        const qty = action.quantity === '' || action.quantity == null ? null : Number(action.quantity);
        e.action = {
          type: action.type,
          price: Number.isFinite(price) ? price : null,
          quantity: Number.isFinite(qty) ? qty : null,
          note: String(action.note || '').slice(0, 500),
          at: now().toISOString(),
        };
      }
      write('journal.json', { entries });
      return e;
    },
    deleteEntry(entryId) {
      const entries = api.listJournal().filter((x) => x.id !== entryId);
      write('journal.json', { entries });
      if (/^[0-9a-f-]+$/i.test(entryId)) { try { fs.unlinkSync(file(`runs/${entryId}.json`)); } catch { /* already gone */ } }
      return entries;
    },

    // ---- backtests
    listBacktests() { return read('backtests.json', { runs: [] }).runs; },
    addBacktest(b) {
      const runs = api.listBacktests();
      runs.unshift({ ...b, createdAt: now().toISOString() });
      write('backtests.json', { runs: runs.slice(0, 50) });
      return runs;
    },

    // Finished runs on the same model, newest first, for time-remaining estimates.
    etaHistory(provider, quick, limit = 10, profile = 'standard') {
      return api.listJournal()
        .filter((e) => e.seconds > 0 && e.model && e.model.provider === provider && (!quick || e.model.quick === quick) && (e.profile || 'standard') === profile)
        .slice(0, limit).map((e) => ({ seconds: e.seconds, timeline: e.timeline || null }));
    },

    // ---- timing, used for honest time estimates
    medianSeconds(provider) {
      const xs = api.listJournal().filter((e) => e.seconds && e.model && e.model.provider === provider).map((e) => e.seconds).sort((a, b) => a - b);
      return xs.length ? xs[Math.floor(xs.length / 2)] : null;
    },
  };
  return api;
}

function cleanTimeline(t) {
  if (!t || typeof t !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(t)) if (/^[a-z_]{2,40}$/.test(k) && typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = Math.round(v * 10) / 10;
  return Object.keys(out).length ? out : null;
}

function summarize(decision) {
  const t = String(decision || '');
  const m = /executive summary\**\s*:?\**\s*([\s\S]*?)(?:\n\s*\n|\*\*investment thesis|$)/i.exec(t);
  const s = (m ? m[1] : t).replace(/[*#]/g, '').replace(/\s+/g, ' ').trim();
  return s.length > 280 ? s.slice(0, 279) + '…' : s;
}

module.exports = { createStore, cleanSettings, cleanTicker, cleanUrl, DEFAULTS, PROVIDERS, LOCAL_PROVIDERS, ANALYSTS, SECRET_NAMES, ACTIONS };
