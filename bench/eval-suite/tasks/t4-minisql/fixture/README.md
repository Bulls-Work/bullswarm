# minisql

Build a small in-memory SQL engine in plain JavaScript (Node 22, standard library only, ES modules, no installs).

Entry point: `src/index.js` must export

```js
export function createDatabase() // returns { exec(sql) }
```

Each call to `createDatabase()` returns a fresh, empty, independent database. Run the tests with `npm test` (`node --test`). Put your own tests in `tests/`.

## What `exec(sql)` does

`exec` takes one SQL statement as a string and runs it.

- For `SELECT` it returns `{ columns, rows }`: `columns` is an array of column-name strings, `rows` is an array of rows, and each row is an array of values in column order.
- For every other statement it returns `{ changes }`, a number (see each statement below).
- For bad input it throws an `Error` whose `message` starts with `SQL error:` (for example `SQL error: no such table: users`). This also applies to a non-string argument. After an error the database is unchanged: a failed statement never leaves partial changes behind.

One optional `;` may follow the statement. Whitespace (spaces, tabs, newlines) may appear between any two tokens. There are no comments, no joins, and no subqueries: every query touches one table.

## Lexical rules

- Keywords (`SELECT`, `from`, `Where`, `COUNT`, ...) are case-insensitive.
- Identifiers (table names, column names, aliases) are case-sensitive: `Users` and `users` are different tables, `Name` and `name` are different columns. An identifier is `[A-Za-z_][A-Za-z0-9_]*`. These words are reserved and cannot be used as identifiers: `CREATE TABLE INSERT INTO VALUES SELECT DISTINCT FROM WHERE GROUP BY HAVING ORDER ASC DESC LIMIT OFFSET UPDATE SET DELETE AND OR NOT IS NULL IN BETWEEN LIKE AS PRIMARY KEY`. Type names and function names (`INTEGER`, `COUNT`, ...) are not reserved.
- Number literals: digits, optionally followed by `.` and digits (`42`, `3.14`). A leading `-` is the unary minus operator.
- String literals: single quotes; a quote inside a string is written as two quotes (`'it''s'` is the text `it's`). An unterminated string is an error. Double quotes are not valid.
- `NULL` is the null literal.

## Values and types

Values are JavaScript numbers, strings, or `null` (SQL NULL). A comparison or logical result that is true is the number `1`, false is `0`, and unknown is `null`.

A number is treated as an integer when it has no fractional part (`6` and `6.0` are both integers).

## Statements

### CREATE TABLE

```
CREATE TABLE t (col INTEGER|TEXT|REAL [PRIMARY KEY], ...)
```

Returns `{ changes: 0 }`. Errors: table already exists, no columns, duplicate column name, more than one `PRIMARY KEY`, unknown type.

Column types: `INTEGER` accepts only whole numbers, `REAL` accepts any number, `TEXT` accepts only strings. Any column accepts `NULL`, except a primary key column. A value of the wrong type is an error (no conversion happens). A primary key column must be unique and not NULL; inserting or updating to a duplicate key is an error.

### INSERT

```
INSERT INTO t [(col, ...)] VALUES (expr, ...), (expr, ...), ...
```

Without a column list, each row must give a value for every column, in table order. With a column list, the listed columns get the values and every other column becomes NULL. A wrong number of values, an unknown column, or a repeated column in the list is an error. The values are expressions without column references (`VALUES (1+2, 'a')` is fine). All rows of one statement are inserted or none are. Returns `{ changes: <rows inserted> }`.

### SELECT

```
SELECT [DISTINCT] * | expr [AS alias], ... [FROM t]
  [WHERE expr] [GROUP BY col, ...] [HAVING expr]
  [ORDER BY expr [ASC|DESC], ...] [LIMIT n [OFFSET m]]
```

- `FROM` is optional. Without it the query is evaluated against a single empty row (`SELECT 1 + 2` returns one row `[3]`).
- `*` expands to all table columns in table order. It can be mixed with other items (`SELECT *, a + 1 AS b`). It is an error without `FROM` or together with aggregates or `GROUP BY`.
- Result column names: the alias if `AS alias` is given; otherwise a plain column reference uses the column name; otherwise the exact source text of the expression with surrounding whitespace trimmed (`SELECT a+1 FROM t` gives the name `a+1`; `SELECT COUNT(*)` gives `COUNT(*)`).
- `WHERE` keeps a row only when the condition is TRUE. NULL (unknown) and 0 reject the row. A non-zero number counts as TRUE. A string condition is an error. Aggregates are not allowed in `WHERE`.
- `DISTINCT` removes duplicate result rows (two NULLs count as equal), keeping the first occurrence in the order the rows would otherwise appear.
- `ORDER BY` sorts by each expression in turn; the default is `ASC`. Ascending puts NULL first; descending puts NULL last. Numbers sort numerically, strings by plain character-code comparison (so `'B' < 'a'`). The sort is stable: rows that compare equal keep their original order. An `ORDER BY` name that matches a select-list alias refers to that alias; otherwise it is evaluated against the table row (or group). Without `ORDER BY` rows come back in insertion order (for groups: the order in which each group first appears).
- `LIMIT n` returns at most `n` rows; `OFFSET m` skips the first `m` rows before that. `n` and `m` are non-negative integer literals. `OFFSET` without `LIMIT` is an error. `LIMIT`/`OFFSET` apply after `DISTINCT` and `ORDER BY`.

### UPDATE

```
UPDATE t SET col = expr [, col = expr ...] [WHERE expr]
```

Every right-hand side is computed from the row as it was before the update (`SET a = b, b = a` swaps). All matching rows are updated or none are (type and primary-key errors abort the whole statement). Returns `{ changes: <rows matched by WHERE> }`, even if a value did not actually change. Aggregates are not allowed.

### DELETE

```
DELETE FROM t [WHERE expr]
```

Returns `{ changes: <rows deleted> }`. Without `WHERE` every row is deleted.

## Expressions

Precedence, from loosest to tightest binding:

1. `OR`
2. `AND`
3. `NOT`
4. comparisons: `=` `!=` `<>` `<` `<=` `>` `>=`, and `IS [NOT] NULL`, `[NOT] IN (...)`, `[NOT] BETWEEN a AND b`, `[NOT] LIKE`
5. `+` `-`
6. `*` `/` `%`
7. unary `-` / `+`
8. literals, column references, function calls, parenthesised expressions

Binary operators of one level group left to right. Parentheses override precedence.

- Arithmetic with a NULL operand gives NULL. Arithmetic on strings is an error.
- `/` on two integers truncates toward zero (`7/2` is `3`, `-7/2` is `-3`); if either operand has a fractional part the result is the ordinary real quotient (`7.5/2` is `3.75`). `%` has the sign of the left operand (`-7 % 3` is `-1`). Division or modulo by zero gives NULL.
- Comparing with NULL gives NULL. Comparing a number with a string is an error. Strings compare by character code.
- `AND`/`OR`/`NOT` use three-valued logic: `FALSE AND NULL` is false, `TRUE AND NULL` is NULL, `TRUE OR NULL` is true, `FALSE OR NULL` is NULL, `NOT NULL` is NULL. Operands must be numbers (non-zero is TRUE) or NULL; a string operand is an error.
- `x IS NULL` / `x IS NOT NULL` are always true or false, never NULL.
- `x IN (a, b, ...)`: true if equal to any item; otherwise NULL if `x` or any item is NULL; otherwise false. `x NOT IN (...)` is the negation of that (so NULL stays NULL).
- `x BETWEEN a AND b` means `x >= a AND x <= b` (bounds inclusive); `NOT BETWEEN` negates it. The `AND` inside `BETWEEN` belongs to it, not to the logic operator.
- `x LIKE pattern`: `%` matches any run of characters (including none), `_` matches exactly one character; everything else matches literally and the match is case-sensitive and must cover the whole string. Both sides must be strings (NULL on either side gives NULL). `NOT LIKE` negates it.

### Aggregates

`COUNT(*)`, `COUNT(expr)`, `SUM(expr)`, `AVG(expr)`, `MIN(expr)`, `MAX(expr)`.

- `COUNT(*)` counts rows; the others skip rows where `expr` is NULL. `COUNT(expr)` is the number of non-NULL values.
- Over zero (non-NULL) values: `COUNT` gives 0; `SUM`, `AVG`, `MIN`, `MAX` give NULL.
- `SUM` and `AVG` need numbers (strings are an error). `MIN`/`MAX` work on numbers or on strings.
- Aggregates may appear in the select list, `HAVING` and `ORDER BY`, and inside larger expressions (`SUM(a) * 2`). They cannot be nested and are not allowed in `WHERE` or in `INSERT`/`UPDATE` values.
- A query with aggregates and no `GROUP BY` returns exactly one row, even over an empty table.
- With `GROUP BY col, ...` there is one output row per distinct combination (NULLs group together). Outside aggregate calls, the select list, `HAVING` and `ORDER BY` may only use the grouped columns (anything else is an error). `HAVING` keeps groups where its condition is TRUE. `GROUP BY` takes plain column names.

## Errors

Throw `SQL error: <detail>` (the detail wording is up to you) for, among others: syntax errors, unknown table, unknown column (even when the table is empty), duplicate table, duplicate primary key, type mismatch, wrong value count, aggregate misuse, comparing a number with a string, unterminated strings, empty input, and any text left over after the statement.

## Your job

Implement the engine in `src/index.js` (you may split it into more files under `src/`), and write tests for it under `tests/`. A few starter tests already exist in `tests/`.
