import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../../src/csv.js';

// plain rows keep working
test('plain rows', () => assert.deepEqual(parseCsv('a,b\n1,2\n'), [['a', 'b'], ['1', '2']]));
// empty input is no rows
test('empty input', () => assert.deepEqual(parseCsv(''), []));
// no trailing line break still gives the last row
test('no trailing newline', () => assert.deepEqual(parseCsv('a,b\n1,2'), [['a', 'b'], ['1', '2']]));
// a comma inside quotes is part of the value
test('quoted comma', () => assert.deepEqual(parseCsv('"a,b",c'), [['a,b', 'c']]));
// a line break inside quotes is part of the value (the bug report)
test('quoted newline', () => assert.deepEqual(parseCsv('id,note\n1,"line one\nline two"\n'), [['id', 'note'], ['1', 'line one\nline two']]));
// a doubled quote is one quote (the bug report)
test('doubled quote', () => assert.deepEqual(parseCsv('1,"say ""hi"""'), [['1', 'say "hi"']]));
// a field that is only a doubled quote pair is one quote
test('only an escaped quote', () => assert.deepEqual(parseCsv('""""'), [['"']]));
// CRLF line endings
test('crlf', () => assert.deepEqual(parseCsv('a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']]));
// CRLF inside a quoted field is kept
test('quoted crlf kept', () => assert.deepEqual(parseCsv('"x\r\ny",z'), [['x\r\ny', 'z']]));
// an empty quoted field is an empty string
test('empty quoted field', () => assert.deepEqual(parseCsv('"",a'), [['', 'a']]));
// empty fields between commas
test('empty fields', () => assert.deepEqual(parseCsv('a,,b,\n'), [['a', '', 'b', '']]));
// an empty line in the middle is a row with one empty field
test('empty middle line', () => assert.deepEqual(parseCsv('a\n\nb\n'), [['a'], [''], ['b']]));
// spaces in unquoted fields are kept
test('spaces kept', () => assert.deepEqual(parseCsv(' a , b '), [[' a ', ' b ']]));
// an unterminated quote throws
test('unterminated quote throws', () => assert.throws(() => parseCsv('a,"b\nc'), /^Error: unterminated quoted field/));
// a long multi-line note round trip
test('mixed record', () => assert.deepEqual(
  parseCsv('id,name,note\r\n7,"Doe, Jane","She said ""ok""\nthen left"\r\n8,Bob,\r\n'),
  [['id', 'name', 'note'], ['7', 'Doe, Jane', 'She said "ok"\nthen left'], ['8', 'Bob', '']],
));
