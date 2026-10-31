// Stale-warning episodes: when an attempt first looks stale, the warning level
// as it stays stale (one more per full progress window), and the event each
// warning is. Shared by the process that runs the attempts (it saves each
// warning as an `attempt.stale` event) and by `workflow watch` (it prints the
// recorded ones, and synthesizes its own only for a run that records none).
import { DEFAULT_STALE_THRESHOLDS } from './stale.js';

// One stale episode the watcher reported: when it went stale, the warning
// level printed so far, when its clock started (the stale time, or the last
// progress seen while it stayed stale) and the level it had then, and the
// progress it had then. Progress while still stale restarts the clock, not
// the level: the next warning is one level higher than the last.
export function staleEpisode(score, baseAt, baseLevel = 1) {
  return {
    since: score.staleSince ?? baseAt,
    level: baseLevel,
    baseAt,
    baseLevel,
    progressAt: Number.isFinite(score.progressAt) ? score.progressAt : null,
    windowMs: staleWindowMs(score),
  };
}

// The episode a watcher that first sees a stale attempt at `atMs` holds, as
// one there all along would: the levels due from the stale time up to the
// last progress the attempt made while stale, then the clock restarted at
// that progress, at that level, and the level due at `atMs`. Only the last
// progress is known. A file change is rare, so the stale time up to it is
// taken as one silent stretch (the level due then): with two or more changes
// while stale that can put it a level above what an all-along watcher
// printed, never below. Output is not rare: a step stale for another reason
// (the same command again, running over its time) keeps printing, so no
// window is taken to have passed without it and the level at that progress
// is 1. With sparse output that can repeat a level a predecessor printed; it
// never skips one, and never prints "warning 4 · no output for 5s".
export function staleEpisodeSeenAt(score, fallback, atMs) {
  const since = score.staleSince ?? fallback;
  const first = staleEpisode(score, since);
  const progressAt = Number.isFinite(score.progressAt) && score.progressAt > since ? score.progressAt : null;
  const levelAtProgress = progressAt == null || score.progressBy === 'output' ? 1 : staleLevelAt(first, progressAt);
  const entry = progressAt == null ? first : staleEpisode(score, progressAt, levelAtProgress);
  entry.level = staleLevelAt(entry, atMs);
  return entry;
}

// The repeat window: the progress window the score names, else quiet's.
export function staleWindowMs(score) {
  const sec = Number(score?.progressWindowSec);
  return (Number.isFinite(sec) && sec > 0 ? sec : DEFAULT_STALE_THRESHOLDS.quietSec) * 1000;
}

// Level 1 at the first warning, one more per full window without progress
// (counted from the level the clock last restarted at).
export function staleLevelAt(entry, nowMs) {
  return (entry.baseLevel ?? 1) + Math.max(0, Math.floor((nowMs - entry.baseAt) / entry.windowMs));
}

// The attempt.stale event for one warning. Level and the time without
// progress were added after `reasons`, `score` and `staleSince` (0.38.12).
export function staleEvent(record, score, level, nowMs) {
  const progressAt = Number.isFinite(score.progressAt) ? score.progressAt : null;
  return {
    type: 'attempt.stale', actionId: record.actionId, attemptId: record.key,
    pool: record.attempt.pool ?? null, model: record.attempt.model ?? null,
    score: score.score, reasons: score.reasons,
    staleSince: score.staleSince == null ? null : new Date(score.staleSince).toISOString(),
    level,
    noProgressSec: progressAt == null ? null : Math.max(0, Math.round((nowMs - progressAt) / 1000)),
    ...(score.progressBy ? { progressBy: score.progressBy } : {}),
  };
}

/**
 * Advance one attempt's episode on a new stale score. `episodes` maps the
 * attempt key to its episode and is mutated. Returns `{ event, cleared }`:
 * `event` is the warning due now (an attempt.stale payload) or null; `cleared`
 * is the episode that just ended (no longer stale), else null. Progress while
 * still stale restarts the clock without a warning (the next is one level
 * higher); a reading that is no longer stale ends the episode, so a later one
 * warns from level 1 again.
 */
export function advanceStaleEpisode(episodes, record, score, nowMs) {
  const none = { event: null, cleared: null };
  const reported = episodes.get(record.key);
  if (reported) {
    if (!score) return none;
    const progressed = Number.isFinite(score.progressAt) && reported.progressAt != null
      && score.progressAt > reported.progressAt;
    if (progressed) {
      if (score.stale) {
        episodes.set(record.key, { ...staleEpisode(score, nowMs, reported.level), since: reported.since });
        return none;
      }
      episodes.delete(record.key);
      return { event: null, cleared: reported };
    }
    // No longer stale, progress or not: the episode ended, and a later stale
    // reading is a new one that warns from level 1 ("looks stale", never
    // "still" across a time it was not stale).
    if (!score.stale) { episodes.delete(record.key); return { event: null, cleared: reported }; }
    const level = staleLevelAt(reported, nowMs);
    if (level <= reported.level) return none;
    episodes.set(record.key, { ...reported, level });
    return { event: staleEvent(record, score, level, nowMs), cleared: null };
  }
  if (!score?.stale) return none;
  // First seen now: one warning, at the level due now (a watcher that attaches
  // windows after the step went stale does not print level 1 and then level 2
  // a poll later).
  const entry = staleEpisodeSeenAt(score, nowMs, nowMs);
  episodes.set(record.key, entry);
  return { event: staleEvent(record, score, entry.level, nowMs), cleared: null };
}
