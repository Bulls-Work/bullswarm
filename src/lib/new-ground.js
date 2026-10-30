// "New ground" for an analyze worker: the last moment it did something it had
// not done before in this attempt. A tool call counts when its target (the
// event kind plus its summary: the command, file or pattern the connector's
// summaryPaths name) has not been used yet; a reply counts when it is longer
// than 200 characters and not identical to an earlier one, because the worker
// is then writing its analysis. A worker that only repeats earlier reads never
// moves it (2026-10-12 benchmark: an analyze worker re-read the same files for
// over an hour; the silence clock restarts on every byte).
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const MIN_NEW_TEXT_CHARS = 200;
// Events that are not a call on a target: the reply, the final result, usage
// counters, and the worker's own reasoning, which is new text every time.
const NOT_A_TARGET = /^(response|result|usage|agent|thinking|reasoning|error|status)$/i;

function targetOf(event, fullSummary, cwd) {
  const kind = String(event?.kind ?? '').trim();
  if (!kind || NOT_A_TARGET.test(kind)) return null;
  const raw = typeof fullSummary === 'string' ? fullSummary : event?.summary;
  const summary = typeof raw === 'string' ? raw.trim() : '';
  if (!summary) return null;
  // A single token is a path or a pattern: a relative path is the same file
  // as its absolute form.
  const normal = cwd && !/\s/.test(summary) && !summary.startsWith('-') ? resolve(cwd, summary) : summary;
  return `${kind}\u0000${normal}`;
}

export function createNewGroundTracker({ cwd = null, startedAtMs = Date.now(), now = Date.now } = {}) {
  let lastAt = startedAtMs;
  const targets = new Set();
  const texts = new Set();
  return {
    observe(event, fullSummary) {
      if (event?.kind === 'response') {
        const text = String(typeof fullSummary === 'string' ? fullSummary : event?.summary ?? '').trim();
        if (text.length <= MIN_NEW_TEXT_CHARS) return;
        const digest = createHash('sha1').update(text).digest('hex');
        if (texts.has(digest)) return;
        texts.add(digest);
        lastAt = now();
        return;
      }
      const target = targetOf(event, fullSummary, cwd);
      if (target === null || targets.has(target)) return;
      targets.add(target);
      lastAt = now();
    },
    lastAt: () => lastAt,
  };
}
