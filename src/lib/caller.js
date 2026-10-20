// Caller identity: who asked for a piece of work.
//
// Recorded at a run's launch (`caller.json` beside goal.json, src/workflow/
// goal.js) and on every in-flight assignment record (src/lib/assignments.js),
// so a reader can tell which terminal pane and which Claude Code session
// started a run, and from which directory.
//
// Exactly two environment variables are read: HERDR_PANE_ID and
// CLAUDE_CODE_SESSION_ID. No other env value is ever read, recorded or
// logged here. A value of the wrong shape is recorded as null, never as the
// raw text, so nothing unexpected reaches disk.

/** A herdr pane id: `w<window>:p<pane>`, for example `w6:p1`. */
const PANE_RE = /^w[A-Za-z0-9]+:p[0-9]+$/;
/** A Claude Code session id: a UUID. */
const SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CWD = 4096;

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
 * A caller record of exactly three fields, every one validated; anything else
 * (an older or forged record, extra keys) is dropped. Not an object: null.
 *
 * @returns {{herdrPane: string|null, claudeSession: string|null, cwd: string|null}|null}
 */
export function normalizeCaller(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    herdrPane: pane(value.herdrPane),
    claudeSession: session(value.claudeSession),
    cwd: absoluteDir(value.cwd),
  };
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
  return {
    herdrPane: pane(env?.HERDR_PANE_ID),
    claudeSession: session(env?.CLAUDE_CODE_SESSION_ID),
    cwd: absoluteDir(dir),
  };
}
