import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Guard against import cycles under src/. A module that imports, directly or
// through others, a module that imports it back loads half-initialised in one
// of the two orders. The scan is textual and dependency-free: comments and
// string contents are blanked, then the specifiers of static relative
// `import … from` and `export … from` statements are read.

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'src');

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

/** The relative specifiers of a module's static `import`/`export … from` statements. */
function staticSpecifiers(src) {
  const code = blankSource(src);
  const specAt = (index) => {
    const quote = index + code.slice(index).search(/['"]/);
    return src.slice(quote + 1, src.indexOf(src[quote], quote + 1));
  };
  const specs = [];
  const statements = [
    /(^|[^.\w$])import\s+[\w$\s{},*]*?\s*from\s*['"]/g,
    /(^|[^.\w$])import\s*['"]/g,
    /(^|[^.\w$])export\s*(?:\*(?:\s*as\s+[\w$]+)?|\{[^}]*\})\s*from\s*['"]/g,
  ];
  for (const pattern of statements) {
    for (const m of code.matchAll(pattern)) specs.push(specAt(m.index + m[0].length - 1));
  }
  return specs.filter((spec) => spec.startsWith('.'));
}

/** Every module's local imports, keyed by path relative to the repository. */
function importGraph(sources) {
  const has = (path) => sources.has(path);
  const graph = new Map();
  for (const [path, src] of sources) {
    const targets = new Set();
    for (const spec of staticSpecifiers(src)) {
      const base = resolve(dirname(path), spec.split('?')[0]);
      const target = [base, `${base}.js`, `${base}.mjs`, join(base, 'index.js')].find(has);
      if (target) targets.add(target);
    }
    graph.set(path, [...targets].sort());
  }
  return graph;
}

/** Each cycle once, as the list of its modules from its first-sorted one. */
function findCycles(graph) {
  // Tarjan's strongly connected components; each component with more than one
  // module (or a module importing itself) holds at least one cycle.
  let index = 0;
  const indices = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];
  const connect = (node) => {
    indices.set(node, index); low.set(node, index); index += 1;
    stack.push(node); onStack.add(node);
    for (const next of graph.get(node) ?? []) {
      if (!indices.has(next)) { connect(next); low.set(node, Math.min(low.get(node), low.get(next))); }
      else if (onStack.has(next)) low.set(node, Math.min(low.get(node), indices.get(next)));
    }
    if (low.get(node) !== indices.get(node)) return;
    const component = [];
    let member;
    do { member = stack.pop(); onStack.delete(member); component.push(member); } while (member !== node);
    if (component.length > 1 || (graph.get(node) ?? []).includes(node)) components.push(component.sort());
  };
  for (const node of [...graph.keys()].sort()) if (!indices.has(node)) connect(node);
  // One shortest cycle through each component's first module names it.
  return components.map((component) => {
    const members = new Set(component);
    const start = component[0];
    const previous = new Map([[start, null]]);
    const queue = [start];
    while (queue.length) {
      const node = queue.shift();
      for (const next of graph.get(node) ?? []) {
        if (next === start) {
          const path = [];
          for (let at = node; at !== null; at = previous.get(at)) path.unshift(at);
          return { cycle: [...path, start], modules: component };
        }
        if (members.has(next) && !previous.has(next)) { previous.set(next, node); queue.push(next); }
      }
    }
    return { cycle: [start, start], modules: component };
  }).sort((a, b) => a.cycle[0].localeCompare(b.cycle[0]));
}

function srcSources() {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(path); }
      else if (/\.m?js$/.test(entry.name)) files.push(path);
    }
  };
  walk(SRC);
  return new Map(files.map((path) => [path, readFileSync(path, 'utf8')]));
}

const named = (path) => relative(ROOT, path).split(sep).join('/');

test('the scan reads static imports and re-exports, and skips comments, strings and packages', () => {
  const at = (path) => join(ROOT, path);
  const sources = new Map([
    [at('src/fixture/a.js'), [
      "import { b } from './b.js';",
      "// import { c } from './c.js';",
      "const text = \"import { c } from './c.js'\";",
      "import fs from 'node:fs';",
      'export const a = b;',
    ].join('\n')],
    [at('src/fixture/b.js'), "export { a as b } from './a.js';\nexport * from './c.js';"],
    [at('src/fixture/c.js'), "import './d.js';\nexport const c = 1;"],
    [at('src/fixture/d.js'), "export async function later() { return import('./c.js'); }"],
  ]);
  const graph = importGraph(sources);
  assert.deepEqual(graph.get(at('src/fixture/a.js')), [at('src/fixture/b.js')]);
  assert.deepEqual(graph.get(at('src/fixture/b.js')), [at('src/fixture/a.js'), at('src/fixture/c.js')]);
  assert.deepEqual(graph.get(at('src/fixture/c.js')), [at('src/fixture/d.js')]);
  assert.deepEqual(graph.get(at('src/fixture/d.js')), []);
  assert.deepEqual(findCycles(graph).map((entry) => entry.cycle.map(named)), [
    ['src/fixture/a.js', 'src/fixture/b.js', 'src/fixture/a.js'],
  ]);
});

test('no module under src/ imports itself back through its imports', () => {
  const sources = srcSources();
  assert.ok(sources.size > 100, `expected the product's modules, read ${sources.size}`);
  const cycles = findCycles(importGraph(sources));
  assert.deepEqual(cycles.map((entry) => entry.cycle.map(named).join(' -> ')), [], [
    'These modules import each other in a cycle. Move what the lower module',
    'reads from the upper one into a module both can import:',
    ...cycles.map((entry) => `  ${entry.cycle.map(named).join(' -> ')}${entry.modules.length > entry.cycle.length - 1 ? ` (component of ${entry.modules.length} modules: ${entry.modules.map(named).join(', ')})` : ''}`),
  ].join('\n'));
});
