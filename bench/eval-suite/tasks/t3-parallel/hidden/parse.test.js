import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, isValidDate, ParseError } from '../../src/parse.js';

function fails(text, line, reason) {
  assert.throws(
    () => parse(text),
    (e) => e instanceof ParseError && e.line === line && e.reason === reason && e.message === `line ${line}: ${reason}`,
  );
}

// empty input gives an empty list
test('empty text parses to []', () => {
  assert.deepEqual(parse(''), []);
  assert.deepEqual(parse('\n\n  \n'), []);
});

// a transaction with explicit amounts that balance
test('two explicit postings', () => {
  assert.deepEqual(parse('2024-03-01 Rent\n  expenses:rent 800.00\n  assets:bank -800.00\n'), [
    {
      date: '2024-03-01',
      description: 'Rent',
      postings: [
        { account: 'expenses:rent', cents: 80000 },
        { account: 'assets:bank', cents: -80000 },
      ],
    },
  ]);
});

// the posting without an amount gets the negated sum
test('balancing posting is filled in', () => {
  const [t] = parse('2024-03-01 Split\n  a 10.00\n  b 5.25\n  c\n');
  assert.deepEqual(t.postings.map((p) => p.cents), [1000, 525, -1525]);
});

// the balancing posting may be in the middle
test('balancing posting in the middle', () => {
  const [t] = parse('2024-03-01 Mid\n  a 3.00\n  b\n  c 4.00\n  d -1.00\n');
  assert.deepEqual(t.postings.map((p) => p.cents), [300, -600, 400, -100]);
});

// amounts are exact integer cents, no float drift
test('amounts are exact cents (0.10 + 0.20 style sums)', () => {
  const [t] = parse('2024-03-01 Float\n  a 0.10\n  b 0.20\n  c -0.30\n');
  assert.deepEqual(t.postings.map((p) => p.cents), [10, 20, -30]);
  const [u] = parse('2024-03-01 Big\n  a 1234567.89\n  b\n');
  assert.deepEqual(u.postings.map((p) => p.cents), [123456789, -123456789]);
  assert.ok(u.postings.every((p) => Number.isInteger(p.cents)));
});

// negative amounts below one unit keep their sign
test('negative sub-unit amount', () => {
  const [t] = parse('2024-03-01 Tiny\n  a -0.05\n  b 0.05\n');
  assert.deepEqual(t.postings.map((p) => p.cents), [-5, 5]);
});

// several transactions keep file order, even when dates are out of order
test('multiple transactions in file order', () => {
  const ts = parse('2024-05-01 B\n  a 1.00\n  b\n\n2024-01-01 A\n  a 2.00\n  b\n');
  assert.deepEqual(ts.map((t) => t.description), ['B', 'A']);
});

// a header directly after postings (no blank line) starts a new transaction
test('no blank line needed between transactions', () => {
  const ts = parse('2024-05-01 B\n  a 1.00\n  b\n2024-05-02 C\n  a 2.00\n  b\n');
  assert.equal(ts.length, 2);
  assert.equal(ts[1].date, '2024-05-02');
});

// whole-line comments are ignored, indented or not, even inside a transaction
test('comment lines are ignored', () => {
  const text = '; top\n2024-03-01 X\n  ; inside\n  a 1.00\n; odd place\n  b\n  ;\n';
  assert.deepEqual(parse(text), [
    {
      date: '2024-03-01',
      description: 'X',
      postings: [
        { account: 'a', cents: 100 },
        { account: 'b', cents: -100 },
      ],
    },
  ]);
});

// trailing comments are stripped from headers and postings
test('trailing comments are stripped', () => {
  const [t] = parse('2024-03-01 Lunch with Sam   ; fun\n  expenses:food 9.00 ; note\n  assets:cash ; paid\n');
  assert.equal(t.description, 'Lunch with Sam');
  assert.deepEqual(t.postings, [
    { account: 'expenses:food', cents: 900 },
    { account: 'assets:cash', cents: -900 },
  ]);
});

// description may be empty or contain many spaces; tabs may indent postings and separate amounts
test('empty description, tab separators, inner spaces', () => {
  const [a] = parse('2024-03-01\n\ta 1.00\n\tb\n');
  assert.equal(a.description, '');
  const [b] = parse('2024-03-01   two  words here  \n\ta\t2.00\n\tb\n');
  assert.equal(b.description, 'two  words here');
  assert.equal(b.postings[0].cents, 200);
});

// CRLF line endings are accepted
test('CRLF input', () => {
  const ts = parse('2024-03-01 X\r\n  a 1.00\r\n  b\r\n\r\n2024-03-02 Y\r\n  a 1.00\r\n  b\r\n');
  assert.equal(ts.length, 2);
  assert.equal(ts[0].description, 'X');
});

// file without a final newline still finishes the last transaction
test('no trailing newline', () => {
  assert.equal(parse('2024-03-01 X\n  a 1.00\n  b').length, 1);
});

// accounts may contain digits, hyphens and several segments
test('account name shapes', () => {
  const [t] = parse('2024-03-01 X\n  expenses:eating-out:cafe2 1.00\n  assets:bank-1\n');
  assert.deepEqual(t.postings.map((p) => p.account), ['expenses:eating-out:cafe2', 'assets:bank-1']);
});

// 2024 is a leap year, 2023 is not
test('leap day is accepted only in leap years', () => {
  assert.equal(parse('2024-02-29 X\n  a 1.00\n  b\n').length, 1);
  fails('2023-02-29 X\n  a 1.00\n  b\n', 1, 'invalid date');
});

// isValidDate accepts real dates only
test('isValidDate', () => {
  for (const d of ['2024-01-31', '2024-02-29', '1999-12-31', '2000-02-29']) assert.equal(isValidDate(d), true, d);
  for (const d of ['2024-13-01', '2024-00-10', '2024-04-31', '2023-02-29', '1900-02-29', '2024-1-05', '24-01-05', '2024/01/05', '', 'today', '2024-01-05 ']) {
    assert.equal(isValidDate(d), false, d);
  }
  assert.equal(isValidDate(undefined), false);
});

// unknown date on a header reports that header line
test('error: invalid date has the header line number', () => {
  fails('2024-01-01 Ok\n  a 1.00\n  b\n\n2024-13-45 Bad\n  a 1.00\n  b\n', 5, 'invalid date');
});

// a header that is not a date at all is reported as invalid date
test('error: non-date header text', () => {
  fails('Groceries\n  a 1.00\n  b\n', 1, 'invalid date');
});

// an indented line before any header
test('error: posting outside transaction', () => {
  fails('; c\n\n  a 1.00\n', 3, 'posting outside transaction');
});

// a blank line closes the transaction, so a later posting is orphaned
test('error: posting after blank line', () => {
  fails('2024-01-01 X\n  a 1.00\n  b\n\n  c 1.00\n', 5, 'posting outside transaction');
});

// amounts must have exactly two decimals and plain digits
test('error: invalid amounts', () => {
  for (const amt of ['12.5', '12', '12.500', '+3.00', '$3.00', '1,000.00', '--1.00', '.50', '1.0a', 'abc']) {
    fails(`2024-01-01 X\n  a ${amt}\n  b\n`, 2, 'invalid amount');
  }
});

// invalid account names
test('error: invalid accounts', () => {
  for (const acct of ['Assets', '1abc', 'a::b', ':a', 'a:', 'a_b', '-x', 'a:B']) {
    fails(`2024-01-01 X\n  a 1.00\n  ${acct} -1.00\n`, 3, 'invalid account');
  }
});

// a bare number in the account position is an invalid account (account is checked first)
test('error: amount-like single token is an invalid account', () => {
  fails('2024-01-01 X\n  12.50\n  b\n', 2, 'invalid account');
});

// more than two pieces on a posting line
test('error: malformed posting', () => {
  fails('2024-01-01 X\n  a 1.00 USD\n  b\n', 2, 'malformed posting');
  fails('2024-01-01 X\n  a b 1.00\n  b\n', 2, 'malformed posting');
});

// two amount-less postings: error on the second
test('error: two postings without amounts', () => {
  fails('2024-01-01 X\n  a 1.00\n  b\n  c\n', 4, 'more than one posting without an amount');
});

// transaction totals must be zero; reported on the header
test('error: unbalanced transaction', () => {
  fails('2024-01-01 Ok\n  a 1.00\n  b\n\n2024-01-02 Off\n  a 1.00\n  b -0.99\n', 5, 'unbalanced transaction');
});

// unbalanced one cent is still caught at end of file, with no trailing newline
test('error: unbalanced at end of file', () => {
  fails('2024-01-01 X\n  a 0.01\n  b -0.02', 1, 'unbalanced transaction');
});

// fewer than two postings
test('error: too few postings', () => {
  fails('2024-01-01 X\n  a 0.00\n', 1, 'transaction needs at least two postings');
  fails('2024-01-01 X\n\n2024-01-02 Y\n  a 1.00\n  b\n', 1, 'transaction needs at least two postings');
  fails('2024-01-01 X\n', 1, 'transaction needs at least two postings');
});

// line numbers count blank and comment lines
test('error line numbers count comments and blanks', () => {
  fails('; one\n\n; three\n2024-01-01 X\n  ; five\n  ; six\n  a 1.5\n  b\n', 7, 'invalid amount');
});

// ParseError exposes line and reason and is an Error
test('ParseError shape', () => {
  assert.ok(new ParseError(3, 'x') instanceof Error);
  const e = new ParseError(3, 'invalid amount');
  assert.equal(e.line, 3);
  assert.equal(e.reason, 'invalid amount');
  assert.equal(e.message, 'line 3: invalid amount');
});
