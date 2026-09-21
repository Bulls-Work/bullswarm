// `bullswarm home prune` and `bullswarm home status`, through the command
// entry point (in-process, console captured) and once through the real binary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cmdHome } from '../src/home-cli.js';
import { recordMaintenanceResult } from '../src/lib/retention.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'bullswarm.js');
const DAY = 86_400_000;
const iso = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString();

const cleanup = [];
test.after(() => { for (const dir of cleanup) rmSync(dir, { recursive: true, force: true }); });

function makeHome(retention) {
  const home = mkdtempSync(join(tmpdir(), 'bullswarm-home-cli-'));
  cleanup.push(home);
  const state = { version: 1, pools: {}, decisionLog: [] };
  if (retention !== undefined) state.retention = retention;
  writeFileSync(join(home, 'state.json'), JSON.stringify(state));
  return home;
}

function makeRun(home, runId, { status = 'completed', finishedAtDaysAgo = 10, bytes = 2048 } = {}) {
  const dir = join(home, 'workflows', runId);
  mkdirSync(join(dir, 'workspaces', 'fix'), { recursive: true });
  const lifecycle = { status, startedAt: iso(finishedAtDaysAgo + 1) };
  if (status !== 'running') lifecycle.finishedAt = iso(finishedAtDaysAgo);
  writeFileSync(join(dir, 'state.json'), JSON.stringify({
    schemaVersion: 'bullswarm.workflow.state.v2', runId, shortId: runId.slice(-6), lifecycle, actions: [], attempts: [],
  }));
  writeFileSync(join(dir, 'result.json'), '{"status":"completed"}');
  writeFileSync(join(dir, 'out-fix-attempt-1.md'), 'output');
  writeFileSync(join(dir, 'workspaces', 'fix', 'copy.txt'), 'x'.repeat(bytes));
  return dir;
}

function capture(fn) {
  const out = [];
  const err = [];
  const { log, error } = console;
  console.log = (...args) => out.push(args.join(' '));
  console.error = (...args) => err.push(args.join(' '));
  let code;
  try { code = fn(); } finally { console.log = log; console.error = error; }
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const home = (dir) => ({ bullswarmDir: dir });

test('home prune --dry-run --json lists candidates with bytes and deletes nothing', () => {
  const dir = makeHome();
  const run = makeRun(dir, 'wf-aaaaaa-000001');
  makeRun(dir, 'wf-bbbbbb-000002', { finishedAtDaysAgo: 2 });
  const { code, out } = capture(() => cmdHome(['prune', '--dry-run', '--json'], home(dir)));
  assert.equal(code, 0);
  const report = JSON.parse(out);
  assert.equal(report.dryRun, true);
  assert.deepEqual(report.candidates.map((candidate) => candidate.runId), ['wf-aaaaaa-000001']);
  assert.equal(report.candidates[0].workspaces[0].bytes, 2048);
  assert.equal(report.reclaimableBytes, 2048);
  assert.ok(existsSync(join(run, 'workspaces', 'fix', 'copy.txt')));
  assert.equal(existsSync(join(dir, 'maintenance', 'prune.json')), false);
});

test('home prune with no flag only lists, and says how to remove', () => {
  const dir = makeHome();
  const run = makeRun(dir, 'wf-aaaaaa-000001');
  const { code, out } = capture(() => cmdHome(['prune'], home(dir)));
  assert.equal(code, 0);
  assert.match(out, /dry run/);
  assert.match(out, /would remove 1 workspace from 1 run · 2\.00 KB/);
  assert.match(out, /workflows\/wf-aaaaaa-000001\/workspaces\/fix/);
  assert.match(out, /re-run with --yes/);
  assert.match(out, /never touched: state, results, reports, events, streams, task\/out\/diff files, history/);
  assert.ok(existsSync(join(run, 'workspaces')));
});

test('home prune --yes removes the workspaces, records the result, and leaves records alone', () => {
  const dir = makeHome();
  const run = makeRun(dir, 'wf-aaaaaa-000001');
  const running = makeRun(dir, 'wf-cccccc-000003', { status: 'running' });
  const before = ['state.json', 'result.json', 'out-fix-attempt-1.md'].map((name) => readFileSync(join(run, name), 'utf8'));
  const { code, out } = capture(() => cmdHome(['prune', '--yes'], home(dir)));
  assert.equal(code, 0);
  assert.match(out, /pruned/);
  assert.match(out, /removed 1 workspace from 1 run · 2\.00 KB/);
  assert.match(out, /wf-cccccc-000003 — status running is not a finished run/);
  assert.equal(existsSync(join(run, 'workspaces')), false);
  assert.ok(existsSync(join(running, 'workspaces', 'fix', 'copy.txt')), 'a running run is untouched');
  assert.deepEqual(['state.json', 'result.json', 'out-fix-attempt-1.md'].map((name) => readFileSync(join(run, name), 'utf8')), before);
  const record = JSON.parse(readFileSync(join(dir, 'maintenance', 'prune.json'), 'utf8'));
  assert.equal(record.trigger, 'manual');
  assert.equal(record.removedWorkspaces, 1);
});

test('home prune --days overrides the configured limit for one command', () => {
  const dir = makeHome({ enabled: true, workspacesDays: 30 });
  makeRun(dir, 'wf-aaaaaa-000001', { finishedAtDaysAgo: 10 });
  assert.equal(JSON.parse(capture(() => cmdHome(['prune', '--dry-run', '--json'], home(dir))).out).candidateRuns, 0);
  const report = JSON.parse(capture(() => cmdHome(['prune', '--dry-run', '--days', '5', '--json'], home(dir))).out);
  assert.equal(report.candidateRuns, 1);
  assert.equal(report.policy.workspacesDays, 5);
  assert.equal(JSON.parse(capture(() => cmdHome(['prune', '--dry-run', '--days=5', '--json'], home(dir))).out).candidateRuns, 1);
});

test('home prune rejects bad input before touching anything', () => {
  const dir = makeHome();
  const run = makeRun(dir, 'wf-aaaaaa-000001');
  const cases = [
    [['prune', '--dry-run', '--yes'], /cannot be combined/],
    [['prune', '--days', 'soon'], /--days must be a number greater than 0/],
    [['prune', '--days', '0'], /--days must be a number greater than 0/],
    [['prune', '--days'], /--days requires a value/],
    [['prune', '--bogus'], /unknown flag --bogus/],
    [['prune', 'extra'], /unexpected argument "extra"/],
    [['prune', '--auto', '--yes'], /--auto takes only the configured policy/],
    [['prune', '--trigger', 'kernel'], /--trigger only goes with --auto/],
    [['status', '--bogus'], /unknown flag --bogus/],
    [['status', 'extra'], /unexpected argument/],
  ];
  for (const [argv, pattern] of cases) {
    const { code, err } = capture(() => cmdHome(argv, home(dir)));
    assert.equal(code, 2, argv.join(' '));
    assert.match(err, pattern, argv.join(' '));
  }
  assert.ok(existsSync(join(run, 'workspaces', 'fix')));
});

test('home prune --auto honours the policy, records a background result, and is throttled', () => {
  const dir = makeHome();
  const run = makeRun(dir, 'wf-aaaaaa-000001');
  const first = capture(() => cmdHome(['prune', '--auto', '--trigger', 'dashboard', '--json'], home(dir)));
  assert.equal(first.code, 0);
  assert.equal(JSON.parse(first.out).removedWorkspaces, 1);
  assert.equal(existsSync(join(run, 'workspaces')), false);
  const record = JSON.parse(readFileSync(join(dir, 'maintenance', 'prune.json'), 'utf8'));
  assert.equal(record.trigger, 'dashboard');
  makeRun(dir, 'wf-bbbbbb-000002');
  const second = capture(() => cmdHome(['prune', '--auto', '--json'], home(dir)));
  assert.equal(second.code, 0);
  assert.equal(JSON.parse(second.out).skippedReason, 'swept recently');
  assert.ok(existsSync(join(dir, 'workflows', 'wf-bbbbbb-000002', 'workspaces')));
  assert.equal(capture(() => cmdHome(['prune', '--auto'], home(dir))).out, '', 'quiet without --json');
});

test('home prune --auto does nothing while retention is off', () => {
  const dir = makeHome({ enabled: false });
  const run = makeRun(dir, 'wf-aaaaaa-000001');
  const { code, out } = capture(() => cmdHome(['prune', '--auto', '--json'], home(dir)));
  assert.equal(code, 0);
  assert.equal(JSON.parse(out).skippedReason, 'retention is disabled');
  assert.ok(existsSync(join(run, 'workspaces')));
});

test('a no-op pass keeps the last real removal on record, and the list groups routine skips', () => {
  const dir = makeHome();
  makeRun(dir, 'wf-aaaaaa-000001');
  makeRun(dir, 'wf-bbbbbb-000002', { finishedAtDaysAgo: 1 });
  makeRun(dir, 'wf-cccccc-000003', { finishedAtDaysAgo: 2 });
  makeRun(dir, 'wf-dddddd-000004', { status: 'interrupted' });
  const dry = capture(() => cmdHome(['prune', '--dry-run'], home(dir))).out;
  assert.match(dry, /kept: 2 runs with workspaces still inside the 7-day limit/);
  assert.match(dry, /kept: 1 run left alone\n\s+wf-dddddd-000004 — status interrupted/);
  assert.doesNotMatch(dry, /wf-bbbbbb-000002 —/, 'a run inside the window is counted, not listed');
  capture(() => cmdHome(['prune', '--yes'], home(dir)));
  const again = capture(() => cmdHome(['prune', '--yes'], home(dir)));
  assert.match(again.out, /nothing to remove/);
  const record = JSON.parse(readFileSync(join(dir, 'maintenance', 'prune.json'), 'utf8'));
  assert.equal(record.removedWorkspaces, 0);
  assert.equal(record.lastRemoval.workspaces, 1);
  assert.equal(record.lastRemoval.bytes, 2048);
  const { out } = capture(() => cmdHome(['status'], home(dir)));
  assert.match(out, /last prune\s+just now · manual · nothing to remove/);
  assert.match(out, /last removal just now: 1 workspace from 1 run · 2\.00 KB/);
});

test('home status shows the policy, workspace bytes, and never-run jobs on a fresh home', () => {
  const dir = makeHome();
  makeRun(dir, 'wf-aaaaaa-000001');
  const { code, out } = capture(() => cmdHome(['status'], home(dir)));
  assert.equal(code, 0);
  assert.match(out, /retention\s+on · workspaces of finished runs go after 7 days/);
  assert.match(out, /workspaces\s+1 run · 2\.00 KB on disk · 2\.00 KB reclaimable now \(1 run\)/);
  assert.match(out, /last prune\s+never/);
  assert.match(out, /last reprice\s+never/);
});

test('home status shows the last prune and the last reprice with their triggers', () => {
  const dir = makeHome();
  makeRun(dir, 'wf-aaaaaa-000001');
  capture(() => cmdHome(['prune', '--yes'], home(dir)));
  recordMaintenanceResult(dir, 'reprice', { trigger: 'kernel', line: 'priced 6 attempts · 2 unmeasured' });
  const { code, out } = capture(() => cmdHome(['status'], home(dir)));
  assert.equal(code, 0);
  assert.match(out, /last prune\s+just now · manual · removed 1 workspace from 1 run · 2\.00 KB/);
  assert.match(out, /last reprice\s+just now · kernel · priced 6 attempts · 2 unmeasured/);
  assert.match(out, /workspaces\s+0 runs · 0 B on disk · 0 B reclaimable now/);
});

test('home status --json is machine-readable and carries every recorded job', () => {
  const dir = makeHome({ enabled: true, workspacesDays: 3 });
  makeRun(dir, 'wf-aaaaaa-000001', { finishedAtDaysAgo: 4 });
  recordMaintenanceResult(dir, 'reprice', { trigger: 'dashboard', line: 'nothing to price' });
  const status = JSON.parse(capture(() => cmdHome(['status', '--json'], home(dir))).out);
  assert.deepEqual(status.retention, { enabled: true, workspacesDays: 3, invalid: [] });
  assert.equal(status.workspaces.runsWithWorkspaces, 1);
  assert.equal(status.workspaces.reclaimableBytes, 2048);
  assert.equal(status.maintenance.reprice.line, 'nothing to price');
  assert.equal(status.maintenance.reprice.trigger, 'dashboard');
});

test('home status names an invalid retention block and says the background prune is paused', () => {
  const dir = makeHome({ enabled: true, workspacesDays: 'seven' });
  const { out } = capture(() => cmdHome(['status'], home(dir)));
  assert.match(out, /retention\s+paused — retention\.workspacesDays must be a number greater than 0/);
  const prune = capture(() => cmdHome(['prune', '--dry-run'], home(dir)));
  assert.match(prune.out, /automatic retention is invalid/);
});

test('the real binary: prune --dry-run then --yes on a temp home, status afterwards', () => {
  const dir = makeHome();
  const run = makeRun(dir, 'wf-aaaaaa-000001');
  const exec = (...args) => spawnSync(process.execPath, [BIN, 'home', ...args], {
    cwd: ROOT, env: { ...process.env, BULLSWARM_HOME: dir }, encoding: 'utf8',
  });
  const dry = exec('prune', '--dry-run', '--json');
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(JSON.parse(dry.stdout).reclaimableBytes, 2048);
  assert.ok(existsSync(join(run, 'workspaces')));
  const real = exec('prune', '--auto', '--trigger', 'kernel', '--json');
  assert.equal(real.status, 0, real.stderr);
  assert.equal(existsSync(join(run, 'workspaces')), false);
  const status = exec('status');
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /last prune\s+.* · kernel · removed 1 workspace from 1 run/);
  assert.equal(exec('prune', '--nope').status, 2);
});

test('home with no subcommand or an unknown one still exits 2 with the command list', () => {
  const dir = makeHome();
  const bare = capture(() => cmdHome([], home(dir)));
  assert.equal(bare.code, 2);
  assert.match(bare.err, /home prune/);
  assert.match(bare.err, /home status/);
  assert.equal(capture(() => cmdHome(['nonsense'], home(dir))).code, 2);
});
