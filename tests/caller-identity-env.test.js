// The caller-identity tests must not depend on who runs them. Bullswarm runs a
// step's --check with its own BULLSWARM_DEPTH and BULLSWARM_CALLER set, so a
// check that runs tests/caller-identity.test.js used to fail on any correct
// tree (found in the cf pool trial, order bs-cf-pool-1123, 2026-11-23).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const FILE = fileURLToPath(new URL('./caller-identity.test.js', import.meta.url));

test('the caller-identity tests pass under an outer Bullswarm caller (as inside a --check)', () => {
  // NODE_TEST_CONTEXT would make the inner run report to this runner and
  // exit 0 whatever happened; drop it so the inner run is a plain run.
  const env = { ...process.env, BULLSWARM_DEPTH: '1', BULLSWARM_CALLER: 'outer-lead' };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ['--test', FILE], { encoding: 'utf8', timeout: 120_000, env });
  const failed = (run.stdout.match(/^not ok .*$/gm) ?? []).join('\n');
  assert.equal(run.status, 0, `failing under an outer caller:\n${failed}`);
});
