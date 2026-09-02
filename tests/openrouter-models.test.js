import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildOpenRouterDatapack, loadOpenRouterCatalog, openRouterMetadata, openRouterModelKey,
  validateOpenRouterDatapack,
} from '../src/lib/openrouter-models.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'bullswarm-openrouter-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function upstream() {
  return {
    benchmarks: {
      data: [
        {
          source: 'artificial-analysis', model_permaslug: 'anthropic/claude-opus-5-20260723',
          display_name: 'Claude Opus 5', agentic_index: 74, coding_index: 78, intelligence_index: 81,
        },
        {
          source: 'artificial-analysis', model_permaslug: 'openai/gpt-5.6-sol-20260709',
          display_name: 'GPT-5.6 Sol', agentic_index: 72, coding_index: 82, intelligence_index: 79,
        },
        {
          source: 'openrouter', model_permaslug: 'openai/gpt-5.6-sol',
          benchmark_type: 'gpqa_diamond', accuracy: 0.8, total_tasks: 300,
        },
        {
          source: 'openrouter', model_permaslug: 'example/no-listed-price',
          display_name: 'No Listed Price', pricing: null,
        },
      ],
      meta: { as_of: '2026-09-02T00:00:00Z', version: 'v1' },
    },
    models: { data: [
      {
        id: 'anthropic/claude-opus-5', name: 'Claude Opus 5', created: 1,
        pricing: { prompt: '0.000005', completion: '0.000025', input_cache_read: '0.0000005' },
      },
      {
        id: 'openai/gpt-5.6-sol', name: 'GPT-5.6 Sol', created: 2,
        pricing: { prompt: '0.000004', completion: '0.000020' },
      },
    ] },
  };
}

function datapack() {
  const value = upstream();
  return buildOpenRouterDatapack({
    ...value,
    capturedAt: '2026-09-02T00:00:00.000Z',
  });
}

function response(value) {
  return { ok: true, status: 200, json: async () => value };
}

test('datapack combines benchmark indices, derived ranks, pricing, and all public records', () => {
  const catalog = datapack();
  assert.equal(catalog.models['anthropic/claude-opus-5'].pricing.inputUsdPerMillion, 5);
  assert.equal(catalog.models['anthropic/claude-opus-5'].pricing.outputUsdPerMillion, 25);
  assert.deepEqual(catalog.models['anthropic/claude-opus-5'].indices, {
    agentic: 74, coding: 78, intelligence: 81,
  });
  assert.deepEqual(catalog.models['anthropic/claude-opus-5'].ranks, {
    agentic: 1, coding: 2, intelligence: 1,
  });
  assert.equal(catalog.models['openai/gpt-5.6-sol'].ranks.coding, 1);
  assert.deepEqual(catalog.models['example/no-listed-price'].pricing, {
    inputUsdPerMillion: null,
    cacheReadUsdPerMillion: null,
    cacheWriteUsdPerMillion: null,
    outputUsdPerMillion: null,
  });
  assert.equal(catalog.benchmarkRecords.length, 4);
  assert.equal(validateOpenRouterDatapack(catalog), catalog);
});

test('CLI downloads one public datapack without an OpenRouter credential and reuses its cache', async () => {
  const f = fixture();
  let calls = 0;
  try {
    const catalog = await loadOpenRouterCatalog({
      bullswarmDir: f.dir,
      fetchImpl: async () => { calls += 1; return response(datapack()); },
      now: Date.parse('2026-09-02T01:00:00Z'),
      force: true,
    });
    assert.equal(calls, 1);
    assert.equal(catalog.cache, 'refreshed');
    assert.equal(JSON.parse(readFileSync(join(f.dir, 'cache', 'openrouter-benchmarks.json'), 'utf8')).models['openai/gpt-5.6-sol'].name, 'GPT-5.6 Sol');

    const cached = await loadOpenRouterCatalog({
      bullswarmDir: f.dir,
      fetchImpl: async () => { throw new Error('cache should avoid network'); },
      now: Date.parse('2026-09-02T02:00:00Z'),
    });
    assert.equal(cached.cache, 'fresh');
    assert.equal(openRouterMetadata(cached, 'relay/gpt-5.6-sol').id, 'openai/gpt-5.6-sol');
  } finally { f.cleanup(); }
});

test('OpenRouter ID normalization maps local provider model names without guessing unknown vendors', () => {
  assert.equal(openRouterModelKey('claude-opus-5'), 'anthropic/claude-opus-5');
  assert.equal(openRouterModelKey('relay/gpt-5.6-luna'), 'openai/gpt-5.6-luna');
  assert.equal(openRouterModelKey('grok-4.6'), 'x-ai/grok-4.6');
  assert.equal(openRouterModelKey('custom-model'), null);
});

test('datapack download failure returns stale cache instead of breaking setup', async () => {
  const f = fixture();
  try {
    await loadOpenRouterCatalog({
      bullswarmDir: f.dir,
      fetchImpl: async () => response(datapack()),
      now: Date.parse('2026-09-02T01:00:00Z'),
      force: true,
    });
    const catalog = await loadOpenRouterCatalog({
      bullswarmDir: f.dir,
      fetchImpl: async () => { throw new Error('offline'); },
      now: Date.parse('2026-09-05T01:00:00Z'),
      ttlMs: 1,
    });
    assert.equal(catalog.cache, 'stale');
    assert.equal(catalog.error, 'offline');
    assert.ok(catalog.models['openai/gpt-5.6-sol']);
  } finally { f.cleanup(); }
});

test('invalid public datapacks are rejected before cache replacement', async () => {
  const f = fixture();
  try {
    const catalog = await loadOpenRouterCatalog({
      bullswarmDir: f.dir,
      bundledFile: null,
      fetchImpl: async () => response({ schemaVersion: 'wrong', models: {} }),
      now: Date.parse('2026-09-02T01:00:00Z'),
      force: true,
    });
    assert.equal(catalog.cache, 'miss');
    assert.match(catalog.error, /schema/);
  } finally { f.cleanup(); }
});
