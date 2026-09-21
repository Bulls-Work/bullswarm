// The Step page: one header, turn rows, a result card, the task's own lines,
// and two plain-word cost rows. On a wide terminal the activity takes the left
// column and result/task/cost stack on the right; the phone stacks them
// result → activity → task → cost so the answer is on top. Every string here
// comes from step-model.js; a missing field prints as a dash, never as prose.

import { cut, rule, seriesColor } from './dash-kit.js';
import { blank, dimText, inverseText, strong, tint, visibleLength } from './dashboard.js';
import { glyphs, spinnerGlyph } from '../lib/glyphs.js';
import { stepClockText } from './step-model.js';

const DIVIDER = ' │ ';
const GUTTER = 12;

// Keep styling at cell boundaries.  `dimText` takes a width because it is
// also used for clipped dashboard rows; these small wrappers give it the
// exact visible width of the cell so it never adds or removes text here.
/** A glyph used inside a RegExp: ASCII glyphs such as `*` are quantifiers. */
const escapeRegExp = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function dimCell(value) {
  const text = String(value ?? '');
  return text ? dimText(text, Math.max(1, visibleLength(text))) : text;
}

function statusColor(status) {
  const value = String(status ?? '').toLowerCase();
  if (['succeeded', 'success', 'completed', 'complete', 'done', 'verified'].includes(value)) return 'green';
  if (['running', 'started', 'start', 'in_progress', 'in-progress', 'queued'].includes(value)) return 'amber';
  if (['failed', 'failure', 'error', 'interrupted', 'cancelled', 'canceled', 'blocked'].includes(value)) return 'red';
  if (value.startsWith('verified by the workflow')) return 'green';
  if (value.startsWith('not verified')) return 'red';
  return null;
}

function paintStatus(value, status = value) {
  const role = statusColor(status);
  return role ? tint(value, role) : dimCell(value);
}

function paintRule(line) {
  return String(line ?? '').replace(/─+/g, (dashes) => dimCell(dashes));
}

function paintErrorCounts(value) {
  const text = String(value ?? '');
  const matcher = /\b[1-9]\d* (?:errors?|err)\b/g;
  let cursor = 0;
  let out = '';
  for (const match of text.matchAll(matcher)) {
    out += text.slice(cursor, match.index);
    out += tint(match[0], 'red');
    cursor = match.index + match[0].length;
  }
  return cursor ? `${out}${text.slice(cursor)}` : text;
}

function dimCounts(value) {
  const text = String(value ?? '');
  const matcher = /\b[1-9]\d* (?:errors?|err)\b/g;
  let cursor = 0;
  let out = '';
  for (const match of text.matchAll(matcher)) {
    out += dimCell(text.slice(cursor, match.index));
    out += tint(match[0], 'red');
    cursor = match.index + match[0].length;
  }
  return cursor ? `${out}${dimCell(text.slice(cursor))}` : dimCell(text);
}

function paintLabelRow(line, label) {
  const prefix = ` ${label}`;
  if (!String(line).startsWith(prefix)) return line;
  return ` ${dimCell(label)}${String(line).slice(prefix.length)}`;
}

function paintMoney(value) {
  const text = String(value ?? '');
  if (!text) return text;
  const glyph = text.match(/^(≈|~|—)(?=\s|\$|$)/)?.[1] ?? null;
  if (!glyph) return strong(text);
  const rest = text.slice(glyph.length);
  return `${dimCell(glyph)}${rest ? strong(rest) : ''}`;
}

function paintCostLabel(label) {
  const text = String(label ?? '');
  if (!text) return text;
  if (text === 'API rate') return dimCell(text);
  const match = /^(.*?)( plan)?$/.exec(text);
  if (match?.[2]) return `${tint(match[1], seriesColor(match[1]))}${dimCell(match[2])}`;
  if (text === 'plans') return dimCell(text);
  return dimCell(text);
}

function paintCostDetails(value) {
  const text = String(value ?? '');
  if (!text) return text;
  // Detail rows are basis/token-class words.  Any amount embedded in a
  // selected-attempt detail remains an amount cell and keeps its bold face.
  return text.split(' · ')
    .map((part) => {
      const match = /(?:≈|~|—)?\s*\$[0-9]+(?:\.[0-9]+)?(?:\/mo)?/.exec(part);
      if (!match) return dimCell(part);
      const before = part.slice(0, match.index);
      const after = part.slice(match.index + match[0].length);
      return `${before ? dimCell(before) : ''}${paintMoney(match[0])}${after ? dimCell(after) : ''}`;
    })
    .join(' · ');
}

function paintResultRule(line) {
  const source = String(line ?? '');
  const out = source.replace(/not verified|verified by the workflow|verified|succeeded|completed|failed|interrupted|cancelled|running|not yet/g, (status) => {
    const role = statusColor(status);
    return role ? tint(status, role) : dimCell(status);
  });
  return paintRule(out);
}

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
  const state = header.state;
  const mark = state === 'ok' ? tint(stateGlyph(state), 'green')
    : state === 'fail' ? tint(stateGlyph(state), 'red')
      : tint(stateGlyph(state), 'amber');
  const parts = [
    header.actionId ? strong(header.actionId) : null,
    header.shortId ? strong(header.shortId) : null,
    header.status ? paintStatus(header.status) : null,
  ];
  if (header.running) {
    if (!phone && header.attemptText) parts.push(dimCell(header.attemptText));
    if (header.activeText) parts.push(dimCell(header.activeText));
    if (header.turnNumber) parts.push(dimCell(`turn ${header.turnNumber}`));
    if (!phone) {
      if (header.lastEventClock) {
        parts.push(dimCell(`last event ${header.lastEventClock} HKT${lastEventAge(header, nowMs)}`));
      }
      if (header.following) parts.push(tint(`following ${glyphs().ongoing}`, 'amber'));
    }
  } else {
    if (header.verdictText) {
      const verdict = phone ? shortVerdict(header.verdictText) : header.verdictText;
      parts.push(paintStatus(verdict, header.succeeded ? 'verified' : 'failed'));
    }
    if (!phone && header.attemptText) parts.push(dimCell(header.attemptText));
  }
  return `${mark} ${parts.filter(Boolean).join(' · ')}`;
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
  const effort = header.effort ? (phone ? header.effort : `${header.effort} effort`) : dimCell('—');
  const pool = header.pool ? tint(header.pool, seriesColor(header.pool)) : null;
  return phone
    ? countList([pool, header.model, effort])
    : countList([
      pool,
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
  if (phone) lines.push(` ${oneLine(countList([meta, clock ? dimCell(clock) : null]))}`);
  else lines.push(alignRight(` ${meta}`, clock ? dimCell(clock) : '', width));
  if (!phone && header.route) lines.push(` ${dimCell('route')}  ${oneLine(header.route)}`);
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
  const paintedTitle = paintErrorCounts(title);
  if (!suffix) return paintRule(rule(paintedTitle, null, width));
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
      const head = `── ${paintedTitle} `;
      const middle = ` ${candidate} `;
      const fill = width - visibleLength(head) - visibleLength(middle) - visibleLength(tail);
      if (fill >= 3) {
        // Colour rules: every dash run on a block rule is dim, the filter
        // control is meta, and a `following ●` marker reads as running.
        const paintedTail = paintRule(tail).replace(
          new RegExp(`following ${escapeRegExp(glyphs().ongoing)}|${escapeRegExp(glyphs().ongoing)}`),
          (mark) => tint(mark, 'amber'),
        );
        return `${dimCell('──')} ${paintedTitle} ${dimCell('─'.repeat(fill))} ${dimCell(candidate)} ${paintedTail}`;
      }
    }
  }
  return paintRule(rule(title, null, width));
}

function turnHead(turn, { mark }) {
  const paintedMark = mark === glyphs().started ? tint(mark, 'amber') : mark;
  const clock = turn.clock ?? '—:—';
  return `${paintedMark}${String(turn.number).padStart(2, ' ')}  ${dimCell(clock)}  `;
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
    rows.push(`${indent}${dimCounts(turn.countsText)} · ${dimCell('Esc closes')}`);
    const window = toolRowWindow(turn, {
      limit: TOOL_ROW_LIMIT,
      page: toolPage,
      following,
      running,
    });
    if (window.earlierCount) {
      rows.push(`${indent}${dimCell(`↑ ${window.earlierCount} earlier ${toolRowNoun(window.earlierRows)} · Space page up`)}`);
    }
    const shownTools = window.rows;
    for (const tool of shownTools) {
      if (tool.inFlight) {
        const elapsed = tool.durationText ? `${dimCell(tool.durationText)}  ` : '';
        rows.push(fit(`${indent}${tint(spinnerGlyph(spinnerFrame), 'amber')} ${tint('running', 'amber')} ${elapsed}${tool.text}`, width));
        continue;
      }
      const durationText = tool.durationText;
      const label = tool.command ? `${dimCell('$')} ${tool.text}` : tool.text;
      const labelRoom = Math.max(8, room - (durationText ? visibleLength(durationText) + 3 : 0));
      const labelLine = `${indent}${dimCell(tool.clock ?? '—:—:—')}  ${fit(label, labelRoom)}`;
      rows.push(durationText ? alignRight(labelLine, dimCell(durationText), width) : fit(labelLine, width));
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
    rows.push(`${indent}${dimCell('→ the report, shown under result')}`);
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
    rows.push(`${indent}${dimCounts(turn.countsText)}`);
    return rows;
  }
  // Desktop keeps the counts at the end of the last response line, truncating
  // the text with `…` to make room.
  if (body.length <= 2) {
    if (body.length === 1) {
      rows.push(`${turnHead(turn, { mark: ' ' })}${first}${dimCounts(countTail)}`);
      return rows;
    }
    rows.push(`${turnHead(turn, { mark: ' ' })}${first}`);
    rows.push(`${indent}${body[1] ?? ''}${dimCounts(countTail)}`.replace(/\s+$/, ''));
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
  rows.push(`${indent}${truncated ? `${truncated}…` : '…'}${dimCounts(countTail)}`);
  return rows;
}

function activityLines(presentation, {
  width,
  phone,
  view,
  compact,
  spinnerFrame = 0,
  toolPage = 0,
  cursorTurn = null,
}) {
  const activity = presentation.activity;
  const title = `activity · ${activityTitle(presentation, { phone, view, compact })}`;
  const lines = [];
  if (!activity.available) {
    lines.push(paintRule(rule(title, null, width)));
    lines.push(fit(` ${dimCell(`${activity.reason ?? 'event stream unavailable'}.`)}`, width));
    lines.push(fit(` ${dimCell('turns, tools, and event timing cannot be reconstructed.')}`, width));
    return lines;
  }
  // One filter control, and the follow marker only while the step runs
  // (rule 9): a finished page has nothing to follow.
  const suffix = phone ? null : `showing ${filterLabel(presentation, view)} · t to change`;
  lines.push(activityRule(title, suffix, width, { following: activity.running && activity.following }));
  if (phone && activity.running) lines.push(fit(` ${dimCell('↑ earlier turns')}`, width));
  if (!activity.turns.length) {
    lines.push(fit(` ${dimCell(`no response turns captured · ${activity.events} atomic events`)}`, width));
    return lines;
  }
  for (const turn of activity.turns) {
    const rows = turnRowLines(turn, {
      width,
      phone,
      spinnerFrame,
      toolPage,
      following: Boolean(activity.following),
      running: Boolean(activity.running),
    });
    // The cursor row: the head row of the turn Up/Down selected, inverse.
    rows.forEach((row, index) => {
      const line = fit(row, width);
      lines.push(index === 0 && turn.index === cursorTurn ? inverseText(line) : line);
    });
  }
  return lines;
}

function nowLines(presentation, { width, nowMs = null }) {
  const activity = presentation.activity;
  const header = presentation.header;
  const totals = { ...activity.totals };
  const title = paintErrorCounts(`now · ${activity.events} events · ${countList([
    `${totals.commands} cmds`,
    `${totals.edits} edits`,
    `${totals.errors} err`,
  ])}`);
  const lines = [paintRule(rule(title, null, width))];
  const last = header.lastEventClock
    ? `last event ${header.lastEventClock}${lastEventAge(header, nowMs)}`
    : 'no captured event yet';
  const following = header.following ? ` · following ${tint(glyphs().ongoing, 'amber')}` : '';
  lines.push(fit(` ${dimCell(last)}${following}`, width));
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
    const pieces = wrap(detail, room);
    for (const piece of pieces) {
      const next = current ? `${current} · ${piece}` : piece;
      if (visibleLength(next) > room && current) {
        rows.push(current);
        current = piece;
      } else {
        current = next;
      }
    }
  }
  if (current) rows.push(current);
  return rows.map((row) => `${indent}${row}`);
}

function resultLines(presentation, { width, phone, detail }) {
  const result = presentation.result;
  const lines = [];
  lines.push(paintResultRule(rule(`result · ${resultTitle(presentation, { phone })}`, null, width)));
  if (result.running) {
    const attempt = result.attemptNumber == null ? 'attempt running' : `attempt ${result.attemptNumber} running`;
    lines.push(fit(` ${attempt.replace(/\brunning\b/, tint('running', 'amber'))} · ${dimCell(`${result.events} events so far`)}`, width));
    if (result.lastResponse) {
      // The clock and the response keep the design's two spaces between them.
      const prefix = `last response ${result.lastResponse.clock ?? '—'}  `;
      const body = wrap(oneLine(result.lastResponse.text), Math.max(1, width - 1 - prefix.length));
      body.slice(0, 2).forEach((line, index) => lines.push(index
        ? `  ${line}`
        : ` ${dimCell(`last response ${result.lastResponse.clock ?? '—'}`)}  ${line}`));
    }
    // An out file already written to still shows what it says so far.
    if ((result.reportLines ?? []).length) lines.push(...reportRows(result.reportLines, { limit: 2, width }));
    return lines;
  }
  const card = phone ? { pad: 7, gap: 1 } : { pad: 7, gap: 2 };
  // A step that stopped without a report still says why it stopped.
  if (result.failure) {
    lines.push(...labelRow('failed', result.failure, { width, ...card }).slice(0, 2)
      .map((line) => line.startsWith(' failed')
        ? `${paintLabelRow(line, 'failed').replace(result.failure, tint(result.failure, 'red'))}`
        : line));
  }
  lines.push(...reportRows(result.reportLines ?? [], { limit: 3, width }));
  if (!(result.reportLines ?? []).length) lines.push(fit(' no report was written for this step', width));
  const asks = result.asks ?? [];
  if (asks.length) lines.push(...labelRow('asks', asks.join(' '), { width, ...card }).slice(0, 2)
    .map((line) => paintLabelRow(line, 'asks')));
  if ((result.changed ?? []).length) {
    lines.push(...labelRow('changed', result.changed[0], { width, ...card }).map((line) => paintLabelRow(line, 'changed')));
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
    lines.push(fit(` ${dimCell('files')}       ${result.runDirShort ? `${result.runDirShort}/` : '—'} ${names.join(' · ') || '—'}`, width));
  } else {
    lines.push(...labelRow('files', result.runDir ?? '—', { width, ...card }).map((line) => paintLabelRow(line, 'files')));
    lines.push(fit(`          ${parts.join(' · ') || dimCell('no artifact paths recorded')}`, width));
  }
  if (detail) {
    for (const [name, path] of Object.entries(result.fullPaths ?? {})) {
      if (path) lines.push(...labelRow(name, path, { width, pad: 7, gap: 2 }).map((line) => paintLabelRow(line, name)));
    }
  }
  if (!phone && result.reportBytesText) lines.push(fit(` ${dimCell(`Enter on result: the full report, ${result.reportBytesText}`)}`, width));
  return lines;
}

// --- task: what was asked ------------------------------------------------

function taskLines(presentation, { width, phone }) {
  const task = presentation.task;
  const title = countList(['task', task.kind, task.lane ? (phone ? task.lane : `${task.lane} lane`) : null]);
  const lines = [paintRule(rule(title, null, width))];
  const rows = [];
  for (const line of task.promptLines ?? []) {
    for (const piece of wrap(oneLine(line), Math.max(1, width - 1))) rows.push(` ${piece}`);
  }
  if (rows.length > 3) rows[2] = `${crop(rows[2], width - 1)}…`;
  if (rows.length) lines.push(...rows.slice(0, 3));
  else lines.push(fit(' task unavailable; no task file was captured.', width));
  const label = phone ? { pad: 6, gap: 1 } : { pad: 7, gap: 1 };
  if ((task.owns ?? []).length) lines.push(...labelRow('owns', task.owns.join(' · '), { width, ...label }).slice(0, 2).map((line) => paintLabelRow(line, 'owns')));
  if ((task.after ?? []).length) lines.push(...labelRow('after', task.after.join(' · '), { width, ...label }).slice(0, 1).map((line) => paintLabelRow(line, 'after')));
  if (!phone && (task.affects ?? []).length) lines.push(...labelRow('affects', task.affects.join(' · '), { width, ...label }).slice(0, 2).map((line) => paintLabelRow(line, 'affects')));
  if (!phone) {
    const bytes = task.bytes ?? {};
    const full = number(bytes.authorPrompt ?? bytes.output);
    const wrapper = number(bytes.taskFile);
    if (full != null || wrapper != null) {
      const parts = [
        full == null ? null : `full text ${(full / 1000).toFixed(1)} KB`,
        wrapper == null ? null : `kernel wrapper ${(wrapper / 1000).toFixed(1)} KB`,
      ].filter(Boolean);
      lines.push(fit(` ${dimCell(`Enter on task: ${parts.join(' · ')}`)}`, width));
    }
  }
  return lines;
}

// --- cost: two rows, plain words ----------------------------------------

function costLines(presentation, { width, phone }) {
  const cost = presentation.cost;
  const labelPad = phone ? 11 : 12;
  const title = Number(cost.attemptCount) > 1 ? `cost · ${cost.attemptCount} attempts` : 'cost';
  const lines = [paintRule(rule(title, null, width))];
  const rows = cost.rows ?? [];
  if (cost.running && rows.every((row) => row.unknown)) {
    lines.push(fit(` ${dimCell(cost.basisLine ?? 'measured when the attempt finishes')}`, width));
    return lines;
  }
  for (const row of rows) {
    // A pool name longer than the design's gutter keeps its whole label and
    // pushes its own amount, rather than being silently cut.
    const labelWidth = Math.max(labelPad, visibleLength(row.label) + 1);
    const gutter = ` ${paintCostLabel(row.label)}${' '.repeat(Math.max(0, labelWidth - visibleLength(row.label)))}`;
    // An amount that needs more than the design's eight cells (a sub-cent
    // estimate) keeps all of it, and always one space before its basis.
    const amount = padTo(paintMoney(row.amount ?? '—'), Math.max(8, visibleLength(row.amount ?? '—') + 1));
    if (phone) {
      // One row per pool on the phone: the amount and the two plain words that
      // say where it came from, with the classes left to the desk layout.
      const detail = row.phoneText ?? row.headline ?? '';
      lines.push(fit(`${gutter}${amount}${detail ? paintCostDetails(detail) : ''}`.replace(/\s+$/, ''), width));
      continue;
    }
    const headlineRoom = Math.max(1, width - visibleLength(gutter) - visibleLength(amount));
    const headlineRows = Number(cost.attemptCount) > 1
      ? wrap(row.headline ?? '', headlineRoom)
      : [row.headline ?? ''];
    lines.push(fit(`${gutter}${amount}${headlineRows[0] ? paintCostDetails(headlineRows[0]) : ''}`.replace(/\s+$/, ''), width));
    const indent = ' '.repeat(visibleLength(gutter));
    for (const headlineRow of headlineRows.slice(1)) lines.push(fit(`${indent}${paintCostDetails(headlineRow)}`, width));
    lines.push(...detailRows(row.details ?? [], Math.max(1, width - visibleLength(indent)), indent)
      .map((line) => `${indent}${paintCostDetails(line.slice(indent.length))}`));
  }
  if (!phone && cost.basisLine) lines.push(fit(` ${dimCell(cost.basisLine)}`, width));
  return lines;
}

// --- detail: today's capture-order log -----------------------------------

function technicalValue(value) {
  if (value == null) return blank();
  if (typeof value === 'string') return value.replace(/\s+/g, ' ');
  try { return JSON.stringify(value); } catch { return String(value); }
}

function detailLines(step, presentation, { width, phone, view, selectedEventIndex = null }) {
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
    const headLine = fit(` ${head}`, width);
    // Detail navigation selects the atomic event itself.  Keep the cursor on
    // the compact event header (the row a reader moves through), rather than
    // repainting its technical fields or changing any displayed text.
    lines.push(Number.isInteger(selectedEventIndex) && Number(event.index) === selectedEventIndex
      ? inverseText(headLine)
      : headLine);
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

export function stepFooterText(presentation, { phone, view }) {
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
    ? detailLines(step, presentation, {
      width: activityWidth,
      phone,
      view,
      selectedEventIndex: opts.stepSelectedEventIndex,
    })
    : activityLines(presentation, {
      width: activityWidth,
      phone,
      view,
      compact: phone || width < 160,
      spinnerFrame: opts.spinnerFrame ?? 0,
      toolPage: opts.stepToolPage ?? opts.stepToolPageIndex ?? opts.toolPage ?? opts.toolPageIndex ?? 0,
      // Only a turn the reader moved to is the cursor; an untouched page
      // draws no cursor, so turn 1 reads as plain text.
      cursorTurn: Number.isInteger(opts.stepTurnIndex) ? opts.stepTurnIndex : null,
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
  return headerLine;
}

export const stepPage = renderStepPage;
