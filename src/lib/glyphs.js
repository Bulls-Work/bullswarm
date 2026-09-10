// Terminal glyph table for the live-refreshing views.
//
// macOS Terminal.app ships no monospace font that can draw the Braille
// spinner. Every font it offers is 0/256 over U+2800-U+28FF, and every one
// also lacks U+29D6 (hourglass):
//
//   Andale Mono  braille 0/256  also missing  ⊘ ✓ ◇ ↳ ⧖ ✗ ⚠ ⚙ ♡ ⟡ ◆ ↻ ▶ ↺
//   Menlo        braille 0/256  also missing  ⧖ ⟡
//   SF Mono      braille 0/256  also missing  ⊘ ◇ ↳ ⧖ ⚠ ⚙ ♡ ⟡ ↻ ↺
//   Monaco       braille 0/256  also missing  ⊘ ✓ ◇ ↳ ⧖ ✗ ⚠ ● ○ ⚙ ♡ ⟡ ■ ↻ ▶ ↺
//   Courier New  braille 0/256  also missing  ⊘ ✓ ◇ ↳ ⧖ ✗ ⚠ ⚙ ♡ ⟡ ◆ ↻ ▶ ↺
//
// Terminal.app does not substitute another face for these, so the dashboard
// repaints a "?" where each one should be — and because the spinner advances
// every 400ms, those question marks flash. The terminal cannot tell us which
// font is loaded, so ASCII mode covers the union of what any of them lacks.
//
// Box drawing, ·, ›, ×, …, ≈, ≥ and █ are in all five, so panels keep their
// borders in ASCII mode. The four arrows ↑ ↓ ← → are only missing from
// Monaco, and they live in the frozen DASHBOARD_KEYS constant that binds at
// import time, before any env pin can apply — left alone deliberately.
//
// Replacements are one column wide: panel width maths uses String#length, so
// a wide or combining substitute would shear every border.

const UNICODE = Object.freeze({
  spinner: Object.freeze(['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']),
  ok: '✓',
  fail: '✗',
  blocked: '⊘',
  plan: '◇',
  detail: '↳',
  waiting: '⧖',
  warn: '⚠',
  ongoing: '●',
  pending: '○',
  stopped: '■',
  heartbeat: '♡',
  agent: '⟡',
  evidence: '◆',
  retry: '↻',
  reroute: '↺',
  started: '▶',
  inflight: '⚙',
});

const ASCII = Object.freeze({
  spinner: Object.freeze(['|', '/', '-', '\\']),
  ok: '+',
  fail: 'x',
  blocked: '#',
  plan: '~',
  detail: '>',
  waiting: ':',
  warn: '!',
  ongoing: '*',
  pending: 'o',
  stopped: '=',
  heartbeat: '.',
  agent: '@',
  evidence: '&',
  retry: '^',
  reroute: '%',
  started: '>',
  inflight: 'w',
});

// Every glyph ASCII mode is responsible for. Tests assert a rendered frame
// contains none of these once ASCII mode is on, so adding a glyph to UNICODE
// without an ASCII twin fails the suite instead of shipping a stray "?".
export const SUBSTITUTED_GLYPHS = Object.freeze(
  Object.entries(UNICODE).flatMap(([key, value]) => (key === 'spinner' ? value : [value])),
);

const truthy = (value) => value !== undefined && value !== '' && value !== '0' && value !== 'false';

// Which table to use, in precedence order. BULLSWARM_ASCII wins outright so a
// user staring at question marks has one switch that always works, and
// BULLSWARM_UNICODE overrides the auto-detection for a terminal we guessed
// wrong about.
export function asciiGlyphsPreferred(env = process.env) {
  if (truthy(env.BULLSWARM_ASCII)) return true;
  if (truthy(env.BULLSWARM_UNICODE)) return false;
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || '';
  if (locale && !/utf-?8/i.test(locale)) return true;
  const term = env.TERM || '';
  if (term === 'dumb' || term === 'linux') return true;
  // ponytail: one terminal is enough. Add another only with cmap evidence
  // like the table above, never on a hunch about a font.
  return env.TERM_PROGRAM === 'Apple_Terminal';
}

export function glyphs(env = process.env) {
  return asciiGlyphsPreferred(env) ? ASCII : UNICODE;
}

export function spinnerGlyph(frame = 0, env = process.env) {
  const { spinner } = glyphs(env);
  // A repaint timer must never paint `undefined`, so a non-finite frame
  // counter (Infinity from a clock jump, NaN from a missing field) parks on
  // the first frame rather than indexing off the end.
  const index = Number(frame);
  return spinner[Number.isFinite(index) ? Math.abs(Math.trunc(index)) % spinner.length : 0];
}
