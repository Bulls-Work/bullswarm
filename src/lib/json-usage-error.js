// With --json on the command line, a usage error (exit 2) must leave stdout as
// one JSON object, { error: 'usage', message, usage }, instead of nothing. The
// usage errors print their human text through console.error from many places;
// this wraps the whole run, copies those lines, and on exit 2 with an empty
// stdout prints the object. The human text still goes to stderr.

export function wantsJson(argv) {
  return argv.some((token) => token === '--json' || token === '--json=true');
}

export async function withJsonUsageErrors(argv, run) {
  if (!wantsJson(argv)) return run();
  const lines = [];
  let wrote = false;
  const origError = console.error;
  const origWrite = process.stdout.write;
  console.error = (...args) => {
    lines.push(args.join(' '));
    origError.apply(console, args);
  };
  process.stdout.write = function write(...args) {
    wrote = true;
    return origWrite.apply(this, args);
  };
  let code;
  try {
    code = await run();
  } finally {
    console.error = origError;
    process.stdout.write = origWrite;
  }
  if (code === 2 && !wrote) {
    const text = lines.join('\n').split('\n');
    const usage = text.find((l) => /^(✗ )?[Uu]sage: /.test(l)) ?? null;
    const message = text.filter((l) => !/^usage: /.test(l) && l.trim()).map((l) => l.replace(/^✗ /, '')).join('\n')
      || 'usage error';
    console.log(JSON.stringify({ error: 'usage', message, usage: usage ? usage.replace(/^(✗ )?[Uu]sage: /, '') : null }, null, 2));
  }
  return code;
}
