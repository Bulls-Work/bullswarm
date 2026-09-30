// Width-independent data for the Step page.
//
// A Step combines durable state, one attempt's artifacts, an optional result
// envelope, and an optional per-attempt JSONL stream. Keep those sources
// separate here so the view cannot accidentally manufacture turns, tools,
// duration, usage, cost, or verification from prose.

import { homedir } from 'node:os';
import { join } from 'node:path';

// These imports are the extraction seam used by dashboard.js. They are used
// only for compatibility fields; the rich model below does its own shaping.
import {
  workflowPanelModel,
  reasoningText,
  taskPreview,
  outcomePreview,
  runEconomics,
} from './dashboard.js';
import { finiteOrNull } from '../lib/num.js';
import { attemptInterval, unionIntervals } from './metrics.js';
import { attemptAnswerFact } from './v3-display.js';
import { isV3State } from './v3-phases.js';
import { VIEWS, activityModel } from './step-model-activity.js';
import { durationFromAttempt } from './step-model-duration.js';
import { validId, eventHasToolDetails } from './step-model-events.js';
import {
  safeReadJson,
  safeReadText,
  resolveExistingPath,
  retainedPath,
} from './step-model-files.js';
import { stepPresentation } from './step-model-presentation.js';
import { resolveAttemptStreamPath, parseAttemptStream } from './step-model-stream.js';
import { normalizeAttemptUsage, aggregateUsageModels } from './step-model-usage.js';
import { hasOwn, textOrNull, clone, finiteMs, dateMs } from './step-model-values.js';

// The Step page model re-exports the names the product reads from it, from
// the modules that now hold them.
export { turnCountsText } from './step-model-counts.js';
export { stepClockText } from './step-model-text.js';
export { activityModel, resolveAttemptStreamPath, parseAttemptStream, normalizeAttemptUsage };

const SUCCESS_STATUSES = new Set(['succeeded', 'success', 'completed', 'complete', 'done']);

/** The active union and wall span for one action's attempts (metrics.js M3). */
export function actionDurationFacts(attempts = [], nowMs = Date.now()) {
  return unionIntervals(attempts.map((attempt) => attemptInterval(attempt, { nowMs })));
}

function routeModel(attempt, action) {
  const routing = attempt?.routing ?? null;
  const candidates = Array.isArray(routing?.candidates)
    ? routing.candidates.map((candidate) => clone(candidate))
    : Array.isArray(attempt?.routeCandidates)
      ? attempt.routeCandidates.map((candidate) => clone(candidate))
      : [];
  const reason = textOrNull(attempt?.routeWhy) ?? textOrNull(routing?.reason);
  const lane = textOrNull(routing?.lane) ?? textOrNull(attempt?.lane);
  const effort = textOrNull(attempt?.effort) ?? textOrNull(routing?.effort);
  const forecast = clone(routing?.forecast ?? null);
  return {
    lane,
    effort,
    reason,
    explanation: reason,
    candidates,
    forecast,
    available: Boolean(reason || lane || effort || candidates.length || forecast),
    actionLane: textOrNull(action?.lane),
  };
}

function failureModel(attempt, action) {
  const raw = attempt?.failure ?? action?.failure ?? action?.lastFailure ?? null;
  const kind = textOrNull(attempt?.failureKind) ?? textOrNull(raw?.kind);
  const message = textOrNull(attempt?.failureReason)
    ?? textOrNull(raw?.message)
    ?? (kind ? textOrNull(attempt?.why) : null);
  if (!kind && !message) return null;
  return { kind, message, raw: clone(raw) };
}

function attemptRecord(raw, action, { runDir = null, nowMs = Date.now() } = {}) {
  const ordinal = finiteOrNull(raw?.ordinal ?? raw?.attemptNumber);
  const actionId = textOrNull(raw?.actionId) ?? textOrNull(action?.id);
  const usage = normalizeAttemptUsage(raw?.usage);
  const streamPath = resolveAttemptStreamPath(raw, { runDir, actionId, ordinal });
  const parsed = parseAttemptStream(resolveExistingPath(streamPath, runDir) ?? (streamPath?.endsWith('.jsonl') ? streamPath : null));
  const start = textOrNull(raw?.startedAt);
  const finish = textOrNull(raw?.finishedAt) ?? textOrNull(raw?.endedAt);
  const duration = durationFromAttempt(raw, nowMs);
  const outputFile = retainedPath(raw?.outputFile ?? raw?.outFile, runDir);
  const taskFile = retainedPath(raw?.taskFile, runDir);
  const failure = failureModel(raw, action);
  return {
    ...clone(raw),
    id: textOrNull(raw?.id),
    actionId,
    ordinal,
    attemptNumber: ordinal,
    status: textOrNull(raw?.status) ?? 'unknown',
    pool: textOrNull(raw?.pool),
    model: textOrNull(raw?.model),
    effort: textOrNull(raw?.effort) ?? textOrNull(raw?.routing?.effort),
    reasoning: clone(raw?.reasoning ?? null),
    lane: textOrNull(raw?.lane) ?? textOrNull(raw?.routing?.lane),
    startedAt: start,
    finishedAt: finish,
    durationMs: duration,
    durationSec: duration == null ? null : duration / 1000,
    failure,
    failureReason: failure?.message ?? null,
    routing: clone(raw?.routing ?? null),
    route: routeModel(raw, action),
    usage: usage.raw,
    usageModel: usage,
    tokens: usage.tokens,
    money: usage,
    outputFile,
    outFile: outputFile,
    taskFile,
    streamFile: parsed.path,
    activity: activityModel(parsed, {
      running: String(raw?.status ?? '').toLowerCase() === 'running',
    }),
    outputBytes: finiteOrNull(raw?.outputBytesObserved ?? raw?.outputBytes ?? raw?.bytes?.output),
    outputBytesObserved: finiteOrNull(raw?.outputBytesObserved ?? raw?.outputBytes ?? raw?.bytes?.output),
    streamAvailable: parsed.available,
    turnsCaptured: parsed.events.some((event) => validId(event.turnId) != null),
    toolDetailsCaptured: parsed.events.some(eventHasToolDetails),
    usagePending: raw?.usage == null && String(raw?.status ?? '').toLowerCase() === 'running',
  };
}

function readResultEnvelope(row, state, runDir) {
  const candidates = [state?.lifecycle?.resultFile, runDir ? join(runDir, 'result.json') : null, runDir ? join(runDir, 'report.json') : null];
  for (const candidate of candidates) {
    const path = resolveExistingPath(candidate, runDir);
    const value = safeReadJson(path);
    if (value) return { value, path };
  }
  if (row?.report && typeof row.report === 'object') {
    return { value: row.report, path: retainedPath(state?.lifecycle?.resultFile, runDir) };
  }
  return { value: null, path: retainedPath(state?.lifecycle?.resultFile, runDir) };
}

function requirementEvidence(result, state) {
  const source = Array.isArray(result?.requirements)
    ? result.requirements
    : result?.requirements && typeof result.requirements === 'object'
      ? Object.values(result.requirements)
      : Array.isArray(result?.requirementEvidence)
        ? result.requirementEvidence
        : Object.values(state?.ledger?.requirements ?? {});
  return source.map((requirement) => ({
    id: textOrNull(requirement?.id),
    status: textOrNull(requirement?.status) ?? 'unknown',
    mandatory: requirement?.mandatory === true,
    why: textOrNull(requirement?.why),
    evidence: Array.isArray(requirement?.evidence) ? clone(requirement.evidence) : [],
  }));
}

function verdictModel({ result, state, action, requirements }) {
  const executionStatus = textOrNull(action?.status) ?? 'unknown';
  const workflowStatus = textOrNull(result?.status) ?? textOrNull(state?.lifecycle?.status) ?? 'unknown';
  const explicitVerified = typeof result?.verified === 'boolean' ? result.verified
    : typeof state?.verified === 'boolean' ? state.verified : null;
  return {
    execution: {
      status: executionStatus,
      succeeded: SUCCESS_STATUSES.has(executionStatus),
      terminal: !['running', 'pending', 'ready', 'queued', 'unknown'].includes(executionStatus),
    },
    workflow: {
      status: workflowStatus,
      terminal: ['completed', 'partial', 'cancelled', 'failed', 'interrupted'].includes(workflowStatus),
    },
    verification: {
      verdict: explicitVerified,
      available: explicitVerified !== null || requirements.some((entry) => entry.evidence.length > 0),
      reason: textOrNull(result?.reason),
      requirements,
    },
    executionStatus,
    workflowStatus,
    verified: explicitVerified,
  };
}

function promptModel(path) {
  const lines = path ? taskPreview(path, 6) : [];
  return { path: path ?? null, available: lines.length > 0, lines, text: lines.length ? lines.join('\n') : null };
}

function outputModel(path, output, maxChars = 64 * 1024) {
  const lines = path || output ? outcomePreview(path, output, maxChars) : [];
  return { path: path ?? null, available: lines.length > 0, lines, text: lines.length ? lines.join('\n') : null };
}

function artifactModel({ runDir, taskFile, outputFile, streamFile, resultFile }) {
  return {
    runDir: runDir ?? null,
    task: taskFile ?? null,
    output: outputFile ?? null,
    stream: streamFile ?? null,
    result: resultFile ?? null,
    paths: { task: taskFile ?? null, output: outputFile ?? null, stream: streamFile ?? null, result: resultFile ?? null },
  };
}

function chooseAttempt(rawAttempts, selectedAgent, options = {}) {
  if (!rawAttempts.length) return null;
  const requestedValue = options.attemptOrdinal
    ?? options.selectedAttempt
    ?? (selectedAgent?.status === 'running' ? selectedAgent?.attempt?.attemptNumber : null);
  const requested = requestedValue && typeof requestedValue === 'object'
    ? requestedValue.ordinal ?? requestedValue.attemptNumber ?? requestedValue.id
    : requestedValue;
  if (requested != null) {
    const found = rawAttempts.find((attempt) => (
      (requestedValue && typeof requestedValue === 'object' && requestedValue.id && attempt.id === requested)
      || Number(attempt.ordinal) === Number(requested)
    ));
    if (found) return found;
  }
  return rawAttempts.find((attempt) => attempt.status === 'running') ?? rawAttempts.at(-1);
}

function normalizeRowInput(input) {
  if (input?.row?.state) return input;
  if (input?.state) return { row: input };
  return { row: null };
}

/** Build the complete Step model from dashboardModel(row) or a row directly. */
export function stepPageModel(input, {
  phaseIndex = null,
  agentIndex = null,
  actionId = null,
  nowMs = Date.now(),
  attemptOrdinal = null,
  selectedAttempt = null,
  selectedEventIndex = null,
  activityFilter = 'all',
  filter = null,
  follow = true,
  followTail = null,
  view = 'overview',
  expandedTurn = null,
} = {}) {
  const normalizedInput = normalizeRowInput(input);
  const row = normalizedInput.row;
  if (!row?.state) return { model: input, panel: null, state: null, agent: null, shortId: '' };
  const panel = input?.panel?.selectedAgent ? input.panel : workflowPanelModel(row, { phaseIndex, agentIndex });
  const state = panel.state ?? row.state;
  const selectedAgent = panel.selectedAgent ?? null;
  const allActionDefinitions = [...(state.program?.actions ?? []), ...(state.actions ?? [])];
  const actionState = actionId ? (state.actions ?? []).find((entry) => entry.id === actionId) : null;
  const actionDefinition = actionId ? allActionDefinitions.find((entry) => entry.id === actionId) : null;
  const action = actionId
    ? (actionState || actionDefinition ? { ...(actionDefinition ?? {}), ...(actionState ?? {}) } : null)
    : (selectedAgent?.action
      ?? actionState
      ?? allActionDefinitions.find((entry) => (state.attempts ?? []).some((attempt) => attempt.actionId === entry.id && attempt.status === 'running'))
      ?? allActionDefinitions.find((entry) => (state.attempts ?? []).some((attempt) => attempt.actionId === entry.id))
      ?? null);
  if (!action) return { model: input, panel, state, agent: null, shortId: row.shortId ?? state.shortId ?? '' };
  const selectedActionId = action.id;
  const rawAttempts = (state.attempts ?? [])
    .filter((attempt) => attempt.actionId === selectedActionId)
    .sort((a, b) => Number(a.ordinal ?? 0) - Number(b.ordinal ?? 0));
  const runDir = row.runDir ?? row.dir ?? null;
  const enrichedAttempts = rawAttempts.map((attempt) => attemptRecord(attempt, action, { runDir, nowMs }));
  const rawSelected = chooseAttempt(rawAttempts, selectedAgent, { attemptOrdinal, selectedAttempt });
  const selected = enrichedAttempts.find((attempt) => attempt.id === rawSelected?.id) ?? enrichedAttempts.at(-1) ?? null;
  const active = selectedAgent?.active ?? (selected?.status === 'running' ? selected : null);
  const reasoning = reasoningText(selected ?? active) || reasoningText(active);
  const assignments = input?.assignments ?? [];
  const assignment = assignments.find((entry) => entry.runId === row.runId && entry.actionId === selectedActionId) ?? null;
  const expected = finiteOrNull(assignment?.expectedMinutes);
  const startedAt = selected?.startedAt ?? active?.startedAt ?? action.startedAt ?? null;

  const resultRecord = readResultEnvelope(row, state, runDir);
  const result = resultRecord.value;
  const requirements = requirementEvidence(result, state);
  const verdict = verdictModel({ result, state, action, requirements });
  const outputRecord = state.outputs?.[selectedActionId] ?? null;
  const taskFile = retainedPath(selected?.taskFile ?? active?.taskFile, runDir);
  const outFile = retainedPath(selected?.outputFile ?? active?.outputFile ?? outputRecord?.outFile, runDir);
  const output = outputModel(outFile, outputRecord);
  const prompt = promptModel(taskFile);
  const followState = followTail == null ? Boolean(follow) : Boolean(followTail);
  // A live attempt shows what had been captured by `now`: a page drawn at an
  // earlier instant (a projection of a finished record) must not print events
  // that had not happened yet. A terminal attempt keeps its whole capture.
  const parsedStream = selected ? parseAttemptStream(selected.streamFile) : parseAttemptStream(null);
  const liveAttempt = String(selected?.status ?? '').toLowerCase() === 'running';
  const captured = liveAttempt && Number.isFinite(nowMs)
    ? parsedStream.events.filter((event) => {
      const at = dateMs(event.at);
      return at == null || at <= nowMs;
    })
    : parsedStream.events;
  const activity = selected
    ? activityModel({ ...parsedStream, events: captured }, {
      pool: selected?.pool ?? null,
      filter: filter ?? activityFilter,
      follow: followState,
      selectedIndex: selectedEventIndex,
      nowMs,
      view,
      expandedTurn,
      running: liveAttempt,
    })
    : activityModel(parseAttemptStream(null), { nowMs, view, expandedTurn, running: false });
  const selectedUsage = selected?.usageModel ?? normalizeAttemptUsage(null);
  const totalUsage = aggregateUsageModels(enrichedAttempts);
  const route = routeModel(selected ?? active, action);
  const resultPath = resultRecord.path ?? retainedPath(state.lifecycle?.resultFile, runDir);
  const durationFacts = actionDurationFacts(rawAttempts, nowMs);
  const activeDurationMs = durationFacts.activeMs
    ?? (!durationFacts.unknown ? selected?.durationMs : null);
  const selectedHasFinish = dateMs(selected?.finishedAt) ?? dateMs(selected?.endedAt);
  const spanDurationMs = durationFacts.spanMs
    ?? (!durationFacts.unknown && durationFacts.intervals.length === 0 && selectedHasFinish != null
      ? selected?.durationMs : null);
  const outcome = {
    available: Boolean(result || output.available || verdict.execution.terminal),
    resultAvailable: Boolean(result),
    result,
    resultPath,
    action: (Array.isArray(result?.actions) ? result.actions : Object.values(result?.actions ?? {}))
      .find((entry) => entry?.id === selectedActionId) ?? null,
    actionStatus: verdict.executionStatus,
    workflowStatus: verdict.workflowStatus,
    verified: verdict.verified,
    reason: verdict.verification.reason,
    requirements,
    output,
  };
  const taskBlock = {
    available: prompt.available || Boolean(action.purpose || action.prompt),
    prompt: textOrNull(action.prompt) ?? textOrNull(state.intent?.goal),
    task: prompt,
    lines: prompt.lines,
    firstLines: prompt.lines,
    promptLines: prompt.lines,
    taskLines: prompt.lines,
    path: taskFile,
    expanded: false,
  };
  const resultBlock = {
    available: outcome.available,
    output: outcome.output,
    artifacts: artifactModel({ runDir, taskFile, outputFile: outFile, streamFile: activity.path, resultFile: resultPath }),
    outcome: {
      execution: verdict.execution,
      workflow: verdict.workflow,
      verification: verdict.verification,
      requirements,
      reason: outcome.reason,
      resultAvailable: outcome.resultAvailable,
    },
    result: outcome.result,
    resultPath: outcome.resultPath,
  };
  const moneyDisplay = totalUsage.display;
  const costBlock = {
    moneyPair: totalUsage,
    money: moneyDisplay,
    tokens: totalUsage.tokens,
    tokenSource: totalUsage.tokenSource,
    budget: clone(input?.budget ?? row?.budget ?? state?.budget ?? null),
    pending: Boolean(selected?.usagePending),
  };
  // The result card and the last turn's `→` marker read the report itself, and
  // the diff file is the kernel's own record of what the step changed. Both
  // are resolved inside the run directory, so a copied home stays read-only.
  const promptText = textOrNull(action.prompt) ?? prompt.text ?? textOrNull(state.intent?.goal);
  const outText = safeReadText(outFile) ?? output.text;
  const diffCandidate = selected?.diffFile ?? (runDir && selectedActionId && selected?.ordinal != null
    ? join(runDir, `diff-${selectedActionId}-attempt-${selected.ordinal}.txt`)
    : null);
  const diffPath = resolveExistingPath(diffCandidate, runDir);
  const diffText = safeReadText(diffPath);
  const presentation = stepPresentation({
    v3: isV3State(state),
    answer: attemptAnswerFact(state, selected),
    identity: {
      actionId: selectedActionId,
      shortId: textOrNull(row.shortId ?? state.shortId),
      purpose: textOrNull(action.purpose ?? action.role),
      verified: verdict.verified,
    },
    verdict,
    action,
    selected,
    attempts: enrichedAttempts,
    runDir,
    homeDir: homedir(),
    activity,
    route,
    duration: { activeMs: activeDurationMs, spanMs: spanDurationMs },
    meta: {
      pool: textOrNull(selected?.pool ?? active?.pool),
      model: textOrNull(selected?.model ?? active?.model),
      effort: textOrNull(selected?.effort ?? selected?.routing?.effort ?? route.effort),
      reasoning: textOrNull(selected?.reasoning?.applied ?? selected?.reasoning?.requested),
    },
    money: {
      pair: totalUsage,
      tokens: totalUsage.tokens,
      tokenSource: totalUsage.tokenSource,
      pending: Boolean(selected?.usagePending),
      pool: textOrNull(selected?.pool ?? active?.pool),
    },
    prompt: promptText,
    promptPath: taskFile,
    outText: outText ?? null,
    outFile,
    streamFile: activity.path,
    diffFile: diffPath,
    diffText,
    resultPath,
    requirements,
    nowMs,
    follow: followState,
  });
  const bytes = finiteOrNull(selected?.outputBytesObserved ?? active?.outputBytesObserved ?? outputRecord?.bytes);
  const live = verdict.executionStatus === 'running' ? 'live' : 'recorded';
  const poolEconomics = (() => {
    try {
      // The step is the unit: its own attempts' minutes on the pool, never
      // the whole run's.
      return runEconomics({ state: { attempts: rawAttempts } }, input?.pools ?? [], nowMs).pools
        .find((entry) => entry.name === (selected?.pool ?? active?.pool ?? selectedAgent?.pool)) ?? null;
    } catch { return null; }
  })();
  const turnsCaptured = activity.turns.length > 0;
  const toolDetailsCaptured = activity.events.some(eventHasToolDetails);
  const availability = {
    streamAvailable: Boolean(activity.available),
    streamReadable: Boolean(activity.readable),
    streamParseErrors: activity.parseErrors,
    turnsCaptured,
    toolDetailsCaptured,
    toolIdentityCaptured: toolDetailsCaptured,
    argumentsCaptured: activity.events.some((event) => hasOwn(event, 'arguments')),
    resultsCaptured: activity.events.some((event) => hasOwn(event, 'result')),
    eventUsageCaptured: activity.events.some((event) => event.usage != null),
    subagentsCaptured: activity.events.some((event) => validId(event.parentId) || validId(event.subagentId)),
    eventDurationsCaptured: activity.events.some((event) => finiteMs(event.durationMs) != null) || activity.pairs.some((pair) => pair.durationMs != null),
    pairedEventsCaptured: activity.pairs.length > 0,
    usageCaptured: selected?.usage != null,
    usagePending: Boolean(selected?.usagePending),
    promptAvailable: prompt.available,
    outputAvailable: output.available,
    resultAvailable: outcome.resultAvailable,
    outcomeAvailable: outcome.available,
    routeAvailable: route.available,
    verificationAvailable: verdict.verification.available,
    selectedEventAvailable: activity.selectedEventDetail.available,
    artifactsAvailable: Boolean(taskFile || outFile || activity.path || resultPath),
  };
  const identity = {
    runId: textOrNull(row.runId ?? state.runId),
    shortId: textOrNull(row.shortId ?? state.shortId),
    actionId: selectedActionId,
    action: clone(action),
    purpose: textOrNull(action.purpose ?? action.role),
    goal: textOrNull(state.intent?.goal ?? state.workflow ?? result?.goal),
    status: verdict.executionStatus,
    executionStatus: verdict.executionStatus,
    executionSucceeded: verdict.execution.succeeded,
    workflowStatus: verdict.workflowStatus,
    verified: verdict.verified,
    verificationVerdict: verdict.verified,
    verificationReason: verdict.verification.reason,
    project: textOrNull(row.project ?? state.project ?? state.intent?.project),
  };
  const header = {
    identity,
    pool: textOrNull(selected?.pool ?? active?.pool),
    model: textOrNull(selected?.model ?? active?.model),
    effort: textOrNull(selected?.effort ?? selected?.routing?.effort ?? route.effort),
    duration: {
      activeMs: activeDurationMs,
      spanMs: spanDurationMs,
      activeMinutes: activeDurationMs == null ? null : activeDurationMs / 60_000,
      spanMinutes: spanDurationMs == null ? null : spanDurationMs / 60_000,
      active: activeDurationMs == null ? null : activeDurationMs / 60_000,
      span: spanDurationMs == null ? null : spanDurationMs / 60_000,
    },
    activeDurationMs,
    spanDurationMs,
    activeDuration: activeDurationMs,
    spanDuration: spanDurationMs,
  };
  const model = {
    identity,
    verdict,
    selectedAttempt: selected,
    attemptHistory: enrichedAttempts,
    attempts: enrichedAttempts,
    route,
    // `money` remains the old string for the extracted renderer. `moneyPair`
    // is the structured v2 pair used by the feature view.
    money: moneyDisplay,
    moneyPair: totalUsage,
    usage: totalUsage,
    tokens: totalUsage.tokens,
    attemptTokens: selectedUsage.tokens,
    totalTokens: totalUsage.tokens,
    activity,
    view: VIEWS.has(view) ? view : 'overview',
    expandedTurn: activity.expandedTurn,
    turns: activity.turns,
    overviewRows: activity.overviewRows,
    header,
    sectionOrder: ['header', 'task', 'activity', 'result', 'cost'],
    blocks: [
      { key: 'header', ...header },
      { key: 'task', ...taskBlock },
      { key: 'activity', ...activity },
      { key: 'result', ...resultBlock },
      { key: 'cost', ...costBlock },
    ],
    // The design record's blocks, said once: one header, turn rows, a result
    // card, the task's own lines, and two plain-word cost rows. The view reads
    // these; every field above stays for the callers that already read it.
    presentation,
    stepHeader: presentation.header,
    activeDurationMs,
    spanDurationMs,
    activeMinutes: activeDurationMs == null ? null : activeDurationMs / 60_000,
    spanMinutes: spanDurationMs == null ? null : spanDurationMs / 60_000,
    duration: header.duration,
    minutes: { active: activeDurationMs == null ? null : activeDurationMs / 60_000, span: spanDurationMs == null ? null : spanDurationMs / 60_000 },
    selectedEvent: activity.selectedEvent,
    // Keep the extraction renderer's arrays at the historical keys while
    // exposing rich objects for the Step feature view.
    outcome: output.lines,
    outcomeModel: outcome,
    task: taskBlock,
    resultBlock,
    resultView: resultBlock,
    cost: costBlock,
    costBlock,
    result: outcome.result,
    resultPath: outcome.resultPath,
    execution: verdict.execution,
    verification: verdict.verification,
    workflow: verdict.workflow,
    prompt: prompt.lines,
    promptModel: prompt,
    artifacts: artifactModel({ runDir, taskFile, outputFile: outFile, streamFile: activity.path, resultFile: resultPath }),
    availability,
    streamAvailable: availability.streamAvailable,
    turnsCaptured: availability.turnsCaptured,
    toolDetailsCaptured: availability.toolDetailsCaptured,
    usagePending: availability.usagePending,
    // Extraction compatibility fields.
    modelInput: input,
    panel,
    state,
    agent: selectedAgent,
    shortId: identity.shortId ?? '',
    action,
    attempt: selected,
    active,
    routing: selected?.routing ?? active?.routing ?? null,
    reasoning,
    assignment,
    expected,
    startedAt,
    pool: poolEconomics,
    taskFile,
    promptLines: prompt.lines,
    output: output.lines,
    outFile,
    bytes,
    live,
  };
  return model;
}
