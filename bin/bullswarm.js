#!/usr/bin/env node
// bullswarm — route work across coding-agent CLI subscriptions.

import { main } from '../src/cli.js';

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err?.message ?? err);
    process.exit(1);
  },
);
