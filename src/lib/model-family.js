// Model families and versions.
//
// A connector may declare `modelFamilies[]`: a name pattern with the tier and
// base quality rank every member of that family gets, so a model the CLI
// starts listing tomorrow is ranked without a new per-model row. Which names
// form a family is provider knowledge and stays in the connector; core only
// understands the generic rule: match the id, read its version, and within one
// family a higher version is the better model.
//
// Exact `modelProfiles[]` rows keep their meaning. They carry the facts a
// family never may (pricing, a dated benchmark, `free`) and may still override
// a family's tier, rank, or `autoRecommend` for one model.

import { modelProfile } from './usage.js';

// Trailing `[...]` selectors (a context-window variant such as `[1m]`) choose
// how a model runs, not which model it is.
function withoutSelectors(id) {
  return String(id ?? '').trim().replace(/(?:\[[^\]]*\])+$/, '');
}

// A component of six or more digits is a date stamp (`-20251001`), not a
// version number; it and anything after it are dropped.
function versionParts(text) {
  const parts = [];
  for (const piece of String(text ?? '').split(/[.-]/)) {
    if (!/^\d+$/.test(piece) || piece.length >= 6) break;
    parts.push(Number(piece));
  }
  return parts.length ? parts : null;
}

function versionOf(parts) {
  return parts ? { parts, label: parts.join('.') } : null;
}

/**
 * The version inside a model id, or null when it has none.
 *
 * The first digit run that stands on its own is the version; `.` and `-` both
 * separate its components, so `gpt-5.6-sol` and `claude-opus-5-5` read as 5.6
 * and 5.5. A vendor prefix, a trailing `[1m]`-style selector, and a date-stamp
 * suffix are ignored.
 *
 * @param {string} id
 * @returns {{ parts: number[], label: string } | null}
 */
export function parseModelVersion(id) {
  const base = withoutSelectors(id).split('/').at(-1);
  const match = base.match(/(?:^|[^a-z0-9.])v?(\d+(?:[.-]\d+)*)(?![a-z0-9])/i);
  return match ? versionOf(versionParts(match[1])) : null;
}

/** Numeric comparison of two version part lists; missing components are 0. */
export function compareVersions(a, b) {
  const left = a ?? [];
  const right = b ?? [];
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/** The part list of a stored version label (`'5.6'` -> `[5, 6]`), or null. */
export function versionLabelParts(label) {
  return typeof label === 'string' && label ? versionParts(label) : null;
}

function finiteRank(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * The first family rule of `connector.modelFamilies` whose `match` regex hits
 * the id (selectors stripped), with the version read from it. A named capture
 * group `version` in the pattern takes precedence over the generic parser, for
 * an id shape the parser cannot read.
 *
 * @returns {null | {
 *   family: string, tier: string|null, qualityRank: number|null,
 *   autoRecommend: boolean|null, version: string|null, versionParts: number[]|null,
 * }}
 */
export function modelFamily(connector, model) {
  const id = withoutSelectors(model);
  if (!id) return null;
  for (const rule of connector?.modelFamilies ?? []) {
    if (!rule || typeof rule.match !== 'string' || typeof rule.family !== 'string') continue;
    let match = null;
    try {
      match = new RegExp(rule.match, 'i').exec(id);
    } catch { /* an invalid user-edited rule is ignored, like a profile */ }
    if (!match) continue;
    const version = match.groups?.version != null
      ? versionOf(versionParts(match.groups.version))
      : parseModelVersion(id);
    return {
      family: rule.family,
      tier: typeof rule.tier === 'string' ? rule.tier : null,
      qualityRank: finiteRank(rule.qualityRank),
      autoRecommend: typeof rule.autoRecommend === 'boolean' ? rule.autoRecommend : null,
      version: version?.label ?? null,
      versionParts: version?.parts ?? null,
    };
  }
  return null;
}

// --- generations ---------------------------------------------------------------
// A generation is the leading component of a version: gpt-6-luna and
// gpt-6-sol are generation 6, gpt-5.6-terra and gpt-5.5 are generation 5, and
// claude-opus-5-5 and claude-sonnet-5 are both generation 5. So a point
// release of one family (Opus 5.5) never makes another family of the same
// generation (Sonnet 5) look stale; only a new leading number does. A tier
// with no family at all is the stalest case: it takes the newest generation's
// best family.

/** The generation of a stored version label (`'5.6'` -> 5), or null. */
export function versionGeneration(label) {
  const parts = versionLabelParts(label);
  return parts ? parts[0] : null;
}

/**
 * The connector's family rules with a usable name, tier and rank, first rule
 * per family name, in declaration order.
 */
function familyRules(connector) {
  const seen = new Set();
  const rules = [];
  for (const rule of connector?.modelFamilies ?? []) {
    if (!rule || typeof rule.family !== 'string' || !rule.family || seen.has(rule.family)) continue;
    seen.add(rule.family);
    rules.push({ family: rule.family, tier: rule.tier ?? null, rank: finiteRank(rule.qualityRank) ?? 0 });
  }
  return rules;
}

/** Best rank first; a tie keeps the connector's declaration order. */
function byRank(rules) {
  return rules.map((rule, index) => ({ rule, index }))
    .sort((a, b) => b.rule.rank - a.rule.rank || a.index - b.index)
    .map(({ rule }) => rule);
}

function generationLabel(connector, generation) {
  const template = connector?.generationFallback?.label;
  return typeof template === 'string' && template.includes('{generation}')
    ? template.replaceAll('{generation}', String(generation))
    : `generation ${generation}`;
}

/**
 * The newest-generation stand-in for one tier of one pool, or null.
 *
 * A connector opts a tier in with `generationFallback.tiers[tier]`. The rule
 * is generic:
 *   - the pool's newest generation is the highest leading version among the
 *     models it may recommend (discovered, ranked, not opted out, not
 *     disabled) that belong to a family;
 *   - the tier's serving family is its best-ranked declared family; it is
 *     stale when none of its members is in the newest generation;
 *   - then the tier takes the newest member of the next-lower-ranked family
 *     that has one in the newest generation, to run at the connector's
 *     declared reasoning. With no such family, there is no fallback;
 *   - a tier that no family serves, and no model of the pool is ranked for
 *     (a provider with one model line), takes the newest member of the
 *     best-ranked family that has one in the newest generation. It has no
 *     rank of its own on that tier, so `staleRank` is 0;
 *   - a tier's declared `why` replaces the generated reason.
 *
 * @param {object} connector  the pool's connector (modelFamilies, generationFallback)
 * @param {Array<object>} models  the pool's recommendable models, each with
 *   `id`, `tier`, `family`, `version`, and optionally `reasoningLevels`
 * @param {string} tier
 * @returns {null | {
 *   model: object, family: string, generation: number, staleFamily: string|null,
 *   staleVersion: string|null, staleRank: number, reasoning: string|null,
 *   reason: string,
 * }}
 */
export function generationFallback(connector, models, tier) {
  const setting = connector?.generationFallback?.tiers?.[tier];
  if (!setting || typeof setting !== 'object') return null;
  const members = (models ?? [])
    .filter((model) => model?.family && versionGeneration(model.version) != null);
  if (!members.length) return null;
  const generation = Math.max(...members.map((model) => versionGeneration(model.version)));
  const rules = byRank(familyRules(connector));
  const serving = rules.find((rule) => rule.tier === tier) ?? null;
  // An exact row may rank a model for a tier no family serves; that model
  // serves the tier, and nothing stands in for it.
  if (!serving && (models ?? []).some((model) => model?.tier === tier)) return null;
  const newestOf = (family) => members
    .filter((model) => model.family === family)
    .sort((a, b) => compareVersions(versionLabelParts(b.version), versionLabelParts(a.version))
      || String(a.id).localeCompare(String(b.id)))[0] ?? null;
  const current = serving ? newestOf(serving.family) : null;
  if (current && versionGeneration(current.version) === generation) return null;
  const why = typeof setting.why === 'string' && setting.why.trim() ? setting.why.trim() : null;
  for (const rule of rules) {
    if (serving && (rule.rank >= serving.rank || rule.family === serving.family)) continue;
    const candidate = newestOf(rule.family);
    if (!candidate || versionGeneration(candidate.version) !== generation) continue;
    return {
      model: candidate,
      family: rule.family,
      generation,
      staleFamily: serving?.family ?? null,
      staleVersion: current?.version ?? null,
      staleRank: serving?.rank ?? 0,
      reasoning: typeof setting.reasoning === 'string' ? setting.reasoning : null,
      reason: why ?? (serving
        ? `no ${generationLabel(connector, generation)} ${serving.family} yet, newest generation preferred`
        : `no ${tier} family, newest ${rule.family} preferred`),
    };
  }
  return null;
}

/**
 * Tier, quality rank, recommendation guard, family, and version for one model:
 * the family rule first, an exact `modelProfiles` row on top of it.
 *
 * `ranking` is `unranked` when neither gives the model a tier — a model the
 * CLI reported that no rule classifies yet. It stays listed, never suggested.
 */
export function modelRanking(connector, model) {
  const profile = modelProfile(connector, model);
  const family = modelFamily(connector, model);
  const tier = profile?.tier ?? family?.tier ?? null;
  const qualityRank = finiteRank(profile?.qualityRank) ?? family?.qualityRank ?? null;
  const autoRecommend = typeof profile?.autoRecommend === 'boolean'
    ? profile.autoRecommend
    : family?.autoRecommend !== false;
  const rankSource = profile?.tier != null || finiteRank(profile?.qualityRank) != null
    ? (family ? 'profile+family' : 'profile')
    : family ? 'family' : null;
  return {
    tier,
    qualityRank,
    autoRecommend,
    family: family?.family ?? null,
    version: family?.version ?? null,
    rankSource,
    ranking: tier ? 'ranked' : 'unranked',
    profile,
  };
}
