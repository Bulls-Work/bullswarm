# ledger

A tiny command line ledger. It reads a plain-text file of transactions and prints
account balances or the history of one account. Node 22, standard library only
(no npm install). Run the tests with `npm test` (or `node --test`).

The repository has three parts. Stubs exist for all of them and throw
`not implemented`. Replace them and add your own tests in `tests/`.

| Part | File | Job |
| --- | --- | --- |
| A | `src/parse.js` | parse ledger text into transactions |
| B | `src/report.js` | balances, register, date filter, amount formatting |
| C | `bin/ledger.js` | the command line, built on A and B |

**Money is integer cents everywhere.** Never use floating point for amounts
(`12.50` is `1250`). Do not compute with `parseFloat`.

## The ledger file format

```
; a comment line
2024-01-01 Opening balance
    assets:bank        1000.00
    equity:opening    -1000.00

2024-01-05 Groceries            ; trailing comment
    expenses:food        42.50
    assets:bank

2024-01-20 Salary
    assets:bank        2000.00
    income:salary
```

* A **comment** starts with `;` and runs to the end of the line. It may be a whole
  line (indented or not) or follow other text. Remove comments before reading the line.
* A **blank line** (nothing but whitespace, no `;`) ends the current transaction.
  A comment-only line does not.
* A **transaction header** is a line that does not start with a space or tab:
  `DATE DESCRIPTION`. The date is `YYYY-MM-DD` and must be a real calendar date
  (`2024-02-29` is fine, `2023-02-29` and `2024-13-01` are not). The description is
  the rest of the line, trimmed; it may be empty and may contain spaces.
* A **posting** is a line that starts with a space or a tab, inside a transaction:
  `ACCOUNT` or `ACCOUNT AMOUNT`, separated by whitespace.
  * An **account** is one or more segments joined by `:`. A segment starts with a
    lowercase letter `a-z` and continues with lowercase letters, digits or `-`.
    Examples: `assets`, `assets:bank`, `expenses:eating-out`.
  * An **amount** is an optional `-`, digits, a `.`, and exactly two decimal digits:
    `12.50`, `-0.05`, `1000.00`. Not valid: `12.5`, `12`, `+3.00`, `$3.00`, `1,000.00`.
  * At most one posting per transaction may omit its amount. It gets the amount that
    makes the transaction add up to zero (the negated sum of the others; `0` if that sum is `0`).
* Every transaction needs at least two postings, and its amounts must add up to
  exactly zero.
* Transactions keep file order. Lines are numbered from 1; `\r\n` line endings are accepted.

## Part A: `src/parse.js`

```js
import { parse, isValidDate, ParseError } from './src/parse.js';
```

* `parse(text)` returns an array of transactions, in file order:
  `{ date: '2024-01-05', description: 'Groceries', postings: [{ account: 'expenses:food', cents: 4250 }, ...] }`.
  Each transaction object has exactly the keys `date`, `description`, `postings`; each
  posting exactly `account`, `cents`. The balancing posting is filled in (its `cents` is a number).
  Empty input gives `[]`.
* `isValidDate(str)` is true only for a string of the form `YYYY-MM-DD` that is a real date.
* `ParseError` extends `Error`. It has `line` (number), `reason` (string) and
  `message` equal to `line N: reason`.

`parse` throws a `ParseError` for the first problem it finds, reading top to bottom.
A transaction is checked when it ends (blank line, next header, or end of file).

| reason | when | `line` |
| --- | --- | --- |
| `invalid date` | header date is not `YYYY-MM-DD` or not a real date (any text in that position that is not a date, too) | the header |
| `posting outside transaction` | indented line with no open transaction | that line |
| `invalid account` | account name breaks the rules above | that line |
| `invalid amount` | amount breaks the rules above | that line |
| `malformed posting` | more than two whitespace-separated pieces | that line |
| `more than one posting without an amount` | a second amount-less posting | the second one |
| `transaction needs at least two postings` | fewer than two postings | the header |
| `unbalanced transaction` | amounts do not sum to zero and no posting omits its amount | the header |

For a posting line, check the account first, then the amount.

## Part B: `src/report.js`

```js
import { balances, register, filterByDate, formatCents } from './src/report.js';
```

These take the transactions that `parse` returns (they must not need `parse`).

* `filterByDate(transactions, { from, to })` keeps transactions whose `date` is
  `>= from` and `<= to` (both inclusive; each optional, compare the `YYYY-MM-DD` strings).
  The options object itself is optional. Returns a new array in the same order.
* `balances(transactions, { from, to })` applies the date filter, then returns
  `[{ account, cents }, ...]`: one entry for every account that appears in a posting
  **and** for every parent of such an account (`assets:bank` also produces `assets`).
  A parent's `cents` is the sum of its own postings and all postings of its sub-accounts.
  Accounts with a total of zero are still listed. Sorted by plain string comparison of the
  full account name (`a < b`).
* `register(transactions, account, { from, to })` applies the date filter, orders
  transactions by date ascending (keeping file order for equal dates), and returns
  `[{ date, description, cents, total }, ...]`: one row per posting whose account is
  `account` or a sub-account of it (`assets` matches `assets:bank`; `assets:ba` matches nothing).
  `total` is the running total of `cents` over the rows returned, starting from 0.
  An account with no postings gives `[]`.
* `formatCents(cents)` renders integer cents as text with two decimals and a leading `-`
  for negatives: `1250` -> `12.50`, `5` -> `0.05`, `-5` -> `-0.05`, `0` -> `0.00`,
  `123456` -> `1234.56`. No thousands separators, no `+`.

## Part C: `bin/ledger.js`

```
node bin/ledger.js balance <file> [--from DATE] [--to DATE]
node bin/ledger.js register <file> <account>
```

`--from` and `--to` may appear in either order, before or after the file name. Dates must
be valid `YYYY-MM-DD`. If an option is repeated, the last one wins.

### `balance` output

One line per entry of `balances(...)`, in that order: the amount (from `formatCents`)
right-aligned to the width of the widest amount, two spaces, the full account name.
Every line, including the last, ends with `\n`. No header, no total. No entries means no output.

For the example file above, saved as `example.ledger`:

```
$ node bin/ledger.js balance example.ledger
 2957.50  assets
 2957.50  assets:bank
-1000.00  equity
-1000.00  equity:opening
   42.50  expenses
   42.50  expenses:food
-2000.00  income
-2000.00  income:salary
```

### `register` output

One line per row of `register(...)` (no date options on the command line):

1. the date (10 characters),
2. two spaces,
3. the description, cut to its first 30 characters and padded on the right with spaces to 30,
4. two spaces,
5. the amount, right-aligned in 10 characters (longer text is not cut),
6. two spaces,
7. the running total, right-aligned in 10 characters.

Every line ends with `\n`; there is no header and no trailing space.

```
$ node bin/ledger.js register example.ledger assets:bank
2024-01-01  Opening balance                    1000.00     1000.00
2024-01-05  Groceries                           -42.50      957.50
2024-01-20  Salary                             2000.00     2957.50
```

### Errors and exit codes

| situation | stdout | stderr | exit |
| --- | --- | --- | --- |
| success | the table | empty | 0 |
| ledger parse error | empty | `ledger: ` + the error message, e.g. `ledger: line 3: invalid amount` + `\n` | 1 |
| file cannot be read | empty | `ledger: cannot read <file as given>` + `\n` | 1 |
| bad usage (unknown command, wrong number of arguments, unknown option, missing or invalid date) | empty | one line starting `ledger: ` followed by a `usage:` line (wording free) | 2 |

A file that parses but has no transactions is not an error (empty output, exit 0).
