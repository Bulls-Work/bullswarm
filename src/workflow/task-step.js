// Adapt a standalone `bullswarm run` ledger record to the Step projection.
//
// A task record is deliberately smaller than a workflow action.  This module
// supplies only facts that the record (or its persisted artifacts) actually
// carries and leaves workflow, verification, and missing technical fields
// unavailable.  The adapter accepts either the normalized row from
// src/lib/tasks.js, a raw decision-log record, or a path to a JSON record.

import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';

import { stepPageModel } from './step-model.js';

function text(value) {
  if (value == null) return null;
  const result = String(value).trim();
  return result || null;
}

function finite(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function clone(value) {
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => clone(entry));
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)]));
}

function readJson(path) {
  if (!path || !existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function within(root, candidate) {
  if (!root || !candidate) return false;
  const rootPath = join(root);
  const relativePath = relative(rootPath, candidate);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function artifactRoot(record, options, recordPath) {
  const explicit = options.runsDir ?? options.artifactRoot ?? options.runDir
    ?? record?.runsDir ?? record?.artifactRoot ?? record?.runDir;
  if (explicit) return String(explicit);
  if (record?.homeDir) return join(String(record.homeDir), 'runs');
  if (recordPath) return dirname(recordPath);
  return null;
}

/**
 * Resolve an artifact without escaping a copied-home inspection root.
 *
 * Absolute paths from a copied state file still point at the source home.
 * When a root is supplied, only a path inside that root or a same-basename
 * sibling is accepted.  This keeps a snapshot read-only and prevents an
 * adapter from following a live ~/.bullswarm path by accident.
 */
function artifactPath(value, root) {
  const source = text(value);
  if (!source) return null;
  if (!root) return source;
  const candidate = isAbsolute(source) ? source : join(root, source);
  if (existsSync(candidate) && within(root, candidate)) return candidate;
  const sibling = join(root, basename(source));
  if (existsSync(sibling)) return sibling;
  // Keep the path visible in the model, but point it at the inspection root
  // when the source file was not copied.  The Step model will mark it
  // unavailable instead of reading outside the root.
  return join(root, basename(source));
}

function recordFrom(input, options = {}) {
  if (typeof input === 'string') {
    const recordPath = input;
    const parsed = readJson(recordPath) ?? {};
    return {
      record: parsed.task && typeof parsed.task === 'object' ? parsed.task
        : parsed.record && typeof parsed.record === 'object' ? parsed.record : parsed,
      recordPath,
    };
  }
  const value = input && typeof input === 'object' ? input : {};
  const recordPath = text(options.recordPath ?? value.recordPath ?? value.jsonPath ?? value.path);
  if (recordPath && (value.record == null || value.task == null)) {
    const parsed = readJson(recordPath);
    if (parsed) {
      return {
        record: parsed.task && typeof parsed.task === 'object' ? parsed.task
          : parsed.record && typeof parsed.record === 'object' ? parsed.record : parsed,
        recordPath,
      };
    }
  }
  return {
    record: value.record && typeof value.record === 'object' ? value.record
      : value.task && typeof value.task === 'object' ? value.task : value,
    recordPath,
  };
}

function statusFor(record) {
  const explicit = text(record?.status ?? record?.state);
  if (explicit) return explicit.toLowerCase();
  if (record?.ok === true) return 'succeeded';
  if (record?.ok === false) return 'failed';
  const started = text(record?.startedAt);
  const ended = text(record?.endedAt ?? record?.finishedAt);
  if (started && !ended) return 'running';
  return 'unknown';
}

function artifactValue(record, names, root) {
  for (const name of names) {
    if (record && Object.hasOwn(record, name) && record[name] != null) {
      return artifactPath(record[name], root);
    }
  }
  return null;
}

function taskId(record, recordPath, taskFile) {
  return text(record?.id)
    ?? text(record?.taskId)
    ?? (recordPath ? basename(recordPath).replace(/\.[^.]+$/, '') : null)
    ?? (taskFile ? basename(taskFile).replace(/^task-/, '').replace(/\.[^.]+$/, '') : null)
    ?? 'task';
}

// History and Runs keep authored task ids intact, but reduce UUID-backed ids
// to their stable eight-character tail (the same value a reader can use to
// identify the row).  Keep this separate from the internal action id: stream
// and artifact paths may still use the full source id.
function taskDisplayId(record) {
  const value = text(record?.id)
    ?? text(record?.taskFile)
    ?? 'task';
  return value.length > 14 ? value.slice(-8) : value;
}

/**
 * Build the row shape consumed by stepPageModel.
 *
 * This is intentionally exported separately so callers that need to inspect
 * the normalized input can do so without rendering a page.
 */
export function taskStepInput(input, options = {}) {
  const { record: raw, recordPath } = recordFrom(input, options);
  const record = raw && typeof raw === 'object' ? raw : {};
  const root = artifactRoot(record, options, recordPath);
  const taskFile = artifactValue(record, ['taskFile', 'taskPath', 'task'], root);
  const outputFile = artifactValue(record, ['outFile', 'outputFile', 'outputPath', 'output'], root);
  const streamFile = artifactValue(record, ['streamFile', 'eventStream', 'streamPath', 'stream'], root)
    ?? artifactValue(record.meta ?? {}, ['streamFile', 'eventStream', 'streamPath', 'stream'], root);
  const resultFile = artifactValue(record, ['resultFile', 'resultPath'], root);
  const id = taskId(record, recordPath, taskFile);
  const displayId = taskDisplayId(record);
  const status = statusFor(record);
  const startedAt = text(record.startedAt);
  const finishedAt = text(record.endedAt ?? record.finishedAt);
  const lane = text(record.lane ?? record.routing?.lane);
  const effort = text(record.effort ?? record.routing?.effort);
  const action = {
    id,
    status,
    attempts: 1,
    purpose: text(record.purpose),
    prompt: text(record.prompt),
    lane,
    effort,
    startedAt,
    finishedAt,
    outputFile,
  };
  const attempt = {
    id: `${id}-1`,
    actionId: id,
    ordinal: 1,
    status,
    pool: text(record.pool ?? record.picked ?? record.pick?.pool ?? record.meta?.pool),
    model: text(record.model ?? record.pick?.model ?? record.meta?.model),
    effort,
    lane,
    startedAt,
    finishedAt,
    durationMs: finite(record.durationMs),
    wallSec: finite(record.wallSec),
    taskFile,
    outputFile,
    outFile: outputFile,
    streamFile,
    reasoning: clone(record.reasoning ?? record.meta?.reasoning ?? null),
    routing: record.routing && typeof record.routing === 'object'
      ? clone(record.routing)
      : { lane, effort },
    usage: clone(record.usage ?? record.meta?.usage ?? null),
    failureKind: text(record.failureKind),
    failureReason: (record.ok === false || status === 'failed' || status === 'error')
      ? text(record.failureReason ?? record.why ?? record.reason)
      : null,
  };
  // Keep the run directory null for the generic Step extraction seam.  All
  // artifact paths above are already resolved, and a null root prevents the
  // workflow convention from inventing a stream path for tasks that did not
  // persist one.
  const state = {
    runId: `task:${id}`,
    shortId: displayId,
    workflow: null,
    project: text(record.project ?? record.projectName),
    intent: { goal: text(record.goal) },
    lifecycle: {
      status,
      startedAt,
      finishedAt,
      resultFile,
    },
    planner: { status: 'unavailable', attempts: [], turns: 0 },
    program: { actions: [action] },
    actions: [action],
    attempts: [attempt],
    presentation: { stages: [{ id: 'task', label: 'Task', actionIds: [id], startedAt, completedAt: finishedAt }] },
    outputs: outputFile ? { [id]: { outFile: outputFile } } : {},
    ledger: { requirements: {} },
  };
  return {
    row: {
      runId: state.runId,
      shortId: state.shortId,
      runDir: null,
      project: state.project,
      state,
    },
    pools: [],
    taskRecord: clone(record),
    taskRecordPath: recordPath,
    artifactRoot: root,
  };
}

/** Build the shared Step model from a standalone task record. */
export function taskStepModel(input, {
  nowMs = Date.now(),
  view = 'overview',
  expandedTurn = null,
  ...options
} = {}) {
  const normalized = input?.row?.state && Object.hasOwn(input, 'taskRecord')
    ? input
    : taskStepInput(input, options);
  const model = stepPageModel(normalized, {
    nowMs,
    view,
    expandedTurn,
    selectedEventIndex: options.selectedEventIndex ?? null,
    attemptOrdinal: options.attemptOrdinal ?? null,
    activityFilter: options.activityFilter ?? options.filter ?? 'all',
    follow: options.follow ?? options.followTail ?? true,
  });
  const record = normalized.taskRecord ?? {};
  const lane = text(record.lane ?? record.routing?.lane);
  const taskName = lane ? `${lane} task` : 'task';
  const displayId = taskDisplayId(record);
  const reason = text(record.reason ?? (record.ok === false ? record.why : null));
  model.taskRecord = normalized.taskRecord;
  model.taskRecordPath = normalized.taskRecordPath;
  model.taskRoot = normalized.artifactRoot;
  model.taskResult = reason;
  model.identity.project = normalized.row.project;
  model.identity.goal = text(record.goal);
  // A standalone task has no workflow action name.  Give the shared Step
  // header the same identity grammar as the Runs row instead of exposing the
  // full UUID (or the old six-character prefix).
  model.identity.actionId = taskName;
  model.identity.shortId = displayId;
  model.presentation.header.actionId = taskName;
  model.presentation.header.shortId = displayId;
  model.stepHeader = model.presentation.header;
  // A standalone task has no workflow result envelope or verification ledger.
  // Preserve the generic execution status, but explicitly clear the fields
  // that the task record cannot prove.
  model.identity.workflowStatus = null;
  model.verdict.workflow = { ...model.verdict.workflow, status: null, terminal: false };
  model.verdict.workflowStatus = null;
  model.verdict.verification = {
    ...model.verdict.verification,
    verdict: null,
    available: false,
    reason: null,
    requirements: [],
  };
  model.verification = model.verdict.verification;
  model.workflow = { ...model.workflow, status: null, terminal: false };
  model.resultBlock = {
    ...model.resultBlock,
    taskReason: reason,
    artifacts: {
      ...model.resultBlock.artifacts,
      runDir: normalized.artifactRoot ?? null,
      record: normalized.taskRecordPath ?? null,
    },
    outcome: {
      ...model.resultBlock.outcome,
      reason,
      workflow: { ...model.resultBlock.outcome.workflow, status: null, terminal: false },
      verification: model.verdict.verification,
      requirements: [],
    },
  };
  model.resultView = model.resultBlock;
  model.outcomeModel = {
    ...model.outcomeModel,
    reason,
    workflow: { ...model.outcomeModel.workflow, status: null, terminal: false },
    verification: model.verdict.verification,
    requirements: [],
  };
  model.artifacts = {
    ...model.artifacts,
    runDir: normalized.artifactRoot ?? null,
    record: normalized.taskRecordPath ?? null,
  };
  model.cost = model.costBlock;
  model.availability = {
    ...model.availability,
    workflowAvailable: false,
    verificationAvailable: false,
  };
  return model;
}

export default taskStepModel;
