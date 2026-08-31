#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { validateV2PlannerResponse } from '../src/workflow/v2-planner.js';
import { deserializeV2DurableState } from '../src/workflow/v2-state.js';

function parseArgs(args) {
  if (args.length !== 6 || args[0] !== '--state' || args[2] !== '--boundary' || args[4] !== '--value') return null;
  const [, statePath, , boundary, , valuePath] = args;
  if (!statePath || !valuePath || !['initial', 'gaps'].includes(boundary)) return null;
  if (statePath.startsWith('--') || valuePath.startsWith('--')) return null;
  return { statePath, boundary, valuePath };
}

const parsed = parseArgs(process.argv.slice(2));
if (!parsed) {
  console.error('Usage: check-v2-plan --state <state.json> --boundary <initial|gaps> --value <candidate.json>');
  process.exit(2);
}

try {
  const state = deserializeV2DurableState(readFileSync(parsed.statePath, 'utf8'));
  const value = JSON.parse(readFileSync(parsed.valuePath, 'utf8'));
  validateV2PlannerResponse(value, state, { boundary: parsed.boundary });
  process.stdout.write(`${JSON.stringify({ ok: true, errors: [] })}\n`);
  process.exit(0);
} catch (error) {
  const errors = Array.isArray(error?.issues) ? error.issues : [error.message];
  process.stdout.write(`${JSON.stringify({ ok: false, errors })}\n`);
  process.exit(1);
}
