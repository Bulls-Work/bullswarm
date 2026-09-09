// bullswarm numeric coercion — one strict reading of "is this a number?".
//
// Doctrine:
//   N1. A missing measurement never becomes a confident zero. `null`,
//       `undefined`, `''`, whitespace, booleans, `NaN` and `±Infinity` all
//       mean "no reading" and coerce to null — not to 0, and not to 1 for
//       `true`. Every meter, forecast, spend and datapack loader reads through
//       this function so a blank field in one provider's payload cannot show
//       up downstream as a measured zero.
//   N2. Zero dependencies, no I/O: this module is a leaf so any layer
//       (src/meters, src/lib, the datapack loaders) can import it without a
//       cycle.

/**
 * Finite number, or null when the value is not a number at all.
 *
 * Rejects, in addition to what `Number.isFinite(Number(value))` alone would
 * reject: `null`/`undefined` (`Number(null) === 0`), `''` and whitespace-only
 * strings (`Number('') === 0`), booleans (`Number(true) === 1`), and arrays
 * (`Number([]) === 0`). Every one of those is an absent reading wearing a
 * number's clothes.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
export function finiteOrNull(value) {
  if (value == null || typeof value === 'boolean' || Array.isArray(value)) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
