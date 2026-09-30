// `bullswarm workflow step restart | rerun | accept`: the caller's answers to
// one step that looks stale or failed.

import { V2_TERMINAL_STATUSES } from './status.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveRunId, isLegacyRunState, v2RunnerLiveness } from './short-id.js';
import { readEvents } from './events.js';
import { poolCausedPools } from './step-vocabulary.js';
import { deserializeV2DurableState } from './v2-state.js';
import { reviseV2Program } from './run-control.js';
import { clearStepRestart, prepareV2DispatchPools, readStepRestarts, requestStepRestart } from './v2-dispatch.js';
import { readRunFeatures, runFeatureFlags } from './run-features.js';
import { poolPassesRoute, resolveRouteFilter, routeSummary } from './step-route.js';
import { createRevisionRequest, exportV2Plan, planV2Revision } from './v2-revision.js';
import { isProgramWorkflow } from './execution-policy.js';
import { helpText, usageLine } from '../help.js';
import { changeStepHint, rerunStepHint } from './step-change-hint.js';
import { loadPoolLabels, withPoolLabels } from '../lib/pool-labels.js';
import { flagErrors } from './workflow-flags.js';
import { BULLSWARM_DIR, legacyRunRefusal } from './cli-run-lookup.js';
import { routePoolIssues, configuredPools } from './cli-pool-checks.js';
import { launchDetachedResume } from './cli-launch.js';

// --- workflow step restart ---------------------------------------------------
// The caller's answer to a `looks stale` line. Nothing restarts on its own:
// this writes the intent (see requestStepRestart in v2-dispatch.js), and the
// run's live kernel stops the step's running attempt and queues it again with
// the stopped attempt's handoff block, on --pool when given.

/**
 * Request a restart of one running step and wait up to waitMs for its kernel
 * to apply it. Resolves {code, status: restarted|refused|requested|error, ...};
 * code is the exit code the CLI returns. poolNames, when given, is the set a
 * --pool value must belong to.
 */
export async function restartV2Step({
  bullswarmDir, token, stepId, pool = null, poolNames = null, pools = null,
  waitMs = 60_000, pollMs = 200, now = () => new Date().toISOString(),
} = {}) {
  const fail = (code, why, extra = {}) => ({ code, status: 'error', why, ...extra });
  const resolved = resolveRunId(bullswarmDir, token);
  if (!resolved) return fail(1, `no run found for "${token}"`);
  let state;
  try { state = JSON.parse(readFileSync(join(resolved.runDir, 'state.json'), 'utf8')); }
  catch { return fail(1, `run "${token}" has no readable state.json`); }
  if (isLegacyRunState(state)) return fail(2, `run "${token}" is not an autonomous V2 run`);
  const id = state.shortId ?? state.runId;
  const base = { runId: state.runId, shortId: state.shortId ?? null, step: stepId };
  const status = state.lifecycle?.status ?? 'unknown';
  if (V2_TERMINAL_STATUSES.has(status)) {
    return fail(1, `run ${id} already finished (${status}); nothing is running. Retry its unfinished steps with: bullswarm workflow resume ${id}`, base);
  }
  if (!(state.program?.actions ?? []).some((action) => action.id === stepId)) {
    return fail(1, `run ${id} has no step "${stepId}"`, base);
  }
  const running = (state.attempts ?? []).findLast((attempt) => attempt.actionId === stepId && attempt.status === 'running');
  if (!running) {
    const stepStatus = (state.actions ?? []).find((action) => action.id === stepId)?.status ?? 'unknown';
    return fail(1, `step ${stepId} is not running (${stepStatus}); restart stops a running attempt. `
      + `To run it again: ${rerunStepHint(state, id, stepId)}`, base);
  }
  if (!v2RunnerLiveness(state, { runDir: resolved.runDir }).alive) {
    return fail(1, `the kernel of ${id} is not running, so nothing can stop ${running.id}; `
      + `bullswarm workflow resume ${id} restarts its interrupted steps with their handoff`, base);
  }
  if (pool && Array.isArray(poolNames) && !poolNames.includes(pool)) {
    return fail(2, `unknown pool "${pool}"; configured pools: ${poolNames.join(', ') || 'none'}`, base);
  }
  // D18: a restart pin never overrides the step's route.
  const definition = state.program.actions.find((action) => action.id === stepId);
  if (pool && definition?.route) {
    const filter = resolveRouteFilter(state, definition, pools ?? []);
    const target = (pools ?? []).find((entry) => entry?.name === pool) ?? pool;
    if (filter && !poolPassesRoute(target, filter)) {
      // Point at what works on a running step: restart on an allowed pool, or
      // change the route (an amendment restarts the step). Not step rerun,
      // which refuses a running step.
      const allowed = (pools ?? []).filter((entry) => entry?.name && entry.name !== pool && entry.enabled !== false && poolPassesRoute(entry, filter)).map((entry) => entry.name);
      const restart = allowed.length
        ? `restart it on a pool the route allows: bullswarm workflow step restart ${id} ${stepId} --pool ${allowed[0]} (allowed: ${allowed.join(', ')}), or without --pool; or `
        : '';
      return fail(2, `step ${stepId}'s route does not allow pool ${pool} (${filter.summary}); ${restart}change the route: ${changeStepHint(state, id)}`, base);
    }
  }
  const request = requestStepRestart(resolved.runDir, { actionId: stepId, attemptId: running.id, pool, now });
  const outcome = { ...base, requestId: request.id, stoppedAttemptId: running.id, stoppedPool: running.pool ?? null, pool: request.pool };
  const deadline = Date.now() + Math.max(0, waitMs);
  for (;;) {
    const answer = readEvents(resolved.runDir).findLast((event) => ['step.restarted', 'step.restart_refused'].includes(event.type)
      && event.payload?.requestId === request.id);
    if (answer?.type === 'step.restarted') return { code: 0, status: 'restarted', ...outcome, stoppedAttemptId: answer.payload.attemptId ?? running.id };
    if (answer) return { code: 1, status: 'refused', why: answer.payload?.why ?? 'the kernel refused the restart', ...outcome };
    if (Date.now() >= deadline) return { code: 0, status: 'requested', ...outcome };
    await new Promise((done) => setTimeout(done, pollMs));
  }
}

// --- workflow step rerun / accept (stage 3 §2.7, §2.8) -----------------------
// Both are plan revisions the CLI builds for the caller, so they work with a
// live kernel or offline, reopen a finished run, and leave an audit record.
// rerun adds --avoid pools to the step's route and hands the last failed
// attempt's handoff to the next attempt through an already-applied restart
// intent that counts only once its revision is applied (D20). accept records
// a failed step, or a check's failing requirements, as the caller's choice.

const STEP_UNFINISHED = new Set(['failed', 'cancelled', 'interrupted', 'blocked']);

const OLD_KERNEL_HINT = (id) => `  the run's kernel predates step rerun/accept: bullswarm workflow pause ${id}, run this again, then bullswarm workflow resume ${id}`;

// The failed (or cancelled, interrupted) step at the root of why `stepId`
// cannot run, with its status.
function blockingRoot(state, stepId, seen = new Set()) {
  const definitions = new Map(state.program.actions.map((action) => [action.id, action]));
  const statusOf = (id) => state.actions.find((action) => action.id === id)?.status;
  for (const dependency of definitions.get(stepId)?.dependsOn ?? []) {
    if (seen.has(dependency)) continue;
    seen.add(dependency);
    const status = statusOf(dependency);
    if (status === 'blocked' || status === 'pending') {
      const deeper = blockingRoot(state, dependency, seen);
      if (deeper) return deeper;
      if (status === 'blocked') return { id: dependency, status };
    } else if (STEP_UNFINISHED.has(status)) return { id: dependency, status };
  }
  return null;
}

function currentStepAttempts(state, runtime) {
  return (state.attempts ?? [])
    .filter((attempt) => attempt.actionId === runtime.id && attempt.ordinal > (runtime.supersededAttempts ?? 0))
    .sort((left, right) => left.ordinal - right.ordinal);
}

// Load a program run for a step verb, or return the refusal.
function loadStepRun(bullswarmDir, token, stepId, verb) {
  const resolved = resolveRunId(bullswarmDir, token);
  if (!resolved) return { refusal: { code: 1, why: `no run found for "${token}"` } };
  let state;
  try { state = deserializeV2DurableState(readFileSync(join(resolved.runDir, 'state.json'), 'utf8')); }
  catch (err) { return { refusal: { code: 1, why: `run "${token}" has no readable state.json (${err.message})` } }; }
  const id = state.shortId ?? state.runId;
  if (!isProgramWorkflow(state)) return { refusal: { code: 1, why: `run ${id} is not a program-mode run; step ${verb} needs a run started with --program` } };
  const runtime = state.actions.find((action) => action.id === stepId);
  if (!runtime || runtime.status === 'removed' || !state.program.actions.some((action) => action.id === stepId)) {
    return { refusal: { code: 1, why: `run ${id} has no step "${stepId}"` } };
  }
  return { resolved, state, id, runtime };
}

function stepError(code, why, extra = {}) {
  return { code, status: 'error', why, ...extra };
}

// Delete the rerun's own intent only: a newer intent for the step stays.
function dropRerunIntent(runDir, intent) {
  if (!intent) return;
  const current = readStepRestarts(runDir).find((entry) => entry.actionId === intent.actionId);
  if (current?.id === intent.id) clearStepRestart(runDir, intent.actionId);
}

function oldKernelRejection(issues) {
  return issues.some((issue) => /\.route\b[^;]*not allowed|route is not allowed/.test(issue))
    || issues.some((issue) => issue.startsWith('the revision changes nothing'));
}

/**
 * `workflow step rerun`: resolves {code, status: applied|queued|rejected|error, ...}.
 * `pools` is the configured pool list (objects), `labels` maps pool ids to
 * labels, and `relaunch(doc, runId)` starts a kernel after an offline apply.
 */
export async function rerunV2Step({
  bullswarmDir, token, stepId, avoid = [], pools = null, labels = {},
  waitMs = 120_000, pollMs = 250, now = () => new Date().toISOString(), relaunch = null,
} = {}) {
  const loaded = loadStepRun(bullswarmDir, token, stepId, 'rerun');
  if (loaded.refusal) return stepError(loaded.refusal.code, loaded.refusal.why);
  const { resolved, state, id, runtime } = loaded;
  const base = { runId: state.runId, shortId: state.shortId ?? null, step: stepId };
  const status = runtime.status;
  if (status === 'running') return stepError(1, `step ${stepId} is running; to stop it and run it again: bullswarm workflow step restart ${id} ${stepId} [--pool <pool>]`, base);
  if (status === 'blocked') {
    const root = blockingRoot(state, stepId);
    return stepError(1, `step ${stepId} is blocked by ${root?.id ?? 'a failed dependency'} (${root?.status ?? 'failed'}); rerun or accept ${root?.id ?? 'it'} first`, base);
  }
  if (status === 'pending' && !avoid.length) return stepError(1, `step ${stepId} has not run yet; nothing to rerun (add --avoid to keep it off a pool when it runs)`, base);

  // Pool names: ids stay, a label resolves to its id, anything else is refused.
  const configured = (pools ?? []).map((pool) => pool.name);
  const idByLabel = new Map(Object.entries(labels ?? {}).map(([poolId, label]) => [label, poolId]));
  const avoided = [];
  const notes = [];
  for (const name of avoid) {
    if (configured.includes(name)) { if (!avoided.includes(name)) avoided.push(name); continue; }
    const poolId = idByLabel.get(name);
    if (poolId && configured.includes(poolId)) {
      if (!avoided.includes(poolId)) avoided.push(poolId);
      notes.push(`(label "${name}" is pool ${poolId})`);
      continue;
    }
    return stepError(2, `unknown pool "${name}"; configured pools: ${configured.join(', ') || 'none'}`, base);
  }

  const document = exportV2Plan(state);
  const definition = document.program.actions.find((action) => action.id === stepId);
  if (avoided.length) {
    const route = definition.route ? JSON.parse(JSON.stringify(definition.route)) : {};
    const use = route.pools?.use ?? null;
    if (use && use.every((name) => avoided.includes(name))) {
      return stepError(2, `step ${stepId} may only use ${use.join(', ')} (route.pools.use); avoiding ${use.length === 1 ? 'it' : 'them'} leaves nothing. Change its route: ${changeStepHint(state, id)}`, base);
    }
    route.pools = { ...(route.pools ?? {}) };
    route.pools.avoid = [...new Set([...(route.pools.avoid ?? []), ...avoided])].sort();
    if (use) route.pools.use = use.filter((name) => !avoided.includes(name));
    definition.route = route;
  }
  // §2.4: the route CLI checks run at every step rerun, not only with --avoid,
  // so a route today's pools cannot serve is refused before anything is written.
  if (definition.route) {
    const doc = (() => { try { return JSON.parse(readFileSync(join(resolved.runDir, 'goal.json'), 'utf8')); } catch { return state; } })();
    if (avoided.length) {
      const routing = doc?.config?.workerRouting ?? {};
      const filter = resolveRouteFilter(state, definition, pools ?? []);
      const capable = prepareV2DispatchPools(pools ?? [], definition, definition.effort ?? 'medium', {
        preferredModel: routing.model ?? routing.preferredModel ?? null, strictPool: routing.strictPool ?? routing.pool ?? null,
        routeFilter: filter, ignoreBurstGate: true,
      }).filter((pool) => poolPassesRoute(pool, filter));
      if (!capable.length) {
        return stepError(2, `no pool could run ${stepId} after avoiding ${avoided.join(', ')} (${definition.lane}/${definition.effort} work); rerun without --avoid, or change the step's effort or route`, base);
      }
    }
    const routeIssues = routePoolIssues([definition], pools, doc, labels, state);
    if (routeIssues.length) return { code: 2, status: 'rejected', issues: routeIssues, ...base };
  }

  const attempts = currentStepAttempts(state, runtime);
  const last = attempts.at(-1) ?? null;
  const handoffFrom = status !== 'pending' && last && ['failed', 'interrupted', 'cancelled'].includes(last.status) ? last : null;
  const lastText = last ? ` (last attempt: ${last.failureKind ?? last.status}${last.pool ? ` on ${last.pool}` : ''})` : '';
  const body = {
    summary: `step rerun ${stepId}${avoided.length ? ` avoiding ${avoided.join(', ')}` : ''}${lastText}`,
    baseRevision: state.program.revision,
    program: document.program,
    rerun: status === 'pending' ? [] : [stepId],
    steeringIds: [],
    ...(avoided.length ? { avoidRoute: [stepId] } : {}),
  };
  const features = runFeatureFlags(readRunFeatures(resolved.runDir));
  const precheck = planV2Revision(state, body, { features });
  if (!precheck.ok) return { code: 2, status: 'rejected', issues: precheck.issues, ...base };

  const request = createRevisionRequest(body, { source: 'step-rerun', now });
  const intent = handoffFrom ? requestStepRestart(resolved.runDir, {
    actionId: stepId, attemptId: handoffFrom.id, pool: null, source: 'step-rerun',
    revisionRequestId: request.id, appliedAt: now(), now,
  }) : null;
  let outcome;
  try { outcome = await reviseV2Program({ bullswarmDir, runId: state.runId, request, waitMs, pollMs, now }); }
  catch (err) { dropRerunIntent(resolved.runDir, intent); return stepError(1, err.message, base); }
  const result = {
    ...base, requestId: request.id, avoid: avoided, notes,
    handoffFrom: handoffFrom?.id ?? null,
    handoff: handoffFrom ? { attemptId: handoffFrom.id, failureKind: handoffFrom.failureKind ?? handoffFrom.status, pool: handoffFrom.pool ?? null } : null,
    // The pools the rerun starts off, because the step failed there on the
    // pool (marked runs): another pool takes the step if one can now.
    leaves: features.failureRule && status !== 'pending'
      ? poolCausedPools(state.attempts, stepId).map((entry) => entry.pool).filter((pool) => !avoided.includes(pool))
      : [],
    pending: status === 'pending',
    route: definition.route ?? null,
    next: { watch: `bullswarm workflow watch ${id} --until trouble` },
  };
  if (outcome.status === 'rejected') {
    dropRerunIntent(resolved.runDir, intent);
    const issues = outcome.record?.issues ?? [];
    return { code: 2, status: 'rejected', issues, oldKernel: outcome.appliedBy === 'kernel' && oldKernelRejection(issues), ...result };
  }
  if (outcome.status === 'queued') return { code: 0, status: 'queued', programRevision: null, changes: null, appliedBy: null, relaunch: null, ...result };
  const paused = outcome.state?.lifecycle?.status === 'paused';
  let relaunched = null;
  if (outcome.appliedBy === 'offline' && !paused && typeof relaunch === 'function') {
    try { relaunched = await relaunch(state.runId); }
    catch (err) { return stepError(1, `rerun of ${stepId} applied to ${id} (revision ${outcome.record.programRevision}) but ${err.message}`, base); }
  }
  return {
    code: 0, status: 'applied', programRevision: outcome.record.programRevision, changes: outcome.record.changes,
    appliedBy: outcome.appliedBy, reopened: outcome.reopened ?? null, paused, relaunch: relaunched, ...result,
  };
}

/**
 * `workflow step accept`: resolves {code, status: applied|queued|rejected|error, ...}.
 * The refusals are the §2.8 texts planV2Revision reports; the exit code is 2
 * for a usage problem (reason, requirement) and 1 for a step in the wrong state.
 */
export async function acceptV2Step({
  bullswarmDir, token, stepId, reason, requirements = [],
  waitMs = 120_000, pollMs = 250, now = () => new Date().toISOString(), relaunch = null,
} = {}) {
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (!text) return stepError(2, '--reason is required: say why you accept it (it is recorded as evidence "choice")');
  if (text.length > 500 || /[\r\n]/.test(text)) return stepError(2, '--reason must be one line of at most 500 characters');
  const loaded = loadStepRun(bullswarmDir, token, stepId, 'accept');
  if (loaded.refusal) return stepError(loaded.refusal.code, loaded.refusal.why);
  const { resolved, state, id, runtime } = loaded;
  const base = { runId: state.runId, shortId: state.shortId ?? null, step: stepId };
  const named = [...new Set(requirements)];
  const body = {
    summary: `accept ${stepId}: "${text}"`,
    baseRevision: state.program.revision,
    program: exportV2Plan(state).program,
    rerun: [],
    steeringIds: [],
    accept: [{ step: stepId, reason: text, requirements: named.length ? named : null }],
  };
  const features = runFeatureFlags(readRunFeatures(resolved.runDir));
  const precheck = planV2Revision(state, body, { features });
  if (!precheck.ok) {
    const [first] = precheck.issues;
    const usage = /^(--reason|step \S+ does not check |requirement \S+ is not failing)/.test(first ?? '');
    const single = precheck.issues.length === 1;
    return single
      ? stepError(usage ? 2 : 1, first, base)
      : { code: 2, status: 'rejected', issues: precheck.issues, ...base };
  }
  const planned = precheck.acceptances[0];
  const kind = planned.kind;
  const before = new Set((runtime.acceptance?.requirements ?? []).map((entry) => entry.id));
  const acceptedRequirements = kind === 'requirements'
    ? (named.length ? named : planned.requirements.map((entry) => entry.id).filter((entryId) => !before.has(entryId)))
    : named;
  const request = createRevisionRequest(body, { source: 'step-accept', now });
  let outcome;
  try { outcome = await reviseV2Program({ bullswarmDir, runId: state.runId, request, waitMs, pollMs, now }); }
  catch (err) { return stepError(1, err.message, base); }
  const result = {
    ...base, requestId: request.id, kind, reason: text, requirements: acceptedRequirements,
    attemptId: planned.attemptId ?? null, failureKind: planned.failureKind ?? null,
    next: { watch: `bullswarm workflow watch ${id} --until trouble`, undo: `bullswarm workflow step rerun ${id} ${stepId}` },
  };
  if (outcome.status === 'rejected') {
    const issues = outcome.record?.issues ?? [];
    return { code: 2, status: 'rejected', issues, oldKernel: outcome.appliedBy === 'kernel' && oldKernelRejection(issues), ...result };
  }
  if (outcome.status === 'queued') return { code: 0, status: 'queued', programRevision: null, changes: null, appliedBy: null, relaunch: null, dependents: [], ...result };
  const paused = outcome.state?.lifecycle?.status === 'paused';
  let relaunched = null;
  if (outcome.appliedBy === 'offline' && !paused && typeof relaunch === 'function') {
    try { relaunched = await relaunch(state.runId); }
    catch (err) { return stepError(1, `accept of ${stepId} applied to ${id} (revision ${outcome.record.programRevision}) but ${err.message}`, base); }
  }
  return {
    code: 0, status: 'applied', programRevision: outcome.record.programRevision, changes: outcome.record.changes,
    dependents: outcome.record.changes?.invalidated ?? [], appliedBy: outcome.appliedBy, reopened: outcome.reopened ?? null, paused, relaunch: relaunched, ...result,
  };
}

/**
 * F22: what reopening a finished run by `step rerun` / `step accept` does:
 * the steps queued again, and each act step kept cancelled because its
 * worker had started (it may have acted).
 */
export function stepReopenedLines(reopened) {
  if (!reopened) return [];
  const requeued = reopened.requeued ?? [];
  const lines = [`reopened the ${reopened.previousStatus} run; its earlier result is archived${requeued.length ? `; running again: ${requeued.join(', ')}` : ''}`];
  if (reopened.keptCancelled?.length) lines.push(`not run again (act step, may have acted): ${reopened.keptCancelled.join(', ')}`);
  return lines;
}

function printStepRerun(result, token) {
  const id = result.shortId ?? token;
  if (result.status === 'error') { console.error(`✗ ${result.why}`); return; }
  if (result.status === 'rejected') {
    console.error(`✗ rerun of ${result.step} rejected (run unchanged)`);
    for (const issue of result.issues ?? []) console.error(`  - ${issue}`);
    if (result.oldKernel) console.error(OLD_KERNEL_HINT(id));
    return;
  }
  if (result.status === 'queued') {
    console.log(`✓ rerun of ${result.step} queued for ${id}; the running kernel applies it at its next check, and watch prints "plan revised"`);
    return;
  }
  const avoiding = result.avoid.length ? ` avoiding ${result.avoid.join(', ')}` : '';
  const by = result.appliedBy === 'kernel' ? 'applied by its running kernel'
    : result.paused ? 'applied directly; the run stays paused' : 'applied directly; kernel relaunched';
  if (result.pending) console.log(`✓ ${result.step} of ${id} will avoid ${result.avoid.join(', ')} when it runs · revision ${result.programRevision}`);
  else console.log(`✓ ${result.step} of ${id} runs again${avoiding} · revision ${result.programRevision} (${by})`);
  for (const note of result.notes ?? []) console.log(`  ${note}`);
  for (const line of stepReopenedLines(result.reopened)) console.log(`  ${line}`);
  if (result.handoff) console.log(`  handoff  ${result.handoff.attemptId} (${result.handoff.failureKind}${result.handoff.pool ? ` on ${result.handoff.pool}` : ''}) goes to the next attempt`);
  if (result.leaves?.length) {
    const names = result.leaves.join(', ');
    console.log(`  pool     starts on another pool than ${names} when one can take it (the step failed there on the pool); ${result.leaves.length === 1 ? 'that pool' : 'those'} only if none can`);
  }
  if (result.avoid.length) console.log(`  route    ${routeSummary(result.route)} · kept for later reruns; to remove it, export the plan, edit the route, then plan revise`);
  if (result.paused) console.log(`  resume   bullswarm workflow resume ${id}`);
  else console.log(`  watch    ${result.next.watch}`);
}

function printStepAccept(result, token) {
  const id = result.shortId ?? token;
  if (result.status === 'error') { console.error(`✗ ${result.why}`); return; }
  if (result.status === 'rejected') {
    console.error(`✗ accept of ${result.step} rejected (run unchanged)`);
    for (const issue of result.issues ?? []) console.error(`  - ${issue}`);
    if (result.oldKernel) console.error(OLD_KERNEL_HINT(id));
    return;
  }
  if (result.status === 'queued') {
    console.log(`✓ accept of ${result.step} queued for ${id}; the running kernel applies it at its next check, and watch prints "plan revised"`);
    return;
  }
  if (result.kind === 'requirements') {
    console.log(`✓ ${result.requirements.join(', ')} accepted by your choice on ${result.step} · "${result.reason}" · revision ${result.programRevision}`);
    console.log('  evidence   choice (not proof; the run stays not verified)');
  } else {
    console.log(`✓ ${result.step} of ${id} accepted by your choice · "${result.reason}" · revision ${result.programRevision}`);
    console.log('  evidence   choice (not proof; the run is verified only by its checks)');
    if (result.dependents.length) console.log(`  dependents ${result.dependents.join(', ')} run now`);
  }
  for (const line of stepReopenedLines(result.reopened)) console.log(`  ${line}`);
  if (result.paused) console.log(`  resume     bullswarm workflow resume ${id}`);
  console.log(`  undo       ${result.next.undo}`);
}

function stepJson(action, result) {
  const { code, why, notes, ...rest } = result;
  return JSON.stringify({ action, ...rest, ...(why ? { why } : {}), ...(notes?.length ? { notes } : {}) }, null, 2);
}

function listFlag(value) {
  return (Array.isArray(value) ? value : value == null ? [] : [value])
    .flatMap((entry) => String(entry).split(',')).map((entry) => entry.trim()).filter(Boolean);
}

async function relaunchRun(runId) {
  const resolved = resolveRunId(BULLSWARM_DIR(), runId);
  const doc = JSON.parse(readFileSync(join(resolved.runDir, 'goal.json'), 'utf8'));
  return launchDetachedResume(doc, runId, {});
}

const STEP_VERBS = ['restart', 'rerun', 'accept'];

export async function wfStep(opts) {
  const verb = opts.rest[0];
  const path = STEP_VERBS.includes(verb) ? ['workflow', 'step', verb] : ['workflow', 'step'];
  if (opts.help) { console.log(helpText(path)); return 0; }
  const flagExit = flagErrors(opts, path);
  if (flagExit !== null) return flagExit;
  const [, token, stepId] = opts.rest;
  if (!STEP_VERBS.includes(verb) || !token || !stepId) { console.error(`usage: ${usageLine(STEP_VERBS.includes(verb) ? path : ['workflow', 'step', 'restart'])}`); return 2; }
  const legacy = legacyRunRefusal(token, opts);
  if (legacy !== null) return legacy;
  const waitSec = opts.wait == null ? (verb === 'restart' ? 60 : 120) : Number(opts.wait);
  if (!Number.isFinite(waitSec) || waitSec < 0) { console.error('✗ --wait must be a non-negative number of seconds'); return 2; }
  if (verb === 'rerun') {
    const result = await rerunV2Step({
      bullswarmDir: BULLSWARM_DIR(), token, stepId, avoid: listFlag(opts.avoid),
      pools: configuredPools() ?? [], labels: loadPoolLabels(BULLSWARM_DIR()), waitMs: waitSec * 1000, relaunch: relaunchRun,
    });
    if (opts.json) console.log(stepJson('step-rerun', result));
    else printStepRerun(result, token);
    return result.code;
  }
  if (verb === 'accept') {
    const result = await acceptV2Step({
      bullswarmDir: BULLSWARM_DIR(), token, stepId, reason: opts.reason, requirements: listFlag(opts.requirement),
      waitMs: waitSec * 1000, relaunch: relaunchRun,
    });
    if (opts.json) console.log(stepJson('step-accept', result));
    else printStepAccept(result, token);
    return result.code;
  }
  let poolNames = null;
  let pools = null;
  if (opts.pool) {
    pools = configuredPools();
    poolNames = pools ? pools.map((pool) => pool.name) : null;
  }
  const result = await restartV2Step({
    bullswarmDir: BULLSWARM_DIR(), token, stepId, pool: opts.pool ?? null, poolNames, pools, waitMs: waitSec * 1000,
  });
  const id = result.shortId ?? result.runId ?? token;
  const payload = {
    action: 'step-restart', ...result, code: undefined,
    ...(result.status === 'error' ? {} : { next: { watch: `bullswarm workflow watch ${id} --until trouble` } }),
  };
  if (opts.json) { console.log(JSON.stringify(payload, null, 2)); return result.code; }
  if (result.status === 'error') { console.error(`✗ ${result.why}`); return result.code; }
  if (result.status === 'refused') { console.error(`✗ ${stepId} in ${id} was not restarted: ${result.why}`); return result.code; }
  const where = result.pool ? ` on ${result.pool}` : '';
  if (result.status === 'restarted') {
    console.log(withPoolLabels(`✓ restarted ${stepId} in ${id}: stopped ${result.stoppedAttemptId}${result.stoppedPool ? ` on ${result.stoppedPool}` : ''}; it runs again with its handoff${where}`, BULLSWARM_DIR()));
  } else {
    console.log(withPoolLabels(`✓ restart requested for ${stepId} in ${id}; its kernel stops ${result.stoppedAttemptId} at its next control check and runs it again with its handoff${where}`, BULLSWARM_DIR()));
  }
  console.log(`  watch    ${payload.next.watch}`);
  return result.code;
}
