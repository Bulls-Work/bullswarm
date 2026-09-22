import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  compareVersions, generationFallback, modelFamily, modelRanking, parseModelVersion, versionGeneration,
} from '../src/lib/model-family.js';
import { validateProvider } from '../src/provider-cli.js';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const connector = (name) => JSON.parse(readFileSync(join(REPO, 'src', 'providers', name, 'connector.json'), 'utf8'));

test('the version is read from every model id shape the built-in CLIs report', () => {
  const version = (id) => parseModelVersion(id)?.label ?? null;
  assert.equal(version('gpt-6-sol'), '6');
  assert.equal(version('gpt-5.6-sol'), '5.6');
  assert.equal(version('claude-opus-5-5'), '5.5');
  assert.equal(version('claude-haiku-4-5'), '4.5');
  assert.equal(version('claude-opus-5'), '5');
  // A context-window selector, a vendor prefix, and a date stamp are not the version.
  assert.equal(version('claude-opus-5-5[1m]'), '5.5');
  assert.equal(version('claude-fable-5-1[1m]'), '5.1');
  assert.equal(version('anthropic/claude-opus-5'), '5');
  assert.equal(version('claude-haiku-4-5-20251001'), '4.5');
  assert.equal(version('gpt-5.3-codex'), '5.3');
  assert.equal(version('deepseek-v4.1-flash'), '4.1');
  // A digit glued to letters is not a standalone version.
  assert.equal(version('gpt-4o'), null);
  assert.equal(version('no-digits-here'), null);
  assert.deepEqual(parseModelVersion('gpt-5.6-luna'), { parts: [5, 6], label: '5.6' });
});

test('versions compare numerically, not as text', () => {
  const parts = (id) => parseModelVersion(id).parts;
  assert.equal(compareVersions(parts('gpt-6-sol'), parts('gpt-5.6-sol')), 1);
  assert.equal(compareVersions(parts('claude-opus-5-5'), parts('claude-opus-5')), 1);
  assert.equal(compareVersions(parts('claude-haiku-4-5'), parts('claude-opus-5')), -1);
  // 5.10 is newer than 5.9 even though "5.10" < "5.9" as a string.
  assert.equal(compareVersions([5, 10], [5, 9]), 1);
  assert.equal(compareVersions([5], [5, 0]), 0);
  assert.equal(compareVersions(parts('claude-opus-5-5[1m]'), parts('claude-opus-5-5')), 0);
});

test('a family rule gives tier, base rank, and version; a named group can override the parser', () => {
  const fixture = {
    modelFamilies: [
      { family: 'pro', match: '^acme-(?<version>[0-9]+)x-pro$', tier: 'high', qualityRank: 4 },
      { family: 'lite', match: '-lite$', tier: 'low', qualityRank: 1, autoRecommend: false },
    ],
  };
  assert.deepEqual(modelFamily(fixture, 'acme-7x-pro'), {
    family: 'pro', tier: 'high', qualityRank: 4, autoRecommend: null, version: '7', versionParts: [7],
  });
  assert.equal(modelFamily(fixture, 'acme-2.1-lite').version, '2.1');
  assert.equal(modelFamily(fixture, 'acme-2.1-lite').autoRecommend, false);
  assert.equal(modelFamily(fixture, 'acme-2.1-other'), null);
  // A broken user-edited pattern is skipped, never thrown.
  assert.equal(modelFamily({ modelFamilies: [{ family: 'x', match: '(' }] }, 'x-1'), null);
});

test('the Codex and Claude families classify every shipped model and keep the old order', () => {
  const codex = connector('codex');
  const rank = (id) => {
    const r = modelRanking(codex, id);
    return [r.tier, r.qualityRank, r.family, r.version];
  };
  assert.deepEqual(rank('gpt-6-astra'), ['high', 7, 'astra', '6']);
  assert.deepEqual(rank('gpt-6-sol'), ['high', 6, 'sol', '6']);
  assert.deepEqual(rank('gpt-5.6-sol'), ['high', 6, 'sol', '5.6']);
  assert.deepEqual(rank('gpt-5.5'), ['high', 5, 'gpt', '5.5']);
  assert.deepEqual(rank('gpt-5.4'), ['high', 5, 'gpt', '5.4']);
  assert.deepEqual(rank('gpt-5.6-terra'), ['medium', 4, 'terra', '5.6']);
  assert.deepEqual(rank('gpt-6-luna'), ['low', 3, 'luna', '6']);
  assert.deepEqual(rank('gpt-5.4-mini'), ['low', 2, 'mini', '5.4']);
  // No family: the exact row still classifies it.
  assert.deepEqual(rank('gpt-5.3-codex'), ['medium', 4, null, null]);

  const claude = connector('claude-code');
  const claudeRank = (id) => {
    const r = modelRanking(claude, id);
    return [r.tier, r.qualityRank, r.family, r.version, r.autoRecommend];
  };
  assert.deepEqual(claudeRank('claude-opus-5-5'), ['high', 5, 'opus', '5.5', true]);
  assert.deepEqual(claudeRank('claude-opus-5-5[1m]'), ['high', 5, 'opus', '5.5', true]);
  assert.deepEqual(claudeRank('claude-opus-5'), ['high', 5, 'opus', '5', true]);
  assert.deepEqual(claudeRank('claude-sonnet-5'), ['medium', 4, 'sonnet', '5', true]);
  assert.deepEqual(claudeRank('claude-haiku-4-5'), ['low', 3, 'haiku', '4.5', true]);
  // Fable stays opted out of automatic recommendations, every version of it.
  assert.deepEqual(claudeRank('claude-fable-5-1[1m]'), ['high', 6, 'fable', '5.1', false]);
  assert.deepEqual(claudeRank('claude-fable-5'), ['high', 6, 'fable', '5', false]);
});

test('an exact row overrides one family field and keeps its own price; a family carries none', () => {
  const fixture = {
    modelFamilies: [{ family: 'sol', match: '-sol$', tier: 'high', qualityRank: 6 }],
    modelProfiles: [
      { match: '^gpt-5\\.6-sol$', qualityRank: 9, pricing: { inputUsdPerMillion: 4, outputUsdPerMillion: 20 } },
      { match: '^gpt-6-sol$', autoRecommend: false },
    ],
  };
  const older = modelRanking(fixture, 'gpt-5.6-sol');
  assert.equal(older.qualityRank, 9);
  assert.equal(older.tier, 'high');
  assert.equal(older.rankSource, 'profile+family');
  assert.equal(older.profile.pricing.inputUsdPerMillion, 4);
  const newer = modelRanking(fixture, 'gpt-6-sol');
  assert.equal(newer.autoRecommend, false);
  assert.equal(newer.qualityRank, 6);
  assert.equal(newer.rankSource, 'family');
  assert.equal(modelRanking(fixture, 'gpt-7-sol').profile, null, 'a new version gets no price');
  assert.equal(modelRanking(fixture, 'gpt-7-nova').ranking, 'unranked');
  assert.equal(modelRanking(fixture, 'gpt-7-nova').tier, null);
});

test('real prices: Opus 5.5 and Fable 5.1 carry their own rate-card lines, and new models none', () => {
  const claude = connector('claude-code');
  const price = (id) => modelRanking(claude, id).profile?.pricing ?? null;
  // platform.claude.com/docs/en/about-claude/pricing, read 2026-09-23.
  assert.deepEqual(price('claude-opus-5-5[1m]'), {
    inputUsdPerMillion: 4, cacheReadUsdPerMillion: 0.2, cacheWrite5mUsdPerMillion: 5,
    cacheWrite1hUsdPerMillion: 8, outputUsdPerMillion: 20,
  });
  assert.equal(price('claude-opus-5').inputUsdPerMillion, 5);
  assert.equal(price('claude-fable-5-1[1m]').cacheReadUsdPerMillion, 0.25);
  assert.equal(price('claude-fable-5').cacheReadUsdPerMillion, 1);
  assert.equal(price('claude-opus-5-6'), null);
  const codex = connector('codex');
  for (const id of ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna']) {
    assert.equal(modelRanking(codex, id).profile, null, `${id} has no public rate card in the connector`);
  }
});

test('provider validate accepts family rules and refuses a price or benchmark on one', () => {
  const home = mkdtempSync(join(tmpdir(), 'bullswarm-model-family-'));
  try {
    mkdirSync(join(home, 'providers'), { recursive: true });
    mkdirSync(join(home, 'connectors'), { recursive: true });
    const dir = join(home, 'providers', 'acme');
    mkdirSync(dir);
    const pool = (modelFamilies) => ({
      name: 'acme',
      spawn: { cmd: ['acme', 'run', '{taskFile}'] },
      outputExtraction: { strategy: 'stdout' },
      model: 'acme-2-pro',
      modelFamilies,
    });
    const loader = {
      dirs: {
        firstClass: join(REPO, 'src', 'providers'),
        contrib: join(REPO, 'providers', 'contrib'),
        local: join(home, 'providers'),
        legacy: join(home, 'connectors'),
      },
    };
    writeFileSync(join(dir, 'connector.json'), JSON.stringify(pool([
      { family: 'pro', match: '-pro$', tier: 'high', qualityRank: 3 },
    ])));
    const ok = validateProvider(home, dir, loader);
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.deepEqual(ok.pools[0].warnings.filter((w) => w.startsWith('modelFamilies')), []);

    writeFileSync(join(dir, 'connector.json'), JSON.stringify(pool([
      { family: 'pro', match: '-pro$', tier: 'high', pricing: { inputUsdPerMillion: 1 } },
      { family: 'lite', match: '(', tier: 'tiny', benchmark: { score: 1 } },
    ])));
    const bad = validateProvider(home, dir, loader);
    assert.equal(bad.ok, false);
    const errors = bad.pools[0].errors.join('\n');
    assert.match(errors, /modelFamilies\[0\]\.pricing: belongs on an exact modelProfiles row/);
    assert.match(errors, /modelFamilies\[1\]\.match:/);
    assert.match(errors, /modelFamilies\[1\]\.tier: must be high, medium, low/);
    assert.match(errors, /modelFamilies\[1\]\.benchmark: belongs on an exact modelProfiles row/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// --- generations ---------------------------------------------------------------

test('a generation is the leading version number', () => {
  assert.equal(versionGeneration('6'), 6);
  assert.equal(versionGeneration('5.6'), 5);
  assert.equal(versionGeneration('5.5'), 5);
  assert.equal(versionGeneration('4.5'), 4);
  assert.equal(versionGeneration(null), null);
});

test('the generation fallback is generic: stale serving family -> next-lower family in the newest generation', () => {
  const connector = {
    generationFallback: { label: 'm-{generation}', tiers: { medium: { reasoning: 'xhigh' } } },
    modelFamilies: [
      { family: 'top', match: '-top$', tier: 'high', qualityRank: 9 },
      { family: 'mid', match: '-mid$', tier: 'medium', qualityRank: 5 },
      { family: 'small', match: '-small$', tier: 'low', qualityRank: 3 },
      { family: 'tiny', match: '-tiny$', tier: 'low', qualityRank: 1 },
    ],
  };
  const model = (id) => ({ id, ...modelRanking(connector, id) });
  const fallback = (ids, tier = 'medium', c = connector) => generationFallback(c, ids.map(model), tier);
  const found = fallback(['m-3-top', 'm-2.9-mid', 'm-3-small', 'm-2-small', 'm-3-tiny']);
  assert.equal(found.model.id, 'm-3-small', 'the next-lower family, not the lowest one');
  assert.deepEqual(
    [found.family, found.generation, found.staleFamily, found.staleVersion, found.staleRank, found.reasoning, found.reason],
    ['small', 3, 'mid', '2.9', 5, 'xhigh', 'no m-3 mid yet, newest generation preferred'],
  );
  // A current serving family: no fallback.
  assert.equal(fallback(['m-3-top', 'm-3.1-mid', 'm-3-small']), null);
  // A serving family with no model at all is stale as well.
  assert.equal(fallback(['m-3-top', 'm-3-small']).model.id, 'm-3-small');
  // No lower family in the newest generation: no fallback, never a higher family.
  assert.equal(fallback(['m-3-top', 'm-2-mid', 'm-2-small']), null);
  // A tier the connector does not opt in never falls back.
  assert.equal(fallback(['m-3-top', 'm-2-small', 'm-3-tiny'], 'low'), null);
  // No label: the generation is named by number.
  const unlabeled = { ...connector, generationFallback: { tiers: { medium: { reasoning: 'max' } } } };
  assert.equal(fallback(['m-3-top', 'm-3-small'], 'medium', unlabeled).reason, 'no generation 3 mid yet, newest generation preferred');
});

test('provider validate checks generationFallback', () => {
  const home = mkdtempSync(join(tmpdir(), 'bullswarm-generation-'));
  try {
    mkdirSync(join(home, 'connectors'), { recursive: true });
    const dir = join(home, 'providers', 'acme');
    mkdirSync(dir, { recursive: true });
    const loader = {
      dirs: {
        firstClass: join(REPO, 'src', 'providers'),
        contrib: join(REPO, 'providers', 'contrib'),
        local: join(home, 'providers'),
        legacy: join(home, 'connectors'),
      },
    };
    const pool = (extra) => ({
      name: 'acme',
      spawn: { cmd: ['acme', 'run', '{taskFile}'] },
      outputExtraction: { strategy: 'stdout' },
      model: 'acme-2-pro',
      ...extra,
    });
    const families = [{ family: 'pro', match: '-pro$', tier: 'medium', qualityRank: 3 }];
    writeFileSync(join(dir, 'connector.json'), JSON.stringify(pool({
      modelFamilies: families, generationFallback: { label: 'acme-{generation}', tiers: { medium: { reasoning: 'max' } } },
    })));
    const ok = validateProvider(home, dir, loader);
    assert.equal(ok.ok, true, JSON.stringify(ok));
    writeFileSync(join(dir, 'connector.json'), JSON.stringify(pool({
      generationFallback: { label: 'acme', tiers: { huge: { reasoning: 'ultra' } } },
    })));
    const errors = validateProvider(home, dir, loader).pools[0].errors.join('\n');
    assert.match(errors, /generationFallback\.label: must be a string containing \{generation\}/);
    assert.match(errors, /generationFallback\.tiers\.huge: unknown tier/);
    assert.match(errors, /generationFallback\.tiers\.huge\.reasoning: must be low, medium, high, xhigh, max/);
    assert.match(errors, /generationFallback: needs modelFamilies/);
    // The packaged connectors that declare it pass.
    for (const name of ['codex', 'claude-code']) {
      const report = validateProvider(home, join(REPO, 'src', 'providers', name), loader);
      assert.deepEqual(report.pools.flatMap((p) => p.errors), [], name);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
