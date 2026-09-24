// Brief text and the D16 marker. The golden kind-only brief was captured from
// buildProgramWorkTask before the deliverable lines were added.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createV2GoalDocument, createV2State } from '../src/workflow/v2-state.js';
import { acceptCallerPlannerResponse, buildProgramWorkTask, runV2AutonomousWorkflow } from '../src/workflow/v2-runtime.js';
import { dispatchV2Action } from '../src/workflow/v2-dispatch.js';

const KIND_ONLY_BRIEF = `Bullswarm program action: write
Purpose: Deliver write
Workspace: /tmp/acme-repo
Your intended territory: write.txt. This is coordination guidance, not an exact-file enforcement gate. Stay within your action purpose; report cross-territory requests for the integrator to apply.
Other agents may share this tree. Preserve their changes and all pre-existing user work. Never revert sibling edits, reset the repository, or format unrelated files. Do not commit unless the user explicitly requires it.
Read every dependency output below before starting. Carry forward concrete findings and outstanding shared-file requests. An integration action applies those requests, reconciles the combined work, and runs the repository acceptance gates.
Dependency artifacts:
[]
Requirement context (deliver): Deliver the requested files and validate them.
Deliver only your action purpose. Exercise observable behavior and run the focused checks; report exact validation and anything unfinished. Do not claim success based only on editing files or unrelated green tests.

Implement write and run its focused checks.

Output transport: your complete final response is captured as this action's durable output artifact. Do not overwrite kernel-owned task/output files. Include delivered files or findings, validation results, unfinished work, and precise requests for the integrator. Read-only reports belong in the final response itself.`;

function briefState(action, cwd) {
  return {
    config: { settings: { executionMode: 'program', workspaceMode: 'shared' } },
    intent: {
      cwd,
      requirements: [{ id: 'deliver', text: 'Deliver the requested files and validate them.' }],
      constraints: { workspaceMutation: 'allowed' },
    },
    program: { actions: [action] },
    actions: [{ id: action.id, status: 'pending', outputFile: null, artifactIds: [] }],
    verifyLoop: null,
  };
}

const baseAction = (over = {}) => ({
  id: 'write',
  purpose: 'Deliver write',
  dependsOn: [],
  affects: ['deliver'],
  ownedFiles: ['write.txt'],
  prompt: 'Implement write and run its focused checks.',
  kind: 'implement',
  lane: 'build',
  effort: 'medium',
  evidenceFor: [],
  inputs: [],
  produces: [],
  ...over,
});

test('a kind-only step brief stays byte-identical', () => {
  const action = baseAction();
  const text = buildProgramWorkTask(briefState(action, '/tmp/acme-repo'), action, '/tmp/acme-repo', null);
  assert.equal(text, KIND_ONLY_BRIEF);
});

test('an act brief uses the act line, including the git sentence', () => {
  const action = baseAction({
    kind: undefined, role: 'act', lane: 'analyze', ownedFiles: [], deliverable: { type: 'outward' },
    prompt: 'Post the note to the board.',
  });
  const text = buildProgramWorkTask(briefState(action, '/tmp/acme-repo'), action, '/tmp/acme-repo', null);
  assert.match(text, /This is an act step: it acts outside the workspace \(send, post, publish, deploy\)/);
  assert.match(text, /do not stage, commit, stash, check out or reset anything in this repository/);
  assert.doesNotMatch(text, /sole unrestricted integrator/);
  assert.doesNotMatch(text, /Declared deliverable/);
});

test('a data brief names its paths, and the files line names territory files or the workspace', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-brief-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = baseAction({
    kind: undefined, role: 'produce', lane: 'build', ownedFiles: [],
    deliverable: { type: 'data', paths: ['out/summary.json', 'out/rows.json'] },
  });
  const dataText = buildProgramWorkTask(briefState(data, root), data, root, null);
  assert.match(dataText, /Declared deliverable \(data\): out\/summary\.json, out\/rows\.json\. Bullswarm fails this step as not produced if any of these is missing when you finish, or none of them was written during this step\./);

  const territory = baseAction({
    deliverable: { type: 'files' }, ownedFiles: ['src/a.js', 'src/b.js'],
  });
  const territoryText = buildProgramWorkTask(briefState(territory, root), territory, root, null);
  assert.match(territoryText, /Declared deliverable: changes to your territory files \(src\/a\.js, src\/b\.js\) or a commit\. Bullswarm fails this step as not produced if none of them changes and no commit is made\./);
  assert.doesNotMatch(territoryText, /in this workspace/);

  execFileSync('git', ['init', '-q', root]);
  const open = baseAction({
    deliverable: { type: 'files' }, ownedFiles: [],
  });
  const openText = buildProgramWorkTask(briefState(open, root), open, root, null);
  assert.match(openText, /Declared deliverable: file changes in this workspace \(a commit counts\)\. Bullswarm fails this step as not produced if no file changes and no commit is made\./);
});

test('a files brief outside git leaves out the failure sentence', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-nosnap-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const action = baseAction({
    deliverable: { type: 'files' }, ownedFiles: [],
  });
  const text = buildProgramWorkTask(briefState(action, root), action, root, null);
  assert.match(text, /Declared deliverable: file changes in this workspace \(a commit counts\)\./);
  assert.doesNotMatch(text, /Bullswarm fails this step as not produced/);
});

test('a files brief in a folder its repository ignores leaves out the failure sentence', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-ignored-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  writeFileSync(join(root, '.gitignore'), 'scratch/\n');
  execFileSync('git', ['-C', root, 'add', '.gitignore']);
  execFileSync('git', ['-C', root, '-c', 'user.name=A', '-c', 'user.email=a@example.com', 'commit', '-qm', 'seed']);
  const site = join(root, 'scratch', 'site');
  mkdirSync(site, { recursive: true });
  const open = baseAction({ deliverable: { type: 'files' }, ownedFiles: [] });
  const openText = buildProgramWorkTask(briefState(open, site), open, site, null);
  assert.match(openText, /Declared deliverable: file changes in this workspace \(a commit counts\)\./);
  assert.doesNotMatch(openText, /Bullswarm fails this step as not produced/);
  // Exact owned files are hashed directly, so that promise is kept.
  const owned = baseAction({ deliverable: { type: 'files' }, ownedFiles: ['index.html'] });
  const ownedText = buildProgramWorkTask(briefState(owned, site), owned, site, null);
  assert.match(ownedText, /Bullswarm fails this step as not produced if none of them changes and no commit is made\./);
});

const connector = (name) => ({
  name, lanes: ['analyze', 'build', 'chore'], enabled: true, spawn: { cmd: ['fake'] },
  modelSelection: { flag: '--model' },
  strategyAssignments: Object.fromEntries(['low', 'medium', 'high'].map((tier) => [tier, { pool: name, model: 'gpt-5.6-luna' }])),
});

function gitRepo(workspace) {
  execFileSync('git', ['init', '-q', workspace]);
  writeFileSync(join(workspace, 'README.md'), 'acme\n');
  execFileSync('git', ['-C', workspace, 'add', '.']);
  execFileSync('git', ['-C', workspace, '-c', 'user.name=Acme Dev', '-c', 'user.email=dev@example.com', 'commit', '-qm', 'seed']);
}

async function resumeBuild(t, { marker = false, prior = null, runId = 'wf-gate01-abcdef' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-gate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'repo');
  const bullswarmDir = join(root, 'home');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(bullswarmDir, { recursive: true });
  gitRepo(workspace);
  const goalDocument = createV2GoalDocument({
    goal: 'Deliver the requested files', cwd: workspace,
    requirements: [{ id: 'deliver', text: 'Deliver the requested files and validate them.' }],
    settings: { executionMode: 'program', workspaceMode: 'shared', scout: false, plannerMode: 'caller', concurrency: 1 },
  });
  const runDir = join(bullswarmDir, 'workflows', runId);
  mkdirSync(runDir, { recursive: true });
  let state = createV2State(goalDocument, { runId, shortId: 'gate01' });
  state = acceptCallerPlannerResponse(state, {
    schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary: 'Write the file.',
    program: {
      schemaVersion: 'bullswarm.workflow.program.v2',
      actions: [{
        id: 'write', purpose: 'Deliver write', dependsOn: [], affects: ['deliver'], ownedFiles: ['write.txt'],
        prompt: 'Implement write and run its focused checks.', lane: 'build', effort: 'low',
        evidenceFor: [], inputs: [], produces: [],
      }],
    },
  }, { boundary: 'initial', runDir }).state;
  if (prior) {
    writeFileSync(join(workspace, 'write.txt'), 'already written\n');
    Object.assign(state.actions[0], { status: 'running', attempts: 1, startedAt: '2026-09-24T10:00:00.000Z' });
    state.attempts = [prior];
    state.lifecycle.status = 'running';
  }
  writeFileSync(join(runDir, 'goal.json'), JSON.stringify(goalDocument));
  writeFileSync(join(runDir, 'state.json'), JSON.stringify(state));
  if (marker) writeFileSync(join(runDir, 'features.json'), `${JSON.stringify({ deliverableGate: 1 }, null, 2)}\n`);
  const core = { config: { depthLimit: 2 }, pools: {}, incumbents: {}, decisionLog: [] };
  const seen = [];
  const run = await runV2AutonomousWorkflow({
    bullswarmDir, resumeRunId: runId, pools: [], parentEnv: {},
    dependencies: {
      refreshPools: async () => null,
      dispatchV2Action: (options) => {
        seen.push({
          id: options.action.id,
          legacyGate: options.legacyGate,
          earlierWork: options.earlierWork,
          extraSnapshotPaths: options.extraSnapshotPaths,
        });
        return dispatchV2Action({
          ...options,
          pools: [connector('codex')],
          dependencies: {
            watchOnce: async (_pool, task, _targetDir, files) => {
              writeFileSync(files.taskFile, task);
              writeFileSync(files.outFile, 'left the workspace unchanged');
              return { ok: true, why: 'ok', meta: { exitCode: 0, wallSec: 1 } };
            },
            loadState: () => structuredClone(core),
            saveState: (_dir, next) => Object.assign(core, structuredClone(next)),
            now: () => Date.now(),
            uuid: () => 'session-fixed',
          },
        });
      },
    },
  });
  return { run, seen, runDir };
}

test('a new run writes features.json with deliverableGate 1', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-marker-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'repo');
  const bullswarmDir = join(root, 'home');
  mkdirSync(workspace);
  mkdirSync(bullswarmDir);
  const goalDocument = createV2GoalDocument({
    goal: 'Deliver the requested files', cwd: workspace,
    requirements: [{ id: 'deliver', text: 'Deliver the requested files and validate them.' }],
    settings: { executionMode: 'program', workspaceMode: 'shared', scout: false, plannerMode: 'caller', concurrency: 1 },
  });
  const result = await runV2AutonomousWorkflow({
    bullswarmDir, goalDocument, pools: [], runId: 'wf-marker-abcdef',
    initialPlannerResponse: {
      schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary: 'Write the file.',
      program: {
        schemaVersion: 'bullswarm.workflow.program.v2',
        actions: [{
          id: 'write', purpose: 'Deliver write', dependsOn: [], affects: ['deliver'], ownedFiles: ['write.txt'],
          prompt: 'Implement write.', lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: [],
        }],
      },
    },
    dependencies: {
      dispatchV2Action: async (options) => {
        assert.equal(options.legacyGate, true);
        assert.deepEqual(options.earlierWork, { produced: false, unknown: false });
        assert.deepEqual(options.extraSnapshotPaths, []);
        const files = options.paths(1);
        const record = {
          ordinal: 1, pool: 'fixture', model: 'fixture', status: 'running',
          startedAt: new Date().toISOString(), taskFile: files.taskFile, outFile: files.outFile,
        };
        writeFileSync(files.taskFile, options.taskText);
        options.onAttempt?.('started', record);
        writeFileSync(files.outFile, 'done');
        Object.assign(record, { status: 'succeeded', finishedAt: new Date().toISOString(), failureKind: null });
        options.onAttempt?.('finished', record, { ok: true, outFile: files.outFile });
        return { ok: true, status: 'succeeded', verdict: { ok: true, outFile: files.outFile }, attempts: [record] };
      },
    },
  });
  assert.equal(existsSync(join(result.runDir, 'features.json')), true);
  assert.deepEqual(JSON.parse(readFileSync(join(result.runDir, 'features.json'), 'utf8')), { deliverableGate: 1 });
});

test('resuming without the marker lets an unchanged build step pass', async (t) => {
  const { run, seen } = await resumeBuild(t, { marker: false, runId: 'wf-legacy-abcdef' });
  assert.equal(seen[0].legacyGate, false);
  assert.equal(run.state.attempts[0].status, 'succeeded');
  assert.equal(run.state.attempts[0].failureKind, null);
  assert.equal(Object.hasOwn(run.state.attempts[0], 'deliverable'), false);
  assert.equal(run.result.status, 'completed');
});

test('resuming a marked run fails an unchanged build step as not-produced', async (t) => {
  const { run, seen } = await resumeBuild(t, { marker: true, runId: 'wf-marked-abcdef' });
  assert.equal(seen[0].legacyGate, true);
  assert.equal(run.state.attempts[0].status, 'failed');
  assert.equal(run.state.attempts[0].failureKind, 'not-produced');
  assert.equal(run.state.attempts[0].why, 'no file changed and no commit made');
  assert.equal(Object.hasOwn(run.state.attempts[0], 'deliverable'), false);
});

test('a resume after an interrupted attempt that wrote files passes', async (t) => {
  const { run, seen } = await resumeBuild(t, {
    marker: true,
    runId: 'wf-carry1-abcdef',
    prior: {
      id: 'write-1', actionId: 'write', ordinal: 1, status: 'running',
      pool: 'codex', model: 'gpt-5.6-luna', startedAt: '2026-09-24T10:00:00.000Z',
      changedFileCount: 1, changedFiles: ['write.txt'],
    },
  });
  assert.deepEqual(seen[0].earlierWork, { produced: true, unknown: false });
  assert.equal(seen[0].legacyGate, true);
  const resumed = run.state.attempts.find((attempt) => attempt.ordinal === 2);
  assert.equal(resumed.status, 'succeeded');
  assert.equal(resumed.failureKind, null);
  assert.equal(run.state.actions[0].status, 'succeeded');
});
