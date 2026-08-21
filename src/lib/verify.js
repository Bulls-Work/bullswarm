// bullswarm verify gate — judge by CONTENT, not exit code.
//
// Doctrine encoded here (each rule earned the hard way):
//   V1. Exit code alone decides nothing in either direction.
//   V2. A confident statement of INTENT with no work behind it is a no-op,
//       not a result. An output that merely OPENS with an announcement is
//       judged on its remainder; an output made ONLY of announcements is a
//       no-op regardless of its byte length.
//   V3. Failure patterns (rate limits, auth errors) only count near the
//       START of an output. A delegate WRITING ABOUT rate limits is not
//       rate-limited. Outputs shorter than SHORT_OUTPUT_MAX are judged
//       whole: they are short enough to be nothing but an error.
//   V4. Sentence splitting breaks ONLY before a capital letter, digit, or
//       markdown starter after terminal punctuation + whitespace. Tokens
//       like ".d.ts", "Node.js", "log.ts" never shred.

export const FAILURE_SCAN_HEAD = 400; // chars scanned for failure patterns
export const SHORT_OUTPUT_MAX = 600;  // below this, whole output is the head
export const MIN_SUBSTANCE_CHARS = 80;

// Patterns indicating the DELEGATE ITSELF failed (not that it discusses
// failure). Case-insensitive against the head slice.
export const FAILURE_PATTERNS = [
  /^rate limit/i,
  /^exceeded.*quota/i,
  /^\s*(error|fatal|exception)\b/i,
  /unauthorized/i,
  /authentication failed/i,
  /invalid api key/i,
  /api key expired/i,
  /permission denied/i,
  /command not found/,
  /no such file or directory/,
  /econnrefused/i,
  /etimedout/i,
  /socket hang up/i,
  /too many requests/i,
  /service unavailable/i,
  /bad gateway/i,
];

// First-person future = intent, not work.
const INTENT_RE =
  /\b(?:i'?ll|i will|i'?m going to|i am going to|i plan to|i intend to|let me)\b/i;

// After terminal punctuation, a new sentence starts only at a capital,
// digit, quote, bracket, or markdown starter — nothing else.
const NEXT_SENTENCE_START = /[A-Z0-9"'`(#[*\->]/;

/** Split text into sentences using the V4 boundary rule. */
export function splitSentences(text) {
  const sentences = [];
  let start = 0;
  let i = 0;
  const push = (end) => {
    const s = text.slice(start, end).trim();
    if (s.length > 0) sentences.push(s);
  };
  while (i < text.length) {
    const ch = text[i];
    if (ch === '.' || ch === '!' || ch === '?') {
      let j = i;
      while (j + 1 < text.length && /[.!?]/.test(text[j + 1])) j++;
      const k = j + 1;
      if (k >= text.length) {
        push(text.length);
        return sentences;
      }
      if (/\s/.test(text[k])) {
        let m = k;
        while (m < text.length && /\s/.test(text[m])) m++;
        if (
          m >= text.length ||
          NEXT_SENTENCE_START.test(text[m])
        ) {
          push(m);
          start = m;
          i = m;
          continue;
        }
      }
      i = j + 1;
      continue;
    }
    i++;
  }
  push(text.length);
  return sentences;
}

function scanForFailure(text) {
  const slice =
    text.length < SHORT_OUTPUT_MAX ? text : text.slice(0, FAILURE_SCAN_HEAD);
  return FAILURE_PATTERNS.some((re) => re.test(slice));
}

/**
 * Work = non-intent sentences carrying real substance after announcements
 * are stripped. Byte length alone proves nothing (a 477-byte pure
 * announcement is still a no-op).
 */
export function looksLikeWork(text) {
  const sentences = splitSentences(text);
  const substance = sentences.filter((s) => !INTENT_RE.test(s)).join(' ');
  return substance.trim().length >= MIN_SUBSTANCE_CHARS;
}

/**
 * Judge delegate output content.
 * @param {string} text   full delegate output
 * @param {object} opts   { exitCode, expectWork=true }
 * @returns {{verdict:'pass'|'fail'|'intent_only', why:string}}
 */
export function judgeContent(text, { exitCode, expectWork = true } = {}) {
  void exitCode; // content-only judgment; exit handled by the caller
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { verdict: 'fail', why: 'empty output' };
  }
  if (scanForFailure(text)) {
    return { verdict: 'fail', why: 'failure pattern at output head' };
  }
  if (expectWork && !looksLikeWork(text)) {
    return { verdict: 'intent_only', why: 'announcement without substance' };
  }
  return { verdict: 'pass', why: 'content passed all gates' };
}
