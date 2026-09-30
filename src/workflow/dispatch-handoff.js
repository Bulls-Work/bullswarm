// The durable handoff a stopped or failed attempt leaves its next attempt:
// its facts read back from its saved files, written as one block.
import { clone } from '../lib/clone.js';
import { isAbsolute, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { handoffBlock } from './retry-handoff.js';
import { fileBytes } from './dispatch-attempt-files.js';

export function lastResponseEvents(streamFile, limit = 3) {
  if (!streamFile) return [];
  try {
    const events = [];
    for (const line of readFileSync(streamFile, 'utf8').split('\n')) {
      if (!line) continue;
      let parsed;
      try { parsed = JSON.parse(line); } catch { continue; }
      if (parsed?.truncated === true) continue;
      if (parsed?.kind === 'response') {
        events.push({
          at: parsed.at ?? null,
          kind: 'response',
          summary: parsed.summary ?? parsed.response ?? null,
        });
      }
    }
    return events.slice(-limit);
  } catch {
    return [];
  }
}

function durableArtifactPath(runDir, path) {
  if (!path) return null;
  return isAbsolute(path) || !runDir ? path : join(runDir, path);
}

function durableHandoffFacts(attempt, runDir) {
  if (!attempt || typeof attempt !== 'object') return null;
  const streamFile = durableArtifactPath(runDir, attempt.streamFile);
  const diffFile = durableArtifactPath(runDir, attempt.diffFile);
  const outputFile = durableArtifactPath(runDir, attempt.outputFile ?? attempt.partialOutput);
  const diffStatText = diffFile && existsSync(diffFile)
    ? (() => { try { return readFileSync(diffFile, 'utf8').trimEnd(); } catch { return ''; } })()
    : '';
  const outputBytes = attempt.outputBytes ?? (outputFile ? fileBytes(outputFile) : null);
  const lastEvents = lastResponseEvents(streamFile);
  if (!lastEvents.length && typeof attempt.lastResponse === 'string' && attempt.lastResponse) {
    lastEvents.push({ at: attempt.finishedAt ?? null, kind: 'response', summary: attempt.lastResponse });
  }
  return {
    pool: attempt.pool,
    model: attempt.model,
    startedAt: attempt.startedAt,
    finishedAt: attempt.finishedAt,
    failureKind: attempt.failureKind,
    why: attempt.why,
    diffStatText,
    diffFile,
    changedFiles: Array.isArray(attempt.changedFiles) ? attempt.changedFiles : [],
    outputFile,
    partialOutput: durableArtifactPath(runDir, attempt.partialOutput),
    outputBytes,
    streamFile,
    hasEventStream: Boolean(streamFile && streamFile.endsWith('.jsonl')),
    lastEvents,
    // Only when the attempt ran its checks, so every other handoff stays
    // byte-identical.
    ...(Array.isArray(attempt.evidenceResults) ? { evidenceResults: clone(attempt.evidenceResults) } : {}),
  };
}

export function durableHandoff(attempt, runDir, formatHandoff) {
  const facts = durableHandoffFacts(attempt, runDir);
  if (!facts) return null;
  const block = formatHandoff(facts);
  if (typeof block !== 'string' || !block) return null;
  return {
    block,
    from: attempt.id ?? `${attempt.actionId ?? 'attempt'}-${attempt.ordinal ?? 1}`,
    bytes: Buffer.byteLength(block, 'utf8'),
  };
}

export function durableAttemptHandoff(attempt, runDir, formatHandoff = handoffBlock) {
  return durableHandoff(attempt, runDir, formatHandoff);
}
