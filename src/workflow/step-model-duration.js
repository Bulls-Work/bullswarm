// How long an attempt ran: the attempt's own recorded duration, or its start
// to its finish (or to now while it is open).

import { finiteOrNull } from '../lib/num.js';
import { textOrNull, finiteMs, dateMs } from './step-model-values.js';

function durationMs(startedAt, finishedAt, nowMs = Date.now()) {
  const started = dateMs(startedAt);
  if (started == null) return null;
  const ended = dateMs(finishedAt) ?? (Number.isFinite(nowMs) ? nowMs : null);
  if (ended == null) return null;
  return Math.max(0, ended - started);
}

function durationFromAttempt(attempt, nowMs) {
  const explicit = finiteMs(attempt?.durationMs);
  if (explicit != null) return explicit;
  const wall = finiteOrNull(attempt?.wallSec);
  if (wall != null && wall >= 0) return wall * 1000;
  const status = String(attempt?.status ?? '').toLowerCase();
  const open = ['started', 'start', 'running', 'in_progress', 'in-progress'].includes(status);
  const finishedAt = textOrNull(attempt?.finishedAt) ?? textOrNull(attempt?.endedAt);
  if (finishedAt == null && !open) return null;
  return durationMs(attempt?.startedAt, finishedAt, nowMs);
}

export {
  durationFromAttempt,
};
