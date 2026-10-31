/** Rows herdr's screen reader sees under the spinner: it looks at the bottom 12 non-empty lines. */
export const HERDR_STRIP_ROWS = 5

/**
 * How many pool and run rows the strip may draw below its header. Under
 * herdr the whole strip (header included) stays within 5 rows, so Claude's
 * spinner line stays inside the window herdr reads to tell working from idle.
 */
export function stripBudget(maxRows: number, underHerdr: boolean): number {
  const budget = Math.max(1, maxRows - 1)
  return budget
}

/** Pool rows, then run rows, then standalone rows, each filling what the one before left. */
export function stripRowCounts(
  budget: number,
  poolCount: number,
  runCount: number,
  looseCount: number,
): { pools: number; runs: number; loose: number; total: number } {
  const pools = Math.min(poolCount, budget)
  const runRows = Math.max(0, budget - pools)
  const runs = Math.min(runCount, runRows)
  const loose = Math.min(looseCount, Math.max(0, runRows - runs))
  return { pools, runs, loose, total: 1 + pools + runs + loose }
}
