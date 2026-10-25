'use strict';
// Run profiles: how thorough one analysis is. They change only how many analysts and debate rounds run,
// never the model. A thorough run takes noticeably longer on a local model.

const PROFILES = {
  fast: { label: 'Fast', note: 'Market and news analysts, one debate round. Quickest, thinnest.', analysts: ['market', 'news'], debateRounds: 1, riskRounds: 1 },
  standard: { label: 'Standard', note: 'Uses the analysts and rounds set in Setup.', analysts: null, debateRounds: null, riskRounds: null },
  thorough: { label: 'Thorough', note: 'All four analysts and two debate rounds. Slowest.', analysts: ['market', 'social', 'news', 'fundamentals'], debateRounds: 2, riskRounds: 2 },
};

const clean = (p) => (Object.prototype.hasOwnProperty.call(PROFILES, p) ? p : 'standard');

function apply(settings, profile) {
  const p = PROFILES[clean(profile)];
  const out = { ...settings };
  if (p.analysts) out.analysts = p.analysts.slice();
  if (p.debateRounds) out.debateRounds = Math.max(settings.debateRounds || 1, p.debateRounds === 1 ? 1 : p.debateRounds);
  if (p.riskRounds) out.riskRounds = Math.max(settings.riskRounds || 1, p.riskRounds === 1 ? 1 : p.riskRounds);
  if (clean(profile) === 'fast') { out.debateRounds = 1; out.riskRounds = 1; }
  return out;
}

module.exports = { PROFILES, clean, apply };
