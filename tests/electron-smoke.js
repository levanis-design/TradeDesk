'use strict';
// Native Electron startup and IPC check. Requires the same optional Playwright
// installation as test:ui. All writes use a fresh temporary user profile.
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { _electron } = require('playwright');

const root = path.join(__dirname, '..');
const artifacts = path.join(__dirname, 'ui-artifacts', 'electron-smoke');
fs.mkdirSync(artifacts, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tradedesk-native-smoke-'));
const bootstrap = path.join(artifacts, 'bootstrap.cjs');
fs.writeFileSync(bootstrap, [
  "const { app } = require('electron');",
  "app.setPath('userData', process.env.TD_SMOKE_PROFILE);",
  "app.setName('TradeDesk native smoke');",
  "require(process.env.TD_SMOKE_MAIN);",
].join('\n'));

(async () => {
  const env = { ...process.env, TD_SMOKE_PROFILE: profile, TD_SMOKE_MAIN: path.join(root, 'src', 'main.js') };
  delete env.ELECTRON_RUN_AS_NODE;
  let electron;
  try {
    electron = await _electron.launch({ executablePath: require('electron'), args: [bootstrap], cwd: root, env });
    const page = await electron.firstWindow();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((window) => window.hide()));
    await page.waitForSelector('#termsok');
    const info = await page.evaluate(() => window.td.info());
    assert.equal(info.ok, true, JSON.stringify(info));
    assert.equal(path.resolve(info.userData), path.resolve(profile));
    await page.check('#termsok');
    await page.click('#termsgo');
    await page.waitForSelector('#pageTitle:has-text("Setup")', { timeout: 30000 });
    const settings = await page.evaluate(() => window.td.getSettings());
    assert.equal(settings.ok, true);
    const saved = await page.evaluate(() => window.td.setSettings({ quickModel: 'native-smoke-model' }));
    assert.equal(saved.ok, true);
    assert.equal(saved.settings.quickModel, 'native-smoke-model');
    const imported = await page.evaluate(async () => {
      const preview = await window.td.pasteWatch({ text: "Ticker,Strong Buy,Why\nAMD,under 95,Native smoke sample" });
      if (!preview.ok) return preview;
      return window.td.commitWatch({ token: preview.token });
    });
    assert.equal(imported.ok, true, JSON.stringify(imported));
    assert.equal(imported.items[0].ticker, 'AMD');
    const preferences = await electron.evaluate(({ BrowserWindow }) => {
      const p = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
      return { sandbox: p.sandbox, contextIsolation: p.contextIsolation, nodeIntegration: p.nodeIntegration };
    });
    assert.deepEqual(preferences, { sandbox: true, contextIsolation: true, nodeIntegration: false });
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(artifacts, 'startup.png') });
    console.log('PASS: native Electron startup, isolated profile, real IPC, settings, watchlist import, and sandbox preferences.');
  } finally {
    if (electron) await electron.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
