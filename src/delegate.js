// One agent-facing entry point for choosing a bounded delegate or an
// autonomous workflow. Classification is deliberately transparent: callers
// can preview it, override it, and persist the suggested workflow shape.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const BIN = fileURLToPath(new URL('../bin/bullswarm.js', import.meta.url));
const MODES = new Set(['auto', 'single', 'workflow']);
const LANES = new Set(['analyze', 'build', 'chore']);
const EFFORTS = new Set(['high', 'medium', 'low']);
const CLASSIFIERS = new Set(['deterministic', 'llm']);
const CLASSIFY_TIMEOUT_SEC = 90;

const MUTATION_WORDS = '(?:add|build|change|create|delete|edit|fix|implement|migrate|modify|patch|refactor|remove|rename|replace|update|write)';
const MUTATION_RE = new RegExp(`\\b${MUTATION_WORDS}\\b(?!-)`, 'i');
const READ_ONLY_LABEL_RE = /\bread[- ]only\b/i;
const NEGATED_CLAUSE_RE = /\b(?:do not|don't|must not|never)\b[^.;\n]*/gi;
const WITHOUT_CLAUSE_RE = /\bwithout\b[^.;\n]*/gi;
const INSTRUCTIONAL_MUTATION_RE = new RegExp(`\\b(?:how|ways?)\\s+to\\s+${MUTATION_WORDS}\\b`, 'gi');
const ANALYSIS_RE = /\b(?:analy[sz]e|audit|diagnose|explain|inspect|investigate|research|review|summari[sz]e|verify)\b/i;
const CHORE_RE = /\b(?:convert|draft|format|list|reformat|rename|summari[sz]e|transcribe)\b/i;

function countMatches(text, re) {
  return [...String(text).matchAll(re)].length;
}

export function inferLane(task) {
  if (hasMutationIntent(task)) return 'build';
  if (CHORE_RE.test(task) && !ANALYSIS_RE.test(task)) return 'chore';
  return 'analyze';
}

export function classifyTask({ task, mode = 'auto', lane = null, plan = null } = {}) {
  const text = String(task ?? '').trim();
  if (!text) throw new Error('task text is required');
  if (!MODES.has(mode)) throw new Error('--mode must be auto, single, or workflow');
  if (lane != null && !LANES.has(lane)) throw new Error('--lane must be analyze, build, or chore');

  const signals = [];
  let score = 0;
  const numbered = countMatches(text, /(?:^|\s)\d+[.)]\s+\S+/g);
  const bullets = countMatches(text, /^\s*[-*]\s+\S+/gm);
  const words = text.split(/\s+/).filter(Boolean).length;
  const mutation = hasMutationIntent(text);
  const lifecycle = [
    mutation,
    /\b(?:test|verify|validate|acceptance)\b/i.test(text),
    /\b(?:deploy|publish|release|ship)\b/i.test(text),
    /\b(?:document|docs|readme|report)\b/i.test(text),
  ].filter(Boolean).length;

  if (numbered >= 2) { score += numbered >= 3 ? 4 : 3; signals.push(`${numbered} numbered deliverables`); }
  else if (bullets >= 3) { score += 3; signals.push(`${bullets} listed deliverables`); }
  if (/\b(?:multi[- ]step|end[- ]to[- ]end|parallel|fan[- ]?out|across (?:multiple|several)|independent (?:agents|workers|verification)|independently (?:verify|review))\b/i.test(text)) {
    score += 3;
    signals.push('explicit coordination or parallelism');
  }
  if (/\b(?:audit|inspect|review|verify|check)\b[^.\n]{0,60}\b(?:each|every|all)\b|\b(?:each|every|all)\b[^.\n]{0,60}\b(?:file|command|module|package|issue|pull request|document)\b/i.test(text)) {
    score += 3;
    signals.push('broad repeated inspection');
  }
  if (lifecycle >= 3) { score += 2; signals.push('multiple delivery lifecycle stages'); }
  if (words >= 120) { score += 1; signals.push('large requirement surface'); }

  const selectedMode = mode === 'auto' ? (score >= 3 ? 'workflow' : 'single') : mode;
  const selectedLane = lane ?? inferLane(text);
  const overridden = mode !== 'auto';
  const readOnly = !mutation;
  const phases = selectedMode === 'single'
    ? [{ name: 'Delegate', objective: `One bounded ${selectedLane} task with a content-verified result.` }]
    : workflowPhases(text, { readOnly });
  const suggestedPlan = plan?.trim() || phases
    .map((phase) => `${phase.name}: ${phase.objective}`)
    .join(' ');
  const reason = overridden
    ? `The caller explicitly selected ${selectedMode} mode.`
    : selectedMode === 'workflow'
      ? `This request benefits from coordinated execution because it has ${signals.join(', ') || 'multiple dependent outcomes'}.`
      : 'This request has one bounded outcome and does not need a planning round or multiple coordinated agents.';

  return {
    schemaVersion: 'bullswarm.task-decision.v1',
    mode: selectedMode,
    source: overridden ? 'caller-override' : 'deterministic-classifier',
    confidence: overridden || score === 0 || score >= 5 ? 'high' : 'medium',
    reason,
    score,
    signals,
    lane: selectedMode === 'single' ? selectedLane : null,
    phases,
    suggestedPlan,
  };
}

function hasMutationIntent(task) {
  const text = String(task);
  if (READ_ONLY_LABEL_RE.test(text)) return false;
  const removeNonIntentClause = (clause) => (MUTATION_RE.test(clause) ? '' : clause);
  const remaining = text
    .replace(NEGATED_CLAUSE_RE, removeNonIntentClause)
    .replace(WITHOUT_CLAUSE_RE, removeNonIntentClause)
    .replace(INSTRUCTIONAL_MUTATION_RE, '');
  return MUTATION_RE.test(remaining);
}

function workflowPhases(text, { readOnly }) {
  const phases = [{
    name: readOnly ? 'Inspect' : 'Discover',
    objective: readOnly
      ? 'Establish the relevant scope and concrete evidence.'
      : 'Inspect the current state, requirements, ownership boundaries, and focused acceptance commands.',
  }];
  if (!readOnly) phases.push({
    name: 'Execute',
    objective: 'Deliver substantial disjoint units in parallel only where that saves time; batch small related edits.',
  });
  phases.push({
    name: 'Verify',
    objective: 'Independently verify every required outcome with focused evidence, repairing only genuine rejection failures.',
  });
  if (/\b(?:deploy|publish|release|ship|report|document|readme)\b/i.test(text)) phases.push({
    name: 'Deliver',
    objective: 'Produce the requested handoff or release evidence and stop without optional expansion.',
  });
  return phases;
}

export function buildDelegateInvocation(decision, {
  task, cwd = process.cwd(), effort = null, timeout = null, noCaller = false,
} = {}) {
  const targetDir = resolve(cwd);
  if (decision.mode === 'single') {
    return {
      verb: 'run',
      argv: [
        'run', '--lane', decision.lane, '--add-dir', targetDir, '--prompt', task, '--json',
        ...(effort ? ['--effort', effort] : []),
        ...(timeout != null ? ['--timeout', String(timeout)] : []),
        ...(noCaller ? ['--no-caller'] : []),
      ],
      display: `bullswarm run --lane ${decision.lane} --add-dir ${targetDir} --prompt <task> --json`,
    };
  }
  return {
    verb: 'workflow',
    argv: [
      'workflow', 'goal', task, '--cwd', targetDir,
      '--suggested-plan', decision.suggestedPlan, '--json',
    ],
    display: `bullswarm workflow goal <task> --cwd ${targetDir} --suggested-plan <plan> --json`,
  };
}

// --- LLM-refined classification (R2) ----------------------------------------
// The classification request travels through the exact same runtime dispatch
// path as any delegated task (`bullswarm run`), so pool routing, metering,
// depth guards, and quarantine all apply. Nothing here is provider-specific.

export function buildClassificationPrompt(task, decision) {
  return [
    'You are a delegation-mode classifier for Bullswarm.',
    'Decide whether the task below should run as one bounded single-agent delegation ("single") or an autonomous multi-agent workflow ("workflow").',
    '',
    `Deterministic guess: ${decision.mode}`,
    `Deterministic score: ${decision.score}`,
    `Deterministic signals: ${decision.signals.length ? decision.signals.join('; ') : '(none)'}`,
    '',
    'Task:',
    task,
    '',
    'Respond with strict JSON only — no prose, no code fences, exactly:',
    '{"mode":"single"|"workflow","reason":"<one short sentence>"}',
  ].join('\n');
}

export function buildClassificationInvocation(task, decision) {
  return [
    'run', '--lane', 'analyze', '--effort', 'low',
    '--timeout', String(CLASSIFY_TIMEOUT_SEC), '--no-caller',
    '--prompt', buildClassificationPrompt(task, decision), '--json',
  ];
}

export function extractModeDecision(text) {
  const stripped = String(text ?? '').replace(/```[a-z]*\n?/gi, '');
  const candidates = [stripped.trim(), ...(stripped.match(/\{[^{}]*\}/g) ?? [])];
  for (const candidate of candidates) {
    let parsed;
    try { parsed = JSON.parse(candidate); } catch { continue; }
    if (parsed && typeof parsed === 'object'
      && (parsed.mode === 'single' || parsed.mode === 'workflow')
      && typeof parsed.reason === 'string' && parsed.reason.trim()) {
      return { mode: parsed.mode, reason: parsed.reason.trim() };
    }
  }
  return null;
}

async function requestLlmClassification(task, decision, execute) {
  let child;
  try {
    child = await execute(buildClassificationInvocation(task, decision));
  } catch (error) {
    throw new Error(`classification dispatch failed: ${error.message}`);
  }
  let verdict;
  try { verdict = JSON.parse(child.stdout); }
  catch { throw new Error('classification dispatch returned a non-JSON verdict'); }
  if (verdict.keepOnClaude) {
    throw new Error(`no delegate pool available for classification${verdict.why ? `: ${verdict.why}` : ''}`);
  }
  // Parseability of the delegate's answer is the acceptance criterion — the
  // generic content gate may reject a one-line JSON body, so verdict.ok is
  // deliberately not consulted here.
  let output = typeof verdict.response === 'string' ? verdict.response : '';
  if (!output.trim() && typeof verdict.outFile === 'string') {
    try { output = readFileSync(verdict.outFile, 'utf8'); } catch { output = ''; }
  }
  const llm = extractModeDecision(output);
  if (!llm) {
    throw new Error(`classification produced unusable output${verdict.why ? ` (${verdict.why})` : ''}`);
  }
  return llm;
}

async function refineDecision({ task, deterministic, opts, execute }) {
  let llm;
  try {
    llm = await requestLlmClassification(task, deterministic, execute);
  } catch (error) {
    if (opts.classify === 'llm') throw new Error(`--classify=llm failed: ${error.message}`);
    return deterministic; // silent fallback to the deterministic decision
  }
  const refined = classifyTask({
    task, mode: llm.mode, lane: opts.lane ?? null, plan: opts.plan ?? null,
  });
  return {
    ...refined,
    source: 'llm-classifier',
    confidence: 'high',
    reason: llm.reason,
    score: deterministic.score,
    deterministic: {
      mode: deterministic.mode,
      score: deterministic.score,
      signals: deterministic.signals,
      reason: deterministic.reason,
    },
  };
}

export async function cmdDelegate(opts, {
  execute = executeInvocation,
  writeOut = (value) => console.log(value),
  writeErr = (value) => console.error(value),
} = {}) {
  try {
    validateOptions(opts);
    const task = taskText(opts);
    const requestedMode = opts.mode ?? 'auto';
    let decision = classifyTask({
      task,
      mode: requestedMode,
      lane: opts.lane ?? null,
      plan: opts.plan ?? null,
    });
    // LLM refinement runs only in auto mode: explicit --mode and --dry-run
    // never dispatch classification, and --classify=deterministic opts out.
    if (requestedMode === 'auto' && opts['dry-run'] !== true && opts.classify !== 'deterministic') {
      decision = await refineDecision({ task, deterministic: decision, opts, execute });
    }
    const invocation = buildDelegateInvocation(decision, {
      task,
      cwd: opts.cwd ?? process.cwd(),
      effort: opts.effort ?? null,
      timeout: opts.timeout ?? null,
      noCaller: opts['no-caller'] === true,
    });
    const envelope = {
      schemaVersion: 'bullswarm.delegate.v1',
      action: opts['dry-run'] ? 'planned' : 'execute',
      task,
      cwd: resolve(opts.cwd ?? process.cwd()),
      decision,
      invocation: { verb: invocation.verb, display: invocation.display },
    };
    if (opts['dry-run']) {
      emitEnvelope(envelope, opts, writeOut);
      return 0;
    }
    if (!opts.json) printDecision(envelope, writeOut);
    const child = await execute(invocation.argv);
    let execution;
    try { execution = JSON.parse(child.stdout); }
    catch {
      execution = { ok: false, why: 'Bullswarm child returned non-JSON output', stdout: child.stdout.trim() };
    }
    envelope.execution = execution;
    envelope.exitCode = child.status;
    if (child.stderr.trim()) envelope.stderr = child.stderr.trim();
    if (opts.json) writeOut(JSON.stringify(envelope, null, 2));
    else printExecution(envelope, writeOut, writeErr);
    return child.status;
  } catch (error) {
    writeErr(`✗ ${error.message}`);
    return 2;
  }
}

function validateOptions(opts) {
  for (const name of ['mode', 'lane', 'plan', 'effort', 'timeout', 'cwd', 'task-file', 'prompt', 'classify']) {
    if (opts[name] === true) throw new Error(`--${name} requires a value`);
  }
  if (opts.effort != null && !EFFORTS.has(opts.effort)) {
    throw new Error('--effort must be high, medium, or low');
  }
  if (opts.classify != null && !CLASSIFIERS.has(opts.classify)) {
    throw new Error('--classify must be deterministic or llm');
  }
  if (opts.timeout != null && (!Number.isFinite(Number(opts.timeout)) || Number(opts.timeout) <= 0)) {
    throw new Error('--timeout must be a positive number of seconds');
  }
  const cwd = resolve(opts.cwd ?? process.cwd());
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    throw new Error(`--cwd must be an existing directory: ${cwd}`);
  }
}

function taskText(opts) {
  const rest = opts.rest ?? [];
  if (opts['task-file'] && (opts.prompt != null || rest.length)) {
    throw new Error('choose one of --task-file, --prompt, or trailing task text');
  }
  if (opts.prompt != null && rest.length) {
    throw new Error('choose one of --prompt or trailing task text');
  }
  const value = opts['task-file']
    ? readFileSync(resolve(opts['task-file']), 'utf8')
    : opts.prompt ?? rest.join(' ');
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('empty task: pass --task-file, --prompt, or trailing task text');
  }
  return value.trim();
}

function emitEnvelope(envelope, opts, writeOut) {
  if (opts.json) writeOut(JSON.stringify(envelope, null, 2));
  else printDecision(envelope, writeOut);
}

function printDecision(envelope, writeOut) {
  const decision = envelope.decision;
  writeOut(`Bullswarm decision · ${decision.mode === 'single' ? 'single bounded agent' : 'autonomous workflow'} · confidence ${decision.confidence}`);
  writeOut(`Why · ${decision.reason}`);
  writeOut('Plan');
  decision.phases.forEach((phase, index) => writeOut(`  ${index + 1}. ${phase.name} · ${phase.objective}`));
  writeOut(`Execution · ${envelope.invocation.display}`);
}

function printExecution(envelope, writeOut, writeErr) {
  if (envelope.stderr) writeErr(envelope.stderr);
  const result = envelope.execution ?? {};
  if (envelope.decision.mode === 'workflow') {
    writeOut(`Workflow launched · ${result.shortId ?? result.runId ?? 'unknown run'}`);
    if (result.observe?.watch) writeOut(`Watch · ${result.observe.watch}`);
    if (result.observe?.dashboard) writeOut(`Human TUI · ${result.observe.dashboard}`);
    if (result.observe?.result) writeOut(`Result · ${result.observe.result}`);
    return;
  }
  writeOut(`Delegate result · ${result.keepOnClaude ? 'keep on caller' : result.ok ? 'verified' : 'failed'}${result.why ? ` · ${result.why}` : ''}`);
  if (result.outFile) writeOut(`Output · ${result.outFile}`);
}

function executeInvocation(argv) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [BIN, ...argv], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', rejectPromise);
    child.on('close', (status) => resolvePromise({ status: status ?? 1, stdout, stderr }));
  });
}
