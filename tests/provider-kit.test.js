import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import {
  REASONING_LEVELS, clonePool, opencodeVariants, bearerJson, MeterError, snapshot, pct,
} from '../src/provider-kit.js';
import { REASONING_LEVELS as CORE_LEVELS } from '../src/lib/reasoning.js';

const template = {
  name: 'opencode',
  spawn: { cmd: ['opencode', 'run', '--auto', '{taskFile}'], cwdMode: 'pwd' },
  modelSelection: { flag: '--model', mode: 'replace-or-append' },
  env: { KEEP: '1' },
  flags: { stealth: false, isCaller: true },
};

test('REASONING_LEVELS is the core scale', () => {
  assert.equal(REASONING_LEVELS, CORE_LEVELS);
});

test('clonePool deep-copies, merges overrides and clears isCaller', () => {
  const pool = clonePool(template, { name: 'relay:a', env: { OTHER: '2' } });
  assert.equal(pool.name, 'relay:a');
  assert.deepEqual(pool.env, { OTHER: '2' });
  assert.deepEqual(pool.flags, { stealth: false, isCaller: false });
  assert.deepEqual(pool.spawn.cmd, template.spawn.cmd);
  pool.spawn.cmd.push('--mutated');
  assert.deepEqual(template.spawn.cmd, ['opencode', 'run', '--auto', '{taskFile}']);
  assert.equal(template.flags.isCaller, true);
  assert.throws(() => clonePool(null), TypeError);
});

test('clonePool pins the model like retargetOpenCodeModel: insert before {taskFile}, else replace', () => {
  const inserted = clonePool(template, { model: 'relay-2/gpt-5.6-luna' });
  assert.equal(inserted.model, 'relay-2/gpt-5.6-luna');
  assert.deepEqual(inserted.spawn.cmd, ['opencode', 'run', '--auto', '--model', 'relay-2/gpt-5.6-luna', '{taskFile}']);

  const pinned = { ...template, spawn: { cmd: ['opencode', 'run', '--model', 'old/m', '{taskFile}'] } };
  assert.deepEqual(clonePool(pinned, { model: 'b/m' }).spawn.cmd, ['opencode', 'run', '--model', 'b/m', '{taskFile}']);

  const noTask = { ...template, spawn: { cmd: ['cli', 'go'] } };
  assert.deepEqual(clonePool(noTask, { model: 'x' }).spawn.cmd, ['cli', 'go', '--model', 'x']);

  const trailing = { ...template, spawn: { cmd: ['cli', '--model'] } };
  assert.deepEqual(clonePool(trailing, { model: 'x' }).spawn.cmd, ['cli', '--model', 'x']);
});

test('clonePool uses the template modelSelection flag, defaulting to --model', () => {
  const custom = { ...template, modelSelection: { flag: '-m', mode: 'replace-or-append' } };
  assert.deepEqual(clonePool(custom, { model: 'x' }).spawn.cmd, ['opencode', 'run', '--auto', '-m', 'x', '{taskFile}']);
  const bare = { name: 't', spawn: { cmd: ['t', '{taskFile}'] } };
  assert.deepEqual(clonePool(bare, { model: 'y' }).spawn.cmd, ['t', '--model', 'y', '{taskFile}']);
  assert.deepEqual(clonePool(bare, { name: 't:2' }).spawn.cmd, ['t', '{taskFile}']);
});

test('opencodeVariants declares every reasoning level per model, verbatim', () => {
  // The shape opencode merges over its config file: one variant per level, on
  // each named model, under this provider id. A single id is accepted as well
  // as a list, and blank entries are dropped rather than declared.
  assert.equal(
    opencodeVariants('relay-2', 'model-a'),
    opencodeVariants('relay-2', ['model-a']),
  );
  assert.deepEqual(
    Object.keys(JSON.parse(opencodeVariants('relay', ['m1', 'm2'])).provider.relay.models),
    ['m1', 'm2'],
  );
  assert.deepEqual(
    Object.keys(JSON.parse(opencodeVariants('a', ['m', '', '  ', null])).provider.a.models),
    ['m'],
  );
  const parsed = JSON.parse(opencodeVariants('a', ['m']));
  assert.deepEqual(Object.keys(parsed.provider.a.models.m.variants), REASONING_LEVELS);
  assert.deepEqual(parsed.provider.a.models.m.variants.xhigh, { reasoningEffort: 'xhigh' });
  // No vendor default: nothing listed declares nothing.
  assert.equal(opencodeVariants('a', []), '{"provider":{"a":{"models":{}}}}');
});

test('MeterError carries message, code and name', () => {
  const err = new MeterError('boom', 'http');
  assert.ok(err instanceof Error);
  assert.equal(err.message, 'boom');
  assert.equal(err.code, 'http');
  assert.equal(err.name, 'MeterError');
});

test('snapshot fills captured_at and empty windows, and passes optional fields', () => {
  const before = Date.now();
  const s = snapshot({ pool: 'relay', monthly: { utilization: 25, resets_at: null }, used_usd: 12.5 });
  assert.ok(Date.parse(s.captured_at) >= before - 1000);
  assert.equal(s.pool, 'relay');
  assert.deepEqual(s.five_hour, { utilization: null, resets_at: null });
  assert.deepEqual(s.seven_day, { utilization: null, resets_at: null });
  assert.deepEqual(s.monthly, { utilization: 25, resets_at: null });
  assert.equal(s.used_usd, 12.5);
  assert.equal('plan_type' in s, false);
  assert.equal('monthly_quota' in s, false);
  const q = snapshot({ pool: 'p', plan_type: null, monthly_quota: { used: 1, limit: 2, remaining: 1, unit: 'credits' } });
  assert.equal(q.plan_type, null);
  assert.deepEqual(q.monthly_quota, { used: 1, limit: 2, remaining: 1, unit: 'credits' });
});

test('pct clamps to 0..100 and is null without a positive cap', () => {
  assert.equal(pct(12.5, 50), 25);
  assert.equal(pct(80, 50), 100);
  assert.equal(pct(-5, 50), 0);
  assert.equal(pct(0, 50), 0);
  assert.equal(pct(1, 0), null);
  assert.equal(pct(1, -3), null);
  assert.equal(pct(1, null), null);
  assert.equal(pct(null, 10), null);
  assert.equal(pct('x', 10), null);
});

async function withServer(handler, fn) {
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('bearerJson sends the bearer token and extra headers and returns JSON', async () => {
  await withServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ auth: req.headers.authorization, accept: req.headers.accept, extra: req.headers['x-extra'] }));
  }, async (base) => {
    const body = await bearerJson(`${base}/usage`, 'sk-test', { headers: { 'X-Extra': 'yes' } });
    assert.deepEqual(body, { auth: 'Bearer sk-test', accept: 'application/json', extra: 'yes' });
  });
});

test('bearerJson throws MeterError http, parse and network', async () => {
  await withServer((req, res) => {
    if (req.url === '/denied') { res.statusCode = 401; res.end('no'); return; }
    res.end('not json');
  }, async (base) => {
    await assert.rejects(bearerJson(`${base}/denied`, 'sk-secret'), (err) => {
      assert.ok(err instanceof MeterError);
      assert.equal(err.code, 'http');
      assert.match(err.message, /401/);
      assert.doesNotMatch(err.message, /sk-secret/);
      return true;
    });
    await assert.rejects(bearerJson(`${base}/text`, 't'), (err) => err instanceof MeterError && err.code === 'parse');
  });
  const closed = await withServer(() => {}, async (base) => base);
  await assert.rejects(bearerJson(`${closed}/gone`, 't'), (err) => err instanceof MeterError && err.code === 'network');
});
