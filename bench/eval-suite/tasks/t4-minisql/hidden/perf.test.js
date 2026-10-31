import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../../src/index.js';

const rows = (db, sql) => db.exec(sql).rows;
const one = (sql) => createDatabase().exec(sql).rows[0][0];
const bad = (db, sql) => assert.throws(() => db.exec(sql), (e) => e instanceof Error && e.message.startsWith('SQL error:'));

// 5000 inserts followed by 200 primary-key UPDATEs must use under 3 seconds of
// CPU. CPU time, not wall time: on 2026-10-31 the wall-clock version failed
// once under machine load (0.65-0.77 s when run alone), which measured the
// machine, not the engine. A quadratic engine still blows the budget.
test('perf: 5000 inserts and 200 keyed updates', () => {
  const db = createDatabase();
  db.exec('CREATE TABLE big (id INTEGER PRIMARY KEY, v INTEGER, label TEXT)');
  const cpu0 = process.cpuUsage();
  for (let i = 0; i < 5000; i++) db.exec(`INSERT INTO big VALUES (${i}, ${i * 2}, 'row${i}')`);
  for (let i = 0; i < 200; i++) {
    const id = (i * 24) % 5000;
    assert.deepEqual(db.exec(`UPDATE big SET v = v + 1 WHERE id = ${id}`), { changes: 1 });
  }
  const used = process.cpuUsage(cpu0);
  const elapsed = Math.round((used.user + used.system) / 1000);
  assert.ok(elapsed < 3000, `used ${elapsed}ms of CPU`);
  assert.deepEqual(db.exec('SELECT COUNT(*), SUM(v) FROM big').rows, [[5000, 24995000 + 200]]);
});
