import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../../src/index.js';

const rows = (db, sql) => db.exec(sql).rows;
const one = (sql) => createDatabase().exec(sql).rows[0][0];
const bad = (db, sql) => assert.throws(() => db.exec(sql), (e) => e instanceof Error && e.message.startsWith('SQL error:'));

function setup() {
  const db = createDatabase();
  db.exec('CREATE TABLE u (id INTEGER PRIMARY KEY, name TEXT, qty INTEGER, price REAL)');
  db.exec("INSERT INTO u VALUES (1, 'a', 5, 1.5), (2, 'b', 6, 2.5), (3, 'c', 7, 3.5)");
  return db;
}
// CREATE TABLE reports zero changes
test('CREATE returns changes 0', () => assert.deepEqual(createDatabase().exec('CREATE TABLE t (a INTEGER)'), { changes: 0 }));
// multi-row INSERT reports the number of rows added
test('INSERT multi-row changes', () => {
  const db = createDatabase();
  db.exec('CREATE TABLE t (a INTEGER)');
  assert.deepEqual(db.exec('INSERT INTO t VALUES (1), (2), (3)'), { changes: 3 });
  assert.equal(rows(db, 'SELECT COUNT(*) FROM t')[0][0], 3);
});
// INSERT with a column list fills the others with NULL and honours column order
test('INSERT with column list', () => {
  const db = setup();
  db.exec("INSERT INTO u (name, id) VALUES ('d', 4)");
  assert.deepEqual(rows(db, 'SELECT * FROM u WHERE id = 4'), [[4, 'd', null, null]]);
});
// REAL columns accept whole numbers and decimals; INTEGER accepts 6.0 as a whole number
test('numeric type acceptance', () => {
  const db = setup();
  db.exec("INSERT INTO u VALUES (4, 'd', 2.0, 3)");
  assert.deepEqual(rows(db, 'SELECT qty, price FROM u WHERE id = 4'), [[2, 3]]);
});
// UPDATE returns matched count and applies the expression
test('UPDATE with WHERE', () => {
  const db = setup();
  assert.deepEqual(db.exec('UPDATE u SET qty = qty * 10 WHERE id >= 2'), { changes: 2 });
  assert.deepEqual(rows(db, 'SELECT qty FROM u ORDER BY id'), [[5], [60], [70]]);
});
// UPDATE without WHERE touches every row, even when a value stays the same
test('UPDATE all rows', () => {
  const db = setup();
  assert.deepEqual(db.exec("UPDATE u SET name = 'z'"), { changes: 3 });
  assert.deepEqual(rows(db, 'SELECT DISTINCT name FROM u'), [['z']]);
});
// UPDATE right-hand sides see the old row, so SET a=b, b=a swaps
test('UPDATE swap uses old values', () => {
  const db = createDatabase();
  db.exec('CREATE TABLE t (a INTEGER, b INTEGER)');
  db.exec('INSERT INTO t VALUES (1, 2)');
  db.exec('UPDATE t SET a = b, b = a');
  assert.deepEqual(rows(db, 'SELECT a, b FROM t'), [[2, 1]]);
});
// UPDATE can set NULL and several columns at once
test('UPDATE multiple columns and NULL', () => {
  const db = setup();
  db.exec("UPDATE u SET name = NULL, qty = qty + 1 WHERE id = 1");
  assert.deepEqual(rows(db, 'SELECT name, qty FROM u WHERE id = 1'), [[null, 6]]);
});
// UPDATE that matches nothing returns 0
test('UPDATE no match', () => assert.deepEqual(setup().exec('UPDATE u SET qty = 0 WHERE id = 99'), { changes: 0 }));
// UPDATE of the primary key to a free value works and the old key can be reused
test('UPDATE primary key', () => {
  const db = setup();
  db.exec('UPDATE u SET id = 10 WHERE id = 1');
  db.exec("INSERT INTO u VALUES (1, 'new', 0, 0)");
  assert.deepEqual(rows(db, 'SELECT id FROM u ORDER BY id'), [[1], [2], [3], [10]]);
});
// shifting every primary key by one is fine because the final set is unique
test('UPDATE primary key shift', () => {
  const db = setup();
  assert.deepEqual(db.exec('UPDATE u SET id = id + 1'), { changes: 3 });
  assert.deepEqual(rows(db, 'SELECT id FROM u ORDER BY id'), [[2], [3], [4]]);
});
// DELETE with WHERE returns the deleted count
test('DELETE with WHERE', () => {
  const db = setup();
  assert.deepEqual(db.exec('DELETE FROM u WHERE qty > 5'), { changes: 2 });
  assert.deepEqual(rows(db, 'SELECT id FROM u'), [[1]]);
});
// DELETE without WHERE empties the table; deleted keys can be reinserted
test('DELETE all then reinsert key', () => {
  const db = setup();
  assert.deepEqual(db.exec('DELETE FROM u'), { changes: 3 });
  assert.deepEqual(rows(db, 'SELECT * FROM u'), []);
  assert.deepEqual(db.exec("INSERT INTO u VALUES (1, 'again', 1, 1)"), { changes: 1 });
});
// a failed multi-row INSERT inserts nothing
test('INSERT is atomic', () => {
  const db = setup();
  bad(db, "INSERT INTO u VALUES (7, 'g', 1, 1), (8, 'h', 1, 1), (2, 'dup', 1, 1)");
  bad(db, "INSERT INTO u VALUES (9, 'i', 1, 1), (9, 'j', 1, 1)");
  assert.equal(rows(db, 'SELECT COUNT(*) FROM u')[0][0], 3);
});
// a failed UPDATE changes nothing (duplicate key hit on the last matching row)
test('UPDATE is atomic', () => {
  const db = setup();
  bad(db, 'UPDATE u SET id = 3 WHERE id >= 2');
  bad(db, "UPDATE u SET qty = 100, name = 5 WHERE id = 1");
  assert.deepEqual(rows(db, 'SELECT id, qty FROM u ORDER BY id'), [[1, 5], [2, 6], [3, 7]]);
});
// databases are independent of one another
test('independent databases', () => {
  const a = createDatabase();
  const b = createDatabase();
  a.exec('CREATE TABLE t (x INTEGER)');
  b.exec('CREATE TABLE t (y TEXT)');
  a.exec('INSERT INTO t VALUES (1)');
  assert.deepEqual(rows(b, 'SELECT * FROM t'), []);
  assert.deepEqual(a.exec('SELECT * FROM t').columns, ['x']);
});
// tables without a primary key allow duplicate rows
test('no primary key allows duplicates', () => {
  const db = createDatabase();
  db.exec('CREATE TABLE t (a INTEGER)');
  db.exec('INSERT INTO t VALUES (1), (1)');
  assert.equal(rows(db, 'SELECT COUNT(*) FROM t')[0][0], 2);
});
// a TEXT primary key enforces uniqueness too
test('TEXT primary key', () => {
  const db = createDatabase();
  db.exec('CREATE TABLE t (k TEXT PRIMARY KEY, v INTEGER)');
  db.exec("INSERT INTO t VALUES ('a', 1)");
  bad(db, "INSERT INTO t VALUES ('a', 2)");
  db.exec("INSERT INTO t VALUES ('A', 2)");
  assert.equal(rows(db, 'SELECT COUNT(*) FROM t')[0][0], 2);
});
