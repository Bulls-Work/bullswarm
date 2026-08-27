// Interactive workflow dashboard, inspired by Claude Code's /workflows view.
// It deliberately uses only ANSI sequences and Node's standard streams.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { listRuns, resolveRunId } from './short-id.js';
import { appendEvent, readEvents } from './events.js';

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

export function requestCancel(bullswarmDir, token) {
  const resolved = resolveRunId(bullswarmDir, token);
  if (!resolved) throw new Error(`no run found for "${token}"`);
  const statePath = join(resolved.runDir, 'state.json');
  if (!existsSync(statePath)) throw new Error(`run "${token}" has no state.json`);
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  if (state.finishedAt || ['completed', 'failed', 'cancelled', 'interrupted', 'budget_exhausted'].includes(state.status)) {
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
        total: acc.total + (v.total ?? 0), ok: acc.ok + (v.ok ?? 0), failed: acc.failed + (v.failed ?? 0),
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
    lines.push(`   ⟡ ${agent.stepId} · ${agent.pool ?? '—'} · ${agent.model ?? 'model from connector'} · attempt ${agent.attempt ?? 0}`);
  }
  if (!Object.keys(state.activeAgents ?? {}).length) lines.push('   none');
  lines.push('', ' completed log:');
  for (const step of state.steps ?? []) lines.push(`   ${step.ok ? '✓' : '✗'} ${step.phase}/${step.stepId}${step.why ? ` · ${step.why}` : ''}`);
  lines.push('', ` budget: ${state.budget?.dispatchesUsed ?? 0}/${state.budget?.dispatchLimit ?? '∞'} dispatches · expansion ${state.budget?.expansionRound ?? 0}/${state.budget?.expansionLimit ?? 0}`);
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
  const paint = () => {
    if (selected >= rows.length) selected = Math.max(0, rows.length - 1);
    if (detail && selectedRunId) {
      const row = detailRow(bullswarmDir, selectedRunId);
      output.write(`${renderDetails(row)}\n`);
      return;
    }
    output.write(`${renderDashboard({ rows, selected, message })}\n`);
  };
  const refresh = () => {
    rows = dashboardRows(bullswarmDir);
    if (!selectedRunId) selectedRunId = rows[selected]?.runId ?? null;
    paint();
  };
  input.setRawMode?.(true);
  input.resume();
  output.write(`${ESC}?25l`);
  paint();
  const timer = setInterval(refresh, refreshMs);
  return new Promise((resolve) => {
    const finish = () => {
      clearInterval(timer);
      input.setRawMode?.(false);
      input.pause();
      input.removeListener('data', onData);
      output.write(`${ESC}?25h\n`);
      resolve(0);
    };
    const onData = (buf) => {
      const key = String(buf);
      if (key === 'q' || key === '\u0003') return finish();
      if (key === 'r') { message = null; return refresh(); }
      if (key === 'b') { detail = false; return paint(); }
      if (key === '\u001b[A' || key === 'k') { selected = Math.max(0, selected - 1); selectedRunId = rows[selected]?.runId ?? selectedRunId; return paint(); }
      if (key === '\u001b[B' || key === 'j') { selected = Math.min(Math.max(0, rows.length - 1), selected + 1); selectedRunId = rows[selected]?.runId ?? selectedRunId; return paint(); }
      if (key === '\r' || key === '\n') { selectedRunId = rows[selected]?.runId ?? selectedRunId; detail = true; return paint(); }
      if (key === 'c' && rows[selected]) {
        try {
          const r = requestCancel(bullswarmDir, rows[selected].runId);
          message = r.alreadyFinished ? 'That workflow has already finished.' : `Stop requested for ${r.shortId ?? r.runId}.`;
          refresh();
        } catch (err) { message = err.message; paint(); }
      }
    };
    input.on('data', onData);
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
