// echo-worker.mjs — deterministic test delegate for bullswarm.
// Reads a task file; behavior is driven by directives in the task text.
//   FAIL:auth   -> prints an auth failure, exits 0 (the lying-exit trap)
//   FAIL:exit   -> prints a complete answer, exits 1 (exit-1-after-success)
//   INTENT:     -> prints only an announcement, exits 0
//   otherwise   -> echoes the task as a completed answer, exit 0

import { readFileSync } from 'node:fs';

const task = readFileSync(process.argv[2], 'utf8');
const sleepMatch = task.match(/SLEEP_MS:(\d+)/);
if (sleepMatch) await new Promise((resolve) => setTimeout(resolve, Number(sleepMatch[1])));

if (task.includes('FAIL:auth-hang')) {
  console.log('Authentication failed: quota exhausted; waiting process should be terminated.');
  await new Promise((resolve) => setTimeout(resolve, 5000));
  process.exit(0);
}
if (task.includes('FAIL:auth')) {
  console.log('Authentication failed: no credentials found in keychain.');
  process.exit(0);
}
if (task.includes('FAIL:exit')) {
  console.log(
    'Refactor complete.\n\n- Renamed getUser to fetchUser across 12 files (grep-verified: zero remaining references).\n- All 47 tests pass. Files touched: src/api/user.ts, src/api/index.ts, src/hooks/useUser.ts, and 9 test files.',
  );
  process.exit(1);
}
if (task.includes('INTENT:')) {
  console.log(
    "I'll inspect log.ts and tail.ts, then trace the rotation path through the config loader. I'll report back with the root cause.",
  );
  process.exit(0);
}
if (task.includes('PWD:')) {
  console.log(
    `## Working directory report\n\nThe delegate process resolved its project context from the following locations, captured immediately at spawn time:\n\n- PWD environment variable: ${process.env.PWD ?? '(unset)'}\n- getcwd() / process.cwd(): ${process.cwd()}\n\nBoth values agree, confirming the launcher set the working directory correctly for this run.`,
  );
  process.exit(0);
}

console.log(
  `## Completed\n\nProcessed the task file successfully.\n\n- Read and executed every directive found in ${process.argv[2]}.\n- Verified the output directory exists and is writable before writing.\n- Ran the full local validation suite: all checks passed with exit code 0.\n\nNo errors were encountered during the run.`,
);
process.exit(0);
