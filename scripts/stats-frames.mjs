#!/usr/bin/env node
// Re-render the durable Stats frames from a real bullswarm home, so the saved
// evidence under docs/design/stats-frames-0.33.2/ can be reproduced instead of
// transcribed.  Never point this at the live ~/.bullswarm; copy it first:
//
//   cp -Rp ~/.bullswarm /tmp/bsw-frames
//   BULLSWARM_HOME=/tmp/bsw-frames node scripts/stats-frames.mjs docs/design/stats-frames-0.33.2
//
// The frame is the renderer's own output with the colour codes removed and
// nothing else changed, so two frames of the same width diff cleanly.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { dashboardModel } from '../src/workflow/dashboard.js';
import { loadUsage } from '../src/workflow/usage-view.js';
import { readRollups } from '../src/workflow/rollup.js';
import { loadState } from '../src/lib/state.js';
import { statsLines } from '../src/workflow/stats-view.js';

const home = process.env.BULLSWARM_HOME ?? join(homedir(), '.bullswarm');
if (home === join(homedir(), '.bullswarm')) {
  console.error('refusing to read the live ~/.bullswarm — copy it and set BULLSWARM_HOME');
  process.exit(2);
}
const outDir = resolve(process.argv[2] ?? 'docs/design/stats-frames-0.33.2');
const widths = (process.argv[3] ?? '55,120').split(',').map((value) => Number(value.trim()));

const rollups = readRollups(home);
const usage = await loadUsage(home);
let prices = { subscriptions: {} };
try { prices = { subscriptions: loadState(home)?.strategy?.subscriptions ?? {} }; } catch { /* none */ }

mkdirSync(outDir, { recursive: true });
const visible = (line) => String(line).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
for (const width of widths) {
  const model = dashboardModel(null, { usage, rollups, prices, period: '7d', metric: 'runs' });
  // A tall viewport so the frame is the whole surface, never a scrolled slice.
  const view = statsLines(model.stats, {
    width, height: 400, tab: 'spending', period: '7d', stackBy: 'pool', ansi: false, slice: null,
  });
  const lines = (view.lines ?? view).map((line) => visible(line));
  const over = lines.filter((line) => [...line].length > width);
  if (over.length) {
    console.error(`${over.length} line(s) exceed ${width} columns`);
    process.exitCode = 1;
  }
  const file = join(outDir, `spending-${width}.txt`);
  writeFileSync(file, `${lines.join('\n')}\n`);
  console.log(`${file}: ${lines.length} lines at ${width} columns`);
}
