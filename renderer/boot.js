'use strict';
(async function boot() {
  try {
    TD.buildNav();
    TD.initEvents();
    await TD.refreshStatus();
    await TD.showTerms();          // every launch; nothing else is usable until the notice is accepted
    TD.go(TD.setupDone() ? 'analyze' : 'setup');
  } catch (e) {
    document.getElementById('view').textContent = 'TradeDesk could not start: ' + e.message;
  }
})();
