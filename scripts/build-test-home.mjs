#!/usr/bin/env node
// Build the scrubbed real-data test home, tests/fixtures/home-351/, from a
// copied Bullswarm home.
//
//   node scripts/build-test-home.mjs <snapshot> <dest>
//
// The real-data tests and scripts/render-tidy-0.35.1-frames.mjs read fifteen
// real workflow runs and four single tasks. The repository is public, so the
// fixture keeps every number those readers pin and none of the words anyone
// wrote. The scrub rule:
//
//   - Kept as recorded: every run id, shortId, action and attempt id,
//     timestamp, duration, status, pool, model, effort, token and byte count,
//     cost, price, count and event kind, and every sentence the kernel itself
//     composes (route reasons, basis codes, `verified`, phase labels).
//   - Replaced: everything a person or an agent wrote — goals, purposes,
//     prompts, requirement text, evidence and concerns, task and out
//     markdown, report and response text, turn summaries, command lines,
//     revision summaries — with plainly marked placeholder text
//     (`sample goal for g6d6q2 lorem ipsum …`) of the same shape: the same
//     line count, list markers, headings and indentation, each line the same
//     length (JSON prose lines longer than LINE_CAP, 200 characters, are cut;
//     markdown files keep every line's byte length, so a report's size reads
//     the same).
//   - Every absolute path becomes /home/dev/<alias>/…, every project name its
//     alias (project-a, project-b, …), every repository-relative file path in
//     a change list an alias (src/dir-03/file-012.js), and the user name `dev`.
//
// Placeholder words come from a fixed vocabulary drawn by a PRNG seeded from
// the order text is met in (never from the text itself, so a placeholder
// cannot be traced back to what it replaced). The same line always gets the
// same placeholder, so a goal reads the same in state.json, result.json,
// events.jsonl and the history index. Same snapshot in, byte-identical
// fixture out: no clock, no Math.random, files walked in sorted order.
//
// Only the files a reader opens are copied (MANIFEST, traced by running the
// suite and the frame script with every fs read logged) — no workspaces/, no
// stdout logs, no meters. The script refuses to finish if any copied byte
// still names the owner, a private project, a checkout folder or an owner
// home path — words it learns from the snapshot, so none is written here.

import {
  existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The widest frame is 200 columns: a JSON prose line longer than that is cut to
// it, so every row a page prints is still filled, and the fixture stays small.
const LINE_CAP = 200;
// Content shorter than this is generated afresh at each occurrence, so short
// words (a streamed chunk such as " read") never map one-to-one.
const MEMO_MIN = 12;

// ── manifest ────────────────────────────────────────────────────────────────
// A file is copied when a reader opens it and its content reaches what a test
// or a frame shows. Traced by running the suite and the frame script with every
// fs call logged, then proved one file at a time: remove it, rerender every
// frame, rerun the snapshot tests; if nothing changed it is not copied. That
// leaves out every events.jsonl (the pages read the run from state.json), the
// result envelopes of five runs, the streams of attempts no Step page opens
// and the task prompts the Step page takes from the program instead. The
// single tasks' own task files stay: the task tests render them.
const HOME_FILES = ['state.json', 'routing.json', 'providers.json', 'history/runs.jsonl'];
const SINGLE_TASKS = ['1789818968543-gqkmn', '1789819008033-et5de', '1789820310564-40z08', '1789855478392-pvtzl'];
const RUN_FILES = {
  'wf-mu5ul9j7-4a3a73': ['state.json'],
  'wf-mu6db6m7-bee921': ['state.json'],
  'wf-mu6h8obw-baa03e': ['state.json', 'result.json'],
  'wf-mu6k5u8q-2b319f': ['state.json'],
  'wf-mu6k6z07-97ed34': ['state.json', 'result.json'],
  'wf-mu6k9wk0-97bc29': ['state.json', 'result.json'],
  'wf-mu6mv62z-cdcd5d': [
    'state.json', 'result.json', 'diff-accept-attempt-1.txt', 'stream-accept-attempt-5.jsonl',
    ...[1, 2, 4, 5].map((n) => `out-accept-attempt-${n}.json`),
  ],
  'wf-mu6u396i-856360': ['state.json', 'result.json'],
  'wf-mu7873tx-3b973b': ['state.json', 'result.json', 'out-integrate-attempt-1.md', 'out-integrate-attempt-2.md'],
  'wf-mu8j2hjn-58b8ec': [
    'state.json', 'result.json', 'diff-verify-attempt-1.txt', 'stream-verify-attempt-1.jsonl',
    ...[1, 2, 3].map((n) => `out-verify-attempt-${n}.json`),
  ],
  'wf-mu8jg6cd-9d7b33': ['state.json'],
  'wf-mu8ni8o4-f9baaf': [
    'state.json', 'result.json',
    ...['step-model', 'step-view', 'verify'].map((id) => `diff-${id}-attempt-1.txt`),
    ...['step-model', 'step-view'].flatMap((id) => [`task-${id}-attempt-1.md`, `stream-${id}-attempt-1.jsonl`]),
    'out-step-model-attempt-1.md', 'out-verify-attempt-1.json',
  ],
  'wf-mu8radyf-bb49cc': ['state.json'],
  'wf-mu8thu2e-27c504': [
    'state.json', 'result.json',
    ...['integrate', 'verify'].flatMap((id) => [`diff-${id}-attempt-1.txt`, `stream-${id}-attempt-1.jsonl`]),
    'out-integrate-attempt-1.md', 'out-verify-attempt-1.json',
  ],
  'wf-mu8vxemr-38a46a': ['state.json', 'result.json'],
};

export function manifest(snapshot) {
  const runs = readdirSync(join(snapshot, 'workflows')).filter((name) => name.startsWith('wf-')).sort();
  const unknown = runs.filter((run) => !RUN_FILES[run]);
  if (unknown.length) throw new Error(`no manifest entry for ${unknown.join(', ')}`);
  const files = [
    ...HOME_FILES,
    ...SINGLE_TASKS.flatMap((id) => [`runs/task-${id}.md`, `runs/out-${id}.md`]),
    ...runs.flatMap((run) => RUN_FILES[run].map((name) => `workflows/${run}/${name}`)),
  ];
  return [...new Set(files)].sort();
}

// ── deterministic words ─────────────────────────────────────────────────────
const LOREM = (
  'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor '
  + 'incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud '
  + 'exercitation ullamco laboris nisi aliquip ex ea commodo consequat duis aute irure '
  + 'in reprehenderit voluptate velit esse cillum fugiat nulla pariatur excepteur sint '
  + 'occaecat cupidatat non proident sunt culpa qui officia deserunt mollit anim id est laborum'
).split(' ');

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BY_LENGTH = new Map();
for (const word of LOREM) BY_LENGTH.set(word.length, [...(BY_LENGTH.get(word.length) ?? []), word]);

/** Exactly `length` characters of whole words: the marker first, then lorem. */
function words(length, marker, rng) {
  if (length <= 0) return '';
  const pick = (list) => list[Math.floor(rng() * list.length)];
  const parts = marker && marker.length + 3 <= length ? [marker] : [];
  let used = parts.length ? marker.length : 0;
  for (;;) {
    const room = length - used - (parts.length ? 1 : 0);
    if (room <= 0) break;
    const exact = BY_LENGTH.get(room);
    if (exact && (room <= 12 || rng() < 0.25)) { parts.push(pick(exact)); break; }
    // Leave room for one more word of at least two letters after this one.
    const fits = LOREM.filter((word) => word.length <= room - 3);
    if (!fits.length) { parts.push(pick(LOREM.filter((word) => word.length >= room)).slice(0, room)); break; }
    const word = pick(fits);
    parts.push(word);
    used += word.length + (parts.length > 1 ? 1 : 0);
  }
  const text = parts.join(' ');
  if (text.length !== length) throw new Error(`placeholder length ${text.length} != ${length}`);
  return text;
}

// ── aliases ─────────────────────────────────────────────────────────────────
const OWNER_HOME = /^\/Users\/[^/]+/;
const TOP_LEVEL_DIRS = new Set(['src', 'tests', 'test', 'docs', 'scripts', 'bin', 'lib', 'packages', 'apps', 'fixtures', 'data', 'mcp', 'mods', 'providers', 'skill', 'connectors']);

/**
 * The scrub rule as one object: aliases learned from the snapshot, a memo of
 * placeholder lines, and one handler per file shape. Exported so the other
 * committed real-capture fixtures are scrubbed by the same code.
 */
export class Scrubber {
  constructor(snapshot, { lineCap = LINE_CAP, keepKeys = [] } = {}) {
    this.snapshot = snapshot;
    this.lineCap = lineCap;
    // Keys whose strings a provider or the kernel wrote (log event names).
    this.keepKeys = new Set(keepKeys);
    this.counter = 0;
    this.lines = new Map();
    this.projects = new Map();
    this.roots = new Map();
    this.dirs = new Map();
    this.paths = new Map();
    this.shortIds = new Map();
    // Every line of a markdown artifact. The same line in a JSON record (the
    // streamed final response, an attempt's lastResponse) is measured the way
    // the file is, so a report and the turn that carried it stay equal.
    this.fileLines = new Set();
    this.#learnProjects();
  }

  learnFileLines(texts) {
    for (const text of texts) for (const line of text.split('\n')) this.fileLines.add(line);
  }

  rng() {
    this.counter += 1;
    return mulberry32(0x9E3779B1 ^ Math.imul(this.counter, 0x85EBCA77));
  }

  // Project names and their checkouts, learned from the records that name
  // both, in the order the history index lists them.
  #learnProjects() {
    const pairs = [];
    const history = readFileSync(join(this.snapshot, 'history', 'runs.jsonl'), 'utf8');
    for (const line of history.split('\n').filter(Boolean)) {
      const row = JSON.parse(line);
      pairs.push([row.project, row.cwd]);
      if (row.runId && row.shortId) this.shortIds.set(row.runId, row.shortId);
    }
    const state = JSON.parse(readFileSync(join(this.snapshot, 'state.json'), 'utf8'));
    for (const entry of state.decisionLog ?? []) pairs.push([entry.project, entry.cwd]);
    for (const run of readdirSync(join(this.snapshot, 'workflows')).sort()) {
      const path = join(this.snapshot, 'workflows', run, 'state.json');
      if (!existsSync(path)) continue;
      const runState = JSON.parse(readFileSync(path, 'utf8'));
      for (const attempt of runState.attempts ?? []) pairs.push([attempt.project, attempt.cwd]);
    }
    for (const [project] of pairs) this.projectAlias(project);
    for (const [project, cwd] of pairs) {
      if (typeof cwd === 'string' && cwd && !this.roots.has(cwd)) {
        this.roots.set(cwd, project ? this.projectAlias(project) : this.projectAlias(cwd.split('/').at(-1)));
      }
    }
  }

  /** A checkout the snapshot does not name, aliased under `project`. */
  addRoot(path, project) {
    if (!this.roots.has(path)) this.roots.set(path, this.projectAlias(project));
    return this.roots.get(path);
  }

  projectAlias(name) {
    if (typeof name !== 'string' || !name) return name;
    if (!this.projects.has(name)) {
      this.projects.set(name, `project-${String.fromCharCode(97 + this.projects.size)}`);
    }
    return this.projects.get(name);
  }

  /** A repository-relative path in a change list: same extension, aliased names. */
  changePath(path) {
    if (typeof path !== 'string' || !path) return path;
    if (this.paths.has(path)) return this.paths.get(path);
    const parts = path.split('/');
    const base = parts.pop();
    const dot = base.indexOf('.', 1);
    const ext = dot > 0 ? base.slice(dot) : '';
    const top = parts.length && TOP_LEVEL_DIRS.has(parts[0]) ? parts.shift() : null;
    let dir = null;
    if (parts.length) {
      const key = parts.join('/');
      if (!this.dirs.has(key)) this.dirs.set(key, `dir-${String(this.dirs.size + 1).padStart(2, '0')}`);
      dir = this.dirs.get(key);
    }
    const alias = [top, dir, `file-${String(this.paths.size + 1).padStart(3, '0')}${ext}`].filter(Boolean).join('/');
    this.paths.set(path, alias);
    return alias;
  }

  /** Every absolute path under the owner's home becomes /home/dev/<alias>/…. */
  absolutePath(path) {
    if (typeof path !== 'string' || !OWNER_HOME.test(path)) return path;
    const roots = [...this.roots.keys()].sort((a, b) => b.length - a.length);
    const root = roots.find((candidate) => path === candidate || path.startsWith(`${candidate}/`));
    if (root) {
      const rest = path.slice(root.length).replace(/^\//, '');
      return `/home/dev/${this.roots.get(root)}${rest ? `/${this.changePath(rest)}` : ''}`;
    }
    const home = path.match(OWNER_HOME)[0];
    const rest = path.slice(home.length).replace(/^\//, '');
    const [first, ...tail] = rest.split('/');
    // The Bullswarm home and the agent CLIs' own homes keep their names.
    if (['.bullswarm', '.codex', '.grok'].includes(first)) return `/home/dev/${first}${tail.length ? `/${tail.join('/')}` : ''}`;
    throw new Error(`no alias for path ${path}`);
  }

  // ── prose ──
  /** One line's markdown frame kept, its words replaced to `target` length. */
  line(text, { kind, context, first, measure, cap, memo }) {
    if (this.fileLines.has(text)) { measure = 'bytes'; cap = null; memo = true; }
    const size = (value) => (measure === 'bytes' ? Buffer.byteLength(value, 'utf8') : [...value].length);
    if (!text.trim()) return text;
    if (/^\s*(```[\w-]*|---+|\*\*\*+|===+)\s*$/.test(text)) return text;
    if (/^\s*\|.*\|\s*$/.test(text)) {
      // A table row keeps its pipes; each cell keeps its width.
      return text.split('|').map((cell) => (/^[\s:-]*$/.test(cell)
        ? cell
        : cell.replace(/^(\s*)(.*?)(\s*)$/, (_, lead, body, trail) => `${lead}${this.#fill(body, size(body), { kind, context, first: false, memo })}${trail}`)))
        .join('|');
    }
    const match = text.match(/^(\s*(?:#{1,6} |> |[-*+] \[[ xX]\] |[-*+] |\d+[.)] )?)(.*?)([.:!?]?)(\s*)$/s);
    const [, prefix, body, stop, trail] = match;
    let target = size(text) - size(prefix) - size(stop) - size(trail);
    if (cap) target = Math.max(0, Math.min(target, cap - [...prefix].length - stop.length));
    return `${prefix}${this.#fill(body, target, { kind, context, first, memo })}${stop}${trail}`;
  }

  #fill(body, target, { kind, context, first, memo }) {
    if (target <= 0) return '';
    // The longest marker that leaves room for a word: `sample goal for g6d6q2`,
    // then `sample goal`, then `sample`.
    const markers = first ? [context ? `sample ${kind} for ${context}` : null, `sample ${kind}`, 'sample'] : ['sample'];
    const marker = markers.find((candidate) => candidate && candidate.length + 3 <= target) ?? null;
    if (!memo && [...body].length < MEMO_MIN) return words(target, target >= 12 ? marker : null, this.rng());
    // The same words at the same length always get the same placeholder.
    const key = `${target}\u0000${body}`;
    if (!this.lines.has(key)) this.lines.set(key, words(target, marker, this.rng()));
    return this.lines.get(key);
  }

  /** A block of prose: same line count, each line's frame and length kept. */
  prose(text, { kind, context = null, measure = 'chars', cap = this.lineCap } = {}) {
    if (typeof text !== 'string' || !text) return text;
    const lines = text.split('\n');
    // A short line inside a block is memoised like a long one, so the block
    // reads the same wherever it is quoted; a lone short string (a streamed
    // word) is drawn afresh each time.
    return lines.map((line, index) => this.line(line, {
      kind, context, first: index === 0, measure, cap: measure === 'chars' ? cap : null, memo: lines.length > 1,
    })).join('\n');
  }

  // ── JSON ──
  value(value, key, parent, ctx) {
    if (Array.isArray(value)) return value.map((item) => this.value(item, key, parent, ctx));
    if (value && typeof value === 'object') {
      const next = { ...ctx };
      if (typeof value.shortId === 'string') next.run = value.shortId;
      if (typeof value.id === 'string' && /^(requirement-\d+|[\w-]+-\d+)$/.test(value.id)) next.item = value.id;
      if (typeof value.actionId === 'string') next.item = value.attemptId ?? value.actionId;
      const out = {};
      for (const [childKey, child] of Object.entries(value)) {
        const outKey = this.projects.has(childKey) ? this.projects.get(childKey) : childKey;
        out[outKey] = this.value(child, childKey, value, next);
      }
      return out;
    }
    if (typeof value !== 'string') return value;
    return this.string(value, key, parent, ctx);
  }

  string(value, key, parent, ctx) {
    const context = ctx.item ?? ctx.run ?? null;
    const prose = (kind) => this.prose(value, { kind, context });
    if (this.keepKeys.has(key)) return value;
    switch (key) {
      case 'project':
      case 'projectName':
        return this.projectAlias(value);
      case 'ownedFiles':
      case 'changedFiles':
      case 'baselineChangedFiles':
        return this.changePath(value);
      case 'goal': return prose('goal');
      case 'prompt': return prose('prompt');
      case 'purpose': return prose('purpose');
      case 'text': return prose(/^requirement-\d+$/.test(parent?.id ?? '') ? 'requirement' : 'text');
      case 'evidence': return prose('evidence');
      case 'concerns': return prose('concern');
      case 'lastResponse':
      case 'lastSaid': return prose('response');
      case 'summary':
        if (key === 'summary' && parent && 'providerType' in parent && parent.kind !== 'response') return prose('command');
        if (/^\d+ requirements? remains? unresolved: [\w=, -]+$/.test(value)) return value;
        return prose(parent && 'providerType' in parent ? 'response' : 'summary');
      case 'why': {
        // `usage limit: "<provider's words>" · pool paused until …`: the frame
        // is the kernel's, the quote is the provider's and is replaced.
        const quota = value.match(/^(usage limit: ")([^"]*)(" · pool paused until [\dT:.Z-]+)$/);
        if (quota) return `${quota[1]}${this.prose(quota[2], { kind: 'note' })}${quota[3]}`;
        return KERNEL_WHY.some((pattern) => pattern.test(value)) ? value : prose('note');
      }
      case 'reason': return this.reason(value, parent, context);
      case 'warnings': return this.warning(value);
      case 'label': return /^Phase \d+ · [\w -]+$/.test(value) ? value : prose('text');
      case 'routeWhy':
      case 'kind':
      case 'basis':
        return value;
      default:
        break;
    }
    if (OWNER_HOME.test(value) && !/\s/.test(value)) return this.absolutePath(value);
    // Everything else with a space in it is somebody's words until proven
    // otherwise; identifiers, codes, timestamps and URLs carry no spaces.
    return /\s/.test(value) ? prose('text') : value;
  }

  reason(value, parent, context) {
    // The route sentence the kernel composes from meter numbers.
    if (parent && ('candidates' in parent || 'routeCandidates' in parent || 'effort' in parent)) return value;
    if (ROUTE_REASON.test(value)) return value;
    if (!/\s/.test(value)) return value;
    // `all N steps succeeded, but not verified: requirement-7 failed — requirement-7: <evidence>`
    const verdict = value.match(/^(all \d+ steps? succeeded[^—]*?)( — )(.*)$/s);
    if (verdict) {
      const tail = verdict[3].split(/(?=\brequirement-\d+: )/).map((part) => {
        const labelled = part.match(/^(requirement-\d+: )(.*)$/s);
        return labelled ? `${labelled[1]}${this.prose(labelled[2], { kind: 'evidence', context: labelled[1].slice(0, -2) })}` : this.prose(part, { kind: 'evidence' });
      }).join('');
      return `${verdict[1]}${verdict[2]}${tail}`;
    }
    if (/^all \d+ steps? succeeded[\w ,]*$/.test(value)) return value;
    if (/^all program actions finished successfully; consult evidence /.test(value)) return value;
    return this.prose(value, { kind: 'note', context });
  }

  warning(value) {
    const match = value.match(/^(Workspace changes outside declared territories: )(.*)$/);
    if (!match) return this.prose(value, { kind: 'note' });
    return `${match[1]}${match[2].split(', ').map((path) => this.changePath(path)).join(', ')}`;
  }

  // ── files ──
  json(text, relative) {
    const ctx = { run: this.runOf(relative) };
    return `${JSON.stringify(this.value(JSON.parse(text), null, null, ctx))}${text.endsWith('\n') ? '\n' : ''}`;
  }

  jsonl(text, relative) {
    const stream = relative.match(/stream-(.+)-attempt-(\d+)\.jsonl$/);
    const ctx = { run: this.runOf(relative), item: stream ? `${stream[1]}-${stream[2]}` : undefined };
    return text.split('\n').map((line) => (line.trim()
      ? JSON.stringify(this.value(JSON.parse(line), null, null, ctx))
      : line)).join('\n');
  }

  markdown(text, relative) {
    const name = relative.split('/').at(-1);
    const kind = name.startsWith('task-') ? 'task' : 'report';
    const attempt = name.match(/^(?:task|out)-(.+)-attempt-(\d+)\./);
    const context = attempt ? `${attempt[1]}-${attempt[2]}` : this.runOf(relative);
    return this.prose(text, { kind, context, measure: 'bytes' });
  }

  diff(text) {
    return text.split('\n').map((line) => {
      if (!line.trim() || /^\s*\d+ files? changed/.test(line)) return line;
      const stat = line.match(/^(\s*)(\S+)(\s+\|\s+.*)$/);
      return stat ? `${stat[1]}${this.changePath(stat[2])}${stat[3]}` : this.prose(line, { kind: 'diff', measure: 'bytes' });
    }).join('\n');
  }

  runOf(relative) {
    const run = relative.match(/workflows\/(wf-[^/]+)\//)?.[1];
    return run ? this.shortIds.get(run) ?? run : null;
  }

  file(relative) {
    const text = readFileSync(join(this.snapshot, relative), 'utf8');
    if (relative === 'state.json') return this.homeState(text);
    if (relative.endsWith('.jsonl')) return this.jsonl(text, relative);
    if (/\/diff-[^/]+\.txt$/.test(relative)) return this.diff(text);
    if (relative.endsWith('.json')) {
      try { JSON.parse(text); } catch { return this.markdown(text, relative); }
      return this.json(text, relative);
    }
    return this.markdown(text, relative);
  }

  // The home decision log keeps the single-task entries its readers use
  // (listTasks and the task tests filter to them); the workflow-attempt
  // copies of attempts already in workflows/*/state.json are not carried.
  homeState(text) {
    const state = JSON.parse(text);
    state.decisionLog = (state.decisionLog ?? []).filter(isTaskEntry);
    return `${JSON.stringify(this.value(state, null, null, {}))}${text.endsWith('\n') ? '\n' : ''}`;
  }
}

// The kernel's own verdict sentences; any other `why` is a person's or an
// agent's words.
const KERNEL_WHY = [
  /^verified$/,
  /^structured output validated$/,
  /^provider stream reported error$/,
  /^runner stopped before the attempt reached a durable terminal state$/,
  /^stopped by plan revision rev-[\w-]+$/,
  /^stopped by workflow pause; it runs again after resume$/,
  /^announcement without substance$/,
  /^no evidence recorded for the current work$/,
  /^workflow cancellation requested$/,
];

// The route sentences the router composes from meter readings.
const ROUTE_REASON = /^(expiring soon: |most-behind capable pool|free pool first: |configured \w+ assignment|evidence step: |evidence: independent of )/;

function isTaskEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.kind === 'run' || entry.source === 'run') return true;
  return entry.source == null && entry.picked != null && entry.outFile != null;
}

/** Task, out and report files: prose files, not JSON records or diffs. */
function isMarkdownFile(relative) {
  return /\/(task|out)-[^/]+\.(md|json)$/.test(relative);
}

// Folder names every checkout path shares, too common to mean anything alone.
const GENERIC_SEGMENTS = new Set(['Repo', 'repo', 'repos', 'src', 'code', 'projects', '.worktrees', 'worktrees']);
// The product's own name is on every page the fixture feeds; its checkouts'
// folder names are not.
const PRODUCT = 'bullswarm';

/** Owner names, private projects, checkout folders and owner home paths. */
export function privateWords(scrubber) {
  const words = new Set();
  for (const root of scrubber.roots.keys()) {
    const [owner, ...segments] = root.replace(/^\/[^/]+\//, '').split('/');
    words.add(owner);
    for (const segment of segments) if (!GENERIC_SEGMENTS.has(segment)) words.add(segment);
  }
  for (const project of scrubber.projects.keys()) words.add(project);
  words.delete(PRODUCT);
  return [...words].filter(Boolean).sort();
}

function leakPattern(words) {
  const escaped = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp([...escaped, OWNER_HOME.source.replace(/^\^/, '')].join('|'), 'i');
}

export function buildTestHome(snapshot, dest) {
  const source = resolve(snapshot);
  const target = resolve(dest);
  if (!existsSync(join(source, 'history', 'runs.jsonl'))) throw new Error(`not a Bullswarm home snapshot: ${source}`);
  const scrubber = new Scrubber(source);
  const files = manifest(source);
  const missing = files.filter((relative) => !existsSync(join(source, relative)));
  if (missing.length) throw new Error(`snapshot lacks ${missing.join(', ')}`);
  scrubber.learnFileLines(files.filter(isMarkdownFile).map((relative) => readFileSync(join(source, relative), 'utf8')));
  const out = new Map(files.map((relative) => [relative, scrubber.file(relative)]));
  const leaks = leakPattern(privateWords(scrubber));
  for (const [relative, text] of out) {
    const leak = text.match(leaks);
    if (leak) throw new Error(`${relative} still carries "${leak[0]}" near ${JSON.stringify(text.slice(Math.max(0, leak.index - 60), leak.index + 60))}`);
  }
  rmSync(target, { recursive: true, force: true });
  for (const [relative, text] of out) {
    const path = join(target, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  return { files: files.length, projects: Object.fromEntries(scrubber.projects) };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const [snapshot, dest] = process.argv.slice(2);
  if (!snapshot || !dest) {
    process.stderr.write('usage: node scripts/build-test-home.mjs <snapshot> <dest>\n');
    process.exit(2);
  }
  const { files } = buildTestHome(snapshot, dest);
  process.stdout.write(`wrote ${files} scrubbed files to ${dest}\n`);
}
