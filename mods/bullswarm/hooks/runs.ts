import type {
  BullswarmAction,
  BullswarmAssignment,
  BullswarmAttempt,
  BullswarmRun,
  BullswarmRunDetail,
  BullswarmStep,
  BullswarmStepAttempt,
} from '../types'

type Raw = Record<string, unknown>

/** The rich, serializable Step model appended by `action show --json`. */
export type ParsedBullswarmStep = BullswarmStep & {
  /** The JSON `step` object; kept separate from the legacy compact projection. */
  page: Raw | null
  /** Action-scoped durable events, retained for callers that need raw context. */
  events: readonly Raw[]
}

export type BullswarmAssignmentRecord = BullswarmAssignment & {
  id?: string
  startedAt?: string
  project?: string
  projectName?: string
  cwd?: string
  taskFile?: string
  task?: string
  description?: string
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

const optionalStrings = (
  raw: Raw,
  fallback: BullswarmAssignmentRecord | null,
  keys: readonly ('id' | 'startedAt' | 'project' | 'projectName' | 'cwd' | 'taskFile' | 'task' | 'description')[],
): Partial<BullswarmAssignmentRecord> => {
  const fields: Partial<BullswarmAssignmentRecord> = {}
  for (const key of keys) {
    const value = str(raw[key]) ?? str(fallback?.[key])
    if (value !== null) fields[key] = value
  }
  return fields
}

/** Reads one raw ledger record, preserving optional fields newer records may carry. */
export function parseAssignmentRecord(
  value: unknown,
  fallback: BullswarmAssignmentRecord | null = null,
): BullswarmAssignmentRecord | null {
  if (!value || typeof value !== 'object') return fallback
  const raw = value as Raw
  const pool = str(raw.pool) ?? fallback?.pool ?? null
  if (!pool) return fallback
  return {
    pool,
    model: str(raw.model) ?? fallback?.model ?? null,
    lane: str(raw.lane) ?? fallback?.lane ?? '',
    source: str(raw.source) ?? fallback?.source ?? '',
    runId: str(raw.runId) ?? fallback?.runId ?? null,
    actionId: str(raw.actionId) ?? fallback?.actionId ?? null,
    elapsedMinutes: num(raw.elapsedMinutes) ?? fallback?.elapsedMinutes ?? null,
    expectedMinutes: num(raw.expectedMinutes) ?? fallback?.expectedMinutes ?? null,
    ...optionalStrings(raw, fallback, ['id', 'startedAt', 'project', 'projectName', 'cwd', 'taskFile', 'task', 'description']),
  }
}

/** Reads `bullswarm workflow runs --json` (ongoing runs) into the run model. */
export function parseRuns(stdout: string): BullswarmRun[] {
  const doc = JSON.parse(stdout) as { runs?: Raw[] }
  const raw = Array.isArray(doc.runs) ? doc.runs : []
  return raw
    .filter(r => typeof r.runId === 'string' && r.legacy !== true)
    .map(r => ({
      runId: r.runId as string,
      shortId: str(r.shortId) ?? (r.runId as string).slice(-6),
      goal: str(r.goal) ?? '',
      status: str(r.status) ?? 'unknown',
      startedAt: str(r.startedAt),
      actionsSucceeded: num(r.actionsSucceeded) ?? 0,
      actionsTotal: num(r.actionsTotal) ?? 0,
    }))
}

/** Reads `bullswarm assignments --json` (the in-flight ledger). */
export function parseAssignments(stdout: string): BullswarmAssignmentRecord[] {
  const doc = JSON.parse(stdout) as unknown
  const raw = Array.isArray(doc) ? (doc as Raw[]) : []
  return raw
    .map(a => parseAssignmentRecord(a))
    .filter((a): a is BullswarmAssignmentRecord => a !== null)
}

/** `3m/9m`, `3m`, or ''. */
export function timingOf(a: BullswarmAssignment): string {
  if (a.elapsedMinutes === null) return ''
  const e = `${Math.round(a.elapsedMinutes)}m`
  return a.expectedMinutes !== null ? `${e}/${Math.round(a.expectedMinutes)}m` : e
}

/** Minutes since an ISO timestamp, as `42m` or `2h05m`. */
export function ageOf(iso: string | null, nowMs: number): string {
  if (!iso) return ''
  const mins = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 60_000))
  if (!Number.isFinite(mins)) return ''
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, '0')}m`
}

/** The steps of one run in flight right now. */
export function stepsOf(run: BullswarmRun, assignments: readonly BullswarmAssignment[]) {
  return assignments.filter(a => a.runId === run.runId)
}

/** Standalone `bullswarm run` dispatches, not part of any listed run. */
export function looseOf(
  runs: readonly BullswarmRun[],
  assignments: readonly BullswarmAssignment[],
): BullswarmAssignment[] {
  const known = new Set(runs.map(r => r.runId))
  return assignments.filter(a => !a.runId || !known.has(a.runId))
}

/** One plain-text line per run, for `/bullswarm runs` and the context block. */
export function runLine(
  run: BullswarmRun,
  assignments: readonly BullswarmAssignment[],
  nowMs: number,
): string {
  const steps = stepsOf(run, assignments)
    .map(a => `${a.actionId ?? '?'} on ${a.pool}${timingOf(a) ? ` ${timingOf(a)}` : ''}`)
    .join(', ')
  const progress = `${run.actionsSucceeded}/${run.actionsTotal} done`
  const age = ageOf(run.startedAt, nowMs)
  return `${run.shortId} (${run.status}${age ? `, ${age}` : ''}): ${progress}${steps ? `; running ${steps}` : ''} — ${run.goal.slice(0, 80)}${run.goal.length > 80 ? '…' : ''}`
}

const activityOf = (v: unknown): string | null => {
  if (typeof v === 'string') return v
  if (v && typeof v === 'object') {
    const o = v as Raw
    return str(o.summary) ?? str(o.kind) ?? str(o.status) ?? null
  }
  return null
}

/** Reads `bullswarm workflow runs show <id> --json` into the action list. */
export function parseDetail(stdout: string, readAt: number): BullswarmRunDetail {
  const doc = JSON.parse(stdout) as Raw
  const state = (doc.state ?? {}) as Raw
  const rawAttempts = Array.isArray(state.attempts) ? (state.attempts as Raw[]) : []
  const attempts: BullswarmAttempt[] = rawAttempts
    .filter(a => typeof a.actionId === 'string')
    .map(a => ({
      actionId: a.actionId as string,
      ordinal: num(a.ordinal) ?? 0,
      status: str(a.status) ?? 'unknown',
      pool: str(a.pool),
      model: str(a.model),
      startedAt: str(a.startedAt),
      finishedAt: str(a.finishedAt),
      why: str(a.why),
      wallSec: num(a.wallSec),
      lastActivity: activityOf(a.lastAgentEvent),
    }))
  const rawActions = Array.isArray(state.actions) ? (state.actions as Raw[]) : []
  const actions: BullswarmAction[] = rawActions
    .filter(a => typeof a.id === 'string')
    .map(a => {
      const mine = attempts.filter(t => t.actionId === a.id)
      const latest = mine.sort((x, y) => y.ordinal - x.ordinal)[0] ?? null
      const failure = a.lastFailure
      return {
        id: a.id as string,
        status: str(a.status) ?? 'unknown',
        attempts: num(a.attempts) ?? mine.length,
        startedAt: str(a.startedAt),
        finishedAt: str(a.finishedAt),
        outputFile: str(a.outputFile),
        lastFailure:
          typeof failure === 'string'
            ? failure
            : failure && typeof failure === 'object'
              ? (str((failure as Raw).why) ?? str((failure as Raw).kind))
              : null,
        latest,
      }
    })
  return {
    runId: str(doc.runId) ?? '',
    shortId: str(doc.shortId) ?? '',
    ongoing: doc.ongoing === true,
    actions,
    readAt,
  }
}

/** `6m12s` for a finished attempt, `3m` so far for a running one, or ''. */
export function durationOf(a: BullswarmAction, nowMs: number): string {
  const wall = a.latest?.wallSec
  if (wall !== null && wall !== undefined) {
    const m = Math.floor(wall / 60)
    const sec = Math.round(wall % 60)
    return m ? `${m}m${String(sec).padStart(2, '0')}s` : `${sec}s`
  }
  if (a.startedAt && !a.finishedAt) return `${ageOf(a.startedAt, nowMs)} so far`
  return ''
}

/** A glyph and color per action status. */
export function glyphOf(status: string): { glyph: string; color: string } {
  switch (status) {
    case 'succeeded':
      return { glyph: '✓', color: 'green' }
    case 'running':
      return { glyph: '▶', color: 'cyan' }
    case 'failed':
      return { glyph: '✗', color: 'red' }
    case 'cancelled':
    case 'skipped':
      return { glyph: '–', color: 'yellow' }
    default:
      return { glyph: '·', color: 'gray' }
  }
}

/** `tokens read=… output=… · cost≈$…`, as the TUI's compact usage line. */
function usageText(v: unknown): string | null {
  if (!v || typeof v !== 'object') return null
  const u = v as Raw
  const t = (u.tokens ?? {}) as Raw
  const cost = (u.cost ?? {}) as Raw
  const parts = [
    `tokens read=${String(num(t.standardRead) ?? '?')} output=${String(num(t.output) ?? '?')}`,
    num(cost.estimatedUsd) !== null ? `cost≈$${String(num(cost.estimatedUsd))}` : '',
  ]
  return parts.filter(Boolean).join(' · ')
}

const eventText = (v: unknown): string | null => {
  if (!v || typeof v !== 'object') return null
  const e = v as Raw
  const bits = [str(e.kind) ?? str(e.providerType), str(e.summary), str(e.status)].filter(
    (x): x is string => !!x,
  )
  return bits.length ? bits.join(' · ') : null
}

/** Reads `bullswarm workflow action show <run> <step> --json` into one step. */
export function parseStep(stdout: string, readAt: number): ParsedBullswarmStep {
  const doc = JSON.parse(stdout) as Raw
  const rec = (doc.actionRecord ?? {}) as Raw
  const rawAttempts = Array.isArray(doc.attempts) ? (doc.attempts as Raw[]) : []
  const last = [...rawAttempts].sort((x, y) => (num(y.ordinal) ?? 0) - (num(x.ordinal) ?? 0))[0]
  const attempt: BullswarmStepAttempt | null = last
    ? {
        ordinal: num(last.ordinal) ?? 1,
        status: str(last.status) ?? 'unknown',
        pool: str(last.pool),
        model: str(last.model),
        reasoning: str(((last.reasoning ?? {}) as Raw).applied),
        routeReason: str(((last.routing ?? {}) as Raw).reason),
        startedAt: str(last.startedAt),
        finishedAt: str(last.finishedAt),
        lastActivityAt: str(last.lastActivityAt),
        outputBytes: num(last.outputBytesObserved),
        taskFile: str(last.taskFile),
        outputFile: str(last.outputFile),
        why: str(last.why),
        wallSec: num(last.wallSec),
        usage: usageText(last.usage),
        lastEvent: eventText(last.lastAgentEvent),
      }
    : null
  const failure = rec.lastFailure
  const page = doc.step && typeof doc.step === 'object' && !Array.isArray(doc.step)
    ? (doc.step as Raw)
    : null
  const events = Array.isArray(doc.events)
    ? (doc.events as unknown[]).filter((event): event is Raw => Boolean(event && typeof event === 'object' && !Array.isArray(event)))
    : []
  return {
    id: str(rec.id) ?? '',
    purpose: str(rec.purpose) ?? '',
    kind: str(rec.kind),
    lane: str(rec.lane),
    effort: str(rec.effort),
    status: str(rec.status) ?? 'unknown',
    outputFile: str(rec.outputFile) ?? attempt?.outputFile ?? null,
    lastFailure:
      typeof failure === 'string'
        ? failure
        : failure && typeof failure === 'object'
          ? (str((failure as Raw).why) ?? str((failure as Raw).kind))
          : null,
    attempt,
    readAt,
    page,
    events,
  }
}
