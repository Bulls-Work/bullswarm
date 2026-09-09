// The kernel's per-attempt byte ledger (`state.attempts[].bytes`), measured
// end-to-end through the real CLI and the shipped echo worker: every number
// here is a real file size, so a task file the kernel did not write cannot
// make these assertions pass.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve('.');
const CLI = join(REPO, 'bin', 'bullswarm.js');

// `{bullswarmDir}` in a connector spawn command resolves to the repository root
// (src/lib/watch.js:28), so the shipped echo connector always spawns the
// repository's own deterministic worker; only the connector definition and
// state.json have to live in the temporary home.
function echoHome(t, prefix = 'bullswarm-bytes-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bullswarmDir = join(root, 'home');
  const workspace = join(root, 'repo');
  mkdirSync(join(bullswarmDir, 'connectors'), { recursive: true });
  mkdirSync(workspace);
  writeFileSync(join(bullswarmDir, 'connectors', 'echo.json'), readFileSync(join(REPO, 'connectors', 'echo.json')));
  writeFileSync(join(bullswarmDir, 'state.json'), `${JSON.stringify({
    version: 1, pools: { echo: { enabled: true } }, incumbents: {}, decisionLog: [],
    config: { depthLimit: 2, callerName: 'claude-code' },
  }, null, 2)}\n`);
  return { root, bullswarmDir, workspace };
}

function runProgram(home, goal, actions, extraArgs = []) {
  const programPath = join(home.root, 'program.json');
  writeFileSync(programPath, JSON.stringify({ schemaVersion: 'bullswarm.workflow.program.v2', actions }));
  const executed = spawnSync(process.execPath, [
    CLI, 'workflow', 'goal', goal, '--cwd', home.workspace,
    '--program', programPath, '--foreground', '--json', ...extraArgs,
  ], {
    encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, BULLSWARM_HOME: home.bullswarmDir, BULLSWARM_DEPTH: '0' },
  });
  assert.equal(executed.status, 0, executed.stderr || executed.stdout);
  const result = JSON.parse(executed.stdout);
  const runDir = join(home.bullswarmDir, 'workflows', result.runId);
  return {
    result,
    runDir,
    state: JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8')),
    goalDocument: JSON.parse(readFileSync(join(runDir, 'goal.json'), 'utf8')),
  };
}

const writer = (id, over = {}) => ({
  id, purpose: `Deliver ${id}`, dependsOn: [], affects: ['requirement-1'], ownedFiles: [`${id}.txt`],
  prompt: `Implement ${id} and report the focused checks you ran.`, lane: 'build', effort: 'low',
  evidenceFor: [], inputs: [], produces: [], ...over,
});

test('every dispatched attempt records real task, prompt, dependency and output bytes', { timeout: 120_000 }, (t) => {
  const home = echoHome(t);
  const second = writer('second', {
    dependsOn: ['first'],
    prompt: 'Read the first action output in full, then reconcile it and report exactly what you validated.',
  });
  const run = runProgram(home, 'Deliver two ordered slices and validate them.', [writer('first'), second]);

  assert.equal(run.result.status, 'completed');
  assert.equal(run.state.attempts.length, 2);
  const attemptFor = (id) => run.state.attempts.findLast((attempt) => attempt.actionId === id);
  const firstAttempt = attemptFor('first');
  const secondAttempt = attemptFor('second');

  // The requirement text the kernel embedded in the task file, read from the
  // durable goal document rather than restated here.
  const requirementText = run.goalDocument.intent.requirements.find((item) => item.id === 'requirement-1').text;
  const requirementBytes = Buffer.byteLength(requirementText, 'utf8');

  for (const [id, attempt] of [['first', firstAttempt], ['second', secondAttempt]]) {
    const action = run.state.program.actions.find((entry) => entry.id === id);
    assert.deepEqual(Object.keys(attempt.bytes).sort(), ['authorPrompt', 'dependencyInputs', 'kernel', 'output', 'taskFile']);
    assert.equal(attempt.bytes.taskFile, statSync(attempt.taskFile).size, `${id} taskFile bytes must equal the file on disk`);
    assert.equal(attempt.bytes.authorPrompt, Buffer.byteLength(action.prompt, 'utf8'));
    assert.equal(attempt.bytes.kernel, attempt.bytes.taskFile - attempt.bytes.authorPrompt - requirementBytes);
    assert.ok(attempt.bytes.taskFile > attempt.bytes.authorPrompt, `${id} task file must be larger than the author prompt`);
    assert.equal(attempt.bytes.output, statSync(attempt.outputFile).size, `${id} output bytes must equal its durable out file`);
  }

  // The whole point of the ledger: what the dependency handed the consumer.
  assert.equal(firstAttempt.bytes.dependencyInputs, 0, 'an action with no dependency reads nothing');
  assert.equal(secondAttempt.bytes.dependencyInputs, statSync(firstAttempt.outputFile).size);
  assert.ok(secondAttempt.bytes.dependencyInputs > 0);

  // The task file really does point the second action at that exact file.
  const secondTask = readFileSync(secondAttempt.taskFile, 'utf8');
  assert.ok(secondTask.includes(firstAttempt.outputFile), 'the dependency artifact list names the first out file');
});

test('a read-only action with no requirement context attributes every byte to kernel or prompt', { timeout: 120_000 }, (t) => {
  const home = echoHome(t);
  const report = {
    id: 'report', purpose: 'Report on the delivered slice', dependsOn: ['first'], affects: [], ownedFiles: [],
    prompt: 'Read the dependency output and report what it claims.', lane: 'analyze', effort: 'low',
    evidenceFor: [], inputs: [], produces: [],
  };
  const run = runProgram(home, 'Deliver one slice, then report on it.', [writer('first'), report]);
  const attempt = run.state.attempts.findLast((entry) => entry.actionId === 'report');
  assert.equal(attempt.bytes.kernel, attempt.bytes.taskFile - attempt.bytes.authorPrompt);
  assert.equal(attempt.bytes.taskFile, statSync(attempt.taskFile).size);
  assert.equal(attempt.bytes.output, statSync(attempt.outputFile).size);
});
