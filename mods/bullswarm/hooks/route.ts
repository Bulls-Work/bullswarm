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

/** Which bullswarm lane a subagent type maps to; null keeps it in-session. */
const LANE_OF: Record<string, BullswarmLane> = {
  '': 'build',
  'general-purpose': 'build',
  claude: 'build',
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

/** The argv `$.process.run` spawns; no shell, the task inline. */
export function argvOf(input: {
  lane: BullswarmLane
  cwd: string
  task: string
  timeoutSec: number
  noCaller: boolean
}): string[] {
  return [
    'bullswarm',
    'run',
    '--lane',
    input.lane,
    '--add-dir',
    input.cwd,
    '--json',
    '--timeout',
    String(input.timeoutSec),
    ...(input.noCaller ? ['--no-caller'] : []),
    '--prompt',
    input.task,
  ]
}
