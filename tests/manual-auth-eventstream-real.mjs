// Manual subscription-backed regression probe. Not part of `npm test`.
// It asks the real Grok and Command Code CLIs to inspect auth-related source,
// reproducing the transport shape that once caused a false quarantine.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { watchOnce } from '../src/lib/watch.js';

const root = resolve(new URL('..', import.meta.url).pathname);
const prompt = [
  'Read-only verification: inspect src/lib/verify.js and src/lib/watch.js.',
  'Identify the auth-signature matching behavior and explain why source text containing the word unauthorized is not itself a provider authentication failure.',
  'Do not modify files. Return a concise evidence-based report naming both files and the relevant behavior.',
].join('\n');

const names = process.argv.slice(2).length ? process.argv.slice(2) : ['grok', 'command-code'];
const results = await Promise.all(names.map(async (name) => {
  const dir = mkdtempSync(join(tmpdir(), `bullswarm-real-${name}-`));
  try {
    const connector = JSON.parse(readFileSync(join(root, 'connectors', `${name}.json`), 'utf8'));
    const verdict = await watchOnce(connector, prompt, root, {
      taskFile: join(dir, 'task.md'),
      outFile: join(dir, 'out.md'),
    });
    const output = readFileSync(join(dir, 'out.md'), 'utf8');
    return {
      name,
      ok: verdict.ok,
      why: verdict.why,
      quarantined: verdict.quarantineHint === true,
      signal: verdict.meta?.signal ?? null,
      wallSec: verdict.meta?.wallSec ?? null,
      outBytes: verdict.meta?.outBytes ?? null,
      outputHead: output.slice(0, 800),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}));

console.log(JSON.stringify(results, null, 2));
if (results.some((result) => !result.ok || result.quarantined)) process.exitCode = 1;
