import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildEpochDatapack, loadEpochBenchmarks, normalizeModelId, parseCsv,
  rungEvidence, validateEpochDatapack, EPOCH_DATAPACK_SCHEMA, EPOCH_CITATION,
} from '../src/lib/epoch-benchmarks.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'bullswarm-epoch-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function writeCsvs(dir, files) {
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
}

function headers() {
  return {
    'cursorbench_external.csv': 'Model version,Score,Reasoning level,Cost per task,Tokens per task,Release date,Organization\n',
    'deepswe_external.csv': 'Model version,Pass@1,Reasoning effort,Mean cost (USD),Mean output tokens,Release date,Organization\n',
    'arc_agi_2_external.csv': 'Model version,Score,Release date,Organization,Cost per task\n',
    'critpt_external.csv': 'Model version,Accuracy,Release date,Organization,Cost\n',
    'model_metadata.csv': 'model_version,model_group,date,display_name,organization\n',
  };
}

function sampleDir() {
  const f = fixture();
  writeCsvs(f.dir, {
    ...headers(),
    'cursorbench_external.csv': `${headers()['cursorbench_external.csv']}`
      + 'org/gpt-5.6-luna_max,0.611,Max,0.39,87973,2026-07-09,OpenAI\n'
      + '"quoted, model_high",0.50,High,1.25,1000,2026-01-01,"Acme, Inc."\n'
      + 'kimi-k2.6,0.476,,0.87,9446,2026-01-27,Moonshot\n',
    'deepswe_external.csv': `${headers()['deepswe_external.csv']}`
      + 'gpt-5.6-luna_max,0.671875,max,3.02,73399,2026-07-09,OpenAI\n',
    'arc_agi_2_external.csv': `${headers()['arc_agi_2_external.csv']}`
      + 'gpt-5.6-luna (max),0.5954,2026-07-09,OpenAI,0.67\n'
      + 'plain-model,0.12,2025-01-01,Acme,\n',
    'critpt_external.csv': `${headers()['critpt_external.csv']}`
      + 'gpt-5.6-luna_max,0.206,2026-07-09,OpenAI,\n',
    'model_metadata.csv': `${headers()['model_metadata.csv']}`
      + 'plain-model,Plain,2025-02-02,Plain Model,Meta AI\n',
  });
  return f;
}

function datapackFrom(records, capturedAt = '2026-09-09T00:00:00.000Z') {
  return validateEpochDatapack({
    schemaVersion: EPOCH_DATAPACK_SCHEMA,
    capturedAt,
    source: {
      url: 'https://epoch.ai/data/benchmark_data.zip',
      license: 'CC BY 4.0',
      citation: EPOCH_CITATION,
    },
    records,
  });
}

function record(overrides = {}) {
  return {
    modelVersion: 'gpt-5.6-luna_max',
    model: 'gpt-5.6-luna',
    reasoningLevel: 'max',
    benchmark: 'cursorbench',
    score: 0.6,
    costPerTask: 0.39,
    tokensPerTask: 100,
    releaseDate: '2026-07-09',
    organization: 'OpenAI',
    ...overrides,
  };
}

function response(value) {
  return { ok: true, status: 200, json: async () => value };
}

test('CSV parser keeps quoted commas and buildEpochDatapack maps levels from columns, suffixes, and blanks', () => {
  const parsed = parseCsv('a,b\n"x, y",1\n');
  assert.deepEqual(parsed, [{ a: 'x, y', b: '1' }]);

  const f = sampleDir();
  try {
    const pack = buildEpochDatapack({ inputDir: f.dir, capturedAt: '2026-09-09T00:00:00Z' });
    assert.equal(pack.schemaVersion, EPOCH_DATAPACK_SCHEMA);
    assert.equal(pack.source.license, 'CC BY 4.0');
    assert.equal(pack.source.citation, EPOCH_CITATION);

    const lunaMax = pack.records.filter((row) => row.model === 'gpt-5.6-luna' && row.reasoningLevel === 'max');
    assert.equal(lunaMax.length, 4);
    assert.equal(lunaMax.find((row) => row.benchmark === 'cursorbench').score, 0.611);
    assert.equal(lunaMax.find((row) => row.benchmark === 'deepswe').score, 0.671875);
    assert.equal(lunaMax.find((row) => row.benchmark === 'arc-agi-2').score, 0.5954);
    assert.equal(lunaMax.find((row) => row.benchmark === 'critpt').score, 0.206);

    const quoted = pack.records.find((row) => row.organization === 'Acme, Inc.');
    assert.equal(quoted.modelVersion, 'quoted, model_high');
    assert.equal(quoted.model, 'quoted,-model');
    assert.equal(quoted.reasoningLevel, 'high');

    const suffix = pack.records.find((row) => row.modelVersion === 'gpt-5.6-luna (max)');
    assert.equal(suffix.reasoningLevel, 'max');
    assert.equal(suffix.model, 'gpt-5.6-luna');

    const none = pack.records.find((row) => row.modelVersion === 'kimi-k2.6');
    assert.equal(none.reasoningLevel, null);
    assert.equal(none.model, 'kimi-k2.6');

    const meta = pack.records.find((row) => row.modelVersion === 'plain-model');
    assert.equal(meta.reasoningLevel, null);
    assert.equal(meta.organization, 'Acme');
    assert.equal(meta.releaseDate, '2025-01-01');
  } finally { f.cleanup(); }
});

test('normalizeModelId drops provider prefixes, effort suffixes, and collapses whitespace', () => {
  assert.equal(normalizeModelId('relay/gpt-5.6-luna'), 'gpt-5.6-luna');
  assert.equal(normalizeModelId('claude-opus-5_high'), 'claude-opus-5');
  assert.equal(normalizeModelId('GPT-5.6 Luna (max)'), 'gpt-5.6-luna');
  assert.equal(normalizeModelId('Composer 2.5'), 'composer-2.5');
  assert.equal(normalizeModelId('grok-4.6_medium'), 'grok-4.6');
  assert.equal(normalizeModelId('accounts/fireworks/models/glm-4p6'), 'glm-4p6');
});

test('validator rejects the wrong schema and malformed records', () => {
  assert.throws(() => validateEpochDatapack(null), /must be an object/);
  assert.throws(() => validateEpochDatapack({ schemaVersion: 'nope', capturedAt: '2026-09-09T00:00:00Z', source: {}, records: [] }), /schema/);
  assert.throws(() => validateEpochDatapack({
    schemaVersion: EPOCH_DATAPACK_SCHEMA, capturedAt: 'not-a-date', source: {}, records: [],
  }), /capturedAt/);
  assert.throws(() => validateEpochDatapack({
    schemaVersion: EPOCH_DATAPACK_SCHEMA, capturedAt: '2026-09-09T00:00:00Z', source: {}, records: 'nope',
  }), /records/);
  assert.throws(() => datapackFrom([record({ score: 'hot' })]), /score/);
  assert.throws(() => datapackFrom([record({ benchmark: 'mmlu' })]), /benchmark/);
});

test('rungEvidence blends the present scores and takes cost from cursorbench', () => {
  const pack = datapackFrom([
    record({ benchmark: 'cursorbench', score: 0.6, costPerTask: 1.28, tokensPerTask: 17942 }),
    record({ benchmark: 'deepswe', score: 0.4, costPerTask: 9, tokensPerTask: 99 }),
    record({
      modelVersion: 'other_max', model: 'other', benchmark: 'cursorbench', score: 0.9,
    }),
  ]);
  const evidence = rungEvidence(pack, { model: 'relay/gpt-5.6-luna', reasoning: 'max' });
  assert.equal(evidence.blended, 0.5);
  assert.equal(evidence.costPerTask, 1.28);
  assert.equal(evidence.tokensPerTask, 17942);
  assert.deepEqual(evidence.benchmarks, { cursorbench: 0.6, deepswe: 0.4 });
  assert.equal(rungEvidence(pack, { model: 'gpt-5.6-luna', reasoning: 'high' }), null);
  assert.equal(rungEvidence(pack, { model: 'gpt-5.6-luna', reasoning: 'default' }), null);
  assert.equal(rungEvidence(pack, { model: 'kimi-k2.6', reasoning: null }), null);

  const unlabeled = datapackFrom([record({
    modelVersion: 'kimi-k2.6', model: 'kimi-k2.6', reasoningLevel: null, score: 0.476,
    costPerTask: 0.87, tokensPerTask: 10,
  })]);
  const fallback = rungEvidence(unlabeled, { model: 'kimi-k2.6', reasoning: 'default' });
  assert.equal(fallback.blended, 0.476);
  assert.equal(fallback.costPerTask, 0.87);
});

test('loader order is cache, then bundled, then url; fetch is not called when a bundled file exists', async () => {
  const f = fixture();
  const pack = datapackFrom([record()]);
  const bundledFile = join(f.dir, 'bundled.json');
  writeFileSync(bundledFile, `${JSON.stringify(pack, null, 2)}\n`);
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error('network should not run'); };
  try {
    const bundled = await loadEpochBenchmarks({
      cacheFile: join(f.dir, 'cache', 'epoch-benchmarks.json'),
      bundledFile,
      fetchImpl,
    });
    assert.equal(calls, 0);
    assert.equal(bundled.cache, 'bundled');
    assert.equal(bundled.records[0].model, 'gpt-5.6-luna');
    assert.equal(bundled.source.license, 'CC BY 4.0');

    mkdirSync(join(f.dir, 'cache'), { recursive: true });
    const cachedPack = datapackFrom([record({ model: 'from-cache' })], '2026-09-09T00:00:00.000Z');
    writeFileSync(join(f.dir, 'cache', 'epoch-benchmarks.json'), `${JSON.stringify(cachedPack, null, 2)}\n`);
    const cached = await loadEpochBenchmarks({
      bullswarmDir: f.dir,
      bundledFile,
      fetchImpl,
      now: Date.parse('2026-09-09T01:00:00Z'),
    });
    assert.equal(calls, 0);
    assert.equal(cached.cache, 'fresh');
    assert.equal(cached.records[0].model, 'from-cache');

    const remotePack = datapackFrom([record({ model: 'from-url' })]);
    const remote = await loadEpochBenchmarks({
      cacheFile: join(f.dir, 'missing-cache.json'),
      bundledFile: join(f.dir, 'missing-bundled.json'),
      fetchImpl: async () => { calls += 1; return response(remotePack); },
    });
    assert.equal(calls, 1);
    assert.equal(remote.cache, 'refreshed');
    assert.equal(remote.records[0].model, 'from-url');
    assert.equal(JSON.parse(readFileSync(join(f.dir, 'missing-cache.json'), 'utf8')).records[0].model, 'from-url');
  } finally { f.cleanup(); }
});

test('offline fetch failure never throws when a bundled datapack exists', async () => {
  const f = fixture();
  const pack = datapackFrom([record({ model: 'bundled-model' })]);
  const bundledFile = join(f.dir, 'bundled.json');
  writeFileSync(bundledFile, `${JSON.stringify(pack, null, 2)}\n`);
  try {
    const catalog = await loadEpochBenchmarks({
      cacheFile: join(f.dir, 'cache.json'),
      bundledFile,
      fetchImpl: async () => { throw new Error('offline'); },
      force: true,
    });
    assert.equal(catalog.cache, 'bundled');
    assert.equal(catalog.error, 'offline');
    assert.equal(catalog.records[0].model, 'bundled-model');
  } finally { f.cleanup(); }
});
