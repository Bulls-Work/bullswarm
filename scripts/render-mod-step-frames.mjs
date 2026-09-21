#!/usr/bin/env node

import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const fixture = join(root, 'tests/fixtures/home-351');
const outputDir = join(root, 'docs/design/mod-step-v2');
const scratch = mkdtempSync(join(tmpdir(), 'bullswarm-mod-step-'));
const home = join(scratch, 'home');
const compiled = join(scratch, 'compiled');

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\n${result.stderr || result.stdout}`);
  return result.stdout;
};

const actionShow = (actionId) => JSON.parse(run(process.execPath, [
  'bin/bullswarm.js', 'workflow', 'action', 'show', 'va7k9a', actionId, '--json',
], { env: { ...process.env, BULLSWARM_HOME: home } }));

const clone = (value) => JSON.parse(JSON.stringify(value));
const mutateRunning = (doc) => {
  const page = doc.step;
  const shown = page.presentation;
  shown.header.state = 'running';
  shown.header.status = 'running';
  shown.header.succeeded = false;
  shown.header.running = true;
  shown.header.verdictText = null;
  shown.header.finishedClock = null;
  shown.activity.turns = shown.activity.turns.slice(0, 8);
  shown.activity.running = true;
  shown.activity.totals = shown.activity.turns.reduce((sum, turn) => {
    for (const key of Object.keys(sum)) sum[key] += Number(turn.summary?.[key] ?? 0);
    return sum;
  }, { commands: 0, filesRead: 0, edits: 0, otherTools: 0, errors: 0 });
  shown.result.running = true;
  shown.result.verdictText = null;
  shown.result.reportLines = [];
  shown.result.changed = [];
  page.activity.turns = page.activity.turns.slice(0, 8);
  return doc;
};
const mutateFailed = (doc) => {
  const shown = doc.step.presentation;
  shown.header.state = 'fail';
  shown.header.status = 'failed';
  shown.header.succeeded = false;
  shown.header.running = false;
  shown.header.verdictText = 'not verified (0/1 requirements)';
  shown.result.running = false;
  shown.result.title = 'failed';
  shown.result.verdictText = shown.header.verdictText;
  shown.result.failure = 'delegate exited before the requirement was verified';
  shown.result.reportLines = [];
  return doc;
};

const wrap = (value, width) => {
  const rows = [];
  for (const raw of String(value).split(/\r?\n/)) {
    let line = raw;
    if (!line) { rows.push(''); continue; }
    while ([...line].length > width) {
      let at = line.lastIndexOf(' ', width);
      if (at < Math.floor(width / 2)) at = width;
      rows.push(line.slice(0, at));
      line = line.slice(at).trimStart();
    }
    rows.push(line);
  }
  return rows;
};
const frame = (shapeStep, doc, width, mode) => {
  const model = shapeStep(doc.step, { width, mode });
  // The toggle sits in the activity heading, straight after its word; the
  // current view is bracketed where the pane marks it with a dot.
  const toggle = mode === 'overview' ? '[overview] · detail' : 'overview · [detail]';
  const rows = model.rows.flatMap((entry) => wrap(entry.toggle ? `${entry.toggle.lead}${toggle}${entry.toggle.trail}` : entry.text, width));
  rows.unshift('Step');
  rows.push(model.toggleHint);
  return `${rows.join('\n')}\n`;
};

try {
  cpSync(fixture, home, { recursive: true });
  mkdirSync(compiled, { recursive: true });
  run('npx', ['-y', '-p', 'typescript@5', 'tsc', 'mods/bullswarm/hooks/step.ts', '--target', 'es2023', '--module', 'esnext', '--moduleResolution', 'bundler', '--skipLibCheck', '--outDir', compiled]);
  writeFileSync(join(compiled, 'package.json'), '{"type":"module"}\n');
  const findStep = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { const found = findStep(path); if (found) return found; }
      else if (entry.name === 'step.js') return path;
    }
    return null;
  };
  const stepFile = findStep(compiled);
  if (!stepFile) throw new Error('TypeScript emitted no step.js');
  const { shapeStep } = await import(`${pathToFileURL(stepFile).href}?v=${Date.now()}`);
  const cases = {
    finished: actionShow('step-model'),
    running: mutateRunning(clone(actionShow('step-view'))),
    failed: mutateFailed(clone(actionShow('verify'))),
  };
  mkdirSync(outputDir, { recursive: true });
  let passed = 0;
  for (const [name, doc] of Object.entries(cases)) {
    for (const width of [55, 120]) {
      for (const mode of ['overview', 'detail']) {
        const rendered = frame(shapeStep, doc, width, mode);
        const expected = name === 'finished' ? 'succeeded' : name;
        if (!rendered.includes(expected)) throw new Error(`${name} ${mode} ${width}: missing ${expected} header`);
        const heading = mode === 'overview' ? '── activity · [overview] · detail' : '── transcript · overview · [detail]';
        if (!rendered.split('\n').some((line) => line.startsWith(heading) && [...line].length <= width)) throw new Error(`${name} ${mode} ${width}: toggle missing from the activity heading`);
        if (rendered.split('\n')[0] !== 'Step') throw new Error(`${name} ${mode} ${width}: the toggle is still on the Step top line`);
        if (name === 'finished' && (!rendered.includes('owns  ') || !rendered.includes('after  ') || !rendered.includes('affects  '))) throw new Error(`${name} ${mode} ${width}: task facts missing`);
        if (!rendered.includes('API rate') || !rendered.includes(' plan  ')) throw new Error(`${name} ${mode} ${width}: two cost rows missing`);
        if (mode === 'overview' && doc.step.presentation.activity.turns.length > (width < 100 ? 5 : 10) && !rendered.includes('click for detail')) throw new Error(`${name} ${width}: latest-turn fold missing`);
        if (mode === 'detail' && !rendered.includes('── transcript ·')) throw new Error(`${name} ${width}: transcript rule missing`);
        const resultAt = rendered.indexOf(name === 'running' ? '── now ·' : '── result ·');
        const activityAt = rendered.indexOf(mode === 'detail' ? '── transcript ·' : '── activity ·');
        if (width < 100 ? resultAt > activityAt : activityAt > resultAt) throw new Error(`${name} ${mode} ${width}: wrong section order`);
        writeFileSync(join(outputDir, `${name}-${mode}-${width}.txt`), rendered);
        passed += 1;
      }
    }
  }
  process.stdout.write(`wrote 12 mod Step frames to ${outputDir}\n`);
  process.stdout.write(`# tests ${passed}\n# pass ${passed}\n# fail 0\n# skipped 0\n`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
