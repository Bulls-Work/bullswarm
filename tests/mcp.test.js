import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
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
    const timer = setTimeout(() => {
      child.kill();
      resolveP(lines.length ? lines : (() => { throw new Error(`MCP timeout. stderr: ${stderr}`); })());
    }, timeoutMs);
    // settle early once every non-notification has a response
    const poll = setInterval(() => {
      const ids = messages.filter((m) => m.id != null).map((m) => m.id);
      if (ids.every((id) => lines.some((l) => l.id === id))) {
        clearTimeout(timer);
        clearInterval(poll);
        child.kill();
        resolveP(lines);
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
