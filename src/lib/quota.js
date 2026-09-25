// bullswarm quota — usage-limit detection and reset-time parsing.
//
// Doctrine:
//   Q1. A usage limit is its OWN mechanical failure kind. It is not `process`
//       (the CLI happened to exit non-zero), not `semantic` (the answer was
//       thin) and not `auth` (the credential is broken). Only a quota failure
//       knows a real reset time, and only that time is a truthful one.
//   Q2. Detection is shape-gated. Agents legitimately discuss rate limits in
//       their reports and tool output routinely contains the words; killing a
//       healthy worker for reading them costs more than a missed limit, which
//       the final-output gate catches anyway.
//   Q3. A reset is only ever a measured one: the reset the provider's own
//       message names, or the reset of the pool's own meter window
//       (decideUsageLimit). With neither, no reset is invented.
//   Q4. Zero dependencies. Named time zones resolve through Intl only.
//   Q5. A throttle is not a spent window. "Rate limit exceeded. Please wait a
//       moment and try again." asks for a wait of seconds; reading it as a
//       spent window once kept command-code out for ~4 hours while its meter
//       read 5% (2026-09). Only wording that says a usage window is exhausted
//       names a spent window; everything the table marks `throttle` is backed
//       off on the same pool.
//   Q6. A limit's reset is known in exactly two ways (decideUsageLimit): the
//       provider's line says a usage window is spent AND names when it resets,
//       or the pool's own meter reads >= QUOTA_METER_SPENT_PCT on a window
//       whose reset is still ahead. Anything else — a throttle, an overload, a
//       5xx, a window phrase with no reset — has no known reset. (A transient
//       `Rate limit exceeded` once kept claude-code out until its 5h reset
//       while its meter read 78% weekly / 48% 5h, 2026-09-21.) Every decision
//       carries the provider line, the meter reading and the reset.
//   Q7. Nothing about a pool is remembered from one step to the next (owner
//       decision, 2026-09-25): no pause, no bench, no strike. A limit goes
//       back to the caller with its reset when that is known; the next step
//       routes on the live meters, and the one fact that outlives the step is
//       the refusal marker a failed forced meter read leaves
//       (meters/registry.js), which gates routing only when its reset was
//       named or measured.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Provider phrases that mean "you have no quota left right now", each marked
 * with whether third-party services emit it too (`generic`) and whether it
 * names a spent usage window (`window`: the attempt ends as a usage limit) or
 * a momentary throttle (`throttle`: back off briefly on the same pool) —
 * the one table every exported list below is projected from.
 *
 * Deliberately excluded: bare `resets at` / `resets in` wording. A reset time
 * alone is not a limit — it appears in healthy meter reports, and treating it
 * as a signature would fail workers on pools that merely told us when their
 * window turns over. Reset wording is only ever read AFTER a signature matched.
 */
const QUOTA_SIGNATURE_TABLE = Object.freeze([
  { phrase: 'hit your session limit' },
  { phrase: 'hit your limit' },
  { phrase: 'hit your usage limit' },
  { phrase: 'usage limit reached' },
  { phrase: 'reached your usage limit' },
  { phrase: 'usage_credits_required' },
  { phrase: 'rate limit exceeded', generic: true, limit: 'throttle' },
  { phrase: 'rate_limit_exceeded', generic: true, limit: 'throttle' },
  { phrase: 'rate limited', generic: true, limit: 'throttle' },
  { phrase: 'too many requests', generic: true, limit: 'throttle' },
  { phrase: 'quota exceeded', generic: true },
  { phrase: 'exceeded your current quota' },
  { phrase: 'insufficient_quota' },
  { phrase: 'out of credits', generic: true },
].map((entry) => Object.freeze({ generic: false, limit: 'window', ...entry })));

export const DEFAULT_QUOTA_SIGNATURES = QUOTA_SIGNATURE_TABLE.map((entry) => entry.phrase);

/** Default phrases that name a spent usage window. */
export const DEFAULT_WINDOW_SIGNATURES = QUOTA_SIGNATURE_TABLE
  .filter((entry) => entry.limit === 'window')
  .map((entry) => entry.phrase);

/** Default phrases that name a momentary throttle: back off, same pool. */
export const DEFAULT_THROTTLE_SIGNATURES = QUOTA_SIGNATURE_TABLE
  .filter((entry) => entry.limit === 'throttle')
  .map((entry) => entry.phrase);

/**
 * Wording on a matched limit line that names a usage window, a quota or a
 * balance rather than request pacing. A throttle phrase that arrives with it
 * ("Rate limit exceeded: weekly usage limit reached") is a spent window.
 */
const WINDOW_WORDING =
  /\b(?:usage|session|daily|weekly|monthly|five[- ]hour|5[- ]?h(?:our)?)\s+(?:limit|quota|window|cap)\b|\bquota\b|\bcredits?\b|\bbilling\b/i;

/**
 * The longest wait a throttle may name and still be sat out on the same pool
 * in a run started by an earlier version; a wait further out moves that
 * attempt to another pool instead (`retrySamePool: false`). Runs started by
 * this version sit out at most two minutes (v2-dispatch.js
 * MARKED_THROTTLE_MAX_WAIT_MS).
 */
export const THROTTLE_MAX_WAIT_MS = 15 * 60_000;
/** Short backoffs before each same-pool retry of a throttled attempt. */
export const THROTTLE_BACKOFF_MS = Object.freeze([20_000, 60_000]);
/**
 * Same-pool retries a throttle earns before it goes on: to the caller, or to
 * another pool in a run started by an earlier version.
 */
export const MAX_THROTTLE_RETRIES = THROTTLE_BACKOFF_MS.length;

/**
 * Phrases that third-party services emit too. An agent narrates "Rate limited
 * by the GitHub API, retrying" about somebody else's quota, and that narration
 * must never kill the worker on OUR pool. These count only as a bare
 * notice: nothing may follow the phrase except punctuation, a reset/retry
 * clause, a parenthesised detail, or a number. Provider first-person wording
 * ("hit your session limit", "usage_credits_required") and connector-declared
 * phrases are not subject to this rule.
 *
 * Derived from QUOTA_SIGNATURE_TABLE's `generic: true` marker, not restated: a
 * phrase added to one hand-written list and not the other used to change quota
 * detection asymmetrically (audit C4).
 */
export const GENERIC_QUOTA_SIGNATURES = QUOTA_SIGNATURE_TABLE
  .filter((entry) => entry.generic)
  .map((entry) => entry.phrase);
const GENERIC_SET = new Set(GENERIC_QUOTA_SIGNATURES.map((s) => s.toLowerCase()));
/** What may follow a generic phrase on a bare notice line. */
const BARE_NOTICE_TAIL = /^(?:[\s.,:;!?·•\-–—|/]*(?:\(|\[|\d|resets?\b|resetting\b|reset\b|try again\b|retry\b|retrying\b|please\b|wait\b|until\b|after\b|in\s+\d|for\s+\d|back\b|available\b|limit\b|quota\b|window\b|window\b|$))/i;

function bareNotice(line, offset, needle) {
  const tail = line.slice(offset + needle.length);
  return BARE_NOTICE_TAIL.test(tail);
}

/** Longest trimmed line that can still be a provider limit notice. */
export const MAX_QUOTA_LINE_CHARS = 300;
/** A limit notice leads with the limit; prose mentions it further in. */
export const QUOTA_SIGNATURE_HEAD_CHARS = 40;
/**
 * Markdown list items, blockquotes and headings are report structure. A
 * provider limit notice is never authored as one, but an agent summarising
 * this very feature writes `- usage limit reached is now its own kind` inside
 * the head window. Such a line qualifies only if it is also error-shaped.
 */
const PROSE_LINE_PREFIX = /^(?:[-*+•]\s|>\s|#{1,6}\s|\d+[.)]\s)/;
/** Reset wording sometimes lands on the line after the limit itself. */
const QUOTA_CONTEXT_CHARS = 300;
/** A reset further out than this is a parse artifact, not a reset. */
export const MAX_RESET_AHEAD_MS = 7 * 24 * 60 * 60_000;

const DAY_MS = 24 * 60 * 60_000;

/**
 * A line that looks like a provider failure rather than source or report text.
 * Shared with `matchLikelyAuthFailure` in watch.js so both gates agree on what
 * "error-shaped" means. HTTP 402 (Payment Required) is how a spent prepaid
 * balance arrives (grok, 2026-09-25): the limit phrase sits past the head
 * window of that line, so only its error shape admits it.
 */
export const ERROR_SHAPED_LINE =
  /^(?:error|fatal)(?:\b|:)|^(?:authentication failed|failed to authenticate|not authenticated|invalid api key|rate limit(?:ed| exceeded)?|cmd login)(?:[.!:]|$)|\b(?:http\s*(?:401|402|403|429)|status\s*(?:401|402|403|429)|payment required|login required|please login|access denied|quota exceeded)\b/i;

function declaredList(connector, key) {
  return Array.isArray(connector?.[key]) ? connector[key] : [];
}

/**
 * Every phrase that marks a limit notice: the connector's own window wording
 * (`quotaSignatures`) and throttle wording (`throttleSignatures`) first, then
 * the core defaults.
 */
function quotaSignaturesFor(connector) {
  return [
    ...declaredList(connector, 'quotaSignatures'),
    ...declaredList(connector, 'throttleSignatures'),
    ...DEFAULT_QUOTA_SIGNATURES,
  ];
}

/** Lower-cased throttle phrases for this connector. */
function throttleSetFor(connector) {
  return new Set([...declaredList(connector, 'throttleSignatures'), ...DEFAULT_THROTTLE_SIGNATURES]
    .map((s) => String(s ?? '').toLowerCase())
    .filter(Boolean));
}

/**
 * Lower-cased window phrases for this connector. A phrase the connector (or an
 * installed copy merged before the split) lists as window wording but core
 * knows as throttle wording stays a throttle: the wording decides, not the list.
 */
function windowListFor(connector, throttles) {
  return [...declaredList(connector, 'quotaSignatures'), ...DEFAULT_WINDOW_SIGNATURES]
    .map((s) => String(s ?? '').toLowerCase())
    .filter((s) => s && !throttles.has(s));
}

/**
 * Is this matched limit notice a spent usage window or a momentary throttle?
 *
 * Window only when the notice carries window wording: a window phrase (the
 * connector's `quotaSignatures` or DEFAULT_WINDOW_SIGNATURES) or
 * WINDOW_WORDING on the line or the line after it. Everything else is a
 * throttle, however long a wait it names (Q6): a named wait says when to try
 * again, not that a usage window is spent.
 *
 * `explicit` is the message half of the Q6 rule: window wording AND a reset
 * the notice names. A window phrase with no reset names no reset on its own;
 * only the meter can then supply one (decideUsageLimit).
 *
 * @returns {{limit: 'window'|'throttle', waitMs: number|null,
 *            resetAt: number|null, explicit: boolean}}
 */
export function classifyQuotaLimit(connector, { line = '', context = '' } = {}, {
  now = Date.now(), timeZone = null,
} = {}) {
  const throttles = throttleSetFor(connector);
  // The notice line and the one after it (where reset wording also lands);
  // the rest of the context window can be the agent's own unrelated text.
  const text = [line, ...String(context || '').split('\n').slice(0, 2)].join('\n');
  const lower = text.toLowerCase();
  const nowMs = toMs(now) ?? Date.now();
  const resetAt = parseQuotaResetAt(context || line, { now: nowMs, timeZone });
  const waitMs = resetAt == null ? null : resetAt - nowMs;
  const windowWording = windowListFor(connector, throttles).some((phrase) => lower.includes(phrase))
    || WINDOW_WORDING.test(text);
  const limit = windowWording ? 'window' : 'throttle';
  return { limit, waitMs, resetAt, explicit: windowWording && resetAt != null };
}

/**
 * How long to wait before same-pool retry number `retry` (1-based) of a
 * throttled attempt: the wait the provider named when it named one (never
 * shorter than a second), else the fixed short schedule.
 */
export function throttleBackoffMs(retry = 1, { waitMs = null } = {}) {
  const named = Number(waitMs);
  if (Number.isFinite(named) && named > 0) return Math.max(1000, Math.min(named, THROTTLE_MAX_WAIT_MS));
  const index = Math.max(0, Math.min(THROTTLE_BACKOFF_MS.length - 1, Math.floor(Number(retry) || 1) - 1));
  return THROTTLE_BACKOFF_MS[index];
}

/**
 * Quota signature WITH its matched line, a bounded context window and the
 * Q5/Q6 classification: `limit` is 'window' (the wording says a usage window
 * is spent) or 'throttle'; `transient` is true unless the notice ALSO names
 * its reset — only then does the message alone say when it resets. `waitMs` is
 * the wait the notice named, or null; `retrySamePool` is false when that
 * wait is longer than THROTTLE_MAX_WAIT_MS (a run started by an earlier
 * version then falls over instead of waiting).
 * The meter half of the rule is decideUsageLimit's.
 * Returns null unless the line is quota-shaped (Q2).
 */
export function findQuotaFailure(connector, text, opts = {}) {
  const hit = findQuotaNotice(connector, text);
  if (!hit) return null;
  const { limit, waitMs, explicit } = classifyQuotaLimit(connector, hit, opts);
  return {
    ...hit,
    limit,
    transient: !explicit,
    waitMs,
    retrySamePool: waitMs == null || waitMs <= THROTTLE_MAX_WAIT_MS,
  };
}

function findQuotaNotice(connector, text) {
  const raw = String(text ?? '');
  if (!raw) return null;
  const lower = raw.toLowerCase();
  for (const signature of quotaSignaturesFor(connector)) {
    const needle = String(signature ?? '').toLowerCase();
    if (!needle) continue;
    // Every line that carries the phrase is a candidate, not just the first:
    // a provider error event puts its raw record first and its own sentence
    // after it, and a raw record too long to be a notice must not hide that
    // sentence.
    for (let index = lower.indexOf(needle); index >= 0; index = lower.indexOf(needle, index + needle.length)) {
      const start = lower.lastIndexOf('\n', index) + 1;
      const newline = lower.indexOf('\n', index);
      const end = newline < 0 ? raw.length : newline;
      const line = raw.slice(start, end).trim();
      if (!line || line.length > MAX_QUOTA_LINE_CHARS) continue;
      const offset = line.toLowerCase().indexOf(needle);
      if (offset < 0) continue;
      const leads = offset <= QUOTA_SIGNATURE_HEAD_CHARS && !PROSE_LINE_PREFIX.test(line);
      if (!leads && !ERROR_SHAPED_LINE.test(line)) continue;
      // A generic phrase is only a limit notice when nothing but punctuation, a
      // reset/retry clause or a detail follows it; "rate limited by GitHub" is
      // narration about another service's quota, whichever branch admitted it.
      if (GENERIC_SET.has(needle) && !bareNotice(line, offset, needle)) continue;
      return {
        signature,
        line,
        context: raw.slice(start, Math.min(raw.length, end + QUOTA_CONTEXT_CHARS)),
      };
    }
  }
  return null;
}

// --- reset-time parsing ---------------------------------------------------

const UNIT_MS = {
  s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
  m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
  h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
  d: DAY_MS, day: DAY_MS, days: DAY_MS,
};

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const MONTH_NAMES = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?'
  + '|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const MONTH_DAY_RE = new RegExp(`\\b(${MONTH_NAMES})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'i');
const DAY_MONTH_RE = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_NAMES})\\b`, 'i');

const ISO_RE = /\b(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::\d{2})?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g;
const RELATIVE_RE = /\bin\s+(?:about\s+|~\s*)?(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|s|m|h|d)\b/i;
const RESET_KEYWORD_RE = /\b(?:resets?|resetting|try again|retry|available again|back (?:at|on)|unblocks?|until)\b/gi;
const MERIDIEM_RE = /\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?\b/i;
const CLOCK_RE = /\b(\d{1,2}):(\d{2})\b/;
const ZONE_RE = /\(([A-Za-z][A-Za-z0-9_+\-/]{1,40})\)/;
/** How much text after a reset keyword can still describe that reset. */
const KEYWORD_WINDOW_CHARS = 120;

function toMs(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function isValidTimeZone(zone) {
  if (typeof zone !== 'string' || !zone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function machineTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Wall-clock parts of `ms` as seen in `zone`. */
function zoneParts(zone, ms) {
  const parts = {};
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  for (const part of formatter.formatToParts(new Date(ms))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  if (parts.hour === 24) parts.hour = 0; // hour12:false still emits 24 on some ICU builds
  return parts;
}

/** Offset of `zone` from UTC, in ms, at the instant `ms`. */
function zoneOffsetMs(zone, ms) {
  const p = zoneParts(zone, ms);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - (ms - (ms % 1000));
}

/** The instant at which `zone` shows the given wall-clock time. */
function instantFromZoneWallClock(zone, { year, month, day, hour, minute }) {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0);
  // Two passes: the first offset is read at the wrong instant near a DST edge.
  const first = naive - zoneOffsetMs(zone, naive);
  return naive - zoneOffsetMs(zone, first);
}

/**
 * Next instant at which `zone` shows `hour:minute` (on `month/day` when the
 * message named a date). A bare time is at most 24h ahead by construction.
 */
function nextOccurrence(zone, nowMs, { hour, minute, month = null, day = null }) {
  const today = zoneParts(zone, nowMs);
  if (month != null && day != null) {
    for (const year of [today.year, today.year + 1]) {
      const at = instantFromZoneWallClock(zone, { year, month, day, hour, minute });
      if (at > nowMs) return at;
    }
    return null;
  }
  const at = instantFromZoneWallClock(zone, {
    year: today.year, month: today.month, day: today.day, hour, minute,
  });
  if (at > nowMs) return at;
  // Tomorrow's calendar date read from the zone itself — no rollover math here.
  const tomorrow = zoneParts(zone, nowMs + DAY_MS);
  return instantFromZoneWallClock(zone, {
    year: tomorrow.year, month: tomorrow.month, day: tomorrow.day, hour, minute,
  });
}

function monthDayIn(segment) {
  const forward = segment.match(MONTH_DAY_RE);
  if (forward) return { month: MONTHS[forward[1].slice(0, 3).toLowerCase()], day: Number(forward[2]) };
  const reverse = segment.match(DAY_MONTH_RE);
  if (reverse) return { month: MONTHS[reverse[2].slice(0, 3).toLowerCase()], day: Number(reverse[1]) };
  return null;
}

function isoCandidates(raw, zone) {
  const out = [];
  for (const match of raw.matchAll(ISO_RE)) {
    if (match[4]) {
      const ms = Date.parse(match[0].replace(' ', 'T'));
      if (Number.isFinite(ms)) out.push(ms);
      continue;
    }
    const [year, month, day] = match[1].split('-').map(Number);
    out.push(instantFromZoneWallClock(zone, {
      year, month, day, hour: Number(match[2]), minute: Number(match[3]),
    }));
  }
  return out;
}

function wallClockIn(segment, nowMs, fallbackZone) {
  const declaredZone = segment.match(ZONE_RE)?.[1];
  // An unknown zone label is not a reason to give up on the time: fall back to
  // the caller's zone, then the machine's.
  const zone = isValidTimeZone(declaredZone) ? declaredZone : fallbackZone;
  let hour;
  let minute;
  const meridiem = segment.match(MERIDIEM_RE);
  if (meridiem) {
    hour = Number(meridiem[1]);
    if (hour < 1 || hour > 12) return null;
    hour %= 12;
    if (meridiem[3].toLowerCase() === 'p') hour += 12;
    minute = meridiem[2] ? Number(meridiem[2]) : 0;
  } else {
    const clock = segment.match(CLOCK_RE);
    if (!clock) return null;
    hour = Number(clock[1]);
    minute = Number(clock[2]);
  }
  if (hour > 23 || minute > 59) return null;
  return nextOccurrence(zone, nowMs, { hour, minute, ...(monthDayIn(segment) ?? {}) });
}

function absoluteCandidates(raw, nowMs, fallbackZone) {
  const out = [];
  for (const match of raw.matchAll(RESET_KEYWORD_RE)) {
    const segment = raw.slice(match.index, match.index + KEYWORD_WINDOW_CHARS);
    const parsed = wallClockIn(segment, nowMs, fallbackZone);
    if (parsed != null) out.push(parsed);
    if (out.length >= 4) break;
  }
  return out;
}

/**
 * Epoch ms of the reset a usage-limit message announces, or null.
 *
 * Candidates are tried most-explicit first (ISO timestamp, relative duration,
 * keyword-anchored wall clock) and the first one inside (now, now+7d] wins: a
 * message that stamps the failure time AND states a reset must not be read
 * as resetting at the stamp.
 */
export function parseQuotaResetAt(text, { now = Date.now(), timeZone = null } = {}) {
  const raw = String(text ?? '');
  if (!raw) return null;
  const nowMs = toMs(now);
  if (nowMs == null) return null;
  const fallbackZone = isValidTimeZone(timeZone) ? timeZone : machineTimeZone();

  const candidates = [...isoCandidates(raw, fallbackZone)];
  const relative = raw.match(RELATIVE_RE);
  if (relative) {
    const unit = UNIT_MS[relative[2].toLowerCase()];
    if (unit) candidates.push(nowMs + Number(relative[1]) * unit);
  }
  candidates.push(...absoluteCandidates(raw, nowMs, fallbackZone));

  for (const ms of candidates) {
    if (!Number.isFinite(ms)) continue;
    if (ms <= nowMs) continue;                       // already past: not a reset
    if (ms - nowMs > MAX_RESET_AHEAD_MS) continue;   // parse artifact, not a reset
    return ms;
  }
  return null;
}

// --- the reset of a limit (Q6) ---------------------------------------------

/** A window this full on the pool's own meter is spent: its reset is the limit's. */
export const QUOTA_METER_SPENT_PCT = 95;

/** Meter snapshot keys, in the order a reading is shown. */
const METER_WINDOWS = Object.freeze([
  ['five_hour', '5h'],
  ['seven_day', 'weekly'],
  ['monthly', 'monthly'],
]);

/** The pool's cached meter snapshot (`<home>/meters/<pool>.json`), or null. */
export function readMeterSnapshot(bullswarmDir, pool) {
  if (typeof bullswarmDir !== 'string' || !bullswarmDir) return null;
  if (typeof pool !== 'string' || !pool) return null;
  try {
    const snapshot = JSON.parse(readFileSync(join(bullswarmDir, 'meters', `${pool}.json`), 'utf8'));
    return snapshot && typeof snapshot === 'object' ? snapshot : null;
  } catch {
    return null;
  }
}

function isoOf(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * The provider-measured windows of a meter snapshot that describe the window
 * running now. A window the refusal marker synthesised (`source:
 * 'quota-refusal'`, written BECAUSE a limit notice arrived) is not a
 * measurement and never counts; neither is a window whose reset has passed
 * (that reading belongs to a window already over). Usage only grows inside a
 * window, so an older reading of the current window is a lower bound.
 *
 * @returns {{readAt: string|null, windows: Array<{window: string,
 *            usedPct: number, resetsAt: string}>}|null}
 */
export function meterReadingOf(snapshot, { now = Date.now() } = {}) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const nowMs = toMs(now) ?? Date.now();
  const windows = [];
  for (const [key, label] of METER_WINDOWS) {
    const entry = snapshot[key];
    if (!entry || typeof entry !== 'object' || entry.source === 'quota-refusal') continue;
    const usedPct = Number(entry.utilization);
    const resetMs = toMs(entry.resets_at ?? null);
    if (entry.utilization == null || !Number.isFinite(usedPct)) continue;
    if (resetMs == null || resetMs <= nowMs) continue;
    windows.push({ window: label, usedPct: Math.round(usedPct * 10) / 10, resetsAt: isoOf(resetMs) });
  }
  if (!windows.length) return null;
  // A refusal marker restamps captured_at with the refusal time; the real
  // windows it kept were read earlier, at a time the snapshot no longer says.
  const marker = snapshot.quota_refusal || snapshot.source === 'quota-refusal';
  const readMs = marker ? null : toMs(snapshot.captured_at ?? null);
  return { readAt: isoOf(readMs), windows };
}

/**
 * The meter window that shows the pool spent: the fullest window at or above
 * QUOTA_METER_SPENT_PCT (ties: the one that resets first), or null.
 */
function fullMeterWindow(reading) {
  const full = (reading?.windows ?? []).filter((w) => w.usedPct >= QUOTA_METER_SPENT_PCT);
  if (!full.length) return null;
  full.sort((a, b) => (b.usedPct - a.usedPct) || (Date.parse(a.resetsAt) - Date.parse(b.resetsAt)));
  return full[0];
}

/** `5h 48% · weekly 78%` — the reading in plain words, or null. */
function meterSummary(reading) {
  const windows = reading?.windows ?? [];
  if (!windows.length) return null;
  return windows.map((w) => `${w.window} ${w.usedPct}%`).join(' · ');
}

/**
 * `16:00` when `ms` falls on today's date in the zone, else `Tue 22 Sep 16:00`.
 * Display only: records keep ISO instants.
 */
export function formatResetClock(ms, { now = Date.now(), timeZone = null } = {}) {
  const at = toMs(ms);
  if (at == null) return '?';
  const zone = isValidTimeZone(timeZone) ? timeZone : machineTimeZone();
  const nowMs = toMs(now) ?? Date.now();
  const clock = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(at));
  const day = (ms2) => new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ms2));
  if (day(at) === day(nowMs)) return clock;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: zone, weekday: 'short', day: 'numeric', month: 'short',
  }).formatToParts(new Date(at)).map((part) => [part.type, part.value]));
  return `${parts.weekday} ${parts.day} ${parts.month} ${clock}`;
}

function quoted(line, max = 160) {
  const text = String(line ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return `"${text.length > max ? `${text.slice(0, max - 1)}…` : text}"`;
}

/**
 * What a limit notice says about the pool's usage window: the one place the
 * Q6 rule lives. Nothing here is stored or remembered (Q7).
 *
 * The reset is known in exactly two ways, checked in this order:
 *   'message'   — the provider's line says a usage window is spent AND names
 *                 its reset: `until` is that reset.
 *   'meter'     — the pool's own meter reads >= QUOTA_METER_SPENT_PCT on a
 *                 window still running: `until` is that window's reset.
 * Otherwise the rule is 'transient' and `until` is null.
 *
 * `failure` is a findQuotaFailure() result (or `text` to find one); `meter`
 * a meter snapshot (default: `<home>/meters/<pool>.json`).
 *
 * `limit` is the notice's wording (classifyQuotaLimit): 'window' when it says
 * a usage window, a quota or a balance is spent, else 'throttle'. A caller
 * under the limits-to-caller rule (watch.js `usageLimitsToCaller`) reads a
 * 'window' notice, or one whose reset is known, as a usage limit.
 *
 * @returns {{rule: 'message'|'meter'|'transient', limit: 'window'|'throttle',
 *   line: string|null, until: number|null, resetsAt: string|null,
 *   meter: object|null, meterWindow: object|null, waitMs: number|null,
 *   retrySamePool: boolean, decidedAt: string, why: string}}
 */
export function decideUsageLimit({
  connector = null, failure = null, text = null, pool = null, bullswarmDir = null,
  meter, now = Date.now(), timeZone = null,
} = {}) {
  const nowMs = toMs(now) ?? Date.now();
  const notice = failure ?? (text != null ? findQuotaNotice(connector, text) : null);
  const line = notice ? (String(notice.line ?? notice.signature ?? '').trim() || null) : null;
  const classified = notice
    ? classifyQuotaLimit(connector, notice, { now: nowMs, timeZone })
    : { limit: 'throttle', waitMs: null, resetAt: null, explicit: false };
  const reading = meterReadingOf(meter !== undefined ? meter : readMeterSnapshot(bullswarmDir, pool), { now: nowMs });
  const said = quoted(line) ?? 'a limit notice';
  const summary = meterSummary(reading);
  const clockOpts = { now: nowMs, timeZone };
  const base = {
    line,
    limit: classified.limit,
    meter: reading,
    waitMs: classified.waitMs,
    retrySamePool: classified.waitMs == null || classified.waitMs <= THROTTLE_MAX_WAIT_MS,
    decidedAt: isoOf(nowMs),
  };
  if (classified.explicit) {
    return {
      ...base, rule: 'message',
      until: classified.resetAt, resetsAt: isoOf(classified.resetAt), meterWindow: null,
      why: `usage window spent: provider said ${said} · back at `
        + `${formatResetClock(classified.resetAt, clockOpts)} (the reset it named)`
        + ` · meter ${summary ?? 'not read'}`,
    };
  }
  const full = fullMeterWindow(reading);
  if (full) {
    const until = Date.parse(full.resetsAt);
    return {
      ...base, rule: 'meter',
      until, resetsAt: full.resetsAt, meterWindow: full,
      why: `usage window spent: meter reads ${full.window} ${full.usedPct}% `
        + `(>= ${QUOTA_METER_SPENT_PCT}%) · back at ${formatResetClock(until, clockOpts)} `
        + `(${full.window} reset) · provider said ${said}`,
    };
  }
  return {
    ...base, rule: 'transient', until: null, resetsAt: null, meterWindow: null,
    why: classified.limit === 'window'
      ? `usage window spent: provider said ${said} · no reset named · meter ${summary ?? 'not read'}`
      : `rate limited (transient): ${said} · meter ${summary ?? 'not read'}, `
        + `below ${QUOTA_METER_SPENT_PCT}%; no spent window with a reset named`,
  };
}
