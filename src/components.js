'use strict';
// The programs TradeDesk needs, whether each is present, and how to add the ones that are missing.
//
//   Python    runs the analysis engine                       installed with winget (Windows Package Manager)
//   Git       optional fallback for fetching the engine      installed with winget
//   Engine    the TradingAgents framework                    built by setup.js into a private environment
//   Ollama    runs the language model on this computer       downloaded from ollama.com, signature checked, then run
//   Models    the quick and deep model named in Settings     pulled through Ollama's own API
//
// Everything that runs a program uses a fixed command line. No text typed by the person is ever put in a shell.
// Dependencies are injected so the logic is tested without Windows, a network or Ollama.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { findPython, run } = require('./setup');
const { ollamaStatus, SUGGESTED } = require('./hardware');
const { norm } = require('./models');

const OLLAMA_DOWNLOAD = 'https://ollama.com/download/OllamaSetup.exe';
const PYTHON_ID = 'Python.Python.3.12';
const GIT_ID = 'Git.Git';
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,100}$/;
const MIN_INSTALLER_BYTES = 20 * 1024 * 1024; // an error page is not an installer

const INFO = {
  python: {
    name: 'Python 3.12', required: true, size: 'about 30 MB', source: 'python.org, through Windows Package Manager (winget)',
    what: 'The programming language the analysis engine is written in.',
    use: 'TradeDesk builds a private copy of the engine with it. It is only used while an analysis, backtest or price fetch runs.',
    link: 'https://www.python.org/downloads/',
  },
  git: {
    name: 'Git', required: false, size: 'about 60 MB', source: 'git-scm.com, through Windows Package Manager (winget)',
    what: 'A version-control tool.',
    use: 'Optional. Only a fallback for fetching the engine if the direct download is blocked on your network.',
    link: 'https://git-scm.com/downloads',
  },
  engine: {
    name: 'TradingAgents engine', required: true, size: 'a few hundred MB', source: 'GitHub, TauricResearch/TradingAgents, one fixed version',
    what: 'The open-source framework of AI analysts, researchers, a trader and a risk team.',
    use: 'Runs every analysis and backtest. Installed into a private environment in the app data folder, not system-wide.',
  },
  ollama: {
    name: 'Ollama', required: true, size: 'about 1 GB', source: 'ollama.com, signature checked before it runs',
    what: 'A free program that runs language models on your own computer.',
    use: 'Serves the model to the engine. Nothing you analyse or hold is sent to a model company while you use it.',
    link: 'https://ollama.com/download',
  },
  model: {
    name: 'Language model', required: true, size: 'see below', source: 'Ollama library, through Ollama',
    what: 'The model that writes the analysis.',
    use: 'The quick model does the analysts, researchers and trader; the deep model the managers. They can be the same one.',
  },
};

const approxGB = (name) => { const s = SUGGESTED.find((m) => norm(m.name) === norm(name)); return s ? s.approxGB : null; };

function createComponents(deps = {}) {
  const platform = deps.platform || process.platform;
  const env = deps.env || process.env;
  const fsMod = deps.fs || fs;
  const runFn = deps.runFn || run;
  const fetchFn = deps.fetchFn || fetch;
  const spawnFn = deps.spawnFn || spawn;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const tmpDir = deps.tmpDir || os.tmpdir();
  const getSettings = deps.getSettings || (() => ({}));
  const engineReady = deps.engineReady || (() => false);
  let busy = null;
  let abort = null;

  const win = platform === 'win32';
  const isCloud = (s) => s.provider === 'anthropic' || s.provider === 'openai';
  const uses = (s) => s.provider === 'ollama';
  const baseUrl = () => String(getSettings().ollamaUrl || 'http://localhost:11434');

  async function has(exe, args) { const r = await runFn(exe, args, { timeoutMs: 8000 }); return r.code === 0 ? r.out.trim().split(/\r?\n/)[0] : null; }

  function ollamaExe() {
    if (!win) return null;
    const dirs = [env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'Ollama'), env.ProgramFiles && path.join(env.ProgramFiles, 'Ollama')].filter(Boolean);
    for (const d of dirs) { const p = path.join(d, 'ollama.exe'); try { if (fsMod.existsSync(p)) return p; } catch { /* unreadable */ } }
    return null;
  }

  // ---------------------------------------------------------------- status
  async function status() {
    const s = getSettings();
    const out = [];
    const wingetOk = win ? !!(await has('winget', ['--version'])) : false;

    const py = await findPython({ preferred: s.pythonPath, platform, runFn });
    const pyRow = { id: 'python', ...INFO.python };
    if (py.pick) Object.assign(pyRow, { status: 'ok', detail: `Python ${py.pick.text} found${py.pick.tested ? '' : ' (not tested with the engine)'}.` });
    else if (py.found.length) Object.assign(pyRow, { status: 'missing', detail: `Found Python ${py.found.map((f) => f.text).join(', ')}, but 3.11 to 3.13 is needed.` });
    else Object.assign(pyRow, { status: 'missing', detail: 'Not found on this computer.' });
    if (pyRow.status !== 'ok') Object.assign(pyRow, wingetOk ? { action: 'install', actionLabel: 'Install' } : { action: 'link', actionLabel: 'Open download page', detail: pyRow.detail + (win ? ' Windows Package Manager (winget) is not available, so download it from python.org.' : '') });
    out.push(pyRow);

    const gitV = await has('git', ['--version']);
    const gitRow = { id: 'git', ...INFO.git, status: gitV ? 'ok' : 'missing', detail: gitV || 'Not installed. Only needed if the direct download of the engine is blocked.' };
    if (!gitV) Object.assign(gitRow, wingetOk ? { action: 'install', actionLabel: 'Install' } : { action: 'link', actionLabel: 'Open download page' });
    out.push(gitRow);

    const eng = { id: 'engine', ...INFO.engine };
    if (engineReady()) Object.assign(eng, { status: 'ok', detail: 'Installed in the app data folder.' });
    else Object.assign(eng, { status: 'missing', detail: py.pick ? 'Not installed yet.' : 'Install Python first.', action: py.pick ? 'engine' : null, actionLabel: 'Install', blockedBy: py.pick ? null : 'python' });
    out.push(eng);

    const row = { id: 'ollama', ...INFO.ollama };
    if (!uses(s)) {
      Object.assign(row, { status: 'skip', detail: `Not needed: the model provider is set to ${s.provider}.`, required: false });
      out.push(row);
    } else {
      const st = await ollamaStatus(baseUrl(), fetchFn);
      const exe = ollamaExe();
      if (st.running) Object.assign(row, { status: 'ok', detail: `Running${st.version ? `, version ${st.version}` : ''} at ${st.url}.` });
      else if (exe) Object.assign(row, { status: 'stopped', detail: 'Installed but not running.', action: 'start', actionLabel: 'Start' });
      else Object.assign(row, { status: 'missing', detail: win ? 'Not installed.' : 'Not found. Install it from ollama.com.', action: win ? 'install' : 'link', actionLabel: win ? 'Download and install' : 'Open download page' });
      out.push(row);
      const have = (st.models || []).map((m) => m.name);
      const wanted = [];
      for (const [role, name] of [['quick', s.quickModel], ['deep', s.deepModel]]) {
        const k = norm(name);
        if (!k) continue;
        const prev = wanted.find((w) => norm(w.name) === k);
        if (prev) prev.roles.push(role); else wanted.push({ name, roles: [role] });
      }
      for (const w of wanted) {
        const ok = have.map(norm).includes(norm(w.name));
        const gb = approxGB(w.name);
        const m = { id: `model:${w.name}`, ...INFO.model, name: `Model: ${w.name}`, roles: w.roles, size: gb ? `about ${gb} GB` : 'size depends on the model', what: `The ${w.roles.join(' and ')} model chosen in Setup.` };
        if (ok) Object.assign(m, { status: 'ok', detail: 'Downloaded in Ollama.' });
        else if (!st.running) Object.assign(m, { status: 'blocked', detail: 'Start Ollama first, then download it.', blockedBy: 'ollama' });
        else Object.assign(m, { status: 'missing', detail: 'Not downloaded yet.', action: MODEL_RE.test(w.name) ? 'pull' : null, actionLabel: 'Download' });
        out.push(m);
      }
    }
    return { ok: true, platform, winget: wingetOk, cloud: isCloud(s), items: out, ready: out.filter((c) => c.required && c.status !== 'skip').every((c) => c.status === 'ok') };
  }

  // ---------------------------------------------------------------- helpers
  async function download(url, dest, onPct, signal) {
    const r = await fetchFn(url, { redirect: 'follow', signal });
    if (!r.ok) throw new Error(`The download failed (HTTP ${r.status}).`);
    const total = Number(r.headers && r.headers.get && r.headers.get('content-length')) || 0;
    fsMod.mkdirSync(path.dirname(dest), { recursive: true });
    const out = fsMod.createWriteStream(dest, { flags: 'wx', mode: 0o600 });
    let got = 0;
    let last = -1;
    const progress = new Transform({
      transform(value, _encoding, cb) {
        got += value.length;
        const pct = total ? Math.floor((got / total) * 100) : null;
        if (pct !== last) { last = pct; onPct(pct, got, total); }
        cb(null, value);
      },
    });
    await pipeline(Readable.fromWeb(r.body), progress, out, { signal });
    if (total && got < total) throw new Error('The download ended early. Check your connection and try again.');
    if (got < MIN_INSTALLER_BYTES) throw new Error(`The file is only ${Math.round(got / 1024)} KB, which is too small to be the installer.`);
    return got;
  }

  // The installer must carry a valid Authenticode signature from a publisher named Ollama.
  async function verifySignature(file) {
    const esc = file.replace(/'/g, "''");
    const ps = `$s = Get-AuthenticodeSignature -LiteralPath '${esc}'; [pscustomobject]@{ Status = [string]$s.Status; Subject = [string]$s.SignerCertificate.Subject; Publisher = if ($s.SignerCertificate) { $s.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) } else { '' } } | ConvertTo-Json -Compress`;
    const r = await runFn('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeoutMs: 60000 });
    const line = (r.out || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
    let j = null;
    try { j = JSON.parse(line); } catch { /* not json */ }
    if (r.code !== 0 || !j) return { ok: false, error: 'Could not check the installer\'s signature, so it was not run.' };
    if (j.Status !== 'Valid') return { ok: false, error: `The installer's signature is ${j.Status || 'missing'}, so it was not run.` };
    if (!['Ollama', 'Ollama, Inc.', 'Ollama Inc.'].includes(j.Publisher)) return { ok: false, error: `The installer is signed by "${j.Subject}", not by Ollama, so it was not run.` };
    return { ok: true, signer: j.Subject };
  }

  async function waitForOllama(seconds, emit) {
    for (let i = 0; i < seconds / 2; i++) {
      const st = await ollamaStatus(baseUrl(), fetchFn);
      if (st.running) return st;
      emit({ phase: 'wait', text: 'Waiting for Ollama to start…' });
      await sleep(2000);
    }
    return null;
  }

  function startOllama() {
    const exe = ollamaExe();
    if (!exe) return false;
    try {
      const c = spawnFn(exe, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true });
      if (c && c.unref) c.unref();
      return true;
    } catch { return false; }
  }

  async function pull(name, emit, signal) {
    const base = baseUrl().replace(/\/+$/, '');
    const r = await fetchFn(`${base}/api/pull`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, stream: true }), signal });
    if (!r.ok) throw new Error(`Ollama refused the request (HTTP ${r.status}).`);
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    const layers = {};
    let buf = '';
    let ok = false;
    const handle = (line) => {
      if (!line.trim()) return;
      let j;
      try { j = JSON.parse(line); } catch { return; }
      if (j.error) throw new Error(String(j.error));
      if (j.digest && j.total) layers[j.digest] = { total: j.total, done: j.completed || 0 };
      const t = Object.values(layers).reduce((a, l) => a + l.total, 0);
      const d = Object.values(layers).reduce((a, l) => a + l.done, 0);
      emit({ phase: 'pull', pct: t ? Math.min(99, Math.floor((d / t) * 100)) : null, text: j.status || '' });
      if (j.status === 'success') ok = true;
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split('\n');
      buf = parts.pop();
      parts.forEach(handle);
    }
    handle(buf);
    if (!ok) throw new Error('Ollama stopped before the download finished.');
  }

  // ---------------------------------------------------------------- install
  async function install(id, emit = () => {}) {
    if (busy) return { ok: false, error: `Another install is running (${busy}).` };
    busy = id;
    const ctl = typeof AbortController === 'function' ? new AbortController() : { signal: undefined, abort() {} };
    abort = ctl;
    const say = (o) => emit({ id, ...o });
    try {
      if (id === 'python' || id === 'git') {
        if (!win) return { ok: false, error: 'Automatic install is only set up for Windows. Use the download page.' };
        if (!(await has('winget', ['--version']))) return { ok: false, error: 'Windows Package Manager (winget) is not available. Use the download page instead.' };
        const pkg = id === 'python' ? PYTHON_ID : GIT_ID;
        say({ phase: 'install', pct: null, text: `Installing ${INFO[id].name} with winget. Windows may ask for permission.` });
        const r = await runFn('winget', ['install', '-e', '--id', pkg, '--silent', '--accept-package-agreements', '--accept-source-agreements'], { onLog: (l) => say({ phase: 'install', text: l.slice(0, 200) }), heartbeatMs: 20000 });
        // winget exits non-zero when the package is already up to date; judge by what is now on the computer.
        const now = id === 'python' ? !!(await findPython({ preferred: '', platform, runFn })).pick : !!(await has('git', ['--version']));
        if (!now) return { ok: false, error: `winget finished (exit ${r.code}) but ${INFO[id].name} still cannot be found. Close and reopen TradeDesk so Windows refreshes its program list, then check again.\n${(r.out || '').slice(-400)}` };
        return { ok: true };
      }

      if (id === 'ollama') {
        if (!win) return { ok: false, error: 'Automatic install is only set up for Windows. Use the download page.' };
        fsMod.mkdirSync(tmpDir, { recursive: true });
        const workDir = fsMod.mkdtempSync(path.join(tmpDir, 'tradedesk-setup-'));
        const dest = path.join(workDir, 'OllamaSetup.exe');
        try {
          say({ phase: 'download', pct: 0, text: 'Downloading the Ollama installer from ollama.com…' });
          await download(OLLAMA_DOWNLOAD, dest, (pct, got, total) => say({ phase: 'download', pct, text: total ? `Downloading… ${Math.round(got / 1048576)} of ${Math.round(total / 1048576)} MB` : `Downloading… ${Math.round(got / 1048576)} MB` }), ctl.signal);
          say({ phase: 'verify', pct: null, text: 'Checking the installer\'s digital signature…' });
          const sig = await verifySignature(dest);
          if (!sig.ok) { try { fsMod.unlinkSync(dest); } catch { /* already gone */ } return sig; }
          say({ phase: 'install', pct: null, text: `Signature valid (${sig.signer.replace(/^.*?CN=([^,]+).*$/, '$1')}). Running the installer. This takes a minute.` });
          const r = await runFn(dest, ['/SILENT', '/NORESTART'], { onLog: (l) => say({ phase: 'install', text: l.slice(0, 200) }), heartbeatMs: 20000 });
          try { fsMod.unlinkSync(dest); } catch { /* leave it */ }
          if (r.code !== 0) return { ok: false, error: `The Ollama installer exited with code ${r.code}.\n${(r.out || '').slice(-400)}` };
          let st = await waitForOllama(20, say);
          if (!st && startOllama()) st = await waitForOllama(40, say);
          if (!st) return { ok: false, error: 'Ollama installed but did not start. Open it from the Start menu, then check again.' };
          return { ok: true };
        } finally {
          try { fsMod.unlinkSync(dest); } catch { /* download may not have started */ }
          try { fsMod.rmdirSync(workDir); } catch { /* leave nonempty directories alone */ }
        }
      }

      if (id === 'ollama-start') {
        if (!startOllama()) return { ok: false, error: 'Could not find Ollama to start it.' };
        const st = await waitForOllama(40, say);
        return st ? { ok: true } : { ok: false, error: 'Ollama did not respond. Open it from the Start menu.' };
      }

      if (id.startsWith('model:')) {
        const name = id.slice(6);
        if (!MODEL_RE.test(name)) return { ok: false, error: 'That does not look like a model name.' };
        say({ phase: 'pull', pct: 0, text: `Downloading ${name}…` });
        await pull(name, say, ctl.signal);
        const st = await ollamaStatus(baseUrl(), fetchFn);
        if (!st.models.some((m) => norm(m.name) === norm(name))) return { ok: false, error: 'The download finished but Ollama does not list the model.' };
        return { ok: true };
      }
      return { ok: false, error: 'Unknown component.' };
    } catch (e) {
      return { ok: false, error: e && e.name === 'AbortError' ? 'Cancelled.' : (e.message || String(e)), canceled: !!(e && e.name === 'AbortError') };
    } finally { busy = null; abort = null; }
  }

  return { status, install, cancel() { if (abort) { try { abort.abort(); } catch { /* already done */ } return true; } return false; }, get busy() { return busy; } };
}

module.exports = { createComponents, INFO, OLLAMA_DOWNLOAD, MODEL_RE };
