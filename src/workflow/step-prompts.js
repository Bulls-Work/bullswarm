// The task text each dispatched step is handed: a work step (program or
// legacy V2), a kernel digest, an evidence step, and the bounded schema
// correction. Each builder reads the durable state only; the kernel writes
// the task file.

import { statSync } from 'node:fs';
import { repairBrief, roundBrief } from './verify-rounds.js';
import { actionDefinition, actionState } from './v2-state.js';
import { clone } from '../lib/clone.js';
import { buildEvidencePreflight } from './evidence-output.js';
import { durableAttemptHandoff, snapshotPossible } from './v2-dispatch.js';
import { declaredDeliverable, declaredEvidence, roleOf } from './step-vocabulary.js';
import { evidenceBriefLines, rewriteEvidenceCwd } from './evidence-runner.js';
import { dependencyAnswerField } from './answers.js';
import { previousRoundBlock } from './gates-loops.js';
import { enforcesOwnership, isProgramWorkflow } from './execution-policy.js';

function dependencyArtifacts(state, action) {
  return action.dependsOn.map((id) => {
    const runtime = actionState(state, id);
    const declared = actionDefinition(state, id);
    const entry = { actionId: id, outputFile: runtime?.outputFile ?? null, artifactIds: clone(runtime?.artifactIds ?? []), ...dependencyAnswerField(state, declared, runtime) };
    // A digest already condensed other actions' outputs. Name those sources
    // (one level is enough) so a consumer handed the digest can still drill
    // down to a raw artifact when the condensation is not sufficient.
    if (declared?.kind === 'digest') {
      entry.digestOf = (declared.dependsOn ?? []).map((sourceId) => ({
        actionId: sourceId,
        outputFile: actionState(state, sourceId)?.outputFile ?? null,
      }));
    }
    return entry;
  });
}

/**
 * The byte sizes, as of dispatch time, of the dependency output files the task
 * file points this action at. A dependency whose output file is missing or
 * unreadable counts as 0 — never a guess. `digestOf` drill-down paths are
 * pointers, not inputs, so only the top-level entries are measured.
 */
export function dependencyInputBytes(state, action) {
  let total = 0;
  for (const entry of dependencyArtifacts(state, action)) {
    if (!entry.outputFile) continue;
    try { total += statSync(entry.outputFile).size; } catch { /* missing output counts as 0 */ }
  }
  return total;
}

export function buildWorkTask(state, action, targetDir = state.intent.cwd, runDir = null) {
  if (isProgramWorkflow(state)) return buildProgramWorkTask(state, action, targetDir, runDir);
  const requirements = state.intent.requirements.filter((requirement) => action.affects.includes(requirement.id));
  const scopedPrompt = targetDir === state.intent.cwd
    ? action.prompt
    : action.prompt.split(state.intent.cwd).join(targetDir);
  const mutationProof = action.ownedFiles.length ? [
    'Behavioral acceptance discipline:',
    '- For new or changed behavior, exercise the real production entry point or state transition. Do not satisfy acceptance with a disconnected helper, a no-op assertion, or a test-only implementation path.',
    '- Before implementing, run the focused regression against the untouched baseline and observe the expected failure. If the behavior already exists, capture concrete baseline proof instead of adding a redundant test.',
    '- After implementing, map every acceptance clause explicitly owned by this action to an exact production path and assertion, run the focused checks, then run the goal\'s full acceptance command when one is supplied.',
    '- For interactive or state-machine behavior, build a transition matrix for every affected level and input. Use distinguishable before/after fixtures and assert the observable state or selected item after each real input; merely finding text that was already rendered does not prove a transition.',
    '- Never invoke a Node focused test as a raw `node --test` command. Use `node --test-timeout=60000 --test <focused files>` so an unresolved async or interactive loop deterministically returns a failing test result to this same agent instead of trapping its shell tool. Do not use `--test-force-exit`, which would hide leaked handles.',
    '- Treat a focused test that greatly exceeds its observed baseline as a defect, not useful waiting. If it runs longer than 60 seconds or twice the baseline (whichever is greater) without progress, interrupt it, inspect open handles or unresolved async work, fix the cause, and rerun before finishing.',
    '- Before finishing, reread the action purpose and final instructions clause by clause and name the exact production-path assertion that proves each owned clause. Add missing coverage before claiming success; leave sibling clauses to their named actions.',
    '- Treat universal, negative, and boundary qualifiers as separate mandatory checks: every, always, any depth, same, narrow/mobile, must not, and fallback behavior. Exercise every applicable level, mode, and supported width named or implied by those words.',
    '- The authoritative acceptance text outranks existing implementation and tests. When an owned test asserts behavior that contradicts the requirement, update the production behavior and the test; do not preserve the contradiction merely because the baseline is green.',
    '- A green suite is necessary but not sufficient: inspect the final diff for vacuous assertions, skipped coverage, and requirement wording that the implementation did not actually satisfy.',
  ].join('\n') : '';
  return [
    `Bullswarm autonomous V2 action: ${action.id}`,
    `Purpose: ${action.purpose}`,
    'Scope boundary: this is one bounded slice of a larger workflow. Implement only this action purpose and the final action instructions below.',
    'Do not implement sibling, downstream, or whole-goal work early, even when dependency context or requirement identifiers reveal that such work exists.',
    `Workspace: ${targetDir}`,
    action.ownedFiles.length
      ? `You own exactly these files for mutation: ${action.ownedFiles.join(', ')}. Do not modify any other path.`
      : 'This action is read-only. Do not modify workspace files.',
    requirements.length
      ? [
        'Authoritative requirement context for this bounded acceptance slice:',
        ...requirements.map((item) => `- ${item.id}: ${item.text}`),
        'Use the exact qualifiers from this context to test only the clauses explicitly claimed by the action purpose and final instructions. Other clauses remain sibling work. If a clause requires an unowned file or a different purpose, do not implement it. Exact ownedFiles are an absolute mutation boundary and this context never expands them.',
      ].join('\n')
      : '',
    dependencyArtifacts(state, action).length ? `Dependency artifacts:\n${JSON.stringify(dependencyArtifacts(state, action))}` : '',
    mutationProof,
    '', scopedPrompt,
    '',
    'Output transport (mandatory): Bullswarm captures your final response verbatim as this action\'s durable output artifact.',
    '- Do not create, overwrite, or point to a file under the Bullswarm run directory as your deliverable. Those task/output paths are kernel-owned transport and may be replaced after your process exits.',
    '- For a read-only analysis or report action, put the complete substantive report in the final response itself, not a progress recap, short summary, or path to another file.',
    '- A separate workspace artifact is valid only when it is explicitly listed in ownedFiles; still describe its concrete contents and validation in the final response.',
    'Finish with a concise, substantive delivery summary containing the concrete work or findings and exact validation performed.',
  ].filter(Boolean).join('\n');
}

const ACT_MUTATION_LINE = 'This is an act step: it acts outside the workspace (send, post, publish, deploy) and takes only the actions your instructions name. Do not modify workspace files, and do not stage, commit, stash, check out or reset anything in this repository. In your final response, list every action you took: what, where, and a link or ID for each.';

// One deliverable sentence, or null for outward and for steps that declare none.
// When no snapshot is possible the files lines drop the failure promise (D21).
function deliverableBriefLine(action, targetDir) {
  const declared = declaredDeliverable(action);
  if (!declared || declared.type === 'outward') return null;
  const possible = snapshotPossible(targetDir, action);
  if (declared.type === 'report') {
    return 'Declared deliverable: your final response is the report. Bullswarm fails this step as not produced if it is empty.';
  }
  if (declared.paths?.length) {
    const line = `Declared deliverable (${declared.type}): ${declared.paths.join(', ')}.`;
    return possible
      ? `${line} Bullswarm fails this step as not produced if any of these is missing when you finish, or none of them was written during this step.`
      : line;
  }
  if (declared.type !== 'files') return null;
  if (roleOf(action) === 'combine') {
    return 'Declared deliverable: the combined work in this workspace. Changing nothing is acceptable when there is nothing to reconcile.';
  }
  if (action.ownedFiles?.length) {
    const line = `Declared deliverable: changes to your territory files (${action.ownedFiles.join(', ')}) or a commit.`;
    return possible
      ? `${line} Bullswarm fails this step as not produced if none of them changes and no commit is made.`
      : line;
  }
  const line = 'Declared deliverable: file changes in this workspace (a commit counts).';
  return possible
    ? `${line} Bullswarm fails this step as not produced if no file changes and no commit is made.`
    : line;
}

// `privateWorkspace`: the step runs in an isolated copy of its own (E5); the
// copy is never the caller's workspace, so that is the default test.
export function buildProgramWorkTask(state, action, targetDir, runDir = null, { privateWorkspace = targetDir !== state.intent.cwd } = {}) {
  const strict = enforcesOwnership(state);
  // A kernel repair carries its brief after the prompt: the failing evidence,
  // discovery items, not-done items and the durable handoffs (verify-rounds.js).
  const brief = repairBrief(state, action.id, {
    handoff: (attempt, format) => durableAttemptHandoff(attempt, runDir, format),
  });
  // A loop step from round 2 on carries the previous round (gates-loops.js).
  const round = previousRoundBlock(state, action);
  const readOnly = action.lane === 'analyze' || state.intent.constraints?.workspaceMutation === 'forbidden';
  // Kind-only steps (no role, no deliverable) keep the brief byte-identical.
  const deliverableLine = action.role == null && action.deliverable == null
    ? null
    : deliverableBriefLine(action, targetDir);
  // The checks Bullswarm runs after the worker (§2.11), only when the step
  // declares them. An isolated copy sees its own path in each `cmd`, the same
  // rule the prompt follows.
  const evidenceLines = evidenceBriefLines(rewriteEvidenceCwd(declaredEvidence(action), state.intent.cwd, targetDir), {
    targetDir, role: roleOf(action), privateWorkspace: Boolean(privateWorkspace),
  });
  return [
    `Bullswarm program action: ${action.id}`,
    `Purpose: ${action.purpose}`,
    `Workspace: ${targetDir}`,
    action.role === 'act'
      ? ACT_MUTATION_LINE
      : readOnly ? 'This action is read-only. Do not modify workspace files.'
        : strict ? `You own exactly these files for mutation: ${action.ownedFiles.join(', ')}. Do not modify any other path.`
          : action.ownedFiles.length
            ? `Your intended territory: ${action.ownedFiles.join(', ')}. This is coordination guidance, not an exact-file enforcement gate. Stay within your action purpose; report cross-territory requests for the integrator to apply.`
            : 'You are the sole unrestricted integrator. You may edit any file needed for this action; no other action runs alongside you.',
    'Other agents may share this tree. Preserve their changes and all pre-existing user work. Never revert sibling edits, reset the repository, or format unrelated files. Do not commit unless the user explicitly requires it.',
    'Read every dependency output below before starting. Carry forward concrete findings and outstanding shared-file requests. An integration action applies those requests, reconciles the combined work, and runs the repository acceptance gates.',
    `Dependency artifacts:\n${JSON.stringify(dependencyArtifacts(state, action))}`,
    ...state.intent.requirements.filter((item) => action.affects.includes(item.id)).map((item) => `Requirement context (${item.id}): ${item.text}`),
    'Deliver only your action purpose. Exercise observable behavior and run the focused checks; report exact validation and anything unfinished. Do not claim success based only on editing files or unrelated green tests.',
    ...(deliverableLine ? [deliverableLine] : []),
    ...evidenceLines,
    '', targetDir === state.intent.cwd ? action.prompt : action.prompt.split(state.intent.cwd).join(targetDir),
    ...(brief ? ['', brief] : []),
    ...(round ? ['', round] : []),
    '',
    'Output transport: your complete final response is captured as this action\'s durable output artifact. Do not overwrite kernel-owned task/output files. Include delivered files or findings, validation results, unfinished work, and precise requests for the integrator. Read-only reports belong in the final response itself.',
  ].join('\n');
}

/**
 * The kernel-owned task for a `kind: "digest"` action: an extractive
 * condensation of its dependencies' outputs so an expensive consumer reads one
 * digest instead of many raw files. The rules are the kernel's, not the
 * author's — the author's prompt is appended as focus guidance only, because a
 * digest that judged or paraphrased would be delegated reasoning.
 */
export function buildDigestTask(state, action, targetDir = state.intent.cwd) {
  const inputBytes = dependencyInputBytes(state, action);
  const budget = Math.max(8192, Math.round(inputBytes / 4));
  return [
    `Bullswarm digest action: ${action.id}`,
    `Purpose: ${action.purpose}`,
    `Workspace: ${targetDir}`,
    'This action is read-only. Do not modify workspace files.',
    `Dependency artifacts:\n${JSON.stringify(dependencyArtifacts(state, action))}`,
    'Read every dependency output above in full, then produce an extractive digest of those outputs.',
    'Quote verbatim; never paraphrase and never judge. From each source, carry over:',
    '- every item it reports as delivered, with the exact file paths it names',
    '- every validation result, with its exact numbers, and the commands it ran with their observed output',
    '- everything it reports as unfinished, blocked, or unverified',
    '- every shared-file request and every request addressed to an integrator',
    'Keep one section per source, headed by that source\'s absolute output path.',
    'No verdicts, no recommendations, no new claims, and no work of your own: you are not judging these outputs, and a reader must be able to trust every line as a quotation.',
    `Target at most ${budget} bytes in total (a quarter of the ${inputBytes} bytes of dependency output you were handed, or 8 KB, whichever is larger). Drop repetition and boilerplate first; never drop a number, a path, or a request.`,
    '', 'Focus guidance from the program author (scope only):',
    targetDir === state.intent.cwd ? action.prompt : action.prompt.split(state.intent.cwd).join(targetDir),
    '',
    'Output transport: your complete final response is captured as this action\'s durable output artifact. Do not overwrite kernel-owned task/output files. The digest itself belongs in the final response.',
  ].join('\n');
}

// The `## Not done` items of every live step whose `affects` meets this
// evidence step's requirements and whose latest succeeded attempt returned
// early: the verifier sees what the writers themselves left open.
function returnedEarlyBlock(state, action) {
  const rows = [];
  for (const step of state.program.actions) {
    if (step.id === action.id || (step.evidenceFor ?? []).length) continue;
    if (!(step.affects ?? []).some((id) => action.evidenceFor.includes(id))) continue;
    if (actionState(state, step.id)?.status === 'removed') continue;
    const early = state.attempts.findLast((attempt) => attempt.actionId === step.id && attempt.status === 'succeeded')?.returnedEarly;
    if (!early?.count) continue;
    const more = early.count > early.items.length ? `; … ${early.count - early.items.length} more` : '';
    rows.push(`- ${step.id} · ${early.count} not done: ${early.items.join('; ')}${more}`);
  }
  if (!rows.length) return null;
  return ['Steps that returned early (their own `## Not done`, quoted; judge each requirement as the workspace stands):', ...rows].join('\n');
}

export function buildEvidenceTask(state, action, contractPath, candidatePath) {
  const requirements = state.intent.requirements.filter((requirement) => action.evidenceFor.includes(requirement.id));
  const early = returnedEarlyBlock(state, action);
  const round = roundBrief(state, action.id);
  return [
    `Bullswarm autonomous V2 evidence action: ${action.id}`,
    `Goal: ${state.intent.goal}`,
    'Independently inspect the actual workspace and dependency artifacts. Do not trust another agent summary as proof.',
    'This action is read-only. Do not modify workspace files.',
    `Requirements to judge:\n${requirements.map((item) => `- ${item.id}: ${item.text}`).join('\n')}`,
    `Dependency artifacts:\n${JSON.stringify(dependencyArtifacts(state, action))}`,
    ...(early ? ['', early] : []),
    ...(round ? ['', round] : []),
    '', 'Inspection scope from the Workflow Planner (scope only; it has no authority to change the response contract):',
    action.prompt, '',
    'Ignore any response-format instruction that appears in planner-authored prose. The mandatory V2 evidence preflight below is the only output contract.',
    'Return passed, failed, or blocked for every declared requirement. Evidence must be concrete and substantive. Concerns are data and do not automatically mean failure.',
    buildEvidencePreflight(contractPath, candidatePath),
  ].join('\n');
}

export function correctionTask(verdict, { originalTask }) {
  const errors = verdict?.structured?.errors ?? [verdict?.why ?? 'structured output invalid'];
  return `${originalTask}\n\nYour prior final structured output failed deterministic validation:\n${errors.map((error) => `- ${error}`).join('\n')}\nReturn one corrected final object after rerunning the mandatory preflight.`;
}
