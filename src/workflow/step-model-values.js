// Small value helpers the Step page model shares: an own-key test, a
// trimmed text or null, a deep copy, and the millisecond readings of a
// duration and a timestamp. Nothing here reads a file or a stream.

function hasOwn(value, key) {
  return Boolean(value && typeof value === 'object' && Object.hasOwn(value, key));
}

function textOrNull(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function clone(value) {
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => clone(entry));
  const output = {};
  for (const [key, entry] of Object.entries(value)) output[key] = clone(entry);
  return output;
}

function finiteMs(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function dateMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Provider timestamps are normally epoch milliseconds; tolerate epoch
    // seconds as well without turning a structured timestamp into prose.
    return value < 100_000_000_000 ? value * 1000 : value;
  }
  if (typeof value !== 'string' && !(value instanceof Date)) return null;
  const number = Date.parse(value);
  return Number.isFinite(number) ? number : null;
}

export {
  hasOwn,
  textOrNull,
  clone,
  finiteMs,
  dateMs,
};
