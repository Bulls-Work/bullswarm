import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parse.js';

test('parses one balanced transaction', () => {
  const text = '2024-01-05 Groceries\n  expenses:food  12.50\n  assets:bank\n';
  assert.deepEqual(parse(text), [
    {
      date: '2024-01-05',
      description: 'Groceries',
      postings: [
        { account: 'expenses:food', cents: 1250 },
        { account: 'assets:bank', cents: -1250 },
      ],
    },
  ]);
});
