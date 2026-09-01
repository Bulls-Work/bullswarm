// Exact-file ownership checks for the V2 scheduler boundary.
// Concurrent mutating actions require isolated workspaces; a shared workspace
// can only safely attribute one mutating action at a time.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

export class OwnershipValidationError extends TypeError {
  constructor(message) {
    super(`workflow ownership invalid: ${message}`);
    this.name = 'OwnershipValidationError';
  }
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

function path(value, name) {
  if (typeof value !== 'string' || !value) throw new OwnershipValidationError(`${name} must be a non-empty relative file path`);
  if (value.includes('\0') || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)) {
    throw new OwnershipValidationError(`${name} must be a relative path`);
  }
  if (value.endsWith('/') || value.includes('*') || value.includes('?') || value.includes('[') || value.includes(']')) {
    throw new OwnershipValidationError(`${name} must name one exact file, not a directory or glob`);
  }
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new OwnershipValidationError(`${name} must be an unambiguous canonical relative path`);
  }
  return value;
}

export function normalizeOwnedFiles(ownedFiles, name = 'ownedFiles') {
  if (!Array.isArray(ownedFiles)) throw new OwnershipValidationError(`${name} must be an array`);
  const seen = new Set();
  const result = ownedFiles.map((value, index) => path(value, `${name}[${index}]`));
  for (const value of result) {
    if (seen.has(value)) throw new OwnershipValidationError(`${name} contains duplicate "${value}"`);
    seen.add(value);
  }
  return result;
}

export function normalizeManifest(manifest, name = 'manifest') {
  if (!isObject(manifest)) throw new OwnershipValidationError(`${name} must be a path-to-digest object`);
  const entries = [];
  for (const [rawPath, digest] of Object.entries(manifest)) {
    const file = path(rawPath, `${name} path`);
    if (typeof digest !== 'string' || !digest) throw new OwnershipValidationError(`${name}[${file}] digest must be a non-empty string`);
    entries.push([file, digest]);
  }
  return Object.fromEntries(entries);
}

export function compareManifests(before, after) {
  const left = normalizeManifest(before, 'before');
  const right = normalizeManifest(after, 'after');
  const created = [], modified = [], deleted = [];
  for (const file of Object.keys(right).sort()) {
    if (!Object.hasOwn(left, file)) created.push(file);
    else if (left[file] !== right[file]) modified.push(file);
  }
  for (const file of Object.keys(left).sort()) if (!Object.hasOwn(right, file)) deleted.push(file);
  return { created, modified, deleted, changed: [...created, ...modified, ...deleted].sort() };
}

export function changedManifestPaths(before, after) {
  return compareManifests(before, after).changed;
}

export function checkOwnership({ before, after, ownedFiles } = {}) {
  const changes = compareManifests(before, after);
  const declared = normalizeOwnedFiles(ownedFiles, 'ownedFiles');
  const allowed = new Set(declared);
  const outOfScope = changes.changed.filter((file) => !allowed.has(file));
  return clone({ ok: outOfScope.length === 0, ownedFiles: declared, ...changes, outOfScope });
}

function digestFile(absolutePath) {
  const stat = lstatSync(absolutePath);
  const hash = createHash('sha256');
  if (stat.isSymbolicLink()) hash.update(`symlink\0${readlinkSync(absolutePath)}`);
  else if (stat.isFile()) hash.update(readFileSync(absolutePath));
  else throw new OwnershipValidationError(`manifest path is not a file: ${absolutePath}`);
  return hash.digest('hex');
}

function gitFiles(root) {
  try {
    const output = execFileSync('git', ['-C', root, 'ls-files', '-co', '--exclude-standard', '-z'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024,
    });
    return [...new Set(output.split('\0').filter(Boolean))].sort();
  } catch {
    return null;
  }
}

function walkFiles(root) {
  const result = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile() || entry.isSymbolicLink()) result.push(relative(root, absolute).split(sep).join('/'));
    }
  };
  walk(root);
  return result.sort();
}

/** Capture a bounded exact-file manifest for post-action ownership checks. */
export function captureWorkspaceManifest(root, { maxFiles = 50_000 } = {}) {
  if (typeof root !== 'string' || !root) throw new OwnershipValidationError('workspace root must be a non-empty path');
  if (!Number.isInteger(maxFiles) || maxFiles < 1) throw new OwnershipValidationError('maxFiles must be a positive integer');
  const absoluteRoot = resolve(root);
  const files = gitFiles(absoluteRoot) ?? walkFiles(absoluteRoot);
  if (files.length > maxFiles) throw new OwnershipValidationError(`workspace manifest exceeds ${maxFiles} files`);
  const manifest = {};
  for (const file of files) {
    const normalized = path(file, 'workspace file');
    try { manifest[normalized] = digestFile(join(absoluteRoot, normalized)); }
    catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return manifest;
}

export const verifyOwnership = checkOwnership;
