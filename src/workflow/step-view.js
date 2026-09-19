// The Step page renderer.
//
// step-model.js is deliberately the only place that reads workflow records,
// streams, outputs, and result envelopes. This module receives that
// width-independent projection and paints it into the dashboard's flat frame.
// A missing value is written as an explicit unavailable state; prose in an
// event summary is never promoted to a tool, turn, cost, or provider field.

import { glyphs } from '../lib/glyphs.js';
import { formatMoneyPair } from '../lib/usage-basis.js';
import { cut, rule } from './dash-kit.js';
import {
  actionRoleLabel,
  blank,
  clockText,
  formatBytes,
  statusIcon,
  truncate,
  visibleLength,
  wrapLines,
} from './dashboard.js';

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
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
});
const SECTION_ORDER = Object.freeze(['activity', 'attempts', 'outcome', 'prompt']);

function plain(value) {
  return String(value ?? '').replace(ANSI, '');
}

function text(value, fallback = null) {
  if (value == null) return fallback;
  const result = String(value).trim();
  return result || fallback;
}

function number(value) {
  if (value == null || value === '' || (typeof value === 'string' && value.trim() === '') || typeof value === 'boolean') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function count(value) {
  const n = number(value);
  return n == null ? null : n.toLocaleString('en-US');
}

function statusWord(value) {
  const raw = String(value ?? '').toLowerCase();
  return STATUS_WORDS[raw] ?? (raw ? raw.toUpperCase() : 'UNKNOWN');
}

function fit(value, width) {
  return cut(String(value ?? ''), Math.max(1, width));
}

function wrapped(body, prefix, value, width, rows = Infinity) {
  const available = Math.max(1, width - visibleLength(prefix));
  const lines = wrapLines([String(value ?? '')], available);
  for (const line of lines.slice(0, rows)) body.push(fit(`${prefix}${line}`, width));
  if (lines.length > rows) body.push(fit(`${prefix}… ${lines.length - rows} more lines`, width));
  return lines.length;
}

function timeText(value) {
  if (!value) return null;
  try { return clockText(value); } catch { return null; }
}

function duration(value) {
  const ms = number(value);
  if (ms == null) return null;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
}

function eventTime(value, precise = false) {
  const parsed = Date.parse(String(value ?? ''));
  if (!Number.isFinite(parsed)) return '--:--';
  const date = new Date(parsed);
  const base = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  if (!precise) return base;
  return `${base}:${String(date.getSeconds()).padStart(2, '0')}.${String(date.getMilliseconds()).padStart(3, '0')}`;
}

function eventMark(event) {
  const status = String(event?.status ?? '').toLowerCase();
  if (['completed', 'complete', 'succeeded', 'success', 'done'].includes(status)) return glyphs().ok;
  if (['failed', 'failure', 'error', 'interrupted', 'cancelled', 'canceled'].includes(status)) return glyphs().fail;
  if (['running', 'started', 'start', 'in_progress', 'in-progress'].includes(status)) return glyphs().started;
  return '·';
}

function eventKind(event) {
  const kind = text(event?.kind, 'event');
  if (kind === 'command_execution') return 'COMMAND';
  return kind.toUpperCase();
}

function eventSummary(event) {
  return text(event?.summary, 'summary unavailable');
}

function streamUnavailable(activity) {
  if (!activity?.available) return activity?.reason || 'event stream unavailable';
  if (activity.plainText) return 'plain stdout capture has no structured events';
  return null;
}

function moneyLine(pair, { pending = false } = {}) {
  const value = pair && typeof pair === 'object' ? pair : {};
  // formatMoneyPair is the one source of truth for amount/basis formatting.
  // The Step page changes only field labels and maps unknown words to the
  // design's honest dash; it never substitutes a zero or bare dollar.
  const rendered = formatMoneyPair({
    api: value.api,
    subscription: value.subscription,
    tokenSource: value.tokenSource,
  });
  const [apiRaw = 'api unknown', subscriptionRaw = 'sub unknown'] = rendered.split(' · ');
  const api = apiRaw.startsWith('api unknown')
    ? `API ${blank()} ${pending ? 'pending' : 'unknown'}`
    : `API ${apiRaw}`;
  const subscription = subscriptionRaw.startsWith('sub unknown')
    ? `subscription ${blank()} ${pending ? 'pending' : 'unknown'}`
    : `subscription ${subscriptionRaw}`;
  return `${api} · ${subscription}`;
}

function tokenLine(tokens, source, { pending = false } = {}) {
  const total = count(tokens?.totalKnown);
  if (total == null) return `Tokens ${blank()} ${pending ? 'pending' : 'unknown'}`;
  const estimated = String(source ?? '').startsWith('estimated:') || source === 'mixed';
  const prefix = estimated ? '~' : '';
  const basis = source && source !== 'unknown' ? ` · ${source}` : '';
  return `Tokens ${prefix}${total}${basis}`;
}

function tokenClassLine(tokens) {
  const fields = [
    ['read', tokens?.standardRead],
    ['cache read', tokens?.cacheRead],
    ['cache write', (number(tokens?.cacheWrite5m) ?? number(tokens?.cacheWrite1h) ?? number(tokens?.cacheWrite))],
    ['output', tokens?.output],
    ['reasoning', tokens?.reasoning],
  ];
  const rendered = fields.map(([label, value]) => `${label} ${value == null ? blank() : count(value)}`);
  return rendered.some((entry) => !entry.endsWith(blank())) ? rendered.join(' · ') : null;
}

function poolMeterLine(step) {
  const profile = step.poolProfile ?? {};
  const name = text(profile.name, text(step.selectedAttempt?.pool, 'pool unavailable'));
  const modelClass = profile.freeModel === true
    ? 'free model'
    : profile.freeModel === false ? 'paid model' : `model class ${blank()}`;
  const meter = profile.meterType === 'none'
    ? 'no licence meter'
    : profile.meterType ? `${profile.meterType} licence meter` : `licence meter ${blank()}`;
  const window = profile.pacingWindow ? ` · ${profile.pacingWindow}` : '';
  return `${name} · ${modelClass} · ${meter}${window}`;
}

function routeText(step) {
  const route = step.route ?? {};
  const attemptRoute = step.selectedAttempt?.routing ?? {};
  const lane = text(route.lane, text(attemptRoute.lane, null));
  const effort = text(route.effort, text(attemptRoute.effort, null));
  const reason = text(route.reason, text(route.explanation, text(attemptRoute.reason, text(attemptRoute.why, null))));
  const candidate = Array.isArray(route.candidates) ? route.candidates[0] : null;
  const forecast = route.forecast && typeof route.forecast === 'object' ? route.forecast : {};
  const candidateText = candidate
    ? `candidate ${text(candidate.pool, 'pool unavailable')}${text(candidate.model, null) ? `/${candidate.model}` : ''}`
    : null;
  const forecastText = [
    forecast.urgency ?? candidate?.urgency,
    forecast.forecastPacingPct ?? candidate?.forecastPacingPct,
  ].filter((value) => number(value) != null).map((value, index) => index === 0 ? `urgency ${value}` : `forecast ${value}%`);
  const surplus = number(candidate?.effectiveSurplus ?? candidate?.pace);
  const pieces = [
    [lane, effort].filter(Boolean).join('/'),
    reason,
    candidateText,
    surplus == null ? null : `surplus ${surplus}`,
    ...forecastText,
  ].filter(Boolean);
  return pieces.length ? pieces.join(' · ') : null;
}

function minimap(activity, width) {
  const buckets = activity?.minimap?.buckets ?? [];
  if (!buckets.length) return null;
  const glyphsForBucket = buckets.map((bucket) => {
    if (bucket.errors > 0) return '×';
    if (bucket.visibleCount === 0) return '·';
    if (bucket.kinds.includes('command_execution') || bucket.kinds.includes('tool')) return '▆';
    return '▂';
  }).join('');
  return fit(glyphsForBucket, Math.max(4, Math.min(width, 32)));
}

function filterLabel(activity) {
  const selected = activity?.filter ?? 'all';
  return ['all', 'turns', 'tools', 'errors']
    .map((value) => value === selected ? `[${value}]` : value)
    .join(' · ');
}

function activityLines(step, width, { detailOpen = false } = {}) {
  const activity = step.activity ?? {};
  const lines = [];
  const unavailable = streamUnavailable(activity);
  if (unavailable) {
    lines.push(` ${unavailable}.`);
    lines.push(' turns, tools, and event timing cannot be reconstructed.');
    return lines.map((line) => fit(line, width));
  }
  const map = minimap(activity, width - 12);
  const turns = activity.turns?.length ? `${activity.turns.length} turns` : 'turns not captured';
  const follow = activity.follow ? 'following' : 'paused';
  lines.push(` ${map ?? '—'}  ${activity.events?.length ?? 0} events · ${turns} · ${follow}`);
  lines.push(` filters ${filterLabel(activity)} · capture order${activity.parseErrors ? ` · ${activity.parseErrors} malformed ignored` : ''}`);
  if (detailOpen) return lines.map((line) => fit(line, width));
  const events = activity.visibleEvents ?? [];
  if (!events.length) {
    lines.push(` ${activity.filter === 'all' ? 'no captured events' : `no ${activity.filter} events captured`}`);
    return lines.map((line) => fit(line, width));
  }
  const compact = width < 70;
  for (const event of events) {
    const selected = Number(event.index) === Number(activity.selectedIndex);
    const prefix = selected ? '>' : ' ';
    const at = eventTime(event.at, width >= 150);
    const head = `${prefix}${at} ${eventKind(event).padEnd(compact ? 9 : 12)} ${eventMark(event)} `;
    const suffix = event.durationMs != null ? ` · ${duration(event.durationMs)}` : '';
    pushLine(lines, `${head}${eventSummary(event)}${suffix}`, width);
  }
  return lines.map((line) => fit(line, width));
}

function pushLine(lines, value, width) {
  lines.push(fit(value, width));
}

function selectedDetailLines(step, width) {
  const detail = step.selectedEventDetail ?? step.activity?.selectedEventDetail;
  const lines = [];
  if (!detail?.available || !detail.event) {
    const attempt = step.selectedAttempt;
    if (attempt && (attempt.failureReason || attempt.status === 'failed' || attempt.status === 'interrupted')) {
      lines.push(` attempt ${attempt.ordinal ?? '?'} · ${statusWord(attempt.status).toLowerCase()} · ${text(attempt.pool, 'pool unavailable')}`);
      lines.push(` failure ${text(attempt.failureReason, 'provider failure unavailable')}`);
      lines.push(` not captured: structured provider payload, tool identity, final event`);
      return lines.map((line) => fit(line, width));
    }
    lines.push(' selected event detail unavailable.');
    lines.push(' No event is selected in the captured stream.');
    return lines.map((line) => fit(line, width));
  }
  const event = detail.event;
  lines.push(` ${eventKind(event)} · ${String(event.status ?? 'status unavailable').toLowerCase()} · source ${event.source ?? 'unavailable'}`);
  lines.push(` captured ${eventTime(event.at, width >= 150)}`);
  if (event.durationMs != null) lines.push(` duration ${duration(event.durationMs)}`);
  if (event.toolName != null) lines.push(` tool ${text(event.toolName)}`);
  if (event.arguments != null) lines.push(` arguments ${typeof event.arguments === 'string' ? event.arguments : JSON.stringify(event.arguments)}`);
  if (event.result != null) lines.push(` result ${typeof event.result === 'string' ? event.result : JSON.stringify(event.result)}`);
  if (event.usage != null) lines.push(` usage ${typeof event.usage === 'string' ? event.usage : JSON.stringify(event.usage)}`);
  if (detail.captured?.length) lines.push(` captured: ${detail.captured.join(', ')}`);
  if (detail.unavailable?.length) {
    const missing = new Set(detail.unavailable);
    const groups = [];
    if (['event id', 'turn id', 'tool call id', 'tool', 'arguments', 'result', 'parent', 'subagent'].some((field) => missing.has(field))) groups.push('tool identity');
    if (['provider time', 'duration'].some((field) => missing.has(field))) groups.push('timing');
    if (missing.has('usage')) groups.push('usage');
    lines.push(` not captured: ${groups.length ? groups.join(', ') : detail.unavailable.join(', ')}`);
  }
  if (!detail.captured?.length && !detail.unavailable?.length) lines.push(' No structured event fields were captured.');
  return lines.map((line) => fit(line, width));
}

function attemptLine(attempt, selected, width) {
  const pool = text(attempt?.pool, 'pool unavailable');
  const model = text(attempt?.model, 'model unavailable');
  const output = number(attempt?.outputBytesObserved ?? attempt?.outputBytes);
  const tokens = attempt?.tokens?.totalKnown != null ? `~${count(attempt.tokens.totalKnown)} tokens` : 'usage pending';
  const elapsed = duration(attempt?.durationMs);
  const failure = text(attempt?.failureReason, null);
  const tail = [elapsed, output == null ? null : formatBytes(output), tokens, failure].filter(Boolean).join(' · ');
  return fit(`${selected ? '>' : ' '}${attempt?.ordinal ?? '?'} ${statusWord(attempt?.status)} · ${pool} · ${model}${tail ? ` · ${tail}` : ''}`, width);
}

function attemptLines(step, width) {
  const attempts = step.attemptHistory ?? step.attempts ?? [];
  if (!attempts.length) return [' no attempt record captured.'];
  return attempts.map((attempt) => attemptLine(attempt, attempt.id === step.selectedAttempt?.id, width));
}

function outcomeLines(step, width) {
  const lines = [];
  const verdict = step.verdict ?? {};
  const execution = verdict.execution ?? step.execution ?? {};
  const workflow = verdict.workflow ?? step.workflow ?? {};
  const verification = verdict.verification ?? step.verification ?? {};
  const status = verification.verdict == null ? `${blank()} unavailable` : verification.verdict ? 'VERIFIED' : 'not verified';
  lines.push(` ${verification.verdict === true ? glyphs().ok : verification.verdict === false ? glyphs().fail : '·'} workflow ${status}`);
  lines.push(` ${execution.succeeded ? glyphs().ok : execution.terminal ? glyphs().fail : glyphs().ongoing} action execution ${statusWord(execution.status)}`);
  lines.push(` workflow status ${workflow.status ?? 'unavailable'} · execution and verification are separate`);
  const result = step.outcomeModel ?? {};
  if (result.resultAvailable) lines.push(' Durable result and action output recorded.');
  else if (result.available) lines.push(' Durable result envelope unavailable; captured output is shown below.');
  else lines.push(' Durable outcome unavailable.');
  const requirements = verification.requirements ?? result.requirements ?? [];
  if (requirements.length) {
    const passed = requirements.filter((entry) => entry.status === 'passed').length;
    lines.push(` requirement evidence ${passed}/${requirements.length} recorded`);
  } else lines.push(' requirement evidence unavailable.');
  return lines.map((line) => fit(line, width));
}

function promptLines(step, width) {
  const prompt = step.promptModel ?? { lines: step.prompt ?? [], available: false };
  const lines = [];
  if (!prompt.available) lines.push(' prompt unavailable; no task file was captured.');
  else for (const line of prompt.lines ?? []) lines.push(` ${line}`);
  return lines.map((line) => fit(line, width));
}

function artifactLines(step, width) {
  const artifacts = step.artifacts?.paths ?? step.artifacts ?? {};
  const rows = [
    ['task', artifacts.task],
    ['output', artifacts.output],
    ['stream', artifacts.stream],
    ['result', artifacts.result],
  ];
  return rows.map(([name, value]) => fit(` ${name.padEnd(7)}${value ?? `${blank()} unavailable`}`, width));
}

function joinColumns(left, right, width) {
  const leftWidth = Math.max(20, Math.floor((width - 3) * 0.56));
  const rightWidth = Math.max(1, width - leftWidth - 3);
  const rows = [];
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = fit(left[index] ?? '', leftWidth);
    const b = fit(right[index] ?? '', rightWidth);
    rows.push(fit(`${a}${' '.repeat(Math.max(1, leftWidth - visibleLength(a) + 2))}${b}`, width));
  }
  return rows;
}

function addField(lines, label, value, width) {
  const prefix = ` ${String(label).padEnd(9)} `;
  const available = Math.max(1, width - visibleLength(prefix));
  for (const line of wrapLines([String(value ?? '— unavailable')], available).slice(0, 3)) {
    lines.push(fit(`${prefix}${line}`, width));
  }
}

function summary(step, width, spinnerFrame) {
  const identity = step.identity ?? {};
  const attempt = step.selectedAttempt ?? {};
  const status = String(identity.status ?? 'unknown').toLowerCase();
  const icon = statusIcon(status, spinnerFrame);
  const attempts = step.attemptHistory?.length ?? 0;
  const ordinal = attempt.ordinal ?? attempt.attemptNumber ?? 1;
  const verified = identity.verified == null ? blank() : identity.verified ? 'VERIFIED' : 'NOT VERIFIED';
  const actionId = text(identity.actionId, text(step.action?.id, 'step'));
  const shortId = text(identity.shortId, text(step.shortId, '------'));
  const lines = [];
  const purpose = text(identity.purpose, text(step.action?.purpose, actionRoleLabel(step.action ?? {})));
  const reasoning = text(step.reasoning, text(attempt.reasoning?.level, null));
  const pool = text(attempt.pool, 'pool unavailable');
  const model = text(attempt.model, 'model unavailable');
  const effort = text(attempt.effort, step.route?.effort ?? 'auto');
  const route = routeText(step) ?? 'route unavailable';
  const started = timeText(attempt.startedAt ?? step.startedAt);
  const elapsed = duration(attempt.durationMs);
  const time = started ? `started ${started}${elapsed ? ` · elapsed ${elapsed}` : ''}` : 'timestamps unavailable';
  const money = moneyLine(step.moneyPair, { pending: step.availability?.usagePending });
  const tokens = tokenLine(step.tokens, step.moneyPair?.tokenSource, { pending: step.availability?.usagePending });
  if (width < 70) {
    lines.push(` ${purpose}`);
    lines.push(` Pool      ${pool} · ${model} · reasoning ${reasoning ?? blank()}${elapsed ? ` · ${elapsed}` : ''}`);
    lines.push(` Route ${route}`);
    lines.push(` Money ${money}`);
    lines.push(` ${tokens} · output ${outputByteValue(step) == null ? blank() : formatBytes(outputByteValue(step))}`);
    return lines.map((line) => fit(line, width));
  }
  if (width >= 170) {
    lines.push(` Purpose  ${purpose}`);
    lines.push(` Pool      ${pool} · attempt ${ordinal} · ${model} · reasoning ${reasoning ?? 'unavailable'} · ${time}${outputByteValue(step) == null ? '' : ` · output ${formatBytes(outputByteValue(step))}`}`);
    lines.push(` Route    ${route}`);
    lines.push(` Money    ${money}                                      ${tokens}`);
    lines.push(` Status   ${statusWord(identity.status)} · workflow ${text(identity.workflowStatus, 'unavailable')} · execution ${statusWord(identity.executionStatus)} · verified ${verified}`);
    return lines.map((line) => fit(line, width));
  }
  // The 120-column contract keeps the old labelled fields discoverable while
  // compressing them to the same five-row summary as the design frames.
  lines.push(` Status   ${statusWord(identity.status).toLowerCase()} · ${model} · reasoning ${reasoning ?? blank()} · ${verified}`);
  lines.push(` Pool      ${pool} · attempt ${ordinal} · effort ${effort}${reasoning ? ` · reasoning ${reasoning}` : ''}${attempts > 1 ? ` · history ${ordinal}/${attempts}` : ''}`);
  lines.push(` Purpose  ${purpose}`);
  lines.push(` Route    ${route}`);
  lines.push(` Time     ${time} · ${money} · ${tokens}`);
  return lines.map((line) => fit(line, width));
}

function renderCompactSummary(step, width, spinnerFrame) {
  const lines = summary(step, width, spinnerFrame);
  return lines;
}

function outputByteValue(step) {
  const current = number(step.bytes);
  const samples = step.selectedAttempt?.outputSamples;
  const last = Array.isArray(samples) && samples.length ? number(samples.at(-1)?.[1]) : null;
  return last != null && (current == null || last > current) ? last : current;
}

function markSection(body, section) {
  body.anchor ??= {};
  body.anchor.step ??= {};
  body.anchor.step[section] = body.lines.length + 1;
}

/** Render one Step page into the dashboard frame builder. */
export function renderStepPage(step, opts = {}, body) {
  const width = Math.max(20, Number(opts.width) || 120);
  const spinnerFrame = Number(opts.spinnerFrame) || 0;
  const narrow = width < 70;
  const wide = width >= 170;
  if (!body || typeof body.push !== 'function') return '';
  if (!step?.identity && !step?.agent) {
    body.push(fit(' no step selected; identity unavailable', width));
    return truncate(' pending · no step selected', width);
  }

  const activity = activityLines(step, width, { detailOpen: Boolean(opts.stepDetail) });
  const detail = selectedDetailLines(step, width);
  const attempts = attemptLines(step, width);
  const outcome = outcomeLines(step, width);
  const prompt = promptLines(step, width);
  const artifacts = artifactLines(step, width);
  const selectedSection = SECTION_ORDER.includes(opts.stepSection) ? opts.stepSection : 'activity';

  if (!(step.attemptHistory ?? step.attempts ?? []).length && step.action?.status === 'blocked') {
    const blockedBy = step.action?.lastFailure?.message ?? step.action?.failure?.message ?? 'a failed dependency';
    const role = actionRoleLabel(step.action) === 'action' ? 'work' : actionRoleLabel(step.action);
    body.push(fit(` ${glyphs().blocked} ${step.action.id} · ${role} · never dispatched`, width));
    body.push(fit(`   blocked by ${blockedBy.replace(/^dependency\s+/i, '').replace(/\s+did not succeed$/i, '')}`, width));
  }

  for (const line of renderCompactSummary(step, width, spinnerFrame)) body.push(fit(line, width));

  body.push('');
  body.push(rule('budget', null, width));
  body.push(fit(` ${poolMeterLine(step)}`, width));
  const classes = tokenClassLine(step.tokens);
  if (classes) body.push(fit(` token classes ${classes}`, width));

  if (narrow) {
    body.push('');
    markSection(body, 'activity');
    body.push(rule(opts.stepDetail ? 'selected event' : 'activity · capture order', opts.stepFollow === false ? 'paused' : 'following', width));
    const primary = opts.stepDetail ? detail : activity;
    for (const line of primary) body.push(fit(line, width));
    body.push('');
    markSection(body, 'attempts');
    body.push(rule('attempts', null, width));
    for (const line of attempts) body.push(fit(line, width));
  } else if (wide) {
    body.push('');
    markSection(body, 'activity');
    body.push(rule('activity · capture order', opts.stepFollow === false ? 'paused' : 'following', width));
    for (const line of joinColumns(activity, detail, width)) body.push(fit(line, width));
    body.push('');
    markSection(body, 'attempts');
    body.push(rule('attempt history', null, width));
    for (const line of attempts) body.push(fit(line, width));
  } else {
    body.push('');
    markSection(body, 'activity');
    body.push(rule('activity · capture order', opts.stepFollow === false ? 'paused' : 'following', width));
    for (const line of activity) body.push(fit(line, width));
    body.push('');
    body.push(rule('selected event', null, width));
    for (const line of detail) body.push(fit(line, width));
    body.push('');
    markSection(body, 'attempts');
    body.push(rule('attempt history', null, width));
    for (const line of attempts) body.push(fit(line, width));
  }

  // Compatibility labels keep the old prompt/output/artifact contract visible
  // while the richer sections above add outcome, evidence, and stream detail.
  body.push('');
  markSection(body, 'outcome');
  body.push(rule('outcome and verification', null, width));
  for (const line of outcome) body.push(fit(line, width));
  body.push('');
  markSection(body, 'prompt');
  body.push(rule('prompt preview', null, width));
  for (const line of prompt) body.push(fit(line, width));
  body.push('');
  body.push(rule('task · first lines', null, width));
  for (const line of prompt.slice(0, narrow ? 4 : 2)) body.push(fit(line, width));
  if (!prompt.length) body.push(fit(` ${blank()} unavailable`, width));
  body.push('');
  body.push(rule('output', step.live === 'live' ? 'live' : 'recorded', width));
  const output = step.outcomeModel?.output ?? step.outputModel ?? {};
  if (output.available) {
    for (const line of (output.lines ?? []).slice(0, narrow ? 6 : 10)) body.push(fit(` ${line}`, width));
  } else body.push(fit(` ${output.path ? `${blank()} output is empty` : 'output unavailable'}`, width));
  body.push('');
  body.push(rule('artifacts', null, width));
  for (const line of artifacts) body.push(fit(line, width));

  const sectionHint = selectedSection === 'activity'
    ? '[↑↓ select] [Enter detail] [Space follow] [a attempts] [o outcome] [p prompt]'
    : `[↑↓ ${selectedSection === 'attempts' ? 'attempt' : 'select'}] [Tab section] [Esc back]`;
  const action = text(step.identity?.actionId, text(step.action?.id, 'step'));
  const status = statusWord(step.identity?.status);
  const verified = step.identity?.verified === true ? ' · VERIFIED' : step.identity?.verified === false ? ' · not verified' : '';
  body.push(fit(` ${sectionHint}`, width));
  const bytes = outputByteValue(step);
  const spark = step.headerSpark
    ? (width < 70
      ? ` · output ${bytes == null ? step.headerSpark : formatBytes(bytes)}`
      : ` · output ${step.headerSpark} ${bytes == null ? '' : formatBytes(bytes)}`)
    : '';
  return truncate(` ${statusIcon(step.identity?.status, spinnerFrame)} ${action} · run ${text(step.identity?.shortId, step.shortId ?? '------')} · ${status}${verified}${spark}`, width);
}

export const stepPage = renderStepPage;
