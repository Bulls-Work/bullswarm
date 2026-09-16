/* @jsxRuntime classic */
/* @jsx h */
/* @jsxFrag Fragment */
import type { ElementTable, RenderElement } from 'claude-code'

import type {
  BullswarmAction,
  BullswarmAssignment,
  BullswarmPool,
  BullswarmRun,
  BullswarmRunDetail,
  BullswarmRung,
  BullswarmStep,
} from '../types'
import type { OverviewLine } from './overview'
import { METER_AMBER, METER_GREEN, METER_RED, meterBar, poolRows, severityColor } from './pool-rows'
import { ageOf, durationOf, glyphOf, stepsOf, timingOf } from './runs'

export type PaneUi = Pick<ElementTable<'terminal' | 'desktop'>, 'Box' | 'Text' | 'Button'>

export type PaneModel = {
  runs: readonly BullswarmRun[]
  selected: BullswarmRun | null
  overview: readonly OverviewLine[] | null
  detail: BullswarmRunDetail | null
  /** The action the person opened, when one is open. */
  action: BullswarmAction | null
  /** That step as `action show` reports it, when read. */
  step: BullswarmStep | null
  /** The head of the step's task file, one entry per line. */
  promptPreview: readonly string[]
  /** The tail of that action's output file, when read. */
  outputTail: string | null
  pools: readonly BullswarmPool[]
  assignments: readonly BullswarmAssignment[]
  /** Every pool × tier rung, for the expanded pools section. */
  rungs: readonly BullswarmRung[]
  /** The pools page is open instead of the run. */
  poolsPage: boolean
  /** How that page groups the rungs. */
  rungsBy: 'tier' | 'pool'
  readAt: number | null
  nowMs: number
  error: string | null
  names: ReadonlyMap<string, string>
  /** The first scrollable row the overview shows; 0 at the top. */
  offset: number
  /** The rows the pane body has, as the engine drew it. */
  bodyRows: number
}

/** How the overview's own window sits over its scrollable rows. */
export type PaneScroll = {
  offset: number
  contentRows: number
  windowRows: number
}

export type PaneActions = {
  select: (shortId: string) => void
  openAction: (actionId: string) => void
  /** Moves the overview's window to its top or bottom. */
  scrollTo: (where: 'start' | 'end') => void
  /** Opens the pools page: every meter window and the model per tier. */
  openPools: () => void
  /** Groups the rung table by effort tier (lane) or by pool. */
  setRungsBy: (by: 'tier' | 'pool') => void
  back: () => void
  close: () => void
}

const toneColor = (tone: OverviewLine['tone']): string | undefined =>
  tone === 'ok' ? 'green' : tone === 'fail' ? 'red' : tone === 'running' ? 'cyan' : undefined

const shortModel = (m: string | null): string => (m ? m.split('/').pop() ?? m : '')

/** Greedy word wrap to `width` cells, one string per row; long words are cut. */
export function wrapText(text: string, width: number): string[] {
  const w = Math.max(8, width)
  const out: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    let line = raw
    if (!line.trim()) {
      out.push('')
      continue
    }
    while (line.length > w) {
      let cut = line.lastIndexOf(' ', w)
      if (cut < w * 0.5) cut = w
      out.push(line.slice(0, cut))
      line = line.slice(cut).replace(/^\s+/, '')
    }
    out.push(line)
  }
  return out
}

/** `6m12s` between two timestamps, or since the first. */
const spanOf = (from: string | null, to: string | null, nowMs: number): string => {
  if (!from) return ''
  const ms = (to ? Date.parse(to) : nowMs) - Date.parse(from)
  if (!Number.isFinite(ms) || ms < 0) return ''
  const sec = Math.round(ms / 1000)
  const m = Math.floor(sec / 60)
  return m ? `${String(m)}m${String(sec % 60).padStart(2, '0')}s` : `${String(sec)}s`
}

/** The action id a frame line names, when it is one of the run's actions. */
function actionOf(text: string, actions: readonly BullswarmAction[]): BullswarmAction | null {
  let best: BullswarmAction | null = null
  for (const a of actions) {
    const re = new RegExp(`(^|[\\s│├└─✓✗×·])${a.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[\\s·])`)
    if (re.test(text) && (!best || a.id.length > best.id.length)) best = a
  }
  return best
}

/**
 * The docked pane. Overview mode: the run's header and `[Top] [End]` stay
 * put, the frame `bullswarm workflow tui --overview` draws scrolls under
 * them (every step row a button that opens the step, the pools at the
 * bottom), and the run switcher stays put beneath. The mod owns that
 * window (`ui.scroll`), so the tree is never taller than the body. Step
 * mode: that action's attempt, files and the tail of its output, which
 * the engine scrolls.
 */
export function paneView(
  kit: { ui: PaneUi; columns: number },
  model: PaneModel,
  actions: PaneActions,
): { tree: RenderElement; scroll: PaneScroll | null } {
  const { Box, Text, Button } = kit.ui
  const run = model.selected
  const rule = '─'.repeat(Math.max(1, Math.min(kit.columns, 120)))
  const nameOf = (pool: string | null) => (pool ? (model.names.get(pool) ?? pool) : '')

  const switcher = (
    <Box key="switcher" flexDirection="row" gap={1} flexWrap="nowrap" overflow="hidden">
      {model.action ? <Button key="back" hotkey="b" label="back" onPress={actions.back} /> : null}
      {model.runs.map((r, i) => (
        <Button
          key={`run-${r.shortId}`}
          hotkey={i < 9 ? String(i + 1) : undefined}
          label={run && r.shortId === run.shortId && !model.poolsPage ? `● ${r.shortId}` : r.shortId}
          onPress={() => actions.select(r.shortId)}
        />
      ))}
      <Button key="usage" hotkey="u" label={model.poolsPage ? '● usage' : 'usage'} onPress={actions.openPools} />
      <Button key="close" hotkey="q" label="close" onPress={actions.close} />
    </Box>
  )

  const poolsSection = model.pools.length ? (
    <Box key="pools" flexDirection="column">
      <Text wrap="truncate-end">
        <Text bold>Pools</Text>
        <Text dimColor> · used/elapsed · pace {'─'.repeat(Math.max(0, Math.min(kit.columns, 120) - 30))}</Text>
      </Text>
      {poolRows({ Box, Text }, model.pools, model.assignments, model.names)}
    </Box>
  ) : null

  if (!run) {
    return {
      tree: (
        <Box flexDirection="column">
          <Text dimColor>No ongoing workflow run. `bullswarm workflow goal` launches one.</Text>
          {poolsSection}
          {switcher}
        </Box>
      ),
      scroll: null,
    }
  }

  // Both modes share one frame: fixed header rows, a window over `rows`
  // the mod scrolls itself, fixed footer rows. One element per row keeps
  // the window's arithmetic exact, so long text is wrapped here.
  const width = Math.max(20, Math.min(kit.columns, 120))
  const frame = (
    header: RenderElement[],
    rows: RenderElement[],
    footer: RenderElement[],
  ): { tree: RenderElement; scroll: PaneScroll } => {
    const fixedRows = header.length + footer.length
    const windowRows = Math.max(1, model.bodyRows - fixedRows)
    const contentRows = rows.length
    const offset = Math.max(0, Math.min(model.offset, Math.max(0, contentRows - windowRows)))
    const shown = rows.slice(offset, offset + windowRows)
    const scrolled = offset > 0 || contentRows > offset + windowRows
    const position = scrolled ? ` · ${String(offset + 1)}–${String(offset + shown.length)}/${String(contentRows)}` : ''
    return {
      tree: (
        <Box flexDirection="column">
          {header.map((el, k) => (k === 0 ? <Box key="hdr" flexDirection="row">{el}<Text dimColor>{position}</Text></Box> : el))}
          {shown}
          {footer}
        </Box>
      ),
      scroll: { offset, contentRows, windowRows },
    }
  }
  const nav = (
    <Box key="nav" flexDirection="row" gap={1} flexWrap="nowrap">
      <Button key="top" plain label="[Top]" onPress={() => actions.scrollTo('start')} />
      <Button key="end" plain label="[End]" onPress={() => actions.scrollTo('end')} />
      <Text dimColor wrap="truncate-end">
        {' '}
        wheel · arrows · PgUp/PgDn when the pane has focus
      </Text>
    </Box>
  )
  const dim = (key: string, text: string) => (
    <Text key={key} dimColor wrap="truncate-end">
      {text}
    </Text>
  )
  const plain = (key: string, text: string, color?: string) => (
    <Text key={key} wrap="truncate-end" color={color}>
      {text}
    </Text>
  )
  const blank = (key: string) => <Text key={key}> </Text>

  if (model.poolsPage) {
    const sampled = model.pools.map(p => p.capturedAt).filter((x): x is string => !!x).sort()[0] ?? null
    const header: RenderElement[] = [
      <Text key="h0" wrap="truncate-end">
        <Text bold color="cyan">
          Pools
        </Text>
        <Text dimColor>{sampled ? ` · sampled ${ageOf(sampled, model.nowMs) || '0m'} ago` : ' · no meter snapshot yet'}</Text>
      </Text>,
      nav,
    ]
    if (model.error) header.push(plain('err', model.error, 'red'))
    const footer: RenderElement[] = [
      switcher,
      dim('f1', 'read-only · adjust pools and rungs with `bullswarm setup` (or `bullswarm strategy`)'),
    ]
    return frame(header, poolsPageRows({ Box, Text, Button }, model, width, nameOf, actions), footer)
  }

  if (model.action) {
    // The step view, laid out as the TUI's agent panel: status line, pool and
    // attempt line, the step, its route and times, the prompt head, usage,
    // activity, the outcome tail, and the artifacts.
    const a = model.action
    const st = model.step
    const at = st?.attempt ?? null
    const g = glyphOf(at?.status ?? a.status)
    const live = stepsOf(run, model.assignments).find(s => s.actionId === a.id) ?? null
    const pool = nameOf(at?.pool ?? live?.pool ?? a.latest?.pool ?? null)
    const modelName = shortModel(at?.model ?? live?.model ?? a.latest?.model ?? null)
    const reasoning = at?.reasoning ? ` · ${at.reasoning}` : ''
    const rows: RenderElement[] = []
    if (!st && !model.error) rows.push(dim('reading', 'reading the step…'))
    rows.push(
      <Text key="status" wrap="truncate-end">
        <Text color={g.color}>{g.glyph}</Text>
        <Text> {at?.status ?? a.status}</Text>
        <Text dimColor>{modelName ? ` · ${modelName}${reasoning}` : ''}</Text>
      </Text>,
      dim(
        'where',
        [
          pool || 'not dispatched yet',
          `attempt ${String(at?.ordinal ?? a.attempts ?? 1)}`,
          st?.effort ? `effort ${st.effort}` : '',
          at?.reasoning ? `reasoning ${at.reasoning}` : '',
        ]
          .filter(Boolean)
          .join(' · '),
      ),
      blank('b1'),
      plain('step', `Step · ${a.id} · ${st?.kind ?? st?.lane ?? 'step'}`),
    )
    if (st?.purpose) rows.push(...wrapText(st.purpose, width - 2).map((l, k) => dim(`purpose${String(k)}`, `  ${l}`)))
    if (at?.routeReason) rows.push(...wrapText(`Route: ${at.routeReason}`, width).map((l, k) => plain(`route${String(k)}`, l)))
    const started = at?.startedAt ?? a.startedAt
    if (started) rows.push(plain('started', `Started: ${started}`))
    if (at?.finishedAt) rows.push(plain('finished', `Finished: ${at.finishedAt} · ${spanOf(started, at.finishedAt, model.nowMs)}`))
    else if (started) rows.push(plain('elapsed', `Elapsed: ${spanOf(started, null, model.nowMs)}${live && timingOf(live) ? ` · ${timingOf(live)} of the estimate` : ''}`))
    if (at?.lastActivityAt) rows.push(plain('activity-at', `Last activity: ${at.lastActivityAt}${at.outputBytes !== null ? ` · ${String(at.outputBytes)} bytes` : ''}`))
    const failure = a.lastFailure ?? (at?.status === 'failed' ? at.why : null)
    if (failure) rows.push(...wrapText(`Failure: ${failure}`, width).map((l, k) => plain(`failure${String(k)}`, l, 'red')))
    else if (at?.why) rows.push(...wrapText(`Verdict: ${at.why}`, width).map((l, k) => plain(`why${String(k)}`, l, 'green')))
    rows.push(blank('b2'), plain('prompt', `Prompt${model.promptPreview.length ? ` · ${String(model.promptPreview.length)} lines shown` : ''}`))
    if (model.promptPreview.length)
      for (const [k, line] of model.promptPreview.entries())
        rows.push(...wrapText(line, width - 2).map((l, kk) => dim(`p${String(k)}-${String(kk)}`, `  ${l}`)))
    else rows.push(dim('p-none', '  unavailable'))
    rows.push(blank('b3'), dim('usage', at?.usage ?? 'usage pending'), blank('b4'), plain('act', 'Activity'))
    rows.push(dim('act-1', at?.lastEvent ? `· ${at.lastEvent}` : '· waiting for semantic action events'))
    if (model.outputTail) {
      rows.push(blank('b5'), plain('outcome', 'Outcome'))
      rows.push(...wrapText(model.outputTail, width - 2).map((l, k) => dim(`o${String(k)}`, `  ${l}`)))
    }
    rows.push(blank('b6'), plain('arts', 'Artifacts:'))
    rows.push(dim('task', `task: ${at?.taskFile ?? '—'}`))
    rows.push(dim('out', `output: ${st?.outputFile ?? at?.outputFile ?? a.outputFile ?? '—'}`))

    const header: RenderElement[] = [
      <Text key="h0" wrap="truncate-end">
        <Text color={g.color} bold>
          {g.glyph} {a.id}
        </Text>
        <Text dimColor> · run {run.shortId}</Text>
      </Text>,
      nav,
    ]
    if (model.error) header.push(plain('err', model.error, 'red'))
    const footer: RenderElement[] = [
      switcher,
      dim('f1', `bullswarm workflow action show ${run.shortId} ${a.id}`),
    ]
    return frame(header, rows, footer)
  }

  const age = ageOf(run.startedAt, model.nowMs)
  const read = model.readAt ? ageOf(new Date(model.readAt).toISOString(), model.nowMs) : ''
  const known = model.detail?.actions ?? []
  const lines = model.overview ?? []

  // One element per row, so the window's arithmetic holds: the frame lines
  // are already wrapped to the pane's width by `--width`.
  const rows: RenderElement[] = lines.map((line, i) => {
    if (line.kind === 'blank') return <Text key={`b${String(i)}`}> </Text>
    if (line.kind === 'header')
      return (
        <Text key={`h${String(i)}`} wrap="truncate-end">
          <Text bold>{line.text}</Text>
          <Text dimColor> {'─'.repeat(Math.max(0, Math.min(kit.columns, 120) - line.text.length - 1))}</Text>
        </Text>
      )
    if (line.kind === 'section')
      return (
        <Text key={`s${String(i)}`} wrap="truncate-end" bold color={toneColor(line.tone)}>
          {line.text}
        </Text>
      )
    const step = line.kind === 'detail' ? null : actionOf(line.text, known)
    if (step)
      return (
        <Box key={`a${String(i)}`} flexDirection="row">
          <Button
            key={`step-${step.id}-${String(i)}`}
            plain
            label={line.text}
            onPress={() => actions.openAction(step.id)}
          />
        </Box>
      )
    return (
      <Text
        key={`l${String(i)}`}
        wrap="truncate-end"
        dimColor={line.kind === 'detail'}
        color={line.kind === 'detail' ? undefined : toneColor(line.tone)}
      >
        {line.text}
      </Text>
    )
  })
  if (model.pools.length) {
    rows.push(
      <Text key="pools-rule" dimColor>
        {rule}
      </Text>,
      <Box key="pools" flexDirection="row">
        <Button key="pools-open" plain label="Pools ▸" onPress={actions.openPools} />
        <Text dimColor wrap="truncate-end">
          {' '}· used/elapsed · pace · ▏ marks elapsed · click for every window and the model per tier
        </Text>
      </Box>,
      ...poolRows({ Box, Text }, model.pools, model.assignments, model.names),
    )
  }

  const header: RenderElement[] = [
    <Text key="h0" wrap="truncate-end">
      <Text bold color="cyan">
        {run.shortId}
      </Text>
      <Text>
        {' '}
        {run.status}
        {age ? ` · ${age}` : ''} ·{' '}
      </Text>
      <Text color="green">
        {run.actionsSucceeded}/{run.actionsTotal}
      </Text>
      <Text dimColor>{model.overview ? ` · ${read || '0m'} old` : ' · reading…'}</Text>
    </Text>,
    nav,
  ]
  if (model.error) header.push(plain('err', model.error, 'red'))
  const footer: RenderElement[] = [
    switcher,
    dim('f1', `click a step to open it · bullswarm workflow watch ${run.shortId} --next`),
  ]
  return frame(header, rows, footer)
}

/** `1h41m`, `2d9h` until an ISO time, or ''. */
const untilText = (iso: string | null, nowMs: number): string => {
  if (!iso) return ''
  const mins = Math.round((Date.parse(iso) - nowMs) / 60_000)
  if (!Number.isFinite(mins) || mins < 0) return 'now'
  if (mins < 60) return `${String(mins)}m`
  const h = Math.floor(mins / 60)
  if (h < 24) return `${String(h)}h${String(mins % 60).padStart(2, '0')}m`
  return `${String(Math.floor(h / 24))}d${String(h % 24)}h`
}

/** `on track −5pp`, `slow +36pp` (quota to spare) or `hot −20pp` (ahead of the window), with a color. */
const paceWord = (usedPct: number, elapsedPct: number | null): { text: string; color: string } => {
  if (elapsedPct === null) return { text: '', color: 'gray' }
  const pp = Math.round(elapsedPct - usedPct)
  const signed = `${pp >= 0 ? '+' : '−'}${String(Math.abs(pp))}pp`
  if (pp >= 15) return { text: `slow ${signed}`, color: METER_AMBER }
  if (pp <= -15) return { text: `hot ${signed}`, color: METER_RED }
  return { text: `on track ${signed}`, color: METER_GREEN }
}

/**
 * The pools page: every meter window of every pool as a full width bar
 * with the elapsed mark, its reset time and pace word, the credit meter
 * when there is one; then every pool × tier rung with its model and
 * reasoning. Read-only: the footer names the command that changes it.
 */
function poolsPageRows(
  ui: PaneUi,
  model: PaneModel,
  width: number,
  nameOf: (pool: string | null) => string,
  actions: Pick<PaneActions, 'setRungsBy'>,
): RenderElement[] {
  const { Box, Text, Button } = ui
  const rows: RenderElement[] = []
  const barWidth = Math.max(10, width - 4 - 8)
  for (const p of model.pools.filter(p => p.enabled)) {
    rows.push(
      <Text key={`x-${p.name}`} bold wrap="truncate-end">
        {nameOf(p.name)}
        {p.planType ? <Text dimColor> · {p.planType}</Text> : null}
      </Text>,
    )
    if (!p.windows.length) rows.push(<Text key={`x-${p.name}-none`} dimColor>  no meter reported</Text>)
    for (const w of p.windows) {
      const pace = paceWord(w.usedPct, w.elapsedPct)
      rows.push(
        <Box key={`x-${p.name}-${w.key}`} flexDirection="row">
          <Text dimColor>{w.key.padEnd(3)} </Text>
          {meterBar(Text, w.usedPct, w.elapsedPct, barWidth)}
          <Text color={severityColor(w.usedPct)}> {`${w.usedPct.toFixed(1)}%`.padStart(6)}</Text>
        </Box>,
        <Text key={`x-${p.name}-${w.key}-r`} wrap="truncate-end">
          <Text dimColor>    {w.resetsAt ? `resets ${untilText(w.resetsAt, model.nowMs)}` : 'no reset time'}</Text>
          {pace.text ? (
            <Text color={pace.color}>
              {' '}· {pace.text}
            </Text>
          ) : null}
        </Text>,
      )
    }
    if (p.credits)
      rows.push(
        <Text key={`x-${p.name}-credits`} dimColor wrap="truncate-end">
          {'    '}
          {String(p.credits.used)} / {String(p.credits.limit)} {p.credits.unit}
        </Text>,
      )
    rows.push(<Text key={`x-${p.name}-b`}> </Text>)
  }

  // The rungs: the model and reasoning each pool dispatches with per effort
  // tier, and what the local record says about it, grouped by tier (the
  // lane a task lands in) or by pool.
  const tiers = ['high', 'medium', 'low']
  const enabled = model.pools.filter(p => p.enabled)
  const short = (m: string | null) => (m ? (m.split('/').pop() ?? m) : '—')
  const recordOf = (r: BullswarmRung) =>
    r.dispatches
      ? `${String(r.dispatches)} run${r.dispatches === 1 ? '' : 's'}${r.okShare !== null ? ` · ${String(Math.round(r.okShare * 100))}% ok` : ''}${r.medianMinutes !== null ? ` · p50 ${String(Math.round(r.medianMinutes))}m` : ''}`
      : 'no runs yet'
  const rungRow = (key: string, _head: string, sub: string, r: BullswarmRung) => [
    <Text key={key} wrap="truncate-end">
      <Text>{'  '}</Text>
      <Text dimColor>{sub.padEnd(16).slice(0, 16)}</Text>
      <Text color="cyan">{short(r.model)}</Text>
      <Text>{r.reasoning ? ` · ${r.reasoning}` : ''}</Text>
    </Text>,
    <Text key={`${key}-r`} dimColor wrap="truncate-end">
      {' '.repeat(18)}
      {recordOf(r)}
    </Text>,
  ]
  // What each lane carries, from the program kinds table: the effort a
  // kind resolves to decides the tier a step dispatches on.
  const laneBlurb: Record<string, string> = {
    high: 'integration · architecture · adversarial-acceptance',
    medium: 'implement · check (the ordinary writers)',
    low: 'mechanical · io-read · digest',
  }
  const poolBlurb = (p: BullswarmPool) => {
    const meter = p.usedPct !== null && p.elapsedPct !== null ? `${String(Math.round(p.usedPct))}% used of ${String(Math.round(p.elapsedPct))}% elapsed` : 'no meter'
    const window = p.pacingWindow === 'monthly' ? 'monthly' : p.pacingWindow === 'weekly' ? 'weekly' : p.pacingWindow ?? ''
    return [window ? `${window} window` : '', meter, p.quarantine ? 'quarantined' : '', p.incumbentLane.length ? `incumbent for ${p.incumbentLane.join('/')}` : '']
      .filter(Boolean)
      .join(' · ')
  }
  rows.push(
    <Text key="x-rungs" wrap="truncate-end">
      <Text bold>Rungs</Text>
      <Text dimColor> · the model and reasoning each lane dispatches with, per pool</Text>
    </Text>,
    <Box key="x-rungs-tabs" flexDirection="row" gap={1} flexWrap="nowrap">
      <Button key="rungs-tier" plain label={model.rungsBy === 'tier' ? '[● by lane]' : '[by lane]'} onPress={() => actions.setRungsBy('tier')} />
      <Button key="rungs-pool" plain label={model.rungsBy === 'pool' ? '[● by provider]' : '[by provider]'} onPress={() => actions.setRungsBy('pool')} />
    </Box>,
  )
  const group = (key: string, title: string, blurb: string) => [
    <Text key={`${key}-gap`}> </Text>,
    <Text key={`${key}-title`} wrap="truncate-end">
      <Text bold>{title}</Text>
      <Text dimColor> · {blurb}</Text>
    </Text>,
  ]
  if (model.rungsBy === 'tier') {
    for (const t of tiers) {
      const mine = enabled
        .map(p => ({ p, r: model.rungs.find(x => x.pool === p.name && x.tier === t) }))
        .filter((x): x is { p: BullswarmPool; r: BullswarmRung } => !!x.r?.model)
      if (!mine.length) continue
      rows.push(...group(`x-lane-${t}`, t, laneBlurb[t] ?? ''))
      for (const { p, r } of mine) rows.push(...rungRow(`x-rung-${t}-${p.name}`, '', nameOf(p.name), r))
    }
  } else {
    for (const p of enabled) {
      const mine = tiers
        .map(t => ({ t, r: model.rungs.find(x => x.pool === p.name && x.tier === t) }))
        .filter((x): x is { t: string; r: BullswarmRung } => !!x.r?.model)
      if (!mine.length) continue
      rows.push(...group(`x-pool-${p.name}`, nameOf(p.name), poolBlurb(p)))
      for (const { t, r } of mine) rows.push(...rungRow(`x-rung-${p.name}-${t}`, '', t, r))
    }
  }
  if (!model.rungs.length) rows.push(<Text key="x-rungs-none" dimColor>  reading rungs…</Text>)
  return rows
}
