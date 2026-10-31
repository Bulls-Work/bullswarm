// Issue #41: under herdr the AbovePrompt strip must stay within 5 rows
// (header included), or Claude's spinner line leaves the bottom 12 lines
// herdr reads and the pane shows as idle.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { stripBudget, stripRowCounts } from '../mods/bullswarm/hooks/strip-budget.ts';

const rows = (maxRows, underHerdr) =>
  stripRowCounts(stripBudget(maxRows, underHerdr), 4, 6, 0).total;

test('under herdr the strip draws at most 5 rows with 4 pools and 6 runs', () => {
  assert.ok(rows(12, true) <= 5, `drew ${rows(12, true)} rows`);
});

test('outside herdr the strip draws every pool and run as before', () => {
  assert.equal(rows(12, false), 11);
  assert.equal(stripBudget(12, false), 11);
});

test('a small maxRows under herdr is not raised', () => {
  assert.equal(stripBudget(3, true), 2);
  assert.equal(stripBudget(12, true), 4);
});
