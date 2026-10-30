import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  compareCopy, connectorCopyWarnings, fingerprint, historyFileName, inspectConnectorCopies,
  packagedConnectorSources, retiredConnectorCopies, syncConnectorCopies,
} from '../src/lib/connector-copies.js';
import { loadProviders } from '../src/lib/providers.js';
import { loadState } from '../src/lib/state.js';
import { buildPools } from '../src/lib/config.js';
import { modelProfile } from '../src/lib/usage.js';
import { upgradeConnectorMetadata } from '../src/setup.js';
import { cmdStrategy } from '../src/strategy-cli.js';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
// Byte-for-byte what `bullswarm setup` 0.28.8 copied into <home>/connectors/.
const OLD = (name) => readFileSync(join(REPO, 'tests', 'fixtures', 'connector-copies', `${name}-0.28.8.json`), 'utf8');
// These tests are about the packaged tiers, which node:test otherwise hides.
const LOADER = { packaged: true, env: { ...process.env, BULLSWARM_DISABLE_CLAUDE_PROFILES: '1' } };

function home(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bullswarm-copies-'));
  mkdirSync(join(dir, 'connectors'), { recursive: true });
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, 'connectors', file), text);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('an older copy of a packaged connector is shadowed: the packaged prices are what load', () => {
  const h = home({ 'claude-code.json': OLD('claude-code') });
  try {
    const { connectors, providers } = loadProviders(h.dir, LOADER);
    const legacy = providers.find((p) => p.dir.endsWith(join('connectors', 'claude-code.json')));
    assert.deepEqual(legacy.skipped.map((s) => s.reason), ['duplicate']);
    // The copy still holds the Opus 5 catch-all row; the loaded pool does not use it.
    assert.match(OLD('claude-code'), /\^claude-opus-\(5\|4-\[5-8\]\)\$/);
    assert.deepEqual(modelProfile(connectors['claude-code'], 'claude-opus-5-5').pricing, {
      inputUsdPerMillion: 4, cacheReadUsdPerMillion: 0.2, cacheWrite5mUsdPerMillion: 5,
      cacheWrite1hUsdPerMillion: 8, outputUsdPerMillion: 20,
    });
  } finally { h.cleanup(); }
});

test('an unmodified older copy is retired, even after later versions filled fields into it', () => {
  const h = home({ 'claude-code.json': OLD('claude-code') });
  try {
    // What every verb of 0.29.0 and later did to the copy.
    upgradeConnectorMetadata(h.dir);
    const [copy] = inspectConnectorCopies(h.dir, { loader: LOADER });
    assert.equal(copy.status, 'older-copy');
    assert.deepEqual(copy.editedFields, []);
    assert.ok(copy.staleFields.includes('modelProfiles'), copy.staleFields.join(','));
    assert.deepEqual([copy.read, copy.servedBy], [false, 'claude-code']);

    const actions = syncConnectorCopies(h.dir, { loader: LOADER });
    assert.deepEqual(actions.map(({ file, action, servedBy }) => ({ file, action, servedBy })),
      [{ file: 'claude-code.json', action: 'retired', servedBy: 'claude-code' }]);
    assert.equal(existsSync(join(h.dir, 'connectors', 'claude-code.json')), false);
    assert.deepEqual(retiredConnectorCopies(h.dir), ['claude-code.json']);
    // Nothing is deleted: the retired file is the copy as it was.
    assert.equal(JSON.parse(readFileSync(join(h.dir, 'connectors', 'retired', 'claude-code.json'), 'utf8')).name, 'claude-code');
    // The loader no longer sees a copy, and a second sync has nothing to do.
    assert.equal(loadProviders(h.dir, LOADER).providers.some((p) => p.dir.includes(join('connectors', 'claude-code.json'))), false);
    assert.deepEqual(syncConnectorCopies(h.dir, { loader: LOADER }), []);
    assert.deepEqual(inspectConnectorCopies(h.dir, { loader: LOADER }), []);
  } finally { h.cleanup(); }
});

test('an unmodified older copy of a contrib connector hands its pool to the contrib provider', () => {
  const h = home({ 'command-code.json': OLD('command-code') });
  try {
    const [copy] = inspectConnectorCopies(h.dir, { loader: LOADER });
    // Not enabled in providers.json, so the stale copy is what defines the pool.
    assert.deepEqual([copy.status, copy.read, copy.servedBy], ['older-copy', true, null]);
    const [action] = syncConnectorCopies(h.dir, { loader: LOADER });
    assert.deepEqual([action.action, action.enabledProvider], ['retired', 'command-code']);
    assert.deepEqual(JSON.parse(readFileSync(join(h.dir, 'providers.json'), 'utf8')).enabled, ['command-code']);
    const { connectors, providers } = loadProviders(h.dir, LOADER);
    assert.ok(connectors['command-code'], 'the pool survives');
    assert.equal(providers.find((p) => p.pools.includes('command-code')).tier, 'contrib');
  } finally { h.cleanup(); }
});

test('an edited copy is kept and named with its stale fields', () => {
  const edited = JSON.parse(OLD('claude-code'));
  edited.spawn.cmd = [...edited.spawn.cmd, '--my-flag'];
  const h = home({ 'claude-code.json': `${JSON.stringify(edited, null, 2)}\n` });
  try {
    const [copy] = inspectConnectorCopies(h.dir, { loader: LOADER });
    assert.equal(copy.status, 'edited');
    assert.deepEqual(copy.editedFields, ['spawn']);
    assert.ok(copy.staleFields.includes('modelProfiles'));
    assert.deepEqual(syncConnectorCopies(h.dir, { loader: LOADER }), []);
    assert.equal(existsSync(join(h.dir, 'connectors', 'claude-code.json')), true, 'kept');
    const [line] = connectorCopyWarnings([copy]);
    assert.match(line, /claude-code\.json: your edited copy, kept \(edited: spawn\); stale: .*modelProfiles.*; not read; the packaged claude-code connector loads instead$/);
  } finally { h.cleanup(); }
});

test('a copy with no packaged counterpart, or one equal to the package, is left alone', () => {
  const current = readFileSync(join(REPO, 'src', 'providers', 'codex', 'connector.json'), 'utf8');
  const h = home({
    'codex.json': current,
    'my-agent.json': JSON.stringify({ name: 'my-agent', spawn: { cmd: ['my-agent', '{taskFile}'] } }),
  });
  try {
    const copies = inspectConnectorCopies(h.dir, { loader: LOADER });
    assert.deepEqual(copies.map((c) => [c.file, c.status]), [['codex.json', 'current']]);
    assert.deepEqual(syncConnectorCopies(h.dir, { loader: LOADER }), []);
    assert.deepEqual(connectorCopyWarnings(copies), []);
    assert.deepEqual(readdirSync(join(h.dir, 'connectors')).sort(), ['codex.json', 'my-agent.json']);
  } finally { h.cleanup(); }
});

test('a field removed from the copy that every version shipped counts as an edit', () => {
  const packaged = { name: 'x', bin: 'x', lanes: ['build'], added: 1 };
  const history = { fields: {
    name: { values: [fingerprint('x')] },
    bin: { values: [fingerprint('x')] },
    lanes: { values: [fingerprint(['build'])], items: [fingerprint('build')] },
    added: { absent: true, values: [fingerprint(1)] },
  } };
  // `added` is new in the package: its absence is an older copy's.
  assert.deepEqual(compareCopy({ name: 'x', bin: 'x', lanes: ['build'] }, packaged, history),
    { staleFields: ['added'], editedFields: [] });
  // `bin` always shipped: removing it is the operator's doing.
  assert.deepEqual(compareCopy({ name: 'x', lanes: ['build'], added: 1 }, packaged, history),
    { staleFields: [], editedFields: ['bin'] });
  // An emptied list is not a shipped value.
  assert.deepEqual(compareCopy({ name: 'x', bin: 'x', lanes: [], added: 1 }, packaged, history).editedFields, ['lanes']);
});

/** The packaged contrib connector, under the pre-rename pool name a 0.28 setup wrote. */
function preRenameOpenCodeCopy(extra = {}) {
  const copy = JSON.parse(readFileSync(join(REPO, 'providers', 'contrib', 'opencode', 'connector.json'), 'utf8'));
  copy.name = 'opencode2';
  Object.assign(copy, extra);
  return `${JSON.stringify(copy, null, 2)}\n`;
}

test('a pre-rename opencode2.json copy is not a live pool that ignores set-provider off', async () => {
  const unmodified = home({ 'opencode2.json': preRenameOpenCodeCopy() });
  try {
    const copies = inspectConnectorCopies(unmodified.dir, { loader: LOADER });
    assert.equal(copies.length, 1);
    assert.equal(copies[0].provider, 'opencode');
    assert.equal(copies[0].file, 'opencode2.json');
    assert.equal(copies[0].status, 'older-copy');
    const actions = syncConnectorCopies(unmodified.dir, { loader: LOADER });
    assert.deepEqual(actions.map(({ file, action }) => ({ file, action })),
      [{ file: 'opencode2.json', action: 'retired' }]);
    assert.equal(existsSync(join(unmodified.dir, 'connectors', 'opencode2.json')), false);
    assert.equal(loadProviders(unmodified.dir, LOADER).connectors.opencode2, undefined);
  } finally { unmodified.cleanup(); }
});

test('an edited pre-rename opencode2.json copy keeps set-provider off', async () => {
  const edited = home({ 'opencode2.json': preRenameOpenCodeCopy({ operatorNote: 'keep this copy' }) });
  try {
    const code = await cmdStrategy(['set-provider', 'opencode2', 'off', '--yes'], { bullswarmDir: edited.dir });
    assert.equal(code, 0);
    const pool = buildPools(edited.dir, Date.now(), {}, LOADER).pools.find((entry) => entry.name === 'opencode2');
    assert.equal(pool?.enabled, false);
    const [copy] = inspectConnectorCopies(edited.dir, { loader: LOADER });
    assert.equal(copy.provider, 'opencode');
    assert.equal(copy.status, 'edited');
    assert.match(connectorCopyWarnings([copy]).join('\n'), /opencode2\.json/);
    assert.equal(existsSync(join(edited.dir, 'connectors', 'opencode2.json')), true);
  } finally { edited.cleanup(); }
});

test('every shipped connector.json is covered by its connector-history.json', () => {
  // If this fails, regenerate: node scripts/connector-history.mjs
  for (const source of packagedConnectorSources()) {
    const connector = JSON.parse(readFileSync(source.connector, 'utf8'));
    const history = JSON.parse(readFileSync(join(source.dir, historyFileName), 'utf8'));
    assert.equal(history.connector, source.name);
    for (const [key, value] of Object.entries(connector)) {
      if (key.startsWith('$')) continue;
      assert.ok(history.fields[key]?.values.includes(fingerprint(value)),
        `${source.name}.${key} is not in ${historyFileName}; run node scripts/connector-history.mjs`);
    }
  }
});

function writeJson(dir, file, value) {
  writeFileSync(join(dir, file), `${JSON.stringify(value, null, 2)}\n`);
}
const readJson = (dir, file) => JSON.parse(readFileSync(join(dir, file), 'utf8'));

test('with no connector copy present, the opencode2 state, routing, providers and meters are renamed', () => {
  const h = home();
  try {
    mkdirSync(join(h.dir, 'meters'), { recursive: true });
    writeJson(h.dir, 'state.json', { version: 1, pools: { opencode2: { enabled: false } } });
    writeJson(h.dir, 'routing.json', { build: { order: ['opencode2', 'codex'] } });
    writeJson(h.dir, 'providers.json', { enabled: ['opencode2'] });
    writeJson(join(h.dir, 'meters'), 'opencode2.json', { pool: 'opencode2' });
    const state = loadState(h.dir);
    assert.deepEqual(Object.keys(state.pools), ['opencode']);
    assert.equal(state.pools.opencode.enabled, false);
    assert.deepEqual(readJson(h.dir, 'routing.json').build.order, ['opencode', 'codex']);
    assert.deepEqual(readJson(h.dir, 'providers.json').enabled, ['opencode']);
    assert.deepEqual(readdirSync(join(h.dir, 'meters')), ['opencode.json']);
  } finally { h.cleanup(); }
});

test('retiring a copy in the same process lets the next load rename the opencode2 keys', () => {
  const h = home({ 'opencode2.json': preRenameOpenCodeCopy() });
  try {
    writeJson(h.dir, 'state.json', { version: 1, pools: { opencode2: { enabled: false } } });
    assert.deepEqual(Object.keys(loadState(h.dir).pools), ['opencode2']);
    syncConnectorCopies(h.dir, { loader: LOADER });
    assert.deepEqual(Object.keys(loadState(h.dir).pools), ['opencode']);
    // Removing the file by hand behaves the same.
    writeFileSync(join(h.dir, 'connectors', 'opencode2.json'), preRenameOpenCodeCopy({ operatorNote: 'x' }));
    writeJson(h.dir, 'state.json', { version: 1, pools: { opencode2: { enabled: false } } });
    assert.deepEqual(Object.keys(loadState(h.dir).pools), ['opencode2']);
    rmSync(join(h.dir, 'connectors', 'opencode2.json'));
    assert.deepEqual(Object.keys(loadState(h.dir).pools), ['opencode']);
  } finally { h.cleanup(); }
});

test('providers.json keeps opencode2 enabled while an edited copy is live', () => {
  const h = home({ 'opencode2.json': preRenameOpenCodeCopy({ operatorNote: 'keep' }) });
  try {
    writeJson(h.dir, 'state.json', { version: 1, pools: { opencode2: { enabled: true } } });
    writeJson(h.dir, 'providers.json', { enabled: ['opencode2'] });
    const state = loadState(h.dir);
    assert.deepEqual(readJson(h.dir, 'providers.json').enabled, ['opencode2']);
    assert.deepEqual(Object.keys(state.pools), ['opencode2']);
    const pools = buildPools(h.dir, Date.now(), {}, LOADER).pools;
    assert.equal(pools.find((p) => p.name === 'opencode2')?.enabled, true);
    assert.equal(pools.find((p) => p.name === 'opencode')?.enabled ?? false, false);
  } finally { h.cleanup(); }
});

test('a malformed opencode2.json does not block the rename and is still reported as broken', () => {
  const h = home({ 'opencode2.json': '{bad' });
  try {
    writeJson(h.dir, 'state.json', { version: 1, pools: { opencode2: { enabled: false } } });
    assert.deepEqual(Object.keys(loadState(h.dir).pools), ['opencode']);
    const [copy] = inspectConnectorCopies(h.dir, { loader: LOADER });
    assert.equal(copy.status, 'unreadable');
    assert.match(connectorCopyWarnings([copy]).join('\n'), /opencode2\.json: not valid JSON/);
  } finally { h.cleanup(); }
});

test('routing and meters keep the opencode2 name while an edited copy is live', () => {
  const h = home({ 'opencode2.json': preRenameOpenCodeCopy({ operatorNote: 'keep' }) });
  try {
    mkdirSync(join(h.dir, 'meters', 'history'), { recursive: true });
    writeJson(h.dir, 'state.json', { version: 1, pools: { opencode2: { enabled: false }, 'opencode2:orbit': { enabled: true } } });
    writeJson(h.dir, 'routing.json', { build: { order: ['opencode2', 'opencode2:orbit', 'codex'] } });
    writeJson(join(h.dir, 'meters'), 'opencode2.json', { pool: 'opencode2' });
    writeFileSync(join(h.dir, 'meters', 'history', 'opencode2.jsonl'), `${JSON.stringify({ pool: 'opencode2' })}\n`);
    const state = loadState(h.dir);
    assert.deepEqual(Object.keys(state.pools).sort(), ['opencode2', 'opencode2:orbit']);
    assert.deepEqual(readJson(h.dir, 'routing.json').build.order, ['opencode2', 'opencode2:orbit', 'codex']);
    assert.deepEqual(readdirSync(join(h.dir, 'meters')).sort(), ['history', 'opencode2.json']);
    assert.deepEqual(readdirSync(join(h.dir, 'meters', 'history')), ['opencode2.jsonl']);
    assert.equal(readJson(join(h.dir, 'meters'), 'opencode2.json').pool, 'opencode2');
  } finally { h.cleanup(); }
});

test('a home with both opencode2.json and opencode.json copies keeps each pool apart', () => {
  const edited = preRenameOpenCodeCopy({ operatorNote: 'keep' });
  const packaged = readFileSync(join(REPO, 'providers', 'contrib', 'opencode', 'connector.json'), 'utf8');
  const h = home({ 'opencode2.json': edited, 'opencode.json': packaged });
  try {
    writeJson(h.dir, 'state.json', { version: 1, pools: { opencode2: { enabled: false }, opencode: { enabled: true } } });
    const state = loadState(h.dir);
    assert.deepEqual(state.pools, { opencode2: { enabled: false }, opencode: { enabled: true } });
    const copies = inspectConnectorCopies(h.dir, { loader: LOADER });
    assert.deepEqual(copies.map((c) => [c.file, c.status]).sort(), [['opencode.json', 'current'], ['opencode2.json', 'edited']]);
    assert.deepEqual(syncConnectorCopies(h.dir, { loader: LOADER }), []);
  } finally { h.cleanup(); }
});
