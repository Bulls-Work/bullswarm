#!/usr/bin/env node
// Rank multiple `run-bench.mjs` output directories on the tasks every label ran.
//
//   node bench/eval-suite/rank.mjs --label <name>=<dir> [--label <name>=<dir> ...] [--out <file.md>] [--json]

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const round = (n, d = 1) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);
const escapeCell = (value) => String(value).replace(/\|/g, '\\|');

function taskWallMin(r) {
  if (Number.isFinite(r?.wallMin)) return r.wallMin;
  if (Number.isFinite(r?.runnerMinutes)) return r.runnerMinutes;
  return null;
}

export function loadBench(dir) {
  if (typeof dir !== 'string' || !dir.trim()) {
    throw new Error('bench directory path is required');
  }
  const file = dir.endsWith('.json') ? dir : join(dir, 'bench.json');
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`cannot read ${file}: ${err.message}`);
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    throw new Error(`cannot read ${file}: invalid JSON (${err.message})`);
  }
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.results)) {
    throw new Error(`cannot read ${file}: expected an object with a results array`);
  }
  return doc;
}

export function summarize(input, opts = {}, maybeOpts = {}) {
  let label = null;
  let source = input;
  let options = opts ?? {};
  if (typeof input === 'string') {
    label = input;
    source = opts;
    options = maybeOpts ?? {};
  }
  const allResults = Array.isArray(source)
    ? source
    : Array.isArray(source?.results)
      ? source.results
      : Array.isArray(source?.bench?.results)
        ? source.bench.results
        : null;
  if (!allResults) {
    throw new TypeError('summarize expects a bench object with results or a results array');
  }
  if (label == null && typeof source?.label === 'string') label = source.label;
  if (options.label != null) label = options.label;

  const taskSet = options.onlyTasks ? new Set(options.onlyTasks) : null;
  const selected = taskSet ? allResults.filter((r) => taskSet.has(r.id)) : allResults;
  const taskTotals = options.taskTotals instanceof Map ? options.taskTotals : null;

  let passed = 0;
  let total = 0;
  let fullMarks = 0;
  let interventions = 0;
  let wallSum = 0;
  let tokens = 0;
  let outputTokens = 0;
  let usdSum = 0;
  let usdPartial = false;
  let attempts = 0;

  for (const r of selected) {
    const p = Number.isFinite(r?.score?.passed) ? r.score.passed : 0;
    const t = Number.isFinite(r?.score?.total)
      ? r.score.total
      : (taskTotals?.get(r?.id) ?? 0);
    passed += p;
    total += t;
    if (t > 0 && p === t) fullMarks += 1;
    interventions += Number.isFinite(r?.interventions) ? r.interventions : 0;
    wallSum += taskWallMin(r) ?? 0;
    tokens += Number.isFinite(r?.tokens) ? r.tokens : 0;
    outputTokens += Number.isFinite(r?.outputTokens) ? r.outputTokens : 0;
    if (Number.isFinite(r?.apiUsdEquivalent)) {
      usdSum += r.apiUsdEquivalent;
    } else {
      usdPartial = true;
    }
    attempts += Number.isFinite(r?.attempts) ? r.attempts : 0;
  }

  const modelSource = selected.length ? selected : allResults;
  const models = [
    ...new Set(
      modelSource.flatMap((r) => (Array.isArray(r?.models) ? r.models : [])).filter(Boolean),
    ),
  ];
  const passPct = total > 0 ? round((100 * passed) / total, 1) : 0;
  const wallMin = round(wallSum, 2);
  const usd = round(usdSum, 2);
  const usdDisplay = `${usd.toFixed(2)}${usdPartial ? '*' : ''}`;

  return {
    ...(label != null ? { label } : {}),
    tasksRun: allResults.length,
    models,
    passed,
    total,
    passPct,
    fullMarks,
    interventions,
    wallMin,
    tokens,
    outputTokens,
    usd,
    usdPartial,
    usdDisplay,
    attempts,
  };
}

function normalizeBench(val) {
  if (Array.isArray(val)) return { meta: {}, results: val };
  if (val && typeof val === 'object' && Array.isArray(val.results)) return val;
  throw new TypeError('each entry requires a bench object with a results array');
}

function normalizeEntries(input) {
  if (input instanceof Map) {
    return [...input.entries()].map(([label, val]) => ({ label, bench: normalizeBench(val) }));
  }
  if (Array.isArray(input)) {
    return input.map((item) => {
      if (Array.isArray(item)) return { label: String(item[0]), bench: normalizeBench(item[1]) };
      const label = item?.label ?? item?.name;
      if (typeof label !== 'string' || !label) {
        throw new TypeError('each rank entry requires a non-empty label');
      }
      const bench = item.bench ? normalizeBench(item.bench) : normalizeBench(item);
      return { label, bench };
    });
  }
  if (input && typeof input === 'object') {
    return Object.entries(input).map(([label, val]) => ({ label, bench: normalizeBench(val) }));
  }
  throw new TypeError('rank expects an array of { label, bench } entries or a { [label]: bench } map');
}

export function rank(input) {
  const entries = normalizeEntries(input);
  const byLabelTasks = entries.map((entry) => {
    const map = new Map();
    for (const r of entry.bench.results) {
      if (r?.id != null) map.set(String(r.id), r);
    }
    return map;
  });

  const allTaskSet = new Set();
  const taskTotals = new Map();
  for (const map of byLabelTasks) {
    for (const [id, r] of map.entries()) {
      allTaskSet.add(id);
      if (Number.isFinite(r?.score?.total) && !taskTotals.has(id)) {
        taskTotals.set(id, r.score.total);
      }
    }
  }

  const allTasks = [...allTaskSet].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  const commonTasks = entries.length
    ? allTasks.filter((id) => byLabelTasks.every((map) => map.has(id)))
    : [];

  const skipped = {};
  for (const id of allTasks) {
    const missingLabels = entries
      .filter((_, i) => !byLabelTasks[i].has(id))
      .map((e) => e.label);
    if (missingLabels.length > 0) {
      skipped[id] = missingLabels;
    }
  }

  const scored = entries.map((entry, index) => {
    const summary = summarize(entry.bench, {
      label: entry.label,
      onlyTasks: commonTasks,
      taskTotals,
    });
    const rate = summary.total > 0 ? summary.passed / summary.total : 0;
    return { summary, rate, index };
  });

  scored.sort((a, b) => {
    if (Math.abs(b.rate - a.rate) > 1e-12) return b.rate - a.rate;
    if (a.summary.interventions !== b.summary.interventions) {
      return a.summary.interventions - b.summary.interventions;
    }
    if (a.summary.wallMin !== b.summary.wallMin) {
      return a.summary.wallMin - b.summary.wallMin;
    }
    if (a.summary.usd !== b.summary.usd) {
      return a.summary.usd - b.summary.usd;
    }
    return a.index - b.index;
  });

  const ranking = scored.map((item, i) => ({
    rank: i + 1,
    ...item.summary,
  }));

  const entryByLabel = new Map(entries.map((e, i) => [e.label, byLabelTasks[i]]));
  const perTask = {};
  for (const id of allTasks) {
    perTask[id] = {};
    for (const row of ranking) {
      const r = entryByLabel.get(row.label)?.get(id);
      if (!r) {
        perTask[id][row.label] = null;
      } else {
        const wall = taskWallMin(r);
        perTask[id][row.label] = {
          passed: Number.isFinite(r?.score?.passed) ? r.score.passed : 0,
          total: Number.isFinite(r?.score?.total) ? r.score.total : (taskTotals.get(id) ?? null),
          wallMin: wall == null ? null : round(wall, 2),
        };
      }
    }
  }

  return { ranking, perTask, commonTasks, skipped };
}

export function renderMarkdown(report) {
  const ranking = report?.ranking ?? [];
  const perTask = report?.perTask ?? {};
  const skipped = report?.skipped ?? {};

  const lines = [
    '# Benchmark ranking',
    '',
    '| rank | label | models seen | pass % | passed/total | full-mark tasks | interventions | wall min | tokens | USD | attempts |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
  ];

  for (const row of ranking) {
    const models = row.models?.length ? escapeCell(row.models.join(', ')) : '—';
    const passCell = row.total > 0 ? `${row.passPct}%` : '—';
    const usdCell = row.usdDisplay ?? `${Number(row.usd ?? 0).toFixed(2)}${row.usdPartial ? '*' : ''}`;
    lines.push(
      `| ${row.rank} | ${escapeCell(row.label)} | ${models} | ${passCell} | ${row.passed}/${row.total} | ${row.fullMarks} | ${row.interventions} | ${row.wallMin} | ${row.tokens.toLocaleString('en-US')} | ${usdCell} | ${row.attempts} |`,
    );
  }

  const skippedEntries = Object.entries(skipped);
  if (skippedEntries.length > 0) {
    const parts = skippedEntries.map(([task, labels]) => `${task} (skipped by ${labels.join(', ')})`);
    lines.push('', `Skipped tasks (not in ranking): ${parts.join('; ')}.`);
  }

  const labels = ranking.map((row) => row.label);
  const tasks = Object.keys(perTask);
  if (labels.length > 0 && tasks.length > 0) {
    lines.push(
      '',
      '## Per-task',
      '',
      `| task | ${labels.map(escapeCell).join(' | ')} |`,
      `|---|${labels.map(() => '---').join('|')}|`,
    );
    for (const task of tasks) {
      const cells = labels.map((label) => {
        const cell = perTask[task]?.[label];
        if (!cell) return '—';
        return `${cell.passed}/${cell.total ?? '?'} (${cell.wallMin ?? '—'} min)`;
      });
      lines.push(`| ${escapeCell(task)} | ${cells.join(' | ')} |`);
    }
  }

  return `${lines.join('\n')}\n`;
}

function parseArgs(argv) {
  const out = { labels: [], out: null, json: false };
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split(/=(.*)/s);
    const nextValue = (name) => {
      if (inline !== undefined) return inline;
      if (i + 1 >= argv.length) throw new Error(`${name} requires a value`);
      i += 1;
      return argv[i];
    };
    if (flag === '--label') {
      const spec = nextValue('--label');
      const eq = spec.indexOf('=');
      const label = eq > 0 ? spec.slice(0, eq).trim() : '';
      const dir = eq > 0 ? spec.slice(eq + 1).trim() : '';
      if (!label || !dir) {
        throw new Error(`invalid --label "${spec}" (expected <name>=<dir>)`);
      }
      if (seen.has(label)) {
        throw new Error(`duplicate --label "${label}"`);
      }
      seen.add(label);
      out.labels.push({ label, dir });
    } else if (flag === '--out') {
      const target = nextValue('--out').trim();
      if (!target) throw new Error('--out requires <file.md>');
      out.out = target;
    } else if (flag === '--json') {
      if (inline !== undefined) throw new Error('--json takes no value');
      out.json = true;
    } else {
      throw new Error(`unknown flag ${flag}`);
    }
  }
  if (out.labels.length === 0) {
    throw new Error('usage: node bench/eval-suite/rank.mjs --label <name>=<dir> [--label <name>=<dir> ...] [--out <file.md>] [--json]');
  }
  return out;
}

function main(argv) {
  try {
    const opts = parseArgs(argv);
    const entries = opts.labels.map(({ label, dir }) => ({
      label,
      bench: loadBench(dir),
    }));
    const report = rank(entries);
    const md = renderMarkdown(report);
    if (opts.out) {
      mkdirSync(dirname(opts.out), { recursive: true });
      writeFileSync(opts.out, md);
    }
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(md);
    }
    return 0;
  } catch (err) {
    console.error(err.message);
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
