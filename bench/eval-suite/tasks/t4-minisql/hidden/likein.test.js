import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../../src/index.js';

const rows = (db, sql) => db.exec(sql).rows;
const one = (sql) => createDatabase().exec(sql).rows[0][0];
const bad = (db, sql) => assert.throws(() => db.exec(sql), (e) => e instanceof Error && e.message.startsWith('SQL error:'));

function setup() {
  const db = createDatabase();
  db.exec('CREATE TABLE w (id INTEGER PRIMARY KEY, s TEXT, n INTEGER)');
  db.exec("INSERT INTO w VALUES (1, 'apple', 1), (2, 'apricot', 2), (3, 'banana', 3), (4, 'Apple', 4), (5, 'a_c', 5), (6, 'abc', 6), (7, '100%', 7), (8, '', 8), (9, NULL, 9)");
  return db;
}
const ids = (db, sql) => rows(db, sql).map((r) => r[0]);
// % at the end matches a prefix
test('LIKE prefix', () => assert.deepEqual(ids(setup(), "SELECT id FROM w WHERE s LIKE 'ap%'"), [1, 2]));
// % at the start matches a suffix
test('LIKE suffix', () => assert.deepEqual(ids(setup(), "SELECT id FROM w WHERE s LIKE '%ana'"), [3]));
// %x% matches a substring anywhere
test('LIKE contains', () => assert.deepEqual(ids(setup(), "SELECT id FROM w WHERE s LIKE '%an%'"), [3]));
// _ matches exactly one character
test('LIKE underscore', () => assert.deepEqual(ids(setup(), "SELECT id FROM w WHERE s LIKE 'a_c'"), [5, 6]));
// pattern must cover the whole string
test('LIKE whole string', () => { assert.deepEqual(ids(setup(), "SELECT id FROM w WHERE s LIKE 'app'"), []); assert.deepEqual(ids(setup(), "SELECT id FROM w WHERE s LIKE 'apple'"), [1]); });
// LIKE is case-sensitive
test('LIKE case-sensitive', () => assert.deepEqual(ids(setup(), "SELECT id FROM w WHERE s LIKE 'A%'"), [4]));
// % matches the empty string, and a lone % matches every non-NULL value
test('LIKE percent matches empty', () => { assert.deepEqual(ids(setup(), "SELECT id FROM w WHERE s LIKE '%'"), [1, 2, 3, 4, 5, 6, 7, 8]); assert.equal(one("SELECT '' LIKE '%'"), 1); assert.equal(one("SELECT '' LIKE '_'"), 0); });
// regex metacharacters in the pattern match literally
test('LIKE literal metacharacters', () => {
  assert.equal(one("SELECT 'a.c' LIKE 'a.c'"), 1);
  assert.equal(one("SELECT 'abc' LIKE 'a.c'"), 0);
  assert.equal(one("SELECT '(x)+' LIKE '(x)+'"), 1);
  assert.equal(one("SELECT 'a*' LIKE 'a*'"), 1);
  assert.equal(one("SELECT 'aaa' LIKE 'a*'"), 0);
  assert.equal(one("SELECT '[a]' LIKE '[a]'"), 1);
});
// multiple wildcards in one pattern
test('LIKE mixed wildcards', () => { assert.equal(one("SELECT 'abcde' LIKE 'a%c_e'"), 1); assert.equal(one("SELECT 'abcd' LIKE 'a%c_e'"), 0); assert.equal(one("SELECT 'abc' LIKE '%%_%%'"), 1); });
// NOT LIKE excludes matches and NULL rows
test('NOT LIKE', () => assert.deepEqual(ids(setup(), "SELECT id FROM w WHERE s NOT LIKE '%a%'"), [4, 7, 8]));
// LIKE on a newline-containing string
test('LIKE with newline', () => { assert.equal(one("SELECT 'a\nb' LIKE 'a_b'"), 1); assert.equal(one("SELECT 'a\nb' LIKE 'a%'"), 1); });
// IN with numbers
test('IN numbers', () => assert.deepEqual(ids(setup(), 'SELECT id FROM w WHERE n IN (2, 4, 6, 99)'), [2, 4, 6]));
// IN with strings and NOT IN
test('IN strings', () => { assert.deepEqual(ids(setup(), "SELECT id FROM w WHERE s IN ('apple', 'banana')"), [1, 3]); assert.deepEqual(ids(setup(), "SELECT id FROM w WHERE s NOT IN ('apple', 'banana', 'Apple', 'apricot', 'a_c', 'abc', '100%')"), [8]); });
// IN with a single item and with expressions
test('IN expressions', () => { assert.deepEqual(ids(setup(), 'SELECT id FROM w WHERE n IN (1 + 1)'), [2]); assert.equal(one('SELECT 3 IN (1+1, 1+2)'), 1); });
// BETWEEN is inclusive on both ends
test('BETWEEN inclusive', () => assert.deepEqual(ids(setup(), 'SELECT id FROM w WHERE n BETWEEN 3 AND 5'), [3, 4, 5]));
// NOT BETWEEN
test('NOT BETWEEN', () => assert.deepEqual(ids(setup(), 'SELECT id FROM w WHERE n NOT BETWEEN 2 AND 8'), [1, 9]));
// BETWEEN with text bounds
test('BETWEEN text', () => assert.deepEqual(ids(setup(), "SELECT id FROM w WHERE s BETWEEN 'b' AND 'c'"), [3]));
// the AND inside BETWEEN does not end the condition; further AND/OR still work
test('BETWEEN with logic AND', () => {
  assert.deepEqual(ids(setup(), "SELECT id FROM w WHERE n BETWEEN 1 AND 6 AND s LIKE 'a%'"), [1, 2, 5, 6]);
  assert.deepEqual(ids(setup(), 'SELECT id FROM w WHERE n BETWEEN 1 AND 2 OR n = 9'), [1, 2, 9]);
});
// BETWEEN bounds can be arithmetic expressions
test('BETWEEN expressions', () => assert.equal(one('SELECT 5 BETWEEN 2 + 1 AND 2 * 3'), 1));
// IN, BETWEEN and LIKE compose with NOT in front
test('NOT in front of predicates', () => {
  assert.deepEqual(ids(setup(), 'SELECT id FROM w WHERE NOT n IN (1, 2, 3, 4, 5, 6, 7)'), [8, 9]);
  assert.deepEqual(ids(setup(), "SELECT id FROM w WHERE NOT s LIKE '%a%' OR n = 1"), [1, 4, 7, 8]);
});
// predicate results as values are 1/0
test('predicates as values', () => assert.deepEqual(rows(setup(), "SELECT n IN (1), n BETWEEN 1 AND 1, s LIKE 'apple' FROM w WHERE id = 1"), [[1, 1, 1]]));
