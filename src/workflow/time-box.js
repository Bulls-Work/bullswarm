// The soft time box (0.35.2): how long a step is invited to take, the
// paragraph that says so in its task, and the `## Not done` section a worker
// that stopped at the box writes back. A box is a guide, never a limit:
// timeouts, stall detection, cancellation and routing do not read it, and
// nothing is stopped when it runs out. See
// docs/design/step-economy-0.35.2/README.md sections 1 and 2.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// History needs this many succeeded attempts before its median means anything
// (D1: the kind level too, not only the pair).
export const TIME_BOX_MIN_SAMPLES = 5;
export const TIME_BOX_FALLBACK_MINUTES = 20;
export const TIME_BOX_FLOOR_MINUTES = 10;
export const TIME_BOX_CEILING_MINUTES = 60;
export const TIME_BOX_FACTOR = 1.5;
// W = round(0.7 × B), in whole-minute arithmetic: 0.7 × 45 is 31.499… in
// binary floating point, and the wrap-up point for a 45-minute box is 32.
export function wrapUpMinutesFor(minutes) {
  return Math.floor((minutes * 7 + 5) / 10);
}
const HISTORY_TTL_MS = 10 * 60 * 1000;
const NOT_DONE_ITEM_CAP = 20;
const NOT_DONE_ITEM_CHARS = 300;

// opencode runs a slow free model: its minutes say nothing about how long the
// same work takes anywhere else, so it never feeds a default. The prefix also
// covers `opencode:*` and the older `opencode2*` pool names.
export function timeBoxExcludedPool(pool) {
  return typeof pool === 'string' && pool.startsWith('opencode');
}

function attemptMinutes(attempt) {
  if (Number.isFinite(attempt?.wallSec) && attempt.wallSec >= 0) return attempt.wallSec / 60;
  const ms = Date.parse(attempt?.finishedAt ?? '') - Date.parse(attempt?.startedAt ?? '');
  return Number.isFinite(ms) && ms >= 0 ? ms / 60_000 : null;
}

function push(map, key, value) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/**
 * The home's succeeded workflow attempts as minutes, keyed `pool|kind` and by
 * kind. Single tasks under `runs/` carry no kind and are not read. Unreadable
 * or half-written state files are skipped: history is advice, never a gate.
 */
export function readTimeBoxHistory(bullswarmDir) {
  const pairs = new Map();
  const kinds = new Map();
  const root = join(bullswarmDir, 'workflows');
  let entries = [];
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return { pairs, kinds }; }
  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = join(root, entry.name, 'state.json');
    if (!existsSync(file)) continue;
    let state;
    try { state = JSON.parse(readFileSync(file, 'utf8')); } catch { continue; }
    const kindOf = new Map((Array.isArray(state?.program?.actions) ? state.program.actions : [])
      .filter((action) => typeof action?.id === 'string' && typeof action.kind === 'string')
      .map((action) => [action.id, action.kind]));
    for (const attempt of Array.isArray(state?.attempts) ? state.attempts : []) {
      if (attempt?.status !== 'succeeded' || timeBoxExcludedPool(attempt.pool)) continue;
      const kind = kindOf.get(attempt.actionId);
      if (!kind || typeof attempt.pool !== 'string' || !attempt.pool) continue;
      const minutes = attemptMinutes(attempt);
      if (minutes === null) continue;
      push(pairs, `${attempt.pool}|${kind}`, minutes);
      push(kinds, kind, minutes);
    }
  }
  return { pairs, kinds };
}

const historyMemo = new Map();

/** `readTimeBoxHistory`, kept in memory per home for ten minutes; no file. */
export function timeBoxHistory(bullswarmDir, { now = Date.now() } = {}) {
  const cached = historyMemo.get(bullswarmDir);
  if (cached && now - cached.at < HISTORY_TTL_MS) return cached.history;
  const history = readTimeBoxHistory(bullswarmDir);
  historyMemo.set(bullswarmDir, { at: now, history });
  return history;
}

export function clearTimeBoxHistoryCache() {
  historyMemo.clear();
}

export function medianOf(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function boxFromMedian(median) {
  const rounded = Math.round((TIME_BOX_FACTOR * median) / 5) * 5;
  return Math.min(TIME_BOX_CEILING_MINUTES, Math.max(TIME_BOX_FLOOR_MINUTES, rounded));
}

function withWrapUp(box) {
  return { ...box, wrapUpMinutes: wrapUpMinutesFor(box.minutes) };
}

/**
 * The box one attempt gets. The action's `timeBox` (program defaults are
 * folded onto it at acceptance) wins, and 0 means no box at all; otherwise
 * 1.5 × the median succeeded minutes for this (pool, kind) pair when it has
 * five, else for the kind when it has five, else 20 — rounded to 5 and kept
 * within 10–60. Resolved per attempt: a retry can land on another pool.
 */
export function resolveTimeBox({ action, pool = null, history = null } = {}) {
  const authored = action?.timeBox;
  if (Number.isInteger(authored) && authored >= 0) {
    if (authored === 0) return null;
    return withWrapUp({ minutes: authored, source: 'program', n: null, medianMinutes: null });
  }
  const kind = typeof action?.kind === 'string' ? action.kind : null;
  const read = typeof history === 'function' ? history() : history;
  const pairSample = kind && pool && !timeBoxExcludedPool(pool) ? read?.pairs?.get(`${pool}|${kind}`) ?? [] : [];
  const kindSample = kind ? read?.kinds?.get(kind) ?? [] : [];
  for (const [source, sample] of [['pair', pairSample], ['kind', kindSample]]) {
    if (sample.length < TIME_BOX_MIN_SAMPLES) continue;
    const median = medianOf(sample);
    return withWrapUp({
      minutes: boxFromMedian(median), source, n: sample.length,
      medianMinutes: Math.round(median * 100) / 100,
    });
  }
  return withWrapUp({ minutes: TIME_BOX_FALLBACK_MINUTES, source: 'fallback', n: null, medianMinutes: null });
}

function clockParts(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    ...(timeZone ? { timeZone } : {}),
  }).formatToParts(new Date(ms));
  const part = (type) => parts.find((item) => item.type === type)?.value ?? '00';
  return { hh: part('hour'), mm: part('minute'), ss: part('second') };
}

/** `date +%T` for the start; `HH:MM` for the wrap-up point and the end. */
export function timeBoxClocks({ minutes, wrapUpMinutes, startedAt, timeZone = null }) {
  const startMs = Date.parse(startedAt);
  if (!Number.isFinite(startMs)) throw new TypeError('startedAt must be an ISO timestamp');
  const start = clockParts(startMs, timeZone);
  const wrap = clockParts(startMs + wrapUpMinutes * 60_000, timeZone);
  const end = clockParts(startMs + minutes * 60_000, timeZone);
  return {
    startClock: `${start.hh}:${start.mm}:${start.ss}`,
    wrapClock: `${wrap.hh}:${wrap.mm}`,
    endClock: `${end.hh}:${end.mm}`,
  };
}

/**
 * The paragraph appended to the very end of one attempt's task, worded from
 * the 2026-09-21 experiment. Work tasks end in a report with `## Done`,
 * `## Not done` and `## Suggested next step`; evidence tasks settle what they
 * have as `blocked` and add the same sections after the preflight's
 * confirmation (D7: the candidate file stays the contract).
 */
export function timeBoxParagraph({ minutes, wrapUpMinutes = wrapUpMinutesFor(minutes), startedAt, evidence = false, timeZone = null }) {
  const { startClock, wrapClock, endClock } = timeBoxClocks({ minutes, wrapUpMinutes, startedAt, timeZone });
  const opening = `Time box: ${minutes} minutes, starting at ${startClock}. It is a guide, not a hard stop. Run \`date +%T\` every few turns to keep track.`;
  if (evidence) {
    return `${opening} Judge the requirements one at a time and settle each before starting the next. `
      + `At about ${wrapUpMinutes} minutes (${wrapClock}), stop opening new lines of inspection and settle what you have. `
      + `At ${minutes} minutes (${endClock}), finish the evidence preflight with what you have: a requirement you could not finish inspecting is \`blocked\`, with what is missing as its evidence. `
      + 'Then end with the preflight\'s confirmation and three sections: `## Done`, `## Not done` and `## Suggested next step`. '
      + 'An honest `blocked` is better than running long, and much better than a guess.';
  }
  return `${opening} Work through the items in order and finish each before starting the next. `
    + `At about ${wrapUpMinutes} minutes (${wrapClock}), stop starting new work and wrap up: make what you have consistent and its tests passing. `
    + `At ${minutes} minutes (${endClock}), stop and write the report with three sections: \`## Done\`, \`## Not done\` (one line per unfinished item, or \`- none\`), and \`## Suggested next step\`. `
    + 'An honest partial report, with unfinished items listed under `## Not done`, is better than running long, and much better than calling unfinished work done.';
}

/**
 * The text and the durable record for one attempt, or null when the action
 * has no box (`timeBox: 0`). The record lands on the attempt as `timeBox`.
 */
export function timeBoxForAttempt({ action, pool = null, startedAt, evidence = false, history = null, timeZone = null }) {
  const box = resolveTimeBox({ action, pool, history });
  if (!box) return null;
  const { startClock } = timeBoxClocks({ ...box, startedAt, timeZone });
  return {
    text: timeBoxParagraph({ ...box, startedAt, evidence, timeZone }),
    record: {
      minutes: box.minutes, wrapUpMinutes: box.wrapUpMinutes, source: box.source,
      n: box.n, medianMinutes: box.medianMinutes, startClock,
    },
  };
}

const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const NOT_DONE_HEADING = /^not done:?$/i;
const LIST_ITEM = /^ ?(?:[-*+]|\d{1,9}[.)])(?:\s+(.*)|$)/;
const NOT_AN_ITEM = /^(?:none|nothing|n\/a|-|—)\.?$/i;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

function cutAtWord(text, limit) {
  if (text.length <= limit) return text;
  const room = text.slice(0, limit - 1);
  const space = room.lastIndexOf(' ');
  return `${(space > limit / 2 ? room.slice(0, space) : room).trimEnd()}…`;
}

/**
 * The items of a report's `## Not done` section: the last heading of any
 * level reading `Not done`, up to the next heading or the end. Top-level list
 * lines only; `none`, `nothing`, `n/a` and dashes are not items. `count` is
 * every item; `items` keeps the first 20, each at most 300 characters.
 * Headings inside fenced code are not headings.
 */
export function parseNotDone(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  let fence = null;
  const headings = [];
  lines.forEach((line, index) => {
    const opener = line.match(FENCE)?.[1] ?? null;
    if (fence) {
      if (opener && opener[0] === fence[0] && opener.length >= fence.length) fence = null;
      return;
    }
    if (opener) { fence = opener; return; }
    const heading = line.match(HEADING);
    if (heading) headings.push({ index, title: heading[2].trim() });
  });
  const start = headings.filter((heading) => NOT_DONE_HEADING.test(heading.title)).at(-1);
  if (!start) return { count: 0, items: [] };
  const end = headings.find((heading) => heading.index > start.index)?.index ?? lines.length;
  const found = [];
  fence = null;
  for (const line of lines.slice(start.index + 1, end)) {
    const opener = line.match(FENCE)?.[1] ?? null;
    if (fence) {
      if (opener && opener[0] === fence[0] && opener.length >= fence.length) fence = null;
      continue;
    }
    if (opener) { fence = opener; continue; }
    const item = line.match(LIST_ITEM);
    if (!item) continue;
    const said = String(item[1] ?? '').trim();
    if (!said || NOT_AN_ITEM.test(said)) continue;
    found.push(said);
  }
  return {
    count: found.length,
    items: found.slice(0, NOT_DONE_ITEM_CAP).map((item) => cutAtWord(item, NOT_DONE_ITEM_CHARS)),
  };
}

// --- display ---------------------------------------------------------------

/** `returned early · 2 not done`, or null when the attempt did not. */
export function returnedEarlyText(attempt) {
  const count = Number(attempt?.returnedEarly?.count);
  return Number.isInteger(count) && count > 0 ? `returned early · ${count} not done` : null;
}

export function returnedEarlyItems(attempt) {
  return Array.isArray(attempt?.returnedEarly?.items)
    ? attempt.returnedEarly.items.filter((item) => typeof item === 'string' && item.trim())
    : [];
}

/**
 * `box 20m · ran 34m` once the attempt ran past its box (its wall minutes,
 * rounded), `box 20m` otherwise; null when the attempt had no box.
 */
export function timeBoxText(attempt, { durationMs = null } = {}) {
  const box = Number(attempt?.timeBox?.minutes);
  if (!Number.isInteger(box) || box <= 0) return null;
  const wallMs = Number.isFinite(attempt?.wallSec) ? attempt.wallSec * 1000 : Number(durationMs);
  const ran = Number.isFinite(wallMs) && wallMs >= 0 ? Math.round(wallMs / 60_000) : null;
  return ran !== null && ran > box ? `box ${box}m · ran ${ran}m` : `box ${box}m`;
}
