import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clone } from '../src/lib/clone.js';

test('clone is a deep JSON copy that keeps undefined as undefined', () => {
  const source = { a: [1, { b: 2 }], at: null, skipped: undefined };
  const copy = clone(source);
  assert.deepEqual(copy, { a: [1, { b: 2 }], at: null });
  assert.notEqual(copy.a, source.a);
  assert.notEqual(copy.a[1], source.a[1]);
  assert.equal(clone(undefined), undefined);
  assert.equal(clone(null), null);
});
