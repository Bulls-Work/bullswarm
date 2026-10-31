// With --json on the command line, a usage error (exit 2) must leave stdout as
// one JSON object, { error: 'usage', message, usage }, instead of nothing.
//
// The places that produce a usage error mark it at the source with
// reportUsageError({ message, usage }) next to their own console.error; this
// file never reads stderr or guesses from text. Refusals, validation issues
// and I/O failures also exit 2 but are not usage errors, so they never call it
// and keep printing nothing on stdout.

let recorded = null;

/**
 * Record a usage error once per process (the first one wins). `message` is the
 * reason alone; `usage` is the synopsis line without its "usage: " prefix, or
 * null when the error names no synopsis. Prints nothing itself.
 */
export function reportUsageError({ message, usage = null }) {
  if (recorded === null) recorded = { message: String(message), usage: usage ?? null };
}

/** An Error that is a usage error: its catcher reports it with reportUsageError. */
export class UsageFault extends Error {
  // The Error message is the human text the catcher already prints; `reason`
  // and `usage` are its two parts for the JSON object.
  constructor(reason, usage = null, human = usage ? `usage: ${usage}` : reason) {
    super(human);
    this.name = 'UsageFault';
    this.reason = reason;
    this.usage = usage;
  }
}

/**
 * JSON is requested by a `--json` or `--json=true` token before any `--`.
 * Limit: a `--json` that is the immediate value of another flag (`--prompt
 * --json`) still counts, because the flag table (src/lib/cli-flags.js) lists
 * flag names only, not which of them take a value.
 */
export function wantsJson(argv) {
  const end = argv.indexOf('--');
  const head = end === -1 ? argv : argv.slice(0, end);
  return head.some((token) => token === '--json' || token === '--json=true');
}

export async function withJsonUsageErrors(argv, run) {
  if (!wantsJson(argv)) return run();
  let wrote = false;
  const origWrite = process.stdout.write;
  process.stdout.write = function write(...args) {
    wrote = true;
    return origWrite.apply(this, args);
  };
  let code;
  try {
    code = await run();
  } finally {
    process.stdout.write = origWrite;
  }
  if (code === 2 && !wrote && recorded !== null) {
    console.log(JSON.stringify({ error: 'usage', message: recorded.message, usage: recorded.usage }, null, 2));
  }
  return code;
}
