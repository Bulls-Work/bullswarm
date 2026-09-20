import type { BullswarmStep } from '../types'

type Raw = Record<string, unknown>

export type StepMode = 'overview' | 'detail'
export type StepTone = 'normal' | 'dim' | 'good' | 'bad' | 'running'

/** One width-independent row for the Claude pane. JSX belongs in pane.tsx. */
export type StepPaneRow = {
  key: string
  kind: 'section' | 'text' | 'response' | 'summary' | 'atomic' | 'artifact'
  text: string
  tone: StepTone
  turnIndex?: number
  expandable?: boolean
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
}

export type StepPaneOptions = {
  mode?: StepMode
  expandedTurn?: number | null
  promptPreview?: readonly string[]
  outputTail?: string | null
}

const record = (value: unknown): Raw | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Raw) : null

const text = (value: unknown, fallback = '—'): string => {
  if (value === null || value === undefined) return fallback
  const raw = typeof value === 'object'
    ? (() => {
        try { return JSON.stringify(value) }
        catch { return String(value) }
      })()
    : String(value)
  const result = raw.replace(/\s+/g, ' ').trim()
  return result || fallback
}

const nullableText = (value: unknown): string | null => {
  const result = text(value, '')
  return result || null
}

const finite = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

const arrayOf = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : [])

const numberText = (value: unknown): string => {
  const n = finite(value)
  return n === null ? '—' : n.toLocaleString('en-US')
}

const duration = (msValue: unknown, minutesValue: unknown = null): string => {
  const ms = finite(msValue)
  if (ms !== null && ms >= 0) {
    const seconds = Math.round(ms / 1000)
    if (seconds < 60) return `${seconds}s`
    const minutes = Math.floor(seconds / 60)
    return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`
  }
  const minutes = finite(minutesValue)
  return minutes === null ? '—' : `${Number(minutes.toFixed(2))}m`
}

const statusTone = (value: unknown): StepTone => {
  const status = String(value ?? '').toLowerCase()
  if (['succeeded', 'success', 'completed', 'complete', 'done', 'passed'].includes(status)) return 'good'
  if (['failed', 'error', 'cancelled', 'canceled', 'interrupted', 'blocked'].includes(status)) return 'bad'
  if (['running', 'started', 'in_progress', 'in-progress'].includes(status)) return 'running'
  return 'normal'
}

const verdictText = (identity: Raw): string => {
  if (typeof identity.verified !== 'boolean') return '—'
  return identity.verified ? 'verified' : 'not verified'
}

const statusText = (value: unknown): string => text(value, 'unknown').toLowerCase()

const row = (
  key: string,
  kind: StepPaneRow['kind'],
  value: unknown,
  tone: StepTone = 'normal',
  extra: Partial<Pick<StepPaneRow, 'turnIndex' | 'expandable'>> = {},
): StepPaneRow => ({ key, kind, text: text(value, ''), tone, ...extra })

/**
 * Extract the rich Step payload from `action show --json` or accept a rich
 * payload directly. `parseStep` stores it under `page`; raw JSON stores it
 * under `step`. The legacy action projection remains a useful fallback.
 */
export function stepPageOf(value: unknown): Raw {
  const root = record(value)
  const page = record(root?.page) ?? record(root?.step)
  if (page) return page
  return root ?? {}
}

function moneySlot(value: unknown): string {
  const n = finite(value)
  return n === null ? '—' : `$${n.toFixed(4)}`
}

function tokenLine(tokens: Raw): string {
  const classes = [
    ['read', tokens.standardRead],
    ['cache read', tokens.cacheRead],
    ['cache write', tokens.cacheWrite5m ?? tokens.cacheWrite1h ?? tokens.cacheWrite],
    ['output', tokens.output],
    ['reasoning', tokens.reasoning],
  ]
    .filter(([, value]) => finite(value) !== null)
    .map(([label, value]) => `${label} ${numberText(value)}`)
  const total = finite(tokens.totalKnown)
  if (total !== null) classes.push(`total ${numberText(total)}`)
  return classes.length ? `tokens ${classes.join(' · ')}` : 'tokens —'
}

function budgetLine(cost: Raw): string {
  const value = cost.budget
  if (value === null || value === undefined) return 'budget —'
  if (typeof value === 'string' || typeof value === 'number') return `budget ${String(value)}`
  const budget = record(value)
  if (!budget) return 'budget —'
  const values = [budget.remaining ?? budget.remainingUsd ?? budget.remainingMinutes, budget.limit ?? budget.budget ?? budget.expectedMinutes]
    .filter(v => v !== null && v !== undefined)
    .map(v => String(v))
  return `budget ${values.length ? values.join('/') : '—'}`
}

function headerRows(page: Raw, fallback: BullswarmStep | null): StepPaneRow[] {
  const identity = record(page.identity) ?? {}
  const header = record(page.header) ?? {}
  const attempt = record(page.selectedAttempt) ?? record(fallback?.attempt) ?? {}
  const action = record(page.action) ?? {}
  const stepHeader = record(presentationOf(page).header) ?? {}
  const actionId = text(stepHeader.actionId ?? identity.actionId ?? action.id ?? fallback?.id, 'step')
  const runId = text(stepHeader.shortId ?? identity.shortId ?? page.shortId, '—')
  const status = statusText(stepHeader.status ?? identity.status ?? attempt.status ?? fallback?.status)
  const pool = text(stepHeader.pool ?? header.pool ?? attempt.pool ?? fallback?.attempt?.pool)
  const model = text(stepHeader.model ?? header.model ?? attempt.model ?? fallback?.attempt?.model)
  const effort = text(stepHeader.effort ?? header.effort ?? attempt.effort ?? record(page.route)?.effort ?? fallback?.effort)
  const reasoning = nullableText(stepHeader.reasoning)
  const durationBlock = record(header.duration) ?? {}
  const active = text(stepHeader.clockText)
    || duration(page.activeDurationMs ?? header.activeDurationMs ?? durationBlock.activeMs, page.activeMinutes ?? durationBlock.activeMinutes)
  const purpose = nullableText(stepHeader.purpose ?? identity.purpose ?? action.purpose ?? fallback?.purpose)
  const routeReason = nullableText(stepHeader.route ?? record(page.route)?.reason ?? record(attempt.routing)?.reason ?? fallback?.attempt?.routeReason)
  const verdict = nullableText(stepHeader.verdictText) ?? verdictText(identity)
  const attemptText = nullableText(stepHeader.attemptText)
  return [
    row('identity', 'text', `${actionId} · ${runId} · ${status}`),
    row('verdict', 'text', `verdict · ${verdict}${attemptText ? ` · ${attemptText}` : ''}`, statusTone(status)),
    row('model', 'text', `${pool} · ${model} · ${effort}${reasoning ? ` · reasoning ${reasoning}` : ''}`, 'dim'),
    row('duration', 'text', active, 'dim'),
    ...(routeReason ? [row('route', 'text', `route · ${routeReason}`, 'dim')] : []),
    ...(purpose ? [row('purpose', 'text', purpose, 'dim')] : []),
  ]
}

function taskRows(page: Raw, fallback: BullswarmStep | null, options: StepPaneOptions): StepPaneRow[] {
  const block = record(page.taskBlock) ?? record(page.taskModel) ?? record(page.task) ?? {}
  const purpose = nullableText(record(page.identity)?.purpose ?? page.purpose ?? fallback?.purpose)
  const source = arrayOf(block.firstLines ?? block.lines ?? page.promptPreview ?? page.prompt)
  const lines = source.length ? source.map(line => String(line)) : [...(options.promptPreview ?? [])]
  const rows: StepPaneRow[] = []
  if (purpose) rows.push(row('purpose', 'text', purpose, 'dim'))
  if (lines.length) {
    lines.forEach((line, index) => rows.push(row(`line-${String(index)}`, 'text', line, 'dim')))
    rows.push(row('expand', 'text', '[Enter expand task first lines]', 'dim'))
  } else {
    rows.push(row('unavailable', 'text', 'task unavailable; no task file was captured.', 'dim'))
  }
  return rows
}

function summaryText(value: unknown): string {
  const summary = record(value)
  if (summary && typeof summary.text === 'string') return summary.text
  const commands = finite(summary?.commands) ?? 0
  const filesRead = finite(summary?.filesRead) ?? 0
  const edits = finite(summary?.edits) ?? 0
  const errors = finite(summary?.errors) ?? 0
  return `${commands} commands · ${filesRead} files read · ${edits} edits · ${errors} errors`
}

function presentationOf(page: Raw): Raw {
  return record(page.presentation) ?? {}
}

function activityRows(page: Raw, options: StepPaneOptions): StepPaneRow[] {
  const activity = record(page.activity) ?? record(page.activityModel) ?? {}
  const shown = presentationOf(page)
  const shownActivity = record(shown.activity) ?? {}
  const mode = options.mode ?? (page.view === 'detail' ? 'detail' : 'overview')
  const filter = text(shownActivity.filter ?? activity.filter, 'all')
  const following = (shownActivity.following ?? activity.follow) !== false
  const controls = row(
    'controls',
    'text',
    `showing ${mode === 'overview' && filter === 'all' ? 'turns' : filter} · t to change · ${following ? 'following' : 'paused'}`,
    'dim',
  )
  if (activity.available === false || (!activity.available && !arrayOf(activity.events).length && !arrayOf(activity.turns).length)) {
    return [controls, row('unavailable', 'text', String(shownActivity.reason ?? activity.reason ?? 'event stream unavailable'), 'dim')]
  }
  if (mode === 'detail') {
    const events = arrayOf(activity.visibleDetailEvents ?? activity.todayEvents ?? activity.events)
    if (!events.length) return [controls, row('none', 'text', `no captured events for today · filters ${filter}`, 'dim')]
    const rows: StepPaneRow[] = [controls]
    events.forEach((value, index) => {
      const event = record(value) ?? {}
      const fields = [
        `seq ${text(event.seq)}`,
        `capture ${text(event.at)}`,
        `source ${text(event.source)}`,
        `provider ${text(event.providerType)}`,
        `kind ${text(event.kind)}`,
        `status ${text(event.status)}`,
        `eventId ${text(event.eventId)}`,
        `turnId ${text(event.turnId)}`,
        `toolCallId ${text(event.toolCallId)}`,
        `provider timestamp ${text(event.providerAt)}`,
        `duration ${text(event.durationMs)}`,
        `usage ${text(event.usage)}`,
        `parent/subagent ${text(event.parentId)}/${text(event.subagentId)}`,
        `arguments ${text(event.arguments)}`,
        `result ${text(event.result)}`,
        `summary ${text(event.summary, 'summary unavailable')}`,
      ]
      rows.push(row(`event-${String(index)}`, 'atomic', fields.join(' · '), statusTone(event.status)))
    })
    return rows
  }

  // The turn rows the page prints: number, response clock, response, and only
  // the non-zero counts beneath it. The pane reads the same projection.
  const turns = arrayOf(shownActivity.turns).length ? arrayOf(shownActivity.turns) : []
  if (turns.length) {
    const expandedTurn = finite(options.expandedTurn)
    const rows: StepPaneRow[] = [controls]
    turns.forEach((value, index) => {
      const turn = record(value) ?? {}
      const turnIndex = finite(turn.index) ?? index
      rows.push(row(
        `response-${String(index)}`,
        'response',
        `${text(turn.number, String(index + 1))}  ${text(turn.clock)}  ${text(turn.text, 'response summary unavailable')}`,
        'normal',
        { turnIndex, expandable: true },
      ))
      if (turn.resultMarked === true) {
        rows.push(row(`result-${String(index)}`, 'summary', '→ the report, shown under result', 'dim', { turnIndex }))
      } else {
        rows.push(row(`summary-${String(index)}`, 'summary', text(turn.countsText, 'no tools'), 'dim', { turnIndex }))
      }
      if (expandedTurn !== null && turnIndex === expandedTurn) {
        arrayOf(turn.toolRows).forEach((tool, toolIndex) => {
          const entry = record(tool) ?? {}
          rows.push(row(
            `tool-${String(index)}-${String(toolIndex)}`,
            'atomic',
            `${text(entry.clock)}  ${entry.command === true ? '$ ' : ''}${text(entry.text, 'summary unavailable')}  ${text(entry.durationText)}`,
            'dim',
            { turnIndex },
          ))
        })
      }
    })
    return rows
  }

  const overview = arrayOf(activity.overviewRows)
  if (overview.length) {
    const expandedTurn = finite(options.expandedTurn)
    const fallbackTurns = arrayOf(activity.turns)
    const rows: StepPaneRow[] = [controls]
    overview.forEach((value, index) => {
      const item = record(value) ?? {}
      const kind = text(item.type, 'summary')
      const turnIndex = finite(item.turnIndex)
      if (kind === 'response') {
        const event = record(item.event) ?? {}
        rows.push(row(`response-${String(index)}`, 'response', `R${turnIndex === null ? '?' : turnIndex + 1} · ${text(event.summary, 'response summary unavailable')}`, statusTone(event.status), {
          turnIndex: turnIndex ?? undefined,
          expandable: true,
        }))
        if (expandedTurn !== null && turnIndex === expandedTurn) {
          const turn = record(fallbackTurns[expandedTurn]) ?? {}
          arrayOf(turn.atomicEvents).forEach((atomic, atomicIndex) => {
            const detail = record(atomic) ?? {}
            rows.push(row(`expanded-${String(expandedTurn)}-${String(atomicIndex)}`, 'atomic', `${text(detail.kind, 'event')} · ${text(detail.status)} · ${text(detail.summary, 'summary unavailable')}`, statusTone(detail.status), { turnIndex: expandedTurn }))
          })
        }
        return
      }
      if (kind === 'event') {
        const event = record(item.event) ?? {}
        rows.push(row(`atomic-${String(index)}`, 'atomic', `${text(event.kind, 'event')} · ${text(event.status)} · ${text(event.summary, 'summary unavailable')}`, statusTone(event.status), { turnIndex: turnIndex ?? undefined }))
        return
      }
      rows.push(row(`summary-${String(index)}`, 'summary', summaryText(item.summary), 'dim', { turnIndex: turnIndex ?? undefined }))
    })
    return rows
  }

  const fallback = arrayOf(activity.turns)
  if (!fallback.length) return [controls, row('none', 'text', `no response turns captured · ${arrayOf(activity.events).length} atomic events`, 'dim')]
  const rows: StepPaneRow[] = [controls]
  fallback.forEach((value, index) => {
    const turn = record(value) ?? {}
    const response = record(turn.response) ?? {}
    rows.push(row(`response-${String(index)}`, 'response', `R${String(index + 1)} · ${text(response.summary, 'response summary unavailable')}`, statusTone(response.status), {
      turnIndex: index,
      expandable: true,
    }))
    if (turn.expanded === true) {
      arrayOf(turn.atomicEvents).forEach((atomic, atomicIndex) => {
        const event = record(atomic) ?? {}
        rows.push(row(`atomic-${String(index)}-${String(atomicIndex)}`, 'atomic', `${text(event.kind, 'event')} · ${text(event.status)} · ${text(event.summary, 'summary unavailable')}`, statusTone(event.status), { turnIndex: index }))
      })
    }
    rows.push(row(`summary-${String(index)}`, 'summary', summaryText(turn.summary), 'dim', { turnIndex: index }))
  })
  return rows
}

function resultRows(page: Raw, fallback: BullswarmStep | null, options: StepPaneOptions): StepPaneRow[] {
  const block = record(page.resultBlock) ?? record(page.resultModel) ?? {}
  const outcome = record(block.outcome) ?? record(page.outcomeModel) ?? {}
  const execution = record(outcome.execution) ?? record(page.execution) ?? {}
  const verification = record(outcome.verification) ?? record(page.verification) ?? {}
  const card = presentationOf(page).result
  const shown = record(card)
  const rows: StepPaneRow[] = []
  if (shown) {
    // The same card the page draws: its rule, the report's first lines, the
    // diff's changed paths, the step's asks, and only the artifacts it left.
    const state = statusText(execution.status ?? fallback?.status)
    const verdict = nullableText(shown.verdictText)
    rows.push(row('outcome', 'text', `result · ${state}${verdict ? ` · ${verdict}` : ''}`, statusTone(execution.status)))
    if (shown.running === true) {
      rows.push(row('running', 'text', `attempt ${text(shown.attemptNumber, '—')} running · ${numberText(shown.events)} events so far`, 'dim'))
      const last = record(shown.lastResponse)
      if (last) rows.push(row('last-response', 'text', `last response ${text(last.clock)}  ${text(last.text)}`, 'dim'))
    }
    arrayOf(shown.reportLines).forEach((line, index) => rows.push(row(`report-${String(index)}`, 'text', String(line), 'dim')))
    if (nullableText(shown.failure)) rows.push(row('failure', 'text', `failed · ${text(shown.failure)}`, 'bad'))
    arrayOf(shown.changed).forEach((path, index) => rows.push(row(`changed-${String(index)}`, 'artifact', `changed · ${String(path)}`, 'dim')))
    arrayOf(shown.asks).forEach((ask, index) => rows.push(row(`ask-${String(index)}`, 'text', `asks · ${String(ask)}`, 'dim')))
    rows.push(row('files', 'text', `files · ${text(shown.runDir)}`, 'dim'))
    const paths = record(shown.fullPaths) ?? {}
    for (const [name, value] of [['task', paths.task], ['output', paths.output], ['stream', paths.stream], ['diff', paths.diff], ['result', paths.result]] as const) {
      if (value !== null && value !== undefined) rows.push(row(`artifact-${name}`, 'artifact', `${name}: ${String(value)}`, 'dim'))
    }
    rows.push(row('report-size', 'text', `Enter on result: the full report, ${text(shown.reportBytesText)}`, 'dim'))
    return rows
  }
  const workflow = record(outcome.workflow) ?? record(page.workflow) ?? {}
  rows.push(row('outcome', 'text', `execution ${statusText(execution.status ?? fallback?.status)} · workflow ${text(workflow.status)} · verified ${verification.verdict == null ? '—' : verification.verdict ? 'true' : 'false'}`, statusTone(execution.status)))
  const attemptHistory = arrayOf(page.attemptHistory ?? page.attempts)
  if (attemptHistory.length > 1) rows.push(row('attempts', 'text', `attempt history ${attemptHistory.length} attempts`, 'dim'))
  const output = record(block.output) ?? record(page.outputModel) ?? {}
  const outputLines = arrayOf(output.lines ?? page.output ?? page.outcomePreview)
  if (outputLines.length) outputLines.forEach((line, index) => rows.push(row(`output-${String(index)}`, 'text', `output · ${String(line)}`, 'dim')))
  else if (options.outputTail) options.outputTail.split(/\r?\n/).forEach((line, index) => rows.push(row(`output-${String(index)}`, 'text', `output · ${line}`, 'dim')))
  else rows.push(row('output-none', 'text', 'no report was written for this step', 'dim'))

  const artifacts = record(block.artifacts) ?? record(page.artifacts) ?? {}
  const paths = record(artifacts.paths) ?? artifacts
  for (const [name, value] of [['task', paths.task], ['output', paths.output], ['stream', paths.stream], ['result', paths.result]] as const) {
    if (value !== null && value !== undefined) rows.push(row(`artifact-${name}`, 'artifact', `${name}: ${String(value)}`, 'dim'))
  }
  const requirements = arrayOf(verification.requirements ?? outcome.requirements)
  if (requirements.length) {
    const passed = requirements.filter(value => record(value)?.status === 'passed').length
    rows.push(row('evidence', 'text', `requirement evidence ${passed}/${requirements.length}`, 'dim'))
  } else rows.push(row('evidence', 'text', 'requirement evidence unavailable.', 'dim'))
  const reason = nullableText(outcome.reason ?? page.taskResult ?? fallback?.lastFailure)
  if (reason) rows.push(row('reason', 'text', `reason · ${reason}`, statusTone(execution.status)))
  return rows
}

function costRows(page: Raw): StepPaneRow[] {
  const cost = record(page.costBlock) ?? record(page.costModel) ?? record(page.cost) ?? {}
  const money = record(cost.moneyPair) ?? record(page.moneyPair) ?? {}
  const api = record(money.api) ?? {}
  const subscription = record(money.subscription) ?? {}
  const card = record(presentationOf(page).cost)
  if (card) {
    // Two plain-word rows and the closing measurement line, exactly as the
    // page words them.
    const rows: StepPaneRow[] = []
    for (const value of arrayOf(card.rows)) {
      const entry = record(value) ?? {}
      rows.push(row(`row-${text(entry.label, 'cost')}`, 'text', `${text(entry.label)}  ${text(entry.amount)}  ${text(entry.headline, '')}`))
      for (const detail of arrayOf(entry.details)) {
        rows.push(row(`detail-${text(detail)}`, 'text', `  ${String(detail)}`, 'dim'))
      }
    }
    if (nullableText(card.basisLine)) rows.push(row('basis', 'text', text(card.basisLine), 'dim'))
    return rows
  }
  const rows = [
    row('money', 'text', `API ${moneySlot(api.usd)} · subscription ${moneySlot(subscription.usd)}`),
    row('tokens', 'text', tokenLine(record(cost.tokens) ?? record(page.tokens) ?? {}), 'dim'),
    row('source', 'text', `token source ${text(cost.tokenSource ?? money.tokenSource)}`, 'dim'),
    row('budget', 'text', budgetLine(cost), 'dim'),
  ]
  return rows
}

/** Shape the rich action-show Step object into the five pane blocks. */
export function shapeStep(value: unknown, options: StepPaneOptions = {}): StepPaneModel {
  const page = stepPageOf(value)
  const fallback = (record(value) ?? {}) as BullswarmStep
  const mode: StepMode = options.mode ?? (page.view === 'detail' ? 'detail' : 'overview')
  const actionId = text(record(page.identity)?.actionId ?? page.actionId ?? fallback.id, 'step')
  const runId = nullableText(record(page.identity)?.shortId ?? page.shortId)
  const blocks: StepPaneBlock[] = [
    { key: 'header', title: 'header', rows: headerRows(page, fallback) },
    { key: 'task', title: 'task · prompt + task', rows: taskRows(page, fallback, options) },
    { key: 'activity', title: mode === 'overview' ? 'activity · overview · response turns' : "activity · today's capture-order log", rows: activityRows(page, { ...options, mode }) },
    { key: 'result', title: 'result · output + artifacts + outcome/verification', rows: resultRows(page, fallback, options) },
    { key: 'cost', title: 'cost · money pair + tokens + budget', rows: costRows(page) },
  ]
  const rows = blocks.flatMap(block => [row(`${block.key}-section`, 'section', block.title), ...block.rows])
  return { mode, actionId, runId, blocks, rows, toggleLabel: mode === 'overview' ? 'detail' : 'overview' }
}

/** Explicit alias used by callers that want to emphasize pane layout data. */
export const stepPaneModel = shapeStep

/** Adapt the durable standalone `bullswarm run` ledger shape without inventing workflow facts. */
export function taskStepPane(task: unknown, options: StepPaneOptions = {}): StepPaneModel {
  const value = record(task) ?? {}
  const id = nullableText(value.id) ?? (nullableText(value.taskFile)?.split(/[\\/]/).pop() ?? 'task')
  const status = value.ok === true ? 'succeeded' : value.ok === false ? 'failed' : value.startedAt && !value.endedAt && !value.finishedAt ? 'running' : 'unknown'
  const started = value.startedAt == null ? null : Date.parse(String(value.startedAt))
  const finished = value.endedAt == null && value.finishedAt == null ? null : Date.parse(String(value.endedAt ?? value.finishedAt))
  const derivedDuration = finite(value.durationMs) ?? (started !== null && finished !== null && Number.isFinite(started) && Number.isFinite(finished)
    ? Math.max(0, finished - started)
    : null)
  return shapeStep({
    identity: { actionId: id, shortId: null, status, verified: null, project: value.project ?? null },
    header: { pool: value.pool ?? null, model: value.model ?? null, effort: null, duration: { activeMs: derivedDuration } },
    selectedAttempt: { status, pool: value.pool ?? null, model: value.model ?? null, startedAt: value.startedAt ?? null, finishedAt: value.endedAt ?? null, effort: null },
    taskBlock: { firstLines: options.promptPreview ?? [], path: value.taskFile ?? null },
    resultBlock: { output: { available: false, lines: [] }, artifacts: { paths: { task: value.taskFile ?? null, output: value.outFile ?? null, stream: null, result: null } }, outcome: { execution: { status }, workflow: { status: null }, verification: { verdict: null }, reason: value.reason ?? null } },
    costBlock: { moneyPair: { api: { usd: null }, subscription: { usd: null } }, tokens: {}, tokenSource: 'unknown', budget: null },
    activity: { available: false, reason: 'event stream unavailable', events: [], turns: [] },
  }, options)
}
