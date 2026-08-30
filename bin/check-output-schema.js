#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { isValidOutputSchema, validateAgainstSchema } from '../src/workflow/schema.js';

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const schemaPath = argValue('--schema');
const valuePath = argValue('--value');
if (!schemaPath || !valuePath) {
  console.error('Usage: check-output-schema --schema <schema.json> --value <candidate.json>');
  process.exit(2);
}

try {
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
  const value = JSON.parse(readFileSync(valuePath, 'utf8'));
  const schemaValidity = isValidOutputSchema(schema);
  const result = schemaValidity.ok
    ? validateAgainstSchema(value, schema)
    : { ok: false, errors: schemaValidity.issues };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.ok ? 0 : 1);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, errors: [error.message] })}\n`);
  process.exit(1);
}
