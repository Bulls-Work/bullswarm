import type { BullswarmVerdict } from '../types'

type Raw = Record<string, unknown>

/**
 * Finds the JSON document in a command's output: the whole text, or the
 * last object that starts at a line start and parses to the end.
 */
export function jsonIn(text: string): Raw | null {
  const trimmed = text.trim()
  try {
    const whole = JSON.parse(trimmed) as unknown
    if (whole && typeof whole === 'object') return whole as Raw
  } catch {
    // fall through to a scan
  }

  const end = trimmed.lastIndexOf('}')
  if (end < 0) return null
  const starts: number[] = []
  const re = /^\{/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(trimmed))) starts.push(m.index)
  for (const start of starts.reverse()) {
    try {
      const doc = JSON.parse(trimmed.slice(start, end + 1)) as unknown
      if (doc && typeof doc === 'object') return doc as Raw
    } catch {
      // try the next start
    }
  }
  return null
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null

/**
 * Reads a `bullswarm run --json` or `bullswarm workflow goal --json`
 * document into one verdict shape.
 */
export function parseVerdict(text: string, exitCode: number): BullswarmVerdict {
  const doc = jsonIn(text)
  const pick = (doc?.pick ?? null) as Raw | null
  const meta = (doc?.meta ?? null) as Raw | null
  const usage = (meta?.usage ?? null) as Raw | null
  const tokens = (usage?.tokens ?? null) as Raw | null

  return {
    found: doc !== null && typeof doc.ok === 'boolean',
    ok: doc?.ok === true,
    keepOnClaude: doc?.keepOnClaude === true,
    why: str(doc?.why),
    outFile: str(doc?.outFile),
    pool: str(pick?.pool) ?? str(doc?.picked) ?? str(doc?.pool),
    model: str(pick?.model) ?? str(doc?.model),
    shortId: str(doc?.shortId),
    wallSec: num(meta?.wallSec),
    inputTokens: num(tokens?.standardRead),
    outputTokens: num(tokens?.output),
    exitCode,
    raw: text,
  }
}

/**
 * The note appended to a Bash result that ran bullswarm: the verdict in the
 * doctrine's words, so the model reads the output file instead of trusting
 * the exit code.
 */
export function verdictContext(
  verb: 'run' | 'workflow goal',
  v: BullswarmVerdict,
): string | null {
  if (!v.found) return null
  if (verb === 'workflow goal') {
    return v.shortId
      ? `bullswarm mod: workflow ${v.shortId} launched and detached. It never waits for you: run \`bullswarm workflow watch ${v.shortId} --next\` in the background and act on each event; \`/bullswarm\` shows the meters.`
      : null
  }
  if (v.keepOnClaude)
    return `bullswarm mod: verdict keepOnClaude — ${v.why ?? 'no eligible pool'}. Do the task yourself in this session.`
  if (v.ok && v.outFile)
    return `bullswarm mod: verdict ok from pool ${v.pool ?? '?'} (${v.model ?? '?'}); ${v.why ?? 'verified by content'}. Read ${v.outFile} and check its content before using it — a clean exit code is not proof.`
  if (!v.ok)
    return `bullswarm mod: verdict ok=false — ${v.why ?? 'unknown failure'}. Inspect and report; do not retry blindly.`
  return null
}
