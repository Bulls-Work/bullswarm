#!/usr/bin/env node
// bullswarm MCP server — exposes run/health/pools over stdio JSON-RPC 2.0.
// One implementation; every MCP client (Claude Code, Codex, Cursor, …)
// can offload without shell plumbing.

import { AsyncLocalStorage } from 'node:async_hooks';
import { createInterface } from 'node:readline';
import { main } from '../src/cli.js';
import { getVersion } from '../src/lib/version.js';

const VERSION = getVersion();

const TOOLS = [
  {
    name: 'bullswarm_run',
    description:
      'Offload a task to the best available coding-agent pool, routed by quota pace and verified by content. Returns a verdict: ok=true means read outFile; keepOnClaude=true means do it in-session; ok=false means the why field names the failed gate. With answerSchema, ok=true also means the answer field holds JSON that matched the schema; an invalid answer is ok=false with answerCheck.errors, and nothing is retried.',
    inputSchema: {
      type: 'object',
      properties: {
        lane: { type: 'string', enum: ['analyze', 'build', 'chore'] },
        task: { type: 'string', description: 'The task text to delegate.' },
        addDir: { type: 'string', description: 'Target repository directory.' },
        timeout: { type: 'number' },
        answerSchema: { type: 'string', description: 'Absolute path to a JSON Schema file the final answer must match. A bad schema is exitCode 2 before any worker starts.' },
        answerFile: { type: 'string', description: 'Absolute path where the worker writes its JSON answer (needs answerSchema). Default: next to the run output.' },
        noCaller: { type: 'boolean', description: 'Always send the task to a delegate, never keepOnClaude. Use it for each step of a flow you drive.' },
      },
      required: ['lane', 'task'],
    },
  },
  {
    name: 'bullswarm_health',
    description:
      'Re-judge saved offload outputs against their verdicts; report verify-gate failures. Run after every offload round.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'bullswarm_pools',
    description: 'Show the meter state and pace position of each pool.',
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

// Reuse the CLI verbs but capture their console output instead of leaking it
// into our protocol stream. Each call captures into its own buffer, so calls
// that overlap (a caller running several steps at once) never read each
// other's verdicts. Swapping console.log per call lost them all.
const captured = new AsyncLocalStorage();
for (const method of ['log', 'error']) {
  const original = console[method].bind(console);
  console[method] = (...a) => {
    const buffer = captured.getStore();
    if (buffer) buffer[method].push(a.join(' '));
    else original(...a);
  };
}

function callTool(name, args) {
  const buffer = { log: [], error: [] };
  return captured.run(buffer, () => runTool(name, args, buffer));
}

async function runTool(name, args, { log: chunks, error: errors }) {
  // Every caller value travels as one `--name=value` token, so a task or path
  // that starts with `--` is never read as a flag.
  const argv =
    name === 'bullswarm_run'
      ? [
          'run',
          '--lane',
          args.lane,
          '--json',
          ...(args.noCaller === true ? ['--no-caller'] : []),
          ...(args.addDir ? [`--add-dir=${args.addDir}`] : []),
          ...(args.timeout ? [`--timeout=${args.timeout}`] : []),
          ...(args.answerSchema ? [`--answer-schema=${args.answerSchema}`] : []),
          ...(args.answerFile ? [`--answer-file=${args.answerFile}`] : []),
          ...(typeof args.task === 'string' ? [`--prompt=${args.task}`] : []),
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
  // A usage error prints only to stderr; hand its words back with the code.
  const stderr = code !== 0 && errors.length ? { stderr: errors.join('\n') } : {};
  return { content: [{ type: 'text', text: JSON.stringify({ exitCode: code, verdict: parsed, ...stderr }, null, 2) }] };
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
