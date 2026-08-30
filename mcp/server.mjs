#!/usr/bin/env node
// bullswarm MCP server — exposes run/health/pools over stdio JSON-RPC 2.0.
// One implementation; every MCP client (Claude Code, Codex, Cursor, …)
// can offload without shell plumbing.

import { createInterface } from 'node:readline';
import { main } from '../src/cli.js';
import { getVersion } from '../src/lib/version.js';

const VERSION = getVersion();

const TOOLS = [
  {
    name: 'bullswarm_run',
    description:
      'Offload a task to the best available coding-agent pool, routed by quota pace and verified by content. Returns a verdict: ok=true means read outFile; keepOnClaude=true means do it in-session; ok=false means the why field names the failed gate.',
    inputSchema: {
      type: 'object',
      properties: {
        lane: { type: 'string', enum: ['analyze', 'build', 'chore'] },
        task: { type: 'string', description: 'The task text to delegate.' },
        addDir: { type: 'string', description: 'Target repository directory.' },
        timeout: { type: 'number' },
      },
      required: ['lane', 'task'],
    },
  },
  {
    name: 'bullswarm_health',
    description:
      'Re-judge saved offload outputs against their verdicts; report verify-gate failures and quarantine clusters. Run after every offload round.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'bullswarm_pools',
    description: 'Show each pool meter state, pace position, and quarantine status.',
    inputSchema: { type: 'object', properties: {} },
  },
];

function write(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function result(id, r) {
  write({ jsonrpc: '2.0', id, result: r });
}

let inputClosed = false;
let pendingCalls = 0;

function exitWhenDrained() {
  if (inputClosed && pendingCalls === 0) process.exit(0);
}

async function callTool(name, args) {
  // Reuse the CLI verbs but capture stdout instead of leaking to our protocol
  // stream: swap console.log for the duration of the call.
  const chunks = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => chunks.push(a.join(' '));
  console.error = () => {};
  try {
    const argv =
      name === 'bullswarm_run'
        ? [
            'run',
            '--lane',
            args.lane,
            '--json',
            ...(args.addDir ? ['--add-dir', args.addDir] : []),
            ...(args.timeout ? ['--timeout', String(args.timeout)] : []),
            ...args.task.split(' '),
          ]
        : name === 'bullswarm_health'
          ? ['health']
          : ['pools', '--json'];
    const code = await main(argv);
    let parsed = null;
    try {
      parsed = JSON.parse(chunks.join('\n'));
    } catch {
      parsed = chunks.join('\n');
    }
    return { content: [{ type: 'text', text: JSON.stringify({ exitCode: code, verdict: parsed }, null, 2) }] };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

function handleMessage(line) {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const { id, method, params } = msg;

  switch (method) {
    case 'initialize':
      result(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'bullswarm', version: VERSION },
      });
      break;
    case 'notifications/initialized':
      break; // no response for notifications
    case 'tools/list':
      result(id, { tools: TOOLS });
      break;
    case 'tools/call':
      pendingCalls += 1;
      callTool(params.name, params.arguments ?? {})
        .then((r) => id != null && result(id, r))
        .catch((err) =>
          id != null &&
          write({
            jsonrpc: '2.0',
            id,
            error: { code: -32603, message: err?.message ?? 'internal error' },
          }),
        )
        .finally(() => {
          pendingCalls -= 1;
          exitWhenDrained();
        });
      break;
    case 'ping':
      result(id, {});
      break;
    default:
      if (id != null) {
        write({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        });
      }
  }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', handleMessage);
rl.on('close', () => {
  inputClosed = true;
  exitWhenDrained();
});
