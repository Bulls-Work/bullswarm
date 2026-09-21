import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_QUOTA_SIGNATURES,
  DEFAULT_QUOTA_QUARANTINE_MS,
  DEFAULT_THROTTLE_SIGNATURES,
  DEFAULT_WINDOW_SIGNATURES,
  MAX_THROTTLE_RETRIES,
  THROTTLE_BACKOFF_MS,
  THROTTLE_MAX_WAIT_MS,
  QUOTA_PAUSE_METER_PCT,
  classifyQuotaLimit,
  decideQuotaPause,
  describePoolPause,
  dropQuotaRefusalSnapshot,
  findQuotaFailure,
  formatPauseClock,
  meterReadingOf,
  pauseProof,
  pauseWord,
  quotaPauseProven,
  pausingEnabled,
  readPausing,
  matchQuotaSignature,
  matchLikelyQuotaFailure,
  parseQuotaResetAt,
  quotaQuarantineUntil,
  throttleBackoffMs,
  GENERIC_QUOTA_SIGNATURES,
} from '../src/lib/quota.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const connectorOf = (path) => JSON.parse(readFileSync(join(REPO, path), 'utf8'));

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

// Q5: a transient throttle retries on the same pool; only a spent window pauses.

/** The two provider limit notices observed in real runs (2026-09). */
const COMMAND_CODE_THROTTLE = 'Error: Rate limit exceeded. Please wait a moment and try again.';
const CLAUDE_SESSION_WINDOW = "You've hit your session limit · resets 7pm (Asia/Hong_Kong)";

const PROVIDER_CONNECTORS = {
  'claude-code': 'src/providers/claude-code/connector.json',
  codex: 'src/providers/codex/connector.json',
  grok: 'src/providers/grok/connector.json',
  echo: 'src/providers/echo/connector.json',
  'command-code': 'providers/contrib/command-code/connector.json',
  opencode: 'providers/contrib/opencode/connector.json',
};

const limitOf = (connector, text) => {
  const hit = findQuotaFailure(connector, text, { now: NOW, timeZone: 'UTC' });
  return hit && { signature: hit.signature, limit: hit.limit, transient: hit.transient, waitMs: hit.waitMs };
};

test('the default table splits into window and throttle wording with nothing lost', () => {
  assert.deepEqual(
    [...DEFAULT_WINDOW_SIGNATURES, ...DEFAULT_THROTTLE_SIGNATURES].sort(),
    [...DEFAULT_QUOTA_SIGNATURES].sort(),
  );
  assert.ok(DEFAULT_THROTTLE_SIGNATURES.every((s) => !DEFAULT_WINDOW_SIGNATURES.includes(s)));
  assert.deepEqual(DEFAULT_THROTTLE_SIGNATURES, [
    'rate limit exceeded', 'rate_limit_exceeded', 'rate limited', 'too many requests',
  ]);
  for (const phrase of ['hit your session limit', 'usage limit reached', 'usage_credits_required', 'quota exceeded', 'insufficient_quota', 'out of credits']) {
    assert.ok(DEFAULT_WINDOW_SIGNATURES.includes(phrase), phrase);
  }
});

test("command-code's real rate-limit notice is a transient throttle, not a paused pool", () => {
  // This exact line paused command-code for ~4 hours while its meter read 5%.
  const connector = connectorOf(PROVIDER_CONNECTORS['command-code']);
  assert.deepEqual(limitOf(connector, COMMAND_CODE_THROTTLE), {
    signature: 'rate limit exceeded', limit: 'throttle', transient: true, waitMs: null,
  });
  // Still a detected limit notice: the attempt ends, it is simply not a pause.
  assert.equal(matchLikelyQuotaFailure(connector, COMMAND_CODE_THROTTLE), 'rate limit exceeded');
});

test("claude-code's real session-limit notice is a spent window that pauses the pool", () => {
  const connector = connectorOf(PROVIDER_CONNECTORS['claude-code']);
  assert.deepEqual(limitOf(connector, CLAUDE_SESSION_WINDOW), {
    signature: 'hit your session limit', limit: 'window', transient: false,
    // 19:00 Asia/Hong_Kong = 11:00Z, one hour after the fixed clock.
    waitMs: 60 * 60_000,
  });
});

test('every provider classifies both wordings: throttle retries, window pauses', () => {
  for (const [name, path] of Object.entries(PROVIDER_CONNECTORS)) {
    const connector = connectorOf(path);
    assert.equal(limitOf(connector, COMMAND_CODE_THROTTLE)?.limit, 'throttle', `${name}: throttle`);
    assert.equal(limitOf(connector, '429 Too Many Requests')?.limit, 'throttle', `${name}: 429`);
    assert.equal(limitOf(connector, 'Error: usage limit reached')?.limit, 'window', `${name}: window`);
    assert.equal(limitOf(connector, CLAUDE_SESSION_WINDOW)?.limit, 'window', `${name}: session window`);
  }
  // Each provider's own declared window wording pauses through its connector.
  const codex = connectorOf(PROVIDER_CONNECTORS.codex);
  assert.equal(limitOf(codex, 'usage_credits_required')?.limit, 'window');
  const claude = connectorOf(PROVIDER_CONNECTORS['claude-code']);
  assert.equal(limitOf(claude, "You've hit your limit · resets 3pm (Asia/Hong_Kong)")?.limit, 'window');
  // Every connector that declares throttle wording declares a list of strings.
  for (const [name, path] of Object.entries(PROVIDER_CONNECTORS)) {
    const declared = connectorOf(path).throttleSignatures;
    assert.ok(declared === undefined || (Array.isArray(declared) && declared.every((s) => typeof s === 'string')), name);
  }
});

test('no provider lists transient throttle wording as an auth signature', () => {
  // An auth hit pauses a pool for 10 minutes before the limit rule is asked;
  // grok listed "rate limit" there until 0.35.2, so its 429 paused the pool.
  for (const [name, path] of Object.entries(PROVIDER_CONNECTORS)) {
    for (const phrase of connectorOf(path).authSignatures ?? []) {
      assert.doesNotMatch(phrase, /rate.?limit|too many requests|429/i, `${name}: "${phrase}"`);
    }
  }
});

test('throttle wording that also names a spent window is window wording; a long wait is not', () => {
  assert.equal(limitOf({}, 'Rate limit exceeded: weekly usage limit reached').limit, 'window');
  assert.equal(limitOf({}, 'Error: rate limit exceeded: quota for this month is spent').limit, 'window');
  assert.equal(limitOf({}, 'Too many requests (credits exhausted)').limit, 'window');
  // Window wording on the line after the notice counts; unrelated text further on does not.
  assert.equal(limitOf({}, 'Error: rate limited\nYour weekly limit resets Monday.').limit, 'window');
  assert.equal(
    limitOf({}, `${COMMAND_CODE_THROTTLE}\n\nlater: agent notes\nthe usage limit docs were read`).limit,
    'throttle',
  );
  // A throttle naming its own reset hours away still says nothing about a
  // spent window (Q6): it is a throttle whose wait is too long to sit out on
  // the same pool, so the attempt falls over instead.
  const fiveHours = findQuotaFailure({}, 'Rate limit exceeded · resets 3pm', { now: NOW, timeZone: 'UTC' });
  assert.equal(fiveHours.limit, 'throttle');
  assert.equal(fiveHours.transient, true);
  assert.equal(fiveHours.waitMs, 5 * 60 * 60_000);
  assert.equal(fiveHours.retrySamePool, false);
  // A short named wait stays a throttle and is the backoff.
  const shortWait = limitOf({}, 'too many requests; try again in 30 seconds');
  assert.deepEqual(shortWait, { signature: 'too many requests', limit: 'throttle', transient: true, waitMs: 30_000 });
  const edge = findQuotaFailure({}, `rate limited, try again in ${THROTTLE_MAX_WAIT_MS / 60_000} minutes`, { now: NOW });
  assert.equal(edge.limit, 'throttle');
  assert.equal(edge.retrySamePool, true);
  const beyond = findQuotaFailure({}, `rate limited, try again in ${THROTTLE_MAX_WAIT_MS / 60_000 + 1} minutes`, { now: NOW });
  assert.equal(beyond.limit, 'throttle');
  assert.equal(beyond.retrySamePool, false);
});

test('connector throttle wording extends the defaults; the wording decides, not the list', () => {
  const connector = { quotaSignatures: ['seat is spent'], throttleSignatures: ['slow down please'] };
  assert.deepEqual(limitOf(connector, 'slow down please'), {
    signature: 'slow down please', limit: 'throttle', transient: true, waitMs: null,
  });
  assert.equal(limitOf(connector, 'seat is spent').limit, 'window');
  assert.equal(limitOf({}, 'slow down please'), null, 'undeclared phrases are not limits');
  // An installed connector copy that listed a generic throttle phrase as window
  // wording (merged before the split) still gets the throttle behaviour.
  assert.equal(limitOf({ quotaSignatures: ['rate limit exceeded'] }, COMMAND_CODE_THROTTLE).limit, 'throttle');
  // The Q2 shape gate applies to throttle wording too.
  assert.equal(findQuotaFailure(connector, 'The agent wrote a longer note about the API, which said slow down please.'), null);
  // Narration about another service is still not a limit at all.
  assert.equal(findQuotaFailure({}, 'Rate limited by the GitHub API while listing PRs, retrying in 30s'), null);
});

test('classifyQuotaLimit reads the notice it is given', () => {
  assert.deepEqual(
    classifyQuotaLimit({}, { signature: 'rate limit exceeded', line: COMMAND_CODE_THROTTLE }, { now: NOW }),
    { limit: 'throttle', waitMs: null, resetAt: null, explicit: false },
  );
  // Window wording without a reset is not proof on its own (Q6).
  assert.deepEqual(
    classifyQuotaLimit({}, { signature: 'usage limit reached', line: 'usage limit reached' }, { now: NOW }),
    { limit: 'window', waitMs: null, resetAt: null, explicit: false },
  );
  const named = classifyQuotaLimit({}, {
    signature: 'hit your session limit', line: CLAUDE_SESSION_WINDOW,
  }, { now: NOW });
  assert.equal(named.explicit, true);
  assert.equal(iso(named.resetAt), '2026-09-08T11:00:00.000Z');
  // Wording that names no window is a throttle, never a pause.
  assert.equal(classifyQuotaLimit({}, { signature: 'mystery', line: 'mystery' }, { now: NOW }).limit, 'throttle');
});

test('throttle backoff is short: the named wait, else the fixed schedule', () => {
  assert.deepEqual(THROTTLE_BACKOFF_MS, [20_000, 60_000]);
  assert.equal(MAX_THROTTLE_RETRIES, 2);
  assert.equal(throttleBackoffMs(1), 20_000);
  assert.equal(throttleBackoffMs(2), 60_000);
  assert.equal(throttleBackoffMs(9), 60_000);
  assert.equal(throttleBackoffMs(0), 20_000);
  assert.equal(throttleBackoffMs(1, { waitMs: 30_000 }), 30_000);
  assert.equal(throttleBackoffMs(1, { waitMs: 10 }), 1000);
  assert.equal(throttleBackoffMs(1, { waitMs: 99 * 60_000 }), THROTTLE_MAX_WAIT_MS);
  assert.equal(throttleBackoffMs(2, { waitMs: null }), 60_000);
});

// Q6: a pool pauses for quota only on proof — its own meter at >= 95%, or a
// provider line that says a usage window is spent AND names the reset.

/** The meter claude-code read when a transient line paused it (2026-09-21). */
const INCIDENT_METER = {
  captured_at: '2026-09-08T09:55:00Z',
  pool: 'claude-code',
  five_hour: { utilization: 48, resets_at: '2026-09-08T12:00:00Z' },
  seven_day: { utilization: 78, resets_at: '2026-09-11T12:00:00Z' },
  monthly: null,
};

const decide = (connector, text, opts = {}) => decideQuotaPause({
  connector,
  failure: findQuotaFailure(connector, text, { now: NOW, timeZone: 'UTC' }),
  meter: INCIDENT_METER,
  pausing: true,
  now: NOW,
  timeZone: 'UTC',
  ...opts,
});

test('the real command-code and claude-code transient lines never pause the pool', () => {
  for (const name of ['command-code', 'claude-code']) {
    const connector = connectorOf(PROVIDER_CONNECTORS[name]);
    const decision = decide(connector, COMMAND_CODE_THROTTLE);
    assert.equal(decision.pause, false, name);
    assert.equal(decision.rule, 'transient', name);
    assert.equal(decision.until, null, name);
    assert.equal(decision.retrySamePool, true, name);
    assert.equal(decision.line, COMMAND_CODE_THROTTLE, name);
    // The why names the line and the reading it was decided on.
    assert.equal(
      decision.why,
      `rate limited (transient): "${COMMAND_CODE_THROTTLE}" · pool not paused `
        + '(meter 5h 48% · weekly 78%, below 95%; no spent window with a reset named)',
      name,
    );
    assert.equal(quotaPauseProven(decision, NOW), false, name);
  }
});

test('a meter at 96% pauses until that window resets, whatever the line says', () => {
  const connector = connectorOf(PROVIDER_CONNECTORS['claude-code']);
  const meter = { ...INCIDENT_METER, seven_day: { utilization: 96, resets_at: '2026-09-11T12:00:00Z' } };
  const decision = decide(connector, COMMAND_CODE_THROTTLE, { meter });
  assert.equal(decision.pause, true);
  assert.equal(decision.rule, 'meter');
  assert.equal(iso(decision.until), '2026-09-11T12:00:00.000Z');
  assert.deepEqual(decision.meterWindow, { window: 'weekly', usedPct: 96, resetsAt: '2026-09-11T12:00:00.000Z' });
  assert.equal(decision.meter.readAt, '2026-09-08T09:55:00.000Z');
  assert.match(decision.why, /^usage window spent: meter reads weekly 96% \(>= 95%\) · paused until Fri 11 Sep 12:00 \(weekly reset\) · provider said "Error: Rate limit exceeded/);
  assert.equal(quotaPauseProven(decision, NOW), true);
  // The threshold is the documented 95%: 94.9% is below it, 95% is at it.
  assert.equal(QUOTA_PAUSE_METER_PCT, 95);
  const below = decide(connector, COMMAND_CODE_THROTTLE, {
    meter: { ...INCIDENT_METER, five_hour: { utilization: 94.9, resets_at: '2026-09-08T12:00:00Z' } },
  });
  assert.equal(below.pause, false);
  const at = decide(connector, COMMAND_CODE_THROTTLE, {
    meter: { ...INCIDENT_METER, five_hour: { utilization: 95, resets_at: '2026-09-08T12:00:00Z' } },
  });
  assert.equal(at.rule, 'meter');
  assert.equal(iso(at.until), '2026-09-08T12:00:00.000Z');
  // Two full windows: the fullest one is the proof.
  const both = decide(connector, COMMAND_CODE_THROTTLE, {
    meter: {
      ...INCIDENT_METER,
      five_hour: { utilization: 100, resets_at: '2026-09-08T12:00:00Z' },
      seven_day: { utilization: 97, resets_at: '2026-09-11T12:00:00Z' },
    },
  });
  assert.equal(both.meterWindow.window, '5h');
  assert.equal(iso(both.until), '2026-09-08T12:00:00.000Z');
});

test('an explicit exhaustion line that names its reset pauses until that reset', () => {
  const connector = connectorOf(PROVIDER_CONNECTORS['claude-code']);
  const decision = decide(connector, CLAUDE_SESSION_WINDOW);
  assert.equal(decision.pause, true);
  assert.equal(decision.rule, 'message');
  // 19:00 Asia/Hong_Kong = 11:00Z, one hour after the fixed clock.
  assert.equal(iso(decision.until), '2026-09-08T11:00:00.000Z');
  assert.equal(decision.resetsAt, '2026-09-08T11:00:00.000Z');
  assert.equal(decision.line, CLAUDE_SESSION_WINDOW);
  assert.equal(
    decision.why,
    `usage window spent: provider said "${CLAUDE_SESSION_WINDOW}" · paused until 11:00 (the reset it named)`
      + ' · meter 5h 48% · weekly 78%',
  );
  assert.equal(quotaPauseProven(decision, NOW), true);
  assert.equal(quotaPauseProven(decision, Date.parse('2026-09-08T11:00:00Z')), false, 'a passed reset proves nothing');
});

test('window wording without a reset, or a long throttle wait, does not pause below 95%', () => {
  for (const text of ['Error: usage limit reached', 'usage_credits_required', 'Rate limit exceeded · resets 3pm']) {
    const decision = decide(connectorOf(PROVIDER_CONNECTORS.codex), text);
    assert.equal(decision.pause, false, text);
    assert.equal(decision.rule, 'transient', text);
  }
  assert.equal(decide({}, 'Rate limit exceeded · resets 3pm').retrySamePool, false);
  // No meter at all is not proof either.
  assert.equal(decide({}, 'Error: usage limit reached', { meter: null }).pause, false);
});

test('both wordings are pinned for every provider: throttle retries, a named spent window pauses', () => {
  const windowWithReset = 'Error: usage limit reached · resets 3pm';
  for (const [name, path] of Object.entries(PROVIDER_CONNECTORS)) {
    const connector = connectorOf(path);
    for (const throttle of [COMMAND_CODE_THROTTLE, '429 Too Many Requests']) {
      const decision = decide(connector, throttle);
      assert.equal(decision.pause, false, `${name}: ${throttle}`);
    }
    const spent = decide(connector, windowWithReset);
    assert.equal(spent.rule, 'message', `${name}: spent window`);
    assert.equal(iso(spent.until), '2026-09-08T15:00:00.000Z', name);
    assert.equal(decide(connector, CLAUDE_SESSION_WINDOW).rule, 'message', `${name}: session window`);
  }
});

test('synthetic refusal windows and windows already over are not meter evidence', () => {
  const marker = {
    captured_at: '2026-09-08T09:59:00Z',
    source: 'quota-refusal',
    quota_refusal: { refused_at: '2026-09-08T09:59:00Z', resets_at: '2026-09-08T12:00:00Z', window: '5h' },
    five_hour: { utilization: 100, resets_at: '2026-09-08T12:00:00Z', source: 'quota-refusal' },
    seven_day: { utilization: 40, resets_at: '2026-09-11T12:00:00Z' },
  };
  const reading = meterReadingOf(marker, { now: NOW });
  assert.deepEqual(reading, {
    readAt: null,
    windows: [{ window: 'weekly', usedPct: 40, resetsAt: '2026-09-11T12:00:00.000Z' }],
  });
  assert.equal(decide({}, COMMAND_CODE_THROTTLE, { meter: marker }).pause, false);
  const over = { captured_at: '2026-09-08T04:00:00Z', five_hour: { utilization: 100, resets_at: '2026-09-08T05:00:00Z' } };
  assert.equal(meterReadingOf(over, { now: NOW }), null);
  assert.equal(decide({}, COMMAND_CODE_THROTTLE, { meter: over }).pause, false);
});

test('with automatic pausing off nothing pauses, even a spent window with a reset', () => {
  const connector = connectorOf(PROVIDER_CONNECTORS['claude-code']);
  const meter = { ...INCIDENT_METER, five_hour: { utilization: 100, resets_at: '2026-09-08T12:00:00Z' } };
  for (const text of [CLAUDE_SESSION_WINDOW, COMMAND_CODE_THROTTLE]) {
    const decision = decide(connector, text, { meter, pausing: false });
    assert.equal(decision.pause, false, text);
    assert.equal(decision.rule, 'off', text);
    assert.match(decision.why, /pool not paused: automatic pausing is off/);
    assert.equal(quotaPauseProven(decision, NOW), false);
  }
  assert.equal(pausingEnabled({}), true, 'default on');
  assert.equal(pausingEnabled({ strategy: { pausing: 'off' } }), false);
  assert.equal(pausingEnabled({ strategy: { pausing: false } }), false);
  assert.equal(pausingEnabled({ strategy: { pausing: 'on' } }), true);
});

test('the switch and the meter are read from the home when not passed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bullswarm-quota-home-'));
  try {
    mkdirSync(join(dir, 'meters'), { recursive: true });
    writeFileSync(join(dir, 'meters', 'claude-code.json'), `${JSON.stringify({
      ...INCIDENT_METER, five_hour: { utilization: 99, resets_at: '2026-09-08T12:00:00Z' },
    })}\n`);
    assert.equal(readPausing(dir), true, 'no state.json: on');
    const connector = connectorOf(PROVIDER_CONNECTORS['claude-code']);
    const failure = findQuotaFailure(connector, COMMAND_CODE_THROTTLE);
    const on = decideQuotaPause({ connector, failure, pool: 'claude-code', bullswarmDir: dir, now: NOW });
    assert.equal(on.rule, 'meter');
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ strategy: { pausing: 'off' } }));
    assert.equal(readPausing(dir), false);
    const off = decideQuotaPause({ connector, failure, pool: 'claude-code', bullswarmDir: dir, now: NOW });
    assert.equal(off.rule, 'off');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a pause reads in plain words: deadline, proof, provider line, meter, and the lift command', () => {
  const connector = connectorOf(PROVIDER_CONNECTORS['claude-code']);
  const decision = decide(connector, CLAUDE_SESSION_WINDOW);
  const record = {
    until: decision.until, reason: decision.why, kind: 'quota', rule: decision.rule,
    line: decision.line, meter: decision.meter, meterWindow: decision.meterWindow,
  };
  assert.equal(
    describePoolPause('claude-code', record, { now: NOW, timeZone: 'UTC' }),
    `paused until 11:00 · usage window spent, provider named the reset · provider: "${CLAUDE_SESSION_WINDOW}"`
      + ' · meter then: 5h 48% · weekly 78% · lift now: bullswarm pools resume claude-code',
  );
  const meterPause = decide(connector, COMMAND_CODE_THROTTLE, {
    meter: { ...INCIDENT_METER, seven_day: { utilization: 96, resets_at: '2026-09-11T12:00:00Z' } },
  });
  assert.match(
    describePoolPause('claude-code', { ...meterPause, kind: 'quota' }, { now: NOW, timeZone: 'UTC' }),
    /^paused until Fri 11 Sep 12:00 · usage window spent, meter read weekly 96% \(>= 95%\) · provider: "Error: Rate limit exceeded/,
  );
  assert.equal(
    describePoolPause('grok', { until: NOW + 10 * 60_000, kind: 'auth', reason: 'auth/throttle signature: "unauthorized"' }, { now: NOW, timeZone: 'UTC' }),
    'paused until 10:10 · auth: auth/throttle signature: "unauthorized" · lift now: bullswarm pools resume grok',
  );
  assert.match(
    describePoolPause('relay', { until: NOW + 60_000, kind: 'quota', reason: 'usage limit' }, { now: NOW, timeZone: 'UTC' }),
    /quota \(recorded without evidence\): usage limit/,
  );
  assert.equal(formatPauseClock(NOW + 60 * 60_000, { now: NOW, timeZone: 'Asia/Hong_Kong' }), '19:00');
  // The compact dashboard-row form of the same records.
  const opts = { now: NOW, timeZone: 'UTC' };
  assert.equal(pauseWord(record, opts), 'paused until 11:00 · provider named the reset');
  assert.equal(pauseWord({ ...meterPause, kind: 'quota' }, opts), 'paused until Fri 11 Sep 12:00 · meter weekly 96%');
  assert.equal(pauseWord({ until: NOW + 10 * 60_000, kind: 'auth' }, opts), 'paused until 10:10 · auth');
  assert.equal(pauseWord(null, opts), null);
  // The proof alone, for a line that already names the deadline.
  assert.equal(pauseProof(record), `provider named the reset: "${CLAUDE_SESSION_WINDOW}"`);
  assert.equal(pauseProof({ ...meterPause, kind: 'quota' }), `meter weekly 96% (>= 95%) · provider: "${COMMAND_CODE_THROTTLE}"`);
  assert.equal(pauseProof({ until: NOW, kind: 'auth', reason: 'x' }), null);
  assert.equal(pauseProof({ until: NOW, kind: 'quota', reason: 'usage limit' }), null);
});

test('dropping a refusal marker removes only a synthetic meter snapshot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bullswarm-quota-marker-'));
  try {
    mkdirSync(join(dir, 'meters'), { recursive: true });
    writeFileSync(join(dir, 'meters', 'walled.json'), JSON.stringify({ source: 'quota-refusal', quota_refusal: { refused_at: 'x' } }));
    writeFileSync(join(dir, 'meters', 'real.json'), JSON.stringify(INCIDENT_METER));
    assert.equal(dropQuotaRefusalSnapshot(dir, 'walled'), true);
    assert.equal(dropQuotaRefusalSnapshot(dir, 'real'), false);
    assert.equal(dropQuotaRefusalSnapshot(dir, 'absent'), false);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'meters', 'real.json'), 'utf8')), INCIDENT_METER);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
