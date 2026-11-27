import test from 'node:test';
import assert from 'node:assert/strict';
import { workerMinutesForPool, attemptWindow } from '../src/lib/spend.js';

// 28 Nov profile of the panel: every 10 s usage reload, rateForWindow asked
// workerMinutesForPool once per pair of meter readings, and each call re-read
// and re-parsed the whole decision log (archive included, ~50 MB) for one pool.

const HOUR = 3_600_000;
const T0 = Date.parse('2026-11-20T00:00:00.000Z');

function entries(n) {
  return Array.from({ length: n }, (_, i) => ({
    pool: i % 3 === 0 ? 'cf:glm' : 'cf:deepseek',
    ts: new Date(T0 + i * 0.5 * HOUR).toISOString(),
    wallSec: 600 + (i % 7) * 300,
  }));
}

function bruteForce(log, name, from, to) {
  let minutes = 0;
  for (const entry of log) {
    if (entry.pool !== name) continue;
    const w = attemptWindow(entry);
    if (!w) continue;
    const overlap = Math.min(w.endMs, to) - Math.max(w.startMs, from);
    if (overlap > 0) minutes += overlap / 60_000;
  }
  return Math.round(minutes * 1e4) / 1e4;
}

test('repeated window queries over one decision log read each entry once', () => {
  let reads = 0;
  const log = entries(200).map((entry) => {
    const counted = {};
    for (const [key, value] of Object.entries(entry)) {
      Object.defineProperty(counted, key, { enumerable: true, get() { reads += 1; return value; } });
    }
    return counted;
  });
  workerMinutesForPool('cf:deepseek', T0, T0 + 10 * HOUR, { decisionLog: log, nowMs: T0 + 200 * HOUR });
  const afterFirst = reads;
  for (let i = 0; i < 50; i += 1) {
    workerMinutesForPool('cf:deepseek', T0 + i * HOUR, T0 + (i + 3) * HOUR, { decisionLog: log, nowMs: T0 + 200 * HOUR });
    workerMinutesForPool('cf:glm', T0 + i * HOUR, T0 + (i + 3) * HOUR, { decisionLog: log, nowMs: T0 + 200 * HOUR });
  }
  assert.equal(reads, afterFirst, 'later queries on the same log do not read its entries again');
});

test('window minutes match a plain sum over the log, and see an appended entry', () => {
  const log = entries(300);
  const now = T0 + 400 * HOUR;
  for (const [from, to] of [[T0, T0 + HOUR], [T0 + 7.25 * HOUR, T0 + 31 * HOUR], [T0 - HOUR, T0 + 500 * HOUR], [T0 + 149.9 * HOUR, T0 + 150.1 * HOUR]]) {
    for (const pool of ['cf:deepseek', 'cf:glm', 'agy']) {
      assert.equal(
        workerMinutesForPool(pool, from, to, { decisionLog: log, nowMs: now }),
        bruteForce(log, pool, from, to),
        `${pool} ${from}-${to}`,
      );
    }
  }
  const before = workerMinutesForPool('agy', T0, T0 + 2 * HOUR, { decisionLog: log, nowMs: now });
  log.push({ pool: 'agy', ts: new Date(T0 + HOUR).toISOString(), wallSec: 1800 });
  const after = workerMinutesForPool('agy', T0, T0 + 2 * HOUR, { decisionLog: log, nowMs: now });
  assert.equal(before, 0);
  assert.equal(after, 30, 'an entry appended to the same array is counted');
});
