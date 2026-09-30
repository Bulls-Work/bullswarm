// A tier's price band.
//
// A connector opts in with `priceBand: true`. Each tier then stays within what
// it cost one generation back: among the newest generation's models whose
// dated API price is known, the tier takes the best-ranked one (inside a
// family, the newest version) that costs no more than the model that served
// the tier in the generation before, at the connector's normal reasoning for
// that tier. So a stronger family's new model moves down into a tier once a
// new generation made it that cheap, and a family whose new model costs more
// than the tier ever did stays out of it.
//
// Nothing is decided without prices: a tier with no priced model one
// generation back, or no priced newest-generation model inside the band that
// ranks at least as well as that model, keeps the family order (and
// generationFallback) exactly as before. Prices are the connector's dated
// `modelProfiles` rows, never guessed.

import { compareVersions, versionGeneration, versionLabelParts } from './model-family.js';

/** API price of a model as input + output USD per million tokens, or null. */
export function modelApiPrice(model) {
  const input = Number(model?.pricing?.inputUsdPerMillion);
  const output = Number(model?.pricing?.outputUsdPerMillion);
  const known = [input, output].filter((n) => model?.pricing && Number.isFinite(n));
  if (!model?.pricing || known.length === 0) return null;
  return (Number.isFinite(input) ? input : 0) + (Number.isFinite(output) ? output : 0);
}

function rankOf(model) {
  const n = Number(model?.qualityRank);
  return Number.isFinite(n) ? n : 0;
}

/** Best rank first, then the newest version, then the cheaper, then by id. */
function best(a, b) {
  return rankOf(b) - rankOf(a)
    || compareVersions(versionLabelParts(b.version), versionLabelParts(a.version))
    || modelApiPrice(a) - modelApiPrice(b)
    || String(a.id).localeCompare(String(b.id));
}

function money(value) {
  return `$${Number.isInteger(value) ? value : value.toFixed(2)}`;
}

/**
 * The model a tier takes inside its price band, or null.
 *
 * @param {object} connector  the pool's connector (`priceBand`, `reasoning.defaults`)
 * @param {Array<object>} listed  every model the pool reports, ranked
 *   (`tier`, `qualityRank`, `family`, `version`, `pricing`); the reference
 *   price is read from these, so a model the operator turned off still says
 *   what the tier used to cost
 * @param {Array<object>} eligible  the models the pool may recommend
 * @param {string} tier
 * @returns {null | { model: object, reference: object, price: number,
 *   band: number, generation: number, reasoning: string|null, reason: string }}
 */
export function priceBandPick(connector, listed, eligible, tier) {
  if (connector?.priceBand !== true) return null;
  const generationOf = (model) => (model?.family ? versionGeneration(model.version) : null);
  const inFamilies = (eligible ?? []).filter((model) => generationOf(model) != null);
  if (!inFamilies.length) return null;
  const generation = Math.max(...inFamilies.map(generationOf));
  const earlier = (listed ?? []).filter((model) => model?.tier === tier
    && generationOf(model) != null && generationOf(model) < generation
    && modelApiPrice(model) != null);
  if (!earlier.length) return null;
  const lastGeneration = Math.max(...earlier.map(generationOf));
  const reference = earlier.filter((model) => generationOf(model) === lastGeneration).sort(best)[0];
  const band = modelApiPrice(reference);
  const model = inFamilies
    .filter((candidate) => generationOf(candidate) === generation
      && modelApiPrice(candidate) != null && modelApiPrice(candidate) <= band
      && rankOf(candidate) >= rankOf(reference))
    .sort(best)[0];
  if (!model) return null;
  const price = modelApiPrice(model);
  const reasoning = connector?.reasoning?.defaults?.[tier];
  return {
    model,
    reference,
    price,
    band,
    generation,
    reasoning: typeof reasoning === 'string' ? reasoning : null,
    reason: `${model.id} costs no more than ${reference.id} did on ${tier} `
      + `(API ${money(price)} vs ${money(band)} per million tokens in + out)`,
  };
}
