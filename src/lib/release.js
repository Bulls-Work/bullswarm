// bullswarm release — version bumping + git tagging.
// Usage: bullswarm release patch|minor|major [--dry-run]
//
// Semver discipline:
//   patch — connector flag fixes, verify-gate fixes, meter corrections
//   minor — new verbs, new connectors, new meters, behavior additions
//   major — verdict-contract or config-format breaking changes

import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PKG_PATH = join(REPO_ROOT, 'package.json');

export function bumpVersion(version, kind) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) throw new Error(`current version "${version}" is not strict semver`);
  let [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (kind === 'major') { maj += 1; min = 0; pat = 0; }
  else if (kind === 'minor') { min += 1; pat = 0; }
  else if (kind === 'patch') { pat += 1; }
  else throw new Error(`unknown bump kind "${kind}" (use patch|minor|major)`);
  return `${maj}.${min}.${pat}`;
}

function git(args) {
  return execSync(`git ${args}`, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
}

export function release(kind, { dryRun = false } = {}) {
  const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'));
  const next = bumpVersion(pkg.version, kind);

  // Dirty-tree guard: a release commit must contain exactly the version change.
  const status = git('status --porcelain');
  if (status.trim()) {
    throw new Error(
      `working tree is dirty — commit first before releasing:\n${status}`,
    );
  }

  if (dryRun) {
    return { from: pkg.version, to: next, tag: `v${next}`, dryRun: true };
  }

  pkg.version = next;
  pkg.files ??= [];
  writeFileSync(PKG_PATH, `${JSON.stringify(pkg, null, 2)}\n`);
  git('add package.json');
  git(`commit -m "release v${next}"`);
  git(`tag -a v${next} -m "v${next}"`);
  return { from: pkg.version, to: next, tag: `v${next}`, dryRun: false };
}
