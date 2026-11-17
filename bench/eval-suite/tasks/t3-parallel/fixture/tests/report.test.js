import test from 'node:test';
import assert from 'node:assert/strict';
import { balances } from '../src/report.js';

test('rolls child balances up into the parent account', () => {
  const txs = [
    {
      date: '2024-01-05',
      description: 'Groceries',
      postings: [
        { account: 'expenses:food', cents: 1250 },
        { account: 'assets:bank', cents: -1250 },
      ],
    },
  ];
  assert.deepEqual(balances(txs), [
    { account: 'assets', cents: -1250 },
    { account: 'assets:bank', cents: -1250 },
    { account: 'expenses', cents: 1250 },
    { account: 'expenses:food', cents: 1250 },
  ]);
});
