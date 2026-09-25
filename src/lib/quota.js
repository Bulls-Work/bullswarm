// bullswarm quota — usage-limit detection, reset-time parsing, quarantine deadline.
//
// Doctrine:
//   Q1. A usage limit is its OWN mechanical failure kind. It is not `process`
//       (the CLI happened to exit non-zero), not `semantic` (the answer was
//       thin) and not `auth` (the credential is broken). Only a quota failure
//       knows a real reset time, and only that time is a truthful deadline.
//   Q2. Detection is shape-gated. Agents legitimately discuss rate limits in
//       their reports and tool output routinely contains the words; killing a
//       healthy worker for reading them costs more than a missed limit, which
//       the final-output gate catches anyway.
//   Q3. The deadline degrades honestly: the time parsed from the provider's
//       own message, else that pool's cached 5h meter reset, else 30 minutes.
//       Never a flat guess presented as a measurement.
//   Q4. Zero dependencies. Named time zones resolve through Intl only.
//   Q5. A throttle is not a spent window. "Rate limit exceeded. Please wait a
//       moment and try again." asks for a pause of seconds; pausing the pool
//       until a reset for it benched command-code for ~4 hours while its
//       meter read 5% (2026-09). Only wording that says a usage window is
//       exhausted can pause a pool; everything the table marks `throttle` is
//       retried on the same pool after a short backoff.
//   Q6. The pause rule is rigid and has exactly two proofs (decideQuotaPause):
//       the pool's own meter reads >= QUOTA_PAUSE_METER_PCT on a window whose
//       reset is still ahead, or the provider's line says a usage window is
//       spent AND names when it resets. Anything else — a throttle, an
//       overload, a 5xx, a window phrase with no reset — is transient and
//       never pauses. A transient `Rate limit exceeded` paused claude-code
//       until its 5h reset while its meter read 78% weekly / 48% 5h
//       (2026-09-21). Every pause records the provider line, the meter
//       reading and the reset.
//   Q7. One switch stops automatic pausing altogether.
//       `state.strategy.pausing: "off"` refuses EVERY pause a command takes on
//       its own: quota, auth, the credential-group siblings that bench with an
//       auth pause (state.js `quarantineUpstreamSiblings`), and the soft bench
//       a second strike would write. Routing is untouched — meters are still
//       read, pace and 5h headroom still gate, and a failed attempt still
//       moves to another pool. `bullswarm strategy set-pausing on|off` writes
//       it; `bullswarm pools` opens with `automatic pausing: off` while it is
//       in effect. The owner asked for exactly this on 2026-09-21 15:40 HKT
//       ("stop the quarantine logic at all").

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Provider phrases that mean "you have no quota left right now", each marked
 * with whether third-party services emit it too (`generic`) and whether it
 * names a spent usage window (`window`: pause the pool until its reset) or a
 * momentary throttle (`throttle`: back off briefly and retry the same pool) —
 * the one table every exported list below is projected from.
 *
 * Deliberately excluded: bare `resets at` / `resets in` wording. A reset time
 * alone is not a limit — it appears in healthy meter reports, and treating it
 * as a signature would quarantine pools that merely told us when their window
 * turns over. Reset wording is only ever read AFTER a signature matched.
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

/** Default phrases that name a spent usage window: the pool pauses. */
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
 * A throttle that names its own wait is honoured up to this long; a wait
 * further out than this is not worth waiting for on the same pool, so the
 * attempt falls over to another pool instead (`retrySamePool: false`). It
 * still never pauses the pool (Q6).
 */
export const THROTTLE_MAX_WAIT_MS = 15 * 60_000;
/** Short backoffs before each same-pool retry of a throttled attempt. */
export const THROTTLE_BACKOFF_MS = Object.freeze([20_000, 60_000]);
/** Same-pool retries a throttle earns before the step moves on. */
export const MAX_THROTTLE_RETRIES = THROTTLE_BACKOFF_MS.length;

/**
 * Phrases that third-party services emit too. An agent narrates "Rate limited
 * by the GitHub API, retrying" about somebody else's quota, and that narration
 * must never kill the worker or bench OUR pool. These count only as a bare
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
/** Fallback quarantine when neither the message nor the meter knows better. */
export const DEFAULT_QUOTA_QUARANTINE_MS = 30 * 60_000;
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
 * `explicit` is the message half of the pause rule: window wording AND a
 * reset the notice names. A window phrase with no reset is not proof on its
 * own; only the meter can then pause the pool (decideQuotaPause).
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

/** First declared-or-default quota phrase present in `text`, or null. */
export function matchQuotaSignature(connector, text) {
  const lower = String(text ?? '').toLowerCase();
  if (!lower) return null;
  for (const signature of quotaSignaturesFor(connector)) {
    const needle = String(signature ?? '').toLowerCase();
    if (needle && lower.includes(needle)) return signature;
  }
  return null;
}

/**
 * Quota signature WITH its matched line, a bounded context window and the
 * Q5/Q6 classification: `limit` is 'window' (the wording says a usage window
 * is spent) or 'throttle'; `transient` is true unless the notice ALSO names
 * its reset — only then does the message alone prove a pause. `waitMs` is
 * the wait the notice named, or null; `retrySamePool` is false when that
 * wait is longer than THROTTLE_MAX_WAIT_MS (fall over instead of waiting).
 * The meter half of the rule is decideQuotaPause's.
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

/** The quota signature when the matched line is quota-shaped, else null. */
export function matchLikelyQuotaFailure(connector, text) {
  return findQuotaFailure(connector, text)?.signature ?? null;
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
 * message that stamps the failure time AND states a reset must not quarantine
 * on the stamp.
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

/** `five_hour.resets_at` from a pool's cached meter snapshot, or null. */
function cachedFiveHourReset(bullswarmDir, pool) {
  if (typeof bullswarmDir !== 'string' || !bullswarmDir) return null;
  if (typeof pool !== 'string' || !pool) return null;
  try {
    const snapshot = JSON.parse(readFileSync(join(bullswarmDir, 'meters', `${pool}.json`), 'utf8'));
    return toMs(snapshot?.five_hour?.resets_at ?? null);
  } catch {
    // No snapshot, unreadable, or malformed — the caller has a fallback.
    return null;
  }
}

/**
 * Quarantine deadline for a quota failure, with the evidence that produced it.
 * @returns {{until: number, source: 'message'|'meter'|'default'}}
 */
export function quotaQuarantineUntil({
  text = '', pool = null, bullswarmDir = null, now = Date.now(), timeZone = null,
} = {}) {
  const nowMs = toMs(now) ?? Date.now();
  const parsed = parseQuotaResetAt(text, { now: nowMs, timeZone });
  if (parsed != null) return { until: parsed, source: 'message' };
  const metered = cachedFiveHourReset(bullswarmDir, pool);
  if (metered != null && metered > nowMs && metered - nowMs <= MAX_RESET_AHEAD_MS) {
    return { until: metered, source: 'meter' };
  }
  return { until: nowMs + DEFAULT_QUOTA_QUARANTINE_MS, source: 'default' };
}

// --- the pause rule (Q6) ---------------------------------------------------

/** A window this full on the pool's own meter proves the pool is spent. */
export const QUOTA_PAUSE_METER_PCT = 95;

/** Meter snapshot keys, in the order a reading is shown. */
const METER_WINDOWS = Object.freeze([
  ['five_hour', '5h'],
  ['seven_day', 'weekly'],
  ['monthly', 'monthly'],
]);

/**
 * Is automatic pausing on for this state? `strategy.pausing: "off"` stops
 * every kind of pause (Q7); absent means on. Lives here because state.js,
 * which enforces it, already imports this module for the pause rule.
 */
export function pausingEnabled(state) {
  const value = state?.strategy?.pausing;
  return !(value === false || value === 'off');
}

/**
 * The switch as stored in `<home>/state.json`, read without taking the state
 * lock (a read, never a write). A missing or unreadable file means the
 * default: on.
 */
export function readPausing(bullswarmDir) {
  if (typeof bullswarmDir !== 'string' || !bullswarmDir) return true;
  try {
    return pausingEnabled(JSON.parse(readFileSync(join(bullswarmDir, 'state.json'), 'utf8')));
  } catch {
    return true;
  }
}

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
 * The meter window that proves the pool spent: the fullest window at or above
 * QUOTA_PAUSE_METER_PCT (ties: the one that resets first), or null.
 */
export function fullMeterWindow(reading) {
  const full = (reading?.windows ?? []).filter((w) => w.usedPct >= QUOTA_PAUSE_METER_PCT);
  if (!full.length) return null;
  full.sort((a, b) => (b.usedPct - a.usedPct) || (Date.parse(a.resetsAt) - Date.parse(b.resetsAt)));
  return full[0];
}

/** `5h 48% · weekly 78%` — the reading in plain words, or null. */
export function meterSummary(reading) {
  const windows = reading?.windows ?? [];
  if (!windows.length) return null;
  return windows.map((w) => `${w.window} ${w.usedPct}%`).join(' · ');
}

/**
 * `16:00` when `ms` falls on today's date in the zone, else `Tue 22 Sep 16:00`.
 * Display only: records keep ISO instants.
 */
export function formatPauseClock(ms, { now = Date.now(), timeZone = null } = {}) {
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
 * Should this limit notice pause the pool? The one place the rule lives (Q6).
 *
 * Two proofs, checked in this order, and nothing else:
 *   'message' — the provider's line says a usage window is spent AND names
 *               its reset: paused until that reset.
 *   'meter'   — the pool's own meter reads >= QUOTA_PAUSE_METER_PCT on a
 *               window still running: paused until that window resets.
 * Otherwise the notice is 'transient' (back off, retry the same pool, then
 * fall over for this attempt only), and with the switch off (Q7) it is 'off'
 * — never a pause either way.
 *
 * `failure` is a findQuotaFailure() result (or `text` to find one); `meter`
 * a meter snapshot (default: `<home>/meters/<pool>.json`); `pausing` the
 * switch (default: `<home>/state.json`, on when absent).
 *
 * Every result carries `limit`, the notice's wording (classifyQuotaLimit):
 * 'window' when it says a usage window, a quota or a balance is spent, else
 * 'throttle' — whatever the rule and the switch decided. A marked workflow
 * step reads a 'window' notice as a usage limit, even a 'transient' one, and
 * hands it to its caller with no backoff.
 *
 * @returns {{pause: boolean, rule: 'message'|'meter'|'transient'|'off',
 *   limit: 'window'|'throttle',
 *   line: string|null, until: number|null, resetsAt: string|null,
 *   meter: object|null, meterWindow: object|null, waitMs: number|null,
 *   retrySamePool: boolean, decidedAt: string, why: string,
 *   holdUntil?: number|null}} `holdUntil` is on the 'off' result only.
 */
export function decideQuotaPause({
  connector = null, failure = null, text = null, pool = null, bullswarmDir = null,
  meter, pausing, now = Date.now(), timeZone = null,
} = {}) {
  const nowMs = toMs(now) ?? Date.now();
  const notice = failure ?? (text != null ? findQuotaNotice(connector, text) : null);
  const line = notice ? (String(notice.line ?? notice.signature ?? '').trim() || null) : null;
  const classified = notice
    ? classifyQuotaLimit(connector, notice, { now: nowMs, timeZone })
    : { limit: 'throttle', waitMs: null, resetAt: null, explicit: false };
  const reading = meterReadingOf(meter !== undefined ? meter : readMeterSnapshot(bullswarmDir, pool), { now: nowMs });
  const on = pausing !== undefined ? pausing !== false && pausing !== 'off' : readPausing(bullswarmDir);
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
  const none = { until: null, resetsAt: null, meterWindow: null };
  if (!on) {
    // The deadline the two proofs below would have paused until. The 'off'
    // result pauses nothing (quotaPauseProven() refuses it); when the
    // deadline is known, a marked workflow step hands the limit to its
    // caller, naming it as the time the pool is back.
    const offWindow = classified.explicit ? null : fullMeterWindow(reading);
    const holdUntil = classified.explicit ? classified.resetAt
      : offWindow ? Date.parse(offWindow.resetsAt) : null;
    return {
      ...base, ...none, pause: false, rule: 'off', holdUntil: Number.isFinite(holdUntil) ? holdUntil : null,
      why: `limit notice ${said} · pool not paused: automatic pausing is off (bullswarm strategy set-pausing on)`
        + (summary ? ` · meter ${summary}` : ''),
    };
  }
  if (classified.explicit) {
    return {
      ...base, pause: true, rule: 'message',
      until: classified.resetAt, resetsAt: isoOf(classified.resetAt), meterWindow: null,
      why: `usage window spent: provider said ${said} · paused until `
        + `${formatPauseClock(classified.resetAt, clockOpts)} (the reset it named)`
        + ` · meter ${summary ?? 'not read'}`,
    };
  }
  const full = fullMeterWindow(reading);
  if (full) {
    const until = Date.parse(full.resetsAt);
    return {
      ...base, pause: true, rule: 'meter',
      until, resetsAt: full.resetsAt, meterWindow: full,
      why: `usage window spent: meter reads ${full.window} ${full.usedPct}% `
        + `(>= ${QUOTA_PAUSE_METER_PCT}%) · paused until ${formatPauseClock(until, clockOpts)} `
        + `(${full.window} reset) · provider said ${said}`,
    };
  }
  return {
    ...base, ...none, pause: false, rule: 'transient',
    why: `rate limited (transient): ${said} · pool not paused `
      + `(meter ${summary ?? 'not read'}, below ${QUOTA_PAUSE_METER_PCT}%; no spent window with a reset named)`,
  };
}

/**
 * Is `evidence` a decideQuotaPause() result that proves a pause still ahead
 * of `now`? state.js refuses a quota pause without one.
 */
export function quotaPauseProven(evidence, now = Date.now()) {
  if (!evidence || typeof evidence !== 'object' || evidence.pause !== true) return false;
  const until = Number(evidence.until);
  if (!Number.isFinite(until) || until <= (toMs(now) ?? Date.now())) return false;
  if (evidence.rule === 'message') return typeof evidence.line === 'string' && evidence.line.trim() !== '';
  if (evidence.rule === 'meter') return Number(evidence.meterWindow?.usedPct) >= QUOTA_PAUSE_METER_PCT;
  return false;
}

/**
 * One plain-words line for a pool's pause, built from the stored record so
 * every surface (`bullswarm pools`, the watch line, the dashboard row) says
 * the same thing: `paused until 16:00 · usage window spent · …`.
 */
export function describePoolPause(pool, quarantine, { now = Date.now(), timeZone = null } = {}) {
  if (!quarantine || typeof quarantine !== 'object') return null;
  const clockOpts = { now, timeZone };
  const until = formatPauseClock(quarantine.until, clockOpts);
  const lift = pool ? ` · lift now: bullswarm pools resume ${pool}` : '';
  if (quarantine.kind !== 'quota') {
    return `paused until ${until} · auth: ${quarantine.reason ?? 'no reason recorded'}${lift}`;
  }
  if (quarantine.rule !== 'message' && quarantine.rule !== 'meter') {
    // Written before the rule was recorded: say so rather than invent it.
    return `paused until ${until} · quota (recorded without evidence): ${quarantine.reason ?? 'no reason recorded'}${lift}`;
  }
  const said = quoted(quarantine.line);
  const summary = meterSummary(quarantine.meter);
  const proof = quarantine.rule === 'meter'
    ? `meter read ${quarantine.meterWindow?.window ?? '?'} ${quarantine.meterWindow?.usedPct ?? '?'}% (>= ${QUOTA_PAUSE_METER_PCT}%)`
    : 'provider named the reset';
  return `paused until ${until} · usage window spent, ${proof}`
    + (said ? ` · provider: ${said}` : '')
    + ` · meter then: ${summary ?? 'not read'}${lift}`;
}

/**
 * Drop a pool's synthetic quota-refusal meter snapshot (the 100% wall written
 * after a refusal when the live meter could not be read). A lifted pause must
 * not stay walled by it; the next meter read is live. A real reading is kept.
 * @returns {boolean} whether a marker was removed
 */
export function dropQuotaRefusalSnapshot(bullswarmDir, pool) {
  const snapshot = readMeterSnapshot(bullswarmDir, pool);
  if (!snapshot || !(snapshot.quota_refusal || snapshot.source === 'quota-refusal')) return false;
  const file = join(bullswarmDir, 'meters', `${pool}.json`);
  if (!existsSync(file)) return false;
  rmSync(file, { force: true });
  return true;
}

/**
 * The compact form of describePoolPause() for one dashboard pool row:
 * `paused until 20:00 · meter weekly 96%`. The full line (provider words,
 * meter reading, lift command) is describePoolPause's.
 */
export function pauseWord(quarantine, { now = Date.now(), timeZone = null } = {}) {
  if (!quarantine || typeof quarantine !== 'object') return null;
  const until = `paused until ${formatPauseClock(quarantine.until, { now, timeZone })}`;
  if (quarantine.kind !== 'quota') return `${until} · auth`;
  if (quarantine.rule === 'meter') {
    return `${until} · meter ${quarantine.meterWindow?.window ?? '?'} ${quarantine.meterWindow?.usedPct ?? '?'}%`;
  }
  if (quarantine.rule === 'message') return `${until} · provider named the reset`;
  return `${until} · quota`;
}

/**
 * Just the proof of a quota pause, for a line that already states the
 * deadline (the watch line): `meter weekly 96% (>= 95%) · provider: "…"` or
 * `provider named the reset: "…"`. Null for an auth pause or a record written
 * without evidence.
 */
export function pauseProof(quarantine) {
  if (!quarantine || typeof quarantine !== 'object' || quarantine.kind !== 'quota') return null;
  const said = quoted(quarantine.line, 120);
  if (quarantine.rule === 'meter') {
    return `meter ${quarantine.meterWindow?.window ?? '?'} ${quarantine.meterWindow?.usedPct ?? '?'}% `
      + `(>= ${QUOTA_PAUSE_METER_PCT}%)${said ? ` · provider: ${said}` : ''}`;
  }
  if (quarantine.rule === 'message') return `provider named the reset${said ? `: ${said}` : ''}`;
  return null;
}
