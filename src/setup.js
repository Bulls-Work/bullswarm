// bullswarm setup wizard — the front door.
//
// Doctrine:
//   U1. Discovery = binary on PATH + config dir present + (never) credential
//       entry. Burn rate starts EMPTY and is labeled "learning".
//   U2. The wizard suggests a routing table as an EDITABLE ARTIFACT, never a
//       questionnaire.
//   U3. Cross-agent skill/instruction integration requires explicit approval,
//       uses versioned bullswarm:begin/end markers, and is idempotent.
//   U4. `bullswarm setup` on a configured machine reports state and repairs
//       broken connector files.

import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stdin as input } from 'node:process';
import { loadState, saveState } from './lib/state.js';
import {
  awarenessBlock, applyAwarenessBlock, awarenessBlockPresent,
  installIntegration, retireLegacyOffload,
} from './integrate.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

// --- prompting ------------------------------------------------------------
// Sequential prompts that work identically on a TTY and with piped answers.
// (readline/promises question() drops lines when stdin is a pipe: the second
// question re-arms after buffered data was already consumed. Preload pipes;
// readline only per-question on a real TTY.)
export class Prompter {
  #lines = [];
  #preloaded = false;

  async #preload() {
    if (this.#preloaded) return;
    this.#preloaded = true;
    if (!input.isTTY) {
      input.setEncoding?.('utf8');
      let data = '';
      for await (const chunk of input) data += chunk;
      this.#lines = data.split('\n').filter((x) => x.length > 0);
    }
  }

  async question(prompt) {
    await this.#preload();
    if (input.isTTY) {
      const { createInterface } = await import('node:readline/promises');
      const rl = createInterface({ input, output: process.stderr });
      const answer = (await rl.question(prompt)).trim();
      rl.close();
      return answer;
    }
    return this.#lines.shift() ?? '';
  }

  // Each TTY question owns and closes its own readline interface. Keep a
  // no-op finalizer so wizard cleanup is safe for both TTY and piped input.
  close() {}
}

// --- discovery ---------------------------------------------------------------

function onPath(bin) {
  try {
    execFileSync('which', [bin], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function expandHome(p) {
  return p.startsWith('~') ? join(process.env.HOME ?? '', p.slice(1)) : p;
}

export function discoverConnectors() {
  const dir = join(REPO_ROOT, 'connectors');
  const found = [];
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue;
    let conn;
    try {
      conn = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    } catch {
      found.push({ file: f, broken: true });
      continue;
    }
    const binFound = onPath(conn.bin);
    const cfgFound = (conn.configDirs ?? []).some((d) => existsSync(expandHome(d)));
    found.push({
      file: f,
      name: conn.name,
      bin: conn.bin,
      binFound,
      cfgFound,
      discovered: binFound || cfgFound,
      meter: conn.meter?.type ?? 'none',
      costRank: conn.costRank,
      lanes: conn.lanes,
      testFixture: conn.flags?.testFixture === true,
    });
  }
  return found;
}

// --- routing suggestion --------------------------------------------------------

export function suggestRoutingTable(enabledPools) {
  const byLane = { analyze: [], build: [], chore: [] };
  for (const p of enabledPools) {
    for (const lane of p.lanes ?? ['analyze', 'build', 'chore']) {
      byLane[lane]?.push(p.name);
    }
  }
  // Suggest: cheapest pool as default per lane; caller as final fallback.
  const suggestion = {};
  for (const [lane, names] of Object.entries(byLane)) {
    suggestion[lane] = { order: names, fallback: 'caller' };
  }
  return suggestion;
}

// --- integration block ------------------------------------------------------------

export function integrationBlock() {
  return awarenessBlock();
}

export function applyIntegrationBlock(filePath, { approved }) {
  return applyAwarenessBlock(filePath, { approved });
}

export function integrationBlockPresent(filePath) {
  return awarenessBlockPresent(filePath);
}

// --- repair ---------------------------------------------------------------

export function repairConnectors(bullswarmDir) {
  const target = join(bullswarmDir, 'connectors');
  mkdirSync(target, { recursive: true });
  const repaired = [];
  for (const f of readdirSync(join(REPO_ROOT, 'connectors'))) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue;
    const dst = join(target, f);
    let broken = false;
    let differs = false;
    try {
      JSON.parse(readFileSync(dst, 'utf8'));
    } catch {
      broken = true;
    }
    if (!broken && existsSync(dst)) {
      differs = readFileSync(dst, 'utf8') !== readFileSync(join(REPO_ROOT, 'connectors', f), 'utf8');
    }
    if (!existsSync(dst) || broken || differs) {
      copyFileSync(join(REPO_ROOT, 'connectors', f), dst);
      repaired.push(f);
    }
  }
  return repaired;
}

// Forward-compatible metadata migration for existing installations. Preserve
// user-edited spawn commands and other connector quirks; only fill fields that
// did not exist in older published connector documents.
export function upgradeConnectorMetadata(bullswarmDir) {
  const target = join(bullswarmDir, 'connectors');
  if (!existsSync(target)) return [];
  const upgraded = [];
  for (const f of readdirSync(join(REPO_ROOT, 'connectors'))) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue;
    const dst = join(target, f);
    if (!existsSync(dst)) continue;
    try {
      const installed = JSON.parse(readFileSync(dst, 'utf8'));
      const packaged = JSON.parse(readFileSync(join(REPO_ROOT, 'connectors', f), 'utf8'));
      let changed = false;
      if (Array.isArray(packaged.capabilities)) {
        const existing = Array.isArray(installed.capabilities) ? installed.capabilities : [];
        const merged = [...new Set([...existing, ...packaged.capabilities])];
        if (JSON.stringify(merged) !== JSON.stringify(existing)) {
          installed.capabilities = merged;
          changed = true;
        }
      }
      if (Array.isArray(packaged.authSignatures)) {
        const existing = Array.isArray(installed.authSignatures) ? installed.authSignatures : [];
        const merged = [...new Set([...existing, ...packaged.authSignatures])];
        if (JSON.stringify(merged) !== JSON.stringify(existing)) {
          installed.authSignatures = merged;
          changed = true;
        }
      }
      if (installed.model == null && packaged.model != null) {
        installed.model = packaged.model;
        changed = true;
      }
      if (packaged.flags?.testFixture === true && installed.flags?.testFixture !== true) {
        installed.flags = { ...(installed.flags ?? {}), testFixture: true };
        changed = true;
      }
      if (installed.eventStream == null && packaged.eventStream != null) {
        installed.eventStream = packaged.eventStream;
        // Older packaged connectors used stdout extraction. Once JSONL flags
        // are enabled, extraction must use the same connector-declared event
        // stream or the content gate would judge the raw protocol envelope.
        if (installed.outputExtraction == null || installed.outputExtraction?.strategy === 'stdout') {
          installed.outputExtraction = packaged.outputExtraction;
        }
        changed = true;
      } else if (installed.eventStream != null && packaged.eventStream?.modelPaths != null &&
          installed.eventStream.modelPaths == null) {
        // Additive decoder metadata is safe to backfill without replacing
        // user-edited rules, args, or output mappings.
        installed.eventStream.modelPaths = packaged.eventStream.modelPaths;
        changed = true;
      }
      for (const field of ['modelDiscovery', 'knownModels', 'modelProfiles', 'modelSelection', 'conversation', 'subscription', 'preferredConcurrency']) {
        if (installed[field] == null && packaged[field] != null) {
          installed[field] = packaged[field];
          changed = true;
        }
      }
      if (changed) {
        writeFileSync(dst, `${JSON.stringify(installed, null, 2)}\n`);
        upgraded.push(f);
      }
    } catch { /* normal repair/setup will handle malformed files */ }
  }
  return upgraded;
}

// One-time safety migration for installations created before connectors could
// identify deterministic test fixtures. Explicit choices made after this
// migration remain respected.
export function migrateTestFixturePools(bullswarmDir) {
  const state = loadState(bullswarmDir);
  state.config ??= {};
  if (state.config.testFixturesMigrated === true) return [];

  const connectorsDir = join(bullswarmDir, 'connectors');
  const disabled = [];
  if (existsSync(connectorsDir)) {
    for (const file of readdirSync(connectorsDir)) {
      if (!file.endsWith('.json') || file.startsWith('_')) continue;
      try {
        const connector = JSON.parse(readFileSync(join(connectorsDir, file), 'utf8'));
        if (connector.flags?.testFixture !== true) continue;
        state.pools ??= {};
        state.pools[connector.name] ??= {};
        if (state.pools[connector.name].enabled !== false) disabled.push(connector.name);
        state.pools[connector.name].enabled = false;
      } catch { /* connector repair owns malformed files */ }
    }
  }
  state.config.testFixturesMigrated = true;
  saveState(bullswarmDir, state);
  return disabled;
}

// --- auto-setup ---------------------------------------------------------------
// Zero-touch initialization: enable every discovered pool, write config,
// never prompt. Used by `setup --yes`, by any verb on first use, and by
// non-TTY invocations (agents). Humans who want choices run plain
// `bullswarm setup` on a terminal.

export function autoSetup(bullswarmDir, { reason = 'auto' } = {}) {
  const state = loadState(bullswarmDir);
  const discovered = discoverConnectors();
  const repaired = repairConnectors(bullswarmDir);

  const usable = discovered.filter((d) => !d.broken && d.discovered && !d.testFixture);
  const enabled = new Set(usable.map((d) => d.name));

  state.pools ??= {};
  state.config ??= {};
  state.config.testFixturesMigrated = true;
  for (const d of discovered.filter((x) => !x.broken)) {
    state.pools[d.name] ??= {};
    state.pools[d.name].enabled = enabled.has(d.name);
  }

  const chosen = discovered.filter((d) => enabled.has(d.name));
  const table = suggestRoutingTable(chosen);

  mkdirSync(join(bullswarmDir, 'connectors'), { recursive: true });
  saveState(bullswarmDir, state);
  writeFileSync(
    join(bullswarmDir, 'routing.json'),
    `${JSON.stringify(table, null, 2)}\n`,
  );

  return {
    initialized: true,
    reason,
    enabledPools: [...enabled],
    discoveredCount: usable.length,
    repaired,
    routingTable: table,
    strategyRefreshRecommended: true,
    strategyCommand: 'bullswarm strategy refresh',
  };
}

export function isConfigured(bullswarmDir) {
  return existsSync(join(bullswarmDir, 'state.json'));
}

/**
 * Idempotent first-use guarantee for every verb: if config is missing,
 * initialize it silently. Returns null when already configured, else the
 * autoSetup result (callers may surface it).
 */
export function ensureSetup(bullswarmDir) {
  if (isConfigured(bullswarmDir)) {
    upgradeConnectorMetadata(bullswarmDir);
    migrateTestFixturePools(bullswarmDir);
    return null;
  }
  return autoSetup(bullswarmDir, { reason: 'first-use' });
}

// --- wizard -------------------------------------------------------------------

export async function runWizard(bullswarmDir, opts = {}) {
  const state = loadState(bullswarmDir);
  const discovered = discoverConnectors();

  if (opts.json) {
    console.log(JSON.stringify({ discovered, state: !!state.pools }, null, 2));
    return 0;
  }

  const rl = new Prompter();
  console.log('bullswarm setup\n');

  // 1. Discovery table
  console.log('Discovered agent CLIs:');
  for (const d of discovered) {
    if (d.broken) {
      console.log(`  ${d.file.padEnd(22)} BROKEN (will repair)`);
      continue;
    }
    const meter =
      d.meter === 'none'
        ? 'quota: unmetered'
        : `quota: ${d.meter} window (burn rate: learning)`;
    console.log(
      `  ${d.name.padEnd(14)} ${d.discovered ? 'found' : 'not found'}  ${meter}${d.testFixture ? '  TEST FIXTURE' : ''}`,
    );
  }
  console.log('');

  // 2. Toggle pools
  const enabled = [];
  for (const d of discovered.filter((x) => !x.broken && x.discovered)) {
    const prompt = d.testFixture
      ? `enable ${d.name} test fixture? [y/N] `
      : `enable ${d.name}? [Y/n] `;
    const ans = (await rl.question(prompt)).trim().toLowerCase();
    if (d.testFixture ? (ans === 'y' || ans === 'yes') : ans !== 'n') enabled.push(d.name);
  }

  if (enabled.length === 0) {
    console.log('\nNo pools enabled — bullswarm will keep every task in-session.');
  }

  // 3. Routing suggestion (editable artifact)
  const chosen = discovered.filter((d) => enabled.includes(d.name));
  const table = suggestRoutingTable(chosen);
  console.log('\nSuggested routing table (edit ~/.bullswarm/routing.json to change):');
  console.log(JSON.stringify(table, null, 2));

  // 4. Write config
  mkdirSync(join(bullswarmDir, 'connectors'), { recursive: true });
  const repaired = repairConnectors(bullswarmDir);
  state.pools ??= {};
  state.config ??= {};
  state.config.testFixturesMigrated = true;
  for (const d of discovered.filter((x) => !x.broken)) {
    state.pools[d.name] ??= {};
    state.pools[d.name].enabled = enabled.includes(d.name);
  }
  saveState(bullswarmDir, state);
  writeFileSync(
    join(bullswarmDir, 'routing.json'),
    `${JSON.stringify(table, null, 2)}\n`,
  );
  console.log(`\nWrote ${bullswarmDir}/state.json and routing.json`);
  if (repaired.length) console.log(`Repaired connector files: ${repaired.join(', ')}`);

  // 5. Optional execution style. Agent-decides is the neutral default: it
  // communicates preference without forcing a repository/worktree topology.
  const worktreeAnswer = (
    await rl.question('worktree isolation [agent/off/required] (default agent): ')
  ).trim().toLowerCase();
  state.config ??= {};
  state.config.worktreeIsolation = worktreeAnswer === 'required'
    ? 'required' : worktreeAnswer === 'off' ? 'off' : 'agent-decides';
  saveState(bullswarmDir, state);
  console.log(`  worktree isolation: ${state.config.worktreeIsolation}`);

  // Strategy changes actual provider/model routing, so discovery plus daily
  // auto-application always requires an explicit setup answer.
  const strategyAnswer = (
    await rl.question('discover models and enable capability-aware daily strategy autopilot? [y/N] ')
  ).trim().toLowerCase();
  if (strategyAnswer === 'y' || strategyAnswer === 'yes') {
    const { refreshStrategy, applyStrategyRecommendations } = await import('./strategy-cli.js');
    const report = await refreshStrategy(bullswarmDir);
    const applied = applyStrategyRecommendations(bullswarmDir, report);
    console.log(`  strategy tiers applied: ${Object.entries(applied.applied).map(([tier, value]) => `${tier}=${value.pool}/${value.model}`).join(', ')}`);
  } else {
    console.log('  strategy autopilot: off (enable later with bullswarm strategy apply --yes)');
  }

  // 6. Cross-agent integration — one canonical skill plus concise global
  // awareness rules. Nothing is written without this explicit answer.
  const integrateAnswer = (
    await rl.question('install Bullswarm skill for Codex, Claude, and Grok? [y/N] ')
  ).trim().toLowerCase();
  if (integrateAnswer === 'y' || integrateAnswer === 'yes') {
    const integrated = installIntegration({ approved: true });
    console.log(`  agent integration: ${integrated.status.ok ? 'ready' : 'incomplete'}`);
    if (integrated.status.legacyOffload.detected) {
      const retireAnswer = (
        await rl.question('archive the retired Claude offload skill? [y/N] ')
      ).trim().toLowerCase();
      if (retireAnswer === 'y' || retireAnswer === 'yes') {
        const retired = retireLegacyOffload({ approved: true });
        console.log(`  retired offload: ${retired.changed ? `archived at ${retired.destination}` : retired.reason}`);
      }
    }
  } else {
    console.log('  agent integration: skipped (install later with bullswarm integrate install --yes)');
  }

  rl.close();
  console.log('\nSetup complete. Try: bullswarm pools');
  return 0;
}
