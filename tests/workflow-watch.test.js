import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  formatDuration, timingBreakdown, watchSnapshot, snapshotFingerprint,
  renderWatchSnapshot, runWorkflowWatch,
} from '../src/workflow/watch-cli.js';
import { appendEvent } from '../src/workflow/events.js';
import { createV2GoalDocument, createV2State } from '../src/workflow/v2-state.js';
import { applyV2PlannerResponse } from '../src/workflow/v2-planner.js';

test('watch snapshot is concise and stable between heartbeats', () => {
  const nowMs = Date.parse('2026-08-28T01:05:00.000Z');
  const f = v2Fixture({ shortId: 'snp234', nowMs });
  try {
    f.state.attempts[0].lastAgentEvent = { kind: 'shell_command', summary: 'npm test' };
    f.save();
    const snapshot = watchSnapshot(f.runDir, f.state, new Date(nowMs));
    assert.equal(snapshot.elapsedSec, 60);
    assert.equal(snapshot.agents[0].elapsedSec, 30);
    assert.equal(snapshot.agents[0].lastActions[0].summary, 'npm test');
    const compact = renderWatchSnapshot(snapshot);
    assert.match(compact, /0 new events/);
    assert.doesNotMatch(compact, /npm test/);
    assert.match(renderWatchSnapshot(snapshot, { verbose: true }), /shell_command:running · npm test/);
    const later = watchSnapshot(f.runDir, f.state, new Date(nowMs + 30_000));
    assert.equal(snapshotFingerprint(snapshot), snapshotFingerprint(later));
    assert.equal(formatDuration(3661), '1h01m');
  } finally { f.cleanup(); }
});

test('V2 watch heartbeat reports only counts, latest purpose, freshness, and result command', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bs-watch-v2-'));
  const runId = 'wf-v2watch-abcdef';
  const runDir = join(home, 'workflows', runId);
  mkdirSync(runDir, { recursive: true });
  try {
    const goal = createV2GoalDocument({ goal: 'Write and inspect a report', cwd: '/tmp/repo', requirements: [{ id: 'report-correct', text: 'Report is correct' }], settings: { scout: false } });
    let state = createV2State(goal, { runId, shortId: 'v2w234' });
    state.lifecycle = { status: 'running', startedAt: new Date(Date.now() - 60_000).toISOString(), finishedAt: null, resultFile: null };
    state = applyV2PlannerResponse(state, {
      schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary: 'Write then inspect.',
      program: { schemaVersion: 'bullswarm.workflow.program.v2', actions: [
        { id: 'write-report', purpose: 'Write report', dependsOn: [], affects: ['report-correct'], ownedFiles: ['report.md'], prompt: 'Write it.', lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: ['report'] },
        { id: 'inspect-report', purpose: 'Inspect report', dependsOn: ['write-report'], affects: [], ownedFiles: [], prompt: 'Inspect it.', lane: 'analyze', effort: 'low', evidenceFor: ['report-correct'], inputs: ['report'], produces: [] },
      ] },
    });
    state.actions[0].status = 'running'; state.actions[0].startedAt = new Date(Date.now() - 30_000).toISOString(); state.actions[0].attempts = 1;
    state.attempts.push({ id: 'write-report-1', actionId: 'write-report', ordinal: 1, status: 'running', pool: 'relay', model: 'gpt-5.6-luna', startedAt: state.actions[0].startedAt, finishedAt: null, lastActivityAt: new Date(Date.now() - 2_000).toISOString(), outputBytesObserved: 1200, lastAgentEvent: { kind: 'tool', summary: 'node --test' } });
    appendEvent(runDir, state, 'action.started', { actionId: 'write-report' });
    writeFileSync(join(runDir, 'state.json'), `${JSON.stringify(state)}\n`);
    const snapshot = watchSnapshot(runDir, state, new Date());
    const compact = renderWatchSnapshot(snapshot, { events: [{ type: 'action.started' }] });
    assert.match(compact, /1 running, 1 waiting/);
    assert.match(compact, /latest: Write report/);
    assert.match(compact, /1 new events/);
    assert.doesNotMatch(compact, /node --test|taskFile|outputFile/);
    assert.match(renderWatchSnapshot(snapshot, { verbose: true }), /tool:running · node --test/);

    state.actions[0].status = 'succeeded'; state.actions[0].finishedAt = new Date().toISOString();
    state.actions[1].status = 'blocked';
    state.attempts[0].status = 'succeeded'; state.attempts[0].finishedAt = state.actions[0].finishedAt;
    state.lifecycle = { status: 'partial', startedAt: state.lifecycle.startedAt, finishedAt: new Date().toISOString(), resultFile: join(runDir, 'result.json') };
    writeFileSync(join(runDir, 'state.json'), `${JSON.stringify(state)}\n`);
    let output = '';
    assert.equal(await runWorkflowWatch(home, 'v2w234', { once: true, output: { write: (text) => { output += text; } } }), 0);
    assert.match(output, /workflow ended partial; result ready/);
    assert.match(output, /next: bullswarm workflow runs result v2w234 --json/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('human watch reports interval activity without repeating excerpts', () => {
  const f = v2Fixture({ shortId: 'itv234' });
  try {
    f.state.attempts[0].lastAgentEvent = { kind: 'shell_command', summary: 'npm test' };
    const rendered = renderWatchSnapshot(watchSnapshot(f.runDir, f.state), {
      events: [
        { type: 'action.started' },
        { type: 'attempt.agent_action', payload: { actionId: 'write-report' } },
      ],
    });
    assert.match(rendered, /2 new events/);
    assert.doesNotMatch(rendered, /npm test/);
  } finally { f.cleanup(); }
});

test('classic watch aggregates low-level actions until the heartbeat interval', async () => {
  const f = v2Fixture({ shortId: 'agg234' });
  try {
    let output = '';
    const watching = runWorkflowWatch(f.home, 'agg234', {
      classic: true,
      intervalMs: 10,
      heartbeatMs: 120,
      output: { write: (text) => { output += text; } },
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    f.emit('attempt.agent_action', { actionId: 'write-report' });
    f.emit('attempt.agent_action', { actionId: 'write-report' });
    await new Promise((resolve) => setTimeout(resolve, 55));
    assert.equal(output.trim().split('\n').length, 1, 'actions alone must not wake compact watch');
    await new Promise((resolve) => setTimeout(resolve, 75));
    f.state.actions[0].status = 'succeeded';
    f.state.attempts[0].status = 'succeeded';
    f.state.lifecycle = { ...f.state.lifecycle, status: 'completed', finishedAt: new Date().toISOString() };
    f.save();
    assert.equal(await watching, 0);
    assert.match(output, /2 new events/);
    assert.doesNotMatch(output, /write-report#|npm test/);
  } finally { f.cleanup(); }
});

test('terminal watch emits attempt timing breakdown and exits', async () => {
  const f = v2Fixture({ shortId: 'tim234' });
  try {
    f.state.lifecycle = {
      status: 'completed', startedAt: '2026-08-28T01:00:00.000Z',
      finishedAt: '2026-08-28T01:03:00.000Z', resultFile: join(f.runDir, 'result.json'),
    };
    f.state.actions.forEach((action) => { action.status = 'succeeded'; });
    Object.assign(f.state.attempts[0], {
      status: 'succeeded', pool: 'command-code', model: 'gpt-5.6-sol',
      startedAt: '2026-08-28T01:01:00.000Z', finishedAt: '2026-08-28T01:02:30.000Z',
      usage: { tokens: { totalKnown: 1000 } },
    });
    f.save();
    assert.equal(timingBreakdown(f.state).attempts[0].elapsedSec, 90);
    let output = '';
    const code = await runWorkflowWatch(f.home, 'tim234', {
      classic: true, verbose: true, output: { write: (text) => { output += text; } },
    });
    assert.equal(code, 0);
    assert.match(output, /timing: 1 attempts in 3m00s/);
    assert.match(output, /write-report#1/);
    assert.match(output, /next: bullswarm workflow runs result tim234 --json/);
  } finally { f.cleanup(); }
});

test('compact terminal uses finished activity for quiet time and omits attempt detail', async () => {
  const finishedAt = new Date(Date.now() - 5_000).toISOString();
  const f = v2Fixture({ shortId: 'cmp234' });
  try {
    f.state.lifecycle = { ...f.state.lifecycle, status: 'completed', finishedAt, resultFile: null };
    f.state.actions.forEach((action) => { action.status = 'succeeded'; });
    Object.assign(f.state.attempts[0], {
      status: 'succeeded', startedAt: new Date(Date.now() - 10_000).toISOString(), finishedAt,
    });
    f.save();
    let output = '';
    assert.equal(await runWorkflowWatch(f.home, 'cmp234', {
      once: true, output: { write: (text) => { output += text; } },
    }), 0);
    assert.match(output, /quiet [45]s/);
    assert.doesNotMatch(output, /write-report#1/);
  } finally { f.cleanup(); }
});

test('compact heartbeat separates semantic quiet from live agent output', async () => {
  const now = Date.now();
  const f = v2Fixture({ shortId: 'qui234', nowMs: now });
  try {
    f.state.lifecycle = { ...f.state.lifecycle, startedAt: new Date(now - 120_000).toISOString() };
    f.state.events = { sequence: 1, last: { committedAt: new Date(now - 40_000).toISOString() } };
    Object.assign(f.state.attempts[0], {
      startedAt: new Date(now - 100_000).toISOString(),
      lastActivityAt: new Date(now - 3_000).toISOString(),
      outputBytesObserved: 4096,
    });
    f.save();
    const snapshot = watchSnapshot(f.runDir, f.state, new Date(now));
    assert.equal(snapshot.transportQuietForSec, 3);
    assert.equal(watchSnapshot(f.runDir, { ...f.state, attempts: [] }, new Date(now)).transportQuietForSec, null);
    let output = '';
    assert.equal(await runWorkflowWatch(f.home, 'qui234', {
      once: true, output: { write: (text) => { output += text; } },
    }), 0);
    assert.match(output, /quiet (39|40|41)s · agent output [2-4]s ago/);
    let json = '';
    await runWorkflowWatch(f.home, 'qui234', { once: true, jsonl: true, output: { write: (text) => { json += text; } } });
    assert.ok([2, 3, 4].includes(JSON.parse(json).transportQuietForSec));
  } finally { f.cleanup(); }
});

test('a live workflow.completed event delivers the terminal status', async () => {
  const f = v2Fixture({ shortId: 'evt234' });
  try {
    let output = '';
    const watching = runWorkflowWatch(f.home, 'evt234', {
      classic: true,
      intervalMs: 10,
      heartbeatMs: 120,
      output: { write: (text) => { output += text; } },
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    f.state.actions.forEach((action) => { action.status = 'succeeded'; });
    f.state.attempts[0].status = 'succeeded';
    f.state.lifecycle = { ...f.state.lifecycle, status: 'completed', finishedAt: new Date().toISOString() };
    f.emit('workflow.completed', {});
    assert.equal(await watching, 0);
    assert.match(output, /workflow complete; result ready/);
    assert.match(output, /1 new events/);
    assert.match(output, /outcome: completed\n/);
  } finally { f.cleanup(); }
});

test('watch waits a bounded grace period for a freshly launched run to write state.json', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bs-watch-grace-'));
  const runId = 'wf-mgrace-abcdef';
  try {
    const runDir = join(home, 'workflows', runId);
    setTimeout(() => {
      const goal = createV2GoalDocument({
        goal: 'Land the change', cwd: '/tmp/repo',
        requirements: [{ id: 'requirement-1', text: 'Change lands' }],
        settings: { scout: false },
      });
      const state = createV2State(goal, { runId, shortId: 'grc234' });
      state.lifecycle = {
        status: 'completed', startedAt: new Date(Date.now() - 5000).toISOString(),
        finishedAt: new Date().toISOString(), resultFile: null,
      };
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, 'state.json'), `${JSON.stringify(state)}\n`);
    }, 400);
    let output = '';
    const code = await runWorkflowWatch(home, runId, {
      once: true, waitForRunMs: 5000, output: { write: (text) => { output += text; } },
    });
    assert.equal(code, 0);
    assert.match(output, /workflow complete; result ready/);
    await assert.rejects(() => runWorkflowWatch(home, 'wf-missing-zzzzzz', { once: true, waitForRunMs: 300 }), /no run found/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(check, message, timeoutMs = 2500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await sleep(15);
  }
  throw new Error(message);
}

function markRunnerLive(state, nowMs = Date.now()) {
  state.runner = { pid: process.pid, lastHeartbeatAt: new Date(nowMs).toISOString() };
}

function defaultV2Actions() {
  return [
    { id: 'write-report', purpose: 'Write report', dependsOn: [], affects: ['requirement-1'], ownedFiles: ['report.md'], prompt: 'Write it.', lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: ['report'] },
    { id: 'inspect-report', purpose: 'Inspect report', dependsOn: ['write-report'], affects: [], ownedFiles: [], prompt: 'Inspect it.', lane: 'analyze', effort: 'low', evidenceFor: ['requirement-1', 'requirement-2'], inputs: ['report'], produces: [] },
  ];
}

function v2Fixture({
  shortId,
  executionMode,
  requirements,
  actions,
  nowMs = Date.now(),
  running = true,
} = {}) {
  const home = mkdtempSync(join(tmpdir(), 'bs-watch-v2e-'));
  const runId = `wf-${shortId}-abcdef`;
  const runDir = join(home, 'workflows', runId);
  mkdirSync(runDir, { recursive: true });
  const goal = createV2GoalDocument({
    goal: 'Write and inspect a report',
    cwd: '/tmp/repo',
    requirements: requirements ?? [
      { id: 'requirement-1', text: 'Report is correct' },
      { id: 'requirement-2', text: 'Tests pass' },
    ],
    settings: { scout: false, ...(executionMode ? { executionMode } : {}) },
  });
  let state = createV2State(goal, { runId, shortId });
  state.lifecycle = {
    status: 'running',
    startedAt: new Date(nowMs - 60_000).toISOString(),
    finishedAt: null,
    resultFile: null,
  };
  state = applyV2PlannerResponse(state, {
    schemaVersion: 'bullswarm.workflow.planner-response.v2',
    kind: 'program',
    summary: 'Write then inspect.',
    program: { schemaVersion: 'bullswarm.workflow.program.v2', actions: actions ?? defaultV2Actions() },
  });
  if (running) {
    Object.assign(state.actions[0], {
      status: 'running',
      startedAt: new Date(nowMs - 30_000).toISOString(),
      attempts: 1,
    });
    state.attempts.push({
      id: `${state.actions[0].id}-1`,
      actionId: state.actions[0].id,
      ordinal: 1,
      status: 'running',
      pool: 'command-code',
      model: 'claude-opus-5',
      startedAt: state.actions[0].startedAt,
      finishedAt: null,
      lastActivityAt: new Date(nowMs - 2_000).toISOString(),
      outputBytesObserved: 1200,
    });
  }
  markRunnerLive(state, nowMs);
  writeFileSync(join(runDir, 'state.json'), `${JSON.stringify(state)}\n`);
  return {
    home, runId, runDir, shortId, state, nowMs,
    save() {
      writeFileSync(join(runDir, 'state.json'), `${JSON.stringify(this.state)}\n`);
    },
    emit(type, payload) {
      appendEvent(runDir, this.state, type, payload);
      this.save();
    },
    cleanup() { rmSync(home, { recursive: true, force: true }); },
  };
}

function startWatch(f, options = {}) {
  let output = '';
  const { now, ...rest } = options;
  const promise = runWorkflowWatch(f.home, f.runId, {
    intervalMs: 50,
    now: now ?? (() => f.nowMs),
    ...rest,
    output: { write: (text) => { output += text; } },
  });
  promise.catch(() => {});
  return {
    get output() { return output; },
    promise,
    lines() { return output.split('\n').filter((line) => line.length > 0); },
  };
}

async function afterFirstPoll() {
  await sleep(200);
}

async function settleWatch(f, watch) {
  const terminal = ['completed', 'partial', 'cancelled', 'failed', 'interrupted'];
  if (!terminal.includes(f.state.lifecycle?.status) && !f.state.planner?.awaiting) {
    f.state.lifecycle = {
      ...f.state.lifecycle,
      status: 'completed',
      finishedAt: new Date(f.nowMs).toISOString(),
      resultFile: join(f.runDir, 'result.json'),
    };
    try { f.save(); } catch { /* run dir may already be gone */ }
  }
  await Promise.race([watch.promise.catch(() => null), sleep(2000)]);
}

test('V2 watch prints an attach line then stays silent while nothing notable happens', async () => {
  const f = v2Fixture({ shortId: 'sil234' });
  try {
    const watch = startWatch(f);
    try {
      await waitUntil(() => watch.output.includes('● watching sil234'), `attach missing: ${watch.output}`);
      assert.match(watch.output, /^● watching sil234 · running · 1 running, 1 waiting · \+1m00s\n$/);
      await sleep(350);
      assert.equal(watch.lines().length, 1, `silence broken: ${watch.output}`);
      assert.doesNotMatch(watch.output, /♡|finished|started|silent for/);
    } finally { await settleWatch(f, watch); }
  } finally { f.cleanup(); }
});

test('V2 watch prints succeeded, failed, blocked and cancelled action lines with durations', async () => {
  const f = v2Fixture({ shortId: 'act234' });
  try {
    const watch = startWatch(f);
    try {
      await waitUntil(() => watch.output.includes('● watching act234'), `attach missing: ${watch.output}`);
      const t = (offsetSec) => new Date(f.nowMs + offsetSec * 1000).toISOString();
      const runtime = (id, status, startSec, extra = {}) => ({
        id, status, attempts: 1, programRevision: 1, workRevision: f.state.ledger.workRevision,
        startedAt: startSec == null ? null : t(startSec), finishedAt: startSec == null ? null : t(0),
        outputFile: null, artifactIds: [], lastFailure: null, ...extra,
      });
      Object.assign(f.state.actions[0], runtime('write-report', 'succeeded', -40));
      f.state.attempts[0] = { ...f.state.attempts[0], status: 'succeeded', finishedAt: t(0) };
      Object.assign(f.state.actions[1], runtime('inspect-report', 'blocked', null, {
        lastFailure: { kind: 'dependency', message: 'write-report did not succeed' },
      }));
      f.state.actions.push(
        runtime('docs', 'failed', -12, { lastFailure: { kind: 'ownership', message: 'out-of-scope mutation: README.md' } }),
        runtime('extra-task', 'cancelled', -8),
      );
      f.emit('action.finished', { actionId: 'write-report', status: 'succeeded' });
      f.emit('action.finished', { actionId: 'docs', status: 'failed', failureKind: 'ownership', why: 'out-of-scope mutation: README.md' });
      f.emit('action.finished', { actionId: 'inspect-report', status: 'blocked', why: 'write-report did not succeed' });
      f.emit('action.finished', { actionId: 'extra-task', status: 'cancelled' });
      await waitUntil(() => watch.output.includes('extra-task cancelled'), `action lines missing: ${watch.output}`);
      assert.match(watch.output, /✓ write-report finished · 40s/);
      assert.match(watch.output, /✗ docs failed · ownership: out-of-scope mutation: README.md · 12s/);
      assert.match(watch.output, /⊘ inspect-report blocked · write-report did not succeed/);
      assert.match(watch.output, /✗ extra-task cancelled · 8s/);
    } finally { await settleWatch(f, watch); }
  } finally { f.cleanup(); }
});

test('V2 watch prints evidence recorded with per-requirement verdicts', async () => {
  const f = v2Fixture({ shortId: 'evi234' });
  try {
    const watch = startWatch(f);
    try {
      await waitUntil(() => watch.output.includes('● watching evi234'), `attach missing: ${watch.output}`);
      Object.assign(f.state.actions[1], { status: 'succeeded', startedAt: new Date(f.nowMs - 10_000).toISOString(), finishedAt: new Date(f.nowMs).toISOString(), attempts: 1 });
      f.state.ledger.requirements['requirement-1'].status = 'passed';
      f.state.ledger.requirements['requirement-2'].status = 'failed';
      f.emit('evidence.recorded', {
        actionId: 'inspect-report',
        requirements: ['requirement-1', 'requirement-2'],
        statuses: { 'requirement-1': 'passed', 'requirement-2': 'failed' },
      });
      await waitUntil(() => watch.output.includes('inspect-report evidence'), `evidence missing: ${watch.output}`);
      assert.match(watch.output, /◆ inspect-report evidence · requirement-1 passed, requirement-2 failed/);
    } finally { await settleWatch(f, watch); }
  } finally { f.cleanup(); }
});

test('V2 watch prints a program dependency level once and a verified presentation stage from its event', async () => {
  const program = v2Fixture({ shortId: 'prg234', executionMode: 'program' });
  try {
    const watch = startWatch(program);
    try {
      await waitUntil(() => watch.output.includes('● watching prg234'), `attach missing: ${watch.output}`);
      const finishedAt = new Date(program.nowMs).toISOString();
      Object.assign(program.state.actions[0], {
        status: 'succeeded',
        startedAt: new Date(program.nowMs - 40_000).toISOString(),
        finishedAt,
        attempts: 1,
      });
      program.state.attempts[0] = { ...program.state.attempts[0], status: 'succeeded', finishedAt };
      program.emit('action.finished', { actionId: 'write-report', status: 'succeeded' });
      program.emit('presentation.stage_completed', {
        stageId: 'r1-level-1',
        label: 'Level 1 · write-report',
        status: 'completed',
        completed: 1,
        total: 1,
      });
      await waitUntil(() => watch.output.includes('Level 1 · write-report completed'), `program stage missing: ${watch.output}`);
      assert.equal(watch.output.match(/Level 1 · write-report completed · 1\/1/g)?.length, 1, watch.output);
      assert.match(watch.output, /✓ write-report finished · 40s/);
    } finally { await settleWatch(program, watch); }
  } finally { program.cleanup(); }

  const verified = v2Fixture({ shortId: 'pre234' });
  try {
    const watch = startWatch(verified);
    try {
      await waitUntil(() => watch.output.includes('● watching pre234'), `attach missing: ${watch.output}`);
      const finishedAt = new Date(verified.nowMs).toISOString();
      Object.assign(verified.state.actions[0], {
        status: 'succeeded',
        startedAt: new Date(verified.nowMs - 40_000).toISOString(),
        finishedAt,
        attempts: 1,
      });
      verified.state.attempts[0] = { ...verified.state.attempts[0], status: 'succeeded', finishedAt };
      verified.emit('action.finished', { actionId: 'write-report', status: 'succeeded' });
      await waitUntil(() => watch.output.includes('write-report finished'), `finish missing: ${watch.output}`);
      await sleep(200);
      assert.doesNotMatch(watch.output, /Implementation completed|Level 1/);
      verified.emit('presentation.stage_completed', {
        stageId: 'r1-implementation',
        label: 'Implementation',
        status: 'completed',
        completed: 1,
        total: 1,
      });
      await waitUntil(() => watch.output.includes('Implementation completed'), `presentation stage missing: ${watch.output}`);
      assert.equal(watch.output.match(/✓ Implementation completed · 1\/1/g)?.length, 1, watch.output);
    } finally { await settleWatch(verified, watch); }
  } finally { verified.cleanup(); }
});

test('V2 watch prints plan created, updated and rejected lines', async () => {
  const f = v2Fixture({ shortId: 'pln234' });
  try {
    const watch = startWatch(f);
    try {
      await waitUntil(() => watch.output.includes('● watching pln234'), `attach missing: ${watch.output}`);
      f.emit('planner.finished', { ok: true, turn: 1, kind: 'program', summary: 'Implement, test, verify.' });
      f.emit('planner.finished', { ok: true, turn: 2, kind: 'program', summary: 'Fill remaining gaps.' });
      f.emit('planner.finished', { ok: false, turn: 3, failureKind: 'invalid', why: 'empty program' });
      await waitUntil(() => watch.output.includes('planning attempt rejected'), `planner lines missing: ${watch.output}`);
      assert.match(watch.output, /◇ plan created \(turn 1\) · Implement, test, verify\./);
      assert.match(watch.output, /◇ plan updated #2 · Fill remaining gaps\./);
      assert.match(watch.output, /× planning attempt rejected · empty program/);
    } finally { await settleWatch(f, watch); }
  } finally { f.cleanup(); }
});

test('V2 watch prints a cancellation requested line', async () => {
  const f = v2Fixture({ shortId: 'cxl234' });
  try {
    const watch = startWatch(f);
    try {
      await waitUntil(() => watch.output.includes('● watching cxl234'), `attach missing: ${watch.output}`);
      f.state.cancellation = { requested: true, requestedAt: new Date(f.nowMs).toISOString(), reason: 'operator' };
      f.emit('workflow.cancellation_requested', { reason: 'operator', source: 'cli' });
      await waitUntil(() => watch.output.includes('cancellation requested'), `cancel missing: ${watch.output}`);
      assert.match(watch.output, /⧖ cancellation requested/);
    } finally { await settleWatch(f, watch); }
  } finally { f.cleanup(); }
});

test('V2 watch reports a stall once and a recovery once using an injectable clock', async () => {
  const f = v2Fixture({ shortId: 'stl234' });
  f.state.attempts[0].lastActivityAt = new Date(f.nowMs).toISOString();
  f.save();
  try {
    const watch = startWatch(f, { stallAfterMs: 1000 });
    try {
      await waitUntil(() => watch.output.includes('● watching stl234'), `attach missing: ${watch.output}`);
      assert.doesNotMatch(watch.output, /silent for|active again/);
      f.nowMs += 5_000;
      markRunnerLive(f.state, f.nowMs);
      f.save();
      await waitUntil(() => watch.output.includes('silent for'), `stall missing: ${watch.output}`);
      assert.match(watch.output, /⚠ write-report silent for 5s · command-code\/claude-opus-5 · still running, not auto-killed/);
      const afterStall = watch.output;
      await sleep(350);
      assert.equal(watch.output, afterStall, 'stall line must print once per episode');
      f.state.attempts[0].lastActivityAt = new Date(f.nowMs).toISOString();
      f.save();
      await waitUntil(() => watch.output.includes('active again'), `recovery missing: ${watch.output}`);
      assert.match(watch.output, /↻ write-report active again after 5s/);
      assert.equal(watch.output.match(/silent for/g)?.length, 1);
      assert.equal(watch.output.match(/active again/g)?.length, 1);
      const afterRecover = watch.output;
      await sleep(350);
      assert.equal(watch.output, afterRecover, 'recovery line must print once');
    } finally { await settleWatch(f, watch); }
  } finally { f.cleanup(); }
});

test('V2 --next prints no attach line and returns after the first notable event', async () => {
  const running = v2Fixture({ shortId: 'nxr234' });
  const watch = startWatch(running, { next: true });
  try {
    await afterFirstPoll();
    assert.equal(watch.output, '');
    Object.assign(running.state.actions[0], {
      status: 'succeeded',
      startedAt: new Date(running.nowMs - 40_000).toISOString(),
      finishedAt: new Date(running.nowMs).toISOString(),
      attempts: 1,
    });
    running.emit('action.finished', { actionId: 'write-report', status: 'succeeded' });
    assert.equal(await Promise.race([
      watch.promise,
      sleep(3000).then(() => { throw new Error(`--next hung: ${watch.output}`); }),
    ]), 0);
    assert.doesNotMatch(watch.output, /watching/);
    assert.match(watch.output, /✓ write-report finished · 40s/);
    assert.doesNotMatch(watch.output, /outcome:/);
  } finally {
    await settleWatch(running, watch);
    running.cleanup();
  }

  const delivered = v2Fixture({ shortId: 'nxc234', running: false });
  try {
    delivered.state.lifecycle = {
      status: 'completed',
      startedAt: new Date(delivered.nowMs - 60_000).toISOString(),
      finishedAt: new Date(delivered.nowMs).toISOString(),
      resultFile: join(delivered.runDir, 'result.json'),
    };
    delivered.save();
    let output = '';
    const code = await runWorkflowWatch(delivered.home, delivered.runId, {
      next: true, now: () => delivered.nowMs, output: { write: (text) => { output += text; } },
    });
    assert.equal(code, 0);
    assert.doesNotMatch(output, /watching/);
    assert.match(output, /outcome: completed\n/);
    assert.match(output, /next: bullswarm workflow runs result nxc234 --json/);
  } finally { delivered.cleanup(); }

  const failed = v2Fixture({ shortId: 'nxf234', running: false });
  try {
    failed.state.lifecycle = {
      status: 'failed',
      startedAt: new Date(failed.nowMs - 60_000).toISOString(),
      finishedAt: new Date(failed.nowMs).toISOString(),
      resultFile: join(failed.runDir, 'result.json'),
    };
    failed.save();
    let output = '';
    const code = await runWorkflowWatch(failed.home, failed.runId, {
      next: true, now: () => failed.nowMs, output: { write: (text) => { output += text; } },
    });
    assert.equal(code, 1);
    assert.doesNotMatch(output, /watching/);
    assert.match(output, /outcome: failed\n/);
  } finally { failed.cleanup(); }

  const paused = v2Fixture({ shortId: 'nxp234', running: false });
  try {
    paused.state.lifecycle.status = 'waiting';
    paused.state.planner.status = 'waiting';
    paused.state.planner.awaiting = {
      boundary: 'initial', turn: 1,
      requestPath: '/tmp/request.json', candidatePath: '/tmp/candidate.json',
      since: new Date(paused.nowMs).toISOString(),
    };
    paused.save();
    let output = '';
    const code = await runWorkflowWatch(paused.home, paused.runId, {
      next: true, now: () => paused.nowMs, output: { write: (text) => { output += text; } },
    });
    assert.equal(code, 0);
    assert.doesNotMatch(output, /watching/);
    assert.match(output, /outcome: waiting for the caller planner \(initial boundary\)\n/);
    assert.match(output, /next: bullswarm workflow plan show nxp234 --json/);
  } finally { paused.cleanup(); }

  const dead = v2Fixture({ shortId: 'nxd234' });
  try {
    dead.state.runner = { pid: 999999999, lastHeartbeatAt: new Date(dead.nowMs).toISOString() };
    dead.save();
    let output = '';
    const code = await runWorkflowWatch(dead.home, dead.runId, {
      next: true, now: () => dead.nowMs, output: { write: (text) => { output += text; } },
    });
    assert.equal(code, 1);
    assert.doesNotMatch(output, /watching/);
    assert.match(output, /outcome: interrupted; edits retained\n/);
    assert.match(output, /next: bullswarm workflow resume nxd234/);
  } finally { dead.cleanup(); }
});

test('V2 --next --after replays a missed finish and its level once and skips a level already terminal at the cursor', async () => {
  const f = v2Fixture({ shortId: 'aft234', executionMode: 'program' });
  try {
    // Committed while no watcher was attached: the previous --next exit left
    // the cursor at sequence 0.
    const finishedAt = new Date(f.nowMs).toISOString();
    Object.assign(f.state.actions[0], {
      status: 'succeeded',
      startedAt: new Date(f.nowMs - 40_000).toISOString(),
      finishedAt,
      attempts: 1,
    });
    f.state.attempts[0] = { ...f.state.attempts[0], status: 'succeeded', finishedAt };
    f.emit('action.finished', { actionId: 'write-report', status: 'succeeded' });
    const missedSequence = f.state.events.sequence;

    let replayed = '';
    const code = await runWorkflowWatch(f.home, f.runId, {
      next: true, afterSequence: 0, now: () => f.nowMs,
      output: { write: (text) => { replayed += text; } },
    });
    assert.equal(code, 0);
    assert.equal(replayed.match(/✓ write-report finished · 40s/g)?.length, 1, replayed);
    assert.equal(replayed.match(/✓ Level 1 · write-report completed · 1\/1/g)?.length, 1, replayed);
    assert.doesNotMatch(replayed, /watching/);

    // The same level is terminal on disk on the next relaunch, but it happened
    // before the new cursor, so it is not reported again.
    f.emit('planner.finished', { ok: true, turn: 2, kind: 'program', summary: 'Second turn.' });
    let again = '';
    const nextCode = await runWorkflowWatch(f.home, f.runId, {
      next: true, afterSequence: missedSequence, now: () => f.nowMs,
      output: { write: (text) => { again += text; } },
    });
    assert.equal(nextCode, 0);
    assert.match(again, /◇ plan updated #2 · Second turn\./);
    assert.doesNotMatch(again, /Level 1|write-report finished/);
  } finally { f.cleanup(); }
});

test('V2 --since suppresses a stall the previous watcher reported and keeps a later crossing', async () => {
  const carried = v2Fixture({ shortId: 'snc234' });
  carried.state.attempts[0].lastActivityAt = new Date(carried.nowMs - 10_000).toISOString();
  carried.save();
  const watch = startWatch(carried, { next: true, stallAfterMs: 1_000, sinceMs: carried.nowMs });
  try {
    // Silence crossed 1s after the last activity, long before this launch's
    // --since, so the previous watcher already printed that stall line.
    await afterFirstPoll();
    assert.equal(watch.output, '', `stall re-fired on relaunch: ${watch.output}`);
    carried.state.attempts[0].lastActivityAt = new Date(carried.nowMs).toISOString();
    carried.save();
    assert.equal(await Promise.race([
      watch.promise,
      sleep(3000).then(() => { throw new Error(`recovery hung: ${watch.output}`); }),
    ]), 0);
    assert.match(watch.output, /↻ write-report active again after 10s/);
    assert.doesNotMatch(watch.output, /silent for/);
  } finally {
    await settleWatch(carried, watch);
    carried.cleanup();
  }

  const fresh = v2Fixture({ shortId: 'snf234' });
  try {
    fresh.state.attempts[0].lastActivityAt = new Date(fresh.nowMs - 10_000).toISOString();
    fresh.save();
    let output = '';
    // The crossing is exactly at --since: the previous watcher exited before
    // it, so this launch owns the report.
    const code = await runWorkflowWatch(fresh.home, fresh.runId, {
      next: true, stallAfterMs: 1_000, sinceMs: fresh.nowMs - 9_000, now: () => fresh.nowMs,
      output: { write: (text) => { output += text; } },
    });
    assert.equal(code, 0);
    assert.match(output, /⚠ write-report silent for 10s · command-code\/claude-opus-5 · still running, not auto-killed/);
  } finally { fresh.cleanup(); }
});

test('V2 --next ends with a relaunch line, and jsonl carries the cursor as a sequence field instead', async () => {
  const human = v2Fixture({ shortId: 'rel234' });
  try {
    Object.assign(human.state.actions[0], {
      status: 'succeeded',
      startedAt: new Date(human.nowMs - 40_000).toISOString(),
      finishedAt: new Date(human.nowMs).toISOString(),
      attempts: 1,
    });
    human.emit('action.finished', { actionId: 'write-report', status: 'succeeded' });
    let output = '';
    const code = await runWorkflowWatch(human.home, human.runId, {
      next: true, now: () => human.nowMs, afterSequence: 0,
      output: { write: (text) => { output += text; } },
    });
    assert.equal(code, 0);
    const lines = output.split('\n').filter((line) => line.length > 0);
    assert.equal(
      lines.at(-1),
      `next: bullswarm workflow watch rel234 --next --after ${human.state.events.sequence}`
        + ` --since ${new Date(human.nowMs).toISOString()}`,
      output,
    );
    assert.equal(lines.filter((line) => line.startsWith('next: ')).length, 1, output);
    assert.doesNotMatch(output, /outcome:/);
  } finally { human.cleanup(); }

  const jsonl = v2Fixture({ shortId: 'rlj234' });
  try {
    Object.assign(jsonl.state.actions[0], {
      status: 'succeeded',
      startedAt: new Date(jsonl.nowMs - 40_000).toISOString(),
      finishedAt: new Date(jsonl.nowMs).toISOString(),
      attempts: 1,
    });
    jsonl.emit('action.finished', { actionId: 'write-report', status: 'succeeded' });
    let output = '';
    const code = await runWorkflowWatch(jsonl.home, jsonl.runId, {
      next: true, jsonl: true, now: () => jsonl.nowMs, afterSequence: 0,
      output: { write: (text) => { output += text; } },
    });
    assert.equal(code, 0);
    assert.doesNotMatch(output, /next: /);
    const objects = output.split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line));
    assert.equal(objects.length, 1, output);
    for (const item of objects) assert.equal(item.sequence, jsonl.state.events.sequence);
    assert.equal(objects[0].type, 'action.finished');
  } finally { jsonl.cleanup(); }
});

test('V2 jsonl emits one object per notable event with documented type fields', async () => {
  const f = v2Fixture({ shortId: 'jsn234' });
  try {
    const watch = startWatch(f, { jsonl: true, verbose: true });
    try {
      await waitUntil(() => watch.lines().some((line) => JSON.parse(line).type === 'attach'), `attach missing: ${watch.output}`);
      const attach = JSON.parse(watch.lines()[0]);
      assert.equal(attach.type, 'attach');
      assert.equal(attach.runId, f.runId);
      assert.equal(attach.shortId, 'jsn234');
      assert.equal(attach.status, 'running');
      assert.equal(attach.running, 1);
      assert.equal(attach.waiting, 1);
      assert.equal(attach.elapsedSec, 60);
      assert.equal(attach.sequence, 0);
      assert.ok(attach.at);

      f.emit('attempt.started', {
        actionId: 'write-report', attemptId: 'write-report-1',
        pool: 'command-code', model: 'claude-opus-5',
      });
      f.emit('action.finished', { actionId: 'write-report', status: 'succeeded' });
      Object.assign(f.state.actions[0], {
        status: 'succeeded',
        startedAt: new Date(f.nowMs - 40_000).toISOString(),
        finishedAt: new Date(f.nowMs).toISOString(),
        attempts: 1,
      });
      f.state.ledger.requirements['requirement-1'].status = 'passed';
      f.state.ledger.requirements['requirement-2'].status = 'failed';
      f.emit('evidence.recorded', {
        actionId: 'inspect-report',
        requirements: ['requirement-1', 'requirement-2'],
        statuses: { 'requirement-1': 'passed', 'requirement-2': 'failed' },
      });
      f.emit('planner.finished', { ok: true, turn: 1, kind: 'program', summary: 'Write then inspect.' });
      f.emit('workflow.cancellation_requested', { reason: 'operator', source: 'cli' });
      f.emit('presentation.stage_completed', {
        stageId: 'r1-implementation', label: 'Implementation', status: 'completed', completed: 1, total: 1,
      });
      f.emit('steering.delivered', { steeringId: 'steer-1' });
      await waitUntil(() => watch.lines().some((line) => {
        try { return JSON.parse(line).type === 'steering.delivered'; } catch { return false; }
      }), `jsonl events missing: ${watch.output}`);

      const objects = watch.lines().map((line) => JSON.parse(line));
      const byType = Object.fromEntries(objects.map((item) => [item.type, item]));
      for (const item of objects) {
        assert.equal(item.runId, f.runId);
        assert.equal(item.shortId, 'jsn234');
        assert.ok(item.at);
        assert.ok(item.type);
      }
      assert.equal(byType['action.started'].actionId, 'write-report');
      assert.equal(byType['action.started'].pool, 'command-code');
      assert.equal(byType['action.started'].model, 'claude-opus-5');
      assert.equal(byType['action.started'].attempt, 1);
      assert.equal(byType['action.finished'].actionId, 'write-report');
      assert.equal(byType['action.finished'].status, 'succeeded');
      assert.equal(byType['action.finished'].durationSec, 40);
      assert.equal(byType['evidence.recorded'].actionId, 'inspect-report');
      assert.deepEqual(byType['evidence.recorded'].requirements, [
        { id: 'requirement-1', status: 'passed' },
        { id: 'requirement-2', status: 'failed' },
      ]);
      assert.equal(byType['planner.finished'].ok, true);
      assert.equal(byType['planner.finished'].turn, 1);
      assert.equal(byType['planner.finished'].summary, 'Write then inspect.');
      assert.equal(byType['cancellation.requested'].reason, 'operator');
      assert.equal(byType['cancellation.requested'].source, 'cli');
      assert.equal(byType['stage.completed'].label, 'Implementation');
      assert.equal(byType['stage.completed'].status, 'completed');
      assert.equal(byType['stage.completed'].completed, 1);
      assert.equal(byType['stage.completed'].total, 1);
      assert.equal(byType['steering.delivered'].steeringId, 'steer-1');

      f.state.lifecycle = {
        ...f.state.lifecycle,
        status: 'completed',
        finishedAt: new Date(f.nowMs).toISOString(),
        resultFile: join(f.runDir, 'result.json'),
      };
      f.save();
      assert.equal(await watch.promise, 0);
      const finished = watch.lines().map((line) => JSON.parse(line)).find((item) => item.type === 'finished');
      assert.equal(finished.status, 'completed');
      assert.equal(finished.delivered, true);
    } finally { await settleWatch(f, watch); }
  } finally { f.cleanup(); }

  const stalled = v2Fixture({ shortId: 'jss234' });
  stalled.state.attempts[0].lastActivityAt = new Date(stalled.nowMs).toISOString();
  stalled.save();
  const stallWatch = startWatch(stalled, { jsonl: true, stallAfterMs: 1000, next: true });
  try {
    await afterFirstPoll();
    stalled.nowMs += 5_000;
    assert.equal(await Promise.race([
      stallWatch.promise,
      sleep(3000).then(() => { throw new Error(`jsonl stall --next hung: ${stallWatch.output}`); }),
    ]), 0);
    const objects = stallWatch.lines().map((line) => JSON.parse(line));
    const stall = objects.find((item) => item.type === 'agent.stalled');
    assert.ok(stall, stallWatch.output);
    assert.equal(stall.actionId, 'write-report');
    assert.equal(stall.silentSec, 5);
    assert.equal(stall.pool, 'command-code');
    assert.equal(stall.model, 'claude-opus-5');
    assert.ok(stall.attemptId);
    assert.doesNotMatch(stallWatch.output, /"type":"attach"/);
  } finally {
    await settleWatch(stalled, stallWatch);
    stalled.cleanup();
  }

  const paused = v2Fixture({ shortId: 'jsp234', running: false });
  try {
    paused.state.lifecycle.status = 'waiting';
    paused.state.planner.awaiting = {
      boundary: 'initial', turn: 1,
      requestPath: '/tmp/request.json', candidatePath: '/tmp/candidate.json',
      since: new Date(paused.nowMs).toISOString(),
    };
    paused.save();
    let output = '';
    await runWorkflowWatch(paused.home, paused.runId, {
      jsonl: true, next: true, now: () => paused.nowMs, output: { write: (text) => { output += text; } },
    });
    const pausedEvent = JSON.parse(output.trim().split('\n').at(-1));
    assert.equal(pausedEvent.type, 'paused');
    assert.equal(pausedEvent.boundary, 'initial');
    assert.equal(pausedEvent.turn, 1);
    assert.equal(pausedEvent.cancellationRequested, false);
  } finally { paused.cleanup(); }

  const dead = v2Fixture({ shortId: 'jsi234' });
  try {
    dead.state.runner = { pid: 999999999, lastHeartbeatAt: new Date(dead.nowMs).toISOString() };
    dead.save();
    let output = '';
    await runWorkflowWatch(dead.home, dead.runId, {
      jsonl: true, next: true, now: () => dead.nowMs, output: { write: (text) => { output += text; } },
    });
    const interrupted = JSON.parse(output.trim().split('\n').at(-1));
    assert.equal(interrupted.type, 'interrupted');
    assert.equal(interrupted.status, 'interrupted');
  } finally { dead.cleanup(); }
});

test('V2 heartbeat stays off unless heartbeatMs is a positive opt-in', async () => {
  const off = v2Fixture({ shortId: 'hbo234' });
  try {
    const watch = startWatch(off);
    try {
      await waitUntil(() => watch.output.includes('● watching hbo234'), `attach missing: ${watch.output}`);
      off.nowMs += 90_000;
      markRunnerLive(off.state, off.nowMs);
      off.save();
      await sleep(250);
      assert.doesNotMatch(watch.output, /♡/);
      assert.equal(watch.lines().length, 1);
    } finally { await settleWatch(off, watch); }
  } finally { off.cleanup(); }

  const on = v2Fixture({ shortId: 'hbn234' });
  try {
    const watch = startWatch(on, { heartbeatMs: 2_000 });
    try {
      await waitUntil(() => watch.output.includes('● watching hbn234'), `attach missing: ${watch.output}`);
      on.nowMs += 3_000;
      markRunnerLive(on.state, on.nowMs);
      on.save();
      await waitUntil(() => watch.output.includes('♡'), `opt-in heartbeat missing: ${watch.output}`);
      assert.match(watch.output, /♡ \+1m03s 1 running, 1 waiting/);
    } finally { await settleWatch(on, watch); }
  } finally { on.cleanup(); }
});

test('V2 verbose-only lines are absent by default and appear with verbose', async () => {
  const quiet = v2Fixture({ shortId: 'vrq234' });
  try {
    const watch = startWatch(quiet);
    try {
      await waitUntil(() => watch.output.includes('● watching vrq234'), `attach missing: ${watch.output}`);
      quiet.emit('attempt.finished', { actionId: 'write-report', status: 'failed', failureKind: 'timeout' });
      quiet.emit('attempt.started', {
        actionId: 'write-report', attemptId: 'write-report-2',
        pool: 'command-code', model: 'claude-opus-5',
      });
      quiet.emit('steering.delivered', { steeringId: 'steer-1' });
      Object.assign(quiet.state.actions[0], {
        status: 'succeeded',
        startedAt: new Date(quiet.nowMs - 40_000).toISOString(),
        finishedAt: new Date(quiet.nowMs).toISOString(),
        attempts: 2,
      });
      quiet.emit('action.finished', { actionId: 'write-report', status: 'succeeded' });
      await waitUntil(() => watch.output.includes('write-report finished'), `finish missing: ${watch.output}`);
      assert.doesNotMatch(watch.output, /▶ |↺ |→ /);
      assert.match(watch.output, /✓ write-report finished · 40s/);
    } finally { await settleWatch(quiet, watch); }
  } finally { quiet.cleanup(); }

  const verbose = v2Fixture({ shortId: 'vrb234' });
  try {
    const watch = startWatch(verbose, { verbose: true });
    try {
      await waitUntil(() => watch.output.includes('● watching vrb234'), `attach missing: ${watch.output}`);
      verbose.state.attempts.push({
        id: 'write-report-2', actionId: 'write-report', ordinal: 2, status: 'running',
        pool: 'command-code', model: 'claude-opus-5',
        startedAt: new Date(verbose.nowMs).toISOString(), finishedAt: null,
        lastActivityAt: new Date(verbose.nowMs).toISOString(), outputBytesObserved: 0,
      });
      verbose.emit('attempt.finished', { actionId: 'write-report', status: 'failed', failureKind: 'timeout' });
      verbose.emit('attempt.started', {
        actionId: 'write-report', attemptId: 'write-report-2',
        pool: 'command-code', model: 'claude-opus-5',
      });
      verbose.emit('steering.delivered', { steeringId: 'steer-1' });
      await waitUntil(() => watch.output.includes('steering delivered'), `verbose lines missing: ${watch.output}`);
      assert.match(watch.output, /↺ write-report retrying · timeout/);
      assert.match(watch.output, /▶ write-report started · command-code\/claude-opus-5 · attempt 2/);
      assert.match(watch.output, /→ steering delivered/);
    } finally { await settleWatch(verbose, watch); }
  } finally { verbose.cleanup(); }
});

test('--classic forces the transition-plus-heartbeat stream for a V2 run and never prints event lines', async () => {
  const f = v2Fixture({ shortId: 'cls234' });
  try {
    const watch = startWatch(f, { classic: true, intervalMs: 20 });
    try {
      await waitUntil(() => watch.lines().length >= 1, `no initial snapshot line: ${watch.output}`);
      assert.match(watch.output, /1 running, 1 waiting/);
      assert.doesNotMatch(watch.output, /● watching|✓ |✗ |◆ |◇ |⚠ |↺ |⧖ |↻ /);
      const beforeHeartbeat = watch.output;
      // No opt-in --heartbeat was given, so classic falls back to the historical
      // 60s legacy heartbeat; the injectable clock advances past it directly.
      f.nowMs += 61_000;
      markRunnerLive(f.state, f.nowMs);
      f.save();
      await waitUntil(() => watch.output.includes('♡'), `60s heartbeat missing: ${watch.output}`);
      assert.ok(watch.output.length > beforeHeartbeat.length, watch.output);
      assert.doesNotMatch(watch.output, /● watching|✓ |✗ |◆ |◇ |⚠ |↺ |⧖ |↻ /);
    } finally { await settleWatch(f, watch); }
  } finally { f.cleanup(); }
});

test('the CLI rejects --classic combined with --next', () => {
  const home = mkdtempSync(join(tmpdir(), 'bs-watch-cliflags-'));
  try {
    const cliPath = resolve('bin/bullswarm.js');
    const result = spawnSync(process.execPath, [cliPath, 'workflow', 'watch', 'anytoken', '--classic', '--next'], {
      encoding: 'utf8', env: { ...process.env, BULLSWARM_HOME: home },
    });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /--classic cannot combine with --next/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('V2 watch reports a usage-limit quota failure once, then the pool it moved to, in order', async () => {
  const f = v2Fixture({ shortId: 'qta234' });
  try {
    const watch = startWatch(f);
    try {
      await waitUntil(() => watch.output.includes('● watching qta234'), `attach missing: ${watch.output}`);
      const untilMs = f.nowMs + 10 * 60_000;
      writeFileSync(join(f.home, 'state.json'), JSON.stringify({
        pools: { 'command-code': { quarantine: { until: untilMs, reason: 'usage limit', kind: 'quota' } } },
      }));
      f.state.attempts[0] = {
        ...f.state.attempts[0],
        status: 'failed',
        failureKind: 'quota',
        why: 'usage limit: "You\'ve hit your session limit · resets 8:20pm" · pool paused until '
          + new Date(untilMs).toISOString(),
        finishedAt: new Date(f.nowMs).toISOString(),
      };
      f.emit('attempt.finished', { actionId: 'write-report', attemptId: 'write-report-1', status: 'failed', failureKind: 'quota' });
      await waitUntil(() => watch.output.includes('usage limit on command-code'), `quota line missing: ${watch.output}`);
      assert.match(watch.output, /⚠ write-report usage limit on command-code · paused until \S+ · retrying on another pool/);
      assert.equal(watch.output.match(/usage limit on command-code/g)?.length, 1, watch.output);
      assert.doesNotMatch(watch.output, /now on relay/);

      f.state.attempts.push({
        id: 'write-report-2', actionId: 'write-report', ordinal: 2, status: 'running',
        pool: 'relay', model: 'gpt-5.6-luna',
        startedAt: new Date(f.nowMs).toISOString(), finishedAt: null,
        lastActivityAt: new Date(f.nowMs).toISOString(), outputBytesObserved: 0,
      });
      f.emit('attempt.started', { actionId: 'write-report', attemptId: 'write-report-2', pool: 'relay', model: 'gpt-5.6-luna' });
      await waitUntil(() => watch.output.includes('now on relay'), `moved line missing: ${watch.output}`);
      assert.match(watch.output, /↺ write-report now on relay · gpt-5\.6-luna/);
      assert.equal(watch.output.match(/now on relay/g)?.length, 1, watch.output);
      const quotaIndex = watch.output.indexOf('usage limit on command-code');
      const movedIndex = watch.output.indexOf('now on relay');
      assert.ok(quotaIndex >= 0 && movedIndex > quotaIndex, watch.output);
      assert.doesNotMatch(watch.output, /write-report retrying/);
    } finally { await settleWatch(f, watch); }
  } finally { f.cleanup(); }
});

test('V2 jsonl carries the attempt.quota and attempt.moved fields', async () => {
  const f = v2Fixture({ shortId: 'qtj234' });
  try {
    const watch = startWatch(f, { jsonl: true });
    try {
      await waitUntil(() => watch.lines().some((line) => JSON.parse(line).type === 'attach'), `attach missing: ${watch.output}`);
      const untilMs = f.nowMs + 10 * 60_000;
      writeFileSync(join(f.home, 'state.json'), JSON.stringify({
        pools: { 'command-code': { quarantine: { until: untilMs, reason: 'usage limit', kind: 'quota' } } },
      }));
      f.state.attempts[0] = {
        ...f.state.attempts[0],
        status: 'failed',
        failureKind: 'quota',
        why: 'usage limit: "session limit"',
        finishedAt: new Date(f.nowMs).toISOString(),
      };
      f.emit('attempt.finished', { actionId: 'write-report', attemptId: 'write-report-1', status: 'failed', failureKind: 'quota' });
      await waitUntil(() => watch.lines().some((line) => {
        try { return JSON.parse(line).type === 'attempt.quota'; } catch { return false; }
      }), `attempt.quota jsonl missing: ${watch.output}`);
      const quotaEvent = watch.lines().map((line) => JSON.parse(line)).find((item) => item.type === 'attempt.quota');
      assert.equal(quotaEvent.actionId, 'write-report');
      assert.equal(quotaEvent.attemptId, 'write-report-1');
      assert.equal(quotaEvent.pool, 'command-code');
      assert.equal(quotaEvent.why, 'usage limit: "session limit"');
      assert.equal(quotaEvent.until, new Date(untilMs).toISOString());

      f.state.attempts.push({
        id: 'write-report-2', actionId: 'write-report', ordinal: 2, status: 'running',
        pool: 'relay', model: 'gpt-5.6-luna',
        startedAt: new Date(f.nowMs).toISOString(), finishedAt: null,
        lastActivityAt: new Date(f.nowMs).toISOString(), outputBytesObserved: 0,
      });
      f.emit('attempt.started', { actionId: 'write-report', attemptId: 'write-report-2', pool: 'relay', model: 'gpt-5.6-luna' });
      await waitUntil(() => watch.lines().some((line) => {
        try { return JSON.parse(line).type === 'attempt.moved'; } catch { return false; }
      }), `attempt.moved jsonl missing: ${watch.output}`);
      const movedEvent = watch.lines().map((line) => JSON.parse(line)).find((item) => item.type === 'attempt.moved');
      assert.equal(movedEvent.actionId, 'write-report');
      assert.equal(movedEvent.attemptId, 'write-report-2');
      assert.equal(movedEvent.pool, 'relay');
      assert.equal(movedEvent.model, 'gpt-5.6-luna');
      assert.equal(watch.lines().filter((line) => JSON.parse(line).type === 'attempt.quota').length, 1, watch.output);
      assert.equal(watch.lines().filter((line) => JSON.parse(line).type === 'attempt.moved').length, 1, watch.output);
    } finally { await settleWatch(f, watch); }
  } finally { f.cleanup(); }
});
