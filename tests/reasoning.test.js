// The shared reasoning resolver. Every dispatch path (bullswarm run, the V1
// runtime, V2 dispatch) resolves through resolveReasoningLevel, so this file
// is the single place the precedence chain and the clamp are pinned down.
//
// The connector fixtures are the REAL packaged templates, read from disk: a
// precedence assertion that passed against a hand-written block would say
// nothing about what the shipped connectors actually declare.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REASONING_LEVELS, isReasoningLevel, resolveReasoningLevel, reasoningArgs,
  appliedReasoningLevel, reasoningRecord, suggestedReasoningLevel, REASONING_SOURCES,
} from '../src/lib/reasoning.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// A first-class template ships in src/providers/, a contrib one in providers/contrib/.
const packaged = (name) => {
  const firstClass = join(REPO_ROOT, 'src', 'providers', name, 'connector.json');
  const file = existsSync(firstClass) ? firstClass : join(REPO_ROOT, 'providers', 'contrib', name, 'connector.json');
  return JSON.parse(readFileSync(file, 'utf8'));
};

const claude = packaged('claude-code');
const codex = packaged('codex');
const grok = packaged('grok');
const commandCode = packaged('command-code');
const opencode = packaged('opencode');
const echo = packaged('echo');

test('the common scale is the five levels, weakest to strongest, plus the literal default', () => {
  assert.deepEqual(REASONING_LEVELS, ['low', 'medium', 'high', 'xhigh', 'max']);
  for (const level of [...REASONING_LEVELS, 'default']) assert.equal(isReasoningLevel(level), true, level);
  for (const bogus of ['none', 'xxhigh', 'HIGH', '', null, undefined, 3]) {
    assert.equal(isReasoningLevel(bogus), false, String(bogus));
  }
});

test('packaged connectors declare reasoning from their real CLIs', () => {
  assert.deepEqual(claude.reasoning, {
    flag: '--effort',
    levels: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaults: { high: 'xhigh', medium: 'high', low: 'medium' },
    skipModels: ['^claude-haiku-'],
  });
  assert.deepEqual(codex.reasoning, {
    args: ['-c', 'model_reasoning_effort={level}'],
    levels: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaults: { high: 'high', medium: 'medium', low: 'low' },
  });
  // command-code 1.44.0 lists the same five levels in its own rejection message.
  assert.deepEqual(commandCode.reasoning.levels, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(grok.reasoning.levels, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(grok.reasoning.flag, '--reasoning-effort');
  assert.equal(commandCode.reasoning.flag, '--effort');
  // opencode says the same five levels through `--variant`, which only means
  // anything because a provider cloning this template injects matching model
  // variants through OPENCODE_CONFIG_CONTENT (provider-kit's opencodeVariants).
  assert.deepEqual(opencode.reasoning, {
    flag: '--variant',
    levels: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaults: { high: 'high', medium: 'medium', low: 'low' },
  });
  assert.deepEqual(
    resolveReasoningLevel({ connector: opencode, tier: 'medium', runOverride: 'max' }),
    { requested: 'max', applied: 'max', source: 'run', clamped: false },
  );
  assert.deepEqual(reasoningArgs(opencode, 'max'), ['--variant', 'max']);
  for (const connector of [claude, codex, grok, commandCode, opencode]) {
    // Every block must say where its values came from, so an unverified
    // accepted-value list can never masquerade as a measured one.
    assert.match(connector['$comment-reasoning'], /verified/i, connector.name);
    for (const level of connector.reasoning.levels) assert.ok(REASONING_LEVELS.includes(level), level);
  }
  // Fixture and no-flag connectors declare nothing at all.
  assert.equal(echo.reasoning, undefined);
});

test('each precedence layer wins over the next', () => {
  const strategy = {
    reasoning: {
      tiers: { high: 'medium' },
      pools: { 'claude-code': { high: 'high' } },
    },
  };
  const base = { connector: claude, tier: 'high', strategy };

  assert.deepEqual(
    resolveReasoningLevel({ ...base, runOverride: 'low', actionOverride: 'max' }),
    { requested: 'max', applied: 'max', source: 'action', clamped: false },
  );
  assert.deepEqual(
    resolveReasoningLevel({ ...base, runOverride: 'low' }),
    { requested: 'low', applied: 'low', source: 'run', clamped: false },
  );
  assert.deepEqual(
    resolveReasoningLevel(base),
    { requested: 'high', applied: 'high', source: 'strategy-pool', clamped: false },
  );
  assert.deepEqual(
    resolveReasoningLevel({ ...base, strategy: { reasoning: { tiers: { high: 'medium' } } } }),
    { requested: 'medium', applied: 'medium', source: 'strategy-tier', clamped: false },
  );
  // Nothing configured: the connector's own default for the effort tier.
  assert.deepEqual(
    resolveReasoningLevel({ connector: claude, tier: 'high' }),
    { requested: 'xhigh', applied: 'xhigh', source: 'connector', clamped: false },
  );
  assert.deepEqual(
    resolveReasoningLevel({ connector: claude, tier: 'medium' }),
    { requested: 'high', applied: 'high', source: 'connector', clamped: false },
  );
  assert.deepEqual(
    resolveReasoningLevel({ connector: claude, tier: 'low' }),
    { requested: 'medium', applied: 'medium', source: 'connector', clamped: false },
  );
});

test('a per-pool strategy level applies only to its own pool', () => {
  const strategy = { reasoning: { pools: { 'claude-code': { high: 'max' } } } };
  assert.equal(resolveReasoningLevel({ connector: claude, tier: 'high', strategy }).source, 'strategy-pool');
  // codex is a different pool: it falls through to its own connector default.
  assert.deepEqual(
    resolveReasoningLevel({ connector: codex, tier: 'high', strategy }),
    { requested: 'high', applied: 'high', source: 'connector', clamped: false },
  );
});

test('the literal default stops resolution at the layer that said it', () => {
  assert.deepEqual(
    resolveReasoningLevel({ connector: claude, tier: 'high', actionOverride: 'default' }),
    { requested: 'default', applied: null, source: 'action', clamped: false },
  );
  assert.deepEqual(
    resolveReasoningLevel({ connector: claude, tier: 'high', runOverride: 'default' }),
    { requested: 'default', applied: null, source: 'run', clamped: false },
  );
  assert.deepEqual(
    resolveReasoningLevel({
      connector: claude, tier: 'high',
      strategy: { reasoning: { pools: { 'claude-code': { high: 'default' } } } },
    }),
    { requested: 'default', applied: null, source: 'strategy-pool', clamped: false },
  );
  assert.deepEqual(
    resolveReasoningLevel({
      connector: claude, tier: 'high', strategy: { reasoning: { tiers: { high: 'default' } } },
    }),
    { requested: 'default', applied: null, source: 'strategy-tier', clamped: false },
  );
  // A run-wide `default` outranks a strategy level, exactly like any override.
  assert.deepEqual(
    resolveReasoningLevel({
      connector: claude, tier: 'high', runOverride: 'default',
      strategy: { reasoning: { tiers: { high: 'max' } } },
    }),
    { requested: 'default', applied: null, source: 'run', clamped: false },
  );
});

test('a connector with no reasoning block is unsupported, whatever was asked', () => {
  assert.deepEqual(
    resolveReasoningLevel({ connector: echo, tier: 'low' }),
    { requested: null, applied: null, source: 'unsupported', clamped: false },
  );
  // The request is still reported, so a record can show it was asked for and
  // could not be expressed.
  assert.deepEqual(
    resolveReasoningLevel({ connector: echo, tier: 'low', runOverride: 'max' }),
    { requested: 'max', applied: null, source: 'unsupported', clamped: false },
  );
  // A block with no usable level list cannot be clamped against either.
  assert.equal(resolveReasoningLevel({
    connector: { name: 'x', reasoning: { flag: '--effort', levels: [] } }, tier: 'high', runOverride: 'high',
  }).source, 'unsupported');
});

test('a connector with a reasoning block but no level for the tier passes nothing', () => {
  const partial = { name: 'partial', reasoning: { flag: '--effort', levels: ['low', 'high'], defaults: { high: 'high' } } };
  assert.deepEqual(
    resolveReasoningLevel({ connector: partial, tier: 'low' }),
    { requested: null, applied: null, source: 'none', clamped: false },
  );
});

test('a model the connector marks as skipped gets no level', () => {
  assert.deepEqual(
    resolveReasoningLevel({ connector: claude, tier: 'low', model: 'claude-haiku-4-5' }),
    { requested: 'medium', applied: null, source: 'skipped-model', clamped: false },
  );
  // A non-matching model on the same connector is unaffected.
  assert.equal(
    resolveReasoningLevel({ connector: claude, tier: 'high', model: 'claude-opus-5' }).applied,
    'xhigh',
  );
  // A broken connector regex never blocks a dispatch (RS5).
  assert.equal(resolveReasoningLevel({
    connector: { ...claude, reasoning: { ...claude.reasoning, skipModels: ['([unclosed'] } },
    tier: 'high', model: 'claude-opus-5',
  }).applied, 'xhigh');
});

// A connector whose CLI stops at high (the shape codex and command-code had
// before their 2026-09-09 probes showed both accept xhigh and max).
const narrow = { name: 'narrow', reasoning: { flag: '--effort', levels: ['low', 'medium', 'high'], defaults: { high: 'high', medium: 'medium', low: 'low' } } };

test('a request the connector cannot express is clamped, never dropped', () => {
  // narrow accepts low..high: max clamps down to the strongest it has.
  assert.deepEqual(
    resolveReasoningLevel({ connector: narrow, tier: 'high', runOverride: 'max' }),
    { requested: 'max', applied: 'high', source: 'run', clamped: true },
  );
  // xhigh clamps down to high the same way.
  assert.deepEqual(
    resolveReasoningLevel({ connector: narrow, tier: 'high', runOverride: 'xhigh' }),
    { requested: 'xhigh', applied: 'high', source: 'run', clamped: true },
  );
  // codex and command-code now express max directly.
  assert.deepEqual(
    resolveReasoningLevel({ connector: codex, tier: 'high', runOverride: 'max' }),
    { requested: 'max', applied: 'max', source: 'run', clamped: false },
  );
  assert.equal(resolveReasoningLevel({ connector: commandCode, tier: 'low', runOverride: 'max' }).applied, 'max');
  // A supported request is not a clamp.
  assert.deepEqual(
    resolveReasoningLevel({ connector: codex, tier: 'low', runOverride: 'low' }),
    { requested: 'low', applied: 'low', source: 'run', clamped: false },
  );
  // Below every supported level: take the weakest the connector has.
  const strongOnly = { name: 'strong-only', reasoning: { flag: '--think', levels: ['high', 'xhigh', 'max'] } };
  assert.deepEqual(
    resolveReasoningLevel({ connector: strongOnly, tier: 'low', runOverride: 'low' }),
    { requested: 'low', applied: 'high', source: 'run', clamped: true },
  );
  // A gap in the middle clamps down to the nearest level not above it.
  const gapped = { name: 'gapped', reasoning: { flag: '--think', levels: ['low', 'max'] } };
  assert.deepEqual(
    resolveReasoningLevel({ connector: gapped, tier: 'high', runOverride: 'xhigh' }),
    { requested: 'xhigh', applied: 'low', source: 'run', clamped: true },
  );
  // Declared out of order, or with junk: order comes from the common scale.
  const messy = { name: 'messy', reasoning: { flag: '--think', levels: ['high', 'bogus', 'low'] } };
  assert.equal(resolveReasoningLevel({ connector: messy, tier: 'high', runOverride: 'max' }).applied, 'high');
  assert.equal(resolveReasoningLevel({ connector: messy, tier: 'high', runOverride: 'medium' }).applied, 'low');
});

test('Codex discovered per-model reasoning levels refine the connector clamp', () => {
  const strategy = {
    lastReport: { discoveries: { codex: { models: [
      { id: 'gpt-5.5', reasoningLevels: ['low', 'medium', 'high', 'xhigh'] },
      { id: 'gpt-5.6-sol', reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
    ] } } },
  };
  assert.deepEqual(
    resolveReasoningLevel({ connector: codex, model: 'gpt-5.5', tier: 'high', strategy, runOverride: 'max' }),
    { requested: 'max', applied: 'xhigh', source: 'run', clamped: true },
  );
  // `ultra` is outside Bullswarm's common scale, while max remains available.
  assert.equal(resolveReasoningLevel({
    connector: codex, model: 'gpt-5.6-sol', tier: 'high', strategy, runOverride: 'max',
  }).applied, 'max');
});

test('a malformed level at any layer falls through instead of failing the dispatch', () => {
  assert.deepEqual(
    resolveReasoningLevel({ connector: claude, tier: 'high', runOverride: 'ludicrous' }),
    { requested: 'xhigh', applied: 'xhigh', source: 'connector', clamped: false },
  );
  assert.deepEqual(
    resolveReasoningLevel({ connector: claude, tier: 'high', strategy: { reasoning: { tiers: { high: 42 } } } }),
    { requested: 'xhigh', applied: 'xhigh', source: 'connector', clamped: false },
  );
  // No arguments at all: nothing to resolve, nothing thrown.
  assert.deepEqual(
    resolveReasoningLevel(),
    { requested: null, applied: null, source: 'unsupported', clamped: false },
  );
  assert.equal(resolveReasoningLevel({ connector: claude, tier: null }).source, 'none');
});

test('reasoningArgs renders the flag form and the config-args form', () => {
  assert.deepEqual(reasoningArgs(claude, 'xhigh'), ['--effort', 'xhigh']);
  assert.deepEqual(reasoningArgs(grok, 'high'), ['--reasoning-effort', 'high']);
  assert.deepEqual(reasoningArgs(codex, 'medium'), ['-c', 'model_reasoning_effort=medium']);
  // Nothing to append: no level, the `default` literal, or no declaration.
  assert.deepEqual(reasoningArgs(claude, null), []);
  assert.deepEqual(reasoningArgs(claude, 'default'), []);
  assert.deepEqual(reasoningArgs(echo, 'high'), []);
  assert.deepEqual(reasoningArgs({ name: 'x', reasoning: { levels: ['high'] } }, 'high'), []);
});

test('the reported record accepts a resolved object or a bare level', () => {
  assert.equal(appliedReasoningLevel({ applied: 'max' }), 'max');
  assert.equal(appliedReasoningLevel('high'), 'high');
  assert.equal(appliedReasoningLevel('default'), null);
  assert.equal(appliedReasoningLevel(null), null);
  assert.deepEqual(reasoningRecord(null), { requested: null, applied: null, source: 'none', clamped: false });
  assert.deepEqual(reasoningRecord('xhigh'), { requested: 'xhigh', applied: 'xhigh', source: 'run', clamped: false });
  assert.deepEqual(
    reasoningRecord(resolveReasoningLevel({ connector: narrow, tier: 'high', runOverride: 'max' })),
    { requested: 'max', applied: 'high', source: 'run', clamped: true },
  );
  // An unrecognized source is not passed through as if it were real.
  assert.equal(reasoningRecord({ applied: 'high', source: 'made-up' }).source, 'none');
});

test('a suggested level is the strongest the model supports, never above max', () => {
  const connector = { name: 'x', reasoning: { flag: '--effort', levels: ['low', 'medium', 'high', 'xhigh', 'max'], skipModels: ['^tiny-'] } };
  const at = (model, requested) => suggestedReasoningLevel(connector, model, requested).applied;
  assert.equal(at({ id: 'a', reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] }), 'max');
  assert.equal(at({ id: 'a', reasoningLevels: ['low', 'medium', 'high'] }), 'high');
  assert.equal(at({ id: 'a' }), 'max', 'no discovered list: the connector levels');
  assert.equal(at({ id: 'a', reasoningLevels: ['ultra'] }), null, 'nothing on the common scale');
  assert.equal(at({ id: 'tiny-1' }), null, 'a skipped model gets no level');
  assert.equal(at({ id: 'a' }, 'high'), 'high', 'a lower request is kept');
  assert.equal(suggestedReasoningLevel(null, { id: 'a' }).applied, null, 'no reasoning block');
  assert.equal(suggestedReasoningLevel(connector, { id: 'a', reasoningLevels: ['low'] }).clamped, true);
});

test('a recommendation-written pool level reports source recommendation, for its own model only', () => {
  assert.ok(REASONING_SOURCES.includes('recommendation'));
  const connector = { name: 'codex', reasoning: { args: ['-c', 'e={level}'], levels: ['low', 'medium', 'high', 'xhigh', 'max'], defaults: { medium: 'medium' } } };
  const strategy = {
    reasoning: { tiers: {}, pools: { codex: { medium: 'max' } } },
    recommendedReasoning: { codex: { medium: { level: 'max', model: 'gpt-6-luna', why: 'w' } } },
  };
  const resolve = (model, s = strategy) => resolveReasoningLevel({ connector, tier: 'medium', model, strategy: s });
  assert.deepEqual(resolve('gpt-6-luna'), { requested: 'max', applied: 'max', source: 'recommendation', clamped: false });
  assert.deepEqual(resolve(null), { requested: 'max', applied: 'max', source: 'recommendation', clamped: false });
  assert.deepEqual(resolve('gpt-5.6-terra'), { requested: 'medium', applied: 'medium', source: 'connector', clamped: false });
  // A run-wide override still wins over it.
  assert.equal(resolveReasoningLevel({ connector, tier: 'medium', model: 'gpt-6-luna', strategy, runOverride: 'low' }).source, 'run');
  // A slot whose value no longer matches the mark is the operator's.
  const edited = { ...strategy, reasoning: { tiers: {}, pools: { codex: { medium: 'high' } } } };
  assert.equal(resolve('gpt-6-luna', edited).source, 'strategy-pool');
  assert.equal(reasoningRecord({ requested: 'max', applied: 'max', source: 'recommendation' }).source, 'recommendation');
});
