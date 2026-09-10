import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync,
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
    const result = run(f.home, ['health', '--json']);
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.gateFailures.length, 1);
    assert.equal(report.gateFailures[0].rejudge, 'pass');
    assert.equal(report.gateFailures[0].gateAteWork, true);
    // Without --json the same finding is reported in human form, same exit.
    const human = run(f.home, ['health']);
    assert.equal(human.status, 1);
    assert.match(human.stdout, /bullswarm health — UNHEALTHY/);
    assert.match(human.stdout, /gate failures: 1/);
    assert.match(human.stdout, /the verify gate ate real work/);
  } finally { f.cleanup(); }
});

test('health calls a fresh home with an empty decision log healthy', () => {
  const f = sandbox();
  try {
    const result = run(f.home, ['health', '--json']);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.healthy, true);
    assert.equal(report.decisionLogSize, 0);
    assert.equal(report.gateFailures.length, 0);
    assert.equal(report.quarantined.length, 0);
    // The human summary must agree with the document, and the fix hint only
    // belongs on a report that has something to fix.
    const human = run(f.home, ['health']);
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /bullswarm health — HEALTHY/);
    assert.match(human.stdout, /decision log: 0 entries/);
    assert.doesNotMatch(human.stdout, /fix:/);
  } finally { f.cleanup(); }
});

test('health still flags a quarantine cluster when the decision log is empty', () => {
  const f = sandbox();
  try {
    const state = JSON.parse(readFileSync(join(f.home, 'state.json'), 'utf8'));
    const until = Date.now() + 10 * 60_000;
    state.pools['local-agent'].quarantine = { until, reason: 'auth', kind: 'auth' };
    state.pools.other = { enabled: true, quarantine: { until, reason: 'auth', kind: 'auth' } };
    writeFileSync(join(f.home, 'state.json'), `${JSON.stringify(state)}\n`);
    const result = run(f.home, ['health', '--json']);
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.healthy, false);
    assert.equal(report.decisionLogSize, 0);
    assert.equal(report.quarantineCluster.length, 2);
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

// --- reasoning ---------------------------------------------------------------
// `bullswarm run` resolves ONE reasoning level per dispatch and has to agree
// with itself in three places: the argv it previews, the argv it spawns, and
// the record it reports. These run the real binary against a fixture pool.

/** Point the sandbox pool at a worker that echoes its own argv, and declare reasoning. */
function reasoningSandbox({ levels = ['low', 'medium', 'high'], defaults = { low: 'medium' } } = {}) {
  const f = sandbox();
  const worker = join(f.home, 'argv-worker.mjs');
  writeFileSync(worker, [
    "const argv = process.argv.slice(2);",
    "console.log('## Completed\\n');",
    "console.log('Ran the bounded task and captured the spawn evidence below.\\n');",
    "console.log('- Spawned argv: ' + JSON.stringify(argv));",
    "console.log('- Read and executed every directive in ' + argv[0] + '.');",
    "console.log('- Ran the focused checks: all passed with exit code 0.');",
    "",
  ].join('\n'));
  const connectorPath = join(f.home, 'connectors', 'local-agent.json');
  const connector = JSON.parse(readFileSync(connectorPath, 'utf8'));
  connector.spawn.cmd = [process.execPath, worker, '{taskFile}'];
  connector.reasoning = { flag: '--effort', levels, defaults };
  writeFileSync(connectorPath, JSON.stringify(connector));
  return f;
}

test('run --dry-run --json previews the real command with the resolved reasoning flag', () => {
  const f = reasoningSandbox();
  try {
    const preview = verdict(run(f.home, [
      'run', '--lane', 'chore', '--reasoning', 'max', '--dry-run', '--json', 'PREVIEW_TASK',
    ]));
    assert.equal(preview.dryRun, true);
    assert.equal(preview.pick.pool, 'local-agent');
    // max is above everything this connector accepts: clamped down to high,
    // and the clamp is on the record rather than silently applied.
    assert.deepEqual(preview.reasoning, {
      requested: 'max', applied: 'high', source: 'run', clamped: true,
    });
    const command = preview.pick.command;
    assert.equal(command.at(-2), '--effort');
    assert.equal(command.at(-1), 'high');

    // A preview dispatches nothing and records nothing.
    assert.equal(existsSync(join(f.home, 'runs')) ? readdirSync(join(f.home, 'runs')).length : 0, 0);
    assert.deepEqual(JSON.parse(readFileSync(join(f.home, 'state.json'), 'utf8')).decisionLog, []);

    // The preview and the live spawn come from the same builder: everything
    // after the task-file argument is identical (the two runs get their own
    // task-file stamps, so those are compared by position, not by value).
    const live = verdict(run(f.home, [
      'run', '--lane', 'chore', '--reasoning', 'max', '--json', 'LIVE_TASK',
    ]));
    assert.equal(live.ok, true);
    const observed = JSON.parse(
      readFileSync(live.outFile, 'utf8').match(/Spawned argv: (\[.*\])/)[1],
    );
    assert.deepEqual(observed, [live.taskFile, '--effort', 'high']);
    const afterTaskFile = (argv) => argv.slice(argv.findIndex((arg) => arg.endsWith('.md')) + 1);
    assert.deepEqual(afterTaskFile(command), ['--effort', 'high']);
    assert.deepEqual(afterTaskFile(observed), afterTaskFile(command));
  } finally { f.cleanup(); }
});

test('run reports the resolved reasoning level in its verdict and its decision log', () => {
  const f = reasoningSandbox();
  try {
    // Nothing asked: the connector's own default for the chore tier (low).
    const fromConnector = verdict(run(f.home, ['run', '--lane', 'chore', '--json', 'TASK']));
    assert.deepEqual(fromConnector.reasoning, {
      requested: 'medium', applied: 'medium', source: 'connector', clamped: false,
    });
    assert.deepEqual(fromConnector.meta.reasoning, fromConnector.reasoning);
    const observed = JSON.parse(
      readFileSync(fromConnector.outFile, 'utf8').match(/Spawned argv: (\[.*\])/)[1],
    );
    assert.deepEqual(observed.slice(1), ['--effort', 'medium']);

    const logged = JSON.parse(readFileSync(join(f.home, 'state.json'), 'utf8')).decisionLog;
    assert.equal(logged.length, 1);
    assert.deepEqual(logged[0].reasoning, fromConnector.reasoning);

    // `default` means "append nothing and let the CLI's own config decide".
    const silent = verdict(run(f.home, [
      'run', '--lane', 'chore', '--reasoning', 'default', '--json', 'TASK',
    ]));
    assert.deepEqual(silent.reasoning, {
      requested: 'default', applied: null, source: 'run', clamped: false,
    });
    const silentArgv = JSON.parse(
      readFileSync(silent.outFile, 'utf8').match(/Spawned argv: (\[.*\])/)[1],
    );
    assert.deepEqual(silentArgv.slice(1), []);
  } finally { f.cleanup(); }
});

test('a pool whose connector declares no reasoning is dispatched without a flag', () => {
  const f = reasoningSandbox();
  try {
    const connectorPath = join(f.home, 'connectors', 'local-agent.json');
    const connector = JSON.parse(readFileSync(connectorPath, 'utf8'));
    delete connector.reasoning;
    writeFileSync(connectorPath, JSON.stringify(connector));
    const result = verdict(run(f.home, [
      'run', '--lane', 'chore', '--reasoning', 'high', '--json', 'TASK',
    ]));
    assert.deepEqual(result.reasoning, {
      requested: 'high', applied: null, source: 'unsupported', clamped: false,
    });
    const observed = JSON.parse(
      readFileSync(result.outFile, 'utf8').match(/Spawned argv: (\[.*\])/)[1],
    );
    assert.deepEqual(observed.slice(1), []);
  } finally { f.cleanup(); }
});

test('run rejects an unknown or valueless --reasoning with exit 2 before dispatching', () => {
  const f = reasoningSandbox();
  try {
    const bogus = run(f.home, ['run', '--lane', 'chore', '--reasoning', 'ludicrous', 'TASK', '--json']);
    assert.equal(bogus.status, 2);
    assert.match(bogus.stderr, /--reasoning must be one of low, medium, high, xhigh, max, default/);
    assert.equal(bogus.stdout, '');
    const missing = run(f.home, ['run', '--lane', 'chore', '--reasoning', '--json', 'TASK']);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /--reasoning requires a value/);
    assert.equal(existsSync(join(f.home, 'runs')) ? readdirSync(join(f.home, 'runs')).length : 0, 0);
  } finally { f.cleanup(); }
});
