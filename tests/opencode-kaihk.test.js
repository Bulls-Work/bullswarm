import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discoverRelayProviders,
  expandOpenCodeRelayConnectors,
  isRelayBaseUrl,
  poolNameForRelayProvider,
  retargetOpenCodeModel,
} from '../src/lib/opencode-relay.js';
import { parseRelayUsage } from '../src/meters/relay.js';

const baseConnector = JSON.parse(readFileSync(new URL('../connectors/opencode2.json', import.meta.url), 'utf8'));

test('Relay host detection and pool naming', () => {
  assert.equal(isRelayBaseUrl('https://api.relay.com/v1'), true);
  assert.equal(isRelayBaseUrl('https://api.openai.com/v1'), false);
  assert.equal(poolNameForRelayProvider('relay', 0), 'opencode2');
  assert.equal(poolNameForRelayProvider('relay-2', 1), 'opencode2:relay-2');
  assert.deepEqual(
    retargetOpenCodeModel(['opencode', 'run', '--model', 'relay/gpt-5.6-luna', '{taskFile}'], 'relay-2'),
    ['opencode', 'run', '--model', 'relay-2/gpt-5.6-luna', '{taskFile}'],
  );
  assert.deepEqual(
    retargetOpenCodeModel(['opencode', 'run', '--auto', '{taskFile}'], 'relay-2'),
    ['opencode', 'run', '--auto', '--model', 'relay-2/gpt-5.6-luna', '{taskFile}'],
  );
});

test('base OpenCode connector uses the installation default without Relay providers', () => {
  assert.equal(baseConnector.spawn.cmd.includes('--model'), false);
  assert.deepEqual(discoverRelayProviders({ providers: [] }), []);
  const connectors = { opencode2: structuredClone(baseConnector) };
  expandOpenCodeRelayConnectors(connectors, { providers: [] });
  assert.equal(connectors.opencode2.spawn.cmd.includes('--model'), false);
});

test('discoverRelayProviders reads OpenCode config, relay first', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-relay-'));
  const configPath = join(dir, 'opencode.json');
  try {
    writeFileSync(configPath, JSON.stringify({
      provider: {
        'relay-3': {
          options: { baseURL: 'https://api.relay.com/v1', apiKey: 'sk-cccc' },
        },
        bai: {
          options: { baseURL: 'https://api.b.ai/v1', apiKey: 'sk-bbbb' },
        },
        relay: {
          options: { baseURL: 'https://api.relay.com/v1', apiKey: 'sk-aaaa' },
        },
        'relay-2': {
          options: { baseURL: 'https://api.relay.com/v1', apiKey: 'sk-bbbb2' },
        },
      },
    }));
    const found = discoverRelayProviders({ configPath });
    assert.deepEqual(found.map((p) => p.id), ['relay', 'relay-2', 'relay-3']);
    assert.deepEqual(found.map((p) => p.pool), ['opencode2', 'opencode2:relay-2', 'opencode2:relay-3']);
    assert.equal(found[1].command, 'opencode run --auto --model relay-2/gpt-5.6-luna');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('expandOpenCodeRelayConnectors clones opencode2 per extra Relay provider', () => {
  const connectors = {
    opencode2: {
      name: 'opencode2',
      bin: 'opencode',
       spawn: { cmd: ['opencode', 'run', '--auto', '{taskFile}'] },
      flags: { stealth: false },
      meter: { type: 'none' },
    },
  };
  expandOpenCodeRelayConnectors(connectors, {
    providers: [
      { id: 'relay', pool: 'opencode2', command: 'opencode run --auto --model relay/gpt-5.6-luna', apiKey: 'sk-a' },
      { id: 'relay-2', pool: 'opencode2:relay-2', command: 'opencode run --auto --model relay-2/gpt-5.6-luna', apiKey: 'sk-b' },
    ],
  });
  assert.equal(connectors.opencode2.spawn.cmd.includes('relay/gpt-5.6-luna'), true);
  const extra = connectors['opencode2:relay-2'];
  assert.ok(extra);
  assert.equal(extra.name, 'opencode2:relay-2');
  assert.equal(extra.spawn.cmd.includes('relay-2/gpt-5.6-luna'), true);
  assert.equal(extra.flags.isCaller, false);
  assert.equal(extra.profile.providerId, 'relay-2');
});

test('parseRelayUsage converts billing hundredths-of-a-dollar and token quota units', () => {
  const snap = parseRelayUsage({
    token: {
      data: {
        expires_at: 1790752330,
        name: 'Staging',
        total_used: 479,
        unlimited_quota: true,
      },
    },
    billingUsage: { total_usage: 0.0958 },
    billingSub: { access_until: 1790752330 },
    pool: 'opencode2:relay-2',
    includedUsd: 50,
  });
  assert.equal(snap.pool, 'opencode2:relay-2');
  assert.equal(snap.used_usd, 0.000958);
  assert.equal(snap.unlimited_quota, true);
  assert.ok(snap.monthly.utilization < 0.01);
  assert.equal(snap.monthly.resets_at, new Date(1790752330 * 1000).toISOString());
});
