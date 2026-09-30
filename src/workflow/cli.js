// bullswarm workflow CLI — goal | plan | runs | watch | tui.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cmdRuns, cmdReindex } from './runs-cli.js';
import { runDashboard, dashboardJson, overviewSnapshot } from './dashboard.js';
import { wfAdd, wfContinue, wfWait } from './cli-steps.js';
import { helpText, usageLine } from '../help.js';
import { flagName, unknownFlagExit } from '../lib/cli-flags.js';
import { cmdReprice } from './reprice.js';
import { resolvePoolId } from '../lib/pool-labels.js';
import { workflowHelpPath, parseFlags, flagErrors } from './workflow-flags.js';
import { BULLSWARM_DIR, legacyRunRefusal, legacyRunSummary, legacySummaryLines } from './cli-run-lookup.js';
import { isLegacyRunDir, resolveRunId } from './short-id.js';
import { modelPoolIssues, programNamesModel, programRoutes, routePoolIssues, configuredPools } from './cli-pool-checks.js';
import { launchDetachedResume } from './cli-launch.js';
import { wfPlan } from './cli-plan.js';
import { wfGoal } from './cli-goal.js';
import { wfStep } from './cli-step-verbs.js';
import { wfPause, wfCancel, wfResume, wfSteer } from './cli-run-verbs.js';
import { wfEvents, wfWatch, wfAction, wfTask } from './cli-inspect.js';
import { wfCapabilities } from './cli-capabilities.js';

function isHomeSnapshot(dir) {
  try {
    const marker = JSON.parse(readFileSync(join(dir, '.snapshot.json'), 'utf8'));
    return marker?.kind === 'bullswarm-home-snapshot' && marker?.version === 1;
  } catch {
    return false;
  }
}

export async function cmdWorkflow(args, {
  bullswarmDir = BULLSWARM_DIR(), input = process.stdin, output = process.stdout,
  runsAlias = null,
} = {}) {
  // A leading flag means no subcommand was given: `workflow --bogus` is a
  // flag error on the workflow root, not an unknown subcommand named
  // "--bogus".
  const [head, ...tail] = args;
  const sub = flagName(head) ? undefined : head;
  const opts = parseFlags(sub === undefined ? args : tail);
  for (const key of ['pool', 'worker-pool', 'orchestrator', 'strict-orchestrator']) {
    if (typeof opts[key] === 'string' && opts[key] !== 'auto') {
      opts[key] = resolvePoolId(opts[key], bullswarmDir);
    }
  }

  if (!sub && input.isTTY && output.isTTY) {
    try { return await runDashboard(bullswarmDir, { input, output }); }
    catch (err) { console.error(`✗ ${err.message}`); return 1; }
  }

  // One gate for every workflow verb whose flags are parsed here. `plan` and
  // `runs` re-parse their own tail against their own subcommand's table, so
  // they run the same check inside their own dispatcher instead.
  // Reprice owns its small flag grammar so it can also be invoked from tests
  // with an injected transcript reader.  The central flag registry/help node
  // is integrator-owned and will add its allow-list alongside the new leaf.
  if (sub !== 'plan' && sub !== 'runs' && sub !== 'reprice') {
    const path = workflowHelpPath(sub, opts);
    if (path) {
      const flagExit = unknownFlagExit(opts.flags, path);
      if (flagExit !== null) return flagExit;
    }
  }

  switch (sub) {
    case 'goal':
      return wfGoal(opts);
    case 'plan':
      return wfPlan(tail);
    case 'cancel':
      return wfCancel(opts);
    case 'pause':
      return wfPause(opts);
    case 'resume':
      return wfResume(opts);
    case 'runs':
      return cmdRuns(tail, runsAlias ? { alias: runsAlias } : {});
    case 'reindex':
      return cmdReindex(tail);
    case 'reprice':
      return cmdReprice(tail, { bullswarmDir });
    case 'capabilities':
      return wfCapabilities(opts);
    case 'tui':
      try {
        {
          // A legacy run shows its summary; cancelling one is refused.
          const token = opts.rest[0] ?? opts.show;
          const resolved = token ? resolveRunId(bullswarmDir, token) : null;
          if (resolved && isLegacyRunDir(resolved.runDir)) {
            if (opts.cancel) return legacyRunRefusal(token, { json: Boolean(opts.json) });
            const summary = legacyRunSummary(resolved);
            console.log(opts.json ? JSON.stringify(summary, null, 2) : legacySummaryLines(summary).join('\n'));
            return 0;
          }
        }
        if (opts.overview) {
          const token = opts.rest[0] ?? opts.show;
          if (!token) { console.error(`usage: ${usageLine(['workflow', 'tui'])}\n--overview needs a run: pass <runId> or --show <runId>`); return 2; }
          const snapshot = overviewSnapshot(bullswarmDir, token, { width: opts.width, height: opts.height });
          if (opts.json) console.log(JSON.stringify(snapshot, null, 2));
          else console.log(snapshot.lines.join('\n'));
          return snapshot.legacy ? 2 : 0;
        }
        if (opts.json || opts.cancel || opts.show || opts.all) {
          const token = opts.rest[0] ?? opts.show;
          const result = dashboardJson(bullswarmDir, {
            all: opts.all || (opts.json && isHomeSnapshot(bullswarmDir)),
            token,
            cancel: opts.cancel,
          });
          console.log(JSON.stringify(result, null, 2));
          return 0;
        }
        return await runDashboard(bullswarmDir, { token: opts.rest[0] ?? null, input, output });
      }
      catch (err) { console.error(`✗ ${err.message}`); return 1; }
    case 'events':
      return wfEvents(opts);
    case 'watch':
      return wfWatch(opts);
    case 'steer':
      return wfSteer(opts);
    case 'action':
      return wfAction(opts);
    case 'task':
      return wfTask(opts, bullswarmDir);
    case 'step':
      return wfStep(opts);
    case 'continue':
      return wfContinue(opts, { bullswarmDir, helpText, flagErrors, launchDetachedResume });
    case 'add':
      return wfAdd(opts, { bullswarmDir, helpText, flagErrors, launchDetachedResume, routeIssues: (actions, doc, state) => [
        ...(programRoutes(actions) ? routePoolIssues(actions, configuredPools(), doc, undefined, state, { recordedWork: true }) : []),
        ...(programNamesModel(actions) ? modelPoolIssues(actions, configuredPools(), doc) : []),
      ] });
    case 'wait':
      return wfWait(opts, { bullswarmDir, helpText, flagErrors });
    default: {
      // Smart error: if the user typed a `runs` subcommand directly
      // under `workflow` (e.g. `workflow show jd3uki`), point them at
      // the right verb instead of dumping the whole help text.
      const runsSubcommands = new Set(['show', 'delete']);
      if (sub && runsSubcommands.has(sub)) {
        console.error(
          `✗ "workflow ${sub}" is not a subcommand. ` +
          `Did you mean "workflow runs ${sub} <id>"?`,
        );
        return 2;
      }
      console.error(helpText(['workflow']));
      return 2;
    }
  }
}
