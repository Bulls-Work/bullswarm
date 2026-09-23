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
import { formatV2HandbackLines, summarizeV2Result } from '../src/workflow/v2-outcome.js';
import { initialWatchMemory, notableWatchEvents, renderWatchEvent, watchTrouble } from '../src/workflow/watch-cli.js';
import { clearTimeBoxHistoryCache } from '../src/workflow/time-box.js';
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
 * returns the evidence for one verify step's requirements.
 */
async function runLoop(t, scenario, { programDoc = program(), runId = 'wf-loop-abcdef', onEvent = null, requirements = REQUIREMENTS } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-loop-kernel-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'repo');
  const bullswarmDir = join(root, 'home');
  mkdirSync(join(workspace, 'src'), { recursive: true });
  mkdirSync(bullswarmDir);
  writeFileSync(join(workspace, 'src', 'a.js'), 'export const alpha = () => 0;\n');
  writeFileSync(join(workspace, 'src', 'b.js'), 'export const beta = () => 0;\n');
  writeFileSync(join(workspace, 'src', 'c.js'), 'export const gamma = () => 0;\n');
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
    const report = handler?.({ targetDir, task }) ?? `## Done\n- ${id}\n\n## Not done\n- none\n\n## Suggested next step\n- none`;
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
    'verify round 3 of 3 · 1 failed · your decision',
  ]);
  const trouble = notable.filter((event) => watchTrouble(event) != null).map((event) => `${event.type}:${watchTrouble(event)}`);
  assert.deepEqual(trouble, ['verify.round:rejected']);
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
  // Today's watch: the failing evidence is the trouble line; no round lines.
  const notable = notableWatchEvents({ events, state: run.state, nowMs: Date.now() }).notable;
  assert.deepEqual(notable.filter((event) => watchTrouble(event) != null).map((event) => event.type), ['evidence.recorded']);
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
