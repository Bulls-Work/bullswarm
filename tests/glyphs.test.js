import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  glyphs, spinnerGlyph, asciiGlyphsPreferred, SUBSTITUTED_GLYPHS,
} from '../src/lib/glyphs.js';
import { renderDashboard, renderWorkflowTui, dashboardRows } from '../src/workflow/dashboard.js';
import { renderWatchSnapshot, watchSnapshot, renderWatchEvent } from '../src/workflow/watch-cli.js';
import { renderAnalysisProgress, renderStrategyDashboard } from '../src/strategy-dashboard.js';
import { createV2GoalDocument, createV2State } from '../src/workflow/v2-state.js';
import { applyV2PlannerResponse } from '../src/workflow/v2-planner.js';

const UTF8 = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };

test('BULLSWARM_ASCII forces the ascii table whatever the terminal claims', () => {
  assert.equal(asciiGlyphsPreferred({ ...UTF8, BULLSWARM_ASCII: '1' }), true);
  assert.equal(glyphs({ ...UTF8, BULLSWARM_ASCII: '1' }).ok, '+');
});

test('BULLSWARM_UNICODE overrides the terminal auto-detection', () => {
  const env = { ...UTF8, TERM_PROGRAM: 'Apple_Terminal' };
  assert.equal(asciiGlyphsPreferred(env), true);
  assert.equal(asciiGlyphsPreferred({ ...env, BULLSWARM_UNICODE: '1' }), false);
});

test('BULLSWARM_ASCII wins over BULLSWARM_UNICODE', () => {
  assert.equal(
    asciiGlyphsPreferred({ ...UTF8, BULLSWARM_ASCII: '1', BULLSWARM_UNICODE: '1' }),
    true,
  );
});

test('falsy env values do not switch tables', () => {
  for (const value of ['', '0', 'false']) {
    assert.equal(asciiGlyphsPreferred({ ...UTF8, BULLSWARM_ASCII: value }), false, `ASCII=${value}`);
    assert.equal(
      asciiGlyphsPreferred({ ...UTF8, TERM_PROGRAM: 'Apple_Terminal', BULLSWARM_UNICODE: value }),
      true,
      `UNICODE=${value}`,
    );
  }
});

test('Apple Terminal gets ascii; a unicode-capable terminal does not', () => {
  assert.equal(asciiGlyphsPreferred({ ...UTF8, TERM_PROGRAM: 'Apple_Terminal' }), true);
  assert.equal(asciiGlyphsPreferred({ ...UTF8, TERM_PROGRAM: 'iTerm.app' }), false);
  assert.equal(asciiGlyphsPreferred({ ...UTF8, TERM_PROGRAM: 'ghostty' }), false);
  assert.equal(asciiGlyphsPreferred(UTF8), false);
});

test('a non-UTF-8 locale or a capability-free TERM gets ascii', () => {
  assert.equal(asciiGlyphsPreferred({ LANG: 'C', TERM: 'xterm-256color' }), true);
  assert.equal(asciiGlyphsPreferred({ LC_ALL: 'en_US.ISO8859-1', TERM: 'xterm' }), true);
  assert.equal(asciiGlyphsPreferred({ ...UTF8, TERM: 'dumb' }), true);
  assert.equal(asciiGlyphsPreferred({ ...UTF8, TERM: 'linux' }), true);
  // LC_ALL outranks LANG, the same order the C library uses.
  assert.equal(asciiGlyphsPreferred({ LC_ALL: 'C', LANG: 'en_US.UTF-8', TERM: 'xterm' }), true);
});

test('every unicode glyph has a one-column pure-ascii twin', () => {
  const unicode = glyphs({ ...UTF8, BULLSWARM_UNICODE: '1' });
  const ascii = glyphs({ ...UTF8, BULLSWARM_ASCII: '1' });
  assert.deepEqual(Object.keys(ascii).sort(), Object.keys(unicode).sort());
  for (const [key, value] of Object.entries(ascii)) {
    const values = Array.isArray(value) ? value : [value];
    for (const glyph of values) {
      assert.equal(glyph.length, 1, `${key} must stay one column wide, got "${glyph}"`);
      const code = glyph.codePointAt(0);
      assert.ok(code >= 0x20 && code <= 0x7e, `${key} must be printable ascii, got U+${code.toString(16)}`);
      // "?" is the symptom this module exists to remove.
      assert.notEqual(glyph, '?', `${key} must not be a question mark`);
    }
  }
  assert.ok(ascii.spinner.length > 1, 'the ascii spinner still has to animate');
});

test('SUBSTITUTED_GLYPHS lists every unicode glyph the tables cover', () => {
  const unicode = glyphs({ ...UTF8, BULLSWARM_UNICODE: '1' });
  const expected = Object.entries(unicode)
    .flatMap(([key, value]) => (key === 'spinner' ? value : [value]));
  assert.deepEqual([...SUBSTITUTED_GLYPHS].sort(), expected.sort());
});

test('spinnerGlyph cycles and survives junk frame numbers', () => {
  const env = { ...UTF8, BULLSWARM_ASCII: '1' };
  const frames = glyphs(env).spinner;
  for (let i = 0; i < frames.length * 2; i++) {
    assert.equal(spinnerGlyph(i, env), frames[i % frames.length]);
  }
  for (const junk of [-3, NaN, undefined, null, 'x', Infinity]) {
    assert.ok(frames.includes(spinnerGlyph(junk, env)), `frame ${junk} must still resolve`);
  }
});

function v2Actions() {
  return [
    {
      id: 'audit-files', purpose: 'Audit every file', dependsOn: [], affects: ['requirement-1'],
      ownedFiles: ['audit.md'], prompt: 'Audit them.', lane: 'build', effort: 'low',
      evidenceFor: [], inputs: [], produces: ['audit'],
    },
    {
      id: 'inspect-audit', purpose: 'Inspect the audit', dependsOn: ['audit-files'], affects: [],
      ownedFiles: [], prompt: 'Inspect it.', lane: 'analyze', effort: 'low',
      evidenceFor: ['requirement-1'], inputs: ['audit'], produces: [],
    },
  ];
}

// One live run plus one finished run, so a rendered frame exercises the
// spinner, the success glyph and the waiting glyph in the same pass.
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'bs-glyphs-'));
  const runs = [];
  for (const [runId, shortId, status, running] of [
    ['wf-live', 'aaa111', 'running', true],
    ['wf-done', 'bbb222', 'completed', false],
  ]) {
    const dir = join(home, 'workflows', runId);
    mkdirSync(dir, { recursive: true });
    const document = createV2GoalDocument({
      goal: `Audit every file in ${runId}.`, cwd: home,
      requirements: [{ id: 'requirement-1', text: 'Every file is audited.', mandatory: true }],
      settings: { scout: false },
    });
    let state = createV2State(document, { runId, shortId });
    state = applyV2PlannerResponse(state, {
      schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program',
      summary: 'Audit then inspect.',
      program: { schemaVersion: 'bullswarm.workflow.program.v2', actions: v2Actions() },
    });
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    state.lifecycle = {
      status, startedAt,
      finishedAt: running ? null : new Date().toISOString(),
      resultFile: null,
    };
    if (running) {
      Object.assign(state.actions[0], { status: 'running', startedAt, attempts: 1 });
      state.attempts.push({
        id: 'audit-files-1', actionId: 'audit-files', ordinal: 1, status: 'running',
        pool: 'planner-agent', model: 'planner-v1', startedAt, finishedAt: null,
        lastActivityAt: startedAt, outputBytesObserved: 42,
      });
      state.runner = { pid: process.pid, lastHeartbeatAt: new Date().toISOString() };
    } else {
      Object.assign(state.actions[0], { status: 'succeeded', startedAt, finishedAt: new Date().toISOString(), attempts: 1 });
    }
    writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
    runs.push({ runId, dir, state });
  }
  return { home, runs, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

// Render every live-refreshing surface, at several spinner frames, so one
// missed glyph anywhere in them fails this test.
function renderEverything(home) {
  const rows = dashboardRows(home, { all: true });
  const out = [];
  for (const spinnerFrame of [0, 1, 4, 7, 9]) {
    out.push(renderDashboard({
      rows, allRows: rows, selected: 0, width: 120, height: 40, spinnerFrame,
      previewRow: rows[0], filter: 'all',
    }));
    for (const row of rows) {
      out.push(renderWorkflowTui(row, { width: 120, height: 40, spinnerFrame }));
      out.push(renderWorkflowTui(row, { width: 120, height: 40, spinnerFrame, workflowVerbose: true }));
      out.push(renderWatchSnapshot(watchSnapshot(row.runDir, row.state)));
      out.push(renderWatchSnapshot(watchSnapshot(row.runDir, row.state), { verbose: true }));
      out.push(renderWatchSnapshot(watchSnapshot(row.runDir, row.state), { heartbeat: true }));
    }
    out.push(renderAnalysisProgress({ startedAt: Date.now() - spinnerFrame * 1000 }));
  }
  for (const event of [
    { type: 'watch.attached', runId: 'wf-live', shortId: 'aaa111', status: 'running', running: 1, waiting: 1, elapsedSec: 12 },
    { type: 'action.started', actionId: 'audit-files', pool: 'p', model: 'm', attempt: 1 },
    { type: 'action.finished', actionId: 'audit-files', status: 'succeeded', durationSec: 5 },
    { type: 'action.finished', actionId: 'audit-files', status: 'blocked', why: 'dependency not satisfied' },
    { type: 'action.finished', actionId: 'audit-files', status: 'cancelled', durationSec: 5 },
    { type: 'action.finished', actionId: 'audit-files', status: 'failed', failureKind: 'timeout', why: 'slow', durationSec: 9 },
    { type: 'evidence.recorded', actionId: 'inspect-audit', requirements: [{ id: 'requirement-1', status: 'passed' }] },
    { type: 'stage.completed', label: 'Work', status: 'completed', completed: 2, total: 2 },
    { type: 'stage.completed', label: 'Work', status: 'partial', completed: 1, total: 2 },
    { type: 'plan.updated', turn: 1, summary: 'first plan' },
    { type: 'plan.updated', turn: 2, summary: 'second plan' },
    { type: 'agent.silent', actionId: 'audit-files', silentSec: 400, pool: 'p', model: 'm' },
    { type: 'cancellation.requested' },
    { type: 'pool.limit', actionId: 'audit-files', pool: 'p', resetsAt: null },
    { type: 'pool.rerouted', actionId: 'audit-files', pool: 'q', model: 'm' },
  ]) {
    out.push(String(renderWatchEvent(event) ?? ''));
  }
  const inventory = {
    providers: [{
      name: 'planner-agent', enabled: true, usedPct: 12, inflight: 2,
      models: [{ id: 'vendor/planner-v1', disabled: false, effectiveTiers: ['heavy'] }],
    }],
    routes: { heavy: { pool: 'planner-agent', model: 'planner-v1', lane: 'build', surplus: 30 } },
  };
  out.push(renderStrategyDashboard(inventory, { width: 120, height: 40 }));
  out.push(renderStrategyDashboard(inventory, { view: 'models', width: 120, height: 40 }));
  return out.join('\n');
}

function withEnv(vars, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try { return fn(); } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('ascii mode renders the live views without a single substituted glyph', () => {
  const f = fixture();
  try {
    const text = withEnv(
      { BULLSWARM_ASCII: '1', BULLSWARM_UNICODE: undefined },
      () => renderEverything(f.home),
    );
    const leaked = SUBSTITUTED_GLYPHS.filter((glyph) => text.includes(glyph));
    assert.deepEqual(leaked, [], `these glyphs still reach an ascii terminal: ${leaked.join(' ')}`);
    // The frames really were drawn, so the assertion above is not vacuous.
    assert.match(text, /Workflows/);
    assert.ok(
      glyphs({ BULLSWARM_ASCII: '1' }).spinner.some((frame) => text.includes(frame)),
      'an ascii spinner frame must appear in the live frames',
    );
  } finally { f.cleanup(); }
});

test('unicode mode still draws the braille spinner and the check mark', () => {
  const f = fixture();
  try {
    const text = withEnv(
      { BULLSWARM_UNICODE: '1', BULLSWARM_ASCII: undefined },
      () => renderEverything(f.home),
    );
    const unicode = glyphs({ BULLSWARM_UNICODE: '1' });
    assert.ok(
      unicode.spinner.some((frame) => text.includes(frame)),
      'the braille spinner must survive on a capable terminal',
    );
    assert.ok(text.includes(unicode.ok), 'the check mark must survive on a capable terminal');
  } finally { f.cleanup(); }
});
