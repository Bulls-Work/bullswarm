// Reading a run's artifact files for the Step page: a tolerant JSON or text
// read, and the path rules that keep a copied home inside its own run
// directory instead of following a retained absolute path into the live home.

import { existsSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative } from 'node:path';
import { textOrNull } from './step-model-values.js';

function safeReadJson(path) {
  if (!path || !existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function safeReadText(path) {
  if (!path || !existsSync(path)) return null;
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

function resolveExistingPath(candidate, runDir) {
  if (typeof candidate !== 'string' || !candidate.trim()) return null;
  const value = candidate.trim();
  if (runDir) {
    const relativeCandidate = isAbsolute(value) ? null : relative(runDir, join(runDir, value));
    const local = relativeCandidate && !relativeCandidate.startsWith('..') && !isAbsolute(relativeCandidate)
      ? join(runDir, relativeCandidate)
      : null;
    if (local && existsSync(local)) return local;
    // Copied-home state often retains an absolute path from the source home;
    // the same basename is the safe local artifact when it was copied beside
    // state.json.
    const basenameLocal = join(runDir, basename(value));
    if (existsSync(basenameLocal)) return basenameLocal;
    // A copied-home inspection must not follow the absolute path retained in
    // state.json back into the live home. Only accept an absolute candidate
    // after proving it is inside this run directory.
    if ((value === runDir || value.startsWith(`${runDir}/`)) && existsSync(value)) return value;
    return null;
  }
  if (existsSync(value)) return value;
  return null;
}

function retainedPath(candidate, runDir) {
  const resolved = resolveExistingPath(candidate, runDir);
  if (resolved) return resolved;
  if (runDir && typeof candidate === 'string' && candidate.trim()) {
    const value = candidate.trim();
    const relativeCandidate = isAbsolute(value) ? null : relative(runDir, join(runDir, value));
    if (relativeCandidate && !relativeCandidate.startsWith('..') && !isAbsolute(relativeCandidate)) {
      return join(runDir, relativeCandidate);
    }
    return join(runDir, basename(value));
  }
  return textOrNull(candidate);
}

export {
  safeReadJson,
  safeReadText,
  resolveExistingPath,
  retainedPath,
};
