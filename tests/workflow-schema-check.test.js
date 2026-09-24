import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync, ftruncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  SCHEMA_MAX_DATA_BYTES, SCHEMA_MAX_SCHEMA_BYTES, checkSchemaFiles, schemaSubsetIssues, unwrapOneFence, validateAgainstSchema,
} from '../src/workflow/schema-check.js';

const CLI = fileURLToPath(new URL('../bin/check-schema.js', import.meta.url));

const errorsOf = (value, schema) => validateAgainstSchema(value, schema).errors;
const ok = (value, schema) => assert.deepEqual(errorsOf(value, schema), [], JSON.stringify({ value, schema }));
const bad = (value, schema, expected) => assert.deepEqual(errorsOf(value, schema), expected);

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'acme-schema-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(dir, name, body) {
  const path = join(dir, name);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body));
  return path;
}

test('type: one name, several names, integer vs number', () => {
  ok('x', { type: 'string' });
  bad(1, { type: 'string' }, ['$ must be string (got integer)']);
  ok(null, { type: ['string', 'null'] });
  bad(true, { type: ['string', 'null'] }, ['$ must be string|null (got boolean)']);
  ok(2, { type: 'integer' });
  bad(2.5, { type: 'integer' }, ['$ must be integer (got number)']);
  ok(2.5, { type: 'number' });
  ok(2, { type: 'number' });
  ok([], { type: 'array' });
  bad([], { type: 'object' }, ['$ must be object (got array)']);
  ok({}, { type: 'object' });
  bad(null, { type: 'object' }, ['$ must be object (got null)']);
  ok(false, { type: 'boolean' });
});

test('enum and const use deep JSON equality', () => {
  ok({ a: [1, 2] }, { enum: [1, { a: [1, 2] }] });
  bad({ a: [2, 1] }, { enum: [1, { a: [1, 2] }] }, ['$ must be one of [1,{"a":[1,2]}]']);
  ok({ b: 1, a: 2 }, { const: { a: 2, b: 1 } });
  bad('x', { const: 'y' }, ['$ must equal "y"']);
  const long = Array.from({ length: 40 }, (_, i) => `v${i}`);
  const [message] = errorsOf('nope', { enum: long });
  assert.ok(message.startsWith('$ must be one of ["v0","v1"'));
  assert.equal(message.length, '$ must be one of '.length + 80);
  assert.ok(message.endsWith('…'));
});

test('properties, required and additionalProperties', () => {
  const schema = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false };
  ok({ name: 'initech' }, schema);
  bad({}, schema, ['$ is missing required property "name"']);
  bad({ name: 1 }, schema, ['$.name must be string (got integer)']);
  bad({ name: 'a', extra: 1, 'a b': 2 }, schema, ['$.extra is not allowed', '$["a b"] is not allowed']);
  const typed = { properties: { a: true }, additionalProperties: { type: 'number' } };
  ok({ a: 'x', b: 1 }, typed);
  bad({ a: 'x', b: 'y' }, typed, ['$.b must be number (got string)']);
});

test('minProperties and maxProperties', () => {
  ok({ a: 1 }, { minProperties: 1 });
  bad({}, { minProperties: 1 }, ['$ must have at least 1 properties']);
  ok({ a: 1 }, { maxProperties: 1 });
  bad({ a: 1, b: 2 }, { maxProperties: 1 }, ['$ must have at most 1 properties']);
});

test('items, minItems, maxItems, uniqueItems', () => {
  ok([1, 2], { items: { type: 'integer' } });
  bad([1, 'x'], { items: { type: 'integer' } }, ['$[1] must be integer (got string)']);
  ok([1], { minItems: 1 });
  bad([], { minItems: 1 }, ['$ must have at least 1 items']);
  ok([1], { maxItems: 1 });
  bad([1, 2], { maxItems: 1 }, ['$ must have at most 1 items']);
  ok([{ a: 1 }, { a: 2 }], { uniqueItems: true });
  bad([1, { a: [1] }, 3, { a: [1] }], { uniqueItems: true }, ['$ has duplicate items at [1] and [3]']);
  ok([1, 1], { uniqueItems: false });
});

test('minLength and maxLength count Unicode code points', () => {
  ok('😀😀', { maxLength: 2 });
  bad('😀😀😀', { maxLength: 2 }, ['$ must be at most 2 characters']);
  ok('ab', { minLength: 2 });
  bad('😀', { minLength: 2 }, ['$ must be at least 2 characters']);
});

test('pattern is an unanchored u-flag RegExp', () => {
  ok('date 2026-09-24 here', { pattern: '\\d{4}-\\d{2}-\\d{2}' });
  bad('2026-9-24', { pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, ['$ must match pattern ^\\d{4}-\\d{2}-\\d{2}$']);
  ok('😀', { pattern: '^.$' });
});

test('numeric bounds and multipleOf', () => {
  ok(1, { minimum: 1 });
  bad(0, { minimum: 1 }, ['$ must be >= 1']);
  ok(1, { maximum: 1 });
  bad(2, { maximum: 1 }, ['$ must be <= 1']);
  ok(2, { exclusiveMinimum: 1 });
  bad(1, { exclusiveMinimum: 1 }, ['$ must be > 1']);
  ok(0, { exclusiveMaximum: 1 });
  bad(1, { exclusiveMaximum: 1 }, ['$ must be < 1']);
  ok(0.3, { multipleOf: 0.1 });
  ok(9, { multipleOf: 3 });
  bad(10, { multipleOf: 3 }, ['$ must be a multiple of 3']);
});

test('allOf, anyOf, oneOf, not', () => {
  ok(5, { allOf: [{ minimum: 1 }, { maximum: 9 }] });
  bad(10, { allOf: [{ minimum: 1 }, { maximum: 9 }] }, ['$ must be <= 9']);
  ok('x', { anyOf: [{ type: 'string' }, { type: 'number' }] });
  bad(true, { anyOf: [{ type: 'string' }, { type: 'number' }] }, ['$ must match at least one of anyOf (2 options)']);
  ok(1.5, { oneOf: [{ type: 'integer' }, { type: 'number', maximum: 2 }] });
  bad(1, { oneOf: [{ type: 'integer' }, { type: 'number' }] }, ['$ must match exactly one of oneOf (matched 2 of 2)']);
  bad('x', { oneOf: [{ type: 'integer' }, { type: 'number' }] }, ['$ must match exactly one of oneOf (matched 0 of 2)']);
  ok(1, { not: { type: 'string' } });
  bad('x', { not: { type: 'string' } }, ['$ must not match the not schema']);
});

test('boolean schemas', () => {
  ok(1, true);
  bad(1, false, ['$ is not allowed']);
  bad({ a: 1 }, { properties: { a: false } }, ['$.a is not allowed']);
  assert.deepEqual(schemaSubsetIssues(true), []);
});

test('$ref to #, #/$defs and #/definitions, siblings apply, recursive trees', () => {
  const defs = { $defs: { name: { type: 'string', minLength: 1 } }, properties: { n: { $ref: '#/$defs/name' } } };
  ok({ n: 'a' }, defs);
  bad({ n: '' }, defs, ['$.n must be at least 1 characters']);
  const old = { definitions: { id: { type: 'integer' } }, items: { $ref: '#/definitions/id', minimum: 1 } };
  ok([1, 2], old);
  bad([0], old, ['$[0] must be >= 1']);
  const tree = {
    type: 'object', required: ['name'],
    properties: { name: { type: 'string' }, children: { type: 'array', items: { $ref: '#' } } },
  };
  ok({ name: 'a', children: [{ name: 'b', children: [{ name: 'c' }] }] }, tree);
  bad({ name: 'a', children: [{ children: [] }] }, tree, ['$.children[0] is missing required property "name"']);
  assert.deepEqual(schemaSubsetIssues(tree), []);
});

test('nesting deeper than 64 is refused; a $ref loop is caught', (t) => {
  let deep = { type: 'string' };
  for (let i = 0; i < 70; i += 1) deep = { items: deep };
  assert.deepEqual(schemaSubsetIssues(deep).map((issue) => issue.message), ['schema nesting deeper than 64']);
  let fine = { type: 'string' };
  for (let i = 0; i < 60; i += 1) fine = { items: fine };
  assert.deepEqual(schemaSubsetIssues(fine), []);

  const dir = tempDir(t);
  write(dir, 'loop.json', { $ref: '#/$defs/a', $defs: { a: { $ref: '#/$defs/b' }, b: { $ref: '#/$defs/a' } } });
  write(dir, 'd.json', 1);
  const result = checkSchemaFiles({ cwd: dir, file: 'd.json', schema: 'loop.json' });
  assert.deepEqual([result.exit, result.fault, result.why], [2, 'check', 'schema nesting deeper than 64']);
  write(dir, 'deep.json', deep);
  const refused = checkSchemaFiles({ cwd: dir, file: 'd.json', schema: 'deep.json' });
  assert.deepEqual([refused.exit, refused.fault, refused.why], [2, 'check', 'schema nesting deeper than 64']);
});

test('every refused keyword gives its exact message and pointer', () => {
  const cases = [
    [{ if: {}, then: {}, else: {} }, ['unsupported keyword "if" at #', 'unsupported keyword "then" at #', 'unsupported keyword "else" at #']],
    [{ properties: { x: { patternProperties: {} } } }, ['unsupported keyword "patternProperties" at #/properties/x']],
    [{ propertyNames: {} }, ['unsupported keyword "propertyNames" at #']],
    [{ dependentRequired: {} }, ['unsupported keyword "dependentRequired" at #']],
    [{ dependentSchemas: {} }, ['unsupported keyword "dependentSchemas" at #']],
    [{ prefixItems: [] }, ['unsupported keyword "prefixItems" at #']],
    [{ items: [{}] }, ['unsupported keyword "items" at #']],
    [{ additionalItems: false }, ['unsupported keyword "additionalItems" at #']],
    [{ contains: {} }, ['unsupported keyword "contains" at #']],
    [{ unevaluatedProperties: false }, ['unsupported keyword "unevaluatedProperties" at #']],
    [{ unevaluatedItems: false }, ['unsupported keyword "unevaluatedItems" at #']],
    [{ $anchor: 'a' }, ['unsupported keyword "$anchor" at #']],
    [{ $dynamicRef: '#a' }, ['unsupported keyword "$dynamicRef" at #']],
    [{ exclusiveMinimum: true, minimum: 1 }, ['unsupported keyword "exclusiveMinimum" at #']],
    [{ properties: { 'a/b': { allOf: [{ contains: {} }] } } }, ['unsupported keyword "contains" at #/properties/a~1b/allOf/0']],
    [{ $defs: { x: { if: {} } } }, ['unsupported keyword "if" at #/$defs/x']],
    [{ $ref: 'http://example.com/s.json' }, ['$ref "http://example.com/s.json" is not local']],
    [{ $ref: 'other.json#/a' }, ['$ref "other.json#/a" is not local']],
  ];
  for (const [schema, messages] of cases) {
    assert.deepEqual(schemaSubsetIssues(schema).map((issue) => issue.message), messages, JSON.stringify(schema));
  }
  assert.equal(schemaSubsetIssues({ if: {} })[0].keyword, 'if');
  assert.equal(schemaSubsetIssues({ properties: { x: { if: {} } } })[0].at, '#/properties/x');
});

test('annotations are ignored and format adds a counted note', (t) => {
  const schema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'https://example.com/s', $comment: 'c',
    title: 't', description: 'd', default: 1, examples: [1], deprecated: false, readOnly: true, writeOnly: false,
    type: 'object',
    properties: { a: { type: 'string', format: 'date' }, b: { type: 'string', format: 'email' } },
  };
  assert.deepEqual(schemaSubsetIssues(schema), []);
  ok({ a: 'not a date', b: 'nope' }, schema);
  const dir = tempDir(t);
  write(dir, 's.json', schema);
  write(dir, 'd.json', { a: 'x' });
  assert.deepEqual(checkSchemaFiles({ cwd: dir, file: 'd.json', schema: 's.json' }).notes, ['format is not checked (2 places)']);
  write(dir, 'one.json', { format: 'uri' });
  assert.deepEqual(checkSchemaFiles({ cwd: dir, file: 'd.json', schema: 'one.json' }).notes, ['format is not checked (1 place)']);
});

test('__proto__, constructor and prototype are ordinary data keys', () => {
  const schema = {
    type: 'object', required: ['__proto__', 'constructor'],
    properties: { __proto__: { type: 'string' }, constructor: { type: 'integer' }, prototype: false },
  };
  // JSON.parse keeps "__proto__" as an own property; an object literal would not.
  const schemaParsed = JSON.parse(JSON.stringify(schema).replace('"required"', '"required"'));
  schemaParsed.properties = JSON.parse('{"__proto__":{"type":"string"},"constructor":{"type":"integer"},"prototype":false}');
  ok(JSON.parse('{"__proto__":"x","constructor":1}'), schemaParsed);
  bad(JSON.parse('{"constructor":1}'), schemaParsed, ['$ is missing required property "__proto__"']);
  bad(JSON.parse('{"__proto__":1,"constructor":1}'), schemaParsed, ['$.__proto__ must be string (got integer)']);
  bad(JSON.parse('{"__proto__":"x","constructor":1,"prototype":1}'), schemaParsed, ['$.prototype is not allowed']);
  bad({}, { required: ['constructor'] }, ['$ is missing required property "constructor"']);
  bad(JSON.parse('{"__proto__":1}'), { additionalProperties: false }, ['$.__proto__ is not allowed']);
  ok({}, { properties: { constructor: { type: 'string' } } });
});

test('file errors: size caps, invalid JSON, missing files, directories', (t) => {
  const dir = tempDir(t);
  write(dir, 's.json', { type: 'object' });
  write(dir, 'good.json', {});

  const big = join(dir, 'big.json');
  const fd = openSync(big, 'w');
  ftruncateSync(fd, SCHEMA_MAX_DATA_BYTES + 1);
  closeSync(fd);
  assert.deepEqual(pick(checkSchemaFiles({ cwd: dir, file: 'big.json', schema: 's.json' })),
    { exit: 2, fault: 'check', why: 'file too large: 32.0 MiB (limit 32 MiB)' });

  write(dir, 'bigschema.json', `{"description":"${'x'.repeat(SCHEMA_MAX_SCHEMA_BYTES)}"}`);
  assert.deepEqual(pick(checkSchemaFiles({ cwd: dir, file: 'good.json', schema: 'bigschema.json' })),
    { exit: 2, fault: 'check', why: 'schema too large: 1.0 MiB (limit 1 MiB)' });

  write(dir, 'broken.json', '{"a":');
  const notJson = checkSchemaFiles({ cwd: dir, file: 'broken.json', schema: 's.json' });
  assert.equal(notJson.exit, 2);
  assert.equal(notJson.fault, 'data');
  assert.match(notJson.why, /^not JSON: /);

  write(dir, 'badschema.json', '{nope');
  const badSchema = checkSchemaFiles({ cwd: dir, file: 'good.json', schema: 'badschema.json' });
  assert.equal(badSchema.fault, 'check');
  assert.match(badSchema.why, /^schema is not JSON: /);

  assert.deepEqual(pick(checkSchemaFiles({ cwd: dir, file: 'out/x.json', schema: 's.json' })),
    { exit: 2, fault: 'data', why: 'file missing: out/x.json' });
  assert.deepEqual(pick(checkSchemaFiles({ cwd: dir, file: 'good.json', schema: 'nope.json' })),
    { exit: 2, fault: 'check', why: 'schema missing: nope.json' });
  write(dir, 'if.json', { properties: { x: { if: {} } } });
  assert.deepEqual(pick(checkSchemaFiles({ cwd: dir, file: 'good.json', schema: 'if.json' })),
    { exit: 2, fault: 'check', why: 'unsupported keyword "if" at #/properties/x' });
  write(dir, 'remote.json', { $ref: 'http://example.com/x' });
  assert.deepEqual(pick(checkSchemaFiles({ cwd: dir, file: 'good.json', schema: 'remote.json' })),
    { exit: 2, fault: 'check', why: '$ref "http://example.com/x" is not local' });
  assert.deepEqual(pick(checkSchemaFiles({ cwd: dir, file: 'good.json', schema: 's.json' })), { exit: 0, fault: null, why: null });
  // Absolute paths stay absolute.
  assert.equal(checkSchemaFiles({ cwd: '/', file: join(dir, 'good.json'), schema: join(dir, 's.json') }).exit, 0);
});

function pick(result) {
  return { exit: result.exit, fault: result.fault, why: result.why };
}

test('JSONL: blank lines skipped, line-prefixed errors, format overrides the extension', (t) => {
  const dir = tempDir(t);
  write(dir, 's.json', { type: 'object', required: ['id'] });
  write(dir, 'rows.jsonl', '{"id":1}\n\n{"x":2}\n   \n{"id":3}\n');
  const rows = checkSchemaFiles({ cwd: dir, file: 'rows.jsonl', schema: 's.json' });
  assert.deepEqual([rows.exit, rows.errors, rows.why], [1, ['line 3: $ is missing required property "id"'], 'not valid: 1 error']);
  write(dir, 'rows.ndjson', '{"id":1}\n{"id":2}\n');
  assert.equal(checkSchemaFiles({ cwd: dir, file: 'rows.ndjson', schema: 's.json' }).exit, 0);
  write(dir, 'bad.jsonl', '{"id":1}\n{"id":\n');
  assert.deepEqual([checkSchemaFiles({ cwd: dir, file: 'bad.jsonl', schema: 's.json' }).fault], ['data']);
  assert.match(checkSchemaFiles({ cwd: dir, file: 'bad.jsonl', schema: 's.json' }).why, /^line 2: not JSON: /);

  write(dir, 'lines.json', '{"id":1}\n{"id":2}\n');
  assert.equal(checkSchemaFiles({ cwd: dir, file: 'lines.json', schema: 's.json' }).fault, 'data');
  assert.equal(checkSchemaFiles({ cwd: dir, file: 'lines.json', schema: 's.json', format: 'jsonl' }).exit, 0);
  write(dir, 'one.jsonl', '{\n"id": 1\n}\n');
  assert.equal(checkSchemaFiles({ cwd: dir, file: 'one.jsonl', schema: 's.json' }).fault, 'data');
  assert.equal(checkSchemaFiles({ cwd: dir, file: 'one.jsonl', schema: 's.json', format: 'json' }).exit, 0);
});

test('--unfence unwraps exactly one fenced block', (t) => {
  assert.equal(unwrapOneFence('```json\n{"a":1}\n```\n'), '{"a":1}');
  assert.equal(unwrapOneFence('\n```\n{"a":1}\n```'), '{"a":1}');
  assert.equal(unwrapOneFence('Here it is:\n```json\n{"a":1}\n```'), null);
  assert.equal(unwrapOneFence('```json\n{"a":1}\n```\ndone'), null);
  assert.equal(unwrapOneFence('```\n{"a":1}\n```\n```\n{"b":2}\n```'), null);

  const dir = tempDir(t);
  write(dir, 's.json', { type: 'object', required: ['a'] });
  write(dir, 'tagged.md', '```json\n{"a":1}\n```\n');
  write(dir, 'plain.md', '```\n{"a":1}\n```');
  write(dir, 'around.md', 'Result:\n```json\n{"a":1}\n```\n');
  write(dir, 'two.md', '```\n{"a":1}\n```\n\n```\n{"a":2}\n```\n');
  for (const name of ['tagged.md', 'plain.md']) {
    const result = checkSchemaFiles({ cwd: dir, file: name, schema: 's.json', unfence: true });
    assert.deepEqual([result.exit, result.notes], [0, ['unwrapped one fenced code block']], name);
  }
  for (const name of ['around.md', 'two.md']) {
    const result = checkSchemaFiles({ cwd: dir, file: name, schema: 's.json', unfence: true });
    assert.equal(result.exit, 2, name);
    assert.equal(result.fault, 'data');
    assert.match(result.why, /^not JSON: /);
  }
  assert.equal(checkSchemaFiles({ cwd: dir, file: 'tagged.md', schema: 's.json' }).fault, 'data');
});

test('more than 100 errors reads 100+', (t) => {
  const dir = tempDir(t);
  write(dir, 's.json', { items: { type: 'string' } });
  write(dir, 'd.json', Array.from({ length: 150 }, (_, i) => i));
  const result = checkSchemaFiles({ cwd: dir, file: 'd.json', schema: 's.json' });
  assert.deepEqual([result.exit, result.errorCount, result.errors.length, result.why], [1, 100, 100, 'not valid: 100+ errors']);
  write(dir, 'exact.json', Array.from({ length: 100 }, (_, i) => i));
  assert.equal(checkSchemaFiles({ cwd: dir, file: 'exact.json', schema: 's.json' }).why, 'not valid: 100 errors');
  write(dir, 'rows.jsonl', Array.from({ length: 150 }, (_, i) => String(i)).join('\n'));
  write(dir, 'row.json', { type: 'string' });
  const rows = checkSchemaFiles({ cwd: dir, file: 'rows.jsonl', schema: 'row.json' });
  assert.deepEqual([rows.errorCount, rows.why], [100, 'not valid: 100+ errors']);
  assert.equal(rows.errors[0], 'line 1: $ must be string (got integer)');
});

function cli(cwd, args) {
  const run = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

test('bin/check-schema.js: exit codes, human output and --json output', (t) => {
  const dir = tempDir(t);
  write(dir, 'schemas/event.json', {
    type: 'object',
    properties: {
      events: {
        type: 'array',
        items: { type: 'object', required: ['title'], properties: { date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', format: 'date' } } },
      },
    },
  });
  write(dir, 'out/events.json', { events: [{ title: 'a', date: '2026-01-01' }, { title: 'b', date: 'soon' }, { date: '2026-01-02' }] });
  write(dir, 'out/good.json', { events: [{ title: 'a' }] });

  const invalid = cli(dir, ['out/events.json', 'schemas/event.json']);
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, [
    'out/events.json does not match schemas/event.json: 2 errors',
    '  $.events[1].date must match pattern ^\\d{4}-\\d{2}-\\d{2}$',
    '  $.events[2] is missing required property "title"',
    'note: format is not checked (1 place)',
    '',
  ].join('\n'));

  const valid = cli(dir, ['out/good.json', 'schemas/event.json']);
  assert.equal(valid.status, 0);
  assert.equal(valid.stdout, 'out/good.json matches schemas/event.json\nnote: format is not checked (1 place)\n');

  const json = cli(dir, ['--json', 'out/events.json', 'schemas/event.json']);
  assert.equal(json.status, 1);
  assert.equal(json.stdout, `${JSON.stringify({
    ok: false, exit: 1, errorCount: 2,
    errors: ['$.events[1].date must match pattern ^\\d{4}-\\d{2}-\\d{2}$', '$.events[2] is missing required property "title"'],
    notes: ['format is not checked (1 place)'], why: 'not valid: 2 errors', fault: null,
  })}\n`);

  const okJson = cli(dir, ['out/good.json', 'schemas/event.json', '--json']);
  assert.equal(okJson.status, 0);
  assert.deepEqual(JSON.parse(okJson.stdout), { ok: true, exit: 0, errorCount: 0, errors: [], notes: ['format is not checked (1 place)'], why: null, fault: null });

  const missing = cli(dir, ['out/none.json', 'schemas/event.json', '--json']);
  assert.equal(missing.status, 2);
  assert.deepEqual(JSON.parse(missing.stdout), { ok: false, exit: 2, errorCount: 0, errors: [], notes: [], why: 'file missing: out/none.json', fault: 'data' });

  const noSchema = cli(dir, ['out/good.json', 's.json', '--json']);
  assert.equal(noSchema.status, 2);
  assert.equal(JSON.parse(noSchema.stdout).fault, 'check');
  const noSchemaHuman = cli(dir, ['out/good.json', 's.json']);
  assert.equal(noSchemaHuman.status, 2);
  assert.equal(noSchemaHuman.stderr, 'cannot check out/good.json against s.json: schema missing: s.json\n');

  write(dir, 'rows.json', '{"title":"a"}\n{"title":"b"}\n');
  assert.equal(cli(dir, ['rows.json', 'schemas/event.json', '--format', 'jsonl']).status, 0);
  write(dir, 'fenced.md', '```json\n{"events":[]}\n```\n');
  const fenced = cli(dir, ['fenced.md', 'schemas/event.json', '--unfence', '--json']);
  assert.equal(fenced.status, 0);
  assert.deepEqual(JSON.parse(fenced.stdout).notes, ['unwrapped one fenced code block', 'format is not checked (1 place)']);

  const usage = 'usage: check-schema <file> <schema> [--json] [--format json|jsonl] [--unfence]';
  for (const args of [[], ['one.json'], ['a', 'b', 'c'], ['a', 'b', '--format', 'yaml'], ['a', 'b', '--bogus']]) {
    const result = cli(dir, args);
    assert.equal(result.status, 2, args.join(' '));
    assert.equal(result.stderr, `${usage}\n`);
  }
  const usageJson = cli(dir, ['--json', 'a']);
  assert.equal(usageJson.status, 2);
  assert.deepEqual(JSON.parse(usageJson.stdout), { ok: false, exit: 2, errorCount: 0, errors: [], notes: [], why: usage, fault: 'check' });
});
