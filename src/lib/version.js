// bullswarm version — single source of truth is package.json.
// Resolved relative to this module so it works identically from a repo
// checkout and a global npm install.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_PATH = join(resolve(dirname(fileURLToPath(import.meta.url)), '../..'), 'package.json');

let cached;

export function getVersion() {
  if (cached) return cached;
  cached = JSON.parse(readFileSync(PKG_PATH, 'utf8')).version;
  return cached;
}
