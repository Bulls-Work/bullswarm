// bullswarm workflow runtime — executes a validated workflow document.
//
// Doctrine:
//   R1. Dispatch reuses watchOnce verbatim — same verdict contract, same
//       quarantine side effects, same meter accounting as single runs.
//   R2. State persists to disk after EVERY step; resume = skip ok:true.
//   R3. Escalation is verdict-driven: failed step retries once on next pool
//       by surplus (never the same pool, never more than once).
//   R4. Concurrency limiter is global across fanout expansions (one Semaphore
//       shared by all in-flight dispatches; per-fanout worker cap ≤ global).
//   R5. onError: continue | fail (abort run) | skip-phase (rest of phase).
//   R6. Workflow dispatches propagate BULLSWARM_DEPTH to the spawned
//       connector; the recursion guard is core-owned. A workflow that itself
//       triggers `bullswarm` is refused at the depth limit instead of
//       recursing forever.
//   R7. Auth/throttle verdicts from inside a workflow do call quarantinePool
//       and append to the shared decisionLog, so `bullswarm health` sees
//       workflow runs and a misbehaving pool is benched for the next dispatch.
//   R8. Burst-gated pools (5h ≥ 90%) are excluded from workflow dispatch,
//       matching the single-run path.
//   R9. `outputText` is truncated when persisted to state.json; the full
//       text always lives in the per-step outFile.

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pickPool } from '../lib/route.js';
import { watchOnce } from '../lib/watch.js';
import { renderDeep, extractItems, getPath } from './template.js';
import { loadState, saveState, quarantinePool, childDepthEnv, DEPTH_ENV, assertDepthAllowed } from '../lib/state.js';
import { Semaphore } from './semaphore.js';

// Cap how much of each step's output we keep inline in state.json.
// Persisting full transcripts bloat state.json on long workflows. The
// full text is always on disk in the per-step outFile.
export const OUTPUT_TEXT_CAP_BYTES = 64 * 1024;

export class WorkflowRuntime {
  /**
   * @param {object} opts
   * @param {string} opts.bullswarmDir  ~/.bullswarm
   * @param {object} opts.pools         buildPoolsLive result pools array
   * @param {object} opts.state         loaded workflow state (mutable)
   * @param {string} opts.runDir        artifact dir for this run
   * @param {function} opts.onEvent     (event) => void for UX rendering
   */
  constructor(opts) {
    this.bullswarmDir = opts.bullswarmDir;
    this.pools = opts.pools;
    this.state = opts.state;
    this.runDir = opts.runDir;
    this.onEvent = opts.onEvent ?? (() => {});
    // Global concurrency limiter shared across runSingle + runFanout.
    // Sized from settings.concurrency; bounded by the spawn cap (16) to
    // match the Claude Code dynamic-workflow cap. Tests inject their own.
    const concap = opts.semaphore
      ?? new Semaphore(
        Math.min(
          Math.max(1, Number(opts.concurrency ?? this.state?.settings?.concurrency ?? 4)),
          16,
        ),
      );
    this.limiter = concap;
    this.parentEnv = opts.env ?? process.env;
    // Counters used by the spend guard (R4 follow-on).
    this.dispatchCount = 0;
    this.warningEmitted = false;
  }

  persist() {
    writeFileSync(join(this.runDir, 'state.json'), `${JSON.stringify(this.state, null, 2)}\n`);
  }

  emit(type, payload) {
    this.onEvent({ type, ...payload });
  }

  scopeFor(step) {
    return {
      inputs: this.state.inputs,
      outputs: this.state.outputs,
      runId: this.state.runId,
      wfDir: this.runDir,
    };
  }

  /**
   * Execute one dispatch (run or single fanout expansion).
   * Returns verdict. Applies escalation per R3.
   *
   * Acquires a permit from the global semaphore (R4) and propagates
   * BULLSWARM_DEPTH to the spawned connector (R6). On an auth/throttle
   * verdict the failed pool is quarantined in the core state and a
   * decisionLog entry is appended (R7). Burst-gated pools are excluded
   * before selection (R8).
   */
  async dispatch(step, taskText, targetDir, paths, opts = {}) {
    return this.limiter.runWith(async () => {
      const attemptPools = this.preparePools(step);
      let lastVerdict = null;

      for (let attempt = 0; attempt < 2; attempt++) {
        const route = pickPool(step.lane ?? 'chore', attemptPools, {
          callerEligible: false,
          callerSession: false, // workflow context: every pool is a worker
          now: Date.now(),
        });
        if (!route.pick) {
          return {
            ok: false,
            keepOnClaude: false,
            why: `no eligible pool (${route.why})`,
            pick: { pool: null },
            meta: { exitCode: null },
          };
        }
        const connector = route.pick.connector?.connector ?? route.pick.connector;

        // Pin pool if requested (validation already checked existence)
        const chosen = step.pool
          ? attemptPools.find((p) => p.name === step.pool)
          : connector;
        const conn = (chosen?.connector) ? chosen.connector : chosen;

        this.dispatchCount += 1;
        this.maybeWarnLarge();

        this.emit('step.started', {
          stepId: step.id,
          item: opts.item,
          pool: conn.name,
          attempt,
        });

        // R6: propagate the recursion env so a connector that itself
        // spawns `bullswarm` is refused at the core's depth limit.
        const childEnv = childDepthEnv(this.parentEnv);

        // R7: refuse if THIS workflow process is already at the depth
        // limit. The check uses parentEnv (the current process's depth),
        // not childEnv — the limit means "this process is at depth N and
        // must not spawn a child that would be N+1". The child will
        // receive childEnv in its own env; if IT tries to recurse, the
        // child process's assert will fire at its own depth+1.
        try {
          const coreState = loadState(this.bullswarmDir);
          assertDepthAllowed(coreState, this.parentEnv);
        } catch (err) {
          return {
            ok: false,
            keepOnClaude: false,
            why: `recursion guard: ${err.message}`,
            pick: { pool: conn.name },
            meta: { exitCode: null },
          };
        }

        const verdict = await watchOnce(conn, taskText, targetDir, paths, {
          timeoutSec: step.timeoutSec ?? conn.timeoutSec ?? 900,
          env: childEnv,
        });

        // R7: record EVERY dispatch into the shared decisionLog so
        // `bullswarm health` can correlate workflow outputs.
        this.appendDecision(step, conn.name, verdict, paths);

        // R7: auth/throttle verdict → quarantine the pool for 10 min so
        // the next dispatch doesn't re-select it.
        if (verdict.quarantineHint) {
          try {
            const coreState = loadState(this.bullswarmDir);
            quarantinePool(coreState, conn.name, verdict.why, Date.now());
            saveState(this.bullswarmDir, coreState);
            // Reflect the new quarantine on the live pool view used by
            // the next attempt of this very dispatch.
            const live = this.pools.find((p) => p.name === conn.name);
            if (live) {
              live.quarantine = coreState.pools[conn.name].quarantine;
            }
          } catch { /* best effort */ }
        }

        if (verdict.ok || step.pool) {
          // pinned pools don't escalate — you asked for THIS pool
          return verdict;
        }
        lastVerdict = verdict;
        // Escalate: drop the pool that just failed from this step's candidates.
        const failedName = conn.name;
        const idx = attemptPools.findIndex((p) => p.name === failedName);
        if (idx >= 0) attemptPools.splice(idx, 1);
        if (!opts.escalate || attemptPools.length === 0) break;
        this.emit('step.escalate', {
          stepId: step.id, item: opts.item,
          from: failedName, why: verdict.why,
        });
      }
      return lastVerdict;
    });
  }

  preparePools(step) {
    // Fresh eligible list per dispatch: enabled, not quarantined, and
    // not currently burst-gated (R8). Quarantine has been applied to
    // pool.quarantine by the live buildPools pass; if a previous
    // dispatch in this run benched a pool we already mirrored that onto
    // this.pools above.
    return this.pools.filter(
      (p) => p.enabled !== false && !p.quarantine && p.burstGate !== true,
    );
  }

  appendDecision(step, poolName, verdict, paths) {
    try {
      const coreState = loadState(this.bullswarmDir);
      coreState.decisionLog ??= [];
      coreState.decisionLog.push({
        ts: new Date().toISOString(),
        lane: step.lane ?? 'chore',
        picked: poolName,
        keepOnClaude: false,
        ok: verdict.ok,
        why: verdict.why,
        wallSec: verdict.meta?.wallSec,
        outFile: paths?.outFile ?? null,
        source: 'workflow',
        stepId: step.id,
      });
      if (coreState.decisionLog.length > 500) {
        coreState.decisionLog = coreState.decisionLog.slice(-500);
      }
      saveState(this.bullswarmDir, coreState);
    } catch { /* never let logging crash a run */ }
  }

  /** Spend-guard: warn once when dispatchCount crosses the threshold. */
  maybeWarnLarge() {
    if (this.warningEmitted) return;
    const t = this.state?.settings?.warnAtAgents ?? 25;
    if (this.dispatchCount >= t) {
      this.warningEmitted = true;
      this.onEvent({
        type: 'workflow.large',
        threshold: t,
        dispatchCount: this.dispatchCount,
      });
    }
  }

  async runStep(step) {
    const scope = this.scopeFor(step);
    if (step.type === 'run') {
      return this.runSingle(step, scope);
    }
    if (step.type === 'fanout') {
      return this.runFanout(step, scope);
    }
    if (step.type === 'verify') {
      return this.runVerify(step, scope);
    }
    throw new Error(`unknown step type ${step.type}`);
  }

  /**
   * Enforce inputs.<k>.required at runtime. Throws if any required input
   * is missing or empty. Called by runSingle / runFanout / runVerify before
   * any dispatch.
   */
  enforceRequiredInputs(stepId) {
    const docInputs = this.state._doc?.inputs ?? {};
    for (const [k, spec] of Object.entries(docInputs)) {
      if (!spec || spec.required !== true) continue;
      const v = this.state.inputs?.[k];
      const missing = v === undefined || v === null || v === '' ||
        (typeof v === 'string' && v.trim() === '');
      if (missing) {
        throw new Error(
          `required input "${k}" is missing for step "${stepId}" ` +
          `(pass --input ${k}=… or declare a default in the workflow doc)`,
        );
      }
    }
  }

  async runSingle(step, scope) {
    this.enforceRequiredInputs(step.id);
    const rendered = renderDeep(
      {
        lane: step.lane ?? 'chore',
        addDir: step.addDir,
        prompt: step.prompt,
        taskFile: step.taskFile,
      },
      scope,
    );
    const taskText = rendered.prompt
      ?? readFileSync(rendered.taskFile, 'utf8');
    const targetDir = rendered.addDir ? String(rendered.addDir).replace(/^~/, process.env.HOME ?? '') : process.cwd();

    const stamp = `${step.id}-${Date.now().toString(36)}`;
    const paths = {
      taskFile: join(this.runDir, `task-${stamp}.md`),
      outFile: join(this.runDir, `out-${stamp}.md`),
    };

    const verdict = await this.dispatch(step, taskText, targetDir, paths, {
      escalate: this.state.settings.escalateOnFail !== false,
    });
    this.recordOutput(step.id, verdict, paths);
    return verdict;
  }

  /**
   * Adversarial verifier step (skeptic). Renders its prompt against the
   * normal scope, dispatches a single run, then judges the verdict plus
   * the prior step's output by asking the model to RETURN ONLY a JSON
   * object: {ok: bool, concerns: [string], summary: string}. The step
   * records the parsed JSON in `state.outputs[step.id].verify` and the
   * step is `ok:true` only if the JSON parses AND ok===true.
   *
   * If no schema is provided we fall back to a plain run that writes
   * the prior output through the verify gate — the work is delivered
   * downstream unchanged.
   */
  async runVerify(step, scope) {
    this.enforceRequiredInputs(step.id);
    if (!step.review) {
      throw new Error(
        `verify step "${step.id}" needs a "review" path ` +
        `(e.g. review: "outputs.<priorStep>.outFile")`,
      );
    }
    const reviewedText = (() => {
      try {
        // `review` is a dotted path into the scope, NOT a template
        // (matches the design of `fanout.itemsFrom`). Resolve it the
        // same way — getPath is the official path accessor.
        const v = getPath(scope, step.review);
        if (typeof v !== 'string') {
          throw new Error(
            `review target "${step.review}" did not resolve to a file path ` +
            `(got ${typeof v})`,
          );
        }
        return readFileSync(v, 'utf8');
      } catch (err) {
        throw new Error(`verify "${step.id}" review target unreadable: ${err.message}`);
      }
    })();

    const stepTemplate = {
      lane: step.lane ?? 'analyze',
      addDir: step.addDir,
      prompt: (step.prompt ?? [
        'You are a skeptical reviewer. The file below is the work to review.',
        'Read it, then RETURN ONLY a single JSON object of the form',
        '{"ok": <true|false>, "concerns": [<string>...], "summary": <string>}.',
        'No prose, no markdown fences.',
        '',
        '---- BEGIN REVIEW TARGET ----',
        reviewedText,
        '---- END REVIEW TARGET ----',
      ].join('\n')),
    };
    const rendered = renderDeep(stepTemplate, scope);
    const taskText = rendered.prompt;
    const targetDir = rendered.addDir ? String(rendered.addDir).replace(/^~/, process.env.HOME ?? '') : process.cwd();

    const stamp = `${step.id}-${Date.now().toString(36)}`;
    const paths = {
      taskFile: join(this.runDir, `task-${stamp}.md`),
      outFile: join(this.runDir, `out-${stamp}.md`),
    };

    const verdict = await this.dispatch(step, taskText, targetDir, paths, {
      escalate: this.state.settings.escalateOnFail !== false,
    });

    let parsed = null;
    let parseError = null;
    try {
      const out = readFileSync(paths.outFile, 'utf8');
      const start = out.indexOf('{');
      const end = out.lastIndexOf('}');
      if (start >= 0 && end > start) {
        const j = JSON.parse(out.slice(start, end + 1));
        if (j && typeof j === 'object') parsed = j;
      }
    } catch (err) {
      parseError = err.message;
    }

    const ok = verdict.ok && !!parsed && parsed.ok === true;
    const verifyVerdict = {
      ok,
      keepOnClaude: false,
      why: ok
        ? 'verify ok'
        : parseError
          ? `verify json parse failed: ${parseError}`
          : !verdict.ok
            ? `verify dispatch failed: ${verdict.why}`
            : 'verify json returned ok:false',
      pick: verdict.pick,
      meta: verdict.meta,
      outFile: paths.outFile,
      taskFile: paths.taskFile,
      verify: parsed,
      contentUsableDespiteExit: verdict.contentUsableDespiteExit,
    };

    // Record into state.outputs the same way runSingle does, with
    // `verify` attached so downstream steps can reference concerns/summary.
    this.recordOutput(step.id, verifyVerdict, paths);
    // Augment with the parsed concerns/summary for the report.
    if (parsed) {
      this.state.outputs[step.id].verify = parsed;
      this.persist();
    }
    return verifyVerdict;
  }

  async runFanout(step, scope) {
    this.enforceRequiredInputs(step.id);
    // itemsFrom is a dotted path into the workflow state (NOT a
    // template). It can be either:
    //   - a real array reference: e.g. `inputs.items` — extractItems
    //     will resolve it via getPath and return the array.
    //   - a file path stored in a prior step's outFile: e.g.
    //     `outputs.discover.outFile` — extractItems will open that
    //     file and parse the JSON array inside.
    // The validator (validate.js) already ensures itemsFrom starts
    // with `inputs.` or `outputs.`, so the literal-string case (no
    // {{ }}) is exactly what we want.
    const items = extractItems(this.state, step.itemsFrom);
    const concurrency = Math.max(1, Math.min(
      step.concurrency ?? this.state.settings.concurrency ?? 4,
      this.state.settings.concurrency ?? Infinity,
    ));
    // Global cap is the limiter's capacity; per-fanout workers cannot
    // exceed it. The design doc claims R4 and this is the enforcement.
    const workerCap = Math.min(concurrency, this.limiter.permits);
    const results = new Array(items.length).fill(null);
    let cursor = 0;
    let failures = 0;
    const resumed = this.state.outputs?.[step.id]?.items ?? [];

    // R10: build a fingerprint map of prior results so resume is robust
    // against the items array changing between runs. Items are matched by
    // their sha1 fingerprint; if a prior result lacks a fingerprint (old
    // state.json) we fall back to positional alignment for THAT item only.
    const fpOf = (v) => createHash('sha1').update(JSON.stringify(v)).digest('hex').slice(0, 12);
    const resumedByFp = new Map();
    for (const r of resumed) {
      if (!r) continue;
      const fp = r.fingerprint ?? (r.item !== undefined ? fpOf(r.item) : null);
      if (fp) resumedByFp.set(fp, r);
    }

    const worker = async () => {
      while (cursor < items.length) {
        const i = cursor++;
        const item = items[i];
        const fp = fpOf(item);

        // R10: skip by fingerprint first; fall back to positional if
        // either side has no fingerprint (old state.json).
        const byFp = resumedByFp.get(fp);
        const byPos = resumed[i];
        const prev = (byFp && byFp.verdict?.ok === true)
          ? byFp
          : ((!byFp && byPos?.verdict?.ok === true) ? byPos : null);

        if (prev) {
          results[i] = { ...prev, item, fingerprint: fp };
          this.emit('item.skipped', { stepId: step.id, index: i, item, fingerprint: fp });
          continue;
        }

        const itemScope = { ...scope, item };
        let template;
        try {
          template = renderDeep(step.stepTemplate, itemScope);
        } catch (err) {
          results[i] = { verdict: { ok: false, why: err.message }, pool: null };
          failures++;
          this.emit('item.failed', { stepId: step.id, index: i, item, why: err.message });
          continue;
        }

        const stamp = `${step.id}-${i}-${Date.now().toString(36)}`;
        const paths = {
          taskFile: join(this.runDir, `task-${stamp}.md`),
          outFile: join(this.runDir, `out-${stamp}.md`),
        };

        const targetDir = template.addDir
          ? String(template.addDir).replace(/^~/, process.env.HOME ?? '')
          : process.cwd();
        const taskText = template.prompt
          ?? readFileSync(String(template.taskFile), 'utf8');

        this.emit('item.started', { stepId: step.id, index: i, total: items.length, item });
        const verdict = await this.dispatch(
          { ...step, id: `${step.id}[${i}]` },
          taskText, targetDir, paths,
          { item, escalate: this.state.settings.escalateOnFail !== false },
        );
        results[i] = { item, verdict, outFile: paths.outFile, fingerprint: fp };
        if (verdict.ok) {
          this.emit('item.completed', { stepId: step.id, index: i, pool: verdict.pick?.pool, wall: verdict.meta?.wallSec });
        } else {
          failures++;
          this.emit('item.failed', { stepId: step.id, index: i, why: verdict.why, pool: verdict.pick?.pool });
        }
        this.persist();
      }
    };

    // Worker count is min(per-fanout concap, global limiter permits,
    // items.length). The semaphore runWith() inside dispatch also acquires
    // a global permit; the worker cap is just how many dispatch loops we
    // start in parallel.
    const totalWorkers = Math.max(1, Math.min(workerCap, items.length));
    // Emit queued event for any work waiting behind the global cap.
    if (items.length > totalWorkers) {
      this.emit('step.blocked', { stepId: step.id, queued: items.length - totalWorkers });
    }
    await Promise.all(Array.from({ length: totalWorkers }, worker));

    const oks = results.filter((r) => r?.verdict?.ok === true).length;
    this.state.outputs[step.id] = {
      total: items.length,
      ok: oks,
      failed: items.length - oks,
      items: results,
    };
    this.persist();
    return { ok: failures === 0, results };
  }

  recordOutput(stepId, verdict, paths) {
    let outputText = null;
    let truncated = false;
    try {
      if (paths.outFile && existsSync(paths.outFile)) {
        const raw = readFileSync(paths.outFile, 'utf8');
        if (raw.length > OUTPUT_TEXT_CAP_BYTES) {
          outputText = raw.slice(0, OUTPUT_TEXT_CAP_BYTES);
          truncated = true;
        } else {
          outputText = raw;
        }
      }
    } catch { /* non-fatal */ }
    this.state.outputs[stepId] = {
      ok: verdict.ok,
      pool: verdict.pick?.pool ?? null,
      why: verdict.why,
      outFile: paths.outFile,
      wallSec: verdict.meta?.wallSec,
      outputText,
      outputTruncated: truncated || undefined,
    };
    this.persist();
  }
}

function renderTemplate0(str, scope) {
  return str.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, ref) => {
    const v = ref.trim().split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), scope);
    if (v === undefined) throw new Error(`unresolved ref {{${ref.trim()}}}`);
    return typeof v === 'string' ? v : JSON.stringify(v);
  });
}
