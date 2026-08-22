// bullswarm workflow — schema validation for dynamic workflow documents.
//
// Doctrine:
//   W1. A workflow is a JSON document, validated fully BEFORE anything runs.
//   W2. Template references must resolve at validation time, except
//       {{item}} / {{item.*}} inside fanout stepTemplate (per-expansion).
//   W3. Lanes and pinned pools are checked against the live registry so a
//       typo never burns quota discovering itself mid-run.

const LANES = ['analyze', 'build', 'chore'];
const ON_ERROR = ['continue', 'fail', 'skip-phase'];
const STEP_TYPES = ['run', 'fanout'];
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

/** Extract {{ref}} tokens from a string. */
export function templateRefs(str) {
  const out = [];
  const re = /\{\{\s*([^}]+?)\s*\}\}/g;
  let m;
  while ((m = re.exec(str)) !== null) out.push(m[1].trim());
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
  }

  // phases
  const phaseNames = new Set();
  const stepIds = new Set();
  const outputs = new Set(); // step ids that produce outputs

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
      if (step.pool != null) {
        collect(issues, validPools.has(step.pool),
          `${sat}.pool "${step.pool}" is not a known pool (${[...validPools].join(', ') || 'none discovered'})`);
      }

      if (step.type === 'fanout') {
        collect(issues, typeof step.itemsFrom === 'string' && step.itemsFrom.length > 0,
          `${sat}.itemsFrom is required for fanout steps`);
        // itemsFrom must reference declared inputs or a prior step's output
        if (typeof step.itemsFrom === 'string' && step.itemsFrom.includes('.')) {
          const [root, target] = step.itemsFrom.split('.');
          collect(issues, root === 'inputs' || (root === 'outputs' && outputs.has(target)),
            `${sat}.itemsFrom "${step.itemsFrom}" cannot resolve (use inputs.<name> or outputs.<priorStepId>)`);
        } else if (typeof step.itemsFrom === 'string') {
          collect(issues, false,
            `${sat}.itemsFrom "${step.itemsFrom}" must be a dotted path (inputs.<name> or outputs.<priorStepId>)`);
        }
        collect(issues, step.stepTemplate && typeof step.stepTemplate === 'object',
          `${sat}.stepTemplate is required for fanout steps`);
        if (step.concurrency != null) {
          collect(issues, Number.isInteger(step.concurrency) && step.concurrency >= 1,
            `${sat}.concurrency must be a positive integer`);
        }
      } else if (step.type === 'run') {
        collect(issues,
          typeof step.taskFile === 'string' || typeof step.prompt === 'string',
          `${sat} needs taskFile or prompt`);
      }

      if (step.timeoutSec != null) {
        collect(issues, Number.isFinite(step.timeoutSec) && step.timeoutSec > 0,
          `${sat}.timeoutSec must be a positive number`);
      }
    });
  });

  if (issues.length) throw new WorkflowValidationError(issues);

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
