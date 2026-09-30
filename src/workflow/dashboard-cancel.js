// Asking a run to stop: the operator's cancellation request, written for the
// kernel to honour (requestCancel).
import { V2_TERMINAL_STATUSES } from './status.js';
import { existsSync } from 'node:fs';
import { readJsonForUpdate, writeJsonAtomic } from '../lib/fsjson.js';
import { join } from 'node:path';
import { resolveRunId, isLegacyRunState } from './short-id.js';
import { appendEvent } from './events.js';

export function requestCancel(bullswarmDir, token, { source = 'api', requesterPid = process.pid } = {}) {
  const resolved = resolveRunId(bullswarmDir, token);
  if (!resolved) throw new Error(`no run found for "${token}"`);
  const statePath = join(resolved.runDir, 'state.json');
  if (!existsSync(statePath)) throw new Error(`run "${token}" has no state.json`);
  const state = readJsonForUpdate(statePath, 'workflow state');
  // A legacy run has no kernel to ask, so nothing is written and nothing is
  // claimed: the caller is told what it is and left alone.
  if (isLegacyRunState(state)) return { ...resolved, legacy: true, alreadyFinished: true };
  if (V2_TERMINAL_STATUSES.has(state.lifecycle.status)) return { ...resolved, state, alreadyFinished: true };
  const requestedAt = new Date().toISOString();
  state.cancellation = {
    requested: true,
    requestedAt,
    reason: 'operator requested stop',
    source,
    requesterPid,
  };
  appendEvent(resolved.runDir, state, 'workflow.cancellation_requested', {
    requestedAt,
    reason: state.cancellation.reason,
    source,
    requesterPid,
  });
  // The operator owns this intent file; only the kernel owns state.json.
  writeJsonAtomic(join(resolved.runDir, 'cancellation.json'), state.cancellation);
  return { ...resolved, state, alreadyFinished: false };
}
