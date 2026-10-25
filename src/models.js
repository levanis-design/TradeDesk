'use strict';
// Before a long run, make sure the models named in Settings exist in Ollama. TradingAgents uses two:
// a quick model for analysts, researchers and the trader, and a deep model for the managers.
// Checking only one of them lets a run work for ten minutes and then fail at the research manager.

// Ollama treats "qwen3" and "qwen3:latest" as the same model.
const norm = (n) => { const s = String(n || '').trim().toLowerCase(); return s && !s.includes(':') ? `${s}:latest` : s; };

function missingModels(settings, installedNames) {
  const have = new Set((installedNames || []).map(norm));
  const out = [];
  const seen = new Set();
  for (const [role, name] of [['quick', settings.quickModel], ['deep', settings.deepModel]]) {
    const k = norm(name);
    if (!k || have.has(k) || seen.has(k)) continue;
    seen.add(k);
    out.push({ role, name });
  }
  return out;
}

function message(settings, missing, installedNames) {
  const list = (installedNames || []).slice().sort();
  const who = missing.map((m) => `the ${m.role} model "${m.name}"`).join(' and ');
  const have = list.length ? `Installed models: ${list.join(', ')}.` : 'Ollama has no models installed yet.';
  const fix = list.length
    ? `In Setup set both model fields to one of these, press Save, and run again. Or install it with: ollama pull ${missing[0].name.replace(/:latest$/, '')}`
    : `Install one with: ollama pull ${missing[0].name.replace(/:latest$/, '')}, then press Save in Setup.`;
  return `${who.charAt(0).toUpperCase() + who.slice(1)} ${missing.length > 1 ? 'are' : 'is'} not installed in Ollama. ${have} ${fix}`;
}

module.exports = { missingModels, message, norm };
