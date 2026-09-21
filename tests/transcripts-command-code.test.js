import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildTranscriptIndex,
  readTranscriptUsage,
} from '../providers/contrib/command-code/provider.mjs';

const FIXTURES = fileURLToPath(new URL('./fixtures/transcripts/', import.meta.url));
const SESSION_ID = 'e7e9edaa-e5c8-465a-a491-6f8d233e44ff';
const PROJECT_SLUG = 'private-tmp-claude-501-home-dev-repo-bullswarm-05453766-e8bc-4a0e-9028-60e1ae452ed0-scratchpad-probe';
const CWD = '/private/tmp/claude-501/-home-dev-Repo-bullswarm/05453766-e8bc-4a0e-9028-60e1ae452ed0/scratchpad/probe';

function home() {
  const dir = mkdtempSync(join(tmpdir(), 'bullswarm-command-code-transcripts-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function installFixture(targetHome, project = PROJECT_SLUG, id = SESSION_ID) {
  const file = join(targetHome, '.commandcode', 'projects', project, `${id}.jsonl`);
  mkdirSync(join(file, '..'), { recursive: true });
  cpSync(join(FIXTURES, 'command-code-session.jsonl'), file);
  return file;
}

test('Command Code session fixture sums inclusive input into exclusive token classes', () => {
  const { dir, cleanup } = home();
  try {
    const file = installFixture(dir);
    const result = readTranscriptUsage({
      provider: 'command-code',
      sessionId: SESSION_ID,
      home: dir,
    });
    assert.equal(result.confidence, 'exact');
    assert.equal(result.sessionId, SESSION_ID);
    assert.equal(result.file, file);
    assert.equal(result.model, 'gpt-5.6-luna');
    assert.equal(result.cwd, CWD);
    assert.equal(result.firstAt, '2026-09-08T21:23:40.160Z');
    assert.equal(result.lastAt, '2026-09-08T21:23:40.160Z');
    assert.equal(result.requests.length, 1);
    assert.deepEqual(result.tokens, {
      standardRead: 3,
      cacheRead: 0,
      cacheWrite5m: null,
      cacheWrite1h: null,
      cacheWrite: 16798,
      output: 5,
      reasoning: null,
      totalKnown: 16806,
    });
  } finally { cleanup(); }
});

test('Command Code index resolves a single attempt by cwd and time window', () => {
  const { dir, cleanup } = home();
  try {
    const file = installFixture(dir);
    const index = buildTranscriptIndex({ home: dir });
    assert.equal(index.provider, 'command-code');
    assert.equal(index.entries.length, 1);
    assert.equal(index.entries[0].file, file);
    assert.equal(index.entries[0].sessionId, SESSION_ID);
    assert.equal(index.entries[0].cwd, CWD);

    const result = readTranscriptUsage({
      provider: 'command-code',
      cwd: CWD,
      startedAt: '2026-09-08T21:23:39.000Z',
      endedAt: '2026-09-08T21:23:41.000Z',
      home: dir,
      index,
    });
    assert.equal(result.confidence, 'window');
    assert.equal(result.sessionId, SESSION_ID);
    assert.equal(result.tokens.totalKnown, 16806);
  } finally { cleanup(); }
});

test('Command Code cwd resolution stays unknown when two sessions overlap', () => {
  const { dir, cleanup } = home();
  try {
    installFixture(dir, PROJECT_SLUG, SESSION_ID);
    installFixture(dir, PROJECT_SLUG, 'e7e9edaa-e5c8-465a-a491-6f8d233e4ff0');
    const result = readTranscriptUsage({
      provider: 'command-code',
      cwd: CWD,
      startedAt: '2026-09-08T21:23:39.000Z',
      endedAt: '2026-09-08T21:23:41.000Z',
      home: dir,
    });
    assert.equal(result.confidence, 'ambiguous');
    assert.equal(result.file, null);
    assert.equal(result.tokens.totalKnown, null);
  } finally { cleanup(); }
});

test('A persisted session without usage reports the documented unknown reason', () => {
  const { dir, cleanup } = home();
  try {
    const file = join(dir, '.commandcode', 'projects', PROJECT_SLUG, 'no-usage.jsonl');
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, `${JSON.stringify({
      type: 'session',
      version: 3,
      id: 'no-usage',
      timestamp: '2026-09-08T21:23:36.175Z',
      cwd: CWD,
    })}\n${JSON.stringify({
      type: 'message',
      id: 'user-only',
      timestamp: '2026-09-08T21:23:40.160Z',
      message: { role: 'user', content: [{ type: 'text', text: 'no assistant usage' }] },
    })}\n`);
    const result = readTranscriptUsage({
      provider: 'command-code',
      sessionId: 'no-usage',
      home: dir,
    });
    assert.equal(result.confidence, 'exact');
    assert.equal(result.file, file);
    assert.equal(result.reason, 'command-code transcripts record no token usage');
    assert.equal(result.tokens.totalKnown, null);
  } finally { cleanup(); }
});
