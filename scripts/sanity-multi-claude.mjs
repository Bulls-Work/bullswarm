#!/usr/bin/env node
// Live sanity: discover every Claude Code login, pin one workflow step per
// pool, and require each spawn to echo its own CLAUDE_CONFIG_DIR.
//
// Profile list is filesystem-derived. There is no hardcoded extra-home name.

import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverClaudeAccounts } from '../src/lib/claude-accounts.js';
import { runWorkflow } from '../src/workflow/runner.js';
import { buildPoolsLive } from '../src/lib/config.js';
import { getAllMeterReadings } from '../src/meters/registry.js';
import { autoSetup } from '../src/setup.js';

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

const accounts = discoverClaudeAccounts();
if (accounts.length < 2) {
  fail(
    `need at least two Claude Code logins with usable tokens; found ${accounts.length} `
    + `(${accounts.map((a) => a.pool).join(', ') || 'none'}). `
    + 'Log a second account in with CLAUDE_CONFIG_DIR=~/.claude-<slug> claude',
  );
}

console.log('discovered Claude profiles:');
for (const a of accounts) {
  console.log(`  - pool=${a.pool}  command=${a.command}  source=${a.source}`);
}

const home = mkdtempSync(join(tmpdir(), 'bs-multi-claude-'));
const bullswarmDir = join(home, '.bullswarm');
mkdirSync(join(bullswarmDir, 'connectors'), { recursive: true });
autoSetup(bullswarmDir, { reason: 'sanity-multi-claude' });

const { pools } = await buildPoolsLive(bullswarmDir, Date.now(), {
  force: true,
  getReadings: getAllMeterReadings,
});
const claudePools = pools.filter((p) => p.name === 'claude-code' || p.name.startsWith('claude-code:'));
console.log('runtime pools:');
for (const p of claudePools) {
  console.log(
    `  - ${p.name} command=${p.connector?.profile?.command ?? '?'} `
    + `used=${p.usedPct ?? '?'}% enabled=${p.enabled !== false}`,
  );
}

const missing = accounts.filter((a) => !claudePools.some((p) => p.name === a.pool));
if (missing.length) {
  fail(`runtime pools missing: ${missing.map((a) => a.pool).join(', ')}`);
}

const targetDir = join(home, 'repo');
mkdirSync(targetDir, { recursive: true });
writeFileSync(join(targetDir, 'README.md'), 'sanity target\n');

const steps = accounts.map((a, i) => ({
  id: `proof-${i + 1}`,
  type: 'run',
  lane: 'chore',
  pool: a.pool,
  timeoutSec: 180,
  prompt: [
    `You are running as bullswarm pool "${a.pool}".`,
    'Do not use tools.',
    'Reply with exactly two lines and nothing else.',
    `Line 1 must be: PROOF pool=${a.pool} configDir=$CLAUDE_CONFIG_DIR`,
    'Replace $CLAUDE_CONFIG_DIR with the actual CLAUDE_CONFIG_DIR environment value, or the word unset if it is missing.',
    'Line 2 must be: SANITY this line exists so the content gate sees enough verified work from a live Claude Code login.',
  ].join(' '),
}));

const doc = {
  name: 'sanity-multi-claude',
  description: 'Pin one chore step per discovered Claude Code login',
  inputs: {},
  settings: { concurrency: 2, escalateOnFail: false },
  phases: [{ name: 'proof', steps }],
};

console.log(`running ${steps.length} pinned Claude steps…`);
const result = await runWorkflow({
  bullswarmDir,
  doc,
  pools: claudePools,
  inputs: {},
  env: process.env,
});

const outputs = result.state?.outputs ?? {};
const proofs = [];
for (const step of steps) {
  const out = outputs[step.id];
  if (!out) fail(`no output for ${step.id} (pool ${step.pool})`);
  const text = existsSync(out.outFile) ? readFileSync(out.outFile, 'utf8') : (out.outputText ?? '');
  const line = text.split('\n').map((l) => l.trim()).find((l) => l.startsWith('PROOF '));
  if (!line) {
    fail(`step ${step.id} (pool ${step.pool}) did not print a PROOF line. output:\n${text.slice(0, 800)}`);
  }
  if (out.pool !== step.pool) {
    fail(`step ${step.id} ran as pool ${out.pool}, expected ${step.pool}`);
  }
  proofs.push({ step: step.id, pool: out.pool, line, ok: out.ok });
  console.log(`  ${step.id}: ${line}  (ok=${out.ok} recordedPool=${out.pool})`);
}

const dirs = proofs.map((p) => {
  const m = p.line.match(/configDir=(\S+)/);
  return m ? m[1] : 'unset';
});
const uniqueDirs = new Set(dirs);
if (uniqueDirs.size < 2) {
  fail(`expected two different CLAUDE_CONFIG_DIR values, got: ${dirs.join(', ')}`);
}
if (dirs.includes('unset')) {
  fail(`a spawn ran without CLAUDE_CONFIG_DIR: ${dirs.join(', ')}`);
}

console.log('PASS: two (or more) Claude licenses spawned with distinct CLAUDE_CONFIG_DIR values');
console.log(JSON.stringify({
  ok: true,
  pools: proofs.map((p) => p.pool),
  configDirs: dirs,
  status: result.report?.status ?? result.state?.status,
}, null, 2));
process.exit(result.report?.status === 'completed' || proofs.every((p) => p.ok) ? 0 : 1);
