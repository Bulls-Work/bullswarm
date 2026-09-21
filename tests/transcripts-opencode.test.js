import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildTranscriptIndex,
  readTranscriptUsage,
} from '../src/lib/transcripts/opencode.js';
import * as provider from '../providers/contrib/opencode/provider.mjs';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const FIXTURES = join(REPO, 'tests', 'fixtures', 'transcripts');
const SESSION_ID = 'ses_fa7933856ffeObmn5v5n9sRGzu';
const CWD = '/home/dev/Repo/bullswarm';
const TASK_PATH = '/home/dev/.bullswarm/workflows/wf-mthe1rm0-364da1/task-audit-v2-implementation-attempt-1.md';

// These are direct `sqlite3 -readonly -json` exports from the real OpenCode
// database. No private message text was redacted; the selected rows contain
// only the task path and a short assistant response.
const MESSAGE_ROWS = JSON.parse(readFileSync(join(FIXTURES, 'opencode-messages.json'), 'utf8'));
const SESSION_ROW = JSON.parse(readFileSync(join(FIXTURES, 'opencode-session.json'), 'utf8'))[0];

function createStore({
  duplicate = false,
  duplicateDirectory = SESSION_ROW.directory,
  duplicateTaskPath = '/tmp/other-task.md',
} = {}) {
  const home = mkdtempSync(join(tmpdir(), 'bullswarm-opencode-'));
  const dataDir = join(home, '.local', 'share', 'opencode');
  const dbPath = join(dataDir, 'opencode.db');
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      directory TEXT NOT NULL,
      model TEXT,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      tokens_input INTEGER DEFAULT 0 NOT NULL,
      tokens_output INTEGER DEFAULT 0 NOT NULL,
      tokens_reasoning INTEGER DEFAULT 0 NOT NULL,
      tokens_cache_read INTEGER DEFAULT 0 NOT NULL,
      tokens_cache_write INTEGER DEFAULT 0 NOT NULL
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `);
  const insertSession = db.prepare(`
    INSERT INTO session (id, directory, model, time_created, time_updated,
      tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertMessage = db.prepare(
    'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)',
  );
  const insertPart = db.prepare(
    'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const addRows = (sessionId, suffix = '', {
    directory = SESSION_ROW.directory,
    taskPath = null,
  } = {}) => {
    insertSession.run(
      sessionId,
      directory,
      SESSION_ROW.model,
      SESSION_ROW.time_created,
      SESSION_ROW.time_updated,
      SESSION_ROW.tokens_input,
      SESSION_ROW.tokens_output,
      SESSION_ROW.tokens_reasoning,
      SESSION_ROW.tokens_cache_read,
      SESSION_ROW.tokens_cache_write,
    );
    for (const row of MESSAGE_ROWS) {
      const messageId = `${row.id}${suffix}`;
      insertMessage.run(messageId, sessionId, row.time_created, row.time_updated, row.data);
      if (!row.part_id) continue;
      let partData = row.part_data;
      if (suffix && row.part_id === MESSAGE_ROWS[0].part_id) {
        partData = JSON.stringify({ type: 'text', text: taskPath ?? duplicateTaskPath });
      }
      insertPart.run(
        `${row.part_id}${suffix}`,
        messageId,
        sessionId,
        row.part_time_created,
        row.part_time_updated,
        partData,
      );
    }
  };
  addRows(SESSION_ID);
  if (duplicate) {
    addRows('ses_fixture_duplicate', '-duplicate', {
      directory: duplicateDirectory,
      taskPath: duplicateTaskPath,
    });
  }
  db.close();
  return {
    home,
    dbPath,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

test('OpenCode provider exports both transcript hooks and the connector ships its proven stream usage rules', async () => {
  assert.equal(typeof provider.buildTranscriptIndex, 'function');
  assert.equal(typeof provider.readTranscriptUsage, 'function');
  const connector = JSON.parse(readFileSync(join(REPO, 'providers', 'contrib', 'opencode', 'connector.json'), 'utf8'));
  assert.deepEqual(connector.eventStream.usage, [
    { match: { path: 'sessionID' }, mode: 'last', fields: { sessionId: 'sessionID' } },
    {
      match: { path: 'type', equals: 'step_finish' },
      mode: 'sum',
      fields: {
        standardRead: 'part.tokens.input',
        cacheRead: 'part.tokens.cache.read',
        cacheWrite: 'part.tokens.cache.write',
        output: 'part.tokens.output',
        reasoning: 'part.tokens.reasoning',
      },
    },
  ]);
  assert.match(connector.eventStream['$comment-usage'], /2026-09-20/);
  assert.match(connector.eventStream['$comment-usage'], /tests\/fixtures\/streams\/opencode-hello\.jsonl/);
  assert.equal(existsSync(join(REPO, 'tests', 'fixtures', 'streams', 'opencode-hello.jsonl')), true);
});

test('fixture rows build a read-only OpenCode index and sum exclusive token classes', () => {
  const store = createStore();
  try {
    const index = buildTranscriptIndex({ home: store.home });
    assert.equal(index.provider, 'opencode');
    assert.equal(index.databasePath, store.dbPath);
    assert.equal(index.entries.length, 1);
    assert.deepEqual(index.entries[0].tokens, {
      standardRead: 368554,
      cacheRead: 1597440,
      cacheWrite5m: null,
      cacheWrite1h: null,
      cacheWrite: 0,
      output: 6104,
      reasoning: 2214,
      totalKnown: 1974312,
    });
    assert.equal(index.entries[0].cwd, CWD);
    assert.equal(index.entries[0].model, 'gpt-5.6-luna');
    // Task text is loaded lazily only when multiple CWD/time candidates need
    // disambiguation, so indexing a large real database stays one SQL scan.
    assert.equal(index.entries[0].taskText, null);

    const usage = readTranscriptUsage({
      home: store.home,
      sessionId: SESSION_ID,
      startedAt: '2026-08-31T15:25:20.000Z',
      endedAt: '2026-08-31T15:25:40.000Z',
    });
    assert.equal(usage.confidence, 'exact');
    assert.equal(usage.sessionId, SESSION_ID);
    assert.equal(usage.cwd, CWD);
    assert.equal(usage.model, 'gpt-5.6-luna');
    assert.equal(usage.requests.length, 3);
    assert.deepEqual(usage.tokens, {
      standardRead: 20841,
      cacheRead: 15360,
      cacheWrite5m: null,
      cacheWrite1h: null,
      cacheWrite: 0,
      output: 220,
      reasoning: 166,
      totalKnown: 36587,
    });
    assert.equal(usage.firstAt, '2026-08-31T15:25:21.127Z');
    assert.equal(usage.lastAt, '2026-08-31T15:25:37.787Z');
  } finally {
    store.cleanup();
  }
});

test('CWD and time-window matching can be disambiguated by the first user task text', () => {
  const store = createStore({ duplicate: true });
  try {
    const window = {
      home: store.home,
      cwd: CWD,
      startedAt: '2026-08-31T15:25:00.000Z',
      endedAt: '2026-08-31T15:26:00.000Z',
    };
    const ambiguous = readTranscriptUsage(window);
    assert.equal(ambiguous.confidence, 'ambiguous');
    assert.equal(ambiguous.sessionId, null);
    assert.equal(ambiguous.file, null);
    assert.equal(ambiguous.tokens.totalKnown, null);
    assert.equal(ambiguous.reason, 'ambiguous-session-match');

    const selected = readTranscriptUsage({ ...window, taskText: TASK_PATH });
    assert.equal(selected.confidence, 'window');
    assert.equal(selected.sessionId, SESSION_ID);
    assert.equal(selected.tokens.totalKnown, 36587);
  } finally {
    store.cleanup();
  }
});

test('a cwd-less attempt resolves by a unique task path, while duplicate paths stay ambiguous', () => {
  const unique = createStore({ duplicate: true });
  try {
    const resolved = readTranscriptUsage({
      home: unique.home,
      startedAt: '2026-08-31T15:25:00.000Z',
      endedAt: '2026-08-31T15:26:00.000Z',
      taskFile: TASK_PATH,
    });
    assert.equal(resolved.confidence, 'window');
    assert.equal(resolved.sessionId, SESSION_ID);
  } finally {
    unique.cleanup();
  }

  const ambiguous = createStore({ duplicate: true, duplicateTaskPath: TASK_PATH });
  try {
    const result = readTranscriptUsage({
      home: ambiguous.home,
      startedAt: '2026-08-31T15:25:00.000Z',
      endedAt: '2026-08-31T15:26:00.000Z',
      taskFile: TASK_PATH,
    });
    assert.equal(result.confidence, 'ambiguous');
    assert.equal(result.sessionId, null);
    assert.equal(result.reason, 'ambiguous-task-match');
  } finally {
    ambiguous.cleanup();
  }
});

test('a recorded CWD still filters candidates when no task path is available', () => {
  const store = createStore({
    duplicate: true,
    duplicateDirectory: '/tmp/other-workspace',
  });
  try {
    const result = readTranscriptUsage({
      home: store.home,
      cwd: CWD,
      startedAt: '2026-08-31T15:25:00.000Z',
      endedAt: '2026-08-31T15:26:00.000Z',
    });
    assert.equal(result.confidence, 'window');
    assert.equal(result.sessionId, SESSION_ID);
    assert.equal(result.cwd, CWD);
  } finally {
    store.cleanup();
  }
});

test('the OpenCode database is opened read-only: a store with no write permission is read and left byte-identical', () => {
  // The real rows above, in a database file and directory nobody may write:
  // an index and a session read still work, and nothing is created or changed.
  const store = createStore();
  const dataDir = dirname(store.dbPath);
  const digest = () => createHash('sha256').update(readFileSync(store.dbPath)).digest('hex');
  const before = { hash: digest(), files: readdirSync(dataDir).sort() };
  chmodSync(store.dbPath, 0o444);
  chmodSync(dataDir, 0o555);
  try {
    const index = buildTranscriptIndex({ databasePath: store.dbPath });
    assert.equal(index.provider, 'opencode');
    assert.equal(index.entries.length, 1);
    assert.equal(index.entries[0].tokens.standardRead, 368554);
    // The exported rows are the session's first three requests.
    const representative = readTranscriptUsage({ databasePath: store.dbPath, sessionId: SESSION_ID });
    assert.equal(representative.confidence, 'exact');
    assert.equal(representative.model, 'gpt-5.6-luna');
    assert.equal(representative.tokens.standardRead, 20841);
    assert.deepEqual({ hash: digest(), files: readdirSync(dataDir).sort() }, before);
  } finally {
    chmodSync(dataDir, 0o755);
    store.cleanup();
  }
});
