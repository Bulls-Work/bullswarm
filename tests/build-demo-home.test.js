import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildDemoHome } from '../scripts/build-demo-home.mjs';

const FIXTURE = fileURLToPath(new URL('fixtures/home-351/', import.meta.url));
const allFiles = (root) => {
  const out = [];
  const visit = (dir) => readdirSync(dir, { withFileTypes: true }).forEach((e) => e.isDirectory() ? visit(join(dir, e.name)) : out.push(relative(root, join(dir, e.name))));
  visit(root); return out.sort();
};
const tree = (root) => allFiles(root).map((name) => `${name}\0${readFileSync(join(root, name), 'utf8')}`).join('\n');
const idShape = (value) => [...value].map((ch) => /\d/.test(ch) ? 'd' : /[a-f]/.test(ch) ? 'h' : /[a-z]/.test(ch) ? 'l' : ch).join('');

test('demo home is coherent, shifted, pool-safe, and deterministic', () => {
  const base = mkdtempSync(join(tmpdir(), 'bsw-demo-test-'));
  const source = join(base, 'source'); const a = join(base, 'a'); const b = join(base, 'b');
  try {
    cpSync(FIXTURE, source, { recursive: true });
    const privateProject = JSON.parse(readFileSync(join(source, 'history/runs.jsonl'), 'utf8').split('\n')[0]).project;
    writeFileSync(join(source, `${privateProject}-opaque.json`), `${JSON.stringify({ opaque: privateProject })}\n`);
    const now = Date.parse('2026-09-22T10:00:44Z');
    const denied = ['acme'];
    const result = buildDemoHome(source, a, { seed: 42, now, denied });
    buildDemoHome(source, b, { seed: 42, now, denied });
    assert.equal(tree(a), tree(b));
    const output = tree(a);
    assert.match(output, /storefront|billing-api|mobile-app|design-system|data-pipeline|docs-site/);
    assert.doesNotMatch(output, /claude-code:acme/i);
    assert.doesNotMatch(output, new RegExp(privateProject, 'i'));
    assert.equal(allFiles(a).some((name) => new RegExp(`acme|${privateProject}`, 'i').test(name)), false);
    assert.match(output, /claude-code:(team|alt)/);
    assert.equal(readdirSync(a).includes('pool-labels.json'), false);
    assert.ok(result.shiftMs > 0);
    assert.match(output, /2026-09-22T09:40:00\.000Z/);
    assert.ok(result.costFactor >= 0.6 && result.costFactor <= 0.9);
    for (const phrase of ['sample goal for', 'sample purpose for', 'sample response for']) assert.doesNotMatch(output, new RegExp(phrase, 'i'));
    const rows = readFileSync(join(a, 'history', 'runs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(new Set(rows.map((row) => row.goal)).size, rows.length);
    assert.ok(rows.every((row) => row.goal.length < 70));
    for (const runDir of readdirSync(join(a, 'workflows'))) {
      const state = JSON.parse(readFileSync(join(a, 'workflows', runDir, 'state.json'), 'utf8'));
      const actions = state.program?.actions ?? state.actions ?? [];
      assert.equal(new Set(actions.map((action) => action.id)).size, actions.length, `${runDir} action names are unique`);
      assert.ok(actions.every((action) => !/^(?:step|implementation)-\d+$/.test(action.id)), `${runDir} has meaningful action names`);
    }
    const today = rows.filter((row) => new Date(row.finishedAt).toLocaleDateString('en-CA') === new Date(now).toLocaleDateString('en-CA'));
    for (const pool of ['claude-code', 'claude-code:team', 'codex', 'grok', 'command-code']) {
      assert.ok(today.some((row) => Object.hasOwn(row.pools ?? {}, pool)), `${pool} has visible work today`);
    }
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('real-looking ids are remapped consistently in state, events, and directory names', () => {
  const base = mkdtempSync(join(tmpdir(), 'bsw-demo-ids-'));
  const source = join(base, 'source'); const dest = join(base, 'dest');
  const realId = 'wf-mabc1234-a1b2c3';
  const proseOnlyId = 'wf-mu0abc12-de34fa';
  const proseOnlyUuid = '019caaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee';
  const taskId = '7d6a1a54';
  try {
    mkdirSync(join(source, 'history'), { recursive: true });
    mkdirSync(join(source, 'workflows', realId), { recursive: true });
    writeFileSync(join(source, 'state.json'), '{"decisionLog":[]}\n');
    writeFileSync(join(source, 'history', 'runs.jsonl'), `${JSON.stringify({
      schemaVersion: 'bullswarm.workflow.history.v1', runId: realId, shortId: 'ab23cd',
      project: 'sample-shop', cwd: '/home/demo/projects/sample-shop', goal: 'Test consistent identifiers',
      status: 'completed', startedAt: '2026-09-20T10:00:00.000Z', finishedAt: '2026-09-20T10:10:00.000Z',
    })}\n`);
    writeFileSync(join(source, 'workflows', realId, 'state.json'), `${JSON.stringify({
      schemaVersion: 'bullswarm.workflow.state.v2', runId: realId, shortId: 'ab23cd', taskId, attempts: [],
    })}\n`);
    writeFileSync(join(source, 'workflows', realId, 'events.jsonl'), `${JSON.stringify({
      schemaVersion: 'bullswarm.workflow.event.v1', type: 'started', payload: { runId: realId, shortId: 'ab23cd' },
    })}\n`);
    writeFileSync(join(source, 'workflows', realId, 'stream-verify-attempt-1.jsonl'), `${JSON.stringify({
      seq: 1, at: '2026-09-20T10:09:00.000Z', kind: 'response', status: 'completed',
      summary: `Compared ${proseOnlyId}, bare mu0abc12-de34fa, and session ${proseOnlyUuid}.`,
      diagnostic: `Compared ${proseOnlyId}, bare mu0abc12-de34fa, and session ${proseOnlyUuid}.`,
    })}\n`);
    buildDemoHome(source, dest, { seed: 42, now: Date.parse('2026-09-22T10:00:00Z') });
    const dirs = readdirSync(join(dest, 'workflows'));
    assert.equal(dirs.length, 1);
    assert.notEqual(dirs[0], realId);
    assert.match(dirs[0], /^wf-[a-z0-9]{8}-[a-z0-9]{6}$/);
    const state = readFileSync(join(dest, 'workflows', dirs[0], 'state.json'), 'utf8');
    const events = readFileSync(join(dest, 'workflows', dirs[0], 'events.jsonl'), 'utf8');
    const stream = readFileSync(join(dest, 'workflows', dirs[0], 'stream-verify-attempt-1.jsonl'), 'utf8');
    assert.doesNotMatch(`${state}\n${events}\n${stream}`, new RegExp(realId));
    assert.doesNotMatch(stream, new RegExp(`${proseOnlyId}|mu0abc12-de34fa|${proseOnlyUuid}`));
    const [mappedFull, mappedBare, mappedUuid] = JSON.parse(stream).idReferences;
    assert.equal(mappedFull.slice(3), mappedBare);
    assert.notEqual(mappedUuid, proseOnlyUuid);
    assert.equal(idShape(mappedUuid), idShape(proseOnlyUuid));
    const mappedTaskId = JSON.parse(state).taskId;
    assert.notEqual(mappedTaskId, taskId);
    assert.equal(idShape(mappedTaskId), idShape(taskId));
    assert.match(state, new RegExp(dirs[0]));
    assert.match(events, new RegExp(dirs[0]));
  } finally { rmSync(base, { recursive: true, force: true }); }
});
