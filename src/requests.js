'use strict';
// Builds the engine request and environment from stored settings. Pure, so it is tested.

const { toPortfolio } = require('./holdings');

function engineSettings(settings, dataDir) {
  const s = {
    provider: settings.provider,
    quick_model: settings.quickModel,
    deep_model: settings.deepModel,
    debate_rounds: settings.debateRounds,
    risk_rounds: settings.riskRounds,
    language: settings.language,
    data_dir: dataDir,
  };
  if (settings.temperature !== '') s.temperature = Number(settings.temperature);
  if (settings.provider === 'openai_compatible' && settings.backendUrl) s.backend_url = settings.backendUrl;
  return s;
}

function engineEnv(settings, secrets = {}) {
  const env = { TRADINGAGENTS_NO_UPDATE_CHECK: '1', ...secrets };
  if (settings.provider === 'ollama') env.OLLAMA_BASE_URL = settings.ollamaUrl.replace(/\/+$/, '') + '/v1';
  return env;
}

// null portfolio = "no context", which is different from an empty book.
function portfolioFor(holdings, settings, include = true) {
  if (!include) return null;
  if (!holdings || (!holdings.positions.length && holdings.cash == null && settings.cashOverride === '')) return null;
  const cash = settings.cashOverride !== '' ? Number(settings.cashOverride) : holdings.cash;
  return toPortfolio(holdings.positions, cash);
}

function isCrypto(ticker) { return /-USD$/i.test(ticker); }

function analyzeRequest({ settings, dataDir, ticker, date, portfolio, assetType }) {
  return {
    cmd: 'analyze',
    ticker,
    date,
    asset_type: assetType || (isCrypto(ticker) ? 'crypto' : 'stock'),
    analysts: settings.analysts,
    settings: engineSettings(settings, dataDir),
    portfolio,
  };
}

// Today's date in the user's timezone, as YYYY-MM-DD.
function todayLocal(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

function validDate(d, now = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return 'Use the format YYYY-MM-DD.';
  const t = new Date(d + 'T00:00:00');
  if (Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== d) return 'That is not a real date.';
  if (d > todayLocal(now)) return 'The date cannot be in the future.';
  return null;
}

// Rough run-time estimate for a sweep, from the user's own measured runs.
function estimate(cells, medianSeconds) {
  if (!medianSeconds) return null;
  const total = cells * medianSeconds;
  return { cells, perCellSeconds: medianSeconds, totalSeconds: total };
}

module.exports = { engineSettings, engineEnv, portfolioFor, analyzeRequest, todayLocal, validDate, estimate, isCrypto };
