import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/ledger.js', import.meta.url));

test('balance prints an aligned table', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
  const file = join(dir, 'a.ledger');
  writeFileSync(file, '2024-01-05 Groceries\n  expenses:food  12.50\n  assets:bank\n');
  const r = spawnSync(process.execPath, [bin, 'balance', file], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(
    r.stdout,
    ['-12.50  assets', '-12.50  assets:bank', ' 12.50  expenses', ' 12.50  expenses:food', ''].join('\n'),
  );
});
