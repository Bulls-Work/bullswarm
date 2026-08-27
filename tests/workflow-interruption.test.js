import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runWorkflow } from '../src/workflow/runner.js';
import { readEvents } from '../src/workflow/events.js';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test('SIGTERM durably interrupts an active delegate and the run resumes cleanly', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-sigterm-'));
  const bullswarmDir = join(root, '.bullswarm');
  const worker = join(root, 'worker.mjs');
  const driver = join(root, 'driver.mjs');
  mkdirSync(join(bullswarmDir, 'connectors'), { recursive: true });
  writeFileSync(worker, 'setTimeout(() => process.stdout.write("Slow delegated task eventually produced concrete verified output."), 10000);\n');
  const doc = {
    name: 'signal-recovery', description: 'signal recovery', inputs: {},
    settings: { concurrency: 1, retryAttempts: 0 },
    phases: [{ name: 'work', steps: [{ id: 'slow', type: 'run', lane: 'chore', prompt: 'Run the bounded task.' }] }],
  };
  const connector = {
    name: 'slow', spawn: { cmd: ['node', worker, '{taskFile}'], cwdMode: 'task-file-dir' },
    authSignatures: [], outputExtraction: { strategy: 'stdout' }, meter: { type: 'none' },
    lanes: ['chore'], capabilities: [], timeoutSec: 30,
  };
  const pools = [{ name: 'slow', connector, enabled: true, lanes: ['chore'], capabilities: [], pace: 0 }];
  writeFileSync(driver, [
    `import { runWorkflow } from ${JSON.stringify(pathToFileURL(join(REPO, 'src/workflow/runner.js')).href)};`,
    `const doc = ${JSON.stringify(doc)};`,
    `const connector = ${JSON.stringify(connector)};`,
    `const pools = [{name:'slow',connector,enabled:true,lanes:['chore'],capabilities:[],pace:0}];`,
    `const result = await runWorkflow({bullswarmDir:${JSON.stringify(bullswarmDir)},doc,pools,inputs:{}});`,
    'process.stdout.write(JSON.stringify({runId:result.runId,status:result.state.status}));',
  ].join('\n'));

  try {
    const runner = spawn(process.execPath, [driver], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    runner.stdout.on('data', (chunk) => { stdout += chunk; });
    runner.stderr.on('data', (chunk) => { stderr += chunk; });

    let runId = null;
    let childPid = null;
    for (let i = 0; i < 100 && !childPid; i++) {
      await delay(25);
      try {
        runId ??= readdirSync(join(bullswarmDir, 'workflows')).find((name) => name.startsWith('wf-')) ?? null;
        if (runId) {
          const state = JSON.parse(readFileSync(join(bullswarmDir, 'workflows', runId, 'state.json'), 'utf8'));
          childPid = Object.values(state.activeAgents ?? {}).find((agent) => agent.childPid)?.childPid ?? null;
        }
      } catch { /* state is not durable yet */ }
    }
    assert.ok(runId, 'runner did not create a durable run');
    assert.ok(childPid, 'delegate child never became observable');
    runner.kill('SIGTERM');
    const exit = await new Promise((resolve) => runner.on('close', (code, signal) => resolve({ code, signal })));
    assert.deepEqual(exit, { code: 0, signal: null }, stderr || stdout);

    const runDir = join(bullswarmDir, 'workflows', runId);
    const interrupted = JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8'));
    assert.equal(interrupted.status, 'interrupted');
    assert.equal(interrupted.recovery.resumable, true);
    assert.equal(interrupted.interruptionSignal, 'SIGTERM');
    assert.equal(interrupted.attempts[0].status, 'cancelled');
    assert.equal(alive(childPid), false);
    assert.ok(readEvents(runDir).some((event) => event.type === 'run.interrupted'));
    const interruptedReport = JSON.parse(readFileSync(join(runDir, 'report.json'), 'utf8'));
    assert.equal(interruptedReport.interruption.signal, 'SIGTERM');
    assert.equal(interruptedReport.recovery.resumable, true);

    writeFileSync(worker, 'process.stdout.write("Resumed delegated task produced concrete verified output and completed successfully.");\n');
    const resumed = await runWorkflow({ bullswarmDir, doc, pools, inputs: {}, resumeRunId: runId });
    assert.equal(resumed.state.status, 'completed');
    assert.equal(resumed.state.interruptionSignal, undefined);
    assert.equal(resumed.state.recovery, undefined);
    assert.equal(resumed.state.resumeHistory.at(-1).status, 'interrupted');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
