// The kernel's repair loop, end to end, with scripted fake workers.
//
// Every run here goes through the real kernel and the real dispatcher; only
// the provider CLI is replaced (`watchOnce`), so task files, diff snapshots
// (a real git workspace), the evidence contract, plan revisions, events and
// result.json are the production paths. Nothing reads the live home: each
// test builds its own temp home and workspace.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readEvents } from '../src/workflow/events.js';
import { createV2GoalDocument } from '../src/workflow/v2-state.js';
import { runV2AutonomousWorkflow } from '../src/workflow/v2-runtime.js';
import { dispatchV2Action } from '../src/workflow/v2-dispatch.js';
import { repairInheritedPaths } from '../src/workflow/verify-rounds.js';
import { formatV2HandbackLines, summarizeV2Result } from '../src/workflow/v2-outcome.js';
import { initialWatchMemory, notableWatchEvents, renderWatchEvent, watchTrouble } from '../src/workflow/watch-cli.js';
import { clearTimeBoxHistoryCache } from '../src/workflow/time-box.js';
import { STAGE2_RUN_FEATURES, STAGE3_RUN_FEATURES } from '../src/workflow/run-features.js';
import { createRevisionRequest, exportV2Plan, normalizeRevisionInput, planV2Revision, queueRevisionRequest } from '../src/workflow/v2-revision.js';

const connector = (name) => ({
  name, lanes: ['analyze', 'build', 'chore'], enabled: true, spawn: { cmd: ['fake'] },
  modelSelection: { flag: '--model' },
  strategyAssignments: Object.fromEntries(['low', 'medium', 'high'].map((tier) => [tier, { pool: name, model: 'gpt-5.6-luna' }])),
});

const REQUIREMENTS = [
  { id: 'alpha', text: 'src/a.js exports alpha() returning 2.' },
  { id: 'beta', text: 'src/b.js exports beta() returning 3.' },
];

const work = (id, over = {}) => ({
  id, purpose: `Write ${id}`, dependsOn: [], affects: [], ownedFiles: [], prompt: `Write the files for ${id}.`,
  kind: 'implement', evidenceFor: [], inputs: [], produces: [], ...over,
});
const verify = (over = {}) => ({
  id: 'verify', purpose: 'Check both modules', dependsOn: ['build-a', 'build-b'], affects: [], ownedFiles: [],
  prompt: 'Inspect src/a.js and src/b.js and run them.', kind: 'adversarial-acceptance',
  evidenceFor: ['alpha', 'beta'], inputs: [], produces: [], ...over,
});

function program({ verifyRounds = null, buildA = {} } = {}) {
  return {
    schemaVersion: 'bullswarm.workflow.program.v2',
    ...(verifyRounds ? { defaults: { verifyRounds } } : {}),
    actions: [
      work('build-a', { affects: ['alpha'], ownedFiles: ['src/a.js'], ...buildA }),
      work('build-b', { affects: ['beta'], ownedFiles: ['src/b.js'] }),
      verify(),
    ],
  };
}

const read = (dir, file) => { try { return readFileSync(join(dir, file), 'utf8'); } catch { return ''; } };
const pass = (evidence) => ({ status: 'passed', evidence: [evidence], concerns: [] });
const fail = (evidence, concerns = []) => ({ status: 'failed', evidence: [evidence], concerns });

/**
 * One kernel run. `scenario.work[id]({ targetDir, task })` edits files and
 * returns the step's report; `scenario.judge(id, ids, { targetDir, task })`
 * returns the evidence for one verify step's requirements. `features` is the
 * marker the run is launched with: a stage-2 launch by default (the saved-run
 * loop: verifyRounds counts review rounds, default 3), STAGE3_RUN_FEATURES for
 * the marked loop (D12, D13, D19, D33).
 */
async function runLoop(t, scenario, { programDoc = program(), runId = 'wf-loop-abcdef', onEvent = null, requirements = REQUIREMENTS, prepare = null, features = STAGE2_RUN_FEATURES } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-loop-kernel-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'repo');
  const bullswarmDir = join(root, 'home');
  mkdirSync(join(workspace, 'src'), { recursive: true });
  mkdirSync(bullswarmDir);
  writeFileSync(join(workspace, 'src', 'a.js'), 'export const alpha = () => 0;\n');
  writeFileSync(join(workspace, 'src', 'b.js'), 'export const beta = () => 0;\n');
  writeFileSync(join(workspace, 'src', 'c.js'), 'export const gamma = () => 0;\n');
  prepare?.(workspace);
  const git = (...args) => execFileSync('git', ['-C', workspace, ...args], { stdio: 'pipe' });
  git('init', '-q');
  git('add', '.');
  git('-c', 'user.name=Loop Test', '-c', 'user.email=loop@example.invalid', 'commit', '-qm', 'seed');
  clearTimeBoxHistoryCache();
  const goalDocument = createV2GoalDocument({
    goal: 'Make alpha and beta return the right values', cwd: workspace, requirements,
    settings: { executionMode: 'program', workspaceMode: 'shared', scout: false, plannerMode: 'caller', concurrency: 1 },
  });
  const tasks = {};
  const core = { config: { depthLimit: 2 }, pools: {}, incumbents: {}, decisionLog: [] };
  let clock = Date.parse('2026-09-21T02:00:00Z');
  const worker = async (_connector, task, targetDir, files, opts) => {
    const id = opts.attemptId.replace(/-\d+$/, '');
    tasks[id] = task;
    writeFileSync(files.taskFile, task);
    const meta = { exitCode: 0, wallSec: 60 };
    const candidatePath = task.match(/exact durable path: '([^']+)'/)?.[1];
    if (candidatePath) {
      const contract = JSON.parse(readFileSync(join(dirname(candidatePath), `contract-${id}.json`), 'utf8'));
      const requirements = scenario.judge(id, contract.evidenceFor, { targetDir, task });
      writeFileSync(candidatePath, JSON.stringify({ schemaVersion: 'bullswarm.workflow.evidence.v2', requirements }));
      writeFileSync(files.outFile, 'evidence recorded');
      return { ok: true, why: 'structured output validated', structured: opts.outputValidator('prose'), meta };
    }
    const handler = scenario.work?.[id];
    const scripted = handler?.({ targetDir, task });
    // `{ fail: why }`: the worker exits 1 (a process failure).
    if (scripted && typeof scripted === 'object') {
      writeFileSync(files.outFile, scripted.fail);
      return { ok: false, why: scripted.fail, meta: { exitCode: 1, wallSec: 60 } };
    }
    const report = scripted ?? `## Done\n- ${id}\n\n## Not done\n- none\n\n## Suggested next step\n- none`;
    // A build attempt that changes nothing is a no-op. An unscripted step
    // still has to leave a byte change, and the comment does not make alpha()
    // return 2, so the judge's verdict stays the one the scenario wrote.
    if (!handler) {
      const marker = join(targetDir, 'src', 'a.js');
      writeFileSync(marker, `${read(targetDir, 'src/a.js').replace(/\n$/, '')} // ${id}\n`);
    }
    writeFileSync(files.outFile, report);
    return { ok: true, why: 'ok', meta };
  };
  const runDir = join(bullswarmDir, 'workflows', runId);
  const run = await runV2AutonomousWorkflow({
    bullswarmDir, goalDocument, pools: [], runId, parentEnv: {},
    ...(onEvent ? { onEvent: (event) => onEvent(event, { runDir }) } : {}),
    initialPlannerResponse: { schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary: 'Build both modules and check them.', program: programDoc },
    dependencies: {
      runFeatures: features,
      refreshPools: async () => null,
      timeBoxTimeZone: 'UTC',
      now: () => new Date(clock).toISOString(),
      dispatchV2Action: (options) => dispatchV2Action({
        ...options,
        pools: [connector('codex')],
        dependencies: {
          watchOnce: worker,
          loadState: () => structuredClone(core),
          saveState: (_dir, next) => Object.assign(core, structuredClone(next)),
          now: () => (clock += 60_000),
          uuid: () => 'session-fixed',
        },
      }),
    },
  });
  const events = readEvents(run.runDir);
  return { run, tasks, events, workspace, bullswarmDir, loop: run.state.verifyLoop, ids: run.state.program.actions.map((action) => action.id) };
}

// Round-1 builders: build-a writes the bug the verifier catches.
const buggyBuild = {
  'build-a': ({ targetDir }) => { writeFileSync(join(targetDir, 'src', 'a.js'), 'export const alpha = () => 1;\n'); return '## Done\n- src/a.js\n\n## Not done\n- alpha edge cases\n\n## Suggested next step\n- none'; },
  'build-b': ({ targetDir }) => { writeFileSync(join(targetDir, 'src', 'b.js'), 'export const beta = () => 3;\n'); return '## Done\n- src/b.js'; },
};
// The verifier reads the workspace: alpha passes once src/a.js returns 2.
const workspaceJudge = (_id, ids, { targetDir }) => Object.fromEntries(ids.map((id) => {
  if (id === 'alpha') {
    return [id, read(targetDir, 'src/a.js').includes('=> 2')
      ? pass('src/a.js: node -e "alpha()" printed 2')
      : fail('src/a.js: node -e "alpha()" printed 1, expected 2')];
  }
  return [id, read(targetDir, 'src/b.js').includes('=> 3') ? pass('src/b.js: node -e "beta()" printed 3') : fail('src/b.js: beta() printed 0')];
}));

// A declared requirement no evidence step names: `verify` judges only alpha
// and beta, so gamma is never inspected by anyone.
const GAMMA = { id: 'gamma', text: 'src/c.js exports gamma() returning 4.' };
const NOT_JUDGED = 'not judged · no evidence step covers it';
const allPassing = {
  'build-a': ({ targetDir }) => { writeFileSync(join(targetDir, 'src', 'a.js'), 'export const alpha = () => 2;\n'); return '## Done\n- src/a.js'; },
  'build-b': ({ targetDir }) => { writeFileSync(join(targetDir, 'src', 'b.js'), 'export const beta = () => 3;\n'); return '## Done\n- src/b.js'; },
};

test('round 1 accounts for a declared requirement no evidence step covers: not judged, never passed, no repair, told to the caller', async (t) => {
  const { run, loop, ids, events } = await runLoop(t, { work: allPassing, judge: workspaceJudge },
    { requirements: [...REQUIREMENTS, { ...GAMMA, mandatory: false }] });
  // Everything a step covers passed, and the optional one does not gate: verified.
  assert.equal(run.result.status, 'completed');
  assert.equal(run.result.verified, true);
  assert.deepEqual(ids, ['build-a', 'build-b', 'verify'], 'an uncovered requirement starts no repair');
  assert.deepEqual(loop.rounds[0].toJudge, ['alpha', 'beta']);
  assert.equal(loop.stoppedBy, 'passed');
  assert.equal(run.state.ledger.requirements.gamma.status, 'pending', 'never counted as passed');
  const round = events.filter((event) => event.type === 'workflow.verify-round');
  assert.deepEqual(round.map((event) => [event.payload.round, event.payload.stage, event.payload.next ?? null, event.payload.notJudged ?? null]),
    [[1, 'started', null, null], [1, 'finished', 'finish', ['gamma']]]);
  // The caller's block carries it, with a next step that names the fix.
  assert.equal(run.result.callerDecision.verifyRounds, '1/3');
  assert.equal(run.result.callerDecision.requirements.length, 1);
  const [entry] = run.result.callerDecision.requirements;
  assert.deepEqual([entry.id, entry.status, entry.round, entry.evidence], ['gamma', NOT_JUDGED, 1, GAMMA.text]);
  assert.match(entry.next, /^add an evidence step whose evidenceFor names gamma, then judge it: bullswarm workflow plan export /);
  assert.deepEqual(run.result.verifyRounds.phases[0].notJudged, ['gamma']);
  const summary = summarizeV2Result(run.result, run.state, { runDir: run.runDir });
  assert.deepEqual(summary.callerDecision, run.result.callerDecision);
  assert.deepEqual(formatV2HandbackLines(summary).slice(0, 2), [
    'verify rounds 1/3 · verified, but some requirements were not judged — your decision:',
    `  gamma ${NOT_JUDGED} — ${GAMMA.text}`,
  ]);
});

test('an uncovered mandatory requirement is not judged and alone starts no repair; a failing covered one is still repaired', async (t) => {
  const mandatory = await runLoop(t, { work: allPassing, judge: workspaceJudge },
    { requirements: [...REQUIREMENTS, GAMMA], runId: 'wf-loop-a1b2c3' });
  assert.equal(mandatory.run.result.verified, false, 'a mandatory requirement no one judged cannot verify the run');
  assert.deepEqual(mandatory.ids, ['build-a', 'build-b', 'verify'], 'and it starts no repair by itself');
  assert.equal(mandatory.loop.rounds.length, 1);
  assert.deepEqual(mandatory.run.result.callerDecision.requirements.map((entry) => [entry.id, entry.status]), [['gamma', NOT_JUDGED]]);
  assert.match(formatV2HandbackLines(summarizeV2Result(mandatory.run.result, mandatory.run.state, { runDir: mandatory.run.runDir }))[0],
    /^verify rounds 1\/3 · not verified — your decision:$/);

  // With alpha failing, the repair is for alpha only; gamma stays with the caller.
  const failing = await runLoop(t, { work: { ...buggyBuild, 'repair-1': ({ targetDir }) => { writeFileSync(join(targetDir, 'src', 'a.js'), 'export const alpha = () => 1; // tried\n'); return '## Done\n- tried\n\n## Suggested next step\n- none'; } }, judge: workspaceJudge },
    { requirements: [...REQUIREMENTS, GAMMA], programDoc: program({ verifyRounds: 2 }), runId: 'wf-loop-d4e5f6' });
  const repair = failing.run.state.program.actions.find((action) => action.id === 'repair-1');
  assert.deepEqual(repair.affects, ['alpha'], 'the repair takes the failed requirement, not the uncovered one');
  assert.deepEqual(failing.loop.rounds[0].failed, ['alpha']);
  assert.deepEqual(failing.run.result.callerDecision.requirements.map((entry) => [entry.id, entry.status, entry.round]),
    [['alpha', 'failed', 2], ['gamma', NOT_JUDGED, 1]]);
  assert.equal(failing.run.result.callerDecision.verifyRounds, '2/2');
});

test('all pass in round 1: no repair, one round, completed · verified', async (t) => {
  const { run, loop, ids, events } = await runLoop(t, {
    work: { ...buggyBuild, 'build-a': ({ targetDir }) => { writeFileSync(join(targetDir, 'src', 'a.js'), 'export const alpha = () => 2;\n'); return '## Done\n- src/a.js'; } },
    judge: workspaceJudge,
  });
  assert.equal(run.result.status, 'completed');
  assert.equal(run.result.verified, true);
  assert.deepEqual(ids, ['build-a', 'build-b', 'verify'], 'no kernel step was added');
  assert.equal(loop.max, 3);
  assert.equal(loop.stoppedBy, 'passed');
  assert.equal(loop.rounds.length, 1);
  assert.deepEqual(loop.rounds[0].toJudge, ['alpha', 'beta']);
  assert.deepEqual(loop.rounds[0].passed, ['alpha', 'beta']);
  assert.equal(run.result.verifyRounds.used, 1);
  assert.equal(run.result.callerDecision, null);
  assert.deepEqual(events.filter((event) => event.type === 'workflow.verify-round').map((event) => [event.payload.round, event.payload.stage, event.payload.next ?? null]),
    [[1, 'started', null], [1, 'finished', 'finish']]);
  assert.equal(events.filter((event) => event.type === 'workflow.repair').length, 0);
  // A run that passed in its first round prints no round block.
  assert.deepEqual(formatV2HandbackLines(summarizeV2Result(run.result, run.state)), []);
});

test('fail → repair → pass in round 2: the kernel adds repair-1 and verify-round-2 itself', async (t) => {
  const { run, loop, ids, tasks, events } = await runLoop(t, {
    work: {
      ...buggyBuild,
      'repair-1': ({ targetDir }) => { writeFileSync(join(targetDir, 'src', 'a.js'), 'export const alpha = () => 2;\n'); return '## Done\n- alpha: fixed; node -e "alpha()" prints 2\n\n## Not done\n- none\n\n## Suggested next step\n- none'; },
    },
    judge: workspaceJudge,
  });
  assert.equal(run.result.status, 'completed');
  assert.equal(run.result.verified, true);
  assert.deepEqual(ids, ['build-a', 'build-b', 'verify', 'repair-1', 'verify-round-2']);
  const repair = run.state.program.actions.find((action) => action.id === 'repair-1');
  assert.deepEqual([repair.kind, repair.lane, repair.affects, repair.ownedFiles, repair.dependsOn], ['implement', 'build', ['alpha'], ['src/a.js'], ['verify']]);
  const verifyRound2 = run.state.program.actions.find((action) => action.id === 'verify-round-2');
  assert.deepEqual([verifyRound2.kind, verifyRound2.evidenceFor, verifyRound2.dependsOn], ['adversarial-acceptance', ['alpha'], ['repair-1']]);
  // The repair task carries the failing evidence, the not-done item and the
  // durable handoff of the step it repairs.
  assert.match(tasks['repair-1'], /## Kernel repair after verify round 1 of 3\nMake every requirement below pass\./);
  assert.match(tasks['repair-1'], /### alpha · failed in round 1 \(verify\)\nsrc\/a\.js exports alpha\(\) returning 2\.\nEvidence:\n- src\/a\.js: node -e "alpha\(\)" printed 1, expected 2/);
  assert.match(tasks['repair-1'], /### Not done in the steps that affect these requirements\n- build-a: alpha edge cases/);
  assert.match(tasks['repair-1'], /### What those steps did\n#### build-a · attempt build-a-1\n- Pool: codex/);
  assert.match(tasks['repair-1'], /Files changed inside this step's territory: src\/a\.js/);
  assert.match(tasks.verify, /Verify round 1 of 3\. A requirement you fail starts a kernel repair/);
  assert.match(tasks['verify-round-2'], /Verify round 2 of 3: re-check and discovery\. repair-1 changed: src\/a\.js\./);
  assert.match(tasks['verify-round-2'], /Carried forward, not yours to judge: beta\./);
  assert.equal(loop.stoppedBy, 'passed');
  assert.deepEqual(loop.rounds.map((round) => [round.round, round.failed, round.repairActionId]), [[1, ['alpha'], 'repair-1'], [2, [], null]]);
  assert.deepEqual(loop.rounds[0].changedFiles, ['src/a.js']);
  assert.deepEqual(run.state.attempts.find((attempt) => attempt.actionId === 'repair-1').changedFiles, ['src/a.js']);
  assert.equal(run.result.verifyRounds.used, 2);
  assert.deepEqual(run.result.verifyRounds.phases.map((phase) => [phase.kind, phase.round, phase.steps, phase.pools]),
    [['verify', 1, ['verify'], ['codex']], ['repair', 1, ['repair-1'], ['codex']], ['verify', 2, ['verify-round-2'], ['codex']]]);
  for (const phase of run.result.verifyRounds.phases) {
    assert.equal(phase.wallMinutes, 1, 'each phase ran one one-minute attempt');
    assert.equal(phase.cost, '—', 'nothing was priced, so the cost is a dash, never $0');
  }
  assert.deepEqual(events.filter((event) => ['workflow.verify-round', 'workflow.repair'].includes(event.type))
    .map((event) => `${event.type} ${event.payload.round} ${event.payload.stage}`), [
    'workflow.verify-round 1 started', 'workflow.verify-round 1 finished', 'workflow.repair 1 started',
    'workflow.repair 1 finished', 'workflow.verify-round 2 started', 'workflow.verify-round 2 finished',
  ]);
  // The kernel's plan revisions are recorded like any other, from the kernel.
  assert.deepEqual(run.state.revisions.map((entry) => [entry.id, entry.source, entry.changes.added]),
    [['kernel-loop-1-repair', 'kernel', ['repair-1']], ['kernel-loop-2-verify', 'kernel', ['verify-round-2']]]);
});

test('fail in all 3 rounds: stops with the caller-decision block, never a fourth round', async (t) => {
  const { run, loop, ids, events } = await runLoop(t, {
    work: {
      ...buggyBuild,
      'repair-1': ({ targetDir }) => { writeFileSync(join(targetDir, 'src', 'a.js'), 'export const alpha = () => 1; // tried\n'); return '## Done\n- tried\n\n## Not done\n- alpha still prints 1\n\n## Suggested next step\n- none'; },
      'repair-2': ({ targetDir }) => { writeFileSync(join(targetDir, 'src', 'a.js'), 'export const alpha = () => 1; // tried again\n'); return '## Done\n- tried again\n\n## Not done\n- alpha still prints 1\n\n## Suggested next step\n- rewrite alpha() against the spec in docs/alpha.md'; },
    },
    judge: workspaceJudge,
  });
  assert.equal(run.result.status, 'completed');
  assert.equal(run.result.verified, false);
  assert.deepEqual(ids, ['build-a', 'build-b', 'verify', 'repair-1', 'verify-round-2', 'repair-2', 'verify-round-3']);
  assert.equal(ids.includes('repair-3'), false);
  assert.equal(ids.includes('verify-round-4'), false);
  assert.equal(loop.rounds.length, 3);
  assert.equal(loop.stoppedBy, 'rounds');
  assert.equal(events.filter((event) => event.type === 'workflow.verify-round' && event.payload.stage === 'started').length, 3);
  assert.equal(events.filter((event) => event.type === 'workflow.repair' && event.payload.stage === 'started').length, 2);
  const last = events.findLast((event) => event.type === 'workflow.verify-round');
  assert.deepEqual([last.payload.round, last.payload.of, last.payload.failed, last.payload.next], [3, 3, ['alpha'], 'caller']);
  assert.match(run.result.reason, /but not verified after verify rounds 3\/3: alpha failed/);
  assert.deepEqual(run.result.callerDecision, {
    verifyRounds: '3/3',
    requirements: [{
      id: 'alpha', status: 'failed', round: 3,
      evidence: 'src/a.js: node -e "alpha()" printed 1, expected 2',
      next: 'rewrite alpha() against the spec in docs/alpha.md',
    }],
  });
  assert.deepEqual(run.result.verifyRounds.phases.map((phase) => `${phase.kind} ${phase.round}`),
    ['verify 1', 'repair 1', 'verify 2', 'repair 2', 'verify 3']);
  const summary = summarizeV2Result(run.result, run.state, { runDir: run.runDir });
  assert.deepEqual(summary.callerDecision, run.result.callerDecision);
  assert.equal(summary.verifyRounds.used, 3);
  const lines = formatV2HandbackLines(summary);
  assert.deepEqual(lines.slice(0, 9), [
    'verify rounds 3/3 · not verified — your decision:',
    '  alpha failed in round 3 — src/a.js: node -e "alpha()" printed 1, expected 2',
    '    next: rewrite alpha() against the spec in docs/alpha.md',
    'rounds:',
    '  verify round 1 · 1m · codex · —',
    '  repair round 1 · 1m · codex · —',
    '  verify round 2 · 1m · codex · —',
    '  repair round 2 · 1m · codex · —',
    '  verify round 3 · 1m · codex · —',
  ]);
  // watch: one line per round start and outcome; the last close is the
  // caller's, so it is trouble, while the failing evidence the kernel repairs is not.
  const notable = notableWatchEvents({ events, state: run.state, nowMs: Date.now() }).notable;
  // The kernel's revisions renumber the phases; a watcher replaying the whole
  // log (`watch --after 0`) still reports each phase once.
  const replay = notableWatchEvents({ events, state: run.state, nowMs: Date.now(), memory: initialWatchMemory(run.state, { replayedEvents: events }) }).notable;
  const phases = replay.filter((event) => event.type === 'stage.completed').map((event) => event.label);
  assert.deepEqual(phases, [...new Set(phases)], `a phase was reported twice: ${phases.join(' | ')}`);
  assert.equal(phases.length, 6);
  const rendered = notable.map((event) => renderWatchEvent(event)).filter((line) => /verify round|repair round/.test(line ?? ''));
  assert.deepEqual(rendered.map((line) => line.replace(/^\S+ /, '')), [
    'verify round 1 of 3 · 2 to judge',
    'verify round 1 of 3 · 1 failed · repair next',
    'repair round 1 · 1 requirement · repair-1',
    'repair round 1 finished · 1 file changed',
    'verify round 2 of 3 · 1 to re-check',
    'verify round 2 of 3 · 1 failed · repair next',
    'repair round 2 · 1 requirement · repair-2',
    'repair round 2 finished · 1 file changed',
    'verify round 3 of 3 · 1 to re-check',
  ]);
  // The caller's close is the review needs-you block (D25, D26), one wake.
  const block = notable.filter((event) => event.type === 'needs-you').map((event) => renderWatchEvent(event));
  assert.equal(block.length, 1);
  assert.match(block[0], /^✗ verify-round-3 needs you · review failed after 2 fixes$/m);
  const trouble = notable.filter((event) => watchTrouble(event) != null).map((event) => `${event.type}:${watchTrouble(event)}`);
  assert.deepEqual(trouble, ['needs-you:failed']);
  assert.equal(notable.some((event) => event.type === 'plan.revised'), false, 'kernel revisions are told by the loop lines');
});

test('a discovery item from round 2 appears in repair 2\'s task; the final round adds nothing new', async (t) => {
  const { tasks, loop } = await runLoop(t, {
    work: {
      ...buggyBuild,
      'repair-1': ({ targetDir }) => { writeFileSync(join(targetDir, 'src', 'a.js'), 'export const alpha = () => 1.5;\n'); return '## Done\n- tried'; },
      'repair-2': ({ targetDir }) => { writeFileSync(join(targetDir, 'src', 'a.js'), 'export const alpha = () => 2;\n'); return '## Done\n- alpha fixed'; },
    },
    judge: (id, ids, context) => {
      const verdicts = workspaceJudge(id, ids, context);
      if (id === 'verify-round-2') verdicts.alpha.concerns = ['Discovery: src/c.js gamma() repeats the same off-by-one', 'an ordinary concern'];
      if (id === 'verify-round-3') verdicts.alpha.concerns = ['Discovery: must not be recorded in the final round'];
      return verdicts;
    },
  });
  assert.deepEqual(loop.rounds[1].discovery, [{ requirementId: 'alpha', text: 'src/c.js gamma() repeats the same off-by-one' }]);
  assert.match(tasks['repair-2'], /### Also fix: discovery items from verify round 2\n- alpha: src\/c\.js gamma\(\) repeats the same off-by-one/);
  assert.doesNotMatch(tasks['repair-1'], /Also fix/);
  assert.match(tasks['verify-round-3'], /Verify round 3 of 3: final closure\. Re-check only whether each requirement below now passes/);
  assert.doesNotMatch(tasks['verify-round-3'], /look for \(a\) regressions/);
  assert.deepEqual(loop.rounds[2].discovery, [], 'the final round records no discovery');
  assert.equal(loop.stoppedBy, 'passed');
});

test('a passed requirement carries forward when the repair did not touch its files, and is re-judged when it did', async (t) => {
  // Not touched: beta's evidence names src/b.js; repair-1 changes src/a.js only.
  const judged = [];
  const untouched = await runLoop(t, {
    work: { ...buggyBuild, 'repair-1': ({ targetDir }) => { writeFileSync(join(targetDir, 'src', 'a.js'), 'export const alpha = () => 2;\n'); return '## Done\n- alpha'; } },
    judge: (id, ids, context) => { judged.push([id, ids]); return workspaceJudge(id, ids, context); },
  });
  assert.deepEqual(judged, [['verify', ['alpha', 'beta']], ['verify-round-2', ['alpha']]]);
  assert.deepEqual(untouched.loop.rounds[1].carried, ['beta']);
  assert.equal(untouched.run.result.requirements.find((entry) => entry.id === 'beta').evidence[0].sourceAction, 'verify', 'beta keeps its round-1 evidence');
  assert.equal(untouched.run.result.verified, true);

  // Touched: the step affecting alpha also owns src/b.js, so the repair owns
  // both, and it changes src/b.js too — beta's evidence names that file.
  const judgedAgain = [];
  const touched = await runLoop(t, {
    work: {
      ...buggyBuild,
      'repair-1': ({ targetDir }) => {
        writeFileSync(join(targetDir, 'src', 'a.js'), 'export const alpha = () => 2;\n');
        writeFileSync(join(targetDir, 'src', 'b.js'), 'export const beta = () => 3; // shared helper moved\n');
        return '## Done\n- alpha';
      },
    },
    judge: (id, ids, context) => { judgedAgain.push([id, ids]); return workspaceJudge(id, ids, context); },
  }, { programDoc: program({ buildA: { ownedFiles: ['src/a.js', 'src/b.js'] } }) });
  const repair = touched.run.state.program.actions.find((action) => action.id === 'repair-1');
  assert.deepEqual(repair.ownedFiles, ['src/a.js', 'src/b.js']);
  assert.deepEqual(touched.loop.rounds[0].changedFiles, ['src/a.js', 'src/b.js']);
  assert.deepEqual(judgedAgain, [['verify', ['alpha', 'beta']], ['verify-round-2', ['alpha', 'beta']]]);
  assert.deepEqual(touched.loop.rounds[1].carried, []);
  assert.equal(touched.run.result.requirements.find((entry) => entry.id === 'beta').evidence[0].sourceAction, 'verify-round-2');
  assert.match(touched.tasks['verify-round-2'], /- beta \(passed in round 1; repair-1 changed a file its evidence names, verify\):/);
});

test('verifyRounds: 1 keeps the single round: no repair, the caller decides at 1/1', async (t) => {
  const { run, ids, loop, tasks, events } = await runLoop(t, { work: buggyBuild, judge: workspaceJudge }, { programDoc: program({ verifyRounds: 1 }) });
  assert.deepEqual(ids, ['build-a', 'build-b', 'verify']);
  assert.equal(loop.max, 1);
  assert.equal(loop.stoppedBy, 'rounds');
  assert.equal(run.result.verified, false);
  assert.equal(run.result.callerDecision.verifyRounds, '1/1');
  assert.match(run.result.reason, /but not verified: alpha failed/, 'one round reads as it always has');
  assert.doesNotMatch(tasks.verify, /Verify round 1 of/, 'a one-round run gets no round paragraph');
  // The watch: the review's needs-you block is the one trouble line (D26); no round lines.
  const notable = notableWatchEvents({ events, state: run.state, nowMs: Date.now() }).notable;
  assert.deepEqual(notable.filter((event) => watchTrouble(event) != null).map((event) => event.type), ['needs-you']);
  assert.match(renderWatchEvent(notable.find((event) => event.type === 'needs-you')), /^✗ verify needs you · review failed · no automatic fix$/m);
  assert.equal(notable.map((event) => renderWatchEvent(event)).some((line) => /verify round/.test(line ?? '')), false);
});

test('authors still cannot declare a repair: a program carrying one is handed back unrun', async (t) => {
  const bad = program();
  bad.program = undefined;
  bad.actions[0].repair = { of: 'verify' };
  const { run, ids } = await runLoop(t, { work: buggyBuild, judge: workspaceJudge }, { programDoc: bad });
  assert.equal(run.result.status, 'partial');
  assert.deepEqual(ids, []);
  assert.match(run.result.reason, /actions\[0\]\.repair is not allowed in V2/);
});

// A revision during the loop is accepted and applied as today (design §3.8).
function queueRevisionFromState(runDir, edit) {
  const state = JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8'));
  const document = exportV2Plan(state);
  edit(document);
  queueRevisionRequest(runDir, createRevisionRequest(normalizeRevisionInput(document), { source: 'test' }));
}

test('a revision during the loop may lower the budget: verifyRounds 2 makes round 2 the final closure', async (t) => {
  let queued = false;
  const { run, loop, ids, tasks } = await runLoop(t, { work: buggyBuild, judge: workspaceJudge }, {
    onEvent: (event, { runDir }) => {
      if (queued || event.type !== 'workflow.repair' || event.payload.stage !== 'started') return;
      queued = true;
      queueRevisionFromState(runDir, (document) => {
        document.summary = 'Two rounds are enough; add a notes step.';
        document.program.defaults = { verifyRounds: 2 };
        document.program.actions.push({
          id: 'notes', purpose: 'Write down what the loop found', dependsOn: [], affects: [], ownedFiles: [],
          prompt: 'Summarise the verify evidence so far.', kind: 'io-read', evidenceFor: [], inputs: [], produces: [],
        });
      });
    },
  });
  assert.equal(loop.max, 2);
  assert.deepEqual(ids, ['build-a', 'build-b', 'verify', 'repair-1', 'notes', 'verify-round-2']);
  assert.match(tasks['verify-round-2'], /Verify round 2 of 2: final closure\./);
  assert.equal(loop.stoppedBy, 'rounds');
  assert.equal(run.result.callerDecision.verifyRounds, '2/2');
  assert.match(run.result.reason, /after verify rounds 2\/2/);
});

test('a revision that only changes verifyRounds is accepted; one that would leave the budget as it is changes nothing', async (t) => {
  let queued = false;
  const { run, loop, ids } = await runLoop(t, { work: buggyBuild, judge: workspaceJudge }, {
    onEvent: (event, { runDir }) => {
      if (queued || event.type !== 'workflow.repair' || event.payload.stage !== 'started') return;
      queued = true;
      queueRevisionFromState(runDir, (document) => {
        document.summary = 'Two rounds are enough.';
        document.program.defaults = { verifyRounds: 2 };
      });
    },
  });
  const budget = run.state.revisions.find((entry) => entry.summary === 'Two rounds are enough.');
  assert.equal(budget?.status, 'applied', JSON.stringify(run.state.revisions));
  assert.deepEqual(budget.changes, { added: [], amended: [], restored: [], removed: [], rerun: [], invalidated: [] });
  assert.equal(loop.max, 2);
  assert.deepEqual(ids, ['build-a', 'build-b', 'verify', 'repair-1', 'verify-round-2']);
  assert.equal(run.result.callerDecision.verifyRounds, '2/2');
  // Two rounds are closed: asking for 1 (clamped up to 2) or for 2 again changes nothing.
  const same = (verifyRounds) => planV2Revision(run.state, { program: { ...exportV2Plan(run.state).program, defaults: { verifyRounds } } });
  for (const verifyRounds of [1, 2]) {
    const planned = same(verifyRounds);
    assert.equal(planned.ok, false, `verifyRounds ${verifyRounds}`);
    assert.match(planned.issues[0], /the revision changes nothing/);
  }
  assert.equal(same(3).ok, true);
});

test('removing the kernel\'s repair in progress stops the loop; the run finishes with the caller-decision block', async (t) => {
  let queued = false;
  const { run, loop, ids } = await runLoop(t, { work: buggyBuild, judge: workspaceJudge }, {
    onEvent: (event, { runDir }) => {
      if (queued || event.type !== 'workflow.repair' || event.payload.stage !== 'started') return;
      queued = true;
      queueRevisionFromState(runDir, (document) => {
        document.summary = 'I will fix alpha myself.';
        document.program.actions = document.program.actions.filter((action) => action.id !== 'repair-1');
      });
    },
  });
  assert.deepEqual(ids, ['build-a', 'build-b', 'verify', 'repair-1'], 'the removed step stays in history');
  assert.equal(run.state.actions.find((action) => action.id === 'repair-1').status, 'removed');
  assert.equal(loop.stoppedBy, 'revision');
  assert.equal(loop.rounds.length, 1, 'no further kernel round');
  assert.equal(run.result.verified, false);
  assert.deepEqual(run.result.callerDecision.requirements.map((entry) => [entry.id, entry.status, entry.round]), [['alpha', 'failed', 1]]);
  assert.equal(run.result.callerDecision.verifyRounds, '1/3');
});

test('a failing requirement affected only by an act step is not repaired', async (t) => {
  const programDoc = {
    schemaVersion: 'bullswarm.workflow.program.v2',
    actions: [
      {
        id: 'send', purpose: 'Post the release note', dependsOn: [], affects: ['alpha'], ownedFiles: [],
        prompt: 'Post the note.', role: 'act', evidenceFor: [], inputs: [], produces: [],
      },
      {
        id: 'verify', purpose: 'Check the post', dependsOn: ['send'], affects: [], ownedFiles: [],
        prompt: 'Inspect the post.', kind: 'adversarial-acceptance', evidenceFor: ['alpha'], inputs: [], produces: [],
      },
    ],
  };
  const { run, loop, ids } = await runLoop(t, {
    work: { send: () => 'Posted note 42 at https://example.com/posts/42' },
    judge: () => ({ alpha: fail('the post is missing the required line') }),
  }, {
    programDoc, requirements: [REQUIREMENTS[0]], runId: 'wf-d20act-abcdef',
  });
  assert.equal(ids.includes('repair-1'), false);
  assert.equal(loop.stoppedBy, 'act-step');
  assert.equal(run.result.verifyRounds.stoppedBy, 'act-step');
  const [entry] = run.result.callerDecision.requirements;
  assert.equal(entry.id, 'alpha');
  assert.equal(entry.status, 'failed');
  const token = run.state.shortId;
  assert.equal(entry.next, `an act step affects alpha; Bullswarm never repeats an outward action on its own. Check what was done, then add an act step if it must be redone: bullswarm workflow plan export ${token} --out plan.json, edit it, then plan revise`);
});

test('a requirement affected only by report steps repairs as an analyze report', async (t) => {
  const investigate = (id) => ({
    id, purpose: `Study ${id}`, dependsOn: [], affects: ['alpha'], ownedFiles: [],
    prompt: 'Write what you found.', role: 'investigate', deliverable: 'report', evidenceFor: [], inputs: [], produces: [],
  });
  const programDoc = {
    schemaVersion: 'bullswarm.workflow.program.v2',
    actions: [
      investigate('study-a'),
      investigate('study-b'),
      {
        id: 'verify', purpose: 'Check the studies', dependsOn: ['study-a', 'study-b'], affects: [], ownedFiles: [],
        prompt: 'Read both reports.', kind: 'adversarial-acceptance', evidenceFor: ['alpha'], inputs: [], produces: [],
      },
    ],
  };
  const { run, ids } = await runLoop(t, {
    work: {
      'study-a': () => 'alpha returns 1 today',
      'study-b': () => 'the spec asks for 2',
      'repair-1': () => 'alpha should return 2. The two studies agree.',
    },
    judge: (id) => (id === 'verify'
      ? { alpha: fail('neither study shows alpha returning 2') }
      : { alpha: pass('the repair report names the return value') }),
  }, {
    programDoc, requirements: [REQUIREMENTS[0]], runId: 'wf-d20rep-abcdef',
  });
  assert.equal(ids.includes('repair-1'), true);
  const repair = run.state.program.actions.find((action) => action.id === 'repair-1');
  assert.equal(repair.lane, 'analyze');
  assert.deepEqual(repair.deliverable, { type: 'report' });
  assert.deepEqual(repair.ownedFiles, []);
  const attempt = run.state.attempts.find((item) => item.actionId === 'repair-1');
  assert.equal(attempt.status, 'succeeded');
  assert.deepEqual(attempt.deliverable, { type: 'report', gated: true, produced: true });
  assert.ok(readFileSync(attempt.outputFile, 'utf8').length > 0);
});

test('a repair of an ignored data path inherits that path and the rewrite counts', async (t) => {
  const programDoc = {
    schemaVersion: 'bullswarm.workflow.program.v2',
    actions: [
      {
        id: 'summarize', purpose: 'Write the summary', dependsOn: [], affects: ['alpha'], ownedFiles: [],
        prompt: 'Write out/summary.json.', role: 'produce',
        deliverable: { type: 'data', paths: ['out/summary.json'] },
        evidenceFor: [], inputs: [], produces: [],
      },
      {
        id: 'verify', purpose: 'Check the summary', dependsOn: ['summarize'], affects: [], ownedFiles: [],
        prompt: 'Read out/summary.json.', kind: 'adversarial-acceptance', evidenceFor: ['alpha'], inputs: [], produces: [],
      },
    ],
  };
  const { run, loop } = await runLoop(t, {
    work: {
      summarize: ({ targetDir }) => {
        writeFileSync(join(targetDir, 'out', 'summary.json'), '{"ok":false}\n');
        return 'Wrote out/summary.json';
      },
      'repair-1': ({ targetDir }) => {
        writeFileSync(join(targetDir, 'out', 'summary.json'), '{"ok":true}\n');
        return 'Rewrote out/summary.json';
      },
    },
    judge: (_id, _ids, { targetDir }) => (read(targetDir, 'out/summary.json').includes('"ok":true')
      ? { alpha: pass('out/summary.json is fixed') }
      : { alpha: fail('out/summary.json is still wrong') }),
  }, {
    programDoc,
    requirements: [{ id: 'alpha', text: 'out/summary.json records ok true.' }],
    runId: 'wf-d20dat-abcdef',
    prepare: (workspace) => {
      writeFileSync(join(workspace, '.gitignore'), 'out/\n');
      mkdirSync(join(workspace, 'out'));
    },
  });
  assert.deepEqual(repairInheritedPaths(run.state, 'repair-1'), ['out/summary.json']);
  const repair = run.state.program.actions.find((action) => action.id === 'repair-1');
  assert.equal(repair.kind, 'implement');
  assert.equal(repair.deliverable, undefined);
  const attempt = run.state.attempts.find((item) => item.actionId === 'repair-1');
  assert.equal(attempt.status, 'succeeded');
  assert.ok(attempt.changedFiles.includes('out/summary.json'));
  assert.deepEqual(loop.rounds[0].changedFiles, ['out/summary.json']);
});


// --- Stage 3, marked runs (D12, D13, D19, D33) ------------------------------

const loopNeedsYou = (run, events) => notableWatchEvents({ events, state: run.state, nowMs: Date.now() }).notable
  .filter((event) => event.type === 'needs-you').map((event) => renderWatchEvent(event));
const stillOne = ({ targetDir }) => { writeFileSync(join(targetDir, 'src', 'a.js'), 'export const alpha = () => 1; // tried\n'); return '## Done\n- tried\n\n## Not done\n- alpha still prints 1'; };

test('marked default: one fix and one re-review, then the caller (max 2, stoppedBy rounds); kernel steps inherit the route', async (t) => {
  const programDoc = program({ buildA: { route: { pools: { avoid: ['grok'] } } } });
  programDoc.actions[2].route = { providers: { avoid: ['grok'] } };
  const { run, loop, ids, events } = await runLoop(t, { work: { ...buggyBuild, 'repair-1': stillOne }, judge: workspaceJudge },
    { features: STAGE3_RUN_FEATURES, programDoc });
  assert.equal(loop.max, 2, 'verifyRounds counts fixes: default 1 → two review rounds');
  assert.deepEqual(ids, ['build-a', 'build-b', 'verify', 'repair-1', 'verify-round-2']);
  assert.equal(loop.stoppedBy, 'rounds');
  assert.equal(run.result.verified, false);
  assert.equal(run.result.callerDecision.verifyRounds, '2/2');
  const last = events.findLast((event) => event.type === 'workflow.verify-round');
  assert.deepEqual([last.payload.round, last.payload.of, last.payload.next], [2, 2, 'caller']);
  // D19: the repair inherits the affecting step's route, the re-review round 1's check's.
  const byId = Object.fromEntries(run.state.program.actions.map((action) => [action.id, action]));
  assert.deepEqual(byId['repair-1'].route, { pools: { avoid: ['grok'] } });
  assert.deepEqual(byId['verify-round-2'].route, { providers: { avoid: ['grok'] } });
  // No authored evidence: nothing to inherit, and the counts say so.
  assert.equal(Object.hasOwn(byId['repair-1'], 'evidence'), false);
  const started = events.find((event) => event.type === 'workflow.repair' && event.payload.stage === 'started').payload;
  assert.deepEqual([started.evidenceInherited, started.evidenceDropped], [0, 0]);
  const [block] = loopNeedsYou(run, events);
  assert.match(block, /^✗ verify-round-2 needs you · review failed after 1 fix$/m);
});

test('marked verifyRounds 0: review only, no automatic fix', async (t) => {
  const programDoc = { ...program(), defaults: { verifyRounds: 0 } };
  const { run, loop, ids, events } = await runLoop(t, { work: buggyBuild, judge: workspaceJudge }, { features: STAGE3_RUN_FEATURES, programDoc });
  assert.equal(loop.max, 1);
  assert.deepEqual(ids, ['build-a', 'build-b', 'verify']);
  assert.equal(run.result.callerDecision.verifyRounds, '1/1');
  assert.match(loopNeedsYou(run, events)[0], /^✗ verify needs you · review failed · no automatic fix/m);
});

test('a saved run with no marker keys keeps its old loop: three review rounds', async (t) => {
  const { loop } = await runLoop(t, { work: allPassing, judge: workspaceJudge }, { features: {} });
  assert.equal(loop.max, 3);
});

// build-a, build-b and verify as usual, plus an unrelated step that fails.
function withUnrelatedFailure() {
  const doc = program();
  doc.actions.push(work('docs', { affects: ['gamma'], ownedFiles: ['src/c.js'] }));
  return doc;
}
const failingDocs = { ...buggyBuild, docs: () => ({ fail: 'docs writer crashed' }) };

test('marked: an unrelated failed step no longer cancels the repair of an independent failed review (D12)', async (t) => {
  const marked = await runLoop(t, {
    work: { ...failingDocs, 'repair-1': ({ targetDir }) => { writeFileSync(join(targetDir, 'src', 'a.js'), 'export const alpha = () => 2;\n'); return '## Done\n- fixed'; } },
    judge: workspaceJudge,
  }, { features: STAGE3_RUN_FEATURES, programDoc: withUnrelatedFailure(), requirements: [...REQUIREMENTS, { ...GAMMA, mandatory: false }] });
  assert.deepEqual(marked.ids, ['build-a', 'build-b', 'verify', 'docs', 'repair-1', 'verify-round-2']);
  assert.equal(marked.run.result.status, 'partial');
  assert.equal(marked.run.state.ledger.requirements.alpha.status, 'passed', 'the repair ran and the re-review passed');
  assert.equal(marked.run.state.actions.find((action) => action.id === 'docs').status, 'failed');
  // docs got its one retry (same pool: the only candidate), then the caller.
  assert.equal(marked.run.state.attempts.filter((attempt) => attempt.actionId === 'docs').length, 2);

  // The unmarked twin settles with the caller at the first failure.
  const unmarked = await runLoop(t, { work: failingDocs, judge: workspaceJudge },
    { programDoc: withUnrelatedFailure(), requirements: [...REQUIREMENTS, { ...GAMMA, mandatory: false }], runId: 'wf-loop-a1b2c3' });
  assert.deepEqual(unmarked.ids, ['build-a', 'build-b', 'verify', 'docs']);
  const closed = unmarked.events.findLast((event) => event.type === 'workflow.verify-round');
  assert.equal(closed.payload.next, 'caller');
  assert.equal(unmarked.loop.stoppedBy, 'step-failed');
});

test('marked, the common shape: a failed writer\'s check is blocked, the other check\'s failure is still repaired, and the blocked requirement goes to the caller', async (t) => {
  const check = (id, dependsOn, evidenceFor) => verify({ id, dependsOn, evidenceFor, prompt: `Inspect ${evidenceFor.join(', ')}.` });
  const programDoc = {
    schemaVersion: 'bullswarm.workflow.program.v2',
    actions: [
      work('build-a', { affects: ['alpha'], ownedFiles: ['src/a.js'] }),
      check('check-a', ['build-a'], ['alpha']),
      work('build-b', { affects: ['beta'], ownedFiles: ['src/b.js'] }),
      check('check-b', ['build-b'], ['beta']),
    ],
  };
  const { run, ids, loop, events } = await runLoop(t, {
    work: {
      'build-a': () => ({ fail: 'build-a crashed' }),
      'build-b': ({ targetDir }) => { writeFileSync(join(targetDir, 'src', 'b.js'), 'export const beta = () => 0; // wrong\n'); return '## Done\n- src/b.js'; },
      'repair-1': ({ targetDir }) => { writeFileSync(join(targetDir, 'src', 'b.js'), 'export const beta = () => 3;\n'); return '## Done\n- beta fixed'; },
    },
    judge: workspaceJudge,
  }, { features: STAGE3_RUN_FEATURES, programDoc });
  const status = Object.fromEntries(run.state.actions.map((action) => [action.id, action.status]));
  assert.deepEqual(status, { 'build-a': 'failed', 'check-a': 'blocked', 'build-b': 'succeeded', 'check-b': 'succeeded', 'repair-1': 'succeeded', 'verify-round-2': 'succeeded' });
  assert.deepEqual(ids, ['build-a', 'check-a', 'build-b', 'check-b', 'repair-1', 'verify-round-2']);
  // Round 1 closed at `partial` with check-a blocked: alpha is failing (the caller's), beta repaired.
  assert.deepEqual(loop.rounds[0].failed, ['alpha', 'beta']);
  const repair = run.state.program.actions.find((action) => action.id === 'repair-1');
  assert.deepEqual(repair.dependsOn, ['check-b'], 'never born blocked behind check-a');
  assert.deepEqual(repair.affects, ['beta']);
  const verifyRound2 = run.state.program.actions.find((action) => action.id === 'verify-round-2');
  assert.deepEqual([verifyRound2.dependsOn, verifyRound2.evidenceFor], [['repair-1'], ['beta']]);
  assert.equal(run.state.ledger.requirements.beta.status, 'passed');
  assert.notEqual(run.state.ledger.requirements.alpha.status, 'passed');
  assert.equal(run.state.attempts.some((attempt) => attempt.actionId.startsWith('repair') && /alpha/.test(attempt.taskFile ?? '')), false);
  assert.equal(run.result.status, 'partial');
  const round1 = events.find((event) => event.type === 'workflow.verify-round' && event.payload.round === 1 && event.payload.stage === 'finished');
  assert.deepEqual([round1.payload.failed, round1.payload.next], [['alpha', 'beta'], 'repair']);
});

const EVIDENCE_A = [
  { type: 'command', cmd: 'test -f src/a.js' },
  { type: 'command', cmd: 'grep -q alpha src/a.js' },
  { type: 'schema', file: 'data/a.json', schema: 'schemas/a.json' },
  { type: 'command', cmd: 'test -s "$BULLSWARM_STEP_OUTPUT"' },
  { type: 'command', cmd: 'grep -q export src/a.js' },
];
const EVIDENCE_C = [
  { type: 'command', cmd: 'test -f src/a.js' },
  { type: 'command', cmd: 'test -r src/a.js' },
  { type: 'command', cmd: 'grep -q const src/a.js' },
  { type: 'command', cmd: 'test -s src/a.js' },
];
const seedSchema = (workspace) => {
  mkdirSync(join(workspace, 'data'));
  mkdirSync(join(workspace, 'schemas'));
  writeFileSync(join(workspace, 'data', 'a.json'), '{"ok":true}\n');
  writeFileSync(join(workspace, 'schemas', 'a.json'), JSON.stringify({ type: 'object', required: ['ok'] }));
};
function inheritingProgram() {
  const doc = program({ buildA: { evidence: EVIDENCE_A } });
  doc.actions.splice(1, 0, work('build-c', { affects: ['alpha'], ownedFiles: ['src/c.js'], evidence: EVIDENCE_C }));
  doc.actions.find((action) => action.id === 'verify').dependsOn.push('build-c');
  return doc;
}
const buggyWithC = { ...buggyBuild, 'build-c': ({ targetDir }) => { writeFileSync(join(targetDir, 'src', 'c.js'), 'export const gamma = () => 4;\n'); return '## Done\n- src/c.js'; } };

test('marked: a files repair runs the evidence of the steps it repairs (D33); the unmarked twin carries none', async (t) => {
  const fixed = ({ targetDir }) => { writeFileSync(join(targetDir, 'src', 'a.js'), 'export const alpha = () => 2;\n'); return '## Done\n- fixed'; };
  const marked = await runLoop(t, { work: { ...buggyWithC, 'repair-1': fixed }, judge: workspaceJudge },
    { features: STAGE3_RUN_FEATURES, programDoc: inheritingProgram(), prepare: seedSchema });
  const repair = marked.run.state.program.actions.find((action) => action.id === 'repair-1');
  assert.deepEqual(repair.ownedFiles, ['src/a.js', 'src/c.js']);
  // Affecting-step order then item order, de-duplicated, the first five; the
  // schema outside the repair's reach and the step-output command are dropped.
  assert.deepEqual(repair.evidence.map((item) => item.cmd), ['test -f src/a.js', 'grep -q alpha src/a.js', 'grep -q export src/a.js', 'test -r src/a.js', 'grep -q const src/a.js']);
  const started = marked.events.find((event) => event.type === 'workflow.repair' && event.payload.stage === 'started').payload;
  assert.deepEqual([started.evidenceInherited, started.evidenceDropped], [5, 3]);
  const repairAttempt = marked.run.state.attempts.find((attempt) => attempt.actionId === 'repair-1');
  assert.deepEqual(repairAttempt.evidenceResults.map((item) => item.status), ['passed', 'passed', 'passed', 'passed', 'passed']);
  assert.equal(marked.run.result.verified, true);

  const unmarked = await runLoop(t, { work: { ...buggyWithC, 'repair-1': fixed }, judge: workspaceJudge },
    { programDoc: inheritingProgram(), prepare: seedSchema, runId: 'wf-loop-d4e5f6' });
  const plain = unmarked.run.state.program.actions.find((action) => action.id === 'repair-1');
  assert.equal(Object.hasOwn(plain, 'evidence'), false);
  const plainStarted = unmarked.events.find((event) => event.type === 'workflow.repair' && event.payload.stage === 'started').payload;
  assert.equal(Object.hasOwn(plainStarted, 'evidenceInherited'), false);
});

test('marked: an inherited check the repair fails makes it failed-evidence, one same-pool retry, then the needs-you block for repair-1', async (t) => {
  const programDoc = program({ buildA: { evidence: [{ type: 'command', cmd: '! grep -q tried src/a.js' }] } });
  const { run, events } = await runLoop(t, { work: { ...buggyBuild, 'repair-1': stillOne }, judge: workspaceJudge },
    { features: STAGE3_RUN_FEATURES, programDoc });
  const attempts = run.state.attempts.filter((attempt) => attempt.actionId === 'repair-1');
  assert.deepEqual(attempts.map((attempt) => [attempt.status, attempt.failureKind]), [['interrupted', 'failed-evidence'], ['failed', 'failed-evidence']]);
  assert.deepEqual(attempts[1].retryOf, { attempt: 'repair-1-1', how: 'same-pool' });
  assert.equal(attempts[1].pool, attempts[0].pool);
  const finished = events.findLast((event) => event.type === 'action.finished' && event.payload.actionId === 'repair-1').payload;
  assert.deepEqual([finished.status, finished.failureKind, finished.retries, finished.attemptIds], ['failed', 'failed-evidence', 1, ['repair-1-1', 'repair-1-2']]);
  assert.equal(run.result.status, 'partial');
  const blocks = loopNeedsYou(run, events);
  assert.equal(blocks.some((block) => /^✗ repair-1 needs you · command evidence failed after 1 retry$/m.test(block)), true, blocks.join('\n---\n'));
});

test('marked: a report repair inherits no evidence', async (t) => {
  const investigate = (id) => ({
    id, purpose: `Study ${id}`, dependsOn: [], affects: ['alpha'], ownedFiles: [],
    prompt: 'Write what you found.', role: 'investigate', deliverable: 'report', evidenceFor: [], inputs: [], produces: [],
    evidence: [{ type: 'command', cmd: 'true' }],
  });
  const programDoc = {
    schemaVersion: 'bullswarm.workflow.program.v2',
    actions: [investigate('study-a'), {
      id: 'verify', purpose: 'Check the study', dependsOn: ['study-a'], affects: [], ownedFiles: [],
      prompt: 'Read the report.', kind: 'adversarial-acceptance', evidenceFor: ['alpha'], inputs: [], produces: [],
    }],
  };
  const { run, events } = await runLoop(t, {
    work: { 'study-a': () => 'alpha returns 1 today', 'repair-1': () => 'alpha should return 2.' },
    judge: (id) => (id === 'verify' ? { alpha: fail('the study does not show 2') } : { alpha: pass('the repair names 2') }),
  }, { features: STAGE3_RUN_FEATURES, programDoc, requirements: [REQUIREMENTS[0]], runId: 'wf-d33rep-abcdef' });
  const repair = run.state.program.actions.find((action) => action.id === 'repair-1');
  assert.equal(repair.lane, 'analyze');
  assert.equal(Object.hasOwn(repair, 'evidence'), false);
  const started = events.find((event) => event.type === 'workflow.repair' && event.payload.stage === 'started').payload;
  assert.deepEqual([started.evidenceInherited, started.evidenceDropped], [0, 1]);
});
