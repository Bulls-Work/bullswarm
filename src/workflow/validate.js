// bullswarm workflow — schema validation for dynamic workflow documents.
//
// Doctrine:
//   W1. A workflow is a JSON document, validated fully BEFORE anything runs.
//   W2. Template references must resolve at validation time, except
//       {{item}} / {{item.*}} inside fanout stepTemplate (per-expansion).
//   W3. Lanes and pinned pools are checked against the live registry so a
//       typo never burns quota discovering itself mid-run.

import { TEMPLATE_TOKEN_RE, isTemplateRef } from './template.js';
import { isValidOutputSchema } from './schema.js';

const LANES = ['analyze', 'build', 'chore'];
const ON_ERROR = ['continue', 'fail', 'skip-phase'];
const STEP_TYPES = ['run', 'fanout', 'verify', 'decide'];
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export class WorkflowValidationError extends Error {
  constructor(issues) {
    super(`workflow invalid: ${issues.length} problem(s)`);
    this.issues = issues;
  }
}

function collect(issues, ok, msg) {
  if (!ok) issues.push(msg);
  return ok;
}

/**
 * Extract {{ref}} tokens from a string. Only grammar-conforming refs count
 * (known root + dotted identifiers); other double-brace text is prompt content.
 */
export function templateRefs(str) {
  const out = [];
  const re = new RegExp(TEMPLATE_TOKEN_RE.source, 'g');
  let m;
  while ((m = re.exec(str)) !== null) {
    if (isTemplateRef(m[1])) out.push(m[1].trim());
  }
  return out;
}

function walkStrings(value, fn) {
  if (typeof value === 'string') {
    fn(value);
  } else if (Array.isArray(value)) {
    for (const v of value) walkStrings(v, fn);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) walkStrings(v, fn);
  }
}

/**
 * Validate a workflow document against the known lanes/pools.
 * @param {object} wf parsed workflow JSON
 * @param {{lanes?: string[], poolNames?: string[]}} env live registry info
 * @returns {{name: string, warnings: string[]}} normalized doc
 * @throws WorkflowValidationError with .issues[] on any problem
 */
export function validateWorkflow(wf, { lanes = LANES, poolNames = [] } = {}) {
  const issues = [];
  const warnings = [];
  const validLanes = new Set(lanes);
  const validPools = new Set(poolNames);

  if (!wf || typeof wf !== 'object' || Array.isArray(wf)) {
    throw new WorkflowValidationError(['document is not a JSON object']);
  }

  collect(issues, typeof wf.name === 'string' && NAME_RE.test(wf.name),
    `name "${wf.name}" must be kebab-case (letters/digits/dashes)`);
  collect(issues, typeof wf.description === 'string' && wf.description.length > 0,
    'description is required');
  collect(issues, Array.isArray(wf.phases) && wf.phases.length > 0,
    'phases must be a non-empty array');

  // inputs
  const inputs = wf.inputs ?? {};
  if (!collect(issues, inputs && typeof inputs === 'object' && !Array.isArray(inputs),
    'inputs must be an object')) {
    throw new WorkflowValidationError(issues);
  }
  for (const [k, v] of Object.entries(inputs)) {
    collect(issues, v && typeof v === 'object', `input "${k}" must be an object`);
    if (v && typeof v === 'object') {
      if (v.required != null) {
        collect(issues, typeof v.required === 'boolean',
          `input "${k}".required must be a boolean`);
      }
      if (v.default != null) {
        collect(issues, ['string', 'number', 'boolean'].includes(typeof v.default),
          `input "${k}".default must be a string, number, or boolean`);
      }
    }
  }

  // phases
  const phaseNames = new Set();
  const stepIds = new Set();
  const outputs = new Set(); // step ids that produce outputs
  let hasDecide = false;

  (wf.phases ?? []).forEach((phase, pi) => {
    const at = `phases[${pi}]`;
    collect(issues, phase && typeof phase === 'object', `${at} must be an object`);
    if (!phase || typeof phase !== 'object') return;
    collect(issues, typeof phase.name === 'string' && NAME_RE.test(phase.name),
      `${at}.name must be kebab-case`);
    if (phase.name) {
      collect(issues, !phaseNames.has(phase.name), `duplicate phase name "${phase.name}"`);
      phaseNames.add(phase.name);
    }
    collect(issues, Array.isArray(phase.steps), `${at}.steps must be an array`);

    (phase.steps ?? []).forEach((step, si) => {
      const sat = `${at}.steps[${si}]`;
      if (!collect(issues, step && typeof step === 'object', `${sat} must be an object`)) return;
      collect(issues, typeof step.id === 'string' && NAME_RE.test(step.id),
        `${sat}.id must be kebab-case`);
      if (step.id) {
        collect(issues, !stepIds.has(step.id), `duplicate step id "${step.id}"`);
        stepIds.add(step.id);
        outputs.add(step.id);
      }
      collect(issues, STEP_TYPES.includes(step.type),
        `${sat}.type must be one of ${STEP_TYPES.join('|')} (got "${step.type}")`);
      collect(issues, ON_ERROR.includes(step.onError ?? 'continue'),
        `${sat}.onError must be one of ${ON_ERROR.join('|')}`);

      if (step.lane != null) {
        collect(issues, validLanes.has(step.lane),
          `${sat}.lane "${step.lane}" is not a lane (${[...validLanes].join(', ')})`);
      }
      if (step.effort != null) {
        collect(issues, ['high', 'medium', 'low'].includes(step.effort),
          `${sat}.effort must be high, medium, or low`);
      }
      if (step.pool != null) {
        collect(issues, validPools.has(step.pool),
          `${sat}.pool "${step.pool}" is not a known pool (${[...validPools].join(', ') || 'none discovered'})`);
      }
      if (step.preferredPool != null) {
        collect(issues, validPools.has(step.preferredPool),
          `${sat}.preferredPool "${step.preferredPool}" is not a known pool (${[...validPools].join(', ') || 'none discovered'})`);
      }
      if (step.requiresCapabilities != null) {
        collect(issues, Array.isArray(step.requiresCapabilities) &&
          step.requiresCapabilities.length > 0 &&
          step.requiresCapabilities.every((capability) =>
            typeof capability === 'string' && NAME_RE.test(capability)),
        `${sat}.requiresCapabilities must be a non-empty array of kebab-case capability names`);
      }

      if (step.type === 'fanout') {
        collect(issues, (typeof step.itemsFrom === 'string' && step.itemsFrom.length > 0) || Array.isArray(step.items),
          `${sat} needs itemsFrom or an inline items array`);
        // itemsFrom must reference declared inputs or a prior step's output
        if (typeof step.itemsFrom === 'string' && step.itemsFrom.includes('.')) {
          const [root, target] = step.itemsFrom.split('.');
          collect(issues, root === 'inputs' || (root === 'outputs' && outputs.has(target)),
            `${sat}.itemsFrom "${step.itemsFrom}" cannot resolve (use inputs.<name> or outputs.<priorStepId>[.data.<field>])`);
        } else if (typeof step.itemsFrom === 'string') {
          collect(issues, false,
            `${sat}.itemsFrom "${step.itemsFrom}" must be a dotted path (inputs.<name> or outputs.<priorStepId>[.data.<field>])`);
        }
        collect(issues, step.stepTemplate && typeof step.stepTemplate === 'object',
          `${sat}.stepTemplate is required for fanout steps`);
        if (step.concurrency != null) {
          collect(issues, Number.isInteger(step.concurrency) && step.concurrency >= 1,
            `${sat}.concurrency must be a positive integer`);
        }
        if (step.items != null) {
          collect(issues, Array.isArray(step.items), `${sat}.items must be an array`);
        }
        if (step.stepTemplate?.outputSchema !== undefined) {
          const schema = isValidOutputSchema(step.stepTemplate.outputSchema);
          collect(issues, schema.ok, `${sat}.stepTemplate.outputSchema is invalid: ${schema.issues.join('; ')}`);
          if (schema.ok) collect(issues, step.stepTemplate.outputSchema.type === 'object', `${sat}.stepTemplate.outputSchema.type must be "object"`);
        }
      } else if (step.type === 'run') {
        collect(issues,
          typeof step.taskFile === 'string' || typeof step.prompt === 'string',
          `${sat} needs taskFile or prompt`);
        if (step.outputSchema !== undefined) {
          const schema = isValidOutputSchema(step.outputSchema);
          collect(issues, schema.ok, `${sat}.outputSchema is invalid: ${schema.issues.join('; ')}`);
          if (schema.ok) collect(issues, step.outputSchema.type === 'object', `${sat}.outputSchema.type must be "object"`);
        }
      } else if (step.type === 'verify') {
        collect(issues, typeof step.review === 'string' && step.review.length > 0,
          `${sat}.review is required for verify steps (path to a prior outFile, e.g. outputs.<prior>.outFile)`);
        // review target: outputs.<priorStepId>.outFile is the only allowed
        // shape (we want to be sure the verifier reads FILE content, not
        // raw context). It may also reference inputs.<name>.<fileField>.
        if (typeof step.review === 'string' && step.review.includes('.')) {
          const [root, target] = step.review.split('.');
          const ok = (root === 'outputs' && outputs.has(target))
            || (root === 'inputs' && (inputs[target] != null));
          collect(issues, ok,
            `${sat}.review "${step.review}" cannot resolve (use outputs.<priorStepId>.outFile or inputs.<declaredInput>)`);
        }
      } else if (step.type === 'decide') {
        hasDecide = true;
        collect(issues, step.prompt == null || typeof step.prompt === 'string',
          `${sat}.prompt must be a string when provided`);
        if (step.actionDefaults != null) {
          collect(issues, step.actionDefaults && typeof step.actionDefaults === 'object' && !Array.isArray(step.actionDefaults),
            `${sat}.actionDefaults must be an object`);
          const allowedDefaults = new Set(['pool', 'model', 'lane', 'effort', 'requiresCapabilities', 'addDir', 'timeoutSec']);
          for (const key of Object.keys(step.actionDefaults ?? {})) {
            collect(issues, allowedDefaults.has(key), `${sat}.actionDefaults.${key} is not runtime-controlled metadata`);
          }
          if (step.actionDefaults?.pool != null) {
            collect(issues, validPools.has(step.actionDefaults.pool),
              `${sat}.actionDefaults.pool "${step.actionDefaults.pool}" is not a known pool`);
          }
          if (step.actionDefaults?.model != null) {
            collect(issues, typeof step.actionDefaults.model === 'string' && step.actionDefaults.model.trim().length > 0,
              `${sat}.actionDefaults.model must be a non-empty model identifier`);
          }
          if (step.actionDefaults?.lane != null) {
            collect(issues, validLanes.has(step.actionDefaults.lane),
              `${sat}.actionDefaults.lane "${step.actionDefaults.lane}" is not a lane`);
          }
          if (step.actionDefaults?.effort != null) {
            collect(issues, ['high', 'medium', 'low'].includes(step.actionDefaults.effort),
              `${sat}.actionDefaults.effort must be high, medium, or low`);
          }
          if (step.actionDefaults?.requiresCapabilities != null) {
            collect(issues, Array.isArray(step.actionDefaults.requiresCapabilities) &&
              step.actionDefaults.requiresCapabilities.length > 0 &&
              step.actionDefaults.requiresCapabilities.every((capability) =>
                typeof capability === 'string' && NAME_RE.test(capability)),
            `${sat}.actionDefaults.requiresCapabilities must contain kebab-case names`);
          }
          if (step.actionDefaults?.addDir != null) {
            collect(issues, typeof step.actionDefaults.addDir === 'string',
              `${sat}.actionDefaults.addDir must be a string`);
          }
          if (step.actionDefaults?.timeoutSec != null) {
            collect(issues, Number.isFinite(step.actionDefaults.timeoutSec) && step.actionDefaults.timeoutSec > 0,
              `${sat}.actionDefaults.timeoutSec must be a positive number`);
          }
        }
      }

      if (step.timeoutSec != null) {
        collect(issues, Number.isFinite(step.timeoutSec) && step.timeoutSec > 0,
          `${sat}.timeoutSec must be a positive number`);
      }
      if (step.model != null) {
        collect(issues, typeof step.model === 'string' && step.model.trim().length > 0,
          `${sat}.model must be a non-empty model identifier`);
      }
    });
  });

  if (issues.length) throw new WorkflowValidationError(issues);

  // settings: optional maxAgents / warnAtAgents.
  const settings = wf.settings ?? {};
  if (settings.maxAgents != null) {
    collect(issues, Number.isInteger(settings.maxAgents) && settings.maxAgents >= 1,
      `settings.maxAgents must be a positive integer`);
  }
  if (settings.warnAtAgents != null) {
    collect(issues, Number.isInteger(settings.warnAtAgents) && settings.warnAtAgents >= 1,
      `settings.warnAtAgents must be a positive integer`);
  }
  if (settings.concurrency != null) {
    collect(issues, Number.isInteger(settings.concurrency) && settings.concurrency >= 1
      && settings.concurrency <= 16,
      `settings.concurrency must be a positive integer ≤ 16`);
  }
  if (settings.retryAttempts != null) {
    collect(issues, Number.isInteger(settings.retryAttempts) && settings.retryAttempts >= 0
      && settings.retryAttempts <= 3,
      `settings.retryAttempts must be an integer from 0 to 3`);
  }
  if (settings.maxActions != null) {
    collect(issues, settings.maxActions >= stepIds.size,
      `settings.maxActions=${settings.maxActions} is below the ${stepIds.size} initial actions`);
  }
  for (const [key, min] of [
    ['maxExpansionRounds', 0],
    ['maxActions', 1],
    ['maxItemsPerExpansion', 1],
    ['maxPlannerCorrections', 0],
    ['maxWorkflowSeconds', 1],
  ]) {
    if (settings[key] != null) {
      collect(issues, Number.isInteger(settings[key]) && settings[key] >= min,
        `settings.${key} must be an integer >= ${min}`);
    }
  }
  if (hasDecide) {
    collect(issues, Number.isInteger(settings.maxExpansionRounds) && settings.maxExpansionRounds >= 1,
      'adaptive workflows with a decide step require settings.maxExpansionRounds >= 1');
  }

  // ---- template reference resolution (W2) --------------------------------
  // Scope available at validation: inputs.*, outputs.<stepId> for PRIOR
  // steps, runId/wfDir metadata. {{item}} allowed only inside fanout
  // stepTemplate. We do a second pass now that all step ids are known.

  const resolvable = (ref, inTemplate) => {
    const root = ref.split('.')[0];
    if (root === 'item') return inTemplate;
    if (root === 'inputs') return true; // presence checked at runtime vs declared inputs? keep lenient, warn below
    if (root === 'outputs') {
      const target = ref.split('.')[1];
      return target ? outputs.has(target) : false;
    }
    return root === 'runId' || root === 'wfDir';
  };

  const checkRefs = (obj, inTemplate, label) => {
    walkStrings(obj, (s) => {
      for (const ref of templateRefs(s)) {
        if (!resolvable(ref, inTemplate)) {
          issues.push(`${label}: template ref "{{${ref}}}" cannot resolve` +
            (inTemplate ? '' : ` (known roots: inputs, outputs.<stepId>, runId, wfDir)`));
        }
      }
    });
  };

  (wf.phases ?? []).forEach((phase, pi) => {
    (phase.steps ?? []).forEach((step, si) => {
      const sat = `phases[${pi}].steps[${si}](${step.id ?? '?'})`;
      const { stepTemplate, ...rest } = step;
      checkRefs(rest, false, sat);
      if (stepTemplate) checkRefs(stepTemplate, true, `${sat}.stepTemplate`);
    });
  });

  // undeclared input usage → warning only (inputs may be passed at runtime)
  const usedInputs = new Set();
  walkStrings(wf, (s) => {
    for (const ref of templateRefs(s)) {
      if (ref.startsWith('inputs.')) usedInputs.add(ref.slice('inputs.'.length));
    }
  });
  for (const u of usedInputs) {
    if (!(u in inputs)) {
      warnings.push(`template uses inputs.${u} but it is not declared under "inputs" (pass --input ${u}=…)`);
    }
  }

  if (issues.length) throw new WorkflowValidationError(issues);
  return { name: wf.name, warnings };
}
