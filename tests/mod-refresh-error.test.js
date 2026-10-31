// Issue #38: the AbovePrompt strip prints lastError verbatim. Claude's
// $.process.run abort ("still running after 30000ms") and a cache that is
// not ready yet must not become that text.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const ABORT = 'bullswarm: $.process.run(bullswarm) aborted: still running after 30000ms';

test('an abort or cache-not-ready read is not shown once meters have loaded', async () => {
  const { refreshErrorText } = await import('../mods/bullswarm/hooks/pools.ts');
  assert.equal(refreshErrorText(ABORT, true), null);
  assert.equal(refreshErrorText('$.process.run(bullswarm) aborted: still running after 30000ms', true), null);
  assert.equal(refreshErrorText('cache not ready', true), null);
  assert.equal(refreshErrorText(ABORT, false), 'meters not ready yet');
  assert.equal(refreshErrorText('cache not ready', false), 'meters not ready yet');
  assert.equal(refreshErrorText('meter down', true), 'meter down');
  assert.equal(refreshErrorText('meter down', false), 'meter down');
});

test('a routed rung killed by the process abort says it took too long', async () => {
  const { rungErrorText } = await import('../mods/bullswarm/hooks/pools.ts');
  assert.equal(rungErrorText(ABORT), 'took too long');
  assert.equal(rungErrorText('$.process.run(bullswarm) aborted: still running after 30000ms'), 'took too long');
  assert.equal(rungErrorText('spawn ENOENT'), 'spawn ENOENT');
});
