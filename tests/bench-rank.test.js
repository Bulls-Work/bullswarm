import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RANK_SCRIPT = fileURLToPath(new URL('../bench/eval-suite/rank.mjs', import.meta.url));
const loadRankModule = () => import('../bench/eval-suite/rank.mjs');

function makeTempRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'bench-rank-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function taskResult(id, overrides = {}) {
  return {
    id,
    score: { passed: 10, total: 10 },
    interventions: 0,
    wallMin: 5,
    runnerMinutes: 5.2,
    tokens: 10_000,
    outputTokens: 1_500,
    apiUsdEquivalent: 1.0,
    attempts: 1,
    pools: ['pool-a'],
    models: ['model-a'],
    runId: `wf-${id}`,
    notes: [],
    ...overrides,
  };
}

function writeBench(root, name, results, meta = {}) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const doc = {
    meta: { at: '2026-11-18T00:00:00.000Z', version: '0.38.22', runFlags: '', goalFlags: '', ...meta },
    results,
  };
  writeFileSync(join(dir, 'bench.json'), `${JSON.stringify(doc, null, 2)}\n`);
  return dir;
}

test('bench rank: higher pass percentage on common tasks beats faster and cheaper runs', async (t) => {
  const { loadBench, rank } = await loadRankModule();
  const root = makeTempRoot(t);
  const fastDir = writeBench(root, 'fast', [
    taskResult('t1', { score: { passed: 10, total: 15 }, wallMin: 1.2, apiUsdEquivalent: 0.2, models: ['fast-1'] }),
    taskResult('t2', { score: { passed: 20, total: 35 }, wallMin: 2.0, apiUsdEquivalent: 0.3, models: ['fast-1'] }),
  ]);
  const accurateDir = writeBench(root, 'accurate', [
    taskResult('t1', { score: { passed: 14, total: 15 }, wallMin: 12.5, apiUsdEquivalent: 4.5, interventions: 2, models: ['acc-1'] }),
    taskResult('t2', { score: { passed: 31, total: 35 }, wallMin: 25.0, apiUsdEquivalent: 8.0, interventions: 1, models: ['acc-1'] }),
  ]);

  const report = rank([
    { label: 'fast', bench: loadBench(fastDir) },
    { label: 'accurate', bench: loadBench(accurateDir) },
  ]);

  assert.deepEqual(report.ranking.map((r) => r.label), ['accurate', 'fast']);
  assert.deepEqual(report.ranking.map((r) => r.rank), [1, 2]);
  assert.equal(report.ranking[0].passPct, 90);
  assert.equal(report.ranking[1].passPct, 60);
});

test('bench rank: fewer interventions break pass-percentage ties before speed and cost', async () => {
  const { rank } = await loadRankModule();
  const report = rank([
    {
      label: 'rescued-fast',
      bench: {
        results: [
          taskResult('t1', { score: { passed: 12, total: 15 }, interventions: 2, wallMin: 2.0, apiUsdEquivalent: 0.5 }),
        ],
      },
    },
    {
      label: 'clean-slow',
      bench: {
        results: [
          taskResult('t1', { score: { passed: 12, total: 15 }, interventions: 0, wallMin: 9.5, apiUsdEquivalent: 3.0 }),
        ],
      },
    },
  ]);

  assert.deepEqual(report.ranking.map((r) => r.label), ['clean-slow', 'rescued-fast']);
});

test('bench rank: wall minutes (falling back to runnerMinutes) then USD break ties, and full ties keep input order', async () => {
  const { rank } = await loadRankModule();
  const report = rank([
    {
      label: 'slow',
      bench: {
        results: [
          taskResult('t1', { score: { passed: 10, total: 10 }, interventions: 1, wallMin: null, runnerMinutes: 8.5, apiUsdEquivalent: 0.5 }),
        ],
      },
    },
    {
      label: 'pricier',
      bench: {
        results: [
          taskResult('t1', { score: { passed: 10, total: 10 }, interventions: 1, wallMin: 4.0, apiUsdEquivalent: 2.5 }),
        ],
      },
    },
    {
      label: 'tie-first',
      bench: {
        results: [
          taskResult('t1', { score: { passed: 10, total: 10 }, interventions: 1, wallMin: 4.0, apiUsdEquivalent: 1.25 }),
        ],
      },
    },
    {
      label: 'tie-second',
      bench: {
        results: [
          taskResult('t1', { score: { passed: 10, total: 10 }, interventions: 1, wallMin: null, runnerMinutes: 4.0, apiUsdEquivalent: 1.25 }),
        ],
      },
    },
  ]);

  assert.deepEqual(report.ranking.map((r) => r.label), ['tie-first', 'tie-second', 'pricier', 'slow']);
  assert.equal(report.ranking[3].wallMin, 8.5);
});

test('bench rank: compares only common tasks and lists tasks skipped by some labels', async () => {
  const { rank, renderMarkdown } = await loadRankModule();
  const report = rank([
    {
      label: 'all-three',
      bench: {
        results: [
          taskResult('t1', { score: { passed: 8, total: 10 }, wallMin: 3, apiUsdEquivalent: 1.0 }),
          taskResult('t2', { score: { passed: 10, total: 10 }, wallMin: 4, apiUsdEquivalent: 1.0 }),
          // High score on t3 must not lift all-three over two-only when two-only skipped t3.
          taskResult('t3', { score: { passed: 80, total: 80 }, wallMin: 20, apiUsdEquivalent: 9.0 }),
        ],
      },
    },
    {
      label: 'two-only',
      bench: {
        results: [
          taskResult('t1', { score: { passed: 9, total: 10 }, wallMin: 5, apiUsdEquivalent: 1.5 }),
          taskResult('t2', { score: { passed: 10, total: 10 }, wallMin: 5, apiUsdEquivalent: 1.5 }),
        ],
      },
    },
  ]);

  assert.deepEqual(report.commonTasks, ['t1', 't2']);
  assert.deepEqual(report.skipped, { t3: ['two-only'] });
  assert.deepEqual(report.ranking.map((r) => r.label), ['two-only', 'all-three']);
  assert.equal(report.ranking[0].passed, 19);
  assert.equal(report.ranking[0].total, 20);
  assert.equal(report.ranking[0].tasksRun, 2);
  assert.equal(report.ranking[1].passed, 18);
  assert.equal(report.ranking[1].total, 20);
  assert.equal(report.ranking[1].tasksRun, 3);
  assert.equal(report.perTask.t3['all-three'].passed, 80);
  assert.equal(report.perTask.t3['two-only'], null);

  const md = renderMarkdown(report);
  assert.match(md, /t3.*two-only/);
  assert.match(md, /\| task \| two-only \| all-three \|/);
  assert.match(md, /\| t3 \| — \| 80\/80 \(20 min\) \|/);
});

test('bench rank: partial USD is marked with a trailing asterisk in summary and markdown', async () => {
  const { summarize, rank, renderMarkdown } = await loadRankModule();
  const partialBench = {
    results: [
      taskResult('t1', { score: { passed: 15, total: 15 }, apiUsdEquivalent: 1.25, tokens: 1200, outputTokens: 300, attempts: 2, models: ['m-alpha'] }),
      taskResult('t2', { score: { passed: 10, total: 20 }, apiUsdEquivalent: null, tokens: 800, outputTokens: 200, attempts: 1, models: ['m-alpha', 'm-beta'] }),
    ],
  };
  const fullBench = {
    results: [
      taskResult('t1', { score: { passed: 15, total: 15 }, apiUsdEquivalent: 1.25, models: ['m-gamma'] }),
      taskResult('t2', { score: { passed: 10, total: 20 }, apiUsdEquivalent: 0.75, models: ['m-gamma'] }),
    ],
  };

  const sumPartial = summarize(partialBench);
  assert.equal(sumPartial.tasksRun, 2);
  assert.equal(sumPartial.passed, 25);
  assert.equal(sumPartial.total, 35);
  assert.equal(sumPartial.fullMarks, 1);
  assert.equal(sumPartial.tokens, 2000);
  assert.equal(sumPartial.outputTokens, 500);
  assert.equal(sumPartial.attempts, 3);
  assert.equal(sumPartial.usd, 1.25);
  assert.equal(sumPartial.usdPartial, true);
  assert.equal(sumPartial.usdDisplay, '1.25*');
  assert.deepEqual(sumPartial.models, ['m-alpha', 'm-beta']);

  const report = rank([
    { label: 'partial-model', bench: partialBench },
    { label: 'complete-model', bench: fullBench },
  ]);
  const md = renderMarkdown(report);
  assert.match(md, /\| 1 \| partial-model \| m-alpha, m-beta \| .* \| 1\.25\* \|/);
  assert.match(md, /\| 2 \| complete-model \| m-gamma \| .* \| 2\.00 \|/);
});

test('bench rank: missing or unreadable bench.json exits 2 and names the file', async (t) => {
  const root = makeTempRoot(t);
  const missingDir = join(root, 'no-such-run');
  const expectedPath = join(missingDir, 'bench.json');

  const cliMissing = spawnSync(process.execPath, [RANK_SCRIPT, '--label', `ghost=${missingDir}`], { encoding: 'utf8' });
  assert.equal(cliMissing.status, 2);
  assert.ok(cliMissing.stderr.includes(expectedPath), `expected stderr to name ${expectedPath}, got: ${cliMissing.stderr}`);

  const corruptDir = join(root, 'corrupt');
  mkdirSync(corruptDir, { recursive: true });
  const corruptFile = join(corruptDir, 'bench.json');
  writeFileSync(corruptFile, '{not valid json');

  const cliCorrupt = spawnSync(process.execPath, [RANK_SCRIPT, `--label=bad=${corruptDir}`], { encoding: 'utf8' });
  assert.equal(cliCorrupt.status, 2);
  assert.ok(cliCorrupt.stderr.includes(corruptFile), `expected stderr to name ${corruptFile}, got: ${cliCorrupt.stderr}`);

  const { loadBench } = await loadRankModule();
  assert.throws(() => loadBench(missingDir), (err) => err.message.includes(expectedPath));
});

test('bench rank: CLI --json shape and --out markdown file output', (t) => {
  const root = makeTempRoot(t);
  const dirA = writeBench(root, 'alpha', [
    taskResult('t1', { score: { passed: 15, total: 15 }, wallMin: 3.5, apiUsdEquivalent: 1.1, models: ['alpha-v1'] }),
    taskResult('t2', { score: { passed: 20, total: 32 }, wallMin: 7.0, apiUsdEquivalent: 2.4, models: ['alpha-v1'] }),
  ]);
  const dirB = writeBench(root, 'beta', [
    taskResult('t1', { score: { passed: 12, total: 15 }, wallMin: 2.5, apiUsdEquivalent: 0.8, models: ['beta-v1'] }),
  ]);
  const outMd = join(root, 'out', 'ranking.md');

  const run = spawnSync(
    process.execPath,
    [RANK_SCRIPT, '--label', `alpha=${dirA}`, '--label', `beta=${dirB}`, '--out', outMd, '--json'],
    { encoding: 'utf8' },
  );
  assert.equal(run.status, 0, run.stderr);

  const parsed = JSON.parse(run.stdout);
  assert.deepEqual(Object.keys(parsed).sort(), ['commonTasks', 'perTask', 'ranking', 'skipped']);
  assert.deepEqual(parsed.commonTasks, ['t1']);
  assert.deepEqual(parsed.skipped, { t2: ['beta'] });
  assert.equal(parsed.ranking.length, 2);
  assert.equal(parsed.ranking[0].label, 'alpha');
  assert.equal(parsed.ranking[0].rank, 1);
  assert.equal(parsed.ranking[0].passPct, 100);
  assert.deepEqual(parsed.perTask.t1.alpha, { passed: 15, total: 15, wallMin: 3.5 });
  assert.deepEqual(parsed.perTask.t1.beta, { passed: 12, total: 15, wallMin: 2.5 });
  assert.equal(parsed.perTask.t2.beta, null);

  const md = readFileSync(outMd, 'utf8');
  assert.match(md, /\| rank \| label \| models seen \| pass % \| passed\/total \| full-mark tasks \| interventions \| wall min \| tokens \| USD \| attempts \|/);
  assert.match(md, /\| task \| alpha \| beta \|/);
});
