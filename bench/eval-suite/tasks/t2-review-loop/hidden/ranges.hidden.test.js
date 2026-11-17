import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRange, format, daysIn, overlaps, merge, subtract, split } from '../../src/ranges.js';

const r = (s, e) => ({ start: s, end: e });

// ---------------------------------------------------------------- happy path

// happy: parseRange returns start and end for a valid range
test('happy: parseRange valid range', () => {
  assert.deepEqual(parseRange('2026-03-09..2026-04-21'), r('2026-03-09', '2026-04-21'));
});

// happy: parseRange rejects malformed text and impossible dates
test('happy: parseRange malformed input throws', () => {
  assert.throws(() => parseRange('2026-01-05'), RangeError);
  assert.throws(() => parseRange('2026-13-01..2026-13-02'), RangeError);
  assert.throws(() => parseRange('2026-02-29..2026-03-05'), RangeError);
});

// happy: overlaps is true for shared days and false for disjoint or adjacent ranges
test('happy: overlaps basics', () => {
  assert.equal(overlaps(r('2026-01-01', '2026-01-10'), r('2026-01-10', '2026-01-12')), true);
  assert.equal(overlaps(r('2026-01-01', '2026-01-10'), r('2026-01-11', '2026-01-12')), false);
  assert.equal(overlaps(r('2026-05-01', '2026-05-02'), r('2026-01-01', '2026-01-02')), false);
});

// happy: merge joins overlapping sorted ranges and leaves gaps alone
test('happy: merge overlapping sorted ranges', () => {
  assert.deepEqual(
    merge([r('2026-01-01', '2026-01-10'), r('2026-01-08', '2026-01-15'), r('2026-02-01', '2026-02-03')]),
    [r('2026-01-01', '2026-01-15'), r('2026-02-01', '2026-02-03')],
  );
});

// happy: merge handles an empty list and does not change its input
test('happy: merge empty and no mutation', () => {
  assert.deepEqual(merge([]), []);
  const input = [r('2026-01-01', '2026-01-10'), r('2026-01-05', '2026-01-20')];
  const copy = JSON.parse(JSON.stringify(input));
  merge(input);
  assert.deepEqual(input, copy);
});

// happy: subtract from the middle gives two pieces, and a far-away range changes nothing
test('happy: subtract middle and disjoint', () => {
  assert.deepEqual(subtract(r('2026-03-01', '2026-03-31'), r('2026-03-10', '2026-03-12')), [
    r('2026-03-01', '2026-03-09'),
    r('2026-03-13', '2026-03-31'),
  ]);
  assert.deepEqual(subtract(r('2026-03-01', '2026-03-05'), r('2026-04-01', '2026-04-05')), [
    r('2026-03-01', '2026-03-05'),
  ]);
});

// happy: split by week keeps a range inside one week as a single piece
test('happy: split week inside a single week', () => {
  assert.deepEqual(split(r('2026-01-05', '2026-01-07'), 'week'), [r('2026-01-05', '2026-01-07')]);
});

// happy: split by month in a year without leap-day trouble, plus the unit check
test('happy: split month ordinary months and bad unit', () => {
  assert.deepEqual(split(r('2026-04-20', '2026-06-02'), 'month'), [
    r('2026-04-20', '2026-04-30'),
    r('2026-05-01', '2026-05-31'),
    r('2026-06-01', '2026-06-02'),
  ]);
  assert.throws(() => split(r('2026-01-01', '2026-01-31'), 'day'), RangeError);
});

// ------------------------------------------------------------------- daysIn

// daysIn: a one-day range has 1 day
test('daysIn: single day is 1', () => {
  assert.equal(daysIn(r('2026-01-05', '2026-01-05')), 1);
});

// daysIn: a full January counts both first and last day
test('daysIn: whole month counts both ends', () => {
  assert.equal(daysIn(r('2026-01-01', '2026-01-31')), 31);
  assert.equal(daysIn(r('2026-01-01', '2026-12-31')), 365);
});

// daysIn: counting across a month boundary and through a leap day
test('daysIn: across month boundary and leap day', () => {
  assert.equal(daysIn(r('2026-02-27', '2026-03-02')), 4);
  assert.equal(daysIn(r('2024-02-28', '2024-03-01')), 3);
});

// --------------------------------------------------------- merge: touching

// merge: ranges where one ends the day before the next starts become one
test('merge touching: adjacent days join', () => {
  assert.deepEqual(merge([r('2026-01-01', '2026-01-05'), r('2026-01-06', '2026-01-10')]), [
    r('2026-01-01', '2026-01-10'),
  ]);
});

// merge: touching across a month end and a year end
test('merge touching: across month and year boundaries', () => {
  assert.deepEqual(merge([r('2026-01-20', '2026-01-31'), r('2026-02-01', '2026-02-05')]), [
    r('2026-01-20', '2026-02-05'),
  ]);
  assert.deepEqual(merge([r('2025-12-25', '2025-12-31'), r('2026-01-01', '2026-01-02')]), [
    r('2025-12-25', '2026-01-02'),
  ]);
});

// merge: a chain of touching ranges collapses, but a one-day gap does not
test('merge touching: chain joins and one-day gap stays', () => {
  assert.deepEqual(
    merge([
      r('2026-03-01', '2026-03-03'),
      r('2026-03-04', '2026-03-06'),
      r('2026-03-07', '2026-03-07'),
      r('2026-03-09', '2026-03-10'),
    ]),
    [r('2026-03-01', '2026-03-07'), r('2026-03-09', '2026-03-10')],
  );
});

// ------------------------------------------------- subtract: b covers a's end

// subtract: b starts inside a and runs past a's end, leaving only the front
test('subtract end: b starts inside a and passes its end', () => {
  assert.deepEqual(subtract(r('2026-01-01', '2026-01-10'), r('2026-01-05', '2026-01-20')), [
    r('2026-01-01', '2026-01-04'),
  ]);
});

// subtract: b covers all of a and more on both sides gives nothing
test('subtract end: b swallows a and passes its end', () => {
  assert.deepEqual(subtract(r('2026-01-05', '2026-01-10'), r('2025-12-30', '2026-01-20')), []);
});

// subtract: b starts at a's first day and runs past a's end gives nothing
test('subtract end: b starts with a and passes its end', () => {
  assert.deepEqual(subtract(r('2026-02-01', '2026-02-10'), r('2026-02-01', '2026-02-11')), []);
  assert.deepEqual(subtract(r('2026-02-01', '2026-02-10'), r('2026-02-10', '2026-03-31')), [
    r('2026-02-01', '2026-02-09'),
  ]);
});

// ----------------------------------------------------- split: week (Monday)

// split week: three whole Monday-to-Sunday weeks
test('split week: whole ISO weeks', () => {
  assert.deepEqual(split(r('2026-01-05', '2026-01-25'), 'week'), [
    r('2026-01-05', '2026-01-11'),
    r('2026-01-12', '2026-01-18'),
    r('2026-01-19', '2026-01-25'),
  ]);
});

// split week: a range starting midweek is cut at the next Sunday
test('split week: starts midweek', () => {
  assert.deepEqual(split(r('2026-01-07', '2026-01-20'), 'week'), [
    r('2026-01-07', '2026-01-11'),
    r('2026-01-12', '2026-01-18'),
    r('2026-01-19', '2026-01-20'),
  ]);
});

// split week: a range starting on a Sunday gets a one-day first piece
test('split week: starts on a Sunday', () => {
  assert.deepEqual(split(r('2026-01-04', '2026-01-12'), 'week'), [
    r('2026-01-04', '2026-01-04'),
    r('2026-01-05', '2026-01-11'),
    r('2026-01-12', '2026-01-12'),
  ]);
});

// ------------------------------------------------- split: month with leap day

// split month: a leap-year February has 29 days
test('split month leap: February 2024 stays whole', () => {
  assert.deepEqual(split(r('2024-02-01', '2024-02-29'), 'month'), [r('2024-02-01', '2024-02-29')]);
});

// split month: a range running through a leap February keeps the 29th
test('split month leap: range across leap February', () => {
  assert.deepEqual(split(r('2024-01-15', '2024-03-10'), 'month'), [
    r('2024-01-15', '2024-01-31'),
    r('2024-02-01', '2024-02-29'),
    r('2024-03-01', '2024-03-10'),
  ]);
});

// split month: 2000 is a leap year, 2100 is not
test('split month leap: century years', () => {
  assert.deepEqual(split(r('2000-02-10', '2000-03-05'), 'month'), [
    r('2000-02-10', '2000-02-29'),
    r('2000-03-01', '2000-03-05'),
  ]);
  assert.deepEqual(split(r('2100-02-10', '2100-03-05'), 'month'), [
    r('2100-02-10', '2100-02-28'),
    r('2100-03-01', '2100-03-05'),
  ]);
});

// --------------------------------------------------- merge: unsorted input

// merge: two overlapping ranges given latest-first still merge to the full span
test('merge unsorted: overlapping, latest first', () => {
  assert.deepEqual(merge([r('2026-01-10', '2026-01-15'), r('2026-01-01', '2026-01-12')]), [
    r('2026-01-01', '2026-01-15'),
  ]);
});

// merge: disjoint ranges given out of order come back sorted by start
test('merge unsorted: disjoint ranges come back sorted', () => {
  assert.deepEqual(merge([r('2026-03-01', '2026-03-05'), r('2026-01-01', '2026-01-05'), r('2026-02-01', '2026-02-05')]), [
    r('2026-01-01', '2026-01-05'),
    r('2026-02-01', '2026-02-05'),
    r('2026-03-01', '2026-03-05'),
  ]);
});

// merge: a long range listed last absorbs shorter ranges listed before it
test('merge unsorted: big range last swallows the rest', () => {
  assert.deepEqual(
    merge([r('2026-02-05', '2026-02-06'), r('2026-02-20', '2026-02-22'), r('2026-02-01', '2026-02-28')]),
    [r('2026-02-01', '2026-02-28')],
  );
});

// ------------------------------------------------ parseRange: end before start

// parseRange: an end a month before the start throws
test('parseRange order: end before start throws', () => {
  assert.throws(() => parseRange('2026-02-10..2026-01-05'), RangeError);
});

// parseRange: an end one day before the start throws, one day range is fine
test('parseRange order: one day early throws, same day ok', () => {
  assert.throws(() => parseRange('2026-01-06..2026-01-05'), RangeError);
  assert.deepEqual(parseRange('2026-01-05..2026-01-05'), r('2026-01-05', '2026-01-05'));
});

// parseRange: an earlier month in a later year still counts as before the start
test('parseRange order: later year start with earlier month end', () => {
  assert.throws(() => parseRange('2026-12-31..2026-01-01'), RangeError);
  assert.throws(() => parseRange('2027-01-01..2026-12-31'), RangeError);
});

// ---------------------------------------------------------- format: padding

// format: single-digit months and days keep their leading zero
test('format padding: single-digit month and day', () => {
  assert.equal(format(r('2026-01-05', '2026-02-09')), '2026-01-05..2026-02-09');
});

// format: a September range written with the first of the month
test('format padding: first of month', () => {
  assert.equal(format(r('2026-09-01', '2026-09-30')), '2026-09-01..2026-09-30');
});

// format: parseRange then format gives back the same text
test('format padding: round trip with parseRange', () => {
  for (const text of ['2026-03-07..2026-03-08', '2026-10-01..2026-10-09', '2026-07-04..2026-07-04']) {
    assert.equal(format(parseRange(text)), text);
  }
});
