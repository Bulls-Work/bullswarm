// bullswarm workflow terminal UX — renders runtime events Claude-style.
//
// Marks: ✓ ok · ✗ fail · ⟡ running · ⋈ blocked · ⏭ skipped · ⏳ phase
// Non-TTY: emits compact JSONL lines instead (machine-consumable).
// Zero dependencies: plain ANSI, cursor-rewrites only for the spinner.

const MARK = {
  ok: '✓',
  fail: '✗',
  running: '⟡',
  blocked: '⋈',
  skipped: '⏭',
  pending: '·',
};
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

function c(code, s) { return `${code}${s}${RESET}`; }
function fmtSecs(ms) {
  if (ms == null) return '—';
  const s = ms / 1000;
  return s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${s.toFixed(1)}s`;
}

export class WorkflowTui {
  constructor({ quiet = false, json = false } = {}) {
    this.quiet = quiet;
    this.json = json;
    this.isTTY = process.stdout.isTTY === true;
    this.phaseIndex = 0;
    this.phaseTotal = 0;
    this.phaseName = '';
    this.spinnerTimer = null;
    this.spinFrame = 0;
    this.liveLine = null;      // current in-flight line to rewrite
    this.counts = { ok: 0, fail: 0 };
    this.startedAt = null;
    // The durable terminal event (`run.completed`, or the legacy
    // `run.completed_with_concerns`) carries the outcome envelope and lands on
    // this same sink just before `workflow.completed`.
    this.outcome = null;
    if (!this.json && !this.isTTY) {
      // Non-TTY human mode: no ANSI colors (plain marks still readable)
      this.color = false;
    }
  }

  c(code, s) { return this.isTTY ? c(code, s) : s; }

  startSpinner() {
    if (!this.isTTY || this.json || this.spinnerTimer) return;
    this.spinnerTimer = setInterval(() => {
      this.spinFrame = (this.spinFrame + 1) % SPINNER_FRAMES.length;
      if (this.liveLine) this.rewriteLive(this.liveLine.render());
    }, 120);
  }

  stopSpinner() {
    if (this.spinnerTimer) { clearInterval(this.spinnerTimer); this.spinnerTimer = null; }
  }

  rewriteLive(line) {
    if (!this.isTTY) return;
    process.stdout.write(`\r\x1b[K${line}`);
  }

  commitLive() {
    if (this.liveLine) {
      if (this.isTTY) process.stdout.write('\n');
      this.liveLine = null;
    }
  }

  print(line) {
    if (this.json) return;
    if (this.quiet && !line.includes('summary')) return;
    this.commitLive();
    console.log(line);
  }

  handle(event) {
    if (event.outcome) this.outcome = event.outcome;
    switch (event.type) {
      case 'workflow.started': {
        this.startedAt = Date.now();
        if (this.json) {
          console.log(JSON.stringify({ ev: 'workflow.started', ...event }));
          return;
        }
        const resumed = event.resumed ? this.c(YELLOW, ' (resumed)') : '';
        this.print('');
        this.print(this.c(BOLD, `bullswarm workflow · ${event.workflow} · run ${event.runId}`) + resumed);
        this.print(this.c(DIM, `─`.repeat(58)));
        break;
      }
      case 'phase.started': {
        this.phaseIndex = event.index + 1;
        this.phaseTotal = event.total;
        this.phaseName = event.name;
        if (this.json) {
          console.log(JSON.stringify({ ev: 'phase.started', ...event }));
          return;
        }
        this.print('');
        this.print(this.c(CYAN, `▐ phase ${event.index + 1}/${event.total} · ${event.name}`));
        break;
      }
      case 'step.started': {
        if (this.json) {
          console.log(JSON.stringify({ ev: 'step.started', ...event }));
          return;
        }
        const label = event.item != null ? `${event.stepId}[${labelOf(event.item)}]` : event.stepId;
        this.commitLive();
        this.liveLine = makeLiveLine(MARK.running, label, event.pool, this);
        this.rewriteLive(this.liveLine.render());
        this.startSpinner();
        break;
      }
      case 'item.started': {
        if (this.json) {
          console.log(JSON.stringify({ ev: 'item.started', ...event }));
          return;
        }
        const idx = `${event.index + 1}/${event.total ?? '?'}`;
        const label = `${event.stepId}[${idx}]`;
        this.commitLive();
        this.liveLine = makeLiveLine(MARK.running, label, event.pool ?? '…', this, itemPreview(event.item));
        this.rewriteLive(this.liveLine.render());
        this.startSpinner();
        break;
      }
      case 'item.completed': {
        this.counts.ok++;
        if (this.json) {
          console.log(JSON.stringify({ ev: 'item.completed', ...event }));
          return;
        }
        const label = `${event.stepId}[${event.index + 1}]`;
        this.commitLive();
        this.print(
          `  ${this.c(GREEN, MARK.ok)} ${label.padEnd(34)} ${this.c(DIM, String(event.pool ?? '').padEnd(14))} ${fmtSecs(event.wall * 1000)}   ok`
        );
        break;
      }
      case 'item.failed': {
        this.counts.fail++;
        if (this.json) {
          console.log(JSON.stringify({ ev: 'item.failed', ...event }));
          return;
        }
        const label = `${event.stepId}[${event.index + 1}]`;
        this.commitLive();
        const pool = event.pool ? `${event.pool}` : '—';
        this.print(
          `  ${this.c(RED, MARK.fail)} ${label.padEnd(34)} ${pool.padEnd(14)} fail · ${(event.why ?? '').slice(0, 48)}`
        );
        break;
      }
      case 'step.escalate': {
        if (this.json) {
          console.log(JSON.stringify({ ev: 'step.escalate', ...event }));
          return;
        }
        this.commitLive();
        this.print(`    ${this.c(YELLOW, '↳ escalate')} ${event.from} → next surplus pool (${(event.why ?? '').slice(0, 40)})`);
        break;
      }
      case 'step.skipped': {
        if (this.json) { console.log(JSON.stringify({ ev: 'step.skipped', ...event })); return; }
        this.print(`  ${this.c(YELLOW, MARK.skipped)} ${event.stepId.padEnd(34)} ${this.c(DIM, 'ok from previous run (resume)')}`);
        break;
      }
      case 'item.skipped': {
        if (this.json) { console.log(JSON.stringify({ ev: 'item.skipped', ...event })); return; }
        const idx = `${(event.index ?? 0) + 1}`;
        const label = `${event.stepId}[${idx}]`;
        this.commitLive();
        this.print(
          `  ${this.c(YELLOW, MARK.skipped)} ${label.padEnd(34)} ${this.c(DIM, 'ok from previous run (resume)')}`
        );
        break;
      }
      case 'step.blocked': {
        if (this.json) { console.log(JSON.stringify({ ev: 'step.blocked', ...event })); return; }
        this.commitLive();
        this.print(
          `    ${this.c(YELLOW, MARK.blocked)} ${event.queued ?? 0} item(s) queued behind concurrency cap in ${event.stepId}`,
        );
        break;
      }
      case 'workflow.large': {
        if (this.json) { console.log(JSON.stringify({ ev: 'workflow.large', ...event })); return; }
        this.commitLive();
        this.print(
          `  ${this.c(YELLOW, '⚠')} Large workflow: ${event.dispatchCount} dispatches ≥ threshold ${event.threshold}. Open /workflows to stop if needed.`,
        );
        break;
      }
      case 'workflow.agent_target_exceeded': {
        if (this.json) { console.log(JSON.stringify({ ev: 'workflow.agent_target_exceeded', ...event })); return; }
        this.commitLive();
        this.print(
          `  ${this.c(YELLOW, '◇')} Advisory agent target exceeded: ${event.dispatchCount}/${event.target} dispatches (${event.overTargetBy} over). Required work continues.`,
        );
        break;
      }
      case 'phase.skipped-rest': {
        if (this.json) { console.log(JSON.stringify({ ev: 'phase.skipped-rest', ...event })); return; }
        this.commitLive();
        this.print(`  ${this.c(YELLOW, MARK.skipped)} rest of phase "${event.phase}" skipped after ${event.stepId}`);
        break;
      }
      case 'phase.completed': {
        this.stopSpinner();
        this.commitLive();
        if (this.json) { console.log(JSON.stringify({ ev: 'phase.completed', ...event })); return; }
        const mark = event.failed ? this.c(RED, MARK.fail) : this.c(GREEN, MARK.ok);
        this.print(`${mark} phase ${this.phaseIndex}/${this.phaseTotal} · ${event.name} done${event.failed ? this.c(YELLOW, ' (with failures)') : ''}`);
        break;
      }
      case 'workflow.completed': {
        this.stopSpinner();
        this.commitLive();
        if (this.json) {
          console.log(JSON.stringify({ ev: 'workflow.completed', ...event }));
          return;
        }
        const elapsed = this.startedAt ? fmtSecs(Date.now() - this.startedAt) : '—';
        const s = event.report ?? {};
        this.print('');
        this.print(this.c(DIM, '─'.repeat(58)));
        const outcome = event.outcome ?? this.outcome;
        const concernCount = outcome?.concerns?.length ?? 0;
        // A legacy run dir replayed without an outcome envelope: its status
        // string is the only record that concerns were raised.
        const legacyConcerns = event.status === 'completed_with_concerns'
          && !Array.isArray(outcome?.concerns);
        const bestEffort = outcome?.bestEffort === true && outcome?.verified !== true;
        const concerns = concernCount
          ? ` · ${concernCount} concern${concernCount === 1 ? '' : 's'}`
          : legacyConcerns ? ' with concerns' : '';
        const status = isDeliveredStatus(event.status)
          ? bestEffort
            ? this.c(YELLOW, `! best-effort delivery, unverified${concerns}`)
            : concerns
              ? this.c(YELLOW, `! completed${concerns}`)
              : this.c(GREEN, '✓ completed')
          : event.status === 'blocked'
            ? this.c(YELLOW, '⧖ blocked with final outcome')
            : this.c(RED, `✗ ${event.status ?? 'failed'}`);
        this.print(
          `${status}  steps ✓${s.stepsOk ?? 0}/✗${s.stepsFailed ?? 0} · fanout ✓${s.fanoutOk ?? 0}/✗${s.fanoutFailed ?? 0} · elapsed ${elapsed}`
        );
        if (event.runId) this.print(this.c(DIM, `report: ~/.bullswarm/workflows/${event.runId}/report.json`));
        break;
      }
      default:
        if (this.json) console.log(JSON.stringify({ ev: event.type, ...event }));
    }
  }
}

// `completed_with_concerns` is a legacy terminal status; new runs deliver as
// `completed` and state their concerns in the outcome envelope.
function isDeliveredStatus(status) {
  return status === 'completed' || status === 'completed_with_concerns';
}

function makeLiveLine(markChar, label, pool, tui, preview) {
  const start = Date.now();
  const render = () => {
    const frame = tui.isTTY ? SPINNER_FRAMES[tui.spinFrame] : MARK.pending;
    const secs = ((Date.now() - start) / 1000).toFixed(0);
    const pv = preview ? ` ${tui.c(DIM, preview)}` : '';
    return `  ${tui.c(CYAN, frame)} ${String(label).padEnd(34)} ${String(pool).padEnd(14)} ${secs}s running${pv}`;
  };
  return { render };
}

function itemPreview(item) {
  if (item == null) return '';
  const s = typeof item === 'string' ? item : JSON.stringify(item);
  return s.length > 40 ? `${s.slice(0, 38)}…` : s;
}

function labelOf(item) {
  const s = typeof item === 'string' ? item : JSON.stringify(item);
  return s.length > 20 ? `${s.slice(0, 18)}…]` : s;
}
