import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidOutputSchema, validateAgainstSchema } from '../src/workflow/schema.js';

test('validateAgainstSchema accepts every supported keyword in a nested schema', () => {
  const schema = {
    type: 'object',
    description: 'A report',
    properties: {
      title: {
        type: 'string',
        minLength: 3,
        pattern: '^Report',
      },
      score: {
        type: 'number',
        minimum: 0,
        maximum: 100,
      },
      count: { type: 'integer' },
      enabled: { type: 'boolean' },
      missing: { type: 'null' },
      state: { enum: ['ready', 'done'] },
      files_written: {
        type: 'array',
        minItems: 1,
        maxItems: 2,
        items: { type: ['string', 'null'] },
      },
      metadata: {
        type: 'object',
        properties: { source: { type: 'string' } },
        required: ['source'],
        additionalProperties: false,
      },
    },
    required: ['title', 'score', 'count', 'enabled', 'missing', 'state', 'files_written', 'metadata'],
    additionalProperties: false,
  };
  const value = {
    title: 'Report 2026',
    score: 88.5,
    count: 3,
    enabled: true,
    missing: null,
    state: 'ready',
    files_written: ['report.md', null],
    metadata: { source: 'tests' },
  };

  assert.deepEqual(isValidOutputSchema(schema), { ok: true, issues: [] });
  assert.deepEqual(validateAgainstSchema(value, schema), { ok: true, errors: [] });
});

test('validateAgainstSchema accepts primitive, union, and array schemas', () => {
  assert.equal(validateAgainstSchema('hello', { type: 'string' }).ok, true);
  assert.equal(validateAgainstSchema(4.5, { type: 'number' }).ok, true);
  assert.equal(validateAgainstSchema(4, { type: 'integer' }).ok, true);
  assert.equal(validateAgainstSchema(false, { type: 'boolean' }).ok, true);
  assert.equal(validateAgainstSchema(null, { type: 'null' }).ok, true);
  assert.equal(validateAgainstSchema('text', { type: ['number', 'string'] }).ok, true);
  assert.equal(validateAgainstSchema([1, 2], { type: 'array', items: { type: 'integer' } }).ok, true);
});

test('validateAgainstSchema rejects a wrong primitive type', () => {
  const result = validateAgainstSchema(12, { type: 'string' });
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, ['value must be string']);
});

test('validateAgainstSchema rejects a missing required property', () => {
  const result = validateAgainstSchema({}, { type: 'object', required: ['name'] });
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, ['name is required']);
});

test('validateAgainstSchema rejects extra properties when additionalProperties is false', () => {
  const result = validateAgainstSchema(
    { name: 'Ada', extra: true },
    { type: 'object', properties: { name: { type: 'string' } }, additionalProperties: false },
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, ['extra is not allowed']);
});

test('validateAgainstSchema rejects minimum and maximum violations', () => {
  assert.deepEqual(
    validateAgainstSchema(-1, { type: 'number', minimum: 0 }),
    { ok: false, errors: ['value must be at least 0'] },
  );
  assert.deepEqual(
    validateAgainstSchema(11, { type: 'number', maximum: 10 }),
    { ok: false, errors: ['value must be at most 10'] },
  );
});

test('validateAgainstSchema rejects string minLength and pattern violations', () => {
  assert.deepEqual(
    validateAgainstSchema('x', { type: 'string', minLength: 2 }),
    { ok: false, errors: ['value must have at least 2 characters'] },
  );
  assert.deepEqual(
    validateAgainstSchema('abc', { type: 'string', pattern: '^Report' }),
    { ok: false, errors: ['value must match pattern "^Report"'] },
  );
});

test('validateAgainstSchema rejects an enum miss', () => {
  const result = validateAgainstSchema('pending', { enum: ['ready', 'done'] });
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, ['value must be one of ["ready","done"]']);
});

test('validateAgainstSchema rejects minItems and maxItems violations', () => {
  assert.deepEqual(
    validateAgainstSchema([], { type: 'array', minItems: 1 }),
    { ok: false, errors: ['value must contain at least 1 items'] },
  );
  assert.deepEqual(
    validateAgainstSchema([1, 2, 3], { type: 'array', maxItems: 2 }),
    { ok: false, errors: ['value must contain at most 2 items'] },
  );
});

test('validateAgainstSchema reports the exact path for a nested array element', () => {
  const result = validateAgainstSchema(
    { files_written: ['one', 'two', 3] },
    { type: 'object', properties: { files_written: { type: 'array', items: { type: 'string' } } } },
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, ['files_written[2] must be string']);
});

test('validateAgainstSchema reports the exact path for a nested object property', () => {
  const result = validateAgainstSchema(
    { metadata: { author: 42 } },
    { type: 'object', properties: { metadata: { type: 'object', properties: { author: { type: 'string' } } } } },
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, ['metadata.author must be string']);
});

test('isValidOutputSchema accepts a well-formed schema', () => {
  const result = isValidOutputSchema({
    type: 'object',
    properties: { files: { type: 'array', items: { type: 'string' }, minItems: 0 } },
    required: ['files'],
    additionalProperties: false,
    description: 'Output files',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);
});

test('isValidOutputSchema rejects unknown keywords at the root and nested levels', () => {
  const result = isValidOutputSchema({
    type: 'object',
    x_root: true,
    properties: {
      child: { type: 'string', x_property: 'bad' },
    },
    items: { type: 'string', x_item: 'bad' },
  });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.includes('x_root')));
  assert.ok(result.issues.some((issue) => issue.includes('x_property')));
  assert.ok(result.issues.some((issue) => issue.includes('x_item')));
});

test('validateAgainstSchema checks own properties only, never inherited names', () => {
  assert.deepEqual(validateAgainstSchema({}, { type: 'object', required: ['toString'] }),
    { ok: false, errors: ['toString is required'] });
  assert.deepEqual(validateAgainstSchema({ constructor: 1 }, { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false }),
    { ok: false, errors: ['constructor is not allowed'] });
  assert.deepEqual(validateAgainstSchema(JSON.parse('{"__proto__": 1}'), { type: 'object', properties: {}, additionalProperties: false }),
    { ok: false, errors: ['__proto__ is not allowed'] });
});

test('readTrailingObject returns the outermost trailing object, not a schema-matching nested one', async () => {
  const { WorkflowRuntime } = await import('../src/workflow/runtime.js');
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const rt = Object.create(WorkflowRuntime.prototype);
  const dir = mkdtempSync(join(tmpdir(), 'bs-trailing-'));
  const file = join(dir, 'out.md');
  const schema = { type: 'object', properties: { ok: { type: 'string' } } };
  writeFileSync(file, 'worker report\n{"wrapper":{"ok":"inner"}}\n');
  assert.deepEqual(rt.readTrailingObject(file, schema), { ok: true, data: { wrapper: { ok: 'inner' } } });
  // The outer object is what gets validated; a matching inner object does not rescue it.
  assert.deepEqual(rt.readTrailingObject(file, { type: 'object', required: ['ok'] }), { ok: false, errors: ['ok is required'] });
  // Prose braces before the object, escaped quotes and braces inside strings, adjacent objects.
  writeFileSync(file, 'see {not json} and {"a":1}{"text":"q \\" {x}","ok":"outer"}');
  assert.deepEqual(rt.readTrailingObject(file, schema), { ok: true, data: { text: 'q " {x}', ok: 'outer' } });
  writeFileSync(file, 'only prose');
  assert.equal(rt.readTrailingObject(file, schema).ok, false);
  writeFileSync(file, 'x {"a":1} trailing prose');
  assert.equal(rt.readTrailingObject(file, schema).ok, false);
});
