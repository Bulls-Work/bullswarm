// bullswarm integrate — make the published agent guide discoverable by coding CLIs.
//
// Integration is explicit, idempotent, and reversible. The full operating
// procedure remains in skill/SKILL.md; global instruction files receive only a
// compact trigger policy so CLI documentation cannot drift in three places.

import {
  existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync,
  symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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

const AGENT_LAYOUT = {
  codex: { skill: ['.codex', 'skills', 'bullswarm'], instructions: ['.codex', 'AGENTS.md'] },
  claude: { skill: ['.claude', 'skills', 'bullswarm'], instructions: ['.claude', 'CLAUDE.md'] },
  grok: { skill: ['.grok', 'skills', 'bullswarm'], instructions: ['.grok', 'AGENTS.md'] },
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

// The file is the person's own text, so no byte of it is ever changed except
// the Bullswarm block itself. The file is read and written as latin1, which
// round-trips every byte (a BOM and non-UTF-8 text included); the markers are
// ASCII. Nothing is trimmed anywhere.
//
// A marker counts only when it is the whole line: the marker text, optional
// trailing spaces or tabs, then the line break (or the end of the file). A
// marker sharing a line with other text is user text and is left alone. Lines
// between a closed pair of code fences (``` or ~~~, up to 3 leading spaces,
// closed by a line starting with the same character at least as many times)
// are user text too; a fence that never closes is not a fence, so a block
// appended after it is still found next time. A begin or end marker with no
// partner changes nothing.
//
// Install on a file with no block appends: the file's own bytes, a line break
// if it does not end in one, one blank line, the block, a line break. Remove
// deletes exactly the block's lines and the one blank line before it when
// present. So install then remove returns the original bytes when the file
// ended in a line break, and the original plus one line break when it did not.
// A bare-CR file (old Mac) is one long line: it gets "\n" appended and its
// existing bytes are never altered.
const BEGIN_LINE_RE = /^<!-- bullswarm:begin v(\d+) -->[ \t]*$/;
const END_LINE_RE = /^<!-- bullswarm:end -->[ \t]*$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const BOM = 'ï»¿';
const CURRENT_VERSION = Number(/v(\d+)/.exec(MARKER_BEGIN)[1]);

export function applyAwarenessBlock(filePath, { approved }) {
  if (!approved) return { changed: false, reason: 'not approved' };
  const read = readExisting(filePath);
  if (read.problem) return read.problem;
  const existing = read.text;
  const parsed = parseBlocks(existing);
  if (parsed.stray) return malformed(filePath, parsed.stray);
  if (parsed.blocks.some((block) => block.version > CURRENT_VERSION)) {
    return { changed: false, reason: 'newer', path: filePath };
  }
  const eol = lineEnding(existing);
  const block = awarenessBlock().replace(/\n/g, eol);
  let next;
  if (!parsed.blocks.length) {
    const close = existing && !existing.endsWith('\n') ? eol : '';
    next = `${existing}${close}${existing ? eol : ''}${block}${eol}`;
  } else {
    const [first, ...rest] = parsed.blocks;
    next = `${existing.slice(0, first.start)}${block}${first.eol || eol}${cutSpans(existing.slice(first.end), rest, first.end)}`;
  }
  if (next === existing) return { changed: false, reason: 'already current' };
  const written = writeText(filePath, next);
  if (written) return written;
  return {
    changed: true,
    reason: parsed.blocks.length ? 'updated' : 'installed',
    ...(parsed.blocks.length > 1 ? { removedExtra: parsed.blocks.length - 1 } : {}),
  };
}

export function removeAwarenessBlock(filePath, { approved }) {
  if (!approved) return { changed: false, reason: 'not approved' };
  const read = readExisting(filePath);
  if (read.problem) return read.problem;
  const parsed = parseBlocks(read.text);
  if (parsed.stray) return malformed(filePath, parsed.stray);
  if (!parsed.blocks.length) return { changed: false, reason: 'not installed' };
  const written = writeText(filePath, cutSpans(read.text, parsed.blocks, 0));
  if (written) return written;
  return { changed: true, reason: 'removed', removedBlocks: parsed.blocks.length };
}

function splitLines(text) {
  const lines = [];
  let start = 0;
  while (start < text.length) {
    const nl = text.indexOf('\n', start);
    const next = nl === -1 ? text.length : nl + 1;
    const raw = text.slice(start, nl === -1 ? next : nl);
    lines.push({ start, next, eol: nl === -1 ? '' : (raw.endsWith('\r') ? '\r\n' : '\n'), content: raw.endsWith('\r') ? raw.slice(0, -1) : raw });
    start = next;
  }
  return lines;
}

function fencedLines(lines) {
  const fenced = new Array(lines.length).fill(false);
  let open = null;
  lines.forEach((line, index) => {
    const match = FENCE_RE.exec(line.content);
    if (!open) {
      if (match) open = { index, char: match[1][0], size: match[1].length };
    } else if (match && match[1][0] === open.char && match[1].length >= open.size) {
      for (let i = open.index; i <= index; i += 1) fenced[i] = true;
      open = null;
    }
  });
  return fenced;
}

// Complete blocks (begin ... end), each with `cut`, the start of the blank line
// before it when there is one: the span that remove deletes.
function parseBlocks(text) {
  const lines = splitLines(text);
  const fenced = fencedLines(lines);
  const blocks = [];
  let open = null;
  let floor = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (fenced[index]) continue;
    const line = lines[index];
    const content = index === 0 && line.content.startsWith(BOM) ? line.content.slice(BOM.length) : line.content;
    const offset = line.content.length - content.length;
    const begin = BEGIN_LINE_RE.exec(content);
    if (begin) {
      if (open) return { blocks, stray: `begin marker at line ${open.line} has no end marker` };
      open = { index, line: index + 1, start: line.start + offset, version: Number(begin[1]) };
    } else if (END_LINE_RE.test(content)) {
      if (!open) return { blocks, stray: `end marker at line ${index + 1} has no begin marker` };
      const before = lines[open.index - 1];
      const blank = before && open.index - 1 >= floor && before.content === '' && before.eol ? before.start : open.start;
      blocks.push({ start: open.start, cut: blank, end: line.next, eol: line.eol, version: open.version });
      floor = index + 1;
      open = null;
    }
  }
  if (open) return { blocks, stray: `begin marker at line ${open.line} has no end marker` };
  return { blocks, stray: null };
}

// Cut each block (and its blank line before) out of text, which starts at
// `base` in the file the blocks were parsed from. Nothing else is touched.
function cutSpans(text, blocks, base) {
  let out = '';
  let cursor = 0;
  for (const block of blocks) {
    out += text.slice(cursor, block.cut - base);
    cursor = block.end - base;
  }
  return out + text.slice(cursor);
}

function lineEnding(text) {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  return crlf > lf ? '\r\n' : '\n';
}

function malformed(filePath, detail) {
  return { changed: false, reason: 'malformed', detail, path: filePath };
}

// Only a missing file reads as empty; any other failure leaves the file alone.
function readExisting(filePath) {
  try { return { text: readFileSync(filePath).toString('latin1') }; } catch (error) {
    if (error?.code === 'ENOENT') return { text: '' };
    return { problem: { changed: false, reason: 'unreadable', detail: error?.message ?? String(error), path: filePath } };
  }
}

function writeText(filePath, text) {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, Buffer.from(text, 'latin1'));
    return null;
  } catch (error) {
    return { changed: false, reason: 'unwritable', detail: error?.message ?? String(error), path: filePath };
  }
}

// What `integrate status` shows for an instruction file, read the way apply
// reads it: present, missing, or a problem named as such (unreadable,
// malformed) instead of a plain "missing".
export function awarenessState(filePath) {
  const read = readExisting(filePath);
  if (read.problem) return { present: false, problem: { reason: read.problem.reason, detail: read.problem.detail } };
  const parsed = parseBlocks(read.text);
  if (parsed.stray) return { present: false, problem: { reason: 'malformed', detail: parsed.stray } };
  return { present: parsed.blocks.length > 0, problem: null };
}

export function awarenessBlockPresent(filePath) {
  return awarenessState(filePath).present;
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
  modSource = MOD_SOURCE,
} = {}) {
  const selected = parseIntegrationAgents(agents);
  const entries = selected.map((agent) => {
    const paths = pathsFor(homeDir, agent);
    const state = awarenessState(paths.instructionsPath);
    const entry = {
      agent,
      skillPath: paths.skillPath,
      skill: skillLinkStatus(paths.skillPath, skillSource),
      instructionsPath: paths.instructionsPath,
      awareness: state.present,
      ...(state.problem ? { awarenessProblem: state.problem } : {}),
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
  homeDir = process.env.HOME ?? '', agents = INTEGRATION_AGENTS,
  skillSource = SKILL_SOURCE, modSource = MOD_SOURCE, approved = false,
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
    if (agent === 'claude' && skillLinkStatus(join(homeDir, ...MOD_LINK), modSource).status === 'conflict') {
      throw new Error(`refusing to replace non-Bullswarm skill path: ${join(homeDir, ...MOD_LINK)}`);
    }
  }
  const changes = [];
  for (const agent of selected) {
    const paths = pathsFor(homeDir, agent);
    const skill = installSkillLink(paths.skillPath, skillSource);
    const awareness = applyAwarenessBlock(paths.instructionsPath, { approved: true });
    const change = { agent, skill, awareness };
    if (agent === 'claude' && existsSync(join(modSource, '.claude-plugin', 'plugin.json'))) {
      change.mod = installSkillLink(join(homeDir, ...MOD_LINK), modSource);
      change.hooksFlag = setHooksFlag(join(homeDir, ...CLAUDE_SETTINGS));
    }
    changes.push(change);
  }
  return { action: 'install', changes, status: integrationStatus({ homeDir, agents: selected, skillSource, modSource }) };
}

export function removeIntegration({
  homeDir = process.env.HOME ?? '', agents = INTEGRATION_AGENTS,
  skillSource = SKILL_SOURCE, modSource = MOD_SOURCE, approved = false,
} = {}) {
  if (!approved) throw new Error('integration removal changes global agent configuration; pass --yes to approve');
  const selected = parseIntegrationAgents(agents);
  const changes = [];
  for (const agent of selected) {
    const paths = pathsFor(homeDir, agent);
    const skill = removeSkillLink(paths.skillPath, skillSource);
    const awareness = removeAwarenessBlock(paths.instructionsPath, { approved: true });
    const change = { agent, skill, awareness };
    if (agent === 'claude') {
      change.mod = removeSkillLink(join(homeDir, ...MOD_LINK), modSource);
      change.hooksFlag = clearHooksFlag(join(homeDir, ...CLAUDE_SETTINGS));
    }
    changes.push(change);
  }
  return { action: 'remove', changes, status: integrationStatus({ homeDir, agents: selected, skillSource, modSource }) };
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
    const blocked = reportBlockProblems(result);
    const ok = result.status?.ok ?? result.ok;
    return blocked || (ok === false && subcommand === 'status') ? 1 : 0;
  } catch (error) {
    console.error(`✗ ${error.message}`);
    return 1;
  }
}

// An instruction file the edit would not touch is a failed install or remove:
// say which file, which line and how to fix it, and let the command exit 1 like
// its other failures. A newer block is left on purpose, so it only warns.
function reportBlockProblems(result) {
  let failed = false;
  for (const change of result.changes ?? []) {
    const a = change.awareness;
    if (!a || a.changed) continue;
    if (a.reason === 'malformed') {
      failed = true;
      console.error(`⚠ ${a.path}: left unchanged; ${a.detail}. Delete or complete that marker by hand (a block is <!-- bullswarm:begin vN --> ... <!-- bullswarm:end -->), then run the command again.`);
    } else if (a.reason === 'unreadable' || a.reason === 'unwritable') {
      failed = true;
      console.error(`⚠ ${a.path}: left unchanged; ${a.reason} (${a.detail}). Fix its permissions or type, then run the command again.`);
    } else if (a.reason === 'newer') {
      console.error(`⚠ ${a.path}: holds a Bullswarm block from a newer version; left as is. Update bullswarm, or run 'bullswarm integrate remove --yes' to drop it.`);
    }
  }
  return failed;
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
  // A link may reach the packaged skill through another link (an `npm link`ed
  // global install, for example). What matters is where the chain ends, so
  // compare real paths; a dangling chain keeps its first hop for the report.
  const endsAt = (path) => { try { return realpathSync(path); } catch { return resolve(path); } };
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
    const awareness = entry.awareness ? 'awareness ✓'
      : entry.awarenessProblem ? `awareness ${entry.awarenessProblem.reason} (${entry.awarenessProblem.detail}; ${entry.instructionsPath})`
        : 'awareness missing';
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
