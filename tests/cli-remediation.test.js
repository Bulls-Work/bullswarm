import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { bumpVersion, release } from '../src/lib/release.js';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const BIN = join(REPO, 'bin', 'bullswarm.js');

function sandbox() {
  const home = mkdtempSync(join(tmpdir(), 'bs-cli-remediation-'));
  mkdirSync(join(home, 'connectors'), { recursive: true });
  writeFileSync(join(home, 'connectors', 'local-agent.json'), JSON.stringify({
    name: 'local-agent', costRank: 1, lanes: ['analyze', 'build', 'chore'],
    spawn: { cmd: ['node', join(REPO, 'connectors', 'echo-worker.mjs'), '{taskFile}'], cwdMode: 'task-file-dir' },
    authSignatures: [], outputExtraction: { strategy: 'stdout' },
    meter: { type: 'none' }, flags: { stealth: false }, timeoutSec: 60,
  }));
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1,
    pools: { 'local-agent': { enabled: true } },
    incumbents: {},
    decisionLog: [],
    config: { depthLimit: 2, callerName: 'claude-code' },
  }));
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

function run(home, args) {
  return spawnSync(process.execPath, [BIN, ...args], {
    env: { ...process.env, BULLSWARM_HOME: home },
    encoding: 'utf8',
    timeout: 30_000,
  });
}

function verdict(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('top-level run accepts prompt, positional, and task-file task forms', () => {
  const f = sandbox();
  try {
    const prompt = verdict(run(f.home, ['run', '--lane', 'chore', '--prompt', 'PROMPT_TASK', '--json']));
    const positional = verdict(run(f.home, ['run', '--lane', 'chore', 'POSITIONAL_TASK', '--json']));
    const taskPath = join(f.home, 'task.md');
    writeFileSync(taskPath, 'FILE_TASK');
    const file = verdict(run(f.home, ['run', '--lane', 'chore', '--task-file', taskPath, '--json']));
    assert.equal(prompt.ok, true);
    assert.equal(readFileSync(prompt.taskFile, 'utf8'), 'PROMPT_TASK');
    assert.equal(positional.ok, true);
    assert.equal(readFileSync(positional.taskFile, 'utf8'), 'POSITIONAL_TASK');
    assert.equal(file.ok, true);
    assert.equal(readFileSync(file.taskFile, 'utf8'), 'FILE_TASK');
  } finally { f.cleanup(); }
});

test('top-level run rejects empty and ambiguous task usage with exit 2', () => {
  const f = sandbox();
  try {
    const empty = run(f.home, ['run', '--lane', 'chore', '--json']);
    assert.equal(empty.status, 2);
    assert.match(empty.stderr, /empty task/);
    const both = run(f.home, ['run', '--lane', 'chore', '--prompt', 'x', 'y', '--json']);
    assert.equal(both.status, 2);
    assert.match(both.stderr, /choose one/);
    const missingPromptValue = run(f.home, ['run', '--lane', 'chore', '--prompt', '--json']);
    assert.equal(missingPromptValue.status, 2);
    assert.match(missingPromptValue.stderr, /require a value/);
  } finally { f.cleanup(); }
});

test('top-level run validates heartbeat interval before dispatch', () => {
  const f = sandbox();
  try {
    const result = run(f.home, ['run', '--lane', 'chore', '--heartbeat', '0', 'TASK', '--json']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /heartbeat.*greater than or equal to 1/);
    assert.equal(result.stdout, '');
    const missing = run(f.home, ['run', '--lane', 'chore', '--heartbeat', '--json', 'TASK']);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /heartbeat.*greater than or equal to 1/);
  } finally { f.cleanup(); }
});

test('top-level run heartbeat keeps JSON stdout clean and emits aggregate stderr only', () => {
  const f = sandbox();
  try {
    const worker = join(f.home, 'slow-worker.mjs');
    writeFileSync(worker, `setTimeout(() => console.log(${JSON.stringify('## Completed\n\nImplemented the bounded task and verified the requested behavior with focused regression evidence. The result is complete, concrete, and saved for inspection.')}), 1150);\n`);
    const connectorPath = join(f.home, 'connectors', 'local-agent.json');
    const connector = JSON.parse(readFileSync(connectorPath, 'utf8'));
    connector.spawn.cmd = ['node', worker, '{taskFile}'];
    writeFileSync(connectorPath, JSON.stringify(connector));

    const result = run(f.home, ['run', '--lane', 'chore', '--heartbeat', '1', 'TASK', '--json']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).ok, true);
    // Timer callbacks can fire a fraction before or after the exact wall-clock
    // boundary on a loaded machine. Assert the stable heartbeat structure and
    // aggregate counters without coupling the test to sub-second scheduling.
    assert.match(result.stderr, /^bullswarm run · active \d+s · 0 events · 0 B · activity \d+s ago\n$/);
  } finally { f.cleanup(); }
});

test('health rejudges saved content instead of trusting the saved exit verdict', () => {
  const f = sandbox();
  try {
    const outFile = join(f.home, 'runs', 'out-saved.md');
    mkdirSync(join(f.home, 'runs'), { recursive: true });
    writeFileSync(outFile, '## Completed\n\n- Verified the saved artifact with concrete evidence across the requested source files.\n- Confirmed the behavior with the focused non-network regression suite and recorded the exact output path.\n- The implementation preserves successful machine-readable output while separating usage errors from runtime failures.\n');
    const state = JSON.parse(readFileSync(join(f.home, 'state.json'), 'utf8'));
    state.decisionLog.push({ outFile, ok: false });
    writeFileSync(join(f.home, 'state.json'), `${JSON.stringify(state)}\n`);
    const result = run(f.home, ['health']);
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.gateFailures.length, 1);
    assert.equal(report.gateFailures[0].rejudge, 'pass');
    assert.equal(report.gateFailures[0].gateAteWork, true);
  } finally { f.cleanup(); }
});

test('version bumping is deterministic and dry-run release behavior is safe', () => {
  assert.equal(bumpVersion('0.10.7', 'patch'), '0.10.8');
  assert.equal(bumpVersion('0.10.7', 'minor'), '0.11.0');
  assert.equal(bumpVersion('0.10.7', 'major'), '1.0.0');
  const repo = mkdtempSync(join(tmpdir(), 'bs-release-clean-'));
  try {
    writeFileSync(join(repo, 'package.json'), `${JSON.stringify({ name: 'fixture', version: '0.10.7' })}\n`);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['add', 'package.json'], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=Bullswarm Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'], { cwd: repo });
    assert.deepEqual(release('patch', { dryRun: true, repoRoot: repo }), {
      from: '0.10.7', to: '0.10.8', tag: 'v0.10.8', dryRun: true,
    });
    writeFileSync(join(repo, 'dirty.txt'), 'dirty\n');
    assert.throws(() => release('patch', { dryRun: true, repoRoot: repo }), /working tree is dirty/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
