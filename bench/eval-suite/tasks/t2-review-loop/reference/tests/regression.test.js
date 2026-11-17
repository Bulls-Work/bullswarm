import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRange, format, daysIn, merge, subtract, split } from '../src/ranges.js';

const r = (s, e) => ({ start: s, end: e });

test('daysIn counts both the first and the last day', () => {
  assert.equal(daysIn(r('2026-01-05', '2026-01-05')), 1);
  assert.equal(daysIn(r('2026-01-01', '2026-01-31')), 31);
});

test('merge joins ranges that touch', () => {
  assert.deepEqual(merge([r('2026-01-01', '2026-01-05'), r('2026-01-06', '2026-01-10')]), [r('2026-01-01', '2026-01-10')]);
});

test('subtract returns only the front when b runs past the end of a', () => {
  assert.deepEqual(subtract(r('2026-01-01', '2026-01-10'), r('2026-01-05', '2026-01-20')), [r('2026-01-01', '2026-01-04')]);
  assert.deepEqual(subtract(r('2026-01-05', '2026-01-10'), r('2025-12-30', '2026-01-20')), []);
});

test('split by week uses Monday as the first day', () => {
  assert.deepEqual(split(r('2026-01-04', '2026-01-12'), 'week'), [
    r('2026-01-04', '2026-01-04'),
    r('2026-01-05', '2026-01-11'),
    r('2026-01-12', '2026-01-12'),
  ]);
});

test('split by month keeps February 29 in leap years only', () => {
  assert.deepEqual(split(r('2024-02-01', '2024-02-29'), 'month'), [r('2024-02-01', '2024-02-29')]);
  assert.deepEqual(split(r('2100-02-10', '2100-03-05'), 'month'), [r('2100-02-10', '2100-02-28'), r('2100-03-01', '2100-03-05')]);
});

test('merge accepts unsorted input and returns sorted output', () => {
  assert.deepEqual(merge([r('2026-01-10', '2026-01-15'), r('2026-01-01', '2026-01-12')]), [r('2026-01-01', '2026-01-15')]);
  assert.deepEqual(merge([r('2026-03-01', '2026-03-02'), r('2026-01-01', '2026-01-02')]), [
    r('2026-01-01', '2026-01-02'),
    r('2026-03-01', '2026-03-02'),
  ]);
});

test('parseRange rejects an end before the start', () => {
  assert.throws(() => parseRange('2026-02-10..2026-01-05'), RangeError);
  assert.deepEqual(parseRange('2026-01-05..2026-01-05'), r('2026-01-05', '2026-01-05'));
});

test('format zero-pads month and day', () => {
  assert.equal(format(r('2026-01-05', '2026-02-09')), '2026-01-05..2026-02-09');
});
