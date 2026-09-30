// A new run's goal document from the goal text and the CLI flags: its
// requirement, constraints, settings and the worker routing.

import { resolve } from 'node:path';
import { REASONING_LEVELS, isReasoningLevel } from '../lib/reasoning.js';
import { implicitV3Requirements } from './program-v3.js';
import { createV2GoalDocument } from './v2-state.js';

function goalSettings(opts) {
  const mappings = {
    'max-agents': 'maxAgents',
    'max-expansion-rounds': 'maxExpansionRounds',
    'max-actions': 'maxActions',
    concurrency: 'concurrency',
    'retry-attempts': 'maxMechanicalRetries',
  };
  const settings = Object.fromEntries(Object.entries(mappings)
    .filter(([flag]) => opts[flag] != null)
    .map(([flag, setting]) => {
      const value = Number(opts[flag]);
      // Stage 3 (D2): one automatic retry per step by default, at most 3.
      if (flag === 'retry-attempts') {
        if (!Number.isInteger(value) || value < 0 || value > 3) throw new Error('--retry-attempts must be 0, 1, 2 or 3');
      } else if (!Number.isInteger(value) || value < 1) throw new Error(`--${flag} must be a positive integer`);
      return [setting, value];
    }));
  return settings;
}

export function extractV2GoalConstraints(goal) {
  const source = String(goal ?? '');
  const explicitReadOnly = /^\s*read[- ]only(?:\s|:|$)/i.test(source)
    || /\b(?:do not|must not|never)\s+(?:modify|edit|write(?:\s+to)?|change)\s+(?:any\s+)?(?:repository|repo|workspace)\s+files?\b/i.test(source);
  return explicitReadOnly ? { workspaceMutation: 'forbidden' } : null;
}

function v2Routing({ pool = null, model = null, strict = false, reasoning = null } = {}) {
  const routing = {};
  if (pool) routing[strict ? 'pool' : 'preferredPool'] = pool;
  if (model) routing.preferredModel = model;
  if (strict && pool) routing.strictPool = pool;
  // Run-wide reasoning depth. It outranks the configured strategy and the
  // connector default, and a per-action `reasoning` field outranks it.
  if (reasoning) routing.reasoning = reasoning;
  return Object.keys(routing).length ? routing : null;
}

// A run-wide reasoning flag is a usage error when it is not on the common
// scale: silently ignoring a typo would let a controlled provider QA run think
// at a level the caller did not ask for.
function reasoningFlag(opts, flag) {
  const value = opts[flag];
  if (value === undefined) return null;
  if (typeof value !== 'string' || !isReasoningLevel(value)) {
    throw new Error(`--${flag} must be ${[...REASONING_LEVELS, 'default'].join('|')}`);
  }
  return value;
}

// Build a fresh goal document for a v3 program from CLI options. Shared by
// `workflow goal` and `workflow plan contract`/`validate`, so a preview checks
// the program against exactly the document the launched run will store.
export function buildNewGoalDocument(goal, opts) {
  const workerPool = opts['worker-pool'] && opts['worker-pool'] !== 'auto' ? opts['worker-pool'] : null;
  const workerModel = opts['worker-model'] && opts['worker-model'] !== 'auto' ? opts['worker-model'] : null;
  const workerReasoning = reasoningFlag(opts, 'worker-reasoning');
  if (opts.isolation !== undefined && typeof opts.isolation !== 'boolean') throw new Error('--isolation is a boolean flag');
  return createV2GoalDocument({
    goal, cwd: resolve(opts.cwd ?? process.cwd()), requirements: implicitV3Requirements(goal),
    constraints: extractV2GoalConstraints(goal),
    settings: {
      ...goalSettings(opts), scout: false,
      executionMode: 'program',
      workspaceMode: opts.isolation === true ? 'isolated' : 'shared',
      plannerMode: 'caller',
    },
    plannerRouting: null,
    workerRouting: v2Routing({ pool: workerPool, model: workerModel, strict: Boolean(workerPool), reasoning: workerReasoning }),
  });
}
