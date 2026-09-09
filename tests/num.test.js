import test from 'node:test';
import assert from 'node:assert/strict';
import { finiteOrNull } from '../src/lib/num.js';

// C3: one strict coercion replaced six near-copies. Four rejected '' and
// booleans, two did not, so `Number('') === 0` slipped through the datapack
// loaders. These are the cases that made the copies differ.

test('finiteOrNull keeps real numbers, including negatives and zero', () => {
  assert.equal(finiteOrNull(0), 0);
  assert.equal(finiteOrNull(-12.5), -12.5);
  assert.equal(finiteOrNull(75), 75);
  assert.equal(finiteOrNull('0'), 0);
  assert.equal(finiteOrNull('  82.4  '), 82.4);
  assert.equal(finiteOrNull('1e3'), 1000);
});

test('finiteOrNull never turns a missing measurement into a zero', () => {
  assert.equal(finiteOrNull(null), null);        // Number(null) === 0
  assert.equal(finiteOrNull(undefined), null);
  assert.equal(finiteOrNull(''), null);          // Number('') === 0
  assert.equal(finiteOrNull('   '), null);       // Number('   ') === 0
  assert.equal(finiteOrNull([]), null);          // Number([]) === 0
  assert.equal(finiteOrNull(['5']), null);       // Number(['5']) === 5
});

test('finiteOrNull rejects booleans rather than scoring true as 1', () => {
  assert.equal(finiteOrNull(true), null);        // Number(true) === 1
  assert.equal(finiteOrNull(false), null);
});

test('finiteOrNull rejects NaN and both infinities', () => {
  assert.equal(finiteOrNull(NaN), null);
  assert.equal(finiteOrNull('not a number'), null);
  assert.equal(finiteOrNull(Infinity), null);
  assert.equal(finiteOrNull(-Infinity), null);
  assert.equal(finiteOrNull({}), null);
});
