'use strict';
// Runs one engine job as a child process and streams its JSON-line events.
// One process per job means cancel is a kill and a crash cannot affect the next job.

const { spawn, spawnSync } = require('child_process');
const { engineEnvironment } = require('./security');

function killTree(child, platform = process.platform) {
  if (!child || child.killed || child.exitCode !== null) return;
  try {
    if (platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    else child.kill('SIGTERM');
  } catch { /* process already ended */ }
}

/**
 * exe/args: how to start the engine (python plus script path).
 * req: object sent to the engine on stdin. env: extra environment (merged over process.env).
 * Returns { promise, cancel }. The promise always resolves:
 *   { ok, result, error, canceled, events, stderrTail, code }
 */
function runEngine({ exe, args = [], req, env = {}, onEvent = () => {}, cwd, spawnFn = spawn, killFn = killTree }) {
  let child;
  let canceled = false;
  const promise = new Promise((resolve) => {
    const events = [];
    let result = null;
    let error = null;
    let buf = '';
    let stderr = '';
    try {
      child = spawnFn(exe, args, {
        cwd,
        env: engineEnvironment(process.env, env),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolve({ ok: false, error: `Could not start the engine: ${e.message}`, canceled: false, events, stderrTail: '', code: null });
      return;
    }
    const handleLine = (line) => {
      line = line.trim();
      if (!line) return;
      let ev;
      try { ev = JSON.parse(line); } catch { stderr += line + '\n'; return; }
      if (!ev || typeof ev !== 'object' || typeof ev.type !== 'string') return;
      events.push(ev);
      if (ev.type === 'result') result = ev;
      else if (ev.type === 'error') error = ev;
      try { onEvent(ev); } catch { /* a UI handler must not break the run */ }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { handleLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-6000); });
    child.on('error', (e) => {
      resolve({ ok: false, error: `Could not start the engine: ${e.message}`, canceled, events, stderrTail: stderr.slice(-1500), code: null });
    });
    child.on('close', (code) => {
      if (buf.trim()) handleLine(buf);
      if (canceled) return resolve({ ok: false, canceled: true, events, stderrTail: stderr.slice(-1500), code });
      if (result && !error) return resolve({ ok: true, result, events, stderrTail: stderr.slice(-1500), code });
      const msg = error ? error.message : `The engine stopped without a result (exit code ${code}).`;
      resolve({ ok: false, error: msg, trace: error && error.trace, events, stderrTail: stderr.slice(-1500), code });
    });
    try { child.stdin.write(JSON.stringify(req) + '\n'); child.stdin.end(); } catch { /* close handler reports it */ }
  });
  return { promise, cancel() { canceled = true; killFn(child); } };
}

module.exports = { runEngine, killTree };
