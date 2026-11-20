// Caller identity: who asked for a piece of work.
//
// Recorded at a run's launch (`caller.json` beside goal.json, src/workflow/
// goal.js) and on every in-flight assignment record (src/lib/assignments.js),
// so a reader can tell which terminal pane and which Claude Code session
// started a run, and from which directory.
//
// Exactly four environment variables are read: HERDR_PANE_ID,
// CLAUDE_CODE_SESSION_ID, BULLSWARM_CALLER (an explicit caller name for the
// concurrency caps, src/lib/caps.js) and BULLSWARM_DEPTH (only whether it is
// set: a worker's own nested run, which the caps never hold back). No other
// env value is ever read, recorded or logged here. A value of the wrong shape
// is recorded as null, never as the raw text, so nothing unexpected reaches
// disk. `name` and `nested` appear only when set, so older records keep their
// exact three-field shape.

/** A herdr pane id: `w<window>:p<pane>`, for example `w6:p1`. */
const PANE_RE = /^w[A-Za-z0-9]+:p[0-9A-Z]+$/;
/** A Claude Code session id: a UUID. */
const SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CWD = 4096;
/** A caller name: the same shape as a caps group name (src/lib/caps.js). */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function callerName(value) {
  return typeof value === 'string' && value !== 'default' && NAME_RE.test(value) ? value : null;
}

function withOptional(record, name, nested) {
  if (name) record.name = name;
  if (nested === true) record.nested = true;
  return record;
}

function pane(value) {
  return typeof value === 'string' && value.length <= 64 && PANE_RE.test(value) ? value : null;
}

function session(value) {
  return typeof value === 'string' && SESSION_RE.test(value) ? value : null;
}

function absoluteDir(value) {
  return typeof value === 'string' && value.startsWith('/') && value.length <= MAX_CWD && !value.includes('\0')
    ? value
    : null;
}

/**
 * A caller record of three fields (plus `name`/`nested` when set), every one validated; anything else
 * (an older or forged record, extra keys) is dropped. Not an object: null.
 *
 * @returns {{herdrPane: string|null, claudeSession: string|null, cwd: string|null, name?: string, nested?: true}|null}
 */
export function normalizeCaller(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return withOptional({
    herdrPane: pane(value.herdrPane),
    claudeSession: session(value.claudeSession),
    cwd: absoluteDir(value.cwd),
  }, callerName(value.name), value.nested);
}

/**
 * This process's caller identity. `env` and `cwd` are seams for tests; the
 * defaults are the live process.
 */
export function callerIdentity({ env = process.env, cwd = null } = {}) {
  let dir = cwd;
  if (dir == null) {
    try { dir = process.cwd(); } catch { dir = null; }
  }
  const depth = env?.BULLSWARM_DEPTH;
  return withOptional({
    herdrPane: pane(env?.HERDR_PANE_ID),
    claudeSession: session(env?.CLAUDE_CODE_SESSION_ID),
    cwd: absoluteDir(dir),
  }, callerName(env?.BULLSWARM_CALLER), Number.parseInt(depth ?? '0', 10) > 0);
}
