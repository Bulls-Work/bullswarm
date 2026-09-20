// The width-independent Step projection is built in step-model.js. This
// renderer deliberately only consumes that projection: missing fields stay
// visible as dashes and event prose is never promoted into technical facts.

import { formatMoneyPair } from '../lib/usage-basis.js';
import { cut, rule } from './dash-kit.js';
import {
  actionRoleLabel,
  blank,
  statusIcon,
  visibleLength,
  wrapLines,
} from './dashboard.js';

const STATUS_WORDS = Object.freeze({
  running: 'RUNNING',
  succeeded: 'SUCCEEDED',
  success: 'SUCCEEDED',
  completed: 'SUCCEEDED',
  complete: 'SUCCEEDED',
  failed: 'FAILED',
  interrupted: 'INTERRUPTED',
  cancelled: 'CANCELLED',
  canceled: 'CANCELLED',
  pending: 'PENDING',
  queued: 'QUEUED',
  unknown: 'UNKNOWN',
});

function text(value, fallback = '—') {
  if (value == null) return fallback;
  const result = String(value).trim();
  return result || fallback;
}

function number(value) {
  if (value == null || value === '' || typeof value === 'boolean') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function count(value) {
  const parsed = number(value);
  return parsed == null ? '—' : parsed.toLocaleString('en-US');
}

function fit(value, width) {
  return cut(String(value ?? ''), Math.max(1, Number(width) || 1));
}

function statusWord(value) {
  const raw = String(value ?? 'unknown').toLowerCase();
  return STATUS_WORDS[raw] ?? (raw ? raw.toUpperCase() : 'UNKNOWN');
}

function eventKind(event) {
  const kind = text(event?.kind, 'event');
  return kind === 'command_execution' ? 'COMMAND' : kind.toUpperCase();
}

function eventStatus(event) {
  return String(event?.status ?? '—').toLowerCase();
}

function duration(ms) {
  const value = number(ms);
  if (value == null) return '—';
  const seconds = Math.max(0, Math.round(value / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
}

function activeDuration(step) {
  const value = number(step?.activeDurationMs ?? step?.header?.duration?.activeMs);
  if (value == null) return '—';
  const minutes = value / 60_000;
  return `${Number(minutes.toFixed(2))}m`;
}

function summaryText(event) {
  const value = event?.summary == null ? '' : String(event.summary).replace(/\s+/g, ' ').trim();
  return value || 'summary unavailable';
}

function add(body, value, width) {
  body.push(fit(value, width));
}

function addWrapped(body, prefix, value, width, maxRows = Infinity) {
  const head = String(prefix ?? '');
  const room = Math.max(1, Number(width) - visibleLength(head));
  const lines = wrapLines([String(value ?? '')], room);
  const shown = lines.length ? lines : [''];
  shown.slice(0, maxRows).forEach((line) => add(body, `${head}${line}`, width));
  if (shown.length > maxRows) add(body, `${head}… ${shown.length - maxRows} more lines`, width);
  return shown.length;
}

function moneyPairLine(step) {
  const pair = step?.cost?.moneyPair ?? step?.moneyPair ?? {};
  const pending = Boolean(step?.cost?.pending ?? step?.availability?.usagePending);
  const rendered = formatMoneyPair({
    api: pair.api,
    subscription: pair.subscription,
    tokenSource: pair.tokenSource,
    tokens: pair.tokens,
  });
  const values = rendered.split(' · ');
  const apiRaw = values[0] ?? 'api unknown';
  const subRaw = values[1] ?? 'sub unknown';
  const api = apiRaw.startsWith('api unknown')
    ? `API ${blank()}${pending ? ' pending' : ''}`
    : `API ${apiRaw}`;
  const sub = subRaw.startsWith('sub unknown')
    ? `subscription ${blank()}${pending ? ' pending' : ''}`
    : `subscription ${subRaw}`;
  return `${api} · ${sub}`;
}

function tokenLine(step) {
  const cost = step?.cost ?? step?.costBlock ?? {};
  const tokens = cost.tokens ?? step?.tokens ?? {};
  const total = tokens.totalKnown;
  const source = cost.tokenSource ?? step?.moneyPair?.tokenSource;
  const pending = Boolean(cost.pending ?? step?.availability?.usagePending);
  if (number(total) == null) return `tokens ${blank()}${pending ? ' pending' : ''}`;
  const estimated = String(source ?? '').startsWith('estimated:') || source === 'mixed';
  return `tokens ${estimated ? '~' : ''}${count(total)}${source && source !== 'unknown' ? ` · ${source}` : ''}`;
}

function tokenClasses(step) {
  const tokens = step?.cost?.tokens ?? step?.tokens ?? {};
  const fields = [
    ['read', tokens.standardRead],
    ['cache read', tokens.cacheRead],
    ['cache write', number(tokens.cacheWrite5m) ?? number(tokens.cacheWrite1h) ?? number(tokens.cacheWrite)],
    ['output', tokens.output],
    ['reasoning', tokens.reasoning],
  ];
  const values = fields.filter(([, value]) => number(value) != null)
    .map(([label, value]) => `${label} ${count(value)}`);
  return values.length ? values.join(' · ') : null;
}

function budgetLine(step) {
  const budget = step?.cost?.budget ?? step?.costBlock?.budget;
  if (budget == null) return `budget ${blank()}`;
  if (typeof budget === 'string' || typeof budget === 'number') return `budget ${budget}`;
  const values = [
    budget.remaining ?? budget.remainingUsd ?? budget.remainingMinutes,
    budget.limit ?? budget.budget ?? budget.expectedMinutes,
  ].filter((value) => value != null);
  return `budget ${values.length ? values.join('/') : blank()}`;
}

function headerLines(step, width, view = 'overview') {
  const identity = step?.identity ?? {};
  const attempt = step?.selectedAttempt ?? {};
  const pool = text(step?.header?.pool ?? attempt.pool);
  const model = text(step?.header?.model ?? attempt.model);
  const effort = text(step?.header?.effort ?? attempt.effort ?? step?.route?.effort);
  const verified = identity.verified == null ? '—' : identity.verified ? 'verified' : 'not verified';
  const purpose = text(identity.purpose, text(step?.action?.purpose, actionRoleLabel(step?.action ?? {})));
  const lines = [];
  if (width < 70) {
    addWrapped(lines, '', purpose, width, 2);
    addWrapped(lines, '', `${statusWord(identity.status).toLowerCase()} · ${verified}`, width, 1);
    addWrapped(lines, '', `${pool} · ${model} · ${effort}`, width, 2);
    add(lines, `active ${activeDuration(step)}`, width);
    add(lines, ` [v ${view === 'overview' ? 'detail' : 'overview'}]`, width);
    return lines;
  }
  addWrapped(lines, ' ', `${statusWord(identity.status).toLowerCase()} · ${verified} · ${pool} · ${model} · ${effort}`, width, 2);
  addWrapped(lines, ' purpose ', purpose, width, 2);
  add(lines, ` active ${activeDuration(step)}${number(step?.spanDurationMs) == null ? '' : ` · span ${duration(step.spanDurationMs)}`}`, width);
  add(lines, ` [v ${view === 'overview' ? 'detail' : 'overview'}]`, width);
  return lines;
}

function taskLines(step, width) {
  const block = step?.taskBlock ?? step?.task ?? {};
  const lines = block.firstLines ?? block.lines ?? step?.prompt ?? [];
  const body = [];
  if (!lines.length) {
    add(body, ` ${block.available ? text(block.prompt) : 'task unavailable; no task file was captured.'}`, width);
  } else {
    const limit = width < 70 ? 4 : width < 170 ? 6 : 8;
    lines.slice(0, limit).forEach((line) => addWrapped(body, ' ', line, width, 2));
    if (lines.length > limit || block.path) add(body, ' task path retained; first lines shown · [Enter expand]', width);
  }
  return body;
}

function overviewLines(step, width) {
  const activity = step?.activity ?? {};
  const body = [];
  if (!activity.available) {
    add(body, ` ${activity.reason || 'event stream unavailable'}.`, width);
    add(body, ' turns, tools, and event timing cannot be reconstructed.', width);
    return body;
  }
  const turns = activity.turns ?? [];
  if (!turns.length) {
    add(body, ` no response turns captured · ${activity.events?.length ?? 0} atomic events`, width);
    return body;
  }
  const filter = activity.filter ?? 'all';
  for (const row of activity.overviewRows ?? []) {
    if (row.type === 'response') {
      addWrapped(body, `R${row.turnIndex + 1}  `, summaryText(row.event), width, 3);
    } else if (row.type === 'event') {
      const event = row.event;
      addWrapped(body, '    ', `${eventKind(event)} · ${eventStatus(event)} · ${summaryText(event)}`, width, 3);
    } else {
      add(body, `    ${row.summary?.text ?? '0 commands · 0 files read · 0 edits · 0 errors'}`, width);
    }
  }
  if (filter !== 'all' && !body.length) add(body, ` no ${filter} events captured`, width);
  return body;
}

function technicalValue(value) {
  if (value == null) return blank();
  if (typeof value === 'string') return value.replace(/\s+/g, ' ');
  try { return JSON.stringify(value); } catch { return String(value); }
}

function detailLines(step, width) {
  const activity = step?.activity ?? {};
  const body = [];
  if (!activity.available) {
    add(body, ` ${activity.reason || 'event stream unavailable'}.`, width);
    add(body, ' all technical fields are unavailable without a structured stream.', width);
    return body;
  }
  const events = activity.visibleDetailEvents ?? activity.visibleEvents ?? [];
  if (!events.length) {
    add(body, ` no captured events for today · filters ${activity.filter ?? 'all'}`, width);
    return body;
  }
  for (const event of events) {
    addWrapped(body, '', `seq ${technicalValue(event.seq)} · capture-time ${technicalValue(event.at)}`, width, 3);
    addWrapped(body, ' ', `source ${technicalValue(event.source)} · provider ${technicalValue(event.providerType)}`, width, 3);
    addWrapped(body, ' ', `kind ${technicalValue(event.kind)} · status ${technicalValue(event.status)}`, width, 3);
    addWrapped(body, ' ', `eventId ${technicalValue(event.eventId)} · turnId ${technicalValue(event.turnId)} · toolCallId ${technicalValue(event.toolCallId)}`, width, 4);
    addWrapped(body, ' ', `provider timestamp ${technicalValue(event.providerAt)} · duration ${technicalValue(event.durationMs)} · usage ${technicalValue(event.usage)}`, width, 4);
    addWrapped(body, ' ', `arguments ${technicalValue(event.arguments)} · result ${technicalValue(event.result)}`, width, 4);
    addWrapped(body, ' ', `parent/subagent ${technicalValue(event.parentId)}/${technicalValue(event.subagentId)}`, width, 3);
    addWrapped(body, ' ', `summary: ${summaryText(event)}`, width, 4);
  }
  return body;
}

function resultLines(step, width, detail) {
  const body = [];
  const outcome = step?.resultBlock?.outcome ?? step?.outcomeModel ?? {};
  const execution = outcome.execution ?? step?.execution ?? {};
  const workflow = outcome.workflow ?? step?.workflow ?? {};
  const verification = outcome.verification ?? step?.verification ?? {};
  const workflowStatus = workflow.status == null || String(workflow.status).toLowerCase() === 'unknown'
    ? blank()
    : text(workflow.status);
  add(body, ` execution ${statusWord(execution.status)} · workflow ${workflowStatus} · verified ${verification.verdict == null ? blank() : verification.verdict ? 'true' : 'false'}`, width);
  if ((step?.attemptHistory?.length ?? 0) > 1) add(body, ` attempt history ${step.attemptHistory.length} attempts`, width);
  if (step?.selectedAttempt?.failureReason) addWrapped(body, ' failure ', step.selectedAttempt.failureReason, width, 3);
  if (step?.taskResult != null) addWrapped(body, ' reason ', step.taskResult, width, 3);
  const output = step?.resultBlock?.output ?? step?.outcomeModel?.output ?? step?.outputModel ?? {};
  if (output.available) {
    add(body, ' output:', width);
    const limit = width < 70 ? 4 : 8;
    (output.lines ?? []).slice(0, limit).forEach((line) => addWrapped(body, '  ', line, width, 3));
  } else add(body, ' output unavailable.', width);
  const artifacts = step?.resultBlock?.artifacts?.paths ?? step?.artifacts?.paths ?? {};
  for (const [name, value] of [['task', artifacts.task], ['output', artifacts.output], ['stream', artifacts.stream], ['result', artifacts.result]]) {
    if (value == null) {
      if (detail) add(body, ` ${name}: ${blank()} unavailable`, width);
      continue;
    }
    addWrapped(body, ` ${name}: `, value, width, detail ? Infinity : 4);
  }
  const requirements = verification.requirements ?? outcome.requirements ?? [];
  if (requirements.length) {
    const passed = requirements.filter((entry) => entry.status === 'passed').length;
    add(body, ` requirement evidence ${passed}/${requirements.length}`, width);
  } else add(body, ' requirement evidence unavailable.', width);
  return body;
}

function costLines(step, width) {
  const body = [];
  addWrapped(body, ' ', moneyPairLine(step), width, 3);
  addWrapped(body, ' ', tokenLine(step), width, 3);
  const classes = tokenClasses(step);
  if (classes) addWrapped(body, ' token classes ', classes, width, 3);
  add(body, ` ${budgetLine(step)}`, width);
  return body;
}

function markSection(body, section) {
  body.anchor ??= {};
  body.anchor.step ??= {};
  body.anchor.step[section] = body.lines.length + 1;
}

/** Render the Step page in the required header/task/activity/result/cost order. */
export function renderStepPage(step, opts = {}, body) {
  const width = Math.max(20, Number(opts.width) || 120);
  const spinnerFrame = Number(opts.spinnerFrame) || 0;
  if (!body || typeof body.push !== 'function') return '';
  if (!step?.identity && !step?.agent) {
    add(body, ' no step selected; identity unavailable', width);
    return ' pending · no step selected';
  }

  const view = opts.stepDetail ? 'detail' : (opts.stepView ?? opts.view ?? step.view ?? 'overview') === 'detail' ? 'detail' : 'overview';
  const expandedTurn = opts.stepExpandedTurn ?? opts.expandedTurn ?? step.expandedTurn ?? null;
  const identity = step.identity ?? {};
  const action = text(identity.actionId, text(step.action?.id, 'step'));
  const shortId = text(identity.shortId, text(step.shortId, '------'));
  const status = statusWord(identity.status);
  const verdict = identity.verified == null ? '' : identity.verified ? ' · VERIFIED' : ' · not verified';

  for (const line of headerLines(step, width, view)) body.push(fit(line, width));

  body.push('');
  markSection(body, 'task');
  body.push(rule('task · prompt + task first lines', null, width));
  for (const line of taskLines(step, width)) body.push(fit(line, width));

  body.push('');
  markSection(body, 'activity');
  const activity = step.activity ?? {};
  const filter = activity.filter ?? 'all';
  const streamNotes = [
    number(activity.parseErrors) > 0 ? `${activity.parseErrors} malformed ignored` : null,
    activity.truncated ? `stream truncated${activity.dropped == null ? '' : ` · ${activity.dropped} dropped`}` : null,
  ].filter(Boolean).join(' · ');
  if (view === 'overview') {
    body.push(rule(`activity · overview · response turns · ${activity.events?.length ?? 0} events`, null, width));
    add(body, ` filters [${filter}] · all · turns · errors · tools · ${activity.follow ? 'following' : 'paused'}${streamNotes ? ` · ${streamNotes}` : ''}`, width);
    for (const line of overviewLines(step, width)) body.push(fit(line, width));
    if (expandedTurn != null) add(body, ` expanded turn ${Number(expandedTurn) + 1}`, width);
  } else {
    body.push(rule(`activity · today's capture-order log · ${filter} · ${activity.todayEvents?.length ?? activity.events?.length ?? 0} events`, null, width));
    add(body, ` filters [${filter}] · all · turns · errors · tools${streamNotes ? ` · ${streamNotes}` : ''}`, width);
    for (const line of detailLines(step, width)) body.push(fit(line, width));
    if (activity.responseCount != null) add(body, ` ${activity.responseCount} responses · ${activity.filterCounts?.tools ?? 0} commands/tools · ${activity.filterCounts?.errors ?? 0} errors`, width);
  }

  body.push('');
  markSection(body, 'result');
  // Compatibility anchors map the retired jumps into the merged blocks.
  body.anchor.step.outcome = body.anchor.step.result;
  body.anchor.step.prompt = body.anchor.step.task;
  body.push(rule('result · output + artifacts + outcome/verification', null, width));
  for (const line of resultLines(step, width, view === 'detail')) body.push(fit(line, width));

  body.push('');
  markSection(body, 'cost');
  body.push(rule('cost · money pair + tokens + budget', null, width));
  for (const line of costLines(step, width)) body.push(fit(line, width));

  body.push('');
  const footer = view === 'overview'
    ? '[v detail] [Enter expand turn] [↑↓ select] [Space follow] [e errors] [t tools]'
    : '[↑↓ select] [Enter expand] [Space follow] [e errors] [t tools] [v overview]';
  add(body, ` ${footer}`, width);
  const header = `${statusIcon(identity.status, spinnerFrame)} Step ${action} · run ${shortId} · ${status}${verdict}`;
  return fit(` ${header}`, width);
}

export const stepPage = renderStepPage;
