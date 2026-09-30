// The Step page's short value texts: a duration clock, a local time or date,
// an artifact size, a token count and a money amount. An unknown value stays
// null (or a dash for money), never a guessed figure.

import { finiteOrNull } from '../lib/num.js';
import { formatMoney } from '../lib/usage-basis.js';
import { finiteMs, dateMs } from './step-model-values.js';

const MONTH_TEXT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `49m07s` / `1h02m` / `30s`: the h/m/s clock, no decimals. */
export function stepClockText(ms) {
  if (ms == null || ms === '') return null;
  const value = finiteMs(ms);
  if (value == null) return null;
  const seconds = Math.round(value / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

function stepClockMs(value) {
  const at = dateMs(value);
  if (at == null) return null;
  const date = new Date(at);
  return {
    hh: String(date.getHours()).padStart(2, '0'),
    mm: String(date.getMinutes()).padStart(2, '0'),
    ss: String(date.getSeconds()).padStart(2, '0'),
    day: String(date.getDate()).padStart(2, '0'),
    month: MONTH_TEXT[date.getMonth()],
    year: String(date.getFullYear()),
  };
}

/** `01:50` in local time. */
function stepTimeText(value) {
  const parts = stepClockMs(value);
  return parts ? `${parts.hh}:${parts.mm}` : null;
}

/** `01:51:12` in local time. */
function stepTimeSecText(value) {
  const parts = stepClockMs(value);
  return parts ? `${parts.hh}:${parts.mm}:${parts.ss}` : null;
}

/** `20 Sep`. */
function stepDayText(value) {
  const parts = stepClockMs(value);
  return parts ? `${Number(parts.day)} ${parts.month}` : null;
}

/** `20 Sep 2026`. */
function stepDateText(value) {
  const parts = stepClockMs(value);
  return parts ? `${Number(parts.day)} ${parts.month} ${parts.year}` : null;
}

/** `2.4 KB`: one decimal, the way the kernel states an artifact's size. */
function stepBytesText(bytes) {
  const value = finiteOrNull(bytes);
  if (value == null || value < 0) return null;
  return `${(value / 1000).toFixed(1)} KB`;
}

/** `36.0M` / `713k` / `36`: a token class as the design prints it. */
function stepTokenText(value) {
  const tokens = finiteOrNull(value);
  if (tokens == null || tokens < 0) return null;
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(Math.round(tokens));
}

/** `$0.96` measured, `≈ $0.25` estimated, `—` unknown. */
function stepMoneyText(usd, { estimated = false } = {}) {
  const value = finiteOrNull(usd);
  if (value == null) return '—';
  const text = formatMoney(value);
  if (text === '-') return '—';
  return estimated ? `≈ ${text}` : text;
}

export {
  stepTimeText,
  stepTimeSecText,
  stepDayText,
  stepDateText,
  stepBytesText,
  stepTokenText,
  stepMoneyText,
};
