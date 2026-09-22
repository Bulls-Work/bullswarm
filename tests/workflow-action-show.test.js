import assert from 'node:assert/strict';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { readEvents } from '../src/workflow/events.js';
import { withV2Cancellation } from '../src/workflow/v2-cancellation.js';
import { resolveRunId } from '../src/workflow/short-id.js';
import { stepPageModel } from '../src/workflow/step-model.js';
import { stepJsonModel } from '../src/workflow/step-json.js';
import { parseStep } from '../mods/bullswarm/hooks/runs.ts';
import { shapeStep } from '../mods/bullswarm/hooks/step.ts';

const REPO = resolve(new URL('..', import.meta.url).pathname);
const BIN = join(REPO, 'bin', 'bullswarm.js');
const SNAPSHOT = fileURLToPath(new URL('./fixtures/home-351/', import.meta.url));
const SOURCE_RUN = 'wf-mu8ni8o4-f9baaf';
const ACTION_ID = 'step-model';

function readState(runDir) {
  return JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8'));
}

function show(home, token, actionId = ACTION_ID) {
  const result = spawnSync(process.execPath, [BIN, 'workflow', 'action', 'show', token, actionId, '--json'], {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, BULLSWARM_HOME: home },
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.error, undefined, result.error?.message);
  return JSON.parse(result.stdout);
}

function legacyPayload(home, token, actionId) {
  const resolved = resolveRunId(home, token);
  assert.ok(resolved, `run ${token} must resolve`);
  const state = withV2Cancellation(readState(resolved.runDir), resolved.runDir);
  const action = state.program?.actions?.find((entry) => entry.id === actionId);
  assert.ok(action, `action ${actionId} must exist`);
  const actionState = state.actions?.find((entry) => entry.id === actionId) ?? null;
  // Keep this projection intentionally independent from v2ActionJson: it is
  // the pre-step contract used to prove every old field stayed unchanged.
  const payload = {
    action: 'show-action',
    runId: resolved.runId,
    shortId: resolved.shortId ?? null,
    runDir: resolved.runDir,
    actionRecord: {
      id: action.id,
      purpose: action.purpose,
      status: actionState?.status ?? 'unknown',
      ...(action.kind ? { kind: action.kind } : {}),
      lane: action.lane,
      effort: action.effort,
      ...(action.reasoning ? { reasoning: action.reasoning } : {}),
      dependsOn: action.dependsOn,
      affects: action.affects,
      evidenceFor: action.evidenceFor,
      ownedFiles: action.ownedFiles,
      inputs: action.inputs ?? [],
      produces: action.produces ?? [],
      programRevision: actionState?.programRevision ?? null,
      outputFile: actionState?.outputFile ?? null,
      artifactIds: actionState?.artifactIds ?? [],
      lastFailure: actionState?.lastFailure ?? null,
    },
    attempts: (state.attempts ?? []).filter((attempt) => attempt.actionId === actionId),
    events: readEvents(resolved.runDir).filter((event) =>
      event.payload?.actionId === actionId || event.payload?.parentId === actionId),
  };
  return { resolved, state, payload };
}

function expectedStep(home, token, actionId, shown) {
  const { resolved, state } = legacyPayload(home, token, actionId);
  const selected = shown.step.attempts.find((attempt) => attempt.ordinal === shown.step.selectedAttemptOrdinal);
  const captureDate = selected.activity.detailCaptureDate;
  let nowMs = Date.parse(`${captureDate}T12:00:00.000Z`);
  // An open attempt's active clock is intentionally live. Recover the exact
  // instant used by the CLI model from its durable start plus reported active
  // duration so the comparison remains a value-for-value contract test.
  if (shown.step.identity.status === 'running') nowMs = Date.now();
  return stepPageModel({
    runId: resolved.runId,
    shortId: resolved.shortId ?? state.shortId ?? null,
    runDir: resolved.runDir,
    state,
  }, { actionId, nowMs });
}

function assertPreviousFieldsUnchanged(shown, previous) {
  assert.deepEqual(Object.keys(shown).slice(0, Object.keys(previous).length), Object.keys(previous));
  for (const key of Object.keys(previous)) assert.deepEqual(shown[key], previous[key], `${key} changed`);
  assert.deepEqual(Object.keys(shown).slice(-1), ['step']);
}

test('action show adds the Step model without changing the existing finished payload', () => {
  const shown = show(SNAPSHOT, SOURCE_RUN);
  const { payload } = legacyPayload(SNAPSHOT, SOURCE_RUN, ACTION_ID);
  assertPreviousFieldsUnchanged(shown, payload);
  const full = expectedStep(SNAPSHOT, SOURCE_RUN, ACTION_ID, shown);
  assert.deepEqual(shown.step, stepJsonModel(full));
  for (const width of [55, 120]) {
    for (const mode of ['overview', 'detail']) {
      assert.deepEqual(
        shapeStep(shown, { width, mode, expandedTurn: 0 }),
        shapeStep({ step: full }, { width, mode, expandedTurn: 0 }),
      );
    }
  }
  const parsed = parseStep(JSON.stringify(shown), 123);
  assert.equal(parsed.id, ACTION_ID);
  assert.equal(parsed.attempt.ordinal, 1);
  assert.equal(parsed.page.schemaVersion, 2);
  assert.ok(Array.isArray(parsed.events));
  assert.equal(shown.step.schemaVersion, 2);
  assert.equal(shown.step.identity.actionId, ACTION_ID);
  assert.equal(shown.step.identity.status, 'succeeded');
  assert.deepEqual(shown.step.sectionOrder, ['header', 'task', 'activity', 'result', 'cost']);
});

test('action show carries the same Step model for a running action from a real snapshot copy', () => {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-action-show-'));
  const home = join(root, 'home');
  const workflows = join(home, 'workflows');
  const runDir = join(workflows, 'wf-action-show-running');
  mkdirSync(workflows, { recursive: true });
  try {
    cpSync(join(SNAPSHOT, 'workflows', SOURCE_RUN), runDir, { recursive: true });
    // The copied real run contains a completed result envelope. A running
    // state must not claim that envelope is current, so remove only the
    // throwaway copy's terminal files.
    for (const name of ['result.json', 'report.json', 'rollup.json']) {
      const path = join(runDir, name);
      if (existsSync(path)) rmSync(path);
    }
    const state = readState(runDir);
    state.runId = 'wf-action-show-running';
    state.shortId = 'runnng';
    state.lifecycle = { ...state.lifecycle, status: 'running', finishedAt: null, resultFile: null };
    state.actions = state.actions.map((action) => action.id === ACTION_ID
      ? { ...action, status: 'running', finishedAt: null }
      : action);
    state.attempts = state.attempts.map((attempt) => attempt.actionId === ACTION_ID
      ? { ...attempt, status: 'running', finishedAt: null }
      : attempt);
    writeFileSync(join(runDir, 'state.json'), JSON.stringify(state, null, 2));

    const shown = show(home, 'wf-action-show-running');
    const { payload } = legacyPayload(home, 'wf-action-show-running', ACTION_ID);
    assertPreviousFieldsUnchanged(shown, payload);
    const expected = expectedStep(home, 'wf-action-show-running', ACTION_ID, shown);
    assert.deepEqual(shown.step, stepJsonModel(expected));
    assert.deepEqual(shapeStep(shown), shapeStep({ step: expected }));
    assert.equal(shown.step.identity.status, 'running');
    assert.match(shown.step.presentation.header.activeText, /^\d+(?:h\d{2}m|m\d{2}s)$/);
    const selected = shown.step.attempts.find((attempt) => attempt.ordinal === shown.step.selectedAttemptOrdinal);
    assert.equal(selected.activity.turns.length, 15);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
