// A pool that takes build steps only with a check (connector buildsNeedCheck)
// refuses an unchecked build with a reason that matches CHECK_REFUSAL
// (buildCheckRefusal in dispatch-pools.js). When any off-tier reason is such a
// refusal, the step's why leads with the check, not with "no enabled pool has
// a model on the tier", which would send the caller after the wrong fix
// (biweekly eval and strict reviews, 2026-11-28). Its own module so both
// no-pool-why.js and step-route.js can use it without an import cycle.

export const CHECK_REFUSAL = /takes build steps only with a check/;

/**
 * The reason text when any of `offTier` is a check refusal: the check
 * refusals first, then the other off-tier reasons, then the fix. Null when
 * none is a check refusal.
 */
export function checkRefusalWhy(offTier = []) {
  const checks = offTier.filter((text) => CHECK_REFUSAL.test(text));
  if (!checks.length) return null;
  const rest = offTier.filter((text) => !CHECK_REFUSAL.test(text));
  return `${[...checks, ...rest].join('; ')}; add a check or route to another pool`;
}
