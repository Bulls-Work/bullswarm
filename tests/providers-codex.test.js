import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { createAgentEventDecoder } from '../src/lib/agent-events.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const connector = JSON.parse(readFileSync(join(repo, 'src/providers/codex/connector.json'), 'utf8'));
const fixture = join(repo, 'tests/fixtures/streams/codex-file-change.jsonl');

test('codex file_change capture keeps the change path and raw changes in the stable event shape', () => {
  const events = [];
  const decoder = createAgentEventDecoder(connector.eventStream, {
    onEvent: (event) => events.push(event),
  });
  decoder.push(readFileSync(fixture), 'stdout', '2026-09-20T09:23:35.000Z');
  decoder.finish('2026-09-20T09:23:36.000Z');

  const changeEvents = events.filter((event) => event.kind === 'file_change');
  assert.equal(changeEvents.length, 2);
  assert.equal(changeEvents[0].status, 'running');
  assert.equal(changeEvents[1].status, 'completed');
  assert.equal(changeEvents[1].summary, '/tmp/bsw-codex-file-change-DxjT3B/file-change-fixture.txt');
  assert.deepEqual(changeEvents[1].arguments, [{
    path: '/tmp/bsw-codex-file-change-DxjT3B/file-change-fixture.txt',
    kind: 'add',
  }]);
  assert.notEqual(changeEvents[1].summary, null);
});
