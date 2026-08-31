// Exact-file ownership checks for the V2 scheduler boundary.
// Concurrent mutating actions require isolated workspaces; a shared workspace
// can only safely attribute one mutating action at a time.

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

export const verifyOwnership = checkOwnership;
