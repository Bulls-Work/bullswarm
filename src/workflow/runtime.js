// bullswarm workflow runtime — executes a validated workflow document.
//
// Doctrine:
//   R1. Dispatch reuses watchOnce verbatim — same verdict contract, same
//       quarantine side effects, same meter accounting as single runs.
//   R2. State persists to disk after EVERY step; resume = skip ok:true.
//   R3. Escalation is verdict-driven: failed step retries once on next pool
//       by surplus (never the same pool, never more than once).
//   R4. Concurrency limiter is global across fanout expansions.
//   R5. onError: continue | fail (abort run) | skip-phase (rest of phase).

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pickPool } from '../lib/route.js';
import { watchOnce } from '../lib/watch.js';
import { renderDeep, extractItems } from './template.js';

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
    this.limiter = null; // set from settings at run()
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
   */
  async dispatch(step, taskText, targetDir, paths, opts = {}) {
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

      this.emit('step.started', {
        stepId: step.id,
        item: opts.item,
        pool: conn.name,
        attempt,
      });

      const verdict = await watchOnce(conn, taskText, targetDir, paths, {
        timeoutSec: step.timeoutSec ?? conn.timeoutSec ?? 900,
      });

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
  }

  preparePools(step) {
    // Fresh eligible list per dispatch: enabled, not quarantined/exhausted.
    return this.pools.filter((p) => p.enabled !== false && !p.quarantine);
  }

  async runStep(step) {
    const scope = this.scopeFor(step);
    if (step.type === 'run') {
      return this.runSingle(step, scope);
    }
    if (step.type === 'fanout') {
      return this.runFanout(step, scope);
    }
    throw new Error(`unknown step type ${step.type}`);
  }

  async runSingle(step, scope) {
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

  async runFanout(step, scope) {
    const items = extractItems(this.state, renderTemplate0(step.itemsFrom, scope));
    const concurrency = Math.max(1, Math.min(
      step.concurrency ?? this.state.settings.concurrency ?? 4,
      this.state.settings.concurrency ?? Infinity,
    ));
    const results = new Array(items.length).fill(null);
    let cursor = 0;
    let failures = 0;
    const resumed = this.state.outputs?.[step.id]?.items ?? [];

    const worker = async () => {
      while (cursor < items.length) {
        const i = cursor++;
        const item = items[i];

        // Resume: skip items whose saved verdict is ok:true (R2)
        const prev = resumed[i];
        if (prev?.verdict?.ok === true) {
          results[i] = prev;
          this.emit('item.skipped', { stepId: step.id, index: i, item });
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
        results[i] = { item, verdict, outFile: paths.outFile };
        if (verdict.ok) {
          this.emit('item.completed', { stepId: step.id, index: i, pool: verdict.pick?.pool, wall: verdict.meta?.wallSec });
        } else {
          failures++;
          this.emit('item.failed', { stepId: step.id, index: i, why: verdict.why, pool: verdict.pick?.pool });
        }
        this.persist();
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));

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
    try {
      if (paths.outFile && existsSync(paths.outFile)) {
        outputText = readFileSync(paths.outFile, 'utf8');
      }
    } catch { /* non-fatal */ }
    this.state.outputs[stepId] = {
      ok: verdict.ok,
      pool: verdict.pick?.pool ?? null,
      why: verdict.why,
      outFile: paths.outFile,
      wallSec: verdict.meta?.wallSec,
      outputText,
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
