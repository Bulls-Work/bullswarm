import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/cli.js';

test('boolean flags never swallow a following positional task', () => {
  assert.deepEqual(
    parseArgs(['--lane', 'chore', '--no-caller', 'inspect', 'this']),
    { lane: 'chore', 'no-caller': true, rest: ['inspect', 'this'] },
  );
});

test('boolean flags remain true when followed by another option', () => {
  assert.deepEqual(
    parseArgs(['--force', '--json', '--add-dir', '/tmp/example']),
    { force: true, json: true, 'add-dir': '/tmp/example', rest: [] },
  );
});

test('value flags still consume their following operand', () => {
  assert.deepEqual(
    parseArgs(['--lane', 'analyze', '--timeout', '30', 'task']),
    { lane: 'analyze', timeout: '30', rest: ['task'] },
  );
});

test('classify flag accepts both eq and space value forms', () => {
  assert.deepEqual(
    parseArgs(['--classify=llm', 'inspect', 'this']),
    { classify: 'llm', rest: ['inspect', 'this'] },
  );
  assert.deepEqual(
    parseArgs(['--classify', 'deterministic', 'task']),
    { classify: 'deterministic', rest: ['task'] },
  );
});
