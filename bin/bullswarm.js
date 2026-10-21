#!/usr/bin/env node
// bullswarm — route work across coding-agent CLI subscriptions.

import { cachedCall, cachedCallMain } from '../src/lib/pools-cache.js';

const argv = process.argv.slice(2);

// `pools`, `workflow runs` and `assignments` with `--json --max-age <s>` are
// what every Claude session's mod asks on a timer: answer them from the shared
// cache before loading the rest of the CLI, which alone is ~280 MB RSS. Only
// the caller that rebuilds loads it.
const run = cachedCall(argv) !== null
  ? cachedCallMain(argv)
  : import('../src/cli.js').then((m) => m.main(argv));

run.then(
  (code) => { process.exitCode = code; },
  (err) => {
    console.error(err?.message ?? err);
    process.exitCode = 1;
  },
);
