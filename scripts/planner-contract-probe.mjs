#!/usr/bin/env node

// Live, worker-free contract probe for the autonomous workflow planner.
// This intentionally exercises only model planning plus Bullswarm's real
// decision parser/normalizer/validator. It never dispatches workflow actions.

import { spawnSync } from 'node:child_process';
import { AUTONOMOUS_ORCHESTRATOR_PROMPT } from '../src/workflow/goal.js';
import {
  parseDecisionText,
  normalizeDecisionProposal,
  validateDecisionProposal,
} from '../src/workflow/decision.js';

const scenarios = {
  'parallel-implementation': {
    goal: 'Implement two file-disjoint modules and then integrate them through one small shared index. Verify focused behavior and the full suite with minimal duplicate work.',
    requirements: [
      { id: 'R1', text: 'Implement parser.js and persistence.js as independent units.' },
      { id: 'R2', text: 'Export both through index.js and pass focused plus full-suite tests.' },
    ],
    scout: [
      'TREE: src/parser.js, src/persistence.js, src/index.js; tests/parser.test.js, tests/persistence.test.js, tests/index.test.js.',
      'TEST STATUS: npm test passes 120/120.',
      'UNITS OF WORK: parser owns src/parser.js and tests/parser.test.js; persistence owns src/persistence.js and tests/persistence.test.js.',
      'SHARED FILES: src/index.js must be edited after both independent modules.',
      'RISKS: one final npm test is sufficient after shared integration.',
      '["parser","persistence","shared-index"]',
    ].join('\n'),
    assert(proposal) {
      if (proposal.decision !== 'needs_more_work') throw new Error(`expected needs_more_work, got ${proposal.decision}`);
      if (proposal.actions.length > 6) throw new Error(`expected at most 6 actions, got ${proposal.actions.length}`);
      const ids = proposal.actions.map((action) => action.id);
      const finalVerifies = proposal.actions.filter((action) => action.type === 'verify' && action.covers?.includes('R2'));
      if (!finalVerifies.length) throw new Error('missing final verification covering R2');
      if (!proposal.completion || proposal.completion.when !== 'all-actions-ok') throw new Error('missing all-actions-ok completion');
      return ids;
    },
  },
  'consolidated-audit': {
    goal: 'Read the CLI architecture and produce one concise, complete evidence report, then independently verify it. Do not modify repository files.',
    requirements: [{ id: 'R1', text: 'Produce and independently verify one complete read-only architecture report.' }],
    scout: [
      'TREE: src/cli.js and src/workflow/*.js; tests/help.test.js.',
      'TEST STATUS: npm test passes 120/120.',
      'UNITS OF WORK: one consolidated architecture report owns no repository files.',
      'SHARED FILES: none.',
      'RISKS: splitting evidence across workers would require lossy consolidation.',
      '["architecture-report"]',
    ].join('\n'),
    assert(proposal) {
      if (proposal.decision !== 'needs_more_work') throw new Error(`expected needs_more_work, got ${proposal.decision}`);
      if (proposal.actions.length !== 2) throw new Error(`expected report plus verify only, got ${proposal.actions.length} actions`);
      if (proposal.actions.filter((action) => action.type === 'run').length !== 1) throw new Error('expected exactly one report worker');
      if (proposal.actions.filter((action) => action.type === 'verify').length !== 1) throw new Error('expected exactly one verifier');
      if (!proposal.completion || proposal.completion.when !== 'all-actions-ok') throw new Error('missing all-actions-ok completion');
      return proposal.actions.map((action) => action.id);
    },
  },
  'terminal-completion': {
    goal: 'Produce and independently verify one complete read-only architecture report.',
    requirements: [{ id: 'R1', text: 'Produce and independently verify one complete read-only architecture report.' }],
    scout: 'The repository report surface and test commands were identified.',
    completedActions: [
      { id: 'architecture-report', type: 'run', phase: 'audit', status: 'succeeded', completionEligible: true },
      { id: 'verify-architecture-report', type: 'verify', phase: 'verify', status: 'succeeded', covers: ['R1'], verification: { ok: true, concerns: [], summary: 'Report matches source and tests.' } },
    ],
    closedPhases: ['audit', 'verify'],
    completedRequirementIds: ['R1'],
    assert(proposal) {
      if (proposal.decision !== 'complete') throw new Error(`expected complete, got ${proposal.decision}`);
      if (proposal.actions.length !== 0) throw new Error(`expected no actions, got ${proposal.actions.length}`);
      return [];
    },
  },
};

const name = process.argv[2] ?? 'parallel-implementation';
const scenario = scenarios[name];
if (!scenario) {
  console.error(`unknown scenario ${name}; choose ${Object.keys(scenarios).join(', ')}`);
  process.exit(2);
}

const model = process.env.BULLSWARM_PLANNER_PROBE_MODEL ?? 'relay/gpt-5.6-luna';
const completedActions = scenario.completedActions ?? [];
const context = {
  intent: scenario.goal,
  intentRequirements: scenario.requirements,
  completedRequirementIds: scenario.completedRequirementIds ?? [],
  suggestedPlan: null,
  completedActions,
  failedActions: [],
  outputs: Object.fromEntries(completedActions.map((action) => [action.id, {
    ok: true,
    verification: action.verification ?? null,
  }])),
  closedPhases: scenario.closedPhases ?? [],
  scout: { ok: true, output: scenario.scout },
  budget: { maxAgents: 12, remainingDispatches: 10, maxDurationMs: 1800000, remainingMs: 1500000 },
  completionPolicy: { requireSuccessfulRun: true, requireIndependentVerification: true },
  availablePools: [{ name: 'opencode2', lanes: ['analyze', 'build', 'chore'], capabilities: ['workflow-planning', 'strong-analysis'] }],
};

const prompt = [
  AUTONOMOUS_ORCHESTRATOR_PROMPT,
  '',
  '---- BEGIN DURABLE WORKFLOW CONTEXT ----',
  JSON.stringify(context, null, 2),
  '---- END DURABLE WORKFLOW CONTEXT ----',
  '',
  'FINAL CONTROL RESPONSE (mandatory): return exactly one JSON object and no prose or markdown.',
  'It must contain schemaVersion "bullswarm.workflow.decision.v1", decision, reason, and actions.',
  'decision MUST be one of: needs_more_work, retry, escalate, complete, wait_for_approval, stop. Use needs_more_work for a new executable program with actions.',
  'When the evidence is sufficient, return {"schemaVersion":"bullswarm.workflow.decision.v1","decision":"complete","reason":"<evidence-backed reason>","actions":[]}.',
].join('\n');

const child = spawnSync('opencode', ['run', '--auto', '--pure', '--model', model, '--format', 'json', prompt], {
  cwd: process.cwd(),
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
});
if (child.error) throw child.error;
if (child.status !== 0) {
  process.stderr.write(child.stderr);
  process.exit(child.status ?? 1);
}

const text = child.stdout.split(/\r?\n/).filter(Boolean).flatMap((line) => {
  try {
    const event = JSON.parse(line);
    return event.type === 'text' && typeof event.part?.text === 'string' ? [event.part.text] : [];
  } catch {
    return [];
  }
}).join('');
let raw;
try {
  raw = parseDecisionText(text);
} catch (error) {
  console.error(JSON.stringify({ responseChars: text.length, responseTail: text.slice(-800) }, null, 2));
  throw error;
}
const proposal = normalizeDecisionProposal(raw);
validateDecisionProposal(proposal, {
  knownActionIds: completedActions.map((action) => action.id),
  requiredRequirementIds: scenario.requirements.map((requirement) => requirement.id),
  completedRequirementIds: scenario.completedRequirementIds ?? [],
  closedPhases: scenario.closedPhases ?? [],
  currentActionCount: completedActions.length,
  maxActions: 20,
  maxItemsPerExpansion: 12,
});
let actionIds;
try {
  actionIds = scenario.assert(proposal);
} catch (error) {
  console.error(JSON.stringify({
    scenario: name,
    rawDecision: raw.decision,
    normalizedDecision: proposal.decision,
    actions: proposal.actions.map(({ id, type, phase, dependsOn, covers }) => ({ id, type, phase, dependsOn, covers })),
    completion: proposal.completion ?? null,
  }, null, 2));
  throw error;
}
console.log(JSON.stringify({
  scenario: name,
  model,
  rawDecision: raw.decision,
  normalizedDecision: proposal.decision,
  actionCount: proposal.actions.length,
  actionIds,
  completion: proposal.completion?.when ?? null,
}, null, 2));
