// Caller identity: who asked for a run, recorded at launch beside goal.json
// (`caller.json`) and on every in-flight assignment record.
//
// The record reads exactly two environment variables, HERDR_PANE_ID and
// CLAUDE_CODE_SESSION_ID, plus the caller's working directory. A value of the
// wrong shape is recorded as null, never as the raw text. The pane and session
// values below are made up for the test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callerIdentity } from '../src/lib/caller.js';
import { assignmentsDir, listAssignments, registerAssignment } from '../src/lib/assignments.js';
import { dispatchV2Action } from '../src/workflow/v2-dispatch.js';
import { removeSettled } from './fixtures/settled-cleanup.mjs';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const BIN = join(REPO, 'bin', 'bullswarm.js');
const PANE = 'w6:p1';
const SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e';
const V3 = 'bullswarm.workflow.program.v3';

function echoHome(root) {
  const home = join(root, 'home');
  mkdirSync(join(home, 'connectors'), { recursive: true });
  for (const file of ['echo.json', 'echo-worker.mjs']) {
    writeFileSync(join(home, 'connectors', file), readFileSync(join(REPO, 'src', 'providers', 'echo', file === 'echo.json' ? 'connector.json' : file)));
  }
  writeFileSync(join(home, 'state.json'), `${JSON.stringify({
    version: 1, pools: { echo: { enabled: true } }, incumbents: {}, decisionLog: [],
    config: { depthLimit: 2, callerName: 'claude-code', testFixturesMigrated: true },
  }, null, 2)}\n`);
  return home;
}

function cliEnv(home, extra = {}) {
  const env = { ...process.env, BULLSWARM_HOME: home, BULLSWARM_NO_PACKAGED_PROVIDERS: '1', BULLSWARM_DEPTH: '0' };
  delete env.HERDR_PANE_ID;
  delete env.CLAUDE_CODE_SESSION_ID;
  return { ...env, ...extra };
}

function withProcessEnv(values, fn) {
  const saved = {};
  for (const key of Object.keys(values)) {
    saved[key] = process.env[key];
    if (values[key] == null) delete process.env[key];
    else process.env[key] = values[key];
  }
  try { return fn(); } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('callerIdentity reads only the pane and session variables, plus the cwd', () => {
  const identity = callerIdentity({
    env: { HERDR_PANE_ID: PANE, CLAUDE_CODE_SESSION_ID: SESSION, OTHER_VALUE: 'must-not-appear' },
    cwd: '/work/acme',
  });
  assert.deepEqual(identity, { herdrPane: PANE, claudeSession: SESSION, cwd: '/work/acme' });
  assert.equal(JSON.stringify(identity).includes('must-not-appear'), false, 'no other env value is recorded');
});

test('callerIdentity records null for a missing or wrongly shaped value', () => {
  assert.deepEqual(callerIdentity({ env: {}, cwd: '/w' }), { herdrPane: null, claudeSession: null, cwd: '/w' });
  for (const pane of ['', 'w6', 'p1', 'w6:p1; rm -rf', 'W6:P1', 'w6:px', ` ${PANE}`, 'w:p1']) {
    assert.equal(callerIdentity({ env: { HERDR_PANE_ID: pane }, cwd: '/w' }).herdrPane, null, `pane ${JSON.stringify(pane)} is refused`);
  }
  for (const session of ['', 'not-a-uuid', `${SESSION}x`, SESSION.replaceAll('-', '')]) {
    assert.equal(callerIdentity({ env: { CLAUDE_CODE_SESSION_ID: session }, cwd: '/w' }).claudeSession, null, `session ${JSON.stringify(session)} is refused`);
  }
  assert.equal(callerIdentity({ env: {}, cwd: 'relative/dir' }).cwd, null, 'a cwd must be absolute');
  assert.equal(callerIdentity({ env: { HERDR_PANE_ID: 'wV:p2' }, cwd: '/w' }).herdrPane, 'wV:p2', 'a lettered window id is a pane');
});

test('callerIdentity defaults to process.env and process.cwd()', () => {
  withProcessEnv({ HERDR_PANE_ID: PANE, CLAUDE_CODE_SESSION_ID: SESSION }, () => {
    assert.deepEqual(callerIdentity(), { herdrPane: PANE, claudeSession: SESSION, cwd: process.cwd() });
  });
});

test('every assignment record carries a caller', () => {
  const home = mkdtempSync(join(tmpdir(), 'bullswarm-caller-'));
  try {
    const given = registerAssignment(home, {
      pool: 'echo', caller: { herdrPane: PANE, claudeSession: 'bogus', cwd: '/work/acme', extra: 'dropped' },
    });
    assert.deepEqual(given.caller, { herdrPane: PANE, claudeSession: null, cwd: '/work/acme' }, 'a supplied caller is re-validated and closed');
    const onDisk = JSON.parse(readFileSync(join(assignmentsDir(home), `${given.id}.json`), 'utf8'));
    assert.deepEqual(onDisk.caller, given.caller);

    const implicit = withProcessEnv({ HERDR_PANE_ID: PANE, CLAUDE_CODE_SESSION_ID: SESSION }, () => registerAssignment(home, { pool: 'echo' }));
    assert.deepEqual(implicit.caller, { herdrPane: PANE, claudeSession: SESSION, cwd: process.cwd() }, 'no caller given: this process is the caller');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('a workflow assignment carries the caller its run recorded at launch', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bullswarm-caller-'));
  try {
    const runDir = join(home, 'workflows', 'wf-mtszc1by-54277e');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'caller.json'), JSON.stringify({
      schemaVersion: 'bullswarm.workflow.caller.v1',
      caller: { herdrPane: 'w2:p3', claudeSession: SESSION, cwd: '/launched/from' },
      recordedAt: '2026-10-20T00:00:00.000Z',
    }));
    const core = { config: { depthLimit: 2 }, pools: {}, incumbents: {}, decisionLog: [] };
    const seen = [];
    const result = await dispatchV2Action({
      action: { id: 'impl-1', lane: 'build', effort: 'medium' },
      taskText: 'do it', targetDir: home,
      paths: { taskFile: join(runDir, 'task-impl-1.md'), outFile: join(runDir, 'out-impl-1.md') },
      pools: [{ name: 'echo', lanes: ['analyze', 'build', 'chore'], enabled: true, spawn: { cmd: ['fake'] }, modelSelection: { flag: '--model' } }],
      bullswarmDir: home, runDir,
      dependencies: {
        watchOnce: async () => {
          seen.push(listAssignments(home));
          return { ok: true, why: 'done', meta: { exitCode: 0, wallSec: 1 } };
        },
        loadState: () => structuredClone(core),
        saveState: (_dir, next) => Object.assign(core, structuredClone(next)),
      },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(seen[0][0].caller, { herdrPane: 'w2:p3', claudeSession: SESSION, cwd: '/launched/from' });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('bullswarm run records caller.json beside goal.json', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-caller-run-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = echoHome(root);
  const callerDir = realpathSync(mkdtempSync(join(root, 'caller-')));
  const out = spawnSync(process.execPath, [BIN, 'run', '--lane', 'analyze', '--json', '--add-dir', REPO, '--prompt', 'caller shape'], {
    encoding: 'utf8', cwd: callerDir, timeout: 60_000,
    env: cliEnv(home, { HERDR_PANE_ID: PANE, CLAUDE_CODE_SESSION_ID: SESSION }),
  });
  assert.equal(out.status, 0, out.stderr);
  const verdict = JSON.parse(out.stdout);
  const recorded = JSON.parse(readFileSync(join(home, 'workflows', verdict.runId, 'caller.json'), 'utf8'));
  assert.equal(recorded.schemaVersion, 'bullswarm.workflow.caller.v1');
  assert.deepEqual(recorded.caller, { herdrPane: PANE, claudeSession: SESSION, cwd: callerDir });
  assert.match(recorded.recordedAt, /^\d{4}-\d\d-\d\dT/);

  const show = spawnSync(process.execPath, [BIN, 'workflow', 'runs', 'show', verdict.runId, '--json'], { encoding: 'utf8', env: cliEnv(home) });
  assert.equal(show.status, 0, show.stderr);
  assert.deepEqual(JSON.parse(show.stdout).caller, recorded.caller, 'runs show --json carries the caller');
  const text = spawnSync(process.execPath, [BIN, 'workflow', 'runs', 'show', verdict.runId], { encoding: 'utf8', env: cliEnv(home) });
  assert.match(text.stdout, new RegExp(`# caller  pane ${PANE} · session ${SESSION} · cwd ${callerDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n`));
});

test('a detached workflow goal records the launching cwd, not the workspace', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-caller-goal-'));
  const home = echoHome(root);
  const workspace = join(root, 'acme');
  const callerDir = realpathSync(mkdtempSync(join(root, 'caller-')));
  mkdirSync(workspace);
  execFileSync('git', ['init', '-q', workspace]);
  writeFileSync(join(workspace, 'README.md'), 'acme\n');
  execFileSync('git', ['-C', workspace, 'add', '.']);
  execFileSync('git', ['-C', workspace, '-c', 'user.name=Acme Dev', '-c', 'user.email=dev@example.com', 'commit', '-qm', 'seed']);
  const plan = join(root, 'plan.json');
  writeFileSync(plan, JSON.stringify({
    schemaVersion: V3,
    steps: [{ id: 'draft', prompt: 'Draft the acme brief.' }],
    gates: [{ id: 'approve', dependsOn: ['draft'] }],
  }));
  const out = spawnSync(process.execPath, [BIN, 'workflow', 'goal', 'Draft the acme brief', '--cwd', workspace, '--program', plan, '--json'], {
    encoding: 'utf8', cwd: callerDir, timeout: 60_000,
    env: cliEnv(home, { HERDR_PANE_ID: PANE }),
  });
  assert.equal(out.status, 0, out.stdout + out.stderr);
  const launched = JSON.parse(out.stdout);
  const runDir = join(home, 'workflows', launched.runId);
  for (let i = 0; i < 300; i += 1) {
    try { if (['waiting', 'completed', 'partial', 'failed'].includes(JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8')).lifecycle.status)) break; } catch { /* mid-write */ }
    await new Promise((done) => setTimeout(done, 50));
  }
  t.after(() => removeSettled(root, { homes: [home] }));
  const recorded = JSON.parse(readFileSync(join(runDir, 'caller.json'), 'utf8'));
  assert.deepEqual(recorded.caller, { herdrPane: PANE, claudeSession: null, cwd: callerDir });
});

test('bullswarm assignments shows the caller pane, and --json carries the caller', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'bullswarm-caller-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  registerAssignment(home, { pool: 'echo', lane: 'build', effort: 'medium', source: 'run', caller: { herdrPane: PANE, claudeSession: SESSION, cwd: '/w' } });
  registerAssignment(home, { pool: 'echo', lane: 'build', effort: 'medium', source: 'run', caller: { herdrPane: null, claudeSession: null, cwd: '/w' } });
  const env = cliEnv(home);
  const json = spawnSync(process.execPath, [BIN, 'assignments', '--json'], { encoding: 'utf8', env });
  assert.equal(json.status, 0, json.stderr);
  const rows = JSON.parse(json.stdout);
  assert.deepEqual(rows.map((row) => row.caller?.herdrPane ?? null).sort(), [PANE, null].sort());
  const text = spawnSync(process.execPath, [BIN, 'assignments'], { encoding: 'utf8', env });
  const lines = text.stdout.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(lines.filter((line) => line.endsWith(` caller=${PANE}`)).length, 1, 'the row with a pane names it');
  assert.equal(lines.filter((line) => /caller=/.test(line)).length, 1, 'a row with no pane prints no caller');
});
