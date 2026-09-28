// `bullswarm run` as a one-step v3 workflow, run in the foreground (0.37.0).
//
// The kernel does everything a workflow step gets: routing (the same pick as
// every step, no incumbency, the caller never a pool), the attempt ledger,
// the one retry of the failure rule (a usage limit is never retried), the
// answer check, and the record under workflows/<id>/ with its rollup and the
// attempt's decision-log entry. There is no scout and no planner: the
// program is the caller's and is accepted as the run starts.
//
// Two run flags reach the kernel's dispatch here and nowhere else:
// `--timeout` (the worker's wall-clock cap, as in 0.36) and `--heartbeat`
// (progress lines on stderr, fed by the dispatch's activity and events).

import { watchOnce } from '../lib/watch.js';
import { probeFreeModel } from '../lib/probe.js';
import { createRunHeartbeat } from '../lib/run-heartbeat.js';
import { RUN_STEP_ID, runStepGoal, runStepProgram } from '../lib/run-step.js';
import { dispatchV2Action } from './v2-dispatch.js';
import { runV2AutonomousWorkflow } from './v2-runtime.js';
import { newRunId } from './short-id.js';
import { runVerdict } from './run-verdict.js';

const PLANNER_RESPONSE = 'bullswarm.workflow.planner-response.v2';

/** Run one request from run-step.js; returns the verdict (run-verdict.js). */
export async function runOneStep({ bullswarmDir, request, pools, parentEnv = process.env, dependencies = {} }) {
  const heartbeat = createRunHeartbeat({ intervalSec: request.heartbeatSec, ...(dependencies.heartbeatWrite ? { write: dependencies.heartbeatWrite } : {}) });
  const dispatchStep = dependencies.dispatchV2Action ?? dispatchV2Action;
  let dispatched = null;
  const dispatch = async (options) => {
    const timed = request.timeoutSec == null ? {} : {
      dependencies: {
        ...(options.dependencies ?? {}),
        watchOnce: (connector, task, dir, paths, opts) => watchOnce(connector, task, dir, paths, { ...opts, timeoutSec: request.timeoutSec }),
        // A supplied watchOnce turns the free-model probe off unless it is named.
        probeFreeModel,
      },
    };
    dispatched = await dispatchStep({
      ...options,
      ...timed,
      onActivity: (event) => { heartbeat.activity(event); options.onActivity?.(event); },
      onAgentEvent: (event) => { heartbeat.event(); options.onAgentEvent?.(event); },
    });
    return dispatched;
  };
  heartbeat.start();
  let run;
  try {
    run = await runV2AutonomousWorkflow({
      bullswarmDir,
      goalDocument: runStepGoal(request),
      pools,
      runId: newRunId(),
      parentEnv,
      initialPlannerResponse: {
        schemaVersion: PLANNER_RESPONSE, kind: 'program', summary: 'bullswarm run: one step.', program: runStepProgram(request),
      },
      dependencies: { dispatchV2Action: dispatch },
    });
  } finally {
    heartbeat.stop();
  }
  return runVerdict({ run, dispatched, stepId: RUN_STEP_ID });
}
