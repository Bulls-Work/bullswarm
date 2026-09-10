import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickPool, paceScore, isQuarantined, isExhausted, fiveHourForecast,
  DEFAULT_INFLIGHT_PENALTY_PCT,
} from '../src/lib/route.js';
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

// --- D7: an empty candidate list names the stage that emptied it -------------

test('empty list blames the tier allow-list, not capabilities, when that is the cause', () => {
  // Every pool declares both required capabilities and both are lane-capable.
  // What made them ineligible is resolveDispatchModel: the `high` allow-list
  // selects models on some other pool, so neither of these has one.
  const blocked = (name) => pool(name, {
    capabilities: ['code-reading', 'file-editing'],
    modelPolicy: {
      eligible: false, model: null, source: 'tier-selection-empty',
      reason: 'no enabled model is assigned to high',
    },
  });
  const r = pickPool('analyze', [blocked('codex'), blocked('grok')], {
    callerEligible: false,
    callerSession: false,
    requiredCapabilities: ['code-reading', 'file-editing'],
    effortTier: 'high',
    now: NOW,
  });
  assert.equal(r.pick, null);
  assert.equal(r.why, 'no pool has a model allowed for the high tier');
  assert.doesNotMatch(r.why, /capabilities/);
  assert.deepEqual(r.candidates, []);
});

test('the caller-eligible variant keeps the allow-list cause too', () => {
  const r = pickPool('build', [pool('codex', {
    modelPolicy: { eligible: false, model: null, source: 'tier-selection-empty' },
  })], { effortTier: 'medium', now: NOW });
  assert.equal(r.keepOnClaude, true);
  assert.equal(r.why, 'no pool has a model allowed for the medium tier; caller takes the lane');
});

test('a model policy blocked for another reason reports that reason verbatim', () => {
  const r = pickPool('build', [pool('codex', {
    modelPolicy: {
      eligible: false, model: null, source: 'tier-selection-unsupported',
      reason: 'connector codex cannot select an assigned medium model',
    },
  })], { callerEligible: false, callerSession: false, effortTier: 'medium', now: NOW });
  assert.equal(
    r.why,
    'no pool has an allowed medium model under the current model policy '
      + '(connector codex cannot select an assigned medium model)',
  );
});

test('capabilities are still blamed when capabilities are the real cause', () => {
  const r = pickPool('analyze', [pool('codex', { capabilities: ['code-reading'] })], {
    callerEligible: false,
    callerSession: false,
    requiredCapabilities: ['strong-analysis'],
    effortTier: 'high',
    now: NOW,
  });
  assert.equal(r.why, 'no eligible pool with capabilities: strong-analysis');
});

test('an eligible model policy routes exactly as an absent one does', () => {
  const opts = { callerEligible: false, callerSession: false, effortTier: 'medium', now: NOW };
  const plain = pickPool('build', [pool('codex', { pace: 10 })], opts);
  const policed = pickPool('build', [pool('codex', {
    pace: 10, modelPolicy: { eligible: true, model: 'gpt-5.6-sol', source: 'tier-selection' },
  })], opts);
  assert.equal(plain.pick.pool, 'codex');
  assert.equal(policed.pick.pool, 'codex');
  assert.equal(policed.candidates[0].model, 'gpt-5.6-sol');
  assert.equal(policed.candidates[0].modelPolicy, 'tier-selection');
});

// --- R7: 5h headroom outranks pace -------------------------------------------

test('near-limit pool loses to a headroom pool with a lower weekly surplus', () => {
  // The threshold itself is doctrine and README:249 documents the number.
  assert.equal(FIVE_HOUR_NEAR_LIMIT_PCT, 75);
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

// --- R8: forecast-aware selection ---------------------------------------------

/** Pool carrying in-flight work with a known weekly spend rate. */
function busy(name, over = {}) {
  const { count = 1, remainingMinutes = 20, ratePerMinute = 0.05, source = 'history', ...rest } = over;
  return pool(name, {
    inflight: {
      count,
      minutes: count * remainingMinutes,
      records: Array.from({ length: count }, () => ({ remainingMinutes })),
    },
    spend: { weekly: { ratePerMinute, source } },
    ...rest,
  });
}

test('the forecast, not the reading, decides the near-limit tier', () => {
  // wati reads 60% but 72% is already projected for work in flight; a 10-minute
  // candidate at 0.36%/min adds 3.6 → 75.6, over the 75 line.
  const wati = pool('claude-code:wati', {
    pace: 60,
    fiveHourUsedPct: 60,
    projectedFiveHourPct: 72,
    spend: { fiveHour: { ratePerMinute: 0.36, source: 'history' } },
  });
  const codex = pool('codex', { pace: 2, fiveHourUsedPct: 20 });
  const r = pickPool('build', [wati, codex], {
    callerEligible: false, callerSession: false, now: NOW, candidateMinutes: 10,
  });
  assert.equal(r.pick.pool, 'codex');
  assert.match(r.why, /skipped near 5h limit \(projected\): claude-code:wati 75\.6%/);
  assert.equal(r.candidates.find((c) => c.pool === 'claude-code:wati').forecastFiveHourPct, 75.6);
  assert.equal(r.forecast.candidateMinutes, 10);

  // The same pools with a shorter candidate stay under the line: 72 + 0.36 → 72.4.
  const short = pickPool('build', [wati, codex], {
    callerEligible: false, callerSession: false, now: NOW, candidateMinutes: 1,
  });
  assert.equal(short.pick.pool, 'claude-code:wati');
  assert.match(short.why, /5h used 60% -> 72\.4% projected/);
});

test('candidateMinutes null forecasts the projection alone', () => {
  const p = pool('wati', {
    pace: 5,
    fiveHourUsedPct: 50,
    projectedFiveHourPct: 78,
    spend: { fiveHour: { ratePerMinute: 0.36, source: 'history' } },
  });
  const r = pickPool('build', [p], { callerEligible: false, callerSession: false, now: NOW });
  assert.equal(r.forecast.candidateMinutes, null);
  const c = r.candidates[0];
  assert.equal(c.forecastFiveHourPct, 78);       // no candidate term added
  assert.equal(c.projectedFiveHourPct, 78);
  assert.equal(c.fiveHourUsedPct, 50);
  assert.equal(c.nearFiveHourLimit, true);        // 78 ≥ 75 on the projection
  assert.match(r.why, /near its 5h limit \(surplus 5, 5h used 50% -> 78% projected\)/);
});

test('a pool forecast at or above the burst line is gated out of selection', () => {
  const gated = pool('wati', {
    pace: 80,
    fiveHourUsedPct: 70,
    projectedFiveHourPct: 88,
    spend: { fiveHour: { ratePerMinute: 0.36, source: 'history' } },
  });
  const open = pool('codex', { pace: -5, fiveHourUsedPct: 10 });
  const r = pickPool('build', [gated, open], {
    callerEligible: false, callerSession: false, now: NOW, candidateMinutes: 10,
  });
  assert.equal(r.pick.pool, 'codex');            // 88 + 3.6 = 91.6 ≥ 90
  assert.deepEqual(r.forecast.gated, ['wati']);
  assert.equal(r.candidates.find((c) => c.pool === 'wati').forecastGated, true);
  assert.equal(r.candidates.at(-1).pool, 'wati'); // gated pools sort last
  assert.match(r.why, /forecast-gated at\/above 90%: wati 91\.6%/);
});

test('every pool forecast-gated: the least loaded still wins, and why says so', () => {
  const a = pool('a', { pace: 40, fiveHourUsedPct: 80, projectedFiveHourPct: 95 });
  const b = pool('b', { pace: 5, fiveHourUsedPct: 82, projectedFiveHourPct: 91 });
  const r = pickPool('build', [a, b], { callerEligible: false, callerSession: false, now: NOW });
  assert.equal(r.pick.pool, 'b');                // least loaded, not most-behind
  assert.deepEqual(r.forecast.gated.sort(), ['a', 'b']);
  assert.match(r.why, /every capable pool is forecast-gated at\/above 90% of its 5h window; least loaded wins \(b, 5h used 82% -> 91% projected\)/);
});

test('an unknown forecast is never gated and never deprioritized', () => {
  const unmetered = pool('grok', { pace: 0 });
  const gated = pool('wati', { pace: 90, fiveHourUsedPct: 88, projectedFiveHourPct: 96 });
  const r = pickPool('analyze', [unmetered, gated], {
    callerEligible: false, callerSession: false, now: NOW, candidateMinutes: 10,
  });
  assert.equal(r.pick.pool, 'grok');
  assert.deepEqual(r.forecast.gated, ['wati']);
  const c = r.candidates.find((x) => x.pool === 'grok');
  assert.deepEqual(
    [c.forecastFiveHourPct, c.projectedFiveHourPct, c.forecastGated, c.nearFiveHourLimit],
    [null, null, false, false],
  );
});

test('between pools of equal pace the one carrying work in flight yields', () => {
  const loaded = busy('wati', { pace: 10, count: 2, remainingMinutes: 20, fiveHourUsedPct: 30 });
  const quiet = busy('codex', { pace: 10, count: 0, fiveHourUsedPct: 30 });
  const r = pickPool('build', [loaded, quiet], {
    callerEligible: false, callerSession: false, now: NOW, candidateMinutes: 6,
  });
  assert.equal(r.pick.pool, 'codex');
  // loaded: projection 0.05×(40 + 6) = 2.3 is below the 2×3 floor → 10 − 6 = 4,
  // labeled penalty · quiet: 10 − 0.05×6 = 9.7 on the measured rate
  assert.deepEqual(
    r.candidates.map((c) => [c.pool, c.pace, c.effectiveSurplus, c.inflight, c.estimateSource]),
    [['codex', 10, 9.7, 0, 'history'], ['wati', 10, 4, 2, 'penalty']],
  );
  assert.match(r.why, /preferred over busier: wati \(2 in flight\)/);
});

test('with no weekly rate, in-flight agents cost the flat penalty', () => {
  assert.equal(DEFAULT_INFLIGHT_PENALTY_PCT, 3);
  const loaded = pool('wati', { pace: 10, inflight: { count: 2, minutes: 40, records: [] } });
  const quiet = pool('codex', { pace: 8 });
  const r = pickPool('build', [loaded, quiet], {
    callerEligible: false, callerSession: false, now: NOW,
  });
  assert.equal(r.pick.pool, 'codex');            // 10 − 2×3 = 4 < 8
  const c = r.candidates.find((x) => x.pool === 'wati');
  assert.deepEqual([c.effectiveSurplus, c.inflight, c.estimateSource], [4, 2, 'penalty']);

  // The penalty is configurable; at 0 the raw pace decides again.
  const off = pickPool('build', [loaded, quiet], {
    callerEligible: false, callerSession: false, now: NOW, inflightPenaltyPct: 0,
  });
  assert.equal(off.pick.pool, 'wati');
});

test('an in-flight agent with no recorded remaining minutes still costs the penalty', () => {
  const p = pool('wati', {
    pace: 10,
    inflight: { count: 2, minutes: null, records: [{ remainingMinutes: 20 }, {}] },
    spend: { weekly: { ratePerMinute: 0.05, source: 'history' } },
  });
  const r = pickPool('build', [p], { callerEligible: false, callerSession: false, now: NOW });
  // projection 0.05×20 measured + 3 for the untimed one = 4, floor 2×3 = 6 → 10 − 6
  assert.equal(r.candidates[0].effectiveSurplus, 4);
  assert.equal(r.candidates[0].estimateSource, 'penalty');
});

test('a measured weekly rate never charges less than the flat floor per in-flight agent', () => {
  // The real machine measures about 0.05 weekly points per worker-minute, so a
  // six-minute agent projects to 0.3 points: without the floor a 4-point pace
  // gap keeps a whole burst on one pool.
  const loaded = busy('wati', { pace: 22, count: 2, remainingMinutes: 6, fiveHourUsedPct: 30 });
  const quiet = busy('codex', { pace: 18, count: 0, fiveHourUsedPct: 30 });
  const r = pickPool('build', [loaded, quiet], {
    callerEligible: false, callerSession: false, now: NOW, candidateMinutes: 6,
  });
  assert.equal(r.pick.pool, 'codex');
  const w = r.candidates.find((c) => c.pool === 'wati');
  // projection 0.05×(12 + 6) = 0.9 < floor 6 → 22 − 6 = 16 < codex 18 − 0.3
  assert.deepEqual([w.effectiveSurplus, w.inflight, w.estimateSource], [16, 2, 'penalty']);
  const c = r.candidates.find((x) => x.pool === 'codex');
  assert.deepEqual([c.effectiveSurplus, c.estimateSource], [17.7, 'history']);

  // A projection above the floor is charged in full and keeps its basis.
  const heavy = pool('grok', {
    pace: 22, fiveHourUsedPct: 30,
    inflight: { count: 1, minutes: 5, records: [{ remainingMinutes: 100 }] },
    spend: { weekly: { ratePerMinute: 0.5, source: 'history' } },
  });
  const h = pickPool('build', [heavy], { callerEligible: false, callerSession: false, now: NOW });
  // 0.5×100 = 50 > floor 3 → 22 − 50
  assert.deepEqual([h.candidates[0].effectiveSurplus, h.candidates[0].estimateSource], [-28, 'history']);
});

test('a loaded incumbent is displaced by a quieter challenger of equal cost', () => {
  const incumbent = busy('wati', {
    incumbent: true, costRank: 2, pace: 10, count: 3, remainingMinutes: 40, fiveHourUsedPct: 20,
  });
  const challenger = busy('codex', { costRank: 2, pace: 4, count: 0, fiveHourUsedPct: 20 });
  const r = pickPool('chore', [incumbent, challenger], {
    callerEligible: false, callerSession: false, now: NOW,
  });
  // incumbent 10 − max(0.05×120, 3×3) = 1 · challenger 4 − 0 = 4. R9: against a
  // challenger carrying fewer agents the loaded incumbent has no margin to hide
  // behind, so the higher effective surplus wins outright.
  assert.equal(r.pick.pool, 'codex');
  const sameLoad = busy('codex', { costRank: 2, pace: 4, count: 3, remainingMinutes: 40, fiveHourUsedPct: 20 });
  // An equally loaded challenger (4 − 9 = −5) gets no shortcut and loses.
  assert.equal(pickPool('chore', [incumbent, sameLoad], {
    callerEligible: false, callerSession: false, now: NOW,
  }).pick.pool, 'wati');
  challenger.pace = 14;                           // 14 ≥ 1 + INCUMBENCY_MARGIN too
  const flipped = pickPool('chore', [incumbent, challenger], {
    callerEligible: false, callerSession: false, now: NOW,
  });
  assert.equal(flipped.pick.pool, 'codex');
});

test('pools without forecast fields route exactly as before', () => {
  const pools = [pool('a', { pace: 30, fiveHourUsedPct: 40 }), pool('b', { pace: 5 })];
  const r = pickPool('build', pools, { callerEligible: false, callerSession: false, now: NOW });
  assert.equal(r.pick.pool, 'a');
  assert.equal(r.why, 'most-behind capable pool with 5h headroom (surplus 30, 5h used 40%)');
  assert.deepEqual(r.forecast, { candidateMinutes: null, gated: [] });
  assert.deepEqual(r.candidates.map((c) => [
    c.pace, c.effectiveSurplus, c.inflight, c.projectedFiveHourPct, c.forecastFiveHourPct,
    c.projectedWeeklyPct, c.ratePerMinute, c.estimateSource, c.forecastGated,
  ]), [
    [30, 30, 0, null, 40, null, null, 'none', false],
    [5, 5, 0, null, null, null, null, 'none', false],
  ]);
});

test('a loaded incumbent forfeits margin and cost guard against a quieter challenger (R9)', () => {
  // Seen on the real machine 2026-09-09: incumbent wati at surplus 26.7 with
  // three demo agents in flight kept the build lane against an idle grok at
  // 23.6, because grok lacked the 10-point margin. Load is not noise.
  const incumbent = pool('wati', {
    incumbent: true, costRank: 2, pace: 26.7, inflight: { count: 2, minutes: 0, records: [] },
  });
  const challenger = pool('grok', { costRank: 4, pace: 23.6 });
  const opts = { callerEligible: false, callerSession: false, now: NOW };
  // 26.7 − 2×3 = 20.7 < 23.6: no margin required, and a pricier pool may win.
  assert.equal(pickPool('build', [incumbent, challenger], opts).pick.pool, 'grok');
  // One agent in flight is still a genuine pace lead (23.7 > 23.6): the lane stays.
  const one = pool('wati', {
    incumbent: true, costRank: 2, pace: 26.7, inflight: { count: 1, minutes: 0, records: [] },
  });
  assert.equal(pickPool('build', [one, challenger], opts).pick.pool, 'wati');
  // An equally loaded challenger still needs the margin and the cost guard.
  const busyChallenger = pool('grok', {
    costRank: 4, pace: 23.6, inflight: { count: 2, minutes: 0, records: [] },
  });
  assert.equal(pickPool('build', [incumbent, busyChallenger], opts).pick.pool, 'wati');
});

test('the in-flight penalty is charged at the PACING window rate, not always the weekly one', () => {
  // command-code is paced by its monthly window, where it burns 0.5 points per
  // worker-minute; its weekly rate (0.05) would under-charge the same work by
  // a factor of ten and leave the burst stacked on an overspent pool.
  const monthly = pool('command-code', {
    pace: -4.1,
    pacingWindow: 'monthly',
    inflight: { count: 1, minutes: 30, records: [{ remainingMinutes: 60 }] },
    spend: {
      weekly: { ratePerMinute: 0.05, source: 'history' },
      monthly: { ratePerMinute: 0.5, source: 'history' },
      pacing: { window: 'monthly', ratePerMinute: 0.5, source: 'history' },
    },
  });
  const other = pool('codex', { pace: -20 });
  const r = pickPool('build', [monthly, other], {
    callerEligible: false, callerSession: false, now: NOW,
  });
  const c = r.candidates.find((x) => x.pool === 'command-code');
  // 0.5 × 60 = 30 > floor 3 → −4.1 − 30 = −34.1, below codex's −20.
  assert.deepEqual([c.effectiveSurplus, c.estimateSource, c.pacingWindow], [-34.1, 'history', 'monthly']);
  assert.equal(r.pick.pool, 'codex');

  // Same pool, same records, paced weekly: 0.05 × 60 = 3, floor 1 × 3 = 3.
  const weekly = pool('command-code', {
    pace: -4.1,
    pacingWindow: 'weekly',
    inflight: { count: 1, minutes: 30, records: [{ remainingMinutes: 60 }] },
    spend: {
      weekly: { ratePerMinute: 0.05, source: 'history' },
      monthly: { ratePerMinute: 0.5, source: 'history' },
      pacing: { window: 'weekly', ratePerMinute: 0.05, source: 'history' },
    },
  });
  const w = pickPool('build', [weekly, other], {
    callerEligible: false, callerSession: false, now: NOW,
  }).candidates.find((x) => x.pool === 'command-code');
  assert.deepEqual([w.effectiveSurplus, w.pacingWindow], [-7.1, 'weekly']);
});

test('a pool with only a weekly spend rate is charged exactly as before', () => {
  const before = pool('wati', {
    pace: 22, fiveHourUsedPct: 30,
    inflight: { count: 1, minutes: 5, records: [{ remainingMinutes: 100 }] },
    spend: { weekly: { ratePerMinute: 0.5, source: 'history' } },
  });
  const r = pickPool('build', [before], { callerEligible: false, callerSession: false, now: NOW });
  // Unchanged from the pre-0.28.1 assertion: 0.5 × 100 = 50 > floor 3.
  assert.deepEqual([r.candidates[0].effectiveSurplus, r.candidates[0].estimateSource], [-28, 'history']);
  assert.equal(r.candidates[0].pacingWindow, null);
  assert.equal(r.candidates[0].projectedPacingPct, null);

  // A pacing block with no measured rate falls back to the weekly one rather
  // than dropping to the flat penalty.
  const pacedButUnmeasured = pool('wati', {
    pace: 22, fiveHourUsedPct: 30,
    inflight: { count: 1, minutes: 5, records: [{ remainingMinutes: 100 }] },
    pacingWindow: 'monthly',
    spend: {
      weekly: { ratePerMinute: 0.5, source: 'history' },
      monthly: { ratePerMinute: null, source: null },
      pacing: { window: 'monthly', ratePerMinute: null, source: null },
    },
  });
  const fallback = pickPool('build', [pacedButUnmeasured], {
    callerEligible: false, callerSession: false, now: NOW,
  });
  assert.deepEqual(
    [fallback.candidates[0].effectiveSurplus, fallback.candidates[0].estimateSource],
    [-28, 'history'],
  );
});

// --- R10: the near-limit line is clock-relative --------------------------------

const MIN = 60_000;

/**
 * The three pools exactly as they read at 2026-09-10T22:19Z, when a high-tier
 * integrator was routed to `claude-code` and both accounts with quota about to
 * expire were skipped with `skipped near 5h limit (projected):
 * claude-code:wati 88.1%, claude-code:petsona 75.3%`.
 *
 * 5h rates are the ones that reproduce that decision's forecasts for the
 * 16-minute candidate it was routing: 81 + 0.44375×16 = 88.1,
 * 64 + 0.70625×16 = 75.3, 25 + 0.725×16 = 36.6. The weekly readings are the
 * ones behind each surplus (wati: 66% used of 87.4% elapsed → +21.4).
 */
function realDecisionPools(over = {}) {
  const make = (name, fiveHourUsedPct, resetsInMin, ratePerMinute, weeklyUsedPct, weeklyElapsedPct) =>
    pool(name, {
      pace: Math.round((weeklyElapsedPct - weeklyUsedPct) * 10) / 10,
      usedPct: weeklyUsedPct,
      elapsedPct: weeklyElapsedPct,
      fiveHourUsedPct,
      fiveHourResetsAt: new Date(NOW + (over[name] ?? resetsInMin) * MIN).toISOString(),
      spend: { fiveHour: { ratePerMinute, source: 'history' } },
    });
  return [
    make('claude-code:wati', 81, 23, 0.44375, 66, 87.4),
    make('claude-code:petsona', 64, 43, 0.70625, 74.6, 78),
    make('claude-code', 25, 83, 0.725, 76.9, 72.3),
  ];
}

test('a near-limit pool under its 5h clock keeps the lane (R10, 2026-09-10 replay)', () => {
  const r = pickPool('build', realDecisionPools(), {
    now: NOW, candidateMinutes: 16, callerEligible: false,
  });
  // wati is at 88.1% projected of a window that is 92.3% elapsed: it is
  // spending no faster than the clock, and the reset lands in 23 minutes —
  // before this 16-minute task could hit the wall.
  assert.equal(r.pick.pool, 'claude-code:wati');
  assert.equal(
    r.why,
    'most-behind capable pool (surplus 21.4, 5h used 81% -> 88.1% projected, '
      + 'under the clock (92.3% elapsed))',
  );
  assert.deepEqual(
    r.candidates.map((c) => [
      c.pool, c.pace, c.forecastFiveHourPct, c.fiveHourElapsedPct, c.nearFiveHourLimit,
    ]),
    [
      ['claude-code:wati', 21.4, 88.1, 92.3, false],
      ['claude-code:petsona', 3.4, 75.3, 85.7, false],
      ['claude-code', -4.6, 36.6, 72.3, false],
    ],
  );
});

test('the same 88.1% forecast four hours from the reset is still tiered down', () => {
  // Only the clock changed: 20% of the window elapsed, 88.1% of the quota
  // spent — this pool WILL hit the wall mid-run.
  const r = pickPool('build', realDecisionPools({ 'claude-code:wati': 240 }), {
    now: NOW, candidateMinutes: 16, callerEligible: false,
  });
  const wati = r.candidates.find((c) => c.pool === 'claude-code:wati');
  assert.deepEqual([wati.nearFiveHourLimit, wati.fiveHourElapsedPct], [true, 20]);
  assert.match(
    r.why,
    /skipped near 5h limit \(projected\): claude-code:wati 88\.1% \(20\.0% elapsed\)/,
  );
  // petsona, still 85.7% through its own window, keeps the lane.
  assert.equal(r.pick.pool, 'claude-code:petsona');

  // With both near-limit pools moved off their clocks the pre-R10 routing is
  // reproduced exactly: the task lands on the one account already ahead of its
  // weekly pace, and both skips name the clock that put them there.
  const both = pickPool('build', realDecisionPools({ 'claude-code:wati': 240, 'claude-code:petsona': 240 }), {
    now: NOW, candidateMinutes: 16, callerEligible: false,
  });
  assert.equal(both.pick.pool, 'claude-code');
  assert.equal(
    both.why,
    'most-behind capable pool with 5h headroom (surplus -4.6, 5h used 25% -> 36.6% projected)'
      + ' · skipped near 5h limit (projected): claude-code:wati 88.1% (20.0% elapsed),'
      + ' claude-code:petsona 75.3% (20.0% elapsed)',
  );
});

test('no 5h reset time means no clock, and the fixed 75% line applies', () => {
  const near = pool('wati', { pace: 60, fiveHourUsedPct: 88 });
  const headroom = pool('codex', { pace: 2, fiveHourUsedPct: 3 });
  const r = pickPool('build', [near, headroom], {
    callerEligible: false, callerSession: false, now: NOW,
  });
  assert.equal(r.pick.pool, 'codex');
  const c = r.candidates.find((x) => x.pool === 'wati');
  assert.deepEqual([c.nearFiveHourLimit, c.fiveHourElapsedPct], [true, null]);
  assert.match(r.why, /skipped near 5h limit: wati 88%/);   // no elapsed clause to add

  // A reset the clock has already passed is unknown too, not a full window.
  const stale = pool('wati', {
    pace: 60, fiveHourUsedPct: 88, fiveHourResetsAt: new Date(NOW - MIN).toISOString(),
  });
  const past = pickPool('build', [stale, headroom], {
    callerEligible: false, callerSession: false, now: NOW,
  });
  assert.equal(past.pick.pool, 'codex');
  assert.equal(past.candidates.find((x) => x.pool === 'wati').fiveHourElapsedPct, null);
});

test('the burst gate ignores the clock: 90% projected is gated whatever the hour', () => {
  // 98.3% of the window elapsed — as far under its clock as a pool can be —
  // and still gated: the wall is 90%, and this pool is past it now.
  const gated = pool('wati', {
    pace: 80, fiveHourUsedPct: 70, projectedFiveHourPct: 90.5,
    fiveHourResetsAt: new Date(NOW + 5 * MIN).toISOString(),
  });
  const open = pool('codex', { pace: -5, fiveHourUsedPct: 10 });
  const r = pickPool('build', [gated, open], {
    callerEligible: false, callerSession: false, now: NOW,
  });
  assert.equal(r.pick.pool, 'codex');
  assert.deepEqual(r.forecast.gated, ['wati']);
  const c = r.candidates.find((x) => x.pool === 'wati');
  assert.deepEqual([c.forecastGated, c.nearFiveHourLimit, c.fiveHourElapsedPct], [true, false, 98.3]);
  assert.match(r.why, /forecast-gated at\/above 90%: wati 90\.5% \(98\.3% elapsed\)/);
});

test('5h spend is clipped at the reset; the pacing-window charge is not', () => {
  // 10 minutes left in the 5h window, 0.5 points per minute, one agent with 30
  // minutes to run, and a 40-minute candidate. Only 10 of each set of minutes
  // can land inside this window.
  const clipped = pool('wati', {
    pace: 40,
    fiveHourUsedPct: 20,
    projectedFiveHourPct: 35,            // what the producer charged: 20 + 0.5×30
    fiveHourResetsAt: new Date(NOW + 10 * MIN).toISOString(),
    inflight: { count: 1, minutes: 10, records: [{ remainingMinutes: 30 }] },
    spend: {
      fiveHour: { ratePerMinute: 0.5, source: 'history' },
      weekly: { ratePerMinute: 0.5, source: 'history' },
    },
  });
  const f = fiveHourForecast(clipped, 40, NOW);
  assert.equal(f.candidateAdd, 5);       // 0.5 × min(40, 10), not 0.5 × 40 = 20
  assert.equal(f.inflightCreditPct, 10); // 0.5 × the 20 in-flight minutes past the reset
  assert.equal(f.forecast, 30);          // 20 + 5 in flight + 5 candidate
  assert.equal(f.minutesToReset, 10);

  const c = pickPool('build', [clipped], {
    callerEligible: false, callerSession: false, now: NOW, candidateMinutes: 40,
  }).candidates[0];
  assert.equal(c.forecastFiveHourPct, 30);
  assert.equal(c.fiveHourElapsedPct, 96.7);   // 10 of the 300 minutes left
  // The weekly window keeps every minute: 0.5 × (30 in flight + 40 candidate)
  // = 35 points off the surplus of 40, clipped nowhere.
  assert.deepEqual([c.effectiveSurplus, c.estimateSource], [5, 'history']);

  // Same pool with no reset time: nothing is clipped, exactly as before R10.
  delete clipped.fiveHourResetsAt;
  assert.equal(fiveHourForecast(clipped, 40, NOW).forecast, 55); // 35 + 0.5 × 40
});
