import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickPool, paceScore, isQuarantined, isExhausted, fiveHourTier } from '../src/lib/route.js';
import { FIVE_HOUR_NEAR_LIMIT_PCT } from '../src/meters/framework.js';

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

test('explicit effort-tier assignment wins only while its pool remains eligible', () => {
  const pools = [
    pool('fast-quota', { pace: 80, capabilities: ['code-reading'] }),
    pool('assigned', { pace: 1, capabilities: ['code-reading'] }),
  ];
  const picked = pickPool('build', pools, {
    callerEligible: false,
    callerSession: false,
    preferredPool: 'assigned',
    effortTier: 'high',
    requiredCapabilities: ['code-reading'],
  });
  assert.equal(picked.pick.pool, 'assigned');
  assert.match(picked.why, /configured high assignment/);

  pools[1].quarantine = { until: NOW + 10_000 };
  const fallback = pickPool('build', pools, {
    callerEligible: false,
    callerSession: false,
    preferredPool: 'assigned',
    effortTier: 'high',
    requiredCapabilities: ['code-reading'],
    now: NOW,
  });
  assert.equal(fallback.pick.pool, 'fast-quota');
});

// --- R7: 5h headroom outranks pace -------------------------------------------

test('5h tier: null reading is headroom, threshold is inclusive', () => {
  assert.equal(FIVE_HOUR_NEAR_LIMIT_PCT, 75);
  assert.equal(fiveHourTier(pool('a')), 0);                             // absent
  assert.equal(fiveHourTier(pool('a', { fiveHourUsedPct: null })), 0);  // no reading
  assert.equal(fiveHourTier(pool('a', { fiveHourUsedPct: 0 })), 0);
  assert.equal(fiveHourTier(pool('a', { fiveHourUsedPct: 74.9 })), 0);
  assert.equal(fiveHourTier(pool('a', { fiveHourUsedPct: 75 })), 1);
  assert.equal(fiveHourTier(pool('a', { fiveHourUsedPct: 82 })), 1);
});

test('near-limit pool loses to a headroom pool with a lower weekly surplus', () => {
  const near = pool('claude-code:wati', { pace: 60, fiveHourUsedPct: 80 });
  const headroom = pool('codex', { pace: 2, fiveHourUsedPct: 3 });
  const r = pickPool('build', [near, headroom], {
    callerEligible: false, callerSession: false, now: NOW,
  });
  assert.equal(r.pick.pool, 'codex'); // 5h headroom beats +58 surplus points
  assert.match(r.why, /most-behind capable pool with 5h headroom \(surplus 2, 5h used 3%\)/);
  assert.match(r.why, / · skipped near 5h limit: claude-code:wati 80%/);
});

test('near-limit pool is still picked when it is the only eligible pool', () => {
  const near = pool('claude-code:wati', { pace: -5, fiveHourUsedPct: 82 });
  const r = pickPool('build', [near], { callerEligible: false, callerSession: false, now: NOW });
  assert.equal(r.pick.pool, 'claude-code:wati');
  assert.match(r.why, /near its 5h limit \(surplus -5, 5h used 82%\)/);
  assert.doesNotMatch(r.why, /skipped near 5h limit/);
});

test('a null 5h reading counts as headroom and outranks a near-limit pool', () => {
  const unmetered = pool('grok', { pace: 0, fiveHourUsedPct: null });
  const near = pool('claude-code:wati', { pace: 40, fiveHourUsedPct: 91 });
  const r = pickPool('analyze', [near, unmetered], {
    callerEligible: false, callerSession: false, now: NOW,
  });
  assert.equal(r.pick.pool, 'grok');
  // No reading for the pick → no 5h clause about it, but the skip is named.
  assert.match(r.why, /most-behind capable pool \(surplus 0\)/);
  assert.match(r.why, /skipped near 5h limit: claude-code:wati 91%/);
});

test('explicit effort-tier assignment on a near-limit pool yields to headroom', () => {
  const assigned = pool('assigned', { pace: 50, fiveHourUsedPct: 88, capabilities: ['code-reading'] });
  const headroom = pool('spare', { pace: -3, fiveHourUsedPct: 12, capabilities: ['code-reading'] });
  const yielded = pickPool('build', [assigned, headroom], {
    callerEligible: false, callerSession: false, now: NOW,
    preferredPool: 'assigned', effortTier: 'high', requiredCapabilities: ['code-reading'],
  });
  assert.equal(yielded.pick.pool, 'spare');
  assert.doesNotMatch(yielded.why, /configured high assignment/);
  assert.match(yielded.why, /skipped near 5h limit: assigned 88%/);

  // Once the assignment's pool has headroom again it wins as before, and the
  // reason carries its 5h reading.
  assigned.fiveHourUsedPct = 20;
  const honored = pickPool('build', [assigned, headroom], {
    callerEligible: false, callerSession: false, now: NOW,
    preferredPool: 'assigned', effortTier: 'high', requiredCapabilities: ['code-reading'],
  });
  assert.equal(honored.pick.pool, 'assigned');
  assert.equal(honored.why, 'configured high assignment (assigned, 5h used 20%)');
});

test('an incumbent on a near-limit pool yields to a headroom pool', () => {
  const incumbent = pool('claude-code:wati', { incumbent: true, costRank: 1, pace: 30, fiveHourUsedPct: 79 });
  // Pricier and far behind on surplus: without R7 the incumbency margin plus
  // the cost guard would keep the incumbent.
  const headroom = pool('codex', { costRank: 3, pace: 1, fiveHourUsedPct: 4 });
  const r = pickPool('chore', [incumbent, headroom], {
    callerEligible: false, callerSession: false, now: NOW,
  });
  assert.equal(r.pick.pool, 'codex');
});

test('candidates expose the 5h fields in routing preference order', () => {
  const r = pickPool('build', [
    pool('near-high', { pace: 90, fiveHourUsedPct: 85 }),
    pool('headroom-low', { pace: 1, fiveHourUsedPct: 30 }),
    pool('headroom-high', { pace: 5, fiveHourUsedPct: null }),
  ], { callerEligible: false, callerSession: false, now: NOW });
  assert.deepEqual(r.candidates.map((c) => c.pool), ['headroom-high', 'headroom-low', 'near-high']);
  assert.deepEqual(
    r.candidates.map((c) => [c.fiveHourUsedPct, c.nearFiveHourLimit]),
    [[null, false], [30, false], [85, true]],
  );
});

test('every eligible pool near the limit: selection proceeds among them', () => {
  const r = pickPool('build', [
    pool('a', { pace: 10, fiveHourUsedPct: 76 }),
    pool('b', { pace: 40, fiveHourUsedPct: 89 }),
  ], { callerEligible: false, callerSession: false, now: NOW });
  assert.equal(r.pick.pool, 'b'); // most-behind wins as today
  assert.doesNotMatch(r.why, /skipped near 5h limit/);
  assert.match(r.why, /near its 5h limit \(surplus 40, 5h used 89%\)/);
});
