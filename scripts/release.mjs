#!/usr/bin/env node
// Maintainer release script: bump the version, date the changelog, commit, tag.
// Usage: npm run release -- <patch|minor|major> [--title "<headline>"] [--dry-run]
//
// It never pushes or publishes. Pushing the tag starts .github/workflows/release.yml,
// which runs the tests, publishes to npm and creates the GitHub release.
//
// Semver discipline:
//   patch — fixes and corrections
//   minor — new verbs, new connectors, new meters, behavior additions
//   major — verdict-contract or config-format breaking changes

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UNRELEASED = /^## Unreleased[ \t]*$/m;

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

/**
 * Turn `## Unreleased` into the version heading and open a fresh, empty
 * `## Unreleased` above it. Refuses a changelog with no unreleased entries,
 * so a release always says what changed.
 */
export function datedChangelog(text, version, title = '') {
  const match = UNRELEASED.exec(text);
  if (!match) throw new Error('CHANGELOG.md has no "## Unreleased" section');
  const start = match.index + match[0].length;
  const next = text.slice(start).search(/^## /m);
  const body = next < 0 ? text.slice(start) : text.slice(start, start + next);
  if (!/^- /m.test(body)) throw new Error('"## Unreleased" has no entries; nothing to release');
  const heading = title.trim() ? `## ${version} — ${title.trim()}` : `## ${version}`;
  return `${text.slice(0, match.index)}## Unreleased\n\n${heading}${text.slice(start)}`;
}

function git(args, repoRoot) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

export function release(kind, { title = '', dryRun = false, repoRoot = REPO_ROOT } = {}) {
  const pkgPath = join(repoRoot, 'package.json');
  const changelogPath = join(repoRoot, 'CHANGELOG.md');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const prev = pkg.version;
  const next = bumpVersion(prev, kind);

  // A release commit must contain exactly the version and changelog change.
  const status = git(['status', '--porcelain'], repoRoot);
  if (status) throw new Error(`working tree is dirty — commit first before releasing:\n${status}`);

  const changelog = datedChangelog(readFileSync(changelogPath, 'utf8'), next, title);
  if (dryRun) return { from: prev, to: next, tag: `v${next}`, dryRun: true };

  pkg.version = next;
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  writeFileSync(changelogPath, changelog);
  git(['add', 'package.json', 'CHANGELOG.md'], repoRoot);
  git(['commit', '-m', `release v${next}`], repoRoot);
  git(['tag', '-a', `v${next}`, '-m', `v${next}`], repoRoot);
  return { from: prev, to: next, tag: `v${next}`, dryRun: false };
}

function main(argv) {
  const kind = argv.find((arg) => !arg.startsWith('--'));
  const titleAt = argv.indexOf('--title');
  const title = titleAt >= 0 ? argv[titleAt + 1] ?? '' : '';
  if (!['patch', 'minor', 'major'].includes(kind)) {
    console.error('usage: npm run release -- <patch|minor|major> [--title "<headline>"] [--dry-run]');
    return 2;
  }
  try {
    const r = release(kind, { title, dryRun: argv.includes('--dry-run') });
    console.log(`${r.dryRun ? 'would release' : 'released'}: ${r.from} → ${r.to} (tag ${r.tag})`);
    if (!r.dryRun) console.log(`next: git push origin main && git push origin ${r.tag} (CI publishes to npm)`);
    return 0;
  } catch (err) {
    console.error(err.message);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
