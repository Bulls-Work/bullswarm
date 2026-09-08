import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createV2GoalDocument } from '../src/workflow/v2-state.js';
import { runV2AutonomousWorkflow } from '../src/workflow/v2-runtime.js';
import { requestCancel } from '../src/workflow/dashboard.js';
import { processIdentity } from '../src/workflow/v2-process.js';

const runtimeUrl = new URL('../src/workflow/v2-runtime.js', import.meta.url).href;
const cli = resolve('bin/bullswarm.js');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const action = { id: 'write', purpose: 'Write the requested files', dependsOn: [], affects: ['deliver'], ownedFiles: ['a.txt', 'b.txt'], prompt: 'Write the requested files.', lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: [] };
const program = { schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary: 'Write both files.', program: { schemaVersion: 'bullswarm.workflow.program.v2', actions: [action] } };
function fixture(t, workspaceMode = 'shared') {
  const root = mkdtempSync(join(tmpdir(), 'bs-v2-recovery-'));
  const home = join(root, 'home'); const cwd = join(root, 'repo');
  mkdirSync(home); mkdirSync(cwd);
  for (const name of ['a.txt', 'b.txt']) writeFileSync(join(cwd, name), 'seed\n');
  writeFileSync(join(cwd, 'user-note.txt'), 'preserve me');
  if (workspaceMode === 'isolated') {
    const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });
    git('init', '-q'); git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'seed');
  }
  const goal = createV2GoalDocument({ goal: 'Write both files', cwd, requirements: [{ id: 'deliver', text: 'Files are written' }], settings: { scout: false, plannerMode: 'caller', executionMode: 'program', workspaceMode } });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, home, cwd, goal };
}

for (const mode of ['shared', 'isolated', 'partial-integration', 'owned-conflict', 'receipt-only']) test(`real SIGKILL after successful attempt recovers ${mode} without replay`, { timeout: 10_000 }, async (t) => {
  const f = fixture(t, mode === 'shared' ? 'shared' : 'isolated');
  const runId = 'wf-receipt-abcdef';
  const script = join(f.root, 'kernel.mjs');
  writeFileSync(script, `
import { appendFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { runV2AutonomousWorkflow } from ${JSON.stringify(runtimeUrl)};
await runV2AutonomousWorkflow({ bullswarmDir: ${JSON.stringify(f.home)}, goalDocument: ${JSON.stringify(f.goal)}, runId: ${JSON.stringify(runId)}, initialPlannerResponse: ${JSON.stringify(program)},
  onEvent: (event) => { if (${JSON.stringify(mode)} !== 'partial-integration' && event.type === 'attempt.finished') process.kill(process.pid, 'SIGKILL'); },
  dependencies: {
    ${mode === 'receipt-only' ? `writeCompletionReceipt: (path, value) => { writeFileSync(path, JSON.stringify(value)); process.kill(process.pid, 'SIGKILL'); },` : ''}
    ${mode === 'partial-integration' ? `integrateIsolatedWorkspace: (workspace) => { copyFileSync(join(workspace.targetDir, 'a.txt'), join(workspace.sourceDir, 'a.txt')); process.kill(process.pid, 'SIGKILL'); },` : ''}
    dispatchV2Action: async (options) => {
      const files = options.paths(1);
      const record = { ordinal: 1, pool: 'fixture', model: 'fixture', status: 'running', startedAt: new Date().toISOString(), taskFile: files.taskFile, outFile: files.outFile };
      options.onAttempt('started', record);
      for (const name of ['a.txt', 'b.txt']) appendFileSync(join(options.targetDir, name), 'applied-once\\n');
      writeFileSync(files.outFile, 'Both concrete output files were updated and checked.');
      record.status = 'succeeded'; record.finishedAt = new Date().toISOString();
      const verdict = { ok: true, outFile: files.outFile };
      options.onAttempt('finished', record, verdict);
      return { ok: true, status: 'succeeded', attempts: [record], verdict };
    }
  }
});
`);
  const crashed = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 5000 });
  assert.equal(crashed.signal, 'SIGKILL', crashed.stderr);
  const runDir = join(f.home, 'workflows', runId);
  const state = JSON.parse(readFileSync(join(runDir, 'state.json')));
  assert.equal(state.actions[0].status, 'running');
  assert.equal(state.attempts[0].status, mode === 'receipt-only' ? 'running' : 'succeeded');
  assert.ok(existsSync(join(runDir, 'completion-write.json')));
  if (mode === 'owned-conflict') writeFileSync(join(f.cwd, 'a.txt'), 'new user edit');
  const result = await runV2AutonomousWorkflow({ bullswarmDir: f.home, resumeRunId: runId, dependencies: { dispatchV2Action: () => { throw new Error('completed worker must not run twice'); } } });
  if (mode === 'owned-conflict') {
    assert.equal(result.result.status, 'partial');
    assert.ok(result.result.workspace.warnings.some((warning) => warning.includes('retained isolated work')));
    assert.equal(readFileSync(join(f.cwd, 'a.txt'), 'utf8'), 'new user edit');
    const receipt = JSON.parse(readFileSync(join(runDir, 'completion-write.json')));
    assert.equal(readFileSync(join(receipt.isolated.targetDir, 'a.txt'), 'utf8'), 'seed\napplied-once\n');
    return;
  }
  assert.equal(result.result.status, 'completed');
  assert.equal(result.state.attempts.length, 1);
  for (const name of ['a.txt', 'b.txt']) assert.equal(readFileSync(join(f.cwd, name), 'utf8'), 'seed\napplied-once\n');
  assert.equal(readFileSync(join(f.cwd, 'user-note.txt'), 'utf8'), 'preserve me');
});

test('operator cancellation survives a kernel persist between request and cancellation poll', async (t) => {
  const f = fixture(t);
  const second = { ...action, id: 'later', dependsOn: ['write'], ownedFiles: ['later.txt'] };
  const seen = [];
  const result = await runV2AutonomousWorkflow({ bullswarmDir: f.home, goalDocument: f.goal, initialPlannerResponse: { ...program, program: { ...program.program, actions: [action, second] } },
    dependencies: { dispatchV2Action: async (options) => {
      seen.push(options.action.id);
      const files = options.paths(1);
      const record = { ordinal: 1, pool: 'fixture', model: 'fixture', status: 'running', startedAt: new Date().toISOString(), outFile: files.outFile };
      options.onAttempt('started', record);
      writeFileSync(files.outFile, 'Delivered concrete requested changes and checked files.');
      record.status = 'succeeded'; record.finishedAt = new Date().toISOString();
      options.onAttempt('finished', record);
      const runId = readdirSync(join(f.home, 'workflows'))[0];
      const path = join(f.home, 'workflows', runId, 'state.json');
      const before = readFileSync(path, 'utf8');
      requestCancel(f.home, runId);
      assert.equal(readFileSync(path, 'utf8'), before, 'operator must not roll kernel state backwards');
      return { ok: true, status: 'succeeded', attempts: [record], verdict: { ok: true, outFile: files.outFile } };
    } }
  });
  assert.deepEqual(seen, ['write']);
  assert.equal(result.result.status, 'cancelled');
  assert.equal(result.state.cancellation.requested, true);
});

async function until(predicate, description, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > deadline) throw new Error(`timed out: ${description}`); await delay(20); }
}
function runCli(f, args) {
  const child = spawn(process.execPath, [cli, 'workflow', 'goal', ...args], { env: { ...process.env, BULLSWARM_HOME: f.home, BULLSWARM_DEPTH: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { output += chunk; });
  const closed = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal, output })));
  return { child, closed };
}
for (const signal of ['SIGTERM', 'SIGKILL']) test(`real V2 CLI ${signal} stops prior workers before resume and retains edits`, { timeout: 20_000 }, async (t) => {
  const f = fixture(t);
  const worker = join(f.root, 'worker.mjs');
  const pidFile = join(f.root, 'worker.pid');
  const grandchildFile = join(f.root, 'grandchild.pid');
  const resumeFile = join(f.root, 'resume-ok');
  writeFileSync(worker, `
import { appendFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
if (existsSync(${JSON.stringify(resumeFile)})) {
  appendFileSync('a.txt', 'resumed\\n');
  process.stdout.write('Completed the requested work after resume, inspected the preserved file contents, and checked that the original user note is intact.');
} else {
  appendFileSync('a.txt', 'partial\\n');
  spawn(process.execPath, ['-e', ${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(grandchildFile)}, String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`)}], { stdio: 'ignore' });
  setInterval(() => process.stdout.write('Still working on the requested files.\\n'), 100);
}
`);
  mkdirSync(join(f.home, 'connectors'));
  writeFileSync(join(f.home, 'connectors', 'recovery-agent.json'), JSON.stringify({ name: 'recovery-agent', bin: 'node', configDirs: [], spawn: { cmd: ['node', worker, '{taskFile}'], cwdMode: 'add-dir' }, authSignatures: [], outputExtraction: { strategy: 'stdout' }, meter: { type: 'none' }, costRank: 1, lanes: ['analyze', 'build', 'chore'], capabilities: ['code-reading', 'file-editing'], knownModels: ['fixture-model'] }));
  writeFileSync(join(f.home, 'state.json'), JSON.stringify({ version: 1, pools: { 'recovery-agent': { enabled: true } }, incumbents: {}, decisionLog: [], config: { depthLimit: 2 } }));
  const plan = join(f.root, 'program.json');
  writeFileSync(plan, JSON.stringify({ ...program.program, actions: [{ ...action, affects: ['requirement-1'] }] }));
  const first = runCli(f, ['Write files', '--cwd', f.cwd, '--program', plan, '--foreground', '--json']);
  const children = [first.child]; const workerPids = [];
  t.after(() => { for (const child of children) { try { child.kill('SIGKILL'); } catch {} } for (const pid of workerPids) { try { process.kill(pid, 'SIGKILL'); } catch {} } });
  await until(() => existsSync(grandchildFile), 'delegate and grandchild started');
  const workerPid = Number(readFileSync(pidFile)); const grandchildPid = Number(readFileSync(grandchildFile));
  workerPids.push(workerPid, grandchildPid);
  const runId = readdirSync(join(f.home, 'workflows'))[0];
  first.child.kill(signal);
  const stopped = await first.closed;
  if (signal === 'SIGTERM') {
    assert.equal(stopped.code, 130, stopped.output);
    assert.equal(JSON.parse(readFileSync(join(f.home, 'workflows', runId, 'state.json'))).lifecycle.status, 'interrupted');
    const watched = spawnSync(process.execPath, [cli, 'workflow', 'watch', runId], { encoding: 'utf8', timeout: 3000, env: { ...process.env, BULLSWARM_HOME: f.home } });
    assert.equal(watched.status, 1, watched.stderr);
    assert.match(watched.stdout, /next: bullswarm workflow resume/);
    await until(() => !processIdentity(workerPid) && !processIdentity(grandchildPid), 'signal drained delegate process group');
  }
  assert.equal(readFileSync(join(f.cwd, 'a.txt'), 'utf8'), 'seed\npartial\n');
  writeFileSync(resumeFile, 'finish on next attempt');
  const resumed = runCli(f, ['--resume', runId, '--foreground', '--json']); children.push(resumed.child);
  const completed = await resumed.closed;
  assert.equal(completed.code, 0, completed.output);
  await until(() => !processIdentity(workerPid) && !processIdentity(grandchildPid), 'resume drained prior delegate process group');
  assert.equal(readFileSync(join(f.cwd, 'a.txt'), 'utf8'), 'seed\npartial\nresumed\n');
  assert.equal(readFileSync(join(f.cwd, 'user-note.txt'), 'utf8'), 'preserve me');
});


test('concurrent real resume kernels dispatch one replacement worker', { timeout: 10_000 }, async (t) => {
  const f = fixture(t);
  const runId = 'wf-concurrent-abcdef';
  // Publish an interrupted attempt through the real kernel, then kill it.
  const script = join(f.root, 'kernel.mjs');
  writeFileSync(script, `
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runV2AutonomousWorkflow } from ${JSON.stringify(runtimeUrl)};
const resume = process.argv[2] === 'resume';
try {
const result = await runV2AutonomousWorkflow({ bullswarmDir: ${JSON.stringify(f.home)},
  ...(resume ? { resumeRunId: ${JSON.stringify(runId)} } : { runId: ${JSON.stringify(runId)}, goalDocument: ${JSON.stringify(f.goal)}, initialPlannerResponse: ${JSON.stringify(program)} }),
  dependencies: { dispatchV2Action: async (options) => {
    const files = options.paths(1);
    const record = { ordinal: 1, pool: 'fixture', model: 'fixture', status: 'running', startedAt: new Date().toISOString(), outFile: files.outFile };
    options.onAttempt('started', record);
    if (!resume) process.kill(process.pid, 'SIGKILL');
    appendFileSync(join(options.targetDir, 'a.txt'), 'replacement\\n');
    await new Promise((resolve) => setTimeout(resolve, 250));
    writeFileSync(files.outFile, 'Delivered and checked the requested files.');
    record.status = 'succeeded'; record.finishedAt = new Date().toISOString();
    const verdict = { ok: true, outFile: files.outFile };
    options.onAttempt('finished', record, verdict);
    return { ok: true, status: 'succeeded', attempts: [record], verdict };
  } }
});
console.log(result.result.status);
} catch (error) { console.error(error.message); process.exitCode = 1; }
`);
  assert.equal(spawnSync(process.execPath, [script], { timeout: 3000 }).signal, 'SIGKILL');
  const start = () => {
    const child = spawn(process.execPath, [script, 'resume'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', (data) => { output += data; }); child.stderr.on('data', (data) => { output += data; });
    return new Promise((resolve) => child.on('close', (code) => resolve({ code, output })));
  };
  const results = await Promise.all([start(), start()]);
  assert.equal(results.filter((result) => result.code === 0).length, 1, JSON.stringify(results));
  assert.match(results.find((result) => result.code !== 0).output, /active kernel/);
  assert.equal(readFileSync(join(f.cwd, 'a.txt'), 'utf8'), 'seed\nreplacement\n');
});
