import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../../bin/ledger.js', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'ledger-cli-'));

function ledger(name, text) {
  const file = join(dir, name);
  writeFileSync(file, text);
  return file;
}
function run(...args) {
  return spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', cwd: dir });
}

const EXAMPLE = `; household
2024-01-01 Opening balance
    assets:bank        1000.00
    equity:opening    -1000.00

2024-01-05 Groceries            ; trailing comment
    expenses:food        42.50
    assets:bank

2024-01-20 Salary
    assets:bank        2000.00
    income:salary
`;
const example = ledger('example.ledger', EXAMPLE);

// balance prints the documented table exactly
test('balance: README example', () => {
  const r = run('balance', example);
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
  assert.equal(
    r.stdout,
    ' 2957.50  assets\n 2957.50  assets:bank\n-1000.00  equity\n-1000.00  equity:opening\n   42.50  expenses\n   42.50  expenses:food\n-2000.00  income\n-2000.00  income:salary\n',
  );
});

// balance --from drops earlier transactions
test('balance: --from', () => {
  const r = run('balance', example, '--from', '2024-01-05');
  assert.equal(r.status, 0);
  assert.equal(r.stdout, ' 1957.50  assets\n 1957.50  assets:bank\n   42.50  expenses\n   42.50  expenses:food\n-2000.00  income\n-2000.00  income:salary\n');
});

// balance --to drops later transactions (inclusive)
test('balance: --to inclusive', () => {
  const r = run('balance', example, '--to', '2024-01-05');
  assert.equal(r.stdout, '  957.50  assets\n  957.50  assets:bank\n-1000.00  equity\n-1000.00  equity:opening\n   42.50  expenses\n   42.50  expenses:food\n');
});

// options may come before the file and in either order; last repeated option wins
test('balance: option order and repeats', () => {
  const a = run('balance', example, '--from', '2024-01-02', '--to', '2024-01-10');
  const b = run('--from', '2024-01-02', 'balance', example, '--to', '2024-01-10');
  const c = run('balance', '--to', '2024-01-10', '--from', '2000-01-01', example, '--from', '2024-01-02');
  assert.equal(a.status, 0);
  assert.equal(a.stdout, '-42.50  assets\n-42.50  assets:bank\n 42.50  expenses\n 42.50  expenses:food\n');
  assert.equal(c.stdout, a.stdout);
  // an option before the command is a usage error
  assert.equal(b.status, 2);
});

// a window with no transactions prints nothing and succeeds
test('balance: empty window', () => {
  const r = run('balance', example, '--from', '2030-01-01');
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
});

// an empty ledger file is fine
test('balance: empty file', () => {
  const r = run('balance', ledger('empty.ledger', '; nothing here\n'));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

// amounts use the width of the widest entry, with negatives
test('balance: column width follows widest amount', () => {
  const f = ledger('w.ledger', '2024-01-01 x\n  a:b 0.05\n  c -0.05\n');
  assert.equal(run('balance', f).stdout, ' 0.05  a\n 0.05  a:b\n-0.05  c\n');
});

// cents stay exact in the printed output
test('balance: exact cents', () => {
  const f = ledger('cents.ledger', '2024-01-01 x\n  a 0.10\n  b 0.20\n  c -0.30\n\n2024-01-02 y\n  a 0.10\n  b 0.20\n  c -0.30\n');
  assert.equal(run('balance', f).stdout, ' 0.20  a\n 0.40  b\n-0.60  c\n');
});

// register prints the documented table exactly
test('register: README example', () => {
  const r = run('register', example, 'assets:bank');
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
  assert.equal(
    r.stdout,
    '2024-01-01  Opening balance                    1000.00     1000.00\n' +
      '2024-01-05  Groceries                           -42.50      957.50\n' +
      '2024-01-20  Salary                             2000.00     2957.50\n',
  );
});

// register on a parent account includes sub-accounts
test('register: parent account', () => {
  const f = ledger('r.ledger', '2024-01-01 a\n  assets:bank 5.00\n  income\n\n2024-01-02 b\n  assets:cash 1.50\n  income\n');
  assert.equal(
    run('register', f, 'assets').stdout,
    '2024-01-01  a                                     5.00        5.00\n2024-01-02  b                                     1.50        6.50\n',
  );
});

// long descriptions are cut to 30 characters; short ones are padded
test('register: description truncation', () => {
  const long = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const f = ledger('long.ledger', `2024-01-01 ${long}\n  a 1.00\n  b\n`);
  assert.equal(run('register', f, 'a').stdout, `2024-01-01  ${long.slice(0, 30)}        1.00        1.00\n`);
});

// columns are fixed width: wide amounts overflow rather than get cut
test('register: wide amounts overflow', () => {
  const f = ledger('wide.ledger', '2024-01-01 big\n  a 123456789.00\n  b\n');
  assert.equal(run('register', f, 'a').stdout, `2024-01-01  ${'big'.padEnd(30)}  123456789.00  123456789.00\n`);
});

// register for an unknown account prints nothing and succeeds
test('register: unknown account', () => {
  const r = run('register', example, 'liabilities');
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

// register orders rows by date even when the file does not
test('register: date order', () => {
  const f = ledger('order.ledger', '2024-03-02 late\n  a 2.00\n  b\n\n2024-03-01 early\n  a 1.00\n  b\n');
  assert.equal(
    run('register', f, 'a').stdout,
    `2024-03-01  ${'early'.padEnd(30)}        1.00        1.00\n2024-03-02  ${'late'.padEnd(30)}        2.00        3.00\n`,
  );
});

// a parse error goes to stderr as "ledger: line N: reason" with exit 1 and empty stdout
test('error: parse error output and exit code', () => {
  const f = ledger('bad.ledger', '2024-01-01 ok\n  a 1.00\n  b\n\n2024-01-02 bad\n  a 1.5\n  b\n');
  for (const args of [['balance', f], ['register', f, 'a']]) {
    const r = run(...args);
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, 'ledger: line 6: invalid amount\n');
  }
});

// unbalanced transactions and unknown dates are reported with the right line
test('error: unbalanced and invalid date', () => {
  const u = run('balance', ledger('u.ledger', '\n2024-01-01 x\n  a 1.00\n  b -2.00\n'));
  assert.equal(u.status, 1);
  assert.equal(u.stderr, 'ledger: line 2: unbalanced transaction\n');
  const d = run('balance', ledger('d.ledger', '2024-02-30 x\n  a 1.00\n  b\n'));
  assert.equal(d.status, 1);
  assert.equal(d.stderr, 'ledger: line 1: invalid date\n');
});

// the file is parsed even when it has an error that no output row would show
test('error: balance with date window still fails on a bad file', () => {
  const f = ledger('bad2.ledger', '2024-01-01 x\n  a 1.00\n  b\n\n2024-01-02 y\n  a 1.00\n');
  const r = run('balance', f, '--to', '2024-01-01');
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, 'ledger: line 5: transaction needs at least two postings\n');
});

// a missing file exits 1 with a one-line message
test('error: missing file', () => {
  const r = run('balance', 'no-such-file.ledger');
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, 'ledger: cannot read no-such-file.ledger\n');
});

// usage errors exit 2 with a ledger: message and usage text, nothing on stdout
test('usage errors', () => {
  const cases = [
    [],
    ['frobnicate', example],
    ['balance'],
    ['balance', example, 'extra'],
    ['register', example],
    ['register', example, 'a', 'b'],
    ['balance', example, '--bogus'],
    ['balance', example, '--from'],
    ['balance', example, '--from', '2024-02-30'],
    ['balance', example, '--to', 'yesterday'],
    ['register', example, 'assets', '--from', '2024-01-01'],
  ];
  for (const args of cases) {
    const r = run(...args);
    assert.equal(r.status, 2, JSON.stringify(args));
    assert.equal(r.stdout, '', JSON.stringify(args));
    assert.match(r.stderr, /usage:/, JSON.stringify(args));
  }
});

// the program does not depend on the working directory
test('works from another cwd with a relative path', () => {
  const r = spawnSync(process.execPath, [bin, 'balance', 'example.ledger', '--to', '2024-01-01'], { encoding: 'utf8', cwd: dir });
  assert.equal(r.stdout, ' 1000.00  assets\n 1000.00  assets:bank\n-1000.00  equity\n-1000.00  equity:opening\n');
});
