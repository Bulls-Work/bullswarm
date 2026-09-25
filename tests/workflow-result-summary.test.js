import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  deserializeV2ResultEnvelope, formatV2HandbackLines, formatV2ProofLine, summarizeV2Result, validateV2ResultEnvelope,
} from '../src/workflow/v2-outcome.js';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const BIN = join(ROOT, 'bin', 'bullswarm.js');
const fixture = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'real-result-ze5xz2.json'), 'utf8'));

function cli(home, args) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: ROOT,
    env: { ...process.env, BULLSWARM_HOME: home },
    encoding: 'utf8',
  });
}

test('summary is a compact schema-checked status envelope', () => {
  validateV2ResultEnvelope(fixture);
  const summary = summarizeV2Result(fixture);
  const compact = JSON.stringify(summary);
  const fullBytes = Buffer.byteLength(JSON.stringify(fixture), 'utf8');
  const summaryBytes = Buffer.byteLength(compact, 'utf8');
  const prettyFullBytes = Buffer.byteLength(`${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
  console.log(`result-summary size: full=${fullBytes} summary=${summaryBytes}`);
  console.log(`result-summary cli: prettyFull=${prettyFullBytes}`);
  assert.equal(compact.includes('\n'), false, 'summariser compact serialisation is one line');
  assert.ok(summaryBytes < 4096, `summary ${summaryBytes} bytes must stay below 4096; full envelope is ${fullBytes} bytes`);
  assert.ok(fullBytes > 50_000, `full envelope is only ${fullBytes} bytes`);
  assert.deepEqual(Object.keys(summary).sort(), [
    'actions', 'concerns', 'executionMode', 'finishedAt', 'goal', 'goalBytes',
    'next', 'reason', 'requirements', 'runId', 'schemaVersion', 'shortId',
    'status', 'usage', 'verified',
  ].sort());
  assert.equal(summary.schemaVersion, 'bullswarm.workflow.result-summary.v1');
  assert.equal(summary.goal, fixture.goal.split(/\r?\n/, 1)[0].trim().slice(0, 120));
  assert.equal(summary.goalBytes, Buffer.byteLength(fixture.goal, 'utf8'));
  assert.equal(summary.requirements[0].evidenceCount, 1);
  const whySource = fixture.requirements[0].evidence.at(-1).evidence[0].split(/\r?\n/, 1)[0].trim();
  assert.ok(summary.requirements[0].why === null || whySource.startsWith(summary.requirements[0].why));
  assert.ok((summary.requirements[0].why ?? '').length <= 200);
  assert.equal(summary.concerns.count, fixture.requirements.flatMap((requirement) => requirement.evidence.flatMap((entry) => entry.concerns ?? [])).length);
  assert.ok(summary.concerns.first.length <= 3);
  assert.equal(summary.next.full, `bullswarm workflow runs result ${fixture.shortId} --json`);
  assert.deepEqual(summary.next.outputs, fixture.actions.map((action) => action.outputFile.split('/').at(-1)), 'outputs are basenames');
  assert.equal(summary.next.runDir, fixture.actions[0].outputFile.slice(0, fixture.actions[0].outputFile.lastIndexOf('/')), 'runDir is derived from the output paths when the caller gives none');
  for (const action of summary.actions) assert.ok(!String(action.outFile ?? '').includes('/'), `outFile is a basename: ${action.outFile}`);
});

test('summary fills action routing and attempt fields from durable state', () => {
  const state = {
    program: { actions: [{ id: fixture.actions[0].id, kind: 'implement', lane: 'build', effort: 'medium' }] },
    attempts: [{
      actionId: fixture.actions[0].id,
      pool: 'echo', model: 'fixture-model', wallSec: 7,
      outputFile: '/run/out-attempt.md',
      bytes: { taskFile: 100, authorPrompt: 20, kernel: 80, dependencyInputs: 30, output: 40 },
    }],
  };
  const action = summarizeV2Result(fixture, state).actions[0];
  assert.deepEqual(action, {
    id: fixture.actions[0].id,
    kind: fixture.actions[0].kind,
    lane: 'build', effort: 'medium', status: fixture.actions[0].status,
    pool: 'echo', model: 'fixture-model', reasoning: fixture.actions[0].reasoning.applied,
    wallSec: 7, outFile: 'out-dead-code-attempt-1.md',
    bytes: { taskFile: 100, authorPrompt: 20, kernel: 80, dependencyInputs: 30, output: 40 },
  });
});

test('runs result --summary and --summary --json produce the same completed JSON', () => {
  const home = mkdtempSync(join(tmpdir(), 'bullswarm-result-summary-'));
  const runDir = join(home, 'workflows', fixture.runId);
  mkdirSync(runDir, { recursive: true });
  try {
    const state = {
      schemaVersion: 'bullswarm.workflow.state.v2',
      runId: fixture.runId,
      shortId: fixture.shortId,
      intentId: fixture.intentId,
      intent: { goal: fixture.goal },
      lifecycle: {
        status: fixture.status,
        startedAt: fixture.finishedAt,
        finishedAt: fixture.finishedAt,
        resultFile: join(runDir, 'result.json'),
      },
    };
    writeFileSync(join(runDir, 'state.json'), JSON.stringify(state));
    writeFileSync(join(runDir, 'result.json'), JSON.stringify(fixture));
    const implicit = cli(home, ['workflow', 'runs', 'result', fixture.shortId, '--summary']);
    const explicit = cli(home, ['workflow', 'runs', 'result', fixture.shortId, '--summary', '--json']);
    assert.equal(implicit.status, 0, implicit.stderr);
    assert.equal(explicit.status, 0, explicit.stderr);
    assert.equal(implicit.stderr, '');
    assert.equal(explicit.stderr, '');
    assert.equal(implicit.stdout, explicit.stdout);
    const summary = summarizeV2Result(fixture, state, { runDir });
    const compact = JSON.stringify(summary);
    assert.equal(implicit.stdout, `${compact}\n`);
    assert.equal(implicit.stdout.replace(/\n$/, '').split('\n').length, 1);
    assert.equal(Buffer.byteLength(compact, 'utf8'), Buffer.byteLength(JSON.stringify(summary), 'utf8'));
    assert.ok(Buffer.byteLength(compact, 'utf8') < 4096, `CLI --summary ${Buffer.byteLength(compact, 'utf8')} bytes must stay below 4096`);
    assert.equal(JSON.parse(implicit.stdout).schemaVersion, 'bullswarm.workflow.result-summary.v1');
    const full = cli(home, ['workflow', 'runs', 'result', fixture.shortId, '--json']);
    assert.equal(full.status, 0, full.stderr);
    assert.equal(full.stdout, `${JSON.stringify(fixture, null, 2)}\n`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('old result envelopes without byte fields remain valid', () => {
  const old = structuredClone(fixture);
  for (const action of old.actions) delete action.bytes;
  delete old.usage.bytes;
  assert.equal(deserializeV2ResultEnvelope(JSON.stringify(old)).schemaVersion, 'bullswarm.workflow.result.v2');
});

// The real envelope's program as durable state: every writer affects one
// requirement, `verify` reviews all of them, and `docs` also declares a
// command check that passed.
function proofState() {
  const requirementIds = fixture.requirements.map((requirement) => requirement.id);
  return {
    program: { actions: fixture.actions.map((action) => (action.id === 'verify'
      ? { id: action.id, kind: action.kind, affects: [], evidenceFor: requirementIds }
      : { id: action.id, kind: action.kind, affects: [requirementIds[0]], evidenceFor: [], ...(action.id === 'docs' ? { evidence: [{ type: 'command', cmd: 'npm run docs:check' }] } : {}) })) },
    actions: fixture.actions.map((action) => ({ id: action.id, status: action.status })),
    attempts: [{ id: 'docs-1', actionId: 'docs', status: 'succeeded', evidenceResults: [{ type: 'command', cmd: 'npm run docs:check', status: 'passed', exit: 0, durationMs: 900, tail: '', log: '/runs/acme/evidence-docs-attempt-1-1.log', why: null }] }],
    ledger: { requirements: Object.fromEntries(fixture.requirements.map((requirement) => [requirement.id, { id: requirement.id, status: requirement.status }])) },
  };
}

test('summary proof: rows carry what backs each step, the top level counts them, and the line reads them', () => {
  const summary = summarizeV2Result(fixture, proofState(), { features: { deliverableGate: 1, proofLabels: 1 } });
  assert.deepEqual(summary.actions.map((action) => [action.id, action.proof]), [
    ['dead-code', ['review']], ['state-bugs', ['review']], ['routing-cleanup', ['review']], ['verify-gate', ['review']],
    ['surface', ['review']], ['dead-kernel', ['review']], ['docs', ['command', 'review']], ['integrate', ['review']], ['verify', undefined],
  ]);
  assert.deepEqual(summary.proof, { proven: 8, byType: { command: 1, schema: 0, review: 8 }, unproven: 0, unprovenSteps: [] });
  assert.equal(formatV2ProofLine(summary), 'proof: 8 steps proven (command 1, review 8)');
  assert.ok(Buffer.byteLength(JSON.stringify(summary), 'utf8') < 4096);
  // The key order: proof sits after actions, and rows carry it after status.
  assert.deepEqual(Object.keys(summary).slice(Object.keys(summary).indexOf('actions'), Object.keys(summary).indexOf('actions') + 2), ['actions', 'proof']);
  assert.deepEqual(Object.keys(summary.actions[0]).slice(0, 5), ['id', 'kind', 'status', 'proof', 'reasoning']);
  // Without the marker only the step that declares evidence is labelled.
  const unmarked = summarizeV2Result(fixture, proofState(), { features: {} });
  assert.deepEqual(unmarked.actions.filter((action) => action.proof).map((action) => action.id), ['docs']);
  assert.equal(formatV2ProofLine(unmarked), 'proof: 1 step proven (command 1, review 1)');
});

test('a new run whose proof pushes the summary over budget sheds only the null per-step usage fields; a saved run reads as before', () => {
  // A per-step usage row as the kernel writes it for an unmetered pool.
  const step = {
    attempts: 1, minutes: 0, tokens: 1573, cacheRead: null, cacheWrite: null, reasoning: null, apiUsd: 0, apiKnownSubtotalUsd: 0,
    subscriptionUsd: null, subscriptionKnownSubtotalUsd: null, measuredAttempts: 0, pricedAttempts: 1, subscriptionPricedAttempts: 0,
    tokenSource: 'estimated:utf8-bytes/4', subscriptionBasis: 'unknown:no-price', subscriptionDeltaPct: null, subscriptionWindow: null, subscriptionWindows: {},
  };
  const many = { ...structuredClone(fixture), usage: { ...fixture.usage, steps: Object.fromEntries(fixture.actions.slice(0, 6).map((action) => [action.id, step])) } };
  const state = {
    program: { actions: fixture.actions.map((action) => ({ id: action.id, kind: action.kind, affects: [], evidenceFor: [] })) },
    actions: fixture.actions.map((action) => ({ id: action.id, status: action.status })),
    attempts: [], ledger: { requirements: {} },
  };
  const size = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
  // Without the marker nothing is labelled, and the over-budget summary is the one earlier versions printed.
  const saved = summarizeV2Result(many, state, { features: {} });
  assert.equal(Object.hasOwn(saved, 'proof'), false);
  assert.ok(size(saved) >= 4096, `the saved-run case must be over budget to prove anything: ${size(saved)}`);
  assert.deepEqual(saved.usage.steps['dead-code'], step);
  // With the marker the top-level proof stays, and the unknown usage fields go instead.
  const fresh = summarizeV2Result(many, state, { features: { deliverableGate: 1, proofLabels: 1 } });
  assert.ok(size(fresh) < 4096, `summary ${size(fresh)} must fit`);
  assert.equal(fresh.proof.unproven, fixture.actions.length);
  const known = Object.fromEntries(Object.entries(step).filter(([, value]) => value !== null));
  for (const row of Object.values(fresh.usage.steps)) assert.deepEqual(row, known);
  assert.deepEqual(fresh.usage.totals, saved.usage.totals);
});

test('runs result prints `# proof` after `# outcome` only for a run with the marker', () => {
  const home = mkdtempSync(join(tmpdir(), 'bullswarm-result-proof-'));
  try {
    const run = 'wf-mu8thu2e-27c504';
    const runDir = join(home, 'workflows', run);
    cpSync(join(ROOT, 'tests', 'fixtures', 'home-351', 'workflows', run), runDir, { recursive: true });
    const before = cli(home, ['workflow', 'runs', 'result', 'euqrni']);
    assert.equal(before.status, 0, before.stderr);
    assert.equal(before.stdout.includes('# proof'), false, 'a saved run without the marker reads as before');
    writeFileSync(join(runDir, 'features.json'), JSON.stringify({ deliverableGate: 1, proofLabels: 1 }));
    const after = cli(home, ['workflow', 'runs', 'result', 'euqrni']);
    assert.equal(after.status, 0, after.stderr);
    const lines = after.stdout.split('\n');
    const outcome = lines.findIndex((line) => line.startsWith('# outcome  '));
    assert.equal(lines[outcome + 1], '# proof  4 steps proven (review 4)');
    assert.equal(after.stdout.replace('# proof  4 steps proven (review 4)\n', ''), before.stdout, 'nothing else changes');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// F16: the verifier's shape. A partial program run (one step finished, one
// failed on quota, one blocked) padded until its unlabelled summary sits just
// under the budget. The marker adds `proof`, which must not cost a handback line.
function nearBudgetRun(padding, { loop = false } = {}) {
  const quotaWhy = 'usage limit: "You\'ve hit your session limit · resets 10:30pm (UTC)" while writing the integration notes for the acme release branch and its checks';
  const envelope = {
    runId: 'wf-test-nearbudget', shortId: 'near01', status: 'partial', verified: false, executionMode: 'program',
    reason: 'integrate failed (quota); verify blocked', finishedAt: '2026-09-24T01:10:00Z', goal: 'Ship the acme command-line release',
    requirements: [
      { id: 'r1', status: 'unresolved', mandatory: true, evidence: [{ evidence: ['The integration step did not run to the end, so the release notes and the combined checks were never produced for review.'] }] },
      { id: 'r2', status: 'unresolved', mandatory: true, evidence: [{ evidence: ['Nothing verified the command-line output against the documented examples because the verify step was blocked by integrate.'] }] },
    ],
    actions: ['cli', 'integrate', 'verify'].map((id) => ({
      id, kind: id === 'verify' ? 'review' : 'implement', status: { cli: 'succeeded', integrate: 'failed', verify: 'blocked' }[id],
      outputFile: `/runs/acme/out-${id}-attempt-1.md`, reasoning: 'medium', bytes: { output: 2048, prompt: 4096 },
    })),
    usage: { total: 3, byPool: { [`acme-${'x'.repeat(padding)}`]: 3 } },
    ...(loop ? {
      verifyRounds: { max: 2, used: 2, stoppedBy: 'rounds', phases: [1, 2].flatMap((round) => [
        { kind: 'verify', round, steps: ['verify'], judged: 2, failed: ['r1'], wallMinutes: 4, pools: ['acme-pool'], apiUsd: null, unmeasured: 1, cost: 'subscription' },
        { kind: 'repair', round, steps: ['integrate'], requirements: ['r1'], wallMinutes: 6, pools: ['acme-pool'], apiUsd: null, unmeasured: 1, cost: 'subscription' },
      ]) },
      callerDecision: { verifyRounds: '2/2', requirements: [{ id: 'r1', status: 'unresolved', round: 2, evidence: 'The release notes were still missing after the second repair round, and the combined checks never ran.', next: 'bullswarm workflow plan revise near01 --program plan.json' }] },
    } : {}),
    handback: {
      unfinished: [
        { id: 'integrate', status: 'failed', failureKind: 'quota', why: quotaWhy, retryable: true },
        { id: 'verify', status: 'blocked', failureKind: 'dependency', why: 'blocked by integrate, which failed before it produced the combined checks this review needs', retryable: true },
      ],
      unresolvedRequirements: [], unreadSteering: [],
    },
  };
  const state = {
    program: { actions: [
      { id: 'cli', kind: 'implement', affects: ['r1'], evidenceFor: [] },
      { id: 'integrate', kind: 'implement', affects: ['r1'], evidenceFor: [] },
      { id: 'verify', kind: 'review', affects: [], evidenceFor: ['r1', 'r2'] },
    ] },
    actions: [{ id: 'cli', status: 'succeeded' }, { id: 'integrate', status: 'failed' }, { id: 'verify', status: 'blocked' }],
    attempts: [], ledger: { requirements: { r1: { id: 'r1', status: 'unresolved' }, r2: { id: 'r2', status: 'unresolved' } } },
  };
  return { envelope, state };
}

test('F16: near the byte budget, the proof object never costs a handback line', () => {
  const size = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
  // Sweep the padding across every fit level: wherever the unlabelled summary
  // lands, the marked one prints the same handback lines and still fits.
  let fullReason = 0;
  for (const loop of [false, true]) for (let padding = 0; padding <= 3000; padding += 10) {
    const { envelope, state } = nearBudgetRun(padding, { loop });
    const saved = summarizeV2Result(envelope, state, { runDir: '/runs/acme', features: {} });
    const fresh = summarizeV2Result(envelope, state, { runDir: '/runs/acme', features: { deliverableGate: 1, proofLabels: 1 } });
    assert.equal(Object.hasOwn(saved, 'proof'), false);
    assert.equal(fresh.proof.unproven, 1, `padding ${padding}: the proof counts stay`);
    assert.equal(fresh.proof.proven, 0);
    // Where the run without labels is already at its smallest levels, the
    // summary may run over, by no more than the proof's own bytes.
    const proofBytes = Buffer.byteLength(`,"proof":${JSON.stringify(fresh.proof)}`, 'utf8');
    if (size(saved) < 4096) assert.ok(size(fresh) < 4096 + proofBytes, `padding ${padding}: ${size(fresh)} bytes`);
    if (size(saved) < 4096 - proofBytes) assert.ok(size(fresh) < 4096, `padding ${padding}: ${size(fresh)} bytes must fit`);
    const lines = formatV2HandbackLines(saved);
    assert.deepEqual(formatV2HandbackLines(fresh), lines, `padding ${padding}: the same handback lines with and without the marker`);
    if (lines.includes(`  step integrate: failed (quota) — ${envelope.handback.unfinished[0].why}`)) fullReason += 1;
  }
  assert.ok(fullReason > 0, 'some paddings keep the whole quota reason');
});

// Stage 3 (§2.9): a marked run's handback carries each failed step's retries
// and the rerun/accept verbs at every fit level, and the proof still never
// costs a handback line.
test('stage 3: retries and the caller verbs survive every fit level; the proof never costs a handback line', () => {
  const STAGE3 = { deliverableGate: 1, proofLabels: 1, failureRule: 1, reviewPlacement: 'caller' };
  for (const loop of [false, true]) for (let padding = 0; padding <= 3000; padding += 50) {
    const { envelope, state } = nearBudgetRun(padding, { loop });
    envelope.handback.unfinished[0].retries = 1;
    const unlabelled = summarizeV2Result(envelope, state, { runDir: '/runs/acme', features: { failureRule: 1, reviewPlacement: 'caller' } });
    const fresh = summarizeV2Result(envelope, state, { runDir: '/runs/acme', features: STAGE3 });
    // The smallest levels list fewer steps; a listed failed step keeps its count.
    const listed = fresh.handback.unfinished.find((entry) => entry.id === 'integrate');
    if (listed) assert.equal(listed.retries, 1, `padding ${padding}`);
    assert.match(fresh.handback.options.rerun, /^bullswarm workflow step rerun near01 integrate \[--avoid <pool>\]/);
    assert.match(fresh.handback.options.accept, /^bullswarm workflow step accept near01 integrate --reason "…"/);
    const lines = formatV2HandbackLines(fresh);
    assert.deepEqual(lines, formatV2HandbackLines(unlabelled), `padding ${padding}: the same handback lines with and without proof labels`);
    const step = lines.find((line) => line.startsWith('  step integrate:'));
    if (step) assert.match(step, /^ {2}step integrate: failed \(quota\) after 1 retry/);
  }
});
