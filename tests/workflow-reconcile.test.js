// Incremental pricing reconciler (0.35.2 requirements 1 and 2).
//
// Transcripts are the checked-in real fixtures. The Codex rollout and the
// Claude session carry real counters; each copy here gains the first user
// turn a delegate receives, in the row shape recorded by the real CLIs and
// with the text the packaged connectors send (`Read {taskFile} and follow the
// instructions.` for Codex, `Read the file {taskFile} and follow its
// instructions exactly.` for Claude Code). Task paths are /home/dev paths.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeJsonAtomic } from '../src/lib/fsjson.js';
import { loadProviders } from '../src/lib/providers.js';
import * as claudeTranscripts from '../src/lib/transcripts/claude-code.js';
import * as codexTranscripts from '../src/lib/transcripts/codex.js';
import { readTranscriptUsage } from '../src/lib/transcripts/index.js';
import { createV2ResultEnvelope } from '../src/workflow/v2-outcome.js';
import {
  createV2DurableState, createV2GoalDocument, validateV2DurableState,
} from '../src/workflow/v2-state.js';
import {
  acquirePricingLock, pricingLockPath, readReconcileLedger, reconcileActivity,
  reconcilePricing, reconcileRunState, RECONCILE_MAX_TRIES, RECONCILE_READER_VERSION,
  scheduleReconcile,
} from '../src/workflow/reconcile.js';
import { cmdReprice } from '../src/workflow/reprice.js';

const FIXTURES = new URL('./fixtures/transcripts/', import.meta.url).pathname;
const CODEX_ID = '01a0ba3c-3045-7013-928b-53a20891542b';
const CODEX_ID_2 = '01a0ba3c-3045-7013-928b-53a20891542c';
const CODEX_CWD = '/private/tmp/bsw-design/codex-probe';
// Edge timestamps of the real rollout fixture; its only token_count row is the
// last one, so an attempt with this window owns the whole cumulative total.
const STARTED_AT = '2026-09-19T15:15:02.116Z';
const FINISHED_AT = '2026-09-19T15:15:14.719Z';
const CODEX_TOTAL = 21089;
const CLAUDE_ID = '47b2c644-395f-40be-aef1-fba48f59da53';
const CLAUDE_ID_2 = '47b2c644-395f-40be-aef1-fba48f59da54';
const CLAUDE_CWD = '/home/dev/project-a';
const CLAUDE_TOTAL = 95288;
const RUN_ID = 'wf-mt42x54k-100cf0';
const SOURCE_HOME = '/home/dev/.bullswarm';

function taskPath(runId, actionId, ordinal = 1) {
  return `${SOURCE_HOME}/workflows/${runId}/task-${actionId}-attempt-${ordinal}.md`;
}

function fixtureRows(name) {
  return readFileSync(join(FIXTURES, name), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

function codexRollout(transcriptHome, { sessionId = CODEX_ID, prompt }) {
  const rows = fixtureRows('codex-rollout.jsonl');
  const [meta, context, ...rest] = rows;
  meta.payload.session_id = sessionId;
  meta.payload.id = sessionId;
  const user = {
    timestamp: context.timestamp,
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] },
  };
  const dir = join(transcriptHome, '.codex', 'sessions', '2026', '09', '19');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-2026-09-19T23-15-01-${sessionId}.jsonl`);
  writeFileSync(file, `${[meta, context, user, ...rest].map((row) => JSON.stringify(row)).join('\n')}\n`);
  return file;
}

function codexPrompt(path) {
  return `Read ${path} and follow the instructions.`;
}

function claudeSession(transcriptHome, { sessionId = CLAUDE_ID, prompt }) {
  const rows = fixtureRows('claude-session.jsonl').map((row) => ({ ...row, sessionId }));
  const first = rows[0];
  const user = {
    parentUuid: null,
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content: prompt },
    uuid: `${sessionId}-prompt`,
    timestamp: first.timestamp,
    cwd: first.cwd,
    sessionId,
    userType: 'external',
  };
  const dir = join(transcriptHome, '.claude', 'projects', CLAUDE_CWD.replace(/[^A-Za-z0-9]/g, '-'));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${sessionId}.jsonl`);
  writeFileSync(file, `${[user, ...rows].map((row) => JSON.stringify(row)).join('\n')}\n`);
  return file;
}

function connectorMap() {
  return {
    codex: {
      name: 'codex', model: 'gpt-5.6-luna',
      subscription: { quotaWindow: 'weekly', monthlyPriceUsd: 30 },
      modelProfiles: [{
        id: 'gpt-5.6-luna',
        pricing: { inputUsdPerMillion: 0.2, cacheReadUsdPerMillion: 0.02, outputUsdPerMillion: 1.2 },
        pricingSource: 'fixture-rate-card', pricingUpdatedAt: '2026-09-19',
      }],
    },
  };
}

// The packaged Codex and Claude providers gain a buildTranscriptIndex export
// in this release; until a checkout has it, tests that exercise the cached
// index add the same function the export forwards to.
function indexedProviders(home) {
  return loadProviders(home, { packaged: true }).providers.map((entry) => {
    const lib = entry.name === 'codex' ? codexTranscripts : entry.name === 'claude-code' ? claudeTranscripts : null;
    if (!lib || typeof entry.module?.buildTranscriptIndex === 'function') return entry;
    const wrapped = Object.create(entry);
    Object.defineProperty(wrapped, 'module', { value: { ...entry.module, buildTranscriptIndex: lib.buildTranscriptIndex } });
    return wrapped;
  });
}

function unknownUsage(model = 'gpt-5.6-luna') {
  return {
    model,
    tokens: { standardRead: null, cacheRead: null, cacheWrite: null, output: null, reasoning: null, totalKnown: null },
    tokenSource: 'unknown',
  };
}

/**
 * A home with one terminal run whose parallel codex attempts share one cwd
 * and one window. Each attempt's task file sits in the run directory; its
 * recorded path names the source home, as in a copied home.
 */
function fixtureHome({ actions = ['alpha', 'beta'], finishedAt = FINISHED_AT, pool = 'codex' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bs-reconcile-'));
  const home = join(root, 'home');
  const transcripts = join(root, 'transcripts');
  mkdirSync(join(home, 'workflows', RUN_ID), { recursive: true });
  mkdirSync(transcripts, { recursive: true });
  writeFileSync(join(home, 'state.json'), JSON.stringify({ version: 1 }));
  const runDir = join(home, 'workflows', RUN_ID);
  const goal = createV2GoalDocument({
    goal: 'Price parallel attempts from their transcripts.',
    cwd: CODEX_CWD,
    requirements: [{ id: 'priced', text: 'Every attempt is priced.', mandatory: true }],
    settings: { scout: false, executionMode: 'program', workspaceMode: 'shared', plannerMode: 'caller' },
  });
  const state = createV2DurableState(goal, { runId: RUN_ID, shortId: 'unknwn' });
  state.lifecycle = { status: 'partial', startedAt: STARTED_AT, finishedAt, resultFile: null };
  const program = actions.map((id) => ({
    id, purpose: `Step ${id}.`, dependsOn: [], affects: [], ownedFiles: [], prompt: 'Do the step.',
    lane: 'analyze', effort: 'low', evidenceFor: [], inputs: [], produces: [],
  }));
  state.program = { schemaVersion: 'bullswarm.workflow.program.v2', revision: 1, actions: program };
  state.actions = actions.map((id) => ({
    id, status: 'succeeded', attempts: 1, programRevision: 1, workRevision: 'work-1',
    startedAt: STARTED_AT, finishedAt, outputFile: null, artifactIds: [], lastFailure: null,
  }));
  state.presentation.stages = [{
    id: 'stage-1', label: 'Price', revision: 1, actionIds: actions, startedAt: STARTED_AT, completedAt: finishedAt,
  }];
  state.attempts = actions.map((id) => ({
    id: `${id}-1`, actionId: id, ordinal: 1, status: 'succeeded', pool, model: 'gpt-5.6-luna',
    startedAt: STARTED_AT, finishedAt, taskFile: taskPath(RUN_ID, id), outputFile: null,
    failureKind: null, why: 'fixture', usage: unknownUsage(),
  }));
  for (const id of actions) writeFileSync(join(runDir, `task-${id}-attempt-1.md`), `sample task for ${id} lorem ipsum\n`);
  state.planner.status = 'completed';
  state.budget = { agents: actions.length, seconds: actions.length, expansions: 0 };
  validateV2DurableState(state);
  const result = createV2ResultEnvelope(state, { finishedAt });
  state.lifecycle.resultFile = join(runDir, 'result.json');
  writeJsonAtomic(join(runDir, 'state.json'), state);
  writeJsonAtomic(join(runDir, 'result.json'), result);
  return {
    root, home, transcripts, runDir,
    state: () => JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8')),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function pass(fixture, options = {}) {
  return reconcilePricing({
    bullswarmDir: fixture.home,
    transcriptHome: fixture.transcripts,
    connectors: connectorMap(),
    trigger: 'test',
    ...options,
  });
}

test('task text resolves parallel Codex attempts that cwd and time leave ambiguous', () => {
  const fixture = fixtureHome();
  try {
    const alpha = codexRollout(fixture.transcripts, { sessionId: CODEX_ID, prompt: codexPrompt(taskPath(RUN_ID, 'alpha')) });
    const beta = codexRollout(fixture.transcripts, { sessionId: CODEX_ID_2, prompt: codexPrompt(taskPath(RUN_ID, 'beta')) });
    const window = { provider: 'codex', cwd: CODEX_CWD, startedAt: STARTED_AT, endedAt: FINISHED_AT, home: fixture.transcripts };
    assert.equal(readTranscriptUsage(window).confidence, 'ambiguous');
    for (const [action, file, id] of [['alpha', alpha, CODEX_ID], ['beta', beta, CODEX_ID_2]]) {
      const byPath = readTranscriptUsage({ ...window, taskFile: taskPath(RUN_ID, action) });
      assert.equal(byPath.confidence, 'task-text');
      assert.equal(byPath.file, file);
      assert.equal(byPath.sessionId, id);
      assert.equal(byPath.tokens.totalKnown, CODEX_TOTAL);
    }
    // The same answer through an index, and by the task's full text when the
    // prompt carries the text instead of the path.
    const index = codexTranscripts.buildTranscriptIndex({ home: fixture.transcripts });
    const indexed = codexTranscripts.readTranscriptUsage({ ...window, index, taskFile: taskPath(RUN_ID, 'beta') });
    assert.equal(indexed.confidence, 'task-text');
    assert.equal(indexed.file, beta);
    const text = 'sample task body lorem ipsum\nsecond line dolor\n';
    const inline = codexRollout(fixture.transcripts, { sessionId: '01a0ba3c-3045-7013-928b-53a20891542d', prompt: text });
    const byText = readTranscriptUsage({ ...window, taskText: `${text.replace(/\n/g, '\r\n')}  ` });
    assert.equal(byText.confidence, 'task-text');
    assert.equal(byText.file, inline);
  } finally { fixture.cleanup(); }
});

test('a task quoted by two transcripts stays ambiguous, never picked by recency', () => {
  const fixture = fixtureHome();
  try {
    const prompt = codexPrompt(taskPath(RUN_ID, 'alpha'));
    codexRollout(fixture.transcripts, { sessionId: CODEX_ID, prompt });
    codexRollout(fixture.transcripts, { sessionId: CODEX_ID_2, prompt });
    const result = readTranscriptUsage({
      provider: 'codex', cwd: CODEX_CWD, startedAt: STARTED_AT, endedAt: FINISHED_AT,
      taskFile: taskPath(RUN_ID, 'alpha'), home: fixture.transcripts,
    });
    assert.equal(result.confidence, 'ambiguous');
    assert.equal(result.tokens.totalKnown, null);
    assert.equal(result.file, null);
  } finally { fixture.cleanup(); }
});

test('Claude sessions resolve by task text; a session naming another task is not a window match', () => {
  const fixture = fixtureHome();
  try {
    const mine = taskPath(RUN_ID, 'alpha');
    const other = taskPath(RUN_ID, 'beta');
    const own = claudeSession(fixture.transcripts, { sessionId: CLAUDE_ID, prompt: `Read the file ${mine} and follow its instructions exactly.` });
    claudeSession(fixture.transcripts, { sessionId: CLAUDE_ID_2, prompt: `Read the file ${other} and follow its instructions exactly.` });
    const window = {
      provider: 'claude-code', cwd: CLAUDE_CWD,
      startedAt: '2026-09-17T20:40:03.700Z', endedAt: '2026-09-17T20:40:14.947Z', home: fixture.transcripts,
    };
    assert.equal(readTranscriptUsage(window).confidence, 'ambiguous');
    const matched = readTranscriptUsage({ ...window, taskFile: mine });
    assert.equal(matched.confidence, 'task-text');
    assert.equal(matched.file, own);
    assert.equal(matched.tokens.totalKnown, CLAUDE_TOTAL);
    // A third task has no transcript. The only window candidates quote other
    // Bullswarm task files, so the answer is none rather than a guess.
    const missing = readTranscriptUsage({ ...window, taskFile: taskPath(RUN_ID, 'gamma') });
    assert.equal(missing.confidence, 'none');
  } finally { fixture.cleanup(); }
});

test('one pass prices unmeasured attempts with no command; a second pass does nothing', () => {
  const fixture = fixtureHome();
  try {
    codexRollout(fixture.transcripts, { sessionId: CODEX_ID, prompt: codexPrompt(taskPath(RUN_ID, 'alpha')) });
    codexRollout(fixture.transcripts, { sessionId: CODEX_ID_2, prompt: codexPrompt(taskPath(RUN_ID, 'beta')) });
    const published = JSON.parse(readFileSync(join(fixture.runDir, 'result.json'), 'utf8'));
    const first = pass(fixture);
    assert.equal(first.status, 'complete');
    assert.equal(first.matched, 2);
    assert.equal(first.changedRuns, 1);
    assert.deepEqual(first.failures, []);

    const state = fixture.state();
    validateV2DurableState(state);
    for (const attempt of state.attempts) {
      assert.equal(attempt.usage.tokenSource, 'transcript-summed');
      assert.equal(attempt.usage.tokens.totalKnown, CODEX_TOTAL);
    }
    assert.equal(state.usage.total, CODEX_TOTAL * 2);
    assert.equal(state.usage.measuredAttempts, 2);
    const result = JSON.parse(readFileSync(join(fixture.runDir, 'result.json'), 'utf8'));
    // Usage is refreshed; the published outcome is not.
    assert.equal(result.status, published.status);
    assert.equal(result.verified, published.verified);
    assert.equal(result.reason, published.reason);
    assert.equal(result.usage.totals.tokens, CODEX_TOTAL * 2);
    const rollup = JSON.parse(readFileSync(join(fixture.runDir, 'rollup.json'), 'utf8'));
    assert.equal(rollup.pools.codex.tokenSource, 'transcript-summed');
    const history = readFileSync(join(fixture.home, 'history', 'runs.jsonl'), 'utf8').trim().split('\n');
    assert.equal(history.length, 1);
    const ledger = readReconcileLedger(fixture.home);
    assert.equal(ledger.attempts[`${RUN_ID}/alpha-1`].lastOutcome, 'matched');
    assert.equal(ledger.attempts[`${RUN_ID}/alpha-1`].confidence, 'task-text');
    // The ledger keeps no task text.
    assert.doesNotMatch(readFileSync(join(fixture.home, 'pricing', 'reconcile.json'), 'utf8'), /lorem/);

    const before = readFileSync(join(fixture.runDir, 'state.json'), 'utf8');
    const second = pass(fixture);
    assert.equal(second.status, 'complete');
    assert.equal(second.due, 0);
    assert.equal(second.parsedRuns, 0);
    assert.equal(second.indexesBuilt, 0);
    assert.equal(second.changedRuns, 0);
    assert.ok(second.elapsedMs < 1000, `no-change pass took ${second.elapsedMs}ms`);
    assert.equal(readFileSync(join(fixture.runDir, 'state.json'), 'utf8'), before);
    const status = JSON.parse(readFileSync(join(fixture.home, 'maintenance', 'reprice.json'), 'utf8'));
    assert.equal(status.trigger, 'test');
    assert.match(status.line, /0 attempts priced · nothing due/);
  } finally { fixture.cleanup(); }
});

test('an attempt that stays ambiguous stays unknown and is not retried', () => {
  const fixture = fixtureHome({ actions: ['alpha'] });
  try {
    const prompt = codexPrompt(taskPath(RUN_ID, 'alpha'));
    codexRollout(fixture.transcripts, { sessionId: CODEX_ID, prompt });
    codexRollout(fixture.transcripts, { sessionId: CODEX_ID_2, prompt });
    const before = readFileSync(join(fixture.runDir, 'state.json'), 'utf8');
    const first = pass(fixture);
    assert.equal(first.ambiguous, 1);
    assert.equal(first.changedRuns, 0);
    assert.equal(readFileSync(join(fixture.runDir, 'state.json'), 'utf8'), before);
    const record = readReconcileLedger(fixture.home).attempts[`${RUN_ID}/alpha-1`];
    assert.equal(record.lastOutcome, 'ambiguous');
    // Finished long before the pass: nothing is left to flush, so it is closed.
    assert.equal(record.tries, RECONCILE_MAX_TRIES);
    assert.equal(record.nextTryAt, null);
    const second = pass(fixture);
    assert.equal(second.due, 0);
    assert.equal(second.ambiguous, 0);
  } finally { fixture.cleanup(); }
});

test('a late transcript reopens only the attempt whose window it overlaps', () => {
  const fixture = fixtureHome({ actions: ['alpha'] });
  try {
    const providers = indexedProviders(fixture.home);
    const first = pass(fixture, { providers });
    assert.equal(first.missing, 1);
    assert.equal(first.indexesBuilt, 1);
    const unchanged = pass(fixture, { providers });
    assert.equal(unchanged.reopened, 0);
    assert.equal(unchanged.due, 0);

    // Another task's session lands in the window: reopened, tried, still none.
    const other = codexRollout(fixture.transcripts, { sessionId: CODEX_ID_2, prompt: codexPrompt(taskPath(RUN_ID, 'beta')) });
    const overlapping = pass(fixture, { providers });
    assert.equal(overlapping.reopened, 1);
    assert.equal(overlapping.missing, 1);
    // That session keeps growing a day later. Only its new rows count, and
    // they are outside the window, so nothing reopens.
    const later = { ...JSON.parse(readFileSync(other, 'utf8').split('\n')[1]), timestamp: '2026-09-20T09:00:00.000Z' };
    writeFileSync(other, `${readFileSync(other, 'utf8')}${JSON.stringify(later)}\n`);
    const grown = pass(fixture, { providers });
    assert.equal(grown.transcriptsRead, 1);
    assert.equal(grown.reopened, 0);

    codexRollout(fixture.transcripts, { sessionId: CODEX_ID, prompt: codexPrompt(taskPath(RUN_ID, 'alpha')) });
    const late = pass(fixture, { providers });
    assert.equal(late.reopened, 1);
    assert.equal(late.matched, 1);
    assert.equal(late.transcriptsRead, 1);
    assert.equal(fixture.state().attempts[0].usage.tokens.totalKnown, CODEX_TOTAL);
    const settled = pass(fixture, { providers });
    assert.equal(settled.reopened, 0);
    assert.equal(settled.transcriptsRead, 0);
  } finally { fixture.cleanup(); }
});

test('a just-finished attempt is retried on the schedule, then closed', () => {
  const fixture = fixtureHome({ actions: ['alpha'] });
  try {
    const finished = Date.parse(FINISHED_AT);
    const key = `${RUN_ID}/alpha-1`;
    pass(fixture, { now: () => finished + 5_000 });
    let record = readReconcileLedger(fixture.home).attempts[key];
    assert.equal(record.tries, 1);
    assert.equal(record.nextTryAt, new Date(finished + 5_000 + 60_000).toISOString());
    assert.equal(pass(fixture, { now: () => finished + 30_000 }).due, 0);
    assert.equal(pass(fixture, { now: () => finished + 66_000 }).due, 1);
    record = readReconcileLedger(fixture.home).attempts[key];
    assert.equal(record.tries, 2);
    assert.equal(record.nextTryAt, new Date(finished + 66_000 + 600_000).toISOString());
    // The transcript lands before the last scheduled try.
    codexRollout(fixture.transcripts, { sessionId: CODEX_ID, prompt: codexPrompt(taskPath(RUN_ID, 'alpha')) });
    const third = pass(fixture, { now: () => finished + 700_000 });
    assert.equal(third.matched, 1);
    assert.equal(fixture.state().attempts[0].usage.tokenSource, 'transcript-summed');
  } finally { fixture.cleanup(); }
});

test('a new reader version reopens every closed attempt once', () => {
  const fixture = fixtureHome({ actions: ['alpha'] });
  try {
    pass(fixture);
    const path = join(fixture.home, 'pricing', 'reconcile.json');
    assert.equal(pass(fixture).due, 0);
    const ledger = JSON.parse(readFileSync(path, 'utf8'));
    ledger.readerVersion = 'transcripts-v1';
    for (const record of Object.values(ledger.attempts)) record.readerVersion = 'transcripts-v1';
    writeFileSync(path, JSON.stringify(ledger));
    codexRollout(fixture.transcripts, { sessionId: CODEX_ID, prompt: codexPrompt(taskPath(RUN_ID, 'alpha')) });
    const reopened = pass(fixture);
    assert.equal(reopened.due, 1);
    assert.equal(reopened.matched, 1);
    assert.equal(readReconcileLedger(fixture.home).readerVersion, RECONCILE_READER_VERSION);
  } finally { fixture.cleanup(); }
});

test('one pass at a time: a held lock skips, a dead holder is taken over', () => {
  const fixture = fixtureHome({ actions: ['alpha'] });
  try {
    const lock = acquirePricingLock(fixture.home);
    assert.ok(lock);
    assert.equal(acquirePricingLock(fixture.home), null);
    assert.equal(pass(fixture).status, 'busy');
    assert.equal(scheduleReconcile({ bullswarmDir: fixture.home, spawnImpl: () => assert.fail('spawned') }).started, false);
    lock.release();
    assert.equal(existsSync(pricingLockPath(fixture.home)), false);
    // A holder whose process is gone does not block the next pass.
    writeFileSync(pricingLockPath(fixture.home), JSON.stringify({ pid: 2 ** 22 + 7, token: 'gone' }));
    assert.equal(pass(fixture).status, 'complete');
  } finally { fixture.cleanup(); }
});

test('the kernel prices its own run in memory and recomputes aggregate usage', () => {
  const fixture = fixtureHome();
  try {
    codexRollout(fixture.transcripts, { sessionId: CODEX_ID, prompt: codexPrompt(taskPath(RUN_ID, 'alpha')) });
    codexRollout(fixture.transcripts, { sessionId: CODEX_ID_2, prompt: codexPrompt(taskPath(RUN_ID, 'beta')) });
    const state = fixture.state();
    state.usage = { ...state.usage, total: 0, byPool: {} };
    const onDisk = readFileSync(join(fixture.runDir, 'state.json'), 'utf8');

    const running = structuredClone(state);
    running.attempts[1].status = 'running';
    assert.equal(reconcileRunState(running, {
      runDir: fixture.runDir, bullswarmDir: fixture.home, transcriptHome: fixture.transcripts, connectors: connectorMap(),
    }).status, 'skipped');

    const outcome = reconcileRunState(state, {
      runDir: fixture.runDir, bullswarmDir: fixture.home, transcriptHome: fixture.transcripts, connectors: connectorMap(),
    });
    assert.equal(outcome.changed, 2);
    assert.equal(state.attempts[0].usage.tokenSource, 'transcript-summed');
    assert.equal(state.usage.total, CODEX_TOTAL * 2);
    assert.deepEqual(state.usage.byPool, { codex: CODEX_TOTAL * 2 });
    validateV2DurableState(state);
    // The caller persists; the run directory is untouched.
    assert.equal(readFileSync(join(fixture.runDir, 'state.json'), 'utf8'), onDisk);
    assert.equal(readReconcileLedger(fixture.home).lastPass.scope, `run ${RUN_ID}`);
    assert.equal(reconcileRunState(state, {
      runDir: fixture.runDir, bullswarmDir: fixture.home, transcriptHome: fixture.transcripts, connectors: connectorMap(),
    }).changed, 0);
  } finally { fixture.cleanup(); }
});

test('a single task recorded with only its outFile is priced by its task file', () => {
  const fixture = fixtureHome({ actions: ['alpha'] });
  try {
    const stamp = '1789614568945-32ood';
    const runs = join(fixture.home, 'runs');
    mkdirSync(runs, { recursive: true });
    writeFileSync(join(runs, `task-${stamp}.md`), 'sample single task lorem ipsum\n');
    // The shape of an early decision-log entry: no taskFile, no cwd.
    writeFileSync(join(fixture.home, 'state.json'), JSON.stringify({
      version: 1,
      decisionLog: [{
        ts: FINISHED_AT, lane: 'build', picked: 'codex', ok: true, why: 'verified', wallSec: 12.6,
        model: 'gpt-5.6-luna', outFile: `${SOURCE_HOME}/runs/out-${stamp}.md`, usage: unknownUsage(),
      }],
    }));
    codexRollout(fixture.transcripts, { sessionId: CODEX_ID, prompt: codexPrompt(`${SOURCE_HOME}/runs/task-${stamp}.md`) });
    codexRollout(fixture.transcripts, { sessionId: CODEX_ID_2, prompt: codexPrompt(taskPath(RUN_ID, 'alpha')) });
    const first = pass(fixture);
    assert.equal(first.changedTasks, 1);
    const entry = JSON.parse(readFileSync(join(fixture.home, 'state.json'), 'utf8')).decisionLog[0];
    assert.equal(entry.usage.tokenSource, 'transcript-summed');
    assert.equal(entry.usage.tokens.totalKnown, CODEX_TOTAL);
    assert.equal(entry.usage.sessionId, CODEX_ID);
    assert.equal(pass(fixture).changedTasks, 0);
  } finally { fixture.cleanup(); }
});

test('the dashboard starts one detached pass, throttles the next and shows a quiet note', async () => {
  const fixture = fixtureHome();
  try {
    codexRollout(fixture.transcripts, { sessionId: CODEX_ID, prompt: codexPrompt(taskPath(RUN_ID, 'alpha')) });
    codexRollout(fixture.transcripts, { sessionId: CODEX_ID_2, prompt: codexPrompt(taskPath(RUN_ID, 'beta')) });
    const calls = [];
    const fake = (command, args, options) => {
      calls.push({ command, args, options });
      return { pid: null, once() {}, unref() {} };
    };
    assert.equal(scheduleReconcile({ bullswarmDir: fixture.home, transcriptHome: fixture.transcripts, spawnImpl: fake, delayMs: 1500 }).started, true);
    assert.equal(calls[0].options.detached, true);
    assert.equal(calls[0].options.stdio, 'ignore');
    assert.equal(calls[0].options.env.BULLSWARM_HOME, fixture.home);
    assert.deepEqual(calls[0].args.slice(1), [
      'workflow', 'reprice', '--incremental', '--trigger', 'dashboard',
      '--transcript-home', fixture.transcripts, '--delay-ms', '1500',
    ]);

    // The real child, no fakes: it prices the run and records the pass.
    const launched = scheduleReconcile({ bullswarmDir: fixture.home, transcriptHome: fixture.transcripts, throttleMs: 0 });
    assert.equal(launched.started, true);
    const deadline = Date.now() + 30_000;
    let ledger = readReconcileLedger(fixture.home);
    while (!ledger.lastPass && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      ledger = readReconcileLedger(fixture.home);
    }
    assert.equal(ledger.lastPass?.trigger, 'dashboard');
    assert.equal(ledger.lastPass.matched, 2, JSON.stringify(ledger.lastPass));
    assert.equal(fixture.state().usage.total, CODEX_TOTAL * 2);
    assert.equal(reconcileActivity(fixture.home), null);
    const throttled = scheduleReconcile({ bullswarmDir: fixture.home, spawnImpl: () => assert.fail('spawned') });
    assert.deepEqual(throttled, { started: false, reason: 'throttled' });

    writeJsonAtomic(join(fixture.home, 'pricing', 'active.json'), { pid: process.pid, eligible: 3 });
    assert.equal(reconcileActivity(fixture.home), 'pricing 3 older records…');
  } finally { fixture.cleanup(); }
});

test('workflow reprice --incremental is the same pass from the command line', () => {
  const fixture = fixtureHome({ actions: ['alpha'] });
  try {
    codexRollout(fixture.transcripts, { sessionId: CODEX_ID, prompt: codexPrompt(taskPath(RUN_ID, 'alpha')) });
    const lines = [];
    const errors = [];
    const code = cmdReprice(['--incremental', '--json', '--transcript-home', fixture.transcripts], {
      bullswarmDir: fixture.home, connectors: connectorMap(), log: (line) => lines.push(line), error: (line) => errors.push(line),
    });
    assert.equal(code, 0, errors.join('\n'));
    const summary = JSON.parse(lines.at(-1));
    assert.equal(summary.type, 'reconcile');
    assert.equal(summary.matched, 1);
    assert.equal(summary.trigger, 'manual');
    const flags = [];
    assert.equal(cmdReprice(['--incremental', '--all'], { bullswarmDir: fixture.home, log: () => {}, error: (line) => flags.push(line) }), 2);
    assert.match(flags[0], /--incremental prices every unmeasured attempt/);
    assert.equal(cmdReprice(['--trigger', 'x'], { bullswarmDir: fixture.home, log: () => {}, error: (line) => flags.push(line) }), 2);
  } finally { fixture.cleanup(); }
});
