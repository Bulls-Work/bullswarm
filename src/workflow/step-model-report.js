// Reading a step's report and diff for the result card: the report's lead
// lines, the paths a diff changed, and the shared-file requests a report
// asked the integrator to carry.

function collapseMarkdownLinks(line) {
  return String(line ?? '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
}

const BULLET = /^(?:[-*+]|\d+[.)])\s+/;
const HEADING = /^#{1,6}\s*/;

/**
 * The report's first lines as the result card prints them: markdown links
 * collapse to their label, the first item of a list joins the line that
 * introduced it (the kernel's own "Files added:" + bullet shape), and blank
 * lines and heading or bullet markers drop out. Nothing is rewritten beyond
 * that.
 */
export function reportLeadLines(text, limit = 3) {
  const lines = [];
  let joined = false;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const bullet = BULLET.test(trimmed);
    const body = collapseMarkdownLinks(trimmed.replace(HEADING, '').replace(BULLET, '')).replace(/\s+/g, ' ').trim();
    if (!body) continue;
    if (bullet && lines.length && !joined) {
      lines[lines.length - 1] = `${lines[lines.length - 1]} ${body}`;
      joined = true;
    } else {
      lines.push(body);
      joined = false;
    }
    if (lines.length >= limit) break;
  }
  return lines;
}

/** `src/workflow/step-model.js | +992 lines (new)` -> the path. */
export function diffChangedPaths(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.split(' | ')[0].trim())
    .filter((line) => line && !line.startsWith('diff '));
}

/**
 * What a step asked the integrator to carry. Only a report that carries the
 * kernel prompt's "Shared-file requests" heading has anything to show.
 */
export function sharedFileRequests(text, limit = 3) {
  const lines = String(text ?? '').split(/\r?\n/);
  const at = lines.findIndex((line) => /^#{1,6}\s*shared-file requests\s*$/i.test(line.trim()));
  if (at < 0) return [];
  const body = [];
  for (const line of lines.slice(at + 1)) {
    if (/^#{1,6}\s/.test(line.trim())) break;
    body.push(line);
  }
  return reportLeadLines(body.join('\n'), limit);
}
