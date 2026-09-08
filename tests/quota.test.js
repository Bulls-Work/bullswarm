import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_QUOTA_SIGNATURES,
  DEFAULT_QUOTA_QUARANTINE_MS,
  matchQuotaSignature,
  matchLikelyQuotaFailure,
  parseQuotaResetAt,
  quotaQuarantineUntil,
  GENERIC_QUOTA_SIGNATURES,
} from '../src/lib/quota.js';

// One fixed clock for every parse assertion: 2026-09-08T10:00:00Z.
const NOW = Date.parse('2026-09-08T10:00:00Z');
const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());

test('the real Claude session-limit message parses to its Hong Kong reset instant', () => {
  const message = "You've hit your session limit · resets 8:20pm (Asia/Hong_Kong)";
  // 20:20 in Asia/Hong_Kong (UTC+8) on the same day = 12:20Z.
  assert.equal(iso(parseQuotaResetAt(message, { now: NOW })), '2026-09-08T12:20:00.000Z');
});

test('a named zone whose wall clock already passed today rolls to the next occurrence', () => {
  // 09:00 Asia/Hong_Kong = 01:00Z, already past at 10:00Z -> tomorrow.
  const at = parseQuotaResetAt('usage limit reached · resets 9:00am (Asia/Hong_Kong)', { now: NOW });
  assert.equal(iso(at), '2026-09-09T01:00:00.000Z');
  assert.ok(at - NOW <= 24 * 60 * 60_000, 'a bare wall clock is never more than 24h ahead');
});

test('an unknown zone label falls back to the caller-supplied zone', () => {
  const at = parseQuotaResetAt('usage limit reached · resets 8:20pm (Middle/Earth)', {
    now: NOW, timeZone: 'Asia/Hong_Kong',
  });
  assert.equal(iso(at), '2026-09-08T12:20:00.000Z');
});

test('absolute, relative and ISO reset forms all resolve', () => {
  const cases = [
    ['Error: usage limit reached, resets at 3pm', '2026-09-08T15:00:00.000Z'],
    ['usage limit reached · resets 14:30', '2026-09-08T14:30:00.000Z'],
    ['You have hit your limit. resets in 2 hours', '2026-09-08T12:00:00.000Z'],
    ['rate limit exceeded, in 45 minutes', '2026-09-08T10:45:00.000Z'],
    ['too many requests; try again in 30 seconds', '2026-09-08T10:00:30.000Z'],
    ['quota exceeded — resets Sep 9 at 3pm', '2026-09-09T15:00:00.000Z'],
    ['usage limit reached (resets 2026-09-08T12:20:00Z)', '2026-09-08T12:20:00.000Z'],
  ];
  for (const [text, expected] of cases) {
    assert.equal(iso(parseQuotaResetAt(text, { now: NOW, timeZone: 'UTC' })), expected, text);
  }
});

test('a reset already in the past, too far ahead, or absent is rejected', () => {
  const opts = { now: NOW, timeZone: 'UTC' };
  assert.equal(parseQuotaResetAt('usage limit reached; resets 2026-09-08T09:00:00Z', opts), null);
  assert.equal(parseQuotaResetAt('usage limit reached; resets 2026-09-30T15:00:00Z', opts), null);
  assert.equal(parseQuotaResetAt('usage limit reached; resets in 9 days', opts), null);
  assert.equal(parseQuotaResetAt('usage limit reached; no reset stated', opts), null);
  assert.equal(parseQuotaResetAt('', opts), null);
});

test('a failure timestamp never becomes the deadline when a real reset is stated', () => {
  const text = "hit your session limit at 2026-09-08T09:59:00Z, resets in 2 hours";
  assert.equal(iso(parseQuotaResetAt(text, { now: NOW, timeZone: 'UTC' })), '2026-09-08T12:00:00.000Z');
});

test('reset wording alone is not a usage-limit signature', () => {
  assert.ok(!DEFAULT_QUOTA_SIGNATURES.some((s) => /^resets/i.test(s)));
  assert.equal(matchQuotaSignature({}, 'Weekly window resets at 3pm; 26% used.'), null);
  assert.equal(matchLikelyQuotaFailure({}, 'Weekly window resets in 2 hours.'), null);
});

test('a short line leading with the signature is quota-shaped', () => {
  const connector = { quotaSignatures: ['hit your session limit'] };
  assert.equal(
    matchLikelyQuotaFailure(connector, "You've hit your session limit · resets 8:20pm (Asia/Hong_Kong)"),
    'hit your session limit',
  );
  // Error-shaped lines qualify even when the phrase starts past character 40.
  assert.equal(
    matchLikelyQuotaFailure({}, 'Error: the upstream provider replied 429 too many requests'),
    'too many requests',
  );
});

test('a report that merely discusses limits is not a quota failure', () => {
  const report = 'Completed the dispatcher audit. The classifier now maps a provider that reports '
    + 'rate limit exceeded onto the mechanical kind quota, and the regression checks all passed '
    + 'with no remaining failures in the routing suite.';
  assert.ok(report.length < 300 && report.indexOf('rate limit exceeded') > 40);
  assert.equal(matchQuotaSignature({}, report), 'rate limit exceeded', 'the words are present');
  assert.equal(matchLikelyQuotaFailure({}, report), null, 'but the phrase is buried in prose');

  // A line long enough to be a paragraph is never a provider notice, even when
  // the phrase happens to land inside the head window.
  const paragraph = 'The quota exceeded path is now covered end to end: the watcher kills the '
    + 'attempt, the dispatcher records the mechanical kind, core state carries the reset deadline '
    + 'the provider named, and every later dispatch of this run and of other runs skips the pool '
    + 'until that deadline passes without any operator action.';
  assert.ok(paragraph.length > 300 && paragraph.indexOf('quota exceeded') < 40);
  assert.equal(matchLikelyQuotaFailure({}, paragraph), null);

  // Same words, short line, but the phrase sits past the head window and the
  // line is ordinary prose rather than a provider error.
  const bullet = '- the retry path now treats usage limit reached as its own kind';
  assert.ok(bullet.length < 300);
  assert.equal(matchLikelyQuotaFailure({}, bullet), null);
});

test('generic phrases count only as a bare notice, never as narration about another service', () => {
  // Third-party services emit the same words. An agent telling us it was
  // rate limited by GitHub is not out of OUR quota, whichever branch admits
  // the line (lead position or error-shaped).
  for (const narration of [
    'Rate limited by the GitHub API while listing PRs, retrying in 30s',
    'Error: rate limited by npm registry, waiting before the next publish',
    'The retry path now treats a provider that reports quota exceeded as its own failure kind.',
    'Too many requests were made against the staging API during the audit; see the notes below.',
  ]) {
    assert.notEqual(matchQuotaSignature({}, narration), null, `words are present: ${narration}`);
    assert.equal(matchLikelyQuotaFailure({}, narration), null, narration);
  }
  // Bare notices still count: nothing but punctuation, a reset/retry clause,
  // a parenthesised detail or a number may follow the phrase.
  assert.equal(matchLikelyQuotaFailure({}, 'Rate limit exceeded · resets 3pm'), 'rate limit exceeded');
  assert.equal(matchLikelyQuotaFailure({}, '429 Too Many Requests'), 'too many requests');
  assert.equal(matchLikelyQuotaFailure({}, 'Too many requests. Please retry after 30 seconds.'), 'too many requests');
  assert.equal(matchLikelyQuotaFailure({}, 'Error: rate limited'), 'rate limited');
  assert.equal(matchLikelyQuotaFailure({}, 'quota exceeded (resets in 2 hours)'), 'quota exceeded');
  // Provider first-person wording is not generic and keeps the plain rule.
  assert.equal(
    matchLikelyQuotaFailure({}, "You've hit your usage limit for this session and cannot continue right now"),
    'hit your usage limit',
  );
  assert.ok(GENERIC_QUOTA_SIGNATURES.every((s) => DEFAULT_QUOTA_SIGNATURES.includes(s)));
});

test('connector-declared signatures extend the defaults', () => {
  assert.equal(matchQuotaSignature({ quotaSignatures: ['seat is spent'] }, 'the seat is spent'), 'seat is spent');
  assert.equal(matchQuotaSignature({}, 'the seat is spent'), null);
  assert.equal(matchQuotaSignature({ quotaSignatures: [] }, 'usage_credits_required'), 'usage_credits_required');
});

test('the quarantine deadline degrades message -> meter -> 30 minutes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bullswarm-quota-'));
  try {
    mkdirSync(join(dir, 'meters'), { recursive: true });
    writeFileSync(join(dir, 'meters', 'claude-code.json'), `${JSON.stringify({
      captured_at: '2026-09-08T09:58:00Z',
      pool: 'claude-code',
      five_hour: { utilization: 100, resets_at: '2026-09-08T14:59:59Z' },
      seven_day: { utilization: 40, resets_at: '2026-09-12T00:00:00Z' },
      monthly: null,
    }, null, 2)}\n`);
    writeFileSync(join(dir, 'meters', 'stale-pool.json'), `${JSON.stringify({
      captured_at: '2026-09-08T04:00:00Z',
      pool: 'stale-pool',
      five_hour: { utilization: 100, resets_at: '2026-09-08T05:00:00Z' },
    }, null, 2)}\n`);

    assert.deepEqual(
      quotaQuarantineUntil({
        text: "You've hit your session limit · resets 8:20pm (Asia/Hong_Kong)",
        pool: 'claude-code', bullswarmDir: dir, now: NOW,
      }),
      { until: Date.parse('2026-09-08T12:20:00Z'), source: 'message' },
    );

    assert.deepEqual(
      quotaQuarantineUntil({
        text: 'usage limit reached', pool: 'claude-code', bullswarmDir: dir, now: NOW,
      }),
      { until: Date.parse('2026-09-08T14:59:59Z'), source: 'meter' },
    );

    // A cached reset already in the past is not a deadline.
    assert.deepEqual(
      quotaQuarantineUntil({
        text: 'usage limit reached', pool: 'stale-pool', bullswarmDir: dir, now: NOW,
      }),
      { until: NOW + DEFAULT_QUOTA_QUARANTINE_MS, source: 'default' },
    );

    assert.deepEqual(
      quotaQuarantineUntil({ text: 'usage limit reached', pool: 'no-meter', bullswarmDir: dir, now: NOW }),
      { until: NOW + DEFAULT_QUOTA_QUARANTINE_MS, source: 'default' },
    );
    assert.deepEqual(
      quotaQuarantineUntil({ text: 'usage limit reached', now: NOW }),
      { until: NOW + DEFAULT_QUOTA_QUARANTINE_MS, source: 'default' },
    );
    assert.equal(DEFAULT_QUOTA_QUARANTINE_MS, 30 * 60_000, 'the flat fallback is 30 minutes, not 10');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
