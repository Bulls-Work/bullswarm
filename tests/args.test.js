import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/cli.js';

// parseArgs also records `_flags`: the flag names exactly as typed, in
// first-seen order. main() hands that list to the unknown-flag gate, which
// needs what the caller wrote rather than the normalized keys below (those
// cannot tell an unknown flag from a value that happens to collide).

test('boolean flags never swallow a following positional task', () => {
  assert.deepEqual(
    parseArgs(['--lane', 'chore', '--no-caller', 'inspect', 'this']),
    { lane: 'chore', 'no-caller': true, rest: ['inspect', 'this'], _flags: ['lane', 'no-caller'] },
  );
});

test('boolean flags remain true when followed by another option', () => {
  assert.deepEqual(
    parseArgs(['--force', '--json', '--add-dir', '/tmp/example']),
    { force: true, json: true, 'add-dir': '/tmp/example', rest: [], _flags: ['force', 'json', 'add-dir'] },
  );
});

test('value flags still consume their following operand', () => {
  assert.deepEqual(
    parseArgs(['--lane', 'analyze', '--timeout', '30', 'task']),
    { lane: 'analyze', timeout: '30', rest: ['task'], _flags: ['lane', 'timeout'] },
  );
});

test('classify flag accepts both eq and space value forms', () => {
  assert.deepEqual(
    parseArgs(['--classify=llm', 'inspect', 'this']),
    { classify: 'llm', rest: ['inspect', 'this'], _flags: ['classify'] },
  );
  assert.deepEqual(
    parseArgs(['--classify', 'deterministic', 'task']),
    { classify: 'deterministic', rest: ['task'], _flags: ['classify'] },
  );
});
