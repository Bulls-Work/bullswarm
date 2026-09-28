import type { BullswarmLane, BullswarmPool } from '../types'

/** The Agent tool's arguments as the tool.call event carries them. */
export type AgentArgs = {
  prompt?: unknown
  description?: unknown
  subagent_type?: unknown
  isolation?: unknown
  run_in_background?: unknown
  fork?: unknown
  model?: unknown
}

/**
 * Which bullswarm lane a subagent type maps to; a missing entry keeps it
 * in-session. General subagents go to analyze: a build run must change a
 * file (run-step.js), so a subagent that only answers would fail
 * `not-produced` there, and a routed subagent's value is its answer.
 */
const LANE_OF: Record<string, BullswarmLane> = {
  '': 'analyze',
  'general-purpose': 'analyze',
  claude: 'analyze',
  Explore: 'analyze',
  Plan: 'analyze',
}

export type RouteDecision =
  | { route: true; lane: BullswarmLane; task: string }
  | { route: false; reason: string }

/**
 * Decides whether an Agent call may leave the session: only plain subagent
 * types, with a text prompt, not forked, not background, not isolated.
 */
export function decide(args: AgentArgs, pools: readonly BullswarmPool[]): RouteDecision {
  const type = typeof args.subagent_type === 'string' ? args.subagent_type : ''
  const lane = LANE_OF[type]
  if (!lane) return { route: false, reason: `subagent_type ${type} stays in-session` }
  if (typeof args.prompt !== 'string' || !args.prompt.trim())
    return { route: false, reason: 'no prompt text' }
  if (args.fork === true) return { route: false, reason: 'forked agents need this conversation' }
  if (args.run_in_background === true)
    return { route: false, reason: 'background agents report back later' }
  if (typeof args.isolation === 'string' && args.isolation)
    return { route: false, reason: `isolation ${args.isolation} is a session feature` }

  const candidates = pools.filter(
    p => p.enabled && !p.quarantine && p.name !== 'claude-code',
  )
  if (candidates.length === 0)
    return { route: false, reason: 'no enabled, unquarantined delegate pool' }

  return { route: true, lane, task: args.prompt }
}

/**
 * The argv `$.process.run` spawns; no shell, the task inline. `--no-retry`:
 * the mod's process budget holds one attempt, and a failed run already
 * falls back to running the subagent in-session.
 */
export function argvOf(input: {
  lane: BullswarmLane
  cwd: string
  task: string
  timeoutSec: number
}): string[] {
  return [
    'bullswarm',
    'run',
    '--lane',
    input.lane,
    '--add-dir',
    input.cwd,
    '--json',
    '--no-retry',
    '--timeout',
    String(input.timeoutSec),
    '--prompt',
    input.task,
  ]
}
