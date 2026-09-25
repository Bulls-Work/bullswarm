import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(ROOT, 'mcp/server.mjs');

function rpc(messages, timeoutMs = 8000, env = {}) {
  return new Promise((resolveP, rejectP) => {
    const child = spawn('node', [SERVER], {
      stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env },
    });
    let buf = '';
    const lines = [];
    child.stdout.on('data', (d) => {
      buf += d;
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.trim()) lines.push(JSON.parse(line));
      }
    });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', rejectP);
    child.stdin.write(messages.map((m) => `${JSON.stringify(m)}\n`).join(''));
    child.stdin.end();
    let settled = false;
    let poll;
    const finish = (value, error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      child.kill();
      if (error) rejectP(error);
      else resolveP(value);
    };
    const timer = setTimeout(() => {
      finish(null, new Error(`MCP timeout after ${timeoutMs}ms; received ids: ${lines.map((line) => line.id).filter((id) => id != null).join(', ') || 'none'}. stderr: ${stderr}`));
    }, timeoutMs);
    // settle early once every non-notification has a response
    poll = setInterval(() => {
      const ids = messages.filter((m) => m.id != null).map((m) => m.id);
      if (ids.every((id) => lines.some((l) => l.id === id))) {
        finish(lines);
      }
    }, 50);
  });
}

test('MCP handshake: initialize -> tools/list', async () => {
  const res = await rpc([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ]);
  const init = res.find((r) => r.id === 1);
  assert.equal(init.result.serverInfo.name, 'bullswarm');
  const tools = res.find((r) => r.id === 2);
  assert.deepEqual(
    tools.result.tools.map((t) => t.name),
    ['bullswarm_run', 'bullswarm_health', 'bullswarm_pools'],
  );
});

test('MCP pools tool returns structured JSON', async () => {
  // Prime an isolated meter cache so the pools call never hits the network
  // and the offline suite never writes to the user's real Bullswarm home.
  const { MeterCache } = await import('../src/meters/framework.js');
  const bullswarmHome = mkdtempSync(join(tmpdir(), 'bullswarm-mcp-'));
  try {
    const cache = new MeterCache(join(bullswarmHome, 'meters'));
    for (const p of ['codex', 'grok', 'command-code', 'claude-code']) {
      // Overwrite unconditionally: a cache older than FRESH_MS (5min) would
      // trigger live polls inside the MCP child and flake the test.
      cache.put(p, {
        captured_at: new Date().toISOString(),
        pool: p,
        five_hour: { utilization: null, resets_at: null },
        seven_day: {
          utilization: 0,
          resets_at: new Date(Date.now() + 86_400_000).toISOString(),
        },
        monthly: null,
      });
    }

    const res = await rpc([
      { jsonrpc: '2.0', id: 10, method: 'initialize', params: {} },
      {
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: { name: 'bullswarm_pools', arguments: {} },
      },
    ], 30000, {
      BULLSWARM_HOME: bullswarmHome,
      BULLSWARM_DISABLE_CLAUDE_PROFILES: '1',
    });
    const call = res.find((r) => r.id === 11);
    const payload = JSON.parse(call.result.content[0].text);
    assert.equal(payload.exitCode, 0);
    assert.ok(Array.isArray(payload.verdict.pools));
  } finally {
    rmSync(bullswarmHome, { recursive: true, force: true });
  }
}, { timeout: 40000 });

// Typed answers pass straight through to `run`: a bad schema comes back as a
// usage error with its reason, before any worker starts, and a task that
// starts with `--` is task text, not a flag. The calls overlap on purpose:
// each one must get its own output back (they used to lose it all).
test('MCP run passes answerSchema and answerFile through; overlapping calls keep their own output', async () => {
  const bullswarmHome = mkdtempSync(join(tmpdir(), 'bullswarm-mcp-answer-'));
  try {
    const badSchema = join(bullswarmHome, 'bad.json');
    writeFileSync(badSchema, JSON.stringify({ type: 'object', if: {} }));
    const call = (id, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'bullswarm_run', arguments: args } });
    const res = await rpc([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      call(3, { lane: 'analyze', task: '--not-a-flag count things', answerSchema: badSchema }),
      call(4, { lane: 'analyze', task: 'count things', answerFile: join(bullswarmHome, 'a.json') }),
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'bullswarm_pools', arguments: {} } },
    ], 30000, { BULLSWARM_HOME: bullswarmHome, BULLSWARM_NO_PACKAGED_PROVIDERS: '1' });
    const run = res.find((r) => r.id === 2).result.tools.find((t) => t.name === 'bullswarm_run');
    assert.equal(run.inputSchema.properties.answerSchema.type, 'string');
    assert.equal(run.inputSchema.properties.answerFile.type, 'string');

    const bad = JSON.parse(res.find((r) => r.id === 3).result.content[0].text);
    assert.equal(bad.exitCode, 2);
    assert.match(bad.stderr, /--answer-schema: unsupported keyword "if"/);
    const alone = JSON.parse(res.find((r) => r.id === 4).result.content[0].text);
    assert.equal(alone.exitCode, 2);
    assert.match(alone.stderr, /--answer-file needs --answer-schema/);
    const pools = JSON.parse(res.find((r) => r.id === 5).result.content[0].text);
    assert.equal(pools.exitCode, 0);
    assert.ok(Array.isArray(pools.verdict.pools), 'the overlapping pools call still gets its own JSON');
    assert.equal(pools.stderr, undefined);
  } finally {
    rmSync(bullswarmHome, { recursive: true, force: true });
  }
}, { timeout: 40000 });

// A flow step through MCP: noCaller sends it to a delegate, and the checked
// answer comes back in the verdict, as it does from the CLI.
test('MCP run with noCaller and answerSchema returns the checked answer', async () => {
  const bullswarmHome = mkdtempSync(join(tmpdir(), 'bullswarm-mcp-typed-'));
  try {
    mkdirSync(join(bullswarmHome, 'connectors'), { recursive: true });
    writeFileSync(join(bullswarmHome, 'connectors', 'echo.json'), readFileSync(join(ROOT, 'src', 'providers', 'echo', 'connector.json')));
    writeFileSync(join(bullswarmHome, 'state.json'), `${JSON.stringify({
      version: 1,
      pools: { echo: { enabled: true } },
      incumbents: {},
      decisionLog: [],
      config: { depthLimit: 2, callerName: 'claude-code', testFixturesMigrated: true },
    }, null, 2)}\n`);
    const schema = join(bullswarmHome, 'n.schema.json');
    writeFileSync(schema, JSON.stringify({ type: 'object', required: ['n'], properties: { n: { type: 'integer' } } }));
    const res = await rpc([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'bullswarm_run', arguments: {
        lane: 'build', task: 'ANSWER:{"n": 7}', addDir: bullswarmHome, answerSchema: schema, noCaller: true,
      } } },
    ], 30000, { BULLSWARM_HOME: bullswarmHome, BULLSWARM_NO_PACKAGED_PROVIDERS: '1' });
    const payload = JSON.parse(res.find((r) => r.id === 2).result.content[0].text);
    assert.equal(payload.exitCode, 0, JSON.stringify(payload));
    assert.equal(payload.verdict.keepOnClaude, false);
    assert.equal(payload.verdict.pick.pool, 'echo');
    assert.deepEqual(payload.verdict.answer, { n: 7 });
    assert.equal(payload.verdict.answerCheck.ok, true);

    // With no pool to take it, the step comes back to the caller unless
    // noCaller says it must not.
    const state = JSON.parse(readFileSync(join(bullswarmHome, 'state.json'), 'utf8'));
    state.pools.echo.enabled = false;
    writeFileSync(join(bullswarmHome, 'state.json'), JSON.stringify(state));
    const step = (id, noCaller) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'bullswarm_run', arguments: {
      lane: 'build', task: 'x', answerSchema: schema, ...(noCaller ? { noCaller } : {}),
    } } });
    const off = await rpc([{ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, step(2, true), step(3, false)],
      30000, { BULLSWARM_HOME: bullswarmHome, BULLSWARM_NO_PACKAGED_PROVIDERS: '1' });
    const strict = JSON.parse(off.find((r) => r.id === 2).result.content[0].text);
    assert.equal(strict.exitCode, 1);
    assert.equal(strict.verdict.keepOnClaude, false);
    const kept = JSON.parse(off.find((r) => r.id === 3).result.content[0].text);
    assert.equal(kept.exitCode, 0);
    assert.equal(kept.verdict.keepOnClaude, true);
  } finally {
    rmSync(bullswarmHome, { recursive: true, force: true });
  }
}, { timeout: 40000 });
