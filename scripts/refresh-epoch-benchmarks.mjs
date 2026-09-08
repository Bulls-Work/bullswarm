#!/usr/bin/env node

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { buildEpochDatapack } from '../src/lib/epoch-benchmarks.js';

function flags(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (!key.startsWith('--')) throw new Error(`unexpected argument ${key}`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${key} needs a value`);
    out[key.slice(2)] = value;
  }
  return out;
}

const opts = flags(process.argv.slice(2));
if (!opts['input-dir']) throw new Error('--input-dir is required');
const output = resolve(opts.output ?? 'data/epoch-benchmarks.json');
const datapack = buildEpochDatapack({
  inputDir: resolve(opts['input-dir']),
  capturedAt: opts['captured-at'],
});
mkdirSync(dirname(output), { recursive: true });
const temporary = `${output}.tmp-${process.pid}`;
writeFileSync(temporary, `${JSON.stringify(datapack, null, 2)}\n`);
renameSync(temporary, output);
const models = new Set(datapack.records.map((record) => record.model));
const pairs = new Set(datapack.records.map((record) => `${record.model}|${record.reasoningLevel}`));
process.stdout.write(`wrote ${datapack.records.length} records, ${models.size} models, ${pairs.size} (model, level) pairs to ${output}\n`);
