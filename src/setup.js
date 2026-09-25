// bullswarm setup wizard — the front door.
//
// Doctrine:
//   U1. Discovery = every loaded provider (src/lib/providers.js), judged by its
//       own doctor() when it exports one, else binary on PATH + config dir
//       present + (never) credential entry. A provider that failed to load is
//       listed with its error. Burn rate starts EMPTY and is labeled "learning".
//   U2. The wizard suggests a routing table as an EDITABLE ARTIFACT, never a
//       questionnaire.
//   U3. Cross-agent skill/instruction integration requires explicit approval,
//       uses versioned bullswarm:begin/end markers, and is idempotent.
//   U4. `bullswarm setup` on a configured machine reports state and repairs
//       broken connector files.

import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { stdin as input } from 'node:process';
import { loadState, updateState } from './lib/state.js';
import {
  STRATEGY_TIERS, getStrategyReasoning, setStrategyReasoning, rungsFor, formatRungEvidence,
  getRecommendedReasoning,
} from './lib/strategy.js';
import { buildPools, loadPoolProviders } from './lib/config.js';
import { REASONING_LEVELS } from './lib/reasoning.js';
import { installIntegration, retireLegacyOffload } from './integrate.js';
import { packagedConnectorSources, syncConnectorCopies } from './lib/connector-copies.js';

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
  if (typeof bin !== 'string' || bin === '') return false;
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

function defaultBullswarmDir() {
  const h = process.env.BULLSWARM_HOME?.trim();
  return h || join(homedir(), '.bullswarm');
}

/**
 * Readiness of one loaded provider: its doctor() when exported, else `bin` on
 * PATH (installed) and any `configDirs` entry present (loggedIn).
 */
function providerHealth(entry, pool) {
  if (entry.hasDoctor) {
    try {
      const report = entry.module.doctor({ ...entry.ctx });
      return {
        health: 'doctor',
        installed: report?.installed === true,
        loggedIn: typeof report?.loggedIn === 'boolean' ? report.loggedIn : null,
        hint: typeof report?.hint === 'string' ? report.hint : null,
      };
    } catch (err) {
      return { health: 'doctor', installed: false, loggedIn: null, hint: `doctor() threw: ${err?.message ?? err}` };
    }
  }
  const configDirs = Array.isArray(pool.configDirs) ? pool.configDirs : [];
  return {
    health: 'default',
    installed: onPath(pool.bin),
    loggedIn: configDirs.some((d) => typeof d === 'string' && existsSync(expandHome(d))),
    hint: null,
  };
}

/**
 * One entry per provider the loader found, in load order: tier, enabled,
 * pools, skipped pools and load error, plus readiness. `discovered` means
 * the provider is enabled, loaded, contributed a pool, and is installed or
 * logged in. A provider whose every pool lost to an earlier one of the same
 * name (an installed copy of a shipped template) is `shadowed`.
 */
export function discoverConnectors(bullswarmDir = defaultBullswarmDir(), opts = {}) {
  // Discovery is about what ships with the package plus what the operator
  // installed, so the packaged tiers load even under node:test; a caller may
  // still override by passing its own `packaged` or `dirs`.
  const { connectors, providers } = loadPoolProviders(bullswarmDir, { packaged: true, ...opts });
  return providers.map((entry) => {
    const base = {
      file: basename(entry.dir),
      name: entry.name,
      displayName: entry.displayName,
      tier: entry.tier,
      enabled: entry.enabled,
      pools: [...entry.pools],
      skipped: entry.skipped.map((x) => ({ ...x })),
      error: entry.error,
    };
    if (entry.error) return { ...base, broken: true, discovered: false };
    const pool = connectors[entry.pools[0]] ?? entry.template ?? {};
    const shadowed = entry.pools.length === 0 && entry.skipped.length > 0
      && entry.skipped.every((x) => x.reason === 'duplicate');
    const health = entry.enabled && entry.pools.length
      ? providerHealth(entry, pool)
      : { health: null, installed: null, loggedIn: null, hint: null };
    return {
      ...base,
      broken: false,
      shadowed,
      bin: pool.bin,
      ...health,
      discovered: health.installed === true || health.loggedIn === true,
      meter: pool.meter?.type ?? 'none',
      costRank: pool.costRank,
      lanes: pool.lanes,
      testFixture: pool.flags?.testFixture === true,
    };
  });
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

// --- repair ---------------------------------------------------------------

/**
 * Setup's connector repair. Until 0.29.0 this copied every packaged connector
 * into `<home>/connectors/`; nothing is copied any more, because the packaged
 * provider directories are what loads. What is left to repair is the copies
 * older installs still hold: an unmodified older copy is retired so the
 * packaged connector loads in its place, and an edited one is kept for
 * `bullswarm doctor` to report (src/lib/connector-copies.js).
 *
 * @returns {string[]} the copy files retired
 */
export function repairConnectors(bullswarmDir, opts = {}) {
  mkdirSync(join(bullswarmDir, 'connectors'), { recursive: true });
  return syncConnectorCopies(bullswarmDir, opts).map((action) => action.file);
}

// Forward-compatible metadata migration for existing installations. Preserve
// user-edited spawn commands and other connector quirks; only fill fields that
// did not exist in older published connector documents. The packaged sources
// are one per provider directory (connector-copies.js packagedConnectorSources),
// matched to the `<name>.json` a legacy copy was named by.
export function upgradeConnectorMetadata(bullswarmDir, {
  packagedDir = null,
} = {}) {
  const target = join(bullswarmDir, 'connectors');
  if (!existsSync(target)) return [];
  // `packagedDir` keeps the flat one-directory-of-json form for any caller
  // that supplies its own source; the default now walks the provider tiers.
  const sources = packagedDir
    ? (existsSync(packagedDir)
      ? readdirSync(packagedDir)
        .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
        .map((f) => [f, join(packagedDir, f)])
      : [])
    : packagedConnectorSources().map((source) => [source.file, source.connector]);
  const upgraded = [];
  for (const [f, packagedPath] of sources) {
    const dst = join(target, f);
    if (!existsSync(dst)) continue;
    try {
      const installed = JSON.parse(readFileSync(dst, 'utf8'));
      const packaged = JSON.parse(readFileSync(packagedPath, 'utf8'));
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
      // Usage-limit phrases are additive for the same reason auth signatures
      // are: an installation that predates the `quota` failure kind would
      // otherwise never learn its provider's own limit wording and would keep
      // reporting a throttle as a generic process failure.
      if (Array.isArray(packaged.quotaSignatures)) {
        const existing = Array.isArray(installed.quotaSignatures) ? installed.quotaSignatures : [];
        const merged = [...new Set([...existing, ...packaged.quotaSignatures])];
        if (!Array.isArray(installed.quotaSignatures) || JSON.stringify(merged) !== JSON.stringify(existing)) {
          installed.quotaSignatures = merged;
          changed = true;
        }
      }
      if (Array.isArray(packaged.throttleSignatures)) {
        const existing = Array.isArray(installed.throttleSignatures) ? installed.throttleSignatures : [];
        const merged = [...new Set([...existing, ...packaged.throttleSignatures])];
        if (!Array.isArray(installed.throttleSignatures) || JSON.stringify(merged) !== JSON.stringify(existing)) {
          installed.throttleSignatures = merged;
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
      // Packaged recommendation opt-outs are safety defaults, not routing
      // assignments. Prepend them so an existing broader profile cannot make
      // an unusually expensive model family an automatic default. The model
      // remains discoverable and explicitly selectable by the user.
      const recommendationGuards = (packaged.modelProfiles ?? [])
        .filter((profile) => typeof profile.autoRecommend === 'boolean');
      if (recommendationGuards.length) {
        installed.modelProfiles = Array.isArray(installed.modelProfiles) ? installed.modelProfiles : [];
        const missing = recommendationGuards.filter((guard) => !installed.modelProfiles.some((profile) => (
          profile.autoRecommend === guard.autoRecommend
          && ((guard.id && profile.id === guard.id) || (guard.match && profile.match === guard.match))
        )));
        if (missing.length) {
          installed.modelProfiles = [...missing, ...installed.modelProfiles];
          changed = true;
        }
      }
      // Reasoning depth is a whole connector-owned block (flag spelling,
      // accepted levels, per-tier defaults). Backfill it only when the
      // installation has none: a customized block is the user's answer to
      // how deeply this CLI should think, and must survive every upgrade.
      if (installed.reasoning == null && packaged.reasoning != null) {
        installed.reasoning = packaged.reasoning;
        if (packaged['$comment-reasoning'] != null && installed['$comment-reasoning'] == null) {
          installed['$comment-reasoning'] = packaged['$comment-reasoning'];
        }
        changed = true;
      }
      for (const field of ['modelDiscovery', 'knownModels', 'modelProfiles', 'modelFamilies', 'generationFallback', 'modelSelection', 'conversation', 'subscription', 'preferredConcurrency']) {
        if (installed[field] == null && packaged[field] != null) {
          installed[field] = packaged[field];
          changed = true;
        }
      }
      // A packaged profile the installed connector has never seen (keyed by
      // its `match` pattern or `id`) is inserted where the packaged order puts
      // it: right before the first installed entry that comes later in the
      // packaged list, else at the end. So a new specific entry lands ahead of
      // the packaged generic catch-all it was written to precede, but never
      // ahead of a profile the operator authored themselves. Entries the
      // installed connector already holds, edited or not, are never touched;
      // recommendation guards were handled above.
      if (Array.isArray(installed.modelProfiles) && Array.isArray(packaged.modelProfiles)) {
        const keyOf = (profile) => (profile?.match != null ? `match:${profile.match}`
          : profile?.id != null ? `id:${profile.id}` : null);
        // Guards are prepended by policy above, so they never anchor order.
        const packagedIndex = new Map(packaged.modelProfiles
          .map((profile, index) => [keyOf(profile), index])
          .filter(([key], index) => key != null && typeof packaged.modelProfiles[index].autoRecommend !== 'boolean'));
        packaged.modelProfiles.forEach((profile, index) => {
          const key = keyOf(profile);
          if (key == null || typeof profile.autoRecommend === 'boolean') return;
          if (installed.modelProfiles.some((entry) => keyOf(entry) === key)) return;
          let at = installed.modelProfiles.length;
          for (let j = 0; j < installed.modelProfiles.length; j += 1) {
            const laterInPackage = packagedIndex.get(keyOf(installed.modelProfiles[j]));
            if (laterInPackage != null && laterInPackage > index) { at = j; break; }
          }
          installed.modelProfiles.splice(at, 0, profile);
          changed = true;
        });
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
// identify deterministic test fixtures.
//
// The rule: a test-fixture pool is disabled only when state.json holds NO
// explicit `enabled` boolean for it. An explicit `enabled: true` is an
// operator decision and is left alone — the previous version overwrote it, so
// one `bullswarm pools` silently turned an intentionally enabled echo pool off
// (audit finding D1, 2026-09-09). The `testFixturesMigrated` flag is set
// either way, so the migration still runs exactly once.
export function migrateTestFixturePools(bullswarmDir) {
  // Cheap unlocked pre-check: this runs on the first-use path of every verb,
  // and once the flag is set there is nothing to write and no lock to take.
  if (loadState(bullswarmDir).config?.testFixturesMigrated === true) return [];

  const connectorsDir = join(bullswarmDir, 'connectors');
  let disabled = [];
  // One locked read-modify-write on a fresh load (S5), so the migration cannot
  // land on top of a concurrent `run` or `strategy` write.
  updateState(bullswarmDir, (state) => {
    state.config ??= {};
    if (state.config.testFixturesMigrated === true) return false; // another process got there first
    disabled = [];
    if (existsSync(connectorsDir)) {
      for (const file of readdirSync(connectorsDir)) {
        if (!file.endsWith('.json') || file.startsWith('_')) continue;
        try {
          const connector = JSON.parse(readFileSync(join(connectorsDir, file), 'utf8'));
          if (connector.flags?.testFixture !== true) continue;
          state.pools ??= {};
          state.pools[connector.name] ??= {};
          if (typeof state.pools[connector.name].enabled === 'boolean') continue;
          state.pools[connector.name].enabled = false;
          disabled.push(connector.name);
        } catch { /* connector repair owns malformed files */ }
      }
    }
    state.config.testFixturesMigrated = true;
    return true;
  });
  return disabled;
}

// --- auto-setup ---------------------------------------------------------------
// Zero-touch initialization: enable every discovered pool, write config,
// never prompt. Used by `setup --yes`, by any verb on first use, and by
// non-TTY invocations (agents). Humans who want choices run plain
// `bullswarm setup` on a terminal.

export function autoSetup(bullswarmDir, { reason = 'auto' } = {}) {
  const discovered = discoverConnectors(bullswarmDir);
  const repaired = repairConnectors(bullswarmDir);

  const usable = discovered.filter((d) => !d.broken && d.discovered && !d.testFixture);
  const enabled = new Set(usable.map((d) => d.name));

  const chosen = discovered.filter((d) => enabled.has(d.name));
  const table = suggestRoutingTable(chosen);

  mkdirSync(join(bullswarmDir, 'connectors'), { recursive: true });
  // Under the lock (S5). This is NOT first-use only: `bullswarm setup --yes`
  // and any non-TTY `bullswarm setup` re-run it over an existing state.json,
  // where a concurrent run's decision-log append is exactly what a stale copy
  // would drop. Pool entries are merged, never replaced, so a pool's
  // quarantine and meter survive a re-run.
  updateState(bullswarmDir, (state) => {
    state.pools ??= {};
    state.config ??= {};
    state.config.testFixturesMigrated = true;
    for (const d of discovered.filter((x) => !x.broken && !x.shadowed)) {
      state.pools[d.name] ??= {};
      state.pools[d.name].enabled = enabled.has(d.name);
    }
  });
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
    // Retire unmodified older copies first, so only edited ones get fills.
    try { syncConnectorCopies(bullswarmDir); } catch { /* never blocks a verb */ }
    upgradeConnectorMetadata(bullswarmDir);
    migrateTestFixturePools(bullswarmDir);
    return null;
  }
  return autoSetup(bullswarmDir, { reason: 'first-use' });
}

// --- the tier step ------------------------------------------------------------
// A rung is one pool's model plus its reasoning level for one effort tier, so
// the tier step shows both halves of every suggested rung — with the dated
// evidence line beside it when the benchmark datapack has one — and then asks
// one reasoning question per configured tier.
//
// Enter is a real answer here: it keeps the connector's own per-tier default,
// which is what the rung line above the questions already reports as the
// effective level. Nothing is written for a tier nobody answered, so a pool
// with no configured rung keeps behaving exactly as it does today.

/**
 * The datapack lookup, or null. Loaded through strategy-cli.js so the setup
 * wizard and `strategy rungs` read evidence exactly one way. The import stays
 * lazy for the same reason the refresh/apply import below is: strategy-cli.js
 * pulls in the whole strategy TUI, which a non-wizard setup never needs.
 */
async function rungEvidenceSource(bullswarmDir) {
  try {
    const { loadRungEvidence } = await import('./strategy-cli.js');
    return await loadRungEvidence(bullswarmDir);
  } catch {
    return null;
  }
}

function rungLine(row) {
  const evidence = formatRungEvidence(row.evidence);
  const reasoning = row.reasoning?.applied
    ? `${row.reasoning.applied} (${row.reasoning.source})`
    : `connector default (${row.reasoning?.source ?? 'none'})`;
  // A level the recommendation chose says why, e.g. `— no gpt-6 terra yet,
  // newest generation preferred`.
  const why = row.reasoning?.why ? ` — ${row.reasoning.why}` : '';
  return `    ${row.tier.padEnd(6)} ${row.pool}/${row.model}`
    + `  reasoning ${reasoning}${why}${evidence ? `  ${evidence}` : ''}`;
}

export async function configureTierRungs(bullswarmDir, prompter, {
  log = console.log, evidence,
} = {}) {
  const state = loadState(bullswarmDir);
  // Setup configures the rungs of what ships with the package, so the packaged
  // tiers load here for the same reason discoverConnectors asks for them.
  const { pools, connectors } = buildPools(bullswarmDir, Date.now(), {}, { packaged: true });
  const rungs = rungsFor({
    pools,
    connectors,
    strategy: state.strategy ?? {},
    decisionLog: state.decisionLog ?? [],
    evidence: evidence === undefined ? await rungEvidenceSource(bullswarmDir) : evidence,
  });
  // A pool with no eligible model on a tier has no rung to suggest; the full
  // diagnostic list (including why a pool is ineligible) is `strategy rungs`.
  const suggested = rungs.filter((row) => row.model);
  if (suggested.length) {
    log('  suggested rungs (model + reasoning per effort tier):');
    for (const row of suggested) log(rungLine(row));
  }

  // One question per CONFIGURED tier; a wizard run that skipped the strategy
  // autopilot has configured none, and still gets asked about all three.
  const configured = STRATEGY_TIERS.filter((tier) => (state.strategy?.configuredTiers ?? []).includes(tier));
  const asked = configured.length ? configured : STRATEGY_TIERS;
  const answers = {};
  const recommended = getRecommendedReasoning(state.strategy ?? {});
  for (const tier of asked) {
    // An answer here is a tier-wide level and replaces a recommended one;
    // Enter keeps whatever the rung lines above show.
    const kept = Object.values(recommended).some((tiers) => tiers[tier])
      ? 'the recommended level' : 'the connector default';
    const answer = (await prompter.question(
      `Reasoning for ${tier} [Enter keeps ${kept}]: `,
    )).trim().toLowerCase();
    if (!answer) continue;
    if (!REASONING_LEVELS.includes(answer)) {
      log(`  "${answer}" is not a reasoning level (${REASONING_LEVELS.join('/')}) - keeping the connector default`);
      continue;
    }
    answers[tier] = answer;
  }
  // Re-read under the lock (S5): the strategy autopilot step persists through
  // its own loader and the questions above waited on a human, so the wizard's
  // in-memory copy of state is stale by the time this runs. `updateState`
  // returns the state it actually wrote, which is what gets reported.
  const fresh = updateState(bullswarmDir, (state) => {
    state.strategy ??= {};
    for (const [tier, level] of Object.entries(answers)) {
      setStrategyReasoning(state.strategy, { tier, level });
    }
  });
  const stored = getStrategyReasoning(fresh.strategy);
  log('  reasoning levels:');
  for (const tier of asked) {
    log(`    ${tier.padEnd(6)} ${stored.tiers[tier] ?? 'connector default'}`);
  }
  return stored;
}

/**
 * What an apply did to rung reasoning, one line each: the levels it wrote
 * and why, and the operator levels it left alone. Shared by the wizard and
 * `setup --yes --strategy`.
 */
export function recommendedReasoningLines(reasoning) {
  const lines = [];
  for (const entry of reasoning?.written ?? []) {
    const rung = [entry.pool, entry.tier, entry.model].filter(Boolean).join(' ');
    lines.push(`rung reasoning: ${rung} · ${entry.level} reasoning${entry.why ? ` — ${entry.why}` : ''}`);
  }
  for (const entry of reasoning?.kept ?? []) {
    lines.push(`rung reasoning: ${entry.pool} ${entry.tier} kept your ${entry.level} (${entry.source})`);
  }
  return lines;
}

// --- the control center ---------------------------------------------------
// The strategy control center is what setup opens on a terminal. There are two
// callers — src/cli.js's interactive cmdSetup and the dashboard's `[edit]`
// hand-off — so the options live here once: the same title, the same analysis
// question, the same inventory loader and the same apply hook. Both imports
// stay lazy because a non-wizard setup, a non-TTY caller, and every verb that
// never opens a TUI must not pay for loading the strategy surface.
export async function openSetupTui({
  bullswarmDir,
  input = process.stdin,
  output = process.stdout,
  startDashboard = null, // test seam for the option pass-through
} = {}) {
  const { loadStrategyInventory, applyStrategyRecommendations } = await import('./strategy-cli.js');
  const start = startDashboard
    ?? (await import('./strategy-dashboard.js')).startStrategyDashboard;
  return start({
    bullswarmDir,
    input,
    output,
    title: 'Bullswarm setup',
    promptForAnalysis: true,
    loadInventory: ({ force, onProgress, analyze }) => loadStrategyInventory(bullswarmDir, {
      force, onProgress, useOpenRouter: analyze,
    }),
    applyRecommendations: () => {
      const report = loadState(bullswarmDir).strategy?.lastReport;
      if (report) applyStrategyRecommendations(bullswarmDir, report);
    },
  });
}

// --- wizard -------------------------------------------------------------------

export async function runWizard(bullswarmDir, opts = {}) {
  const state = loadState(bullswarmDir);
  const discovered = discoverConnectors(bullswarmDir);

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
      console.log(`  ${String(d.name ?? d.file).padEnd(14)} FAILED TO LOAD (${d.tier}): ${d.error}`);
      continue;
    }
    if (d.shadowed) continue;
    if (!d.enabled) {
      console.log(`  ${d.name.padEnd(14)} not enabled (${d.tier} provider)`);
      continue;
    }
    const meter =
      d.meter === 'none'
        ? 'quota: unmetered'
        : `quota: ${d.meter} window (burn rate: learning)`;
    console.log(
      `  ${d.name.padEnd(14)} ${d.discovered ? 'found' : 'not found'}  ${meter}${d.testFixture ? '  TEST FIXTURE' : ''}${d.hint ? `  (${d.hint})` : ''}`,
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
  // Under the lock (S5) on a fresh load: the pool questions above sat waiting
  // for a human, so the copy loaded at the top of the wizard is stale.
  updateState(bullswarmDir, (fresh) => {
    fresh.pools ??= {};
    fresh.config ??= {};
    fresh.config.testFixturesMigrated = true;
    for (const d of discovered.filter((x) => !x.broken && !x.shadowed)) {
      fresh.pools[d.name] ??= {};
      fresh.pools[d.name].enabled = enabled.includes(d.name);
    }
  });
  writeFileSync(
    join(bullswarmDir, 'routing.json'),
    `${JSON.stringify(table, null, 2)}\n`,
  );
  console.log(`\nWrote ${bullswarmDir}/state.json and routing.json`);
  if (repaired.length) console.log(`Retired older connector copies (the packaged connectors load instead): ${repaired.join(', ')}`);

  // 5. Optional execution style. Agent-decides is the neutral default: it
  // communicates preference without forcing a repository/worktree topology.
  const worktreeAnswer = (
    await rl.question('worktree isolation [agent/off/required] (default agent): ')
  ).trim().toLowerCase();
  const worktreeIsolation = worktreeAnswer === 'required'
    ? 'required' : worktreeAnswer === 'off' ? 'off' : 'agent-decides';
  updateState(bullswarmDir, (fresh) => {
    fresh.config ??= {};
    fresh.config.worktreeIsolation = worktreeIsolation;
  });
  console.log(`  worktree isolation: ${worktreeIsolation}`);

  // Strategy changes actual provider/model routing, so discovery plus daily
  // auto-application always requires an explicit setup answer.
  const strategyAnswer = (
    await rl.question('discover models and enable capability-aware daily strategy autopilot? [y/N] ')
  ).trim().toLowerCase();
  if (strategyAnswer === 'y' || strategyAnswer === 'yes') {
    const { refreshStrategy, applyStrategyRecommendations, applySummaryLines } = await import('./strategy-cli.js');
    const report = await refreshStrategy(bullswarmDir, { useOpenRouter: true });
    const applied = applyStrategyRecommendations(bullswarmDir, report);
    for (const line of applySummaryLines(applied)) console.log(`  ${line}`);
    for (const line of recommendedReasoningLines(applied.reasoning)) console.log(`  ${line}`);
  } else {
    console.log('  strategy autopilot: off (enable later with bullswarm strategy apply --yes)');
  }

  await configureTierRungs(bullswarmDir, rl);

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
