import test from 'node:test';
import assert from 'node:assert/strict';
import { rungRecord } from '../src/lib/strategy.js';
import { expectedMinutesFor, isDurationSample, MIN_DURATION_SAMPLES } from '../src/lib/spend.js';

const row = (wallSec, extra = {}) => ({
  picked: 'p1', lane: 'build', effort: 'high', wallSec, ts: '2026-10-01T10:00:00Z', ...extra,
});
const ok = (wallSec, extra = {}) => row(wallSec, { ok: true, ...extra });

test('rungRecord: cancelled dispatches count but add no minutes', () => {
  const log = [
    ok(600),
    row(20, { ok: false, failureKind: 'cancelled' }),
    row(20, { ok: false, failureKind: 'cancelled' }),
  ];
  const rec = rungRecord(log, 'p1', 'high');
  assert.equal(rec.medianMinutes, 10);
  assert.equal(rec.dispatches, 3);
  assert.equal(rec.okShare, 1);
});

test('rungRecord: the dispatcher cancellation message alone marks a stopped row', () => {
  const log = [
    ok(600),
    row(20, { ok: false, why: 'workflow cancellation requested' }),
    row(20, { ok: false, why: 'workflow cancellation requested' }),
  ];
  const rec = rungRecord(log, 'p1', 'high');
  assert.equal(rec.medianMinutes, 10);
  assert.equal(rec.dispatches, 3);
});

test('rungRecord: a false failure ran its full length and keeps its minutes', () => {
  const log = [ok(600), row(1200, { ok: false, falseFailure: 'wrote outside cwd' })];
  const rec = rungRecord(log, 'p1', 'high');
  assert.equal(rec.medianMinutes, 15);
  assert.equal(rec.dispatches, 2);
});

test('isDurationSample: stopped and stalled rows are out, false failures stay', () => {
  assert.equal(isDurationSample(ok(60)), true);
  assert.equal(isDurationSample(row(60, { failureKind: 'cancelled' })), false);
  assert.equal(isDurationSample(row(60, { why: 'workflow cancellation requested' })), false);
  assert.equal(isDurationSample(row(60, { failureKind: 'stalled' })), false);
  assert.equal(isDurationSample(row(60, { stalled: true })), false);
  assert.equal(isDurationSample(row(60, { ok: false, falseFailure: 'x' })), true);
});

test('expectedMinutesFor: stalled and cancelled rows do not count as samples', () => {
  const noise = [
    row(20, { failureKind: 'cancelled' }),
    row(20, { why: 'workflow cancellation requested' }),
    row(30, { failureKind: 'stalled' }),
    row(30, { stalled: true }),
  ];
  const good = Array.from({ length: MIN_DURATION_SAMPLES - 1 }, () => ok(1200));
  const under = expectedMinutesFor({ lane: 'build', effort: 'high' }, { decisionLog: [...good, ...noise] });
  assert.equal(under.source, 'default');
  assert.equal(under.samples, MIN_DURATION_SAMPLES - 1);

  const enough = expectedMinutesFor(
    { lane: 'build', effort: 'high' },
    { decisionLog: [...good, ok(1200), ...noise] },
  );
  assert.equal(enough.source, 'history');
  assert.equal(enough.samples, MIN_DURATION_SAMPLES);
  assert.equal(enough.minutes, 20);
});
