import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createV2GoalDocument, createV2State } from '../src/workflow/v2-state.js';
import { applyV2PlannerResponse } from '../src/workflow/v2-planner.js';
import { readKernelStderrTail } from '../src/workflow/short-id.js';
import { runWorkflowWatch } from '../src/workflow/watch-cli.js';
import { dashboardRows, renderDetails, renderWorkflowTui } from '../src/workflow/dashboard.js';

const BIN = join(new URL('..', import.meta.url).pathname.replace(/\/$/, ''), 'bin', 'bullswarm.js');

function deadRun({ withLog = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'bs-dead-kernel-'));
  const runId = 'wf-dead-kernel-abcdef';
  const shortId = 'dkr234';
  const runDir = join(home, 'workflows', runId);
  mkdirSync(runDir, { recursive: true });
  mkdirSync(join(home, 'connectors'), { recursive: true });
  const goal = createV2GoalDocument({
    goal: 'Diagnose a dead kernel',
    cwd: '/tmp/repo',
    requirements: [{ id: 'requirement-1', text: 'The dead kernel is diagnosable' }],
    settings: { scout: false },
  });
  let state = createV2State(goal, { runId, shortId });
  state = applyV2PlannerResponse(state, {
    schemaVersion: 'bullswarm.workflow.planner-response.v2',
    kind: 'program',
    summary: 'Run the fixture.',
    program: {
      schemaVersion: 'bullswarm.workflow.program.v2',
      actions: [{
        id: 'inspect', purpose: 'Inspect the fixture', dependsOn: [], affects: ['requirement-1'],
        ownedFiles: [], prompt: 'Inspect it.', lane: 'analyze', effort: 'low', evidenceFor: [], inputs: [], produces: [],
      }, {
        id: 'verify', purpose: 'Verify the fixture', dependsOn: ['inspect'], affects: [], ownedFiles: [],
        prompt: 'Read the fixture and verify the requirement.', lane: 'analyze', effort: 'low', evidenceFor: ['requirement-1'], inputs: [], produces: [],
      }],
    },
  });
  state.lifecycle = {
    status: 'running',
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    finishedAt: null,
    resultFile: null,
  };
  state.actions[0].status = 'running';
  state.actions[0].startedAt = new Date(Date.now() - 30_000).toISOString();
  state.runner = { pid: 999_999_999, lastHeartbeatAt: new Date().toISOString() };
  writeFileSync(join(runDir, 'state.json'), `${JSON.stringify(state)}\n`);
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1, pools: {}, incumbents: {}, decisionLog: [], config: { depthLimit: 2, callerName: 'test' },
  }));
  if (withLog) {
    const stderrDir = join(home, 'goals', runId);
    mkdirSync(stderrDir, { recursive: true });
    writeFileSync(join(stderrDir, 'stderr.log'), `${Array.from({ length: 25 }, (_, index) => `trace line ${index + 1}`).join('\n')}\n`);
  }
  return {
    home,
    runId,
    shortId,
    runDir,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

function run(home, args) {
  return spawnSync(process.execPath, [BIN, ...args], {
    env: { ...process.env, BULLSWARM_HOME: home },
    encoding: 'utf8',
    timeout: 30_000,
  });
}

test('dead-kernel stderr tail is capped at the last 20 lines', () => {
  const fixture = deadRun();
  try {
    assert.deepEqual(readKernelStderrTail(fixture.runDir), Array.from({ length: 20 }, (_, index) => `trace line ${index + 6}`));
  } finally { fixture.cleanup(); }
});

test('watch exposes the dead-kernel log in classic and event JSONL modes', async () => {
  const fixture = deadRun();
  try {
    let classic = '';
    assert.equal(await runWorkflowWatch(fixture.home, fixture.shortId, {
      once: true, classic: true, output: { write: (text) => { classic += text; } },
    }), 0);
    assert.match(classic, /outcome: interrupted; edits retained/);
    assert.match(classic, /kernel log:\n  trace line 6\n.*trace line 25/s);

    let eventOutput = '';
    assert.equal(await runWorkflowWatch(fixture.home, fixture.shortId, {
      jsonl: true, output: { write: (text) => { eventOutput += text; } },
    }), 1);
    const interrupted = eventOutput.trim().split('\n').map((line) => JSON.parse(line)).find((line) => line.type === 'interrupted');
    assert.deepEqual(interrupted.kernelStderrTail, Array.from({ length: 20 }, (_, index) => `trace line ${index + 6}`));
  } finally { fixture.cleanup(); }
});

test('runs show and result expose the dead-kernel log, and TUI hints that it exists', () => {
  const fixture = deadRun();
  try {
    const shown = run(fixture.home, ['workflow', 'runs', 'show', fixture.shortId]);
    assert.equal(shown.status, 0, shown.stderr);
    assert.match(shown.stdout, /kernel log:\n  trace line 6\n.*trace line 25/s);

    const shownJson = run(fixture.home, ['workflow', 'runs', 'show', fixture.shortId, '--json']);
    assert.equal(shownJson.status, 0, shownJson.stderr);
    assert.deepEqual(JSON.parse(shownJson.stdout).kernelStderrTail, Array.from({ length: 20 }, (_, index) => `trace line ${index + 6}`));

    const result = run(fixture.home, ['workflow', 'runs', 'result', fixture.shortId, '--json']);
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stdout).kernelStderrTail, Array.from({ length: 20 }, (_, index) => `trace line ${index + 6}`));

    const row = dashboardRows(fixture.home, { all: true })[0];
    assert.match(renderDetails(row, { interactive: false }), /kernel log: available/);
    assert.match(renderWorkflowTui(row, { width: 120, height: 30 }), /kernel log: available/);
  } finally { fixture.cleanup(); }
});

test('dead-kernel surfaces preserve output when stderr.log is absent', async () => {
  const fixture = deadRun({ withLog: false });
  try {
    let output = '';
    assert.equal(await runWorkflowWatch(fixture.home, fixture.shortId, {
      once: true, classic: true, output: { write: (text) => { output += text; } },
    }), 0);
    assert.doesNotMatch(output, /kernel log/);

    const shown = run(fixture.home, ['workflow', 'runs', 'show', fixture.shortId, '--json']);
    assert.equal(shown.status, 0, shown.stderr);
    assert.equal(Object.hasOwn(JSON.parse(shown.stdout), 'kernelStderrTail'), false);

    const result = run(fixture.home, ['workflow', 'runs', 'result', fixture.shortId, '--json']);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
  } finally { fixture.cleanup(); }
});
