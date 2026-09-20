// Width-independent Run model and plan shaping.
//
// The shell retains shared dashboard primitives and re-exports the compatibility
// surface; this module owns the Run-specific durable projections.

import { asciiGlyphsPreferred, glyphs } from '../lib/glyphs.js';
import { finiteOrNull } from '../lib/num.js';
import { isProgramWorkflow } from './execution-policy.js';
import { presentationStageStatus, projectV2DependencyStages } from './v2-presentation.js';
import { cut, progressBar } from './dash-kit.js';
import {
  blank,
  clamp,
  clockAt,
  dimText,
  failMark,
  minutesText,
  okMark,
  outputSparkline,
  pendingMark,
  reasoningText,
  runningMark,
  tint,
  tokenSourceOf,
  visibleLength,
  worstSubscriptionBasis,
  worstTokenSource,
} from './dashboard.js';

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
 * Resolve the intervals that actually had a worker attached to this run.
 * Missing endpoints stay unknown; a running attempt ends at the projection
 * clock, never at the run's lifecycle finish (which can include idle time).
 */
function attemptIntervals(attempts, { nowMs = Date.now() } = {}) {
  const out = [];
  for (const attempt of (Array.isArray(attempts) ? attempts : [])) {
    const start = parsedMs(attempt?.startedAt);
    if (start == null) {
      if (attempt && typeof attempt === 'object') out.push({ unknown: true, attempt });
      continue;
    }
    let end = parsedMs(attempt?.finishedAt ?? attempt?.endedAt);
    const open = end == null && attempt?.status === 'running';
    if (open) end = Number.isFinite(nowMs) ? nowMs : Date.now();
    if (end == null || end < start) {
      out.push({ unknown: true, attempt });
      continue;
    }
    out.push({ start, end, attempt, open });
  }
  return out;
}

/** Union interval facts for active minutes and the secondary wall span. */
function unionIntervals(intervals) {
  const unknown = (Array.isArray(intervals) ? intervals : []).some((entry) => entry?.unknown === true);
  const list = (Array.isArray(intervals) ? intervals : [])
    .filter((entry) => Number.isFinite(entry?.start) && Number.isFinite(entry?.end) && entry.end >= entry.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  if (unknown || !list.length) return { activeMinutes: null, spanMinutes: null, startMs: null, endMs: null, open: false, unknown };
  const merged = [];
  for (const interval of list) {
    const previous = merged.at(-1);
    if (previous && interval.start <= previous.end) previous.end = Math.max(previous.end, interval.end);
    else merged.push({ start: interval.start, end: interval.end });
  }
  const activeMs = merged.reduce((total, interval) => total + interval.end - interval.start, 0);
  const startMs = list[0].start;
  const endMs = list.at(-1).end;
  const open = list.some((interval) => interval.open === true);
  return {
    activeMinutes: activeMs / 60_000,
    spanMinutes: open ? null : (endMs - startMs) / 60_000,
    startMs,
    endMs,
    open,
    unknown: false,
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
  const intervals = attemptIntervals(allRunAttempts(row), { nowMs });
  const union = unionIntervals(intervals);
  const activeMinutes = union.open ? union.activeMinutes : storedMinutes(rollup, 'active') ?? union.activeMinutes;
  const spanMinutes = !runIsTerminal(row) || union.open ? null : storedMinutes(rollup, 'span') ?? union.spanMinutes;
  return { ...union, activeMinutes, spanMinutes, intervals };
}

function phaseAttempts(row, stage) {
  const ids = new Set(stage?.actionIds ?? stage?.actions?.map((action) => action.id) ?? []);
  const attempts = row?.state?.attempts ?? row?.attempts ?? stage?.attempts ?? [];
  return attempts.filter((attempt) => ids.has(attempt?.actionId));
}

function phaseDurationFacts(row, stage, { nowMs = Date.now() } = {}) {
  const intervals = attemptIntervals(phaseAttempts(row, stage), { nowMs });
  const union = unionIntervals(intervals);
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
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
}

function attemptDurationMinutes(attempt, { nowMs = Date.now() } = {}) {
  const intervals = attemptIntervals([attempt], { nowMs });
  if (intervals.length) return (intervals[0].end - intervals[0].start) / 60_000;
  const wallSec = finiteOrNull(attempt?.wallSec);
  return wallSec != null && wallSec >= 0 ? wallSec / 60 : null;
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
  levels.forEach((level, levelIndex) => {
    if (levelIndex) parts.push({ text: '──' });
    level.forEach((action, index) => {
      if (index) parts.push({ text: ' ' });
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
  // and planner turns.  Rollups and result envelopes use this same set; the
  // Run page must not silently omit their API/subscription usage.
  const attempts = [
    ...(row?.state?.preflight?.scout?.attempts ?? []),
    ...(row?.state?.planner?.attempts ?? []),
    ...(row?.state?.attempts ?? []),
  ];
  const byPool = new Map();
  let apiKnownSubtotalUsd = null;
  let subscriptionKnownSubtotalUsd = null;
  let priced = 0;
  let subscriptionPriced = 0;
  let measuredAttempts = 0;
  let tokenSource = null;
  let subscriptionBasis = null;
  let subscriptionDeltaPct = null;
  let subscriptionWindow = null;
  for (const attempt of attempts) {
    const name = attempt?.pool ?? null;
    const startedMs = Date.parse(attempt?.startedAt ?? '');
    const finishedMs = Date.parse(attempt?.finishedAt ?? '');
    const wall = finiteOrNull(attempt?.wallSec);
    const minutes = wall != null ? wall / 60
      : Number.isFinite(startedMs)
        ? Math.max(0, (Number.isFinite(finishedMs) ? finishedMs : nowMs) - startedMs) / 60_000
        : null;
    if (name && minutes != null) byPool.set(name, (byPool.get(name) ?? 0) + minutes);
    const cost = finiteOrNull(attempt?.usage?.api?.usd ?? attempt?.usage?.cost?.estimatedUsd);
    const subscription = finiteOrNull(attempt?.usage?.subscription?.usd);
    const deltaPct = finiteOrNull(attempt?.usage?.subscription?.deltaPct);
    const source = tokenSourceOf(attempt?.usage?.tokenSource, cost);
    const basis = attempt?.usage?.subscription?.basis ?? 'unknown:no-meter';
    tokenSource = worstTokenSource(tokenSource, source);
    subscriptionBasis = worstSubscriptionBasis(subscriptionBasis, basis);
    if (deltaPct != null) subscriptionDeltaPct = (subscriptionDeltaPct ?? 0) + deltaPct;
    subscriptionWindow ??= attempt?.usage?.subscription?.window ?? null;
    if (cost != null) { apiKnownSubtotalUsd = (apiKnownSubtotalUsd ?? 0) + cost; priced += 1; }
    if (subscription != null) { subscriptionKnownSubtotalUsd = (subscriptionKnownSubtotalUsd ?? 0) + subscription; subscriptionPriced += 1; }
    if (cost != null && (source === 'provider-reported' || source === 'transcript-summed')) measuredAttempts += 1;
  }
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
  return {
    pools: rows,
    apiEquivalentUsd: priced === attempts.length && attempts.length ? apiKnownSubtotalUsd : null,
    apiUsd: priced === attempts.length && attempts.length ? apiKnownSubtotalUsd : null,
    apiKnownSubtotalUsd,
    subscriptionUsd: subscriptionPriced === attempts.length && attempts.length ? subscriptionKnownSubtotalUsd : null,
    subscriptionKnownSubtotalUsd,
    subscription: {
      usd: subscriptionPriced === attempts.length && attempts.length ? subscriptionKnownSubtotalUsd : null,
      deltaPct: subscriptionDeltaPct,
      window: subscriptionWindow,
      basis: subscriptionBasis ?? 'unknown:no-meter',
    },
    tokenSource: tokenSource ?? 'unknown',
    pricedAttempts: priced,
    subscriptionPricedAttempts: subscriptionPriced,
    measuredAttempts,
    attempts: attempts.length,
  };
}

function planAttemptDetail(attempt, width) {
  const cols = Math.max(0, Number(width) || 0);
  const reasoning = reasoningText(attempt);
  const pool = attempt?.pool ? String(attempt.pool) : null;
  const model = attempt?.model ? String(attempt.model) : null;
  const effortValue = attempt?.effort ?? attempt?.routing?.effort;
  const effort = effortValue ? String(effortValue) : null;
  // Keep the pool/model identity atomic. If the full detail does not fit,
  // remove the pool, then the model; only a remaining effort/reasoning label
  // may be cut as a last resort. This prevents a short plan cell from ever
  // painting a misleading `openc…` pool name.
  const candidates = [
    [pool, model, effort, reasoning],
    [model, effort, reasoning],
    [effort, reasoning],
    [reasoning],
    [],
  ];
  for (const candidate of candidates) {
    const text = candidate.filter(Boolean).join(' · ');
    if (!text || text.length <= cols) return text;
  }
  return cols > 0 && reasoning ? cut(reasoning, cols) : '';
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
    const stages = (panel.stages ?? []).map((stage) => ({
      ...stage,
      actions: (stage.actionIds ?? [])
        .map((id) => ({ ...definitions.get(id), ...states.get(id) }))
        .filter((action) => action?.id),
    })).filter((stage) => stage.actions.length);
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

/** The compact box uses the authored phase name, without the graph prefix. */
function planStageName(stage, index) {
  const label = planStageLabel(stage, index)
    .replace(/^Follow-up \d+: /, '')
    .replace(/^Phase \d+\s*·\s*/, '')
    .trim();
  return label || `phase-${index + 1}`;
}

function planStageHeader(stage, index) {
  const actions = stage.actions ?? [];
  const progress = presentationStageStatus(stage, actions);
  const running = actions.some((action) => action.status === 'running');
  const failed = actions.some((action) => ['failed', 'blocked', 'cancelled'].includes(action.status));
  const status = running ? glyphs().started
    : failed ? glyphs().fail
      : progress.completed === progress.total && progress.total > 0 ? glyphs().ok : glyphs().pending;
  return `${planStageLabel(stage, index)} · ${progress.completed}/${progress.total} ${status}`;
}

/**
 * One whole-phase plan box. The action is attached to the full text so both a
 * mouse click and the dashboard's selected-row Enter open the phase's first
 * step; no individual step names leak into the compact plan.
 */
function planStageBoxParts(stage, index, { runId = null, selectedId = null } = {}) {
  const actions = stage?.actions ?? [];
  const progress = presentationStageStatus(stage, actions);
  const running = actions.some((action) => action.status === 'running');
  const failed = actions.some((action) => ['failed', 'blocked', 'cancelled'].includes(action.status));
  const status = running ? glyphs().started
    : failed ? glyphs().fail
      : progress.completed === progress.total && progress.total > 0 ? glyphs().ok : glyphs().pending;
  const first = actions[0];
  const selected = first?.id && first.id === selectedId;
  const text = `[${status} ${planStageName(stage, index)} ${progress.completed}/${progress.total}]`;
  return [{
    text: selected ? `\x1b[7m${text}\x1b[0m` : text,
    ...(first ? { action: { kind: 'step', actionId: first.id, ...(runId ? { runId } : {}) } } : {}),
  }];
}

function planStageBoxText(stage, index) {
  return planStageBoxParts(stage, index)[0]?.text ?? '';
}

function planStageActions(stage, limit = null) {
  const actions = stage.actions ?? [];
  if (limit == null || actions.length <= limit) return { actions, omitted: 0 };
  const keep = Math.max(1, Number(limit) || 1);
  const rank = (action) => action.status === 'running' ? 0
    : ['failed', 'blocked', 'cancelled'].includes(action.status) ? 1
      : action.status === 'succeeded' ? 3 : 2;
  const running = actions.filter((action) => action.status === 'running');
  const picked = [...running];
  for (const action of actions
    .filter((entry) => !picked.includes(entry))
    .sort((a, b) => rank(a) - rank(b))) {
    if (picked.length >= keep) break;
    picked.push(action);
  }
  // Keep the phase's authored order after prioritising running/failed work,
  // so the summary never makes a column look re-ordered.
  const shown = actions.filter((action) => picked.includes(action));
  return { actions: shown, omitted: Math.max(0, actions.length - shown.length) };
}

function planMoreParts(count, width) {
  return [{ text: dimText(`+${count} more`, Math.max(1, width)) }];
}

function phaseActionGlyph(action) {
  if (action.status === 'succeeded') return okMark();
  if (action.status === 'running') return runningMark();
  if (['failed', 'blocked', 'cancelled'].includes(action.status)) return failMark();
  return pendingMark();
}

function fittedParts(parts, width) {
  const limit = Math.max(0, Number(width) || 0);
  const out = [];
  let used = 0;
  for (const part of parts) {
    if (used >= limit) break;
    const text = String(part?.text ?? '');
    const room = limit - used;
    if (visibleLength(text) <= room) {
      out.push({ ...part, text });
      used += visibleLength(text);
      continue;
    }
    if (room > 0) out.push({ ...part, text: cut(text, room) });
    used = limit;
    break;
  }
  if (used < limit) out.push({ text: ' '.repeat(limit - used) });
  return out;
}

/** One phase action row; metadata and the running bar are never subtitle rows. */
function planPhaseActionParts(action, { width, row, runId, assignments, nowMs, selectedId }) {
  const actionName = String(action.id);
  const name = selectedId === action.id ? `\x1b[7m${actionName}\x1b[0m` : actionName;
  const attempt = (row?.state?.attempts ?? []).findLast((entry) => entry.actionId === action.id) ?? null;
  const assignment = (assignments ?? []).find((entry) => entry.runId === runId && entry.actionId === action.id) ?? null;
  const prefix = `${phaseActionGlyph(action)} `;
  const base = [{ text: prefix }, {
    text: name,
    action: { kind: 'step', actionId: action.id, ...(runId ? { runId } : {}) },
  }];
  const fixed = visibleLength(prefix) + visibleLength(name);
  const expected = finiteOrNull(assignment?.expectedMinutes ?? attempt?.expectedMinutes);
  const startedMs = Date.parse(attempt?.startedAt ?? action?.startedAt ?? '');
  const elapsed = Number.isFinite(startedMs) ? Math.max(0, (nowMs - startedMs) / 60_000) : null;
  const elapsedText = elapsed == null ? null : minutesText(elapsed);
  const p50Text = expected == null ? blank() : minutesText(expected);
  const timing = action.status === 'running' ? `${elapsedText ?? blank()}/${p50Text}` : '';
  const spark = action.status === 'running' ? outputSparkline(attempt, row?.runDir, 8) : '';
  const minBar = action.status === 'running' ? 4 : 0;
  const timingWidth = timing ? visibleLength(timing) + 1 : 0;
  const sparkWidth = spark ? visibleLength(spark) + 1 : 0;
  const reasoning = attempt ? reasoningText(attempt) : '';
  const detailAttempt = attempt && reasoning ? { ...attempt, effort: null, routing: { ...(attempt.routing ?? {}), effort: null } } : attempt;
  // Prefer the complete pool/model identity when the cell can make room for
  // it. A narrow phase cell may still fall back to model/reasoning, but a
  // desktop cell should not spend all its space on a long progress bar first.
  const fullDetail = detailAttempt ? planAttemptDetail(detailAttempt, Number.MAX_SAFE_INTEGER) : '';
  const fullDetailWidth = visibleLength(fullDetail);
  let barWidth = action.status === 'running' && width - fixed - timingWidth - sparkWidth - 1 >= minBar
    ? Math.max(minBar, Math.min(10, width - fixed - timingWidth - sparkWidth - 1)) : 0;
  if (action.status === 'running' && fullDetail && width - fixed - timingWidth - sparkWidth - fullDetailWidth - 1 >= 1) {
    barWidth = Math.min(10, Math.max(1, width - fixed - timingWidth - sparkWidth - fullDetailWidth - 1));
  }
  // Seven phases at 120 columns leave deliberately small cells. Keep a
  // running step's bar and elapsed/p50 on its row by using a one-cell bar and
  // compact separators before ever dropping the running measurement.
  const compactBar = action.status === 'running' && !barWidth && width - fixed - visibleLength(timing) >= 1;
  if (compactBar) barWidth = 1;
  const detailRoom = Math.max(0, width - fixed - (barWidth ? barWidth + timingWidth + sparkWidth : 1));
  const detail = detailAttempt ? planAttemptDetail(detailAttempt, detailRoom) : '';
  if (detail) base.push({ text: ` · ${dimText(detail, detailRoom + 24)}` });
  if (barWidth) {
    const measured = expected != null && expected > 0 && elapsed != null;
    const ratio = measured ? elapsed / expected : 0;
    const bar = measured
      ? tint(progressBar(ratio, barWidth), 'green')
      : tint((asciiGlyphsPreferred() ? '.' : '░').repeat(barWidth), 'dim');
    base.push({ text: compactBar ? `${bar}${timing}` : ` ${bar} ${timing}${spark ? ` · ${spark}` : ''}` });
  }
  return fittedParts(base, width);
}

/** `✓ 3  ▶ 2  ○ 3`, the run's steps by the state they are in. */
function stepTally(row) {
  const actions = row?.state?.actions ?? [];
  const done = actions.filter((action) => action.status === 'succeeded').length;
  const running = actions.filter((action) => action.status === 'running').length;
  const failed = actions.filter((action) => ['failed', 'blocked', 'cancelled'].includes(action.status)).length;
  const waiting = Math.max(0, actions.length - done - running - failed);
  return [
    `${okMark()} ${done}`,
    running ? `${runningMark()} ${running}` : null,
    failed ? `${failMark()} ${failed}` : null,
    `${dimText(glyphs().pending, 2)} ${waiting}`,
  ].filter(Boolean).join('  ');
}

export {
  workflowPanelModel,
  planLevels,
  planProgress,
  planStripParts,
  runEconomics,
  attemptIntervals,
  unionIntervals,
  runDurationFacts,
  phaseDurationFacts,
  activeMinutesText,
  attemptDurationMinutes,
  attemptDurationText,
  planAttemptDetail,
  planStages,
  planStageLabel,
  planStageName,
  planStageHeader,
  planStageBoxParts,
  planStageBoxText,
  planStageActions,
  planMoreParts,
  phaseActionGlyph,
  fittedParts,
  planPhaseActionParts,
  stepTally,
};
