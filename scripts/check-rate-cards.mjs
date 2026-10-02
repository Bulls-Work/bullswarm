#!/usr/bin/env node
// Compare Bullswarm's rate-card price of each attempt with the CLI's own
// reported cost, over the run folders of a home (default ~/.bullswarm). Read
// only. Usage: node scripts/check-rate-cards.mjs [--home <dir>] [--last <n>]
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { compareAttemptCosts, summarizeCostComparison } from '../src/lib/rate-card-check.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : fallback; };
const home = flag('--home', process.env.BULLSWARM_HOME || join(homedir(), '.bullswarm'));
const last = Number(flag('--last', 200));
const runsRoot = join(home, 'workflows');
const events = (attempt) => {
  if (!attempt?.streamFile || !existsSync(attempt.streamFile)) return null;
  return readFileSync(attempt.streamFile, 'utf8').split('\n').map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
};
const rows = [];
for (const name of readdirSync(runsRoot).filter((entry) => entry.startsWith('wf-')).sort().slice(-last)) {
  let state;
  try { state = JSON.parse(readFileSync(join(runsRoot, name, 'state.json'), 'utf8')); } catch { continue; }
  rows.push(...compareAttemptCosts(state, events));
}
for (const group of summarizeCostComparison(rows)) {
  const off = group.off.slice(0, 4).map((row) => `${row.shortId}/${row.actionId} ${((row.ratio - 1) * 100).toFixed(1)}%`).join(', ');
  console.log(`${group.key.padEnd(34)} ${String(group.exact).padStart(4)}/${String(group.pairs).padEnd(4)} agree${off ? `   off: ${off}` : ''}`);
}
