import {
  existsSync, mkdirSync, readFileSync, renameSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// One strict numeric coercion for the whole codebase (src/lib/num.js). The
// local copy this replaces already rejected null and '', so behaviour here is
// unchanged; it differed only on booleans and arrays, which cell() — the CSV
// accessor every call goes through — cannot produce.
import { finiteOrNull as finite } from './num.js';

export const EPOCH_DATAPACK_SCHEMA = 'bullswarm.epoch.benchmarks.v1';
export const EPOCH_DATAPACK_URL = 'https://github.com/cowcow02/bullswarm/releases/download/benchmark-data-latest/epoch-benchmarks.json';
export const EPOCH_SOURCE_URL = 'https://epoch.ai/data/benchmark_data.zip';
export const EPOCH_LICENSE = 'CC BY 4.0';
export const EPOCH_CITATION = "Epoch AI, 'AI Benchmarking Hub'. Published online at epoch.ai. Retrieved from https://epoch.ai/benchmarks";
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const BUNDLED_DATAPACK = fileURLToPath(new URL('../../data/epoch-benchmarks.json', import.meta.url));
const EFFORT_CANON = {
  max: 'max',
  high: 'high',
  medium: 'medium',
  low: 'low',
  xhigh: 'xhigh',
  extrahigh: 'xhigh',
  extra: 'xhigh',
  minimal: 'minimal',
  min: 'minimal',
};
const EFFORT_SUFFIX = '(?:xhigh|minimal|medium|high|max|low|extra\\s*high)';
const BENCHMARKS = [
  {
    file: 'cursorbench_external.csv',
    name: 'cursorbench',
    score: ['Score'],
    cost: ['Cost per task'],
    tokens: ['Tokens per task'],
  },
  {
    file: 'deepswe_external.csv',
    name: 'deepswe',
    score: ['Pass@1', 'Score'],
    cost: ['Mean cost (USD)', 'Cost per task'],
    tokens: ['Mean output tokens', 'Tokens per task'],
  },
  {
    file: 'arc_agi_2_external.csv',
    name: 'arc-agi-2',
    score: ['Score'],
    cost: ['Cost per task'],
    tokens: [],
  },
  {
    file: 'critpt_external.csv',
    name: 'critpt',
    score: ['Accuracy', 'Score'],
    cost: ['Cost', 'Cost per task'],
    tokens: ['Tokens per task'],
  },
];
const BENCHMARK_NAMES = BENCHMARKS.map((item) => item.name);

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function emptyToNull(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

function compact(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[\s_\-]+/g, '');
}

export function canonicalizeReasoningLevel(value) {
  if (value == null) return null;
  const raw = String(value).trim().toLowerCase();
  if (!raw) return null;
  return EFFORT_CANON[compact(raw)] ?? EFFORT_CANON[raw] ?? null;
}

function cell(row, names) {
  const keys = Object.keys(row ?? {});
  for (const name of names) {
    if (row[name] != null && String(row[name]).trim() !== '') return row[name];
    const found = keys.find((key) => key.toLowerCase() === name.toLowerCase());
    if (found && row[found] != null && String(row[found]).trim() !== '') return row[found];
  }
  return null;
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => {
    pushField();
    if (row.length > 1 || row.some((value) => value !== '')) rows.push(row);
    row = [];
  };
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (inQuotes) {
      if (char === '"') {
        if (source[index + 1] === '"') { field += '"'; index += 1; continue; }
        inQuotes = false;
        continue;
      }
      field += char;
      continue;
    }
    if (char === '"') { inQuotes = true; continue; }
    if (char === ',') { pushField(); continue; }
    if (char === '\n') { pushRow(); continue; }
    if (char === '\r') {
      if (source[index + 1] === '\n') continue;
      pushRow();
      continue;
    }
    field += char;
  }
  if (field.length || row.length) pushRow();
  if (!rows.length) return [];
  const headers = rows[0].map((header) => String(header).trim());
  return rows.slice(1)
    .filter((values) => values.some((value) => String(value).trim() !== ''))
    .map((values) => {
      const record = {};
      for (let index = 0; index < headers.length; index++) {
        if (!headers[index]) continue;
        record[headers[index]] = values[index] ?? '';
      }
      return record;
    });
}

export function normalizeModelId(modelVersion) {
  let value = String(modelVersion ?? '').trim().toLowerCase();
  if (!value) return '';
  const slash = value.lastIndexOf('/');
  if (slash !== -1) value = value.slice(slash + 1);
  value = value.replace(new RegExp(`(?:[\\s._\\-/(]+|\\()${EFFORT_SUFFIX}\\)?\\s*$`, 'i'), '');
  value = value.replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return value;
}

function reasoningFromVersion(modelVersion) {
  const value = String(modelVersion ?? '');
  const paren = value.match(new RegExp(`\\(\\s*(${EFFORT_SUFFIX})\\s*\\)\\s*$`, 'i'));
  if (paren) return canonicalizeReasoningLevel(paren[1]);
  const suffix = value.match(new RegExp(`[\\s._\\-/(](${EFFORT_SUFFIX})\\s*$`, 'i'));
  return suffix ? canonicalizeReasoningLevel(suffix[1]) : null;
}

function reasoningLevel(row, modelVersion) {
  const explicit = cell(row, ['Reasoning level', 'Reasoning effort']);
  if (explicit != null) {
    const canonical = canonicalizeReasoningLevel(explicit);
    if (canonical) return canonical;
  }
  return reasoningFromVersion(modelVersion);
}

function wantedReasoning(reasoning) {
  if (reasoning == null || reasoning === '' || reasoning === 'default') return null;
  return canonicalizeReasoningLevel(reasoning) ?? String(reasoning).trim().toLowerCase();
}

export function validateEpochDatapack(value) {
  if (!object(value)) throw new Error('Epoch datapack must be an object');
  if (value.schemaVersion !== EPOCH_DATAPACK_SCHEMA) throw new Error('unsupported Epoch datapack schema');
  if (!Number.isFinite(Date.parse(value.capturedAt ?? ''))) throw new Error('Epoch datapack capturedAt is invalid');
  if (!object(value.source)) throw new Error('Epoch datapack source must be an object');
  if (!Array.isArray(value.records)) throw new Error('Epoch datapack records must be an array');
  for (const [index, record] of value.records.entries()) {
    if (!object(record)) throw new Error(`Epoch datapack record ${index} is invalid`);
    if (typeof record.modelVersion !== 'string' || !record.modelVersion.trim()) {
      throw new Error(`Epoch datapack record ${index} has an invalid modelVersion`);
    }
    if (typeof record.model !== 'string' || !record.model.trim()) {
      throw new Error(`Epoch datapack record ${index} has an invalid model`);
    }
    if (record.reasoningLevel != null && typeof record.reasoningLevel !== 'string') {
      throw new Error(`Epoch datapack record ${index} has an invalid reasoningLevel`);
    }
    if (!BENCHMARK_NAMES.includes(record.benchmark)) {
      throw new Error(`Epoch datapack record ${index} has an invalid benchmark`);
    }
    if (!Number.isFinite(Number(record.score))) {
      throw new Error(`Epoch datapack record ${index} has an invalid score`);
    }
    for (const field of ['costPerTask', 'tokensPerTask']) {
      if (record[field] != null && !Number.isFinite(Number(record[field]))) {
        throw new Error(`Epoch datapack record ${index} has an invalid ${field}`);
      }
    }
  }
  return value;
}

function loadMetadata(inputDir) {
  const file = join(inputDir, 'model_metadata.csv');
  const byVersion = new Map();
  if (!existsSync(file)) return byVersion;
  for (const row of parseCsv(readFileSync(file, 'utf8'))) {
    const modelVersion = emptyToNull(cell(row, ['model_version', 'Model version']));
    if (!modelVersion) continue;
    byVersion.set(modelVersion, {
      releaseDate: emptyToNull(cell(row, ['date', 'Release date'])),
      organization: emptyToNull(cell(row, ['organization', 'Organization'])),
    });
  }
  return byVersion;
}

function readCsv(inputDir, file, required) {
  const path = join(inputDir, file);
  if (!existsSync(path)) {
    if (required) throw new Error(`missing ${file} in ${inputDir}`);
    return [];
  }
  return parseCsv(readFileSync(path, 'utf8'));
}

export function buildEpochDatapack({ inputDir, capturedAt = new Date().toISOString() } = {}) {
  if (!inputDir) throw new Error('inputDir is required');
  const metadata = loadMetadata(inputDir);
  const records = [];
  for (const spec of BENCHMARKS) {
    for (const row of readCsv(inputDir, spec.file, true)) {
      const modelVersion = emptyToNull(cell(row, ['Model version', 'model_version']));
      if (!modelVersion) continue;
      const score = finite(cell(row, spec.score));
      if (score == null) continue;
      const model = normalizeModelId(modelVersion);
      if (!model) continue;
      const meta = metadata.get(modelVersion);
      records.push({
        modelVersion,
        model,
        reasoningLevel: reasoningLevel(row, modelVersion),
        benchmark: spec.name,
        score,
        costPerTask: finite(cell(row, spec.cost)),
        tokensPerTask: finite(cell(row, spec.tokens)),
        releaseDate: emptyToNull(cell(row, ['Release date', 'date'])) ?? meta?.releaseDate ?? null,
        organization: emptyToNull(cell(row, ['Organization', 'organization'])) ?? meta?.organization ?? null,
      });
    }
  }
  records.sort((a, b) => a.model.localeCompare(b.model)
    || String(a.reasoningLevel ?? '').localeCompare(String(b.reasoningLevel ?? ''))
    || a.benchmark.localeCompare(b.benchmark)
    || a.modelVersion.localeCompare(b.modelVersion));
  return validateEpochDatapack({
    schemaVersion: EPOCH_DATAPACK_SCHEMA,
    capturedAt,
    source: {
      url: EPOCH_SOURCE_URL,
      license: EPOCH_LICENSE,
      citation: EPOCH_CITATION,
    },
    records,
  });
}

export function rungEvidence(datapack, { model, reasoning } = {}) {
  const id = normalizeModelId(model);
  if (!id || !Array.isArray(datapack?.records)) return null;
  const level = wantedReasoning(reasoning);
  const matched = datapack.records.filter((record) => record.model === id && record.reasoningLevel === level);
  if (!matched.length) return null;
  const byBenchmark = {};
  for (const record of matched) {
    if (byBenchmark[record.benchmark] == null) byBenchmark[record.benchmark] = record;
  }
  const benchmarks = {};
  const sources = [];
  const scores = [];
  for (const name of BENCHMARK_NAMES) {
    const record = byBenchmark[name];
    if (!record || !Number.isFinite(Number(record.score))) continue;
    const score = Number(record.score);
    benchmarks[name] = score;
    scores.push(score);
    sources.push({ benchmark: name, modelVersion: record.modelVersion });
  }
  if (!scores.length) return null;
  const cursorbench = byBenchmark.cursorbench;
  return {
    blended: scores.reduce((sum, score) => sum + score, 0) / scores.length,
    costPerTask: cursorbench?.costPerTask ?? null,
    tokensPerTask: cursorbench?.tokensPerTask ?? null,
    benchmarks,
    sources,
  };
}

function readDatapack(file) {
  if (!file || !existsSync(file)) return null;
  try {
    return validateEpochDatapack(JSON.parse(readFileSync(file, 'utf8')));
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
    if (!response.ok) throw new Error(`Epoch benchmark datapack returned HTTP ${response.status}`);
    return validateEpochDatapack(await response.json());
  } finally {
    clearTimeout(timer);
  }
}

function miss(now, url, error) {
  return {
    schemaVersion: EPOCH_DATAPACK_SCHEMA,
    capturedAt: new Date(now).toISOString(),
    source: {
      url: EPOCH_SOURCE_URL,
      license: EPOCH_LICENSE,
      citation: EPOCH_CITATION,
    },
    records: [],
    cache: 'miss',
    loadedFrom: url,
    error,
  };
}

export async function loadEpochBenchmarks({
  bullswarmDir,
  cacheFile = bullswarmDir ? join(bullswarmDir, 'cache', 'epoch-benchmarks.json') : null,
  bundledFile = BUNDLED_DATAPACK,
  url = EPOCH_DATAPACK_URL,
  fetchImpl = globalThis.fetch,
  force = false,
  now = Date.now(),
  ttlMs = DEFAULT_TTL_MS,
  timeoutMs = 8_000,
} = {}) {
  const cached = readDatapack(cacheFile);
  const captured = Date.parse(cached?.capturedAt ?? '');
  if (!force && cached && Number.isFinite(captured) && now - captured <= ttlMs) {
    return { ...cached, cache: 'fresh', loadedFrom: url, error: null };
  }
  if (!force && !cached) {
    const bundled = readDatapack(bundledFile);
    if (bundled) return { ...bundled, cache: 'bundled', loadedFrom: bundledFile, error: null };
  }
  if (typeof fetchImpl === 'function') {
    try {
      const remote = await fetchDatapack(fetchImpl, url, timeoutMs);
      writeDatapack(cacheFile, remote);
      return { ...remote, cache: 'refreshed', loadedFrom: url, error: null };
    } catch (error) {
      if (cached) return { ...cached, cache: 'stale', loadedFrom: url, error: error.message };
      const bundled = readDatapack(bundledFile);
      if (bundled) return { ...bundled, cache: 'bundled', loadedFrom: bundledFile, error: error.message };
      return miss(now, url, error.message);
    }
  }
  const fallback = cached ?? readDatapack(bundledFile);
  return fallback
    ? {
      ...fallback,
      cache: cached ? 'stale' : 'bundled',
      loadedFrom: cached ? url : bundledFile,
      error: 'fetch is unavailable',
    }
    : miss(now, url, 'fetch is unavailable');
}
