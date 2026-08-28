// bullswarm workflow — {{ref}} templating + JSON-path access.
//
// Scope precedence: loop item > inputs > outputs.<stepId> > run metadata.
// A missing reference throws (validation should have caught static cases;
// this catches runtime-only gaps like fanout item field typos).

import { readFileSync, existsSync } from 'node:fs';

export function getPath(obj, path) {
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

/**
 * Expand {{ref}} tokens in a string against a scope object.
 * Supports {{item}}, {{item.path.to.field}}, {{inputs.x}}, {{outputs.stepId}},
 * {{runId}}, {{wfDir}}. Non-string values are JSON-stringified.
 */
export function renderTemplate(str, scope) {
  if (typeof str !== 'string') return str;
  return str.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, ref) => {
    const v = getPath(scope, ref.trim());
    if (v === undefined) {
      throw new Error(`template ref "{{${ref.trim()}}}" unresolved at render time`);
    }
    return typeof v === 'string' ? v : JSON.stringify(v);
  });
}

/** Deep-render every string in a step-like object. */
export function renderDeep(obj, scope) {
  if (typeof obj === 'string') return renderTemplate(obj, scope);
  if (Array.isArray(obj)) return obj.map((v) => renderDeep(v, scope));
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = renderDeep(v, scope);
    return out;
  }
  return obj;
}

/**
 * Extract the items array for a fanout from workflow state by dotted path.
 * Accepts:
 *   - a real array (inputs.files, outputs.step.items)
 *   - an outputs entry with outputText containing a JSON array
 *     (the common case: a discover step returns "[\"a.json\", ...]")
 */
export function extractItems(state, itemsFrom) {
  const v = getPath(state, itemsFrom);
  if (v === undefined) {
    throw new Error(`fanout itemsFrom "${itemsFrom}" not found in workflow state`);
  }
  if (Array.isArray(v)) return v;

  // outputs.<stepId> envelope (state.outputs.<id> is the full record
  // with ok/pool/outFile/outputText): use the recorded outputText,
  // which is a truncated copy of the on-disk file. The runtime
  // copies the file's contents into outputText at recordOutput time
  // so a fanout can resolve even if the run dir is later deleted.
  if (v && typeof v === 'object' && typeof v.outputText === 'string') {
    const parsed = parseJsonArray(v.outputText);
    if (parsed) return parsed;
    throw new Error(
      `fanout itemsFrom "${itemsFrom}": step output is not a JSON array. ` +
      'The discover step must return ONLY a JSON array of items.',
    );
  }

  // outputs.<stepId>.outFile (just the file path string): the
  // caller wants us to read the file from disk and parse it. This
  // is the natural shape for "fan out over the discovered list";
  // the discover step writes the list to its outFile and the
  // fanout step references the path.
  if (typeof v === 'string') {
    if (!existsSync(v)) {
      throw new Error(`fanout itemsFrom "${itemsFrom}": file not found: ${v}`);
    }
    const text = readFileSync(v, 'utf8');
    const parsed = parseJsonArray(text);
    if (parsed) return parsed;
    throw new Error(
      `fanout itemsFrom "${itemsFrom}": file ${v} is not a JSON array. ` +
      'The discover step must return ONLY a JSON array of items.',
    );
  }

  throw new Error(`fanout itemsFrom "${itemsFrom}" must resolve to an array (got ${typeof v})`);
}

/** Parse the first JSON array found in a text blob, tolerating prose around it. */
export function parseJsonArray(text) {
  if (typeof text !== 'string') return null;
  const tryParse = (slice) => {
    try {
      const arr = JSON.parse(slice);
      return Array.isArray(arr) ? arr : null;
    } catch {
      return null;
    }
  };
  // Workers are told to END their output with the array, so prefer the
  // trailing array: from the last "]" walk "[" candidates right-to-left until
  // one parses. Prose that itself contains brackets ("[see below]") then no
  // longer poisons the parse.
  const end = text.lastIndexOf(']');
  if (end === -1) return null;
  for (let start = text.lastIndexOf('[', end); start !== -1; start = text.lastIndexOf('[', start - 1)) {
    const parsed = tryParse(text.slice(start, end + 1));
    if (parsed) return parsed;
    if (start === 0) break;
  }
  // Fallback: the widest span (first "[" to last "]").
  const first = text.indexOf('[');
  return first !== -1 && first < end ? tryParse(text.slice(first, end + 1)) : null;
}
