/**
 * The `$.bullswarm` noun: what the bullswarm mod adds to `$` in the
 * `engine.create` fold, for any plugin loaded beside it.
 */
export type Bullswarm = {
  /** The pools as last read from `bullswarm pools --json` (reads once if never read). */
  pools: () => Promise<readonly BullswarmPool[]>
  /** Re-read the pools, runs and assignments now. */
  refresh: () => Promise<readonly BullswarmPool[]>
  /** Ongoing workflow runs as last read. */
  runs: () => Promise<readonly BullswarmRun[]>
  /** Work in flight right now, across every bullswarm process. */
  assignments: () => Promise<readonly BullswarmAssignment[]>
  /** The action list of one run, read now. */
  detail: (shortId: string) => Promise<BullswarmRunDetail>
  /** One step of a run with its latest attempt, as the TUI's agent panel shows it. */
  step: (shortId: string, actionId: string) => Promise<BullswarmStep>
  /** Every pool × tier rung: the model and reasoning level dispatch sends there. */
  rungs: () => Promise<BullswarmRung[]>
  /** Dispatch one bounded task through `bullswarm run` and return its verdict. */
  run: (args: BullswarmRunArgs) => Promise<BullswarmVerdict>
}

export type BullswarmLane = 'analyze' | 'build' | 'chore'

/** One ongoing workflow run as `bullswarm workflow runs --json` lists it. */
export type BullswarmRun = {
  runId: string
  shortId: string
  goal: string
  status: string
  startedAt: string | null
  actionsSucceeded: number
  actionsTotal: number
}

/** One action of a run as `bullswarm workflow runs show --json` reports it. */
export type BullswarmAction = {
  id: string
  status: string
  attempts: number
  startedAt: string | null
  finishedAt: string | null
  outputFile: string | null
  lastFailure: string | null
  /** The latest attempt, when one exists. */
  latest: BullswarmAttempt | null
}

/** One attempt at an action. */
export type BullswarmAttempt = {
  actionId: string
  ordinal: number
  status: string
  pool: string | null
  model: string | null
  startedAt: string | null
  finishedAt: string | null
  why: string | null
  wallSec: number | null
  lastActivity: string | null
}

/**
 * One step of a run as `bullswarm workflow action show <run> <step> --json`
 * reports it: the action record and its latest attempt, the same facts the
 * TUI's agent panel draws.
 */
export type BullswarmStep = {
  id: string
  purpose: string
  kind: string | null
  lane: string | null
  effort: string | null
  status: string
  outputFile: string | null
  lastFailure: string | null
  attempt: BullswarmStepAttempt | null
  readAt: number
}

/** The latest attempt of a step, with its route and activity. */
export type BullswarmStepAttempt = {
  ordinal: number
  status: string
  pool: string | null
  model: string | null
  /** The reasoning level applied, when the connector reports one. */
  reasoning: string | null
  /** Why dispatch picked this pool. */
  routeReason: string | null
  startedAt: string | null
  finishedAt: string | null
  lastActivityAt: string | null
  outputBytes: number | null
  taskFile: string | null
  outputFile: string | null
  why: string | null
  wallSec: number | null
  /** `tokens read=… output=… · cost≈$…` once usage is known. */
  usage: string | null
  /** The latest agent event: kind, summary and status. */
  lastEvent: string | null
}

/** The action list of one run. */
export type BullswarmRunDetail = {
  runId: string
  shortId: string
  ongoing: boolean
  actions: readonly BullswarmAction[]
  readAt: number
}

/** One live dispatch from the shared in-flight ledger (`bullswarm assignments --json`). */
export type BullswarmAssignment = {
  pool: string
  poolLabel?: string | null
  model: string | null
  lane: string
  source: string
  runId: string | null
  actionId: string | null
  elapsedMinutes: number | null
  expectedMinutes: number | null
}

/** One quota window of a pool, from the provider's meter snapshot. */
export type BullswarmWindow = {
  /** `5h`, `7d` or `mo`. */
  key: string
  usedPct: number
  resetsAt: string | null
  /** Percent of the window elapsed, from its reset time; null when unknown. */
  elapsedPct: number | null
}

/** One pool × effort-tier rung from `bullswarm strategy rungs --json`. */
export type BullswarmRung = {
  pool: string
  poolLabel?: string | null
  tier: string
  model: string | null
  reasoning: string | null
  dispatches: number
  okShare: number | null
  medianMinutes: number | null
}

export type BullswarmPool = {
  name: string
  /** Core per-home display label; the durable id remains `name`. */
  poolLabel?: string | null
  enabled: boolean
  /** The provider's meter windows, in `5h`, `7d`, `mo` order, when reported. */
  windows: readonly BullswarmWindow[]
  /** When the meter snapshot was taken. */
  capturedAt: string | null
  /** The provider's plan name, when it reports one. */
  planType: string | null
  /** A credit meter, when the provider counts credits. */
  credits: { used: number; limit: number; unit: string } | null
  /** Percent of the pacing window's quota used, when the provider reports a meter. */
  usedPct: number | null
  /** Percent of the pacing window elapsed. */
  elapsedPct: number | null
  /** elapsedPct − usedPct: positive is spare quota, negative is over pace. */
  pace: number | null
  pacingWindow: string | null
  fiveHourUsedPct: number | null
  costRank: number | null
  meterSource: string | null
  /** A short provider error reason while a stale meter is held. */
  meterError: string | null
  /** Epoch milliseconds at which a stale-meter hold may be retried. */
  meterHoldUntil: number | null
  incumbentLane: readonly string[]
  quarantine: { until: number; reason: string; kind: string } | null
}

export type BullswarmRunArgs = {
  lane: BullswarmLane
  task: string
  cwd: string
  /** Wall-clock cap passed as `--timeout`, seconds. */
  timeoutSec?: number
  /** Exclude the calling agent's own pool (`--no-caller`). */
  noCaller?: boolean
}

export type BullswarmVerdict = {
  /** False when the output held no verdict document at all. */
  found: boolean
  ok: boolean
  keepOnClaude: boolean
  why: string | null
  outFile: string | null
  pool: string | null
  model: string | null
  shortId: string | null
  /** From the verdict's `meta`, when present. */
  wallSec: number | null
  inputTokens: number | null
  outputTokens: number | null
  exitCode: number
  raw: string
}

declare module 'claude-code' {
  interface EngineInterface {
    bullswarm: Bullswarm
  }
}
