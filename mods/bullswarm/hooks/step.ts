import type { BullswarmStep } from '../types'

type Raw = Record<string, unknown>

export type StepMode = 'overview' | 'detail'
export type StepTone = 'normal' | 'dim' | 'good' | 'bad' | 'running' | 'strong' | 'pool'

export type StepPaneSegment = { text: string; tone: StepTone; pool?: string }

/** One width-aware row for the Claude pane. JSX belongs in pane.tsx. */
export type StepPaneRow = {
  key: string
  kind: 'section' | 'text' | 'response' | 'summary' | 'atomic' | 'artifact' | 'fold'
  text: string
  tone: StepTone
  segments?: readonly StepPaneSegment[]
  turnIndex?: number
  expandable?: boolean
  opensDetail?: boolean
}

export type StepPaneBlock = {
  key: 'header' | 'task' | 'activity' | 'result' | 'cost'
  title: string
  rows: readonly StepPaneRow[]
}

export type StepPaneModel = {
  mode: StepMode
  actionId: string
  runId: string | null
  blocks: readonly StepPaneBlock[]
  rows: readonly StepPaneRow[]
  toggleLabel: 'detail' | 'overview'
  toggleHint: string
}

export type StepPaneOptions = {
  mode?: StepMode
  expandedTurn?: number | null
  promptPreview?: readonly string[]
  outputTail?: string | null
  width?: number
}

const record = (value: unknown): Raw | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Raw : null
const list = (value: unknown): readonly unknown[] => Array.isArray(value) ? value : []
const valueText = (value: unknown, fallback = '—'): string => {
  if (value === null || value === undefined) return fallback
  if (typeof value === 'object') {
    try { return JSON.stringify(value) }
    catch { return String(value) }
  }
  const result = String(value).trim()
  return result || fallback
}
const oneLine = (value: unknown, fallback = '—'): string => valueText(value, fallback).replace(/\s+/g, ' ')
const nullable = (value: unknown): string | null => {
  const result = oneLine(value, '')
  return result || null
}
const numberOf = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}
const row = (
  key: string,
  kind: StepPaneRow['kind'],
  text: string,
  tone: StepTone = 'normal',
  extra: Partial<Omit<StepPaneRow, 'key' | 'kind' | 'text' | 'tone'>> = {},
): StepPaneRow => ({ key, kind, text, tone, ...extra })
const segment = (text: string, tone: StepTone = 'normal', pool?: string): StepPaneSegment => ({ text, tone, ...(pool ? { pool } : {}) })
const clip = (value: string, cells: number): string => value.length > cells ? `${value.slice(0, Math.max(0, cells - 1)).trimEnd()}…` : value

/** The rich model attached by `workflow action show --json`. */
export function stepPageOf(value: unknown): Raw {
  const root = record(value)
  return record(root?.page) ?? record(root?.step) ?? root ?? {}
}

const presentationOf = (page: Raw): Raw => record(page.presentation) ?? {}
const statusTone = (status: unknown): StepTone => {
  const value = String(status ?? '').toLowerCase()
  if (['succeeded', 'success', 'completed', 'complete', 'verified'].includes(value)) return 'good'
  if (['failed', 'failure', 'error', 'cancelled', 'canceled', 'interrupted', 'blocked'].includes(value)) return 'bad'
  if (['running', 'started', 'in_progress', 'in-progress', 'queued'].includes(value)) return 'running'
  return 'dim'
}
const statusGlyph = (state: unknown): string => state === 'ok' ? '✓' : state === 'fail' ? '✗' : '▶'

function headerRows(page: Raw, fallback: BullswarmStep | null, options: StepPaneOptions): StepPaneRow[] {
  const header = record(presentationOf(page).header) ?? {}
  const identity = record(page.identity) ?? {}
  const attempt = record(page.selectedAttempt) ?? record(fallback?.attempt) ?? {}
  const actionId = oneLine(header.actionId ?? identity.actionId ?? fallback?.id, 'step')
  const shortId = nullable(header.shortId ?? identity.shortId)
  const status = oneLine(header.status ?? identity.status ?? attempt.status ?? fallback?.status, 'unknown').toLowerCase()
  const tone = statusTone(status)
  const phone = (options.width ?? 120) < 100
  const fullVerdict = nullable(header.verdictText)
  const verdict = phone && fullVerdict?.startsWith('verified by the workflow') ? 'verified'
    : phone && fullVerdict?.startsWith('not verified') ? 'not verified'
      : fullVerdict
  const attemptText = phone ? null : nullable(header.attemptText)
  const state = header.state ?? (tone === 'good' ? 'ok' : tone === 'bad' ? 'fail' : 'running')
  const identityParts: StepPaneSegment[] = [
    segment(`${statusGlyph(state)} `, tone), segment(actionId, 'strong'),
    ...(shortId ? [segment(' · '), segment(shortId, 'strong')] : []),
    segment(' · '), segment(status, tone),
    ...(verdict ? [segment(' · '), segment(verdict, verdict.startsWith('not ') ? 'bad' : 'good')] : []),
    ...(attemptText ? [segment(' · '), segment(attemptText, 'dim')] : []),
  ]
  const pool = nullable(header.pool ?? attempt.pool)
  const model = nullable(header.model ?? attempt.model)
  const effort = nullable(header.effort ?? fallback?.effort)
  const reasoning = nullable(header.reasoning)
  const clock = nullable(header.clockText)
  const clockRange = header.startedClock && header.finishedClock
    ? `${String(header.startedClock)} → ${String(header.finishedClock)} HKT`
    : nullable(header.startedClock) ? `since ${String(header.startedClock)} HKT` : null
  const metaParts: StepPaneSegment[] = [
    ...(pool ? [segment(pool, 'pool', pool)] : []),
    ...(model ? [segment(`${pool ? ' · ' : ''}${model}`)] : []),
    ...(effort ? [segment(` · ${effort}${phone ? '' : ' effort'}`)] : []),
    ...(!phone && reasoning ? [segment(` · reasoning ${reasoning}`)] : []),
    ...((clock || clockRange) ? [segment(` · ${[clock, clockRange?.replace(' → ', '→')].filter(Boolean).join(' · ')}`, 'dim')] : []),
  ]
  return [
    row('identity', 'text', identityParts.map(part => part.text).join(''), tone, { segments: identityParts }),
    ...(nullable(header.purpose ?? identity.purpose ?? fallback?.purpose)
      ? [row('purpose', 'text', oneLine(header.purpose ?? identity.purpose ?? fallback?.purpose))]
      : []),
    row('meta', 'text', metaParts.map(part => part.text).join('') || '—', 'normal', { segments: metaParts }),
    ...(nullable(header.route) ? [row('route', 'text', `route  ${oneLine(header.route)}`, 'dim')] : []),
  ]
}

function taskRows(page: Raw, fallback: BullswarmStep | null, options: StepPaneOptions): StepPaneRow[] {
  const task = record(presentationOf(page).task) ?? record(page.taskBlock) ?? {}
  const promptLines = list(task.promptLines).length ? list(task.promptLines) : options.promptPreview ?? []
  const promptWidth = Math.max(20, options.width ?? 120)
  const rows = promptLines.slice(0, 3).map((line, index) => row(`prompt-${index}`, 'text', clip(oneLine(line, ''), promptWidth)))
  const facts: Array<[string, unknown]> = [['owns', task.owns], ['after', task.after], ['affects', task.affects]]
  for (const [label, value] of facts) {
    const values = list(value).map(entry => oneLine(entry, '')).filter(Boolean)
    if (values.length) rows.push(row(label, 'text', `${label}  ${values.join(' · ')}`, 'dim'))
  }
  const bytes = record(task.bytes)
  if (bytes) {
    const kb = (value: unknown) => numberOf(value) === null ? '—' : `${(numberOf(value)! / 1000).toFixed(1)} KB`
    rows.push(row('task-open', 'text', `Enter on task: full text ${kb(bytes.authorPrompt)} · kernel wrapper ${kb(bytes.kernel)}`, 'dim'))
  }
  if (!rows.length) rows.push(row('task-unavailable', 'text', fallback?.purpose ?? 'task unavailable', 'dim'))
  return rows
}

type ToolRow = { clock: string | null; text: string; command: boolean; duration: string | null; error: boolean }

function clockOf(value: unknown, seconds = false): string | null {
  const date = new Date(String(value ?? ''))
  if (!Number.isFinite(date.getTime())) return null
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}), hour12: false,
  }).format(date)
}

function rawToolRows(turn: Raw): ToolRow[] {
  const events = list(turn.atomicEvents).map(record).filter((event): event is Raw => event !== null)
  const paired = new Set<number>()
  const rows: ToolRow[] = []
  for (let index = 0; index < events.length; index += 1) {
    if (paired.has(index)) continue
    const event = events[index]!
    const kind = String(event.kind ?? '').toLowerCase()
    if (kind === 'response' || kind === 'usage' || kind === 'envelope' || kind === 'agent_result') continue
    const next = events[index + 1]
    const samePair = next
      && String(next.kind ?? '') === String(event.kind ?? '')
      && oneLine(next.summary, '') === oneLine(event.summary, '')
      && String(event.status ?? '') === 'running'
      && ['completed', 'failed', 'error'].includes(String(next.status ?? ''))
    if (samePair) paired.add(index + 1)
    const command = /command|shell|bash/.test(kind)
    const durationMs = numberOf(next?.durationMs ?? event.durationMs)
    rows.push({
      clock: clockOf(event.at, true), text: oneLine(event.summary ?? event.tool ?? event.kind, 'tool'), command,
      duration: durationMs !== null && durationMs >= 1000 ? `${Math.round(durationMs / 1000)}s` : null,
      error: ['failed', 'error'].includes(String(next?.status ?? event.status ?? '')),
    })
  }
  return rows
}

function toolsFor(page: Raw, shownTurn: Raw): readonly ToolRow[] {
  const projected = list(shownTurn.toolRows).map(record).filter((entry): entry is Raw => entry !== null)
  if (projected.length) return projected.map(entry => ({
    clock: nullable(entry.clock), text: oneLine(entry.text, 'tool'), command: entry.command === true,
    duration: nullable(entry.durationText), error: entry.error === true,
  }))
  const rawActivity = record(page.activity) ?? {}
  const rawTurn = list(rawActivity.turns).map(record).find(turn => numberOf(turn?.index) === numberOf(shownTurn.index))
  return rawTurn ? rawToolRows(rawTurn) : []
}

function totalsOf(turns: readonly Raw[]): string {
  const totals = { commands: 0, filesRead: 0, searches: 0, edits: 0, otherTools: 0, errors: 0 }
  for (const turn of turns) {
    const summary = record(turn.summary) ?? {}
    for (const key of Object.keys(totals) as Array<keyof typeof totals>) totals[key] += numberOf(summary[key]) ?? 0
  }
  return [
    totals.commands ? `${totals.commands} command${totals.commands === 1 ? '' : 's'}` : null,
    totals.filesRead ? `${totals.filesRead} file${totals.filesRead === 1 ? '' : 's'} read` : null,
    totals.searches ? `${totals.searches} search${totals.searches === 1 ? '' : 'es'}` : null,
    totals.edits ? `${totals.edits} edit${totals.edits === 1 ? '' : 's'}` : null,
    totals.otherTools ? `${totals.otherTools} other tool${totals.otherTools === 1 ? '' : 's'}` : null,
    totals.errors ? `${totals.errors} error${totals.errors === 1 ? '' : 's'}` : null,
  ].filter(Boolean).join(' · ')
}

function activityRows(page: Raw, options: StepPaneOptions): StepPaneRow[] {
  const activity = record(presentationOf(page).activity) ?? {}
  const turns = list(activity.turns).map(record).filter((turn): turn is Raw => turn !== null)
  const mode = options.mode ?? 'overview'
  const rows: StepPaneRow[] = []
  if (!activity.available || !turns.length) return [row('activity-empty', 'text', oneLine(activity.reason, 'event stream unavailable'), 'dim')]
  const visibleCount = (options.width ?? 120) < 100 ? 5 : 10
  const first = mode === 'overview' ? Math.max(0, turns.length - visibleCount) : 0
  if (mode === 'overview' && first > 0) {
    const hidden = turns.slice(0, first)
    const range = hidden.length === 1 ? 'turn 1' : `turns 1–${hidden.length}`
    const counts = totalsOf(hidden)
    rows.push(row('fold', 'fold', `${range}${counts ? ` · ${counts}` : ''} · click for detail`, 'dim', { opensDetail: true }))
  }
  turns.slice(first).forEach((turn, offset) => {
    const index = numberOf(turn.index) ?? first + offset
    const number = numberOf(turn.number) ?? index + 1
    const prefix = `${String(number).padStart(2)}  ${oneLine(turn.clock, '--:--')}  `
    const response = mode === 'overview'
      ? clip(oneLine(turn.text, 'response summary unavailable'), Math.max(20, ((options.width ?? 120) - prefix.length) * 2))
      : valueText(turn.text, 'response summary unavailable')
    const head = `${prefix}${response}`
    rows.push(row(`turn-${index}`, 'response', head, 'normal', { turnIndex: index, expandable: mode === 'overview' }))
    if (mode === 'overview') {
      rows.push(row(`counts-${index}`, 'summary', turn.resultMarked === true ? '→ the report, shown under result' : oneLine(turn.countsText, 'no tools'), 'dim', { turnIndex: index }))
      if (numberOf(options.expandedTurn) === index) {
        toolsFor(page, turn).forEach((tool, toolIndex) => rows.push(row(`tool-${index}-${toolIndex}`, 'atomic', `${tool.clock ?? '--:--:--'}  ${tool.command ? '$ ' : ''}${tool.text}${tool.duration ? `  ${tool.duration}` : ''}`, tool.error ? 'bad' : 'dim', { turnIndex: index })))
      }
      return
    }
    rows.push(row(`counts-${index}`, 'summary', oneLine(turn.countsText, 'no tools'), 'dim', { turnIndex: index }))
    toolsFor(page, turn).forEach((tool, toolIndex) => rows.push(row(`tool-${index}-${toolIndex}`, 'atomic', `${tool.clock ?? '--:--:--'}  ${tool.command ? '$ ' : ''}${tool.text}${tool.duration ? `  ${tool.duration}` : ''}`, tool.error ? 'bad' : 'dim', { turnIndex: index })))
  })
  return rows
}

function resultRows(page: Raw, fallback: BullswarmStep | null, options: StepPaneOptions): StepPaneRow[] {
  const result = record(presentationOf(page).result) ?? {}
  if (!Object.keys(result).length) return options.outputTail
    ? options.outputTail.split(/\r?\n/).slice(0, 3).map((line, index) => row(`output-${index}`, 'text', line))
    : [row('result-empty', 'text', fallback?.lastFailure ?? 'no report was written', 'dim')]
  const rows: StepPaneRow[] = []
  if (result.running === true) {
    rows.push(row('not-yet', 'text', 'not yet', 'dim'))
    const last = record(result.lastResponse)
    if (last) rows.push(row('last-response', 'text', `${oneLine(last.clock)}  ${valueText(last.text, '')}`))
  } else list(result.reportLines).forEach((line, index) => rows.push(row(`report-${index}`, 'text', clip(oneLine(line, ''), Math.max(20, options.width ?? 120)))))
  if (nullable(result.failure)) rows.push(row('failure', 'text', oneLine(result.failure), 'bad'))
  list(result.changed).forEach((path, index) => rows.push(row(`changed-${index}`, 'artifact', `changed  ${String(path)}`, 'dim')))
  list(result.asks).forEach((ask, index) => rows.push(row(`asks-${index}`, 'text', `asks  ${String(ask)}`, 'dim')))
  const artifacts = record(result.artifacts) ?? {}
  const fileBits = [result.runDirShort ? `run ${String(result.runDirShort)}` : null]
  for (const name of ['task', 'output', 'stream', 'diff'] as const) {
    const value = nullable(artifacts[name])
    if (value) fileBits.push(name === 'stream' ? `${name} (${String(result.streamEvents ?? 0)} events)` : name)
  }
  if (fileBits.length) rows.push(row('files', 'artifact', `files  ${fileBits.filter(Boolean).join(' · ')}`, 'dim'))
  if (nullable(result.reportBytesText)) rows.push(row('result-open', 'text', `Enter on result: the full report, ${String(result.reportBytesText)}`, 'dim'))
  return rows
}

function costRows(page: Raw): StepPaneRow[] {
  const cost = record(presentationOf(page).cost) ?? {}
  const rows: StepPaneRow[] = []
  for (const value of list(cost.rows)) {
    const entry = record(value) ?? {}
    const label = oneLine(entry.label, 'cost')
    const amount = oneLine(entry.amount)
    const headline = oneLine(entry.headline, '')
    const segments = [segment(label, label.endsWith(' plan') ? 'pool' : 'dim', label.replace(/ plan$/, '')), segment('  '), segment(amount, 'strong'), ...(headline ? [segment(`  ${headline}`, 'dim')] : [])]
    rows.push(row(`cost-${label}`, 'text', segments.map(part => part.text).join(''), 'normal', { segments }))
    list(entry.details).forEach((detail, index) => rows.push(row(`cost-${label}-${index}`, 'text', `  ${String(detail)}`, 'dim')))
  }
  if (nullable(cost.basisLine)) rows.push(row('cost-basis', 'text', String(cost.basisLine), 'dim'))
  return rows.length ? rows : [row('cost-empty', 'text', '—', 'dim')]
}

/** Shape the action-show record into the finished Step v2 pane. */
export function shapeStep(value: unknown, options: StepPaneOptions = {}): StepPaneModel {
  const page = stepPageOf(value)
  const fallback = record(value) as BullswarmStep | null
  const mode: StepMode = options.mode ?? (page.view === 'detail' ? 'detail' : 'overview')
  const presentation = presentationOf(page)
  const header = record(presentation.header) ?? {}
  const result = record(presentation.result) ?? {}
  const task = record(presentation.task) ?? {}
  const activity = record(presentation.activity) ?? {}
  const status = oneLine(header.status ?? fallback?.status, 'unknown')
  const resultVerdict = nullable(result.verdictText)
  const activityTotals = record(activity.totals) ?? {}
  const turnCount = list(activity.turns).length
  const activityTitle = mode === 'detail'
    ? `transcript · ${turnCount} turn${turnCount === 1 ? '' : 's'} · ${numberOf(activityTotals.commands) ?? 0} commands · ${numberOf(activityTotals.edits) ?? 0} edits · ${numberOf(activityTotals.errors) ?? 0} errors · showing all`
    : `activity · ${turnCount} turn${turnCount === 1 ? '' : 's'} · showing turns`
  const resultTitle = result.running === true ? 'now · not yet' : `result · ${status}${resultVerdict ? ` · ${resultVerdict}` : ''}`
  const taskTitle = `task${task.lane ? ` · ${String(task.lane)}` : ''}${task.kind ? ` · ${String(task.kind)}` : ''}`
  const cost = record(presentation.cost) ?? {}
  const attemptCount = numberOf(cost.attemptCount) ?? 1
  const blocksByKey: Record<StepPaneBlock['key'], StepPaneBlock> = {
    header: { key: 'header', title: '', rows: headerRows(page, fallback, options) },
    activity: { key: 'activity', title: activityTitle, rows: activityRows(page, { ...options, mode }) },
    result: { key: 'result', title: resultTitle, rows: resultRows(page, fallback, options) },
    task: { key: 'task', title: taskTitle, rows: taskRows(page, fallback, options) },
    cost: { key: 'cost', title: attemptCount > 1 ? `cost · ${attemptCount} attempts` : 'cost', rows: costRows(page) },
  }
  const order: StepPaneBlock['key'][] = (options.width ?? 120) < 100
    ? ['header', 'result', 'activity', 'task', 'cost']
    : ['header', 'activity', 'result', 'task', 'cost']
  const blocks = order.map(key => blocksByKey[key])
  const rows = blocks.flatMap(block => block.key === 'header' ? block.rows : [row(`${block.key}-section`, 'section', `── ${block.title} ──`), ...block.rows])
  return {
    mode,
    actionId: oneLine(header.actionId ?? fallback?.id, 'step'),
    runId: nullable(header.shortId),
    blocks,
    rows,
    toggleLabel: mode === 'overview' ? 'detail' : 'overview',
    toggleHint: mode === 'overview' ? 'v detail (every turn in full)' : 'v overview (latest turns)',
  }
}

export const stepPaneModel = shapeStep

/** Standalone tasks use a supplied Step model, or the same five-block grammar with honest absences. */
export function taskStepPane(task: unknown, options: StepPaneOptions = {}): StepPaneModel {
  const value = record(task) ?? {}
  if (record(value.step) || record(value.page) || record(value.presentation)) return shapeStep(value, options)
  const id = nullable(value.id) ?? nullable(value.taskFile)?.split(/[\\/]/).pop() ?? 'task'
  const status = value.ok === true ? 'succeeded' : value.ok === false ? 'failed' : 'running'
  return shapeStep({ presentation: {
    header: { state: status === 'succeeded' ? 'ok' : status === 'failed' ? 'fail' : 'running', actionId: id, status, pool: value.pool, model: value.model, purpose: value.description ?? value.task },
    activity: { available: false, reason: 'event stream unavailable', turns: [], totals: {} },
    result: { running: status === 'running', reportLines: [], failure: value.reason, artifacts: { task: value.taskFile, output: value.outFile } },
    task: { promptLines: options.promptPreview ?? [], owns: [], after: [], affects: [] },
    cost: { attemptCount: 1, rows: [{ label: 'API rate', amount: '—', headline: 'no recorded rate', details: [] }, { label: `${String(value.pool ?? 'pool')} plan`, amount: '—', headline: 'no meter reading for this attempt', details: [] }] },
  } }, options)
}
