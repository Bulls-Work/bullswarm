// The needs-you block (stage-3 §2.5, D25, D26): what the watcher prints when a
// program step comes back to the caller. The states here are small hand-built
// program runs with made-up pools (pool-a, pool-b) and paths.

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
    '    change the step  bullswarm workflow plan export acme01 --out plan.json → plan revise acme01 --program plan.json',
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
      { id: 'variants-2', pool: 'pool-a', model: 'model-a', durationSec: 420, files: 3, retryOf: 'same-pool' },
    ],
    stillRunning: ['copy'], waitingOnThis: ['pick', 'ship'],
    options: {
      rerunElsewhere: 'bullswarm workflow step rerun acme01 variants --avoid pool-a',
      changeStep: 'bullswarm workflow plan export acme01 --out plan.json → plan revise acme01 --program plan.json',
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
    '    change the step  bullswarm workflow plan export acme01 --out plan.json → plan revise acme01 --program plan.json',
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
