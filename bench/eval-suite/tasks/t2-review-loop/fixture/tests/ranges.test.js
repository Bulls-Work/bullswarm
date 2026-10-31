import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRange, format, overlaps, merge, subtract, split } from '../src/ranges.js';

test('parseRange reads a start and an end', () => {
  assert.deepEqual(parseRange('2026-01-05..2026-02-10'), {
    start: '2026-01-05',
    end: '2026-02-10',
  });
});

test('parseRange rejects text that is not a range', () => {
  assert.throws(() => parseRange('hello'), RangeError);
  assert.throws(() => parseRange('2026-02-30..2026-03-05'), RangeError);
});

test('format writes a two-digit month and day range', () => {
  assert.equal(format({ start: '2026-11-15', end: '2026-12-20' }), '2026-11-15..2026-12-20');
});

test('overlaps is true for ranges that share days and false for apart ranges', () => {
  assert.equal(overlaps(parseRange('2026-01-01..2026-01-10'), parseRange('2026-01-05..2026-01-20')), true);
  assert.equal(overlaps(parseRange('2026-01-01..2026-01-10'), parseRange('2026-02-01..2026-02-05')), false);
});

test('merge joins overlapping ranges', () => {
  assert.deepEqual(
    merge([parseRange('2026-01-01..2026-01-10'), parseRange('2026-01-05..2026-01-20')]),
    [parseRange('2026-01-01..2026-01-20')],
  );
});

test('subtract removes the middle of a range', () => {
  assert.deepEqual(subtract(parseRange('2026-03-01..2026-03-31'), parseRange('2026-03-10..2026-03-12')), [
    parseRange('2026-03-01..2026-03-09'),
    parseRange('2026-03-13..2026-03-31'),
  ]);
});

test('split by month follows calendar months', () => {
  assert.deepEqual(split(parseRange('2026-05-20..2026-07-10'), 'month'), [
    parseRange('2026-05-20..2026-05-31'),
    parseRange('2026-06-01..2026-06-30'),
    parseRange('2026-07-01..2026-07-10'),
  ]);
});

test('split rejects an unknown unit', () => {
  assert.throws(() => split(parseRange('2026-01-01..2026-01-31'), 'year'), RangeError);
});
