import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  suggestRoutingTable,
  applyIntegrationBlock,
  integrationBlockPresent,
  upgradeConnectorMetadata,
} from '../src/setup.js';

function tmp() {
  const d = mkdtempSync(join(tmpdir(), 'bullswarm-setup-'));
  return { d, cleanup: () => rmSync(d, { recursive: true, force: true }) };
}

test('routing table suggestion covers lanes from enabled pools', () => {
  const t = suggestRoutingTable([
    { name: 'codex', lanes: ['analyze', 'build', 'chore'] },
    { name: 'grok', lanes: ['build', 'chore'] },
    { name: 'command-code', lanes: ['build', 'chore'] },
  ]);
  assert.deepEqual(t.analyze.order, ['codex']); // command-code cannot serve analyze
  assert.ok(t.build.order.includes('grok'));
  assert.equal(t.chore.fallback, 'caller');
});

test('connector metadata upgrades add packaged capabilities without removing custom ones', () => {
  const { d, cleanup } = tmp();
  try {
    const dir = join(d, 'connectors');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'grok.json'), `${JSON.stringify({
      name: 'grok', capabilities: ['custom-local-capability'],
    }, null, 2)}\n`);
    assert.deepEqual(upgradeConnectorMetadata(d), ['grok.json']);
    const installed = JSON.parse(readFileSync(join(dir, 'grok.json'), 'utf8'));
    assert.ok(installed.capabilities.includes('custom-local-capability'));
    assert.ok(installed.capabilities.includes('workflow-planning'));
    assert.equal(installed.eventStream.format, 'jsonl');
    assert.equal(installed.outputExtraction.strategy, 'event-stream');
    assert.deepEqual(upgradeConnectorMetadata(d), []);
  } finally { cleanup(); }
});

test('connector metadata upgrades model paths without replacing custom event rules', () => {
  const { d, cleanup } = tmp();
  try {
    const dir = join(d, 'connectors');
    mkdirSync(dir, { recursive: true });
    const customRules = [{ rootMatch: { path: 'custom', equals: true }, kind: 'custom' }];
    writeFileSync(join(dir, 'claude-code.json'), `${JSON.stringify({
      name: 'claude-code',
      capabilities: ['strong-analysis', 'code-reading', 'file-editing', 'workflow-planning'],
      eventStream: { format: 'jsonl', args: ['--custom-stream'], rules: customRules },
      modelDiscovery: {}, knownModels: [], modelProfiles: [], modelSelection: {}, subscription: {},
    }, null, 2)}\n`);
    assert.deepEqual(upgradeConnectorMetadata(d), ['claude-code.json']);
    const installed = JSON.parse(readFileSync(join(dir, 'claude-code.json'), 'utf8'));
    assert.deepEqual(installed.eventStream.modelPaths, ['model', 'message.model']);
    assert.deepEqual(installed.eventStream.args, ['--custom-stream']);
    assert.deepEqual(installed.eventStream.rules, customRules);
  } finally { cleanup(); }
});

test('integration block: approval required, idempotent markers', () => {
  const { d, cleanup } = tmp();
  try {
    const file = join(d, 'CLAUDE.md');
    writeFileSync(file, '# My config\n\nexisting content\n');

    const denied = applyIntegrationBlock(file, { approved: false });
    assert.equal(denied.changed, false);

    applyIntegrationBlock(file, { approved: true });
    let text = readFileSync(file, 'utf8');
    assert.match(text, /bullswarm:begin v1/);
    assert.match(text, /existing content/); // preserved

    // idempotent re-run: no duplicate blocks
    const before = (text.match(/bullswarm:begin/g) ?? []).length;
    void before;
    applyIntegrationBlock(file, { approved: false }); // present -> skip
    // force re-check through the public API:
    assert.equal(integrationBlockPresent(file), true);

    // manual double-apply must not duplicate either
    applyIntegrationBlock(file, { approved: true });
    text = readFileSync(file, 'utf8');
    const count = (text.match(/bullswarm:begin v1/g) ?? []).length;
    // second approved apply strips the old block first — exactly one remains
    assert.equal(count, 1);
    assert.match(text, /existing content/);
  } finally {
    cleanup();
  }
});

test('integration block creates parent dirs for new AGENTS.md', () => {
  const { d, cleanup } = tmp();
  try {
    const file = join(d, 'sub', 'AGENTS.md');
    applyIntegrationBlock(file, { approved: true });
    assert.equal(existsSync(file), true);
    assert.match(readFileSync(file, 'utf8'), /bullswarm:begin v1/);
  } finally {
    cleanup();
  }
});
