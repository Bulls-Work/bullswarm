// The shared reasoning resolver. Every dispatch path (bullswarm run, the V1
// runtime, V2 dispatch) resolves through resolveReasoningLevel, so this file
// is the single place the precedence chain and the clamp are pinned down.
//
// The connector fixtures are the REAL packaged templates, read from disk: a
// precedence assertion that passed against a hand-written block would say
// nothing about what the shipped connectors actually declare.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REASONING_LEVELS, isReasoningLevel, resolveReasoningLevel, reasoningArgs,
  appliedReasoningLevel, reasoningRecord,
} from '../src/lib/reasoning.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packaged = (name) => JSON.parse(readFileSync(join(REPO_ROOT, 'connectors', `${name}.json`), 'utf8'));

const claude = packaged('claude-code');
const codex = packaged('codex');
const grok = packaged('grok');
const commandCode = packaged('command-code');
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
    levels: ['low', 'medium', 'high', 'xhigh'],
    defaults: { high: 'high', medium: 'medium', low: 'low' },
  });
  assert.deepEqual(grok.reasoning.levels, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(grok.reasoning.flag, '--reasoning-effort');
  assert.equal(commandCode.reasoning.flag, '--effort');
  for (const connector of [claude, codex, grok, commandCode]) {
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

test('a request the connector cannot express is clamped, never dropped', () => {
  // codex accepts low..xhigh: max clamps down to the strongest it has.
  assert.deepEqual(
    resolveReasoningLevel({ connector: codex, tier: 'high', runOverride: 'max' }),
    { requested: 'max', applied: 'xhigh', source: 'run', clamped: true },
  );
  // command-code accepts low, medium, high: xhigh clamps down to high.
  assert.deepEqual(
    resolveReasoningLevel({ connector: commandCode, tier: 'high', runOverride: 'xhigh' }),
    { requested: 'xhigh', applied: 'high', source: 'run', clamped: true },
  );
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
    reasoningRecord(resolveReasoningLevel({ connector: codex, tier: 'high', runOverride: 'max' })),
    { requested: 'max', applied: 'xhigh', source: 'run', clamped: true },
  );
  // An unrecognized source is not passed through as if it were real.
  assert.equal(reasoningRecord({ applied: 'high', source: 'made-up' }).source, 'none');
});
