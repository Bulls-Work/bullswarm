// The prior-attempt block a retry's task carries: what the earlier attempt
// did, how it ended, and (when it ran them) what its evidence checks showed.
// Facts only, no I/O: dispatch-handoff.js gathers the facts, handoffBlock writes them.

/**
 * Fixed prior-attempt preamble appended to the task attempt N+1 receives after
 * a mechanical retry or cross-pool fallback. Schema correction keeps its own
 * block and never goes through this template. Facts only — no I/O.
 * The stream log is referenced by path, never inlined.
 */
export function handoffBlock(facts = {}) {
  const durationMs = Date.parse(facts.finishedAt) - Date.parse(facts.startedAt);
  const durationText = Number.isFinite(durationMs)
    ? `${Math.max(0, Math.round(durationMs / 1000))}s`
    : 'unknown';
  const outputPath = facts.outputFile ?? facts.partialOutput ?? null;
  const outputLine = outputPath
    ? (facts.outputBytes != null ? `${outputPath} (${facts.outputBytes} bytes)` : outputPath)
    : 'none';
  const streamLine = facts.streamFile || 'no stream recorded';
  const changed = Array.isArray(facts.changedFiles) ? facts.changedFiles : [];
  const events = Array.isArray(facts.lastEvents) ? facts.lastEvents.slice(-3) : [];
  const lines = [
    '## Prior attempt on this step',
    '',
    `- Pool: ${facts.pool ?? 'unknown'}`,
    `- Model: ${facts.model ?? (facts.pool != null ? `${facts.pool} connector default` : 'unknown')}`,
    `- Started: ${facts.startedAt ?? 'unknown'}`,
    `- Finished: ${facts.finishedAt ?? 'unknown'}`,
    `- Duration: ${durationText}`,
    `- Failure: ${facts.failureKind ?? 'unknown'} — ${facts.why ?? 'no reason recorded'}`,
    `- Files changed inside this step's territory: ${changed.join(', ') || 'none'}`,
    '- Diff stat at the moment it ended:',
    '```',
    facts.diffStatText || '(no diff)',
    '```',
    `- Diff snapshot: ${facts.diffFile ?? 'none taken'}`,
    `- Final answer / partial output: ${outputLine}`,
    `- Stream file: ${streamLine}`,
  ];
  if (events.length) {
    lines.push('- Last response events:');
    for (const event of events) {
      // One line per event. A response carrying its own newlines (or a `##`
      // heading) would otherwise break out of the list and read as part of the
      // task the new worker is being handed.
      const said = typeof event.summary === 'string'
        ? event.summary.replace(/\s+/g, ' ').trim()
        : '';
      lines.push(`  - ${event.at ?? 'time unknown'}: ${said || '(no summary)'}`);
    }
  } else if (facts.hasEventStream === false) {
    lines.push(`- Last response events: none decoded (the ${facts.pool ?? 'unknown'} connector declares no eventStream; see the stream file)`);
  }
  // Only when the attempt ran its checks, so every other handoff stays
  // byte-identical (§2.11).
  if (Array.isArray(facts.evidenceResults) && facts.evidenceResults.length) lines.push(...evidenceHandoffLines(facts.evidenceResults));
  // Stage 3 (§2.3): only the gate retry of a marked run carries this line.
  if (facts.gate === true) lines.push(GATE_RETRY_HANDOFF_LINE);
  lines.push('- Those edits are unverified. You decide whether to keep, fix or revert them, and you must report which.');
  return lines.join('\n');
}

export const GATE_RETRY_HANDOFF_LINE = '- This is the step\'s one automatic retry: the failure above closed its gate. Fix what it names; your earlier edits are still in the workspace.';

const HANDOFF_TAIL_LINES = 10;

const HANDOFF_LINE_CHARS = 200;

function cutHandoffLine(text) {
  const chars = [...String(text)];
  return chars.length > HANDOFF_LINE_CHARS ? `${chars.slice(0, HANDOFF_LINE_CHARS - 1).join('')}…` : String(text);
}

// One evidence item as the retry reads it: what ran, how it ended, where the
// full log is, and its last lines (a schema item's first errors instead of the
// checker's JSON report line).
function evidenceHandoffLines(results) {
  const lines = ['- Evidence Bullswarm ran after that attempt:'];
  for (const item of results) {
    const what = item.type === 'schema'
      ? `schema ${item.file === '$output' ? 'your final response' : item.file} against ${item.schema}`
      : `command \`${item.cmd}\``;
    const seconds = `${Math.max(0, Math.round(Number(item.durationMs ?? 0) / 1000))}s`;
    if (item.status === 'passed') lines.push(`  - ${what}: passed · ${seconds}`);
    else if (item.status === 'not-run') lines.push(`  - ${what}: not run · ${String(item.why ?? 'not run').replace(/^not run: /, '')}`);
    else {
      lines.push(`  - ${what}: failed · ${item.why ?? 'failed'} · ${seconds}`);
      if (item.log) lines.push(`    output: ${item.log}`);
      const shown = item.type === 'schema' && Array.isArray(item.errors) && item.errors.length
        ? { heading: 'errors:', rows: item.errors }
        : { heading: 'last lines:', rows: String(item.tail ?? '').split('\n').filter((line) => line.trim()) };
      const rows = shown.rows.slice(-HANDOFF_TAIL_LINES);
      if (rows.length) {
        lines.push(`    ${shown.heading}`);
        for (const row of rows) lines.push(`      ${cutHandoffLine(row)}`);
      }
    }
    if (Array.isArray(item.touched) && item.touched.length) lines.push(`    also: touched ${item.touched.join(', ')}`);
    if (item.headMoved === true) lines.push('    also: HEAD moved while it ran (another step may have committed)');
  }
  // Every item stopped before it finished: no check judged the work (F9).
  const stopped = results.every((item) => item?.status === 'not-run' && item?.why === 'stopped');
  lines.push(stopped
    ? '- Its checks were stopped before they finished; Bullswarm runs them again after this attempt.'
    : '- Fix the work so every evidence item passes. Do not change what the checks test to make them pass.');
  return lines;
}
