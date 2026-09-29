// The goal as the `workflow runs` table shows it (QA37 rerun, N2).
//
// Callers often start a goal, or a one-step run's task (whose first line is
// both the goal and the step's purpose), with the folder to work in: "Work in
// ~/…/proj. Read every ticket …". Cut to a narrow column, every such row
// read "Work in ~/…", so a caller could not tell its run from another.
// A leading folder, with its lead-in words, is dropped and the rest shown;
// a bare path with no lead-in is dropped only when it ends in "/" (QA37 wave H).

// "Work in", "Working inside", "In", "cd", "At", "From", "Under", or a label
// such as "Repo:" or "Workspace:" (0.37.2: routed subagents start "Repo: <path>"), then a path
// that starts with /, ~/, ./ or ../, bare or in quotes or backticks. The
// path stops before punctuation that ends it ("proj.", "parser.js:").
const LEADING_FOLDER = /^((?:work(?:ing)?|run(?:ning)?|operate)\s+(?:in|inside|on|at|from|under)\s+|(?:in|inside|at|from|under|cd)\s+|(?:repo(?:sitory)?|folder|dir(?:ectory)?|workspace|project|cwd|path)\s*:\s*)?([`'"]?)((?:~|\.{1,2})?\/[^\s`'"]*?)\2(?=[.,:;]*(?:[\s`'"]|$))/i;
// What joins the folder to the rest: punctuation, "&&", "and", "then".
const JOINER = /^(?:[\s.,:;]|&&|\b(?:and|then)\b)+/i;

// A note in brackets right after the folder ("(a small Node package)")
// describes the folder, not the work: skip it, nested brackets included.
function withoutLeadingNote(text) {
  if (!text.startsWith('(')) return text;
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '(') depth += 1;
    else if (text[index] === ')' && (depth -= 1) === 0) return text.slice(index + 1);
  }
  return text;
}

const lastPart = (path) => path.replace(/\/+$/, '').split('/').filter(Boolean).at(-1) ?? null;

// One line without its leading folder: `{ text, folder }`. A bare path with
// no lead-in is dropped only when it ends in "/"; otherwise it may be the
// file the goal is about ("./src/parser.js: fix …"), so its last part stays.
function withoutFolder(line) {
  const match = line.match(LEADING_FOLDER);
  if (!match) return { text: line, folder: null };
  const [whole, leadIn, , path] = match;
  if (!leadIn && !path.endsWith('/')) {
    return { text: `${lastPart(path) ?? path}${line.slice(whole.length)}`, folder: null };
  }
  const rest = withoutLeadingNote(line.slice(whole.length).trim()).replace(JOINER, '').trim();
  return { text: rest, folder: lastPart(path) };
}

/**
 * The goal's first line without a leading folder. A folder alone on its line
 * is followed by the next non-empty line; a goal that is only a folder shows
 * the folder's name; `?` when empty.
 */
export function goalColumnText(goal) {
  const lines = String(goal ?? '').split(/\r?\n/).map((part) => part.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!lines.length) return '?';
  let folder = null;
  for (const line of lines) {
    const next = withoutFolder(line);
    if (next.text) return next.text;
    folder ??= next.folder;
  }
  return folder ?? lines[0];
}
