// Interactive workflow dashboard, inspired by Claude Code's /workflows view.
// It deliberately uses only ANSI sequences and Node's standard streams.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fanoutSucceededCount } from './runner.js';
import { join } from 'node:path';
import { listRuns, resolveRunId } from './short-id.js';
import { appendEvent, readEvents } from './events.js';
import { isTerminalWorkflowStatus } from './status.js';

const ESC = '\x1b[';

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

export function requestCancel(bullswarmDir, token) {
  const resolved = resolveRunId(bullswarmDir, token);
  if (!resolved) throw new Error(`no run found for "${token}"`);
  const statePath = join(resolved.runDir, 'state.json');
  if (!existsSync(statePath)) throw new Error(`run "${token}" has no state.json`);
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  if (state.finishedAt || isTerminalWorkflowStatus(state.status)) {
    return { ...resolved, state, alreadyFinished: true };
  }
  state.cancelRequested = true;
  state.cancelRequestedAt = new Date().toISOString();
  state.status = 'cancelling';
  state.cancellingAt = state.cancelRequestedAt;
  appendEvent(resolved.runDir, state, 'run.cancellation_requested', { requestedAt: state.cancelRequestedAt });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  return { ...resolved, state, alreadyFinished: false };
}

export function dashboardRows(bullswarmDir) {
  return listRuns(bullswarmDir)
    .filter((r) => r.ongoing)
    .sort((a, b) => String(b.state?.startedAt ?? '').localeCompare(String(a.state?.startedAt ?? '')))
    .map((r) => {
      const state = r.state ?? {};
      const steps = state.steps ?? [];
      const fanout = Object.values(state.outputs ?? {}).filter((v) => v?.items).reduce((acc, v) => ({
        total: acc.total + (v.total ?? 0), ok: acc.ok + fanoutSucceededCount(v), failed: acc.failed + (v.failed ?? 0),
      }), { total: 0, ok: 0, failed: 0 });
      return {
        ...r,
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

export function renderDashboard({ rows, selected = 0, message = null } = {}) {
  const out = [`${ESC}2J${ESC}H`, ' bullswarm · workflows', ''];
  if (!rows?.length) {
    out.push(' No ongoing workflows.', '', ' Press r to refresh · q to quit');
    return out.join('\n');
  }
  out.push(' Select a run with j/k or arrows · Enter details · c stop · r refresh · q quit', '');
  out.push('    ID       WORKFLOW                 STATUS     PHASE                 PROGRESS');
  out.push('    ' + '-'.repeat(82));
  rows.forEach((r, i) => {
    const mark = i === selected ? '>' : ' ';
    const progress = `${r.stepsOk}/${r.stepsTotal} steps` + (r.fanout.total ? ` · ${r.fanout.ok}/${r.fanout.total} items` : '');
    out.push(`${mark}   ${(r.shortId ?? '------').padEnd(8)} ${(r.state?.workflow ?? '?').slice(0, 24).padEnd(24)} ${(r.status ?? 'running').padEnd(10)} ${(r.phase ?? 'starting').slice(0, 20).padEnd(20)} ${progress}`);
  });
  if (message) out.push('', ` ${message}`);
  out.push('', ' Press Enter for details · q to quit');
  return out.join('\n');
}

export function renderDetails(row, { interactive = true } = {}) {
  const state = row?.state ?? {};
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
  if (interactive) lines.push('', ' Press b to go back · c to stop · r to refresh · q to quit');
  return lines.join('\n');
}

const TERMINAL_ACTIONS = new Set([
  'succeeded', 'failed', 'failed_retryable', 'failed_terminal', 'skipped', 'cancelled',
]);
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function autonomousControlPlane(state) {
  const autonomous = state.intent?.autonomous === true || state.orchestration?.mode === 'autonomous';
  if (!autonomous) return { autonomous: false, actionId: null, attempts: [], active: null };
  const actionId = state.decisions?.find((decision) => decision.gateId)?.gateId ?? 'orchestrator';
  const attempts = (state.attempts ?? []).filter((attempt) => attempt.actionId === actionId);
  const active = Object.values(state.activeAgents ?? {}).find((agent) => agent.stepId === actionId) ?? null;
  const latestAttempt = attempts.at(-1) ?? null;
  const terminal = Boolean(state.finishedAt);
  const workerActive = Object.values(state.activeAgents ?? {}).some((agent) => agent.stepId !== actionId);
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
  const output = state.outputs?.[action.id];
  if (output?.ok === false) return 'failed_terminal';
  if (output?.ok === true && action.status === 'succeeded') return 'succeeded';
  return action.status ?? 'pending';
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
  const ledger = state.actionLedger ?? [];
  const orchestrator = autonomousControlPlane(state);
  const isControlAction = (action) => orchestrator.autonomous
    && action.id === orchestrator.actionId
    && action.kind === 'decide';
  const phaseNames = [];
  const addPhase = (name) => {
    if (name && !phaseNames.includes(name)) phaseNames.push(name);
  };
  for (const phase of state._doc?.phases ?? []) {
    const controlOnly = orchestrator.autonomous
      && (phase.steps ?? []).length
      && (phase.steps ?? []).every((step) => step.id === orchestrator.actionId && step.type === 'decide');
    if (!controlOnly) addPhase(phase.name);
  }
  for (const action of ledger) if (!isControlAction(action)) addPhase(action.phase);
  for (const step of state.steps ?? []) if (step.stepId !== orchestrator.actionId) addPhase(step.phase);
  if (state.currentStep?.id !== orchestrator.actionId) addPhase(state.currentStep?.phase);
  if (!orchestrator.autonomous) addPhase(state.currentPhase?.name);
  if (!phaseNames.length) phaseNames.push(orchestrator.autonomous ? 'execution' : 'starting');

  const activePhaseName = state.currentStep?.phase ?? state.currentPhase?.name;
  const currentPhaseIndex = Math.max(0, phaseNames.indexOf(activePhaseName));
  const selectedPhaseIndex = clamp(
    phaseIndex == null ? currentPhaseIndex : phaseIndex,
    0,
    phaseNames.length - 1,
  );
  const phases = phaseNames.map((name) => {
    const actions = ledger.filter((action) => action.phase === name && !isControlAction(action));
    const effectiveStatuses = actions.map((action) => effectiveActionStatus(action, state));
    const completed = effectiveStatuses.filter((status) => TERMINAL_ACTIONS.has(status)).length;
    const failed = effectiveStatuses.filter((status) => String(status).startsWith('failed')).length;
    const current = name === activePhaseName && !state.finishedAt;
    const active = effectiveStatuses.some((status) => status === 'running');
    const status = failed ? 'failed'
      : actions.length && completed === actions.length ? 'completed'
        : active ? 'active' : current ? 'waiting' : 'pending';
    return { name, label: phaseLabel(name, orchestrator), status, actions, completed, total: actions.length };
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

export function renderWorkflowTui(row, {
  width = 120, height = 36, focus = 0, phaseIndex = null, agentIndex = null,
  detailScroll = 0, message = null, confirmCancel = false,
  controlSelected = false, orchestratorDetail = false, orchestratorVerbose = false,
  spinnerFrame = 0,
} = {}) {
  width = Math.max(38, Number(width) || 120);
  height = Math.max(18, Number(height) || 36);
  const model = workflowPanelModel(row, { phaseIndex, agentIndex });
  const state = model.state;
  const status = row?.status ?? state.status ?? 'starting';
  const elapsed = durationText(state.startedAt, state.finishedAt);
  const phaseComplete = model.selectedPhase.completed;
  const phaseTotal = model.selectedPhase.total;
  const attempts = state.attempts ?? [];
  const workerAttempts = attempts.filter((attempt) => attempt.actionId !== model.orchestrator.actionId);
  const finishedAgents = workerAttempts.filter((attempt) => TERMINAL_ACTIONS.has(attempt.status)).length;
  const agentProgress = workerAttempts.length ? `${finishedAgents}/${workerAttempts.length} workers · ` : '';
  const terminalLabel = state.finishedAt ? ` · ${status === 'completed' ? 'done' : status}` : '';
  const runName = state.workflow ?? row?.shortId ?? state.shortId ?? row?.runId ?? 'workflow';
  const header = [
    ` ${truncate(runName, Math.max(1, width - agentProgress.length - elapsed.length - terminalLabel.length - 5))} · ${agentProgress}${elapsed}${terminalLabel}`,
    ` ${truncate(state.intent?.goal ?? state.workflow ?? 'workflow', width - 2)}`,
  ];
  const footer = confirmCancel
    ? ' Stop this workflow? y confirm · n/Esc keep running'
    : orchestratorDetail
      ? ` ↑/↓ scroll · v ${orchestratorVerbose ? 'overview' : 'technical details'} · Esc back · c stop · q detach`
      : ` ↑/↓ select · Enter drill in · Esc back · o orchestrator · c stop · q detach`;
  const rawMessageLine = message
    ? ` ${truncate(message, width - 2)}`
    : ` ${orchestratorDetail ? `Orchestrator ${orchestratorVerbose ? 'technical details' : 'overview'}` : focus === 0 ? 'Phases' : focus === 1 ? 'Agents' : 'Agent activity'} · r refresh · workflow continues after detach`;
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
  if (!model.agents.length) agentLines.push(dimLine('Not started yet', width));
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

  // Two information-rich panes become counterproductive on typical 80-column
  // SSH/mobile terminals. Keep the drill-down full-width below 100 columns.
  const narrow = width < 100;
  const leftWidth = narrow ? width : Math.max(24, Math.min(34, Math.floor(width * 0.27)));
  const rightWidth = narrow ? width : width - leftWidth;
  const orchestrationLines = orchestratorDetailLines(
    model,
    Math.max(20, (orchestratorDetail ? width : rightWidth) - 4),
    spinnerFrame,
    { verbose: orchestratorVerbose },
  );
  const detail = orchestratorDetail
    ? orchestrationLines
    : agentDetailLines(model, Math.max(20, rightWidth - 4), spinnerFrame);
  const contentHeight = bodyHeight - 2;
  const maxScroll = Math.max(0, detail.length - contentHeight);
  const scroll = clamp(detailScroll, 0, maxScroll);
  const visiblePhases = panelWindow(['', ...phaseLines], model.phaseIndex, 1, contentHeight).slice(1);
  const visibleAgents = panelWindow(['', ...agentLines], model.agentIndex, 1, contentHeight).slice(1);
  const visibleDetail = detail.slice(scroll, scroll + contentHeight);
  const phaseTitle = `Phases · ${model.phases.length}`;
  const orchestrationNavLines = model.orchestrator.autonomous
    ? [
      selectLine(
        `${statusIcon(model.orchestrator.active ? 'running' : model.orchestrator.status, spinnerFrame)} Orchestration · ${model.orchestrator.status}`,
        controlSelected,
        focus === 0 && !orchestratorDetail,
        leftWidth - 2,
      ),
      dimLine(
        [model.orchestrator.pool, model.orchestrator.model].filter(Boolean).join(' · ') || 'select to inspect',
        leftWidth - 2,
      ),
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
  if (orchestratorDetail) {
    body = renderPanel(`Orchestrator · ${orchestratorVerbose ? 'technical details' : 'overview'}`, visibleDetail, width, bodyHeight);
  } else if (narrow) {
    const mobile = focus === 0
      ? {
        title: model.orchestrator.autonomous
          ? `Workflow · ${model.phases.length} phase${model.phases.length === 1 ? '' : 's'}`
          : phaseTitle,
        lines: narrowWorkflowLines,
      }
      : focus === 1
        ? { title: agentTitle, lines: visibleAgents }
        : { title: detailTitle, lines: visibleDetail };
    body = renderPanel(mobile.title, mobile.lines, width, bodyHeight);
  } else if (focus < 2) {
    const left = model.orchestrator.autonomous
      ? [
        ...renderPanel('Orchestrator', orchestrationNavLines, leftWidth, 5),
        ...renderPanel(phaseTitle, visiblePhases, leftWidth, bodyHeight - 5),
      ]
      : renderPanel(phaseTitle, visiblePhases, leftWidth, bodyHeight);
    body = joinPanels(
      left,
      controlSelected
        ? renderPanel(`Orchestration · ${model.orchestrator.status}`, orchestrationLines.slice(0, contentHeight), rightWidth, bodyHeight)
        : renderPanel(agentTitle, visibleAgents, rightWidth, bodyHeight),
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

function orchestratorDetailLines(model, width, spinnerFrame, { verbose = false } = {}) {
  const { orchestrator, state } = model;
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
  const workerAttempts = (state.attempts ?? []).filter((attempt) => attempt.actionId !== orchestrator.actionId);
  const completedWorkers = workerAttempts.filter((attempt) => TERMINAL_ACTIONS.has(attempt.status)).length;
  const activeWorkers = Object.values(state.activeAgents ?? {})
    .filter((agent) => agent.stepId !== orchestrator.actionId);
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
      const verified = state.outcome?.verified === true;
      lines.push('', `Result · ${verified ? 'Verified delivery is ready' : state.status === 'completed_with_concerns' ? 'Best useful delivery is ready with concerns' : state.status === 'blocked' ? 'No useful delivery could be completed' : 'Workflow is terminal'}`);
      const concernCount = state.outcome?.concerns?.length ?? 0;
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
    const decision = (state.decisions ?? [])[index];
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
      lines.push(`${statusIcon(action.status, spinnerFrame)} ${action.id} · ${action.kind} · ${action.status}`);
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

function statusIcon(status, spinnerFrame = 0) {
  const value = String(status ?? '').toLowerCase();
  if (value === 'completed' || value.startsWith('succeeded')) return '✓';
  if (value === 'completed_with_concerns') return '!';
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
  const text = String(value ?? '');
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
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null;
  const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : null;
  return { ...resolved, state, report, events: readEvents(resolved.runDir), status: state?.status };
}

export async function runDashboard(bullswarmDir, {
  input = process.stdin, output = process.stdout, refreshMs = 1000, token = null,
} = {}) {
  if ((!input.isTTY || !output.isTTY) && !token) throw new Error('workflow dashboard requires a TTY, or pass a run ID for a static text tree');
  if ((!input.isTTY || !output.isTTY) && token) {
    const text = renderDetails(detailRow(bullswarmDir, token), { interactive: false }).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    output.write(`${text}\n`);
    return 0;
  }
  let selected = 0;
  let detail = Boolean(token);
  let message = null;
  let rows = dashboardRows(bullswarmDir);
  let selectedRunId = token ? detailRow(bullswarmDir, token).runId : (rows[selected]?.runId ?? null);
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
    spinnerFrame: 0,
  };
  const paint = () => {
    if (selected >= rows.length) selected = Math.max(0, rows.length - 1);
    if (detail && selectedRunId) {
      const row = detailRow(bullswarmDir, selectedRunId);
      const model = workflowPanelModel(row, {
        phaseIndex: ui.followActivePhase ? null : ui.phaseIndex,
        agentIndex: ui.followActiveAgent ? null : ui.agentIndex,
      });
      ui.phaseIndex = model.phaseIndex;
      ui.agentIndex = model.agentIndex;
      output.write(renderWorkflowTui(row, {
        width: output.columns,
        height: output.rows,
        ...ui,
        message,
      }));
      return;
    }
    output.write(renderDashboard({ rows, selected, message }));
  };
  const refresh = () => {
    rows = dashboardRows(bullswarmDir);
    if (!selectedRunId) selectedRunId = rows[selected]?.runId ?? null;
    paint();
  };
  input.setRawMode?.(true);
  input.resume();
  output.write(`${ESC}?1049h${ESC}?25l`);
  paint();
  const timer = setInterval(refresh, refreshMs);
  const spinnerTimer = setInterval(() => {
    ui.spinnerFrame = (ui.spinnerFrame + 1) % SPINNER_FRAMES.length;
    if (detail) paint();
  }, 160);
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
      if (ui.orchestratorDetail) {
        ui.detailScroll = Math.max(0, ui.detailScroll + delta);
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
        const result = requestCancel(bullswarmDir, target);
        message = result.alreadyFinished
          ? 'That workflow has already finished.'
          : `Stop requested for ${result.shortId ?? result.runId}.`;
        ui.confirmCancel = false;
        refresh();
      } catch (err) { message = err.message; ui.confirmCancel = false; paint(); }
    };
    const onData = (buf) => {
      const key = String(buf);
      if (ui.confirmCancel) {
        if (key === 'y' || key === 'Y') return requestSelectedCancel();
        if (key === 'n' || key === 'N' || key === '\u001b' || key === '\u0003') {
          ui.confirmCancel = false;
          message = 'Workflow left running.';
          return paint();
        }
        return;
      }
      if (key === 'q' || key === '\u0003') return finish();
      if (key === 'r') { message = null; return refresh(); }
      if (key === '\u001b' || key === 'b') {
        if (ui.orchestratorDetail) {
          ui.orchestratorDetail = false;
          ui.orchestratorVerbose = false;
          ui.focus = 0;
          ui.controlSelected = true;
          ui.detailScroll = 0;
        } else if (detail && ui.focus > 0) ui.focus -= 1;
        else if (detail && !token) detail = false;
        else message = 'At phase level · press q to detach while the workflow keeps running.';
        return paint();
      }
      if (key === '\t' || key === '\u001b[C' || key === 'l') {
        if (detail) ui.focus = (ui.focus + 1) % 3;
        return paint();
      }
      if (key === '\u001b[D' || key === 'h') {
        if (detail) ui.focus = (ui.focus + 2) % 3;
        return paint();
      }
      if (key === '\u001b[A' || key === 'k') return moveVertical(-1);
      if (key === '\u001b[B' || key === 'j') return moveVertical(1);
      if (key === '\u001b[5~') { ui.detailScroll = Math.max(0, ui.detailScroll - 8); return paint(); }
      if (key === '\u001b[6~') { ui.detailScroll += 8; return paint(); }
      if (key === 'o' && detail) {
        const row = detailRow(bullswarmDir, selectedRunId);
        const model = workflowPanelModel(row, { phaseIndex: ui.phaseIndex, agentIndex: ui.agentIndex });
        if (model.orchestrator.autonomous) {
          ui.orchestratorDetail = true;
          ui.orchestratorVerbose = false;
          ui.controlSelected = true;
          ui.detailScroll = 0;
          message = null;
        } else message = 'This workflow has no autonomous orchestrator thread.';
        return paint();
      }
      if (key === '1' && detail) { ui.focus = 0; return paint(); }
      if (key === '2' && detail) { ui.focus = 1; return paint(); }
      if (key === '3' && detail) { ui.focus = 2; return paint(); }
      if (key === 'v' && ui.orchestratorDetail) {
        ui.orchestratorVerbose = !ui.orchestratorVerbose;
        ui.detailScroll = 0;
        message = null;
        return paint();
      }
      if (key === '\r' || key === '\n') {
        if (!detail) {
          selectedRunId = rows[selected]?.runId ?? selectedRunId;
          detail = true;
          ui.followActivePhase = true;
          ui.followActiveAgent = true;
        } else if (ui.focus === 0) {
          if (ui.controlSelected) {
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
    const onResize = () => paint();
    input.on('data', onData);
    output.on?.('resize', onResize);
  });
}

export function dashboardJson(bullswarmDir, { all = false, token = null, cancel = false } = {}) {
  if (cancel) {
    const result = requestCancel(bullswarmDir, token);
    return { action: 'cancel', ...result };
  }
  if (token) {
    const resolved = resolveRunId(bullswarmDir, token);
    if (!resolved) throw new Error(`no run found for "${token}"`);
    const statePath = join(resolved.runDir, 'state.json');
    const reportPath = join(resolved.runDir, 'report.json');
    const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null;
    const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : null;
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
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null;
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
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
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
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  return { ...resolved, decision, state };
}
