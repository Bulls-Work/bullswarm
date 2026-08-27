import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { judgeContent, splitSentences } from '../src/lib/verify.js';

const FIX_DIR = fileURLToPath(new URL('../fixtures/', import.meta.url));

function loadFixtures(sub) {
  const dir = path.join(FIX_DIR, sub);
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => ({
      file: `${sub}/${f}`,
      ...JSON.parse(readFileSync(path.join(dir, f), 'utf8')),
    }));
}

const fixtures = [...loadFixtures('failures'), ...loadFixtures('real')];

test('fixture count meets the doctrine floor (>=17)', () => {
  assert.ok(fixtures.length >= 17, `only ${fixtures.length} fixtures`);
});

for (const fx of fixtures) {
  test(`fixture ${fx.file} → ${fx.expect}`, () => {
    const r = judgeContent(fx.output, {
      exitCode: fx.exitCode,
      expectWork: true,
    });
    if (fx.expect === 'fail') {
      assert.equal(r.verdict, 'fail', `${fx.name}: ${r.why}`);
    } else if (fx.expect === 'intent_only') {
      assert.equal(r.verdict, 'intent_only', `${fx.name}: ${r.why}`);
    } else {
      assert.equal(r.verdict, 'pass', `${fx.name}: ${r.why}`);
    }
  });
}

test('splitter never shreds .d.ts tokens (V4)', () => {
  const sentences = splitSentences(
    'The public API lives in index.d.ts and runtime.d.ts. It exports Result.',
  );
  assert.equal(sentences.length, 2);
});

test('splitter handles Node.js mid-sentence (V4)', () => {
  const sentences = splitSentences(
    'We require Node.js. Then install pnpm.',
  );
  assert.equal(sentences.length, 2);
});

test('verify JSON can satisfy the content gate without filler prose', () => {
  const output = 'I will verify now. ' + JSON.stringify({
    ok: true, concerns: [], summary: 'The inspected artifact satisfies the requested checks.',
  });
  assert.equal(judgeContent(output).verdict, 'intent_only');
  assert.equal(judgeContent(output, { acceptVerifyJson: true }).verdict, 'pass');
});

test('curly-apostrophe intent announcements are not mistaken for completed work', () => {
  const output = 'I’ll load the three source docs plus the contract-authoring rules so I can score each area against the stated bar. '
    + 'The three docs are loaded. Next I’ll check leftover research, current permission contracts, and likely gaps so later calls rest on line-level evidence.';
  assert.equal(judgeContent(output).verdict, 'intent_only');
});
