// Claude Code mod UI and agy:claude pricing (spec addendum F).
//
// Everything runs from fixtures and temp homes with `accounts: []` and an
// injected usage runner: nothing spawns agy or claude, reads ~/.gemini, or
// touches live meters or ~/.bullswarm.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { aliasesOf, displayNames, withDisplayNames } from '../mods/bullswarm/hooks/names.ts';
import { contextText, paceText, parsePools, poolLine, statusText } from '../mods/bullswarm/hooks/pools.ts';
import { shapeStep } from '../mods/bullswarm/hooks/step.ts';
import { decide } from '../mods/bullswarm/hooks/route.ts';

import { createAgentEventDecoder } from '../src/lib/agent-events.js';
import { createAttemptStreamSink } from '../src/lib/attempt-stream.js';
import { buildPools } from '../src/lib/config.js';
import { loadProviders } from '../src/lib/providers.js';
import { estimateInvocationUsage } from '../src/lib/usage.js';
import { paceSnapshot } from '../src/meters/framework.js';
import { readUsage } from '../src/providers/agy/provider.mjs';
import { stepJsonModel } from '../src/workflow/step-json.js';
import { taskStepModel } from '../src/workflow/task-step.js';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const FIRST_CLASS = join(REPO, 'src', 'providers');
const USAGE = JSON.parse(readFileSync(join(REPO, 'tests', 'fixtures', 'agy', 'usage.json'), 'utf8'));
const STREAM = readFileSync(join(REPO, 'tests', 'fixtures', 'stream', 'agy.jsonl'), 'utf8');

// Inside both fixture windows (5h resets 22:26:32Z / 22:40:52Z, weeklies on Nov 24).
const NOW = Date.parse('2026-11-17T20:00:00.000Z');

function tempHome(t, prefix = 'bs-mod-agy-') {
  const home = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  for (const dir of ['providers', 'connectors', 'contrib', 'runs']) mkdirSync(join(home, dir), { recursive: true });
  writeFileSync(join(home, 'state.json'), JSON.stringify({ pools: {}, strategy: {}, decisionLog: [] }));
  return home;
}

function loaderFor(home, accounts = []) {
  return {
    homeDir: home,
    accounts,
    enabled: [],
    dirs: {
      firstClass: FIRST_CLASS,
      contrib: join(home, 'contrib'),
      local: join(home, 'providers'),
      legacy: join(home, 'connectors'),
    },
  };
}

function usageBody({ gemini = {}, claude = {} } = {}) {
  const body = structuredClone(USAGE);
  for (const group of body.command.data.groups) {
    const edits = group.name === 'Gemini Models' ? gemini : claude;
    for (const bucket of group.buckets) {
      if (edits[bucket.window] != null) bucket.remaining_fraction = edits[bucket.window];
    }
  }
  return body;
}

const reading = (snapshot) => ({ snapshot, source: 'live', ...paceSnapshot(snapshot, NOW) });

async function poolsJsonFixture(t, buckets = { gemini: { weekly: 0.7, '5h': 0.85 }, claude: { weekly: 0.95, '5h': 0.6 } }) {
  const home = tempHome(t);
  const body = usageBody(buckets);
  const runner = async () => ({ stdout: JSON.stringify(body), stderr: '', exitCode: 0 });
  const env = { HOME: home };
  const readings = {
    agy: reading(await readUsage('agy', { runner, env, now: () => NOW })),
    'agy:claude': reading(await readUsage('agy:claude', { runner, env, now: () => NOW })),
    'claude-code': reading({
      captured_at: new Date(NOW).toISOString(),
      pool: 'claude-code',
      five_hour: { utilization: 25, resets_at: '2026-11-17T23:00:00.000Z' },
      seven_day: { utilization: 55, resets_at: '2026-11-24T12:00:00.000Z' },
      monthly: null,
    }),
    codex: reading({
      captured_at: new Date(NOW).toISOString(),
      pool: 'codex',
      five_hour: { utilization: 12, resets_at: '2026-11-17T23:30:00.000Z' },
      seven_day: { utilization: 65, resets_at: '2026-11-24T12:00:00.000Z' },
      monthly: null,
    }),
  };
  const { pools } = buildPools(home, NOW, readings, loaderFor(home));
  return { home, stdout: JSON.stringify({ pools }) };
}

test('F: display names keep agy:claude whole while shortening claude-code:<account> to its initial', async (t) => {
  const { stdout } = await poolsJsonFixture(t);
  const parsed = parsePools(stdout);
  const ids = [...parsed.map((p) => p.name), 'claude-code:acme', 'claude-code:me'];
  // One non-colliding account first: claude-code:acme -> claude-code:a, claude-code:me -> claude-code:m.
  const names = displayNames(ids, new Map());
  assert.equal(names.get('agy'), 'agy');
  assert.equal(names.get('agy:claude'), 'agy:claude');
  assert.equal(names.get('claude-code'), 'claude-code');
  assert.equal(names.get('claude-code:acme'), 'claude-code:a');
  assert.equal(names.get('claude-code:me'), 'claude-code:m');

  // Colliding claude-code accounts still fall back to their full names.
  const colliding = displayNames(['agy:claude', 'claude-code:acme', 'claude-code:alpha'], new Map());
  assert.equal(colliding.get('agy:claude'), 'agy:claude');
  assert.equal(colliding.get('claude-code:acme'), 'claude-code:acme');
  assert.equal(colliding.get('claude-code:alpha'), 'claude-code:alpha');

  // Explicit poolAliases and coreLabels still override agy:claude when asked.
  assert.equal(displayNames(['agy:claude'], aliasesOf('agy:claude=agy-3p')).get('agy:claude'), 'agy-3p');
  assert.equal(displayNames(['agy:claude'], new Map(), new Map([['agy:claude', 'agy-claude']])).get('agy:claude'), 'agy-claude');

  // Status line and display-name rewrites never turn agy:claude into agy:c.
  const status = statusText(parsed, true, 0, null, names);
  assert.match(status, /most surplus: agy:claude \+/);
  assert.doesNotMatch(status, /\bagy:c\b/);
  assert.equal(
    withDisplayNames('picked agy:claude over claude-code:acme and agy', names),
    'picked agy:claude over claude-code:a and agy',
  );
});

test('F: pools strip and pane parse both agy pools with their own used/elapsed, pace, and 5h + 7d windows', async (t) => {
  const { stdout } = await poolsJsonFixture(t, {
    gemini: { weekly: 0.7, '5h': 0.85 },
    claude: { weekly: 0.2, '5h': 0.5 },
  });
  const pools = parsePools(stdout);
  const agy = pools.find((p) => p.name === 'agy');
  const agyClaude = pools.find((p) => p.name === 'agy:claude');
  const claudeCode = pools.find((p) => p.name === 'claude-code');
  assert.ok(agy && agyClaude && claudeCode);

  assert.equal(agy.enabled, true);
  assert.equal(agyClaude.enabled, true);
  assert.equal(agy.usedPct, 30);
  assert.equal(agyClaude.usedPct, 80);
  assert.ok(agy.elapsedPct !== null && agyClaude.elapsedPct !== null);
  assert.notEqual(paceText(agy), paceText(agyClaude));
  assert.equal(agy.fiveHourUsedPct, 15);
  assert.equal(agyClaude.fiveHourUsedPct, 50);

  // Both agy pools carry the same [5h, 7d] window list that pane.tsx renders for claude-code and codex.
  assert.deepEqual(claudeCode.windows.map((w) => w.key), ['5h', '7d']);
  assert.deepEqual(agy.windows.map((w) => w.key), ['5h', '7d']);
  assert.deepEqual(agyClaude.windows.map((w) => w.key), ['5h', '7d']);
  assert.equal(agy.windows[0].usedPct, 15);
  assert.equal(agyClaude.windows[0].usedPct, 50);
  assert.ok(agy.windows[0].elapsedPct !== null && agy.windows[0].resetsAt);
  assert.ok(agyClaude.windows[0].elapsedPct !== null && agyClaude.windows[0].resetsAt);
  assert.equal(agy.windows[1].usedPct, 30);
  assert.equal(agyClaude.windows[1].usedPct, 80);

  // Context lines name both pools with their own quota numbers.
  assert.match(poolLine(agy), /^agy: 30% used, \d+% of weekly elapsed, /);
  assert.match(poolLine(agyClaude), /^agy:claude: 80% used, \d+% of weekly elapsed, /);
  const ctx = contextText(pools, true, 0);
  assert.match(ctx, /- agy: 30% used/);
  assert.match(ctx, /- agy:claude: 80% used/);
});

function buildStepFromStream(t, { poolName, connector, modelOverride = null }) {
  const home = tempHome(t, 'bs-mod-agy-step-');
  const runsDir = join(home, 'runs');
  const taskFile = join(runsDir, 'task-1.md');
  const outFile = join(runsDir, 'out-1.md');
  const streamFile = join(runsDir, 'stream-1.jsonl');
  writeFileSync(taskFile, 'Create hello2.txt and list the directory.\n');

  const sink = createAttemptStreamSink({ streamFile, now: () => '2026-11-17T17:41:45.000Z' });
  const decoder = createAgentEventDecoder(connector.eventStream, {
    onEvent: (ev, full) => sink.event(ev, full),
  });
  decoder.push(STREAM, 'stdout', '2026-11-17T17:41:40.000Z');
  decoder.finish('2026-11-17T17:41:53.000Z');
  sink.close();
  writeFileSync(outFile, decoder.output());

  const decodedUsage = decoder.usage();
  const model = modelOverride ?? decodedUsage.model;
  const usage = estimateInvocationUsage({
    connector,
    model,
    reportedUsage: { ...decodedUsage, model, outputIsExclusive: true },
    pricedAt: '2026-11-17T17:41:40.000Z',
  });
  const full = taskStepModel({
    id: 'agy-attempt-1',
    ok: true,
    pool: poolName,
    model,
    effort: 'high',
    startedAt: '2026-11-17T17:41:40.000Z',
    endedAt: '2026-11-17T17:41:53.000Z',
    taskFile,
    outFile,
    streamFile,
    usage,
  }, { runsDir });
  return { usage, full, compact: stepJsonModel(full) };
}

test('F: Step page renders an agy stream attempt (read_file, write_file, run_command, response, cost)', (t) => {
  const home = tempHome(t);
  const { connectors } = loadProviders(home, loaderFor(home));
  const { usage, full, compact } = buildStepFromStream(t, { poolName: 'agy', connector: connectors.agy });
  assert.ok(usage.api.usd > 0, `expected non-$0 Gemini cost, got ${usage.api.usd}`);

  for (const mode of ['overview', 'detail']) {
    const shaped = shapeStep({ step: compact }, { width: 110, mode });
    assert.deepEqual(shaped, shapeStep({ step: full }, { width: 110, mode }));

    const activity = shaped.blocks.find((b) => b.key === 'activity');
    const atomics = activity.rows.filter((r) => r.kind === 'atomic').map((r) => r.text);
    // All three real tool steps from tests/fixtures/stream/agy.jsonl render, and the result envelope does not masquerade as a tool.
    assert.equal(atomics.length, 3, `${mode}: ${JSON.stringify(atomics)}`);
    assert.match(atomics[0], /\/tmp\/agy-probe\/other\/task\.md/);
    assert.match(atomics[1], /\/tmp\/agy-probe\/w\/hello2\.txt/);
    assert.match(atomics[2], /\$\s+ls -la \/tmp\/agy-probe\/w/);
    assert.ok(!atomics.some((line) => /Created \[hello2\.txt\]/.test(line)), 'result envelope is not rendered as a tool row');

    const responses = activity.rows.filter((r) => r.kind === 'response').map((r) => r.text);
    assert.equal(responses.length, 1);
    assert.match(responses[0], /Created \[hello2\.txt\].*containing `two`/);

    const cost = shaped.blocks.find((b) => b.key === 'cost');
    const apiRow = cost.rows.find((r) => r.key === 'cost-API price');
    assert.ok(apiRow, JSON.stringify(cost.rows));
    assert.match(apiRow.text, /API price\s+\$0\.0296/);
  }
});

test('F: agy:claude prices Opus 4.6 and Sonnet 4.6 with cited Anthropic rates and leaves gpt-oss-120b-medium unpriced', (t) => {
  const home = tempHome(t);
  const { connectors } = loadProviders(home, loaderFor(home));
  const claudePool = connectors['agy:claude'];

  // Opus 4.6 ($5 in / $0.50 cache read / $25 out): 15327*5 + 16783*0.5 + 707*25 = 102,701.5 / 1e6 -> $0.1027.
  const opus = buildStepFromStream(t, {
    poolName: 'agy:claude',
    connector: claudePool,
    modelOverride: 'claude-opus-4-6-thinking',
  });
  assert.equal(opus.usage.api.basis, 'rate-card:complete');
  assert.equal(opus.usage.api.rateCard.source, 'https://platform.claude.com/docs/en/about-claude/pricing');
  assert.equal(opus.usage.api.usd, 0.1027);
  const opusCost = shapeStep({ step: opus.compact }, { width: 110 }).blocks.find((b) => b.key === 'cost');
  assert.match(opusCost.rows.find((r) => r.key === 'cost-API price').text, /API price\s+\$0\.1027.*Anthropic rate card/);
  assert.ok(opusCost.rows.some((r) => r.key === 'cost-agy:claude plan'));

  // Sonnet 4.6 ($3 in / $0.30 cache read / $15 out): 15327*3 + 16783*0.3 + 707*15 = 61,620.9 / 1e6 -> $0.0616.
  const sonnet = buildStepFromStream(t, {
    poolName: 'agy:claude',
    connector: claudePool,
    modelOverride: 'claude-sonnet-4-6',
  });
  assert.equal(sonnet.usage.api.basis, 'rate-card:complete');
  assert.equal(sonnet.usage.api.rateCard.source, 'https://platform.claude.com/docs/en/about-claude/pricing');
  assert.equal(sonnet.usage.api.usd, 0.0616);
  const sonnetCost = shapeStep({ step: sonnet.compact }, { width: 110 }).blocks.find((b) => b.key === 'cost');
  assert.match(sonnetCost.rows.find((r) => r.key === 'cost-API price').text, /API price\s+\$0\.0616.*Anthropic rate card/);

  // GPT-OSS 120B has no cited rate card through AGY: stays unpriced rather than $0 or invented.
  const gptOss = buildStepFromStream(t, {
    poolName: 'agy:claude',
    connector: claudePool,
    modelOverride: 'gpt-oss-120b-medium',
  });
  assert.equal(gptOss.usage.api.usd, null);
  assert.equal(gptOss.usage.api.basis, 'unknown:no-rate-card');
  const gptCost = shapeStep({ step: gptOss.compact }, { width: 110 }).blocks.find((b) => b.key === 'cost');
  assert.match(gptCost.rows.find((r) => r.key === 'cost-API price').text, /API price\s+—/);
});

test('F: mod Agent routing counts an enabled agy or agy:claude pool as a delegate candidate', () => {
  const prompt = 'Find where pool pacing surplus is calculated.';
  const onlyCaller = [{ name: 'claude-code', enabled: true, quarantine: null }];
  assert.equal(decide({ prompt, subagent_type: 'Explore' }, onlyCaller).route, false);

  for (const agyPool of ['agy', 'agy:claude']) {
    const enabled = [...onlyCaller, { name: agyPool, enabled: true, quarantine: null }];
    const decision = decide({ prompt, subagent_type: 'Explore' }, enabled);
    assert.deepEqual(decision, { route: true, lane: 'analyze', task: prompt });

    const quarantined = [...onlyCaller, { name: agyPool, enabled: true, quarantine: { until: NOW + 60_000, reason: 'auth', kind: 'auth' } }];
    assert.equal(decide({ prompt, subagent_type: 'Explore' }, quarantined).route, false);

    const disabled = [...onlyCaller, { name: agyPool, enabled: false, quarantine: null }];
    assert.equal(decide({ prompt, subagent_type: 'Explore' }, disabled).route, false);
  }
});
