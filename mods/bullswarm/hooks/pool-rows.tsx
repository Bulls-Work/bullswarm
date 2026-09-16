/* @jsxRuntime classic */
/* @jsx h */
/* @jsxFrag Fragment */
import type { ElementTable, RenderElement } from 'claude-code'

import type { BullswarmAssignment, BullswarmPool } from '../types'
import { paceText, stateOf } from './pools'

/**
 * The meter colours, the truecolour values the status line renders with
 * (herdr remaps the basic ANSI colours through its theme, so names would
 * not agree with it): green below 50% used, amber from 50%, red from 80%.
 */
export const METER_GREEN = '#b6bd73'
export const METER_AMBER = '#e9c880'
export const METER_RED = '#bf6c69'

/** The fill colour of a meter by how much is used, as the status line picks it. */
export const severityColor = (usedPct: number | null): string =>
  usedPct === null ? 'gray' : usedPct >= 80 ? METER_RED : usedPct >= 50 ? METER_AMBER : METER_GREEN

const TRACK = '#3a3a3a'

/**
 * The bar as the status line draws it: background-coloured cells, filled
 * up to used% in the severity colour over a dark track, and a white
 * one-eighth line at the cell where elapsed% falls (the right edge of the
 * last cell once the window has fully elapsed).
 */
export function meterBar(
  Text: RowsUi['Text'],
  usedPct: number | null,
  elapsedPct: number | null,
  width: number,
  key?: string,
): RenderElement {
  if (usedPct === null) return <Text key={key} backgroundColor={TRACK}>{'·'.repeat(width)}</Text>
  const fill = severityColor(usedPct)
  const filled = Math.max(0, Math.min(width, Math.floor((usedPct / 100) * width)))
  let mark = -1
  let glyph = '▏'
  if (elapsedPct !== null) {
    mark = Math.floor((elapsedPct / 100) * width)
    if (mark >= width) {
      mark = width - 1
      glyph = '▕'
    }
  }
  const cells: RenderElement[] = []
  let i = 0
  while (i < width) {
    const bg = i < filled ? fill : TRACK
    if (i === mark) {
      cells.push(
        <Text key={`m${String(i)}`} color="white" backgroundColor={bg}>
          {glyph}
        </Text>,
      )
      i += 1
      continue
    }
    let j = i
    while (j < width && j !== mark && (j < filled) === (i < filled)) j += 1
    cells.push(
      <Text key={`c${String(i)}`} backgroundColor={bg}>
        {' '.repeat(j - i)}
      </Text>,
    )
    i = j
  }
  return <Text key={key}>{cells}</Text>
}

export type RowsUi = Pick<ElementTable<'terminal' | 'desktop'>, 'Box' | 'Text'>

const NAME_WIDTH = 16
const BAR_WIDTH = 10

/**
 * One row per enabled pool: display name, used-quota bar, used/elapsed,
 * signed pace in the state's color, the actions running there, the lane
 * it is incumbent for. Shared by the strip and the pane.
 */
export function poolRows(
  ui: RowsUi,
  pools: readonly BullswarmPool[],
  assignments: readonly BullswarmAssignment[],
  names: ReadonlyMap<string, string>,
): RenderElement[] {
  const { Box, Text } = ui
  return pools
    .filter(p => p.enabled)
    .map(p => {
      const state = stateOf(p)
      const name = (names.get(p.name) ?? p.name).padEnd(NAME_WIDTH).slice(0, NAME_WIDTH)
      const used = p.usedPct === null ? '  —' : `${String(Math.round(p.usedPct)).padStart(3)}%`
      const elapsed = p.elapsedPct === null ? '' : `/${String(Math.round(p.elapsedPct)).padStart(2)}%`
      const busy = assignments.filter(a => a.pool === p.name)
      const lane = p.incumbentLane.length ? `  ← ${p.incumbentLane.join('/')}` : ''
      const running = busy.length ? `  ${busy.map(a => a.actionId ?? a.lane).join(', ')}` : ''
      return (
        <Box key={p.name} flexDirection="row">
          <Text wrap="truncate-end">
            <Text>{name}</Text>
            {meterBar(Text, p.usedPct, p.elapsedPct, BAR_WIDTH)}
            <Text> {used}</Text>
            <Text dimColor>{elapsed}</Text>
            <Text color={state.color} bold>
              {'  '}
              {p.quarantine ? 'quarantined' : paceText(p)}
            </Text>
            {running ? <Text color="cyan">{running}</Text> : null}
            <Text dimColor>{lane}</Text>
          </Text>
        </Box>
      )
    })
}
