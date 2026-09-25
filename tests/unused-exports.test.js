import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Guard against dead exports. Every name a src module exports must be
// imported by another file of the product (src, bin, mcp, providers, scripts),
// used inside its own module, or named below. A test does not count as an
// importer: an export only a test reads is dead code with a test attached.
//
// The scan is textual and dependency-free: comments and string contents are
// blanked, then static imports, re-exports, `import * as ns` members and
// literal `import('...')` calls are read. A namespace or undestructured
// dynamic import counts every `.name` its file reads.

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const IMPORTER_DIRS = ['src', 'bin', 'mcp', 'providers', 'scripts'];

// Entry points an import scan cannot see.
const ENTRY_POINTS = [
  // src/lib/providers.js loads each provider.mjs with require() and reads
  // these names off the module object (docs/reference/providers.md).
  { file: /^src\/providers\/[^/]+\/provider\.mjs$/, names: ['name', 'displayName', 'connectors', 'readUsage', 'discoverModels', 'readTranscriptUsage', 'buildTranscriptIndex', 'doctor'] },
  // The provider kit reaches every provider as `ctx.kit`; each export is its API.
  { file: /^src\/provider-kit\.js$/, names: '*' },
];

// Handles only tests need, kept on purpose.
const TEST_SEAMS = {
  'src/help.js': ['HELP_PATHS'], // the help test walks every command path
  'src/lib/glyphs.js': ['SUBSTITUTED_GLYPHS'], // frames are checked against the ASCII table
  'src/lib/pool-labels.js': ['clearPoolLabelCache'], // a test rewrites a home's label file
  'src/workflow/time-box.js': ['clearTimeBoxHistoryCache'], // a test rewrites a home's history
  'src/workflow/v2-state.js': ['createV2State'], // the tests' name for createV2DurableState
};

// Dead or test-only exports the 2026-09 dead-code pass left, because removing
// each one edits a file or a test outside that pass. Delete the export (and a
// test that only covers it), then its line here: the third test fails while a
// line names something that no longer needs it.
const NOT_YET_REMOVED = {
  'src/cli.js': ['BULLSWARM_DIR'],
  'src/lib/stale.js': ['streamFacts'],
  'src/lib/watch.js': ['attemptCapture'],
  'src/meters/framework.js': ['meterIntervalDelta', 'monotonicDelta'],
  'src/meters/registry.js': ['readMeterHistoryByDay'],
  'src/workflow/dashboard.js': ['renderDashboard'],
  'src/workflow/home-model.js': ['todayMinutesText', 'todayMinutesNumberText'],
  'src/workflow/run-features.js': ['STAGE2_RUN_FEATURES'],
  'src/workflow/run-model.js': ['attemptRoutingText', 'planMoreParts', 'planPhaseActionParts', 'planStageActions', 'planStageBoxText', 'planStageHeader', 'stepTally'],
  'src/workflow/v2-outcome.js': ['serializeV2ResultEnvelope'],
  'src/workflow/v2-runtime.js': ['preferredUsage'],
  'src/workflow/verify-rounds.js': ['VERIFY_LOOP_STOPS'],
};

const WORD = /[A-Za-z0-9_$]/;
const REGEX_AFTER_WORDS = new Set(['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'throw', 'else', 'yield', 'await', 'instanceof', 'do']);

/**
 * The source with comments and the insides of strings, templates and regex
 * literals replaced by spaces (newlines kept, so offsets line up). A
 * template's `${…}` stays code.
 */
function blankSource(src) {
  const out = src.split('');
  const put = (index) => { if (out[index] !== '\n') out[index] = ' '; };
  const templateBraces = [];
  let depth = 0;
  let lastChar = '';
  let lastWord = '';
  let i = 0;
  const template = () => {
    while (i < src.length) {
      if (src[i] === '\\') { put(i); put(i + 1); i += 2; continue; }
      if (src[i] === '`') { i += 1; lastChar = '`'; lastWord = ''; return; }
      if (src[i] === '$' && src[i + 1] === '{') { i += 2; templateBraces.push(depth); depth = 0; lastChar = '{'; lastWord = ''; return; }
      put(i); i += 1;
    }
  };
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') { while (i < src.length && src[i] !== '\n') { put(i); i += 1; } continue; }
    if (c === '/' && next === '*') {
      put(i); put(i + 1); i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { put(i); i += 1; }
      put(i); put(i + 1); i += 2;
      continue;
    }
    if (c === '\'' || c === '"') {
      i += 1;
      while (i < src.length && src[i] !== c && src[i] !== '\n') { if (src[i] === '\\') { put(i); i += 1; } put(i); i += 1; }
      i += 1; lastChar = c; lastWord = '';
      continue;
    }
    if (c === '`') { i += 1; template(); continue; }
    const regexAllowed = lastChar === '' || (WORD.test(lastChar) ? REGEX_AFTER_WORDS.has(lastWord) : lastChar !== ')' && lastChar !== ']');
    if (c === '/' && regexAllowed) {
      i += 1;
      let inClass = false;
      while (i < src.length && src[i] !== '\n') {
        if (src[i] === '\\') { put(i); put(i + 1); i += 2; continue; }
        if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        else if (src[i] === '/' && !inClass) break;
        put(i); i += 1;
      }
      i += 1;
      while (i < src.length && /[a-z]/.test(src[i])) i += 1;
      lastChar = '/'; lastWord = '';
      continue;
    }
    if (c === '{') depth += 1;
    if (c === '}') {
      if (depth === 0 && templateBraces.length) { depth = templateBraces.pop(); i += 1; template(); continue; }
      depth -= 1;
    }
    if (WORD.test(c)) {
      let end = i;
      while (end < src.length && WORD.test(src[end])) end += 1;
      lastWord = src.slice(i, end); lastChar = src[end - 1]; i = end;
      continue;
    }
    if (!/\s/.test(c)) { lastChar = c; lastWord = ''; }
    i += 1;
  }
  return out.join('');
}

function names(list) {
  return list.split(',').map((part) => part.trim()).filter(Boolean).map((part) => {
    const [local, alias] = part.split(/\s+as\s+/).map((text) => text.trim());
    return { local, exported: alias ?? local };
  });
}

const escape = (name) => name.replace(/\$/g, '\\$');

/** One module's imports (by target path) and exports, from its source text. */
function scanModule(path, src, resolveSpec) {
  const code = blankSource(src);
  // The specifier of the first string literal at or after `index`.
  const specAt = (index) => {
    const quote = index + code.slice(index).search(/['"]/);
    return src.slice(quote + 1, src.indexOf(src[quote], quote + 1));
  };
  const imports = [];
  const exports = [];
  const exportLists = [];
  for (const m of code.matchAll(/(^|[^.\w$])import\s+([\w$\s{},*]*?)\s*from\s*['"]/g)) {
    const target = resolveSpec(path, specAt(m.index + m[0].length - 1));
    if (!target) continue;
    const clause = m[2];
    const braces = clause.match(/\{([^}]*)\}/);
    const used = braces ? names(braces[1]).map((entry) => entry.local) : [];
    if (clause.replace(/\{[^}]*\}/, '').replace(/\*\s*as\s+[\w$]+/, '').replace(/,/g, ' ').trim()) used.push('default');
    imports.push({ target, names: used, namespace: clause.match(/\*\s*as\s+([\w$]+)/)?.[1] ?? null });
  }
  for (const m of code.matchAll(/(^|[^.\w$])import\s*\(\s*['"]/g)) {
    const target = resolveSpec(path, specAt(m.index + m[0].length - 1));
    if (!target) continue;
    const destructured = code.slice(Math.max(0, m.index - 400), m.index + m[1].length)
      .match(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:await\s*)?$/);
    const member = code.slice(m.index + m[0].length - 1).match(/^['"][^'"]*['"]\s*\)\s*\)\s*\.\s*([\w$]+)/);
    if (destructured) imports.push({ target, names: names(destructured[1].replace(/:\s*[\w$]+/g, '')).map((entry) => entry.local), namespace: null });
    else if (member) imports.push({ target, names: [member[1]], namespace: null });
    else imports.push({ target, names: [], namespace: '*' });
  }
  for (const m of code.matchAll(/(^|[^.\w$])export\s+(?:async\s+)?(?:function\s*\*?|class|const|let|var)\s+([\w$]+)/g)) {
    exports.push({ name: m[2], local: m[2] });
  }
  for (const m of code.matchAll(/(^|[^.\w$])export\s*\{([^}]*)\}(\s*from\s*['"])?/g)) {
    const pairs = names(m[2]);
    if (m[3]) {
      const target = resolveSpec(path, specAt(m.index + m[0].length - 1));
      if (target) imports.push({ target, names: pairs.map((entry) => entry.local), namespace: null });
      for (const entry of pairs) exports.push({ name: entry.exported, local: null });
    } else {
      for (const entry of pairs) exports.push({ name: entry.exported, local: entry.local });
    }
    exportLists.push([m.index + m[1].length, m.index + m[0].length]);
  }
  for (const m of code.matchAll(/(^|[^.\w$])export\s+default\s+([\w$]+)?/g)) {
    exports.push({ name: 'default', local: m[2] ?? null });
  }
  // Uses of a local name: the code outside `export { … }` lists, where the
  // declaration itself is one occurrence and a `.name` property is none.
  let body = code;
  for (const [start, end] of exportLists) body = body.slice(0, start) + ' '.repeat(end - start) + body.slice(end);
  const usedLocally = (local) => Boolean(local)
    && [...body.matchAll(new RegExp(`(^|[^\\w$.]|\\.\\.\\.)${escape(local)}(?![\\w$])`, 'g'))].length >= 2;
  return { path, code, imports, exports, usedLocally };
}

/** `file#name` for every src export nothing outside the tests uses. */
function unusedExports(sources) {
  const has = (path) => sources.has(path);
  const resolveSpec = (from, spec) => {
    if (!spec.startsWith('.')) return null;
    const base = resolve(dirname(from), spec.split('?')[0]);
    return [base, `${base}.js`, `${base}.mjs`, join(base, 'index.js')].find(has) ?? null;
  };
  const modules = [...sources].map(([path, src]) => scanModule(path, src, resolveSpec));
  const used = new Set();
  for (const module of modules) {
    for (const entry of module.imports) {
      for (const name of entry.names) used.add(`${entry.target}#${name}`);
      if (!entry.namespace) continue;
      const member = entry.namespace === '*'
        ? /\.\s*([\w$]+)/g
        : new RegExp(`(?:^|[^\\w$.])${escape(entry.namespace)}\\s*\\.\\s*([\\w$]+)`, 'g');
      for (const m of module.code.matchAll(member)) used.add(`${entry.target}#${m[1]}`);
    }
  }
  const unused = [];
  for (const module of modules) {
    const file = relative(ROOT, module.path).split(sep).join('/');
    if (!file.startsWith('src/')) continue;
    for (const entry of module.exports) {
      if (used.has(`${module.path}#${entry.name}`) || module.usedLocally(entry.local)) continue;
      unused.push(`${file}#${entry.name}`);
    }
  }
  return [...new Set(unused)].sort();
}

function productSources() {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(path); }
      else if (/\.m?js$/.test(entry.name)) files.push(path);
    }
  };
  for (const dir of IMPORTER_DIRS) {
    try { walk(join(ROOT, dir)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return new Map(files.map((path) => [path, readFileSync(path, 'utf8')]));
}

function allowed(key) {
  const [file, name] = key.split('#');
  if (ENTRY_POINTS.some((entry) => entry.file.test(file) && (entry.names === '*' || entry.names.includes(name)))) return true;
  return Boolean(TEST_SEAMS[file]?.includes(name) || NOT_YET_REMOVED[file]?.includes(name));
}

const listed = (lists) => lists.flatMap((list) => Object.entries(list)
  .flatMap(([file, entries]) => entries.map((name) => `${file}#${name}`)));

test('the scan sees imports, re-exports, namespaces, dynamic imports and local use', () => {
  const at = (path) => join(ROOT, path);
  const sources = new Map([
    [at('src/fixture/a.js'), [
      '// export function commented() {}',
      "export const kept = 'import { dead } from \\'./b.js\\'';",
      'export function dead() { return /export function fake/.test(`${kept}`); }',
      'export function local() { return 1; }',
      'export const twice = () => local();',
      'export function viaNamespace() {}',
      'export function viaDynamic() {}',
      'export default kept;',
    ].join('\n')],
    [at('src/fixture/b.js'), [
      "import value, { kept, twice as again } from './a.js';",
      "import * as ns from './a.js';",
      "export { kept as renamed } from './a.js';",
      'export function onlyTests() {}',
      "export async function load() { const { viaDynamic } = await import('./a.js'); return [ns.viaNamespace, viaDynamic, value, again]; }",
    ].join('\n')],
    [at('bin/fixture.js'), "import { load, renamed } from '../src/fixture/b.js';\nload(renamed);"],
  ]);
  assert.deepEqual(unusedExports(sources), ['src/fixture/a.js#dead', 'src/fixture/b.js#onlyTests']);
});

test('every src export has a user outside the tests, or is named on the allow-list', () => {
  const sources = productSources();
  assert.ok(sources.size > 100, `expected the product's modules, read ${sources.size}`);
  const unused = unusedExports(sources).filter((key) => !allowed(key));
  assert.deepEqual(unused, [], [
    'These exports have no importer outside the tests and no use in their own module.',
    'Delete them (with any test that only covers them), drop the `export` keyword,',
    'or, for a real entry point or a deliberate test seam, add them to',
    'tests/unused-exports.test.js with a one-line reason:',
    ...unused.map((key) => `  ${key}`),
  ].join('\n'));
});

test('every name on the allow-list still needs its line', () => {
  const unused = new Set(unusedExports(productSources()));
  const stale = listed([TEST_SEAMS, NOT_YET_REMOVED]).filter((key) => !unused.has(key));
  assert.deepEqual(stale, [], `remove these lines from tests/unused-exports.test.js:\n${stale.map((key) => `  ${key}`).join('\n')}`);
});
