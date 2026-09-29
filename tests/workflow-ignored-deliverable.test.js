// A step's work in files git ignores (QA 0.37.0 rerun, N1).
//
// A build step that wrote its deliverable to an ignored folder (`out/` in
// .gitignore) was failed `not-produced` ("no file changed and no commit
// made"), and the retry prompt, which said both "Do not commit" and "a commit
// counts", led the worker to force-add and commit. The produced check lists
// ignored files too (bounded, folder-walk.js), a step's declared files count
// wherever they are, and no worker prompt names a commit as a way to produce.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { deliverableVerdict, dispatchV2Action } from '../src/workflow/v2-dispatch.js';
import { walkIgnoredEntries } from '../src/workflow/folder-walk.js';
import { buildProgramWorkTask } from '../src/workflow/step-prompts.js';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const BIN = join(REPO, 'bin', 'bullswarm.js');

const good = { ok: true, why: 'structured output validated', meta: { exitCode: 0, wallSec: 1, usage: { totalTokens: 10 } } };
const connector = (name) => ({
  name, lanes: ['analyze', 'build', 'chore'], enabled: true, spawn: { cmd: ['fake'] },
  modelSelection: { flag: '--model' }, strategyAssignments: { low: { pool: name, model: 'gpt-5.6-luna' }, medium: { pool: name, model: 'gpt-5.6-luna' } },
});

function harness(verdicts) {
  const core = { config: { depthLimit: 2 }, pools: {}, incumbents: {}, decisionLog: [] };
  let index = 0;
  const tasks = [];
  return {
    tasks,
    dependencies: {
      watchOnce: async (_connector, task, _dir, paths, opts) => {
        tasks.push(task);
        const item = verdicts[index++];
        return typeof item === 'function' ? item({ paths, opts }) : item;
      },
      loadState: () => structuredClone(core),
      saveState: (_dir, next) => Object.assign(core, structuredClone(next)),
      now: (() => { let value = Date.parse('2026-09-29T01:00:00Z'); return () => (value += 1000); })(),
      uuid: () => 'session-fixed',
    },
  };
}

// A repository whose .gitignore lists out/, like the QA s2 seed.
function ignoringRepo(t) {
  const root = mkdtempSync(join(tmpdir(), 'bs-ignored-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  const home = join(root, 'home');
  mkdirSync(join(repo, 'tickets'), { recursive: true });
  mkdirSync(home);
  writeFileSync(join(repo, '.gitignore'), 'out/\n*.log\n');
  writeFileSync(join(repo, 'tickets', 'T-1001.md'), 'Refund not received\n');
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=Acme Dev', '-c', 'user.email=dev@example.com', 'commit', '-qm', 'seed']);
  return { root, repo, home };
}

async function dispatch(f, action, watches, options = {}) {
  const h = harness(watches);
  const result = await dispatchV2Action({
    ...options,
    action, taskText: 'triage the tickets', targetDir: f.repo,
    paths: { taskFile: join(f.home, `task-${action.id}-attempt-1.md`), outFile: join(f.home, `out-${action.id}-attempt-1.md`) },
    pools: [connector('sample-pool')], bullswarmDir: f.home, dependencies: h.dependencies,
  });
  return { result, tasks: h.tasks };
}

const writeOut = (repo) => () => {
  mkdirSync(join(repo, 'out'), { recursive: true });
  writeFileSync(join(repo, 'out', 'triage.jsonl'), '{"id":"T-1001"}\n');
  return good;
};

test('walkIgnoredEntries lists the files of git\'s ignored entries, skips tool caches, and gives up past its bound', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'bs-ignored-walk-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ['out/deep', 'node_modules/pkg', '__pycache__']) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, 'out', 'a.jsonl'), 'a');
  writeFileSync(join(root, 'out', 'deep', 'b.md'), 'b');
  writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'x');
  writeFileSync(join(root, '__pycache__', 'm.pyc'), 'x');
  writeFileSync(join(root, 'debug.log'), 'x');
  const entries = ['out/', 'node_modules/', '__pycache__/', 'debug.log', 'gone.log'];
  assert.deepEqual(walkIgnoredEntries(root, entries), ['debug.log', 'out/a.jsonl', 'out/deep/b.md']);
  assert.equal(walkIgnoredEntries(root, entries, { maxFiles: 2 }), null);
});

test('a files step whose only work is in a git-ignored folder is produced, and the change is named', async (t) => {
  const f = ignoringRepo(t);
  const action = { id: 'task', role: 'produce', lane: 'build', effort: 'medium', deliverable: { type: 'files' }, ownedFiles: [] };
  const { result } = await dispatch(f, action, [writeOut(f.repo)]);
  assert.equal(result.ok, true, result.attempts[0]?.why);
  assert.equal(result.attempts.length, 1);
  assert.deepEqual(result.attempts[0].changedFiles, ['out/triage.jsonl']);
  assert.match(readFileSync(join(f.home, 'diff-task-attempt-1.txt'), 'utf8'), /out\/triage\.jsonl \| \+1 lines \(new\)/);
  // Nothing was committed on the worker's behalf.
  assert.equal(execFileSync('git', ['-C', f.repo, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim(), '1');
});

test('a build step with no declared deliverable (the old gate) also counts an ignored file', async (t) => {
  const f = ignoringRepo(t);
  const { result } = await dispatch(f, { id: 'task', lane: 'build', effort: 'low', ownedFiles: [] }, [writeOut(f.repo)]);
  assert.equal(result.ok, true, result.attempts[0]?.why);
  assert.equal(result.attempts.length, 1);
});

test('too many ignored files to list: a step that changed nothing else is unchecked, never failed', () => {
  const files = { id: 'task', role: 'produce', lane: 'build', deliverable: { type: 'files' }, ownedFiles: [] };
  const legacy = { id: 'task', lane: 'build', ownedFiles: [] };
  const base = { verdict: { ok: true }, snapshotOk: true, changed: [] };
  assert.deepEqual(deliverableVerdict({ ...base, action: files, ignoredUnlisted: true }), { fact: { type: 'files', gated: false, produced: null }, failWhy: null });
  assert.deepEqual(deliverableVerdict({ ...base, action: legacy, ignoredUnlisted: true }), { fact: null, failWhy: null });
  assert.equal(deliverableVerdict({ ...base, action: files }).failWhy, 'no file changed');
  assert.equal(deliverableVerdict({ ...base, action: legacy }).failWhy, 'no file changed');
});

test('a step that declared an ignored file counts it', async (t) => {
  const f = ignoringRepo(t);
  const action = { id: 'task', role: 'produce', lane: 'build', effort: 'medium', deliverable: { type: 'files' }, ownedFiles: ['out/triage.jsonl'] };
  const { result } = await dispatch(f, action, [writeOut(f.repo)]);
  assert.equal(result.ok, true, result.attempts[0]?.why);
  assert.deepEqual(result.attempts[0].changedFiles, ['out/triage.jsonl']);
});

test('an ignored file left as it was is not work: not-produced, and neither the why nor the retry names a commit', async (t) => {
  const f = ignoringRepo(t);
  mkdirSync(join(f.repo, 'out'));
  writeFileSync(join(f.repo, 'out', 'old.jsonl'), 'old\n');
  const action = { id: 'task', role: 'produce', lane: 'build', effort: 'medium', deliverable: { type: 'files' }, ownedFiles: [] };
  const { result, tasks } = await dispatch(f, action, [good, good], { failureRule: true });
  assert.equal(result.ok, false);
  assert.equal(result.failureKind, 'not-produced');
  assert.equal(result.attempts[0].why, 'no file changed');
  assert.equal(tasks.length, 2, 'the gate retry ran');
  for (const task of tasks) assert.doesNotMatch(task, /commit (counts|was made|is made)|or a commit|no commit/i);
});

test('no deliverable line in a worker prompt offers a commit as a way to produce', (t) => {
  const f = ignoringRepo(t);
  const state = {
    config: { settings: { executionMode: 'program', workspaceMode: 'shared' } },
    intent: { cwd: f.repo, requirements: [{ id: 'deliver', text: 'Triage the tickets.' }], constraints: { workspaceMutation: 'allowed' } },
    program: { actions: [] }, actions: [], verifyLoop: null,
  };
  const base = { id: 'task', purpose: 'Triage', dependsOn: [], affects: ['deliver'], prompt: 'Triage the tickets.', role: 'produce', lane: 'build', effort: 'medium', evidenceFor: [], inputs: [], produces: [] };
  const open = { ...base, deliverable: { type: 'files' }, ownedFiles: [] };
  const owned = { ...base, deliverable: { type: 'files' }, ownedFiles: ['out/triage.jsonl'] };
  const openText = buildProgramWorkTask({ ...state, program: { actions: [open] } }, open, f.repo, null);
  const ownedText = buildProgramWorkTask({ ...state, program: { actions: [owned] } }, owned, f.repo, null);
  for (const text of [openText, ownedText]) {
    const line = text.split('\n').find((row) => row.startsWith('Declared deliverable'));
    assert.ok(line, text);
    assert.doesNotMatch(line, /commit/i);
  }
  assert.match(openText, /Declared deliverable: file changes in this workspace \(files git ignores count too\)\. Bullswarm fails this step as not produced if no file changes\./);
  assert.match(ownedText, /Declared deliverable: changes to your territory files \(out\/triage\.jsonl\)\. Bullswarm fails this step as not produced if none of them changes\./);
});

test('bullswarm run --lane build: a file written to an ignored path passes in one attempt', (t) => {
  const f = ignoringRepo(t);
  writeFileSync(join(f.repo, '.gitignore'), 'out/\n*.log\nnotes.md\n');
  execFileSync('git', ['-C', f.repo, '-c', 'user.name=Acme Dev', '-c', 'user.email=dev@example.com', 'commit', '-qam', 'ignore notes']);
  mkdirSync(join(f.home, 'connectors'), { recursive: true });
  for (const file of ['connector.json', 'echo-worker.mjs']) {
    writeFileSync(join(f.home, 'connectors', file === 'connector.json' ? 'echo.json' : file), readFileSync(join(REPO, 'src', 'providers', 'echo', file)));
  }
  writeFileSync(join(f.home, 'state.json'), `${JSON.stringify({
    version: 1, pools: { echo: { enabled: true } }, incumbents: {}, decisionLog: [],
    config: { depthLimit: 2, callerName: 'claude-code', testFixturesMigrated: true },
  }, null, 2)}\n`);
  const env = { ...process.env, BULLSWARM_HOME: f.home, BULLSWARM_NO_PACKAGED_PROVIDERS: '1' };
  delete env.BULLSWARM_DEPTH;
  const run = spawnSync(process.execPath, [BIN, 'run', '--lane', 'build', '--json', '--add-dir', f.repo, '--prompt', 'Write the notes TOUCH:notes.md'], { cwd: f.repo, env, encoding: 'utf8', timeout: 60_000 });
  const verdict = JSON.parse(run.stdout);
  assert.equal(verdict.ok, true, verdict.why);
  assert.equal(verdict.attempts, 1);
  assert.equal(run.status, 0);
  assert.equal(execFileSync('git', ['-C', f.repo, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim(), '2');
});
