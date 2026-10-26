'use strict';
const path = require('path');
const { app, BrowserWindow, Notification, ipcMain, dialog, shell, safeStorage, Menu, session } = require('electron');

const { createStore } = require('./store');
const { createIpc } = require('./ipc');

if (!app.requestSingleInstanceLock()) { app.quit(); }

let win = null;
let ipc = null;

const send = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };

function createWindow() {
  win = new BrowserWindow({
    width: 1360, height: 900, minWidth: 1020, minHeight: 680,
    backgroundColor: '#0f1417', title: 'TradeDesk', show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({ responseHeaders: { ...details.responseHeaders,
      'Content-Security-Policy': ["default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"] } });
  });
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);

  const userData = app.getPath('userData');
  const store = createStore(path.join(userData, 'data'), {
    encrypt: (s) => safeStorage.encryptString(s),
    decrypt: (b) => safeStorage.decryptString(b),
    canEncrypt: () => safeStorage.isEncryptionAvailable(),
  });
  ipc = createIpc({
    store, dialog, shell, safeStorage, send, getWindow: () => win, version: app.getVersion(), quit: () => app.quit(),
    notify: ({ title, body }) => { try { if (Notification.isSupported()) new Notification({ title: String(title).slice(0, 80), body: String(body).slice(0, 200) }).show(); } catch { /* a missing notification must not stop the check */ } },
    paths: {
      userData,
      engineDir: path.join(userData, 'engine'),
      dataDir: path.join(userData, 'ta'),
      engineScript: app.isPackaged
        ? path.join(process.resourcesPath, 'engine', 'tradedesk_engine.py')
        : path.join(__dirname, '..', 'engine', 'tradedesk_engine.py'),
    },
  });
  ipc.register(ipcMain);
  createWindow();
});

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('before-quit', () => { if (ipc) ipc.cancelAll(); });
app.on('window-all-closed', () => app.quit());
