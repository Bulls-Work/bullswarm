import test from 'node:test';
import assert from 'node:assert/strict';
import { balances, register, filterByDate, formatCents } from '../../src/report.js';

const tx = (date, description, ...postings) => ({
  date,
  description,
  postings: postings.map(([account, cents]) => ({ account, cents })),
});

const T = [
  tx('2024-01-01', 'Opening', ['assets:bank', 100000], ['equity:opening', -100000]),
  tx('2024-01-05', 'Groceries', ['expenses:food', 4250], ['assets:bank', -4250]),
  tx('2024-01-20', 'Salary', ['assets:bank', 200000], ['income:salary', -200000]),
  tx('2024-02-01', 'Cash out', ['assets:cash', 5000], ['assets:bank', -5000]),
];

// formatCents: basic positive values
test('formatCents positive', () => {
  assert.equal(formatCents(1250), '12.50');
  assert.equal(formatCents(5), '0.05');
  assert.equal(formatCents(100), '1.00');
  assert.equal(formatCents(123456), '1234.56');
});

// formatCents: zero and negatives
test('formatCents zero and negative', () => {
  assert.equal(formatCents(0), '0.00');
  assert.equal(formatCents(-5), '-0.05');
  assert.equal(formatCents(-1250), '-12.50');
  assert.equal(formatCents(-100000), '-1000.00');
});

// formatCents: no separators, large values stay exact
test('formatCents large values', () => {
  assert.equal(formatCents(123456789012), '1234567890.12');
  assert.equal(formatCents(-99), '-0.99');
});

// filterByDate: no options returns everything
test('filterByDate without options', () => {
  assert.deepEqual(filterByDate(T), T);
  assert.deepEqual(filterByDate(T, {}), T);
});

// filterByDate: from is inclusive
test('filterByDate from inclusive', () => {
  assert.deepEqual(filterByDate(T, { from: '2024-01-20' }).map((t) => t.description), ['Salary', 'Cash out']);
});

// filterByDate: to is inclusive
test('filterByDate to inclusive', () => {
  assert.deepEqual(filterByDate(T, { to: '2024-01-05' }).map((t) => t.description), ['Opening', 'Groceries']);
});

// filterByDate: both bounds, and an empty window
test('filterByDate from and to', () => {
  assert.deepEqual(filterByDate(T, { from: '2024-01-02', to: '2024-01-31' }).map((t) => t.description), ['Groceries', 'Salary']);
  assert.deepEqual(filterByDate(T, { from: '2025-01-01' }), []);
  assert.deepEqual(filterByDate(T, { from: '2024-01-10', to: '2024-01-09' }), []);
});

// filterByDate returns a new array and leaves the input alone
test('filterByDate does not mutate or alias', () => {
  const copy = JSON.parse(JSON.stringify(T));
  const out = filterByDate(T, {});
  assert.notEqual(out, T);
  assert.deepEqual(T, copy);
});

// balances: empty input
test('balances of no transactions', () => {
  assert.deepEqual(balances([]), []);
});

// balances: parents are rolled up and listed, sorted by name
test('balances roll up and sort', () => {
  assert.deepEqual(balances(T.slice(0, 3)), [
    { account: 'assets', cents: 295750 },
    { account: 'assets:bank', cents: 295750 },
    { account: 'equity', cents: -100000 },
    { account: 'equity:opening', cents: -100000 },
    { account: 'expenses', cents: 4250 },
    { account: 'expenses:food', cents: 4250 },
    { account: 'income', cents: -200000 },
    { account: 'income:salary', cents: -200000 },
  ]);
});

// balances: a parent sums several children
test('balances parent sums siblings', () => {
  const r = balances(T);
  const get = (a) => r.find((x) => x.account === a).cents;
  assert.equal(get('assets'), 295750);
  assert.equal(get('assets:bank'), 290750);
  assert.equal(get('assets:cash'), 5000);
});

// balances: postings made directly on a parent add to its roll-up
test('balances parent with own postings', () => {
  const r = balances([tx('2024-01-01', 'x', ['assets', 700], ['assets:bank', 300], ['income', -1000])]);
  assert.deepEqual(r, [
    { account: 'assets', cents: 1000 },
    { account: 'assets:bank', cents: 300 },
    { account: 'income', cents: -1000 },
  ]);
});

// balances: deep hierarchies list every level
test('balances deep hierarchy', () => {
  const r = balances([tx('2024-01-01', 'x', ['a:b:c:d', 100], ['z', -100])]);
  assert.deepEqual(r.map((x) => x.account), ['a', 'a:b', 'a:b:c', 'a:b:c:d', 'z']);
  assert.deepEqual(r.map((x) => x.cents), [100, 100, 100, 100, -100]);
});

// balances: zero-total accounts are still listed
test('balances keeps zero accounts', () => {
  const r = balances([tx('2024-01-01', 'x', ['a', 500], ['b', -500]), tx('2024-01-02', 'y', ['a', -500], ['b', 500])]);
  assert.deepEqual(r, [
    { account: 'a', cents: 0 },
    { account: 'b', cents: 0 },
  ]);
});

// balances: a name that is a prefix but not a parent is not rolled in
test('balances does not confuse prefix names', () => {
  const r = balances([tx('2024-01-01', 'x', ['assets:bank', 100], ['assetsx', -100])]);
  assert.deepEqual(r, [
    { account: 'assets', cents: 100 },
    { account: 'assets:bank', cents: 100 },
    { account: 'assetsx', cents: -100 },
  ]);
});

// balances: sort is plain string comparison of full names
test('balances sort order is by full name', () => {
  const r = balances([tx('2024-01-01', 'x', ['b', 1], ['a:z', 1], ['a', 1], ['a:b', -3])]);
  assert.deepEqual(r.map((x) => x.account), ['a', 'a:b', 'a:z', 'b']);
});

// balances: date filter applies before summing
test('balances with from/to', () => {
  const r = balances(T, { from: '2024-01-05', to: '2024-01-31' });
  assert.deepEqual(r, [
    { account: 'assets', cents: 195750 },
    { account: 'assets:bank', cents: 195750 },
    { account: 'expenses', cents: 4250 },
    { account: 'expenses:food', cents: 4250 },
    { account: 'income', cents: -200000 },
    { account: 'income:salary', cents: -200000 },
  ]);
});

// balances: sums stay exact over many small amounts
test('balances exact over many cents', () => {
  const many = [];
  for (let i = 0; i < 1000; i++) many.push(tx('2024-01-01', 'p', ['a', 10], ['b', -10]));
  assert.deepEqual(balances(many), [
    { account: 'a', cents: 10000 },
    { account: 'b', cents: -10000 },
  ]);
});

// balances: input is not modified
test('balances does not mutate input', () => {
  const copy = JSON.parse(JSON.stringify(T));
  balances(T, { from: '2024-01-02' });
  assert.deepEqual(T, copy);
});

// register: running totals for a leaf account
test('register leaf account with running total', () => {
  assert.deepEqual(register(T, 'assets:bank'), [
    { date: '2024-01-01', description: 'Opening', cents: 100000, total: 100000 },
    { date: '2024-01-05', description: 'Groceries', cents: -4250, total: 95750 },
    { date: '2024-01-20', description: 'Salary', cents: 200000, total: 295750 },
    { date: '2024-02-01', description: 'Cash out', cents: -5000, total: 290750 },
  ]);
});

// register: a parent account includes its sub-accounts
test('register parent includes sub-accounts', () => {
  const rows = register(T, 'assets');
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.map((r) => r.total), [100000, 95750, 295750, 300750, 295750]);
});

// register: prefix text that is not a whole segment does not match
test('register requires a whole-segment match', () => {
  assert.deepEqual(register(T, 'assets:ba'), []);
  assert.deepEqual(register(T, 'asset'), []);
  assert.deepEqual(register(T, 'assets:bank:x'), []);
});

// register: unknown account yields no rows
test('register unknown account', () => {
  assert.deepEqual(register(T, 'liabilities'), []);
  assert.deepEqual(register([], 'assets'), []);
});

// register: rows are ordered by date, ties keep file order
test('register orders by date, stable for ties', () => {
  const ts = [
    tx('2024-03-02', 'late', ['a', 100], ['b', -100]),
    tx('2024-03-01', 'first', ['a', 200], ['b', -200]),
    tx('2024-03-02', 'late2', ['a', 300], ['b', -300]),
  ];
  const rows = register(ts, 'a');
  assert.deepEqual(rows.map((r) => r.description), ['first', 'late', 'late2']);
  assert.deepEqual(rows.map((r) => r.total), [200, 300, 600]);
});

// register: two postings of one account in one transaction give two rows
test('register one row per posting', () => {
  const rows = register([tx('2024-01-01', 'split', ['a', 100], ['a', 50], ['b', -150])], 'a');
  assert.deepEqual(rows, [
    { date: '2024-01-01', description: 'split', cents: 100, total: 100 },
    { date: '2024-01-01', description: 'split', cents: 50, total: 150 },
  ]);
});

// register: date filter restarts the running total at zero
test('register with from/to restarts total', () => {
  assert.deepEqual(register(T, 'assets:bank', { from: '2024-01-05', to: '2024-01-31' }), [
    { date: '2024-01-05', description: 'Groceries', cents: -4250, total: -4250 },
    { date: '2024-01-20', description: 'Salary', cents: 200000, total: 195750 },
  ]);
});

// register: input is not modified or reordered
test('register does not mutate input', () => {
  const ts = [tx('2024-03-02', 'b', ['a', 1], ['c', -1]), tx('2024-03-01', 'a', ['a', 1], ['c', -1])];
  const copy = JSON.parse(JSON.stringify(ts));
  register(ts, 'a');
  assert.deepEqual(ts, copy);
});
