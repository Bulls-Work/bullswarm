// Issue #41: under herdr the AbovePrompt strip must stay within 5 rows
// (header included), or Claude's spinner line leaves the bottom 12 lines
// herdr reads and the pane shows as idle.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { stripBudget, stripRowCounts } from '../mods/bullswarm/hooks/strip-budget.ts';

const counts = (maxRows, underHerdr, hasError) =>
  stripRowCounts(stripBudget(maxRows, underHerdr), 4, 6, 0, hasError && underHerdr);
const rows = (maxRows, underHerdr) => counts(maxRows, underHerdr, false).total;

test('under herdr the strip draws at most 5 rows with 4 pools and 6 runs', () => {
  assert.ok(rows(12, true) <= 5, `drew ${rows(12, true)} rows`);
});

test('under herdr an error row counts against the 5 rows', () => {
  const c = counts(12, true, true);
  assert.ok(c.total <= 5, `drew ${c.total} rows`);
  assert.equal(c.pools + c.runs + c.loose, 3, 'the error row takes one row of the budget');
});

test('outside herdr an error row stays extra and the counts are unchanged', () => {
  assert.deepEqual(counts(12, false, true), { pools: 4, runs: 6, loose: 0, total: 11 });
  assert.deepEqual(counts(12, false, false), { pools: 4, runs: 6, loose: 0, total: 11 });
});

test('outside herdr the strip draws every pool and run as before', () => {
  assert.equal(rows(12, false), 11);
  assert.equal(stripBudget(12, false), 11);
});

test('a small maxRows under herdr is not raised', () => {
  assert.equal(stripBudget(3, true), 2);
  assert.equal(stripBudget(12, true), 4);
});

test('strip.tsx takes its row counts from stripRowCounts', () => {
  const src = readFileSync(new URL('../mods/bullswarm/hooks/strip.tsx', import.meta.url), 'utf8');
  assert.match(src, /import\s*\{[^}]*\bstripRowCounts\b[^}]*\}\s*from\s*'\.\/strip-budget'/);
  assert.match(src, /stripRowCounts\(/);
});
