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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Provider phrases that mean "you have no quota left right now".
 *
 * Deliberately excluded: bare `resets at` / `resets in` wording. A reset time
 * alone is not a limit — it appears in healthy meter reports, and treating it
 * as a signature would quarantine pools that merely told us when their window
 * turns over. Reset wording is only ever read AFTER a signature matched.
 */
export const DEFAULT_QUOTA_SIGNATURES = [
  'hit your session limit',
  'hit your limit',
  'hit your usage limit',
  'usage limit reached',
  'reached your usage limit',
  'usage_credits_required',
  'rate limit exceeded',
  'rate_limit_exceeded',
  'rate limited',
  'too many requests',
  'quota exceeded',
  'exceeded your current quota',
  'insufficient_quota',
  'out of credits',
];

/**
 * Phrases that third-party services emit too. An agent narrates "Rate limited
 * by the GitHub API, retrying" about somebody else's quota, and that narration
 * must never kill the worker or bench OUR pool. These count only as a bare
 * notice: nothing may follow the phrase except punctuation, a reset/retry
 * clause, a parenthesised detail, or a number. Provider first-person wording
 * ("hit your session limit", "usage_credits_required") and connector-declared
 * phrases are not subject to this rule.
 */
export const GENERIC_QUOTA_SIGNATURES = [
  'rate limit exceeded',
  'rate_limit_exceeded',
  'rate limited',
  'too many requests',
  'quota exceeded',
  'out of credits',
];
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
 * "error-shaped" means.
 */
export const ERROR_SHAPED_LINE =
  /^(?:error|fatal)(?:\b|:)|^(?:authentication failed|failed to authenticate|not authenticated|invalid api key|rate limit(?:ed| exceeded)?|cmd login)(?:[.!:]|$)|\b(?:http\s*(?:401|403|429)|status\s*(?:401|403|429)|login required|please login|access denied|quota exceeded)\b/i;

function quotaSignaturesFor(connector) {
  const declared = Array.isArray(connector?.quotaSignatures) ? connector.quotaSignatures : [];
  return [...declared, ...DEFAULT_QUOTA_SIGNATURES];
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
 * Quota signature WITH its matched line and a bounded context window.
 * Returns null unless the line is quota-shaped (Q2).
 */
export function findQuotaFailure(connector, text) {
  const raw = String(text ?? '');
  if (!raw) return null;
  const lower = raw.toLowerCase();
  for (const signature of quotaSignaturesFor(connector)) {
    const needle = String(signature ?? '').toLowerCase();
    if (!needle) continue;
    const index = lower.indexOf(needle);
    if (index < 0) continue;
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
