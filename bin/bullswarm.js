#!/usr/bin/env node
// bullswarm — route work across coding-agent CLI subscriptions.

import { main } from '../src/cli.js';

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (err) => {
    console.error(err?.message ?? err);
    process.exitCode = 1;
  },
);
