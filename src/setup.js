'use strict';
// First-run setup: find a suitable Python, build a private virtual environment and
// install TradingAgents into it. Nothing is installed system-wide.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// The exact TradingAgents commit this app was written and tested against.
const PINNED_SHA = 'e8f5503e9b86d5c2710b0c76b1f686703968c9df';
const SOURCES = [
  `https://github.com/TauricResearch/TradingAgents/archive/${PINNED_SHA}.zip`,
  `git+https://github.com/TauricResearch/TradingAgents.git@${PINNED_SHA}`,
];

function run(exe, args, { onLog = () => {}, timeoutMs = 0, heartbeatMs = 0, spawnFn = spawn } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try { child = spawnFn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return resolve({ code: -1, out: e.message }); }
    const timer = timeoutMs ? setTimeout(() => { try { child.kill(); } catch { /* ended */ } }, timeoutMs) : null;
    // Heartbeat: if the tool is silent for a while, say so, so a long step is not mistaken for a hang.
    const started = Date.now();
    let lastOut = Date.now();
    const beat = heartbeatMs ? setInterval(() => {
      if (Date.now() - lastOut >= heartbeatMs) onLog(`Still working… ${Math.round((Date.now() - started) / 1000)} s elapsed, no new output yet.`);
    }, heartbeatMs) : null;
    const stop = () => { if (timer) clearTimeout(timer); if (beat) clearInterval(beat); };
    const feed = (d) => { lastOut = Date.now(); const s = String(d); out = (out + s).slice(-20000); s.split(/\r?\n/).filter(Boolean).forEach(onLog); };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('error', (e) => { stop(); resolve({ code: -1, out: e.message }); });
    child.on('close', (code, signal) => { stop(); resolve({ code: code === null ? -1 : code, signal: signal || null, out }); });
  });
}

function candidates(platform, preferred) {
  if (preferred) return [[preferred]];
  if (platform === 'win32') return [['py', '-3.12'], ['py', '-3.13'], ['py', '-3.11'], ['python'], ['python3']];
  return [['python3.12'], ['python3.13'], ['python3.11'], ['python3']];
}

async function findPython({ preferred = '', platform = process.platform, runFn = run } = {}) {
  const found = [];
  for (const [exe, ...pre] of candidates(platform, preferred)) {
    const r = await runFn(exe, [...pre, '-c', 'import sys;print("%d.%d.%d" % sys.version_info[:3])'], { timeoutMs: 8000 });
    const m = r.code === 0 && /(\d+)\.(\d+)\.(\d+)/.exec(r.out);
    if (!m) continue;
    const v = { major: +m[1], minor: +m[2], text: m[0] };
    if (v.major !== 3 || v.minor < 11) { found.push({ exe, pre, ...v, usable: false }); continue; }
    found.push({ exe, pre, ...v, usable: true, tested: v.minor <= 13 });
  }
  const pick = found.find((f) => f.usable && f.tested) || found.find((f) => f.usable) || null;
  return { pick, found };
}

const venvPython = (venvDir, platform = process.platform) =>
  platform === 'win32' ? path.join(venvDir, 'Scripts', 'python.exe') : path.join(venvDir, 'bin', 'python');

async function installEngine({ baseDir, preferred = '', onLog = () => {}, runFn = run, platform = process.platform, sources = SOURCES }) {
  const { pick, found } = await findPython({ preferred, platform, runFn });
  if (!pick) {
    const seen = found.length ? ` Found: ${found.map((f) => f.text).join(', ')}.` : ' No Python was found.';
    return { ok: false, error: `Python 3.11, 3.12 or 3.13 is required.${seen} Install one with: winget install Python.Python.3.12` };
  }
  if (!pick.tested) onLog(`Using Python ${pick.text}. This version has not been tested with TradingAgents; if the install fails, install Python 3.12 next to it.`);
  const venvDir = path.join(baseDir, 'venv');
  const py = venvPython(venvDir, platform);
  fs.mkdirSync(baseDir, { recursive: true });
  if (!fs.existsSync(py)) {
    onLog(`Creating a private environment with Python ${pick.text}…`);
    const r = await runFn(pick.exe, [...pick.pre, '-m', 'venv', venvDir], { onLog });
    if (r.code !== 0) return { ok: false, error: 'Could not create the Python environment.\n' + r.out.slice(-800) };
  }
  onLog('Updating the private environment package installer before downloading engine packages…');
  const pip = await runFn(py, ['-m', 'pip', 'install', '--disable-pip-version-check', '--upgrade', 'pip>=26.2'], { onLog, timeoutMs: 120000 });
  if (pip.code !== 0) return { ok: false, error: 'The install failed: could not update the private package installer.\n' + pip.out.slice(-800) };
  let last = '';
  for (const src of sources) {
    onLog(`Installing TradingAgents (pinned commit ${PINNED_SHA.slice(0, 7)}). This downloads a few hundred megabytes and can take several minutes…`);
    const r = await runFn(py, ['-m', 'pip', 'install', '--disable-pip-version-check', '--progress-bar', 'off', src], { onLog, heartbeatMs: 20000 });
    if (r.code === 0) {
      // Do not trust the exit code alone: prove the package imports.
      const v = await runFn(py, ['-c', 'import tradingagents, sys; print("import ok", sys.version.split()[0])'], { onLog, timeoutMs: 120000 });
      if (v.code === 0) {
        // Optional: lets the House disclosure reader work without poppler. Failure is not an error.
        const pdf = await runFn(py, ['-m', 'pip', 'install', '--disable-pip-version-check', '--progress-bar', 'off', 'pypdf'], { onLog, timeoutMs: 120000 });
        if (pdf.code !== 0) onLog('Optional PDF reader (pypdf) did not install. House disclosures will be listed but not read.');
        return { ok: true, python: py, version: pick.text };
      }
      last = `pip finished but the package does not import (exit ${v.code}).\n` + v.out.slice(-1000);
      onLog('pip finished, but TradingAgents does not import. ' + v.out.slice(-300));
      continue;
    }
    last = `pip exited with code ${r.code}${r.signal ? ' (' + r.signal + ')' : ''}.\n` + r.out.slice(-1200);
    onLog(`That source failed (pip exit code ${r.code}), trying the next one…`);
  }
  return { ok: false, error: 'The install failed. Last output:\n' + last };
}

module.exports = { findPython, installEngine, venvPython, run, candidates, PINNED_SHA, SOURCES };
