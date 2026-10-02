// Width-independent Run model and plan shaping.
//
// The shell retains shared dashboard primitives and re-exports the compatibility
// surface; this module owns the Run-specific durable projections.

import { glyphs } from '../lib/glyphs.js';
import { finiteOrNull } from '../lib/num.js';
import { formatMoney } from '../lib/usage-basis.js';
import { isProgramWorkflow } from './execution-policy.js';
import { presentationStageStatus, projectV2DependencyStages } from './v2-presentation.js';
import { kernelRepairActionIds, loopStageLabel } from './legacy-verification.js';
import { clamp } from './dashboard-clamp.js';
import { clockAt } from './dashboard-value-text.js';
import {
  MEASURED_TOKEN_SOURCES, aggregateAttemptUsage, attemptInterval, attemptUsage, attemptWorkerMinutes, attemptsUnion,
  stateAttempts,
} from './metrics.js';

function workflowPanelModel(row, { phaseIndex = null, agentIndex = null, nowMs = Date.now() } = {}) {
  const state = row.state;
  const actionDefinitions = new Map((state.program?.actions ?? []).map((action) => [action.id, action]));
  const actionStates = new Map((state.actions ?? []).map((action) => [action.id, action]));
  const dependencyGroups = isProgramWorkflow(state);
  const stages = dependencyGroups ? projectV2DependencyStages(state) : state.presentation?.stages ?? [];
  const currentStageIndex = Math.max(0, stages.findIndex((stage) => stage.actionIds.some((id) => ['running', 'ready'].includes(actionStates.get(id)?.status))));
  const selectedPhaseIndex = clamp(phaseIndex == null ? currentStageIndex : phaseIndex, 0, Math.max(0, stages.length - 1));
  const phases = stages.map((stage) => {
    const progress = presentationStageStatus(stage, state.actions);
    const actionEntries = stage.actionIds.map((id) => ({ ...actionDefinitions.get(id), ...actionStates.get(id) }));
    const duration = phaseDurationFacts(row, stage, { nowMs });
    const active = actionEntries.some((action) => action.status === 'running');
    const failed = actionEntries.some((action) => ['failed', 'blocked', 'cancelled'].includes(action.status));
    return {
      name: stage.id, label: stage.label,
      status: active ? 'active' : stage.completedAt ? (failed ? 'failed' : 'completed') : stage.startedAt ? 'waiting' : 'pending',
      actions: actionEntries, completed: progress.completed, total: progress.total,
      activeMinutes: duration.activeMinutes, spanMinutes: duration.spanMinutes,
      blockedActions: actionEntries.filter((action) => action.status === 'blocked').map((action) => ({ id: action.id, kind: 'action', blockedBy: action.dependsOn ?? [] })),
    };
  });
  if (!phases.length) phases.push({ name: 'planning', label: 'Planning', status: state.planner.status === 'running' ? 'active' : 'pending', actions: [], completed: 0, total: 0, activeMinutes: null, spanMinutes: null, blockedActions: [] });
  const selectedPhase = phases[selectedPhaseIndex] ?? phases[0];
  const agents = [];
  for (const action of selectedPhase.actions) {
    for (const attempt of (state.attempts ?? []).filter((entry) => entry.actionId === action.id)) {
      agents.push({
        key: `attempt:${attempt.id}`, action, attempt: { ...attempt, attemptNumber: attempt.ordinal, outFile: attempt.outputFile },
        active: attempt.status === 'running' ? { ...attempt, stepId: action.id, attempt: attempt.ordinal, outFile: attempt.outputFile } : null,
        pool: attempt.pool ?? 'unassigned', model: attempt.model ?? 'connector model',
        // A worker stopped by a plan revision or a pause did not fail; say why it stopped.
        status: attempt.status === 'cancelled' && ['superseded', 'paused'].includes(attempt.failureKind) ? attempt.failureKind : attempt.status,
      });
    }
  }
  const activeIndex = Math.max(0, agents.findIndex((agent) => agent.status === 'running'));
  const selectedAgentIndex = agents.length ? clamp(agentIndex == null ? activeIndex : agentIndex, 0, agents.length - 1) : 0;
  const callerPlanned = (state.config?.settings?.plannerMode ?? 'caller') === 'caller';
  const plannerAttempts = state.planner?.attempts ?? [];
  const latestPlanner = plannerAttempts.at(-1) ?? null;
  const activePlanner = plannerAttempts.findLast((attempt) => attempt.status === 'running') ?? null;
  const orchestrator = {
    autonomous: true, actionId: 'workflow-planner', attempts: plannerAttempts,
    active: activePlanner, latestAttempt: latestPlanner,
    status: state.planner.status,
    // In caller mode no planner agent is ever dispatched, so "selecting ·
    // connector model" would describe a process that cannot exist.
    pool: activePlanner?.pool ?? latestPlanner?.pool ?? state.config?.plannerRouting?.pool ?? state.config?.plannerRouting?.preferredPool
      ?? (callerPlanned ? 'caller' : 'selecting'),
    model: activePlanner?.model ?? latestPlanner?.model ?? state.config?.plannerRouting?.model ?? state.config?.plannerRouting?.preferredModel
      ?? (callerPlanned ? 'you are the planner' : 'connector model'),
    latestDecision: state.planner.lastDecision,
  };
  return {
    row, state, stages, dependencyGroups, events: row.events ?? [], orchestrator, phases,
    phaseIndex: selectedPhaseIndex, selectedPhase, agents,
    agentIndex: selectedAgentIndex, selectedAgent: agents[selectedAgentIndex] ?? null,
  };
}

function planLevels(row) {
  try {
    const phases = workflowPanelModel(row).phases
      .map((phase) => (phase.actions ?? []).filter((action) => action?.id));
    if (phases.some((phase) => phase.length)) return phases;
  } catch { /* fall through to the declared graph */ }
  const actions = row?.state?.actions ?? [];
  const byId = new Map(actions.map((action) => [action.id, action]));
  const depth = new Map();
  const depthOf = (action, seen = new Set()) => {
    if (depth.has(action.id)) return depth.get(action.id);
    if (seen.has(action.id)) return 0;
    seen.add(action.id);
    const parents = (action.dependsOn ?? []).map((id) => byId.get(id)).filter(Boolean);
    const value = parents.length ? 1 + Math.max(...parents.map((parent) => depthOf(parent, seen))) : 0;
    depth.set(action.id, value);
    return value;
  };
  const levels = [];
  for (const action of actions) (levels[depthOf(action)] ??= []).push(action);
  return levels.map((level) => level ?? []);
}

const DONE_STATUS = new Set(['succeeded', 'failed', 'blocked', 'cancelled', 'skipped']);

function parsedMs(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const ms = Date.parse(value ?? '');
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The attempt intervals of this run and their union (metrics.js M3). A
 * running attempt ends at the projection clock, never at the run's lifecycle
 * finish (which can include idle time); a missing endpoint stays unknown.
 */
function intervalUnion(attempts, { nowMs = Date.now(), terminal = true } = {}) {
  const union = attemptsUnion(attempts, { now: nowMs, terminal, running: false });
  return {
    activeMinutes: union.activeMinutes,
    spanMinutes: union.open ? null : union.spanMinutes,
    startMs: union.startMs,
    endMs: union.endMs,
    open: union.open,
    unknown: union.unknown,
    intervals: union.intervals,
  };
}

function storedMinutes(source, key) {
  const candidates = [
    source?.minutes?.[key],
    source?.minutes?.[key === 'active' ? 'activeMinutes' : 'spanMinutes'],
    source?.[`${key}Minutes`],
  ];
  for (const value of candidates) {
    const number = finiteOrNull(value);
    if (number != null && number >= 0) return number;
  }
  return null;
}

function allRunAttempts(row) {
  return [
    ...(row?.state?.preflight?.scout?.attempts ?? []),
    ...(row?.state?.planner?.attempts ?? []),
    ...(row?.state?.attempts ?? row?.attempts ?? []),
  ];
}

const TERMINAL_LIFECYCLE_STATUS = new Set(['completed', 'partial', 'cancelled', 'failed', 'interrupted']);

function runIsTerminal(row) {
  const state = row?.state ?? row;
  if (Boolean(state?.lifecycle?.finishedAt ?? row?.finishedAt)) return true;
  const status = String(state?.lifecycle?.status ?? row?.status ?? '').toLowerCase();
  if (status) return TERMINAL_LIFECYCLE_STATUS.has(status);
  const attempts = allRunAttempts(row);
  return attempts.length > 0 && attempts.every((attempt) => attempt?.status && attempt.status !== 'running');
}

function runDurationFacts(row, { nowMs = Date.now() } = {}) {
  const rollup = row?.minutes
    ? row
    : (row?.rollup ?? row?.report?.rollup ?? row?.report ?? row?.state?.rollup ?? row?.state ?? {});
  const union = intervalUnion(allRunAttempts(row), { nowMs });
  const { intervals } = union;
  const activeMinutes = union.open ? union.activeMinutes : storedMinutes(rollup, 'active') ?? union.activeMinutes;
  const spanMinutes = !runIsTerminal(row) || union.open ? null : storedMinutes(rollup, 'span') ?? union.spanMinutes;
  // `spanMinutes` remains the proved terminal wall span for compatibility
  // with the duration helpers.  The Run header also needs the screen's
  // current wall span while a worker is open; keep that as a separate fact so
  // an open run can honestly say “active of span” without pretending it has a
  // terminal finish.
  const wallSpanMinutes = union.startMs != null && union.endMs != null
    ? Math.max(0, (union.endMs - union.startMs) / 60_000)
    : null;
  return { ...union, activeMinutes, spanMinutes, wallSpanMinutes, intervals };
}

function phaseAttempts(row, stage) {
  const ids = new Set(stage?.actionIds ?? stage?.actions?.map((action) => action.id) ?? []);
  const attempts = row?.state?.attempts ?? row?.attempts ?? stage?.attempts ?? [];
  return attempts.filter((attempt) => ids.has(attempt?.actionId));
}

function phaseDurationFacts(row, stage, { nowMs = Date.now() } = {}) {
  const union = intervalUnion(phaseAttempts(row, stage), { nowMs });
  const { intervals } = union;
  const phaseSources = [row?.minutes?.phases, row?.phases, row?.rollup?.phases, row?.report?.phases];
  const phaseRollup = phaseSources.find((source) => Array.isArray(source))
    ?.find((entry) => entry?.id === stage?.id || entry?.label === stage?.label)
    ?? phaseSources.find((source) => source && !Array.isArray(source))?.[stage?.id]
    ?? phaseSources.find((source) => source && !Array.isArray(source))?.[stage?.label];
  const activeStored = storedMinutes(stage, 'active') ?? storedMinutes(phaseRollup, 'active');
  const spanStored = storedMinutes(stage, 'span') ?? storedMinutes(phaseRollup, 'span');
  const activeMinutes = union.open ? union.activeMinutes : activeStored ?? union.activeMinutes;
  const phaseActions = stage?.actions?.length
    ? stage.actions
    : (row?.state?.actions ?? []).filter((action) => (stage?.actionIds ?? []).includes(action?.id));
  const phaseTerminal = Boolean(stage?.completedAt)
    || (phaseActions.length > 0 && phaseActions.every((action) => DONE_STATUS.has(action?.status)));
  const spanMinutes = !phaseTerminal || union.open ? null : spanStored ?? union.spanMinutes;
  return { ...union, activeMinutes, spanMinutes, intervals };
}

function activeMinutesText(value) {
  const number = finiteOrNull(value);
  if (number == null) return '—';
  return `${number.toFixed(2)}m`;
}

function durationClockText(minutes) {
  const number = finiteOrNull(minutes);
  if (number == null) return 'time pending';
  const seconds = Math.max(0, Math.round(number * 60));
  if (seconds < 60) return `${seconds}s`;
  const totalMinutes = Math.floor(seconds / 60);
  // The two design records share one clock: h/m/s, never a raw minute count.
  // A step that ran past an hour reads `1h02m`, the way the run header and the
  // Step page's own clock read it — `62m10s` was the same number said twice.
  if (totalMinutes < 60) return `${totalMinutes}m${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(totalMinutes / 60)}h${String(totalMinutes % 60).padStart(2, '0')}m`;
}

function attemptDurationMinutes(attempt, { nowMs = Date.now() } = {}) {
  const interval = attemptInterval(attempt, { nowMs });
  if (!interval.unknown) return (interval.end - interval.start) / 60_000;
  return attemptWorkerMinutes(attempt);
}

function attemptDurationText(attempt, options = {}) {
  return durationClockText(attemptDurationMinutes(attempt, options));
}

/** `phase 2 of 4 · 5/8 steps`, plus the ETA when every remainder is measured. */
function planProgress(row, { assignments = [], nowMs = Date.now() } = {}) {
  const state = row?.state ?? {};
  const actions = state.actions ?? [];
  // The phase count in the Run header must be the same presentation-stage
  // list the plan strip and timeline use, not a separately re-derived graph.
  const levels = planStages(row).stages.map((stage) => stage.actions ?? []);
  const done = actions.filter((action) => action.status === 'succeeded').length;
  const running = levels.findIndex((level) => level.some((action) => action.status === 'running'));
  const pending = levels.findIndex((level) => level.some((action) => !DONE_STATUS.has(action.status)));
  const index = running >= 0 ? running : pending >= 0 ? pending : levels.length - 1;
  const phase = levels.length ? index + 1 : 0;

  // The ETA only exists when every step still to run recorded an expected
  // duration. Today only a dispatched step does (its live assignment carries
  // `expectedMinutes`), so a run with waiting steps says so instead of
  // inventing the minutes nobody measured.
  const remaining = actions.filter((action) => !DONE_STATUS.has(action.status));
  let minutes = 0;
  let measured = 0;
  const unmeasured = [];
  for (const action of remaining) {
    const assignment = assignments.find((entry) => entry.runId === row?.runId && entry.actionId === action.id);
    const expected = finiteOrNull(assignment?.expectedMinutes);
    if (expected == null) { unmeasured.push(action.id); continue; }
    const startedMs = Date.parse(assignment?.startedAt ?? '');
    const elapsed = Number.isFinite(startedMs) ? (nowMs - startedMs) / 60_000 : 0;
    minutes += Math.max(0, expected - elapsed);
    measured += 1;
  }
  const eta = remaining.length && measured === remaining.length
    ? clockAt(nowMs + minutes * 60_000)
    : null;
  return {
    phase,
    phases: levels.length,
    levels,
    done,
    total: actions.length,
    remaining: remaining.length,
    measuredRemaining: measured,
    unmeasured,
    eta,
  };
}

/** One glyph per step, in dependency order, each of them clickable. */
function planStripParts(row, { runId = null } = {}) {
  const levels = planLevels(row);
  const mark = glyphs();
  const parts = [];
  // A v3 phase can hold steps that run one after the other (a loop's steps):
  // a step that depends on an earlier one in its group is joined by the
  // sequence separator, not set beside it as a parallel one. A step may wait
  // on a gate or a loop, which is no step: the walk goes through it to what
  // it waits on (a gate's dependsOn, a loop's steps).
  const program = row?.state?.program ?? {};
  const dependsOn = new Map([
    ...(program.control?.gates ?? []).map((gate) => [gate.id, gate.dependsOn ?? []]),
    ...(program.control?.loops ?? []).map((loop) => [loop.id, loop.steps ?? []]),
    ...(program.actions ?? []).map((action) => [action.id, action.dependsOn ?? []]),
  ]);
  const follows = (id, earlier, seen = new Set()) => (dependsOn.get(id) ?? []).some((dep) => {
    if (seen.has(dep)) return false;
    seen.add(dep);
    return earlier.has(dep) || follows(dep, earlier, seen);
  });
  levels.forEach((level, levelIndex) => {
    if (levelIndex) parts.push({ text: '──' });
    level.forEach((action, index) => {
      if (index) parts.push({ text: follows(action.id, new Set(level.slice(0, index).map((entry) => entry.id))) ? '──' : ' ' });
      const glyph = action.status === 'succeeded' ? mark.ok
        : action.status === 'running' ? mark.started
          : ['failed', 'blocked', 'cancelled'].includes(action.status) ? mark.fail
            : mark.pending;
      parts.push({
        text: glyph,
        action: { kind: 'step', actionId: action.id, ...(runId ? { runId } : {}) },
      });
    });
  });
  return parts;
}

/**
 * What one run drew and spent, measured from its own attempts.
 *
 * Minutes are the wall clock each attempt recorded. A pool's licence share is
 * `ratePerMinute × those minutes`, the only licence arithmetic the plan
 * allows, and it is null — never zero — where the pool has no measured rate.
 * Money is the sum of the API-equivalent estimates the attempts recorded.
 */
function runEconomics(row, pools = [], nowMs = Date.now()) {
  // A run's economics cover every durable attempt, including optional scout
  // and planner turns: the same set the rollup and every page aggregate.
  const attempts = stateAttempts(row?.state).map(({ attempt }) => attempt);
  const byPool = new Map();
  for (const attempt of attempts) {
    const name = attempt?.pool ?? null;
    const minutes = attemptWorkerMinutes(attempt, { nowMs });
    if (name && minutes != null) byPool.set(name, (byPool.get(name) ?? 0) + minutes);
  }
  const usage = aggregateAttemptUsage(attempts);
  const rows = [...byPool.entries()].map(([name, minutes]) => {
    const pool = (Array.isArray(pools) ? pools : []).find((entry) => entry?.name === name) ?? null;
    const rate = finiteOrNull(pool?.spend?.pacing?.ratePerMinute);
    return {
      name,
      minutes,
      usedPct: finiteOrNull(pool?.usedPct),
      window: pool?.spend?.pacing?.window ?? pool?.pacingWindow ?? null,
      sharePct: rate == null ? null : rate * minutes,
      rateSource: pool?.spend?.pacing?.source ?? null,
    };
  }).sort((a, b) => b.minutes - a.minutes);
  const windows = Object.entries(usage.subscriptionWindows);
  return {
    pools: rows,
    apiEquivalentUsd: usage.apiUsd,
    apiUsd: usage.apiUsd,
    apiKnownSubtotalUsd: usage.apiKnownSubtotalUsd,
    subscriptionUsd: usage.subscriptionUsd,
    subscriptionKnownSubtotalUsd: usage.subscriptionKnownSubtotalUsd,
    subscription: {
      usd: usage.subscriptionUsd,
      deltaPct: windows.length ? windows.reduce((sum, [, delta]) => sum + delta, 0) : null,
      window: windows[0]?.[0] ?? null,
      basis: usage.subscriptionBasis,
    },
    tokenSource: usage.tokenSource,
    pricedAttempts: usage.pricedAttempts,
    subscriptionPricedAttempts: usage.subscriptionPricedAttempts,
    measuredAttempts: usage.measuredAttempts,
    attempts: usage.attempts,
  };
}

/**
 * The plan as the prototype draws it: the levels across the width with their
 * branch topology, a per-step bar on whatever is running, and the pool and
 * model each level ran on underneath.
 *
 * A plan with no real fan-out — every level exactly one step — keeps the
 * linear `▶──○` strip the page has always drawn; the topology only appears
 * where there is topology to draw.
 */
/** The presentation stages the Run page and its timeline agree on. */
function planStages(row) {
  try {
    const panel = workflowPanelModel(row);
    const definitions = new Map((panel.state.program?.actions ?? []).map((action) => [action.id, action]));
    const states = new Map((panel.state.actions ?? []).map((action) => [action.id, action]));
    const stages = (panel.stages ?? []).map((stage) => {
      // A stage that is exactly one verify round or one repair is named by
      // the loop (`verify · round 2 of 3 · 2 to re-check`).
      const loopLabel = loopStageLabel(panel.state, stage);
      return {
        ...stage,
        ...(loopLabel ? { loopLabel } : {}),
        actions: (stage.actionIds ?? [])
          .map((id) => ({ ...definitions.get(id), ...states.get(id) }))
          .filter((action) => action?.id),
      };
    }).filter((stage) => stage.actions.length);
    if (stages.length) return { stages, dependencyGroups: panel.dependencyGroups };
  } catch { /* a torn state falls through to the action graph below */ }
  const levels = planLevels(row).filter((level) => level.length);
  return {
    dependencyGroups: true,
    stages: levels.map((actions, index) => ({
      id: `level-${index + 1}`, label: `Phase ${index + 1} · ${actions.length > 1 ? 'Parallel work' : actions[0].id}`,
      actionIds: actions.map((action) => action.id), actions,
      startedAt: actions.map((action) => action.startedAt).filter(Boolean).sort()[0] ?? null,
      completedAt: actions.map((action) => action.finishedAt).filter(Boolean).sort().at(-1) ?? null,
    })),
  };
}

function planStageLabel(stage, index) {
  const label = String(stage?.label ?? '').trim();
  return /^((?:Follow-up \d+: )?Phase \d+)(?: ·|$)/.test(label)
    ? label
    : `Phase ${index + 1} · ${label || 'starting'}`;
}

const WRITER_COUNT_WORDS = Object.freeze([
  'zero', 'one', 'two', 'three', 'four', 'five', 'six',
  'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
]);

/**
 * The compact name a phase carries in the plan: the authored phase name when
 * the phase has one step, otherwise the writer group its level is — `two
 * writers` through `twelve writers`, digits above that. The step names
 * themselves stay on the phase's own page rather than being folded into the
 * box; a level of two or three steps is a group like any other.
 */
function planStageName(stage, index) {
  // A v3 phase is named by its declared label, whatever its size.
  if (stage?.phase) return stage.phase;
  const actions = stage?.actions ?? [];
  if (actions.length > 1) {
    return `${WRITER_COUNT_WORDS[actions.length] ?? actions.length} writers`;
  }
  const label = planStageLabel(stage, index)
    .replace(/^Follow-up \d+: /, '')
    .replace(/^Phase \d+\s*·\s*/, '')
    .trim();
  return label || `phase-${index + 1}`;
}

/**
 * The timeline's phase name: a single-step phase keeps the name it was given,
 * and a level of more than one step is read out as the steps it holds —
 * `home · active-minutes · run-page · step-page · docs` — which is how the
 * run-v2 record's phase rules name their phases. The plan box for the same
 * level stays the compact `five writers` that the plan row is read at.
 */
function planStageStepsName(stage, index) {
  if (stage?.loopLabel) return stage.loopLabel;
  const names = (stage?.actions ?? [])
    .map((action) => String(action?.id ?? '').trim())
    .filter(Boolean);
  // A v3 phase is named by its label in the title; the rule reads its steps.
  if (stage?.phase) return names.join(' · ') || stage.phase;
  const label = planStageLabel(stage, index)
    .replace(/^Follow-up \d+: /, '')
    .replace(/^Phase \d+\s*·\s*/, '')
    .trim();
  // `Parallel work` was an implementation label, never a phase name.
  if (names.length > 1 || !label || /^parallel work$/i.test(label)) {
    return names.join(' · ') || label || `phase-${index + 1}`;
  }
  return label;
}

/**
 * One whole-phase plan box. The action is attached to the full text so both a
 * mouse click and the dashboard's selected-row Enter open the phase's first
 * step; no individual step names leak into the compact plan. The box carries
 * the phase's number, the number the plan's arrows chain it with, and the
 * done/total only where that count says something the glyph does not have
 * already: a running phase says how much of it is left, and a multi-step phase
 * that has started says how far it got. `[✓ 4 mod-step]` is a finished single
 * step and `[○ 13 verify]` is one that has not begun, so neither prints `1/1`
 * or `0/1` after the name.
 */
function planStageBoxParts(stage, index, { runId = null, selectedId = null } = {}) {
  const actions = stage?.actions ?? [];
  const progress = presentationStageStatus(stage, actions);
  const running = actions.some((action) => action.status === 'running');
  const failed = actions.some((action) => ['failed', 'blocked', 'cancelled'].includes(action.status));
  const status = running ? glyphs().started
    : failed ? glyphs().fail
      : progress.completed === progress.total && progress.total > 0 ? glyphs().ok : glyphs().pending;
  const count = running || (progress.total > 1 && progress.completed > 0)
    ? ` ${progress.completed}/${progress.total}` : '';
  const first = actions[0];
  const selected = first?.id && first.id === selectedId;
  const text = `[${status} ${index + 1} ${planStageName(stage, index)}${count}]`;
  return [{
    text: selected ? `\x1b[7m${text}\x1b[0m` : text,
    ...(first ? { action: { kind: 'step', actionId: first.id, ...(runId ? { runId } : {}) } } : {}),
  }];
}

const RUN_TERMINAL_ATTEMPTS = new Set(['succeeded', 'failed', 'blocked', 'cancelled', 'interrupted', 'skipped']);
const RUN_MEASURED_SOURCES = new Set(MEASURED_TOKEN_SOURCES);

/** `6h02m` / `38m17s` / `30s`, the Run header's active/span clock. */
function runClockText(minutes) {
  const value = finiteOrNull(minutes);
  if (value == null) return '—';
  const seconds = Math.max(0, Math.round(value * 60));
  if (seconds < 60) return `${seconds}s`;
  const totalMinutes = Math.floor(seconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(totalMinutes / 60)}h${String(totalMinutes % 60).padStart(2, '0')}m`;
}

function runLocalClock(value) {
  const ms = parsedMs(value);
  if (ms == null) return null;
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function runDateText(value) {
  const ms = parsedMs(value);
  if (ms == null) return null;
  const date = new Date(ms);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()}`;
}

function runAttemptMix(attempts) {
  const counts = new Map();
  for (const attempt of attempts ?? []) {
    const pool = String(attempt?.pool ?? 'unassigned');
    counts.set(pool, (counts.get(pool) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([pool, count]) => ({ pool, count }))
    .sort((a, b) => b.count - a.count || a.pool.localeCompare(b.pool));
}

/** Facts for the three-line Run header; no prose or money is inferred here. */
function runHeaderFacts(row, { nowMs = Date.now(), rollup = null } = {}) {
  const state = row?.state ?? row ?? {};
  const actions = Array.isArray(state.actions) ? state.actions : [];
  const attempts = allRunAttempts(row);
  const duration = runDurationFacts(row, { nowMs });
  const displaySpan = finiteOrNull(duration.spanMinutes) ?? finiteOrNull(duration.wallSpanMinutes);
  const running = actions.filter((action) => action.status === 'running');
  const waiting = actions.filter((action) => !DONE_STATUS.has(action.status) && action.status !== 'running');
  const startedAt = state.lifecycle?.startedAt ?? attempts.map((attempt) => attempt.startedAt).filter(Boolean).sort()[0] ?? null;
  const finishedAt = state.lifecycle?.finishedAt ?? row?.finishedAt ?? rollup?.finishedAt ?? null;
  const goal = String(state.intent?.goal ?? state.workflow ?? rollup?.goal ?? '').trim();
  return {
    shortId: row?.shortId ?? state.shortId ?? rollup?.shortId ?? row?.runId ?? state.runId ?? '------',
    status: String(row?.status ?? state.lifecycle?.status ?? rollup?.status ?? 'starting'),
    done: actions.filter((action) => action.status === 'succeeded').length,
    total: actions.length,
    running: running.map((action) => action.id),
    waiting: waiting.map((action) => action.id),
    goal,
    activeMinutes: duration.activeMinutes,
    spanMinutes: displaySpan,
    startedAt,
    finishedAt,
    startedClock: runLocalClock(startedAt),
    finishedClock: runLocalClock(finishedAt),
    dateText: runDateText(finishedAt ?? startedAt),
    activeText: runClockText(duration.activeMinutes),
    spanText: runClockText(displaySpan),
    attempts: attempts.length,
    attemptMix: runAttemptMix(attempts),
    project: row?.project ?? state.project ?? rollup?.project ?? null,
    cwd: state.intent?.cwd ?? row?.cwd ?? rollup?.cwd ?? null,
    duration,
  };
}

function usageSource(attempt) {
  return String(attempt?.usage?.tokenSource ?? 'unknown');
}

function amountText(value, { approximate = false, lowerBound = false } = {}) {
  if (value == null) return '—';
  // A zero is `$0`, never the `$0.000` an unknown-token zero reads.
  const rendered = Number(value) === 0 ? '$0' : formatMoney(value);
  if (rendered === '-') return '—';
  return `${lowerBound ? '≥' : approximate ? '≈ ' : ''}${rendered}`;
}

/** Honest partial API/plan subtotals and coverage counts for the Spend block. */
function runSpendFacts(row, { rollup = null } = {}) {
  const attempts = allRunAttempts(row);
  const byPool = new Map();
  let apiKnownSubtotalUsd = null;
  let plansKnownSubtotalUsd = null;
  let measured = 0;
  let estimated = 0;
  let running = 0;
  let unmeasured = 0;
  let planMeter = 0;
  for (const attempt of attempts) {
    const { apiUsd: api, subscriptionUsd: sub } = attemptUsage(attempt);
    const status = String(attempt?.status ?? '').toLowerCase();
    const source = usageSource(attempt);
    const open = status === 'running';
    const apiMeasured = api != null && RUN_MEASURED_SOURCES.has(source);
    const apiEstimated = api != null && !apiMeasured;
    // A live attempt is its own coverage class.  It may also lack a usage
    // amount, but counting it again as "unmeasured" makes the footer report
    // more missing attempts than the actual partial scope (the design's
    // example is `6 estimated · 1 running`, not `… · 1 running · 1
    // unmeasured`).
    if (open) running += 1;
    else if (api == null) unmeasured += 1;
    else if (apiMeasured) measured += 1;
    else estimated += 1;
    if (api != null) apiKnownSubtotalUsd = (apiKnownSubtotalUsd ?? 0) + api;
    if (sub != null) {
      plansKnownSubtotalUsd = (plansKnownSubtotalUsd ?? 0) + sub;
      planMeter += 1;
    }
    const pool = String(attempt?.pool ?? 'unassigned');
    const entry = byPool.get(pool) ?? {
      pool, apiKnownSubtotalUsd: null, attempts: 0, measured: 0, estimated: 0, running: 0, unmeasured: 0,
    };
    entry.attempts += 1;
    if (api != null) entry.apiKnownSubtotalUsd = (entry.apiKnownSubtotalUsd ?? 0) + api;
    if (open) entry.running += 1;
    else if (apiMeasured) entry.measured += 1;
    else if (apiEstimated) entry.estimated += 1;
    else entry.unmeasured += 1;
    byPool.set(pool, entry);
  }
  // A rollup may retain a subtotal for an attempt whose raw state was
  // projected away by the renderer. It remains a known subtotal, never an
  // invented whole-run amount.
  const rollupUsage = rollup?.usage ?? rollup?.economics ?? null;
  if (apiKnownSubtotalUsd == null) apiKnownSubtotalUsd = finiteOrNull(rollupUsage?.apiKnownSubtotalUsd);
  if (plansKnownSubtotalUsd == null) plansKnownSubtotalUsd = finiteOrNull(rollupUsage?.subscriptionKnownSubtotalUsd);
  const attemptsTotal = attempts.length || finiteOrNull(rollupUsage?.attempts) || 0;
  const rollupMeasured = finiteOrNull(rollupUsage?.measuredAttempts);
  if (!attempts.length && rollupMeasured != null) {
    measured = rollupMeasured;
    const priced = finiteOrNull(rollupUsage?.pricedAttempts);
    estimated = priced == null ? 0 : Math.max(0, priced - measured);
    unmeasured = priced == null ? 0 : Math.max(0, attemptsTotal - priced);
    planMeter = finiteOrNull(rollupUsage?.subscriptionPricedAttempts) ?? planMeter;
  }
  const apiPartial = unmeasured > 0 || running > 0;
  const allEstimated = estimated > 0 && measured === 0 && unmeasured === 0 && running === 0;
  const pools = [...byPool.values()]
    .filter((entry) => entry.apiKnownSubtotalUsd != null || entry.attempts)
    .sort((a, b) => (b.apiKnownSubtotalUsd ?? -1) - (a.apiKnownSubtotalUsd ?? -1) || b.attempts - a.attempts);
  return {
    attempts: attemptsTotal,
    apiKnownSubtotalUsd,
    apiText: amountText(apiKnownSubtotalUsd, { lowerBound: apiPartial, approximate: !apiPartial && allEstimated }),
    apiPartial,
    allEstimated,
    measured,
    estimated,
    running,
    unmeasured,
    coverageText: `${measured + estimated} of ${attemptsTotal} attempts priced`,
    suffix: [
      estimated ? `${estimated} estimated` : null,
      running ? `${running} running` : null,
      unmeasured ? `${unmeasured} unpriced` : null,
    ].filter(Boolean).join(' · '),
    pools,
    plansKnownSubtotalUsd,
    // A plan amount is a share of an account-wide meter: always an estimate.
    plansText: amountText(plansKnownSubtotalUsd, { lowerBound: planMeter < attemptsTotal, approximate: true }),
    planMeter,
    planUnmetered: Math.max(0, attemptsTotal - planMeter),
  };
}

function phaseGlyph(status) {
  const table = glyphs();
  if (status === 'completed') return table.ok;
  if (status === 'failed') return table.fail;
  if (status === 'active') return table.started;
  return table.pending;
}

// What a phase does, named from the kinds of the steps it holds: the owner's
// words for the program's step kinds (0.35.3). A kind with no entry reads as
// the kind itself, capitalised.
const PHASE_KIND_NAMES = Object.freeze({
  implement: 'Build',
  integration: 'Integrate',
  'adversarial-acceptance': 'Verify',
  digest: 'Digest',
  architecture: 'Design',
});

/**
 * A phase's name from its steps' kinds, in the order each kind first appears,
 * joined with ` + ` when the phase mixes them (`Build + Verify`). A repair
 * step the kernel's verify loop added reads `Repair`, whatever kind it was
 * added as. A role-only step names the phase by its role (`Produce`). Null
 * when no step of the phase declares a kind or a role.
 */
function phaseKindName(state, actionIds) {
  const repairs = new Set(kernelRepairActionIds(state));
  const kinds = new Map((state?.program?.actions ?? []).map((action) => [action?.id, action?.kind ?? action?.role]));
  const names = [];
  for (const id of actionIds) {
    const kind = String(kinds.get(id) ?? '').trim();
    const name = repairs.has(id) ? 'Repair'
      : Object.hasOwn(PHASE_KIND_NAMES, kind) ? PHASE_KIND_NAMES[kind]
        : kind ? `${kind[0].toUpperCase()}${kind.slice(1).replaceAll('-', ' ')}` : null;
    if (name && !names.includes(name)) names.push(name);
  }
  return names.length ? names.join(' + ') : null;
}

/** The tree facts consumed by both the desktop and phone timeline layouts. */
function runTimelineFacts(row, { nowMs = Date.now() } = {}) {
  const state = row?.state ?? row ?? {};
  const { stages } = planStages(row);
  const actions = state.actions ?? [];
  const phaseFacts = stages.map((stage, index) => {
    const phaseActions = stage.actions?.length ? stage.actions : actions.filter((action) => (stage.actionIds ?? []).includes(action.id));
    const attempts = phaseAttempts(row, stage).slice().sort((a, b) => parsedMs(a.startedAt) - parsedMs(b.startedAt));
    const duration = phaseDurationFacts(row, { ...stage, actions: phaseActions }, { nowMs });
    const progress = presentationStageStatus(stage, actions);
    // The rule reads `start → end` above its own attempt rows, so both ends come
    // from those rows: the first attempt's start and the last attempt's finish.
    // The stage's own stamps only stand in for a phase that has no attempt yet.
    const startedAt = attempts.map((attempt) => attempt.startedAt).filter(Boolean).sort()[0] ?? stage.startedAt ?? null;
    const finishedAt = attempts.map((attempt) => attempt.finishedAt).filter(Boolean).sort().at(-1) ?? stage.completedAt ?? null;
    const active = phaseActions.some((action) => action.status === 'running') || attempts.some((attempt) => attempt.status === 'running');
    const failed = phaseActions.some((action) => ['failed', 'blocked', 'cancelled', 'interrupted'].includes(action.status));
    return {
      index, id: stage.id, name: planStageStepsName(stage, index), label: stage.label, stage,
      kindName: stage.phase ?? phaseKindName(state, phaseActions.map((action) => action.id)),
      status: active ? 'active' : failed ? 'failed' : progress.completed === progress.total && progress.total > 0 ? 'completed' : 'pending',
      glyph: phaseGlyph(active ? 'active' : failed ? 'failed' : progress.completed === progress.total && progress.total > 0 ? 'completed' : 'pending'),
      startedAt, finishedAt, endAt: active ? null : finishedAt,
      duration, activeMinutes: duration.activeMinutes, spanMinutes: duration.spanMinutes,
      done: progress.completed, total: progress.total, attempts,
    };
  });
  return {
    preflight: { at: state.lifecycle?.startedAt ?? null, label: 'goal accepted · goal.json' },
    phases: phaseFacts,
    attempts: phaseFacts.flatMap((phase) => phase.attempts.map((attempt) => ({
      ...attempt, phaseIndex: phase.index, phaseName: phase.name,
      glyph: phaseGlyph(attempt.status === 'running' ? 'active' : RUN_TERMINAL_ATTEMPTS.has(attempt.status) && attempt.status !== 'succeeded' ? 'failed' : 'completed'),
      durationText: attemptDurationText(attempt, { nowMs }),
    }))),
  };
}

export {
  workflowPanelModel,
  planLevels,
  planProgress,
  planStripParts,
  runEconomics,
  runDurationFacts,
  phaseDurationFacts,
  activeMinutesText,
  durationClockText,
  attemptDurationMinutes,
  attemptDurationText,
  planStages,
  planStageLabel,
  planStageName,
  planStageStepsName,
  planStageBoxParts,
  runClockText,
  runHeaderFacts,
  runSpendFacts,
  runTimelineFacts,
};
