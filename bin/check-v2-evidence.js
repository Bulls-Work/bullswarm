#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { validateEvidenceOutput } from '../src/workflow/evidence-output.js';

function parseArgs(args) {
  if (args.length !== 4 || args[0] !== '--contract' || args[2] !== '--value' || !args[1] || !args[3] || args[1].startsWith('--') || args[3].startsWith('--')) return null;
  return { contractPath: args[1], valuePath: args[3] };
}

const parsed = parseArgs(process.argv.slice(2));
if (!parsed) {
  console.error('Usage: check-v2-evidence --contract <contract.json> --value <candidate.json>');
  process.exit(2);
}

try {
  const contract = JSON.parse(readFileSync(parsed.contractPath, 'utf8'));
  const value = JSON.parse(readFileSync(parsed.valuePath, 'utf8'));
  const result = validateEvidenceOutput(value, contract);
  process.stdout.write(`${JSON.stringify({ ok: result.ok, errors: result.errors })}\n`);
  process.exit(result.ok ? 0 : 1);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, errors: [error.message] })}\n`);
  process.exit(1);
}
