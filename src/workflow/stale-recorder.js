// Saves a running attempt's stale warnings in the run's events. The process
// that runs the attempts owns it (v2-runtime.js), so a run nobody watches
// still leaves a trace the scorecard can count. A watch prints these events
// and synthesizes its own warnings only for an older run that has none
// (watch-cli.js notableWatchEvents).
//
// Per attempt: `attempt.stale` at the first crossing (level 1) and at each
// further level (one per full progress window without progress), and
// `attempt.stale_cleared` when it shows progress again or its attempt ends.
// A scoring error is skipped, never allowed to break the attempt.
import { createStaleProbe } from '../lib/stale.js';
import { advanceStaleEpisode } from '../lib/stale-episodes.js';

export const STALE_RECORD_EVERY_MS = 30_000;

export function createStaleRecorder({
  runDir, emit, thresholds, probe = null, everyMs = STALE_RECORD_EVERY_MS, nowMs = Date.now,
} = {}) {
  const score = probe ?? createStaleProbe({ runDir, ...(thresholds ? { thresholds } : {}) });
  const episodes = new Map();
  const lastCheckAt = new Map();

  const cleared = (record, episode, atMs) => emit('attempt.stale_cleared', {
    actionId: record.actionId, attemptId: record.key, level: episode.level,
    staleSec: Math.max(0, Math.round((atMs - episode.since) / 1000)),
  });

  const attemptRecords = (state) => (state.attempts ?? []).map((attempt) => ({
    key: attempt.id ?? `${attempt.actionId}-${attempt.ordinal}`, actionId: attempt.actionId, attempt,
  }));

  return {
    /** Score every running attempt not scored within `everyMs`; emit what is due. */
    check(state, at = nowMs()) {
      const running = new Set();
      for (const record of attemptRecords(state)) {
        if (record.attempt.status !== 'running') continue;
        running.add(record.key);
        if (at - (lastCheckAt.get(record.key) ?? -Infinity) < everyMs) continue;
        lastCheckAt.set(record.key, at);
        try {
          const action = (state.program?.actions ?? []).find((entry) => entry.id === record.actionId) ?? null;
          const result = score({ attempt: record.attempt, action, state, nowMs: at });
          const { event, cleared: ended } = advanceStaleEpisode(episodes, record, result, at);
          if (ended) cleared(record, ended, at);
          if (event) emit(event.type, (({ type, ...rest }) => rest)(event));
        } catch { /* a scoring error never breaks the attempt */ }
      }
      for (const key of [...episodes.keys()]) {
        if (running.has(key)) continue;
        const episode = episodes.get(key);
        episodes.delete(key);
        lastCheckAt.delete(key);
        try { cleared({ key, actionId: key.replace(/-\d+$/, '') }, episode, at); } catch { /* skip */ }
      }
    },
    /** The attempt ended: close its open episode before `attempt.finished`. */
    finish(attemptId, actionId, at = nowMs()) {
      lastCheckAt.delete(attemptId);
      const episode = episodes.get(attemptId);
      if (!episode) return;
      episodes.delete(attemptId);
      try { cleared({ key: attemptId, actionId }, episode, at); } catch { /* skip */ }
    },
  };
}
