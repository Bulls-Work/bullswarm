import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync,
  rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { helpText } from '../src/help.js';
import {
  INTEGRATION_AGENTS, awarenessBlockPresent, installIntegration, integrationStatus,
  parseIntegrationAgents, removeIntegration, retireLegacyOffload,
} from '../src/integrate.js';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const BIN = join(REPO, 'bin', 'bullswarm.js');
const SKILL_SOURCE = join(REPO, 'skill');

function sandbox() {
  const home = mkdtempSync(join(tmpdir(), 'bullswarm-integrate-'));
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

test('integration installs one canonical skill and awareness rule for every agent', () => {
  const { home, cleanup } = sandbox();
  try {
    const result = installIntegration({ homeDir: home, skillSource: SKILL_SOURCE, approved: true });
    assert.equal(result.status.ok, true);
    for (const agent of ['codex', 'claude', 'grok']) {
      const entry = result.status.agents.find((item) => item.agent === agent);
      assert.equal(entry.skill.status, 'installed');
      assert.equal(lstatSync(entry.skillPath).isSymbolicLink(), true);
      assert.equal(resolve(join(entry.skillPath, '..'), readlinkSync(entry.skillPath)), SKILL_SOURCE);
      assert.equal(awarenessBlockPresent(entry.instructionsPath), true);
      const instructions = readFileSync(entry.instructionsPath, 'utf8');
      assert.match(instructions, /Read the `bullswarm` skill/);
      assert.match(instructions, /`bullswarm run`/);
      assert.match(instructions, /`bullswarm workflow goal`/);
      assert.match(instructions, /evidence, not authority/);
      assert.match(instructions, /BULLSWARM_DEPTH/);
    }
    assert.match(readFileSync(join(SKILL_SOURCE, 'SKILL.md'), 'utf8'), /name: bullswarm\n/);

    const again = installIntegration({ homeDir: home, skillSource: SKILL_SOURCE, approved: true });
    assert.equal(again.status.ok, true);
    assert.ok(again.changes.every((change) => change.skill.changed === false));
  } finally { cleanup(); }
});

test('integration upgrades old marker blocks, preserves user content, and removes only managed state', () => {
  const { home, cleanup } = sandbox();
  try {
    const instructions = join(home, '.codex', 'AGENTS.md');
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(instructions, '# User rule\n\n<!-- bullswarm:begin v1 -->\nold block\n<!-- bullswarm:end -->\n');

    installIntegration({
      homeDir: home, agents: ['codex'], skillSource: SKILL_SOURCE, approved: true,
    });
    const installed = readFileSync(instructions, 'utf8');
    assert.match(installed, /# User rule/);
    assert.doesNotMatch(installed, /old block/);
    assert.equal((installed.match(/bullswarm:begin/g) ?? []).length, 1);

    const removed = removeIntegration({
      homeDir: home, agents: ['codex'], skillSource: SKILL_SOURCE, approved: true,
    });
    assert.equal(removed.changes[0].skill.changed, true);
    assert.equal(existsSync(join(home, '.codex', 'skills', 'bullswarm')), false);
    assert.equal(readFileSync(instructions, 'utf8'), '# User rule\n');
  } finally { cleanup(); }
});

test('a skill link that reaches the packaged skill through another link is installed, not a conflict', () => {
  const { home, cleanup } = sandbox();
  try {
    // ~/.local/lib/node_modules/bullswarm -> <repo> is how `npm link` installs
    // the package; every agent's skills/bullswarm then points through it.
    const hop = join(home, '.local', 'lib', 'node_modules', 'bullswarm');
    mkdirSync(join(home, '.local', 'lib', 'node_modules'), { recursive: true });
    symlinkSync(REPO, hop);
    const skillPath = join(home, '.claude', 'skills', 'bullswarm');
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
    symlinkSync(join(hop, 'skill'), skillPath);
    const status = integrationStatus({ homeDir: home, agents: ['claude'], skillSource: SKILL_SOURCE });
    const entry = status.agents.find((item) => item.agent === 'claude');
    assert.equal(entry.skill.status, 'installed');
    assert.equal(entry.skill.target, join(hop, 'skill'));
    // And a link that ends somewhere else is still a conflict.
    rmSync(skillPath);
    mkdirSync(join(home, 'elsewhere'), { recursive: true });
    symlinkSync(join(home, 'elsewhere'), skillPath);
    const other = integrationStatus({ homeDir: home, agents: ['claude'], skillSource: SKILL_SOURCE });
    assert.equal(other.agents.find((item) => item.agent === 'claude').skill.status, 'conflict');
  } finally { cleanup(); }
});

test('integration refuses to replace an unmanaged skill directory', () => {
  const { home, cleanup } = sandbox();
  try {
    const conflict = join(home, '.claude', 'skills', 'bullswarm');
    mkdirSync(conflict, { recursive: true });
    writeFileSync(join(conflict, 'SKILL.md'), 'user-owned');
    assert.throws(() => installIntegration({
      homeDir: home, agents: ['claude'], skillSource: SKILL_SOURCE, approved: true,
    }), /refusing to replace non-Bullswarm skill path/);
    assert.equal(readFileSync(join(conflict, 'SKILL.md'), 'utf8'), 'user-owned');
  } finally { cleanup(); }
});

test('legacy offload retirement is explicit and recoverable', () => {
  const { home, cleanup } = sandbox();
  try {
    const legacy = join(home, '.claude', 'skills', 'offload');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'SKILL.md'), 'legacy');
    assert.throws(() => retireLegacyOffload({ homeDir: home }), /pass --yes/);
    const retired = retireLegacyOffload({
      homeDir: home, approved: true, now: new Date('2026-08-28T08:00:00.000Z'),
    });
    assert.equal(retired.changed, true);
    assert.equal(retired.recoverable, true);
    assert.equal(existsSync(legacy), false);
    assert.equal(readFileSync(join(retired.destination, 'SKILL.md'), 'utf8'), 'legacy');
  } finally { cleanup(); }
});

test('integrate CLI works non-interactively with an isolated HOME', () => {
  const { home, cleanup } = sandbox();
  try {
    const env = { ...process.env, HOME: home, BULLSWARM_HOME: join(home, '.bullswarm') };
    const install = spawnSync('node', [BIN, 'integrate', 'install', '--agents', 'codex,grok', '--yes', '--json'], {
      env, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(install.status, 0, install.stderr);
    assert.equal(JSON.parse(install.stdout).status.ok, true);

    const status = spawnSync('node', [BIN, 'integrate', 'status', '--agents', 'codex,grok', '--json'], {
      env, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).ok, true);
    assert.equal(integrationStatus({
      homeDir: home, agents: ['codex', 'grok'], skillSource: SKILL_SOURCE,
    }).ok, true);
  } finally { cleanup(); }
});

test('the Claude integration links the mod and sets the function-hooks flag, and remove undoes both', () => {
  const { home, cleanup } = sandbox();
  try {
    const settingsPath = join(home, '.claude', 'settings.json');
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ model: 'opus', env: { OTHER: 'kept' } }, null, 2));
    const result = installIntegration({ homeDir: home, skillSource: SKILL_SOURCE, approved: true, agents: ['claude'] });
    const claude = result.status.agents.find((item) => item.agent === 'claude');
    assert.equal(result.status.ok, true);
    assert.equal(claude.mod.status, 'installed');
    assert.equal(lstatSync(claude.modPath).isSymbolicLink(), true);
    assert.equal(resolve(join(claude.modPath, '..'), readlinkSync(claude.modPath)), join(REPO, 'mods', 'bullswarm'));
    assert.equal(claude.hooksFlag, true);
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    assert.equal(settings.env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS, '1');
    assert.equal(settings.env.OTHER, 'kept');
    assert.equal(settings.model, 'opus');

    const again = installIntegration({ homeDir: home, skillSource: SKILL_SOURCE, approved: true, agents: ['claude'] });
    assert.equal(again.changes[0].mod.changed, false);
    assert.equal(again.changes[0].hooksFlag.changed, false);

    const removed = removeIntegration({ homeDir: home, skillSource: SKILL_SOURCE, approved: true, agents: ['claude'] });
    assert.equal(removed.changes[0].mod.changed, true);
    assert.equal(existsSync(claude.modPath), false);
    const after = JSON.parse(readFileSync(settingsPath, 'utf8'));
    assert.equal(after.env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS, undefined);
    assert.equal(after.env.OTHER, 'kept');
    assert.equal(removed.status.ok, false);
  } finally { cleanup(); }
});

test('a settings.json that is not a JSON object is left alone and reported', () => {
  const { home, cleanup } = sandbox();
  try {
    const settingsPath = join(home, '.claude', 'settings.json');
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(settingsPath, '{ not json');
    const result = installIntegration({ homeDir: home, skillSource: SKILL_SOURCE, approved: true, agents: ['claude'] });
    assert.equal(result.changes[0].mod.changed, true);
    assert.equal(result.changes[0].hooksFlag.changed, false);
    assert.match(result.changes[0].hooksFlag.reason, /not a JSON object/);
    assert.equal(readFileSync(settingsPath, 'utf8'), '{ not json');
    assert.equal(result.status.ok, false);
  } finally { cleanup(); }
});

test('AGY integration creates a real skill directory with entry symlinks, manages ~/.gemini/config/AGENTS.md, and honours installed-by-default rules', () => {
  const { home, cleanup } = sandbox();
  try {
    assert.ok(INTEGRATION_AGENTS.includes('agy'));
    assert.deepEqual(parseIntegrationAgents('agy'), ['agy']);

    // Without agy on PATH or ~/.gemini/antigravity-cli in home, default "all" omits agy.
    const withoutAgy = integrationStatus({ homeDir: home, env: { PATH: '' }, skillSource: SKILL_SOURCE });
    assert.deepEqual(withoutAgy.agents.map((a) => a.agent), ['codex', 'claude', 'grok']);

    // With agy on PATH (fake executable in temp dir, never spawned), default "all" includes agy.
    const fakeBin = join(home, 'bin');
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(join(fakeBin, 'agy'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(fakeBin, 'agy'), 0o755);

    const installed = installIntegration({
      homeDir: home, env: { PATH: fakeBin }, skillSource: SKILL_SOURCE, approved: true,
    });
    assert.equal(installed.status.ok, true);
    assert.deepEqual(installed.status.agents.map((a) => a.agent), ['codex', 'claude', 'grok', 'agy']);

    const agy = installed.status.agents.find((a) => a.agent === 'agy');
    assert.equal(agy.skillPath, join(home, '.gemini', 'config', 'skills', 'bullswarm'));
    assert.equal(agy.instructionsPath, join(home, '.gemini', 'config', 'AGENTS.md'));
    assert.equal(agy.skill.status, 'installed');
    // Real folder, NOT a symlinked folder; top-level entries inside are symlinks to packaged skill entries.
    assert.equal(lstatSync(agy.skillPath).isSymbolicLink(), false);
    assert.equal(lstatSync(agy.skillPath).isDirectory(), true);
    const expectedEntries = readdirSync(SKILL_SOURCE).filter((n) => !n.startsWith('.')).sort();
    assert.deepEqual(readdirSync(agy.skillPath).sort(), expectedEntries);
    for (const entryName of expectedEntries) {
      const entryPath = join(agy.skillPath, entryName);
      assert.equal(lstatSync(entryPath).isSymbolicLink(), true, `${entryName} should be a symlink`);
      assert.equal(resolve(agy.skillPath, readlinkSync(entryPath)), join(SKILL_SOURCE, entryName));
    }
    assert.equal(awarenessBlockPresent(agy.instructionsPath), true);
    assert.match(readFileSync(agy.instructionsPath, 'utf8'), /BULLSWARM_DEPTH/);

    // Idempotent re-install.
    const again = installIntegration({
      homeDir: home, agents: ['agy'], skillSource: SKILL_SOURCE, approved: true,
    });
    assert.equal(again.changes[0].skill.changed, false);
    assert.equal(again.changes[0].awareness.changed, false);

    // Extra user file inside ~/.gemini/config/skills/bullswarm is preserved on remove;
    // once removed and clean, removing again removes the empty folder itself.
    writeFileSync(join(agy.skillPath, 'user-note.md'), 'keep me');
    const partialRemove = removeIntegration({
      homeDir: home, agents: ['agy'], skillSource: SKILL_SOURCE, approved: true,
    });
    assert.equal(partialRemove.changes[0].skill.changed, true);
    assert.equal(existsSync(join(agy.skillPath, 'SKILL.md')), false);
    assert.equal(readFileSync(join(agy.skillPath, 'user-note.md'), 'utf8'), 'keep me');
    rmSync(agy.skillPath, { recursive: true, force: true });

    installIntegration({ homeDir: home, agents: ['agy'], skillSource: SKILL_SOURCE, approved: true });
    const fullRemove = removeIntegration({
      homeDir: home, agents: ['agy'], skillSource: SKILL_SOURCE, approved: true,
    });
    assert.equal(fullRemove.changes[0].skill.changed, true);
    assert.equal(existsSync(agy.skillPath), false);
    assert.equal(awarenessBlockPresent(agy.instructionsPath), false);
  } finally { cleanup(); }
});

test('AGY integration refuses to touch a non-Bullswarm skill directory or symlink and works via CLI + docs', () => {
  const { home, cleanup } = sandbox();
  try {
    const conflict = join(home, '.gemini', 'config', 'skills', 'bullswarm');
    mkdirSync(conflict, { recursive: true });
    writeFileSync(join(conflict, 'SKILL.md'), 'custom-agy-skill');

    assert.throws(() => installIntegration({
      homeDir: home, agents: ['agy'], skillSource: SKILL_SOURCE, approved: true,
    }), /refusing to replace non-Bullswarm skill path/);
    const untouched = removeIntegration({
      homeDir: home, agents: ['agy'], skillSource: SKILL_SOURCE, approved: true,
    });
    assert.equal(untouched.changes[0].skill.changed, false);
    assert.equal(readFileSync(join(conflict, 'SKILL.md'), 'utf8'), 'custom-agy-skill');
    rmSync(conflict, { recursive: true, force: true });

    // CLI non-interactive --agents agy with isolated HOME.
    const env = { HOME: home, PATH: resolve(process.execPath, '..'), BULLSWARM_HOME: join(home, '.bullswarm') };
    const cliInstall = spawnSync(process.execPath, [BIN, 'integrate', 'install', '--agents', 'agy', '--yes', '--json'], {
      env, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(cliInstall.status, 0, cliInstall.stderr);
    assert.equal(JSON.parse(cliInstall.stdout).status.ok, true);

    const cliStatus = spawnSync(process.execPath, [BIN, 'integrate', 'status', '--agents', 'agy', '--json'], {
      env, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(cliStatus.status, 0, cliStatus.stderr);
    assert.equal(JSON.parse(cliStatus.stdout).ok, true);

    // Help and README table mention agy.
    assert.match(helpText(['integrate']), /agy/);
    const readme = readFileSync(join(REPO, 'README.md'), 'utf8');
    const tableSlice = readme.slice(readme.indexOf('## Supported agents and meters'));
    assert.match(tableSlice, /\|\s*AGY\b.*\|\s*Built in\s*\|/);
  } finally { cleanup(); }
});
