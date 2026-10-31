// A step answer schema no worker can satisfy is refused at validation, with
// the JSON path and the reason, instead of failing after a paid worker run.
// Made-up names only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseProgramV3 } from '../src/workflow/program-v3.js';
import { oneStepV3 } from './fixtures/program-v3-fixtures.mjs';

function issuesOf(answer, index = 0) {
  const program = oneStepV3();
  if (index > 0) {
    program.steps = [
      ...Array.from({ length: index }, (_, n) => ({ id: `pad${n}`, prompt: 'Count the markdown files.' })),
      { ...program.steps[0], answer },
    ];
  } else program.steps[0].answer = answer;
  try { normaliseProgramV3(program); } catch (error) { return error.issues ?? [error.message]; }
  return [];
}

const wrapProps = (schema) => ({ type: 'object', properties: { ok: schema } });
const wrapItems = (schema) => ({ type: 'array', items: schema });

// [name, bad schema, keyword path suffix, reason pattern]
const BAD = [
  ['empty enum', { enum: [] }, 'enum', /enum/],
  ['minLength above maxLength', { type: 'string', minLength: 5, maxLength: 2 }, 'minLength', /minLength.*maxLength/],
  ['minimum above maximum', { type: 'number', minimum: 5, maximum: 2 }, 'minimum', /minimum.*maximum/],
  ['exclusiveMinimum at exclusiveMaximum', { type: 'number', exclusiveMinimum: 2, exclusiveMaximum: 2 }, 'exclusiveMinimum', /exclusiveMinimum.*exclusiveMaximum/],
  ['minimum at exclusiveMaximum', { type: 'number', minimum: 2, exclusiveMaximum: 2 }, 'minimum', /minimum.*exclusiveMaximum/],
  ['exclusiveMinimum at maximum', { type: 'number', exclusiveMinimum: 2, maximum: 2 }, 'exclusiveMinimum', /exclusiveMinimum.*maximum/],
  ['minItems above maxItems', { type: 'array', minItems: 3, maxItems: 1 }, 'minItems', /minItems.*maxItems/],
  ['minProperties above maxProperties', { type: 'object', minProperties: 3, maxProperties: 1 }, 'minProperties', /minProperties.*maxProperties/],
  ['required missing from closed properties', { type: 'object', required: ['gone'], properties: { here: { type: 'string' } }, additionalProperties: false }, 'required', /"gone".*properties/],
  ['const outside enum', { enum: ['a', 'b'], const: 'c' }, 'const', /const.*enum/],
  ['const outside type', { type: 'string', const: 7 }, 'const', /const.*type/],
];

test('the unsatisfiable shapes are refused at the top, naming the path and why', () => {
  for (const [name, schema, suffix, reason] of BAD) {
    const issues = issuesOf(schema, 2);
    const hit = issues.find((issue) => issue.includes(`steps[2].answer.${suffix}`));
    assert.ok(hit, `${name}: no issue at steps[2].answer.${suffix} in ${JSON.stringify(issues)}`);
    assert.match(hit, reason, name);
  }
});

test('the same shapes are refused nested in properties and in items', () => {
  for (const [name, schema, suffix, reason] of BAD) {
    const inProps = issuesOf(wrapProps(schema), 2).find((issue) => issue.includes(`steps[2].answer.properties.ok.${suffix}`));
    assert.ok(inProps, `${name} in properties`);
    assert.match(inProps, reason, name);
    const inItems = issuesOf(wrapItems(schema), 2).find((issue) => issue.includes(`steps[2].answer.items.${suffix}`));
    assert.ok(inItems, `${name} in items`);
    assert.match(inItems, reason, name);
  }
});

test('satisfiable look-alikes stay valid', () => {
  const GOOD = [
    { type: 'string', minLength: 3, maxLength: 3 },
    { type: 'number', minimum: 2, maximum: 2 },
    { type: 'number', exclusiveMinimum: 1, exclusiveMaximum: 3 },
    { type: 'number', minimum: 2, exclusiveMaximum: 3 },
    { type: 'array', minItems: 1, maxItems: 1 },
    { type: 'object', minProperties: 1, maxProperties: 1 },
    { enum: ['only'] },
    { enum: ['a', 'b'], const: 'a' },
    { type: ['string', 'null'], const: null },
    { type: 'number', const: 3 },
    { type: 'object', required: ['here'], properties: { here: { type: 'string' } }, additionalProperties: false },
    { type: 'object', required: ['open'], properties: { here: { type: 'string' } } },
    { type: 'object', required: ['open'], properties: { here: { type: 'string' } }, additionalProperties: { type: 'string' } },
  ];
  for (const schema of GOOD) {
    assert.deepEqual(issuesOf(schema), [], JSON.stringify(schema));
    assert.deepEqual(issuesOf(wrapProps(schema)), [], `props ${JSON.stringify(schema)}`);
    assert.deepEqual(issuesOf(wrapItems(schema)), [], `items ${JSON.stringify(schema)}`);
  }
});
