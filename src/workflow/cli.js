// bullswarm workflow CLI — run | validate | list.

import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { loadWorkflow, runWorkflow } from './runner.js';
import { validateWorkflow, WorkflowValidationError } from './validate.js';
import { buildPoolsLive } from '../lib/config.js';
import { getAllMeterReadings } from '../meters/registry.js';
import { WorkflowTui } from './tui.js';

export const BULLSWARM_DIR = join(homedir(), '.bullswarm');

function workflowDirs() {
  return [
    join(process.cwd(), 'workflows'),
    join(BULLSWARM_DIR, 'workflows'),
  ];
}

function discover() {
  const found = [];
  for (const dir of workflowDirs()) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).sort()) {
      const p = join(dir, f);
      if (!statSync(p).isFile() || !f.endsWith('.json')) continue;
      try {
        const doc = JSON.parse(readFileSync(p, 'utf8'));
        found.push({ name: doc.name ?? f.replace(/\.json$/, ''), path: p, valid: null });
      } catch (err) {
        found.push({ name: f.replace(/\.json$/, ''), path: p, valid: `parse error: ${err.message}` });
      }
    }
  }
  return found;
}

export async function cmdWorkflow(args) {
  const [sub, ...rest] = args;
  const opts = parseFlags(rest);

  switch (sub) {
    case 'run':
      return wfRun(opts);
    case 'validate':
      return wfValidate(opts);
    case 'list':
      return wfList(opts);
    default:
      console.error('usage: bullswarm workflow <run|validate|list> [file|name] [--input k=v] [--resume id] [--json] [--quiet]');
      return 2;
  }
}

function parseFlags(argv) {
  const out = { inputs: {}, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--resume') out.resume = argv[++i];
    else if (a === '--input') {
      const kv = argv[++i] ?? '';
      const eq = kv.indexOf('=');
      if (eq > 0) out.inputs[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else if (a.startsWith('--')) {
      out[a.slice(2)] = true;
    } else out.rest.push(a);
  }
  return out;
}

async function wfValidate(opts) {
  const target = opts.rest[0];
  if (!target) {
    console.error('usage: bullswarm workflow validate <file-or-name>');
    return 2;
  }
  let doc, path;
  try {
    ({ doc, path } = loadWorkflow(target, workflowDirs()));
  } catch (err) {
    console.error(`✗ ${err.message}`);
    return 1;
  }
  const poolsInfo = await livePoolNames();
  try {
    const r = validateWorkflow(doc, { poolNames: poolsInfo.names });
    console.log(`✓ ${path} is valid (${doc.phases?.length ?? 0} phases)`);
    for (const w of r.warnings) console.log(`  ⚠ ${w}`);
    return 0;
  } catch (err) {
    if (err instanceof WorkflowValidationError) {
      console.error(`✗ ${path}:`);
      for (const issue of err.issues) console.error(`  - ${issue}`);
      return 1;
    }
    throw err;
  }
}

async function livePoolNames() {
  try {
    const { pools } = await buildPoolsLive(BULLSWARM_DIR, Date.now(), {
      getReadings: getAllMeterReadings,
    });
    return { names: pools.map((p) => p.name), pools };
  } catch {
    return { names: [], pools: [] };
  }
}

async function wfRun(opts) {
  const target = opts.rest[0];
  if (!target) {
    console.error('usage: bullswarm workflow run <file-or-name> [--input k=v] [--resume runId]');
    return 2;
  }

  let doc, path;
  try {
    ({ doc, path } = loadWorkflow(target, workflowDirs()));
  } catch (err) {
    console.error(`✗ ${err.message}`);
    return 1;
  }

  const { names, pools } = await livePoolNames();
  try {
    validateWorkflow(doc, { poolNames: names });
  } catch (err) {
    if (err instanceof WorkflowValidationError) {
      console.error(`✗ workflow invalid (nothing ran):`);
      for (const issue of err.issues) console.error(`  - ${issue}`);
      return 1;
    }
    throw err;
  }

  const tui = new WorkflowTui({ quiet: opts.quiet, json: opts.json });
  const result = await runWorkflow({
    bullswarmDir: BULLSWARM_DIR,
    doc,
    pools,
    inputs: opts.inputs,
    resumeRunId: opts.resume,
    onEvent: (ev) => tui.handle(ev),
  });

  if (opts.json) {
    console.log(JSON.stringify(result.report, null, 2));
  }
  return result.report.status === 'completed' ? 0 : 1;
}

function wfList(opts) {
  const found = discover();
  if (opts.json) {
    console.log(JSON.stringify({ workflows: found }, null, 2));
    return 0;
  }
  if (found.length === 0) {
    console.log(`no workflows found in: ${workflowDirs().join(', ')}`);
    return 0;
  }
  for (const w of found) {
    const mark = w.valid ? `✗ ${w.valid}` : '✓';
    console.log(`${mark}  ${w.name.padEnd(24)} ${w.path}`);
  }
  return 0;
}
