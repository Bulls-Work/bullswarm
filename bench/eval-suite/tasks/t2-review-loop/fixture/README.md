# date-ranges

A small library for working with calendar date ranges. Everything lives in
`src/ranges.js`. It uses only Node's standard library (Node 22).

Run the tests with `npm test` (this runs `node --test`).

## What a range is

A range is a plain object `{ start, end }`. Both fields are ISO dates written
`YYYY-MM-DD`, and **both ends are included**: `{ start: '2026-01-05', end: '2026-01-05' }`
is a valid range that covers exactly one day. The text form is
`2026-01-05..2026-02-10`. Dates are plain calendar days: there are no times,
time zones or daylight-saving changes.

Functions that take bad input throw a `RangeError`.

## Functions

- `parseRange(text)` turns `'2026-01-05..2026-02-10'` into `{ start, end }`.
  It throws if the text is malformed, if a date does not exist (for example
  `2026-02-30`), or if the end is earlier than the start.
- `format(range)` is the reverse of `parseRange`. Months and days are always
  two digits: `'2026-01-05..2026-02-09'`.
- `daysIn(range)` is the number of calendar days in the range, counting the
  first day and the last day. A one-day range has 1 day.
- `overlaps(a, b)` is `true` when the two ranges share at least one day.
  Ranges that only sit side by side (one ends the day before the other
  starts) do not overlap.
- `merge(list)` joins ranges that overlap **or touch** (one ends the day
  before the next starts) so that as few ranges as possible remain. The input
  can be in any order and must not be changed. The result is sorted by start
  date.
- `subtract(a, b)` returns the days of `a` that are not in `b`, as zero, one
  or two ranges in date order. If `b` does not touch `a`, the result is `[a]`.
  If `b` covers all of `a`, the result is `[]`.
- `split(range, unit)` cuts a range into consecutive pieces. With `'month'`
  the pieces follow calendar months (leap years included). With `'week'` the
  pieces follow ISO weeks, which start on Monday. The first and last pieces
  are trimmed to the range, so the pieces together cover exactly the days of
  the original range. Any other unit throws.

## Task

The library is in use, but users have reported wrong results. Find every place
where `src/ranges.js` does not behave as described above and fix it. Add a
regression test for each fix.
