import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadOpenRouterCatalog, openRouterMetadata, openRouterModelKey,
} from '../src/lib/openrouter-models.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'bullswarm-openrouter-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function response(data) {
  return { ok: true, status: 200, json: async () => ({ data }) };
}

test('OpenRouter catalog combines official rankings, pricing, and a reusable cache', async () => {
  const f = fixture();
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    assert.match(url, /category=programming/);
    return response([
      {
        id: 'anthropic/claude-opus-5', name: 'Claude Opus 5', created: 1,
        pricing: { prompt: '0.000005', completion: '0.000025', input_cache_read: '0.0000005' },
      },
      {
        id: 'openai/gpt-5.6-sol', name: 'GPT-5.6 Sol', created: 2,
        pricing: { prompt: '0.000004', completion: '0.000020' },
      },
    ]);
  };
  try {
    const catalog = await loadOpenRouterCatalog({ bullswarmDir: f.dir, fetchImpl, now: 1_000, force: true });
    assert.equal(calls, 4);
    assert.equal(catalog.models['anthropic/claude-opus-5'].pricing.inputUsdPerMillion, 5);
    assert.equal(catalog.models['anthropic/claude-opus-5'].pricing.outputUsdPerMillion, 25);
    assert.deepEqual(catalog.models['anthropic/claude-opus-5'].ranks, {
      agentic: 1, coding: 1, intelligence: 1, popularity: 1,
    });
    assert.equal(JSON.parse(readFileSync(join(f.dir, 'cache', 'openrouter-models.json'), 'utf8')).models['openai/gpt-5.6-sol'].name, 'GPT-5.6 Sol');

    const cached = await loadOpenRouterCatalog({
      bullswarmDir: f.dir,
      fetchImpl: async () => { throw new Error('cache should avoid network'); },
      now: 2_000,
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

test('OpenRouter failure returns stale cache instead of breaking setup', async () => {
  const f = fixture();
  const model = { id: 'openai/gpt-5.6-sol', pricing: { prompt: '0.000004', completion: '0.000020' } };
  try {
    await loadOpenRouterCatalog({ bullswarmDir: f.dir, fetchImpl: async () => response([model]), now: 1_000, force: true });
    const catalog = await loadOpenRouterCatalog({
      bullswarmDir: f.dir,
      fetchImpl: async () => { throw new Error('offline'); },
      now: 3 * 24 * 60 * 60 * 1_000,
      ttlMs: 1,
    });
    assert.equal(catalog.cache, 'stale');
    assert.equal(catalog.error, 'offline');
    assert.ok(catalog.models['openai/gpt-5.6-sol']);
  } finally { f.cleanup(); }
});
