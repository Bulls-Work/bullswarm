// How a connector's worker is started: its argv (task file, cwd, model,
// reasoning and conversation arguments substituted into the connector's
// command, and the follow-up turn's), and its environment.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appliedReasoningLevel, reasoningArgs } from './reasoning.js';

const BULLSWARM_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function substituteArgv(cmdTemplate, { taskFile, cwd }) {
  return cmdTemplate.map((a) =>
    a
      .replaceAll('{taskFile}', taskFile)
      .replaceAll('{bullswarmDir}', BULLSWARM_DIR)
      .replaceAll('{cwd}', cwd),
  );
}

function substituteFollowUpArgv(cmdTemplate, { taskFile, cwd, sessionId, prompt }) {
  return cmdTemplate.map((arg) => String(arg)
    .replaceAll('{taskFile}', taskFile)
    .replaceAll('{bullswarmDir}', BULLSWARM_DIR)
    .replaceAll('{cwd}', cwd)
    .replaceAll('{sessionId}', sessionId)
    .replaceAll('{prompt}', prompt));
}

export function followUpArgv(connector, { taskFile, cwd, sessionId, prompt }) {
  const followUp = connector.conversation?.followUp;
  if (!Array.isArray(followUp?.cmd) || !followUp.cmd.length || !sessionId) return null;
  const argv = substituteFollowUpArgv(followUp.cmd, { taskFile, cwd, sessionId, prompt });
  const streamArgs = Array.isArray(followUp.eventStreamArgs)
    ? followUp.eventStreamArgs
    : (connector.eventStream?.args ?? []);
  return argv.concat(streamArgs.map(String));
}

/**
 * Build the argv this connector is spawned with.
 *
 * `reasoning` is the resolved record from resolveReasoningLevel (or a bare
 * level string). Its level is appended exactly like the model flag — after
 * the model and the conversation arguments, before the event-stream args —
 * and nothing is appended when the resolver applied no level.
 */
export function argvWithModel(connector, paths, model = null, conversation = null, reasoning = null) {
  const argv = substituteArgv(connector.spawn.cmd, paths);
  if (model && connector.modelSelection?.flag) {
    const flag = connector.modelSelection.flag;
    const index = argv.indexOf(flag);
    if (index >= 0) {
      if (index + 1 < argv.length) argv[index + 1] = model;
      else argv.push(model);
    } else {
      argv.push(flag, model);
    }
  }
  if (conversation?.sessionId && connector.conversation) {
    const template = conversation.resume
      ? connector.conversation.resumeArgs
      : connector.conversation.newArgs;
    argv.push(...(template ?? []).map((arg) => String(arg).replaceAll('{sessionId}', conversation.sessionId)));
  }
  const reasoningLevel = appliedReasoningLevel(reasoning);
  if (reasoningLevel) {
    const flag = connector.reasoning?.flag;
    const index = typeof flag === 'string' && flag ? argv.indexOf(flag) : -1;
    if (index >= 0) {
      // Replace-or-append, like the model flag: a connector template that
      // already pins a level must end up with ONE level, not two.
      if (index + 1 < argv.length) argv[index + 1] = reasoningLevel;
      else argv.push(reasoningLevel);
    } else {
      argv.push(...reasoningArgs(connector, reasoningLevel));
    }
  }
  argv.push(...(connector.eventStream?.args ?? []));
  return argv;
}

/**
 * The environment a worker runs with, lowest precedence first:
 * - this process's environment;
 * - the caller's (`callerEnv`, usually a full copy of the parent's);
 * - the pool's own settings (`connector.env`), which say which account the
 *   pool bills, such as claude-code's CLAUDE_CONFIG_DIR. They must win over
 *   the caller's copy: a caller running under one Claude home used to send
 *   every claude-code pool to that one account;
 * - Bullswarm's own keys from the caller (`BULLSWARM_*`, among them the
 *   BULLSWARM_DEPTH recursion guard), which no pool setting may override;
 * - PWD, always the spawned directory (a stale PWD is the wrong-repo hazard).
 */
export function workerEnv(connector, callerEnv = {}, cwd = process.cwd(), base = process.env) {
  const caller = callerEnv ?? {};
  const own = Object.fromEntries(Object.entries(caller).filter(([key]) => key.startsWith('BULLSWARM_')));
  return { ...base, ...caller, ...(connector?.env ?? {}), ...own, PWD: cwd };
}
