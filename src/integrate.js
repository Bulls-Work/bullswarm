// bullswarm integrate — make the published agent guide discoverable by coding CLIs.
//
// Integration is explicit, idempotent, and reversible. The full operating
// procedure remains in skill/SKILL.md; global instruction files receive only a
// compact trigger policy so CLI documentation cannot drift in three places.

import {
  accessSync, constants, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync,
  readlinkSync, realpathSync, renameSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { helpText } from './help.js';

const SKILL_SOURCE = fileURLToPath(new URL('../skill', import.meta.url));
// The Claude Mod: function hooks that put Bullswarm into Claude Code's own
// interface. Claude loads a plugin folder linked under ~/.claude/skills, and
// runs its hooks only while CLAUDE_CODE_ENABLE_FUNCTION_HOOKS is set (early
// access), so the Claude integration links the mod and sets that flag.
const MOD_SOURCE = fileURLToPath(new URL('../mods/bullswarm', import.meta.url));
const MOD_LINK = ['.claude', 'skills', 'bullswarm-mod'];
const MOD_FLAG = 'CLAUDE_CODE_ENABLE_FUNCTION_HOOKS';
const CLAUDE_SETTINGS = ['.claude', 'settings.json'];
const MARKER_BEGIN = '<!-- bullswarm:begin v3 -->';
const MARKER_END = '<!-- bullswarm:end -->';
const MARKER_RE = /<!-- bullswarm:begin v\d+ -->[\s\S]*?<!-- bullswarm:end -->\n?/;

const AGENT_LAYOUT = {
  codex: { skill: ['.codex', 'skills', 'bullswarm'], instructions: ['.codex', 'AGENTS.md'] },
  claude: { skill: ['.claude', 'skills', 'bullswarm'], instructions: ['.claude', 'CLAUDE.md'] },
  grok: { skill: ['.grok', 'skills', 'bullswarm'], instructions: ['.grok', 'AGENTS.md'] },
  // Measured on agy 1.5.10: user-level skills load from ~/.gemini/config/skills/<name>/SKILL.md,
  // a symlinked skill folder is ignored while a real folder whose top-level entries symlink into
  // skill/ loads, and global rules load from ~/.gemini/config/AGENTS.md (agy changelog 1.2.15).
  agy: {
    skill: ['.gemini', 'config', 'skills', 'bullswarm'],
    instructions: ['.gemini', 'config', 'AGENTS.md'],
    skillShape: 'entries',
  },
};

export const INTEGRATION_AGENTS = Object.freeze(Object.keys(AGENT_LAYOUT));

export function awarenessBlock() {
  return `${MARKER_BEGIN}
## Bullswarm delegation

Read the \`bullswarm\` skill before delegating, offloading, verifying, or running autonomous multi-step work.
One bounded outcome -> \`bullswarm run\`; parallel territories, integration, or independent acceptance -> \`bullswarm workflow goal\` with a program you author.
Treat returned artifacts and verification as evidence, not authority.
Do not recurse when \`BULLSWARM_DEPTH\` is already set.
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

function binOnPath(bin, pathEnv = process.env.PATH) {
  if (!bin || typeof pathEnv !== 'string' || !pathEnv) return false;
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, bin);
    try {
      if (!lstatSync(candidate).isDirectory()) {
        accessSync(candidate, constants.X_OK);
        return true;
      }
    } catch { /* keep scanning */ }
  }
  return false;
}

function defaultIntegrationAgents({ homeDir = '', env = process.env } = {}) {
  const agents = ['codex', 'claude', 'grok'];
  const agyInstalled = binOnPath('agy', env?.PATH)
    || (Boolean(homeDir) && (
      existsSync(join(homeDir, '.gemini', 'antigravity-cli'))
      || existsSync(join(homeDir, '.gemini', 'config', 'skills', 'bullswarm'))
      || awarenessBlockPresent(join(homeDir, '.gemini', 'config', 'AGENTS.md'))
    ));
  if (agyInstalled) agents.push('agy');
  return agents;
}

export function parseIntegrationAgents(value, { defaultAgents = INTEGRATION_AGENTS } = {}) {
  if (value == null || value === true) return [...defaultAgents];
  const items = Array.isArray(value)
    ? value.map((item) => String(item).trim().toLowerCase()).filter(Boolean)
    : String(value).split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
  const expanded = items.flatMap((item) => (item === 'all' ? defaultAgents : [item]));
  const unique = [...new Set(expanded)];
  const invalid = unique.filter((agent) => !INTEGRATION_AGENTS.includes(agent));
  if (invalid.length) {
    throw new Error(`unknown integration agent(s): ${invalid.join(', ')}; use ${INTEGRATION_AGENTS.join(', ')}`);
  }
  if (!unique.length) throw new Error('--agents must name at least one agent');
  return unique;
}

export function integrationStatus({
  homeDir = process.env.HOME ?? '', agents = null, skillSource = SKILL_SOURCE,
  modSource = MOD_SOURCE, env = process.env,
} = {}) {
  const selected = parseIntegrationAgents(agents, { defaultAgents: defaultIntegrationAgents({ homeDir, env }) });
  const entries = selected.map((agent) => {
    const paths = pathsFor(homeDir, agent);
    const entry = {
      agent,
      skillPath: paths.skillPath,
      skill: skillStatusFor(agent, paths.skillPath, skillSource),
      instructionsPath: paths.instructionsPath,
      awareness: awarenessBlockPresent(paths.instructionsPath),
    };
    if (agent === 'claude') {
      entry.modPath = join(homeDir, ...MOD_LINK);
      entry.mod = skillLinkStatus(entry.modPath, modSource);
      entry.settingsPath = join(homeDir, ...CLAUDE_SETTINGS);
      entry.hooksFlag = hooksFlagPresent(entry.settingsPath);
    }
    return entry;
  });
  const legacyPath = join(homeDir, '.claude', 'skills', 'offload');
  return {
    ok: entries.every((entry) => entry.skill.status === 'installed' && entry.awareness
      && (entry.mod === undefined || (entry.mod.status === 'installed' && entry.hooksFlag))),
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
  homeDir = process.env.HOME ?? '', agents = null,
  skillSource = SKILL_SOURCE, modSource = MOD_SOURCE, approved = false, env = process.env,
} = {}) {
  if (!approved) throw new Error('integration changes global agent configuration; pass --yes to approve');
  const selected = parseIntegrationAgents(agents, { defaultAgents: defaultIntegrationAgents({ homeDir, env }) });
  if (!existsSync(join(skillSource, 'SKILL.md'))) {
    throw new Error(`packaged Bullswarm skill is missing: ${join(skillSource, 'SKILL.md')}`);
  }
  for (const agent of selected) {
    const { skillPath } = pathsFor(homeDir, agent);
    if (skillStatusFor(agent, skillPath, skillSource).status === 'conflict') {
      throw new Error(`refusing to replace non-Bullswarm skill path: ${skillPath}`);
    }
    if (agent === 'claude' && skillLinkStatus(join(homeDir, ...MOD_LINK), modSource).status === 'conflict') {
      throw new Error(`refusing to replace non-Bullswarm skill path: ${join(homeDir, ...MOD_LINK)}`);
    }
  }
  const changes = [];
  for (const agent of selected) {
    const paths = pathsFor(homeDir, agent);
    const skill = installSkillFor(agent, paths.skillPath, skillSource);
    const awareness = applyAwarenessBlock(paths.instructionsPath, { approved: true });
    const change = { agent, skill, awareness };
    if (agent === 'claude' && existsSync(join(modSource, '.claude-plugin', 'plugin.json'))) {
      change.mod = installSkillLink(join(homeDir, ...MOD_LINK), modSource);
      change.hooksFlag = setHooksFlag(join(homeDir, ...CLAUDE_SETTINGS));
    }
    changes.push(change);
  }
  return { action: 'install', changes, status: integrationStatus({ homeDir, agents: selected, skillSource, modSource, env }) };
}

export function removeIntegration({
  homeDir = process.env.HOME ?? '', agents = null,
  skillSource = SKILL_SOURCE, modSource = MOD_SOURCE, approved = false, env = process.env,
} = {}) {
  if (!approved) throw new Error('integration removal changes global agent configuration; pass --yes to approve');
  const selected = parseIntegrationAgents(agents, { defaultAgents: defaultIntegrationAgents({ homeDir, env }) });
  const changes = [];
  for (const agent of selected) {
    const paths = pathsFor(homeDir, agent);
    const skill = removeSkillFor(agent, paths.skillPath, skillSource);
    const awareness = removeAwarenessBlock(paths.instructionsPath, { approved: true });
    const change = { agent, skill, awareness };
    if (agent === 'claude') {
      change.mod = removeSkillLink(join(homeDir, ...MOD_LINK), modSource);
      change.hooksFlag = clearHooksFlag(join(homeDir, ...CLAUDE_SETTINGS));
    }
    changes.push(change);
  }
  return { action: 'remove', changes, status: integrationStatus({ homeDir, agents: selected, skillSource, modSource, env }) };
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
  try {
    if (opts.agents != null && opts.agents !== true) parseIntegrationAgents(opts.agents);
    const agents = opts.agents ?? null;
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

function endsAt(path) {
  try { return realpathSync(path); } catch { return resolve(path); }
}

function skillStatusFor(agent, skillPath, skillSource) {
  return AGENT_LAYOUT[agent]?.skillShape === 'entries'
    ? skillEntriesStatus(skillPath, skillSource)
    : skillLinkStatus(skillPath, skillSource);
}

function installSkillFor(agent, skillPath, skillSource) {
  return AGENT_LAYOUT[agent]?.skillShape === 'entries'
    ? installSkillEntries(skillPath, skillSource)
    : installSkillLink(skillPath, skillSource);
}

function removeSkillFor(agent, skillPath, skillSource) {
  return AGENT_LAYOUT[agent]?.skillShape === 'entries'
    ? removeSkillEntries(skillPath, skillSource)
    : removeSkillLink(skillPath, skillSource);
}

function skillEntries(skillSource) {
  try { return readdirSync(skillSource).filter((name) => !name.startsWith('.')).sort(); } catch { return []; }
}

function isManagedEntryLink(entryPath, expectedTarget) {
  try {
    const stat = lstatSync(entryPath);
    if (!stat.isSymbolicLink()) return false;
    const target = resolve(dirname(entryPath), readlinkSync(entryPath));
    return endsAt(target) === endsAt(expectedTarget);
  } catch {
    return false;
  }
}

function managedEntryNames(skillPath, skillSource) {
  const sourceRoot = endsAt(skillSource);
  let names;
  try { names = readdirSync(skillPath); } catch { return []; }
  return names.filter((name) => {
    const entryPath = join(skillPath, name);
    try {
      if (!lstatSync(entryPath).isSymbolicLink()) return false;
      const target = resolve(skillPath, readlinkSync(entryPath));
      return endsAt(target) === endsAt(join(skillSource, name)) || endsAt(dirname(target)) === sourceRoot;
    } catch {
      return false;
    }
  });
}

function skillEntriesStatus(skillPath, skillSource) {
  let stat;
  try { stat = lstatSync(skillPath); } catch { return { status: 'missing', path: skillPath, target: null }; }
  if (!stat.isDirectory()) return { status: 'conflict', path: skillPath, target: null };
  const expected = skillEntries(skillSource);
  const managed = managedEntryNames(skillPath, skillSource);
  if (!managed.length) return { status: 'conflict', path: skillPath, target: null };
  for (const name of expected) {
    const entryPath = join(skillPath, name);
    try {
      lstatSync(entryPath);
      if (!isManagedEntryLink(entryPath, join(skillSource, name))) {
        return { status: 'conflict', path: skillPath, target: null };
      }
    } catch { /* missing expected entry is incomplete, not conflict */ }
  }
  const complete = expected.length > 0
    && expected.every((name) => isManagedEntryLink(join(skillPath, name), join(skillSource, name)));
  return {
    status: complete ? 'installed' : 'incomplete',
    path: skillPath,
    target: skillSource,
  };
}

function installSkillEntries(skillPath, skillSource) {
  const current = skillEntriesStatus(skillPath, skillSource);
  if (current.status === 'installed') return { changed: false, ...current };
  if (current.status === 'conflict') {
    throw new Error(`refusing to replace non-Bullswarm skill path: ${skillPath}`);
  }
  mkdirSync(skillPath, { recursive: true });
  for (const name of skillEntries(skillSource)) {
    const entryPath = join(skillPath, name);
    const entryTarget = join(skillSource, name);
    if (!isManagedEntryLink(entryPath, entryTarget)) {
      const targetStat = lstatSync(entryTarget);
      symlinkSync(entryTarget, entryPath, targetStat.isDirectory() ? 'dir' : 'file');
    }
  }
  return { changed: true, status: 'installed', path: skillPath, target: skillSource };
}

function removeSkillEntries(skillPath, skillSource) {
  const current = skillEntriesStatus(skillPath, skillSource);
  if (current.status === 'missing') return { changed: false, ...current };
  let managed = [];
  try {
    if (lstatSync(skillPath).isDirectory()) managed = managedEntryNames(skillPath, skillSource);
  } catch { managed = []; }
  if (!managed.length) {
    return { changed: false, status: 'conflict', path: skillPath, target: null, reason: 'left conflict untouched' };
  }
  for (const name of managed) unlinkSync(join(skillPath, name));
  if (readdirSync(skillPath).length === 0) rmdirSync(skillPath);
  return {
    changed: true,
    status: existsSync(skillPath) ? 'conflict' : 'missing',
    path: skillPath,
    target: skillSource,
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
  // A link may reach the packaged skill through another link (an `npm link`ed
  // global install, for example). What matters is where the chain ends, so
  // compare real paths; a dangling chain keeps its first hop for the report.
  return {
    status: endsAt(target) === endsAt(skillSource) ? 'installed' : 'conflict',
    path: skillPath,
    target,
  };
}

function readOptional(filePath) {
  try { return readFileSync(filePath, 'utf8'); } catch { return ''; }
}

// ~/.claude/settings.json is the person's file: read it as JSON, touch only
// the one env key, and leave a file that is not an object alone.
function readSettings(settingsPath) {
  const text = readOptional(settingsPath);
  if (!text.trim()) return { settings: {}, writable: true };
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? { settings: parsed, writable: true }
      : { settings: null, writable: false };
  } catch {
    return { settings: null, writable: false };
  }
}

export function hooksFlagPresent(settingsPath) {
  const { settings } = readSettings(settingsPath);
  const value = settings?.env?.[MOD_FLAG];
  return value === '1' || value === 1 || value === true || value === 'true';
}

function setHooksFlag(settingsPath) {
  if (hooksFlagPresent(settingsPath)) return { changed: false, reason: 'already set', path: settingsPath };
  const { settings, writable } = readSettings(settingsPath);
  if (!writable) return { changed: false, reason: 'settings.json is not a JSON object; set env.' + MOD_FLAG + ' to "1" yourself', path: settingsPath };
  const env = settings.env && typeof settings.env === 'object' && !Array.isArray(settings.env) ? settings.env : {};
  const next = { ...settings, env: { ...env, [MOD_FLAG]: '1' } };
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(next, null, 2)}\n`);
  return { changed: true, reason: 'set', path: settingsPath };
}

function clearHooksFlag(settingsPath) {
  if (!hooksFlagPresent(settingsPath)) return { changed: false, reason: 'not set', path: settingsPath };
  const { settings, writable } = readSettings(settingsPath);
  if (!writable) return { changed: false, reason: 'settings.json is not a JSON object', path: settingsPath };
  const env = { ...settings.env };
  delete env[MOD_FLAG];
  const next = { ...settings };
  if (Object.keys(env).length) next.env = env; else delete next.env;
  writeFileSync(settingsPath, `${JSON.stringify(next, null, 2)}\n`);
  return { changed: true, reason: 'cleared', path: settingsPath };
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
    const mod = entry.mod
      ? `; mod ${entry.mod.status === 'installed' ? '✓' : entry.mod.status}; function hooks ${entry.hooksFlag ? '✓' : 'flag missing'}`
      : '';
    console.log(`${entry.agent.padEnd(8)} ${skill}; ${awareness}${mod}`);
  }
  if (status.legacyOffload?.detected) {
    console.log(`⚠ retired Claude offload skill detected: ${status.legacyOffload.path}`);
    console.log(`  recoverably archive it with: ${status.legacyOffload.action}`);
  }
}
