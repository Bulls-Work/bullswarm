import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/index.js';

function setup() {
  const db = createDatabase();
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, age INTEGER)');
  db.exec("INSERT INTO users VALUES (1, 'ann', 30), (2, 'bob', 25), (3, 'cy', NULL)");
  return db;
}

test('create and select all', () => {
  const db = setup();
  assert.deepEqual(db.exec('SELECT * FROM users'), {
    columns: ['id', 'name', 'age'],
    rows: [[1, 'ann', 30], [2, 'bob', 25], [3, 'cy', null]],
  });
});

test('where, order by and limit', () => {
  const db = setup();
  const r = db.exec('select name from users where age > 20 order by age limit 1');
  assert.deepEqual(r.rows, [['bob']]);
});

test('update and delete report changes', () => {
  const db = setup();
  assert.deepEqual(db.exec('UPDATE users SET age = age + 1 WHERE id = 1'), { changes: 1 });
  assert.deepEqual(db.exec('DELETE FROM users WHERE age IS NULL'), { changes: 1 });
  assert.deepEqual(db.exec('SELECT id, age FROM users').rows, [[1, 31], [2, 25]]);
});

test('aggregates', () => {
  const db = setup();
  assert.deepEqual(db.exec('SELECT COUNT(*), COUNT(age), SUM(age) FROM users').rows, [[3, 2, 55]]);
});

test('bad input throws an SQL error', () => {
  const db = setup();
  assert.throws(() => db.exec('SELECT * FROM nope'), /^Error: SQL error:/);
});
