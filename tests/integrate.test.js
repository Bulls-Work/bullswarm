import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync,
  rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  awarenessBlockPresent, installIntegration, integrationStatus,
  removeIntegration, retireLegacyOffload,
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
      assert.match(instructions, /read the `bullswarm` skill/);
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
