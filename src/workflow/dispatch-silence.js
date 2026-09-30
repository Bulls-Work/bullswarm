// How long a worker may stay silent before its attempt is stopped as
// `stalled`: the configured clock, or for a free pool the spend-derived
// threshold from its recorded rung median (v2-dispatch.js applies it).
import { rungRecord } from '../lib/strategy.js';
import { MIN_DURATION_SAMPLES, MIN_EXPECTED_MINUTES } from '../lib/spend.js';

// A worker that writes nothing at all for this long is stalled: its process is
// stopped and the attempt fails as `stalled`. Metered failures use the bounded
// mechanical retry allowance; a free stall can advance through each untried
// eligible pool once without spending that allowance. It bounds silence, not
// run time: the clock restarts on every byte, so an agent that keeps working is
// never cut off. Without it one hung worker kept its whole run open forever.
export const DEFAULT_WORKER_SILENCE_SEC = 60 * 60;
// A free pool is stopped after one recorded rung median of silence. The floor
// remains the spend model's minimum assignment length; callers may pass an
// explicit silenceTimeoutSec (including a short fixture value) to override the
// derived threshold for a probe or operator-directed run.
export const FREE_STALL_P50_FACTOR = 1;

export function workerSilenceTimeoutSec(env = process.env) {
  const raw = Number(env?.BULLSWARM_WORKER_SILENCE_SEC);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_WORKER_SILENCE_SEC;
}

function recordedRung(decisionLog, poolName, effort) {
  // A stall is a transport failure, not a real duration sample. Excluding it
  // here keeps the free-pool threshold from tightening after each timeout even
  // when an older strategy.js has not yet applied the same guard.
  const usable = (decisionLog ?? []).filter((entry) => entry?.failureKind !== 'stalled');
  return rungRecord(usable, poolName, effort);
}

export function attemptSilenceTimeoutSec(pool, effort, decisionLog, configuredSilenceSec, explicitOverride = false) {
  if (pool?.free !== true) return configuredSilenceSec;
  const configured = Number(configuredSilenceSec);
  // An explicit value is an operator/test override. The default 3600-second
  // watcher clock is replaced by the spend-derived free-pool threshold below.
  if (explicitOverride && Number.isFinite(configured) && configured > 0) {
    return configured;
  }
  const rung = recordedRung(decisionLog, pool.name, effort);
  const trusted = rung && rung.dispatches >= MIN_DURATION_SAMPLES && rung.medianMinutes != null;
  const medianSec = trusted
    ? Math.round(Number(rung.medianMinutes) * 60 * FREE_STALL_P50_FACTOR)
    : 0;
  return Math.max(MIN_EXPECTED_MINUTES * 60, medianSec);
}
