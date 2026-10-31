import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../../src/index.js';

const rows = (db, sql) => db.exec(sql).rows;
const one = (sql) => createDatabase().exec(sql).rows[0][0];
const bad = (db, sql) => assert.throws(() => db.exec(sql), (e) => e instanceof Error && e.message.startsWith('SQL error:'));

function setup() {
  const db = createDatabase();
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, n INTEGER)');
  db.exec("INSERT INTO t VALUES (1, 'a', 1)");
  return db;
}
// selecting from a missing table
test('unknown table', () => { const db = setup(); bad(db, 'SELECT * FROM nope'); bad(db, 'INSERT INTO nope VALUES (1)'); bad(db, 'UPDATE nope SET a = 1'); bad(db, 'DELETE FROM nope'); });
// table names are case-sensitive so the wrong case is unknown
test('table name case matters', () => bad(setup(), 'SELECT * FROM T'));
// unknown column in each clause
test('unknown column', () => {
  const db = setup();
  bad(db, 'SELECT zzz FROM t');
  bad(db, 'SELECT id FROM t WHERE zzz = 1');
  bad(db, 'SELECT id FROM t ORDER BY zzz');
  bad(db, 'UPDATE t SET zzz = 1');
  bad(db, 'INSERT INTO t (zzz) VALUES (1)');
});
// an unknown column is an error even when the table has no rows to evaluate
test('unknown column on empty table', () => {
  const db = createDatabase();
  db.exec('CREATE TABLE e (a INTEGER)');
  bad(db, 'SELECT zzz FROM e');
  bad(db, 'SELECT a FROM e WHERE zzz = 1');
  bad(db, 'DELETE FROM e WHERE zzz = 1');
});
// creating a table twice
test('duplicate table', () => bad(setup(), 'CREATE TABLE t (a INTEGER)'));
// bad CREATE TABLE definitions
test('bad CREATE TABLE', () => {
  const db = createDatabase();
  bad(db, 'CREATE TABLE t (a INTEGER, a TEXT)');
  bad(db, 'CREATE TABLE t (a BLOB)');
  bad(db, 'CREATE TABLE t (a INTEGER PRIMARY KEY, b INTEGER PRIMARY KEY)');
  bad(db, 'CREATE TABLE t ()');
  bad(db, 'CREATE TABLE t (a INTEGER');
});
// duplicate primary key on insert
test('duplicate primary key', () => bad(setup(), "INSERT INTO t VALUES (1, 'dup', 2)"));
// NULL primary key
test('NULL primary key', () => { const db = setup(); bad(db, "INSERT INTO t VALUES (NULL, 'x', 1)"); bad(db, "INSERT INTO t (name) VALUES ('x')"); bad(db, 'UPDATE t SET id = NULL'); });
// wrong value counts
test('wrong value count', () => { const db = setup(); bad(db, 'INSERT INTO t VALUES (2, 3)'); bad(db, 'INSERT INTO t (id, name) VALUES (2)'); bad(db, 'INSERT INTO t (id, id) VALUES (2, 3)'); });
// type mismatches
test('type mismatch', () => {
  const db = setup();
  bad(db, "INSERT INTO t VALUES (2, 5, 1)");
  bad(db, "INSERT INTO t VALUES (3, 'x', 'y')");
  bad(db, "INSERT INTO t VALUES (4, 'x', 1.5)");
  bad(db, "UPDATE t SET n = 'z'");
});
// syntax errors
test('syntax errors', () => {
  const db = setup();
  for (const sql of ['SELEC * FROM t', 'SELECT FROM t', 'SELECT * FROM', 'SELECT * FROM t WHERE', 'SELECT 1 +', 'SELECT (1', 'SELECT * FROM t ORDER id', 'INSERT t VALUES (1)', 'UPDATE t WHERE id = 1', 'DELETE t', 'SELECT * FROM t LIMIT x', 'SELECT * FROM t OFFSET 1']) bad(db, sql);
});
// empty and non-string input
test('empty and non-string input', () => {
  const db = setup();
  bad(db, '');
  bad(db, '   ');
  bad(db, ';');
  bad(db, 42);
  bad(db, undefined);
});
// unterminated string and stray characters
test('lexical errors', () => {
  const db = setup();
  bad(db, "SELECT 'abc");
  bad(db, 'SELECT "name" FROM t');
  bad(db, 'SELECT 1 # 2');
  bad(db, 'SELECT 12abc');
});
// trailing garbage and multiple statements
test('trailing text', () => {
  const db = setup();
  bad(db, 'SELECT * FROM t garbage');
  bad(db, 'SELECT * FROM t; SELECT * FROM t');
  bad(db, 'SELECT * FROM t;;');
});
// comparing a number with text is an error
test('number vs string comparison', () => { const db = setup(); bad(db, "SELECT * FROM t WHERE name = 1"); bad(db, "SELECT 1 < 'a'"); });
// arithmetic on strings, and a string used as a condition, are errors
test('string misuse', () => { const db = setup(); bad(db, "SELECT 'a' + 1"); bad(db, "SELECT -'a'"); bad(db, "SELECT * FROM t WHERE name"); bad(db, "SELECT 'a' AND 1"); });
// unknown function and bad aggregate arguments
test('bad function calls', () => { const db = setup(); bad(db, 'SELECT FOO(n) FROM t'); bad(db, 'SELECT SUM(*) FROM t'); bad(db, 'SELECT COUNT() FROM t'); });
// reserved words cannot be used as identifiers
test('reserved words', () => { const db = createDatabase(); bad(db, 'CREATE TABLE select (a INTEGER)'); bad(db, 'CREATE TABLE t (from INTEGER)'); });
// star misuse and aggregate in INSERT/UPDATE
test('star and aggregate misuse', () => { const db = setup(); bad(db, 'SELECT *'); bad(db, 'INSERT INTO t VALUES (COUNT(*), 1, 1)'); bad(db, 'UPDATE t SET n = SUM(n)'); bad(db, 'INSERT INTO t VALUES (n, 1, 1)'); });
// errors are plain Error instances with the SQL error prefix, and the database stays usable afterwards
test('error shape and recovery', () => {
  const db = setup();
  let caught;
  try { db.exec('SELECT * FROM nope'); } catch (e) { caught = e; }
  assert.ok(caught instanceof Error);
  assert.match(caught.message, /^SQL error: /);
  assert.deepEqual(rows(db, 'SELECT id FROM t'), [[1]]);
});
