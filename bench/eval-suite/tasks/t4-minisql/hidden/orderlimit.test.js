import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../../src/index.js';

const rows = (db, sql) => db.exec(sql).rows;
const one = (sql) => createDatabase().exec(sql).rows[0][0];
const bad = (db, sql) => assert.throws(() => db.exec(sql), (e) => e instanceof Error && e.message.startsWith('SQL error:'));

function setup() {
  const db = createDatabase();
  db.exec('CREATE TABLE p (id INTEGER PRIMARY KEY, name TEXT, score INTEGER, grp TEXT)');
  db.exec("INSERT INTO p VALUES (1, 'delta', 50, 'x'), (2, 'alpha', 90, 'y'), (3, 'charlie', NULL, 'x'), (4, 'bravo', 90, 'y'), (5, 'echo', 10, 'x'), (6, 'B', 70, 'z')");
  return db;
}
// default ORDER BY is ascending with NULL first
test('ORDER BY default asc, NULL first', () => assert.deepEqual(rows(setup(), 'SELECT id FROM p ORDER BY score'), [[3], [5], [1], [6], [2], [4]]));
// DESC puts NULL last; equal keys keep insertion order (stable)
test('ORDER BY DESC, NULL last, stable', () => assert.deepEqual(rows(setup(), 'SELECT id FROM p ORDER BY score DESC'), [[2], [4], [6], [1], [5], [3]]));
// ORDER BY with a tie-breaker column
test('ORDER BY two keys', () => assert.deepEqual(rows(setup(), 'SELECT id FROM p ORDER BY score DESC, name ASC'), [[2], [4], [6], [1], [5], [3]]));
// text sorts by character code so uppercase comes before lowercase
test('ORDER BY text code order', () => assert.deepEqual(rows(setup(), 'SELECT name FROM p ORDER BY name').slice(0, 2), [['B'], ['alpha']]));
// ORDER BY an expression that is not selected
test('ORDER BY expression', () => assert.deepEqual(rows(setup(), 'SELECT name FROM p WHERE score IS NOT NULL ORDER BY score / 4000 - score, id'), [['alpha'], ['bravo'], ['B'], ['delta'], ['echo']]));
// ORDER BY a select-list alias
test('ORDER BY alias', () => assert.deepEqual(rows(setup(), 'SELECT id, score / 10 AS tens FROM p WHERE score IS NOT NULL ORDER BY tens DESC, id DESC LIMIT 3'), [[4, 9], [2, 9], [6, 7]]));
// LIMIT cuts the result
test('LIMIT', () => assert.deepEqual(rows(setup(), 'SELECT id FROM p ORDER BY id LIMIT 2'), [[1], [2]]));
// LIMIT 0 returns no rows; LIMIT beyond the row count returns all
test('LIMIT 0 and large', () => {
  assert.deepEqual(rows(setup(), 'SELECT id FROM p LIMIT 0'), []);
  assert.equal(rows(setup(), 'SELECT id FROM p LIMIT 100').length, 6);
});
// OFFSET skips rows after ordering
test('LIMIT OFFSET', () => assert.deepEqual(rows(setup(), 'SELECT id FROM p ORDER BY id LIMIT 2 OFFSET 3'), [[4], [5]]));
// OFFSET past the end gives nothing
test('OFFSET past end', () => assert.deepEqual(rows(setup(), 'SELECT id FROM p ORDER BY id LIMIT 5 OFFSET 10'), []));
// DISTINCT removes duplicate rows, keeping first occurrence order
test('DISTINCT', () => assert.deepEqual(rows(setup(), 'SELECT DISTINCT grp FROM p'), [['x'], ['y'], ['z']]));
// DISTINCT over several columns treats NULLs as equal
test('DISTINCT multi-column with NULLs', () => {
  const db = createDatabase();
  db.exec('CREATE TABLE d (a INTEGER, b INTEGER)');
  db.exec('INSERT INTO d VALUES (1, NULL), (1, NULL), (1, 2), (NULL, NULL), (NULL, NULL), (1, 2)');
  assert.deepEqual(rows(db, 'SELECT DISTINCT a, b FROM d'), [[1, null], [1, 2], [null, null]]);
});
// DISTINCT is applied before LIMIT
test('DISTINCT then LIMIT', () => assert.deepEqual(rows(setup(), 'SELECT DISTINCT grp FROM p ORDER BY grp DESC LIMIT 2'), [['z'], ['y']]));
// DISTINCT on an expression and with WHERE
test('DISTINCT expression', () => assert.deepEqual(rows(setup(), 'SELECT DISTINCT score / 40 FROM p WHERE score IS NOT NULL ORDER BY score / 40'), [[0], [1], [2]]));
// SELECT * with ORDER BY and LIMIT
test('star with ORDER BY LIMIT', () => assert.deepEqual(db1().exec('SELECT * FROM p ORDER BY score DESC, id LIMIT 1'), { columns: ['id', 'name', 'score', 'grp'], rows: [[2, 'alpha', 90, 'y']] }));
function db1() { return setup(); }
// ORDER BY after GROUP BY on a grouped column, with LIMIT/OFFSET
test('GROUP BY ORDER BY LIMIT OFFSET', () => assert.deepEqual(rows(setup(), 'SELECT grp, COUNT(*) AS n FROM p GROUP BY grp ORDER BY n DESC, grp LIMIT 1 OFFSET 1'), [['y', 2]]));
// ORDER BY keyword case and mixed ASC/DESC
test('mixed ASC DESC', () => assert.deepEqual(rows(setup(), 'select id from p order by grp asc, score desc, id'), [[1], [5], [3], [2], [4], [6]]));
