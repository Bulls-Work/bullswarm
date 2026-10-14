// 0.38.15 review quality, from the 2026-10-14 minisql benchmark: a dry stop
// with a severity floor, a non-functional review area by default, and a
// rotation that never leaves a round all on correctness. Also the 5h reading
// whose reset has passed (Second Mate, 23:00:41Z). Made-up names only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseProgramV3, storedProgramV3 } from '../src/workflow/program-v3.js';
import {
  FINDINGS_ANSWER, NON_FUNCTIONAL_AREA, atOrAboveFloor, coverRounds, dryVerdict, mergeRound, reviewRoundBlock, roundAreas,
} from '../src/workflow/dry-loops.js';
import { programAdvisories } from '../src/workflow/action-validator.js';
import { buildPools, fiveHourFromReading } from '../src/lib/config.js';
import { updateState } from '../src/lib/state.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const V3 = 'bullswarm.workflow.program.v3';
const severityAnswer = JSON.parse(JSON.stringify(FINDINGS_ANSWER));
const f = (title, severity, extra = {}) => ({ title, inScope: true, ...(severity ? { severity } : {}), ...extra });
const answer = (findings) => [{ step: 'review', area: 0, value: { findings } }];

const program = ({ areas = null, areasPerRound, until = {}, review = {} } = {}) => ({
  schemaVersion: V3,
  steps: [
    { id: 'build', lane: 'build', prompt: 'Build the acme engine.' },
    {
      id: 'review', dependsOn: ['build'], blindTo: ['build'], prompt: 'Review the acme engine.', answer: severityAnswer,
      ...(areas ? { areas } : {}), ...(areasPerRound !== undefined ? { areasPerRound } : {}), ...review,
    },
    { id: 'fix', dependsOn: ['review'], lane: 'build', prompt: 'Fix the acme engine.' },
  ],
  loops: [{ id: 'harden', steps: ['review', 'fix'], until: { step: 'review', dry: 1, ...until }, maxRounds: 4 }],
});
const issuesOf = (p) => { try { normaliseProgramV3(p); return []; } catch (error) { return error.issues; } };

test('severity floor: a round whose only new findings are obscure is dry, and its fixer is not run for them', () => {
  const obscureOnly = mergeRound({ answers: answer([f('Collation of NUL bytes', 'obscure')]), round: 1 });
  assert.equal(obscureOnly.entry.new, 0);
  assert.equal(obscureOnly.entry.belowFloor, 1);
  assert.deepEqual(obscureOnly.fix, []);
  assert.equal(obscureOnly.known[0].belowFloor, true);
  assert.equal(obscureOnly.known[0].severity, 'obscure');
  const loop = { until: { step: 'review', dry: 1 } };
  const group = { id: 'review', steps: ['review'], areas: [], perRound: 1 };
  const record = { findings: { rounds: [{ ...obscureOnly.entry, reviewed: [0] }] } };
  assert.equal(dryVerdict(loop, record, group).dry, true);

  // Beside an edge finding, the obscure one rides along to the fixer, marked.
  const mixed = mergeRound({ answers: answer([f('LIKE escape ignored', 'edge'), f('Collation of NUL bytes', 'obscure')]), round: 1 });
  assert.equal(mixed.entry.new, 1);
  assert.deepEqual(mixed.fix.map((item) => [item.finding.title, item.belowFloor === true]), [['LIKE escape ignored', false], ['Collation of NUL bytes', true]]);

  // No severity counts (old reviews keep working); everyday always counts.
  const unrated = mergeRound({ answers: answer([f('Parser drops minus', null)]), round: 1 });
  assert.equal(unrated.entry.new, 1);
  assert.equal(atOrAboveFloor({ severity: 'everyday' }, 'everyday'), true);
  assert.equal(atOrAboveFloor({ severity: 'edge' }, 'everyday'), false);
  assert.equal(atOrAboveFloor({ severity: 'obscure' }, 'obscure'), true);

  // floor everyday: an edge-only round is dry too.
  const edgeOnly = mergeRound({ answers: answer([f('LIKE escape ignored', 'edge')]), round: 1, floor: 'everyday' });
  assert.equal(edgeOnly.entry.new, 0);

  // A below-floor finding reported still open is a repeat, not a reason to go on.
  const later = mergeRound({ answers: answer([f('Collation of NUL bytes', 'obscure', { stillOpen: true })]), known: obscureOnly.known, round: 2 });
  assert.equal(later.entry.reopened, 0);
  assert.equal(later.entry.repeated, 1);
});

test('the floor and the opt-out are validated on the dry until', () => {
  assert.deepEqual(issuesOf(program({ until: { floor: 'everyday' } })), []);
  assert.deepEqual(normaliseProgramV3(program({ until: { floor: 'obscure' } })).loops[0].until, { step: 'review', dry: 1, floor: 'obscure' });
  assert.ok(issuesOf(program({ until: { floor: 'major' } })).some((issue) => issue.startsWith('loops[0].until.floor must be everyday, edge, obscure')));
  assert.ok(issuesOf(program({ until: { nonFunctional: true } })).some((issue) => issue.startsWith('loops[0].until.nonFunctional may only be false')));
});

test('a review whose areas are all correctness gets the non-functional area; one that names its own does not', () => {
  const added = normaliseProgramV3(program({ areas: ['grammar', 'types', 'joins'] }));
  assert.deepEqual(added.steps[1].areaOf.areas, ['grammar', 'types', 'joins', NON_FUNCTIONAL_AREA]);
  assert.equal(added.steps.filter((step) => step.areaOf).length, 3, 'still 3 reviewers a round (min(N, 3))');
  const advice = programAdvisories(storedProgramV3(program({ areas: ['grammar', 'types', 'joins'] }))).map((item) => item.code);
  assert.ok(advice.includes('review-area-added'));

  const own = normaliseProgramV3(program({ areas: ['grammar', 'types', 'query speed on 100k rows'] }));
  assert.deepEqual(own.steps[1].areaOf.areas, ['grammar', 'types', 'query speed on 100k rows']);
  const optOut = normaliseProgramV3(program({ areas: ['grammar', 'types'], until: { nonFunctional: false } }));
  assert.deepEqual(optOut.steps[1].areaOf.areas, ['grammar', 'types']);
});

test('rotation: with fewer reviewers than areas, every round has a non-functional reviewer and every area is covered', () => {
  const areas = ['grammar', 'types', 'joins', NON_FUNCTIONAL_AREA];
  const rounds = [1, 2, 3, 4].map((round) => roundAreas(areas, 3, round));
  for (const picked of rounds) assert.ok(picked.includes(3), `round ${JSON.stringify(picked)} has the non-functional area`);
  assert.deepEqual(new Set(rounds.slice(0, 2).flat()), new Set([0, 1, 2, 3]), 'two rounds review all four areas');
  assert.equal(coverRounds(areas, 3), 2);
  // Every area each round, or one reviewer a round: the plain rotation.
  assert.deepEqual(roundAreas(areas, 4, 1), [0, 1, 2, 3]);
  assert.deepEqual([1, 2, 3, 4].map((round) => roundAreas(areas, 1, round)[0]), [0, 1, 2, 3]);
  // No non-functional area (opted out): plain rotation, as 0.38.12.
  assert.deepEqual(roundAreas(['a', 'b', 'c', 'd'], 3, 1), [0, 1, 2]);
  assert.deepEqual(roundAreas(['a', 'b', 'c', 'd'], 3, 2), [3, 0, 1]);
  assert.equal(coverRounds(['a', 'b', 'c', 'd'], 3), 2);
});

function promptState({ areas = null, until = {} } = {}) {
  const stored = storedProgramV3(program({ areas, until }));
  return {
    program: stored,
    actions: stored.actions.map((action) => ({ id: action.id, status: 'pending', attempts: 0 })),
    attempts: [],
    controlNodes: [{ id: 'harden', type: 'loop', status: 'pending', at: null, round: 1, maxRounds: 4 }],
  };
}

test('reviewers are told the severity scale and the floor; a lone reviewer is asked past correctness unless opted out', () => {
  const single = reviewRoundBlock(promptState(), { id: 'review' });
  assert.match(single, /- severity: everyday \(ordinary use of the work hits it\), edge .*, or obscure/);
  assert.match(single, /Only everyday or edge findings keep the loop going/);
  assert.match(single, /look at performance .*code structure, and whether the tests would catch a regression/);
  const strict = reviewRoundBlock(promptState({ until: { floor: 'everyday' } }), { id: 'review' });
  assert.match(strict, /Only everyday findings keep the loop going/);
  const optOut = reviewRoundBlock(promptState({ until: { nonFunctional: false } }), { id: 'review' });
  assert.doesNotMatch(optOut, /look at performance/);
  const withAreas = promptState({ areas: ['grammar', 'types', 'joins'] });
  const third = reviewRoundBlock(withAreas, { id: 'review-area-3' });
  assert.match(third, new RegExp(`Focus on this area: ${NON_FUNCTIONAL_AREA}\\.`));
});

test('validate warns when a dry review has no severity', () => {
  const noSeverity = program({ review: { answer: { type: 'object', required: ['findings'], properties: { findings: { type: 'array', items: {
    type: 'object', required: ['title', 'inScope'], properties: { title: { type: 'string' }, inScope: { type: 'boolean' }, stillOpen: { type: 'boolean' } },
  } } } } } });
  const advice = programAdvisories(storedProgramV3(noSeverity));
  const warning = advice.find((item) => item.code === 'review-no-severity');
  assert.ok(warning);
  assert.match(warning.message, /add severity \(everyday, edge or obscure\)/);
  assert.ok(!programAdvisories(storedProgramV3(program())).some((item) => item.code === 'review-no-severity'));
});

test('a 5h reading whose reset has passed is 0% of a fresh window, not near its limit', () => {
  const now = Date.parse('2026-10-14T23:00:41Z');
  const reading = {
    source: 'snapshot',
    snapshot: { captured_at: '2026-10-14T22:58:00Z', five_hour: { utilization: 76, resets_at: '2026-10-14T23:00:00Z' }, seven_day: null },
    fiveHourUsedPct: 76, fiveHourResetsAt: '2026-10-14T23:00:00Z', burstGate: false,
  };
  assert.deepEqual(fiveHourFromReading(reading, now), { usedPct: 0, resetsAt: null, nearLimit: false, resetPassed: true });
  // Before the reset it is still the reading.
  assert.equal(fiveHourFromReading(reading, Date.parse('2026-10-14T22:59:00Z')).usedPct, 76);
  assert.equal(fiveHourFromReading(reading, Date.parse('2026-10-14T22:59:00Z')).nearLimit, true, '76% >= the 75% near line');
  const near = { ...reading, fiveHourUsedPct: 92, snapshot: { ...reading.snapshot, five_hour: { utilization: 92, resets_at: '2026-10-14T23:00:00Z' } } };
  assert.equal(fiveHourFromReading(near, Date.parse('2026-10-14T22:59:00Z')).nearLimit, true);
  assert.equal(fiveHourFromReading(near, now).nearLimit, false);

  // Through buildPools, as `bullswarm pools` shows it.
  const home = mkdtempSync(join(tmpdir(), 'bs-5h-reset-'));
  try {
    updateState(home, (state) => { state.pools.echo = { ...(state.pools.echo ?? {}), enabled: true }; });
    const { pools } = buildPools(home, now, { echo: near }, { packaged: true });
    const echo = pools.find((p) => p.name === 'echo');
    assert.equal(echo.fiveHourUsedPct, 0);
    assert.equal(echo.nearFiveHourLimit, false);
    assert.equal(echo.burstGate, false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
