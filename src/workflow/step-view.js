// The Step page: one header, turn rows, a result card, the task's own lines,
// and two plain-word cost rows. On a wide terminal the activity takes the left
// column and result/task/cost stack on the right; the phone stacks them
// result → activity → task → cost so the answer is on top. Every string here
// comes from step-model.js; a missing field prints as a dash, never as prose.

import { cut, rule } from './dash-kit.js';
import { blank, visibleLength } from './dashboard.js';
import { glyphs, spinnerGlyph } from '../lib/glyphs.js';
import { stepClockText } from './step-model.js';

const DIVIDER = ' │ ';
const GUTTER = 12;

function number(value) {
  if (value == null || value === '' || typeof value === 'boolean') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function fit(value, width) {
  return cut(String(value ?? ''), Math.max(1, Number(width) || 1));
}

function padTo(value, width) {
  const line = String(value ?? '');
  const room = Math.max(0, Number(width) || 0) - visibleLength(line);
  return room > 0 ? `${line}${' '.repeat(room)}` : line;
}

/** `width` cells of text at most, with no ellipsis of its own. */
function crop(value, width) {
  let line = String(value ?? '');
  while (line && visibleLength(line) > width) line = line.slice(0, -1);
  return line.replace(/\s+$/, '');
}

function countList(parts) {
  return parts.filter(Boolean).join(' · ');
}

/** One line of prose: the captured text with its whitespace collapsed. */
function oneLine(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/** Word-safe wrapping: a word that cannot fit keeps its own row. */
function wrap(value, width) {
  const room = Math.max(1, Number(width) || 1);
  const rows = [];
  let current = '';
  for (const word of String(value ?? '').split(/\s+/).filter(Boolean)) {
    if (!current) {
      if (visibleLength(word) > room) rows.push(crop(word, room));
      else current = word;
      continue;
    }
    const next = `${current} ${word}`;
    if (visibleLength(next) <= room) {
      current = next;
      continue;
    }
    rows.push(current);
    current = visibleLength(word) > room ? (rows.push(crop(word, room)), '') : word;
  }
  if (current) rows.push(current);
  return rows.length ? rows : [''];
}

/** A right-aligned tail: the line keeps its left edge and its right marker. */
function alignRight(left, right, width) {
  const leftText = String(left ?? '');
  const rightText = String(right ?? '');
  const room = Math.max(1, Number(width) || 1) - visibleLength(rightText);
  if (visibleLength(leftText) >= room) return fit(`${leftText} ${rightText}`, width);
  return `${leftText}${' '.repeat(room - visibleLength(leftText))}${rightText}`;
}

/**
 * The design's layout numbers: two columns at 160+ (left = width − 68, right
 * 65) and at 120 (right 40), stacking like the phone when the left column
 * would drop under 72.
 */
export function stepLayout(width) {
  const cols = Math.max(20, Number(width) || 120);
  if (cols >= 160) return { twoColumn: true, left: cols - 68, right: 65, phone: false };
  if (cols - 43 >= 72) return { twoColumn: true, left: cols - 43, right: 40, phone: false };
  return { twoColumn: false, left: cols, right: cols, phone: true };
}

function combineColumns(leftLines, rightLines, { left, right }) {
  const rows = [];
  const count = Math.max(leftLines.length, rightLines.length);
  for (let index = 0; index < count; index += 1) {
    const leftText = fit(leftLines[index] ?? '', left);
    const rightText = fit(rightLines[index] ?? '', right);
    rows.push(`${padTo(leftText, left)}${DIVIDER}${rightText}`);
  }
  return rows;
}

// --- the header, said once ------------------------------------------------

function shortVerdict(verdictText) {
  return /^verified by the workflow/i.test(String(verdictText ?? '')) ? 'verified' : verdictText;
}

/** The verdict mark the terminal can draw: ascii mode has no `✓` or `●`. */
function stateGlyph(state) {
  const table = glyphs();
  if (state === 'ok') return table.ok;
  if (state === 'fail') return table.fail;
  return table.ongoing;
}

function headerIdentityLine(header, { phone, nowMs = null }) {
  const parts = [header.actionId, header.shortId, header.status];
  if (header.running) {
    if (!phone) parts.push(header.attemptText);
    if (header.activeText) parts.push(header.activeText);
    if (header.turnNumber) parts.push(`turn ${header.turnNumber}`);
    if (!phone) {
      if (header.lastEventClock) {
        parts.push(`last event ${header.lastEventClock} HKT${lastEventAge(header, nowMs)}`);
      }
      if (header.following) parts.push(`following ${glyphs().ongoing}`);
    }
  } else {
    if (header.verdictText) parts.push(phone ? shortVerdict(header.verdictText) : header.verdictText);
    if (!phone && header.attemptText) parts.push(header.attemptText);
  }
  return `${stateGlyph(header.state)} ${parts.filter(Boolean).join(' · ')}`;
}

/** `, 3s ago` — the age of the newest captured event, or nothing. */
function lastEventAge(header, nowMs) {
  const at = Number(header?.lastEventMs);
  const now = Number(nowMs);
  if (!Number.isFinite(at) || !Number.isFinite(now)) return '';
  return `, ${stepClockText(Math.max(0, now - at)) ?? '0s'} ago`;
}

function headerClockText(header, { phone }) {
  if (phone) {
    if (header.running) return header.startedClock ? `since ${header.startedClock} HKT` : null;
    return countList([
      header.clockText,
      header.startedClock && header.finishedClock ? `${header.startedClock}→${header.finishedClock}` : null,
    ]);
  }
  if (header.running) return countList([header.startedClock ? `started ${header.startedClock} HKT` : null, header.dateText]);
  return countList([
    header.clockText,
    header.startedClock && header.finishedClock ? `${header.startedClock} → ${header.finishedClock} HKT` : null,
    header.dateText,
  ]);
}

function headerMetaLine(header, { phone }) {
  // The level slot keeps its dash when the attempt recorded none, so a missing
  // effort is visible rather than silently absent; `reasoning` only prints when
  // there is a record behind it.
  const effort = header.effort ? (phone ? header.effort : `${header.effort} effort`) : '—';
  return phone
    ? countList([header.pool, header.model, effort])
    : countList([
      header.pool,
      header.model,
      effort,
      header.reasoning ? `reasoning ${header.reasoning}` : null,
    ]);
}

function headerLines(presentation, { width, phone }) {
  const header = presentation.header;
  const lines = [];
  const purpose = oneLine(header.purpose ?? '');
  if (purpose) {
    const rows = wrap(purpose, Math.max(1, width - 1));
    rows.slice(0, phone ? 2 : Infinity).forEach((row) => lines.push(` ${row}`));
  }
  const meta = headerMetaLine(header, { phone });
  const clock = headerClockText(header, { phone });
  if (phone) lines.push(` ${oneLine(countList([meta, clock]))}`);
  else lines.push(alignRight(` ${meta}`, clock ?? '', width));
  if (!phone && header.route) lines.push(` route  ${oneLine(header.route)}`);
  return lines;
}

// --- activity: the turns --------------------------------------------------

function activityCounts(totals, { phone, running, compact = phone }) {
  const turns = totals.turns ?? 0;
  return countList([
    `${turns} turn${turns === 1 ? '' : 's'}${running && !phone ? ' so far' : ''}`,
    compact ? `${totals.commands} cmds` : `${totals.commands} command${totals.commands === 1 ? '' : 's'}`,
    `${totals.edits} edit${totals.edits === 1 ? '' : 's'}`,
    compact ? `${totals.errors} err` : `${totals.errors} error${totals.errors === 1 ? '' : 's'}`,
  ]);
}

/** The overview's default lens reads `turns`; the detail log reads `all`. */
function filterLabel(presentation, view) {
  const filter = presentation.activity.filter ?? 'all';
  return view === 'overview' && filter === 'all' ? 'turns' : filter;
}

function activityTitle(presentation, { phone, view, compact }) {
  const activity = presentation.activity;
  const totals = { ...activity.totals, turns: activity.turns.length };
  if (activity.running && phone) {
    return countList([
      `${totals.turns} turn${totals.turns === 1 ? '' : 's'}`,
      `showing ${filterLabel(presentation, view)}`,
    ]);
  }
  return activityCounts(totals, { phone, running: activity.running, compact });
}

/**
 * The activity rule ends with its one filter control; the follow marker owns
 * the last cells of the rule while the step runs (rule 9). The reserved tail
 * keeps the control in the same place whether or not it is following.
 */
function activityRule(title, suffix, width, { following }) {
  if (!suffix) return rule(title, null, width);
  // The control is the first thing to shorten when the column cannot hold it,
  // then the dashes that follow it — the follow marker is the last to go, and
  // only because the header line already carries it. The counts in the title
  // never shrink.
  const tails = following
    ? [`── following ${glyphs().ongoing}`, `── ${glyphs().ongoing}`, '──────', '──']
    : ['──────────', '──────', '──'];
  for (const tail of tails) {
    for (const candidate of [suffix, suffix.replace(/ · t to change$/, ''), null]) {
      if (!candidate) break;
      const head = `── ${title} `;
      const middle = ` ${candidate} `;
      const fill = width - visibleLength(head) - visibleLength(middle) - visibleLength(tail);
      if (fill >= 3) return `${head}${'─'.repeat(fill)}${middle}${tail}`;
    }
  }
  return rule(title, null, width);
}

function turnHead(turn, { mark }) {
  return `${mark}${String(turn.number).padStart(2, ' ')}  ${turn.clock ?? '—:—'}  `;
}

const TOOL_ROW_LIMIT = 3;

function toolRowCategory(tool) {
  if (tool?.command === true) return 'command';
  const kind = String(tool?.kind ?? '').trim().toLowerCase().replace(/[_-]+/g, ' ');
  if (['write', 'edit', 'multiedit', 'notebookedit', 'file change', 'apply patch', 'write file', 'edit file'].includes(kind)) {
    return 'edit';
  }
  return 'tool';
}

function toolRowNoun(rows) {
  const categories = new Set((rows ?? []).map(toolRowCategory));
  const category = categories.size === 1 ? [...categories][0] : 'tool';
  const count = rows?.length ?? 0;
  if (category === 'command') return `command${count === 1 ? '' : 's'}`;
  if (category === 'edit') return `edit${count === 1 ? '' : 's'}`;
  return `tool${count === 1 ? '' : 's'}`;
}

function boundedPage(value, maxPage) {
  const parsed = number(value);
  return parsed == null ? 0 : Math.max(0, Math.min(Math.floor(parsed), maxPage));
}

/**
 * Return one page of a turn's atomic rows. Page zero is the newest window;
 * each increment moves one complete window towards older rows. The model
 * keeps in-flight rows at the end of `toolRows`; retain that invariant here so
 * the newest page always leaves a running row as its final visible row.
 */
export function toolRowWindow(turn, {
  limit = TOOL_ROW_LIMIT,
  page = 0,
  following = false,
  running = false,
} = {}) {
  const size = Math.max(1, Number(limit) || TOOL_ROW_LIMIT);
  const rows = Array.isArray(turn?.toolRows) ? turn.toolRows.filter(Boolean) : [];
  const captureOrder = rows.map((tool, position) => ({ tool, position })).sort((left, right) => {
    const leftIndex = number(left.tool.index);
    const rightIndex = number(right.tool.index);
    if (leftIndex != null && rightIndex != null && leftIndex !== rightIndex) return leftIndex - rightIndex;
    return left.position - right.position;
  }).map(({ tool }) => tool);
  const ordered = captureOrder.filter((tool) => !tool.inFlight).concat(captureOrder.filter((tool) => tool.inFlight));
  const maxPage = Math.max(0, Math.ceil(ordered.length / size) - 1);
  const selectedPage = running && following ? 0 : boundedPage(page, maxPage);
  const end = Math.max(0, ordered.length - (selectedPage * size));
  const start = Math.max(0, end - size);
  return {
    rows: ordered.slice(start, end),
    earlierRows: ordered.slice(0, start),
    earlierCount: start,
    newerCount: ordered.length - end,
    page: selectedPage,
    pageCount: maxPage + 1,
    limit: size,
  };
}

function turnRowLines(turn, { width, phone, spinnerFrame = 0, toolPage = 0, following = false, running = false }) {
  const room = Math.max(1, width - GUTTER);
  const indent = ' '.repeat(GUTTER);
  const rows = [];
  if (turn.expanded) {
    // Enter prints the whole response, then the counts with the collapse hint;
    // the tool rows carry their clock and the duration the pair measured.
    const body = wrap(oneLine(turn.text), room);
    (body.length ? body : ['response summary unavailable']).forEach((line, index) => {
      rows.push(index === 0 ? `${turnHead(turn, { mark: glyphs().started })}${line}` : `${indent}${line}`);
    });
    rows.push(`${indent}${turn.countsText} · Esc closes`);
    const window = toolRowWindow(turn, {
      limit: TOOL_ROW_LIMIT,
      page: toolPage,
      following,
      running,
    });
    if (window.earlierCount) {
      rows.push(`${indent}↑ ${window.earlierCount} earlier ${toolRowNoun(window.earlierRows)} · Space page up`);
    }
    const shownTools = window.rows;
    for (const tool of shownTools) {
      if (tool.inFlight) {
        const elapsed = tool.durationText ? `${tool.durationText}  ` : '';
        rows.push(fit(`${indent}${spinnerGlyph(spinnerFrame)} running ${elapsed}${tool.text}`, width));
        continue;
      }
      const durationText = tool.durationText;
      const label = tool.command ? `$ ${tool.text}` : tool.text;
      const labelRoom = Math.max(8, room - (durationText ? visibleLength(durationText) + 3 : 0));
      const labelLine = `${indent}${tool.clock ?? '—:—:—'}  ${fit(label, labelRoom)}`;
      rows.push(durationText ? alignRight(labelLine, durationText, width) : fit(labelLine, width));
    }
    return rows;
  }
  const body = wrap(oneLine(turn.text), room);
  const first = body[0] ?? 'response summary unavailable';
  if (turn.resultMarked) {
    // Rule 4: the last turn is the result, so the row names it and points at
    // the report instead of printing it twice.
    const lead = oneLine(String(turn.text ?? '').split(/\r?\n/)[0]) || first;
    rows.push(`${turnHead(turn, { mark: ' ' })}${lead}`);
    rows.push(`${indent}→ the report, shown under result`);
    return rows;
  }
  const countTail = ` · ${turn.countsText}`;
  if (phone) {
    // Two response rows on the phone, then the counts on their own row; a
    // response longer than two rows is cut with `…` like the desk's.
    const cut2 = body.length > 2;
    rows.push(`${turnHead(turn, { mark: ' ' })}${first}`);
    if (body.length > 1) {
      rows.push(`${indent}${cut2 ? `${crop(body[1], room - 1)}…` : body[1]}`);
    } else if (cut2) {
      rows.push(`${indent}…`);
    }
    rows.push(`${indent}${turn.countsText}`);
    return rows;
  }
  // Desktop keeps the counts at the end of the last response line, truncating
  // the text with `…` to make room.
  if (body.length <= 2) {
    if (body.length === 1) {
      rows.push(`${turnHead(turn, { mark: ' ' })}${first}${countTail}`);
      return rows;
    }
    rows.push(`${turnHead(turn, { mark: ' ' })}${first}`);
    rows.push(`${indent}${body[1] ?? ''}${countTail}`.replace(/\s+$/, ''));
    return rows;
  }
  const room2 = Math.max(1, room - visibleLength(countTail));
  const second = body[1] ?? '';
  let truncated = '';
  for (const word of second.split(' ')) {
    const next = truncated ? `${truncated} ${word}` : word;
    if (visibleLength(next) > Math.max(1, room2 - 1)) break;
    truncated = next;
  }
  rows.push(`${turnHead(turn, { mark: ' ' })}${first}`);
  rows.push(`${indent}${truncated ? `${truncated}…` : '…'}${countTail}`);
  return rows;
}

function activityLines(presentation, {
  width,
  phone,
  view,
  compact,
  spinnerFrame = 0,
  toolPage = 0,
}) {
  const activity = presentation.activity;
  const title = `activity · ${activityTitle(presentation, { phone, view, compact })}`;
  const lines = [];
  if (!activity.available) {
    lines.push(rule(title, null, width));
    lines.push(fit(` ${activity.reason ?? 'event stream unavailable'}.`, width));
    lines.push(fit(' turns, tools, and event timing cannot be reconstructed.', width));
    return lines;
  }
  // One filter control, and the follow marker only while the step runs
  // (rule 9): a finished page has nothing to follow.
  const suffix = phone ? null : `showing ${filterLabel(presentation, view)} · t to change`;
  lines.push(activityRule(title, suffix, width, { following: activity.running && activity.following }));
  if (phone && activity.running) lines.push(fit(' ↑ earlier turns', width));
  if (!activity.turns.length) {
    lines.push(fit(` no response turns captured · ${activity.events} atomic events`, width));
    return lines;
  }
  for (const turn of activity.turns) {
    for (const row of turnRowLines(turn, {
      width,
      phone,
      spinnerFrame,
      toolPage,
      following: Boolean(activity.following),
      running: Boolean(activity.running),
    })) lines.push(fit(row, width));
  }
  return lines;
}

function nowLines(presentation, { width, nowMs = null }) {
  const activity = presentation.activity;
  const header = presentation.header;
  const totals = { ...activity.totals };
  const title = `now · ${activity.events} events · ${countList([
    `${totals.commands} cmds`,
    `${totals.edits} edits`,
    `${totals.errors} err`,
  ])}`;
  const lines = [rule(title, null, width)];
  const last = header.lastEventClock
    ? `last event ${header.lastEventClock}${lastEventAge(header, nowMs)}${header.following ? ` · following ${glyphs().ongoing}` : ''}`
    : 'no captured event yet';
  lines.push(fit(` ${last}`, width));
  return lines;
}

// --- result: the summary card --------------------------------------------

function resultTitle(presentation, { phone }) {
  const result = presentation.result;
  const verification = result.verification ?? {};
  if (result.running) return 'not yet';
  if (phone) {
    if (verification.total) {
      return `${verification.complete ? 'verified by the workflow' : 'not verified'} ${verification.passed}/${verification.total}`;
    }
    return result.title;
  }
  return countList([
    result.title,
    verification.total
      ? `${verification.complete ? 'verified' : 'not verified'} ${verification.passed}/${verification.total}`
      : null,
  ]);
}

function labelRow(label, value, { width, pad, gap }) {
  const gutter = ` ${label.padEnd(pad)}${' '.repeat(gap)}`;
  const room = Math.max(1, width - visibleLength(gutter));
  const rows = [];
  const wrapped = wrap(value, room);
  (wrapped.length ? wrapped : ['—']).forEach((line, index) => {
    rows.push(index === 0 ? `${gutter}${line}` : `${' '.repeat(visibleLength(gutter))}${line}`);
  });
  return rows;
}

function reportRows(lines, { limit, width }) {
  const room = Math.max(1, width - 1);
  const all = [];
  for (const line of lines) {
    for (const piece of wrap(line, room)) all.push(` ${piece}`);
  }
  if (all.length <= limit) return all;
  // The card is a summary: the last visible row says the report goes on.
  const shown = all.slice(0, limit);
  shown[limit - 1] = `${crop(shown[limit - 1], room - 1).replace(/[,\s]+$/, '')}…`;
  return shown;
}

/** `N` cells of detail, joined with ` · ` and filled across the rows that fit. */
function detailRows(details, room, indent) {
  const rows = [];
  let current = '';
  for (const detail of details) {
    const next = current ? `${current} · ${detail}` : detail;
    if (visibleLength(next) > room && current) {
      rows.push(current);
      current = detail;
      continue;
    }
    current = next;
  }
  if (current) rows.push(current);
  return rows.map((row) => `${indent}${row}`);
}

function resultLines(presentation, { width, phone, detail }) {
  const result = presentation.result;
  const lines = [];
  lines.push(rule(`result · ${resultTitle(presentation, { phone })}`, null, width));
  if (result.running) {
    const attempt = result.attemptNumber == null ? 'attempt running' : `attempt ${result.attemptNumber} running`;
    lines.push(fit(` ${attempt} · ${result.events} events so far`, width));
    if (result.lastResponse) {
      // The clock and the response keep the design's two spaces between them.
      const prefix = `last response ${result.lastResponse.clock ?? '—'}  `;
      const body = wrap(oneLine(result.lastResponse.text), Math.max(1, width - 1 - prefix.length));
      body.slice(0, 2).forEach((line, index) => lines.push(` ${index ? '  ' : ''}${index ? line : `${prefix}${line}`}`));
    }
    // An out file already written to still shows what it says so far.
    if ((result.reportLines ?? []).length) lines.push(...reportRows(result.reportLines, { limit: 2, width }));
    return lines;
  }
  const card = phone ? { pad: 7, gap: 1 } : { pad: 7, gap: 2 };
  // A step that stopped without a report still says why it stopped.
  if (result.failure) lines.push(...labelRow('failed', result.failure, { width, ...card }).slice(0, 2));
  lines.push(...reportRows(result.reportLines ?? [], { limit: 3, width }));
  if (!(result.reportLines ?? []).length) lines.push(fit(' no report was written for this step', width));
  const asks = result.asks ?? [];
  if (asks.length) lines.push(...labelRow('asks', asks.join(' '), { width, ...card }).slice(0, 2));
  if ((result.changed ?? []).length) {
    lines.push(...labelRow('changed', result.changed[0], { width, ...card }));
    const indent = ' '.repeat(phone ? 9 : 10);
    for (const path of result.changed.slice(1, 3)) lines.push(fit(`${indent}${path}`, width));
    if (result.changed.length > 3) lines.push(fit(`${indent}… ${result.changed.length - 3} more paths`, width));
  }
  // Only the artifacts this step actually left are named, so a missing stream
  // or diff is absent rather than implied.
  const parts = [
    result.artifacts?.task ? 'task' : null,
    result.artifacts?.output ? 'out' : null,
    result.artifacts?.stream ? (result.streamEvents ? `stream (${result.streamEvents} events)` : 'stream') : null,
    result.artifacts?.diff ? 'diff' : null,
  ].filter(Boolean);
  const names = ['task', 'out', 'stream', 'diff'].filter((name) => parts.some((part) => part.startsWith(name)));
  if (phone) {
    lines.push(fit(` ${'files'.padEnd(7)} ${result.runDirShort ? `${result.runDirShort}/` : '—'} ${names.join(' · ') || '—'}`, width));
  } else {
    lines.push(...labelRow('files', result.runDir ?? '—', { width, ...card }));
    lines.push(fit(`          ${parts.join(' · ') || 'no artifact paths recorded'}`, width));
  }
  if (detail) {
    for (const [name, path] of Object.entries(result.fullPaths ?? {})) {
      if (path) lines.push(...labelRow(name, path, { width, pad: 7, gap: 2 }));
    }
  }
  if (!phone && result.reportBytesText) lines.push(fit(` Enter on result: the full report, ${result.reportBytesText}`, width));
  return lines;
}

// --- task: what was asked ------------------------------------------------

function taskLines(presentation, { width, phone }) {
  const task = presentation.task;
  const title = countList(['task', task.kind, task.lane ? (phone ? task.lane : `${task.lane} lane`) : null]);
  const lines = [rule(title, null, width)];
  const rows = [];
  for (const line of task.promptLines ?? []) {
    for (const piece of wrap(oneLine(line), Math.max(1, width - 1))) rows.push(` ${piece}`);
  }
  if (rows.length > 3) rows[2] = `${crop(rows[2], width - 1)}…`;
  if (rows.length) lines.push(...rows.slice(0, 3));
  else lines.push(fit(' task unavailable; no task file was captured.', width));
  const label = phone ? { pad: 6, gap: 1 } : { pad: 7, gap: 1 };
  if ((task.owns ?? []).length) lines.push(...labelRow('owns', task.owns.join(' · '), { width, ...label }).slice(0, 2));
  if ((task.after ?? []).length) lines.push(...labelRow('after', task.after.join(' · '), { width, ...label }).slice(0, 1));
  if (!phone && (task.affects ?? []).length) lines.push(...labelRow('affects', task.affects.join(' · '), { width, ...label }).slice(0, 2));
  if (!phone) {
    const bytes = task.bytes ?? {};
    const full = number(bytes.authorPrompt ?? bytes.output);
    const wrapper = number(bytes.taskFile);
    if (full != null || wrapper != null) {
      const parts = [
        full == null ? null : `full text ${(full / 1000).toFixed(1)} KB`,
        wrapper == null ? null : `kernel wrapper ${(wrapper / 1000).toFixed(1)} KB`,
      ].filter(Boolean);
      lines.push(fit(` Enter on task: ${parts.join(' · ')}`, width));
    }
  }
  return lines;
}

// --- cost: two rows, plain words ----------------------------------------

function costLines(presentation, { width, phone }) {
  const cost = presentation.cost;
  const labelPad = phone ? 11 : 12;
  const lines = [rule('cost', null, width)];
  const rows = cost.rows ?? [];
  if (cost.running && rows.every((row) => row.unknown)) {
    lines.push(fit(` ${cost.basisLine ?? 'measured when the attempt finishes'}`, width));
    return lines;
  }
  for (const row of rows) {
    // A pool name longer than the design's gutter keeps its whole label and
    // pushes its own amount, rather than being silently cut.
    const gutter = ` ${row.label.padEnd(Math.max(labelPad, visibleLength(row.label) + 1))}`;
    // An amount that needs more than the design's eight cells (a sub-cent
    // estimate) keeps all of it, and always one space before its basis.
    const amount = padTo(row.amount ?? '—', Math.max(8, visibleLength(row.amount ?? '—') + 1));
    if (phone) {
      // One row per pool on the phone: the amount and the two plain words that
      // say where it came from, with the classes left to the desk layout.
      lines.push(fit(`${gutter}${amount}${row.phoneText ?? row.headline ?? ''}`.replace(/\s+$/, ''), width));
      continue;
    }
    lines.push(fit(`${gutter}${amount}${row.headline ?? ''}`.replace(/\s+$/, ''), width));
    const indent = ' '.repeat(visibleLength(gutter));
    lines.push(...detailRows(row.details ?? [], Math.max(1, width - visibleLength(indent)), indent));
  }
  if (!phone && cost.basisLine) lines.push(fit(` ${cost.basisLine}`, width));
  return lines;
}

// --- detail: today's capture-order log -----------------------------------

function technicalValue(value) {
  if (value == null) return blank();
  if (typeof value === 'string') return value.replace(/\s+/g, ' ');
  try { return JSON.stringify(value); } catch { return String(value); }
}

function detailLines(step, presentation, { width, phone, view }) {
  const activity = step.activity ?? {};
  const filter = filterLabel(presentation, view);
  const events = activity.visibleDetailEvents ?? activity.visibleEvents ?? [];
  const suffix = phone ? null : `showing ${filter} · t to change`;
  const lines = [activityRule(`detail · today's capture-order log · ${filter} · ${events.length} events`, suffix, width, { following: false })];
  if (!activity.available) {
    lines.push(fit(` ${activity.reason ?? 'event stream unavailable'}.`, width));
    lines.push(fit(' every technical field is unavailable without a structured stream.', width));
    return lines;
  }
  if (!events.length) {
    lines.push(fit(` no captured events for today · filters ${filter}`, width));
    return lines;
  }
  for (const event of events) {
    const head = countList([
      `seq ${technicalValue(event.seq)}`,
      event.at ? oneLine(String(event.at)) : null,
      technicalValue(event.source),
      technicalValue(event.providerType),
    ]);
    lines.push(fit(` ${head}`, width));
    const fields = [
      ['kind', technicalValue(event.kind)],
      ['status', technicalValue(event.status)],
      ['eventId', technicalValue(event.eventId)],
      ['turnId', technicalValue(event.turnId)],
      ['toolCallId', technicalValue(event.toolCallId)],
      ['provider timestamp', technicalValue(event.providerAt)],
      ['duration', technicalValue(event.durationMs)],
      ['usage', technicalValue(event.usage)],
      ['parent/subagent', `${technicalValue(event.parentId)}/${technicalValue(event.subagentId)}`],
      ['arguments', technicalValue(event.arguments)],
      ['result', technicalValue(event.result)],
    ];
    const halves = phone ? [fields] : [fields.slice(0, 6), fields.slice(6)];
    for (const half of halves) {
      const row = half.map(([name, value]) => `${name} ${value}`).join(' · ');
      for (const piece of wrap(row, Math.max(1, width - 2))) lines.push(fit(`  ${piece}`, width));
    }
    for (const piece of wrap(`summary: ${technicalValue(event.summary ?? 'summary unavailable')}`, Math.max(1, width - 2))) {
      lines.push(fit(`  ${piece}`, width));
    }
  }
  return lines;
}

// --- the page -------------------------------------------------------------

function footerText(presentation, { phone, view }) {
  // The design prints the follow hint whether or not the step is live; with
  // nothing to follow the key simply has nothing to do.
  const follow = ' · f follow';
  if (view === 'detail') {
    return phone
      ? 'Enter event · v overview · t filter · ? help'
      : `Enter event detail · Esc close · v overview (turns) · t filter${follow} · ? help`;
  }
  return phone
    ? 'Enter turn · v detail · t filter · ? help'
    : `Enter expand turn · Esc close · v detail (every event) · t filter${follow} · ? help`;
}

/** Render the Step page: one header, then the blocks the design record fixes. */
export function renderStepPage(step, opts = {}, body) {
  const width = Math.max(20, Number(opts.width) || 120);
  if (!body || typeof body.push !== 'function') return '';
  const presentation = step?.presentation ?? null;
  if (!presentation) {
    if (!step?.identity && !step?.agent) {
      body.push(fit(' no step selected; identity unavailable', width));
      return ' pending · no step selected';
    }
    body.push(fit(' step presentation unavailable', width));
    return fit(` Step ${step?.identity?.actionId ?? 'step'}`, width);
  }
  const view = opts.stepDetail === true
    ? 'detail'
    : (opts.stepView ?? opts.view ?? step.view ?? 'overview') === 'detail' ? 'detail' : 'overview';
  const layout = stepLayout(width);
  const phone = layout.phone;
  // "3s ago" is a fact about this screen, so the view draws it from the clock
  // it was given (or its own) rather than from a stored string.
  const nowMs = Number.isFinite(Number(opts.nowMs)) ? Number(opts.nowMs) : Date.now();
  const headerLine = fit(` ${headerIdentityLine(presentation.header, { phone, nowMs })}`, width);

  // The shell's body builder takes one line at a time.
  for (const line of headerLines(presentation, { width, phone })) body.push(fit(line, width));
  body.push('');

  const columnWidth = layout.twoColumn ? layout.right : width;
  const activityWidth = layout.twoColumn ? layout.left : width;
  const activityColumn = view === 'detail'
    ? detailLines(step, presentation, { width: activityWidth, phone, view })
    : activityLines(presentation, {
      width: activityWidth,
      phone,
      view,
      compact: phone || width < 160,
      spinnerFrame: opts.spinnerFrame ?? 0,
      toolPage: opts.stepToolPage ?? opts.stepToolPageIndex ?? opts.toolPage ?? opts.toolPageIndex ?? 0,
    });
  const resultColumn = resultLines(presentation, { width: columnWidth, phone: phone || !layout.twoColumn, detail: view === 'detail' });
  const taskColumn = taskLines(presentation, { width: columnWidth, phone: phone || !layout.twoColumn });
  const costColumn = costLines(presentation, { width: columnWidth, phone: phone || !layout.twoColumn });

  body.anchor ??= {};
  body.anchor.step ??= {};
  const anchor = body.anchor.step;

  if (layout.twoColumn) {
    // Desktop: activity left, result → task → cost right.
    const right = resultColumn.concat([''], taskColumn, [''], costColumn);
    anchor.activity = 2;
    anchor.result = 2;
    anchor.task = resultColumn.length + 2;
    anchor.cost = resultColumn.length + taskColumn.length + 4;
    for (const line of combineColumns(activityColumn, right, layout)) body.push(line);
  } else {
    // Phone: while the step runs the newest captured fact leads (`now`), then
    // the activity; otherwise the answer leads. Task and cost close the page.
    const first = presentation.activity.running ? nowLines(presentation, { width, nowMs }) : resultColumn;
    anchor.result = 2;
    for (const line of first) body.push(fit(line, width));
    body.push('');
    anchor.activity = first.length + 3;
    for (const line of activityColumn) body.push(fit(line, width));
    body.push('');
    anchor.task = first.length + activityColumn.length + 4;
    for (const line of taskColumn) body.push(fit(line, width));
    body.push('');
    anchor.cost = first.length + activityColumn.length + taskColumn.length + 5;
    for (const line of costColumn) body.push(fit(line, width));
  }
  // Compatibility jumps map the retired sections into the merged blocks.
  anchor.outcome = anchor.result;
  anchor.prompt = anchor.task;
  anchor.attempts = anchor.result;
  body.push(fit(` ${footerText(presentation, { phone, view })}`, width));
  return headerLine;
}

export const stepPage = renderStepPage;
