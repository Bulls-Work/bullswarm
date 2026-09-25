// The run's features.json marker (stage-1 D16, stage-2 E23). A launch writes
// every earlier stage's key plus its own; no stage drops or reinterprets a
// key, and existing files are never rewritten. Readers test their own key
// (`features.proofLabels === 1`), so this file fills no defaults.
//
// Imported by the runtime, watch, runs and outcome code; it depends only on
// fsjson so it stays out of import cycles.

import { join } from 'node:path';
import { readJsonSafe, writeJsonAtomic } from '../lib/fsjson.js';

export const RUN_FEATURES_FILE = 'features.json';

// What a stage-2 launch writes (E23).
export const STAGE2_RUN_FEATURES = Object.freeze({ deliverableGate: 1, proofLabels: 1 });

// What a stage-3 launch writes (D28): stage 2's keys plus the failure rule and
// caller-placed reviews. A missing key means the older rule.
export const STAGE3_RUN_FEATURES = Object.freeze({
  deliverableGate: 1, proofLabels: 1, failureRule: 1, reviewPlacement: 'caller',
});

/**
 * The marker as flags, for code that branches on it. Pure. A key counts only
 * with its exact stored value; unknown keys are ignored.
 * @returns {{deliverableGate: boolean, proofLabels: boolean, failureRule: boolean,
 *   reviewPlacement: 'caller'|'automatic'}}
 */
export function runFeatureFlags(features) {
  const raw = features !== null && typeof features === 'object' && !Array.isArray(features) ? features : {};
  return {
    deliverableGate: raw.deliverableGate === 1,
    proofLabels: raw.proofLabels === 1,
    failureRule: raw.failureRule === 1,
    reviewPlacement: raw.reviewPlacement === 'caller' ? 'caller' : 'automatic',
  };
}

export function runFeaturesPath(runDir) {
  return join(runDir, RUN_FEATURES_FILE);
}

/** The stored object unchanged; `{}` when missing, unreadable or not an object. Never throws. */
export function readRunFeatures(runDir) {
  try {
    const value = readJsonSafe(runFeaturesPath(runDir), null);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export function writeRunFeatures(runDir, features) {
  writeJsonAtomic(runFeaturesPath(runDir), features);
}
