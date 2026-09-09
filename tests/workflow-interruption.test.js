// Signal interruption is a durability contract, not a cleanup nicety: a
// SIGTERM'd kernel must leave a resumable run behind, kill the delegate it
// spawned, and release its in-flight ledger booking — and the resume must then
// finish the same run without replaying completed work.
//
// The V1 authored-graph runner used to own this test. It now runs against the
// V2 kernel: a real child kernel, a real connector and a real delegate child
// process, with no provider dispatched and no network.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listAssignments } from '../src/lib/assignments.js';
import { createV2GoalDocument } from '../src/workflow/v2-state.js';
import { runV2AutonomousWorkflow } from '../src/workflow/v2-runtime.js';
import { readEvents } from '../src/workflow/events.js';

const runtimeUrl = new URL('../src/workflow/v2-runtime.js', import.meta.url).href;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function until(predicate, description, timeout = 8000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out: ${description}`);
    await delay(25);
  }
}

test('SIGTERM durably interrupts an active delegate and the run resumes cleanly', { timeout: 30_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-sigterm-'));
  const bullswarmDir = join(root, '.bullswarm');
  const cwd = join(root, 'repo');
  const worker = join(root, 'worker.mjs');
  const driver = join(root, 'driver.mjs');
  const resumeFile = join(root, 'resume-ok');
  const runId = 'wf-sigterm-abcdef';
  mkdirSync(join(bullswarmDir, 'connectors'), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, 'a.txt'), 'seed\n');
  writeFileSync(join(cwd, 'user-note.txt'), 'preserve me');
  // First attempt: touch the owned file, then stay alive so the SIGTERM lands
  // on a genuinely running delegate. After resume: finish with real output.
  writeFileSync(worker, `
import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const target = join(${JSON.stringify(cwd)}, 'a.txt');
if (existsSync(${JSON.stringify(resumeFile)})) {
  appendFileSync(target, 'resumed\\n');
  process.stdout.write('Completed the requested change after resume: appended the required line to a.txt, re-read the file to confirm it, and checked that the untouched user note is intact.');
  process.exit(0);
}
appendFileSync(target, 'partial\\n');
setTimeout(() => process.stdout.write('never reached'), 30000);
`);
  writeFileSync(join(bullswarmDir, 'connectors', 'interrupt-agent.json'), JSON.stringify({
    name: 'interrupt-agent', bin: 'node', configDirs: [],
    spawn: { cmd: ['node', worker, '{taskFile}'], cwdMode: 'add-dir' },
    authSignatures: [], outputExtraction: { strategy: 'stdout' },
    meter: { type: 'none' }, costRank: 1,
    lanes: ['analyze', 'build', 'chore'],
    capabilities: ['code-reading', 'file-editing'], knownModels: ['fixture-model'],
  }));
  writeFileSync(join(bullswarmDir, 'state.json'), JSON.stringify({
    version: 1, pools: { 'interrupt-agent': { enabled: true } },
    incumbents: {}, decisionLog: [], config: { depthLimit: 2 },
  }));

  const goal = createV2GoalDocument({
    goal: 'Append the required line to a.txt',
    cwd,
    requirements: [{ id: 'deliver', text: 'a.txt carries the appended line' }],
    settings: { scout: false, plannerMode: 'caller', executionMode: 'program', workspaceMode: 'shared' },
  });
  const program = {
    schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program',
    summary: 'Append one line to the owned file.',
    program: {
      schemaVersion: 'bullswarm.workflow.program.v2',
      actions: [{
        id: 'append', purpose: 'Append the required line to a.txt', dependsOn: [],
        affects: ['deliver'], ownedFiles: ['a.txt'], prompt: 'Append the required line to a.txt.',
        lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: [],
      }],
    },
  };
  writeFileSync(driver, `
import { runV2AutonomousWorkflow } from ${JSON.stringify(runtimeUrl)};
const out = await runV2AutonomousWorkflow({
  bullswarmDir: ${JSON.stringify(bullswarmDir)},
  goalDocument: ${JSON.stringify(goal)},
  runId: ${JSON.stringify(runId)},
  initialPlannerResponse: ${JSON.stringify(program)},
});
process.stdout.write(JSON.stringify({ runId: out.runId, status: out.state.lifecycle.status }));
`);

  const workerPids = [];
  t.after(() => {
    for (const pid of workerPids) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
    rmSync(root, { recursive: true, force: true });
  });

  const kernel = spawn(process.execPath, [driver], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, BULLSWARM_HOME: bullswarmDir, BULLSWARM_DEPTH: '0' },
  });
  let stdout = '';
  let stderr = '';
  kernel.stdout.on('data', (chunk) => { stdout += chunk; });
  kernel.stderr.on('data', (chunk) => { stderr += chunk; });

  // Wait until the delegate has genuinely started working — otherwise the
  // signal could land before the child ever touched its owned file, and the
  // "work survives an interruption" assertion below would prove nothing.
  await until(
    () => readFileSync(join(cwd, 'a.txt'), 'utf8').includes('partial'),
    'delegate child started editing its owned file',
  );
  // The in-flight ledger is the durable record of a live delegate, so it is
  // also how the test learns the real child pid.
  const booked = await until(
    () => listAssignments(bullswarmDir).find((entry) => entry.workerPid) ?? null,
    'kernel registered an in-flight delegate with a real child pid',
  );
  assert.equal(booked.source, 'workflow-v2');
  assert.equal(booked.pool, 'interrupt-agent');
  assert.equal(booked.runId, runId);
  assert.equal(booked.actionId, 'append');
  const childPid = booked.workerPid;
  workerPids.push(childPid);
  assert.ok(childPid > 0, 'delegate child never became observable');

  kernel.kill('SIGTERM');
  const exit = await new Promise((resolve) => kernel.on('close', (code, signal) => resolve({ code, signal })));
  assert.deepEqual(exit, { code: 0, signal: null }, stderr || stdout);

  const runDir = join(bullswarmDir, 'workflows', runId);
  const interrupted = JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8'));
  assert.equal(interrupted.lifecycle.status, 'interrupted');
  assert.equal(interrupted.lifecycle.finishedAt, null, 'an interrupted run is not terminal');
  assert.equal(interrupted.actions[0].status, 'interrupted');
  assert.equal(interrupted.actions[0].lastFailure.kind, 'interrupted');
  assert.equal(interrupted.attempts[0].status, 'interrupted');
  assert.ok(readEvents(runDir).some((event) => event.type === 'workflow.interrupted'));
  await until(() => !alive(childPid), 'signal drained the delegate child');
  assert.deepEqual(listAssignments(bullswarmDir), [], 'the interrupted attempt released its booking');
  // Work the delegate had already done survives the interruption.
  assert.equal(readFileSync(join(cwd, 'a.txt'), 'utf8'), 'seed\npartial\n');

  writeFileSync(resumeFile, 'finish on the next attempt');
  const resumed = await runV2AutonomousWorkflow({ bullswarmDir, resumeRunId: runId });
  assert.equal(resumed.result.status, 'completed', JSON.stringify(resumed.result?.reason ?? null));
  assert.equal(resumed.state.lifecycle.status, 'completed');
  assert.ok(resumed.state.lifecycle.finishedAt, 'a resumed run reaches a terminal timestamp');
  assert.equal(resumed.state.actions.filter((action) => action.status === 'interrupted').length, 0);
  assert.equal(readFileSync(join(cwd, 'a.txt'), 'utf8'), 'seed\npartial\nresumed\n');
  assert.equal(readFileSync(join(cwd, 'user-note.txt'), 'utf8'), 'preserve me');
  assert.deepEqual(listAssignments(bullswarmDir), [], 'the resumed attempt released its booking too');
});
