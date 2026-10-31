import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../../src/index.js';

const rows = (db, sql) => db.exec(sql).rows;
const one = (sql) => createDatabase().exec(sql).rows[0][0];
const bad = (db, sql) => assert.throws(() => db.exec(sql), (e) => e instanceof Error && e.message.startsWith('SQL error:'));

function setup() {
  const db = createDatabase();
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, a INTEGER, s TEXT)');
  db.exec("INSERT INTO t VALUES (1, 10, 'x'), (2, NULL, 'y'), (3, 5, NULL), (4, NULL, NULL)");
  return db;
}
// comparison with NULL is NULL, shown as null in output
test('comparison with NULL is null', () => {
  assert.equal(one('SELECT 1 = NULL'), null);
  assert.equal(one('SELECT NULL = NULL'), null);
  assert.equal(one('SELECT NULL < 1'), null);
});
// WHERE a = NULL matches nothing
test('WHERE = NULL matches none', () => assert.deepEqual(rows(setup(), 'SELECT id FROM t WHERE a = NULL'), []));
// WHERE a != 10 drops rows where a is NULL
test('WHERE != skips NULLs', () => assert.deepEqual(rows(setup(), 'SELECT id FROM t WHERE a != 10'), [[3]]));
// IS NULL finds null rows
test('IS NULL', () => assert.deepEqual(rows(setup(), 'SELECT id FROM t WHERE a IS NULL'), [[2], [4]]));
// IS NOT NULL finds non-null rows
test('IS NOT NULL', () => assert.deepEqual(rows(setup(), 'SELECT id FROM t WHERE a IS NOT NULL'), [[1], [3]]));
// IS NULL on an expression is never null itself
test('IS NULL yields 1/0', () => {
  assert.equal(one('SELECT NULL IS NULL'), 1);
  assert.equal(one('SELECT 1 IS NULL'), 0);
  assert.equal(one('SELECT NULL IS NOT NULL'), 0);
});
// AND truth table with NULL
test('AND with NULL', () => {
  assert.equal(one('SELECT 0 AND NULL'), 0);
  assert.equal(one('SELECT NULL AND 0'), 0);
  assert.equal(one('SELECT 1 AND NULL'), null);
  assert.equal(one('SELECT NULL AND NULL'), null);
});
// OR truth table with NULL
test('OR with NULL', () => {
  assert.equal(one('SELECT 1 OR NULL'), 1);
  assert.equal(one('SELECT NULL OR 1'), 1);
  assert.equal(one('SELECT 0 OR NULL'), null);
  assert.equal(one('SELECT NULL OR NULL'), null);
});
// NOT NULL is NULL
test('NOT NULL', () => assert.equal(one('SELECT NOT NULL'), null));
// WHERE NOT (a = 10) still drops NULL rows
test('WHERE NOT keeps only TRUE', () => assert.deepEqual(rows(setup(), 'SELECT id FROM t WHERE NOT (a = 10)'), [[3]]));
// arithmetic with NULL gives NULL
test('arithmetic with NULL', () => {
  assert.equal(one('SELECT 1 + NULL'), null);
  assert.equal(one('SELECT NULL * 5'), null);
  assert.equal(one('SELECT -NULL'), null);
  assert.deepEqual(rows(setup(), 'SELECT a + 1 FROM t ORDER BY id'), [[11], [null], [6], [null]]);
});
// WHERE with OR where one side is NULL but the other TRUE keeps the row
test('WHERE OR with NULL side', () => assert.deepEqual(rows(setup(), "SELECT id FROM t WHERE a = 10 OR s = 'y'"), [[1], [2]]));
// WHERE with AND where one side is NULL rejects the row
test('WHERE AND with NULL side', () => assert.deepEqual(rows(setup(), "SELECT id FROM t WHERE a > 0 AND s = 'x'"), [[1]]));
// division and modulo by zero give NULL
test('divide by zero is NULL', () => {
  assert.equal(one('SELECT 1 / 0'), null);
  assert.equal(one('SELECT 5 % 0'), null);
});
// NULL never equals itself in IN, but IN finds a real match despite NULLs in the list
test('IN with NULL', () => {
  assert.equal(one('SELECT 1 IN (NULL, 1)'), 1);
  assert.equal(one('SELECT 2 IN (NULL, 1)'), null);
  assert.equal(one('SELECT NULL IN (1, 2)'), null);
});
// NOT IN with a NULL in the list is NULL when nothing matches
test('NOT IN with NULL', () => {
  assert.equal(one('SELECT 2 NOT IN (1, NULL)'), null);
  assert.equal(one('SELECT 1 NOT IN (1, NULL)'), 0);
  assert.equal(one('SELECT 3 NOT IN (1, 2)'), 1);
});
// NULL handling in BETWEEN and LIKE
test('BETWEEN and LIKE with NULL', () => {
  assert.equal(one('SELECT NULL BETWEEN 1 AND 3'), null);
  assert.equal(one('SELECT 2 BETWEEN NULL AND 3'), null);
  assert.equal(one('SELECT 5 BETWEEN NULL AND 3'), 0);
  assert.equal(one("SELECT NULL LIKE 'a%'"), null);
  assert.equal(one('SELECT NULL NOT LIKE NULL'), null);
});
// UPDATE ... WHERE col = NULL changes nothing; IS NULL does
test('UPDATE with NULL conditions', () => {
  const db = setup();
  assert.deepEqual(db.exec('UPDATE t SET a = 0 WHERE a = NULL'), { changes: 0 });
  assert.deepEqual(db.exec('UPDATE t SET a = 0 WHERE a IS NULL'), { changes: 2 });
});
