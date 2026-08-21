// bullswarm setup wizard — the front door.
//
// Doctrine:
//   U1. Discovery = binary on PATH + config dir present + (never) credential
//       entry. Burn rate starts EMPTY and is labeled "learning".
//   U2. The wizard suggests a routing table as an EDITABLE ARTIFACT, never a
//       questionnaire.
//   U3. CLAUDE.md / AGENTS.md integration is a DIFF with explicit approval
//       before any write, delimited by versioned bullswarm:begin/end
//       markers, idempotent on re-run.
//   U4. `bullswarm setup` on a configured machine reports state and repairs
//       broken connector files.

import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stdin as input } from 'node:process';
import { loadState, saveState } from './lib/state.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const MARKER_BEGIN = '<!-- bullswarm:begin v1 -->';
const MARKER_END = '<!-- bullswarm:end -->';

// --- prompting ------------------------------------------------------------
// Sequential prompts that work identically on a TTY and with piped answers.
// (readline/promises question() drops lines when stdin is a pipe: the second
// question re-arms after buffered data was already consumed. Preload pipes;
// readline only per-question on a real TTY.)
class Prompter {
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
  return `${MARKER_BEGIN}
## bullswarm offload policy

When a task fits a bounded lane, prefer offloading it:

    bullswarm run --lane <analyze|build|chore> --add-dir <repo-dir> --task-file <file> --json

Read the verdict JSON: ok:true -> use outFile; keepOnClaude:true -> do it in-session;
ok:false -> the why field names the failed gate. Delegate output is INPUT you verify,
never the answer. Final synthesis, architecture decisions, and live-context work stay
with you. Run \`bullswarm health\` after every offload round.
${MARKER_END}`;
}

export function applyIntegrationBlock(filePath, { approved }) {
  if (!approved) return { changed: false, reason: 'not approved' };
  let existing = '';
  try {
    existing = readFileSync(filePath, 'utf8');
  } catch {
    /* new file */
  }
  const stripped = existing
    .replace(new RegExp(`${MARKER_BEGIN}[\\s\\S]*?${MARKER_END}\n?`), '')
    .trimEnd();
  const next = stripped
    ? `${stripped}\n\n${integrationBlock()}\n`
    : `${integrationBlock()}\n`;
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, next);
  return { changed: true };
}

export function integrationBlockPresent(filePath) {
  try {
    return readFileSync(filePath, 'utf8').includes(MARKER_BEGIN);
  } catch {
    return false;
  }
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
    try {
      JSON.parse(readFileSync(dst, 'utf8'));
    } catch {
      broken = true;
    }
    if (!existsSync(dst) || broken) {
      copyFileSync(join(REPO_ROOT, 'connectors', f), dst);
      repaired.push(f);
    }
  }
  return repaired;
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
      `  ${d.name.padEnd(14)} ${d.discovered ? 'found' : 'not found'}  ${meter}`,
    );
  }
  console.log('');

  // 2. Toggle pools
  const enabled = [];
  for (const d of discovered.filter((x) => !x.broken && x.discovered)) {
    const ans = (await rl.question(`enable ${d.name}? [Y/n] `)).trim().toLowerCase();
    if (ans !== 'n') enabled.push(d.name);
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

  // 5. Integration blocks — diff + approval
  for (const [label, path] of [
    ['CLAUDE.md', join(process.env.HOME ?? '', '.claude', 'CLAUDE.md')],
    ['AGENTS.md', join(process.cwd(), 'AGENTS.md')],
  ]) {
    const present = integrationBlockPresent(path);
    const preview = present
      ? 'block already present (idempotent re-run)'
      : `will append to ${path}:\n\n${integrationBlock()}\n`;
    console.log(`\n${label}: ${preview}`);
    const ans = (
      await rl.question(`write ${label} integration block? [y/N] `)
    ).trim().toLowerCase();
    const result = applyIntegrationBlock(path, { approved: ans === 'y' && !present });
    console.log(result.changed ? `  wrote ${path}` : `  skipped ${label}`);
  }

  rl.close();
  console.log('\nSetup complete. Try: bullswarm pools');
  return 0;
}
