#!/usr/bin/env node

import { readFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  buildOpenRouterDatapack, OPENROUTER_BENCHMARKS_API, OPENROUTER_MODELS_API,
} from '../src/lib/openrouter-models.js';

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

async function fetchJson(url, token) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    },
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return await response.json();
}

function readJson(file) {
  return JSON.parse(readFileSync(resolve(file), 'utf8'));
}

const opts = flags(process.argv.slice(2));
const output = resolve(opts.output ?? 'data/openrouter-benchmarks.json');
let benchmarks;
let models;
if (opts['benchmarks-file'] || opts['models-file']) {
  if (!opts['benchmarks-file'] || !opts['models-file']) throw new Error('fixture mode needs both --benchmarks-file and --models-file');
  benchmarks = readJson(opts['benchmarks-file']);
  models = readJson(opts['models-file']);
} else {
  const token = process.env.OPENROUTER_API_KEY;
  if (!token) throw new Error('OPENROUTER_API_KEY is required for an upstream refresh');
  [benchmarks, models] = await Promise.all([
    fetchJson(OPENROUTER_BENCHMARKS_API, token),
    fetchJson(OPENROUTER_MODELS_API, token),
  ]);
}

const datapack = buildOpenRouterDatapack({ benchmarks, models });
mkdirSync(dirname(output), { recursive: true });
const temporary = `${output}.tmp-${process.pid}`;
writeFileSync(temporary, `${JSON.stringify(datapack, null, 2)}\n`);
renameSync(temporary, output);
process.stdout.write(`wrote ${Object.keys(datapack.models).length} models and ${datapack.benchmarkRecords.length} benchmark records to ${output}\n`);
