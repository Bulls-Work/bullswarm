// The ANSI text primitives every dashboard page paints with: the escape
// introducer, visible length, truncation, dim, the palette tint, bold and
// inverse, and whether colour meters are on (meterAnsi, blank).
import { asciiGlyphsPreferred } from '../lib/glyphs.js';
import { METER_COLORS } from './usage-view.js';

const ESC = '\x1b[';

export function dimText(value, width) {
  return `\x1b[2m${truncate(value, width)}\x1b[0m`;
}

// ------------------------------------------------- the palette on the page
//
// The pages name a palette role — or the stable hex returned by dash-kit for a
// pool/model series — and never invent a colour. Every value comes from
// METER_COLORS in usage-view.js, the one palette the product has; this file
// adds none. Colour is off wherever the meters are off, so an ascii terminal
// and a plain-text capture read the same words with no escapes in them.

const SGR_RESET = '\x1b[0m';
const SGR_BOLD = '\x1b[1m';
const SGR_NO_BOLD = '\x1b[22m';

const rgbOf = (hex) => {
  const value = Number.parseInt(String(hex).slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
};

/** `text` in the palette's `role`, or untouched where colour is off. */
export function tint(text, role) {
  const body = String(text ?? '');
  if (!body || !meterAnsi()) return body;
  const hex = typeof role === 'string' && role.startsWith('#') ? role : METER_COLORS[role];
  if (typeof hex !== 'string' || !/^#[0-9a-f]{6}$/i.test(hex)) return body;
  return `\x1b[38;2;${rgbOf(hex).join(';')}m${body}${SGR_RESET}`;
}

/** A key figure or a key name, bold — ASCII mode keeps bold, dim and inverse. */
function strong(text) {
  const body = String(text ?? '');
  if (!body) return body;
  return `${SGR_BOLD}${body}${SGR_NO_BOLD}`;
}

/**
 * The cursor row, inverse as the tab row: `\x1b[7m … \x1b[27m`. A painted row
 * resets its own cells, so reverse video is re-armed after each reset and the
 * whole row stays inverse. SGR only — the row keeps its text and its width —
 * and kept in ASCII mode, which drops colour but keeps bold, dim and inverse.
 */
function inverseText(text) {
  const body = String(text ?? '');
  if (!body) return body;
  return `\x1b[7m${body.replace(/\x1b\[0m/g, '\x1b[0m\x1b[7m')}\x1b[27m`;
}

export function truncate(value, width) {
  const text = String(value ?? '');
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}

const ANSI_SGR = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** How many columns a painted line really occupies. */
export const visibleLength = (value) => String(value ?? '').replace(ANSI_SGR, '').length;

/** Meters are background-coloured cells; an ascii terminal gets the plain bar. */
export function meterAnsi() {
  return !asciiGlyphsPreferred();
}

/** The blank a figure with no measurable source is painted as. */
export function blank() {
  return asciiGlyphsPreferred() ? '-' : '—';
}

export {
  ESC,
  strong,
  inverseText,
  ANSI_SGR,
};
