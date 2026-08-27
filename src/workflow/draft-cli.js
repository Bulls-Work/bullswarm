// bullswarm workflow draft — incremental workflow construction via CLI.
//
// Surface:
//   bullswarm workflow draft create <name> [--description ...] [--input k=v]
//   bullswarm workflow draft show <name>
//   bullswarm workflow draft list
//   bullswarm workflow draft phase add <name> <phase>
//   bullswarm workflow draft phase remove <name> <phase>
//   bullswarm workflow draft step add <name> <phase> <step-id> [--type run|fanout|verify]
//                                                  [--lane ...] [--prompt ...]
//                                                  [--task-file ...] [--add-dir ...]
//                                                  [--pool ...] [--items-from ...]
//                                                  [--review ...] [--concurrency N]
//                                                  [--timeout N] [--on-error ...]
//                                                  [--step-template k=v] (repeatable)
//   bullswarm workflow draft step remove <name> <phase> <step-id>
//   bullswarm workflow draft step set <name> <phase> <step-id> <field> [--value ...]
//   bullswarm workflow draft set <name> <field> [--value ...]
//   bullswarm workflow draft validate <name>      # alias for workflow validate
//   bullswarm workflow draft export <name> <out-file>
//   bullswarm workflow draft delete <name>
//   bullswarm workflow draft run <name> [--input k=v] [--resume id] [--json] [--quiet]
//
// The `step add` and `set` commands accept JSON-encoded --value / --prompt
// so callers can pass arrays/objects inline (mirrors `workflow run --input`).

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildPoolsLive } from '../lib/config.js';
import { getAllMeterReadings } from '../meters/registry.js';
import { WorkflowTui } from './tui.js';
import { runWorkflow, loadWorkflow } from './runner.js';
import { validateWorkflow, WorkflowValidationError } from './validate.js';
import {
  emptyDraft, emptyMeta, draftExists, draftPaths, loadDraft, saveDraft,
  listDrafts, deleteDraft, addPhase, removePhase, addStep, removeStep,
  setField, setStepField, exportDraft, revalidateDraft,
} from './draft.js';
import { BULLSWARM_DIR } from './cli.js';
import { resolveRunId } from './short-id.js';

// --- flag parsing ----------------------------------------------------------
// Draft commands have a richer flag set than `workflow run`, so we parse
// the argv ourselves. Quoted string handling is intentionally minimal:
// values with spaces work as long as the shell passes them as a single
// argv element. Agents calling from JSON-encoded --value get predictable
// behavior because we never tokenize inside a value.

function parseDraftFlags(argv) {
  const out = { _positional: [], _flags: {}, _pairs: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--resume') out.resume = argv[++i];
    else if (a === '--input') out._pairs.push(argv[++i] ?? '');
    else if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out._flags[key] = true;
      } else {
        out._flags[key] = next;
        i += 1;
      }
    } else {
      out._positional.push(a);
    }
  }
  // Parse --input k=v pairs into a real map; JSON-encode arrays/objects.
  out.inputs = {};
  for (const kv of out._pairs) {
    const eq = kv.indexOf('=');
    if (eq <= 0) continue;
    const key = kv.slice(0, eq);
    const raw = kv.slice(eq + 1);
    let v = raw;
    if (raw.length && '[{"\''.includes(raw[0])) {
      try { v = JSON.parse(raw); } catch { v = raw; }
    }
    out.inputs[key] = v;
  }
  return out;
}

function jsonOut(obj, opts) {
  if (opts.json) console.log(JSON.stringify(obj, null, 2));
}

function err(msg) { console.error(msg); return 1; }

// --- subcommand dispatch ---------------------------------------------------

export async function cmdDraft(args) {
  const [sub, ...rest] = args;
  const opts = parseDraftFlags(rest);

  switch (sub) {
    case 'create':      return draftCreate(opts);
    case 'show':        return draftShow(opts);
    case 'list':        return draftList(opts);
    case 'phase':       return draftPhase(opts);
    case 'step':        return draftStep(opts);
    case 'set':         return draftSet(opts);
    case 'validate':    return draftValidate(opts);
    case 'export':      return draftExport(opts);
    case 'delete':      return draftDelete(opts);
    case 'run':         return draftRun(opts);
    default:
      console.error(draftUsage());
      return 2;
  }
}

export function draftUsage() {
  return `usage:
  bullswarm workflow draft create <name> [--description <text>] [--input k=v]...
  bullswarm workflow draft show <name>
  bullswarm workflow draft list
  bullswarm workflow draft phase add <name> <phase>
  bullswarm workflow draft phase remove <name> <phase>
  bullswarm workflow draft step add <name> <phase> <step-id>
                              [--type run|fanout|verify]
                              [--lane <lane>] [--pool <pool>]
                              [--prompt <text>] [--task-file <path>] [--add-dir <dir>]
                              [--items-from <path>] [--review <path>]
                              [--concurrency N] [--timeout N]
                              [--on-error continue|fail|skip-phase]
                              [--step-template <json>]
                              [--input k=v]...   (declarations, for the prompt template)
  bullswarm workflow draft step remove <name> <phase> <step-id>
  bullswarm workflow draft step set <name> <phase> <step-id> <field> --value <text>
  bullswarm workflow draft set <name> <field> --value <text>
  bullswarm workflow draft validate <name>
  bullswarm workflow draft export <name> <out-file>
  bullswarm workflow draft delete <name>
  bullswarm workflow draft run <name> [--input k=v]... [--resume <runId>] [--json] [--quiet]`;
}

// --- implementations -------------------------------------------------------

async function livePoolNames() {
  try {
    const { pools } = await buildPoolsLive(BULLSWARM_DIR(), Date.now(), {
      getReadings: getAllMeterReadings,
    });
    return { names: pools.map((p) => p.name), pools };
  } catch {
    return { names: [], pools: [] };
  }
}

function draftCreate(opts) {
  const [name] = opts._positional;
  if (!name) return err('usage: bullswarm workflow draft create <name>');
  if (draftExists(BULLSWARM_DIR(), name)) {
    return err(`draft "${name}" already exists (delete it first or use 'show')`);
  }
  const doc = emptyDraft(name);
  if (opts._flags.description) doc.description = String(opts._flags.description);
  // Apply --input k=v as draft-level input DECLARATIONS. The schema
  // requires each input to be an object with a `default` field, not a
  // raw value, so we wrap. `--required` flips the boolean.
  const requiredSet = new Set(
    String(opts._flags.required ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  );
  for (const [k, v] of Object.entries(opts.inputs)) {
    doc.inputs[k] = { default: v, ...(requiredSet.has(k) ? { required: true } : {}) };
  }
  const meta = emptyMeta(name);
  saveDraft(BULLSWARM_DIR(), name, doc, meta);
  // A brand-new draft is empty by design — the validator's
  // "phases must be non-empty" rule shouldn't fire on a draft
  // the user JUST created. Suppress that one specific warning;
  // real schema violations still error out via subsequent
  // `phase add` / `step add` calls.
  if (opts.json) {
    jsonOut({ ok: true, action: 'create', name, draftDir: draftPaths(BULLSWARM_DIR(), name).dir }, opts);
  } else {
    console.log(`✓ created draft "${name}" at ${draftPaths(BULLSWARM_DIR(), name).dir}`);
    console.log('  next: add a phase (workflow draft phase add <name> <phase>)');
  }
  return 0;
}

function draftShow(opts) {
  const [name] = opts._positional;
  if (!name) return err('usage: bullswarm workflow draft show <name>');
  const { doc, meta } = loadDraft(BULLSWARM_DIR(), name);
  if (opts.json) {
    jsonOut({ doc, meta }, opts);
  } else {
    console.log(`# ${doc.name} — ${doc.description ?? '(no description)'}`);
    console.log(`# created ${meta.createdAt}, updated ${meta.updatedAt}`);
    if (meta.lastValidation && !meta.lastValidation.ok) {
      console.log('✗ INVALID:');
      for (const i of meta.lastValidation.issues) console.log(`  - ${i}`);
    } else if (meta.lastValidation) {
      console.log('✓ valid');
      for (const w of meta.lastValidation.warnings ?? []) console.log(`  ⚠ ${w}`);
    }
    console.log('');
    console.log(JSON.stringify(doc, null, 2));
  }
  return 0;
}

function draftList(opts) {
  const drafts = listDrafts(BULLSWARM_DIR());
  if (opts.json) {
    jsonOut({ drafts }, opts);
  } else {
    if (drafts.length === 0) {
      console.log('no drafts (try: bullswarm workflow draft create <name>)');
      return 0;
    }
    for (const d of drafts) {
      const mark = d.valid ? '✓' : '✗';
      const issue = d.issues ? ` (${d.issues} issues)` : '';
      console.log(`${mark}  ${d.name.padEnd(28)} phases=${d.phases} steps=${d.steps}${issue}`);
    }
  }
  return 0;
}

function draftPhase(opts) {
  const [action, name, phaseName] = opts._positional;
  if (!action || !name || !phaseName) {
    return err('usage: bullswarm workflow draft phase <add|remove> <draft> <phase>');
  }
  if (action === 'add') {
    if (!draftExists(BULLSWARM_DIR(), name)) return err(`draft "${name}" does not exist`);
    const r = addPhase(BULLSWARM_DIR(), name, { phaseName });
    if (opts.json) {
      jsonOut({ ok: true, action: 'phase.add', name, phase: phaseName, validation: r.validation }, opts);
    } else {
      console.log(`✓ added phase "${phaseName}" to draft "${name}"`);
      reportValidation(r.validation);
    }
    return r.validation?.ok === false ? 1 : 0;
  }
  if (action === 'remove') {
    const r = removePhase(BULLSWARM_DIR(), name, { phaseName });
    if (opts.json) jsonOut({ ok: true, action: 'phase.remove', name, phase: phaseName, validation: r.validation }, opts);
    else { console.log(`✓ removed phase "${phaseName}" from draft "${name}"`); reportValidation(r.validation); }
    return r.validation?.ok === false ? 1 : 0;
  }
  return err(`unknown phase action "${action}"`);
}

function draftStep(opts) {
  const [action, name, phaseName, stepId] = opts._positional;
  if (!action || !name || !phaseName || !stepId) {
    return err('usage: bullswarm workflow draft step <add|remove|set> <draft> <phase> <step-id> [options]');
  }
  if (action === 'add') {
    const f = opts._flags;
    if (!draftExists(BULLSWARM_DIR(), name)) return err(`draft "${name}" does not exist`);
    const phase = (loadDraft(BULLSWARM_DIR(), name).doc.phases ?? []).find((p) => p.name === phaseName);
    if (!phase) return err(`phase "${phaseName}" not in draft "${name}" (add it first)`);
    const step = { type: f.type ?? 'run' };
    if (f.lane) step.lane = f.lane;
    if (f.pool) step.pool = f.pool;
    if (f.prompt != null) step.prompt = f.prompt;
    if (f['task-file']) step.taskFile = f['task-file'];
    if (f['add-dir']) step.addDir = f['add-dir'];
    if (f['items-from']) step.itemsFrom = f['items-from'];
    if (f.review) step.review = f.review;
    if (f.concurrency) step.concurrency = Number(f.concurrency);
    if (f.timeout) step.timeoutSec = Number(f.timeout);
    if (f['on-error']) step.onError = f['on-error'];
    if (f['step-template']) {
      let t = f['step-template'];
      if (typeof t === 'string' && t.length && '[{'.includes(t[0])) {
        try { t = JSON.parse(t); } catch { /* keep as string */ }
      }
      step.stepTemplate = t;
    }
    const r = addStep(BULLSWARM_DIR(), name, { phaseName, stepId, step });
    if (opts.json) {
      jsonOut({ ok: true, action: 'step.add', name, phase: phaseName, stepId, step: r.step, validation: r.validation }, opts);
    } else {
      console.log(`✓ added step "${stepId}" (type=${step.type}) to phase "${phaseName}" in draft "${name}"`);
      reportValidation(r.validation);
    }
    return r.validation?.ok === false ? 1 : 0;
  }
  if (action === 'remove') {
    const r = removeStep(BULLSWARM_DIR(), name, { phaseName, stepId });
    if (opts.json) jsonOut({ ok: true, action: 'step.remove', name, phase: phaseName, stepId, validation: r.validation }, opts);
    else { console.log(`✓ removed step "${stepId}" from phase "${phaseName}" in draft "${name}"`); reportValidation(r.validation); }
    return r.validation?.ok === false ? 1 : 0;
  }
  if (action === 'set') {
    const field = opts._positional[4];
    if (!field) return err('usage: bullswarm workflow draft step set <draft> <phase> <step> <field> --value <text>');
    if (!f_has(opts._flags, 'value')) return err('missing --value');
    const r = setStepField(BULLSWARM_DIR(), name, {
      phaseName, stepId, field, value: opts._flags.value,
    });
    if (opts.json) jsonOut({ ok: true, action: 'step.set', name, phase: phaseName, stepId, field, validation: r.validation }, opts);
    else { console.log(`✓ set ${field} on step "${stepId}" in draft "${name}"`); reportValidation(r.validation); }
    return r.validation?.ok === false ? 1 : 0;
  }
  return err(`unknown step action "${action}"`);
}

function f_has(flags, name) {
  return Object.prototype.hasOwnProperty.call(flags, name);
}

function draftSet(opts) {
  const [name, field] = opts._positional;
  if (!name || !field) return err('usage: bullswarm workflow draft set <draft> <field> --value <text>');
  if (!f_has(opts._flags, 'value')) return err('missing --value');
  const r = setField(BULLSWARM_DIR(), name, { field, value: opts._flags.value });
  if (opts.json) jsonOut({ ok: true, action: 'set', name, field, validation: r.validation }, opts);
  else { console.log(`✓ set ${field} on draft "${name}"`); reportValidation(r.validation); }
  return r.validation?.ok === false ? 1 : 0;
}

async function draftValidate(opts) {
  const [name] = opts._positional;
  if (!name) return err('usage: bullswarm workflow draft validate <name>');
  if (!draftExists(BULLSWARM_DIR(), name)) return err(`draft "${name}" does not exist`);
  const { doc } = loadDraft(BULLSWARM_DIR(), name);
  const { names } = await livePoolNames();
  try {
    const r = validateWorkflow(doc, { poolNames: names });
    if (opts.json) {
      jsonOut({ ok: true, name, warnings: r.warnings, poolNames: names }, opts);
    } else {
      console.log(`✓ draft "${name}" is valid (${(doc.phases ?? []).length} phases)`);
      for (const w of r.warnings) console.log(`  ⚠ ${w}`);
    }
    return 0;
  } catch (err) {
    if (err instanceof WorkflowValidationError) {
      if (opts.json) {
        jsonOut({ ok: false, name, issues: err.issues, poolNames: names }, opts);
      } else {
        console.log(`✗ draft "${name}":`);
        for (const i of err.issues) console.log(`  - ${i}`);
      }
      return 1;
    }
    throw err;
  }
}

function draftExport(opts) {
  const [name, outFile] = opts._positional;
  if (!name || !outFile) return err('usage: bullswarm workflow draft export <name> <out-file>');
  if (!draftExists(BULLSWARM_DIR(), name)) return err(`draft "${name}" does not exist`);
  const { outPath } = exportDraft(BULLSWARM_DIR(), name, outFile);
  if (opts.json) jsonOut({ ok: true, name, outPath }, opts);
  else console.log(`✓ exported draft "${name}" to ${outPath}`);
  return 0;
}

function draftDelete(opts) {
  const [name] = opts._positional;
  if (!name) return err('usage: bullswarm workflow draft delete <name>');
  if (!f_has(opts._flags, 'yes') && !opts._flags.y) {
    // Refuse without --yes for safety.
    return err(`refusing to delete draft "${name}" without --yes`);
  }
  const ok = deleteDraft(BULLSWARM_DIR(), name);
  if (opts.json) jsonOut({ ok, name }, opts);
  else console.log(ok ? `✓ deleted draft "${name}"` : `draft "${name}" did not exist`);
  return 0;
}

async function draftRun(opts) {
  const [name] = opts._positional;
  if (!name) return err('usage: bullswarm workflow draft run <name> [--input k=v]...');
  if (!draftExists(BULLSWARM_DIR(), name)) return err(`draft "${name}" does not exist`);
  // Build a synthetic path inside the drafts dir so the existing
  // loadWorkflow + runWorkflow paths work without modification.
  const { doc } = loadDraft(BULLSWARM_DIR(), name);
  // Re-validate against live pools before running.
  const { names, pools } = await livePoolNames();
  try { validateWorkflow(doc, { poolNames: names }); }
  catch (err) {
    if (err instanceof WorkflowValidationError) {
      console.error(`✗ draft "${name}" is invalid (nothing ran):`);
      for (const i of err.issues) console.error(`  - ${i}`);
      return 1;
    }
    throw err;
  }
  // Resolve --resume: shortId → runId. Reject unknown tokens.
  let resumeRunId = opts.resume;
  if (resumeRunId) {
    const resolved = resolveRunId(BULLSWARM_DIR(), resumeRunId);
    if (resolved) {
      resumeRunId = resolved.runId;
    } else if (resumeRunId.startsWith('wf-')) {
      // already a runId, leave as-is
    } else {
      console.error(`✗ --resume token "${resumeRunId}" did not match any run`);
      return 1;
    }
  }
  // Stash a path the loadWorkflow helper can find.
  const staged = join(BULLSWARM_DIR(), 'drafts', name, 'workflow.json');
  // Resolve relative to the working file via the loadWorkflow helper.
  const tui = new WorkflowTui({ quiet: opts.quiet, json: opts.json });
  const result = await runWorkflow({
    bullswarmDir: BULLSWARM_DIR(),
    doc,
    pools,
    inputs: opts.inputs,
    resumeRunId,
    onEvent: (ev) => tui.handle(ev),
  });
  if (opts.json) console.log(JSON.stringify(result.report, null, 2));
  return result.report.status === 'completed' ? 0 : 1;
}

function reportValidation(v) {
  if (!v) return;
  if (v.issues?.length) {
    console.log('✗ validation issues:');
    for (const i of v.issues) console.log(`  - ${i}`);
  }
  if (v.warnings?.length) {
    console.log('⚠ warnings:');
    for (const w of v.warnings) console.log(`  - ${w}`);
  }
}
