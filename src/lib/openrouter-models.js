import {
  existsSync, mkdirSync, readFileSync, renameSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export const OPENROUTER_MODELS_SOURCE = 'https://openrouter.ai/api/v1/models';
export const OPENROUTER_RANKINGS_SOURCE = 'https://openrouter.ai/rankings';
const CACHE_SCHEMA = 'bullswarm.openrouter.models.v1';
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const SORTS = Object.freeze({
  agentic: 'agentic-high-to-low',
  coding: 'coding-high-to-low',
  intelligence: 'intelligence-high-to-low',
  popularity: 'most-popular',
});

function finite(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function perMillion(value) {
  const parsed = finite(value);
  return parsed == null ? null : Math.round(parsed * 1e12) / 1e6;
}

function pricing(model) {
  return {
    inputUsdPerMillion: perMillion(model.pricing?.prompt),
    cacheReadUsdPerMillion: perMillion(model.pricing?.input_cache_read),
    cacheWriteUsdPerMillion: perMillion(model.pricing?.input_cache_write),
    outputUsdPerMillion: perMillion(model.pricing?.completion),
  };
}

function readCache(cacheFile, now, ttlMs) {
  if (!cacheFile || !existsSync(cacheFile)) return null;
  try {
    const value = JSON.parse(readFileSync(cacheFile, 'utf8'));
    const captured = Date.parse(value.capturedAt ?? '');
    if (value.schemaVersion !== CACHE_SCHEMA || !Number.isFinite(captured) || now - captured > ttlMs) return null;
    return { ...value, cache: 'fresh' };
  } catch {
    return null;
  }
}

function writeCache(cacheFile, value) {
  if (!cacheFile) return;
  mkdirSync(dirname(cacheFile), { recursive: true });
  const temporary = `${cacheFile}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, cacheFile);
}

async function fetchRanking(fetchImpl, sort, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `${OPENROUTER_MODELS_SOURCE}?category=programming&sort=${encodeURIComponent(sort)}`;
    const response = await fetchImpl(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`OpenRouter ${sort} returned HTTP ${response.status}`);
    const body = await response.json();
    if (!Array.isArray(body.data)) throw new Error(`OpenRouter ${sort} returned no model list`);
    return body.data;
  } finally {
    clearTimeout(timer);
  }
}

export async function loadOpenRouterCatalog({
  bullswarmDir,
  cacheFile = bullswarmDir ? join(bullswarmDir, 'cache', 'openrouter-models.json') : null,
  fetchImpl = globalThis.fetch,
  force = false,
  now = Date.now(),
  ttlMs = DEFAULT_TTL_MS,
  timeoutMs = 8_000,
} = {}) {
  const cached = !force ? readCache(cacheFile, now, ttlMs) : null;
  if (cached) return cached;
  if (typeof fetchImpl !== 'function') return {
    schemaVersion: CACHE_SCHEMA, capturedAt: new Date(now).toISOString(), source: OPENROUTER_MODELS_SOURCE,
    rankingsSource: OPENROUTER_RANKINGS_SOURCE, models: {}, error: 'fetch is unavailable', cache: 'miss',
  };
  try {
    const entries = await Promise.all(Object.entries(SORTS).map(async ([dimension, sort]) => [
      dimension, await fetchRanking(fetchImpl, sort, timeoutMs),
    ]));
    const models = {};
    for (const [dimension, ranked] of entries) {
      ranked.forEach((model, index) => {
        const id = String(model.id ?? '').toLowerCase();
        if (!id) return;
        models[id] ??= {
          id,
          name: model.name ?? model.id,
          created: finite(model.created),
          pricing: pricing(model),
          pricingSource: OPENROUTER_MODELS_SOURCE,
          ranks: {},
        };
        models[id].ranks[dimension] = index + 1;
      });
    }
    const value = {
      schemaVersion: CACHE_SCHEMA,
      capturedAt: new Date(now).toISOString(),
      source: OPENROUTER_MODELS_SOURCE,
      rankingsSource: OPENROUTER_RANKINGS_SOURCE,
      rankingLicense: 'CC BY 4.0',
      models,
      error: null,
      cache: 'refreshed',
    };
    writeCache(cacheFile, value);
    return value;
  } catch (error) {
    const stale = readCache(cacheFile, now, Number.POSITIVE_INFINITY);
    if (stale) return { ...stale, cache: 'stale', error: error.message };
    return {
      schemaVersion: CACHE_SCHEMA, capturedAt: new Date(now).toISOString(), source: OPENROUTER_MODELS_SOURCE,
      rankingsSource: OPENROUTER_RANKINGS_SOURCE, models: {}, error: error.message, cache: 'miss',
    };
  }
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
