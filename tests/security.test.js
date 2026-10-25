'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const { trustedSender, engineEnvironment } = require('../src/security');
const { createIpc } = require('../src/ipc');
const holdings = require('../src/holdings');
const fs = require('fs');
const os = require('os');
const { installEngine } = require('../src/setup');

const documentUrl = pathToFileURL(path.join(__dirname, '..', 'renderer', 'index.html')).href;
function fixture() {
  const frame = { url: documentUrl };
  const contents = { mainFrame: frame };
  const window = { isDestroyed: () => false, webContents: contents };
  return { window, event: { sender: contents, senderFrame: frame } };
}

test('security: only the current window main frame at the exact app document is trusted', () => {
  const { window, event } = fixture();
  assert.equal(trustedSender(event, window, documentUrl), true);
  for (const untrusted of [null, {}, { ...event, sender: {} },
    { ...event, senderFrame: { url: documentUrl } }, { ...event, senderFrame: null }]) {
    assert.equal(trustedSender(untrusted, window, documentUrl), false);
  }
  for (const url of ['https://evil.example', 'about:blank', documentUrl + '?spoof', documentUrl + '.html']) {
    event.senderFrame.url = url;
    assert.equal(trustedSender(event, window, documentUrl), false);
  }
  assert.equal(trustedSender(event, null, documentUrl), false);
  assert.equal(trustedSender(event, { isDestroyed: () => true }, documentUrl), false);
});

test('security: every registered IPC channel refuses an untrusted caller before doing work', async () => {
  const handlers = {};
  const { window } = fixture();
  createIpc({ store: {}, dialog: {}, shell: {}, paths: {}, getWindow: () => window })
    .register({ handle: (name, handler) => { handlers[name] = handler; } });
  assert.ok(Object.keys(handlers).length > 30);
  for (const handler of Object.values(handlers)) {
    assert.deepEqual(await handler({}, {}), { ok: false, error: 'Untrusted IPC sender.' });
  }
});

test('security: Python inherits OS paths but no ambient secrets, routing, tracing or import hooks', () => {
  const env = engineEnvironment({ Path: 'system-path', TEMP: 'tmp', HOME: 'home',
    OPENAI_API_KEY: 'ambient-secret', OPENAI_BASE_URL: 'https://evil.example',
    ANTHROPIC_API_KEY: 'other-secret', AWS_SECRET_ACCESS_KEY: 'aws-secret',
    LANGCHAIN_API_KEY: 'trace-key', LANGCHAIN_TRACING_V2: 'true',
    PYTHONPATH: 'untrusted-imports', PYTHONSTARTUP: 'evil.py', NODE_OPTIONS: 'injection',
  }, { OPENAI_API_KEY: 'explicit-provider-key', TRADINGAGENTS_NO_UPDATE_CHECK: '1' });
  assert.equal(env.Path, 'system-path');
  assert.equal(env.HOME, 'home');
  assert.equal(env.OPENAI_API_KEY, 'explicit-provider-key');
  assert.equal(env.PYTHONUTF8, '1');
  for (const key of ['OPENAI_BASE_URL', 'ANTHROPIC_API_KEY', 'AWS_SECRET_ACCESS_KEY',
    'LANGCHAIN_API_KEY', 'LANGCHAIN_TRACING_V2', 'PYTHONPATH', 'PYTHONSTARTUP', 'NODE_OPTIONS']) {
    assert.equal(env[key], undefined);
  }
});

test('security: spreadsheet account names cannot resolve inherited object properties', () => {
  for (const account of ['__proto__', 'constructor', 'toString']) {
    const imported = holdings.importRows([
      ['Ticker', 'Quantity', 'Account'], ['AAPL', '2', account], ['AAPL', '3', account],
    ]);
    assert.equal(imported.ok, true);
    assert.equal(imported.positions[0].accounts[account], 5);
    assert.equal(imported.byAccount[account].length, 2);
    const merged = holdings.mergePositions([], imported.positions);
    assert.equal(merged[0].accounts[account], 5);
    assert.equal(Object.prototype.polluted, undefined);
  }
});

test('security: external links reject credentials, alternate ports, subdomains and unsafe protocols', async () => {
  const { window, event } = fixture();
  const handlers = {};
  const opened = [];
  createIpc({ store: {}, dialog: {}, paths: {}, getWindow: () => window,
    shell: { openExternal: async (url) => { opened.push(url); } } })
    .register({ handle: (name, handler) => { handlers[name] = handler; } });
  const open = (url) => handlers['shell:open'](event, { url });
  for (const url of ['file:///C:/Windows/system32/calc.exe', 'javascript:alert(1)',
    'https://ollama.com.evil.example/', 'https://user:secret@ollama.com/', 'https://ollama.com:444/']) {
    assert.equal((await open(url)).ok, false);
  }
  assert.equal((await open('https://ollama.com/download')).ok, true);
  assert.deepEqual(opened, ['https://ollama.com/download']);
});

test('security: engine setup updates pip before installing third-party packages and stops if that fails', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'td-sec-setup-'));
  const calls = [];
  const result = await installEngine({ baseDir: base, platform: 'linux', runFn: async (_exe, args) => {
    calls.push(args);
    if (args.includes('-c')) return { code: 0, out: '3.12.8' };
    if (args.includes('venv')) return { code: 0, out: '' };
    if (args.includes('pip>=26.2')) return { code: 1, out: 'blocked' };
    throw new Error('Engine packages must not install after an unsuccessful pip update');
  } });
  assert.equal(result.ok, false);
  assert.match(result.error, /could not update the private package installer/);
  assert.ok(calls.some((args) => args.includes('--upgrade') && args.includes('pip>=26.2')));
  assert.equal(calls.some((args) => args.some((arg) => arg.startsWith('https://github.com/'))), false);
  fs.rmdirSync(base);
});
