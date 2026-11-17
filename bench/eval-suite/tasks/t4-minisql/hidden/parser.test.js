import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../../src/index.js';

const rows = (db, sql) => db.exec(sql).rows;
const one = (sql) => createDatabase().exec(sql).rows[0][0];
const bad = (db, sql) => assert.throws(() => db.exec(sql), (e) => e instanceof Error && e.message.startsWith('SQL error:'));

// 1 + 2 * 3 uses multiplication before addition
test('mul binds tighter than add', () => assert.equal(one('SELECT 1 + 2 * 3'), 7));
// parentheses override precedence
test('parentheses override', () => assert.equal(one('SELECT (1 + 2) * 3'), 9));
// subtraction groups left to right
test('subtraction left assoc', () => assert.equal(one('SELECT 10 - 4 - 3'), 3));
// division groups left to right
test('division left assoc', () => assert.equal(one('SELECT 100 / 10 / 5'), 2));
// / and % share a level, left to right
test('mul div mod same level', () => assert.equal(one('SELECT 2 * 7 % 4'), 2));
// unary minus on a literal and nested unary minus
test('unary minus', () => { assert.equal(one('SELECT -5 + 2'), -3); assert.equal(one('SELECT - -5'), 5); });
// unary minus binds tighter than multiplication
test('unary minus vs mul', () => assert.equal(one('SELECT -2 * 3'), -6));
// arithmetic binds tighter than comparison
test('arith before comparison', () => assert.equal(one('SELECT 1 + 1 = 2'), 1));
// comparison result is 1 or 0
test('comparison yields 1/0', () => { assert.equal(one('SELECT 3 > 2'), 1); assert.equal(one('SELECT 3 < 2'), 0); });
// AND binds tighter than OR: 1 OR (0 AND 0) is true
test('AND before OR', () => assert.equal(one('SELECT 1 = 1 OR 1 = 0 AND 1 = 0'), 1));
// parentheses force OR first: (1 OR 0) AND 0 is false
test('parens around OR', () => assert.equal(one('SELECT (1 = 1 OR 1 = 0) AND 1 = 0'), 0));
// NOT binds tighter than AND: (NOT 1=1) AND 1=0 is false... and NOT (1=1 AND 1=0) would be true
test('NOT before AND', () => {
  assert.equal(one('SELECT NOT 1 = 1 AND 1 = 0'), 0);
  assert.equal(one('SELECT NOT 1 = 0 AND 1 = 1'), 1);
});
// NOT NOT cancels out
test('double NOT', () => assert.equal(one('SELECT NOT NOT 1 = 1'), 1));
// NOT applies to a whole comparison, not just its left operand
test('NOT covers comparison', () => assert.equal(one('SELECT NOT 2 + 2 = 5'), 1));
// keywords are case-insensitive, including mixed case
test('keywords case-insensitive', () => {
  const db = createDatabase();
  db.exec('cReAtE tAbLe t (a integer)');
  db.exec('InSeRt InTo t VaLuEs (4)');
  assert.deepEqual(rows(db, 'sElEcT a fRoM t wHeRe a Is NoT nUlL'), [[4]]);
});
// identifiers are case-sensitive: table names and column names
test('identifiers case-sensitive', () => {
  const db = createDatabase();
  db.exec('CREATE TABLE T (Name TEXT)');
  db.exec('CREATE TABLE t (name TEXT)');
  db.exec("INSERT INTO T VALUES ('upper')");
  db.exec("INSERT INTO t VALUES ('lower')");
  assert.deepEqual(rows(db, 'SELECT Name FROM T'), [['upper']]);
  assert.deepEqual(rows(db, 'SELECT name FROM t'), [['lower']]);
  bad(db, 'SELECT NAME FROM t');
});
// string literal with doubled quote yields one quote
test("string '' escape", () => {
  assert.equal(one("SELECT 'it''s'"), "it's");
  assert.equal(one("SELECT ''''"), "'");
  assert.equal(one("SELECT ''"), '');
});
// extra whitespace, newlines, tabs and a trailing semicolon are fine
test('whitespace and semicolon', () => {
  const db = createDatabase();
  assert.deepEqual(db.exec('  SELECT\n\t1\n  +   2 ;  ').rows, [[3]]);
});
// expression result column is named by its source text; alias and plain column names too
test('result column names', () => {
  const db = createDatabase();
  db.exec('CREATE TABLE t (a INTEGER, b INTEGER)');
  db.exec('INSERT INTO t VALUES (1, 2)');
  assert.deepEqual(db.exec('SELECT a, a+b, b AS bee, COUNT(*) FROM t GROUP BY a, b').columns, ['a', 'a+b', 'bee', 'COUNT(*)']);
  assert.deepEqual(db.exec('SELECT *, a * 2 AS dbl FROM t').columns, ['a', 'b', 'dbl']);
});
// select without FROM evaluates to a single row
test('select without FROM', () => assert.deepEqual(createDatabase().exec('SELECT 1, 2').rows, [[1, 2]]));
// decimal literals parse as numbers
test('decimal literals', () => assert.equal(one('SELECT 1.5 + 2.25'), 3.75));
// INSERT values may be constant expressions
test('insert expression values', () => {
  const db = createDatabase();
  db.exec('CREATE TABLE t (a INTEGER, b TEXT)');
  db.exec("INSERT INTO t VALUES (1 + 2 * 3, 'x')");
  assert.deepEqual(rows(db, 'SELECT * FROM t'), [[7, 'x']]);
});
