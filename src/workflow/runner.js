// bullswarm workflow runner — load, validate, execute phases, report.
//
// Phase semantics:
//   step onError: continue | fail (abort whole run) | skip-phase
//   settings.stopOnPhaseFailure: abort after a phase with any failure
// Resume: steps whose recorded verdict is ok:true are skipped (R2).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { validateWorkflow } from './validate.js';
import { WorkflowRuntime } from './runtime.js';

export function loadWorkflow(pathOrName, searchDirs) {
  let path = pathOrName;
  if (!path.endsWith('.json')) {
    const candidates = searchDirs.flatMap((d) => [
      join(d, `${pathOrName}.json`),
      join(d, pathOrName, 'workflow.json'),
    ]);
    path = candidates.find((p) => existsSync(p));
    if (!path) {
      throw new Error(`workflow "${pathOrName}" not found in: ${searchDirs.join(', ')}`);
    }
  }
  if (!existsSync(path)) throw new Error(`workflow file not found: ${path}`);
  return {
    doc: JSON.parse(readFileSync(path, 'utf8')),
    path,
  };
}

function newRunId() {
  return `wf-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
}

/**
 * Execute a workflow.
 * @param {object} opts
 * @param {string} opts.bullswarmDir
 * @param {object} opts.doc           validated workflow document
 * @param {object} opts.pools         live pools (buildPoolsLive)
 * @param {object} opts.inputs        runtime inputs (CLI --input k=v)
 * @param {string} [opts.resumeRunId]
 * @param {function} opts.onEvent     UX event sink
 */
export async function runWorkflow(opts) {
  const { bullswarmDir, doc, pools, inputs = {} } = opts;
  const runsRoot = join(bullswarmDir, 'workflows');
  mkdirSync(runsRoot, { recursive: true });

  const resuming = Boolean(opts.resumeRunId);
  const runId = resuming ? opts.resumeRunId : newRunId();
  const runDir = join(runsRoot, runId);
  mkdirSync(runDir, { recursive: true });

  let state;
  if (resuming && existsSync(join(runDir, 'state.json'))) {
    state = JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8'));
    state.resumed = true;
  } else {
    if (resuming) {
      throw new Error(`cannot resume: no state.json for run ${runId}`);
    }
    state = {
      runId,
      workflow: doc.name,
      inputs: { ...Object.fromEntries(
        Object.entries(doc.inputs ?? {}).map(([k, v]) => [k, v.default]),
      ), ...inputs },
      settings: { escalateOnFail: true, concurrency: 4, ...(doc.settings ?? {}) },
      outputs: {},
      steps: [],   // linear log: {phase, stepId, type, verdict summary}
      startedAt: new Date().toISOString(),
      resumed: false,
    };
  }
  if (opts.inputs && Object.keys(opts.inputs).length) {
    state.inputs = { ...state.inputs, ...opts.inputs };
  }

  const runtime = new WorkflowRuntime({
    bullswarmDir,
    pools,
    state,
    runDir,
    onEvent: opts.onEvent,
  });
  runtime.persist();

  opts.onEvent?.({ type: 'workflow.started', runId, workflow: doc.name, phases: doc.phases.length, resumed: state.resumed });

  let aborted = false;
  let abortReason = null;

  for (let pi = 0; pi < doc.phases.length && !aborted; pi++) {
    const phase = doc.phases[pi];
    opts.onEvent?.({ type: 'phase.started', index: pi, total: doc.phases.length, name: phase.name });
    let phaseFailed = false;

    for (const step of phase.steps ?? []) {
      if (resuming && state.outputs[step.id]?.ok === true && step.type === 'run') {
        opts.onEvent?.({ type: 'step.skipped', stepId: step.id });
        continue;
      }
      let r;
      try {
        r = await runtime.runStep(step);
      } catch (err) {
        // Step-level errors (bad template refs, unparseable fanout items, …)
        // are step failures under onError semantics — never crashes.
        r = { ok: false, why: err.message };
        state.outputs[step.id] = { ok: false, why: err.message };
      }
      state.steps.push({
        phase: phase.name,
        stepId: step.id,
        type: step.type,
        ok: r.ok,
        why: r.why ?? null,
      });
      runtime.persist();

      if (!r.ok) {
        phaseFailed = true;
        const onError = step.onError ?? 'continue';
        if (onError === 'fail') {
          aborted = true;
          abortReason = `step ${step.id} failed (onError: fail): ${r.why ?? 'unknown'}`;
          break;
        }
        if (onError === 'skip-phase') {
          opts.onEvent?.({ type: 'phase.skipped-rest', phase: phase.name, stepId: step.id });
          break;
        }
        // 'continue' — record and move on
      }
    }

    if (!aborted && phaseFailed && (doc.settings?.stopOnPhaseFailure || state.settings.stopOnPhaseFailure)) {
      aborted = true;
      abortReason = `phase ${phase.name} had failures (stopOnPhaseFailure)`;
    }
    opts.onEvent?.({ type: 'phase.completed', index: pi, name: phase.name, failed: phaseFailed });
  }

  const finishedAt = new Date().toISOString();
  state.finishedAt = finishedAt;
  state.status = aborted ? 'failed' : 'completed';
  if (abortReason) state.abortReason = abortReason;
  runtime.persist();

  const report = buildReport(state, doc, runDir);
  writeFileSync(join(runDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  opts.onEvent?.({ type: 'workflow.completed', runId, status: state.status, report: report.summary });

  return { runId, runDir, state, report };
}

export function buildReport(state, doc, runDir) {
  const stepResults = state.steps ?? [];
  const fanoutSteps = Object.entries(state.outputs ?? {}).filter(
    ([, v]) => v && typeof v === 'object' && 'items' in v,
  );
  let fanoutOk = 0;
  let fanoutFailed = 0;
  for (const [, v] of fanoutSteps) {
    fanoutOk += v.ok ?? 0;
    fanoutFailed += v.failed ?? 0;
  }
  const simpleOk = stepResults.filter((s) => s.ok).length;
  const simpleFailed = stepResults.filter((s) => s.ok === false).length;

  return {
    schemaVersion: 'bullswarm.workflow.report.v1',
    runId: state.runId,
    workflow: state.workflow,
    status: state.status,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    resumed: state.resumed === true,
    abortReason: state.abortReason ?? null,
    summary: {
      stepsTotal: stepResults.length,
      stepsOk: simpleOk,
      stepsFailed: simpleFailed,
      fanoutSteps: fanoutSteps.length,
      fanoutOk,
      fanoutFailed,
    },
    steps: stepResults,
    outputs: state.outputs,
    artifactsDir: runDir,
  };
}
