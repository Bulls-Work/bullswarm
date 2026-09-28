// The planning contract for a v3 program (0.37.0): what `workflow plan
// contract` prints by default. A caller reads it once and writes a program of
// steps, gates and loops; `workflow plan validate` checks the file against
// the same rules (program-v3.js) and `workflow goal --program` launches it.
// `plan contract --v2` still prints the old contract (v2-planner.js) for old
// programs.

import { ANSWER_MAX_BYTES } from './answers.js';
import { DEFAULT_EFFORT_BY_LANE, TIME_BOX_MAX_MINUTES } from './action-validator.js';
import {
  CHECKER_PATH, EVIDENCE_DEFAULT_TIMEOUT_SEC, EVIDENCE_ENV_KEYS, EVIDENCE_MAX_ITEMS, EVIDENCE_MAX_TIMEOUT_SEC,
} from './evidence-runner.js';
import { LOOP_MAX_ROUNDS, PROGRAM_V3_SCHEMA_VERSION } from './program-v3.js';
import { SCHEMA_ASSERTED_KEYWORDS, SCHEMA_IGNORED_KEYWORDS } from './schema-check.js';
import { REASONING_LEVELS } from '../lib/reasoning.js';

export const V3_CONTRACT_SCHEMA_VERSION = 'bullswarm.workflow.contract.v3';

const lanes = Object.entries(DEFAULT_EFFORT_BY_LANE).map(([lane, effort]) => `${lane} ${effort}`).join(', ');

const STEP_FIELDS = Object.freeze({
  id: 'required: a unique kebab-case id; steps, gates and loops share one id space',
  prompt: 'required: self-contained worker instructions; nothing is substituted, so name the absolute workspace path, the outcome, the files and the checks to run',
  dependsOn: 'optional step, gate or loop ids that must finish first (default []); a dependency on a gate waits until you continue it, on a loop until the loop ends',
  phase: 'optional one-line label that groups steps (the dashboard groups by it); it changes nothing else',
  label: 'optional one-line display name (default: the id)',
  lane: 'optional analyze | build | chore (default defaults.lane, else analyze): analyze reads, build and chore change files',
  effort: `optional high | medium | low (default defaults.effort, else by lane: ${lanes}); a chore step is mechanical work and must be low`,
  reasoning: `optional ${[...REASONING_LEVELS, 'default'].join(' | ')}: how hard the picked model thinks on this step; default passes nothing and lets the worker CLI decide`,
  route: 'optional {pools?: {use?, avoid?}, providers?: {use?, avoid?}, independentOf?: [step ids]}: a hard filter applied before quota pacing; independentOf names steps this step depends on (directly or through others) whose providers it must not use',
  answer: `optional JSON schema: the worker writes its final answer as JSON to a file Bullswarm names, at most ${ANSWER_MAX_BYTES / 1024} KiB; a mismatch is failure kind schema; the checked answer goes to dependent steps, to workflow wait, and to conditions`,
  evidence: `optional up to ${EVIDENCE_MAX_ITEMS} checks Bullswarm runs after the worker: {type:"command", cmd, timeoutSec?} (exit 0 passes) or {type:"schema", file ("$output" = the final response), schema, format?, timeoutSec?}; timeoutSec 1-${EVIDENCE_MAX_TIMEOUT_SEC}, default ${EVIDENCE_DEFAULT_TIMEOUT_SEC}`,
  deliverable: 'optional files | report | data | media | outward, or {type, paths}: what the step must leave behind (default files for build and chore, report for analyze without an answer, none for analyze with an answer); not produced is failure kind not-produced; outward (sending, publishing) is for analyze steps and is never retried once its worker started',
  files: 'optional exact relative paths the step may change (no directories or globs); steps whose files overlap run one after the other',
  retry: 'optional 0 or 1 (default defaults.retry, else 1): the one automatic retry after a failure; 0 for a step that must not repeat',
  timeBox: `optional whole minutes 0-${TIME_BOX_MAX_MINUTES}: the soft time box written into the task (0 leaves it out); a guide, never a timeout`,
});

const GATE_FIELDS = Object.freeze({
  id: 'required: a kebab-case id; steps behind the gate list it in dependsOn',
  dependsOn: 'the step, gate or loop ids the gate follows',
  when: 'optional condition: the gate waits for you only when it holds; when it does not hold the gate passes by itself',
  note: 'optional one line printed when the gate waits: what you should look at before you continue',
});

const LOOP_FIELDS = Object.freeze({
  id: 'required: a kebab-case id; steps after the loop list it in dependsOn, never a step inside it',
  steps: 'the step ids that repeat, in order through their own dependsOn; a step is in at most one loop; no loops inside loops',
  until: 'condition on one of the loop\'s steps: true ends the loop; false runs the next round',
  maxRounds: `required whole number 1-${LOOP_MAX_ROUNDS}: rounds used up, the loop waits for you like a gate`,
});

const CONDITION = Object.freeze({
  forms: [
    '{"step": "<id>", "field": "<name>", "equals": true}: a boolean field listed in the required fields of that step\'s object answer schema; equals is true (the default) or false',
    '{"step": "<id>", "evidence": "passed"}: every evidence check of that step passed; inside a loop a failed check on the until step reads as not passed instead of failing the step',
  ],
  note: 'the one condition form, for a gate\'s when and a loop\'s until; no expressions and no else: anything more is your call, with workflow wait and workflow add',
});

const RULES = Object.freeze([
  'Plan as far ahead as you know: declare steps, gates and loops up front, and add steps later with workflow add where the next part depends on an answer (workflow add <run> --steps part.json, or --from-answer <step> when a step\'s answer is itself a fragment {steps, gates?, loops?}).',
  'A step passes by facts only: its worker ended cleanly, its deliverable was produced, its evidence passed, and its answer (when declared) matched the schema. A worker\'s own report never decides.',
  'The one failure rule: a failed step gets one automatic retry (retry: 1): a process failure on another eligible pool, a failed check (answer, evidence, deliverable) on the same pool with the failure attached. Then it comes back to you. A step with retry 0, and an outward step whose worker started, comes back at once.',
  'A usage limit (a spent 5-hour, weekly or monthly window, or no credit left) ends the step and sends it to you at once: nothing waits, moves or retries. A short rate limit backs off on the same pool at most twice, then comes to you. Finding no capable pool free at the pick also sends the step to you.',
  'Nothing else is automatic: only what you declared runs by itself (the retry, loop rounds, gates that pass because their when does not hold).',
  'A gate stops only the steps behind it; other branches keep running. When only waiting gates or loops are left, the run parks with status waiting; workflow continue <run> <id> moves a gate on, and --rounds N gives a loop that ran out N more rounds.',
  'A loop runs every one of its steps in every round and reads its condition when the round is over, so put the deciding step last, and give every writer in a loop work to do each round: a build or chore step that changes no file fails not-produced (a draft that is rewritten from the critique works; a revise step after a critique that already passed does not).',
  'A failed step blocks only the steps that depend on it; other branches finish.',
  'route.independentOf can only name steps this step depends on (directly or through others): a check that must run on another provider than its source also depends on that source.',
  'Workers share one folder: tell each writer to keep other workers\' edits, and give it the exact files it changes in files.',
  'A v3 run\'s steps, gates and loops are never edited: plan revise refuses any change to them and may only rerun steps. Add steps (workflow add), rerun a step (workflow step rerun), accept a failed one (workflow step accept, recorded as your choice), or cancel and start a new run.',
]);

// The draft, critique, approve, publish workflow: research in parallel, a
// loop that rewrites the brief until an independent critique passes, a gate
// for the caller, then an outward step that must not repeat.
const claims = { type: 'object', required: ['claims'], properties: { claims: { type: 'array', items: { type: 'string' } } } };
const EXAMPLE = Object.freeze({
  schemaVersion: PROGRAM_V3_SCHEMA_VERSION,
  defaults: { lane: 'analyze', effort: 'medium' },
  steps: [
    { id: 'search-a', phase: 'research', prompt: 'In /abs/workspace, collect the claims sources/a.md makes about acme widgets.', answer: claims },
    { id: 'search-b', phase: 'research', prompt: 'In /abs/workspace, collect the claims sources/b.md makes about acme widgets.', answer: claims },
    { id: 'draft', phase: 'writing', dependsOn: ['search-a', 'search-b'], lane: 'build', files: ['brief.md'], prompt: 'In /abs/workspace, write brief.md from the claims your dependencies answered. From round 2 on, fix the problems the previous critique listed.' },
    { id: 'critique', phase: 'writing', dependsOn: ['draft'], route: { independentOf: ['draft'] }, prompt: 'In /abs/workspace, check every claim in brief.md against sources/. Answer passed true when every claim holds; list each problem otherwise.', answer: { type: 'object', required: ['passed', 'problems'], properties: { passed: { type: 'boolean' }, problems: { type: 'array', items: { type: 'string' } } } } },
    { id: 'post', phase: 'publish', dependsOn: ['approve'], deliverable: 'outward', retry: 0, prompt: 'Publish /abs/workspace/brief.md to the acme wiki, and list the page you created.' },
  ],
  loops: [{ id: 'polish', steps: ['draft', 'critique'], until: { step: 'critique', field: 'passed' }, maxRounds: 3 }],
  gates: [{ id: 'approve', dependsOn: ['polish'], note: 'Read brief.md and decide whether to publish it' }],
});

/** The v3 contract document for a goal; `next` holds the validate and launch commands. */
export function buildV3Contract({ goal, cwd, next, workerReasoning = null }) {
  return {
    action: 'plan-contract',
    schemaVersion: V3_CONTRACT_SCHEMA_VERSION,
    goal,
    cwd,
    program: {
      schemaVersion: PROGRAM_V3_SCHEMA_VERSION,
      shape: '{schemaVersion, defaults?, steps: [...], gates?: [...], loops?: [...]}',
      defaults: { allowed: ['lane', 'effort', 'reasoning', 'retry', 'timeBox'], note: 'optional; a step\'s own field outranks it' },
      stepFields: { ...STEP_FIELDS },
      gateFields: { ...GATE_FIELDS },
      loopFields: { ...LOOP_FIELDS },
      condition: { forms: [...CONDITION.forms], note: CONDITION.note },
      evidence: {
        maxItems: EVIDENCE_MAX_ITEMS,
        timeoutSec: { default: EVIDENCE_DEFAULT_TIMEOUT_SEC, max: EVIDENCE_MAX_TIMEOUT_SEC },
        schemaKeywords: [...SCHEMA_ASSERTED_KEYWORDS], schemaIgnored: [...SCHEMA_IGNORED_KEYWORDS],
        schemaFormats: ['json', 'jsonl'], outputFile: '$output', env: [...EVIDENCE_ENV_KEYS], checker: CHECKER_PATH,
        note: 'checks are read-only: a check that changes the deliverable fails; the answer schema and a schema check accept the same keywords',
      },
      notV3: 'purpose, affects, evidenceFor, kind, role, inputs, produces and defaults.verifyRounds belong to v2 programs; a check is an ordinary step with an answer and/or evidence',
    },
    rules: [...RULES],
    reasoning: {
      worker: workerReasoning,
      stepField: 'reasoning',
      levels: [...REASONING_LEVELS, 'default'],
      note: 'null means no run-wide override: the configured strategy or connector default applies. A step\'s reasoning outranks both.',
    },
    example: JSON.parse(JSON.stringify(EXAMPLE)),
    next: { validate: next.validate, launch: next.launch },
  };
}
