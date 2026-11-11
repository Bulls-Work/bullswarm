// A pool held by a sign-in failure at dispatch (auth-hold.js) and also held
// for a timed reason keeps the sign-in sentence when the hold lasts longer,
// and its back time is the hold's end (blind review 6dj6ii, 11 Nov).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heldEntry, signInPart } from '../src/workflow/no-pool-why.js';

const T0 = Date.parse('2026-11-11T05:00:00Z');
const holdUntil = new Date(T0 + 15 * 60_000).toISOString();

test('the dispatch sign-in hold carries its end as the back time', () => {
  const pool = { name: 'p', authHold: { at: new Date(T0).toISOString(), until: holdUntil, level: 0 } };
  const part = signInPart(pool, T0);
  assert.ok(part[0].includes('sign-in failed at dispatch'));
  assert.equal(part[1], Date.parse(holdUntil));
});

test('a longer sign-in hold wins over a shorter timed reason', () => {
  const pool = { name: 'p', authHold: { at: new Date(T0).toISOString(), until: holdUntil, level: 0 } };
  const shorter = ['held (maintenance)', T0 + 5 * 60_000, false];
  const entry = heldEntry('p', [signInPart(pool, T0), shorter]);
  assert.ok(entry.text.includes('sign-in failed at dispatch'), entry.text);
  assert.equal(entry.back, Date.parse(holdUntil));
  assert.equal(entry.text.split(holdUntil).length - 1, 1, entry.text);
});

test('a meter-read sign-in failure has no known end', () => {
  const pool = { name: 'p', meterSignInFailed: true, meterError: 'auth' };
  assert.equal(signInPart(pool, T0)[1], null);
});

test('a meter failure and a hold together still have no known end', () => {
  const pool = { name: 'p', meterSignInFailed: true, authHold: { at: new Date(T0).toISOString(), until: holdUntil, level: 0 } };
  assert.equal(signInPart(pool, T0)[1], null);
});
