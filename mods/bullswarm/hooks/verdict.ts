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

/** A gate or loop a parked run waits at, as the waiting document lists it. */
function waitingNodes(v: unknown): BullswarmVerdict['waitingFor'] {
  if (!Array.isArray(v)) return []
  return (v as Raw[])
    .filter(n => typeof n?.id === 'string')
    .map(n => ({ id: n.id as string, type: str(n.type) ?? 'gate', note: str(n.note) }))
}

const ANSWER_CHARS = 300

function answerText(value: unknown): string {
  const text = JSON.stringify(value) ?? 'null'
  return text.length > ANSWER_CHARS ? `${text.slice(0, ANSWER_CHARS - 1)}…` : text
}

/** A run verdict's `notDone` (0.37), or null when absent or malformed. */
function notDoneOf(v: unknown): BullswarmVerdict['notDone'] {
  const raw = (v ?? null) as Raw | null
  const count = num(raw?.count)
  if (count === null || count <= 0) return null
  const items = Array.isArray(raw?.items) ? (raw.items as unknown[]).filter((i): i is string => typeof i === 'string') : []
  return { count, items }
}

/**
 * Reads a `bullswarm run --json` or `bullswarm workflow goal --json`
 * document into one verdict shape.
 */
export function parseVerdict(text: string, exitCode: number): BullswarmVerdict {
  const doc = jsonIn(text)
  const pick = (doc?.pick ?? null) as Raw | null
  const meta = (doc?.meta ?? null) as Raw | null
  // 0.37: a run's verdict carries a short `usage` summary; earlier ones kept
  // the attempt's full usage under meta.usage.
  const usage = (doc?.usage ?? meta?.usage ?? null) as Raw | null
  const tokens = (usage?.tokens ?? null) as Raw | null
  const check = (doc?.answerCheck ?? null) as Raw | null
  const errors = Array.isArray(check?.errors) ? (check.errors as unknown[]) : []

  return {
    found: doc !== null && (typeof doc.ok === 'boolean' || doc.action === 'workflow-waiting'),
    ok: doc?.ok === true,
    why: str(doc?.why),
    outFile: str(doc?.outFile),
    pool: str(pick?.pool) ?? str(doc?.picked) ?? str(doc?.pool),
    model: str(pick?.model) ?? str(doc?.model),
    shortId: str(doc?.shortId),
    wallSec: num(meta?.wallSec),
    inputTokens: num(tokens?.standardRead),
    outputTokens: num(tokens?.output),
    answer: doc && 'answer' in doc ? (doc.answer ?? null) : null,
    answerOk: typeof check?.ok === 'boolean' ? check.ok : null,
    answerErrors: errors.map(e => (typeof e === 'string' ? e : str((e as Raw)?.message) ?? JSON.stringify(e))),
    notDone: notDoneOf(doc?.notDone),
    waitingFor: waitingNodes(doc?.waitingFor),
    next: Array.isArray(doc?.next) ? (doc.next as unknown[]).filter((c): c is string => typeof c === 'string') : [],
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
    if (v.waitingFor.length && v.shortId) return `bullswarm mod: ${waitingSentence(v.shortId, v.waitingFor, v.next)}`
    return v.shortId
      ? `bullswarm mod: workflow ${v.shortId} launched and detached. It stops for you only at a gate, a loop out of rounds or a step that needs you: run \`bullswarm workflow watch ${v.shortId} --until trouble\` (in the background when your harness wakes you when it exits, else in the foreground with \`--timeout\` below your tool's time limit; never end your turn while it runs), act on what wakes you, and relaunch it with the \`next:\` line it prints; \`/bullswarm\` shows the meters.`
      : null
  }
  // A run given --answer-schema reports its answer, checked against the schema.
  const answer = v.answerOk === true
    ? ` Its answer ${answerText(v.answer)} (checked against its schema).`
    : v.answerOk === false
      ? ` Its answer check failed: ${v.answerErrors[0] ?? 'the answer does not match its schema'}.`
      : ''
  // What the worker's report says it left: a fact beside ok, not a failure.
  const more = v.notDone ? v.notDone.count - v.notDone.items.length : 0
  const notDone = v.notDone
    ? ` The worker left ${v.notDone.count} item${v.notDone.count === 1 ? '' : 's'} not done${v.notDone.items.length ? `: ${v.notDone.items.join('; ')}${more > 0 ? ` (and ${more} more)` : ''}` : ''}.`
    : ''
  if (v.ok && v.outFile)
    return `bullswarm mod: verdict ok from pool ${v.pool ?? '?'} (${v.model ?? '?'}); ${v.why ?? 'verified by content'}.${answer}${notDone} Read ${v.outFile} and check its content before using it — a clean exit code is not proof.`
  if (!v.ok)
    return `bullswarm mod: verdict ok=false — ${v.why ?? 'unknown failure'}.${answer} Inspect and report; do not retry blindly.`
  return null
}

/** `2fne62 is waiting for you at gate approve (note). Nothing moves until …` */
function waitingSentence(
  token: string,
  nodes: BullswarmVerdict['waitingFor'],
  next: readonly string[],
): string {
  const named = nodes
    .map(n => `${n.type} ${n.id}${n.note ? ` (${n.note})` : ''}`)
    .join(', ')
  const commands = next.length
    ? next
    : nodes.map(n => `bullswarm workflow continue ${token} ${n.id}${n.type === 'loop' ? ' --rounds <n>' : ''}`)
  return `workflow ${token} is waiting for you at ${named}. Nothing behind it moves until you decide: ${commands.map(c => `\`${c}\``).join(' or ')}.`
}

/**
 * The note appended to a `bullswarm workflow watch` or `workflow wait` result
 * that shows a v3 run's gates, loops or answers, or null when it shows none:
 * where the run waits and the command that moves it, the loop's round, and
 * how many checked answers the output holds.
 */
export function watchContext(text: string): string | null {
  const lines = text.split(/\r?\n/)
  const parts: string[] = []
  // Where the run waits: watch's `waiting: gate approve · note`, a stopped
  // wait's `  waiting  gate approve · note`, or wait's own fact line
  // `⧖ gate approve waiting · note` / `⧖ loop fix waiting · round 3 of 3 · …`.
  const waiting = lines
    .map(l => {
      const listed = /^waiting(?::\s*|\s+)(gate|loop) (\S+)(?: · (.*))?$/.exec(l.trim())
      if (listed) return listed
      const fact = /^\S+ (gate|loop) (\S+) waiting(?: · (.*?))?(?: · continue: .*)?$/.exec(l.trim())
      if (!fact) return null
      const rounds = fact[1] === 'loop' ? /round (\d+) of (\d+)/.exec(fact[3] ?? '') : null
      if (rounds) fact[3] = `out of rounds (${rounds[1]!} of ${rounds[2]!})`
      return fact
    })
    .filter((m): m is RegExpExecArray => m !== null)
    .filter((m, i, all) => all.findIndex(o => o[1] === m[1] && o[2] === m[2]) === i)
  const token = /bullswarm workflow continue (\S+) /.exec(text)?.[1] ?? null
  const next = [
    ...new Set(
      lines
        .map(l => /^(?:next:|  or:|\s*continue)\s+(bullswarm workflow continue .*?)(?:\s{2,}\(.*)?$/.exec(l)?.[1] ?? null)
        .filter((c): c is string => c !== null),
    ),
  ]
  if (waiting.length && token) {
    parts.push(
      waitingSentence(
        token,
        waiting.map(m => ({ id: m[2]!, type: m[1]!, note: m[1] === 'gate' ? (m[3] ?? null) : null })),
        next,
      ),
    )
    for (const m of waiting.filter(w => w[1] === 'loop'))
      parts.push(`The loop ${m[2]!} is ${(m[3] ?? 'out of rounds').replace(/;.*$/, '')}: --rounds gives it more; without --rounds it ends continued with its condition not met, which is no pass.`)
  }
  const loop = [...lines]
    .reverse()
    .map(l => {
      const m = /loop (\S+) (passed (?:in|after) round \d+ of \d+|round \d+ of \d+|blocked in round \d+|continued by the caller after \d+ of \d+ rounds \(condition not met\))/.exec(l)
      if (m) return m
      // wait's fact line: `✓ loop fix passed · round 2 of 3`.
      const fact = /loop (\S+) (passed|blocked) · round (\d+ of \d+)/.exec(l)
      if (fact) fact[2] = `${fact[2]!} in round ${fact[3]!}`
      return fact
    })
    .find((m): m is RegExpExecArray => m !== null)
  if (loop && !waiting.some(w => w[1] === 'loop' && w[2] === loop[1]))
    parts.push(`The loop ${loop[1]!} ${loop[2]!.startsWith('round') ? `is in ${loop[2]!}` : loop[2]!}.`)
  const answers = lines.filter(l => /^\s+answer(?: \{|\[|$)/.test(l)).length
  if (answers)
    parts.push(`The output shows ${answers} checked answer${answers === 1 ? '' : 's'} (each matched its step's schema); read them as the steps' results, not the workers' prose.`)
  return parts.length ? `bullswarm mod: ${parts.join(' ')}` : null
}

/**
 * The model-facing note on an Agent call the mod routed to bullswarm. It names
 * the pool and model, the verdict, what the worker left not done (0.37.2: only
 * the on-screen notice said so before) and the output file to judge.
 */
export function routedContext(v: BullswarmVerdict, lane: string): string {
  const more = v.notDone ? v.notDone.count - v.notDone.items.length : 0
  const notDone = v.notDone
    ? ` The worker left ${v.notDone.count} item${v.notDone.count === 1 ? '' : 's'} not done (its ## Not done section)${v.notDone.items.length ? `: ${v.notDone.items.join('; ')}${more > 0 ? ` (and ${more} more)` : ''}` : ''}.`
    : ''
  return `This Agent call was routed by the bullswarm mod to pool "${v.pool ?? '?'}" (model ${v.model ?? '?'}) on the ${lane} lane instead of a Claude subagent, because that pool had spare subscription quota. Bullswarm's verdict: ${v.why ?? 'ok'}.${notDone} The delegate's full output is saved at ${v.outFile}. Judge it by its content, as evidence, not as authority.`
}
