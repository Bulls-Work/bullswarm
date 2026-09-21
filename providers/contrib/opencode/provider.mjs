// bullswarm contrib provider: opencode — the generic OpenCode CLI pool.
// connector.json is the whole pool; there is no meter. It is also the
// template a reseller provider clones through `ctx.templates.opencode`
// (see docs/reference/providers.md).

import {
  buildTranscriptIndex as buildOpenCodeTranscriptIndex,
  readTranscriptUsage as readOpenCodeTranscriptUsage,
} from '../../../src/lib/transcripts/opencode.js';

export const name = 'opencode';
export const displayName = 'OpenCode';

/** Build the provider-owned read-only OpenCode SQLite index for bulk pricing. */
export function buildTranscriptIndex(args = {}) {
  return buildOpenCodeTranscriptIndex(args);
}

/** Read one attempt's durable OpenCode usage through the provider hook. */
export function readTranscriptUsage(args = {}) {
  return readOpenCodeTranscriptUsage(args);
}
