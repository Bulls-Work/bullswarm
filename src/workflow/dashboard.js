// Interactive workflow dashboard, inspired by Claude Code's /workflows view.
// It deliberately uses only ANSI sequences and Node's standard streams.

import { readFileSync, existsSync } from 'node:fs';
import { readJsonSafe, readJsonForUpdate, writeJsonAtomic } from './fsjson.js';
import { fanoutSucceededCount } from './runner.js';
import { join } from 'node:path';
import { listRuns, resolveRunId } from './short-id.js';
import { appendEvent, readEvents } from './events.js';
import { isDeliveredWorkflowStatus, isTerminalWorkflowStatus } from './status.js';
import { V2_STATE_SCHEMA_VERSION } from './v2-state.js';
import { presentationStageStatus } from './v2-presentation.js';

const ESC = '\x1b[';
const SIDEBAR_WIDTH = 34;
const V2_TERMINAL = new Set(['completed', 'partial', 'cancelled', 'failed']);
const isV2State = (state) => state?.schemaVersion === V2_STATE_SCHEMA_VERSION;
const stateStatus = (state) => isV2State(state) ? state.lifecycle.status : state?.status;
const stateStartedAt = (state) => isV2State(state) ? state.lifecycle.startedAt : state?.startedAt;
const stateFinishedAt = (state) => isV2State(state) ? state.lifecycle.finishedAt : state?.finishedAt;

// Keep navigation wording and bindings in one place. Rendering and input use
// the same vocabulary so a hint never describes a different action.
export const DASHBOARD_KEYS = Object.freeze({
  up: Object.freeze({ keys: '↑/k', label: 'move up', bindings: Object.freeze(['\x1b[A', 'k']) }),
  down: Object.freeze({ keys: '↓/j', label: 'move down', bindings: Object.freeze(['\x1b[B', 'j']) }),
  in: Object.freeze({ keys: 'Enter/→/l', label: 'open', bindings: Object.freeze(['\r', '\n', '\x1b[C', 'l']) }),
  out: Object.freeze({ keys: 'Esc/←/h/b', label: 'move out', bindings: Object.freeze(['\x1b', '\x1b[D', 'h', 'b']) }),
  nextWorkflow: Object.freeze({ keys: 'Tab', label: 'next workflow', bindings: Object.freeze(['\t']) }),
  previousWorkflow: Object.freeze({ keys: 'Shift+Tab', label: 'previous workflow', bindings: Object.freeze(['\x1b[Z']) }),
  detach: Object.freeze({ keys: 'q', label: 'detach', bindings: Object.freeze(['q', '\x03']) }),
});

function keyHint(name) {
  const action = DASHBOARD_KEYS[name];
  return `${action.keys.split('/')[0]} ${action.label}`;
}

function keyPressed(name, key) {
  return DASHBOARD_KEYS[name].bindings?.includes(key) ?? false;
}

function navigationFooter({
  list = false, depth = 0, narrow = false, filterEditing = false, mobileTimeline = true,
} = {}) {
  if (filterEditing) return 'Filter: {query}█ · Enter apply · Esc clear';
  if (list) {
    return narrow
      ? `${keyHint('in')} · / filter · a active/all · ${keyHint('detach')} · ${keyHint('out')} · ${keyHint('nextWorkflow')} · ${keyHint('previousWorkflow')} · r refresh`
      : `${keyHint('up')} · ${keyHint('in')} · / filter · a active/all · ${keyHint('detach')} · ${keyHint('out')} · ${keyHint('nextWorkflow')} · ${keyHint('previousWorkflow')} · r refresh · c stop`;
  }
  const extras = depth >= 4 ? ' · PgUp/PgDn scroll' : '';
  const phaseNavigation = narrow && depth <= 2 && mobileTimeline;
  const phaseToggle = narrow && depth <= 2
    ? ` · t ${mobileTimeline ? 'phases' : 'timeline'}`
    : '';
  const movement = phaseNavigation ? '↑ previous phase · ↓ next phase' : `${keyHint('up')} · ${keyHint('down')}`;
  const open = phaseNavigation ? 'Enter agents' : keyHint('in');
  return `${movement}${phaseToggle} · ${open} · ${keyHint('out')} · ${keyHint('nextWorkflow')} · ${keyHint('previousWorkflow')} · o planner · v technical · c stop · ${keyHint('detach')}${extras}`;
}

function breadcrumbSegments(row, { depth = 0, phase = null, agent = null } = {}) {
  const state = row?.state ?? {};
  const run = row ? `${row.shortId ?? row.runId ?? '------'} · ${workflowRunLabel(row)}` : null;
  const segments = ['Workflows'];
  if (run) segments.push(run);
  if (depth >= 2 && phase) segments.push(phase.label ?? phase.name ?? String(phase));
  if (depth >= 3 && agent) segments.push(agent.action?.id ?? agent.id ?? String(agent));
  return segments;
}

function breadcrumbLine(segments, width) {
  let parts = [...segments];
  while (parts.length > 1 && ` ${parts.join(' › ')}`.length > width) parts.pop();
  if (` ${parts.join(' › ')}`.length <= width) return ` ${parts.join(' › ')}`;
  return truncate(` ${parts.join(' › ')}`, width);
}

function navigationDepth({ detail = false, focus = 0, orchestratorDetail = false, workflowVerbose = false } = {}) {
  if (!detail) return 0;
  if (orchestratorDetail || workflowVerbose) return 2;
  return Math.min(4, 2 + Math.max(0, Number(focus) || 0));
}

function compactUsage(usage) {
  if (!usage) return 'usage pending';
  const tokens = usage.tokens ?? {};
  const tokenText = `tokens read=${tokens.standardRead ?? '?'} cache-read=${tokens.cacheRead ?? '?'} cache-write=${tokens.cacheWrite ?? '?'} output=${tokens.output ?? '?'}`;
  const cost = usage.cost?.estimatedUsd != null
    ? `cost≈$${usage.cost.estimatedUsd}`
    : usage.cost?.knownSubtotalUsd != null
      ? `cost≥$${usage.cost.knownSubtotalUsd} (partial)` : 'cost=?';
  const quota = usage.normalizedQuota?.estimatedPercent == null
    ? usage.normalizedQuota?.knownSubtotalPercent != null
      ? `quota≥${usage.normalizedQuota.knownSubtotalPercent}% (partial)` : 'quota=?'
    : `quota≈${usage.normalizedQuota.estimatedPercent}%`;
  return `${tokenText} · ${cost} · ${quota}`;
}

function tokenText(usage) {
  const tokens = usage?.tokens;
  if (!tokens) return '';
  const reported = tokens.totalKnown;
  const total = Number.isFinite(reported)
    ? reported
    : ['standardRead', 'cacheRead', 'cacheWrite', 'output']
      .map((key) => tokens[key])
      .filter(Number.isFinite)
      .reduce((sum, value) => sum + value, 0);
  if (!total) return '';
  return total >= 1000 ? `${(total / 1000).toFixed(1)}k tok` : `${total} tok`;
}

export function requestCancel(bullswarmDir, token, { source = 'api', requesterPid = process.pid } = {}) {
  const resolved = resolveRunId(bullswarmDir, token);
  if (!resolved) throw new Error(`no run found for "${token}"`);
  const statePath = join(resolved.runDir, 'state.json');
  if (!existsSync(statePath)) throw new Error(`run "${token}" has no state.json`);
  const state = readJsonForUpdate(statePath, 'workflow state');
  if (isV2State(state)) {
    if (V2_TERMINAL.has(state.lifecycle.status)) return { ...resolved, state, alreadyFinished: true };
    const requestedAt = new Date().toISOString();
    state.cancellation = {
      requested: true,
      requestedAt,
      reason: 'operator requested stop',
      source,
      requesterPid,
    };
    appendEvent(resolved.runDir, state, 'workflow.cancellation_requested', {
      requestedAt,
      reason: state.cancellation.reason,
      source,
      requesterPid,
    });
    writeJsonAtomic(statePath, state);
    return { ...resolved, state, alreadyFinished: false };
  }
  if (state.finishedAt || isTerminalWorkflowStatus(state.status)) {
    return { ...resolved, state, alreadyFinished: true };
  }
  state.cancelRequested = true;
  state.cancelRequestedAt = new Date().toISOString();
  state.status = 'cancelling';
  state.cancellingAt = state.cancelRequestedAt;
  appendEvent(resolved.runDir, state, 'run.cancellation_requested', { requestedAt: state.cancelRequestedAt });
  writeJsonAtomic(statePath, state);
  return { ...resolved, state, alreadyFinished: false };
}

export function dashboardRows(bullswarmDir, { all = false } = {}) {
  return listRuns(bullswarmDir)
    .filter((r) => all || r.ongoing)
    .sort((a, b) => {
      if (a.ongoing !== b.ongoing) return a.ongoing ? -1 : 1;
      return String(stateStartedAt(b.state) ?? b.report?.startedAt ?? '')
        .localeCompare(String(stateStartedAt(a.state) ?? a.report?.startedAt ?? ''));
    })
    .map((r) => {
      const state = r.state ?? {};
      if (isV2State(state)) {
        const actions = state.actions ?? [];
        const runningAttempts = (state.attempts ?? []).filter((attempt) => attempt.status === 'running');
        const current = actions.find((action) => action.status === 'running') ?? actions.find((action) => ['ready', 'pending'].includes(action.status));
        const stage = state.presentation?.stages?.find((item) => item.actionIds.includes(current?.id))
          ?? state.presentation?.stages?.findLast((item) => item.startedAt)
          ?? null;
        return {
          ...r,
          events: readEvents(r.runDir),
          status: state.cancellation?.requested ? 'stopping' : state.lifecycle.status,
          phase: stage?.label ?? (state.preflight?.scout?.status === 'running' ? 'Preflight: Scout' : state.planner?.status === 'running' ? 'Workflow Planner' : 'starting'),
          stepsOk: actions.filter((action) => action.status === 'succeeded').length,
          stepsTotal: actions.length,
          fanout: { total: 0, ok: 0, failed: 0 },
          activeAgents: runningAttempts,
          currentPhase: stage,
          currentStep: current ?? null,
          usage: state.usage ?? null,
        };
      }
      const steps = state.steps ?? [];
      const fanout = Object.values(state.outputs ?? {}).filter((v) => v?.items).reduce((acc, v) => ({
        total: acc.total + (v.total ?? 0), ok: acc.ok + fanoutSucceededCount(v), failed: acc.failed + (v.failed ?? 0),
      }), { total: 0, ok: 0, failed: 0 });
      return {
        ...r,
        events: readEvents(r.runDir),
        status: state.cancelRequested ? 'stopping' : (state.status ?? 'running'),
        phase: state.currentStep?.phase ?? state.currentPhase?.name ?? steps.at(-1)?.phase ?? 'starting',
        stepsOk: steps.filter((s) => s.ok).length,
        stepsTotal: steps.length,
        fanout,
        activeAgents: Object.values(state.activeAgents ?? {}),
        currentPhase: state.currentPhase ?? null,
        currentStep: state.currentStep ?? null,
        usage: state.usage ?? null,
      };
    });
}

export function renderDashboard({
  rows, allRows = rows, selected = 0, message = null, width = 120, height = 36,
  filter = 'active', query = '', filterEditing = false, spinnerFrame = 0,
  previewRow = null,
} = {}) {
  width = Math.max(20, Number(width) || 120);
  height = Math.max(12, Number(height) || 36);
  rows = rows ?? [];
  allRows = allRows ?? rows;
  const narrow = width < 100;
  const active = allRows.filter((row) => row.ongoing).length;
  const waiting = allRows.filter((row) => isWaitingWorkflow(row.state)).length;
  const historical = Math.max(0, allRows.length - active);
  const selectedRow = previewRow ?? rows[selected] ?? null;
  const summary = `${active} active · ${waiting} waiting · ${historical} recent`;
  const header = [
    breadcrumbLine(breadcrumbSegments(null), width),
    truncate(` bullswarm workflows · ${summary}`, width),
    selectedRow
      ? truncate(` ${selectedRow.shortId ?? '------'} · ${workflowRunLabel(selectedRow)}`, width)
      : truncate(` ${filter === 'active' ? 'Active workflows' : 'All workflows'}`, width),
  ];
  const footer = filterEditing
    ? truncate(navigationFooter({ filterEditing }).replace('{query}', query), width)
    : truncate(navigationFooter({ list: true, narrow }), width);
  const messageLine = message
    ? truncate(` ${message}`, width)
    : truncate(` Runs · ${filter}${query ? ` · filter “${query}”` : ''} · workflow continues after dashboard exit`, width);
  const bodyHeight = Math.max(6, height - header.length - 2);
  const listLines = dashboardRunLines(rows, selected, narrow, width);

  let body;
  if (narrow) {
    const body = renderPanel(
      `Runs · ${filter}`,
      listWindow(listLines, selected, bodyHeight - 2, true),
      width,
      bodyHeight,
    );
    return [`${ESC}2J${ESC}H`, ...header, ...body, messageLine, footer].join('\n');
  }
  const leftWidth = Math.min(SIDEBAR_WIDTH, Math.max(1, width - 3));
  const rightWidth = Math.max(1, width - leftWidth);
  const left = renderPanel(
    `Runs · ${filter}`,
    listWindow(listLines, selected, bodyHeight - 2, false),
    leftWidth,
    bodyHeight,
  );
  let right;
   if (selectedRow?.state && rightWidth >= 3) {
     const model = workflowPanelModel(selectedRow);
     right = renderWorkflowOverviewPanel(model, rightWidth, bodyHeight, spinnerFrame, 0);
  } else {
    const hint = allRows.length && filter === 'active'
      ? ['No active workflows.', '', 'Press a to browse recent runs.']
      : ['No workflow runs yet.', '', 'Start one with:', 'bullswarm workflow goal "…"'];
    right = renderPanel('Selected workflow', hint, rightWidth, bodyHeight);
  }
  body = joinPanels(left, right);
  return [`${ESC}2J${ESC}H`, ...header, ...body, messageLine, footer].join('\n');
}

function isWaitingWorkflow(state) {
  const value = String(stateStatus(state) ?? state?.stage ?? '').toLowerCase();
  return value.includes('waiting') || value === 'paused';
}

function workflowRunLabel(row) {
  const state = row?.state ?? {};
  const workflow = String(state.workflow ?? '').trim();
  if (workflow && !workflow.startsWith('goal-')) return workflow;
  return String(state.intent?.goal ?? state.intent?.description ?? workflow ?? row?.runId ?? 'workflow')
    .split('\n')[0]
    .trim();
}

function workflowConcernCount(row) {
  const concerns = row?.state?.outcome?.concerns ?? row?.report?.concerns ?? [];
  return Array.isArray(concerns) ? concerns.length : 0;
}

function dashboardRunLines(rows, selected, narrow, width) {
  if (!rows.length) return [{ selected: false, lines: ['No workflows in this view.'] }];
  return rows.map((row, index) => {
    const state = row.state ?? {};
    const selectedRow = index === selected;
    const durableStatus = stateStatus(state);
    const icon = row.ongoing
      ? statusIcon(durableStatus ?? 'running')
      : workflowStatusIcon(isV2State(state) ? { status: durableStatus } : state.status ? state : { ...state, status: 'completed' });
    const elapsed = durationText(stateStartedAt(state) ?? row.report?.startedAt, stateFinishedAt(state) ?? row.report?.finishedAt);
    const workerAttempts = (state.attempts ?? []).filter((attempt) =>
      attempt.actionId !== state.orchestration?.actionId && attempt.actionId !== 'orchestrator');
    const finished = workerAttempts.filter((attempt) => TERMINAL_ACTIONS.has(attempt.status)).length;
    let progress = workerAttempts.length
      ? `${finished}/${workerAttempts.length} workers`
      : `${row.stepsOk ?? 0}/${row.stepsTotal ?? 0} actions`;
    if (row.fanout?.total) progress += ` · ${row.fanout.ok}/${row.fanout.total} items`;
    const concerns = workflowConcernCount(row);
    const status = concerns ? `${concerns} concern${concerns === 1 ? '' : 's'}` : humanWorkflowStatus(durableStatus, row.ongoing);
    const name = workflowRunLabel(row);
    const phase = humanPhaseName(row.phase ?? state.stage ?? 'starting');
    if (narrow) {
      const inner = Math.max(1, width - 4);
      return {
        selected: selectedRow,
        lines: [
          selectLine(`${icon} ${row.shortId ?? '------'} · ${name}`, selectedRow, true, inner),
          selectLine(`  ${progress} · ${elapsed}`, selectedRow, false, inner),
          selectLine(`  ${phase} · ${status}`, selectedRow, false, inner),
          '',
        ],
      };
    }
    return {
      selected: selectedRow,
      lines: [
        selectLine(`${icon} ${row.shortId ?? '------'} · ${name}`, selectedRow, true, 44),
        selectLine(`  ${progress} · ${elapsed} · ${status}`, selectedRow, false, 44),
        '',
      ],
    };
  });
}

function listWindow(groups, selected, height, narrow) {
  const linesPerGroup = narrow ? 4 : 3;
  const capacity = Math.max(1, Math.floor(height / linesPerGroup));
  const start = clamp(selected - Math.floor(capacity / 2), 0, Math.max(0, groups.length - capacity));
  return groups.slice(start, start + capacity).flatMap((group) => group.lines).slice(0, height);
}

function humanWorkflowStatus(status, ongoing) {
  const value = String(status ?? '').replaceAll('_', ' ');
  if (ongoing && (!value || value === 'running')) return 'running';
  if (value === 'completed') return 'finished';
  if (value === 'completed with concerns') return 'finished with concerns';
  return value || (ongoing ? 'running' : 'finished');
}

function humanPhaseName(value) {
  return String(value ?? 'starting').replaceAll('-', ' ').replaceAll(':', ' › ');
}

function filterDashboardRows(rows, filter, query) {
  const needle = String(query ?? '').trim().toLowerCase();
  return (rows ?? []).filter((row) => {
    if (filter === 'active' && !row.ongoing) return false;
    if (!needle) return true;
    const state = row.state ?? {};
    return [row.shortId, row.runId, state.workflow, state.intent?.goal, row.phase, stateStatus(state)]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(needle));
  });
}

export function renderDetails(row, { interactive = true } = {}) {
  const state = row?.state ?? {};
  if (isV2State(state)) return renderV2Details(row, { interactive });
  const phases = state._doc?.phases ?? [];
  const displayedPhase = state.currentPhase?.name
    ?? state.steps?.at(-1)?.phase
    ?? state.stage
    ?? 'starting';
  const displayedCurrent = state.currentStep?.id
    ?? (state.finishedAt ? `terminal:${state.status ?? state.stage ?? 'finished'}` : '—');
  const lines = [
    `${ESC}2J${ESC}H`,
    ` bullswarm · ${state.workflow ?? '?'} · ${row?.shortId ?? row?.runId ?? '?'}`,
    '',
    ` status: ${row?.status ?? state.status ?? 'running'}`,
    ` phase:  ${row?.phase ?? displayedPhase}`,
    ` current: ${displayedCurrent}`,
    ` goal:   ${state.intent?.goal ?? state.intent?.description ?? '—'}`,
    ` orchestrator: ${state.orchestration?.selectedPool ?? state.orchestration?.requestedPool ?? 'auto/pending'} · ${state.orchestration?.selectedModel ?? 'connector model'} · ${state.orchestration?.selection ?? 'workflow-defined'}`,
    ` dir:    ${row?.runDir ?? '—'}`,
    '',
    ' phases:',
  ];
  for (const phase of phases) {
    const active = phase.name === state.currentPhase?.name ? ' ◀ active' : '';
    lines.push(`   ${phase.name}${active}`);
    for (const step of phase.steps ?? []) {
      const result = state.outputs?.[step.id];
      const mark = result?.ok === true ? '✓' : result?.ok === false ? '✗' : '·';
      lines.push(`     ${mark} ${step.id} (${step.type})`);
    }
  }
  lines.push('', ' active agents:');
  for (const agent of Object.values(state.activeAgents ?? {})) {
    const activity = agent.lastActivityAt
      ? ` · output activity ${agent.lastActivityAt} (${agent.outputBytesObserved ?? 0} bytes observed)`
      : ' · no streamed output observed yet';
    const stall = agent.stall?.status === 'suspected_stalled'
      ? ` · ⚠ suspected stalled (${agent.stall.silentForSec}s without evidence; no auto-kill)`
      : agent.stall ? ` · active (${agent.stall.silentForSec}s since evidence)` : '';
    lines.push(`   ⟡ ${agent.stepId} · ${agent.pool ?? '—'} · ${agent.model ?? 'model from connector'} · attempt ${agent.attempt ?? 0}${activity}${stall}`);
    if (agent.eventStreamSupported) {
      lines.push('     last actions:');
      for (const action of agent.lastActions ?? []) {
        const summary = action.summary ? ` · ${action.summary}` : '';
        lines.push(`       ${action.status === 'completed' ? '✓' : action.status === 'failed' ? '✗' : '·'} ${action.kind} · ${action.status}${summary}`);
      }
      if (!(agent.lastActions ?? []).length) lines.push('       waiting for a semantic action event');
    } else {
      lines.push('     last actions: unavailable (connector has no event stream)');
    }
  }
  if (!Object.keys(state.activeAgents ?? {}).length) lines.push('   none');
  lines.push('', ' completed log:');
  for (const step of state.steps ?? []) lines.push(`   ${step.ok ? '✓' : '✗'} ${step.phase}/${step.stepId}${step.why ? ` · ${step.why}` : ''}`);
  const dispatchTarget = state.budget?.dispatchTarget ?? state.budget?.dispatchLimit ?? '∞';
  const dispatchOverage = state.budget?.overTargetBy > 0 ? ` · ${state.budget.overTargetBy} over target` : '';
  const workflowTarget = state.budget?.workflowTargetSec ?? state.settings?.maxWorkflowSeconds ?? '∞';
  const workflowOverage = state.budget?.workflowOverTargetBySec > 0
    ? ` · ${Math.round(state.budget.workflowOverTargetBySec)}s over target`
    : '';
  lines.push('', ` budget: ${state.budget?.dispatchesUsed ?? 0}/${dispatchTarget} dispatch target (advisory${dispatchOverage}) · ${Math.round(state.budget?.workflowElapsedSec ?? 0)}/${workflowTarget}s duration target (advisory${workflowOverage}) · expansion ${state.budget?.expansionRound ?? 0}/${state.budget?.expansionLimit ?? 0}`);
  lines.push(` usage:  ${compactUsage(state.usage)}`);
  lines.push('', ' action tree:');
  for (const action of state.actionLedger ?? []) {
    const indent = action.parentId ? '     ' : '   ';
    const item = action.item === undefined ? '' : ` · item=${JSON.stringify(action.item)}`;
    const timing = action.startedAt ? ` · ${action.startedAt}${action.finishedAt ? ` → ${action.finishedAt}` : ' → running'}` : '';
    lines.push(`${indent}${action.status === 'succeeded' ? '✓' : action.status?.startsWith('failed') ? '✗' : '·'} ${action.id} (${action.kind}) · ${action.status}${item}${timing}`);
    for (const attemptIndex of action.attempts ?? []) {
      const attempt = state.attempts?.[attemptIndex];
      if (attempt) {
        lines.push(`${indent}  ↳ attempt ${attempt.attemptNumber} · ${attempt.pool ?? '—'} · ${attempt.model ?? 'connector model'} · effort=${attempt.effort ?? 'auto'} · ${attempt.status} · ${attempt.startedAt ?? '—'}${attempt.finishedAt ? ` → ${attempt.finishedAt}` : ''}`);
        if (attempt.routing) {
          const candidates = (attempt.routing.candidates ?? []).map((candidate) => `${candidate.pool}:${candidate.pace}`).join(', ');
          lines.push(`${indent}     route: ${attempt.routing.reason}${candidates ? ` · candidates [${candidates}]` : ''}`);
        }
        lines.push(`${indent}     ${compactUsage(attempt.usage)}`);
        for (const agentAction of attempt.lastActions ?? []) {
          lines.push(`${indent}     action: ${agentAction.kind} · ${agentAction.status}${agentAction.summary ? ` · ${agentAction.summary}` : ''}`);
        }
      }
    }
  }
  if (!(state.actionLedger ?? []).length) lines.push('   none');
  lines.push('', ' decisions:');
  for (const decision of state.decisions ?? []) lines.push(`   ${decision.sequence}. ${decision.decision} · ${decision.reason}`);
  if (!(state.decisions ?? []).length) lines.push('   none');
  lines.push('', ' recent events:');
  for (const event of (row?.events ?? []).slice(-8)) lines.push(`   #${event.sequence} ${event.type}`);
  if (!(row?.events ?? []).length) lines.push('   none');
  if (interactive) lines.push('', ` ${keyHint('out')} · c stop · r refresh · ${keyHint('detach')}`);
  return lines.join('\n');
}

function renderV2Details(row, { interactive = true } = {}) {
  const state = row.state;
  const lines = [
    `${ESC}2J${ESC}H`,
    ` bullswarm · ${row.shortId ?? state.shortId ?? state.runId}`,
    '',
    ` status: ${state.lifecycle.status}`,
    ` goal:   ${state.intent.goal}`,
    ` dir:    ${row.runDir ?? '—'}`,
    '',
    ' presentation stages:',
  ];
  for (const stage of state.presentation.stages) {
    const progress = presentationStageStatus(stage, state.actions);
    const status = stage.completedAt ? (progress.successful ? 'completed' : 'completed with gaps') : stage.startedAt ? 'running' : 'not started';
    lines.push(`   ${statusIcon(status)} ${stage.label} · ${progress.completed}/${progress.total} · ${status}`);
    for (const id of stage.actionIds) {
      const action = state.actions.find((entry) => entry.id === id);
      lines.push(`     ${statusIcon(action?.status)} ${id} · ${action?.status ?? 'pending'}`);
    }
  }
  if (!state.presentation.stages.length) lines.push('   planning has not created the first program yet');
  lines.push('', ' workflow planner:');
  lines.push(`   ${statusIcon(state.planner.status)} ${state.planner.status} · ${state.planner.turns} checkpoint${state.planner.turns === 1 ? '' : 's'}`);
  lines.push(`   latest: ${state.planner.lastDecision?.summary ?? 'not available'}`);
  lines.push('', ' requirements:');
  for (const requirement of Object.values(state.ledger.requirements)) {
    lines.push(`   ${statusIcon(requirement.status)} ${requirement.id} · ${requirement.status}`);
  }
  lines.push('', ' recent events:');
  for (const event of (row.events ?? []).slice(-12)) lines.push(`   #${event.sequence} ${event.type}`);
  if (!(row.events ?? []).length) lines.push('   none');
  if (interactive) lines.push('', ` ${keyHint('out')} · c stop · r refresh · ${keyHint('detach')}`);
  return lines.join('\n');
}

const TERMINAL_ACTIONS = new Set([
  'succeeded', 'failed', 'failed_retryable', 'failed_terminal', 'skipped', 'cancelled',
]);
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function isLiveAgent(agent) {
  return !agent?.status || agent.status === 'running';
}

function autonomousControlPlane(state) {
  const autonomous = state.intent?.autonomous === true || state.orchestration?.mode === 'autonomous';
  if (!autonomous) return { autonomous: false, actionId: null, attempts: [], active: null };
  const actionId = state.decisions?.find((decision) => decision.gateId)?.gateId ?? 'orchestrator';
  const attempts = (state.attempts ?? []).filter((attempt) => attempt.actionId === actionId);
  const active = Object.values(state.activeAgents ?? {}).find((agent) => agent.stepId === actionId && isLiveAgent(agent)) ?? null;
  const latestAttempt = attempts.at(-1) ?? null;
  const terminal = Boolean(state.finishedAt);
  const workerActive = Object.values(state.activeAgents ?? {}).some((agent) => agent.stepId !== actionId && isLiveAgent(agent));
  const status = terminal
    ? state.status === 'completed' ? 'completed' : state.status ?? 'finished'
    : active ? 'planning'
      : workerActive ? 'directing execution'
        : state.decisions?.length ? 'reviewing evidence' : 'starting';
  return {
    autonomous,
    actionId,
    attempts,
    active,
    latestAttempt,
    status,
    pool: active?.pool ?? latestAttempt?.pool ?? state.orchestration?.selectedPool ?? state.orchestration?.requestedPool ?? 'selecting',
    model: active?.model ?? latestAttempt?.model ?? state.orchestration?.selectedModel ?? 'connector model',
    latestDecision: state.decisions?.at(-1) ?? null,
  };
}

function effectiveActionStatus(action, state) {
  // A re-running action (repair round, re-verify, schema retry) must read as
  // running even when a previous round recorded ok:false — a failed mark on
  // work that is still being retried misreports the run (user report 2026-08-29).
  const active = Object.values(state.activeAgents ?? {}).some((agent) =>
    isLiveAgent(agent) && (agent.stepId === action.id || String(agent.stepId ?? '').startsWith(`${action.id}[`)));
  if (active || action.status === 'running') return 'running';
  const output = state.outputs?.[action.id];
  if (output?.ok === false) return 'failed_terminal';
  if (output?.ok === true && action.status === 'succeeded') return 'succeeded';
  return action.status ?? 'pending';
}

// Qualification belongs to the outcome envelope, not to the status string:
// a delivered run reads `verified`, `bestEffort` and its concern count from
// `state.outcome`, so a new run and a legacy `completed_with_concerns` run
// render the same sentence.
function outcomeQualification(state) {
  const outcome = state?.outcome ?? null;
  const concernCount = outcome?.concerns?.length ?? 0;
  const verified = outcome?.verified === true;
  // Legacy run dirs predate the envelope: without a concerns array the old
  // status string is the only evidence that concerns were recorded.
  const legacyConcerns = state?.status === 'completed_with_concerns' && !Array.isArray(outcome?.concerns);
  return {
    outcome,
    concernCount,
    verified,
    bestEffort: outcome?.bestEffort === true && !verified,
    concerned: concernCount > 0 || legacyConcerns,
  };
}

function concernPhrase(count) {
  return `${count} concern${count === 1 ? '' : 's'}`;
}

function deliveredRun(state) {
  return Boolean(state?.finishedAt) && isDeliveredWorkflowStatus(state?.status);
}

// An action can end terminal without ever being dispatched: the runner marks
// dynamic actions whose dependencies failed `dependencyBlocked`, and they
// record no attempt. Such an action never ran, so it neither completed nor
// has an agent pane to show.
function actionWasDispatched(action, state) {
  if ((action?.attempts ?? []).length) return true;
  return (state?.attempts ?? []).some((attempt) => attempt.actionId === action?.id
    || String(attempt.actionId ?? '').startsWith(`${action?.id}[`));
}

function isNeverDispatchedBlocked(action, state) {
  return state?.outputs?.[action?.id]?.dependencyBlocked === true && !actionWasDispatched(action, state);
}

// Name the dependency that actually failed instead of repeating the runner's
// generic "blocked by failed or unresolved dependencies" message.
function blockingDependencies(action, state) {
  const deps = action?.dependsOn ?? [];
  const failed = deps.filter((id) => {
    const output = state?.outputs?.[id];
    if (output && output.ok !== true) return true;
    const dep = (state?.actionLedger ?? []).find((entry) => entry.id === id);
    return dep ? String(effectiveActionStatus(dep, state)).startsWith('failed') : false;
  });
  return failed.length ? failed : deps;
}

function phaseLabel(name, control) {
  if (control.autonomous) {
    if (name === 'execution' || String(name).endsWith(':adaptive')) return 'Execution';
    const dynamic = String(name).split(':').at(-1);
    return dynamic.split('-').map((part) => part ? `${part[0].toUpperCase()}${part.slice(1)}` : '').join(' ');
  }
  return compactPhaseName(name);
}

export function workflowPanelModel(row, {
  phaseIndex = null, agentIndex = null,
} = {}) {
  const state = row?.state ?? {};
  if (isV2State(state)) return workflowPanelModelV2(row, { phaseIndex, agentIndex });
  const ledger = state.actionLedger ?? [];
  const orchestrator = autonomousControlPlane(state);
  const isControlAction = (action) => orchestrator.autonomous
    && action.id === orchestrator.actionId
    && action.kind === 'decide';
  const isPreflightAction = (action) => orchestrator.autonomous && action.id === 'scout';
  const isNonPhaseAction = (action) => isControlAction(action) || isPreflightAction(action);
  const phaseNames = [];
  const addPhase = (name) => {
    if (name && !phaseNames.includes(name)) phaseNames.push(name);
  };
  for (const phase of state._doc?.phases ?? []) {
    const controlOnly = orchestrator.autonomous
      && (phase.steps ?? []).length
      && (phase.steps ?? []).every((step) =>
        (step.id === orchestrator.actionId && step.type === 'decide') || step.id === 'scout');
    if (!controlOnly) addPhase(phase.name);
  }
  for (const action of ledger) if (!isNonPhaseAction(action)) addPhase(action.phase);
  for (const step of state.steps ?? []) if (step.stepId !== orchestrator.actionId && step.stepId !== 'scout') addPhase(step.phase);
  if (state.currentStep?.id !== orchestrator.actionId && state.currentStep?.id !== 'scout') addPhase(state.currentStep?.phase);
  if (!orchestrator.autonomous) addPhase(state.currentPhase?.name);
  if (!phaseNames.length) phaseNames.push(orchestrator.autonomous ? 'execution' : 'starting');

  const activePhaseName = state.currentStep?.phase ?? state.currentPhase?.name;
  const currentPhaseIndex = Math.max(0, phaseNames.indexOf(activePhaseName));
  const selectedPhaseIndex = clamp(
    phaseIndex == null ? currentPhaseIndex : phaseIndex,
    0,
    phaseNames.length - 1,
  );
  const delivered = deliveredRun(state);
  const phases = phaseNames.map((name) => {
    const actions = ledger.filter((action) => action.phase === name && !isNonPhaseAction(action));
    const entries = actions.map((action) => ({
      action,
      status: effectiveActionStatus(action, state),
      blocked: isNeverDispatchedBlocked(action, state),
    }));
    // A never-dispatched action is not finished work: counting it produced
    // "1/1 complete" above an empty agent pane (user report 2026-08-31).
    const completed = entries.filter((entry) => !entry.blocked && TERMINAL_ACTIONS.has(entry.status)).length;
    const failed = entries.filter((entry) => String(entry.status).startsWith('failed')).length;
    const blockedActions = entries.filter((entry) => entry.blocked).map((entry) => ({
      id: entry.action.id,
      kind: entry.action.kind ?? 'run',
      blockedBy: blockingDependencies(entry.action, state),
    }));
    const current = name === activePhaseName && !state.finishedAt;
    const active = entries.some((entry) => entry.status === 'running');
    // On a delivered run every failure was recovered or superseded before the
    // delivery, so a permanent ✗ on the phase list misreports the run (user
    // report 2026-08-31). Attempt rows keep their true per-attempt history,
    // and failed, blocked or interrupted runs keep their failure marks.
    const failureMarks = delivered ? 0 : failed;
    const status = active ? 'active'
      : failureMarks ? 'failed'
        : blockedActions.length && completed < actions.length ? 'dependency_blocked'
          : actions.length && completed === actions.length ? 'completed'
            : current ? 'waiting' : 'pending';
    return {
      name, label: phaseLabel(name, orchestrator), status, actions,
      completed, total: actions.length, blockedActions,
    };
  });
  const selectedPhase = phases[selectedPhaseIndex];

  const agents = [];
  const representedActiveKeys = new Set();
  for (const action of selectedPhase.actions) {
    for (const attemptIndex of action.attempts ?? []) {
      const attempt = state.attempts?.[attemptIndex];
      if (!attempt) continue;
      const activeEntry = Object.entries(state.activeAgents ?? {}).find(([, active]) =>
        active.stepId === action.id && active.pool === attempt.pool &&
        (active.attempt == null || active.attempt === attempt.attemptNumber));
      if (activeEntry) representedActiveKeys.add(activeEntry[0]);
      agents.push({
        key: `attempt:${attemptIndex}`,
        action,
        attempt,
        active: activeEntry?.[1] ?? null,
        pool: attempt.pool ?? activeEntry?.[1]?.pool ?? 'unassigned',
        model: attempt.model ?? activeEntry?.[1]?.model ?? 'connector model',
        status: activeEntry ? 'running'
          : state.outputs?.[action.id]?.ok === false ? 'failed_verification'
            : attempt.status ?? effectiveActionStatus(action, state),
      });
    }
  }
  for (const [key, active] of Object.entries(state.activeAgents ?? {})) {
    if (representedActiveKeys.has(key)) continue;
    // The autonomous orchestrator is a control-plane thread, not a worker in
    // whichever execution phase happens to be selected. It has its own panel.
    // Without this guard, an active checkpoint is re-added below a completed
    // phase when both share the durable `autonomous-delivery` phase name.
    if (orchestrator.autonomous && active.stepId === orchestrator.actionId) continue;
    const action = ledger.find((entry) => entry.id === active.stepId || active.stepId?.startsWith(`${entry.id}[`));
    if ((action?.phase ?? state.currentPhase?.name) !== selectedPhase.name) continue;
    agents.push({
      key: `active:${key}`,
      action: action ?? { id: active.stepId, kind: state.currentStep?.type ?? 'run', status: 'running' },
      attempt: null,
      active,
      pool: active.pool ?? 'unassigned',
      model: active.model ?? 'connector model',
      status: active.status ?? 'running',
    });
  }
  const activeAgentIndex = Math.max(0, agents.findIndex((agent) => agent.status === 'running' || agent.active));
  const selectedAgentIndex = agents.length
    ? (agentIndex == null ? activeAgentIndex : clamp(agentIndex, 0, agents.length - 1))
    : 0;
  return {
    state,
    events: row?.events ?? [],
    orchestrator,
    phases,
    phaseIndex: selectedPhaseIndex,
    selectedPhase,
    agents,
    agentIndex: selectedAgentIndex,
    selectedAgent: agents[selectedAgentIndex] ?? null,
  };
}

function workflowPanelModelV2(row, { phaseIndex = null, agentIndex = null } = {}) {
  const state = row.state;
  const actionDefinitions = new Map((state.program?.actions ?? []).map((action) => [action.id, action]));
  const actionStates = new Map((state.actions ?? []).map((action) => [action.id, action]));
  const stages = state.presentation?.stages ?? [];
  const currentStageIndex = Math.max(0, stages.findIndex((stage) => stage.actionIds.some((id) => ['running', 'ready'].includes(actionStates.get(id)?.status))));
  const selectedPhaseIndex = clamp(phaseIndex == null ? currentStageIndex : phaseIndex, 0, Math.max(0, stages.length - 1));
  const phases = stages.map((stage) => {
    const progress = presentationStageStatus(stage, state.actions);
    const actionEntries = stage.actionIds.map((id) => ({ ...actionDefinitions.get(id), ...actionStates.get(id) }));
    const active = actionEntries.some((action) => action.status === 'running');
    const failed = actionEntries.some((action) => ['failed', 'blocked', 'cancelled'].includes(action.status));
    return {
      name: stage.id, label: stage.label,
      status: active ? 'active' : stage.completedAt ? (failed ? 'failed' : 'completed') : stage.startedAt ? 'waiting' : 'pending',
      actions: actionEntries, completed: progress.completed, total: progress.total,
      blockedActions: actionEntries.filter((action) => action.status === 'blocked').map((action) => ({ id: action.id, kind: 'action', blockedBy: action.dependsOn ?? [] })),
    };
  });
  if (!phases.length) phases.push({ name: 'planning', label: 'Planning', status: state.planner.status === 'running' ? 'active' : 'pending', actions: [], completed: 0, total: 0, blockedActions: [] });
  const selectedPhase = phases[selectedPhaseIndex] ?? phases[0];
  const agents = [];
  for (const action of selectedPhase.actions) {
    for (const attempt of (state.attempts ?? []).filter((entry) => entry.actionId === action.id)) {
      agents.push({
        key: `attempt:${attempt.id}`, action, attempt: { ...attempt, attemptNumber: attempt.ordinal, outFile: attempt.outputFile },
        active: attempt.status === 'running' ? { ...attempt, stepId: action.id, attempt: attempt.ordinal, outFile: attempt.outputFile } : null,
        pool: attempt.pool ?? 'unassigned', model: attempt.model ?? 'connector model', status: attempt.status,
      });
    }
  }
  const activeIndex = Math.max(0, agents.findIndex((agent) => agent.status === 'running'));
  const selectedAgentIndex = agents.length ? clamp(agentIndex == null ? activeIndex : agentIndex, 0, agents.length - 1) : 0;
  const plannerAttempts = state.planner?.attempts ?? [];
  const latestPlanner = plannerAttempts.at(-1) ?? null;
  const activePlanner = plannerAttempts.findLast((attempt) => attempt.status === 'running') ?? null;
  const orchestrator = {
    autonomous: true, actionId: 'workflow-planner', attempts: plannerAttempts,
    active: activePlanner, latestAttempt: latestPlanner,
    status: state.planner.status,
    pool: activePlanner?.pool ?? latestPlanner?.pool ?? state.config?.plannerRouting?.pool ?? state.config?.plannerRouting?.preferredPool ?? 'selecting',
    model: activePlanner?.model ?? latestPlanner?.model ?? state.config?.plannerRouting?.model ?? state.config?.plannerRouting?.preferredModel ?? 'connector model',
    latestDecision: state.planner.lastDecision,
  };
  return {
    v2: true, state, events: row.events ?? [], orchestrator, phases,
    phaseIndex: selectedPhaseIndex, selectedPhase, agents,
    agentIndex: selectedAgentIndex, selectedAgent: agents[selectedAgentIndex] ?? null,
  };
}

export function renderWorkflowTui(row, {
  width = 120, height = 36, focus = 0, phaseIndex = null, agentIndex = null,
  detailScroll = 0, message = null, confirmCancel = false,
  controlSelected = false, orchestratorDetail = false, orchestratorVerbose = false,
  workflowVerbose = false, mobileTimeline = true, timelinePhaseFocus = false,
  spinnerFrame = 0,
} = {}) {
  width = Math.max(20, Number(width) || 120);
  height = Math.max(18, Number(height) || 36);
  const narrow = width < 100;
  const model = workflowPanelModel(row, { phaseIndex, agentIndex });
  const state = model.state;
  const status = row?.status ?? stateStatus(state) ?? 'starting';
  const elapsed = durationText(stateStartedAt(state), stateFinishedAt(state));
  const phaseComplete = model.selectedPhase.completed;
  const phaseTotal = model.selectedPhase.total;
  const attempts = state.attempts ?? [];
  const workerAttempts = attempts.filter((attempt) => attempt.actionId !== model.orchestrator.actionId);
  const finishedAgents = workerAttempts.filter((attempt) => TERMINAL_ACTIONS.has(attempt.status)).length;
  const agentProgress = workerAttempts.length ? `${finishedAgents}/${workerAttempts.length} workers · ` : '';
  const terminalLabel = stateFinishedAt(state) ? ` · ${status === 'completed' ? 'done' : status}` : '';
  const runName = state.workflow ?? row?.shortId ?? state.shortId ?? row?.runId ?? 'workflow';
  const breadcrumbDepth = navigationDepth({ detail: true, focus, orchestratorDetail, workflowVerbose });
  const header = [
    breadcrumbLine(breadcrumbSegments(row, {
      depth: breadcrumbDepth,
      phase: model.selectedPhase,
      agent: model.selectedAgent,
    }), width),
    truncate(` ${truncate(runName, Math.max(1, width - agentProgress.length - elapsed.length - terminalLabel.length - 5))} · ${agentProgress}${elapsed}${terminalLabel}`, width),
    ` ${truncate(state.intent?.goal ?? state.workflow ?? 'workflow', width - 2)}`,
  ];
  const footer = confirmCancel
    ? ' Stop this workflow? y confirm · n/Esc keep running'
    : navigationFooter({ depth: breadcrumbDepth, narrow, mobileTimeline });
  const rawMessageLine = message
    ? ` ${truncate(message, width - 2)}`
    : ` ${orchestratorDetail ? `Workflow Planner ${orchestratorVerbose ? 'technical details' : 'overview'}` : workflowVerbose ? 'Workflow technical details' : focus === 0 ? (narrow && !mobileTimeline ? 'Phases' : 'Timeline · auto-following newest event') : focus === 1 ? 'Agents' : 'Agent activity'} · r refresh · workflow continues after detach`;
  const messageLine = truncate(rawMessageLine, width);
  const bodyHeight = Math.max(10, height - header.length - 3);

  const phaseLines = [];
  model.phases.forEach((phase, index) => {
    const icon = statusIcon(phase.status, spinnerFrame);
    const count = phase.total ? ` ${phase.completed}/${phase.total}` : '';
    phaseLines.push(selectLine(
      `${index + 1} ${icon} ${phase.label}${count}`,
      index === model.phaseIndex && !controlSelected,
      focus === 0 && !controlSelected,
      width,
    ));
  });

  const agentLines = [];
  if (!model.agents.length) {
    const blockedActions = model.selectedPhase.blockedActions ?? [];
    if (blockedActions.length) {
      for (const blocked of blockedActions) {
        agentLines.push(dimLine(
          `⊘ ${blocked.id} · never dispatched · blocked by ${blocked.blockedBy.length ? blocked.blockedBy.join(', ') : 'a failed dependency'}`,
          width,
        ));
      }
    } else agentLines.push(dimLine('Not started yet', width));
  }
  model.agents.forEach((agent, index) => {
    const icon = statusIcon(agent.status, spinnerFrame);
    const attempt = agent.attempt?.attemptNumber ?? agent.active?.attempt ?? 1;
    const selected = index === model.agentIndex;
    const tokens = tokenText(agent.attempt?.usage);
    const age = durationText(agent.attempt?.startedAt ?? agent.active?.startedAt, agent.attempt?.finishedAt);
    agentLines.push(selectLine(
      `${icon} ${agent.action.id} · ${agent.pool} · ${agent.model} · #${attempt}${tokens ? ` · ${tokens}` : ''}${age !== 'time pending' ? ` · ${age}` : ''}`,
      selected, focus === 1, width,
    ));
  });

  // Wide terminals keep the hierarchy and preview visible together. Narrow
  // terminals show one full-width pane at a time so mobile/SSH text remains
  // readable and explicit back navigation preserves the same hierarchy.
  const leftWidth = Math.min(SIDEBAR_WIDTH, Math.max(1, width - 3));
  const rightWidth = Math.max(1, width - leftWidth);
  const orchestrationLines = orchestratorDetailLines(
    model,
    Math.max(20, (orchestratorDetail ? width : rightWidth) - 4),
    spinnerFrame,
    { verbose: orchestratorVerbose },
  );
  const detail = orchestratorDetail
    ? orchestrationLines
    : agentDetailLines(model, Math.max(20, rightWidth - 4), spinnerFrame);
  const technical = workflowTechnicalLines(model, Math.max(20, rightWidth - 4));
  const contentHeight = bodyHeight - 2;
  const scrollSource = workflowVerbose ? technical : detail;
  const maxScroll = Math.max(0, scrollSource.length - contentHeight);
  const scroll = clamp(detailScroll, 0, maxScroll);
  const visiblePhases = panelWindow(['', ...phaseLines], model.phaseIndex, 1, contentHeight).slice(1);
  const visibleAgents = panelWindow(['', ...agentLines], model.agentIndex, 1, contentHeight).slice(1);
  const visibleDetail = detail.slice(scroll, scroll + contentHeight);
  const phaseTitle = `Phases · ${model.phases.length}`;
  const orchestrationNavLines = model.orchestrator.autonomous
    ? [
      selectLine(
        `${model.orchestrator.active ? statusIcon('running', spinnerFrame)
          : stateFinishedAt(state) ? workflowStatusIcon(isV2State(state) ? { status: stateStatus(state) } : state, spinnerFrame)
            : statusIcon(model.orchestrator.status, spinnerFrame)} ${plannerDisplayStatus(model)}`,
        controlSelected,
        focus === 0 && !orchestratorDetail,
        leftWidth - 2,
      ),
      dimLine(
        [model.orchestrator.pool, model.orchestrator.model].filter(Boolean).join(' · ') || 'select to inspect',
        leftWidth - 2,
      ),
      dimLine(plannerUsageSummary(model), leftWidth - 2),
    ]
    : [];
  const narrowWorkflowLines = model.orchestrator.autonomous
    ? [...orchestrationNavLines, '', ...visiblePhases]
    : visiblePhases;
  const agentTitle = `${model.selectedPhase.label} · ${phaseComplete}/${phaseTotal} complete`;
  const detailTitle = model.selectedAgent
    ? `${model.selectedAgent.action.id} · ${model.selectedAgent.pool}`
    : 'Agent activity';

  let body;
  if (narrow) {
    if (orchestratorDetail) {
      body = renderPanel(`Workflow Planner · ${orchestratorVerbose ? 'technical details' : 'overview'}`, visibleDetail, width, bodyHeight);
    } else if (workflowVerbose) {
      body = renderPanel('Workflow technical details', technical.slice(scroll, scroll + contentHeight), width, bodyHeight);
    } else if (focus === 0 && mobileTimeline) {
      body = renderWorkflowOverviewPanel(
        model, width, bodyHeight, spinnerFrame, detailScroll,
        timelinePhaseFocus ? model.selectedPhase.label : null,
      );
    } else if (focus === 0) {
      body = renderPanel(phaseTitle, visiblePhases, width, bodyHeight);
    } else if (focus === 1) {
      body = renderPanel(agentTitle, visibleAgents, width, bodyHeight);
    } else {
      body = renderPanel(detailTitle, visibleDetail, width, bodyHeight);
    }
  } else if (orchestratorDetail) {
    body = joinPanels(
      renderPanel('Workflow Planner', orchestrationNavLines, leftWidth, bodyHeight),
      renderPanel(`Workflow Planner · ${orchestratorVerbose ? 'technical details' : 'overview'}`, visibleDetail, rightWidth, bodyHeight),
    );
  } else if (workflowVerbose) {
    const visibleTechnical = technical.slice(scroll, scroll + contentHeight);
    const left = model.orchestrator.autonomous
      ? [
        ...renderPanel('Workflow Planner', orchestrationNavLines, leftWidth, 5),
        ...renderPanel(phaseTitle, visiblePhases, leftWidth, bodyHeight - 5),
      ]
      : renderPanel(phaseTitle, visiblePhases, leftWidth, bodyHeight);
    body = joinPanels(left, renderPanel('Workflow technical details', visibleTechnical, rightWidth, bodyHeight));
  } else if (focus < 2) {
    const left = focus === 1
      ? renderPanel(agentTitle, visibleAgents, leftWidth, bodyHeight)
      : model.orchestrator.autonomous
        ? [
          ...renderPanel('Workflow Planner', orchestrationNavLines, leftWidth, 5),
          ...renderPanel(phaseTitle, visiblePhases, leftWidth, bodyHeight - 5),
        ]
        : renderPanel(phaseTitle, visiblePhases, leftWidth, bodyHeight);
    body = joinPanels(
         left,
        controlSelected
        ? renderPanel(`Workflow Planner · ${model.orchestrator.status}`, orchestrationLines.slice(0, contentHeight), rightWidth, bodyHeight)
        : focus === 0
          ? renderWorkflowOverviewPanel(model, rightWidth, bodyHeight, spinnerFrame, detailScroll)
          : renderPanel(detailTitle, compactAgentPreviewLines(model, Math.max(20, rightWidth - 4), spinnerFrame), rightWidth, bodyHeight),
       );
  } else {
    body = joinPanels(
      renderPanel(agentTitle, visibleAgents, leftWidth, bodyHeight),
      renderPanel(detailTitle, visibleDetail, rightWidth, bodyHeight),
    );
  }

  const lines = [`${ESC}2J${ESC}H`, ...header, ...body, messageLine, truncate(footer, width)];
  return lines.join('\n');
}

function renderPanel(title, content, width, height) {
  const inner = Math.max(1, width - 2);
  const label = truncate(` ${title} `, inner);
  const top = `┌${label}${'─'.repeat(Math.max(0, inner - label.length))}┐`;
  const rows = [top];
  for (let i = 0; i < height - 2; i++) rows.push(`│${panelCell(content[i] ?? '', inner)}│`);
  rows.push(`└${'─'.repeat(inner)}┘`);
  return rows;
}

function joinPanels(left, right) {
  return left.map((line, index) => `${line}${right[index] ?? ''}`);
}

function renderWorkflowOverviewPanel(model, width, height, spinnerFrame, timelineScroll = 0, selectedTimelineSegment = null) {
  const inner = Math.max(1, width - 2);
  const timeline = workflowTimelineLines(model, inner);
  const live = workflowLiveLines(model, inner, spinnerFrame);
  const next = workflowNextLines(model, inner);
  const contentRows = Math.max(3, height - 4); // outer border + two section dividers
  const nextRows = Math.min(next.length, 2);
  const liveRows = Math.min(live.lines.length, Math.max(2, Math.floor(contentRows * 0.42)));
  const timelineRows = Math.max(1, contentRows - liveRows - nextRows);
  const maxTimelineScroll = Math.max(0, timeline.lines.length - timelineRows);
  const selectedHeader = selectedTimelineSegment
    ? timeline.lines.findIndex((line) => line?.header && line.segment === selectedTimelineSegment)
    : -1;
  const scroll = clamp(timelineScroll, 0, maxTimelineScroll);
  const end = selectedHeader >= 0
    ? Math.min(timeline.lines.length, selectedHeader + timelineRows)
    : Math.max(0, timeline.lines.length - scroll);
  let start = selectedHeader >= 0
    ? selectedHeader
    : Math.max(0, end - timelineRows);
  if (start > 0 && selectedHeader < 0) {
    // Reserve one row for the continuation header while keeping the newest
    // timestamped milestone in view.
    start = Math.max(0, end - Math.max(0, timelineRows - 1));
    while (start < end && !/^\d{2}:\d{2}\s/.test(timelineText(timeline.lines[start]))) start += 1;
  }
   let visibleTimeline = timeline.lines.slice(start, end);
   if (start > 0 && selectedHeader < 0) {
     visibleTimeline.unshift(dimText(`↑ ${start} earlier timeline rows`, inner));
     const continuation = visibleTimeline.find((line) => line?.segment)?.segment
       ?? currentTimelineSegment(model);
     if (continuation) {
       const priorHeader = timeline.lines.find((line) => line?.header && line.segment === continuation);
       visibleTimeline.splice(1, 0, continuationHeader(
         continuation,
         priorHeader?.elapsed ?? 'running',
         inner,
         visibleTimeline.find((line) => line?.segment === continuation)?.at,
       ));
     }
    // Scrolled views already carry the upward marker and continuation header;
    // omit inter-segment spacer rows so the viewport retains the latest event.
    visibleTimeline = visibleTimeline.filter((line) => timelineText(line) !== '');
  }
  if (end < timeline.lines.length && visibleTimeline.length) {
    const marker = dimText(`↓ ${timeline.lines.length - end} newer timeline rows`, inner);
    if (visibleTimeline.length >= timelineRows) visibleTimeline[visibleTimeline.length - 1] = marker;
    else visibleTimeline.push(marker);
  }
   if (start > 0 && selectedHeader < 0 && visibleTimeline.length > timelineRows) {
     // The continuation marker and header are structural context, not
     // expendable event rows. Keep both and trim the oldest visible events.
     visibleTimeline = [visibleTimeline[0], visibleTimeline[1],
       ...visibleTimeline.slice(-(timelineRows - 2))];
   } else {
     visibleTimeline = visibleTimeline.slice(0, timelineRows);
   }
  if (selectedTimelineSegment) {
    visibleTimeline = visibleTimeline.map((line) => line?.header && line.segment === selectedTimelineSegment
      ? { ...line, text: `\x1b[7m${timelineText(line)}\x1b[0m` }
      : line);
  }
  const visibleLive = live.lines.slice(0, liveRows);
  const visibleNext = next.slice(0, nextRows);
  const title = ` Workflow timeline · ${timeline.milestoneCount} milestone${timeline.milestoneCount === 1 ? '' : 's'} `;
  const rows = [`┌${truncate(title, inner)}${'─'.repeat(Math.max(0, inner - truncate(title, inner).length))}┐`];
  for (const line of visibleTimeline) rows.push(`│${panelCell(line, inner)}│`);
  while (rows.length < 1 + timelineRows) rows.push(`│${panelCell('', inner)}│`);
  rows.push(sectionDivider(`Live · ${live.running} running · ${live.waiting} waiting`, inner));
  for (const line of visibleLive) rows.push(`│${panelCell(line, inner)}│`);
  while (rows.length < 2 + timelineRows + liveRows) rows.push(`│${panelCell('', inner)}│`);
  rows.push(sectionDivider('Next', inner));
  for (const line of visibleNext) rows.push(`│${panelCell(line, inner)}│`);
  while (rows.length < height - 1) rows.push(`│${panelCell('', inner)}│`);
  rows.push(`└${'─'.repeat(inner)}┘`);
  return rows.slice(0, height);
}

function sectionDivider(label, inner) {
  const text = truncate(` ${label} `, inner);
  return `├${text}${'─'.repeat(Math.max(0, inner - text.length))}┤`;
}

function workflowTimelineLines(model, width) {
  if (model.v2) return workflowTimelineLinesV2(model, width);
  const { state, orchestrator } = model;
  const ledger = state.actionLedger ?? [];
  const events = [];
  const add = (at, lines, sequence = Number.MAX_SAFE_INTEGER, segment = null) => {
    if (!at) return;
    events.push({ at, sequence, segment, lines: Array.isArray(lines) ? lines : [lines] });
  };
  const scout = ledger.find((action) => action.id === 'scout');
  add(state.startedAt, [
    timelineRow(state.startedAt, '● Workflow initiated', '', width),
    timelineDetail(scout ? 'Goal accepted; preparing repository reconnaissance' : 'Execution started', width),
  ], Number.MAX_SAFE_INTEGER, 'Preflight');

  const scoutStartedAt = actionStartedAt(state, scout);
  const scoutFinishedAt = actionFinishedAt(state, scout);
  if (scoutStartedAt) {
    add(scoutStartedAt, [
       timelineRow(scoutStartedAt, '● Scout started', '', width),
      timelineDetail('Read-only repository and capability inspection', width),
    ], Number.MAX_SAFE_INTEGER, 'Preflight');
  }
  if (scoutFinishedAt && TERMINAL_ACTIONS.has(effectiveActionStatus(scout, state))) {
    const attempt = latestAttemptForAction(state, scout);
    const metadata = [attempt?.pool, attempt?.model, tokenText(attempt?.usage)].filter(Boolean).join(' · ');
    add(scoutFinishedAt, [
       timelineRow(scoutFinishedAt, `${statusIcon(effectiveActionStatus(scout, state))} Scout completed`, durationText(scoutStartedAt, scoutFinishedAt), width),
      ...(metadata ? [timelineDetail(metadata, width)] : []),
    ], Number.MAX_SAFE_INTEGER, 'Preflight');
  }

  orchestrator.attempts.forEach((attempt, index) => {
    if (!attempt.finishedAt || !TERMINAL_ACTIONS.has(attempt.status)) return;
    const decision = decisionForPlannerAttempt(state, attempt, index, orchestrator.attempts);
    const summary = decision?.reason ? sentencePreview(decision.reason, Math.max(30, width - 10))
      : decision ? decisionLabel(decision.decision) : 'No accepted decision; correction or retry turn';
    const acceptedBefore = orchestrator.attempts.slice(0, index).filter((entry, priorIndex) =>
      decisionForPlannerAttempt(state, entry, priorIndex, orchestrator.attempts)).length;
    const plannerLabel = !decision
      ? `planning retry #${index + 1}`
      : decision.decision === 'complete'
        ? 'completion confirmed'
        : acceptedBefore === 0 ? 'plan created' : `plan updated #${acceptedBefore + 1}`;
    const segment = index === 0 ? 'Preflight' : 'Planner';
    add(attempt.finishedAt, [
      timelineRow(attempt.finishedAt, `◆ [Workflow Planner] ${plannerLabel}`, durationText(attempt.startedAt, attempt.finishedAt), width),
      timelineDetail(summary, width),
    ], Number.MAX_SAFE_INTEGER, segment);
  });

  const phases = new Map();
  for (const action of ledger) {
    if (action.id === 'scout' || (orchestrator.autonomous && action.id === orchestrator.actionId && action.kind === 'decide')) continue;
    if (!action.phase) continue;
    if (!phases.has(action.phase)) phases.set(action.phase, []);
    phases.get(action.phase).push(action);
  }
  for (const [name, actions] of phases) {
    const realStart = earliestTimestamp(actions.map((action) => actionStartedAt(state, action)));
    const startedAt = realStart ?? earliestTimestamp(actions.map((action) => actionFinishedAt(state, action)));
    if (!startedAt) continue;
    const label = phaseLabel(name, orchestrator);
    const dependencyBlocked = actions.filter((action) => state.outputs?.[action.id]?.dependencyBlocked === true);
    if (!realStart && dependencyBlocked.length === actions.length) {
      const finishedAt = latestTimestamp(actions.map((action) => actionFinishedAt(state, action)));
      if (finishedAt) {
        add(finishedAt, [
          timelineRow(finishedAt, '⊘ skipped', `${actions.length} action${actions.length === 1 ? '' : 's'} not run`, width),
          timelineDetail('Required earlier work did not pass; the planner chose a recovery path', width),
        ], Number.MAX_SAFE_INTEGER, label);
      }
      continue;
    }
    add(startedAt, timelineRow(startedAt, `├─ ${realStart ? 'started' : 'blocked'}`, '', width), Number.MAX_SAFE_INTEGER, label);
    const finished = actions
      .filter((action) => actionFinishedAt(state, action) && TERMINAL_ACTIONS.has(effectiveActionStatus(action, state)))
      .sort((a, b) => Date.parse(actionFinishedAt(state, a)) - Date.parse(actionFinishedAt(state, b)));
    finished.forEach((action, index) => {
      const terminalPhase = finished.length === actions.length && index === finished.length - 1;
      const branch = terminalPhase ? '│  └─' : '│  ├─';
      const actionFinished = actionFinishedAt(state, action);
      const actionStarted = actionStartedAt(state, action);
      const blocked = state.outputs?.[action.id]?.dependencyBlocked === true;
      add(actionFinished, timelineRow(
        actionFinished,
        `${branch}${blocked ? '⊘' : statusIcon(effectiveActionStatus(action, state))} ${action.id}`,
        actionStarted ? durationText(actionStarted, actionFinished) : '',
        width,
      ), Number.MAX_SAFE_INTEGER, label);
    });
    if (finished.length === actions.length && actions.length) {
      const finishedAt = latestTimestamp(actions.map((action) => actionFinishedAt(state, action)));
      const blocked = actions.some((action) => state.outputs?.[action.id]?.dependencyBlocked === true);
      const failed = actions.some((action) => state.outputs?.[action.id]?.dependencyBlocked !== true
        && String(effectiveActionStatus(action, state)).startsWith('failed'));
      const outcome = failed ? 'finished with failures' : blocked ? 'incomplete' : 'completed';
      add(finishedAt, timelineRow(finishedAt, `└─${failed ? '✗' : blocked ? '!' : '✓'} ${outcome}`, `${finished.length}/${actions.length}`, width), Number.MAX_SAFE_INTEGER, label);
    }
  }

  for (const event of model.events) {
    const detail = timelineControlEvent(event, width);
    if (detail) add(event.committedAt, detail, Number(event.sequence), event.type.startsWith('decision.') ? 'Planner' : 'Preflight');
  }

  return groupedTimeline(events, model, width, state.finishedAt);
}

function groupedTimeline(events, model, width, workflowFinishedAt) {
  events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)
    || Number(a.sequence ?? Number.MAX_SAFE_INTEGER) - Number(b.sequence ?? Number.MAX_SAFE_INTEGER));
  const segments = new Map();
  for (const event of events) {
    const name = event.segment ?? 'Workflow';
    const firstAt = event.startedAt ?? event.at;
    if (!segments.has(name)) segments.set(name, { name, events: [], first: firstAt, last: event.at });
    const segment = segments.get(name);
    segment.events.push(event);
    if (Date.parse(firstAt) < Date.parse(segment.first)) segment.first = firstAt;
    if (Date.parse(event.at) > Date.parse(segment.last)) segment.last = event.at;
  }
  const lines = [];
  let previousSegment = null;
  const openedSegments = new Set();
  for (const event of events) {
    if (event.segment !== previousSegment) {
      if (lines.length) lines.push('');
      const segment = segments.get(event.segment ?? 'Workflow');
      const segmentFinishedAt = segment.last;
      const currentSegment = currentTimelineSegment(model);
      const running = !workflowFinishedAt && segment.name === currentSegment;
      const elapsed = running ? 'running' : durationText(segment.first, segmentFinishedAt);
      lines.push(openedSegments.has(segment.name)
        ? continuationHeader(segment.name, elapsed, width)
        : segmentHeader(segment.name, elapsed, width));
      openedSegments.add(segment.name);
      previousSegment = event.segment;
    }
    lines.push(...event.lines.map((line) => ({ text: line, segment: event.segment, at: event.at })));
  }
  if (!lines.length) lines.push({ text: 'Waiting for the first durable workflow milestone', segment: null });
  return { lines, milestoneCount: events.length };
}

function workflowTimelineLinesV2(model, width) {
  const { state } = model;
  const rows = [];
  const add = (at, label, right = '', detail = null, segment = 'Workflow', startedAt = null) => {
    if (!at) return;
    rows.push({
      at, startedAt, segment,
      lines: [timelineRow(at, label, right, width), ...(detail ? [timelineDetail(detail, width)] : [])],
    });
  };
  add(state.lifecycle.startedAt, '● Workflow initiated', '', 'Goal accepted; preparing repository reconnaissance', 'Preflight');
  const eventByType = new Map();
  for (const event of model.events) {
    if (!eventByType.has(event.type)) eventByType.set(event.type, []);
    eventByType.get(event.type).push(event);
  }
  for (const event of eventByType.get('preflight.scout_started') ?? []) add(event.committedAt, '● Scout started', '', event.payload?.purpose, 'Preflight');
  for (const event of eventByType.get('preflight.scout_finished') ?? []) {
    const attempt = state.preflight.scout.attempts.at(-1);
    const detail = [attempt?.pool, attempt?.model, tokenText(attempt?.usage)].filter(Boolean).join(' · ');
    add(event.committedAt, `${event.payload?.status === 'succeeded' ? '✓' : '×'} Scout ${event.payload?.status === 'succeeded' ? 'completed' : 'could not complete'}`, durationText(state.preflight.scout.startedAt, state.preflight.scout.finishedAt), detail, 'Preflight');
  }
  for (const event of eventByType.get('planner.finished') ?? []) {
    const turn = Number(event.payload?.turn ?? 1);
    const label = event.payload?.ok
      ? turn === 1 ? '[Workflow Planner] plan created' : `[Workflow Planner] plan updated #${turn}`
      : '[Workflow Planner] planning attempt rejected';
    const attempt = state.planner.attempts.findLast((item) => item.turn === turn);
    add(
      event.committedAt,
      `${event.payload?.ok ? '◇' : '×'} ${label}`,
      attempt ? durationText(attempt.startedAt, attempt.finishedAt) : '',
      event.payload?.summary ?? event.payload?.why,
      turn === 1 ? 'Preflight' : 'Planner',
      attempt?.startedAt,
    );
  }
  const stageById = new Map((state.presentation?.stages ?? []).map((stage) => [stage.id, stage]));
  for (const event of model.events) {
    if (event.type === 'presentation.stage_started') {
      add(event.committedAt, '├─ started', '', null, event.payload.label);
    }
    if (event.type === 'action.finished' || event.type === 'evidence.recorded') {
      const actionId = event.payload?.actionId;
      const runtime = state.actions.find((action) => action.id === actionId);
      const stage = (state.presentation?.stages ?? []).find((item) => item.actionIds.includes(actionId));
      const status = runtime?.status === 'succeeded' ? '✓' : runtime?.status === 'blocked' ? '⊘' : '×';
      add(event.committedAt, `│  ├─${status} ${actionId}`, runtime?.startedAt ? durationText(runtime.startedAt, runtime.finishedAt) : '', null, stage?.label ?? 'Work');
    }
    if (event.type === 'presentation.stage_completed') {
      const stage = stageById.get(event.payload?.stageId);
      const ok = event.payload?.status === 'completed';
      add(event.committedAt, `└─${ok ? '✓' : '×'} completed`, `${event.payload.completed}/${event.payload.total}`, null, stage?.label ?? event.payload.label);
    }
  }
  if (state.lifecycle.finishedAt) {
    const status = state.lifecycle.status;
    const finalSegment = state.presentation?.stages?.findLast((stage) => stage.startedAt)?.label ?? 'Workflow';
    add(state.lifecycle.finishedAt, `${status === 'completed' ? '✓' : status === 'partial' ? '!' : '×'} Workflow ${status === 'completed' ? 'complete - result is ready' : `${status} - result is ready`}`, durationText(state.lifecycle.startedAt, state.lifecycle.finishedAt), null, finalSegment);
  }
  return groupedTimeline(rows, model, width, state.lifecycle.finishedAt);
}

function segmentHeader(name, elapsed, width) {
  if (width < 40) {
    const suffix = ` ── ${elapsed} ──`;
    const available = width - suffix.length - 3;
    const text = available >= String(name).length
      ? `── ${name}${suffix}`
      : `── ${truncate(name, Math.max(1, available))}${suffix}`;
    return { text: truncate(text, width), segment: name, elapsed, header: true };
  }
  const text = `── ${name} `;
  const suffix = ` ${elapsed} ──`;
  const room = Math.max(0, width - text.length - suffix.length);
  if (room < 2) return { text: truncate(`── ${name} ──`, width), segment: name, elapsed, header: true };
  return { text: truncate(`${text}${'─'.repeat(room)}${suffix}`, width), segment: name, elapsed, header: true };
}

function continuationHeader(segment, elapsed, width, at = null) {
  if (width < 40) {
    // Keep the segment name readable in the compact pane; the continuation
    // marker already distinguishes this header from the initial one.
    const text = `── ${segment} · continued ──`;
    return { text: truncate(text, width), segment, elapsed, header: true, at };
  }
  const text = `── ${segment} · continued `;
  const suffix = ` ${elapsed} ──`;
  const room = Math.max(0, width - text.length - suffix.length);
  if (room < 2) return { text: truncate(`── ${segment} · continued ──`, width), segment, elapsed, header: true, at };
  return { text: truncate(`${text}${'─'.repeat(room)}${suffix}`, width), segment, elapsed, header: true, at };
}

function currentTimelineSegment(model) {
  const { state, orchestrator } = model;
  if (model.v2) {
    const activeAction = state.actions.find((action) => action.status === 'running');
    return state.presentation.stages.find((stage) => stage.actionIds.includes(activeAction?.id))?.label
      ?? (state.preflight?.scout?.status === 'running' ? 'Preflight'
        : state.planner.status === 'running'
          ? (state.actions.length ? 'Planner' : 'Preflight')
          : 'Workflow');
  }
  if (orchestrator.active || (orchestrator.autonomous && !state.currentStep?.phase)) return 'Planner';
  const phase = state.currentStep?.phase ?? state.currentPhase?.name;
  return phase ? phaseLabel(phase, orchestrator) : 'Preflight';
}

function timelineText(value) {
  return typeof value === 'string' ? value : value?.text ?? '';
}

function decisionForPlannerAttempt(state, attempt, index, attempts) {
  const decisions = state.decisions ?? [];
  if (attempt?.outFile) {
    const artifactMatch = decisions.find((decision) => decision.artifact === attempt.outFile);
    if (artifactMatch) return artifactMatch;
  }
  const started = Date.parse(attempt?.startedAt ?? '');
  const finished = Date.parse(attempt?.finishedAt ?? '');
  if (Number.isFinite(started) && Number.isFinite(finished)) {
    const timeMatch = decisions.find((decision) => {
      const created = Date.parse(decision.createdAt ?? '');
      return Number.isFinite(created) && created >= started && created <= finished + 2_000;
    });
    if (timeMatch) return timeMatch;
  }
  const hasDurableCorrelation = decisions.some((decision) => decision.artifact || decision.createdAt)
    || attempts.some((entry) => entry.outFile);
  return hasDurableCorrelation ? null : decisions[index];
}

function timelineControlEvent(event, width) {
  const labels = {
    'decision.rejected': '✗ [Workflow Planner] decision rejected',
    'decision.correction_requested': '⧖ [Workflow Planner] correction requested',
    'decision.orchestrator_escalated': '◆ [Workflow Planner] provider escalated',
    'run.cancellation_requested': '⧖ Workflow cancellation requested',
    'run.cancelling': '⧖ Workflow cancellation requested',
    'run.interruption_requested': '⧖ Workflow interruption requested',
    'workflow.expansion_target_exceeded': '! Advisory expansion target exceeded',
    'workflow.agent_target_exceeded': '! Advisory agent target exceeded',
  };
  const label = labels[event.type];
  if (!label) return null;
  const reason = event.payload?.why ?? event.payload?.reason;
  return [
    timelineRow(event.committedAt, label, '', width),
    ...(reason ? [timelineDetail(sentencePreview(reason, Math.max(20, width - 8)), width)] : []),
  ];
}

function workflowLiveLines(model, width, spinnerFrame) {
  if (model.v2) return workflowLiveLinesV2(model, width, spinnerFrame);
  const { state, orchestrator } = model;
  const activeWorkers = Object.values(state.activeAgents ?? {})
    .filter((agent) => agent.stepId !== orchestrator.actionId && isLiveAgent(agent))
    .sort((a, b) => String(b.lastEventAt ?? b.lastActivityAt ?? '').localeCompare(String(a.lastEventAt ?? a.lastActivityAt ?? '')));
  const lines = [];
  let running = activeWorkers.length + (orchestrator.active ? 1 : 0);
  let waiting = 0;
  if (orchestrator.autonomous && !state.finishedAt) {
    const plannerWaiting = !orchestrator.active && activeWorkers.length > 0;
    if (plannerWaiting) waiting += 1;
    const plannerStatus = orchestrator.active ? 'planning' : plannerWaiting ? 'waiting' : orchestrator.status;
    lines.push(alignRight(
      `${statusIcon(plannerStatus, spinnerFrame)} [Workflow Planner] · ${orchestrator.pool} · ${orchestrator.model}`,
      plannerStatus,
      width,
    ));
    if (plannerWaiting) lines.push(`   Waiting for ${activeWorkers.length === 1 ? activeWorkers[0].stepId : `${activeWorkers.length} workers`}`);
    else if (orchestrator.active) lines.push('   Choosing the next smallest useful action');
    else lines.push(`   ${humanStatus(orchestrator.status)}`);
    const plannerAction = orchestrator.active?.lastActions?.at(-1) ?? orchestrator.latestAttempt?.lastActions?.at(-1);
    if (plannerAction) lines.push(`   ↳ ${friendlyActionKind(plannerAction.kind)}${plannerAction.summary ? ` · ${friendlyActionSummary(plannerAction)}` : ''}`);
    else if (orchestrator.latestDecision) lines.push(`   ↳ Decision · ${decisionLabel(orchestrator.latestDecision.decision)}`);
    const plannerStream = streamActivityLine(orchestrator.active);
    if (plannerStream) lines.push(`   ${plannerStream}`);
    lines.push('');
  }
  for (const agent of activeWorkers) {
    const action = (state.actionLedger ?? []).find((entry) => entry.id === agent.stepId || agent.stepId?.startsWith(`${entry.id}[`));
    lines.push(alignRight(
      `${statusIcon(agent.status ?? 'running', spinnerFrame)} ${agent.stepId} · ${agent.pool ?? 'unassigned'} · ${agent.model ?? 'connector model'}`,
      durationText(action?.startedAt ?? agent.startedAt),
      width,
    ));
    const latest = agent.lastActions?.at(-1);
    lines.push(latest
      ? `   ↳ ${friendlyActionKind(latest.kind)}${latest.summary ? ` · ${friendlyActionSummary(latest)}` : ''}`
      : '   ↳ waiting for the first semantic action event');
    const stream = streamActivityLine(agent);
    if (stream) lines.push(`   ${stream}`);
    lines.push('');
  }
  if (!lines.length) lines.push(state.finishedAt
    ? `${workflowStatusIcon(state)} No agents running · ${terminalWorkflowLabel(state)}`
    : '⧖ Waiting for the next dispatch');
  return { lines, running, waiting };
}

function workflowLiveLinesV2(model, width, spinnerFrame) {
  const { state, orchestrator } = model;
  const runningAttempts = state.attempts.filter((attempt) => attempt.status === 'running');
  const lines = [];
  const plannerRunning = orchestrator.active;
  const plannerWaiting = !plannerRunning && runningAttempts.length > 0 && !stateFinishedAt(state);
  let waiting = plannerWaiting ? 1 : 0;
  if (plannerRunning || plannerWaiting) {
    const status = plannerRunning ? 'planning' : 'waiting';
    lines.push(alignRight(`${statusIcon(status, spinnerFrame)} [Workflow Planner] · ${orchestrator.pool} · ${orchestrator.model}`, status, width));
    lines.push(plannerRunning ? '   Choosing the next bounded program' : `   Waiting for ${runningAttempts.length} worker${runningAttempts.length === 1 ? '' : 's'}`);
    const event = plannerRunning?.lastAgentEvent;
    if (event) lines.push(`   ↳ ${friendlyActionKind(event.kind ?? event.providerType)}${event.summary ? ` · ${friendlyActionSummary(event)}` : ''}`);
    const stream = streamActivityLine(plannerRunning);
    if (stream) lines.push(`   ${stream}`);
    lines.push('');
  }
  for (const attempt of runningAttempts) {
    lines.push(alignRight(`${statusIcon('running', spinnerFrame)} ${attempt.actionId} · ${attempt.pool ?? 'unassigned'} · ${attempt.model ?? 'connector model'}`, durationText(attempt.startedAt), width));
    const event = attempt.lastAgentEvent;
    lines.push(event
      ? `   ↳ ${friendlyActionKind(event.kind ?? event.providerType)}${event.summary ? ` · ${friendlyActionSummary(event)}` : ''}`
      : '   ↳ waiting for the first semantic action event');
    const stream = streamActivityLine(attempt);
    if (stream) lines.push(`   ${stream}`);
    lines.push('');
  }
  if (!lines.length) lines.push(stateFinishedAt(state)
    ? `✓ No live agents · workflow ${state.lifecycle.status}`
    : '⧖ Waiting for the next dispatch');
  return { lines, running: runningAttempts.length + (plannerRunning ? 1 : 0), waiting };
}

function terminalWorkflowLabel(state) {
  const status = state?.status;
  const { concernCount, bestEffort, concerned } = outcomeQualification(state);
  if (isDeliveredWorkflowStatus(status)) {
    const concerns = concernCount ? concernPhrase(concernCount) : concerned ? 'concerns' : '';
    if (bestEffort) return `best-effort delivery, unverified${concerns ? ` — ${concerns}` : ''}`;
    return concerns ? `workflow finished with ${concerns}` : 'workflow finished';
  }
  if (status === 'blocked') return 'workflow stopped with blockers';
  if (status === 'failed') return 'workflow failed';
  if (status === 'cancelled') return 'workflow cancelled';
  if (status === 'interrupted') return 'workflow interrupted';
  return 'workflow stopped';
}

function workflowNextLines(model, width) {
  if (model.v2) return workflowNextLinesV2(model, width);
  const { state, orchestrator } = model;
  if (state.finishedAt) {
    const { concernCount, bestEffort, concerned } = outcomeQualification(state);
    const next = isDeliveredWorkflowStatus(state.status)
      ? concernCount ? `review ${concernPhrase(concernCount)} in result`
        : concerned ? 'review concerns in result'
          : bestEffort ? 'review the unverified best-effort delivery'
            : 'result ready'
      : state.status === 'blocked' ? 'review blockers and partial work'
        : state.status === 'failed' ? 'inspect the failure before using partial work'
          : state.status === 'cancelled' ? 'review any partial work'
            : state.status === 'interrupted' ? 'resume the workflow or inspect partial work'
              : 'inspect the workflow result';
    const label = terminalWorkflowLabel(state);
    return [truncate(`${workflowStatusIcon(state)} ${label[0].toUpperCase()}${label.slice(1)} · ${next}`, width)];
  }
  const ledger = state.actionLedger ?? [];
  const pending = ledger.find((action) => action.id !== 'scout'
    && action.id !== orchestrator.actionId
    && !TERMINAL_ACTIONS.has(effectiveActionStatus(action, state))
    && effectiveActionStatus(action, state) !== 'running');
  if (pending) {
    const blockers = (pending.dependsOn ?? []).filter((id) => state.outputs?.[id]?.ok !== true);
    const wait = blockers.length ? ` · waiting for ${blockers.join(', ')}` : '';
    return [truncate(`○ [Phase: ${phaseLabel(pending.phase, orchestrator)}] · ${pending.id}${wait}`, width)];
  }
  if (Object.keys(state.activeAgents ?? {}).some((key) => state.activeAgents[key]?.stepId !== orchestrator.actionId)) {
    return ['○ [Workflow Planner] will reassess when current work finishes'];
  }
  if (orchestrator.active) return ['○ Awaiting the next [Workflow Planner] decision'];
  return ['○ Awaiting the next [Workflow Planner] decision'];
}

function workflowNextLinesV2(model, width) {
  const { state } = model;
  if (stateFinishedAt(state)) return [truncate(`✓ Workflow ${state.lifecycle.status === 'completed' ? 'complete' : state.lifecycle.status} - result is ready`, width)];
  const running = state.attempts.filter((attempt) => attempt.status === 'running');
  if (running.length) return [truncate(`○ Waiting for ${running.length} worker${running.length === 1 ? '' : 's'}`, width)];
  if (state.planner.status === 'running') return ['○ Workflow Planner is creating the next bounded program'];
  if (state.actions.some((action) => ['pending', 'ready'].includes(action.status))) return ['○ Starting the next dependency-ready actions'];
  return ['○ Workflow Planner will reassess remaining gaps'];
}

function workflowTechnicalLines(model, width) {
  if (model.v2) {
    const { state } = model;
    return wrapLines([
      `Schema · ${state.schemaVersion}`,
      `Status · ${state.lifecycle.status}`,
      `Started · ${state.lifecycle.startedAt ?? '—'}`,
      `Usage · ${state.usage.total} known tokens`,
      '', 'Action program',
      ...state.actions.map((action) => `${statusIcon(action.status)} ${action.id} · revision ${action.programRevision} · ${action.status}`),
      '', 'Requirement ledger',
      ...Object.values(state.ledger.requirements).map((requirement) => `${statusIcon(requirement.status)} ${requirement.id} · ${requirement.status}`),
      '', 'Recent durable events',
      ...model.events.slice(-12).map((event) => `#${event.sequence} ${event.type}`),
    ], width);
  }
  const { state, orchestrator } = model;
  const lines = [
    `Status · ${state.status ?? 'starting'}`,
    `Current · ${state.currentStep?.id ?? '—'} · ${state.currentStep?.phase ?? state.currentPhase?.name ?? '—'}`,
    `Started · ${state.startedAt ?? '—'}`,
    `Usage · ${compactUsage(state.usage)}`,
    '',
    'Action ledger',
  ];
  for (const action of state.actionLedger ?? []) {
    const control = orchestrator.autonomous && action.id === orchestrator.actionId && action.kind === 'decide';
    lines.push(`${statusIcon(effectiveActionStatus(action, state))} ${control ? '[Workflow Planner]' : action.id} · ${action.kind} · ${action.status ?? 'pending'} · ${action.phase ?? '—'}`);
  }
  if (!(state.actionLedger ?? []).length) lines.push('· no actions recorded');
  lines.push('', 'Recent durable events');
  for (const event of model.events.slice(-12)) lines.push(`#${event.sequence} ${event.type}`);
  if (!model.events.length) lines.push('· no events recorded');
  return wrapLines(lines, width);
}

function timelineRow(at, label, right, width) {
  if (width < 40) return label;
  return alignRight(`${clockText(at)}  ${label}`, right, width);
}

function timelineDetail(text, width) {
  return truncate(`       ${text}`, width);
}

function alignRight(left, right, width) {
  const suffix = right ? String(right) : '';
  // Preserve the actionable event label in the compact preview; dropping a
  // duration is preferable to turning the action name into an ellipsis.
  if (width < 30) return truncate(left, width);
  if (!suffix) return truncate(left, width);
  const room = Math.max(1, width - suffix.length - 1);
  const lhs = truncate(left, room);
  return `${lhs}${' '.repeat(Math.max(1, width - lhs.length - suffix.length))}${suffix}`;
}

function clockText(value) {
  const date = new Date(value ?? '');
  if (!Number.isFinite(date.getTime())) return '--:--';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function earliestTimestamp(values) {
  return values.filter(Boolean).sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;
}

function latestTimestamp(values) {
  return values.filter(Boolean).sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
}

function latestAttemptForAction(state, action) {
  if (!action) return null;
  return (action.attempts ?? []).map((index) => state.attempts?.[index]).filter(Boolean).at(-1) ?? null;
}

function actionStartedAt(state, action) {
  if (!action) return null;
  const attempts = (action.attempts ?? []).map((index) => state.attempts?.[index]).filter(Boolean);
  return action.startedAt ?? earliestTimestamp(attempts.map((attempt) => attempt.startedAt));
}

function actionFinishedAt(state, action) {
  if (!action) return null;
  const attempts = (action.attempts ?? []).map((index) => state.attempts?.[index]).filter(Boolean);
  return action.finishedAt ?? latestTimestamp(attempts.map((attempt) => attempt.finishedAt));
}

function streamActivityLine(agent) {
  if (!agent) return '';
  const at = agent.lastEventAt ?? agent.lastActivityAt;
  if (!at) return 'stream waiting for the first provider event';
  return `stream active ${durationText(at)} ago · ${formatBytes(agent.outputBytesObserved ?? 0)} observed`;
}

function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function humanStatus(value) {
  return String(value ?? 'waiting').replaceAll('_', ' ').replace(/^./, (char) => char.toUpperCase());
}

function plannerDisplayStatus(model) {
  const { orchestrator, state } = model;
  if (model.v2) {
    if (stateFinishedAt(state)) return state.lifecycle.status === 'completed' ? 'Completed' : humanStatus(state.lifecycle.status);
    if (orchestrator.active) return 'Creating or updating plan';
    if (state.attempts.some((attempt) => attempt.status === 'running')) return 'Waiting for workers';
    return humanStatus(state.planner.status);
  }
  if (state.finishedAt && isDeliveredWorkflowStatus(state.status)) {
    const { concernCount, bestEffort, concerned } = outcomeQualification(state);
    const concerns = concernCount ? concernPhrase(concernCount) : concerned ? 'concerns' : '';
    // The planner pane is a 34-column nav column: state the qualification
    // here and leave the count to the Live, Next and Result lines.
    if (bestEffort) return 'Best-effort, unverified';
    return concerns ? `Completed with ${concerns}` : 'Completed';
  }
  if (state.finishedAt) return humanStatus(state.status);
  if (orchestrator.active) return 'Planning next actions';
  const workers = Object.values(state.activeAgents ?? {}).filter((agent) => agent.stepId !== orchestrator.actionId && isLiveAgent(agent));
  if (workers.length) return 'Waiting for workers';
  if (orchestrator.status === 'reviewing evidence') return 'Reviewing evidence';
  return humanStatus(orchestrator.status);
}

function plannerUsageSummary(model) {
  const checkpoints = model.orchestrator.attempts.length;
  if (model.v2) return `Checkpoints ${checkpoints} · ${model.state.usage.total || 0} tok`;
  const cost = model.state.usage?.cost?.estimatedUsd ?? model.state.usage?.cost?.knownSubtotalUsd;
  return `Checkpoints ${checkpoints}${Number.isFinite(cost) ? ` · $${cost.toFixed(2)}` : ''}`;
}

function dimText(value, width) {
  return `\x1b[2m${truncate(value, width)}\x1b[0m`;
}

function orchestratorDetailLines(model, width, spinnerFrame, { verbose = false } = {}) {
  const { orchestrator, state } = model;
  if (model.v2) return orchestratorDetailLinesV2(model, width, spinnerFrame, { verbose });
  if (!orchestrator.autonomous) {
    return wrapLines(['This workflow has no autonomous orchestrator thread.'], width);
  }
  const latest = orchestrator.latestAttempt;
  const active = orchestrator.active;
  const liveActions = active?.lastActions ?? latest?.lastActions ?? [];
  const totalActions = active?.actionCount ?? latest?.actionCount ?? liveActions.length;
  const conversations = Object.entries(state.orchestration?.conversations ?? {});
  const decisions = state.decisions ?? [];
  const latestDecision = decisions.at(-1);
  const latestLiveAction = liveActions.at(-1) ?? null;
  const workerAttempts = (state.attempts ?? []).filter((attempt) => attempt.actionId !== orchestrator.actionId);
  const completedWorkers = workerAttempts.filter((attempt) => TERMINAL_ACTIONS.has(attempt.status)).length;
  const activeWorkers = Object.values(state.activeAgents ?? {})
    .filter((agent) => agent.stepId !== orchestrator.actionId && isLiveAgent(agent));
  const nextActions = latestDecision?.actions?.map((action) => action.id).filter(Boolean) ?? [];
  const stateLabel = active
    ? 'Choosing the next smallest useful action'
    : activeWorkers.length
      ? `Waiting for ${activeWorkers.length} worker${activeWorkers.length === 1 ? '' : 's'} to finish`
      : state.finishedAt
        ? 'Workflow finished'
        : 'Reviewing completed evidence';
  const lines = [
    `${statusIcon(active ? 'running' : latest?.status ?? orchestrator.status, spinnerFrame)} ${orchestrator.status} · ${orchestrator.pool} · ${orchestrator.model}`,
    '',
    `Now · ${stateLabel}`,
    `Progress · ${completedWorkers}/${workerAttempts.length} worker attempts finished · ${orchestrator.attempts.length} planning checkpoint${orchestrator.attempts.length === 1 ? '' : 's'}`,
  ];
  if (active) {
    lines.push(latestLiveAction
      ? `Latest action · ${friendlyActionKind(latestLiveAction.kind)}${latestLiveAction.summary ? ` · ${friendlyActionSummary(latestLiveAction)}` : ''}`
      : 'Latest action · waiting for the first semantic event');
    lines.push(active.lastEventAt
      ? `Live stream · event ${durationText(active.lastEventAt)} ago · ${active.outputBytesObserved ?? 0} bytes observed`
      : 'Live stream · waiting for the first provider event');
  }
  if (latestDecision) {
    lines.push(`Latest decision · ${decisionLabel(latestDecision.decision)}`);
    if (latestDecision.reason) lines.push(`Why · ${sentencePreview(latestDecision.reason)}`);
    lines.push(`Next · ${nextActions.length ? nextActions.join(', ') : latestDecision.decision === 'complete' ? 'Return the verified result' : 'Wait for current work, then reassess'}`);
  } else {
    lines.push('Latest decision · Planning has not completed its first checkpoint yet');
  }
  if (active?.stall?.status === 'suspected_stalled') {
    lines.push(`Attention · No new evidence for ${active.stall.silentForSec}s; the agent has not been auto-killed`);
  }

  if (!verbose) {
    if (state.finishedAt) {
      const { verified, bestEffort, concernCount, concerned } = outcomeQualification(state);
      const concerns = concernCount ? ` · ${concernPhrase(concernCount)}` : concerned ? ' with concerns' : '';
      const result = isDeliveredWorkflowStatus(state.status)
        ? verified
          ? `Verified delivery is ready${concerns}`
          : `Best useful delivery is ready${bestEffort ? ', unverified' : ''}${concerns}`
        : state.status === 'blocked' ? 'No useful delivery could be completed' : 'Workflow is terminal';
      lines.push('', `Result · ${result}`);
      if (concernCount) lines.push(`Concerns · ${concernCount} recorded in the result envelope`);
    }
    lines.push('', 'Recent activity');
    if (!liveActions.length) lines.push('· waiting for semantic action events');
    const firstVisibleActionNumber = Math.max(1, totalActions - liveActions.length + 1);
    liveActions.slice(-3).forEach((action, index, visible) => {
      const number = Math.max(firstVisibleActionNumber, totalActions - visible.length + 1) + index;
      lines.push(`#${number} ${statusIcon(action.status, spinnerFrame)} ${friendlyActionKind(action.kind)}${action.summary ? ` · ${friendlyActionSummary(action)}` : ''}`);
    });
    lines.push('', 'Press v for checkpoint prompts, sessions, usage, and artifact paths.');
    return wrapLines(lines, width);
  }

  lines.push('', 'Technical thread');
  lines.push(`Logical thread · ${orchestrator.attempts.length} checkpoint turn${orchestrator.attempts.length === 1 ? '' : 's'}`);
  for (const [pool, thread] of conversations) {
    lines.push(`Session · ${pool} · ${thread.sessionId ?? '—'}${thread.started ? ' · resumable' : ' · pending first turn'}`);
  }
  if (!conversations.length) lines.push('Session · pending first orchestrator dispatch');
  if (active?.lastActivityAt) lines.push(`Last activity · ${active.lastActivityAt} · ${active.outputBytesObserved ?? 0} bytes`);
  if (active?.stall?.status === 'suspected_stalled') {
    lines.push(`⚠ Suspected stalled · ${active.stall.silentForSec}s without evidence · never auto-killed`);
  }

  lines.push('', 'Checkpoint turns');
  if (!orchestrator.attempts.length) lines.push('· waiting for the first planning turn');
  orchestrator.attempts.forEach((attempt, index) => {
    const decision = decisionForPlannerAttempt(state, attempt, index, orchestrator.attempts);
    lines.push(`#${index + 1} ${statusIcon(attempt.status, spinnerFrame)} ${attempt.status} · ${attempt.pool ?? '—'} · ${attempt.model ?? 'connector model'} · ${durationText(attempt.startedAt, attempt.finishedAt)}`);
    lines.push(`  ${compactUsage(attempt.usage)}`);
    if (decision) lines.push(`  decision: ${decision.decision} · ${decision.reason}`);
    if (attempt.failureReason) lines.push(`  failure: ${attempt.failureReason}`);
  });

  const prompt = taskPreview(active?.taskFile ?? latest?.taskFile);
  lines.push('', `Current checkpoint prompt${prompt.length ? ` · ${prompt.length} lines shown` : ''}`);
  if (prompt.length) lines.push(...prompt.map((line) => `  ${line}`));
  else lines.push('  unavailable');

  const activityLabel = totalActions > liveActions.length
    ? `Activity · last ${liveActions.length} of ${totalActions}` : 'Activity';
  lines.push('', activityLabel);
  if (!liveActions.length) lines.push('· waiting for semantic action events');
  const firstVisibleActionNumber = Math.max(1, totalActions - liveActions.length + 1);
  liveActions.forEach((action, index) => {
    lines.push(`#${firstVisibleActionNumber + index} ${statusIcon(action.status, spinnerFrame)} ${action.kind} · ${action.status}`);
    if (action.summary) lines.push(`  ${action.summary}`);
  });

  const outcome = outcomePreview(latest?.outFile, state.outputs?.[orchestrator.actionId]);
  if (outcome.length) lines.push('', 'Latest checkpoint outcome', ...outcome.map((line) => `  ${line}`));
  lines.push('', 'Artifacts');
  lines.push(`task: ${active?.taskFile ?? latest?.taskFile ?? '—'}`);
  lines.push(`output: ${active?.outFile ?? latest?.outFile ?? '—'}`);
  return wrapLines(lines, width);
}

function orchestratorDetailLinesV2(model, width, spinnerFrame, { verbose = false } = {}) {
  const { orchestrator, state } = model;
  const running = state.attempts.filter((attempt) => attempt.status === 'running');
  const now = orchestrator.active
    ? 'Creating or updating the bounded action program'
    : running.length ? `Waiting for ${running.length} worker${running.length === 1 ? '' : 's'}`
      : stateFinishedAt(state) ? 'Workflow finished' : 'Reviewing requirement gaps';
  const lines = [
    `${statusIcon(orchestrator.active ? 'planning' : orchestrator.status, spinnerFrame)} ${plannerDisplayStatus(model)} · ${orchestrator.pool} · ${orchestrator.model}`,
    '', `Now · ${now}`,
    `Progress · ${state.actions.filter((action) => ['succeeded', 'failed', 'blocked', 'cancelled'].includes(action.status)).length}/${state.actions.length} actions settled · ${orchestrator.attempts.length} planning checkpoint${orchestrator.attempts.length === 1 ? '' : 's'}`,
    `Latest plan · ${state.planner.lastDecision?.summary ?? 'not created yet'}`,
  ];
  const event = orchestrator.active?.lastAgentEvent;
  if (event) lines.push(`Latest action · ${friendlyActionKind(event.kind ?? event.providerType)}${event.summary ? ` · ${friendlyActionSummary(event)}` : ''}`);
  if (!verbose) {
    lines.push('', 'Recent activity');
    for (const attempt of orchestrator.attempts.slice(-3)) lines.push(`#${attempt.turn} ${statusIcon(attempt.status, spinnerFrame)} ${attempt.status} · ${durationText(attempt.startedAt, attempt.finishedAt)}`);
    lines.push('', 'Press v for checkpoint prompts, sessions, usage, and artifact paths.');
    return wrapLines(lines, width);
  }
  lines.push('', `Session · ${state.planner.session?.sessionId ?? 'pending'}${state.planner.session ? ' · resumable' : ''}`);
  for (const attempt of orchestrator.attempts) {
    lines.push(`#${attempt.turn} ${statusIcon(attempt.status, spinnerFrame)} ${attempt.status} · ${attempt.pool ?? '—'} · ${attempt.model ?? '—'} · ${durationText(attempt.startedAt, attempt.finishedAt)}`);
    lines.push(`  task: ${attempt.taskFile ?? '—'}`, `  output: ${attempt.outputFile ?? '—'}`);
  }
  return wrapLines(lines, width);
}

function decisionLabel(decision) {
  return ({
    needs_more_work: 'Continue with bounded work',
    complete: 'Finish and deliver',
    stop: 'Stop with the best useful outcome',
  })[decision] ?? String(decision ?? 'Pending');
}

function sentencePreview(value, maxChars = 420) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  const sentences = text.match(/.*?[.!?](?:\s|$)/g)?.slice(0, 2).map((part) => part.trim()).join(' ') ?? text;
  return truncate(sentences || text, maxChars);
}

function friendlyActionKind(kind) {
  return ({
    read_file: 'Read file',
    write_file: 'Write file',
    response: 'Response',
    tool: 'Tool',
    bash: 'Command',
  })[kind] ?? String(kind ?? 'Action').replaceAll('_', ' ');
}

function friendlyActionSummary(action) {
  const summary = String(action.summary ?? '').replace(/\s+/g, ' ').trim();
  if (action.kind === 'response' && /workflow\.decision|"decision"|needs_more_work/.test(summary)) {
    return 'Planner decision recorded';
  }
  return truncate(summary, 180);
}

function agentDetailLines(model, width, spinnerFrame) {
  const agent = model.selectedAgent;
  if (!agent) {
    const lines = ['No agent selected.', '', 'Planned steps in this phase:'];
    for (const action of model.selectedPhase.actions) {
      const blocked = (model.selectedPhase.blockedActions ?? []).find((entry) => entry.id === action.id);
      lines.push(blocked
        ? `⊘ ${action.id} · ${action.kind} · never dispatched`
        : `${statusIcon(action.status, spinnerFrame)} ${action.id} · ${action.kind} · ${action.status}`);
      if (blocked) {
        lines.push(`  blocked by ${blocked.blockedBy.length ? blocked.blockedBy.join(', ') : 'a failed dependency'}`);
      }
    }
    if (!model.selectedPhase.actions.length) lines.push('· waiting for the orchestrator to add work');
    return wrapLines(lines, width);
  }
  const { action, attempt, active } = agent;
  const liveActions = active?.lastActions ?? attempt?.lastActions ?? [];
  const routing = attempt?.routing;
  const lines = [
    `${statusIcon(agent.status, spinnerFrame)} ${agent.status} · ${agent.model}`,
    `${agent.pool} · attempt ${attempt?.attemptNumber ?? active?.attempt ?? 1} · effort ${attempt?.effort ?? active?.effort ?? 'auto'}`,
    '',
    `Step · ${action.id} · ${action.kind ?? 'run'}`,
  ];
  if (routing?.reason) lines.push(`Route: ${routing.reason}`);
  if (attempt?.startedAt ?? active?.startedAt) lines.push(`Started: ${attempt?.startedAt ?? active.startedAt}`);
  if (attempt?.finishedAt) lines.push(`Finished: ${attempt.finishedAt}`);
  if (active?.lastActivityAt) lines.push(`Last activity: ${active.lastActivityAt} · ${active.outputBytesObserved ?? 0} bytes`);
  if (active?.stall?.status === 'suspected_stalled') {
    lines.push(`⚠ Suspected stalled: ${active.stall.silentForSec}s without evidence; never auto-killed`);
  }
  if (attempt?.failureReason) lines.push(`Failure: ${attempt.failureReason}`);
  const taskFile = attempt?.taskFile ?? active?.taskFile;
  const prompt = taskPreview(taskFile);
  lines.push('', `Prompt${prompt.length ? ` · ${prompt.length} lines shown` : ''}`);
  if (prompt.length) lines.push(...prompt.map((line) => `  ${line}`));
  else lines.push('  unavailable');
  const historicalActionIds = new Set(model.events
    .filter((event) => event.type === 'attempt.agent_action'
      && event.payload?.actionId === action.id
      && (attempt?.attemptNumber == null || event.payload?.attemptNumber === attempt.attemptNumber))
    .map((event) => event.payload?.agentAction?.id)
    .filter(Boolean));
  const totalActions = active?.actionCount ?? attempt?.actionCount
    ?? Math.max(liveActions.length, historicalActionIds.size);
  const activityLabel = totalActions > liveActions.length
    ? `Activity · last ${liveActions.length} of ${totalActions}`
    : 'Activity';
  lines.push('', compactUsage(attempt?.usage), '', activityLabel);
  if (!liveActions.length) lines.push('· waiting for semantic action events');
  const firstVisibleActionNumber = Math.max(1, totalActions - liveActions.length + 1);
  for (const [index, step] of liveActions.entries()) {
    lines.push(`#${firstVisibleActionNumber + index} ${statusIcon(step.status, spinnerFrame)} ${step.kind} · ${step.status}`);
    if (step.summary) lines.push(`  ${step.summary}`);
  }
  const output = model.state.outputs?.[action.id];
  const outcome = outcomePreview(attempt?.outFile ?? active?.outFile ?? output?.outFile, output);
  if (outcome.length) lines.push('', 'Outcome', ...outcome.map((line) => `  ${line}`));
  lines.push('', 'Artifacts:');
  lines.push(`task: ${attempt?.taskFile ?? active?.taskFile ?? '—'}`);
  lines.push(`output: ${attempt?.outFile ?? active?.outFile ?? '—'}`);
  return wrapLines(lines, width);
}

function compactAgentPreviewLines(model, width, spinnerFrame) {
  const agent = model.selectedAgent;
  if (!agent) return [
    `${model.selectedPhase.label} · ${model.selectedPhase.completed}/${model.selectedPhase.total} complete`,
    ...(model.selectedPhase.blockedActions ?? []).map((blocked) =>
      `⊘ ${blocked.id} · never dispatched · blocked by ${blocked.blockedBy.join(', ')}`),
    ...agentDetailLines(model, width, spinnerFrame),
  ];
  const liveActions = agent.active?.lastActions ?? agent.attempt?.lastActions ?? [];
  const lines = [
    `${agent.action.id} · ${agent.pool} · ${agent.model} · #${agent.attempt?.attemptNumber ?? agent.active?.attempt ?? 1} · ${tokenText(agent.attempt?.usage) || 'pending'}`,
    `${statusIcon(agent.status, spinnerFrame)} ${agent.status} · ${agent.model}`,
    `${agent.pool} · attempt ${agent.attempt?.attemptNumber ?? agent.active?.attempt ?? 1}`,
    `Tokens · ${tokenText(agent.attempt?.usage) || 'pending'}`,
    compactUsage(agent.attempt?.usage),
    '',
    'Recent steps',
  ];
  if (!liveActions.length) lines.push('· waiting for semantic action events');
  for (const step of liveActions.slice(-4)) {
    lines.push(`${statusIcon(step.status, spinnerFrame)} ${friendlyActionKind(step.kind)}${step.summary ? ` · ${friendlyActionSummary(step)}` : ''}`);
  }
  return wrapLines(lines, width);
}

function taskPreview(path, limit = 6) {
  if (!path || !existsSync(path)) return [];
  try {
    const all = readFileSync(path, 'utf8').split(/\r?\n/).filter((line) => line.trim());
    const shown = all.slice(0, limit);
    if (all.length > limit) shown.push(`… ${all.length - limit} more lines`);
    return shown;
  } catch {
    return [];
  }
}

function outcomePreview(path, output, maxChars = 64 * 1024) {
  let text = '';
  try {
    if (path && existsSync(path)) text = readFileSync(path, 'utf8');
  } catch { /* fall through to the durable state preview */ }
  if (!text && typeof output?.outputText === 'string') text = output.outputText;
  if (!text && output?.verify) text = JSON.stringify(output.verify, null, 2);
  if (!text.trim()) return [];
  const truncated = text.length > maxChars;
  const lines = text.slice(0, maxChars).split(/\r?\n/);
  if (truncated) lines.push('… outcome truncated in TUI; open the artifact for the complete result');
  return lines;
}

function wrapLines(lines, width) {
  const out = [];
  for (const line of lines) {
    if (!line) { out.push(''); continue; }
    let rest = String(line);
    while (rest.length > width) {
      let split = rest.lastIndexOf(' ', width);
      if (split < Math.floor(width * 0.5)) split = width;
      out.push(rest.slice(0, split));
      rest = rest.slice(split).trimStart();
    }
    out.push(rest);
  }
  return out;
}

// Workflow-level glyph: the qualification comes from the outcome envelope, so
// a `completed` run that recorded concerns still reads as `!`.
function workflowStatusIcon(state, spinnerFrame = 0) {
  const { concernCount, bestEffort, concerned } = outcomeQualification(state);
  if (isDeliveredWorkflowStatus(state?.status) && (concernCount || concerned || bestEffort)) return '!';
  return statusIcon(state?.status, spinnerFrame);
}

function statusIcon(status, spinnerFrame = 0) {
  const value = String(status ?? '').toLowerCase();
  if (value === 'completed' || value.startsWith('succeeded')) return '✓';
  if (value === 'completed_with_concerns') return '!'; // legacy runs
  if (value === 'dependency_blocked') return '⊘';
  if (value.startsWith('failed') || value === 'cancelled' || value === 'interrupted') return '✗';
  if (value === 'running' || value === 'active' || value === 'planning') {
    return SPINNER_FRAMES[Math.abs(Number(spinnerFrame) || 0) % SPINNER_FRAMES.length];
  }
  if (value.includes('waiting') || value === 'queued' || value === 'paused'
    || value === 'blocked' || value === 'starting' || value === 'reviewing evidence'
    || value === 'directing execution') return '⧖';
  if (value === 'skipped') return '–';
  return '○';
}

function durationText(startedAt, finishedAt) {
  const start = Date.parse(startedAt ?? '');
  if (!Number.isFinite(start)) return 'time pending';
  const end = Date.parse(finishedAt ?? '') || Date.now();
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
}

function truncate(value, width) {
  const text = String(value ?? '');
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}

function compactPhaseName(name) {
  const parts = String(name ?? '').split(':');
  return parts.length > 1 ? `↳ ${parts.slice(1).join(':')}` : parts[0];
}

function panelWindow(lines, selectedIndex, itemHeight, height) {
  if (lines.length <= height) return lines;
  const header = lines[0];
  const content = lines.slice(1);
  const room = Math.max(1, height - 1);
  const selectedRow = Math.max(0, selectedIndex * itemHeight);
  const start = clamp(selectedRow - Math.floor(room / 2), 0, Math.max(0, content.length - room));
  return [header, ...content.slice(start, start + room)];
}

function panelCell(value, width) {
  const text = timelineText(value);
  const plain = text.replace(/\x1b\[[0-9;]*m/g, '');
  const clipped = plain.length > width ? truncate(plain, width) : plain;
  const styled = text.includes('\x1b[') && plain.length <= width ? text : clipped;
  return `${styled}${' '.repeat(Math.max(0, width - clipped.length))}`;
}

function selectLine(value, selected, focused, width) {
  const text = truncate(`${selected ? '› ' : '  '}${value}`, width);
  return selected && focused ? `\x1b[7m${text}\x1b[0m` : text;
}

function dimLine(value, width) {
  return `\x1b[2m${truncate(`  ${value}`, width)}\x1b[0m`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

function detailRow(bullswarmDir, token) {
  const resolved = resolveRunId(bullswarmDir, token);
  if (!resolved) throw new Error(`no run found for "${token}"`);
  const statePath = join(resolved.runDir, 'state.json');
  const reportPath = join(resolved.runDir, 'report.json');
  const state = readJsonSafe(statePath);
  const report = readJsonSafe(reportPath);
  return { ...resolved, state, report, events: readEvents(resolved.runDir), status: state?.status };
}

export async function runDashboard(bullswarmDir, {
  input = process.stdin, output = process.stdout, refreshMs = 1000,
  spinnerMs = 400, token = null,
} = {}) {
  if ((!input.isTTY || !output.isTTY) && !token) throw new Error('workflow dashboard requires a TTY, or pass a run ID for a static text tree');
  if ((!input.isTTY || !output.isTTY) && token) {
    const row = detailRow(bullswarmDir, token);
    const details = renderDetails(row, { interactive: false });
    // A non-TTY run-ID inspection must expose the same segmented timeline as
    // the interactive viewer; otherwise real command output cannot evidence
    // the layout that users are being asked to inspect.
    const timeline = renderWorkflowTui(row, {
      width: Math.max(80, Number(output.columns) || 120),
      height: 80,
    });
    const text = `${details}\n\n${timeline}`.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    output.write(`${text}\n`);
    return 0;
  }
  let selected = 0;
  const directRow = token ? detailRow(bullswarmDir, token) : null;
  const directV2 = isV2State(directRow?.state);
  let detail = Boolean(token) && !directV2;
  let message = null;
  let lastGoodRow = null;
  let dashboardFilter = directV2 ? 'all' : 'active';
  let query = '';
  let filterEditing = false;
  let allRows = dashboardRows(bullswarmDir, { all: true });
  let rows = filterDashboardRows(allRows, dashboardFilter, query);
  if (directV2) {
    const directIndex = rows.findIndex((row) => row.runId === directRow.runId);
    if (directIndex >= 0) selected = directIndex;
  }
  let selectedRunId = token ? directRow.runId : (rows[selected]?.runId ?? null);
  let lastPaintedFrame = null;
  const ui = {
    focus: 0,
    phaseIndex: null,
    agentIndex: null,
    detailScroll: 0,
    followActivePhase: true,
    followActiveAgent: true,
    confirmCancel: false,
    controlSelected: false,
    orchestratorDetail: false,
    orchestratorVerbose: false,
    workflowVerbose: false,
    mobileTimeline: true,
    timelinePhaseFocus: false,
    spinnerFrame: 0,
  };
  // Clearing the entire alternate screen for every spinner frame produces a
  // visible blank flash on slower terminals, especially mobile SSH sessions.
  // Enter/clear the alternate screen once, then repaint each row in place.
  // Padding to the terminal height also removes remnants when switching from
  // a taller detail view to a shorter picker view.
  const writeFrame = (text) => {
    const clearPrefix = `${ESC}2J${ESC}H`;
    let source = String(text ?? '').startsWith(clearPrefix)
      ? String(text ?? '').slice(clearPrefix.length)
      : String(text ?? '');
    if (source.startsWith('\n')) source = source.slice(1);
    const height = Math.max(1, Number(output.rows) || source.split('\n').length);
    const lines = source.split('\n').slice(0, height);
    while (lines.length < height) lines.push('');
    const frame = `${ESC}H${lines.map((line) => `${line}${ESC}K`).join('\n')}`;
    if (frame === lastPaintedFrame) return;
    lastPaintedFrame = frame;
    output.write(frame);
  };
  // Several mobile terminals auto-wrap when the final column is painted.
  // Leave one narrow-screen column unused so the right border remains stable.
  const frameWidth = () => {
    const columns = Math.max(20, Number(output.columns) || 120);
    return columns < 100 ? Math.max(20, columns - 1) : columns;
  };
  const paintUnsafe = () => {
    if (selected >= rows.length) selected = Math.max(0, rows.length - 1);
    if (detail && selectedRunId) {
      // A torn read while the runner writes state.json yields state:null for
      // one frame — keep painting the last good snapshot of the same run.
      const fresh = detailRow(bullswarmDir, selectedRunId);
      const row = (fresh.state || lastGoodRow?.runId !== fresh.runId) ? fresh : lastGoodRow;
      if (row === fresh) lastGoodRow = fresh;
      const model = workflowPanelModel(row, {
        phaseIndex: ui.followActivePhase ? null : ui.phaseIndex,
        agentIndex: ui.followActiveAgent ? null : ui.agentIndex,
      });
      ui.phaseIndex = model.phaseIndex;
      ui.agentIndex = model.agentIndex;
      writeFrame(renderWorkflowTui(row, {
        width: frameWidth(),
        height: output.rows,
        ...ui,
        message,
      }));
      return;
    }
    let previewRow = null;
    if (selectedRunId) {
      const fresh = detailRow(bullswarmDir, selectedRunId);
      previewRow = (fresh.state || lastGoodRow?.runId !== fresh.runId) ? fresh : lastGoodRow;
      if (previewRow === fresh) lastGoodRow = fresh;
      const selectedListRow = rows[selected];
      if (previewRow && selectedListRow) previewRow.ongoing = selectedListRow.ongoing;
    }
    writeFrame(renderDashboard({
      rows,
      allRows,
      selected,
      message,
      width: frameWidth(),
      height: output.rows,
      filter: dashboardFilter,
      query,
      filterEditing,
      spinnerFrame: ui.spinnerFrame,
      previewRow,
    }));
  };
  // A render error must never kill the TUI or strand the terminal in
  // alt-screen raw mode (crash observed 2026-08-29 at detailRow via the
  // repaint timer). Show the error in the message line and keep running.
  const paint = () => {
    try { paintUnsafe(); } catch (err) {
      message = `display error: ${err.message}`;
      try {
        writeFrame(renderDashboard({
          rows, allRows, selected, message, width: frameWidth(), height: output.rows,
          filter: dashboardFilter, query, filterEditing, spinnerFrame: ui.spinnerFrame,
        }));
      } catch { /* keep the loop alive */ }
    }
  };
  const refresh = () => {
    try {
      const previousRunId = selectedRunId;
      allRows = dashboardRows(bullswarmDir, { all: true });
      rows = filterDashboardRows(allRows, dashboardFilter, query);
      const preserved = rows.findIndex((row) => row.runId === previousRunId);
      if (preserved >= 0) selected = preserved;
      else selected = clamp(selected, 0, Math.max(0, rows.length - 1));
    } catch (err) { message = `display error: ${err.message}`; }
    selectedRunId = rows[selected]?.runId ?? null;
    paint();
  };
  const switchWorkflow = (delta) => {
    const catalog = allRows;
    if (!catalog.length) return paint();
    const previousFocus = ui.focus;
    const previousPhaseIndex = ui.phaseIndex;
    const currentIndex = Math.max(0, catalog.findIndex((row) => row.runId === selectedRunId));
    const nextIndex = (currentIndex + delta + catalog.length) % catalog.length;
    const next = catalog[nextIndex];
    if (!next) return paint();
    selectedRunId = next.runId;
    let visibleIndex = rows.findIndex((row) => row.runId === next.runId);
    if (visibleIndex < 0 && dashboardFilter === 'active') {
      dashboardFilter = 'all';
      rows = filterDashboardRows(allRows, dashboardFilter, query);
      visibleIndex = rows.findIndex((row) => row.runId === next.runId);
    }
    if (visibleIndex >= 0) selected = visibleIndex;
    if (detail) {
      const nextRow = detailRow(bullswarmDir, next.runId);
      const nextModel = workflowPanelModel(nextRow, {
        phaseIndex: previousPhaseIndex,
        agentIndex: ui.agentIndex,
      });
      ui.followActivePhase = false;
      ui.followActiveAgent = false;
      const phaseExists = previousPhaseIndex == null || previousPhaseIndex < nextModel.phases.length;
      if (previousFocus > 0 && !phaseExists) {
        ui.focus = 0;
        ui.phaseIndex = nextModel.phaseIndex;
        ui.agentIndex = nextModel.agentIndex;
        ui.detailScroll = 0;
        message = null;
        return paint();
      }
      ui.phaseIndex = previousFocus === 0 ? nextModel.phaseIndex
        : clamp(previousPhaseIndex ?? nextModel.phaseIndex, 0, nextModel.phases.length - 1);
      const agents = workflowPanelModel(nextRow, { phaseIndex: ui.phaseIndex }).agents;
      ui.agentIndex = ui.focus < 2 ? nextModel.agentIndex
        : clamp(ui.agentIndex ?? nextModel.agentIndex, 0, Math.max(0, agents.length - 1));
      ui.detailScroll = 0;
      ui.timelinePhaseFocus = false;
    }
    message = null;
    paint();
  };
  input.setRawMode?.(true);
  input.resume();
  output.write(`${ESC}?1049h${ESC}?25l${ESC}2J${ESC}H`);
  paint();
  const timer = setInterval(refresh, refreshMs);
  const spinnerTimer = setInterval(() => {
    ui.spinnerFrame = (ui.spinnerFrame + 1) % SPINNER_FRAMES.length;
    if (detail || rows[selected]?.ongoing) paint();
  }, Math.max(50, Number(spinnerMs) || 400));
  return new Promise((resolve) => {
    const finish = () => {
      clearInterval(timer);
      clearInterval(spinnerTimer);
      input.setRawMode?.(false);
      input.pause();
      input.removeListener('data', onData);
      output.removeListener?.('resize', onResize);
      output.write(`${ESC}?25h${ESC}?1049l`);
      resolve(0);
    };
    const moveVertical = (delta) => {
      if (!detail || !selectedRunId) {
        selected = clamp(selected + delta, 0, Math.max(0, rows.length - 1));
        selectedRunId = rows[selected]?.runId ?? selectedRunId;
        return paint();
      }
      const row = detailRow(bullswarmDir, selectedRunId);
      const model = workflowPanelModel(row, { phaseIndex: ui.phaseIndex, agentIndex: ui.agentIndex });
      const narrowTimeline = output.columns < 100 && ui.mobileTimeline && ui.focus === 0;
      if (ui.orchestratorDetail || ui.workflowVerbose || narrowTimeline) {
        if (narrowTimeline) {
          const visibleSegments = new Set(workflowTimelineLines(model, Math.max(20, frameWidth() - 2)).lines
            .filter((line) => line?.header)
            .map((line) => line.segment));
          const navigable = model.phases
            .map((phase, index) => ({ phase, index }))
            .filter(({ phase }) => visibleSegments.has(phase.label))
            .map(({ index }) => index);
          if (navigable.length) {
            const current = navigable.indexOf(model.phaseIndex);
            const base = current >= 0 ? current : (delta < 0 ? navigable.length : -1);
            ui.followActivePhase = false;
            ui.phaseIndex = navigable[clamp(base + delta, 0, navigable.length - 1)];
            ui.agentIndex = null;
            ui.followActiveAgent = true;
            ui.timelinePhaseFocus = true;
            ui.detailScroll = 0;
          }
        } else ui.detailScroll = Math.max(0, ui.detailScroll + delta);
        return paint();
      }
      if (ui.focus === 0) {
        if (model.orchestrator.autonomous && ui.controlSelected) {
          if (delta > 0) {
            ui.controlSelected = false;
            ui.followActivePhase = false;
            ui.phaseIndex = 0;
          }
          return paint();
        }
        if (model.orchestrator.autonomous && delta < 0 && model.phaseIndex === 0) {
          ui.controlSelected = true;
          ui.detailScroll = 0;
          return paint();
        }
        ui.followActivePhase = false;
        ui.phaseIndex = clamp(model.phaseIndex + delta, 0, model.phases.length - 1);
        ui.agentIndex = null;
        ui.followActiveAgent = true;
        ui.detailScroll = 0;
      } else if (ui.focus === 1) {
        ui.followActiveAgent = false;
        ui.agentIndex = clamp(model.agentIndex + delta, 0, Math.max(0, model.agents.length - 1));
        ui.detailScroll = 0;
      } else {
        ui.detailScroll = Math.max(0, ui.detailScroll + delta);
      }
      paint();
    };
    const requestSelectedCancel = () => {
      const target = detail ? selectedRunId : rows[selected]?.runId;
      if (!target) { message = 'No workflow selected.'; return paint(); }
      try {
        const result = requestCancel(bullswarmDir, target, { source: 'interactive-tui' });
        message = result.alreadyFinished
          ? 'That workflow has already finished.'
          : `Stop requested for ${result.shortId ?? result.runId}.`;
        ui.confirmCancel = false;
        refresh();
      } catch (err) { message = err.message; ui.confirmCancel = false; paint(); }
    };
    const onDataUnsafe = (buf) => {
      const key = String(buf);
      if (filterEditing) {
        if (key === '\r' || key === '\n') {
          filterEditing = false;
          message = query ? `Showing workflows matching “${query}”.` : null;
          return refresh();
        }
        if (key === '\u001b' || key === '\u0003') {
          filterEditing = false;
          query = '';
          message = null;
          return refresh();
        }
        if (key === '\u007f' || key === '\b') {
          query = query.slice(0, -1);
          return refresh();
        }
        if (/^[ -~]+$/.test(key)) {
          query += key;
          return refresh();
        }
        return;
      }
      if (ui.confirmCancel) {
        if (key === 'y' || key === 'Y') return requestSelectedCancel();
        if (key === 'n' || key === 'N' || key === '\u001b' || key === '\u0003') {
          ui.confirmCancel = false;
          message = 'Workflow left running.';
          return paint();
        }
        return;
      }
      if (keyPressed('detach', key)) return finish();
      if (key === 'r') { message = null; return refresh(); }
      if (!detail && key === '/') {
        filterEditing = true;
        message = null;
        return paint();
      }
      if (!detail && key === 'a') {
        dashboardFilter = dashboardFilter === 'active' ? 'all' : 'active';
        message = dashboardFilter === 'active' ? 'Showing active workflows.' : 'Showing active and recent workflows.';
        return refresh();
      }
      if (keyPressed('out', key)) {
        if (!detail) return finish();
        if (ui.orchestratorDetail) {
          ui.orchestratorDetail = false;
          ui.orchestratorVerbose = false;
          ui.focus = 0;
          ui.controlSelected = true;
          ui.detailScroll = 0;
        } else if (ui.workflowVerbose) {
          ui.workflowVerbose = false;
          ui.detailScroll = 0;
        } else if (detail && ui.focus > 0) {
          ui.focus -= 1;
          if (ui.focus === 0 && output.columns < 100 && ui.mobileTimeline) ui.timelinePhaseFocus = true;
        }
        else if (detail) detail = false;
        return paint();
      }
      if (keyPressed('nextWorkflow', key)) return switchWorkflow(1);
      if (keyPressed('previousWorkflow', key)) return switchWorkflow(-1);
      if (keyPressed('in', key)) {
        if (!detail) {
          selectedRunId = rows[selected]?.runId ?? selectedRunId;
          if (selectedRunId) {
            detail = true;
            ui.followActivePhase = true;
            ui.followActiveAgent = true;
            ui.timelinePhaseFocus = false;
          }
        } else if (ui.orchestratorDetail) {
          message = 'Planner detail is the deepest level.';
        } else if (ui.workflowVerbose) {
          message = 'Technical details are the deepest level.';
        } else if (ui.focus === 0) {
          ui.focus = 1;
          ui.followActiveAgent = true;
        } else if (ui.focus === 1) {
          const row = detailRow(bullswarmDir, selectedRunId);
          if (workflowPanelModel(row, { phaseIndex: ui.phaseIndex }).agents.length) ui.focus = 2;
          else message = 'No agent has started in this phase yet.';
        }
        ui.detailScroll = 0;
        return paint();
      }
      if (key === '\u001b[D' || key === 'h') {
        if (ui.orchestratorDetail) {
          ui.orchestratorDetail = false;
          ui.orchestratorVerbose = false;
          ui.focus = 0;
        } else if (ui.workflowVerbose) {
          ui.workflowVerbose = false;
        } else if (detail && ui.focus > 0) {
          ui.focus -= 1;
          if (ui.focus === 0 && output.columns < 100 && ui.mobileTimeline) ui.timelinePhaseFocus = true;
        } else if (detail) {
          detail = false;
        }
        ui.detailScroll = 0;
        return paint();
      }
      if (keyPressed('up', key)) return moveVertical(-1);
      if (keyPressed('down', key)) return moveVertical(1);
      const timelineScroll = detail && ui.focus === 0 && !ui.orchestratorDetail && !ui.workflowVerbose;
      if (key === '\u001b[5~') { if (timelineScroll) ui.timelinePhaseFocus = false; ui.detailScroll = timelineScroll ? ui.detailScroll + 8 : Math.max(0, ui.detailScroll - 8); return paint(); }
      if (key === '\u001b[6~') { if (timelineScroll) ui.timelinePhaseFocus = false; ui.detailScroll = timelineScroll ? Math.max(0, ui.detailScroll - 8) : ui.detailScroll + 8; return paint(); }
      if (key === 'o' && detail) {
        const row = detailRow(bullswarmDir, selectedRunId);
        const model = workflowPanelModel(row, { phaseIndex: ui.phaseIndex, agentIndex: ui.agentIndex });
        if (model.orchestrator.autonomous) {
          ui.workflowVerbose = false;
          ui.orchestratorDetail = true;
          ui.orchestratorVerbose = false;
          ui.controlSelected = true;
          ui.detailScroll = 0;
          message = null;
        } else message = 'This workflow has no autonomous orchestrator thread.';
        return paint();
      }
      if (key === 't' && detail && output.columns < 100 && !ui.orchestratorDetail && !ui.workflowVerbose) {
        ui.mobileTimeline = !ui.mobileTimeline;
        ui.timelinePhaseFocus = ui.mobileTimeline;
        ui.focus = 0;
        ui.controlSelected = false;
        ui.detailScroll = 0;
        message = null;
        return paint();
      }
      if (key === '1' && detail) { ui.focus = 0; return paint(); }
      if (key === '2' && detail) { ui.focus = 1; return paint(); }
      if (key === '3' && detail) { ui.focus = 2; return paint(); }
      if (key === 'v' && detail) {
        if (ui.orchestratorDetail) ui.orchestratorVerbose = !ui.orchestratorVerbose;
        else ui.workflowVerbose = !ui.workflowVerbose;
        ui.detailScroll = 0;
        message = null;
        return paint();
      }
      if (key === '\r' || key === '\n') {
        if (!detail) {
          selectedRunId = rows[selected]?.runId ?? selectedRunId;
          if (!selectedRunId) {
            message = dashboardFilter === 'active'
              ? 'No active workflow selected · press a to browse recent runs.'
              : 'No workflow selected.';
            return paint();
          }
          detail = true;
          ui.followActivePhase = true;
          ui.followActiveAgent = true;
        } else if (ui.focus === 0) {
          if (ui.controlSelected) {
            ui.workflowVerbose = false;
            ui.orchestratorDetail = true;
            ui.orchestratorVerbose = false;
            ui.detailScroll = 0;
          } else ui.focus = 1;
        } else if (ui.focus === 1) {
          const row = detailRow(bullswarmDir, selectedRunId);
          const model = workflowPanelModel(row, { phaseIndex: ui.phaseIndex, agentIndex: ui.agentIndex });
          if (model.agents.length) ui.focus = 2;
          else message = 'No agent has started in this phase yet.';
        }
        return paint();
      }
      if (key === 'c') {
        ui.confirmCancel = true;
        message = null;
        return paint();
      }
    };
    const onData = (buf) => {
      // A key-handler error (e.g. a drill-in racing the writer) must never
      // kill the TUI; finish() still restores the terminal on q/Ctrl-C.
      try { onDataUnsafe(buf); } catch (err) {
        message = `display error: ${err.message}`;
        paint();
      }
    };
    const onResize = () => paint();
    input.on('data', onData);
    output.on?.('resize', onResize);
  });
}

export function dashboardJson(bullswarmDir, { all = false, token = null, cancel = false } = {}) {
  if (cancel) {
    const result = requestCancel(bullswarmDir, token, { source: 'cli' });
    return { action: 'cancel', ...result };
  }
  if (token) {
    const resolved = resolveRunId(bullswarmDir, token);
    if (!resolved) throw new Error(`no run found for "${token}"`);
    const statePath = join(resolved.runDir, 'state.json');
    const reportPath = join(resolved.runDir, 'report.json');
    const state = readJsonSafe(statePath);
    const report = readJsonSafe(reportPath);
    const events = readEvents(resolved.runDir);
    return { action: 'show', ...resolved, state, report, events };
  }
  const runs = all ? listRuns(bullswarmDir) : dashboardRows(bullswarmDir);
  return { action: 'list', count: runs.length, runs };
}

export function actionJson(bullswarmDir, token, actionId) {
  const resolved = resolveRunId(bullswarmDir, token);
  if (!resolved) throw new Error(`no run found for "${token}"`);
  const statePath = join(resolved.runDir, 'state.json');
  const state = readJsonSafe(statePath);
  const action = state?.actionLedger?.find((entry) => entry.id === actionId);
  if (!action) throw new Error(`run "${token}" has no action "${actionId}"`);
  const attempts = (action.attempts ?? []).map((index) => state.attempts?.[index]).filter(Boolean);
  const events = readEvents(resolved.runDir).filter((event) =>
    event.payload?.actionId === actionId || event.payload?.parentId === actionId);
  return { action: 'show-action', ...resolved, actionRecord: action, attempts, output: state.outputs?.[actionId] ?? null, events };
}

export function decideApproval(bullswarmDir, token, decision) {
  if (!['approve', 'reject'].includes(decision)) throw new Error('approval decision must be approve or reject');
  const resolved = resolveRunId(bullswarmDir, token);
  if (!resolved) throw new Error(`no run found for "${token}"`);
  const statePath = join(resolved.runDir, 'state.json');
  const state = readJsonForUpdate(statePath, 'workflow state');
  if (state.status !== 'waiting_for_approval' || !state.approval) {
    throw new Error(`run "${token}" is not waiting for approval`);
  }
  const at = new Date().toISOString();
  state.approval = {
    ...state.approval,
    status: decision === 'approve' ? 'approved' : 'rejected',
    decidedAt: at,
  };
  if (decision === 'approve') {
    state.status = 'paused';
    state.stage = 'approval_granted';
  } else {
    state.status = 'cancelled';
    state.stage = 'cancelled';
    state.finishedAt = at;
    state.cancelledAt = at;
  }
  appendEvent(resolved.runDir, state, decision === 'approve' ? 'approval.granted' : 'approval.rejected', {
    gateId: state.approval.gateId,
    decidedAt: at,
  });
  writeJsonAtomic(statePath, state);
  return { ...resolved, decision, state };
}
