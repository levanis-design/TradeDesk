'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Writable } = require('stream');
const { createComponents } = require('../src/components');

const stream = (chunks) => new ReadableStream({ start(c) { chunks.forEach((x) => c.enqueue(new TextEncoder().encode(x))); c.close(); } });
const json = (o, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => o });
const settings = { provider: 'ollama', ollamaUrl: 'http://x:1', quickModel: 'qwen3:latest', deepModel: 'qwen3:latest', pythonPath: '' };

function make({ tags = null, runs = {}, fetchExtra = null, platform = 'win32', engine = false, set = settings, exists = () => false } = {}) {
  const calls = [];
  const runFn = async (exe, args) => {
    calls.push([exe, ...args]);
    const key = exe === 'powershell' ? 'powershell' : exe;
    const r = runs[key];
    return typeof r === 'function' ? r(args) : (r || { code: 1, out: '' });
  };
  const fetchFn = async (url, opt) => {
    if (fetchExtra) { const r = await fetchExtra(url, opt); if (r) return r; }
    if (tags === null) throw new Error('refused');
    if (url.endsWith('/api/tags')) return json({ models: tags.map((n) => ({ name: n, size: 5e9, details: {} })) });
    if (url.endsWith('/api/version')) return json({ version: '0.9' });
    throw new Error('unexpected ' + url);
  };
  const c = createComponents({ platform, runFn, fetchFn, getSettings: () => set, engineReady: () => engine, sleep: async () => {}, env: { LOCALAPPDATA: 'C:\\L' }, fs: { existsSync: exists, mkdirSync() {}, mkdtempSync: (prefix) => prefix + 'test', rmdirSync() {}, unlinkSync() {}, createWriteStream: () => new Writable({ write(_chunk, _encoding, cb) { cb(); } }) }, spawnFn: () => ({ unref() {} }) });
  return { c, calls };
}

test('status: nothing installed on Windows offers installs through winget', async () => {
  const { c } = make({ runs: { winget: { code: 0, out: 'v1.7' } } });
  const s = await c.status();
  const by = Object.fromEntries(s.items.map((i) => [i.id, i]));
  assert.equal(by.python.status, 'missing'); assert.equal(by.python.action, 'install');
  assert.equal(by.engine.status, 'missing'); assert.equal(by.engine.blockedBy, 'python');
  assert.equal(by.ollama.status, 'missing'); assert.equal(by.ollama.action, 'install');
  assert.equal(by['model:qwen3:latest'].status, 'blocked');
  assert.equal(s.ready, false);
});

test('status: without winget Python falls back to the download page', async () => {
  const { c } = make();
  const s = await c.status();
  assert.equal(s.items.find((i) => i.id === 'python').action, 'link');
});

test('status: Ollama installed but not running offers Start; running with the model is ready', async () => {
  let r = make({ exists: (p) => /ollama\.exe$/.test(p) });
  assert.equal((await r.c.status()).items.find((i) => i.id === 'ollama').action, 'start');
  r = make({ tags: ['qwen3:latest'], engine: true, runs: { python3: { code: 0, out: '3.12.1' }, 'py': { code: 0, out: '3.12.1' }, python: { code: 0, out: '3.12.1' } } });
  const s = await r.c.status();
  assert.equal(s.items.find((i) => i.id === 'ollama').status, 'ok');
  assert.equal(s.items.find((i) => i.id === 'model:qwen3:latest').status, 'ok');
  assert.equal(s.ready, true);
});

test('status: quick and deep model that match are one row; cloud provider skips Ollama', async () => {
  const two = make({ tags: [], set: { ...settings, deepModel: 'gpt-oss:latest' } });
  assert.equal((await two.c.status()).items.filter((i) => i.id.startsWith('model:')).length, 2);
  const cloud = make({ set: { ...settings, provider: 'anthropic' } });
  const s = await cloud.c.status();
  assert.equal(s.items.find((i) => i.id === 'ollama').status, 'skip');
  assert.equal(s.items.some((i) => i.id.startsWith('model:')), false);
});

test('model pull: progress is summed across layers and ends at success', async () => {
  const lines = [
    JSON.stringify({ status: 'pulling manifest' }) + '\n',
    JSON.stringify({ status: 'pulling a', digest: 'a', total: 100, completed: 50 }) + '\n' + JSON.stringify({ status: 'pulling b', digest: 'b', total: 100, completed: 0 }).slice(0, 20),
    JSON.stringify({ status: 'pulling b', digest: 'b', total: 100, completed: 0 }).slice(20) + '\n',
    JSON.stringify({ status: 'pulling a', digest: 'a', total: 100, completed: 100 }) + '\n' + JSON.stringify({ status: 'success' }),
  ];
  let pulled = false;
  const { c } = make({ tags: [], fetchExtra: async (url, o) => {
    if (url.endsWith('/api/pull')) { assert.equal(JSON.parse(o.body).name, 'qwen3:latest'); pulled = true; return { ok: true, body: stream(lines) }; }
    if (url.endsWith('/api/tags') && pulled) return json({ models: [{ name: 'qwen3:latest', size: 1 }] });
    return null;
  } });
  const seen = [];
  const r = await c.install('model:qwen3:latest', (p) => seen.push(p.pct));
  assert.equal(r.ok, true);
  assert.ok(seen.includes(25), seen.join());
  assert.ok(seen.every((x) => x === null || x <= 99));
});

test('model pull: an error line from Ollama is reported, and bad names never reach Ollama', async () => {
  const { c } = make({ tags: [], fetchExtra: async (url) => (url.endsWith('/api/pull') ? { ok: true, body: stream([JSON.stringify({ error: 'pull model manifest: file does not exist' }) + '\n']) } : null) });
  const r = await c.install('model:nope:1b');
  assert.equal(r.ok, false); assert.match(r.error, /does not exist/);
  const bad = await c.install('model:x; rm -rf /');
  assert.equal(bad.ok, false); assert.match(bad.error, /model name/);
});

test('Ollama install: a wrong signer is refused and the installer is never run', async () => {
  const ran = [];
  const big = new Uint8Array(21 * 1024 * 1024);
  const { c, calls } = make({
    fetchExtra: async (url) => (/OllamaSetup\.exe$/.test(url) ? { ok: true, headers: { get: () => String(big.length) }, body: stream([]) && new ReadableStream({ start(k) { k.enqueue(big); k.close(); } }) } : null),
    runs: { powershell: { code: 0, out: JSON.stringify({ Status: 'Valid', Subject: 'CN=Evil Corp' }) + '\n' }, 'C:\\tmp\\OllamaSetup.exe': () => { ran.push(1); return { code: 0, out: '' }; } },
  });
  const r = await c.install('ollama');
  assert.equal(r.ok, false); assert.match(r.error, /not by Ollama/);
  assert.equal(calls.some((x) => /OllamaSetup\.exe$/.test(x[0])), false);
  assert.equal(ran.length, 0);
});

test('Ollama install: an unsigned installer and a tiny download are both refused', async () => {
  const mk = (size, sig) => make({
    fetchExtra: async (url) => (/OllamaSetup\.exe$/.test(url) ? { ok: true, headers: { get: () => String(size) }, body: new ReadableStream({ start(k) { k.enqueue(new Uint8Array(size)); k.close(); } }) } : null),
    runs: { powershell: { code: 0, out: JSON.stringify(sig) } },
  });
  const unsigned = await mk(21 * 1024 * 1024, { Status: 'NotSigned', Subject: '' }).c.install('ollama');
  assert.match(unsigned.error, /NotSigned/);
  const tiny = await mk(5000, { Status: 'Valid', Subject: 'CN=Ollama' }).c.install('ollama');
  assert.match(tiny.error, /too small/);
});

test('Ollama install: publisher names containing Ollama are not accepted as Ollama', async () => {
  for (const Publisher of ['Not Ollama LLC', 'Ollama Malware', '']) {
    const { c, calls } = make({
      fetchExtra: async (url) => /OllamaSetup\.exe$/.test(url) ? { ok: true,
        headers: { get: () => String(21 * 1024 * 1024) },
        body: new ReadableStream({ start(k) { k.enqueue(new Uint8Array(21 * 1024 * 1024)); k.close(); } }),
      } : null,
      runs: { powershell: { code: 0, out: JSON.stringify({ Status: 'Valid', Subject: 'CN=' + Publisher, Publisher }) } },
    });
    assert.match((await c.install('ollama')).error, /not by Ollama/);
    assert.equal(calls.some(([exe]) => /OllamaSetup\.exe$/.test(exe)), false);
  }
});

test('Ollama install: an exact trusted publisher can proceed after signature verification', async () => {
  const { c, calls } = make({ tags: [],
    fetchExtra: async (url) => /OllamaSetup\.exe$/.test(url) ? { ok: true,
      headers: { get: () => String(21 * 1024 * 1024) },
      body: new ReadableStream({ start(k) { k.enqueue(new Uint8Array(21 * 1024 * 1024)); k.close(); } }),
    } : null,
    runs: { powershell: { code: 0, out: JSON.stringify({ Status: 'Valid', Subject: 'CN="Ollama, Inc."', Publisher: 'Ollama, Inc.' }) } },
  });
  await c.install('ollama');
  assert.equal(calls.some(([exe]) => /OllamaSetup\.exe$/.test(exe)), true);
});

test('install: winget missing and non-Windows are explained, and one install runs at a time', async () => {
  assert.match((await make().c.install('python')).error, /winget/);
  assert.match((await make({ platform: 'linux' }).c.install('python')).error, /only set up for Windows/);
  assert.match((await make().c.install('nonsense')).error, /Unknown/);
  let release;
  const gate = new Promise((r) => { release = r; });
  const { c } = make({ tags: [], fetchExtra: async (url) => (url.endsWith('/api/pull') ? (await gate, { ok: true, body: stream([JSON.stringify({ status: 'success' }) + '\n']) }) : null) });
  const first = c.install('model:a:1');
  const second = await c.install('model:b:1');
  assert.equal(second.ok, false); assert.match(second.error, /Another install/);
  release(); await first;
});

test('python install via winget: judged by what is on the computer afterwards, with a restart hint when it is not found', async () => {
  const { c, calls } = make({ runs: { winget: { code: 0, out: 'ok' } } });
  const r = await c.install('python');
  assert.ok(calls.some((x) => x[0] === 'winget' && x.includes('Python.Python.3.12') && x.includes('--silent')));
  assert.equal(r.ok, false); assert.match(r.error, /Close and reopen/);
});
