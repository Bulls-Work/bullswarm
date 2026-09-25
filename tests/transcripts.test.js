import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readTranscriptUsage } from '../src/lib/transcripts/index.js';
import { claudeTokens } from '../src/lib/transcripts/claude-code.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/transcripts/', import.meta.url));
const CODEX_ID = '01a0ba3c-3045-7013-928b-53a20891542b';
const GROK_ID = '4dae9748-19bc-4fe6-9034-28249657f73f';
const CLAUDE_ID = '47b2c644-395f-40be-aef1-fba48f59da53';
const CODEX_CWD = '/private/tmp/bsw-design/codex-probe';
const CLAUDE_CWD = '/home/dev/project-a';
const GROK_CWD = '/home/dev/project-d';

function home() {
  const dir = mkdtempSync(join(tmpdir(), 'bullswarm-transcripts-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function copy(name, target) {
  mkdirSync(join(target, '..'), { recursive: true });
  cpSync(join(FIXTURES, name), target);
}

function codexHome(targetHome, date = '2026/09/19') {
  const path = join(targetHome, '.codex', 'sessions', date, `rollout-2026-09-19T23-15-01-${CODEX_ID}.jsonl`);
  copy('codex-rollout.jsonl', path);
  return path;
}

test('Codex rollout fixture uses the last cumulative total and reports the real model', () => {
  const { dir, cleanup } = home();
  try {
    codexHome(dir);
    const result = readTranscriptUsage({ provider: 'codex', sessionId: CODEX_ID, home: dir });
    assert.equal(result.confidence, 'exact');
    assert.equal(result.model, 'gpt-5.6-luna');
    assert.equal(result.sessionId, CODEX_ID);
    assert.equal(result.cwd, CODEX_CWD);
    assert.equal(result.requests.length, 1);
    assert.deepEqual(result.tokens, {
      standardRead: 14157,
      cacheRead: 6912,
      cacheWrite5m: null,
      cacheWrite1h: null,
      cacheWrite: 0,
      output: 7,
      reasoning: 13,
      totalKnown: 21089,
    });
  } finally { cleanup(); }
});

test('Claude session fixture keeps the last streaming row per message identity', () => {
  const { dir, cleanup } = home();
  try {
    const slug = '-home-dev-project-a';
    copy('claude-session.jsonl', join(dir, '.claude', 'projects', slug, `${CLAUDE_ID}.jsonl`));
    const result = readTranscriptUsage({ provider: 'claude-code', sessionId: CLAUDE_ID, home: dir });
    assert.equal(result.confidence, 'exact');
    assert.equal(result.model, 'claude-opus-5');
    assert.equal(result.cwd, CLAUDE_CWD);
    assert.equal(result.requests.length, 3);
    assert.deepEqual(result.tokens, {
      standardRead: 6,
      cacheRead: 61565,
      cacheWrite5m: 0,
      cacheWrite1h: 33149,
      cacheWrite: 33149,
      output: 516,
      reasoning: 52,
      totalKnown: 95288,
    });
  } finally { cleanup(); }
});

test('Claude usage keeps thinking as reasoning and subtracts it from output', () => {
  const result = JSON.parse(readFileSync(join(FIXTURES, 'claude-result-event.json'), 'utf8'));
  assert.deepEqual(claudeTokens(result.usage), {
    standardRead: 2,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 30253,
    cacheWrite: 30253,
    output: 155,
    reasoning: 21,
    totalKnown: 30431,
  });
});

test('Grok unified fixture sums the short and long-context requests', () => {
  const { dir, cleanup } = home();
  try {
    copy('grok-unified.jsonl', join(dir, '.grok', 'logs', 'unified.jsonl'));
    const result = readTranscriptUsage({ provider: 'grok', sessionId: GROK_ID, home: dir });
    assert.equal(result.confidence, 'exact');
    assert.equal(result.model, 'grok-4.6');
    assert.equal(result.cwd, GROK_CWD);
    assert.equal(result.requests.length, 2);
    assert.deepEqual(result.requests.map((request) => request.contextTier), ['short', 'long']);
    assert.deepEqual(result.tokens, {
      standardRead: 60910,
      cacheRead: 187904,
      cacheWrite5m: null,
      cacheWrite1h: null,
      cacheWrite: null,
      output: 796,
      reasoning: 353,
      totalKnown: 249963,
    });
  } finally { cleanup(); }
});

test('resolution by cwd and inclusive attempt window returns the single match', () => {
  const { dir, cleanup } = home();
  try {
    codexHome(dir);
    const result = readTranscriptUsage({
      provider: 'codex',
      cwd: CODEX_CWD,
      startedAt: '2026-09-19T15:15:02.116Z',
      endedAt: '2026-09-19T15:15:14.719Z',
      home: dir,
    });
    assert.equal(result.confidence, 'window');
    assert.equal(result.sessionId, CODEX_ID);
    assert.equal(result.tokens.totalKnown, 21089);
  } finally { cleanup(); }
});

test('ambiguous cwd and time-window resolution returns no selected candidate', () => {
  const { dir, cleanup } = home();
  try {
    codexHome(dir, '2026/09/19');
    codexHome(dir, '2026/09/20');
    const result = readTranscriptUsage({
      provider: 'codex',
      cwd: CODEX_CWD,
      startedAt: '2026-09-19T15:15:02.116Z',
      endedAt: '2026-09-19T15:15:14.719Z',
      home: dir,
    });
    assert.equal(result.confidence, 'ambiguous');
    assert.equal(result.file, null);
    assert.equal(result.tokens.totalKnown, null);
  } finally { cleanup(); }
});

test('a missing provider store resolves to none without inventing usage', () => {
  const { dir, cleanup } = home();
  try {
    const result = readTranscriptUsage({ provider: 'grok', sessionId: GROK_ID, home: dir });
    assert.equal(result.confidence, 'none');
    assert.equal(result.sessionId, null);
    assert.deepEqual(result.tokens, {
      standardRead: null,
      cacheRead: null,
      cacheWrite5m: null,
      cacheWrite1h: null,
      cacheWrite: null,
      output: null,
      reasoning: null,
      totalKnown: null,
    });
  } finally { cleanup(); }
});
