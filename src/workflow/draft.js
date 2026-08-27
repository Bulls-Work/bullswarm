// bullswarm workflow drafts — incremental workflow construction.
//
// A draft is a workflow document under construction. It lives in
// `~/.bullswarm/drafts/<name>/` and consists of:
//   - `workflow.json` — the workflow document itself (matches the schema
//     that `validate.js` understands; identical to a hand-written file)
//   - `meta.json`     — draft metadata: createdAt, updatedAt, lastEditBy
//
// Every mutation in this module:
//   1. Loads the draft (or scaffolds a new one).
//   2. Applies the mutation.
//   3. Persists atomically (write to temp + rename).
//   4. Re-validates the document. Validation errors are returned to the
//      caller AND stored on `meta.lastValidation`. The draft is NOT
//      rolled back — a partial draft is allowed so the user can fix it
//      step by step.
//
// The shape is intentionally simple: drafts ARE workflow documents. No
// separate "draft state" model to keep in sync.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { validateWorkflow, WorkflowValidationError } from './validate.js';
import { loadState, saveState, quarantinePool } from '../lib/state.js';
import { loadConnectors } from '../lib/config.js';

export const DRAFTS_DIR_NAME = 'drafts';

// Minimal seed for a brand-new draft. The user fills in the rest.
export function emptyDraft(name) {
  return {
    name,
    description: 'New draft workflow — describe what it does.',
    version: '1.0.0',
    inputs: {},
    settings: { concurrency: 4, escalateOnFail: true },
    phases: [],
  };
}

export function emptyMeta(name) {
  return {
    name,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastEditBy: null,
    lastValidation: { ok: true, issues: [], warnings: [] },
  };
}

export function draftDir(bullswarmDir, name) {
  return join(bullswarmDir, DRAFTS_DIR_NAME, name);
}

export function draftPaths(bullswarmDir, name) {
  const d = draftDir(bullswarmDir, name);
  return { dir: d, doc: join(d, 'workflow.json'), meta: join(d, 'meta.json') };
}

function atomicWrite(p, content) {
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${randomBytes(3).toString('hex')}`;
  writeFileSync(tmp, content);
  renameSync(tmp, p);
}

export function draftExists(bullswarmDir, name) {
  return existsSync(draftPaths(bullswarmDir, name).doc);
}

export function loadDraft(bullswarmDir, name) {
  const p = draftPaths(bullswarmDir, name);
  if (!existsSync(p.doc)) {
    throw new Error(`draft "${name}" does not exist (try: bullswarm workflow draft create ${name})`);
  }
  const doc = JSON.parse(readFileSync(p.doc, 'utf8'));
  let meta = emptyMeta(name);
  if (existsSync(p.meta)) {
    try { meta = { ...meta, ...JSON.parse(readFileSync(p.meta, 'utf8')) }; } catch { /* corrupt meta → use default */ }
  }
  return { doc, meta, paths: p };
}

export function saveDraft(bullswarmDir, name, doc, metaPatch = {}) {
  const p = draftPaths(bullswarmDir, name);
  const meta = {
    ...(existsSync(p.meta) ? JSON.parse(readFileSync(p.meta, 'utf8')) : emptyMeta(name)),
    ...metaPatch,
    updatedAt: new Date().toISOString(),
  };
  atomicWrite(p.doc, `${JSON.stringify(doc, null, 2)}\n`);
  atomicWrite(p.meta, `${JSON.stringify(meta, null, 2)}\n`);
  return { doc, meta, paths: p };
}

// Re-validate the draft and persist the result on meta.lastValidation.
// Returns the validation result. Throws nothing: callers decide whether
// to abort or report the error to the user.
//
// Partial drafts (zero phases, or a phase with zero steps) are
// considered BUILDING, not INVALID. The "phases must be non-empty"
// rule still bites when you try to RUN a phaseless draft, but during
// construction we want incremental edits to keep returning 0. We
// downgrade those specific issues to warnings.
export function revalidateDraft(bullswarmDir, name, { poolNames = null } = {}) {
  const { doc, meta, paths } = loadDraft(bullswarmDir, name);
  const knownPoolNames = poolNames ?? Object.keys(loadConnectors(bullswarmDir));
  let result = { ok: true, issues: [], warnings: [] };
  try {
    const r = validateWorkflow(doc, { poolNames: knownPoolNames });
    result = { ok: true, issues: [], warnings: r.warnings ?? [] };
  } catch (err) {
    if (err instanceof WorkflowValidationError) {
      // Issues that ONLY fire on an empty draft — treat as warnings
      // so the user can keep building. Anything else is a real
      // schema violation and is a hard fail.
      const isBuildingIssue = (i) => (
        /phases must be a non-empty array/.test(i)
      );
      const issues = err.issues.filter((i) => !isBuildingIssue(i));
      const warnings = err.issues.filter(isBuildingIssue);
      result = issues.length === 0
        ? { ok: true, issues: [], warnings }
        : { ok: false, issues, warnings: [] };
    } else {
      result = { ok: false, issues: [`internal: ${err.message}`], warnings: [] };
    }
  }
  meta.lastValidation = result;
  atomicWrite(paths.meta, `${JSON.stringify(meta, null, 2)}\n`);
  return result;
}

export function listDrafts(bullswarmDir) {
  const root = join(bullswarmDir, DRAFTS_DIR_NAME);
  if (!existsSync(root)) return [];
  const out = [];
  for (const name of readdirSync(root).sort()) {
    const d = join(root, name);
    if (!statSync(d).isDirectory()) continue;
    const p = draftPaths(bullswarmDir, name);
    if (!existsSync(p.doc)) continue;
    let doc, meta;
    try { doc = JSON.parse(readFileSync(p.doc, 'utf8')); } catch { continue; }
    try { meta = existsSync(p.meta) ? JSON.parse(readFileSync(p.meta, 'utf8')) : {}; } catch { meta = {}; }
    out.push({
      name,
      phases: (doc.phases ?? []).length,
      steps: (doc.phases ?? []).reduce((n, p) => n + (p.steps?.length ?? 0), 0),
      valid: meta.lastValidation?.ok === true,
      issues: meta.lastValidation?.issues?.length ?? 0,
      updatedAt: meta.updatedAt ?? null,
    });
  }
  return out;
}

export function deleteDraft(bullswarmDir, name) {
  const d = draftDir(bullswarmDir, name);
  if (!existsSync(d)) return false;
  rmSync(d, { recursive: true, force: true });
  return true;
}

// ---- mutations ------------------------------------------------------------

/**
 * Add a phase to a draft. Returns the updated doc.
 * Idempotent: if a phase with the same name already exists, this is a
 * no-op (returns the existing phase index). Always re-validates.
 */
export function addPhase(bullswarmDir, name, { phaseName }) {
  const { doc, paths } = loadDraft(bullswarmDir, name);
  if ((doc.phases ?? []).some((p) => p.name === phaseName)) {
    return { doc, phaseIndex: doc.phases.findIndex((p) => p.name === phaseName) };
  }
  doc.phases = doc.phases ?? [];
  doc.phases.push({ name: phaseName, steps: [] });
  const { meta } = saveDraft(bullswarmDir, name, doc);
  const v = revalidateDraft(bullswarmDir, name);
  return { doc, phaseIndex: doc.phases.length - 1, validation: v, meta };
}

export function removePhase(bullswarmDir, name, { phaseName }) {
  const { doc, paths } = loadDraft(bullswarmDir, name);
  const i = (doc.phases ?? []).findIndex((p) => p.name === phaseName);
  if (i < 0) throw new Error(`phase "${phaseName}" not in draft "${name}"`);
  doc.phases.splice(i, 1);
  saveDraft(bullswarmDir, name, doc);
  const v = revalidateDraft(bullswarmDir, name);
  return { doc, validation: v };
}

/**
 * Add a step to a draft phase. The step fields are passed as a plain
 * object; any keys that look like arrays/objects are parsed from JSON
 * (so `--itemsFrom='["a","b"]'` works the same way as --input does).
 */
export function addStep(bullswarmDir, name, { phaseName, stepId, step }) {
  const { doc } = loadDraft(bullswarmDir, name);
  const phase = (doc.phases ?? []).find((p) => p.name === phaseName);
  if (!phase) throw new Error(`phase "${phaseName}" not in draft "${name}"`);
  phase.steps = phase.steps ?? [];
  if (phase.steps.some((s) => s.id === stepId)) {
    throw new Error(`step id "${stepId}" already exists in phase "${phaseName}"`);
  }
  const newStep = { id: stepId, ...step };
  phase.steps.push(newStep);
  saveDraft(bullswarmDir, name, doc);
  const v = revalidateDraft(bullswarmDir, name);
  return { doc, step: newStep, validation: v };
}

export function removeStep(bullswarmDir, name, { phaseName, stepId }) {
  const { doc } = loadDraft(bullswarmDir, name);
  const phase = (doc.phases ?? []).find((p) => p.name === phaseName);
  if (!phase) throw new Error(`phase "${phaseName}" not in draft "${name}"`);
  const i = (phase.steps ?? []).findIndex((s) => s.id === stepId);
  if (i < 0) throw new Error(`step "${stepId}" not in phase "${phaseName}"`);
  phase.steps.splice(i, 1);
  saveDraft(bullswarmDir, name, doc);
  const v = revalidateDraft(bullswarmDir, name);
  return { doc, validation: v };
}

/**
 * Set / replace a top-level field. Used for `description`, `version`,
 * `inputs`, `settings`. The `value` is JSON-decoded if it starts with
 * `[ { " '` so callers can do `--value='{"required":true}'`.
 */
export function setField(bullswarmDir, name, { field, value }) {
  const { doc } = loadDraft(bullswarmDir, name);
  let parsed = value;
  if (typeof value === 'string' && value.length && '[{"\''.includes(value[0])) {
    try { parsed = JSON.parse(value); } catch { /* keep as string */ }
  }
  doc[field] = parsed;
  saveDraft(bullswarmDir, name, doc);
  const v = revalidateDraft(bullswarmDir, name);
  return { doc, validation: v };
}

/**
 * Set / replace a step field. Useful for tweaking prompt, lane, timeout,
 * pool, onError, etc. without removing + re-adding the step.
 */
export function setStepField(bullswarmDir, name, { phaseName, stepId, field, value }) {
  const { doc } = loadDraft(bullswarmDir, name);
  const phase = (doc.phases ?? []).find((p) => p.name === phaseName);
  if (!phase) throw new Error(`phase "${phaseName}" not in draft "${name}"`);
  const step = (phase.steps ?? []).find((s) => s.id === stepId);
  if (!step) throw new Error(`step "${stepId}" not in phase "${phaseName}"`);
  let parsed = value;
  if (typeof value === 'string' && value.length && '[{"\''.includes(value[0])) {
    try { parsed = JSON.parse(value); } catch { /* keep as string */ }
  }
  step[field] = parsed;
  saveDraft(bullswarmDir, name, doc);
  const v = revalidateDraft(bullswarmDir, name);
  return { doc, validation: v };
}

/**
 * Export a draft as a stable workflow JSON file. Used to promote a
 * draft to a checked-in `.json` in `./workflows/`.
 */
export function exportDraft(bullswarmDir, name, outPath) {
  const { doc } = loadDraft(bullswarmDir, name);
  atomicWrite(outPath, `${JSON.stringify(doc, null, 2)}\n`);
  return { doc, outPath };
}
