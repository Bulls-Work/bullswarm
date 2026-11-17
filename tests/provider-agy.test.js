// AGY (Google Antigravity CLI) as a first-class provider: two pools from one
// login (Gemini models, and the Claude and GPT-OSS models AGY also serves),
// each paced on its own AGY quota group.
//
// Every number here comes from the real captures in tests/fixtures/agy and
// tests/fixtures/stream/agy.jsonl (agy 1.5.10, 2026-11-17). Nothing here
// spawns agy, reads ~/.gemini, reads a live meter or the real ~/.bullswarm:
// discovery and the meter take injected runners, the pools are built in a
// temp home from those readings, and the one dispatch injects watchOnce and
// refreshPools.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAgentEventDecoder } from '../src/lib/agent-events.js';
import { loadProviders } from '../src/lib/providers.js';
import { buildPools } from '../src/lib/config.js';
import { pickPool } from '../src/lib/route.js';
import { resolveReasoningLevel } from '../src/lib/reasoning.js';
import { argvWithModel, followUpArgv } from '../src/lib/worker-argv.js';
import { buildStrategy, discoverAllModels, discoverConnectorModels, resolveDispatchModel } from '../src/lib/strategy.js';
import { connectors } from '../src/providers/agy/provider.mjs';
import { paceSnapshot } from '../src/meters/framework.js';
import { getAllMeterReadings } from '../src/meters/registry.js';
import { validateProvider } from '../src/provider-cli.js';
import { previewStepPick } from '../src/workflow/pick-preview.js';
import { dispatchV2Action } from '../src/workflow/v2-dispatch.js';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const FIRST_CLASS = join(REPO, 'src', 'providers');
const AGY_DIR = join(FIRST_CLASS, 'agy');
const FIXTURES = join(REPO, 'tests', 'fixtures', 'agy');
const STREAM = readFileSync(join(REPO, 'tests', 'fixtures', 'stream', 'agy.jsonl'), 'utf8');
const MODELS_TXT = readFileSync(join(FIXTURES, 'models.txt'), 'utf8');
const USAGE = JSON.parse(readFileSync(join(FIXTURES, 'usage.json'), 'utf8'));
const BAD_MODEL = readFileSync(join(FIXTURES, 'bad-model.json'), 'utf8');

// Inside both fixture windows: the 5h window resets 22:26:32Z, the weeklies on the 24th.
const NOW = Date.parse('2026-11-17T20:00:00.000Z');

const agyModule = () => import(join(AGY_DIR, 'provider.mjs'));

function tempHome(t, prefix = 'bs-agy-') {
  const home = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  for (const dir of ['providers', 'connectors', 'contrib']) mkdirSync(join(home, dir), { recursive: true });
  return home;
}

function loaderFor(home) {
  return {
    homeDir: home,
    // No Claude login is scanned: claude-code loads as its one default pool.
    accounts: [],
    enabled: [],
    dirs: {
      firstClass: FIRST_CLASS,
      contrib: join(home, 'contrib'),
      local: join(home, 'providers'),
      legacy: join(home, 'connectors'),
    },
  };
}

/** The agy pools exactly as the loader builds them from the shipped provider. */
function agyPools(t) {
  const home = tempHome(t);
  const { connectors, providers } = loadProviders(home, loaderFor(home));
  return { home, connectors, providers, agy: connectors.agy, claude: connectors['agy:claude'] };
}

/** A usage runner that answers like `agy -p /usage --output-format json`, from the fixture. */
function usageRunner(body = USAGE, calls = []) {
  return async (request) => {
    calls.push(request);
    return { stdout: typeof body === 'string' ? body : JSON.stringify(body), stderr: '', exitCode: 0 };
  };
}

function withBuckets(edit) {
  const body = structuredClone(USAGE);
  for (const group of body.command.data.groups) {
    for (const bucket of group.buckets) edit(group.name, bucket);
  }
  return body;
}

// --- connector and pools ------------------------------------------------------------

test('agy validates as a first-class provider with two pools sharing one credential group', (t) => {
  const home = tempHome(t);
  const report = validateProvider(home, AGY_DIR, loaderFor(home));
  assert.equal(report.ok, true, JSON.stringify(report, null, 2));
  assert.deepEqual(report.pools.map((p) => p.name), ['agy', 'agy:claude']);
  assert.deepEqual(report.pools.flatMap((p) => p.errors), []);

  const { providers, agy, claude } = agyPools(t);
  const entry = providers.find((p) => p.name === 'agy');
  assert.equal(entry.tier, 'first-class');
  assert.equal(entry.error, null);
  assert.equal(entry.hasReadUsage, true);
  assert.deepEqual(entry.pools, ['agy', 'agy:claude']);
  assert.equal(agy.credentialGroup, 'agy');
  assert.equal(claude.credentialGroup, 'agy');
  for (const pool of [agy, claude]) {
    assert.deepEqual(pool.lanes, ['analyze', 'build', 'chore']);
    assert.deepEqual(pool.meter, { type: 'reader', window: 'weekly+5h' });
    assert.equal(pool.subscription.quotaWindow, 'weekly');
    assert.equal(pool.subscription.plan, null);
    assert.deepEqual(pool.quotaSignatures, ['RESOURCE_EXHAUSTED']);
    assert.equal(pool.authSignatures, undefined, 'no observed sign-in wording: none invented');
    assert.equal(pool.bin, 'agy');
    assert.deepEqual(pool.configDirs, ['~/.gemini/antigravity-cli']);
  }
  assert.equal(agy.model, 'gemini-4-carbon');
  // Each pool lists only its own quota group's models; orchestrators in neither.
  assert.deepEqual(agy.knownModels, ['gemini-4-carbon', 'gemini-4-argon', 'gemini-4-hydrogen', 'gemini-3.8-flash']);
  assert.deepEqual(claude.knownModels, ['claude-sonnet-4-6', 'claude-opus-4-6-thinking', 'gpt-oss-120b-medium']);
  assert.ok(claude.knownModels.includes(claude.model));
});

// --- the event stream -----------------------------------------------------------------

function decodeStream(text = STREAM) {
  const { eventStream } = JSON.parse(readFileSync(join(AGY_DIR, 'connector.json'), 'utf8'));
  const events = [];
  const progress = [];
  const decoder = createAgentEventDecoder(eventStream, {
    onEvent: (event) => events.push(event),
    onProgress: (event) => progress.push(event),
  });
  decoder.push(text, 'stdout', '2026-11-17T17:41:40.000Z');
  decoder.finish('2026-11-17T17:41:53.000Z');
  return { eventStream, events, progress, output: decoder.output(), usage: decoder.usage() };
}

test('the stream-json capture decodes: answer, session, model, usage classes and tool kinds', () => {
  const lines = STREAM.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const result = lines.at(-1).result;
  const { eventStream, events, progress, output, usage } = decodeStream();

  assert.deepEqual(eventStream.args, ['--output-format', 'stream-json']);
  assert.equal(output, result.response);
  // input_tokens excludes cache reads (15327 + 707 = total 16034); output
  // includes thinking, so the exclusive output class is 707 - 214.
  assert.deepEqual(usage, {
    sessionId: '0ee3d441-bba8-4892-ae8b-a6607d31185c',
    model: 'gemini-4-hydrogen',
    standardRead: 15327,
    cacheRead: 16783,
    output: 493,
    reasoning: 214,
  });
  assert.ok(progress.some((event) => event.model === 'gemini-4-hydrogen'));

  const tools = events.filter((event) => event.toolName);
  assert.deepEqual(tools.map((event) => [event.toolName, event.status]), [
    ['read_file', 'running'], ['read_file', 'completed'],
    ['write_file', 'running'], ['write_file', 'completed'],
    ['run_command', 'running'], ['run_command', 'completed'],
  ]);
  // A tool's start and its completion share one call id.
  assert.deepEqual(tools.map((event) => event.toolCallId), ['2', '2', '4', '4', '5', '5']);
  assert.deepEqual(tools[4].arguments, { CommandLine: 'ls -la /tmp/agy-probe/w' });
  assert.match(String(tools[5].result), /Command exited with code 0/);
  const kinds = Object.fromEntries(Object.entries(eventStream.toolKinds).map(([k, v]) => [k.toLowerCase(), v]));
  assert.deepEqual(tools.map((event) => kinds[event.kind.toLowerCase()]),
    ['read', 'read', 'edit', 'edit', 'command', 'command']);
  // The init tool list's own names are counted too.
  for (const [name, kind] of [['view_file', 'read'], ['write_to_file', 'edit'], ['replace_file_content', 'edit'],
    ['grep_search', 'search'], ['find_by_name', 'search'], ['list_dir', 'search']]) {
    assert.equal(kinds[name], kind, name);
  }

  // The streamed reply is one response, its text the answer.
  const responses = events.filter((event) => event.kind === 'response');
  assert.ok(responses.length > 1);
  assert.equal(new Set(responses.map((event) => event.id)).size, 1);
  const finalResult = events.find((event) => event.kind === 'result');
  assert.equal(finalResult.status, 'completed');
  assert.deepEqual(finalResult.usage, { input: 15327, cacheRead: 16783, output: 707, reasoning: 214 });
});

test('a stream cut before its result line still yields the session and the per-step token totals', () => {
  const cut = STREAM.split('\n').filter(Boolean).slice(0, -1).join('\n') + '\n';
  const { output, usage } = decodeStream(cut);
  assert.equal(output, '');
  // The per-step agent_response usage rows add up to the result's totals.
  assert.deepEqual(usage, {
    sessionId: '0ee3d441-bba8-4892-ae8b-a6607d31185c',
    model: 'gemini-4-hydrogen',
    standardRead: 15327,
    cacheRead: 16783,
    output: 493,
    reasoning: 214,
  });
});

test('the follow-up turn continues the same agy conversation', (t) => {
  const { agy } = agyPools(t);
  const argv = followUpArgv(agy, { taskFile: '/w/task.md', cwd: '/w', sessionId: 'conv-1', prompt: 'finish the answer' });
  assert.deepEqual(argv.slice(0, 5), ['agy', '-p', 'finish the answer', '--conversation', 'conv-1']);
  assert.deepEqual(argv.slice(-2), ['--output-format', 'stream-json']);
  // Session ids are AGY's own: nothing is pre-assigned on a new attempt.
  assert.equal(agy.conversation.newArgs, undefined);
  assert.equal(agy.conversation.resumeArgs, undefined);
});

// --- the usage meter --------------------------------------------------------------------

test('the /usage fixture gives each pool its own quota group, 5h and weekly, without a model turn', async () => {
  const { readUsage } = await agyModule();
  const calls = [];
  const gemini = await readUsage('agy', { runner: usageRunner(USAGE, calls) });
  assert.equal(gemini.pool, 'agy');
  assert.deepEqual(gemini.five_hour, { utilization: 0.5, resets_at: '2026-11-17T22:26:32.000Z' });
  assert.deepEqual(gemini.seven_day, { utilization: 0.1, resets_at: '2026-11-24T17:26:32.000Z' });
  assert.equal(gemini.plan_type, null);

  const claude = await readUsage({ name: 'agy:claude' }, { runner: usageRunner(USAGE, calls) });
  assert.equal(claude.pool, 'agy:claude');
  assert.deepEqual(claude.five_hour, { utilization: 0, resets_at: '2026-11-17T22:40:52.000Z' });
  assert.deepEqual(claude.seven_day, { utilization: 0, resets_at: '2026-11-24T17:40:52.000Z' });

  // The read is the /usage command in print mode, bounded, and never a model prompt.
  for (const call of calls) {
    assert.equal(call.command, 'agy');
    assert.deepEqual(call.args, ['-p', '/usage', '--output-format', 'json']);
    assert.ok(call.timeoutMs > 0 && call.timeoutMs <= 20_000, String(call.timeoutMs));
  }

  // Pacing reads it like any weekly + 5h meter.
  const paced = paceSnapshot(gemini, NOW);
  assert.equal(paced.pacingWindow, 'weekly');
  assert.equal(paced.fiveHourUsedPct, 0.5);
  assert.equal(paced.burstGate, false);
});

test('a bad meter read is a MeterError with a code, never a snapshot', async () => {
  const { readUsage, AgyMeterError } = await agyModule();
  const fails = async (runner, code, pool = 'agy') => {
    await assert.rejects(readUsage(pool, { runner }), (error) => {
      assert.ok(error instanceof AgyMeterError, error.stack);
      assert.equal(error.name, 'MeterError');
      assert.equal(error.code, code, error.message);
      return true;
    });
  };
  await fails(usageRunner('Fetching usage...\nnot json'), 'parse');
  await fails(usageRunner({ status: 'SUCCESS', num_turns: 0, command: { name: 'usage' } }), 'parse');
  await fails(usageRunner(withBuckets((_, bucket) => { bucket.remaining_fraction = 'lots'; })), 'parse');
  const noClaude = structuredClone(USAGE);
  noClaude.command.data.groups = noClaude.command.data.groups.filter((g) => g.name === 'Gemini Models');
  await fails(usageRunner(noClaude), 'no_group', 'agy:claude');
  // A meter read that started a model turn spent quota: refused.
  await fails(usageRunner({ ...USAGE, num_turns: 1 }), 'model_turn');
  // agy's own error object (exit 1), and a non-zero exit with plain stderr / empty stdout.
  await fails(async () => ({ stdout: BAD_MODEL, stderr: '', exitCode: 1 }), 'cli_error');
  await assert.rejects(
    readUsage('agy', { runner: async () => ({ stdout: '', stderr: 'auth error: token expired', exitCode: 1 }) }),
    (error) => {
      assert.ok(error instanceof AgyMeterError);
      assert.equal(error.code, 'cli_error');
      assert.match(error.message, /exited 1.*auth error: token expired/);
      return true;
    },
  );
  await fails(async () => ({ stdout: 'plain error line', stderr: '', exitCode: 2 }), 'cli_error');
  await fails(async () => { throw Object.assign(new Error('spawn agy ENOENT'), { code: 'ENOENT' }); }, 'no_bin');
  await fails(async () => { throw Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' }); }, 'timeout');
});

test('under node --test the meter and discovery refuse to spawn agy unless a runner is injected', async (t) => {
  const { readUsage, discoverModels } = await agyModule();
  const { agy } = agyPools(t);
  await assert.rejects(readUsage('agy', {}), (error) => error.code === 'test_guard');
  await assert.rejects(discoverModels(agy, {}), /node --test/);
});

test('readUsage stamps captured_at from ctx.now and getAllMeterReadings forwards nowMs to the provider reader', async (t) => {
  const { readUsage } = await agyModule();
  const stamped = await readUsage('agy', { runner: usageRunner(USAGE), now: () => NOW });
  assert.equal(stamped.captured_at, new Date(NOW).toISOString());

  const { home, providers } = agyPools(t);
  mkdirSync(join(home, 'meters'), { recursive: true });
  let runnerCalls = 0;
  const withRunner = providers.map((entry) => {
    if (entry.name !== 'agy') return entry;
    const copy = Object.defineProperties({}, Object.getOwnPropertyDescriptors(entry));
    Object.defineProperty(copy, 'ctx', {
      value: {
        ...entry.ctx,
        runner: async () => {
          runnerCalls += 1;
          return { stdout: JSON.stringify(USAGE), stderr: '', exitCode: 0 };
        },
      },
      enumerable: false,
      writable: true,
    });
    return copy;
  });

  const first = await getAllMeterReadings(['agy', 'agy:claude'], {
    bullswarmDir: home, providers: withRunner, nowMs: NOW, force: true,
  });
  assert.equal(runnerCalls, 1);
  assert.equal(first.agy.snapshot.captured_at, new Date(NOW).toISOString());

  // 60 s later on the caller's clock (> FORCED_SHARE_MS), a forced refresh must
  // poll again rather than reuse the earlier reading when wall-clock > NOW + 60_000.
  const second = await getAllMeterReadings(['agy', 'agy:claude'], {
    bullswarmDir: home, providers: withRunner, nowMs: NOW + 60_000, force: true,
  });
  assert.equal(runnerCalls, 2);
  assert.equal(second.agy.snapshot.captured_at, new Date(NOW + 60_000).toISOString());
});

// --- model discovery ----------------------------------------------------------------

test('discovery folds effort suffixes into base ids per pool and leaves the orchestrators out', async (t) => {
  const { discoverModels } = await agyModule();
  const { agy, claude } = agyPools(t);
  const calls = [];
  const executor = async (request) => { calls.push(request); return MODELS_TXT; };

  const gemini = await discoverModels(agy, { executor });
  assert.deepEqual(gemini.command, ['agy', 'models']);
  assert.deepEqual(gemini.models.map((m) => [m.id, m.displayName, m.reasoningLevels]), [
    ['gemini-4-carbon', 'Gemini 4 Carbon', ['low', 'medium', 'high']],
    ['gemini-4-argon', 'Gemini 4 Argon', ['low', 'medium', 'high']],
    ['gemini-4-hydrogen', 'Gemini 4 Hydrogen', ['low', 'medium', 'high', 'xhigh']],
    ['gemini-3.8-flash', 'Gemini 3.8 Flash', ['low', 'medium', 'high']],
  ]);

  const other = await discoverModels(claude, { executor });
  assert.deepEqual(other.models.map((m) => m.id), ['claude-sonnet-4-6', 'claude-opus-4-6-thinking', 'gpt-oss-120b-medium']);
  assert.ok(other.models.every((m) => m.reasoningLevels === undefined), 'no --effort for these models');

  for (const call of calls) {
    assert.equal(call.command, 'agy');
    assert.deepEqual(call.args, ['models']);
    assert.ok(call.timeoutMs > 0 && call.timeoutMs <= 20_000);
    assert.equal(typeof call.env, 'object');
  }
  // The connector's fallback list is the same folded list.
  assert.deepEqual(agy.knownModels, gemini.models.map((m) => m.id));
  assert.deepEqual(claude.knownModels, other.models.map((m) => m.id));

  // One `agy models` call serves both pools on the same login, both directly and through discoverAllModels.
  assert.equal(calls.length, 1, 'agy models should run once for both agy and agy:claude');

  // Through core discovery: source cli, every listed model ranked, one spawn across both pools.
  const { providers } = agyPools(t);
  let allCalls = 0;
  const allReports = await discoverAllModels(
    { agy, 'agy:claude': claude },
    { providers, providerExecutors: { agy: async () => { allCalls += 1; return MODELS_TXT; } } },
  );
  assert.equal(allCalls, 1, 'discoverAllModels must invoke agy discovery once across agy and agy:claude');
  assert.equal(allReports.agy.source, 'cli');
  assert.equal(allReports['agy:claude'].source, 'cli');
  assert.ok(allReports.agy.models.every((m) => m.ranking === 'ranked'), JSON.stringify(allReports.agy.models));
  assert.ok(!allReports.agy.models.some((m) => /orchestrator/.test(m.id)));
  const provider = providers.find((p) => p.name === 'agy');
  const report = await discoverConnectorModels(agy, { provider, providerExecutor: executor });
  assert.equal(report.source, 'cli');
  assert.ok(report.models.every((m) => m.ranking === 'ranked'), JSON.stringify(report.models));
  assert.ok(!report.models.some((m) => /orchestrator/.test(m.id)));
});

// --- reasoning ------------------------------------------------------------------------

async function discoveredStrategy(t) {
  const { discoverModels } = await agyModule();
  const { agy, claude } = agyPools(t);
  const executor = async () => MODELS_TXT;
  return {
    agy,
    claude,
    strategy: {
      lastReport: {
        discoveries: {
          agy: { models: (await discoverModels(agy, { executor })).models },
          'agy:claude': { models: (await discoverModels(claude, { executor })).models },
        },
      },
    },
  };
}

test('reasoning: carbon at xhigh clamps to high, hydrogen keeps xhigh, Claude and GPT-OSS get no flag', async (t) => {
  const { agy, claude, strategy } = await discoveredStrategy(t);
  assert.equal(agy.reasoning.flag, '--effort');
  const at = (connector, model, level) => resolveReasoningLevel({ connector, tier: 'high', model, strategy, actionOverride: level });
  assert.deepEqual(at(agy, 'gemini-4-carbon', 'xhigh'), { requested: 'xhigh', applied: 'high', source: 'action', clamped: true });
  assert.deepEqual(at(agy, 'gemini-4-hydrogen', 'xhigh'), { requested: 'xhigh', applied: 'xhigh', source: 'action', clamped: false });
  assert.equal(at(agy, 'gemini-3.8-flash', 'max').applied, 'high');
  for (const model of ['claude-opus-4-6-thinking', 'claude-sonnet-4-6', 'gpt-oss-120b-medium']) {
    const record = at(claude, model, 'high');
    assert.equal(record.applied, null, model);
    // Even with no model named (the CLI-default pick), agy:claude appends no --effort.
    const argv = argvWithModel(claude, { taskFile: '/w/task.md', cwd: '/w' }, model, null, record);
    assert.ok(!argv.includes('--effort'), `${model}: ${argv.join(' ')}`);
  }
  const unnamed = resolveReasoningLevel({ connector: claude, tier: 'high', model: null, strategy });
  assert.equal(unnamed.applied, null);
  // The template's skipModels still guard a Claude id pinned on the Gemini pool.
  assert.equal(at(agy, 'claude-opus-4-6-thinking', 'high').source, 'skipped-model');
});

// --- argv -----------------------------------------------------------------------------

function pairAt(argv, flag, value) {
  const index = argv.indexOf(flag);
  return index >= 0 && argv[index + 1] === value;
}

test('argv: a built agy pool runs a high-effort step on gemini-4-carbon with every flag it needs', async (t) => {
  const { agy, strategy } = await discoveredStrategy(t);
  const reasoning = resolveReasoningLevel({ connector: agy, tier: 'high', model: 'gemini-4-carbon', strategy });
  assert.deepEqual([reasoning.applied, reasoning.source], ['high', 'connector']);
  const argv = argvWithModel(agy, { taskFile: '/runs/r1/task-a.md', cwd: '/work/repo' }, 'gemini-4-carbon', null, reasoning);
  assert.equal(argv[0], 'agy');
  assert.ok(pairAt(argv, '-p', 'Read the file /runs/r1/task-a.md and follow its instructions exactly.'), argv.join(' '));
  assert.ok(pairAt(argv, '--model', 'gemini-4-carbon'), argv.join(' '));
  assert.ok(pairAt(argv, '--effort', 'high'), argv.join(' '));
  assert.ok(pairAt(argv, '--output-format', 'stream-json'), argv.join(' '));
  assert.ok(pairAt(argv, '--add-dir', '/work/repo'), argv.join(' '));
  assert.ok(argv.includes('--dangerously-skip-permissions'));
  // One model flag and one effort flag, never two.
  assert.equal(argv.filter((a) => a === '--model').length, 1);
  assert.equal(argv.filter((a) => a === '--effort').length, 1);
});

// --- routing: agy is used like any other pool ---------------------------------------------

/** A reading as the meter registry hands it to the pool builder. */
const reading = (snapshot) => ({ snapshot, source: 'live', ...paceSnapshot(snapshot, NOW) });

/** A pool far ahead of its weekly pace (60% used early in the week). */
const busy = (pool) => reading({
  captured_at: new Date(NOW).toISOString(), pool,
  five_hour: { utilization: 10, resets_at: '2026-11-17T23:00:00.000Z' },
  seven_day: { utilization: 60, resets_at: '2026-11-24T12:00:00.000Z' },
  monthly: null,
});

async function routedPools(t, { gemini = USAGE, codexIdle = false } = {}) {
  const { readUsage } = await agyModule();
  const home = tempHome(t, 'bs-agy-route-');
  writeFileSync(join(home, 'state.json'), JSON.stringify({ pools: {}, strategy: {}, decisionLog: [] }));
  // The Claude group is busy in these readings, so the Gemini pool is the most behind.
  const claudeBody = withBuckets((group, bucket) => {
    if (group !== 'Gemini Models') bucket.remaining_fraction = 0.4;
  });
  const readings = {
    agy: reading(await readUsage('agy', { runner: usageRunner(gemini) })),
    'agy:claude': reading(await readUsage('agy:claude', { runner: usageRunner(claudeBody) })),
    'claude-code': busy('claude-code'),
    codex: codexIdle
      ? reading({ captured_at: new Date(NOW).toISOString(), pool: 'codex', five_hour: null,
        seven_day: { utilization: 0, resets_at: '2026-11-18T12:00:00.000Z' }, monthly: null })
      : busy('codex'),
    grok: busy('grok'),
  };
  const { pools } = buildPools(home, NOW, readings, loaderFor(home));
  return { home, pools: pools.filter((p) => p.enabled) };
}

test('routing: with agy most behind its pace it is picked for analyze and build with no pin', async (t) => {
  const { pools } = await routedPools(t);
  const names = pools.map((p) => p.name).sort();
  assert.deepEqual(names, ['agy', 'agy:claude', 'claude-code', 'codex', 'grok']);
  const agy = pools.find((p) => p.name === 'agy');
  assert.equal(agy.pacingWindow, 'weekly');
  assert.equal(agy.fiveHourUsedPct, 0.5);
  assert.ok(agy.pace > 0, String(agy.pace));
  for (const lane of ['analyze', 'build']) {
    const route = pickPool(lane, pools, { now: NOW });
    assert.equal(route.pick?.pool, 'agy', `${lane}: ${route.why}`);
  }
});

test('routing: agy is skipped while its 5h window reads 99% or more, and back below it', async (t) => {
  for (const remaining of [0.01, 0.004, 0]) {
    const gemini = withBuckets((group, bucket) => {
      if (group === 'Gemini Models' && bucket.window === '5h') bucket.remaining_fraction = remaining;
    });
    const { pools } = await routedPools(t, { gemini });
    const agy = pools.find((p) => p.name === 'agy');
    assert.ok(agy.fiveHourUsedPct >= 99, String(agy.fiveHourUsedPct));
    const route = pickPool('build', pools, { now: NOW });
    assert.notEqual(route.pick?.pool, 'agy', route.why);
    assert.ok(!route.candidates.some((c) => c.pool === 'agy'), route.why);
  }
  const justUnder = withBuckets((group, bucket) => {
    if (group === 'Gemini Models' && bucket.window === '5h') bucket.remaining_fraction = 0.02;
  });
  const { pools } = await routedPools(t, { gemini: justUnder });
  assert.equal(pickPool('build', pools, { now: NOW }).pick?.pool, 'agy');
});

test('routing: --use-provider agy pins the step to agy when another pool is further behind', async (t) => {
  const { home, pools } = await routedPools(t, { codexIdle: true });
  const action = { id: 'task', lane: 'build', effort: 'high' };
  const free = await previewStepPick({ action, pools, bullswarmDir: home, coreState: { decisionLog: [] }, targetDir: home, now: NOW });
  assert.equal(free.pick?.pool, 'codex', free.why);
  const pinned = await previewStepPick({
    action: { ...action, route: { providers: { use: ['agy'] } } },
    pools, bullswarmDir: home, coreState: { decisionLog: [] }, targetDir: home, now: NOW,
  });
  assert.equal(pinned.ok, true, pinned.why);
  assert.equal(pinned.pick.pool, 'agy', pinned.why);
  // The preview's argv is the one a worker would get: the pool's model, at the tier's level.
  const command = pinned.pick.command;
  assert.equal(command[0], 'agy');
  assert.ok(pairAt(command, '--model', 'gemini-4-carbon'), command.join(' '));
  assert.ok(pairAt(command, '--effort', 'high'), command.join(' '));
  assert.ok(pairAt(command, '--output-format', 'stream-json'), command.join(' '));
  assert.ok(pairAt(command, '--add-dir', home), command.join(' '));
});

test('dispatch: an unpinned build step runs on agy, and the worker gets the agy argv', async (t) => {
  const { home, pools } = await routedPools(t);
  const core = { config: { depthLimit: 2 }, pools: {}, incumbents: {}, decisionLog: [] };
  const ran = [];
  let refreshed = 0;
  const result = await dispatchV2Action({
    action: { id: 'task', lane: 'build', effort: 'high' },
    taskText: 'do it', targetDir: home,
    paths: { taskFile: join(home, 'task.md'), outFile: join(home, 'out.md') },
    pools, bullswarmDir: home, maxMechanicalRetries: 0,
    refreshPools: async () => { refreshed += 1; return pools; },
    dependencies: {
      watchOnce: async (connector, task, targetDir, files, opts) => {
        ran.push({ pool: connector.name, argv: argvWithModel(connector, { taskFile: files.taskFile, cwd: targetDir }, opts.model, opts.conversation, opts.reasoning) });
        writeFileSync(files.taskFile, task);
        writeFileSync(join(targetDir, 'made.txt'), 'made\n');
        writeFileSync(files.outFile, '## Completed\n\nMade the change and verified it: all checks passed.');
        return { ok: true, why: 'ok', meta: { exitCode: 0, wallSec: 1 } };
      },
      loadState: () => structuredClone(core),
      saveState: (_dir, next) => Object.assign(core, structuredClone(next)),
      now: () => NOW,
      uuid: () => 'session-fixed',
    },
  });
  assert.ok(refreshed >= 1, 'the dispatch re-read the (fake) meters');
  assert.deepEqual(ran.map((r) => r.pool), ['agy'], JSON.stringify(result.verdict ?? result));
  const argv = ran[0].argv;
  assert.ok(pairAt(argv, '--model', 'gemini-4-carbon'), argv.join(' '));
  assert.ok(pairAt(argv, '--effort', 'high'), argv.join(' '));
  assert.ok(pairAt(argv, '--output-format', 'stream-json'), argv.join(' '));
});

// --- strategy: the Gemini mapping per effort tier -------------------------------------------

test('strategy suggests the Gemini line per tier on agy, and Opus/Sonnet on agy:claude', async (t) => {
  const { providers, agy, claude } = agyPools(t);
  const provider = providers.find((p) => p.name === 'agy');
  const executor = async () => MODELS_TXT;
  const discoveries = {
    agy: await discoverConnectorModels(agy, { provider, providerExecutor: executor }),
    'agy:claude': await discoverConnectorModels(claude, { provider, providerExecutor: executor }),
  };
  const poolFor = (connector) => ({
    name: connector.name, connector, enabled: true, pace: 0, costRank: connector.costRank,
    lanes: connector.lanes, capabilities: connector.capabilities,
  });
  const report = buildStrategy({
    connectors: { agy, 'agy:claude': claude }, pools: [poolFor(agy), poolFor(claude)], state: {}, discoveries,
  });
  const gemini = report.providerSuggestions.agy;
  assert.equal(gemini.high.recommended.model, 'gemini-4-carbon');
  assert.equal(gemini.medium.recommended.model, 'gemini-4-hydrogen');
  assert.equal(gemini.low.recommended.model, 'gemini-3.8-flash');
  // Argon is listed and selectable, never suggested.
  const argon = discoveries.agy.models.find((m) => m.id === 'gemini-4-argon');
  assert.deepEqual([argon.tier, argon.autoRecommend], ['high', false]);
  assert.ok(!gemini.high.candidates.some((c) => c.model === 'gemini-4-argon'));
  // Each tier's rung runs at the connector's level for it: carbon high, hydrogen high, flash medium.
  for (const [tier, model, level] of [['high', 'gemini-4-carbon', 'high'], ['medium', 'gemini-4-hydrogen', 'high'], ['low', 'gemini-3.8-flash', 'medium']]) {
    const record = resolveReasoningLevel({ connector: agy, tier, model, strategy: { lastReport: { discoveries } } });
    assert.equal(record.applied, level, `${tier}/${model}`);
  }

  const other = report.providerSuggestions['agy:claude'];
  // Addendum I (owner benchmark decision, 18 Nov, out/evals/2026-11-18-agy/opus46):
  // no high pick on agy:claude, medium = Opus 4.6, low = Sonnet 4.6, GPT-OSS autoRecommend false.
  assert.equal(other.high.recommended, null);
  assert.deepEqual(other.high.candidates, []);
  assert.equal(other.medium.recommended.model, 'claude-opus-4-6-thinking');
  assert.equal(other.low.recommended.model, 'claude-sonnet-4-6');
  const gptOss = discoveries['agy:claude'].models.find((m) => m.id === 'gpt-oss-120b-medium');
  assert.deepEqual([gptOss.tier, gptOss.autoRecommend], ['low', false]);
  assert.ok(!other.low.candidates.some((c) => c.model === 'gpt-oss-120b-medium'));
  const rawConnector = JSON.parse(readFileSync(join(REPO, 'src/providers/agy/connector.json'), 'utf8'));
  assert.match(rawConnector['$comment-modelFamilies'] ?? '', /out\/evals\/2026-11-18-agy\/opus46/);
  assert.deepEqual(report.unranked, []);
  // Gemini and Anthropic prices are dated rows; GPT-OSS via AGY stays unpriced.
  const priced = Object.fromEntries(discoveries.agy.models.map((m) => [m.id, m.pricing]));
  assert.deepEqual(priced['gemini-4-carbon'], { inputUsdPerMillion: 2, cacheReadUsdPerMillion: 0.1, outputUsdPerMillion: 10 });
  assert.deepEqual(priced['gemini-4-hydrogen'], { inputUsdPerMillion: 1.5, cacheReadUsdPerMillion: 0.075, outputUsdPerMillion: 7.5 });
  assert.deepEqual(priced['gemini-3.8-flash'], { inputUsdPerMillion: 0.75, cacheReadUsdPerMillion: 0.075, outputUsdPerMillion: 3.75 });
  const claudePriced = Object.fromEntries(discoveries['agy:claude'].models.map((m) => [m.id, m.pricing]));
  assert.deepEqual(claudePriced['claude-opus-4-6-thinking'], {
    inputUsdPerMillion: 5, cacheReadUsdPerMillion: 0.5, cacheWrite5mUsdPerMillion: 6.25, cacheWrite1hUsdPerMillion: 10, outputUsdPerMillion: 25,
  });
  assert.deepEqual(claudePriced['claude-sonnet-4-6'], {
    inputUsdPerMillion: 3, cacheReadUsdPerMillion: 0.3, cacheWrite5mUsdPerMillion: 3.75, cacheWrite1hUsdPerMillion: 6, outputUsdPerMillion: 15,
  });
  assert.equal(claudePriced['gpt-oss-120b-medium'], null);
});

test('docs: the contrib README lists every first-class provider under src/providers, agy included', () => {
  const readme = readFileSync(join(REPO, 'providers/contrib/README.md'), 'utf8');
  const line = readme.split('\n').join(' ').match(/providers under\s+`src\/providers\/`\s+\(([^)]*)\)/);
  assert.ok(line, 'the README names the first-class providers in parentheses after `src/providers/`');
  const listed = line[1].split(',').map((name) => name.trim()).sort();
  const firstClass = readdirSync(join(REPO, 'src/providers'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  assert.deepEqual(listed, firstClass);
});

test('argv: a connector-default dispatch still names the pool model, so agy:claude never falls to agy\'s own (possibly Gemini) default', () => {
  const template = JSON.parse(readFileSync(join(REPO, 'src/providers/agy/connector.json'), 'utf8'));
  const [gemini, claude] = connectors({ template });
  const paths = { taskFile: '/runs/r1/task-a.md', cwd: '/work/repo' };
  for (const [pool, model] of [[gemini, 'gemini-4-carbon'], [claude, 'claude-sonnet-4-6']]) {
    // No tier assignment and no exclusions: core leaves the model to the connector (model null).
    const resolved = resolveDispatchModel(pool, 'high', {});
    assert.deepEqual([resolved.model, resolved.source], [null, 'connector-default']);
    const argv = argvWithModel(pool, paths, resolved.model);
    assert.ok(pairAt(argv, '--model', model), `${pool.name}: ${argv.join(' ')}`);
    assert.equal(argv.filter((a) => a === '--model').length, 1);
  }
});
