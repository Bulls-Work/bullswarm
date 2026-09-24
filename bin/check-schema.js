#!/usr/bin/env node
// check-schema <file> <schema> [--json] [--format json|jsonl] [--unfence]
// Exit 0 valid, 1 invalid, 2 cannot check (or a usage error). The evidence
// runner calls this by absolute path; it has no package.json bin entry.

import { checkSchemaFiles } from '../src/workflow/schema-check.js';

const USAGE = 'usage: check-schema <file> <schema> [--json] [--format json|jsonl] [--unfence]';
const PRINTED_ERRORS = 20;

function parseArgs(argv) {
  const positional = [];
  const options = { json: false, format: undefined, unfence: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--unfence') options.unfence = true;
    else if (arg === '--format') {
      const value = argv[index += 1];
      if (value !== 'json' && value !== 'jsonl') return null;
      options.format = value;
    } else if (arg.startsWith('--format=')) {
      const value = arg.slice('--format='.length);
      if (value !== 'json' && value !== 'jsonl') return null;
      options.format = value;
    } else if (arg.startsWith('-') && arg !== '-') return null;
    else positional.push(arg);
  }
  if (positional.length !== 2) return null;
  return { file: positional[0], schema: positional[1], ...options };
}

function main(argv) {
  const args = parseArgs(argv);
  if (!args) {
    if (argv.includes('--json')) {
      process.stdout.write(`${JSON.stringify({ ok: false, exit: 2, errorCount: 0, errors: [], notes: [], why: USAGE, fault: 'check' })}\n`);
    } else {
      process.stderr.write(`${USAGE}\n`);
    }
    return 2;
  }
  let result;
  try {
    result = checkSchemaFiles({ cwd: process.cwd(), file: args.file, schema: args.schema, format: args.format, unfence: args.unfence });
  } catch (error) {
    result = { exit: 2, errorCount: 0, errors: [], notes: [], why: `checker error: ${error.message}`, fault: 'check' };
  }
  if (args.json) {
    process.stdout.write(`${JSON.stringify({
      ok: result.exit === 0,
      exit: result.exit,
      errorCount: result.errorCount,
      errors: result.errors.slice(0, PRINTED_ERRORS),
      notes: result.notes,
      why: result.why,
      fault: result.exit === 2 ? result.fault : null,
    })}\n`);
    return result.exit;
  }
  const lines = [];
  if (result.exit === 0) lines.push(`${args.file} matches ${args.schema}`);
  else if (result.exit === 1) {
    const count = result.why.replace(/^not valid: /, '');
    lines.push(`${args.file} does not match ${args.schema}: ${count}`);
    for (const error of result.errors.slice(0, PRINTED_ERRORS)) lines.push(`  ${error}`);
    if (result.errors.length > PRINTED_ERRORS) lines.push(`  … and ${result.errors.length - PRINTED_ERRORS} more`);
  } else {
    lines.push(`cannot check ${args.file} against ${args.schema}: ${result.why}`);
  }
  for (const note of result.notes) lines.push(`note: ${note}`);
  (result.exit === 2 ? process.stderr : process.stdout).write(`${lines.join('\n')}\n`);
  return result.exit;
}

process.exitCode = main(process.argv.slice(2));
