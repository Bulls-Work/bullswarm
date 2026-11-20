// `bullswarm caps`: show and set the concurrency caps (src/lib/caps.js).
//
//   caps [show] [--json]                               what is capped, running and queued now
//   caps set <group> <n> [--cwd <dir>]... [--pane <wN:pM>]...
//   caps set-pool <pool> <n>
//   caps set-default <n|off>
//   caps clear <group> | caps clear --pool <pool>
//
// Writes touch only caps.json under BULLSWARM_HOME. A cap never stops a step
// that is already running: a lowered cap holds back the next ones.

import { realpathSync } from 'node:fs';
import { parseArgs } from './cli.js';
import { unknownFlagExit } from './lib/cli-flags.js';
import { usageLine } from './help.js';
import { listAssignments } from './lib/assignments.js';
import {
  NAME_RE, emptyCaps, readCaps, slotSummary, writeCaps,
} from './lib/caps.js';

const SUBS = new Set(['show', 'set', 'set-pool', 'set-default', 'clear']);
const PANE_RE = /^w[A-Za-z0-9]+:p[0-9]+$/;

function capValue(raw) {
  const n = Number(raw);
  return typeof raw === 'string' && /^[0-9]+$/.test(raw) && Number.isInteger(n) && n <= 1000 ? n : null;
}

function list(value) {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).filter((item) => item !== true);
}

/** The facts `caps show` prints: caps, plus what runs and waits now. */
export function capsView(bullswarmDir, { now = Date.now() } = {}) {
  const caps = readCaps(bullswarmDir);
  const slots = slotSummary(bullswarmDir, caps, { now });
  const inflight = new Map();
  for (const record of listAssignments(bullswarmDir, { now })) {
    inflight.set(record.pool, (inflight.get(record.pool) ?? 0) + 1);
  }
  const callers = Object.entries(caps.callers).map(([group, entry]) => ({
    group, max: entry.max, cwdPrefixes: entry.cwdPrefixes, panes: entry.panes,
    running: slots[group]?.running ?? 0, waiting: slots[group]?.waiting ?? 0,
  }));
  // Groups with live slots but no entry of their own (named callers, or the default cap).
  for (const [group, view] of Object.entries(slots)) {
    if (!caps.callers[group]) callers.push({ group, max: view.max, cwdPrefixes: [], panes: [], running: view.running, waiting: view.waiting, implicit: true });
  }
  const pools = Object.entries(caps.pools).map(([pool, max]) => ({ pool, max, running: inflight.get(pool) ?? 0 }));
  return { schemaVersion: 'bullswarm.caps.view.v1', default: caps.default, updatedAt: caps.updatedAt, callers, pools };
}

function printView(view) {
  if (!view.callers.length && !view.pools.length && view.default == null) {
    console.log('no caps set: every caller and pool runs as many steps as routing allows');
    return;
  }
  console.log(`callers${view.default != null ? ` (default ${view.default} per caller not listed)` : ''}:`);
  if (!view.callers.length) console.log('  none');
  for (const row of view.callers) {
    const match = [...row.cwdPrefixes.map((p) => `cwd ${p}`), ...row.panes.map((p) => `pane ${p}`)].join(', ');
    console.log(`  ${row.group.padEnd(22)} max ${String(row.max ?? '-').padEnd(3)} running ${row.running} · queued ${row.waiting}`
      + `${match ? ` · ${match}` : row.implicit ? ' · (named at launch or default)' : ' · matched by --caller only'}`);
  }
  console.log('pools:');
  if (!view.pools.length) console.log('  none');
  for (const row of view.pools) console.log(`  ${row.pool.padEnd(22)} max ${String(row.max).padEnd(3)} running ${row.running}`);
  if (view.updatedAt) console.log(`updated ${view.updatedAt}`);
}

export async function cmdCaps(argv, { bullswarmDir, now = Date.now() } = {}) {
  const first = argv[0];
  const sub = first && !first.startsWith('--') ? first : 'show';
  const rest = first && !first.startsWith('--') ? argv.slice(1) : argv;
  if (!SUBS.has(sub)) {
    console.error(`✗ unknown caps command "${sub}": use show, set, set-pool, set-default or clear`);
    return 2;
  }
  const opts = parseArgs(rest, { lists: ['cwd', 'pane'] });
  const path = sub === 'show' && first !== 'show' ? ['caps'] : ['caps', sub];
  const flagExit = unknownFlagExit(opts._flags, path);
  if (flagExit !== null) return flagExit;
  const [a, b] = opts.rest;

  if (sub === 'show') {
    const view = capsView(bullswarmDir, { now });
    if (opts.json) console.log(JSON.stringify(view, null, 2));
    else printView(view);
    return 0;
  }

  const caps = readCaps(bullswarmDir) ?? emptyCaps();
  let said;
  if (sub === 'set') {
    const max = capValue(b);
    if (!a || !NAME_RE.test(a) || a === 'default' || max == null) {
      console.error(`✗ a group is letters, digits, . _ - (not default) and n is 0-1000\nusage: ${usageLine(['caps', 'set'])}`);
      return 2;
    }
    const cwds = list(opts.cwd);
    const panes = list(opts.pane);
    const badCwd = cwds.find((dir) => typeof dir !== 'string' || !dir.startsWith('/'));
    if (badCwd !== undefined) { console.error(`✗ --cwd takes an absolute directory (got "${badCwd}")`); return 2; }
    const badPane = panes.find((pane) => typeof pane !== 'string' || !PANE_RE.test(pane));
    if (badPane !== undefined) { console.error(`✗ --pane takes a herdr pane id like w6:p1 (got "${badPane}")`); return 2; }
    // Launch directories are recorded resolved (/tmp is /private/tmp on macOS).
    const resolved = cwds.map((dir) => { try { return realpathSync(dir); } catch { return dir; } });
    const before = caps.callers[a];
    // Matchers given replace the group's matchers; none given keeps them.
    caps.callers[a] = {
      max,
      cwdPrefixes: cwds.length || panes.length ? resolved : (before?.cwdPrefixes ?? []),
      panes: cwds.length || panes.length ? panes : (before?.panes ?? []),
    };
    said = `caller ${a}: max ${max}${before ? ` (was ${before.max})` : ''}`;
  } else if (sub === 'set-pool') {
    const max = capValue(b);
    if (!a || max == null) { console.error(`✗ n is 0-1000\nusage: ${usageLine(['caps', 'set-pool'])}`); return 2; }
    const before = caps.pools[a];
    caps.pools[a] = max;
    said = `pool ${a}: max ${max}${before != null ? ` (was ${before})` : ''}`;
  } else if (sub === 'set-default') {
    const max = a === 'off' ? null : capValue(a);
    if (a !== 'off' && max == null) { console.error(`✗ give a number 0-1000 or off\nusage: ${usageLine(['caps', 'set-default'])}`); return 2; }
    caps.default = max;
    said = max == null ? 'default cap off: callers no group matches are uncapped' : `default: max ${max} per caller no group matches`;
  } else {
    const poolName = typeof opts.pool === 'string' ? opts.pool : null;
    if (poolName) {
      if (!(poolName in caps.pools)) { console.error(`✗ pool ${poolName} has no cap`); return 1; }
      delete caps.pools[poolName];
      said = `pool ${poolName}: cap removed`;
    } else {
      if (!a || !caps.callers[a]) { console.error(a ? `✗ caller group ${a} has no cap` : `✗ name a group or --pool\nusage: ${usageLine(['caps', 'clear'])}`); return a ? 1 : 2; }
      delete caps.callers[a];
      said = `caller ${a}: cap removed`;
    }
  }
  const written = writeCaps(bullswarmDir, caps, { now });
  if (opts.json) console.log(JSON.stringify({ ok: true, changed: said, caps: written }, null, 2));
  else console.log(`✓ ${said}\n  steps already running keep running; the next ones follow the new cap`);
  return 0;
}
