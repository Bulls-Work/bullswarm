/** Rows herdr's screen reader sees under the spinner: it looks at the bottom 12 non-empty lines. */
export const HERDR_STRIP_ROWS = 5

/**
 * How many pool and run rows the strip may draw below its header. Under
 * herdr the whole strip (header included) stays within 5 rows, so Claude's
 * spinner line stays inside the window herdr reads to tell working from idle.
 */
export function stripBudget(maxRows: number, underHerdr: boolean): number {
  const budget = Math.max(1, maxRows - 1)
  return underHerdr ? Math.min(budget, HERDR_STRIP_ROWS - 1) : budget
}

/**
 * Pool rows, then run rows, then standalone rows, each filling what the one
 * before left. An error row takes one row of the budget; callers pass it only
 * under herdr, where the whole strip stays within 5 rows.
 */
export function stripRowCounts(
  budget: number,
  poolCount: number,
  runCount: number,
  looseCount: number,
  hasError: boolean,
): { pools: number; runs: number; loose: number; total: number } {
  const room = Math.max(0, budget - (hasError ? 1 : 0))
  const pools = Math.min(poolCount, room)
  const runRows = Math.max(0, room - pools)
  const runs = Math.min(runCount, runRows)
  const loose = Math.min(looseCount, Math.max(0, runRows - runs))
  return { pools, runs, loose, total: 1 + (hasError ? 1 : 0) + pools + runs + loose }
}
