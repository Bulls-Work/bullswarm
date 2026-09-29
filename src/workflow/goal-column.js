// The goal as the `workflow runs` table shows it (QA37 rerun, N2).
//
// Callers often start a goal, or a one-step run's task (whose first line is
// both the goal and the step's purpose), with the folder to work in: "Work in
// /Users/…/proj. Read every ticket …". Cut to a narrow column, every such row
// read "Work in /Users/…", so a caller could not tell its run from another.
// A leading folder, with its lead-in words, is dropped and the rest shown.

// "Work in", "Working inside", "In", "cd", "At", "From", "Under", then a path
// that starts with /, ~/, ./ or ../, bare or in quotes or backticks.
const LEADING_FOLDER = /^(?:(?:work(?:ing)?|run(?:ning)?|operate)\s+(?:in|inside|on|at|from|under)\s+|(?:in|inside|at|from|under|cd)\s+)?([`'"]?)((?:~|\.{1,2})?\/[^\s`'"]*)\1/i;
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

/** The first line of a goal, without a leading folder; `?` when empty. */
export function goalColumnText(goal) {
  const line = String(goal ?? '').split(/\r?\n/).map((part) => part.replace(/\s+/g, ' ').trim()).find(Boolean);
  if (!line) return '?';
  const match = line.match(LEADING_FOLDER);
  if (!match) return line;
  const rest = withoutLeadingNote(line.slice(match[0].length).trim()).replace(JOINER, '').trim();
  if (rest) return rest;
  return match[2].replace(/\/+$/, '').split('/').filter(Boolean).at(-1) ?? line;
}
