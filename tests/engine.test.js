'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { runEngine } = require('../src/engine');

const stub = path.join(__dirname, 'fixtures', 'stub-engine.js');
const run = (mode, extra = {}) => runEngine({ exe: process.execPath, args: [stub], req: { mode }, ...extra });

test('runner: parses events, ignores non-JSON lines, joins split lines', async () => {
  const seen = [];
  const { promise } = run('ok', { onEvent: (e) => seen.push(e.type) });
  const res = await promise;
  assert.equal(res.ok, true);
  assert.equal(res.result.rating, 'Buy');
  assert.deepEqual(seen, ['start', 'stage', 'result']);
  assert.match(res.stderrTail, /not json/);
});

test('runner: engine error event becomes a failure with message and trace', async () => {
  const res = await run('error').promise;
  assert.equal(res.ok, false);
  assert.equal(res.error, 'boom');
  assert.equal(res.trace, 'tb');
});

test('runner: crash without a result reports exit code and stderr', async () => {
  const res = await run('crash').promise;
  assert.equal(res.ok, false);
  assert.match(res.error, /exit code 3/);
  assert.match(res.stderrTail, /segfault-ish/);
});

test('runner: cancel stops a hung engine and reports canceled, not failure', async () => {
  const job = run('hang');
  await new Promise((r) => setTimeout(r, 250));
  job.cancel();
  const res = await job.promise;
  assert.equal(res.canceled, true);
  assert.equal(res.ok, false);
});

test('runner: a missing executable fails cleanly instead of throwing', async () => {
  const res = await runEngine({ exe: '/definitely/not/here', args: [], req: {} }).promise;
  assert.equal(res.ok, false);
  assert.match(res.error, /Could not start/);
});

test('runner: a throwing event handler does not break the run', async () => {
  const res = await run('ok', { onEvent: () => { throw new Error('ui bug'); } }).promise;
  assert.equal(res.ok, true);
});
