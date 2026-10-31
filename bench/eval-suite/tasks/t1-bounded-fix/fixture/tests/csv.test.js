import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../src/csv.js';

test('plain rows', () => {
  assert.deepEqual(parseCsv('a,b\n1,2\n'), [['a', 'b'], ['1', '2']]);
});

test('a quoted field without special characters', () => {
  assert.deepEqual(parseCsv('"a",b'), [['a', 'b']]);
});
