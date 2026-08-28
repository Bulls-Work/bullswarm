// bullswarm integrate — make the published agent guide discoverable by coding CLIs.
//
// Integration is explicit, idempotent, and reversible. The full operating
// procedure remains in skill/SKILL.md; global instruction files receive only a
// compact trigger policy so CLI documentation cannot drift in three places.

import {
  existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync,
  symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { helpText } from './help.js';

const SKILL_SOURCE = fileURLToPath(new URL('../skill', import.meta.url));
const MARKER_BEGIN = '<!-- bullswarm:begin v2 -->';
const MARKER_END = '<!-- bullswarm:end -->';
const MARKER_RE = /<!-- bullswarm:begin v\d+ -->[\s\S]*?<!-- bullswarm:end -->\n?/;

const AGENT_LAYOUT = {
  codex: { skill: ['.codex', 'skills', 'bullswarm'], instructions: ['.codex', 'AGENTS.md'] },
  claude: { skill: ['.claude', 'skills', 'bullswarm'], instructions: ['.claude', 'CLAUDE.md'] },
  grok: { skill: ['.grok', 'skills', 'bullswarm'], instructions: ['.grok', 'AGENTS.md'] },
};

export const INTEGRATION_AGENTS = Object.freeze(Object.keys(AGENT_LAYOUT));

export function awarenessBlock() {
  return `${MARKER_BEGIN}
## Bullswarm delegation

Bullswarm is available for bounded external delegation. When delegation,
offloading, independent verification, or autonomous multi-step execution is
requested, read the \`bullswarm\` skill before acting. Use \`bullswarm run\` for
one bounded task, \`bullswarm workflow goal\` for ordinary autonomous multi-step
work, and workflow drafts only when the graph itself is the contract. Treat
returned artifacts and verification as evidence, not authority. This policy
supersedes retired pre-Bullswarm \`offload\` routing instructions. If
\`BULLSWARM_DEPTH\` is already set, perform the assigned task directly and do
not recursively invoke Bullswarm unless the task explicitly requires it.
${MARKER_END}`;
}

export function applyAwarenessBlock(filePath, { approved }) {
  if (!approved) return { changed: false, reason: 'not approved' };
  const existing = readOptional(filePath);
  const stripped = existing.replace(MARKER_RE, '').trimEnd();
  const next = stripped ? `${stripped}\n\n${awarenessBlock()}\n` : `${awarenessBlock()}\n`;
  mkdirSync(dirname(filePath), { recursive: true });
  if (next === existing) return { changed: false, reason: 'already current' };
  writeFileSync(filePath, next);
  return { changed: true, reason: existing.match(MARKER_RE) ? 'updated' : 'installed' };
}

export function removeAwarenessBlock(filePath, { approved }) {
  if (!approved) return { changed: false, reason: 'not approved' };
  if (!existsSync(filePath)) return { changed: false, reason: 'not installed' };
  const existing = readFileSync(filePath, 'utf8');
  const next = existing.replace(MARKER_RE, '').trimEnd();
  if (next === existing.trimEnd()) return { changed: false, reason: 'not installed' };
  writeFileSync(filePath, next ? `${next}\n` : '');
  return { changed: true, reason: 'removed' };
}

export function awarenessBlockPresent(filePath) {
  return MARKER_RE.test(readOptional(filePath));
}

export function parseIntegrationAgents(value) {
  const requested = value == null || value === true
    ? INTEGRATION_AGENTS
    : String(value).split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
  const unique = [...new Set(requested)];
  const invalid = unique.filter((agent) => !INTEGRATION_AGENTS.includes(agent));
  if (invalid.length) {
    throw new Error(`unknown integration agent(s): ${invalid.join(', ')}; use ${INTEGRATION_AGENTS.join(', ')}`);
  }
  if (!unique.length) throw new Error('--agents must name at least one agent');
  return unique;
}

export function integrationStatus({
  homeDir = process.env.HOME ?? '', agents = INTEGRATION_AGENTS, skillSource = SKILL_SOURCE,
} = {}) {
  const selected = parseIntegrationAgents(agents);
  const entries = selected.map((agent) => {
    const paths = pathsFor(homeDir, agent);
    return {
      agent,
      skillPath: paths.skillPath,
      skill: skillLinkStatus(paths.skillPath, skillSource),
      instructionsPath: paths.instructionsPath,
      awareness: awarenessBlockPresent(paths.instructionsPath),
    };
  });
  const legacyPath = join(homeDir, '.claude', 'skills', 'offload');
  return {
    ok: entries.every((entry) => entry.skill.status === 'installed' && entry.awareness),
    skillSource,
    agents: entries,
    legacyOffload: {
      path: legacyPath,
      detected: existsSync(legacyPath),
      action: existsSync(legacyPath)
        ? 'bullswarm integrate retire-legacy --yes'
        : null,
    },
  };
}

export function installIntegration({
  homeDir = process.env.HOME ?? '', agents = INTEGRATION_AGENTS,
  skillSource = SKILL_SOURCE, approved = false,
} = {}) {
  if (!approved) throw new Error('integration changes global agent configuration; pass --yes to approve');
  const selected = parseIntegrationAgents(agents);
  if (!existsSync(join(skillSource, 'SKILL.md'))) {
    throw new Error(`packaged Bullswarm skill is missing: ${join(skillSource, 'SKILL.md')}`);
  }
  for (const agent of selected) {
    const { skillPath } = pathsFor(homeDir, agent);
    if (skillLinkStatus(skillPath, skillSource).status === 'conflict') {
      throw new Error(`refusing to replace non-Bullswarm skill path: ${skillPath}`);
    }
  }
  const changes = [];
  for (const agent of selected) {
    const paths = pathsFor(homeDir, agent);
    const skill = installSkillLink(paths.skillPath, skillSource);
    const awareness = applyAwarenessBlock(paths.instructionsPath, { approved: true });
    changes.push({ agent, skill, awareness });
  }
  return { action: 'install', changes, status: integrationStatus({ homeDir, agents: selected, skillSource }) };
}

export function removeIntegration({
  homeDir = process.env.HOME ?? '', agents = INTEGRATION_AGENTS,
  skillSource = SKILL_SOURCE, approved = false,
} = {}) {
  if (!approved) throw new Error('integration removal changes global agent configuration; pass --yes to approve');
  const selected = parseIntegrationAgents(agents);
  const changes = [];
  for (const agent of selected) {
    const paths = pathsFor(homeDir, agent);
    const skill = removeSkillLink(paths.skillPath, skillSource);
    const awareness = removeAwarenessBlock(paths.instructionsPath, { approved: true });
    changes.push({ agent, skill, awareness });
  }
  return { action: 'remove', changes, status: integrationStatus({ homeDir, agents: selected, skillSource }) };
}

export function retireLegacyOffload({ homeDir = process.env.HOME ?? '', approved = false, now = new Date() } = {}) {
  if (!approved) throw new Error('legacy offload retirement moves a user skill; pass --yes to approve');
  const source = join(homeDir, '.claude', 'skills', 'offload');
  if (!existsSync(source)) return { action: 'retire-legacy', changed: false, reason: 'not installed' };
  const archiveRoot = join(homeDir, '.claude', 'skills-archive');
  mkdirSync(archiveRoot, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const destination = join(archiveRoot, `offload-before-bullswarm-${stamp}`);
  renameSync(source, destination);
  return { action: 'retire-legacy', changed: true, source, destination, recoverable: true };
}

export function integrateUsage() {
  return helpText(['integrate']);
}

export function cmdIntegrate(opts) {
  const subcommand = opts.rest[0] ?? 'status';
  if (opts.help || subcommand === 'help') {
    console.log(integrateUsage());
    return 0;
  }
  let agents;
  try {
    agents = parseIntegrationAgents(opts.agents);
    let result;
    if (subcommand === 'status') result = { action: 'status', ...integrationStatus({ agents }) };
    else if (subcommand === 'install') result = installIntegration({ agents, approved: opts.yes === true });
    else if (subcommand === 'remove') result = removeIntegration({ agents, approved: opts.yes === true });
    else if (subcommand === 'retire-legacy') result = retireLegacyOffload({ approved: opts.yes === true });
    else {
      console.error(integrateUsage());
      return 2;
    }
    if (opts.json) console.log(JSON.stringify(result, null, 2));
    else printIntegrationResult(result);
    const ok = result.status?.ok ?? result.ok;
    return ok === false && subcommand === 'status' ? 1 : 0;
  } catch (error) {
    console.error(`✗ ${error.message}`);
    return 1;
  }
}

function pathsFor(homeDir, agent) {
  const layout = AGENT_LAYOUT[agent];
  return {
    skillPath: join(homeDir, ...layout.skill),
    instructionsPath: join(homeDir, ...layout.instructions),
  };
}

function installSkillLink(skillPath, skillSource) {
  const current = skillLinkStatus(skillPath, skillSource);
  if (current.status === 'installed') return { changed: false, ...current };
  if (current.status === 'conflict') {
    throw new Error(`refusing to replace non-Bullswarm skill path: ${skillPath}`);
  }
  mkdirSync(dirname(skillPath), { recursive: true });
  symlinkSync(skillSource, skillPath, 'dir');
  return { changed: true, status: 'installed', path: skillPath, target: skillSource };
}

function removeSkillLink(skillPath, skillSource) {
  const current = skillLinkStatus(skillPath, skillSource);
  if (current.status === 'missing') return { changed: false, ...current };
  if (current.status === 'conflict') {
    return { changed: false, ...current, reason: 'left conflict untouched' };
  }
  unlinkSync(skillPath);
  return { changed: true, status: 'missing', path: skillPath, target: skillSource };
}

function skillLinkStatus(skillPath, skillSource) {
  let stat;
  try { stat = lstatSync(skillPath); } catch { return { status: 'missing', path: skillPath, target: null }; }
  if (!stat.isSymbolicLink()) return { status: 'conflict', path: skillPath, target: null };
  const rawTarget = readlinkSync(skillPath);
  const target = resolve(dirname(skillPath), rawTarget);
  return {
    status: target === resolve(skillSource) ? 'installed' : 'conflict',
    path: skillPath,
    target,
  };
}

function readOptional(filePath) {
  try { return readFileSync(filePath, 'utf8'); } catch { return ''; }
}

function printIntegrationResult(result) {
  if (result.action === 'retire-legacy') {
    console.log(result.changed
      ? `✓ archived retired offload skill at ${result.destination}`
      : 'retired offload skill is not installed');
    return;
  }
  const status = result.status ?? result;
  for (const entry of status.agents ?? []) {
    const skill = entry.skill.status === 'installed' ? 'skill ✓' : `skill ${entry.skill.status}`;
    const awareness = entry.awareness ? 'awareness ✓' : 'awareness missing';
    console.log(`${entry.agent.padEnd(8)} ${skill}; ${awareness}`);
  }
  if (status.legacyOffload?.detected) {
    console.log(`⚠ retired Claude offload skill detected: ${status.legacyOffload.path}`);
    console.log(`  recoverably archive it with: ${status.legacyOffload.action}`);
  }
}
