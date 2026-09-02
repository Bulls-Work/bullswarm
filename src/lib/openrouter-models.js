import {
  existsSync, mkdirSync, readFileSync, renameSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const OPENROUTER_BENCHMARKS_API = 'https://openrouter.ai/api/v1/benchmarks';
export const OPENROUTER_MODELS_API = 'https://openrouter.ai/api/v1/models';
export const OPENROUTER_DATAPACK_URL = 'https://github.com/cowcow02/bullswarm/releases/download/benchmark-data-latest/openrouter-benchmarks.json';
export const OPENROUTER_RANKINGS_SOURCE = 'https://openrouter.ai/rankings';
export const OPENROUTER_DATAPACK_SCHEMA = 'bullswarm.openrouter.benchmarks.v1';
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const BUNDLED_DATAPACK = fileURLToPath(new URL('../../data/openrouter-benchmarks.json', import.meta.url));

function finite(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function perMillion(value) {
  const parsed = finite(value);
  return parsed == null ? null : Math.round(parsed * 1e12) / 1e6;
}

function pricing(value = {}) {
  return {
    inputUsdPerMillion: perMillion(value.prompt),
    cacheReadUsdPerMillion: perMillion(value.input_cache_read),
    cacheWriteUsdPerMillion: perMillion(value.input_cache_write),
    outputUsdPerMillion: perMillion(value.completion),
  };
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

export function validateOpenRouterDatapack(value) {
  if (!object(value)) throw new Error('OpenRouter datapack must be an object');
  if (value.schemaVersion !== OPENROUTER_DATAPACK_SCHEMA) throw new Error('unsupported OpenRouter datapack schema');
  if (!Number.isFinite(Date.parse(value.capturedAt ?? ''))) throw new Error('OpenRouter datapack capturedAt is invalid');
  if (!object(value.models)) throw new Error('OpenRouter datapack models must be an object');
  if (!Array.isArray(value.benchmarkRecords)) throw new Error('OpenRouter datapack benchmarkRecords must be an array');
  for (const [id, model] of Object.entries(value.models)) {
    if (!object(model) || model.id !== id) throw new Error(`OpenRouter datapack model ${id} is invalid`);
    for (const score of Object.values(model.indices ?? {})) {
      if (score != null && !Number.isFinite(Number(score))) throw new Error(`OpenRouter datapack model ${id} has an invalid index`);
    }
    for (const rank of Object.values(model.ranks ?? {})) {
      if (!Number.isInteger(rank) || rank < 1) throw new Error(`OpenRouter datapack model ${id} has an invalid rank`);
    }
  }
  return value;
}

export function buildOpenRouterDatapack({ benchmarks, models, capturedAt = new Date().toISOString() }) {
  if (!Array.isArray(benchmarks?.data)) throw new Error('OpenRouter benchmarks response has no data array');
  if (!Array.isArray(models?.data)) throw new Error('OpenRouter models response has no data array');
  const byId = {};
  for (const model of models.data) {
    const id = String(model.id ?? '').trim().toLowerCase();
    if (!id) continue;
    byId[id] = {
      id,
      name: model.name ?? model.id,
      created: finite(model.created),
      indices: {},
      ranks: {},
      pricing: pricing(model.pricing),
      pricingSource: OPENROUTER_MODELS_API,
    };
  }
  for (const record of benchmarks.data) {
    const id = String(record.model_permaslug ?? '').trim().toLowerCase();
    if (!id) continue;
    byId[id] ??= {
      id,
      name: record.display_name ?? id,
      created: null,
      indices: {},
      ranks: {},
      pricing: pricing(record.pricing),
      pricingSource: OPENROUTER_BENCHMARKS_API,
    };
    if (record.source === 'artificial-analysis') {
      byId[id].indices = {
        agentic: finite(record.agentic_index),
        coding: finite(record.coding_index),
        intelligence: finite(record.intelligence_index),
      };
    }
  }
  for (const dimension of ['agentic', 'coding', 'intelligence']) {
    Object.values(byId)
      .filter((model) => model.indices[dimension] != null)
      .sort((a, b) => b.indices[dimension] - a.indices[dimension] || a.id.localeCompare(b.id))
      .forEach((model, index) => { model.ranks[dimension] = index + 1; });
  }
  return validateOpenRouterDatapack({
    schemaVersion: OPENROUTER_DATAPACK_SCHEMA,
    capturedAt,
    upstream: {
      benchmarks: OPENROUTER_BENCHMARKS_API,
      models: OPENROUTER_MODELS_API,
      rankings: OPENROUTER_RANKINGS_SOURCE,
      benchmarkMeta: benchmarks.meta ?? null,
    },
    models: Object.fromEntries(Object.entries(byId).sort(([a], [b]) => a.localeCompare(b))),
    benchmarkRecords: benchmarks.data,
  });
}

function readDatapack(file) {
  if (!file || !existsSync(file)) return null;
  try {
    return validateOpenRouterDatapack(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

function writeDatapack(file, value) {
  if (!file) return;
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, file);
}

async function fetchDatapack(fetchImpl, url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Bullswarm benchmark datapack returned HTTP ${response.status}`);
    return validateOpenRouterDatapack(await response.json());
  } finally {
    clearTimeout(timer);
  }
}

export async function loadOpenRouterCatalog({
  bullswarmDir,
  cacheFile = bullswarmDir ? join(bullswarmDir, 'cache', 'openrouter-benchmarks.json') : null,
  bundledFile = BUNDLED_DATAPACK,
  url = OPENROUTER_DATAPACK_URL,
  fetchImpl = globalThis.fetch,
  force = false,
  now = Date.now(),
  ttlMs = DEFAULT_TTL_MS,
  timeoutMs = 8_000,
} = {}) {
  const cached = readDatapack(cacheFile);
  const captured = Date.parse(cached?.capturedAt ?? '');
  if (!force && cached && Number.isFinite(captured) && now - captured <= ttlMs) {
    return { ...cached, cache: 'fresh', source: url, error: null };
  }
  if (typeof fetchImpl === 'function') {
    try {
      const remote = await fetchDatapack(fetchImpl, url, timeoutMs);
      writeDatapack(cacheFile, remote);
      return { ...remote, cache: 'refreshed', source: url, error: null };
    } catch (error) {
      if (cached) return { ...cached, cache: 'stale', source: url, error: error.message };
      const bundled = readDatapack(bundledFile);
      if (bundled) return { ...bundled, cache: 'bundled', source: bundledFile, error: error.message };
      return {
        schemaVersion: OPENROUTER_DATAPACK_SCHEMA,
        capturedAt: new Date(now).toISOString(),
        upstream: null,
        models: {},
        benchmarkRecords: [],
        cache: 'miss',
        source: url,
        error: error.message,
      };
    }
  }
  const fallback = cached ?? readDatapack(bundledFile);
  return fallback
    ? { ...fallback, cache: cached ? 'stale' : 'bundled', source: cached ? url : bundledFile, error: 'fetch is unavailable' }
    : {
      schemaVersion: OPENROUTER_DATAPACK_SCHEMA,
      capturedAt: new Date(now).toISOString(),
      upstream: null,
      models: {},
      benchmarkRecords: [],
      cache: 'miss',
      source: url,
      error: 'fetch is unavailable',
    };
}

export function openRouterModelKey(modelId) {
  const raw = String(modelId ?? '').trim().toLowerCase();
  if (!raw) return null;
  const tail = raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw;
  if (/^claude-/.test(tail)) return `anthropic/${tail}`;
  if (/^gpt-/.test(tail)) return `openai/${tail}`;
  if (/^grok-/.test(tail)) return `x-ai/${tail}`;
  if (/^gemini-/.test(tail)) return `google/${tail}`;
  if (/^deepseek-/.test(tail)) return `deepseek/${tail}`;
  if (/^minimax-/.test(tail)) return `minimax/${tail}`;
  if (raw.includes('/') && /^(anthropic|openai|x-ai|google|deepseek|minimax|qwen|qwen3|z-ai)\//.test(raw)) return raw;
  return raw.includes('/') ? raw : null;
}

export function openRouterMetadata(catalog, modelId) {
  const key = openRouterModelKey(modelId);
  return key ? catalog?.models?.[key] ?? null : null;
}
