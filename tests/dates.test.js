'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validDate, todayLocal } = require('../src/requests');

test('calendar dates use local fields in time zones ahead of and behind UTC', () => {
  const previous = process.env.TZ;
  try {
    for (const zone of ['Asia/Tokyo', 'America/New_York', 'Pacific/Auckland']) {
      process.env.TZ = zone;
      const now = new Date('2026-10-25T12:00:00');
      assert.equal(validDate('2026-10-25', now), null, zone);
      assert.match(validDate('2026-10-26', now), /future/, zone);
      assert.match(validDate('2026-02-30', now), /real date/, zone);
    }
  } finally {
    if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous;
  }
});

test('the default research date stays local when UTC has advanced to tomorrow', () => {
  const previous = process.env.TZ;
  try {
    process.env.TZ = 'America/New_York';
    const now = new Date('2026-10-26T01:30:00Z');
    assert.equal(todayLocal(now), '2026-10-25');
    assert.equal(validDate(todayLocal(now), now), null);
  } finally {
    if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous;
  }
});
