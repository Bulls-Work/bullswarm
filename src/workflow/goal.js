// Goal-driven workflow bootstrap.
//
// Users provide intent, not a workflow graph. Bullswarm supplies the bounded
// orchestration contract and lets the selected planner expand the durable plan.

function compactRequirement(text) {
  // Requirements are an acceptance contract, not display copy. Truncating
  // them can remove the decisive clause while leaving an apparently valid
  // identifier behind, causing both workers and evidence agents to judge a
  // weaker goal. Display surfaces may truncate a copy; durable intent may not.
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

// Advice for a caller whose goal collapsed to a single requirement. Numbering
// is never required: a goal with distinct deliverables is tracked and repaired
// per clause, while a genuinely holistic outcome ("make the parser faster") is
// correctly one requirement and must not be split into invented parts.
export const REQUIREMENT_GRANULARITY_HINT =
  'This goal is tracked as one requirement, so optional requirement evidence reports one pass/fail for the whole thing. '
  + 'If it has distinct deliverables, number them ("1. ... 2. ...") to get one tracked requirement each, with separate verdicts that identify the part needing follow-up. '
  + 'Leave a single holistic outcome as one sentence; do not invent clauses to split it.';

export function extractGoalRequirements(goal) {
  const text = String(goal ?? '').trim();
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const numbered = [];
  let current = null;
  for (const raw of lines) {
    const line = raw.trim();
    const match = /^(\d+)[.)]\s+(.+)$/.exec(line);
    if (match) {
      if (current) numbered.push(current);
      current = { number: match[1], text: match[2] };
    } else if (current && line && !/^(?:finish with|before completion|acceptance(?: criteria)?|finally)\b/i.test(line)) {
      current.text += ` ${line}`;
    }
  }
  if (current) numbered.push(current);
  // A single line that carries several inline markers ("1. Fix the parser.
  // 2. Update the docs.") is one numbered line to the pass above; split it on
  // the inline markers so the documented one-line form yields one requirement
  // per clause, exactly like the newline-separated form.
  // Inline markers count only when they form a list that starts at 1, so a
  // prose goal mentioning "version 2. Then ..." is not split on the number.
  const markers = [...text.matchAll(/(?:^|\s)(\d+)[.)]\s+/g)];
  if (numbered.length <= 1 && markers.length > numbered.length && markers[0]?.[1] === '1') {
    numbered.length = 0;
    for (let index = 0; index < markers.length; index += 1) {
      const marker = markers[index];
      const start = marker.index + marker[0].length;
      const end = markers[index + 1]?.index ?? text.length;
      const requirement = text.slice(start, end).trim();
      if (requirement) numbered.push({ number: marker[1], text: requirement });
    }
  }
  const requirements = numbered.map((entry, index) => ({
    id: `R${index + 1}`,
    text: compactRequirement(entry.text),
  }));
  const finalLines = lines
    .map((line) => line.trim())
    .filter((line) => /^(?:finish with|before completion|acceptance(?: criteria)?|finally)\b/i.test(line));
  if (finalLines.length) {
    requirements.push({ id: `R${requirements.length + 1}`, text: compactRequirement(finalLines.join(' ')) });
  }
  return requirements.length ? requirements : [{ id: 'R1', text: compactRequirement(text) }];
}

export function extractScoutUnitIds(report) {
  const source = String(report ?? '').trim();
  for (let index = source.lastIndexOf('['); index >= 0; index = source.lastIndexOf('[', index - 1)) {
    try {
      const parsed = JSON.parse(source.slice(index));
      if (!Array.isArray(parsed) || !parsed.length) continue;
      const units = parsed.map((unit) => String(unit).trim());
      if (units.some((unit) => !/^[a-z0-9][a-z0-9-]*$/.test(unit))) continue;
      if (new Set(units).size !== units.length) continue;
      return units;
    } catch { /* try an earlier trailing array opener */ }
  }
  return [];
}

// Read-only survey that runs before the orchestrator's first decision, so the
// program it compiles names real files, modules, and commands instead of
// guessing — the equivalent of the inline scouting a Claude Code session does
// before authoring a Workflow script.
export function scoutPrompt(goal, cwd) {
  return [
    'You are the read-only SCOUT for an autonomous workflow. Another agent will turn the goal below into a program of parallel worker actions using ONLY your report, so be concrete and complete.',
    `Working directory (absolute): ${cwd}`,
    `Goal: ${goal}`,
    '',
    'Survey what the goal touches. Do NOT modify, create, or delete any file; do not install dependencies; do not commit.',
    'Report under exactly these headings, at most ~80 lines total:',
    'TREE: the directory tree to depth 3 (skip node_modules, .git, build output), one entry per line.',
    'MANIFEST: package/build manifest facts that matter (name, language/runtime, test command, lint/format command, module system).',
    'TEST STATUS: run the test command once and report the exact pass/fail counts and any failing test names.',
    'UNITS OF WORK: one bullet per coherent, independently observable acceptance slice the goal implies (behavior, transition, module, finding, page). If one numbered requirement contains several independently testable clauses or state transitions, split those clauses into separate ordered slices even though they share one requirement and the same files; avoid an umbrella unit named after the whole requirement. For each: quote the decisive acceptance qualifiers it owns (especially every, always, any depth, same, narrow/mobile, negative constraints, and fallback behavior), name the exact production and test files it may need to change, the exact focused command that proves it is done, anything already present, and semantic dependencies. Existing implementation or tests that contradict the goal are migration work, not acceptance authority: state the conflict explicitly and assign a mutation-capable owner that can change both production behavior and its tests. Explicitly identify tests that specify behavior introduced by another unit: each focused regression belongs with that behavior implementation, while later cross-cutting acceptance may depend on the integrated earlier slices.',
    'When a requirement spans several ordered slices, add one final cross-cutting acceptance slice after them. That slice must own the relevant production files as well as tests, must exercise every decisive qualifier across the integrated result, and must be authorized to close discovered behavior gaps. A tests-only regression slice is not a valid final owner for cross-cutting behavior.',
    'SHARED FILES: files that more than one slice would touch. Shared ownership forbids parallel mutation, but it does not require one monolithic action: if the slices are independently testable, recommend a small ordered sequence that reuses the same owned files and builds on the integrated prior slice.',
    'RISKS: anything that constrains the plan (files that must not change, flaky tests, missing tools, ambiguous requirements).',
    'Finally, END your output with a JSON array of the unit-of-work names in UNITS OF WORK, e.g. ["csv","duration"]. Nothing after the array.',
  ].join('\n');
}
