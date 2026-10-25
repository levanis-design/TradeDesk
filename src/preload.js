'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const call = (ch) => (arg) => ipcRenderer.invoke(ch, arg);
const on = (ch) => (fn) => {
  const h = (_e, payload) => fn(payload);
  ipcRenderer.on(ch, h);
  return () => ipcRenderer.removeListener(ch, h);
};

contextBridge.exposeInMainWorld('td', {
  info: call('app:info'),
  quit: call('app:quit'),
  getSettings: call('settings:get'),
  setSettings: call('settings:set'),
  setSecret: call('secrets:set'),
  hardware: call('hw:snapshot'),
  engineStatus: call('engine:status'),
  engineInstall: call('engine:install'),
  components: call('components:status'),
  componentInstall: call('components:install'),
  componentCancel: call('components:cancel'),
  modelCheck: call('engine:modelcheck'),
  cancel: call('job:cancel'),
  jobStatus: call('job:status'),
  queueAdd: call('queue:add'),
  queueState: call('queue:state'),
  queueCancel: call('queue:cancel'),
  queueClear: call('queue:clear'),

  getHoldings: call('holdings:get'),
  pickHoldings: call('holdings:pick'),
  pasteHoldings: call('holdings:paste'),
  previewHoldings: call('holdings:preview'),
  commitHoldings: call('holdings:commit'),
  saveHoldings: call('holdings:save'),

  watchList: call('watch:list'),
  watchAdd: call('watch:add'),
  watchRemove: call('watch:remove'),

  analyze: call('analyze:run'),
  batch: call('batch:run'),

  journal: call('journal:list'),
  journalGet: call('journal:get'),
  journalAction: call('journal:action'),
  journalDelete: call('journal:delete'),
  journalScore: call('journal:score'),
  journalExport: call('journal:export'),
  showReport: call('journal:showReport'),

  quote: call('quote:get'),
  bars: call('bars:get'),
  calendar: call('calendar:get'),
  events: call('events:get'),
  saveEvents: call('events:save'),
  makeBrief: call('brief:make'),
  record: call('record:for'),
  backtests: call('backtest:list'),
  backtest: call('backtest:run'),
  openLink: call('shell:open'),

  onJob: on('job:event'),
  onBatch: on('batch:update'),
  onQueue: on('queue:update'),
  onQueueTotal: on('queue:total'),
  onSetupLog: on('setup:log'),
  onComponentProgress: on('component:progress'),
});
