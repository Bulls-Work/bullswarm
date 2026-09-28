// A worker's final answer: read by the connector's extraction strategy,
// recognised as cut short (a short reply after the last tool call), asked for
// again (FOLLOW_UP_PROMPT), or, when it never came, derived from the
// workspace and the captured stream.

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export const FOLLOW_UP_PROMPT = 'Your previous turn ended without a final report. Write it now: what you changed per file, the test summary lines, contract deviations, shared-file requests.';

const TRUNCATED_OUTPUT_MAX = 500;

function streamTextFor(obs, paths) {
  const file = obs?.streamFile ?? paths?.streamFile ?? null;
  if (file && existsSync(file)) {
    try { return readFileSync(file, 'utf8'); } catch { /* use captured transport below */ }
  }
  return [obs?.eventOutput, obs?.stdout, obs?.stderr].filter(Boolean).join('\n');
}

function decodedStreamLines(text) {
  const lines = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    lines.push(line);
    try {
      const row = JSON.parse(line);
      for (const value of [
        row?.summary,
        row?.text,
        row?.result,
        row?.message,
        row?.command,
        row?.item?.text,
        row?.item?.command,
        row?.content,
      ]) {
        if (typeof value === 'string') lines.push(...value.split(/\r?\n/));
      }
    } catch { /* plain transport line */ }
  }
  return lines;
}

function testSummaryFromStream(text) {
  const lines = decodedStreamLines(text);
  const blocks = [];
  let current = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^#\s+tests\b/i.test(trimmed)) {
      if (current.length) blocks.push(current);
      current = [trimmed];
      continue;
    }
    if (current.length && /^#\s+(?:pass|fail)\b/i.test(trimmed)) {
      current.push(trimmed);
      continue;
    }
    if (current.length && trimmed && !/^#\s+(?:skip|skipped|todo)\b/i.test(trimmed)) {
      blocks.push(current);
      current = [];
    }
  }
  if (current.length) blocks.push(current);
  return blocks.at(-1)?.join('\n') ?? '';
}

function gitSummary(targetDir, command) {
  try {
    return execFileSync('git', command, {
      cwd: resolve(targetDir),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
  } catch { return ''; }
}

export function derivedReport(targetDir, obs, paths) {
  const status = gitSummary(targetDir, ['status', '--short']);
  const diffStat = gitSummary(targetDir, ['diff', '--stat']);
  const tests = testSummaryFromStream(streamTextFor(obs, paths));
  return [
    'Derived report: the worker ended without a final report, so Bullswarm reconstructed the durable workspace evidence.',
    '',
    'Workspace status:',
    status || '(no status output)',
    '',
    'Diff stat:',
    diffStat || '(no diff stat output)',
    '',
    'Test summary:',
    tests || '(no # tests/# pass/# fail block found in the captured stream)',
  ].join('\n');
}

export function outputIsTruncated(output, eventTimeline) {
  if (typeof output !== 'string' || output.trim().length >= TRUNCATED_OUTPUT_MAX) return false;
  return Number(eventTimeline?.lastToolSequence ?? 0) > Number(eventTimeline?.lastResponseSequence ?? 0);
}

export function extractOutput(connector, obs) {
  switch (connector.outputExtraction?.strategy ?? 'stdout') {
    case 'event-stream':
      return obs.eventOutput || obs.stdout || obs.stderr || '';
    case 'stdout':
      return obs.stdout || obs.stderr || '';
    case 'stdout-tail':
      return (obs.stdout || '').split('\n').slice(-80).join('\n') || obs.stderr;
    case 'file': {
      // Connectors that write their full transcript to a file (e.g.
      // a long-running agent that streams to a log) declare a glob/path
      // in outputExtraction.field. We read it directly, sidestepping
      // the spawn-pipe buffer limit (~64 KB on macOS). The field is
      // treated as a literal path; if missing, fall back to stdout.
      const field = connector.outputExtraction?.field;
      if (!field) return obs.stdout || obs.stderr || '';
      try {
        return readFileSync(field, 'utf8');
      } catch {
        return obs.stdout || obs.stderr || '';
      }
    }
    default:
      return obs.stdout || obs.stderr || '';
  }
}
