#!/usr/bin/env node
// Regenerate each shipped provider's connector-history.json from git.
//
//   node scripts/connector-history.mjs          rewrite every history file
//   node scripts/connector-history.mjs --check  exit 1 when one is out of date
//
// Until 0.29.0 `bullswarm setup` copied every packaged connector into
// `<home>/connectors/<name>.json`, and every verb since has filled new fields
// into those copies. A history file holds a fingerprint of every value each
// top-level field of the connector has ever shipped with — the old flat
// `connectors/<name>.json` and the provider directory's `connector.json`,
// every committed version plus the working tree — so src/lib/connector-copies.js
// can tell an unmodified older packaged copy from one the operator edited.
// Only hashes are stored.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { historyFileName, historyFromVersions } from '../src/lib/connector-copies.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function git(args) {
  return execFileSync('git', args, {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/** Every committed version of `path`, oldest first. */
function versionsOf(path) {
  const shas = git(['log', '--format=%H', '--', path]).split('\n').filter(Boolean).reverse();
  const out = [];
  for (const sha of shas) {
    try {
      out.push(JSON.parse(git(['show', `${sha}:${path}`])));
    } catch { /* the commit that deleted it, or a broken intermediate */ }
  }
  return out;
}

function providerDirs() {
  const dirs = [];
  for (const base of ['src/providers', 'providers/contrib']) {
    const abs = join(ROOT, base);
    if (!existsSync(abs)) continue;
    for (const name of readdirSync(abs).sort()) {
      if (name.startsWith('_') || name.startsWith('.')) continue;
      if (existsSync(join(abs, name, 'connector.json'))) dirs.push({ name, dir: join(abs, name) });
    }
  }
  return dirs;
}

const check = process.argv.includes('--check');
let stale = 0;
for (const { name, dir } of providerDirs()) {
  const current = join(dir, 'connector.json');
  const versions = [
    ...versionsOf(`connectors/${name}.json`),
    ...versionsOf(relative(ROOT, current)),
    JSON.parse(readFileSync(current, 'utf8')),
  ];
  const target = join(dir, historyFileName);
  const text = `${JSON.stringify(historyFromVersions(name, versions), null, 2)}\n`;
  const before = existsSync(target) ? readFileSync(target, 'utf8') : null;
  if (before === text) continue;
  if (check) {
    stale += 1;
    console.error(`${relative(ROOT, target)} is out of date`);
    continue;
  }
  writeFileSync(target, text);
  console.log(`wrote ${relative(ROOT, target)} (${versions.length} versions)`);
}
if (check && stale) {
  console.error('run: node scripts/connector-history.mjs');
  process.exit(1);
}
