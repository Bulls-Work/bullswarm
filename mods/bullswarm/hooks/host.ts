import type {
  PaneCloseArgs,
  PaneOpenArgs,
  ProcessRunInit,
  ProcessRunResult,
  SessionUsage,
} from 'claude-code'

/**
 * The calls on `$` the mod's helpers make, each a closure written where
 * `$` is in scope: the engine tracks side effects at the call site, so `$`
 * itself is never passed around.
 */
export type Host = {
  run: (argv: readonly string[], init?: ProcessRunInit) => Promise<ProcessRunResult>
  usage: () => Promise<SessionUsage>
  read: (path: string) => Promise<string>
  storeSet: (key: string, value: unknown) => Promise<void>
  after: (ms: number, fn: () => void) => unknown
  now: () => number | Promise<number>
  invalidate: (event: 'ui.render' | 'prompt.context') => void
  log: (text: string) => void
  toast: (text: string) => void
  openPane: (pane: PaneOpenArgs) => Promise<void>
  closePane: (pane: PaneCloseArgs) => Promise<void>
}
