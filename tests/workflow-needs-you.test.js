// The needs-you block (stage-3 §2.5, D25, D26): what the watcher prints when a
// program step comes back to the caller. The states here are small hand-built
// program runs with made-up pools (pool-a, pool-b, luna-1, luna-2) and paths.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { needsYouFacts, needsYouJson, renderNeedsYou } from '../src/workflow/needs-you.js';
import { notableWatchEvents, renderWatchEvent, watchTrouble } from '../src/workflow/watch-cli.js';
import { NEEDS_YOU_LABELS } from '../src/workflow/step-vocabulary.js';

process.env.BULLSWARM_UNICODE = '1';
delete process.env.BULLSWARM_ASCII;

const MARKED = { deliverableGate: 1, proofLabels: 1, failureRule: 1, reviewPlacement: 'caller' };
const T0 = Date.parse('2026-09-24T01:00:00.000Z');
const at = (minutes) => new Date(T0 + minutes * 60_000).toISOString();
const step = (id, extra = {}) => ({
  id, purpose: id, dependsOn: [], affects: [], ownedFiles: [], prompt: `Do ${id}.`, lane: 'build', effort: 'medium',
  evidenceFor: [], inputs: [], produces: [], ...extra,
});

function attempt(actionId, ordinal, { start, minutes, ...extra }) {
  return {
    id: `${actionId}-${ordinal}`, actionId, ordinal, status: 'failed', pool: 'pool-a', model: 'model-a',
    startedAt: at(start), finishedAt: at(start + minutes), changedFileCount: 3,
    outputFile: `/runs/acme/out-${actionId}-attempt-${ordinal}.md`,
    routeCandidates: [{ pool: 'pool-a' }, { pool: 'pool-b' }],
    ...extra,
  };
}

// The design's example: `variants` failed its command evidence after its one
// same-pool retry, `copy` still runs, and `pick` then `ship` wait on it.
function designState() {
  return {
    runId: 'wf-acme-000001', shortId: 'acme01',
    config: { settings: { executionMode: 'program' } },
    program: {
      actions: [
        step('variants', { evidence: [{ type: 'command', cmd: 'npm test' }] }),
        step('copy'),
        step('pick', { dependsOn: ['variants'] }),
        step('ship', { dependsOn: ['pick'] }),
        step('done-already'),
      ],
    },
    actions: [
      { id: 'variants', status: 'failed', supersededAttempts: 0, lastFailure: { kind: 'failed-evidence', message: 'npm test → exit 1' } },
      { id: 'copy', status: 'running' },
      { id: 'pick', status: 'blocked' },
      { id: 'ship', status: 'pending' },
      { id: 'done-already', status: 'succeeded' },
    ],
    attempts: [
      attempt('variants', 1, { start: 0, minutes: 11, failureKind: 'failed-evidence' }),
      attempt('variants', 2, {
        start: 12, minutes: 7, failureKind: 'failed-evidence',
        retryOf: { attempt: 'variants-1', how: 'same-pool' }, handoff: { from: 'variants-1', bytes: 900 },
        diffFile: '/runs/acme/diff-variants-attempt-2.patch',
        evidenceResults: [{ type: 'command', cmd: 'npm test', status: 'failed', exit: 1, why: 'exit 1', tail: 'ok 2 - loads\nnot ok 3 - variants render\n' }],
      }),
    ],
  };
}

const failedEvent = (actionId, extra = {}) => ({
  type: 'action.finished', sequence: 212, committedAt: at(20),
  payload: { actionId, status: 'failed', ...extra },
});

test('the design block renders exactly: failed-evidence after one same-pool retry, still running and waiting on this', () => {
  const state = designState();
  const facts = needsYouFacts(state, failedEvent('variants', { failureKind: 'failed-evidence', attemptIds: ['variants-1', 'variants-2'], retries: 1 }), { features: MARKED });
  assert.deepEqual(renderNeedsYou(facts, { next: `bullswarm workflow watch acme01 --until trouble --after 212 --since ${at(20)}` }), [
    '✗ variants needs you · command evidence failed after 1 retry',
    '  evidence  npm test → exit 1',
    '            not ok 3 - variants render',
    '  try 1  pool-a · model-a · 11m00s · 3 files',
    '  try 2  same pool, failure attached · 7m00s · 3 files',
    '  still running: copy · waiting on this: pick, ship',
    '  your call:',
    '    rerun elsewhere  bullswarm workflow step rerun acme01 variants --avoid pool-a',
    '    change the step  bullswarm workflow plan export acme01 --out plan.json',
    '      then edit it   bullswarm workflow plan revise acme01 --program plan.json',
    '    take over        output: /runs/acme/out-variants-attempt-2.md · diff: /runs/acme/diff-variants-attempt-2.patch',
    '    accept anyway    bullswarm workflow step accept acme01 variants --reason "…"',
    `  next: bullswarm workflow watch acme01 --until trouble --after 212 --since ${at(20)}`,
  ]);
});

test('the label table follows NEEDS_YOU_LABELS, with the kind itself for anything else', () => {
  const cases = [
    ['not-produced', 'deliverable not produced'], ['schema', 'report format failed'], ['semantic', 'output check failed'],
    ['process', 'worker exited with an error'], ['provider', 'provider error'], ['stalled', 'worker went silent'],
    ['auth', 'sign-in failed'], ['interrupted', 'worker was killed'], ['throttle', 'rate limited'],
    ['quota', 'out of quota'], ['unavailable', 'no eligible pool'], ['ownership-conflict', 'merge conflict'],
    ['ownership', 'wrote outside its files'], ['runtime', 'kernel error'], ['something-new', 'something-new'],
  ];
  for (const [kind, label] of cases) {
    const state = designState();
    state.attempts = [attempt('variants', 1, { start: 0, minutes: 2, failureKind: kind })];
    const facts = needsYouFacts(state, failedEvent('variants', { failureKind: kind, why: 'x' }), { features: MARKED });
    assert.equal(facts.label, label, kind);
    if (NEEDS_YOU_LABELS[kind]) assert.equal(facts.label, NEEDS_YOU_LABELS[kind]);
  }
  // failed-evidence picks by the type of the first failing item.
  const state = designState();
  state.attempts[1].evidenceResults = [
    { type: 'command', cmd: 'npm run lint', status: 'passed', exit: 0, why: null },
    { type: 'schema', file: 'out/data.json', schema: 'schemas/data.json', status: 'failed', exit: 1, errorCount: 2, why: '2 errors', tail: '/items/0/id: must be string' },
  ];
  assert.equal(needsYouFacts(state, failedEvent('variants', { failureKind: 'failed-evidence' }), { features: MARKED }).label, 'schema evidence failed');
});

test('zero retries reads `not retried`, and a why line stands in for evidence on other kinds', () => {
  const state = designState();
  state.program.actions[0] = step('variants');
  state.attempts = [attempt('variants', 1, { start: 0, minutes: 2, failureKind: 'process', changedFileCount: undefined })];
  const lines = renderNeedsYou(needsYouFacts(state, failedEvent('variants', { failureKind: 'process', why: `worker exited with code 1 ${'x'.repeat(300)}` }), { features: MARKED }));
  assert.equal(lines[0], '✗ variants needs you · worker exited with an error · not retried');
  assert.match(lines[1], /^ {2}why {7}worker exited with code 1 x+…$/);
  assert.equal(lines[1].length, '  why       '.length + 160, 'the why is at most 160 characters');
  assert.equal(lines[2], '  try 1  pool-a · model-a · 2m00s · 0 files', 'no recorded count reads 0 files');
  // Stage 2's F23 fact stays: a step that declares evidence and failed before it ran.
  const declared = designState();
  declared.attempts = [attempt('variants', 1, { start: 0, minutes: 2, failureKind: 'process' })];
  const facts = needsYouFacts(declared, failedEvent('variants', { failureKind: 'process', why: 'worker exited with code 1' }), { features: MARKED });
  assert.equal(renderNeedsYou(facts)[1], '  why       worker exited with code 1 · evidence not run');
  assert.equal(needsYouJson(facts).evidenceNotRun, true);
});

test('schema evidence lines: n errors for exit 1, the why for exit 2, one tail line each, at most two items', () => {
  const state = designState();
  state.attempts[1].evidenceResults = [
    { type: 'schema', file: 'out/data.json', schema: 'schemas/data.json', status: 'failed', exit: 1, errorCount: 1, why: '1 error', tail: '/items/0/id: must be string' },
    { type: 'schema', file: 'out/b.json', schema: 'schemas/b.json', status: 'failed', exit: 2, why: 'file not found: out/b.json' },
    { type: 'command', cmd: 'npm test', status: 'failed', exit: null, timedOut: true, why: 'timed out after 3s' },
  ];
  const lines = renderNeedsYou(needsYouFacts(state, failedEvent('variants', { failureKind: 'failed-evidence', retries: 1 }), { features: MARKED }));
  assert.deepEqual(lines.slice(1, 4), [
    '  evidence  schema out/data.json ← schemas/data.json → 1 error',
    '            /items/0/id: must be string',
    '  evidence  schema out/b.json ← schemas/b.json → file not found: out/b.json',
  ]);
  assert.match(lines[4], /^ {2}try 1/, 'the third failing item is left out');
  // A command item whose exit is null prints its why.
  state.attempts[1].evidenceResults = [{ type: 'command', cmd: 'node x.js', status: 'failed', exit: null, signal: 'SIGABRT', why: 'killed by SIGABRT' }];
  assert.equal(renderNeedsYou(needsYouFacts(state, failedEvent('variants', { failureKind: 'failed-evidence', retries: 1 }), { features: MARKED }))[1], '  evidence  node x.js → killed by SIGABRT');
});

test('a check that could not run is labelled so and never retried', () => {
  const state = designState();
  state.attempts[1].evidenceResults = [{ type: 'schema', file: 'out/data.json', schema: 'schemas/missing.json', status: 'failed', exit: 2, fault: 'check', why: 'schema not found: schemas/missing.json' }];
  const facts = needsYouFacts(state, failedEvent('variants', { failureKind: 'failed-evidence', retries: 1 }), { features: MARKED });
  assert.equal(renderNeedsYou(facts)[0], '✗ variants needs you · check could not run · not retried');
  assert.equal(needsYouJson(facts).notRetried, 'check');
});

test('retry here when the last attempt had no other candidate pool', () => {
  const state = designState();
  for (const entry of state.attempts) entry.routeCandidates = [{ pool: 'pool-a' }];
  const lines = renderNeedsYou(needsYouFacts(state, failedEvent('variants', { failureKind: 'failed-evidence', retries: 1 }), { features: MARKED }));
  assert.equal(lines.find((line) => line.startsWith('    retry here')), '    retry here       bullswarm workflow step rerun acme01 variants');
  assert.equal(lines.some((line) => line.includes('rerun elsewhere')), false);
  // routing.candidates is read when routeCandidates is absent.
  for (const entry of state.attempts) { delete entry.routeCandidates; entry.routing = { candidates: [{ pool: 'pool-a' }, { pool: 'pool-b' }] }; }
  assert.ok(renderNeedsYou(needsYouFacts(state, failedEvent('variants', { failureKind: 'failed-evidence', retries: 1 }), { features: MARKED })).some((line) => line.startsWith('    rerun elsewhere')));
});

test('still running and waiting on this are capped at five names, then `and N more`; the line is left out when both are empty', () => {
  const state = designState();
  for (let index = 1; index <= 7; index += 1) {
    state.program.actions.push(step(`side-${index}`), step(`after-${index}`, { dependsOn: ['variants'] }));
    state.actions.push({ id: `side-${index}`, status: index % 2 ? 'running' : 'waiting' }, { id: `after-${index}`, status: 'pending' });
  }
  const lines = renderNeedsYou(needsYouFacts(state, failedEvent('variants', { failureKind: 'failed-evidence', retries: 1 }), { features: MARKED }));
  assert.equal(
    lines.find((line) => line.startsWith('  still running')),
    '  still running: copy, side-1, side-2, side-3, side-4 and 3 more · waiting on this: pick, ship, after-1, after-2, after-3 and 4 more',
  );
  const alone = designState();
  alone.actions = alone.actions.map((entry) => (entry.id === 'variants' ? entry : { ...entry, status: 'succeeded' }));
  assert.equal(renderNeedsYou(needsYouFacts(alone, failedEvent('variants', { failureKind: 'failed-evidence', retries: 1 }), { features: MARKED }))
    .some((line) => /still running|waiting on this/.test(line)), false);
  // Only the waiting part.
  alone.actions.find((entry) => entry.id === 'pick').status = 'blocked';
  assert.ok(renderNeedsYou(needsYouFacts(alone, failedEvent('variants', { failureKind: 'failed-evidence', retries: 1 }), { features: MARKED }))
    .includes('  waiting on this: pick'));
});

test('terminal mode leaves out your call and next', () => {
  const facts = needsYouFacts(designState(), failedEvent('variants', { failureKind: 'failed-evidence', retries: 1 }), { features: MARKED });
  const lines = renderNeedsYou(facts, { terminal: true, next: 'bullswarm workflow watch acme01 --until trouble' });
  assert.equal(lines.at(-1), '  still running: copy · waiting on this: pick, ship');
  assert.equal(lines.some((line) => /your call|next:|accept anyway/.test(line)), false);
});

test('the JSONL object has the documented shape and carries the cursor sequence', () => {
  const state = designState();
  const facts = needsYouFacts(state, failedEvent('variants', { failureKind: 'failed-evidence', attemptIds: ['variants-1', 'variants-2'], retries: 1 }), { features: MARKED });
  assert.deepEqual(needsYouJson(facts), {
    actionId: 'variants', label: 'command evidence failed', failureKind: 'failed-evidence', retries: 1,
    evidence: [{ type: 'command', cmd: 'npm test', exit: 1, why: 'exit 1', tail: 'not ok 3 - variants render' }],
    attempts: [
      { id: 'variants-1', pool: 'pool-a', model: 'model-a', durationSec: 660, files: 3 },
      { id: 'variants-2', pool: 'pool-a', model: 'model-a', durationSec: 420, files: 3, retryOf: 'same-pool', handoff: true },
    ],
    stillRunning: ['copy'], waitingOnThis: ['pick', 'ship'],
    options: {
      rerunElsewhere: 'bullswarm workflow step rerun acme01 variants --avoid pool-a',
      changeStep: 'bullswarm workflow plan export acme01 --out plan.json, edit it, then bullswarm workflow plan revise acme01 --program plan.json',
      takeOver: 'output: /runs/acme/out-variants-attempt-2.md · diff: /runs/acme/diff-variants-attempt-2.patch',
      acceptAnyway: 'bullswarm workflow step accept acme01 variants --reason "…"',
    },
  });
  // Through the watcher: one needs-you notable, trouble `failed`, no facts leak into JSON.
  const { notable } = notableWatchEvents({ events: [failedEvent('variants', { failureKind: 'failed-evidence', retries: 1 })], state });
  assert.equal(notable.length, 1);
  assert.equal(notable[0].type, 'needs-you');
  assert.equal(watchTrouble(notable[0]), 'failed');
  const record = JSON.parse(JSON.stringify({ type: notable[0].type, sequence: 212, ...notable[0] }));
  assert.deepEqual(Object.keys(record), ['type', 'sequence', 'actionId', 'label', 'failureKind', 'retries', 'evidence', 'attempts', 'stillRunning', 'waitingOnThis', 'options']);
  assert.equal(renderWatchEvent(notable[0]).split('\n')[0], '✗ variants needs you · command evidence failed after 1 retry');
});

test('a saved run with no retryOf facts counts the attempts minus one; a marked run counts its facts', () => {
  const saved = designState();
  delete saved.attempts[1].retryOf;
  saved.attempts.push(attempt('variants', 3, { start: 20, minutes: 1, failureKind: 'process' }));
  const event = { ...failedEvent('variants', { failureKind: 'process', why: 'exit 1' }), committedAt: at(22) };
  assert.equal(needsYouFacts(saved, event, { features: {} }).retries, 2);
  assert.equal(renderNeedsYou(needsYouFacts(saved, event, { features: {} }))[0], '✗ variants needs you · worker exited with an error after 2 retries');
  // Marked: a plain attempt (a kernel resume) is not a retry; a wait is not either.
  const marked = designState();
  marked.attempts.push(attempt('variants', 3, { start: 20, minutes: 1, failureKind: 'process', pool: 'pool-b', retryOf: { attempt: 'variants-2', how: 'wait' } }));
  const facts = needsYouFacts(marked, event, { features: MARKED });
  assert.equal(facts.retries, 1);
  assert.equal(renderNeedsYou(facts).find((line) => line.startsWith('  try 3')), '  try 3  pool-b · model-a · 1m00s · 3 files · moved after a usage limit');
  // The marker is read from the run directory when no features are given.
  const runDir = mkdtempSync(join(tmpdir(), 'bs-needs-you-'));
  try {
    writeFileSync(join(runDir, 'features.json'), JSON.stringify(MARKED));
    assert.equal(needsYouFacts(marked, event, { runDir }).retries, 1);
  } finally { rmSync(runDir, { recursive: true, force: true }); }
  // Superseded attempts are not the current definition's.
  const rerun = designState();
  rerun.actions[0].supersededAttempts = 1;
  assert.deepEqual(needsYouFacts(rerun, failedEvent('variants', { failureKind: 'failed-evidence' }), { features: MARKED }).attempts.map((entry) => entry.id), ['variants-2']);
});

test('a different-pool attempt with a handoff says so', () => {
  const state = designState();
  Object.assign(state.attempts[1], { pool: 'pool-b', retryOf: { attempt: 'variants-1', how: 'other-pool' } });
  const lines = renderNeedsYou(needsYouFacts(state, failedEvent('variants', { failureKind: 'failed-evidence', retries: 1 }), { features: MARKED }));
  assert.equal(lines.find((line) => line.startsWith('  try 2')), '  try 2  pool-b · model-a · 7m00s · 3 files · handoff attached');
});

test('an act step reads `not retried: act step (it may have acted)` in a marked run', () => {
  const state = designState();
  state.program.actions[0] = step('variants', { role: 'act', deliverable: 'outward', lane: 'analyze' });
  state.attempts = [attempt('variants', 1, { start: 0, minutes: 2, failureKind: 'semantic' })];
  const facts = needsYouFacts(state, failedEvent('variants', { failureKind: 'semantic', why: 'the post was rejected', retries: 0 }), { features: MARKED });
  const lines = renderNeedsYou(facts);
  assert.equal(lines[0], '✗ variants needs you · output check failed · not retried: act step (it may have acted)');
  assert.ok(lines.some((line) => line.startsWith('    rerun elsewhere')), 'the caller still decides');
  assert.equal(needsYouJson(facts).notRetried, 'act');
  // A saved run retries act steps like any step: no act header.
  assert.equal(renderNeedsYou(needsYouFacts(state, failedEvent('variants', { failureKind: 'semantic', why: 'x' }), { features: {} }))[0], '✗ variants needs you · output check failed · not retried');
});

// The review variant: verify.round finished with the caller.
function reviewState({ max = 2, repaired = true } = {}) {
  const state = designState();
  state.program.actions = [
    step('build', { affects: ['requirement-1'] }),
    step('check', { dependsOn: ['build'], evidenceFor: ['requirement-1', 'requirement-2'], lane: 'analyze' }),
    ...(repaired ? [step('repair-1', { dependsOn: ['check'] }), step('verify-round-2', { dependsOn: ['repair-1'], evidenceFor: ['requirement-1'], lane: 'analyze' })] : []),
    step('publish', { dependsOn: [repaired ? 'verify-round-2' : 'check'] }),
  ];
  state.actions = state.program.actions.map((action) => ({ id: action.id, status: action.id === 'publish' ? 'pending' : 'succeeded' }));
  const judge = repaired ? 'verify-round-2' : 'check';
  state.attempts = [
    attempt('check', 1, { start: 0, minutes: 5, status: 'succeeded', pool: 'pool-b', model: 'model-b', changedFileCount: 0 }),
    ...(repaired ? [
      attempt('repair-1', 1, { start: 6, minutes: 9, status: 'succeeded', changedFileCount: 2 }),
      attempt('verify-round-2', 1, { start: 16, minutes: 4, status: 'succeeded', pool: 'pool-b', model: 'model-b', changedFileCount: 0 }),
    ] : []),
  ];
  state.verifyLoop = {
    max, stoppedBy: null,
    rounds: [
      { round: 1, verifyActionIds: ['check'], failed: ['requirement-1'], repairActionId: repaired ? 'repair-1' : null },
      ...(repaired ? [{ round: 2, verifyActionIds: ['verify-round-2'], failed: ['requirement-1'], repairActionId: null }] : []),
    ],
  };
  state.ledger = {
    requirements: {
      'requirement-1': {
        status: 'failed',
        evidence: [{ sourceAction: judge, requirementId: 'requirement-1', status: 'failed', stale: false, evidence: ['total row still reads 0 on an empty week', 'second line'], concerns: [] }],
      },
    },
  };
  return state;
}

test('the review variant names the failing requirement, its reviewer, and the fix', () => {
  const state = reviewState();
  const event = { type: 'workflow.verify-round', sequence: 300, committedAt: at(21), payload: { round: 2, of: 2, stage: 'finished', passed: [], failed: ['requirement-1'], next: 'caller' } };
  assert.deepEqual(renderNeedsYou(needsYouFacts(state, event, { features: MARKED })), [
    '✗ verify-round-2 needs you · review failed after 1 fix',
    '  review    requirement-1 failed · verify-round-2 on pool-b · model-b',
    '            total row still reads 0 on an empty week',
    '  fix       repair-1 · pool-a · model-a · 9m00s · 2 files',
    '  waiting on this: publish',
    '  your call:',
    '    rerun elsewhere  bullswarm workflow step rerun acme01 verify-round-2 --avoid pool-b',
    '    change the step  bullswarm workflow plan export acme01 --out plan.json',
    '      then edit it   bullswarm workflow plan revise acme01 --program plan.json',
    '    take over        output: /runs/acme/out-verify-round-2-attempt-1.md',
    '    accept anyway    bullswarm workflow step accept acme01 verify-round-2 --reason "…"',
  ]);
  // The watcher turns it into one needs-you notable, whatever the round count.
  const { notable } = notableWatchEvents({ events: [event], state });
  assert.deepEqual(notable.map((entry) => entry.type), ['needs-you']);
  assert.equal(watchTrouble(notable[0]), 'failed');
  // Not the caller's yet: no block.
  assert.equal(needsYouFacts(state, { ...event, payload: { ...event.payload, next: 'repair' } }, { features: MARKED }), null);
});

test('with verifyRounds 0 the review header says there was no automatic fix', () => {
  const state = reviewState({ max: 1, repaired: false });
  const event = { type: 'workflow.verify-round', committedAt: at(6), payload: { round: 1, of: 1, stage: 'finished', passed: ['requirement-2'], failed: ['requirement-1'], next: 'caller' } };
  const lines = renderNeedsYou(needsYouFacts(state, event, { features: MARKED }));
  assert.equal(lines[0], '✗ check needs you · review failed · no automatic fix (verifyRounds 0)');
  assert.equal(lines.some((line) => line.startsWith('  fix ')), false);
  // A one-round loop still wakes the caller through the block.
  assert.deepEqual(notableWatchEvents({ events: [event], state }).notable.map((entry) => entry.type), ['needs-you']);
  // A saved run's one-round loop has no verifyRounds 0.
  assert.equal(renderNeedsYou(needsYouFacts(state, event, { features: {} }))[0], '✗ check needs you · review failed · no automatic fix');
});

test('a verified (non-program) run keeps the plain failed line', () => {
  const state = designState();
  state.config.settings.executionMode = 'verified';
  const { notable } = notableWatchEvents({ events: [failedEvent('variants', { failureKind: 'process', why: 'exit 1' })], state });
  assert.equal(notable[0].type, 'action.finished');
});

// F19 / L3: a gate retry is pinned to its pool, so its own candidate list
// names only that pool; the first attempt's list still names the others.
test('rerun elsewhere is decided over every current attempt: a pinned gate retry still offers the other pool', () => {
  const state = designState();
  state.attempts[1].routeCandidates = [{ pool: 'pool-a' }];
  const lines = renderNeedsYou(needsYouFacts(state, failedEvent('variants', { failureKind: 'failed-evidence', retries: 1 }), { features: MARKED }));
  assert.equal(lines.find((line) => line.startsWith('    rerun elsewhere')), '    rerun elsewhere  bullswarm workflow step rerun acme01 variants --avoid pool-a');
  assert.equal(lines.some((line) => line.includes('retry here')), false);
  // A process retry on the other pool: its list leaves out the pool it tried.
  const moved = designState();
  moved.attempts[0].routeCandidates = [{ pool: 'pool-b' }, { pool: 'pool-a' }];
  moved.attempts[0].pool = 'pool-b';
  Object.assign(moved.attempts[1], { routeCandidates: [{ pool: 'pool-a' }], retryOf: { attempt: 'variants-1', how: 'other-pool' } });
  assert.equal(needsYouFacts(moved, failedEvent('variants', { failureKind: 'process', why: 'x', retries: 1 }), { features: MARKED }).options.rerunElsewhere,
    'bullswarm workflow step rerun acme01 variants --avoid pool-a');
  // Superseded attempts (an earlier definition) do not count.
  const rerun = designState();
  rerun.attempts[1].routeCandidates = [{ pool: 'pool-a' }];
  rerun.actions[0].supersededAttempts = 1;
  assert.equal(needsYouFacts(rerun, failedEvent('variants', { failureKind: 'failed-evidence' }), { features: MARKED }).options.retryHere,
    'bullswarm workflow step rerun acme01 variants');
});

// F26: every printed command runs as printed; no `→` joins two commands.
test('the change-the-step option prints two whole commands', () => {
  const lines = renderNeedsYou(needsYouFacts(designState(), failedEvent('variants', { failureKind: 'failed-evidence', retries: 1 }), { features: MARKED }));
  const commands = lines.filter((line) => line.includes('bullswarm ')).map((line) => line.slice(line.indexOf('bullswarm ')));
  assert.equal(commands.some((command) => command.includes('→')), false);
  assert.ok(commands.includes('bullswarm workflow plan export acme01 --out plan.json'));
  assert.ok(commands.includes('bullswarm workflow plan revise acme01 --program plan.json'));
});

// F20: the round's last check may have passed its own requirement; the block
// names the check that judged the failing one.
test('the review variant names the check that judged the failing requirement, not the round\'s last check', () => {
  const state = reviewState({ max: 1, repaired: false });
  state.program.actions.splice(2, 0, step('check-b', { dependsOn: ['build'], evidenceFor: ['requirement-2'], lane: 'analyze' }));
  state.actions.push({ id: 'check-b', status: 'succeeded' });
  state.attempts.push(attempt('check-b', 1, { start: 0, minutes: 3, status: 'succeeded', pool: 'pool-a', model: 'model-a', changedFileCount: 0 }));
  state.verifyLoop.rounds[0].verifyActionIds = ['check', 'check-b'];
  const event = { type: 'workflow.verify-round', committedAt: at(6), payload: { round: 1, of: 1, stage: 'finished', passed: ['requirement-2'], failed: ['requirement-1'], next: 'caller' } };
  const facts = needsYouFacts(state, event, { features: MARKED });
  const lines = renderNeedsYou(facts);
  assert.equal(lines[0], '✗ check needs you · review failed · no automatic fix (verifyRounds 0)');
  assert.equal(facts.options.rerunElsewhere, 'bullswarm workflow step rerun acme01 check --avoid pool-b');
  assert.equal(facts.options.acceptAnyway, 'bullswarm workflow step accept acme01 check --reason "…"');
  assert.equal(facts.options.takeOver, 'output: /runs/acme/out-check-attempt-1.md');
  assert.equal(lines.some((line) => line.includes('check-b')), false);
  // Two checks each failing one: the second gets its own rerun and accept lines.
  state.ledger.requirements['requirement-2'] = {
    status: 'failed',
    evidence: [{ sourceAction: 'check-b', requirementId: 'requirement-2', status: 'failed', stale: false, evidence: ['no empty-week test'], concerns: [] }],
  };
  const both = needsYouFacts(state, { ...event, payload: { ...event.payload, passed: [], failed: ['requirement-1', 'requirement-2'] } }, { features: MARKED });
  const bothLines = renderNeedsYou(both);
  assert.equal(bothLines[0], '✗ check needs you · review failed · no automatic fix (verifyRounds 0)');
  const at2 = bothLines.indexOf('    also judged by check-b:');
  assert.ok(at2 > 0);
  assert.deepEqual(bothLines.slice(at2 + 1, at2 + 3), [
    '    rerun elsewhere  bullswarm workflow step rerun acme01 check-b --avoid pool-a',
    '    accept anyway    bullswarm workflow step accept acme01 check-b --reason "…"',
  ]);
  assert.deepEqual(needsYouJson(both).options.otherChecks, [{
    step: 'check-b', rerunElsewhere: 'bullswarm workflow step rerun acme01 check-b --avoid pool-a',
    acceptAnyway: 'bullswarm workflow step accept acme01 check-b --reason "…"',
  }]);
});

// F28: a failed action.finished from a kernel that named no attempts, replayed
// after the step was rerun, shows the tries of the definition that failed.
test('replaying an old failed finish after a rerun shows the tries that failed then', () => {
  const state = designState();
  state.attempts[1].pool = 'pool-b';
  delete state.attempts[1].retryOf;
  state.actions[0].supersededAttempts = 2;
  state.attempts.push(
    attempt('variants', 3, { start: 30, minutes: 2, failureKind: 'process' }),
    attempt('variants', 4, { start: 33, minutes: 2, failureKind: 'process' }),
  );
  const facts = needsYouFacts(state, failedEvent('variants', { failureKind: 'failed-evidence' }), { features: {} });
  assert.deepEqual(facts.attempts.map((entry) => [entry.id, entry.pool]), [['variants-1', 'pool-a'], ['variants-2', 'pool-b']]);
});

// F29: a dependent a plan revision removed waits on nothing.
test('a removed dependent is not listed in waiting on this', () => {
  const state = designState();
  state.actions.find((entry) => entry.id === 'ship').status = 'removed';
  const facts = needsYouFacts(state, failedEvent('variants', { failureKind: 'failed-evidence', retries: 1 }), { features: MARKED });
  assert.deepEqual(facts.waitingOnThis, ['pick']);
});

// F30: the JSONL attempt keeps the handoff a same-pool retry carries; the try
// line still leaves it out.
test('a same-pool retry keeps handoff: true in JSONL but not on its try line', () => {
  const facts = needsYouFacts(designState(), failedEvent('variants', { failureKind: 'failed-evidence', retries: 1 }), { features: MARKED });
  assert.equal(needsYouJson(facts).attempts[1].handoff, true);
  assert.equal(renderNeedsYou(facts).find((line) => line.startsWith('  try 2')), '  try 2  same pool, failure attached · 7m00s · 3 files');
  // A handoff to the same pool without a retryOf fact is not printed either.
  const state = designState();
  delete state.attempts[1].retryOf;
  const lines = renderNeedsYou(needsYouFacts(state, failedEvent('variants', { failureKind: 'failed-evidence', retries: 1 }), { features: MARKED }));
  assert.equal(lines.find((line) => line.startsWith('  try 2')), '  try 2  pool-a · model-a · 7m00s · 3 files');
});

// The owner's rule (2026-09-25): a usage limit, or no free pool when the step
// is picked, ends the step and hands it to the caller. In a marked run, when
// the return is known the block says when and offers a rerun after it;
// Bullswarm itself never waits for it. Unmarked runs print no return time.
const BACK = '2026-09-24T06:00:00.000Z';
const LATER = '2026-09-24T07:30:00.000Z';

function limitState(kind, lastFailure = {}) {
  const state = designState();
  state.program.actions[0] = step('variants');
  state.actions[0].lastFailure = { kind, message: 'x', ...lastFailure };
  state.attempts = [attempt('variants', 1, { start: 0, minutes: 2, failureKind: kind, changedFileCount: 0 })];
  return state;
}

// A run directory holding only the marker, for the watcher to read.
function markedRunDir(t) {
  const runDir = mkdtempSync(join(tmpdir(), 'bs-needs-you-'));
  t.after(() => rmSync(runDir, { recursive: true, force: true }));
  writeFileSync(join(runDir, 'features.json'), JSON.stringify(MARKED));
  return runDir;
}

function assertNoBackAt(facts, label) {
  assert.equal(facts.backAt, undefined, label);
  assert.equal(facts.options.waitForIt, undefined, label);
  assert.equal(Object.hasOwn(needsYouJson(facts), 'backAt'), false, label);
  assert.equal(Object.hasOwn(needsYouJson(facts).options, 'waitForIt'), false, label);
  const lines = renderNeedsYou(facts);
  assert.equal(lines.some((line) => line.startsWith('  back at')), false, label);
  assert.equal(lines.some((line) => line.includes('wait for it')), false, label);
}

test('a usage limit with a known reset prints `back at` and a wait-for-it option; the JSONL carries backAt', (t) => {
  const state = limitState('quota');
  const event = failedEvent('variants', { failureKind: 'quota', why: 'usage limit reached on pool-a', retryAfter: BACK, retries: 0 });
  const facts = needsYouFacts(state, event, { features: MARKED });
  assert.equal(facts.backAt, BACK);
  assert.equal(facts.options.waitForIt, `after ${BACK}: bullswarm workflow step rerun acme01 variants`);
  assert.deepEqual(renderNeedsYou(facts), [
    '✗ variants needs you · out of quota · not retried',
    '  why       usage limit reached on pool-a',
    `  back at   ${BACK}`,
    '  try 1  pool-a · model-a · 2m00s · 0 files',
    '  still running: copy · waiting on this: pick, ship',
    '  your call:',
    '    rerun elsewhere  bullswarm workflow step rerun acme01 variants --avoid pool-a',
    `    wait for it      after ${BACK}: bullswarm workflow step rerun acme01 variants`,
    '    change the step  bullswarm workflow plan export acme01 --out plan.json',
    '      then edit it   bullswarm workflow plan revise acme01 --program plan.json',
    '    take over        output: /runs/acme/out-variants-attempt-1.md',
    '    accept anyway    bullswarm workflow step accept acme01 variants --reason "…"',
  ]);
  assert.deepEqual(needsYouJson(facts), {
    actionId: 'variants', label: 'out of quota', failureKind: 'quota', retries: 0,
    evidence: [], why: 'usage limit reached on pool-a', backAt: BACK,
    attempts: [{ id: 'variants-1', pool: 'pool-a', model: 'model-a', durationSec: 120, files: 0 }],
    stillRunning: ['copy'], waitingOnThis: ['pick', 'ship'],
    options: {
      rerunElsewhere: 'bullswarm workflow step rerun acme01 variants --avoid pool-a',
      changeStep: 'bullswarm workflow plan export acme01 --out plan.json, edit it, then bullswarm workflow plan revise acme01 --program plan.json',
      takeOver: 'output: /runs/acme/out-variants-attempt-1.md',
      acceptAnyway: 'bullswarm workflow step accept acme01 variants --reason "…"',
      waitForIt: `after ${BACK}: bullswarm workflow step rerun acme01 variants`,
    },
  });
  // Terminal mode keeps the fact and leaves out the option with the rest of your call.
  const terminal = renderNeedsYou(facts, { terminal: true });
  assert.ok(terminal.includes(`  back at   ${BACK}`));
  assert.equal(terminal.some((line) => line.includes('wait for it')), false);
  // Through the watcher, with the marker read from the run directory: backAt
  // sits after why in the JSONL record.
  const { notable } = notableWatchEvents({ events: [event], state, runDir: markedRunDir(t) });
  assert.equal(notable.length, 1);
  assert.equal(watchTrouble(notable[0]), 'failed');
  const record = JSON.parse(JSON.stringify({ type: notable[0].type, sequence: 212, ...notable[0] }));
  assert.deepEqual(Object.keys(record), ['type', 'sequence', 'actionId', 'label', 'failureKind', 'retries', 'evidence', 'why', 'backAt', 'attempts', 'stillRunning', 'waitingOnThis', 'options']);
  assert.equal(record.backAt, BACK);
  assert.ok(renderWatchEvent(notable[0]).split('\n').includes(`  back at   ${BACK}`));
  // The watcher of a run without the marker: no backAt key, line or option.
  const [plain] = notableWatchEvents({ events: [event], state }).notable;
  assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(plain))), ['type', 'actionId', 'label', 'failureKind', 'retries', 'evidence', 'why', 'attempts', 'stillRunning', 'waitingOnThis', 'options']);
  assert.equal(renderWatchEvent(plain).split('\n').some((line) => /back at|wait for it/.test(line)), false);
});

test('no free pool when the step was picked prints `back at` the earliest return and a wait-for-it option', () => {
  const state = limitState('unavailable');
  state.attempts = [];
  const why = `no pool free: pool-a nearly spent (forecast 97.0%) until ${BACK}; pool-b benched until ${LATER}`;
  const facts = needsYouFacts(state, failedEvent('variants', { failureKind: 'unavailable', why, retryAfter: BACK, retries: 0 }), { features: MARKED });
  assert.equal(facts.backAt, BACK);
  assert.deepEqual(renderNeedsYou(facts), [
    '✗ variants needs you · no eligible pool · not retried',
    `  why       ${why}`,
    `  back at   ${BACK}`,
    '  still running: copy · waiting on this: pick, ship',
    '  your call:',
    '    retry here       bullswarm workflow step rerun acme01 variants',
    `    wait for it      after ${BACK}: bullswarm workflow step rerun acme01 variants`,
    '    change the step  bullswarm workflow plan export acme01 --out plan.json',
    '      then edit it   bullswarm workflow plan revise acme01 --program plan.json',
    '    take over        output: none recorded',
    '    accept anyway    bullswarm workflow step accept acme01 variants --reason "…"',
  ]);
  const json = needsYouJson(facts);
  assert.equal(json.backAt, BACK);
  assert.equal(json.options.waitForIt, `after ${BACK}: bullswarm workflow step rerun acme01 variants`);
  assert.deepEqual(json.attempts, []);
});

test('backAt falls back to the step\'s last failure when the event names no retryAfter', () => {
  const state = limitState('quota', { retryAfter: BACK });
  const facts = needsYouFacts(state, failedEvent('variants', { failureKind: 'quota', why: 'x', retries: 0 }), { features: MARKED });
  assert.equal(facts.backAt, BACK);
  assert.equal(needsYouJson(facts).backAt, BACK);
  assert.ok(renderNeedsYou(facts).includes(`  back at   ${BACK}`));
  assert.equal(facts.options.waitForIt, `after ${BACK}: bullswarm workflow step rerun acme01 variants`);
  // The kind comes from the last failure too when the event has none.
  assert.equal(needsYouFacts(state, failedEvent('variants', { why: 'x', retries: 0 }), { features: MARKED }).backAt, BACK);
  // A saved no-free-pool failure falls back the same way.
  const unavailable = limitState('unavailable', { retryAfter: LATER });
  assert.equal(needsYouFacts(unavailable, failedEvent('variants', { failureKind: 'unavailable', why: 'x', retries: 0 }), { features: MARKED }).backAt, LATER);
  // The event's own retryAfter wins over the saved one.
  assert.equal(needsYouFacts(state, failedEvent('variants', { failureKind: 'quota', why: 'x', retryAfter: LATER, retries: 0 }), { features: MARKED }).backAt, LATER);
});

// A replay reads the state as it is now: after a rerun, the step's saved
// failure is the later one, and its return is not the older block's.
test('replaying an older failure after a rerun that hit a usage limit prints no back at', () => {
  const state = limitState('quota', { retryAfter: BACK });
  state.actions[0].supersededAttempts = 1;
  state.attempts = [
    attempt('variants', 1, { start: 0, minutes: 2, failureKind: 'process', changedFileCount: 0 }),
    attempt('variants', 2, { start: 10, minutes: 2, failureKind: 'quota', changedFileCount: 0 }),
  ];
  const crash = { ...failedEvent('variants', { failureKind: 'process', why: 'worker exited', attemptIds: ['variants-1'], retries: 0 }), committedAt: at(2) };
  const older = needsYouFacts(state, crash, { features: MARKED });
  assert.deepEqual(older.attempts.map((entry) => entry.id), ['variants-1']);
  assertNoBackAt(older, 'the older crash');
  // The later failure's own event still falls back to the saved return.
  const limit = { ...failedEvent('variants', { failureKind: 'quota', why: 'usage limit', attemptIds: ['variants-2'], retries: 0 }), committedAt: at(12) };
  assert.equal(needsYouFacts(state, limit, { features: MARKED }).backAt, BACK);
});

// In a marked run the dispatcher names a retryAfter only when a return time
// is the real next step, so any kind that carries one prints it.
test('in a marked run any kind with a parseable retryAfter prints `back at` and a wait-for-it option', () => {
  const hasBack = (facts, returnAt, label) => {
    assert.equal(facts.backAt, returnAt, label);
    assert.equal(facts.options.waitForIt, `after ${returnAt}: bullswarm workflow step rerun acme01 variants`, label);
    assert.equal(needsYouJson(facts).backAt, returnAt, label);
    assert.equal(needsYouJson(facts).options.waitForIt, facts.options.waitForIt, label);
    const lines = renderNeedsYou(facts);
    assert.ok(lines.includes(`  back at   ${returnAt}`), label);
    assert.ok(lines.includes(`    wait for it      ${facts.options.waitForIt}`), label);
  };
  for (const kind of ['process', 'auth', 'throttle', 'provider']) {
    const state = limitState(kind, { retryAfter: BACK });
    hasBack(needsYouFacts(state, failedEvent('variants', { failureKind: kind, why: 'x', retryAfter: BACK, retries: 0 }), { features: MARKED }), BACK, kind);
    // From the step's last failure when the event names none.
    hasBack(needsYouFacts(state, failedEvent('variants', { failureKind: kind, why: 'x', retries: 0 }), { features: MARKED }), BACK, `${kind}, saved`);
  }
  // A rate limit whose provider named a wait too long to sleep through.
  const throttled = limitState('throttle');
  const why = 'rate limit: "Rate limit exceeded, retry after 30 minutes"';
  const facts = needsYouFacts(throttled, failedEvent('variants', { failureKind: 'throttle', why, retryAfter: LATER, retries: 0 }), { features: MARKED });
  assert.deepEqual(renderNeedsYou(facts).slice(0, 4), [
    '✗ variants needs you · rate limited · not retried',
    `  why       ${why}`,
    `  back at   ${LATER}`,
    '  try 1  pool-a · model-a · 2m00s · 0 files',
  ]);
  hasBack(facts, LATER, 'throttle, named wait');
  // Failed evidence, with a retryAfter on the event and on the saved failure.
  const evidence = designState();
  evidence.actions[0].lastFailure.retryAfter = BACK;
  hasBack(needsYouFacts(evidence, failedEvent('variants', { failureKind: 'failed-evidence', retryAfter: BACK, retries: 1 }), { features: MARKED }), BACK, 'failed-evidence');
});

test('a marked run prints no back at and no wait-for-it for an unknown return or an unparseable one', () => {
  for (const kind of ['quota', 'unavailable', 'throttle', 'process']) {
    assertNoBackAt(needsYouFacts(limitState(kind), failedEvent('variants', { failureKind: kind, why: 'x', retries: 0 }), { features: MARKED }), `${kind}, no return`);
  }
  assertNoBackAt(needsYouFacts(limitState('unavailable'), failedEvent('variants', { failureKind: 'unavailable', why: 'x', retryAfter: null, retries: 0 }), { features: MARKED }), 'unavailable, null');
  assertNoBackAt(needsYouFacts(limitState('quota'), failedEvent('variants', { failureKind: 'quota', why: 'x', retryAfter: 'soon', retries: 0 }), { features: MARKED }), 'quota, soon');
  assertNoBackAt(needsYouFacts(limitState('unavailable', { retryAfter: 'not a time' }), failedEvent('variants', { failureKind: 'unavailable', why: 'x', retries: 0 }), { features: MARKED }), 'unavailable, saved');
  assertNoBackAt(needsYouFacts(limitState('throttle', { retryAfter: 'later' }), failedEvent('variants', { failureKind: 'throttle', why: 'x', retries: 0 }), { features: MARKED }), 'throttle, saved');
});

// Unmarked (released) runs print the block as before: no return time, whatever
// the event or the saved failure carries.
test('an unmarked run never prints back at, a wait-for-it option or a backAt key, for any kind', () => {
  const unmarked = [{}, { deliverableGate: 1, proofLabels: 1 }, { ...MARKED, failureRule: 0 }];
  for (const features of unmarked) {
    for (const kind of ['quota', 'unavailable', 'process', 'auth', 'throttle', 'provider']) {
      const label = `${kind} ${JSON.stringify(features)}`;
      const state = limitState(kind, { retryAfter: BACK });
      assertNoBackAt(needsYouFacts(state, failedEvent('variants', { failureKind: kind, why: 'x', retryAfter: BACK, retries: 0 }), { features }), label);
      assertNoBackAt(needsYouFacts(state, failedEvent('variants', { failureKind: kind, why: 'x', retries: 0 }), { features }), `${label}, saved`);
    }
    const evidence = designState();
    evidence.actions[0].lastFailure.retryAfter = BACK;
    assertNoBackAt(needsYouFacts(evidence, failedEvent('variants', { failureKind: 'failed-evidence', retryAfter: BACK, retries: 1 }), { features }), `failed-evidence ${JSON.stringify(features)}`);
  }
  // The JSONL keys are the ones before the marker existed.
  const quota = needsYouFacts(limitState('quota'), failedEvent('variants', { failureKind: 'quota', why: 'x', retryAfter: BACK, retries: 0 }), { features: {} });
  assert.deepEqual(Object.keys(needsYouJson(quota)), ['actionId', 'label', 'failureKind', 'retries', 'evidence', 'why', 'attempts', 'stillRunning', 'waitingOnThis', 'options']);
  assert.deepEqual(Object.keys(needsYouJson(quota).options), ['rerunElsewhere', 'changeStep', 'takeOver', 'acceptAnyway']);
});

// A transient rate limit's backoff replays the step on the pool that just
// failed (retryOf 'wait'); a saved stage-3 run's wait could move it to
// another pool after a usage limit.
test('a same-pool wait reads `after a rate-limit backoff`; a wait that changed pools reads `moved after a usage limit`', () => {
  const state = limitState('throttle');
  const candidates = [{ pool: 'luna-1' }, { pool: 'luna-2' }];
  const tryOn = (ordinal, pool, extra = {}) => attempt('variants', ordinal, {
    start: (ordinal - 1) * 2, minutes: 1, failureKind: 'throttle', pool, changedFileCount: 0, routeCandidates: candidates, ...extra,
  });
  const wait = (ordinal) => ({ retryOf: { attempt: `variants-${ordinal - 1}`, how: 'wait' } });
  state.attempts = [tryOn(1, 'luna-1'), tryOn(2, 'luna-1', wait(2)), tryOn(3, 'luna-1', wait(3))];
  const event = failedEvent('variants', { failureKind: 'throttle', why: 'rate limit: too many requests', attemptIds: ['variants-1', 'variants-2', 'variants-3'], retries: 0 });
  const facts = needsYouFacts(state, event, { features: MARKED });
  const tries = (lines) => lines.filter((line) => line.startsWith('  try '));
  assert.deepEqual(tries(renderNeedsYou(facts)), [
    '  try 1  luna-1 · model-a · 1m00s · 0 files',
    '  try 2  luna-1 · model-a · 1m00s · 0 files · after a rate-limit backoff',
    '  try 3  luna-1 · model-a · 1m00s · 0 files · after a rate-limit backoff',
  ]);
  assert.deepEqual(needsYouJson(facts).attempts.map((entry) => entry.retryOf ?? null), [null, 'wait', 'wait']);
  assert.equal(facts.retries, 0, 'a backoff is not a retry');
  // Saved stage-3 run: the wait moved the step to another pool.
  const saved = limitState('quota');
  saved.attempts = [tryOn(1, 'luna-1', { failureKind: 'quota' }), tryOn(2, 'luna-2', { failureKind: 'quota', ...wait(2) })];
  assert.deepEqual(tries(renderNeedsYou(needsYouFacts(saved, failedEvent('variants', { failureKind: 'quota', why: 'x', attemptIds: ['variants-1', 'variants-2'] }), { features: MARKED }))), [
    '  try 1  luna-1 · model-a · 1m00s · 0 files',
    '  try 2  luna-2 · model-a · 1m00s · 0 files · moved after a usage limit',
  ]);
  // Both in one step: a backoff on luna-1, then a move to luna-2.
  state.attempts = [tryOn(1, 'luna-1'), tryOn(2, 'luna-1', wait(2)), tryOn(3, 'luna-2', wait(3))];
  assert.deepEqual(tries(renderNeedsYou(needsYouFacts(state, event, { features: MARKED }))).map((line) => line.slice(line.indexOf('0 files'))), [
    '0 files', '0 files · after a rate-limit backoff', '0 files · moved after a usage limit',
  ]);
});

// A backoff is not a retry, but the step did run again: the header counts the
// backoffs its try lines show instead of reading `not retried`.
test('a step that backed off reads `backed off once` or `backed off twice`, never `not retried`; the JSONL carries backoffs', () => {
  const state = limitState('throttle');
  const candidates = [{ pool: 'luna-1' }, { pool: 'luna-2' }];
  const tryOn = (ordinal, pool, extra = {}) => attempt('variants', ordinal, {
    start: (ordinal - 1) * 2, minutes: 1, failureKind: 'throttle', pool, changedFileCount: 0, routeCandidates: candidates, ...extra,
  });
  const after = (ordinal, how) => ({ retryOf: { attempt: `variants-${ordinal - 1}`, how } });
  const event = (count, extra = {}) => failedEvent('variants', {
    failureKind: 'throttle', why: 'rate limit: too many requests',
    attemptIds: Array.from({ length: count }, (_, index) => `variants-${index + 1}`), ...extra,
  });
  const head = (facts) => renderNeedsYou(facts)[0];
  state.attempts = [tryOn(1, 'luna-1'), tryOn(2, 'luna-1', after(2, 'wait')), tryOn(3, 'luna-1', after(3, 'wait'))];
  const twice = needsYouFacts(state, event(3, { retries: 0 }), { features: MARKED });
  assert.equal(head(twice), '✗ variants needs you · rate limited · backed off twice');
  assert.equal(needsYouJson(twice).backoffs, 2);
  assert.equal(Object.hasOwn(needsYouJson(twice), 'notRetried'), false);
  // Without the kernel's retries count the facts give the same header.
  assert.equal(head(needsYouFacts(state, event(3), { features: MARKED })), '✗ variants needs you · rate limited · backed off twice');
  state.attempts = [tryOn(1, 'luna-1'), tryOn(2, 'luna-1', after(2, 'wait'))];
  assert.equal(head(needsYouFacts(state, event(2, { retries: 0 }), { features: MARKED })), '✗ variants needs you · rate limited · backed off once');
  // A step that also retried says both.
  state.attempts = [
    tryOn(1, 'luna-2', { failureKind: 'process' }), tryOn(2, 'luna-1', after(2, 'other-pool')), tryOn(3, 'luna-1', after(3, 'wait')),
  ];
  const both = needsYouFacts(state, event(3), { features: MARKED });
  assert.equal(head(both), '✗ variants needs you · rate limited after 1 retry · backed off once');
  assert.equal(needsYouJson(both).backoffs, 1);
  // A saved stage-3 run's move after a usage limit is not a backoff.
  state.attempts = [tryOn(1, 'luna-1', { failureKind: 'quota' }), tryOn(2, 'luna-2', { failureKind: 'quota', ...after(2, 'wait') })];
  const moved = needsYouFacts(state, failedEvent('variants', { failureKind: 'quota', why: 'x', attemptIds: ['variants-1', 'variants-2'], retries: 0 }), { features: MARKED });
  assert.equal(head(moved), '✗ variants needs you · out of quota · not retried');
  assert.equal(Object.hasOwn(needsYouJson(moved), 'backoffs'), false);
  // No backoff: the header and the JSONL keys are unchanged.
  state.attempts = [tryOn(1, 'luna-1')];
  const once = needsYouFacts(state, event(1, { retries: 0 }), { features: MARKED });
  assert.equal(head(once), '✗ variants needs you · rate limited · not retried');
  assert.equal(Object.hasOwn(needsYouJson(once), 'backoffs'), false);
});
