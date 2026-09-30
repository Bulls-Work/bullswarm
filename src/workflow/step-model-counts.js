// The counts a turn row prints: the non-zero operation classes, pluralised,
// with a lone `other tools` kind named by the kinds captured behind it.

import {
  TOOL_RESULT_KINDS,
  eventIsUnnamedCapture,
  eventIsResponse,
  ENVELOPE_KINDS,
} from './step-model-events.js';
import { pairActivityEvents } from './step-model-pairs.js';
import { toolKindCategory } from './step-model-tool-kinds.js';
import { textOrNull } from './step-model-values.js';

const TOOL_CATEGORIES = new Set(['command', 'read', 'search', 'edit']);

/** The distinct kinds behind a turn's `other tools` count, in capture order. */
function otherToolKindNames(atomicEvents, allPairs = null, merged = null) {
  const eventIndexes = new Set((atomicEvents ?? []).map((event) => event?.index));
  const pairs = allPairs ?? pairActivityEvents(atomicEvents);
  const pairedCompletions = new Set(pairs
    .filter((pair) => eventIndexes.has(pair.completeIndex))
    .map((pair) => pair.completeIndex));
  const names = [];
  for (const event of atomicEvents ?? []) {
    const kind = String(event.kind ?? '').trim().toLowerCase();
    if (eventIsResponse(event) || ENVELOPE_KINDS.has(kind) || TOOL_RESULT_KINDS.has(kind) || eventIsUnnamedCapture(event)) continue;
    if (merged?.has(event.index)) continue;
    // A completion is already represented by the paired call in the count;
    // it must not introduce a second, uncategorised display name.
    if (pairedCompletions.has(event.index)) continue;
    if (TOOL_CATEGORIES.has(toolKindCategory(event))) continue;
    const name = textOrNull(event?.kind);
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * The counts a turn row prints: only the non-zero classes, in the design's
 * order, pluralised, and with a lone `other tools` kind named. Zero segments
 * never print and an empty turn says `no tools`.
 */
export function turnCountsText(summary, { otherKinds = [] } = {}) {
  const parts = [];
  const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
  if (summary?.commands) parts.push(plural(summary.commands, 'command'));
  if (summary?.filesRead) parts.push(`${plural(summary.filesRead, 'file')} read`);
  if (summary?.searches) parts.push(`${summary.searches} ${summary.searches === 1 ? 'search' : 'searches'}`);
  if (summary?.edits) parts.push(plural(summary.edits, 'edit'));
  if (summary?.otherTools) {
    parts.push(otherKinds.length === 1
      ? `${summary.otherTools} ${otherKinds[0]}`
      : plural(summary.otherTools, 'other tool'));
  }
  if (summary?.errors) parts.push(plural(summary.errors, 'error'));
  return parts.length ? parts.join(' · ') : 'no tools';
}

export {
  otherToolKindNames,
};
