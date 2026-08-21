import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickPool, paceScore, isQuarantined, isExhausted } from '../src/lib/route.js';

const HOUR = 3600_000;
const NOW = 1_000_000_000_000;

function pool(name, over = {}) {
  return { name, costRank: 2, lanes: ['analyze', 'build', 'chore'], ...over };
}

test('most-behind capable pool wins (highest surplus)', () => {
  const r = pickPool('build', [
    // codex: weekly window 84h in → 50% elapsed, only 10% used → surplus +40
    pool('codex', { meter: { type: 'weekly', windowStart: NOW - 84 * HOUR, usedPct: 10 }, costRank: 3 }),
    // grok: 5h window 4h in → 80% elapsed, 80% used → surplus 0
    pool('grok', { meter: { type: '5h', windowStart: NOW - 4 * HOUR, usedPct: 80 }, costRank: 2 }),
  ], { callerEligible: false, now: NOW });
  assert.equal(r.pick.pool, 'codex');
});

test('pace score: elapsed minus used; unmetered neutral', () => {
  const behind = paceScore(
    { meter: { type: '5h', windowStart: NOW - 4 * HOUR, usedPct: 20 } }, NOW,
  );
  assert.equal(behind, 60); // 80% elapsed − 20% used
  assert.equal(paceScore({ meter: { type: 'none' } }), 0);
});

test('cost guard in incumbency path: challenger must be cheaper', () => {
  // incumbent grok (rank 2). codex (rank 3 = pricier) has huge surplus but
  // must NOT displace grok. opencode2 (rank 1) needs margin too.
  const inc = pool('grok', {
    incumbent: true, costRank: 2,
    meter: { type: '5h', windowStart: NOW - 2 * HOUR, usedPct: 40 }, // surplus 40−40=0
  });
  const pricey = pool('codex', {
    costRank: 3,
    meter: { type: 'weekly', windowStart: NOW - 84 * HOUR, usedPct: 10 }, // surplus +40
  });
  const cheapNoMargin = pool('opencode2', {
    costRank: 1,
    meter: { type: '5h', windowStart: NOW - 2 * HOUR, usedPct: 35 }, // surplus +5 < margin
  });
  const r = pickPool('analyze', [inc, pricey, cheapNoMargin], { callerEligible: false, now: NOW });
  assert.equal(r.pick.pool, 'grok'); // neither challenger qualifies
});

test('incumbent displaced when cheaper challenger clears margin', () => {
  const inc = pool('opencode2', {
    incumbent: true, costRank: 1,
    meter: { type: '5h', windowStart: NOW - 2 * HOUR, usedPct: 40 }, // surplus 0
  });
  const chal = pool('command-code', {
    costRank: 0,
    meter: { type: '5h', windowStart: NOW - 4 * HOUR, usedPct: 20 }, // surplus +60
  });
  const r = pickPool('chore', [inc, chal], { callerEligible: false, now: NOW });
  assert.equal(r.pick.pool, 'command-code');
});

test('caller wins the lane when every delegate pool is exhausted', () => {
  const pools = [pool('grok', { meter: { type: '5h', windowStart: NOW - 4 * HOUR, usedPct: 100 } })];
  assert.equal(isExhausted(pools[0]), true);
  const r = pickPool('analyze', pools, { callerEligible: true, callerName: 'claude', now: NOW });
  assert.equal(r.keepOnClaude, true);
  assert.equal(r.pick, null);
});

test('caller does not win while a delegate has headroom', () => {
  const pools = [pool('grok', { meter: { type: '5h', windowStart: NOW - 4 * HOUR, usedPct: 30 } })];
  const r = pickPool('analyze', pools, { callerEligible: true, callerName: 'claude', now: NOW });
  assert.equal(r.keepOnClaude, false);
  assert.equal(r.pick.pool, 'grok');
});

test('quarantined pools excluded until expiry, then back in service', () => {
  const until = NOW + 1000;
  const p = pool('grok', { quarantine: { until } });
  assert.equal(isQuarantined(p, NOW), true);
  const during = pickPool('chore', [p], { callerEligible: false, now: NOW });
  assert.equal(during.candidates.length, 0);
  assert.equal(isQuarantined(p, NOW + 2000), false);
  const after = pickPool('chore', [p], { callerEligible: false, now: NOW + 2000 });
  assert.equal(after.pick.pool, 'grok'); // re-probe path: automatic return
});

test('unknown lane is refused, never guessed', () => {
  const r = pickPool('vibes', [pool('grok')]);
  assert.equal(r.pick, null);
  assert.match(r.why, /unknown lane/);
});
