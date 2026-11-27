import test from 'node:test';
import assert from 'node:assert/strict';
import { dayKey } from '../src/workflow/day-key.js';

// 28 Nov profile of Home: every paint asked dayKey for each finished run, and
// each answer ran Intl formatToParts. A local day only changes on a 15-minute
// UTC boundary (every zone offset and DST switch is a multiple of 15 min).

const direct = (ms, zone) => {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms));
  const f = (t) => parts.find((p) => p.type === t).value;
  return `${f('year')}-${f('month')}-${f('day')}`;
};

test('dayKey formats once per 15-minute bucket, not once per call', () => {
  const original = Intl.DateTimeFormat.prototype.formatToParts;
  let calls = 0;
  Intl.DateTimeFormat.prototype.formatToParts = function counted(...args) { calls += 1; return original.apply(this, args); };
  try {
    const base = Date.parse('2026-11-20T03:00:00.000Z');
    dayKey(base);
    const after = calls;
    for (let i = 0; i < 500; i += 1) dayKey(base + (i % 60) * 1000);
    assert.equal(calls, after, '500 instants in one bucket reuse the first answer');
  } finally { Intl.DateTimeFormat.prototype.formatToParts = original; }
});

test('cached day keys match direct formatting across odd offsets and DST', () => {
  const saved = process.env.TZ;
  try {
    for (const zone of ['Asia/Hong_Kong', 'Asia/Kolkata', 'Asia/Kathmandu', 'America/New_York', 'Australia/Lord_Howe', 'UTC']) {
      process.env.TZ = zone;
      for (const start of ['2026-03-08T00:00:00Z', '2026-11-01T00:00:00Z', '2026-10-04T00:00:00Z', '2026-11-27T15:00:00Z']) {
        const from = Date.parse(start);
        for (let ms = from; ms < from + 30 * 3_600_000; ms += 7 * 60_000 + 13_000) {
          assert.equal(dayKey(ms), direct(ms, zone), `${zone} ${new Date(ms).toISOString()}`);
        }
      }
    }
  } finally {
    if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
  }
});
