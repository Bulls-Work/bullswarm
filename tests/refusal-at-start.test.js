// A dead sign-in seen by the meter keeps the pool out of the pick, and a
// refusal at start (a sign-in failure or a model the plan does not include,
// before any work) is picked again without spending the step's one retry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { getMeterReading, meterSignInFailed } from '../src/meters/registry.js';
import { fetchCodexUsage } from '../src/providers/codex/provider.mjs';
import { previewStepPick } from '../src/workflow/pick-preview.js';
import { streamShowsWork } from '../src/workflow/dispatch-handoff.js';
import { countRefusalRepicks, countRetries } from '../src/workflow/step-vocabulary.js';
import { MeterCache, FRESH_MS } from '../src/meters/framework.js';
import { buildPools } from '../src/lib/config.js';
import { preparePools } from '../src/workflow/dispatch-pools.js';
import { noPoolCandidates } from '../src/workflow/dispatch-no-pool.js';
import { poolStatusText } from '../src/cli.js';
import { dispatchV2Action, MAX_REFUSAL_REPICKS } from '../src/workflow/v2-dispatch.js';
import { needsYouFacts, renderNeedsYou } from '../src/workflow/needs-you.js';
import { normalizeAttempt } from '../src/workflow/attempt-record.js';
import { createV2GoalDocument, createV2State } from '../src/workflow/v2-state.js';
import { deriveV2DependencyStages } from '../src/workflow/v2-presentation.js';
import { stepPageModel } from '../src/workflow/step-model.js';
import { runV2AutonomousWorkflow } from '../src/workflow/v2-runtime.js';
import { implicitV3Requirements } from '../src/workflow/program-v3.js';
import { createAgentEventDecoder } from '../src/lib/agent-events.js';

const HOUR = 60 * 60 * 1000;

function snapshotAt(ms, used = 10) {
  return {
    captured_at: new Date(ms).toISOString(),
    five_hour: { utilization: used, resets_at: new Date(ms + 3 * HOUR).toISOString() },
    seven_day: { utilization: used, resets_at: new Date(ms + 72 * HOUR).toISOString() },
  };
}

function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'bs-refusal-'));
  return Promise.resolve(fn(home)).finally(() => rmSync(home, { recursive: true, force: true }));
}

// A reading as the registry gives it, then the pool the pick sees.
function pickPoolFrom(reading, nowMs) {
  const pool = {
    name: 'pool-a', enabled: true, lanes: ['analyze', 'build', 'chore'],
    connector: { name: 'pool-a', spawn: { cmd: ['fake'] }, modelSelection: { flag: '--model' } },
    strategyAssignments: { low: { pool: 'pool-a', model: 'model-a' } },
  };
  return Object.assign(pool, {
    meterError: reading.meterError ?? null,
    meterHoldUntil: reading.holdUntil ?? null,
    meterSignInFailed: reading.signInFailed === true,
  }, { _now: nowMs });
}

const step = { id: 'review', role: 'analyze', lane: 'build', effort: 'low' };

for (const [label, ageMs] of [['a fresh-looking cache', 30_000], ['a 7-hour-old cache', 7 * HOUR]]) {
  test(`meter: a 401 hold with ${label} keeps the pool out of the pick with the sign-in reason`, () => withHome(async (home) => {
    const nowMs = Date.parse('2026-10-01T09:27:21Z');
    const cache = new MeterCache(join(home, 'meters'));
    cache.put('pool-a', snapshotAt(nowMs - ageMs));
    cache.putHold('pool-a', { failed_at: new Date(nowMs - 1000).toISOString(), retry_after_ms: FRESH_MS, reason: '401' });
    const reading = await getMeterReading('pool-a', { bullswarmDir: home, nowMs, reader: async () => { throw new Error('must not poll'); } });
    assert.equal(reading.source, 'stale');
    assert.equal(reading.signInFailed, true);
    const pool = pickPoolFrom(reading, nowMs);
    assert.deepEqual(preparePools([pool], step, 'low', { now: nowMs }).map((p) => p.name), []);
    const [row] = noPoolCandidates([pool], step, 'low', {
      lane: 'build', failedProbes: new Set(), onLane: () => true, held: [], now: nowMs,
    });
    assert.equal(row.excluded, 'sign-in failed (meter read 401)');
    assert.match(poolStatusText(pool), /^not ready · sign-in failed \(meter read 401\)$/);
  }));
}

test('meter: a live read that answers 401 (or an auth 403 its provider marks) writes a sign-in hold', () => withHome(async (home) => {
  const nowMs = Date.parse('2026-10-01T09:27:21Z');
  const cache = new MeterCache(join(home, 'meters'));
  cache.put('pool-a', snapshotAt(nowMs - 7 * HOUR));
  const unauthorized = Object.assign(new Error('HTTP 401'), { status: 401 });
  const first = await getMeterReading('pool-a', { bullswarmDir: home, nowMs, reader: async () => { throw unauthorized; } });
  assert.equal(first.signInFailed, true);
  assert.equal(cache.getHold('pool-a').sign_in_failed, true);
  const forbidden = Object.assign(new Error('HTTP 403'), { status: 403, signInFailed: true });
  const second = await getMeterReading('pool-b', { bullswarmDir: home, nowMs, reader: async () => { throw forbidden; } }).catch((error) => error);
  assert.equal(second.signInFailed, true, 'no cache: the thrown error carries it');
  const reread = await getMeterReading('pool-b', { bullswarmDir: home, nowMs: nowMs + 1000 }).catch((error) => error);
  assert.equal(reread.signInFailed, true, 'the persisted 403 hold still says sign-in');
}));

test('meter: a 429 or network hold keeps today\'s behaviour (the pool stays pickable)', () => withHome(async (home) => {
  const nowMs = Date.parse('2026-10-01T09:27:21Z');
  const cache = new MeterCache(join(home, 'meters'));
  for (const [pool, reason] of [['pool-a', '429'], ['pool-c', 'network']]) {
    cache.put(pool, snapshotAt(nowMs - 30_000));
    cache.putHold(pool, { failed_at: new Date(nowMs - 1000).toISOString(), retry_after_ms: FRESH_MS, reason });
    const reading = await getMeterReading(pool, { bullswarmDir: home, nowMs });
    assert.equal(reading.signInFailed, undefined);
    const prepared = pickPoolFrom(reading, nowMs);
    assert.equal(preparePools([prepared], step, 'low', { now: nowMs }).length, 1, reason);
    assert.match(poolStatusText(prepared), /^ready/);
  }
}));

test('meter: after the 401 hold expires a successful read makes the pool pickable again, and nothing else is stored', () => withHome(async (home) => {
  const nowMs = Date.parse('2026-10-01T09:27:21Z');
  const cache = new MeterCache(join(home, 'meters'));
  cache.put('pool-a', snapshotAt(nowMs - 7 * HOUR));
  cache.putHold('pool-a', { failed_at: new Date(nowMs - 1000).toISOString(), retry_after_ms: FRESH_MS, reason: '401', sign_in_failed: true });
  const later = nowMs + FRESH_MS + 1000;
  const reading = await getMeterReading('pool-a', { bullswarmDir: home, nowMs: later, reader: async () => snapshotAt(later) });
  assert.equal(reading.source, 'live');
  assert.equal(reading.signInFailed, undefined);
  assert.equal(cache.getHold('pool-a'), null);
  assert.equal(preparePools([pickPoolFrom(reading, later)], step, 'low', { now: later }).length, 1);
}));

test('meter: buildPools carries the sign-in failure of the latest reading onto the pool', () => withHome((home) => {
  mkdirSync(join(home, 'connectors'), { recursive: true });
  writeFileSync(join(home, 'connectors/pool-a.json'), JSON.stringify({
    name: 'pool-a', meter: { type: 'reader', window: 'weekly+5h' }, subscription: { quotaWindow: 'weekly' },
    flags: { testFixture: true }, lanes: ['build'],
  }));
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1, pools: { 'pool-a': { enabled: true } }, incumbents: {}, decisionLog: [], config: { depthLimit: 2 },
  }));
  const nowMs = Date.now();
  const plain = buildPools(home, nowMs, {}).pools.find((pool) => pool.name === 'pool-a');
  assert.ok(plain, 'the enabled pool is built');
  assert.notEqual(plain.meterSignInFailed, true);
  const reading = { source: 'error', snapshot: null, meterError: '401', holdUntil: nowMs + 1000, signInFailed: true, windows: {} };
  const built = buildPools(home, nowMs, { 'pool-a': reading }).pools.find((pool) => pool.name === 'pool-a');
  assert.equal(built.meterSignInFailed, true);
  assert.equal(poolStatusText(built), 'not ready · sign-in failed (meter read 401)');
}));

test('meter: codex marks a 403 as a sign-in failure only when its body names an auth problem', () => withHome(async (home) => {
  writeFileSync(join(home, 'auth.json'), JSON.stringify({ tokens: { access_token: 'opaque-token', account_id: 'acct' } }));
  const realFetch = globalThis.fetch;
  const answer = (status, body) => async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  const read = async (status, body) => {
    globalThis.fetch = answer(status, body);
    try { await fetchCodexUsage({ env: { CODEX_HOME: home } }); return null; } catch (error) { return error; } finally { globalThis.fetch = realFetch; }
  };
  const revoked = await read(403, { error: { code: 'token_revoked', message: 'Your token was revoked' } });
  assert.equal(revoked.status, 403);
  assert.equal(revoked.signInFailed, true);
  assert.equal(meterSignInFailed(revoked), true);
  const blocked = await read(403, '<html>Access denied by edge</html>');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.signInFailed, undefined, 'a 403 that is not an auth error stays an ordinary meter error');
  assert.equal(meterSignInFailed(blocked), false);
  const forbidden = await read(403, { error: { code: 'region_blocked', message: 'not available here' } });
  assert.equal(meterSignInFailed(forbidden), false);
  const unauthorized = await read(401, { error: { message: 'bad' } });
  assert.equal(meterSignInFailed(unauthorized), true);
}));

// --- refusal at start --------------------------------------------------------

const connector = (name, extra = {}) => ({
  name, lanes: ['analyze', 'build', 'chore'], enabled: true, spawn: { cmd: ['fake'] },
  modelSelection: { flag: '--model' }, strategyAssignments: { low: { pool: name, model: 'model-a' } },
  ...extra,
});
const GROUP = 'relay:relay.example';
const good = { ok: true, why: 'ok', meta: { exitCode: 0, wallSec: 1 } };
const signIn = { ok: false, failureKind: 'auth', why: '401 Unauthorized: token_revoked', meta: { exitCode: 1, wallSec: 28 } };
const notInPlan = (model) => ({ ok: false, failureKind: 'model-not-in-plan', planModel: model, why: '403 MODEL_NOT_IN_PLAN', meta: { exitCode: 1, wallSec: 7 } });
const processFail = { ok: false, failureKind: 'process', why: 'crashed', meta: { exitCode: 1, wallSec: 2 } };

function gitWorkspace(root) {
  const repo = join(root, 'repo');
  mkdirSync(repo);
  writeFileSync(join(repo, 'owned.txt'), 'base\n');
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', repo, 'add', 'owned.txt']);
  execFileSync('git', ['-C', repo, 'commit', '-qm', 'base']);
  return repo;
}

const produce = (extra = {}) => ({
  id: 'work', role: 'produce', lane: 'build', effort: 'low',
  deliverable: { type: 'files' }, ownedFiles: ['owned.txt'], ...extra,
});

// `watches` are the fake worker's turns: a verdict, or a function of the repo
// and the attempt's files that may write work or a stream before returning.
async function dispatch({ action = produce(), watches, pools, maxMechanicalRetries = 1, preferredPool = null, refreshPools = null, refusalsAlready = 0, stream = true }) {
  const root = mkdtempSync(join(tmpdir(), 'bs-refusal-dispatch-'));
  const repo = gitWorkspace(root);
  const home = join(root, 'home');
  mkdirSync(home);
  const core = { config: { depthLimit: 2 }, pools: {}, incumbents: {}, decisionLog: [] };
  const models = [];
  let index = 0;
  try {
    const result = await dispatchV2Action({
      action, taskText: 'do the step', targetDir: repo,
      paths: (ordinal) => ({ taskFile: join(home, `task-${ordinal}.md`), outFile: join(home, `out-${ordinal}.md`) }),
      pools, preferredPool, bullswarmDir: home, maxMechanicalRetries, refusalsAlready,
      ...(refreshPools ? { refreshPools } : {}),
      dependencies: {
        watchOnce: async (_connector, _task, _dir, files, opts) => {
          models.push(opts.model);
          const item = watches[index++];
          if (item === undefined) throw new Error('unexpected extra attempt');
          let verdict = typeof item === 'function' ? item({ repo, files, model: opts.model }) : item;
          // A worker that wrote only a reply: a readable stream with no tool call.
          if (stream && !verdict.meta?.streamFile) {
            const file = files.outFile.replace(/\.md$/, '.stream.jsonl');
            writeFileSync(file, `${JSON.stringify({ seq: 1, source: 'stdout', providerType: 'result', kind: 'response', status: 'failed', summary: verdict.why })}\n`);
            verdict = { ...verdict, meta: { ...verdict.meta, streamFile: file } };
          }
          if (verdict.ok && action.deliverable?.type === 'files') writeFileSync(join(repo, 'owned.txt'), `done ${index}\n`);
          return verdict;
        },
        loadState: () => structuredClone(core),
        saveState: (_dir, next) => Object.assign(core, structuredClone(next)),
        now: (() => { let value = Date.parse('2026-10-01T09:27:21Z'); return () => (value += 1000); })(),
        uuid: () => 'session-fixed',
      },
    });
    return { result, models };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const picked = (result) => result.attempts.map((attempt) => attempt.pool);
// The step's first attempts, so the dispatcher's `work-<n>` names are already
// the run-wide ids v2-runtime would rewrite them to.
const storedAttempts = (records) => records.map((record) => normalizeAttempt(record, { id: `work-${record.ordinal}`, actionId: 'work', ordinal: record.ordinal }));
const how = (result) => result.attempts.map((attempt) => attempt.retryOf?.how ?? null);

test('refusal: a sign-in failure with no work is picked again outside its credential group and keeps the step\'s retry', async () => {
  const { result } = await dispatch({
    pools: [connector('relay-a', { credentialGroup: GROUP }), connector('relay-b', { credentialGroup: GROUP }), connector('pool-b'), connector('pool-c')],
    preferredPool: 'relay-a',
    watches: [signIn, processFail, good],
  });
  assert.equal(result.ok, true);
  assert.equal(picked(result)[0], 'relay-a');
  assert.ok(!picked(result).includes('relay-b'), 'never the dead credential\'s sibling');
  assert.deepEqual(how(result), [null, 'refused', 'other-pool'], 'the real failure still got its one retry');
  assert.equal(result.attempts[0].refusedAtStart, true);
  assert.equal(result.attempts[0].willRetry, true);
});

test('refusal: a model the plan does not include is picked again on the same pool with another model of the tier', async () => {
  const tiers = { strategyAssignments: {}, strategyConfiguredTiers: ['low'], strategyModelTiers: { 'pool-a': { 'model-a': ['low'], 'model-b': ['low'] } } };
  const { result, models } = await dispatch({
    pools: [connector('pool-a', tiers)],
    watches: [({ model }) => notInPlan(model), processFail, good],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(picked(result), ['pool-a', 'pool-a', 'pool-a']);
  assert.notEqual(models[1], models[0], 'the refused model is not tried again');
  assert.deepEqual(how(result), [null, 'refused', 'same-pool'], 'the retry is still there for the real failure');
});

test('refusal: a refusal after a tool call is the normal retry', async () => {
  const { result } = await dispatch({
    pools: [connector('pool-a'), connector('pool-b'), connector('pool-c')],
    preferredPool: 'pool-a',
    watches: [({ files }) => {
      const stream = files.outFile.replace(/\.md$/, '.stream.jsonl');
      writeFileSync(stream, `${JSON.stringify({ kind: 'tool', toolName: 'shell' })}\n`);
      return { ...signIn, meta: { ...signIn.meta, streamFile: stream } };
    }, processFail],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(how(result), [null, 'other-pool']);
  assert.equal(result.attempts[0].refusedAtStart, undefined);
});

test('refusal: a refusal after a file change is the normal retry', async () => {
  const { result } = await dispatch({
    pools: [connector('pool-a'), connector('pool-b'), connector('pool-c')],
    preferredPool: 'pool-a',
    watches: [({ repo }) => { writeFileSync(join(repo, 'owned.txt'), 'half\n'); return signIn; }, processFail],
  });
  assert.deepEqual(how(result), [null, 'other-pool']);
});

test('refusal: outward and retry 0 steps go to the caller', async () => {
  const outward = await dispatch({
    action: { id: 'send', role: 'act', lane: 'build', effort: 'low', deliverable: 'outward' },
    pools: [connector('pool-a'), connector('pool-b')], preferredPool: 'pool-a', watches: [signIn],
  });
  assert.equal(outward.result.ok, false);
  assert.deepEqual(picked(outward.result), ['pool-a']);
  const none = await dispatch({ pools: [connector('pool-a'), connector('pool-b')], preferredPool: 'pool-a', watches: [signIn], maxMechanicalRetries: 0 });
  assert.deepEqual(picked(none.result), ['pool-a']);
  assert.equal(none.result.attempts[0].willRetry, false);
});

test('refusal: at most 3 refusal re-picks per step, then the caller, with each refused try listed', async () => {
  const pools = ['pool-a', 'pool-b', 'pool-c', 'pool-d', 'pool-e', 'pool-f'].map((name) => connector(name));
  const { result } = await dispatch({ pools, watches: [signIn, signIn, signIn, signIn, good] });
  assert.equal(result.ok, false);
  assert.equal(result.failureKind, 'auth');
  assert.equal(result.attempts.length, 4);
  assert.deepEqual(how(result), [null, 'refused', 'refused', 'refused']);
  assert.equal(result.attempts[3].willRetry, false);
  // Stored as the kernel stores them (normalizeAttempt), which keeps no
  // refusal field of its own: the try line reads it from the next attempt.
  const stored = storedAttempts(result.attempts);
  assert.deepEqual(stored.map((attempt) => attempt.refusedAtStart), [undefined, undefined, undefined, undefined]);
  const state = {
    program: { version: 3 },
    actions: [{ id: 'work', role: 'produce' }],
    attempts: stored,
  };
  const facts = needsYouFacts(state, {
    type: 'action.finished',
    payload: { status: 'failed', actionId: 'work', failureKind: 'auth', attemptIds: state.attempts.map((attempt) => attempt.id) },
  }, { features: {} });
  const lines = renderNeedsYou(facts);
  const tries = lines.filter((line) => /^ {2}try \d/.test(line));
  assert.equal(tries.length, 4, lines.join('\n'));
  for (const line of tries.slice(0, 3)) assert.match(line, /^ {2}try \d {2}pool-\w · model-a · \S+ · refused at start: sign-in failed · picked again$/);
  assert.doesNotMatch(tries[3], /refused at start/);
});

// --- review fixes -----------------------------------------------------------

const deadSignIn = (name, status) => connector(name, { meterSignInFailed: true, meterError: status });

test('no pool: a step whose only capable pools have a dead sign-in names it per pool, in dispatch and in the preview', async () => {
  const pools = [deadSignIn('pool-a', '401'), deadSignIn('pool-b', '403')];
  const { result } = await dispatch({ pools, watches: [] });
  assert.equal(result.ok, false);
  assert.equal(result.attempts.length, 0);
  assert.match(result.verdict.why, /pool-a sign-in failed \(meter read 401\)/);
  assert.match(result.verdict.why, /pool-b sign-in failed \(meter read 403\)/);
  const ruledOut = JSON.stringify(result);
  assert.match(ruledOut, /"excluded":"sign-in failed \(meter read 401\)"/);
  assert.doesNotMatch(ruledOut, /capable, but no pick was made/);
  await withHome(async (home) => {
    const preview = await previewStepPick({ action: step, pools, bullswarmDir: home, coreState: { decisionLog: [] }, targetDir: home });
    assert.equal(preview.ok, false);
    assert.match(preview.why, /pool-a sign-in failed \(meter read 401\); pool-b sign-in failed \(meter read 403\)/);
  });
});

test('refusal: a model refused as not in the plan is never picked again on that pool, even when the refresher returns a list from before the failure', async () => {
  const tiers = { strategyAssignments: {}, strategyConfiguredTiers: ['low'], strategyModelTiers: { 'pool-a': { 'model-a': ['low'], 'model-b': ['low'] } } };
  const before = [connector('pool-a', tiers)];
  const { result, models } = await dispatch({
    pools: before,
    refreshPools: async () => structuredClone(before),
    watches: [({ model }) => notInPlan(model), processFail, good],
  });
  const refused = models[0];
  assert.ok(!models.slice(1).includes(refused), `refused model picked again: ${models.join(', ')}`);
  assert.deepEqual(how(result), [null, 'refused', 'same-pool']);
  assert.equal(result.ok, true);
});

// Real stream records, as the providers write them (tests/fixtures/home-351).
const REAL_WORK = {
  codex: [
    { seq: 2, source: 'stdout', providerType: 'item.started', kind: 'command_execution', status: 'running', summary: 'ran deploy' },
    { seq: 3, source: 'stdout', providerType: 'item.started', kind: 'file_change', status: 'running', summary: null },
  ],
  grok: [{ seq: 74, source: 'stdout', providerType: 'tool_call', kind: 'run_terminal_command', status: 'pending', summary: 'ran deploy' }],
  'claude-code': [
    { seq: 2, source: 'stdout', providerType: 'assistant', kind: 'Bash', status: 'running', summary: 'ran deploy' },
    { seq: 3, source: 'stdout', providerType: 'user', kind: 'tool', status: 'completed', summary: null },
  ],
};
const REPLY_ONLY = { seq: 1, source: 'stdout', providerType: 'item.completed', kind: 'response', status: 'completed', summary: 'cannot sign in' };
const writeStream = (file, records) => writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');

test('stream: real codex, grok and Claude Code tool records count as work; a reply-only stream does not; an unreadable one is unknown', () => withHome((home) => {
  for (const [pool, records] of Object.entries(REAL_WORK)) {
    for (const record of records) {
      const file = join(home, `${pool}-${record.seq}.jsonl`);
      writeStream(file, [REPLY_ONLY, record]);
      assert.equal(streamShowsWork(file, pool), true, `${pool} ${record.kind}`);
    }
    const reply = join(home, `${pool}-reply.jsonl`);
    writeStream(reply, [REPLY_ONLY]);
    assert.equal(streamShowsWork(reply, pool), false, pool);
  }
  assert.equal(streamShowsWork(join(home, 'missing.jsonl'), 'codex'), null);
  assert.equal(streamShowsWork(null, 'codex'), null);
  const garbled = join(home, 'garbled.jsonl');
  writeFileSync(garbled, 'not json\n');
  assert.equal(streamShowsWork(garbled, 'codex'), null);
}));

// Raw provider lines through each connector's own decoder, as the runtime
// writes the stream file.
function decodedStream(file, provider, lines) {
  const { eventStream } = JSON.parse(readFileSync(new URL(`../src/providers/${provider}/connector.json`, import.meta.url), 'utf8'));
  const events = [];
  const decoder = createAgentEventDecoder(eventStream, { onEvent: (event) => events.push(event) });
  decoder.push(lines.map((line) => `${JSON.stringify(line)}\n`).join(''), 'stdout', '2026-10-01T09:27:21.000Z');
  decoder.finish('2026-10-01T09:27:22.000Z');
  writeStream(file, events.map((event, index) => ({ seq: index + 1, ...event })));
  return events.length;
}

test('stream: any tool-call record is work whatever its name or kind; only a stream with none is no work', () => withHome((home) => {
  const toolUse = (name) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `tu-${name}`, name, input: {} }] } });
  const work = {
    'codex mcp_tool_call': ['codex', [{ type: 'item.started', item: { id: 'i1', type: 'mcp_tool_call', server: 'acme', tool: 'deploy', status: 'in_progress' } }]],
    'codex todo_list': ['codex', [{ type: 'item.started', item: { id: 'i2', type: 'todo_list', items: [] } }]],
    'claude-code MCP tool': ['claude-code', [toolUse('mcp__acme__deploy')]],
    'claude-code WebFetch': ['claude-code', [toolUse('WebFetch')]],
    'grok web_fetch': ['grok', [{ type: 'tool_call', toolCallId: 'g1', toolName: 'web_fetch', rawInput: { url: 'https://example.com' }, status: 'pending' }]],
  };
  for (const [name, [provider, lines]] of Object.entries(work)) {
    const file = join(home, `${name.replace(/\W+/g, '-')}.jsonl`);
    assert.ok(decodedStream(file, provider, lines) > 0, name);
    assert.equal(streamShowsWork(file, provider), true, name);
  }
  // A record the vocabulary classes as `other`, with no name, id or result.
  for (const [pool, kind] of [['codex', 'mcp_tool_call'], ['claude-code', 'WebFetch'], ['claude-code', 'mcp__acme__deploy']]) {
    const file = join(home, `bare-${kind}.jsonl`);
    writeStream(file, [REPLY_ONLY, { seq: 2, source: 'stdout', providerType: pool === 'codex' ? 'item.started' : 'assistant', kind, status: 'running' }]);
    assert.equal(streamShowsWork(file, pool), true, `${pool} ${kind}`);
  }
  // No tool-call record: a reply, an end-of-run result, an error.
  const none = {
    'codex sign-in refusal': ['codex', [{ type: 'thread.started', thread_id: 't1' }, { type: 'turn.started' }, { type: 'error', message: '401 Unauthorized' }]],
    'claude-code reply and result': ['claude-code', [{ type: 'assistant', message: { content: [{ type: 'text', text: 'cannot sign in' }] } }, { type: 'result', subtype: 'error', is_error: true, result: '401' }]],
  };
  for (const [name, [provider, lines]] of Object.entries(none)) {
    const file = join(home, `${name.replace(/\W+/g, '-')}.jsonl`);
    decodedStream(file, provider, lines);
    assert.equal(streamShowsWork(file, provider), false, name);
  }
  const error = join(home, 'error.jsonl');
  writeStream(error, [{ seq: 1, source: 'stdout', providerType: 'error', kind: 'error', status: 'failed', summary: '401' }]);
  assert.equal(streamShowsWork(error, 'codex'), false);
  // An empty stream file is no work (both refusals of the incident left one);
  // a missing one stays unknown.
  const empty = join(home, 'empty.jsonl');
  writeFileSync(empty, '');
  assert.equal(streamShowsWork(empty, 'codex'), false);
  assert.equal(streamShowsWork(join(home, 'gone.jsonl'), 'codex'), null);
}));

for (const [provider, records] of Object.entries(REAL_WORK)) {
  test(`refusal: a ${provider} worker whose real stream shows a tool call before the sign-in failure takes the normal retry`, async () => {
    const { result } = await dispatch({
      pools: [connector(provider), connector('pool-b'), connector('pool-c')],
      preferredPool: provider,
      watches: [({ files }) => {
        const file = files.outFile.replace(/\.md$/, '.stream.jsonl');
        writeStream(file, [records[0], REPLY_ONLY]);
        return { ...signIn, meta: { ...signIn.meta, streamFile: file } };
      }, processFail],
    });
    assert.deepEqual(how(result), [null, 'other-pool']);
    assert.equal(result.attempts[0].refusedAtStart, undefined);
  });
}

test('refusal: an attempt whose stream is missing is not a refusal (the old rule)', async () => {
  const { result } = await dispatch({
    pools: [connector('pool-a'), connector('pool-b'), connector('pool-c')], preferredPool: 'pool-a',
    stream: false, watches: [signIn, processFail],
  });
  assert.deepEqual(how(result), [null, 'other-pool']);
});

test('refusal: an act step is never picked again as a refusal, whatever its deliverable', async () => {
  for (const action of [
    { id: 'deploy', role: 'act', lane: 'build', effort: 'low' },
    { id: 'deploy', role: 'act', lane: 'build', effort: 'low', deliverable: { type: 'report' } },
  ]) {
    const { result } = await dispatch({ action, pools: [connector('pool-a'), connector('pool-b')], preferredPool: 'pool-a', watches: [signIn] });
    assert.equal(result.ok, false);
    assert.deepEqual(picked(result), ['pool-a'], JSON.stringify(action));
    assert.equal(result.attempts[0].refusedAtStart, undefined);
  }
});

test('refusal: the 3-re-pick bound counts the step\'s stored refused attempts, so a resume does not reset it', async () => {
  const state = {
    actions: [{ id: 'work' }],
    attempts: [1, 2, 3].map((ordinal) => ({ actionId: 'work', ordinal, retryOf: ordinal === 1 ? null : { how: 'refused' } }))
      .concat([{ actionId: 'work', ordinal: 4, retryOf: { how: 'refused' } }, { actionId: 'other', ordinal: 1, retryOf: { how: 'refused' } }]),
  };
  assert.equal(countRefusalRepicks(state, 'work'), 3);
  assert.equal(countRetries(state, 'work'), 0, 'refused re-picks never spend the retry');
  assert.equal(countRefusalRepicks({ ...state, actions: [{ id: 'work', supersededAttempts: 2 }] }, 'work'), 2);
  const resumed = await dispatch({
    pools: [connector('pool-a'), connector('pool-b'), connector('pool-c')], preferredPool: 'pool-a',
    refusalsAlready: MAX_REFUSAL_REPICKS, watches: [signIn],
  });
  assert.deepEqual(picked(resumed.result), ['pool-a'], 'no refusal re-pick left after a resume');
  assert.equal(resumed.result.attempts[0].willRetry, false);
  const fresh = await dispatch({
    pools: [connector('pool-a'), connector('pool-b'), connector('pool-c')], preferredPool: 'pool-a',
    refusalsAlready: MAX_REFUSAL_REPICKS - 1, watches: [signIn, signIn],
  });
  assert.deepEqual(how(fresh.result), [null, 'refused']);
});

test('refusal: the step page header of a stored refused attempt says it was refused at start and picked again', async () => {
  const pools = ['pool-a', 'pool-b', 'pool-c'].map((name) => connector(name));
  const { result } = await dispatch({ pools, preferredPool: 'pool-a', watches: [signIn, good] });
  assert.deepEqual(how(result), [null, 'refused']);
  const state = createV2State(createV2GoalDocument({
    goal: 'Ship the acme widget', cwd: '/work/acme', settings: { concurrency: 2, workspaceMode: 'shared', executionMode: 'program' },
    requirements: [{ id: 'widget-works', text: 'The widget works' }],
  }), { runId: 'wf-acme-refused', shortId: 'ref234' });
  state.lifecycle = { status: 'complete', startedAt: '2026-10-01T09:27:00Z', finishedAt: '2026-10-01T09:40:00Z', resultFile: null };
  state.planner = { status: 'waiting', turns: 1, lastDecision: { kind: 'program-created' }, session: null, attempts: [] };
  state.program = { schemaVersion: 'bullswarm.workflow.program.v2', revision: 1, actions: [
    { id: 'work', purpose: 'Work', dependsOn: [], affects: [], ownedFiles: [], prompt: 'Work.', lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: [] },
  ] };
  state.actions = [{ id: 'work', status: 'succeeded', attempts: 2, programRevision: 1, workRevision: 'initial', startedAt: null, finishedAt: null, outputFile: null, artifactIds: [] }];
  state.attempts = storedAttempts(result.attempts);
  state.presentation = { stages: deriveV2DependencyStages(state.program.actions, 1) };
  const row = { runId: state.runId, shortId: state.shortId, state, status: 'complete' };
  const header = (attemptOrdinal) => stepPageModel({ row, assignments: [], pools: [] }, { actionId: 'work', attemptOrdinal, nowMs: Date.parse('2026-10-01T10:00:00Z') }).presentation.header.attemptText;
  assert.equal(header(1), 'attempt 1 of 2 · refused at start: sign-in failed · picked again');
  assert.equal(header(2), 'attempt 2 of 2');
});

test('refusal: a resumed step with 3 stored refused re-picks gets no further refusal re-pick (the kernel counts the stored ones)', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'bs-refusal-kernel-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = gitWorkspace(root);
  const bullswarmDir = join(root, 'home');
  mkdirSync(bullswarmDir);
  const goalDocument = createV2GoalDocument({
    goal: 'Deliver owned.txt', cwd: workspace, requirements: implicitV3Requirements('Deliver owned.txt'),
    settings: { executionMode: 'program', workspaceMode: 'shared', scout: false, plannerMode: 'caller', concurrency: 1 },
  });
  const pools = ['pool-a', 'pool-b', 'pool-c', 'pool-d', 'pool-e', 'pool-f'].map((name) => connector(name));
  const core = { config: { depthLimit: 2 }, pools: {}, incumbents: {}, decisionLog: [] };
  const dispatch = (options) => dispatchV2Action({
    ...options, pools,
    dependencies: {
      // Every worker is refused at start: a sign-in failure with a readable
      // stream that holds no tool call.
      watchOnce: async (_pool, task, _dir, files) => {
        writeFileSync(files.taskFile, task);
        const streamFile = files.outFile.replace(/\.md$/, '.stream.jsonl');
        writeFileSync(streamFile, `${JSON.stringify({ seq: 1, source: 'stdout', providerType: 'result', kind: 'response', status: 'failed', summary: signIn.why })}\n`);
        return { ...signIn, meta: { ...signIn.meta, streamFile } };
      },
      loadState: () => structuredClone(core),
      saveState: (_dir, next) => Object.assign(core, structuredClone(next)),
      now: () => Date.now(),
      uuid: () => 'session-fixed',
    },
  });
  const runId = 'wf-refuse-abcdef';
  const steps = [{ id: 'work', files: ['owned.txt'], prompt: 'Write owned.txt.', lane: 'build', effort: 'low' }];
  await runV2AutonomousWorkflow({
    bullswarmDir, goalDocument, pools: [], runId,
    initialPlannerResponse: { schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary: 'Initial plan.', program: { schemaVersion: 'bullswarm.workflow.program.v3', steps } },
    dependencies: { savedRunTwin: true, dispatchV2Action: dispatch, controlPollMs: 10 },
  });
  const read = () => JSON.parse(readFileSync(join(bullswarmDir, 'workflows', runId, 'state.json'), 'utf8'));
  const tries = (state) => state.attempts.filter((attempt) => attempt.actionId === 'work').map((attempt) => attempt.retryOf?.how ?? null);
  let state = read();
  assert.deepEqual(tries(state), [null, 'refused', 'refused', 'refused'], 'the bound held in the first kernel run');
  assert.equal(state.actions.find((action) => action.id === 'work').status, 'failed');
  // The needs-you block of the kernel's own stored attempts lists each refused try.
  const attemptIds = state.attempts.map((attempt) => attempt.id);
  const block = renderNeedsYou(needsYouFacts(state, { type: 'action.finished', payload: { status: 'failed', actionId: 'work', failureKind: 'auth', attemptIds } }, { features: {} }));
  const lines = block.filter((line) => /^ {2}try \d/.test(line));
  assert.equal(lines.filter((line) => / · refused at start: sign-in failed · picked again$/.test(line)).length, 3, block.join('\n'));
  // The kernel died once those attempts were stored (a `workflow resume` of a
  // finished run supersedes them and gives the step its bound back): the
  // resumed kernel reads the bound from the stored attempts.
  const runDir = join(bullswarmDir, 'workflows', runId);
  Object.assign(state.lifecycle, { status: 'running', finishedAt: null, resultFile: null });
  Object.assign(state.actions[0], { status: 'interrupted', finishedAt: null, lastFailure: { kind: 'interrupted', message: 'kernel interrupted; work retained for resume' } });
  writeFileSync(join(runDir, 'state.json'), JSON.stringify(state));
  rmSync(join(runDir, 'result.json'), { force: true });
  rmSync(join(runDir, 'completion-work.json'), { force: true });
  await runV2AutonomousWorkflow({ bullswarmDir, resumeRunId: runId, pools: [], dependencies: { dispatchV2Action: dispatch, controlPollMs: 10 } });
  state = read();
  assert.deepEqual(tries(state), [null, 'refused', 'refused', 'refused', null], 'the resume made one pick and no refusal re-pick');
});
