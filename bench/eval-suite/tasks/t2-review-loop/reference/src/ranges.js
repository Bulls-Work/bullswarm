// Date-range utilities.
//
// A range is a plain object { start, end } where both fields are ISO calendar
// dates ('YYYY-MM-DD') and both ends are inclusive. All date math is done on
// whole UTC days, so there are no time zones or daylight-saving shifts to
// worry about.

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

// ---------------------------------------------------------------------------
// Day-number helpers (internal)
// ---------------------------------------------------------------------------

function pad(n, width = 2) {
  return String(n).padStart(width, '0');
}

/** Whole days since 1970-01-01 for a (year, month 1-12, day) triple. */
function toDayNumber(year, month, day) {
  return Date.UTC(year, month - 1, day) / MS_PER_DAY;
}

/** Day number for an ISO date string. Throws RangeError if it is not a real date. */
function dayOf(iso) {
  const m = ISO_DATE.exec(iso);
  if (!m) {
    throw new RangeError(`Invalid date: ${iso}`);
  }
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const n = toDayNumber(year, month, day);
  const back = new Date(n * MS_PER_DAY);
  if (
    back.getUTCFullYear() !== year ||
    back.getUTCMonth() !== month - 1 ||
    back.getUTCDate() !== day
  ) {
    throw new RangeError(`Invalid date: ${iso}`);
  }
  return n;
}

/** ISO date string for a day number. */
function isoOf(dayNumber) {
  const d = new Date(dayNumber * MS_PER_DAY);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Shift an ISO date string by a number of days (may be negative). */
function addDays(iso, days) {
  return isoOf(dayOf(iso) + days);
}

/** Build a range object from two day numbers. */
function rangeOfDays(startDay, endDay) {
  return { start: isoOf(startDay), end: isoOf(endDay) };
}

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year, month) {
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Day of week for a day number: 0 = Sunday ... 6 = Saturday. */
function weekdayOf(dayNumber) {
  return new Date(dayNumber * MS_PER_DAY).getUTCDay();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse text like '2026-01-05..2026-02-10' into { start, end }.
 * Throws RangeError for malformed text, impossible dates, or an end that is
 * earlier than the start. A one-day range ('2026-01-05..2026-01-05') is valid.
 */
export function parseRange(text) {
  if (typeof text !== 'string') {
    throw new RangeError('Range must be a string');
  }
  const parts = text.split('..');
  if (parts.length !== 2) {
    throw new RangeError(`Invalid range: ${text}`);
  }
  const [start, end] = parts;
  const startDay = dayOf(start);
  const endDay = dayOf(end);
  if (endDay < startDay) {
    throw new RangeError(`Range ends before it starts: ${text}`);
  }
  return { start, end };
}

/**
 * Text form of a range, e.g. '2026-01-05..2026-02-10'. Months and days are
 * always two digits.
 */
export function format(range) {
  const part = (iso) => {
    const d = new Date(dayOf(iso) * MS_PER_DAY);
    return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  };
  return `${part(range.start)}..${part(range.end)}`;
}

/**
 * Number of calendar days in the range, counting both the first and the last
 * day. A one-day range has 1 day.
 */
export function daysIn(range) {
  return dayOf(range.end) - dayOf(range.start) + 1;
}

/**
 * True when the two ranges share at least one day. Ranges that merely sit
 * next to each other (one ends the day before the other starts) do not
 * overlap.
 */
export function overlaps(a, b) {
  return dayOf(a.start) <= dayOf(b.end) && dayOf(b.start) <= dayOf(a.end);
}

/**
 * Combine ranges that overlap or touch (one ends the day before the next
 * starts) into the fewest possible ranges. The input may be in any order and
 * is not modified. The result is sorted by start date.
 */
export function merge(list) {
  const sorted = list
    .map((r) => ({ startDay: dayOf(r.start), endDay: dayOf(r.end) }))
    .sort((x, y) => x.startDay - y.startDay || x.endDay - y.endDay);

  const out = [];
  let current = null;
  for (const item of sorted) {
    if (current && item.startDay <= current.endDay + 1) {
      current.endDay = Math.max(current.endDay, item.endDay);
    } else {
      if (current) {
        out.push(rangeOfDays(current.startDay, current.endDay));
      }
      current = { startDay: item.startDay, endDay: item.endDay };
    }
  }
  if (current) {
    out.push(rangeOfDays(current.startDay, current.endDay));
  }
  return out;
}

/**
 * The days of `a` that are not in `b`, as 0, 1 or 2 ranges in date order.
 * If `b` does not touch `a`, the result is [a]. If `b` covers all of `a`, the
 * result is [].
 */
export function subtract(a, b) {
  if (!overlaps(a, b)) {
    return [{ start: a.start, end: a.end }];
  }
  const aStart = dayOf(a.start);
  const aEnd = dayOf(a.end);
  const bStart = dayOf(b.start);
  const bEnd = dayOf(b.end);

  const out = [];
  if (aStart < bStart) {
    out.push(rangeOfDays(aStart, bStart - 1));
  }
  if (bEnd < aEnd) {
    out.push(rangeOfDays(bEnd + 1, aEnd));
  }
  return out;
}

/**
 * Cut a range into consecutive pieces along calendar boundaries.
 *   'month' - pieces never cross the end of a calendar month
 *   'week'  - pieces never cross the end of an ISO week (weeks start on Monday)
 * The first and last piece are trimmed to the range, so together the pieces
 * cover exactly the original days. Throws RangeError for any other unit.
 */
export function split(range, unit) {
  if (unit !== 'month' && unit !== 'week') {
    throw new RangeError(`Unknown unit: ${unit}`);
  }
  const startDay = dayOf(range.start);
  const endDay = dayOf(range.end);
  const pieces = [];

  let cursor = startDay;
  while (cursor <= endDay) {
    let boundary;
    if (unit === 'month') {
      const d = new Date(cursor * MS_PER_DAY);
      const year = d.getUTCFullYear();
      const month = d.getUTCMonth() + 1;
      boundary = toDayNumber(year, month, daysInMonth(year, month));
    } else {
      const sinceMonday = (weekdayOf(cursor) + 6) % 7;
      boundary = cursor + (6 - sinceMonday);
    }
    const pieceEnd = Math.min(boundary, endDay);
    if (pieceEnd < cursor) {
      break; // safety net: never loop forever on a bad boundary
    }
    pieces.push(rangeOfDays(cursor, pieceEnd));
    cursor = pieceEnd + 1;
  }
  return pieces;
}

// Exposed for callers that want to step a date by hand.
export { addDays };
