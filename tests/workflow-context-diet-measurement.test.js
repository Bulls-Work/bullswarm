// Requirement 4's measurement: the same goal run twice under a temporary home,
// once with three writers feeding an integrator directly and once with a
// `kind: "digest"` between them, so the bytes the integrator actually reads are
// observed rather than asserted. The numbers this test prints are the ones
// CHANGELOG.md 0.28.0 quotes, alongside the full versus `--summary` envelope
// size of the digest run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve('.');
const CLI = join(REPO, 'bin', 'bullswarm.js');
const GOAL = 'Deliver three slices and integrate them.';

// The shipped echo worker answers with a fixed ~360-byte completion whatever
// the prompt says, which would make three writers indistinguishable from one.
// This worker is just as deterministic and just as offline; it pads its answer
// to the size the task file asks for, so a writer really does hand the
// integrator a few KB.
const PADDING_WORKER = [
  "import { readFileSync } from 'node:fs';",
  "const task = readFileSync(process.argv[2], 'utf8');",
  "const pad = Number(task.match(/PAD:(\\d+)/)?.[1] ?? 0);",
  "process.stdout.write('## Completed\\n\\nDelivered the slice and ran the focused checks.\\n' + 'y'.repeat(pad) + '\\n');",
].join('\n');

const WRITER_PAD = 4096;

function fixtureHome(t) {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-diet-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bullswarmDir = join(root, 'home');
  const workspace = join(root, 'repo');
  mkdirSync(join(bullswarmDir, 'connectors'), { recursive: true });
  mkdirSync(workspace);
  const workerPath = join(root, 'worker.mjs');
  writeFileSync(workerPath, PADDING_WORKER);
  const connector = JSON.parse(readFileSync(join(REPO, 'connectors', 'echo.json'), 'utf8'));
  connector.name = 'local';
  connector.spawn = { cmd: ['node', workerPath, '{taskFile}'], cwdMode: 'task-file-dir' };
  writeFileSync(join(bullswarmDir, 'connectors', 'local.json'), JSON.stringify(connector));
  writeFileSync(join(bullswarmDir, 'state.json'), `${JSON.stringify({
    version: 1, pools: { local: { enabled: true } }, incumbents: {}, decisionLog: [],
    config: { depthLimit: 2, callerName: 'claude-code' },
  }, null, 2)}\n`);
  return { root, bullswarmDir, workspace };
}

const writer = (id, over = {}) => ({
  id,
  purpose: `Deliver ${id}`,
  dependsOn: [],
  affects: ['requirement-1'],
  ownedFiles: [`${id}.txt`],
  prompt: `Implement ${id} and report the focused checks you ran. PAD:${WRITER_PAD}`,
  lane: 'build',
  effort: 'low',
  evidenceFor: [],
  inputs: [],
  produces: [],
  ...over,
});

const integrator = (dependsOn) => writer('integrate', {
  purpose: 'Reconcile the delivered slices',
  dependsOn,
  ownedFiles: [],
  prompt: 'Reconcile every slice you were handed and run the repository gates.',
});

const WITHOUT_DIGEST = [writer('a1'), writer('a2'), writer('a3'), integrator(['a1', 'a2', 'a3'])];
const WITH_DIGEST = [
  writer('a1'), writer('a2'), writer('a3'),
  {
    id: 'condense',
    purpose: 'Condense the writer outputs',
    kind: 'digest',
    dependsOn: ['a1', 'a2', 'a3'],
    affects: [],
    ownedFiles: [],
    prompt: 'Keep every delivered item, every number and every shared-file request.',
    evidenceFor: [],
    inputs: [],
    produces: [],
  },
  integrator(['condense']),
];

function runProgram(home, actions, label) {
  const programPath = join(home.root, `program-${label}.json`);
  writeFileSync(programPath, JSON.stringify({ schemaVersion: 'bullswarm.workflow.program.v2', actions }));
  const executed = spawnSync(process.execPath, [
    CLI, 'workflow', 'goal', GOAL,
    '--cwd', home.workspace, '--program', programPath, '--concurrency', '3', '--foreground', '--json',
  ], {
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, BULLSWARM_HOME: home.bullswarmDir, BULLSWARM_DEPTH: '0' },
  });
  assert.equal(executed.status, 0, executed.stderr || executed.stdout);
  const result = JSON.parse(executed.stdout);
  assert.equal(result.status, 'completed');
  const state = JSON.parse(readFileSync(
    join(home.bullswarmDir, 'workflows', result.runId, 'state.json'), 'utf8',
  ));
  return { result, state };
}

const lastAttempt = (state, actionId) => state.attempts.findLast((attempt) => attempt.actionId === actionId);

test('a digest cuts what the integrator reads, measured on the same goal run twice', { timeout: 240_000 }, (t) => {
  const home = fixtureHome(t);

  const plain = runProgram(home, WITHOUT_DIGEST, 'a');
  const digested = runProgram(home, WITH_DIGEST, 'b');

  const withoutDigest = lastAttempt(plain.state, 'integrate').bytes.dependencyInputs;
  const withDigest = lastAttempt(digested.state, 'integrate').bytes.dependencyInputs;

  // Every writer really did hand over a few KB, so the saving is not an
  // artifact of a fixture that emits almost nothing.
  const writerOutputs = ['a1', 'a2', 'a3'].map((id) => lastAttempt(plain.state, id).bytes.output);
  for (const size of writerOutputs) assert.ok(size > WRITER_PAD, `writer output ${size} must clear the padding`);
  assert.equal(withoutDigest, writerOutputs.reduce((total, size) => total + size, 0));
  assert.equal(withDigest, lastAttempt(digested.state, 'condense').bytes.output);
  assert.ok(withDigest < withoutDigest, `digest run must read less: ${withDigest} !< ${withoutDigest}`);

  // The fixture worker answers with a fixed stub rather than a real
  // condensation, so `withDigest` is the floor. The ceiling is the byte target
  // the kernel writes into the digest's own task; assert the saving holds even
  // if a real digest spent its whole budget.
  const digestBudget = Number(
    readFileSync(lastAttempt(digested.state, 'condense').taskFile, 'utf8')
      .match(/Target at most (\d+) bytes in total/)[1],
  );
  assert.ok(withDigest <= digestBudget, `${withDigest} must fit the ${digestBudget}-byte budget`);
  assert.ok(digestBudget < withoutDigest, `even a budget-filling digest must beat ${withoutDigest} raw bytes`);

  const shortId = digested.result.shortId ?? digested.result.runId;
  const envelope = (args) => {
    const executed = spawnSync(process.execPath, [CLI, 'workflow', 'runs', 'result', shortId, ...args], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, BULLSWARM_HOME: home.bullswarmDir, BULLSWARM_DEPTH: '0' },
    });
    assert.equal(executed.status, 0, executed.stderr || executed.stdout);
    return Buffer.byteLength(executed.stdout, 'utf8');
  };
  const fullBytes = envelope(['--json']);
  const summaryBytes = envelope(['--summary']);
  assert.ok(summaryBytes < fullBytes, `summary ${summaryBytes} must be smaller than full ${fullBytes}`);

  // The numbers CHANGELOG.md 0.28.0 quotes.
  console.log(`context diet: integrator dependencyInputs without digest=${withoutDigest} with digest=${withDigest} (kernel digest budget for that input ${digestBudget})`);
  console.log(`context diet: run B envelope full=${fullBytes} summary=${summaryBytes}`);
});
