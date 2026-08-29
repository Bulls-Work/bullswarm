import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs';
import { isDeliveredWorkflowStatus } from './status.js';

const MAX_RESULT_BYTES = 1024 * 1024;
const CONTROL_KINDS = new Set(['decide', 'verify']);

export function buildWorkflowResult({ state, report, runId, shortId, ongoing }) {
  const ledger = Array.isArray(state?.actionLedger) ? state.actionLedger : [];
  const attempts = Array.isArray(state?.attempts) ? state.attempts : [];
  const deliveryAction = selectDeliveryAction(
    ledger,
    state?.outputs,
    state?.outcome?.deliveryActionId,
  );
  const deliveryAttempt = selectAttempt(attempts, deliveryAction?.id);
  const deliveryOutput = deliveryAction ? state?.outputs?.[deliveryAction.id] : null;
  const outFile = deliveryOutput?.outFile ?? deliveryAttempt?.outFile ?? null;
  const artifact = readDelivery(outFile, deliveryOutput);
  const verificationAction = selectVerificationAction(ledger, deliveryAction?.id);
  const verificationOutput = verificationAction ? state?.outputs?.[verificationAction.id] : null;
  const deliveryActions = selectDeliveryActions(
    ledger,
    state?.outputs,
    verificationAction,
    deliveryAction,
  );
  const deliveryRecord = (action) => {
    const attempt = selectAttempt(attempts, action.id);
    const output = state?.outputs?.[action.id];
    const path = output?.outFile ?? attempt?.outFile ?? null;
    const content = readDelivery(path, output);
    return {
      actionId: action.id,
      phase: action.phase ?? null,
      kind: action.kind ?? null,
      outFile: path,
      format: content.format,
      content: content.content,
      truncated: content.truncated,
      bytes: content.bytes,
    };
  };
  const finishedAttempts = attempts.filter(
    (attempt) => attempt?.finishedAt || isTerminalAttempt(attempt?.status),
  ).length;
  const actionCounts = attempts.map((attempt) => attempt?.actionCount);
  const knownToolCalls = actionCounts
    .filter((count) => Number.isFinite(count))
    .reduce((sum, count) => sum + count, 0);
  const missingToolCallAttempts = actionCounts.filter((count) => !Number.isFinite(count)).length;

  return {
    schemaVersion: 'bullswarm.workflow.result.v1',
    runId,
    shortId: shortId ?? state?.shortId ?? null,
    workflow: state?.workflow ?? null,
    goal: state?.intent?.goal ?? null,
    status: state?.status ?? (ongoing ? 'running' : 'unknown'),
    ready: !ongoing && isDeliveredWorkflowStatus(state?.status),
    verified: state?.outcome?.verified ?? state?.status === 'completed',
    outcome: state?.outcome ?? null,
    startedAt: state?.startedAt ?? report?.startedAt ?? null,
    finishedAt: state?.finishedAt ?? report?.finishedAt ?? null,
    summary: report?.summary ?? null,
    agentProgress: {
      completed: finishedAttempts,
      total: attempts.length,
    },
    logs: (Array.isArray(state?.steps) ? state.steps : []).map((step) => ({
      phase: step.phase ?? null,
      actionId: step.stepId ?? null,
      kind: step.type ?? null,
      status: step.ok === true ? 'succeeded' : step.ok === false ? 'failed' : 'unknown',
      summary: step.why ?? null,
    })),
    delivery: deliveryAction ? {
      actionId: deliveryAction.id,
      phase: deliveryAction.phase ?? null,
      kind: deliveryAction.kind ?? null,
      outFile,
      format: artifact.format,
      content: artifact.content,
      truncated: artifact.truncated,
      bytes: artifact.bytes,
    } : null,
    // Backward-compatible multi-delivery view. `delivery` remains the primary
    // artifact, while this frontier contains every independently completed
    // worker artifact covered by the selected final verifier.
    deliveries: deliveryActions.map(deliveryRecord),
    verification: verificationAction ? {
      actionId: verificationAction.id,
      outFile: verificationOutput?.outFile ?? selectAttempt(attempts, verificationAction.id)?.outFile ?? null,
      verdict: verificationOutput?.verify ?? null,
    } : null,
    totalTokens: state?.usage?.tokens?.totalKnown ?? null,
    tokenUsage: state?.usage?.tokens ?? null,
    totalToolCalls: {
      known: knownToolCalls,
      complete: missingToolCallAttempts === 0,
      attemptsMissingCount: missingToolCallAttempts,
    },
  };
}

function ancestorIds(ledger, action) {
  const byId = new Map(ledger.map((entry) => [entry?.id, entry]));
  const ancestors = new Set();
  const pending = [...(action?.dependsOn ?? [])];
  while (pending.length) {
    const id = pending.pop();
    if (ancestors.has(id)) continue;
    ancestors.add(id);
    pending.push(...(byId.get(id)?.dependsOn ?? []));
  }
  return ancestors;
}

function selectDeliveryActions(ledger, outputs, verificationAction, primary) {
  if (!primary) return [];
  const verifiedAncestors = ancestorIds(ledger, verificationAction);
  if (!verificationAction || !verifiedAncestors.has(primary.id)) return [primary];
  const candidates = ledger.filter(
    (action) => action?.id !== 'scout'
      && action?.status === 'succeeded'
      && !CONTROL_KINDS.has(action.kind)
      && outputs?.[action.id]?.ok !== false
      && verifiedAncestors.has(action.id),
  );
  const ancestorCache = new Map(candidates.map((action) => [action.id, ancestorIds(ledger, action)]));
  const frontier = candidates.filter(
    (action) => !candidates.some(
      (other) => other.id !== action.id && ancestorCache.get(other.id)?.has(action.id),
    ),
  );
  return frontier.length ? frontier : [primary];
}

function selectDeliveryAction(ledger, outputs, preferredActionId) {
  const succeeded = ledger.filter(
    (action) => action?.status === 'succeeded'
      && outputs?.[action.id]?.ok !== false,
  );
  const preferred = succeeded.find((action) => action.id === preferredActionId);
  if (preferred && !CONTROL_KINDS.has(preferred.kind)) return preferred;
  return [...succeeded].reverse().find((action) => !CONTROL_KINDS.has(action.kind)) ?? null;
}

function selectVerificationAction(ledger, deliveryId) {
  const verifications = ledger.filter(
    (action) => action?.status === 'succeeded' && action.kind === 'verify',
  );
  const byId = new Map(ledger.map((action) => [action?.id, action]));
  const coversDelivery = (action) => {
    if (!deliveryId) return false;
    const pending = [...(action?.dependsOn ?? [])];
    const seen = new Set();
    while (pending.length) {
      const id = pending.pop();
      if (id === deliveryId) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      pending.push(...(byId.get(id)?.dependsOn ?? []));
    }
    return false;
  };
  // Prefer the latest successful verifier that transitively covers the
  // delivery. A final suite verify commonly depends on unit verifiers rather
  // than directly on each worker; selecting only a direct edge hid the
  // strongest acceptance evidence in the stable caller envelope.
  return [...verifications].reverse().find(
    coversDelivery,
  ) ?? [...verifications].reverse()[0] ?? null;
}

function selectAttempt(attempts, actionId) {
  return [...attempts].reverse().find(
    (attempt) => attempt?.actionId === actionId && attempt.status === 'succeeded',
  ) ?? null;
}

function isTerminalAttempt(status) {
  return [
    'succeeded', 'failed', 'failed_retryable', 'failed_terminal',
    'timed_out', 'cancelled', 'aborted',
  ].includes(status);
}

function readDelivery(path, output) {
  if (!path) return inlineDelivery(output);
  if (!existsSync(path)) {
    return inlineDelivery(output);
  }
  const fd = openSync(path, 'r');
  try {
    const bytes = fstatSync(fd).size;
    const bytesToRead = Math.min(bytes, MAX_RESULT_BYTES);
    const buffer = Buffer.alloc(bytesToRead);
    let offset = 0;
    while (offset < bytesToRead) {
      const read = readSync(fd, buffer, offset, bytesToRead - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    const text = buffer.subarray(0, offset).toString('utf8');
    const truncated = bytes > bytesToRead;
    if (!truncated) {
      try {
        return { format: 'json', content: JSON.parse(text), truncated: false, bytes };
      } catch { /* text artifact */ }
    }
    return { format: 'text', content: text, truncated, bytes };
  } finally {
    closeSync(fd);
  }
}

function inlineDelivery(output) {
  if (!output) return { format: null, content: null, truncated: false, bytes: null };
  const content = output.items ?? output.outputText ?? output;
  if (typeof content === 'string') {
    const bytes = Buffer.byteLength(content);
    return {
      format: 'text',
      content: bytes > MAX_RESULT_BYTES ? Buffer.from(content).subarray(0, MAX_RESULT_BYTES).toString('utf8') : content,
      truncated: bytes > MAX_RESULT_BYTES,
      bytes,
    };
  }
  const text = JSON.stringify(content);
  const bytes = Buffer.byteLength(text);
  return bytes <= MAX_RESULT_BYTES
    ? { format: 'json', content, truncated: false, bytes }
    : {
        format: 'text',
        content: Buffer.from(text).subarray(0, MAX_RESULT_BYTES).toString('utf8'),
        truncated: true,
        bytes,
      };
}
