import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAgentEventDecoder } from '../src/lib/agent-events.js';
import { validateProvider } from '../src/provider-cli.js';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const FIRST_CLASS = join(REPO, 'src', 'providers');
const CONTRIB = join(REPO, 'providers', 'contrib');
const CODEX_STDOUT_FIXTURE = join(REPO, 'tests', 'fixtures', 'transcripts', 'codex-stdout.jsonl');
const CLAUDE_RESULT_FIXTURE = join(REPO, 'tests', 'fixtures', 'transcripts', 'claude-result-event.json');
const OPENCODE_STREAM_FIXTURE = join(REPO, 'tests', 'fixtures', 'streams', 'opencode-hello.jsonl');
const COMMAND_CODE_STREAM_FIXTURE = join(REPO, 'tests', 'fixtures', 'streams', 'command-code-hello.jsonl');

// These are the four real lines captured by the design probe when Codex was
// asked to reply with exactly "ok". The transcript worker may later add the
// same capture under tests/fixtures/transcripts; use it when present.
const REAL_CODEX_STDOUT = [
  '{"type":"thread.started","thread_id":"01a0ba3c-3045-7013-928b-53a20891542b"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"ok"}}',
  '{"type":"turn.completed","usage":{"input_tokens":21069,"cached_input_tokens":6912,"cache_write_input_tokens":0,"output_tokens":20,"reasoning_output_tokens":13}}',
].join('\n') + '\n';

const REAL_CLAUDE_RESULT = JSON.stringify({
  duration_api_ms: 3859,
  stop_reason: 'tool_use',
  session_id: 'e83661db-cd13-4a23-824c-5c335353c19b',
  total_cost_usd: 0.61388,
  usage: {
    input_tokens: 2,
    cache_creation_input_tokens: 30253,
    cache_read_input_tokens: 0,
    output_tokens: 176,
    output_tokens_details: { thinking_tokens: 21 },
    cache_creation: { ephemeral_1h_input_tokens: 30253, ephemeral_5m_input_tokens: 0 },
  },
  type: 'result',
});

function connector(name) {
  return JSON.parse(readFileSync(join(FIRST_CLASS, name, 'connector.json'), 'utf8'));
}

function contribConnector(name) {
  return JSON.parse(readFileSync(join(CONTRIB, name, 'connector.json'), 'utf8'));
}

function isolatedLoader(home) {
  mkdirSync(join(home, 'providers'), { recursive: true });
  mkdirSync(join(home, 'connectors'), { recursive: true });
  return {
    homeDir: home,
    dirs: {
      firstClass: FIRST_CLASS,
      contrib: join(REPO, 'providers', 'contrib'),
      local: join(home, 'providers'),
      legacy: join(home, 'connectors'),
    },
  };
}

test('first-class provider validation reports usage and cache-write warnings without failing', () => {
  const home = mkdtempSync(join(tmpdir(), 'bullswarm-provider-usage-rules-'));
  try {
    const expected = {
      codex: { usageWarning: false, pricingWarning: false },
      grok: { usageWarning: false, pricingWarning: true },
      'claude-code': { usageWarning: false, pricingWarning: false },
      echo: { usageWarning: false, pricingWarning: true },
    };
    for (const [name, want] of Object.entries(expected)) {
      const report = validateProvider(home, join(FIRST_CLASS, name), isolatedLoader(home));
      assert.equal(report.ok, true, `${name}: ${JSON.stringify(report)}`);
      const warnings = report.pools.flatMap((pool) => pool.warnings);
      const usageWarnings = warnings.filter((warning) => warning.startsWith('eventStream.usage:'));
      const pricingWarnings = warnings.filter((warning) => warning.startsWith('modelProfiles[')
        && warning.includes('cache-write rate missing'));
      assert.equal(usageWarnings.length > 0, want.usageWarning, `${name} usage warning`);
      assert.equal(pricingWarnings.length > 0, want.pricingWarning, `${name} pricing warning`);
      if (want.usageWarning) {
        assert.equal(usageWarnings[0], 'eventStream.usage: eventStream is declared but no usage rules exist; attempts require transcript or byte fallback');
      }
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('Codex stdout usage applies inclusive subtraction and preserves the real session identity', () => {
  const codex = connector('codex');
  const fixture = existsSync(CODEX_STDOUT_FIXTURE)
    ? readFileSync(CODEX_STDOUT_FIXTURE, 'utf8')
    : REAL_CODEX_STDOUT;
  const decoder = createAgentEventDecoder(codex.eventStream);
  decoder.push(fixture, 'stdout', '2026-09-19T15:15:14.719Z');
  decoder.finish('2026-09-19T15:15:14.719Z');
  assert.equal(decoder.output(), 'ok');
  assert.deepEqual(decoder.usage(), {
    sessionId: '01a0ba3c-3045-7013-928b-53a20891542b',
    standardRead: 14157,
    cacheRead: 6912,
    cacheWrite: 0,
    output: 7,
    reasoning: 13,
  });
});

test('Claude result usage subtracts thinking tokens from inclusive output', () => {
  const claude = connector('claude-code');
  const decoder = createAgentEventDecoder(claude.eventStream);
  const fixture = existsSync(CLAUDE_RESULT_FIXTURE)
    ? readFileSync(CLAUDE_RESULT_FIXTURE, 'utf8').trimEnd()
    : REAL_CLAUDE_RESULT;
  decoder.push(`${fixture}\n`);
  decoder.finish();
  assert.deepEqual(decoder.usage(), {
    sessionId: 'e83661db-cd13-4a23-824c-5c335353c19b',
    costUsd: 0.61388,
    standardRead: 2,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 30253,
    output: 155,
    reasoning: 21,
  });
});

// The two fixtures below are real, unedited stdout captures made on 2026-09-20
// (the connectors' $comment-usage names the exact commands). The asserted
// numbers are the ones the files carry.

test('OpenCode step_finish usage reads the real captured stream without subtracting disjoint counters', () => {
  const opencode = contribConnector('opencode');
  const decoder = createAgentEventDecoder(opencode.eventStream);
  decoder.push(readFileSync(OPENCODE_STREAM_FIXTURE, 'utf8'), 'stdout', '2026-09-20T02:42:47.578Z');
  decoder.finish('2026-09-20T02:42:47.578Z');
  assert.equal(decoder.output().trim(), 'ok');
  assert.deepEqual(decoder.usage(), {
    sessionId: 'ses_f434e3b69ffed4pqWwY50GlaGz',
    standardRead: 15390,
    cacheRead: 0,
    cacheWrite: 0,
    output: 4,
    reasoning: 14,
  });
});

test('Command Code result usage reads the real captured stream and removes the inclusive cache classes', () => {
  const commandCode = contribConnector('command-code');
  const decoder = createAgentEventDecoder(commandCode.eventStream);
  decoder.push(readFileSync(COMMAND_CODE_STREAM_FIXTURE, 'utf8'), 'stdout', '2026-09-20T02:40:27.343Z');
  decoder.finish('2026-09-20T02:40:27.343Z');
  assert.equal(decoder.output(), 'ok');
  assert.deepEqual(decoder.usage(), {
    sessionId: '4cd53a33-80d6-41c1-b64c-5a47b36079f4',
    standardRead: 3,
    cacheRead: 0,
    cacheWrite: 21097,
    output: 5,
  });
});
