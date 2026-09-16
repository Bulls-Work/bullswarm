/* @jsxRuntime classic */
/* @jsx h */
/* @jsxFrag Fragment */
import type { ElementTable, RenderElement } from 'claude-code'

import type { BullswarmAssignment, BullswarmPool, BullswarmRun } from '../types'
import { poolRows } from './pool-rows'
import { looseOf, stepsOf, timingOf } from './runs'

export type StripUi = Pick<
  ElementTable<'terminal' | 'desktop'>,
  'Box' | 'Text' | 'Button'
>

export type StripModel = {
  pools: readonly BullswarmPool[]
  runs: readonly BullswarmRun[]
  assignments: readonly BullswarmAssignment[]
  autoRoute: boolean
  routedCount: number
  lastError: string | null
  paneOpen: boolean
  selectedShortId: string | null
  /** Pool name → what the strip shows for it. */
  names: ReadonlyMap<string, string>
  /** `full` draws the pool rows too; `runs` only the run rows. */
  level: 'runs' | 'full'
}

export type StripActions = {
  /** Opens (or closes) the run pane on the selected run. */
  pane: () => void
  /** Selects one run and opens the pane on it. */
  open: (shortId: string) => void
}

/**
 * The strip in the AbovePrompt band, kept to one idea per row: a header
 * line with the pane button, one row per pool (bar, used/elapsed, pace,
 * what is running there), one row per ongoing run (progress, the step in
 * flight, the goal), one per standalone dispatch.
 */
export function strip(
  kit: { ui: StripUi; columns: number; maxRows: number },
  model: StripModel,
  actions: StripActions,
): RenderElement {
  const { Box, Text, Button } = kit.ui
  const budget = Math.max(1, kit.maxRows - 1)
  const pools = model.level === 'full' ? model.pools.filter(p => p.enabled).slice(0, budget) : []
  const loose = looseOf(model.runs, model.assignments)
  const runRows = Math.max(0, budget - pools.length)
  const runs = model.runs.slice(0, runRows)
  const looseShown = loose.slice(0, Math.max(0, runRows - runs.length))
  const nameOf = (pool: string) => model.names.get(pool) ?? pool

  const summary = [
    model.runs.length ? `${model.runs.length} run${model.runs.length === 1 ? '' : 's'}` : 'no runs',
    model.assignments.length ? `${model.assignments.length} in flight` : '',
    model.routedCount ? `${model.routedCount} routed` : '',
    model.autoRoute ? '' : 'route off',
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" flexWrap="nowrap" gap={1} marginRight={4}>
        <Box flexShrink={1} overflow="hidden">
          <Text wrap="truncate-end">
            <Text bold color="magenta">
              bullswarm
            </Text>
            <Text dimColor> {summary}{model.level === 'full' ? ' · used/elapsed · pace' : ''}</Text>
          </Text>
        </Box>
        <Box flexShrink={0} flexDirection="row" gap={1}>
          <Button
            key="pane"
            hotkey="w"
            label={model.paneOpen ? '[w] close' : '[w] runs'}
            onPress={actions.pane}
          />
        </Box>
      </Box>
      {model.lastError ? (
        <Text color="red" wrap="truncate-end">
          {model.lastError}
        </Text>
      ) : null}
      {poolRows({ Box, Text }, pools, model.assignments, model.names)}
      {runs.map((run, i) => {
        const steps = stepsOf(run, model.assignments)
        const done = `${run.actionsSucceeded}/${run.actionsTotal}`
        // One step in flight is named; the rest are counted, so the goal
        // that says which run this is always stays on the row.
        const named = steps
          .slice(0, 1)
          .map(a => `${a.actionId ?? '?'}@${nameOf(a.pool)}${timingOf(a) ? ` ${timingOf(a)}` : ''}`)
          .join(', ')
        const running = steps.length > 1 ? `${named}, and ${String(steps.length - 1)} more` : named
        const finished = run.status !== 'running'
        const selected = model.selectedShortId === run.shortId && model.paneOpen

        return (
          <Box key={run.runId} flexDirection="row">
            <Button
              key={`open-${run.shortId}`}
              plain
              hotkey={i < 9 ? String(i + 1) : undefined}
              label={`${finished ? '◼' : '▶'} ${run.shortId}`}
              onPress={() => actions.open(run.shortId)}
            />
            <Text wrap="truncate-end">
              <Text color="magenta">{selected ? ' ●' : ''}</Text>
              <Text color="green">
                {'  '}
                {done}
              </Text>
              {finished ? <Text color="yellow">  {run.status}</Text> : null}
              <Text color="cyan">{running ? `  ${running}` : ''}</Text>
              <Text dimColor>  {run.goal}</Text>
            </Text>
          </Box>
        )
      })}
      {looseShown.map((a, i) => (
        <Box key={`loose-${String(i)}`} flexDirection="row">
          <Text wrap="truncate-end">
            <Text color="cyan" bold>
              ▶ run
            </Text>
            <Text>
              {'  '}
              {a.lane}@{nameOf(a.pool)}
            </Text>
            <Text dimColor>
              {timingOf(a) ? `  ${timingOf(a)}` : ''}
              {a.source ? `  ${a.source}` : ''}
            </Text>
          </Text>
        </Box>
      ))}
    </Box>
  )
}
