// Urgency safeguards in expiringSoonView: the window-left floor, the headroom an
// unmeasured pool needs, and the clock-relative draining test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  expiringSoonView, MIN_WINDOW_LEFT_FRACTION, UNMEASURED_URGENT_HEADROOM_PCT, PACING_FORECAST_BLOCK_PCT,
} from '../src/lib/route.js';

const NOW = Date.parse('2026-10-31T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const weekly = (over) => ({
  pacingWindow: 'weekly', paceResetsAt: iso(NOW + 3600e3), pace: 10, usedPct: 50, elapsedPct: 50, ...over,
});

test('the constants the tests below rely on', () => {
  assert.equal(MIN_WINDOW_LEFT_FRACTION, 0.005);
  assert.equal(UNMEASURED_URGENT_HEADROOM_PCT, 5);
  assert.equal(PACING_FORECAST_BLOCK_PCT, 95);
});

test('a reset 30 seconds away is floored at 0.5% of the window, so urgency stays finite', () => {
  const view = expiringSoonView(weekly({
    paceResetsAt: iso(NOW + 30e3), pace: 13, elapsedPct: 99.99, spend: { pacing: { ratePerMinute: 0.01 } },
  }), { now: NOW });
  assert.equal(view.windowLeftFraction, MIN_WINDOW_LEFT_FRACTION);
  assert.equal(view.urgency, 2600); // 13 / 0.005
  assert.ok(Number.isFinite(view.urgency));
  assert.equal(view.state, 'urgent');
});

test('a pool with no elapsedPct has no measured window position: fraction 1, urgency is the surplus', () => {
  const view = expiringSoonView(weekly({ elapsedPct: undefined, spend: { pacing: { ratePerMinute: 0.01 } } }), { now: NOW });
  assert.equal(view.windowLeftFraction, 1);
  assert.equal(view.urgency, 10);
});

test('an unmeasured pool at 90% is urgent; at 91% it is normal', () => {
  const at = (usedPct) => expiringSoonView(weekly({ usedPct }), { now: NOW });
  assert.equal(at(90).ratePerMinute, null);
  assert.equal(at(90).state, 'urgent');
  assert.equal(at(91).state, 'normal');
});

test('a measured pool does not need the headroom', () => {
  const view = expiringSoonView(weekly({ usedPct: 94, elapsedPct: 99, spend: { pacing: { ratePerMinute: 0.001 } } }), { now: NOW });
  assert.equal(view.state, 'urgent');
});

test('forecast 96 is draining while the window is half gone, not when it is 99% gone', () => {
  const at = (elapsedPct) => expiringSoonView(
    weekly({ usedPct: 96, elapsedPct, spend: { pacing: { ratePerMinute: 0.001 } } }), { now: NOW });
  assert.equal(at(50).state, 'draining');
  assert.equal(at(99).state, 'urgent');
});

test('draining uses the fixed line when there is no elapsedPct', () => {
  const view = expiringSoonView(weekly({ usedPct: 96, elapsedPct: undefined, spend: { pacing: { ratePerMinute: 0.001 } } }), { now: NOW });
  assert.equal(view.state, 'draining');
});

test('forecast 94 is never draining', () => {
  const view = expiringSoonView(weekly({ usedPct: 94, elapsedPct: 10, spend: { pacing: { ratePerMinute: 0.001 } } }), { now: NOW });
  assert.notEqual(view.state, 'draining');
});

test('a window that resets after its lead time is not expiring soon', () => {
  const view = expiringSoonView(weekly({ paceResetsAt: iso(NOW + 25 * 3600e3) }), { now: NOW });
  assert.equal(view.expiringSoon, false);
  assert.equal(view.urgency, null);
});
