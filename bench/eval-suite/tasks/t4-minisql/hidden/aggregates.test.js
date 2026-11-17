import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../../src/index.js';

const rows = (db, sql) => db.exec(sql).rows;
const one = (sql) => createDatabase().exec(sql).rows[0][0];
const bad = (db, sql) => assert.throws(() => db.exec(sql), (e) => e instanceof Error && e.message.startsWith('SQL error:'));

function setup() {
  const db = createDatabase();
  db.exec('CREATE TABLE s (id INTEGER PRIMARY KEY, dept TEXT, region TEXT, amt INTEGER, w REAL)');
  db.exec("INSERT INTO s VALUES (1, 'a', 'n', 10, 1.5), (2, 'a', 's', 20, NULL), (3, 'b', 'n', 30, 2.5), (4, 'b', 'n', NULL, 3.5), (5, 'c', NULL, 5, NULL), (6, NULL, 's', 7, 0.5)");
  return db;
}
// COUNT(*) counts every row, COUNT(col) skips NULLs
test('COUNT star vs column', () => assert.deepEqual(rows(setup(), 'SELECT COUNT(*), COUNT(amt), COUNT(dept) FROM s'), [[6, 5, 5]]));
// SUM, MIN, MAX ignore NULLs
test('SUM MIN MAX ignore NULL', () => assert.deepEqual(rows(setup(), 'SELECT SUM(amt), MIN(amt), MAX(amt) FROM s'), [[72, 5, 30]]));
// AVG averages only non-NULL values
test('AVG ignores NULL', () => assert.deepEqual(rows(setup(), 'SELECT AVG(amt) FROM s'), [[14.4]]));
// AVG of REAL column, skipping NULLs
test('AVG of reals', () => assert.deepEqual(rows(setup(), 'SELECT AVG(w) FROM s'), [[2]]));
// MIN and MAX work on text
test('MIN MAX on text', () => assert.deepEqual(rows(setup(), 'SELECT MIN(dept), MAX(dept) FROM s'), [['a', 'c']]));
// aggregates over an empty set: COUNT is 0, others NULL
test('aggregates over empty table', () => {
  const db = createDatabase();
  db.exec('CREATE TABLE e (x INTEGER)');
  assert.deepEqual(rows(db, 'SELECT COUNT(*), COUNT(x), SUM(x), AVG(x), MIN(x), MAX(x) FROM e'), [[0, 0, null, null, null, null]]);
});
// aggregates where WHERE removes every row still give one row
test('aggregate with WHERE matching nothing', () => assert.deepEqual(rows(setup(), 'SELECT COUNT(*), SUM(amt) FROM s WHERE id > 100'), [[0, null]]));
// SUM and COUNT over an all-NULL column
test('all NULL column', () => {
  const db = createDatabase();
  db.exec('CREATE TABLE n (x INTEGER)');
  db.exec('INSERT INTO n VALUES (NULL), (NULL)');
  assert.deepEqual(rows(db, 'SELECT COUNT(*), COUNT(x), SUM(x), MAX(x) FROM n'), [[2, 0, null, null]]);
});
// GROUP BY one column; groups appear in first-seen order; NULL forms its own group
test('GROUP BY single column', () => assert.deepEqual(rows(setup(), 'SELECT dept, COUNT(*) FROM s GROUP BY dept'), [['a', 2], ['b', 2], ['c', 1], [null, 1]]));
// GROUP BY with SUM per group, NULLs skipped inside groups
test('GROUP BY SUM', () => assert.deepEqual(rows(setup(), 'SELECT dept, SUM(amt) FROM s GROUP BY dept ORDER BY dept'), [[null, 7], ['a', 30], ['b', 30], ['c', 5]]));
// GROUP BY two columns
test('GROUP BY two columns', () => assert.deepEqual(rows(setup(), 'SELECT dept, region, COUNT(*) FROM s GROUP BY dept, region ORDER BY dept, region'), [[null, 's', 1], ['a', 'n', 1], ['a', 's', 1], ['b', 'n', 2], ['c', null, 1]]));
// HAVING filters groups by an aggregate
test('HAVING aggregate', () => assert.deepEqual(rows(setup(), 'SELECT dept FROM s GROUP BY dept HAVING COUNT(*) > 1 ORDER BY dept'), [['a'], ['b']]));
// HAVING may use an aggregate that is not in the select list
test('HAVING hidden aggregate', () => assert.deepEqual(rows(setup(), 'SELECT dept FROM s GROUP BY dept HAVING SUM(amt) >= 30 ORDER BY dept'), [['a'], ['b']]));
// HAVING that evaluates to NULL drops the group (SUM of c is 5, group NULL has MAX(w)=0.5)
test('HAVING NULL drops group', () => assert.deepEqual(rows(setup(), 'SELECT dept FROM s GROUP BY dept HAVING MAX(w) > 1 ORDER BY dept'), [['a'], ['b']]));
// WHERE filters rows before grouping
test('WHERE before GROUP BY', () => assert.deepEqual(rows(setup(), "SELECT dept, COUNT(*) FROM s WHERE region = 'n' GROUP BY dept"), [['a', 1], ['b', 2]]));
// aggregates inside larger expressions
test('aggregate in expression', () => assert.deepEqual(rows(setup(), 'SELECT dept, SUM(amt) * 2 + 1 FROM s GROUP BY dept ORDER BY dept DESC LIMIT 2'), [['c', 11], ['b', 61]]));
// ORDER BY an aggregate (not selected) and by an alias of an aggregate
test('ORDER BY aggregate', () => {
  assert.deepEqual(rows(setup(), 'SELECT dept FROM s GROUP BY dept ORDER BY COUNT(*) DESC, dept'), [['a'], ['b'], [null], ['c']]);
  assert.deepEqual(rows(setup(), 'SELECT dept, SUM(amt) AS total FROM s GROUP BY dept ORDER BY total DESC, dept LIMIT 3'), [['a', 30], ['b', 30], [null, 7]]);
});
// the aggregate result column keeps the call text or the alias as its name
test('aggregate column names', () => {
  const r = setup().exec('SELECT SUM(amt) AS t, MAX(amt), count(*) FROM s');
  assert.deepEqual(r.columns, ['t', 'MAX(amt)', 'count(*)']);
});
// aggregate function names are case-insensitive
test('aggregate names case-insensitive', () => assert.deepEqual(rows(setup(), 'select Count(*), sUm(amt), min(amt) from s'), [[6, 72, 5]]));
// integer SUM stays integer; AVG may be fractional
test('SUM and AVG values', () => {
  const db = createDatabase();
  db.exec('CREATE TABLE n (x INTEGER)');
  db.exec('INSERT INTO n VALUES (1), (2), (4)');
  assert.deepEqual(rows(db, 'SELECT SUM(x), AVG(x) FROM n'), [[7, 7 / 3]]);
});
// DISTINCT with GROUP BY output and aggregate over an expression
test('aggregate over expression', () => assert.deepEqual(rows(setup(), 'SELECT SUM(amt * 2), MAX(amt - 5) FROM s'), [[144, 25]]));
// GROUP BY on an empty table yields no rows
test('GROUP BY empty table', () => {
  const db = createDatabase();
  db.exec('CREATE TABLE e (x INTEGER, y INTEGER)');
  assert.deepEqual(rows(db, 'SELECT x, COUNT(*) FROM e GROUP BY x'), []);
});
// a bare column next to an aggregate without GROUP BY is an error
test('bare column with aggregate is an error', () => {
  const db = setup();
  bad(db, 'SELECT dept, COUNT(*) FROM s');
  bad(db, 'SELECT region, COUNT(*) FROM s GROUP BY dept');
});
// aggregates are rejected in WHERE and when nested
test('aggregate misuse errors', () => {
  const db = setup();
  bad(db, 'SELECT id FROM s WHERE COUNT(*) > 1');
  bad(db, 'SELECT SUM(COUNT(*)) FROM s');
  bad(db, 'SELECT SUM(dept) FROM s');
  bad(db, 'SELECT * FROM s GROUP BY dept');
});
