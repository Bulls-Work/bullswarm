import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { eventToolSummary,
  eventKindSummary,
  groupActivityTurns,
  normalizeAttemptUsage,
  pairActivityEvents,
  parseAttemptStream,
  reportLeadLines,
  sharedFileRequests,
  stepClockText,
  stepPageModel,
  taskStepModel,
  toolCallUpdates,
  toolKindsForPool,
  toolSummaryText,
  turnCountsText,
} from '../src/workflow/step-model.js';
import { createAgentEventDecoder } from '../src/lib/agent-events.js';
import { dashboardModel, renderDashboardPage } from '../src/workflow/dashboard.js';
import { workflowPanelModel } from '../src/workflow/run-model.js';

// The fixture's clocks were recorded in Hong Kong and the expectations quote
// them as HKT, so this file reads them there on any machine (CI runs in UTC).
process.env.TZ = 'Asia/Hong_Kong';

const fixtureDir = fileURLToPath(new URL('./fixtures/step-model/', import.meta.url));
const fixture = (name) => join(fixtureDir, name);
const fixedNow = Date.parse('2026-09-19T18:10:00.000Z');
// The scrubbed in-repo copy of a real home (scripts/build-test-home.mjs).
const realHome = fileURLToPath(new URL('./fixtures/home-351/workflows/', import.meta.url));
const realSnapshotRun = join(realHome, 'wf-mu8ni8o4-f9baaf');
// g6d6q2, the run whose accept attempt 3-5 ran on claude-code, and mu8j2hjn,
// whose verify attempt 1 ran on grok. Both are real captures, not fixtures.
const realClaudeRun = join(realHome, 'wf-mu6mv62z-cdcd5d');
const realGrokRun = join(realHome, 'wf-mu8j2hjn-58b8ec');
const realTwoAttemptCodexRun = join(realHome, 'wf-mu7873tx-3b973b');

function baseState({
  actionId = 'step-model',
  lifecycleStatus = 'running',
  actionStatus = 'running',
  attempts = [],
  resultFile = null,
  requirements = {},
} = {}) {
  const action = {
    id: actionId,
    status: actionStatus,
    attempts: attempts.length,
    purpose: 'Build the evidence-honest Step model',
    startedAt: attempts[0]?.startedAt ?? '2026-09-19T17:50:19.595Z',
    finishedAt: actionStatus === 'running' ? null : attempts.at(-1)?.finishedAt ?? null,
    outputFile: 'output.md',
    lastFailure: attempts.at(-1)?.failureKind
      ? { kind: attempts.at(-1).failureKind, message: attempts.at(-1).why }
      : null,
  };
  return {
    runId: 'wf-step-model-fixture',
    shortId: 'stepfx',
    workflow: 'step model fixture',
    intent: { goal: 'exercise the Step page model' },
    lifecycle: {
      status: lifecycleStatus,
      startedAt: '2026-09-19T17:50:19.595Z',
      finishedAt: lifecycleStatus === 'running' ? null : '2026-09-19T18:00:00.000Z',
      resultFile,
    },
    config: { settings: { plannerMode: 'caller', workspaceMode: 'shared' } },
    planner: { status: 'completed', turns: 0, attempts: [], lastDecision: null },
    presentation: {
      stages: [{
        id: 'phase',
        label: 'Phase',
        actionIds: [actionId],
        startedAt: '2026-09-19T17:50:19.595Z',
        completedAt: lifecycleStatus === 'running' ? null : '2026-09-19T18:00:00.000Z',
      }],
    },
    actions: [action],
    attempts,
    outputs: { [actionId]: { outFile: 'output.md', bytes: 122 } },
    ledger: { requirements },
  };
}

function runningAttempt(actionId = 'step-model') {
  return {
    id: `${actionId}-1`,
    actionId,
    ordinal: 1,
    status: 'running',
    pool: 'codex',
    model: 'gpt-5.6-luna',
    startedAt: '2026-09-19T17:50:19.886Z',
    finishedAt: null,
    taskFile: 'task.md',
    outputFile: 'output.md',
    streamFile: 'running-stream.jsonl',
    routing: {
      lane: 'build',
      effort: 'medium',
      reason: 'most-behind capable pool',
      candidates: [{ pool: 'codex', model: 'gpt-5.6-luna', pace: 12 }],
    },
    usage: null,
    wallSec: null,
  };
}

function finishedAttempt() {
  return {
    ...runningAttempt('stats-design'),
    id: 'stats-design-1',
    status: 'succeeded',
    startedAt: '2026-09-18T17:21:52.572Z',
    finishedAt: '2026-09-18T18:01:13.599Z',
    streamFile: null,
    wallSec: 2361,
    usage: {
      model: 'gpt-5.6-luna',
      tokens: { standardRead: 1642, output: 190, totalKnown: 1832 },
      tokenSource: 'estimated:utf8-bytes/4',
      pricing: {
        inputUsdPerMillion: 0.2,
        outputUsdPerMillion: 1.2,
        source: 'https://developers.openai.com/api/docs/models',
        updatedAt: '2026-08-27',
      },
      cost: {
        estimatedUsd: 0.0005564,
        breakdown: { standardReadUsd: 0.0003284, outputUsd: 0.000228 },
        basis: 'api-equivalent rate; subscription debit may differ',
      },
    },
  };
}

function failedAttempts() {
  const common = {
    ...runningAttempt('cli'),
    streamFile: null,
    pool: 'opencode2:kaihk-3',
    model: 'kaihk-3/gpt-5.6-luna',
    failureKind: 'provider',
    why: 'provider stream reported error',
    usage: {
      model: 'kaihk-3/gpt-5.6-luna',
      tokens: { standardRead: 2407, output: 359, totalKnown: 2766 },
      tokenSource: 'estimated:utf8-bytes/4',
      pricing: null,
      cost: { estimatedUsd: null, breakdown: null, basis: 'unknown: no model rate metadata' },
    },
  };
  return [
    {
      ...common,
      id: 'cli-1',
      ordinal: 1,
      status: 'interrupted',
      startedAt: '2026-09-11T12:51:13.521Z',
      finishedAt: '2026-09-11T12:52:38.033Z',
      wallSec: 84.5,
    },
    {
      ...common,
      id: 'cli-2',
      ordinal: 2,
      status: 'interrupted',
      pool: 'opencode2',
      model: 'kaihk-3/gpt-5.6-luna',
      startedAt: '2026-09-11T12:52:38.231Z',
      finishedAt: '2026-09-11T12:53:57.480Z',
      wallSec: 79.2,
      usage: {
        ...common.usage,
        model: 'kaihk-3/gpt-5.6-luna',
        tokens: { standardRead: 2407, output: 358, totalKnown: 2765 },
      },
    },
  ];
}

test('running real stream fixture keeps capture order and marks unsupported structure unavailable', () => {
  const attempt = runningAttempt();
  const state = baseState({ attempts: [attempt] });
  const model = stepPageModel({
    runId: state.runId,
    shortId: state.shortId,
    runDir: fixtureDir,
    state,
  }, { nowMs: fixedNow });

  assert.equal(model.identity.actionId, 'step-model');
  assert.equal(model.identity.status, 'running');
  assert.equal(model.identity.executionSucceeded, false);
  assert.equal(model.identity.verified, null);
  assert.equal(model.activeDurationMs, fixedNow - Date.parse(attempt.startedAt));
  assert.equal(model.spanDurationMs, null);
  assert.equal(model.selectedAttempt.ordinal, 1);
  assert.equal(model.activity.events.length, 7);
  assert.equal(model.activity.captureOrder, true);
  assert.equal(model.activity.turns.length, 2);
  assert.deepEqual(model.activity.turns.map((turn) => turn.summary), [
    { commands: 2, filesRead: 0, searches: 0, edits: 0, otherTools: 0, errors: 0, total: 2, text: '2 commands · 0 files read · 0 edits · 0 errors' },
    { commands: 1, filesRead: 0, searches: 0, edits: 0, otherTools: 0, errors: 0, total: 1, text: '1 commands · 0 files read · 0 edits · 0 errors' },
  ]);
  assert.equal(model.availability.streamAvailable, true);
  assert.equal(model.streamAvailable, true);
  assert.equal(model.turnsCaptured, true);
  assert.equal(model.toolDetailsCaptured, false);
  assert.equal(model.usagePending, true);
  assert.equal(model.activity.selectedIndex, 6);
  assert.equal(model.activity.minimap.count, 7);
  assert.match(model.money, /api unknown/);
  assert.match(model.money, /sub unknown/);
  assert.deepEqual(model.prompt, [
    'sample task for step-model lorem ips',
    'Purpose: build the evidence-honest Step model from durable records.',
    'Use real copied-home fixtures and preserve unknown values.',
  ]);
  assert.equal(model.promptModel.available, true);
  assert.equal(model.outcomeModel.output.available, true);
});

test('durable action state keeps the caller-authored purpose from its program definition', () => {
  const attempt = runningAttempt('integrate');
  const state = baseState({ actionId: 'integrate', attempts: [attempt] });
  delete state.actions[0].purpose;
  state.program = {
    actions: [{
      id: 'integrate', purpose: 'Reconcile and prove the complete Step page',
      dependsOn: [], affects: [], ownedFiles: [], lane: 'build', effort: 'high',
    }],
  };
  const model = stepPageModel({
    runId: state.runId,
    shortId: state.shortId,
    runDir: fixtureDir,
    state,
  }, { actionId: 'integrate', nowMs: fixedNow });
  assert.equal(model.identity.purpose, 'Reconcile and prove the complete Step page');
  assert.equal(model.action.status, 'running');
});

test('finished verified fixture separates execution success from durable verification and preserves legacy cost', () => {
  const attempt = finishedAttempt();
  const state = baseState({
    actionId: 'stats-design',
    lifecycleStatus: 'completed',
    actionStatus: 'succeeded',
    attempts: [attempt],
    resultFile: 'finished-result.json',
  });
  const model = stepPageModel({
    runId: state.runId,
    shortId: state.shortId,
    runDir: fixtureDir,
    state,
  }, { nowMs: fixedNow });

  assert.equal(model.identity.executionSucceeded, true);
  assert.equal(model.identity.workflowStatus, 'completed');
  assert.equal(model.identity.verified, true);
  assert.equal(model.verdict.verification.available, true);
  assert.equal(model.outcomeModel.resultAvailable, true);
  assert.equal(model.outcomeModel.action.id, 'stats-design');
  assert.equal(model.outcomeModel.resultPath, fixture('finished-result.json'));
  assert.equal(model.tokens.totalKnown, 1832);
  assert.equal(model.moneyPair.tokenSource, 'estimated:utf8-bytes/4');
  assert.equal(model.moneyPair.api.usd, 0.0005564);
  assert.match(model.money, /estimated/);
  assert.equal(model.availability.streamAvailable, false);
  assert.equal(model.availability.turnsCaptured, false);
  assert.equal(model.availability.toolDetailsCaptured, false);
  assert.equal(model.availability.usagePending, false);
  assert.match(model.availability.streamAvailable ? 'captured' : 'unavailable', /unavailable/);
});

test('failed two-attempt fixture retains retry history and never renders unknown cost as zero', () => {
  const attempts = failedAttempts();
  const state = baseState({
    actionId: 'cli',
    lifecycleStatus: 'partial',
    actionStatus: 'failed',
    attempts,
    resultFile: 'failed-result.json',
  });
  const model = stepPageModel({
    runId: state.runId,
    shortId: state.shortId,
    runDir: fixtureDir,
    state,
  }, { nowMs: fixedNow });

  assert.equal(model.attemptHistory.length, 2);
  assert.equal(model.selectedAttempt.ordinal, 2);
  assert.equal(model.selectedAttempt.failure.kind, 'provider');
  assert.equal(model.identity.status, 'failed');
  assert.equal(model.identity.workflowStatus, 'partial');
  assert.equal(model.identity.verified, false);
  assert.equal(model.tokens.totalKnown, 5531);
  assert.equal(model.attemptTokens.totalKnown, 2765);
  assert.equal(model.moneyPair.api.usd, null);
  assert.equal(model.moneyPair.subscription.usd, null);
  assert.match(model.money, /api unknown/);
  assert.match(model.money, /sub unknown/);
  assert.doesNotMatch(model.money, /\$0\.00/);
  assert.equal(model.availability.streamAvailable, false);
  assert.equal(model.availability.turnsCaptured, false);
  assert.equal(model.availability.toolDetailsCaptured, false);
  assert.equal(model.outcomeModel.verified, false);
});

test('malformed and missing streams are explicit, and a started/completed pair counts once', () => {
  const malformed = parseAttemptStream(fixture('malformed-stream.jsonl'));
  assert.equal(malformed.available, true);
  assert.equal(malformed.parseErrors, 1);
  assert.equal(malformed.truncated, true);
  assert.equal(malformed.dropped, 2);
  assert.equal(malformed.events.length, 2);
  assert.equal(parseAttemptStream(fixture('does-not-exist.jsonl')).available, false);

  const paired = pairActivityEvents([
    { index: 0, toolCallId: 'call-1', toolName: 'Bash', kind: 'tool', status: 'running' },
    { index: 1, toolCallId: 'call-1', toolName: 'Bash', kind: 'tool', status: 'completed', result: 'ok', durationMs: 12 },
    { index: 2, kind: 'tool', status: 'running', summary: 'same prose, no stable id' },
    { index: 3, kind: 'tool', status: 'completed', summary: 'same prose, no stable id' },
  ]);
  // The stable id is the strongest key, and the id-less start/complete pair of
  // one kind is the same operation recorded twice, not two operations.
  assert.equal(paired.length, 2);
  assert.equal(paired[0].toolCallId, 'call-1');
  assert.equal(paired[0].durationMs, 12);
  assert.equal(paired[1].toolCallId, null);
  assert.deepEqual([paired[1].startIndex, paired[1].completeIndex], [2, 3]);

  // A start whose completion never arrived stays its own unit and never
  // borrows a completion from another kind.
  assert.deepEqual(pairActivityEvents([
    { index: 0, kind: 'tool', status: 'running' },
    { index: 1, kind: 'file_change', status: 'completed' },
  ]), []);

  // A result captured under its own kind (`tool`) answers the call before it,
  // whatever kind the call carries — claude-code records the tool's name as the
  // call's kind and `tool` for its tool_result. The call keeps its place and
  // the result is not counted as an operation.
  const answered = pairActivityEvents([
    { index: 0, kind: 'Bash', status: 'running' },
    { index: 1, kind: 'tool', status: 'completed' },
    { index: 2, kind: 'ToolSearch', status: 'running' },
    { index: 3, kind: 'tool', status: 'completed' },
  ]);
  assert.equal(answered.length, 2);
  assert.deepEqual(answered.map((pair) => [pair.startIndex, pair.completeIndex]), [[0, 1], [2, 3]]);
});

test('a live tail segment extends a real stream to the same events as the finished file', () => {
  const sourceFile = join(realGrokRun, 'stream-verify-attempt-1.jsonl');
  assert.ok(existsSync(sourceFile), `missing real snapshot stream: ${sourceFile}`);
  const source = parseAttemptStream(sourceFile);
  assert.ok(source.events.length > 20);
  assert.equal(source.tailSegment, false);

  const tempDir = mkdtempSync(join(tmpdir(), 'bullswarm-step-stream-tail-'));
  try {
    const splitFile = join(tempDir, 'stream.jsonl');
    const lines = readFileSync(sourceFile, 'utf8').split(/\r?\n/).filter(Boolean);
    const splitAt = Math.floor(lines.length / 2);
    writeFileSync(splitFile, `${lines.slice(0, splitAt).join('\n')}\n`);
    writeFileSync(`${splitFile}.tail`, `{"truncated":true,"dropped":0}\n${lines.slice(splitAt).join('\n')}\n`);

    const live = parseAttemptStream(splitFile);
    assert.equal(live.tailSegment, true);
    assert.equal(live.truncated, true);
    assert.equal(live.dropped, 0);
    assert.deepEqual(live.events, source.events);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('a tail marker carries folded truncation metadata', () => {
  const sourceFile = join(realGrokRun, 'stream-verify-attempt-1.jsonl');
  assert.ok(existsSync(sourceFile), `missing real snapshot stream: ${sourceFile}`);
  const lines = readFileSync(sourceFile, 'utf8').split(/\r?\n/).filter(Boolean);
  const tempDir = mkdtempSync(join(tmpdir(), 'bullswarm-step-stream-tail-marker-'));
  try {
    const splitFile = join(tempDir, 'stream.jsonl');
    writeFileSync(splitFile, `${lines[0]}\n`);
    writeFileSync(`${splitFile}.tail`, `{"truncated":true,"dropped":17}\n${lines[1]}\n`);

    const parsed = parseAttemptStream(splitFile);
    assert.equal(parsed.tailSegment, true);
    assert.equal(parsed.truncated, true);
    assert.equal(parsed.dropped, 17);
    assert.equal(parsed.events.length, 2);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('a live tail drops lines overlapping the head by sequence number', () => {
  const sourceFile = join(realGrokRun, 'stream-verify-attempt-1.jsonl');
  assert.ok(existsSync(sourceFile), `missing real snapshot stream: ${sourceFile}`);
  const lines = readFileSync(sourceFile, 'utf8').split(/\r?\n/).filter(Boolean);
  const tempDir = mkdtempSync(join(tmpdir(), 'bullswarm-step-stream-tail-overlap-'));
  try {
    const splitFile = join(tempDir, 'stream.jsonl');
    writeFileSync(splitFile, `${lines[0]}\n${lines[1]}\n`);
    // The sink can flush a tail window that still contains the newest head
    // event. The reader must not duplicate that sequence when it appends it.
    writeFileSync(`${splitFile}.tail`, `${lines[1]}\n${lines[2]}\n${lines[3]}\n`);

    const parsed = parseAttemptStream(splitFile);
    assert.equal(parsed.tailSegment, true);
    assert.deepEqual(parsed.events.map((event) => event.seq), [1, 2, 3, 4]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('each connector declares its tool kinds; the page counts by them and buckets the rest', () => {
  const repo = fileURLToPath(new URL('..', import.meta.url));
  const connectors = ['src/providers/claude-code', 'src/providers/codex', 'src/providers/grok', 'providers/contrib/opencode', 'providers/contrib/command-code']
    .map((dir) => JSON.parse(readFileSync(join(repo, dir, 'connector.json'), 'utf8')));
  const seen = new Map();
  for (const connector of connectors) {
    const declared = Object.entries(connector.eventStream.toolKinds);
    assert.ok(declared.length > 0, `${connector.name} declares its tool kinds`);
    for (const [tool, kind] of declared) {
      assert.ok(['command', 'read', 'edit', 'search', 'other'].includes(kind));
      const key = tool.toLowerCase();
      assert.ok(!seen.has(key) || seen.get(key) === kind, `${tool}: ${seen.get(key)} vs ${kind}`);
      seen.set(key, kind);
    }
  }
  assert.equal(toolKindsForPool('grok').get('grep'), 'search');
  assert.equal(toolKindsForPool('grok').get('search_replace'), 'edit');
  assert.equal(toolKindsForPool('grok').has('bash'), false);
  assert.equal(toolKindsForPool('claude-code:work').get('bash'), 'command');
  assert.equal(toolKindsForPool('codex').get('file_change'), 'edit');
  const source = readFileSync(join(repo, 'src/workflow/step-model.js'), 'utf8');
  for (const tool of ['run_terminal_command', 'read_file', 'list_dir', 'multiedit', 'apply_patch', 'write_file', 'edit_file']) {
    assert.ok(!source.includes(`'${tool}'`), `step-model.js names ${tool}`);
  }
  const kinds = [
    'Bash', 'bash', 'run_terminal_command', 'command_execution', 'shell_command', 'powershell',
    'Read', 'read_file', 'read', 'read_multiple_files',
    'Glob', 'Grep', 'grep', 'glob', 'list_dir', 'read_directory', 'web_search', 'WebSearch',
    'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'file_change', 'apply_patch', 'write_file', 'edit_file', 'search_replace', 'write',
    'ToolSearch', 'WebFetch', 'todo_write', 'shell',
  ];
  const summary = eventKindSummary(kinds.map((kind, index) => ({
    index,
    kind,
    status: 'running',
    providerType: 'assistant',
  })));
  assert.equal(summary.commands, 6);
  assert.equal(summary.filesRead, 4);
  assert.equal(summary.searches, 8);
  assert.equal(summary.edits, 10);
  assert.equal(summary.otherTools, 4);
  assert.equal(summary.total, 32);
  assert.equal(summary.text, '6 commands · 4 files read · 10 edits · 0 errors · 8 searches · 4 other tools');
  assert.equal(turnCountsText(summary), '6 commands · 4 files read · 8 searches · 10 edits · 4 other tools');
  assert.equal(eventKindSummary([{ index: 0, kind: 'agent', status: 'observed', providerType: 'tool_call_update' }]).total, 0);

  // The provider's own envelope records are metadata, not operations, so a
  // stream that ends with them reports no phantom tool.
  const envelope = eventKindSummary([
    { index: 0, kind: 'result', status: 'completed', providerType: 'result' },
    { index: 1, kind: 'usage', status: 'completed', providerType: 'usage' },
    { index: 2, kind: 'response', status: 'completed', providerType: 'assistant' },
  ]);
  assert.equal(envelope.total, 0);
  assert.equal(envelope.text, '0 commands · 0 files read · 0 edits · 0 errors');
});

test('every connector’s real capture kinds reach the operation summary through the decode path', () => {
  const repo = fileURLToPath(new URL('..', import.meta.url));
  const decode = (name) => {
    const connector = JSON.parse(readFileSync(join(repo, 'src', 'providers', name, 'connector.json'), 'utf8'));
    const rows = readFileSync(join(repo, 'tests', 'fixtures', 'stream', `${name}.jsonl`), 'utf8');
    const events = [];
    const decoder = createAgentEventDecoder(connector.eventStream, { onEvent: (event) => events.push(event) });
    decoder.push(rows, 'stdout', '2026-09-19T17:30:00.000Z');
    decoder.finish('2026-09-19T17:30:02.000Z');
    return events.map((event, index) => ({ ...event, index }));
  };

  // claude-code: the call carries the tool name (`Bash`) and its result is
  // `tool`; the trailing `result` envelope counts as nothing.
  const claude = decode('claude-code');
  assert.deepEqual(claude.map((event) => event.kind), ['Bash', 'tool', 'response', 'result']);
  const claudeGrouped = groupActivityTurns(claude);
  assert.equal(claudeGrouped.prelude.length, 2);
  assert.equal(eventKindSummary(claudeGrouped.prelude).text, '1 commands · 0 files read · 0 edits · 0 errors');
  assert.equal(eventKindSummary(claude).text, '1 commands · 0 files read · 0 edits · 0 errors');
  assert.equal(claudeGrouped.turns.at(-1).summary.total, 0);

  // codex: item kinds, unchanged by the normalisation.
  const codex = decode('codex');
  assert.equal(eventKindSummary(codex).text, '1 commands · 0 files read · 0 edits · 0 errors');

  // Grok updates are results that fold into the call with the same id.
  const grok = decode('grok');
  assert.equal(grok.filter((event) => event.kind === 'run_terminal_command').length, 1);
  assert.deepEqual(grok.filter((event) => event.providerType === 'tool_call_update').map((event) => event.kind), ['tool', 'tool', 'tool']);
  const grokSummary = eventKindSummary(grok);
  assert.equal(grokSummary.commands, 1);
  assert.equal(grokSummary.otherTools, 0);
  assert.equal(grokSummary.total, 1);
  assert.equal(grokSummary.text, '1 commands · 0 files read · 0 edits · 0 errors');
  const call = grok.findIndex((event) => event.providerType === 'tool_call');
  assert.deepEqual(pairActivityEvents(grok).map((pair) => [pair.startIndex, grok[pair.completeIndex].status]), [[call, 'completed']]);
  assert.deepEqual([...toolCallUpdates(grok).values()], [call, call]);
});

test('only a completed response closes a turn, and streamed chunks are that turn’s text', () => {
  const grouped = groupActivityTurns([
    { index: 0, kind: 'response', status: 'streaming', providerType: 'text', summary: 'I’ll' },
    { index: 1, kind: 'response', status: 'streaming', providerType: 'text', summary: ' read' },
    { index: 2, kind: 'response', status: 'streaming', providerType: 'text', summary: ' it.' },
    { index: 3, kind: 'response', status: 'completed', providerType: 'text', summary: null },
    { index: 4, kind: 'read_file', status: 'pending', providerType: 'tool_call' },
    { index: 5, kind: 'agent', status: 'observed', providerType: 'tool_call_update' },
    { index: 6, kind: 'response', status: 'streaming', providerType: 'text', summary: 'Done' },
    { index: 7, kind: 'response', status: 'streaming', providerType: 'text', summary: ' early.' },
  ]);
  assert.equal(grouped.turns.length, 2);
  assert.equal(grouped.responseCount, 2);
  assert.equal(grouped.prelude.length, 0);
  // The finished turn prints the text it streamed; its chunks are not rows and
  // not operations, and the atomic events after the completed response are the
  // work of this turn.
  assert.equal(grouped.turns[0].response.summary, 'I’ll read it.');
  assert.deepEqual(grouped.turns[0].atomicEvents.map((event) => event.index), [4, 5]);
  assert.deepEqual(grouped.turns[0].eventIndices, [0, 1, 2, 3, 4, 5]);
  assert.equal(grouped.turns[0].summary.total, 1);
  assert.equal(grouped.turns[0].summary.filesRead, 1);
  assert.equal(grouped.turns[0].summary.otherTools, 0);
  // A run that has not completed yet is still one turn, printing the chunks
  // captured so far: its last chunk ends the turn because nothing else will.
  assert.equal(grouped.turns[1].responseClosed, false);
  assert.equal(grouped.turns[1].response.summary, 'Done early.');
  assert.equal(grouped.turns[1].responseIndex, 6);
  assert.equal(grouped.turns[1].summary.total, 0);

  // A completed response that carries its own wording keeps it, so a provider
  // that never streams (codex, claude-code) is still one turn per response.
  const standalone = groupActivityTurns([
    { index: 0, kind: 'response', status: 'completed', providerType: 'item.completed', summary: 'first' },
    { index: 1, kind: 'command_execution', status: 'running', providerType: 'item.started' },
    { index: 2, kind: 'response', status: 'completed', providerType: 'assistant', summary: 'the finished answer' },
  ]);
  assert.equal(standalone.turns.length, 2);
  assert.equal(standalone.turns[0].response.summary, 'first');
  assert.equal(standalone.turns[0].responseChunks.length, 0);
  assert.equal(standalone.turns[0].summaryText, '1 commands · 0 files read · 0 edits · 0 errors');

  // Events captured before the first response stay the prelude, whatever they
  // are: a turn starts at a response.
  assert.deepEqual(groupActivityTurns([
    { index: 0, kind: 'command_execution', status: 'running', providerType: 'item.started' },
    { index: 1, kind: 'response', status: 'streaming', providerType: 'text', summary: 'late' },
  ]).prelude.map((event) => event.index), [0]);
});

test('v2 money pair retains measured zero and legacy aliases without inventing values', () => {
  const v2 = normalizeAttemptUsage({
    tokens: {
      standardRead: 10,
      cacheRead: 20,
      cacheWrite5m: 3,
      cacheWrite1h: 4,
      output: 5,
      reasoning: 6,
      totalKnown: 48,
    },
    tokenSource: 'provider-reported',
    api: { usd: 0, basis: 'provider-reported', pricedFields: ['standardRead', 'output'] },
    subscription: {
      pool: 'codex',
      window: 'weekly',
      deltaPct: 1.5,
      usd: 0.42,
      basis: 'observed:meter-delta',
    },
  });
  assert.equal(v2.tokens.totalKnown, 48);
  assert.equal(v2.api.usd, 0);
  assert.equal(v2.subscription.usd, 0.42);
  assert.match(v2.display, /\$0\.000 api/);
  assert.match(v2.display, /1\.5% wk/);

  const legacy = normalizeAttemptUsage({
    tokens: { standardRead: 7, output: 2 },
    tokenSource: 'estimated:utf8-bytes/4',
    cost: { estimatedUsd: 0.25, basis: 'legacy estimate' },
  });
  assert.equal(legacy.tokens.totalKnown, 9);
  assert.equal(legacy.api.usd, 0.25);
  assert.match(legacy.display, /~ \$0\.25 api estimated/);

  const unknown = normalizeAttemptUsage({
    tokens: { standardRead: 3 },
    tokenSource: 'estimated:utf8-bytes/4',
    cost: { estimatedUsd: null, basis: 'unknown: no model rate metadata' },
  });
  assert.equal(unknown.api.usd, null);
  assert.match(unknown.display, /api unknown/);
  assert.doesNotMatch(unknown.display, /\$0\.00/);
});

test('attempt selection can be explicit without changing the selected action', () => {
  const attempts = failedAttempts();
  const state = baseState({ actionId: 'cli', lifecycleStatus: 'partial', actionStatus: 'failed', attempts });
  const model = stepPageModel({ runId: state.runId, shortId: state.shortId, runDir: fixtureDir, state }, {
    actionId: 'cli',
    attemptOrdinal: 1,
    nowMs: fixedNow,
  });
  assert.equal(model.identity.actionId, 'cli');
  assert.equal(model.selectedAttempt.ordinal, 1);
  assert.equal(model.selectedAttempt.id, 'cli-1');
});

test('response turns preserve atomic capture order and expand without inferring file work', () => {
  const attempt = runningAttempt();
  const state = baseState({ attempts: [attempt] });
  const model = stepPageModel({ runId: state.runId, shortId: state.shortId, runDir: fixtureDir, state }, {
    nowMs: fixedNow,
    expandedTurn: 0,
  });
  assert.equal(model.view, 'overview');
  assert.equal(model.expandedTurn, 0);
  assert.deepEqual(model.overviewRows.map((row) => row.type), ['response', 'event', 'event', 'event', 'event', 'summary', 'response', 'summary']);
  assert.equal(model.activity.turns[0].atomicEvents.length, 4);
  assert.equal(model.activity.turns[0].summary.filesRead, 0);
  assert.equal(model.activity.turns[0].summary.edits, 0);

  const detail = stepPageModel({ runId: state.runId, shortId: state.shortId, runDir: fixtureDir, state }, {
    nowMs: fixedNow,
    view: 'detail',
  });
  assert.equal(detail.view, 'detail');
  assert.equal(detail.activity.todayEvents.length, 7);
  assert.equal(detail.activity.visibleDetailEvents.length, 7);
  assert.equal(detail.activity.events[1].kind, 'command_execution');
});

test('active duration is the union of attempt intervals and span remains secondary', () => {
  const attempts = [
    { ...runningAttempt('gap'), id: 'gap-1', actionId: 'gap', status: 'succeeded', startedAt: '2026-09-19T17:00:00.000Z', finishedAt: '2026-09-19T17:10:00.000Z', streamFile: null },
    { ...runningAttempt('gap'), id: 'gap-2', actionId: 'gap', ordinal: 2, status: 'succeeded', startedAt: '2026-09-19T17:20:00.000Z', finishedAt: '2026-09-19T17:25:00.000Z', streamFile: null },
  ];
  const state = baseState({ actionId: 'gap', lifecycleStatus: 'completed', actionStatus: 'succeeded', attempts });
  const model = stepPageModel({ runId: state.runId, shortId: state.shortId, runDir: fixtureDir, state }, { nowMs: fixedNow });
  assert.equal(model.activeDurationMs, 15 * 60 * 1000);
  assert.equal(model.spanDurationMs, 25 * 60 * 1000);
  assert.equal(model.activeMinutes, 15);
  assert.equal(model.spanMinutes, 25);
});

test('single-task adapter keeps ledger facts and marks workflow-only fields unavailable', () => {
  const model = taskStepModel({
    id: 'task-1',
    project: null,
    lane: 'build',
    pool: 'codex',
    model: 'gpt-5.6-luna',
    startedAt: '2026-09-19T17:00:00.000Z',
    endedAt: '2026-09-19T17:02:00.000Z',
    durationMs: 120000,
    ok: false,
    reason: 'provider stopped',
    taskFile: fixture('task.md'),
    outFile: fixture('output.md'),
  }, { nowMs: fixedNow });
  assert.equal(model.identity.actionId, 'task-1');
  assert.equal(model.identity.project, null);
  assert.equal(model.route.lane, 'build');
  assert.equal(model.header.effort, null);
  assert.equal(model.identity.workflowStatus, null);
  assert.equal(model.identity.verified, null);
  assert.equal(model.activity.available, false);
  assert.equal(model.artifacts.stream, null);
  assert.equal(model.taskResult, 'provider stopped');
  assert.equal(model.cost.tokens.totalKnown, null);
});

test('real copied-home detail stream groups the observed 325-event capture', () => {
  const state = JSON.parse(readFileSync(join(realSnapshotRun, 'state.json'), 'utf8'));
  const model = stepPageModel({
    runId: state.runId,
    shortId: state.shortId,
    runDir: realSnapshotRun,
    state,
  }, { actionId: 'step-model', nowMs: fixedNow });
  assert.equal(model.activity.events.length, 325);
  assert.equal(model.activity.responseCount, 15);
  assert.equal(model.activity.turns.length, 15);
  assert.equal(model.activity.filterCounts.turns, 15);
  // Codex writes one finished response per turn and never streams chunks, so
  // every window below is the same one the boundary rule always produced.
  assert.ok(model.activity.turns.every((turn) => turn.responseChunks.length === 0));
  // 240 command_execution events are 120 commands and 70 file_change events
  // are 35 edits: every operation was captured as an item.started and an
  // item.completed, so a summary that counted raw events would double them.
  assert.equal(model.activity.turns.reduce((total, turn) => total + turn.summary.commands, 0), 120);
  assert.equal(model.activity.turns.reduce((total, turn) => total + turn.summary.edits, 0), 35);
  assert.equal(model.activity.turns.reduce((total, turn) => total + turn.summary.filesRead, 0), 0);
  assert.equal(model.activity.turns.reduce((total, turn) => total + turn.summary.errors, 0), 0);
  // The two turns the independent verifier checked: R2 ran 35 commands (70 raw
  // events) and R6 made 10 edits (20 raw events).
  assert.equal(model.activity.turns[1].summary.commands, 35);
  assert.equal(model.activity.turns[1].summary.text, '35 commands · 0 files read · 0 edits · 0 errors');
  assert.equal(model.activity.turns.at(-1).summary.commands, 0);
  assert.equal(model.activity.turns[5].summary.edits, 10);
  assert.equal(model.activity.turns[5].summary.text, '16 commands · 0 files read · 10 edits · 0 errors');
  assert.equal(model.activity.turns[5].atomicEvents.filter((event) => event.kind === 'command_execution').length, 32);
  assert.equal(model.activity.turns[5].atomicEvents.filter((event) => event.kind === 'file_change').length, 20);
  assert.equal(model.activity.turns.reduce((total, turn) => total + turn.summary.otherTools, 0), 0);
  assert.equal(model.activity.turns.reduce((total, turn) => total + turn.summary.total, 0), 155);
});

test('a real claude-code step counts its raw tool names instead of reporting zeros', () => {
  const state = JSON.parse(readFileSync(join(realClaudeRun, 'state.json'), 'utf8'));
  const model = stepPageModel({
    runId: state.runId,
    shortId: state.shortId,
    runDir: realClaudeRun,
    state,
  }, { actionId: 'accept', attemptOrdinal: 5, nowMs: fixedNow });
  assert.equal(model.selectedAttempt.pool, 'claude-code');
  assert.equal(model.selectedAttempt.ordinal, 5);
  assert.equal(model.activity.events.length, 505);
  assert.equal(model.activity.turns.length, 31);
  // The capture holds 231 Bash, 237 `tool` results, 31 responses, 4 Read, 1
  // Write and 1 ToolSearch. The results answer the 237 calls, so the page must
  // report the 237 operations and not 474 events.
  const total = (field) => model.activity.turns.reduce((sum, turn) => sum + turn.summary[field], 0);
  assert.equal(model.activity.filterCounts.tools, 473);
  assert.equal(total('commands'), 231);
  assert.equal(total('filesRead'), 4);
  assert.equal(total('edits'), 1);
  assert.equal(total('otherTools'), 1);
  assert.equal(total('errors'), 1);
  assert.equal(total('total'), 237);
  assert.equal(model.activity.turns[0].summary.text, '125 commands · 4 files read · 0 edits · 1 errors · 1 other tools');
  assert.equal(model.activity.turns[0].summary.otherTools, 1);
  assert.equal(model.presentation.activity.turns[0].countsText, '125 commands · 4 files read · 1 ToolSearch · 1 error');
  // No turn that captured tool events may read as zeros.
  for (const turn of model.activity.turns) {
    if (turn.atomicEvents.length) assert.ok(turn.summary.total > 0, `turn ${turn.index + 1} reported no operation`);
  }
});

test('a real grok step counts its own tool names instead of reporting zeros', () => {
  const state = JSON.parse(readFileSync(join(realGrokRun, 'state.json'), 'utf8'));
  const model = stepPageModel({
    runId: state.runId,
    shortId: state.shortId,
    runDir: realGrokRun,
    state,
  }, { actionId: 'verify', attemptOrdinal: 1, nowMs: fixedNow });
  assert.equal(model.selectedAttempt.pool, 'grok');
  assert.equal(model.activity.events.length, 1084);
  const total = (field) => model.activity.turns.reduce((sum, turn) => sum + turn.summary[field], 0);
  // Connector tool kinds separate reads from searches; nameless progress
  // updates are captures of their calls, not operations of their own.
  assert.equal(total('commands'), 25);
  assert.equal(total('filesRead'), 89);
  assert.equal(total('searches'), 47);
  assert.equal(total('edits'), 1);
  assert.equal(total('otherTools'), 9);
  assert.equal(total('errors'), 1);
  assert.equal(total('total'), 171);
  assert.equal(model.activity.events.filter((event) => event.providerType === 'tool_call').length, 171);
  assert.ok(model.presentation.activity.turns.every((turn) => !/\bagent\b/.test(turn.countsText)));
  assert.ok(model.activity.turns.every((turn) => turn.atomicEvents.length > 0 ? turn.summary.total > 0 : true));
  assert.ok(model.activity.turns.some((turn) => turn.summary.filesRead > 0));
  assert.ok(model.activity.turns.some((turn) => turn.summary.commands > 0));
  assertStreamedTurnBoundary(model);
});

// The grok connector streams `response/streaming` deltas and closes each run
// with a summary-less `response/completed` terminator. Reading every response
// as a boundary made 474 turns out of 458 chunks and 16 responses, 459 of them
// empty; the capture holds 16 responses, so the page must show 16 turns, each
// printing the text the provider actually streamed.
function assertStreamedTurnBoundary(model) {
  const { activity } = model;
  const chunks = activity.events.filter((event) => event.kind === 'response' && event.status === 'streaming');
  const completed = activity.events.filter((event) => event.kind === 'response' && event.status === 'completed');
  assert.equal(chunks.length, 458);
  assert.equal(completed.length, 16);
  assert.equal(activity.turns.length, 16);
  assert.equal(activity.responseCount, 16);
  assert.equal(activity.filterCounts.turns, 16);
  assert.equal(activity.turns.reduce((count, turn) => count + turn.responseChunks.length, 0), 458);
  assert.equal(activity.overviewRows.filter((row) => row.type === 'response').length, 16);
  // A turn prints the response it finished with; its chunks are the turn's own
  // text and never a row, and no turn reads as unknown text.
  for (const turn of activity.turns) {
    assert.equal(turn.response.status, 'completed');
    assert.ok(String(turn.response.summary ?? '').trim(), `turn ${turn.index + 1} printed no response text`);
    assert.ok(turn.responseChunks.every((chunk) => chunk.status === 'streaming'));
  }
  // The fixture's placeholder words (scripts/build-test-home.mjs), joined from
  // the streamed chunks exactly as the provider's own words were.
  assert.equal(activity.turns[0].response.summary, 'enim sunt amet sample magna nisi nisi ipsum et f aute nisi ea enim sed.');
  assert.equal(activity.turns.at(-1).response.summary, 'officia occaecat consequat cupidatat.');
  // Only the closing turn holds no atomic events, and the raw stream really
  // captured none after its last completed response.
  assert.deepEqual(
    activity.turns.filter((turn) => turn.atomicEvents.length === 0).map((turn) => turn.index),
    [15],
  );
  assert.equal(activity.turns.at(-1).responseIndex, activity.events.at(-1).index);
}

test('the grok step page renders one row per response instead of one per streamed chunk', () => {
  const state = JSON.parse(readFileSync(join(realGrokRun, 'state.json'), 'utf8'));
  const row = {
    runId: state.runId,
    shortId: state.shortId,
    runDir: realGrokRun,
    project: state.project ?? null,
    state,
    status: state.lifecycle.status,
    ongoing: false,
  };
  const panel = workflowPanelModel(row);
  const phaseIndex = Math.max(0, panel.phases.findIndex((phase) => phase.actions.some((action) => action.id === 'verify')));
  const agents = workflowPanelModel(row, { phaseIndex }).agents;
  const agentIndex = Math.max(0, agents.findIndex((agent) => agent.action.id === 'verify'));
  const render = (stepView) => renderDashboardPage(dashboardModel(row, { runs: [row], nowMs: fixedNow }), {
    page: 'step', width: 120, height: 3000, nowMs: fixedNow, rows: [row], allRows: [row],
    selectedRunId: row.runId, stepView, stepAttemptOrdinal: 1, phaseIndex, agentIndex,
  }).lines.map((line) => String(line ?? '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''));
  const turnRows = (lines) => {
    const rows = new Set();
    for (const line of lines) {
      const match = line.match(/^ {0,2}(\d+) {2}\d\d:\d\d {2}/);
      if (match) rows.add(match[1]);
    }
    return rows;
  };
  // The overview opens on the newest ten turns and one line for the six above
  // them (step-v2 rule 13); the transcript lists every turn (rule 12).
  const overview = render('overview');
  assert.deepEqual([...turnRows(overview)], ['7', '8', '9', '10', '11', '12', '13', '14', '15', '16']);
  assert.ok(overview.some((line) => /^ turns 1–6 · .*click for detail/.test(line)), overview.join('\n'));
  const lines = render('detail');
  assert.equal(turnRows(lines).size, 16);
  assert.ok(lines.some((line) => line.includes('enim sunt amet sample magna nisi nisi ipsum et f aute nisi')));
  assert.ok(lines.some((line) => /^ {0,2}16 {2}\d\d:\d\d {2}officia occaecat consequat cupidatat\./.test(line)));
  assert.ok(lines.some((line) => line.includes('officia occaecat consequat cupidatat.')));
});

test('a still-streaming attempt closes its turn on the last chunk it captured', () => {
  const parsed = parseAttemptStream(join(realGrokRun, 'stream-verify-attempt-1.jsonl'));
  const closing = parsed.events.filter((event) => event.kind === 'response' && event.status === 'completed').at(-1);
  // Everything the run streamed before its final completed response: the last
  // turn is the 5 chunks that had not been terminated yet.
  const streaming = groupActivityTurns(parsed.events.slice(0, closing.index));
  assert.equal(streaming.turns.length, 16);
  const last = streaming.turns.at(-1);
  assert.equal(last.responseClosed, false);
  assert.equal(last.responseChunks.length, 5);
  assert.equal(last.response.summary, 'officia occaecat consequat cupidatat.');
  // The same provider text reaches the row whether the run finished or is
  // still streaming: the joined chunks are the turn's own words either way.
  const finished = groupActivityTurns(parsed.events);
  assert.equal(last.response.summary, finished.turns.at(-1).response.summary);
  assert.equal(streaming.turns.at(-1).atomicEvents.length, 0);
});

// Keep the fixture provenance visible to maintainers without reading the
// copied home during every test run.
test('fixture stream is a copied-home capture, not provider prose reconstruction', () => {
  const firstLine = readFileSync(fixture('running-stream.jsonl'), 'utf8').split('\n')[0];
  assert.match(firstLine, /"providerType":"item\.completed"/);
  assert.match(firstLine, /2026-09-19T17:50:31\.709Z/);
});

test('the clock, the counts and the command wrapper are the design’s own words', () => {
  assert.equal(stepClockText(2946_700), '49m07s');
  assert.equal(stepClockText(3_600_000), '1h00m');
  assert.equal(stepClockText(30_000), '30s');
  assert.equal(stepClockText(null), null);

  const zero = { commands: 0, filesRead: 0, edits: 0, otherTools: 0, errors: 0 };
  assert.equal(turnCountsText(zero), 'no tools');
  assert.equal(turnCountsText({ ...zero, commands: 1, errors: 1 }), '1 command · 1 error');
  assert.equal(turnCountsText({ ...zero, commands: 14, edits: 3 }), '14 commands · 3 edits');
  assert.equal(turnCountsText({ ...zero, otherTools: 2 }, { otherKinds: ['grep'] }), '2 grep');
  assert.equal(turnCountsText({ ...zero, otherTools: 4 }, { otherKinds: ['grep', 'fetch'] }), '4 other tools');

  // The connector's own spawn wrapper never reaches a tool row; a capture the
  // provider clipped keeps the text it has, and a non-command is untouched.
  assert.equal(toolSummaryText('command', '/bin/zsh -lc "rtk npm test"'), 'rtk npm test');
  assert.equal(toolSummaryText('command', "/bin/zsh -lc 'rtk npm test'"), 'rtk npm test');
  assert.equal(toolSummaryText('command', '/bin/zsh -lc "rtk npm test'), 'rtk npm test');
  assert.equal(toolSummaryText('command', 'npm test'), 'npm test');
  assert.equal(toolSummaryText('read', '/bin/zsh -lc "cat file"'), '/bin/zsh -lc "cat file"');

  // A report's leading lines collapse the way the design's card prints them.
  assert.deepEqual(reportLeadLines([
    'Built the sample model layer.',
    '',
    'Files added:',
    '',
    '- [step-model.js](/tmp/step-model.js): identity and verdict.',
    '- [second.md](/tmp/second.md): another file.',
  ].join('\n')), [
    'Built the sample model layer.',
    'Files added: step-model.js: identity and verdict.',
    'second.md: another file.',
  ]);
  // `asks` exists only when the report carries the kernel prompt's heading.
  assert.deepEqual(sharedFileRequests('## Result\nnothing asked'), []);
  assert.deepEqual(sharedFileRequests('## Shared-file requests\n\n- [step-view.js](/tmp/step-view.js) needs the shell hook\n- and the frames\n'), [
    'step-view.js needs the shell hook and the frames',
  ]);
});

test('a followed running turn opens and pins its in-flight tool with a live clock', () => {
  const attempt = runningAttempt();
  const state = baseState({ attempts: [attempt] });
  const model = stepPageModel({
    runId: state.runId,
    shortId: state.shortId,
    runDir: fixtureDir,
    state,
  }, { nowMs: fixedNow });
  const current = model.presentation.activity.turns.at(-1);
  assert.equal(model.activity.expandedTurn, current.index);
  assert.equal(current.expanded, true);
  assert.match(current.countsText, /running: copy the Bullswarm home before ins.*18m/);
  const tool = current.toolRows.at(-1);
  assert.equal(tool.inFlight, true);
  assert.equal(tool.text, 'copy the Bullswarm home before inspection');
  assert.equal(tool.durationText, '18m47s');
  assert.doesNotMatch(current.toolRows.map((row) => row.text).join('\n'), /summary unavailable/);
  assert.doesNotMatch(current.toolRows.map((row) => row.durationText ?? '').join('\n'), /0s/);
});

test('null file-change summaries stay legible in expanded rows', () => {
  assert.ok(existsSync(join(realSnapshotRun, 'state.json')), `real snapshot missing: ${realSnapshotRun}`);
  const state = JSON.parse(readFileSync(join(realSnapshotRun, 'state.json'), 'utf8'));
  const model = stepPageModel({
    runId: state.runId,
    shortId: state.shortId,
    runDir: realSnapshotRun,
    state,
  }, {
    actionId: 'step-model',
    nowMs: Date.parse('2026-09-19T18:39:26.632Z'),
    expandedTurn: 2,
    follow: false,
  });
  const rows = model.presentation.activity.turns[2].toolRows;
  assert.ok(rows.length >= 1);
  assert.ok(rows.every((row) => row.text === 'file change'));
  assert.doesNotMatch(rows.map((row) => row.text).join('\n'), /summary unavailable/);
  assert.doesNotMatch(rows.map((row) => row.durationText ?? '').join('\n'), /0s/);
});

test('the real step’s presentation reads the report, the diff, the turns and the cost codes', () => {
  const state = JSON.parse(readFileSync(join(realSnapshotRun, 'state.json'), 'utf8'));
  const model = stepPageModel({
    runId: state.runId,
    shortId: state.shortId,
    runDir: realSnapshotRun,
    state,
  }, { actionId: 'step-model', nowMs: Date.parse('2026-09-19T18:39:26.632Z') });
  const { header, activity, result, task, cost } = model.presentation;

  // Line 1 said once: verdict, attempt, one clock and the route sentence.
  assert.equal(header.state, 'ok');
  assert.equal(header.verdictText, 'verified by the workflow (6/6 requirements)');
  assert.equal(header.attemptText, 'attempt 1 of 1');
  assert.equal(header.activeText, '49m07s');
  assert.equal(header.spanText, null);
  assert.equal(header.startedClock, '01:50');
  assert.equal(header.finishedClock, '02:39');
  assert.equal(header.dateText, '20 Sep 2026');
  assert.equal(header.reasoning, 'max');
  assert.equal(header.route, 'expiring soon: codex resets in 8h28m, surplus 11.8 over 5% of the week left → urgency 236 · picked over command-code, grok');

  // Turns: the counts a row prints, the last turn marked as the result.
  assert.equal(activity.turns.length, 15);
  assert.equal(activity.totals.commands, 120);
  assert.equal(activity.turns[1].countsText, '35 commands');
  assert.equal(activity.turns[2].countsText, '2 edits');
  assert.equal(activity.turns[11].countsText, '1 command');
  assert.equal(activity.turns.at(-1).resultMarked, true);
  assert.equal(activity.turns.at(-1).clock, '02:39');
  // The turn's own text is the whole report; the row prints its first line.
  assert.match(activity.turns.at(-1).text, /^sample report magna exercitation\./);

  // Result: the report's own first lines, the diff's paths, the artifact row.
  assert.deepEqual(result.reportLines.slice(0, 2), [
    'sample report magna exercitation.',
    'sample sint: sample exercitation nisi consequat cillum anim id exercitation culpa ut veniam exercitation fugiat ex sint nulla irure adipiscing id labore dolor excepteur commodo commodo dolore deserunt do nulla dolore sint non fugiat nostrud eiusmod ex cupidatat sit quis esse enim officia sint non exercitation ipsum.',
  ]);
  assert.deepEqual(result.changed, ['src/dir-01/file-267.js', 'tests/file-268.test.js']);
  assert.deepEqual(result.asks, []);
  assert.equal(result.runDirShort, 'wf-mu8ni8o4-f9baaf');
  assert.equal(result.streamEvents, 325);
  assert.equal(result.reportBytesText, '1.3 KB');
  assert.equal(result.verification.passed, 6);
  assert.equal(result.verification.total, 6);

  // Task: the author's own prompt, the program's short facts, its byte sizes.
  assert.equal(task.kind, 'implement');
  assert.equal(task.lane, 'build');
  assert.deepEqual(task.owns, ['file-267.js', 'file-268.test.js']);
  assert.deepEqual(task.after, ['extract', 'stream-contract']);
  assert.deepEqual(task.affects, ['requirement 3', 'requirement 6']);
  assert.equal(task.bytes.authorPrompt, 2444);
  assert.equal(task.bytes.taskFile, 5109);

  // Cost: two rows of plain words over the finite codes, and the closing line.
  assert.equal(cost.rows[0].label, 'API rate');
  assert.equal(cost.rows[0].amount, '$0.96');
  assert.equal(cost.rows[0].headline, '36.0M tokens · OpenAI rate card, 20 Sep');
  assert.deepEqual(cost.rows[0].details, ['35.2M cache read', '713k input', '58k output', '37k reasoning']);
  assert.equal(cost.rows[1].label, 'codex plan');
  assert.equal(cost.rows[1].amount, '—');
  assert.equal(cost.rows[1].headline, 'no meter reading for this attempt');
  assert.deepEqual(cost.rows[1].details, ['$100/mo', 'weekly window']);
  assert.equal(cost.rows[1].phoneText, 'no meter reading · $100/mo weekly');
  assert.equal(cost.basisLine, 'measured from the codex transcript');
});

test('a mixed-pool real step keeps plan prices per pool and names the selected attempt share', () => {
  assert.ok(existsSync(join(realClaudeRun, 'state.json')), `real snapshot missing: ${realClaudeRun}`);
  const state = JSON.parse(readFileSync(join(realClaudeRun, 'state.json'), 'utf8'));
  const model = stepPageModel({
    runId: state.runId,
    shortId: state.shortId,
    runDir: realClaudeRun,
    state,
  }, { actionId: 'accept', attemptOrdinal: 5, nowMs: fixedNow });
  const { header, cost } = model.presentation;

  assert.equal(header.pool, 'claude-code');
  assert.equal(header.model, 'claude-opus-5');
  assert.equal(header.attemptText, 'attempt 5 of 5');
  assert.equal(model.moneyPair.subscription.monthlyPriceUsd, null);
  assert.equal(cost.attemptCount, 5);
  assert.equal(cost.rows[0].headline, '77.6M tokens · xAI + Anthropic rate cards, 20 Sep');
  assert.equal(cost.rows[0].details.at(-1), 'this attempt $28.21 · 45.95M tokens · Anthropic rate card');
  assert.equal(cost.rows[1].label, 'plans');
  assert.equal(cost.rows[1].amount, '—');
  assert.equal(cost.rows[1].headline, 'grok $30/mo · claude-code $200/mo');
  assert.deepEqual(cost.rows[1].details, ['no meter reading for this attempt', 'weekly window']);
  assert.equal(cost.basisLine, 'measured from the recorded attempts');
  assert.doesNotMatch(JSON.stringify(cost), /\$660\/mo/);
});

test('a same-pool two-attempt real codex step shows one plan price, never a sum', () => {
  assert.ok(existsSync(join(realTwoAttemptCodexRun, 'state.json')), `real snapshot missing: ${realTwoAttemptCodexRun}`);
  const state = JSON.parse(readFileSync(join(realTwoAttemptCodexRun, 'state.json'), 'utf8'));
  const model = stepPageModel({
    runId: state.runId,
    shortId: state.shortId,
    runDir: realTwoAttemptCodexRun,
    state,
  }, { actionId: 'integrate', attemptOrdinal: 2, nowMs: fixedNow });
  const { cost } = model.presentation;

  assert.equal(model.moneyPair.subscription.monthlyPriceUsd, 100);
  assert.equal(cost.attemptCount, 2);
  assert.equal(cost.rows[1].label, 'codex plan');
  assert.equal(cost.rows[1].details[0], '$100/mo');
  assert.doesNotMatch(JSON.stringify(cost.rows[1]), /\$200\/mo/);
  assert.equal(cost.rows[0].headline, '4.1M tokens · OpenAI rate card, 20 Sep');
});

test('a running step shows only the events captured by its clock', () => {
  const state = JSON.parse(readFileSync(join(realSnapshotRun, 'state.json'), 'utf8'));
  const projected = {
    ...state,
    lifecycle: { ...state.lifecycle, status: 'running', finishedAt: null },
    attempts: state.attempts.map((attempt) => (attempt.id === 'step-model-1'
      ? { ...attempt, status: 'running', finishedAt: null, usage: null, bytes: null }
      : attempt)),
    actions: state.actions.map((action) => (action.id === 'step-model'
      ? { ...action, status: 'running', finishedAt: null }
      : action)),
  };
  // The design record's caption: the frame at the 202nd event, 02:20:26 HKT.
  const at202 = Date.parse('2026-09-19T18:20:26.469Z');
  const model = stepPageModel({ runId: state.runId, shortId: state.shortId, runDir: realSnapshotRun, state: projected }, {
    actionId: 'step-model', nowMs: at202,
  });
  assert.equal(model.activity.events.length, 202);
  assert.equal(model.presentation.result.running, true);
  assert.equal(model.presentation.activity.turns.length, 8);
  assert.equal(model.presentation.activity.totals.commands, 76);
  assert.equal(model.presentation.header.lastEventClock, '02:20:26');
  assert.equal(model.presentation.header.lastEventMs, at202);
  assert.equal(model.presentation.header.turnNumber, 8);
  assert.equal(model.presentation.cost.running, true);
  assert.equal(model.presentation.cost.rows.every((row) => row.unknown), true);
  assert.equal(model.presentation.cost.basisLine, 'measured when the attempt finishes');
  // Three seconds later the same 202 events are still all there was.
  const later = stepPageModel({ runId: state.runId, shortId: state.shortId, runDir: realSnapshotRun, state: projected }, {
    actionId: 'step-model', nowMs: at202 + 3000,
  });
  assert.equal(later.activity.events.length, 202);
});

test('a Claude Bash event never reads as an edit: its {command, description} arguments are not change paths', () => {
  // Real shape from run 8zgqei attempt verify-7 (claude-code:acme, 2026-09-20): kind/toolName Bash,
  // summary = the command, arguments = { command, description }.
  const bash = {
    kind: 'Bash', toolName: 'Bash', status: 'running', index: 0, seq: 3,
    summary: 'cat /home/dev/.bullswarm/workflows/wf-mu91u6xh-0441fd/task-verify-attempt-7.md',
    arguments: { command: 'cat /home/dev/.bullswarm/workflows/wf-mu91u6xh-0441fd/task-verify-attempt-7.md', description: 'Read the task instructions' },
  };
  assert.equal(eventToolSummary(bash), 'cat /home/dev/.bullswarm/workflows/wf-mu91u6xh-0441fd/task-verify-attempt-7.md');
  // A Claude Edit call names its one file; a Codex file_change names its changes array.
  assert.equal(eventToolSummary({ kind: 'Edit', toolName: 'Edit', status: 'running', index: 1, seq: 4, summary: null,
    arguments: { file_path: 'src/workflow/run-view.js', old_string: 'a', new_string: 'b' } }), 'edit src/workflow/run-view.js');
  const codex = eventToolSummary({ kind: 'file_change', status: 'completed', index: 2, seq: 5, summary: null,
    arguments: { changes: [{ path: 'src/a.js', kind: 'update' }, { path: 'tests/a.test.js', kind: 'add' }] } });
  assert.match(codex, /^\w+ src\/a\.js · add tests\/a\.test\.js$/);
});

test('a codex result envelope closes a turn but never opens one: the QA task shows two turns, not three', () => {
  // Real capture: `bullswarm run --lane=analyze` on codex gpt-5.6-luna, 2026-09-20 21:57 HKT,
  // 15 events = 2 responses, 6 paired commands, 1 `result` (turn.completed) envelope.
  const parsed = parseAttemptStream(new URL('./fixtures/streams/codex-qa-task-2026-09-20.jsonl', import.meta.url).pathname);
  assert.equal(parsed.events.length, 15);
  const grouped = groupActivityTurns(parsed.events);
  assert.equal(grouped.turns.length, 2);
  assert.equal(grouped.responseCount, 2);
  assert.match(grouped.turns[1].responseText ?? grouped.turns[1].response?.summary ?? '', /^sample response excepteur aute non ad/);
});

// Step-v2 rule 12 (0.35.2): the detail view is the transcript. Every captured
// event the 0.35.1 capture-order log listed stays reachable: a tool row stands
// for its call and its completion, a turn head for its response, streamed
// chunks and envelope captures, and the prelude for what came before turn 1.
test('the transcript rows cover every captured event on real codex, claude-code and grok streams', () => {
  const cases = [
    [realSnapshotRun, 'step-model', 1],
    [realClaudeRun, 'accept', 5],
    [realGrokRun, 'verify', 1],
  ];
  for (const [runDir, actionId, attemptOrdinal] of cases) {
    const state = JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8'));
    const input = { runId: state.runId, shortId: state.shortId, runDir, state };
    const detail = stepPageModel(input, { actionId, attemptOrdinal, nowMs: fixedNow, view: 'detail' });
    const activity = detail.presentation.activity;
    assert.ok(activity.turns.length > 1, `${actionId}: the stream has turns`);
    const covered = new Set();
    for (const turn of activity.turns) {
      for (const index of turn.headEventIndices) covered.add(index);
      for (const tool of turn.toolRows) for (const index of tool.eventIndices) covered.add(index);
    }
    for (const index of activity.prelude?.headEventIndices ?? []) covered.add(index);
    for (const tool of activity.prelude?.toolRows ?? []) for (const index of tool.eventIndices) covered.add(index);
    const missing = detail.activity.events.filter((event) => !covered.has(event.index));
    assert.deepEqual(missing.map((event) => `${event.index}:${event.kind}`), [], `${actionId}: events no row reaches`);
    // Each row stands for its own captures: a pair is its start and completion.
    for (const tool of activity.turns.flatMap((turn) => turn.toolRows)) {
      assert.equal(tool.eventIndices[0], tool.index);
      assert.ok(tool.eventIndices.length <= 2);
    }
    // The overview keeps its rows to the one open turn.
    const overview = stepPageModel(input, { actionId, attemptOrdinal, nowMs: fixedNow });
    assert.ok(overview.presentation.activity.turns.every((turn) => turn.expanded || turn.toolRows.length === 0));
  }
});
