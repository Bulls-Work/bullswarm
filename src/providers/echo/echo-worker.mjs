// echo-worker.mjs — deterministic test delegate for bullswarm.
// Reads a task file; behavior is driven by directives in the task text.
//   FAIL:auth   -> prints an auth failure, exits 0 (the lying-exit trap)
//   FAIL:quota  -> prints a provider usage limit naming its reset, exits 0
//   FAIL:exit   -> prints a complete answer, exits 1 (exit-1-after-success)
//   INTENT:     -> prints only an announcement, exits 0
//   ANSWER_JSON:<json> -> also writes <json> to the answer file the task names
//   TOUCH:<name> -> also writes <name> in the task's Workspace directory
//   NOT_DONE:<a>|<b> -> ends the answer with a `## Not done` section listing a, b
//   otherwise   -> echoes the task as a completed answer, exit 0

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const task = readFileSync(process.argv[2], 'utf8');
const sleepMatch = task.match(/SLEEP_MS:(\d+)/);
if (sleepMatch) await new Promise((resolve) => setTimeout(resolve, Number(sleepMatch[1])));

// A typed answer (program v3): the JSON after the directive, written to the
// file the answer paragraph names.
const answerJson = task.match(/ANSWER_JSON:(\S+)/)?.[1];
const answerFile = task.match(/single JSON value to this file: (\S+)/)?.[1];
if (answerJson && answerFile) writeFileSync(answerFile, answerJson);
// A build step's file, in the workspace the task names.
const touch = task.match(/TOUCH:([\w.-]+)/)?.[1];
const workspace = task.match(/^Workspace: (.+)$/m)?.[1];
if (touch && workspace) writeFileSync(join(workspace, touch), `${touch}\n`);

if (task.includes('FAIL:quota')) {
  // A usage limit is not a broken credential: it names when it resets.
  console.log('Error: usage limit reached · resets in 45 minutes');
  process.exit(0);
}
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

// Items the worker says it left, as a report's `## Not done` section.
const notDone = task.match(/NOT_DONE:(.+)$/m)?.[1].split('|').map((item) => item.trim()).filter(Boolean) ?? [];
const notDoneSection = notDone.length ? `\n\n## Not done\n${notDone.map((item) => `- ${item}`).join('\n')}` : '';

console.log(
  `## Completed\n\nProcessed the task file successfully.\n\n- Read and executed every directive found in ${process.argv[2]}.\n- Verified the output directory exists and is writable before writing.\n- Ran the full local validation suite: all checks passed with exit code 0.\n\nNo errors were encountered during the run.${notDoneSection}`,
);
process.exit(0);
