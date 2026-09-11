---
title: Operating on workflow runs
permalink: /guide/operations/
---

Every run gets a 6-character shortId (Crockford-style alphabet,
no `0/1/i/l/o` — digits and letters that are hard to mix up). The full
`wf-...` runId stays the durable handle. The **kernel** is Bullswarm's own
runtime: it owns the run directory, the result document, and the status
loop.

```bash
bullswarm workflow runs                    # ongoing only (default)
bullswarm workflow runs --all              # ongoing + historical
bullswarm workflow runs --historical       # only historical
bullswarm workflow runs --name audit-code  # filter by exact goal/name
bullswarm workflow runs --all --since 7d   # initiated in the last 7 days
bullswarm workflow runs --historical --since yesterday --until today
bullswarm workflow runs --all --from 2026-08-20 --to 2026-08-27
bullswarm workflow runs --limit 20         # cap the result count
bullswarm workflow runs show <shortId>     # state + report + summary
bullswarm workflow runs result <shortId> --json --summary  # compact status-loop envelope
bullswarm workflow runs result <shortId> --json            # full envelope (failed/partial, or before judging evidence)
bullswarm runs show <shortId>              # top-level shorthand
bullswarm workflow runs delete <shortId> --yes    # remove the run dir
```

Legacy authored-graph runs are listed as read-only rows marked `legacy`. Every
driving command prints `legacy authored-graph run <shortId>: its executor was
removed in 0.27.0; files remain under <dir>` and exits 2; historical directories
are untouched.

Run-history time filters always compare when the workflow was initiated
(`startedAt`), never when it finished. `--since` is inclusive and `--until` is
exclusive; `--started-after`/`--from` and `--started-before`/`--to` are aliases.
Values accept ISO timestamps, local `YYYY-MM-DD` dates, `today`, `yesterday`,
`tomorrow`, `now`, or relative durations such as `30m`, `24h`, `7d`, and `2w`.

## Result envelope

The result envelope is the versioned JSON document a finished workflow leaves
behind. After a workflow reaches a terminal state, agents should consume
`workflow runs result <id> --json --summary` for the status loop instead of
probing `state.json`, task files, or provider-specific output. Read the full
envelope with `--json` alone when the run is failed or partial, or before
judging evidence. The current engine's full document is the versioned
`bullswarm.workflow.result.v2` envelope with kernel-computed status, fresh
requirement evidence, per-action status/failure/output files, explicit gaps,
usage, and verification qualification. New programs include `executionMode:
"program"` and a `workspace` report with `changedFiles`, `baselineChangedFiles`,
and warnings. This is a Git status inventory, not attribution to individual
workers; files stay in the target directory. A completed program may be
unverified and contain negative evidence. `runs show` remains the low-level debugging surface.
Goal launch output includes an `instructions` handoff with four named paths:
`agentInspect` for a machine-readable snapshot, `watch` for low-noise progress,
`humanTui` for the interactive browser, and `result` for the terminal delivery.
Use `--watch` when the initiating terminal should immediately follow progress;
otherwise the command returns after printing this handoff.
Time filters preserve the existing scope, so use `--all` or `--historical` when
auditing completed runs.

## Context diet

The kernel measures — and can shrink — what it puts in front of a model.
These are UTF-8 byte counts, never tokens.

**Status loop.** Poll with `--summary`; it implies JSON (with or without
`--json`) and prints `schemaVersion: "bullswarm.workflow.result-summary.v1"`:
`runId`, `shortId`, `status`, `verified`, `executionMode`, `reason`,
`finishedAt`, the goal's first line (120 characters) plus `goalBytes`, each
requirement as `{ id, status, mandatory, evidenceCount, why }`, each action as
`{ id, kind, lane, effort, status, pool, model, reasoning, wallSec, outFile,
bytes }`, `concerns: { count, first }`, `usage`, and `next: { full, runDir, outputs }` — every output name is a basename inside `next.runDir`.
`--summary` is single-line JSON (`JSON.stringify`), so the bytes on the wire
match the 4,096-byte fitter budget. As printed by the CLI on
`tests/fixtures/real-result-ze5xz2.json`, the compact summary is 3,786 bytes
and the pretty full envelope (`--json` alone) is 60,709 bytes.
The full `bullswarm.workflow.result.v2` envelope is unchanged and remains the
default. Read it (`--json` alone) on a failed or partial run, or before judging
evidence. A terminal `workflow watch` prints the same compact command as
`next:`.

```bash
bullswarm workflow runs result <shortId> --json --summary
bullswarm workflow runs result <shortId> --json
```

`workflow runs result --help` states `Usage: bullswarm workflow runs result
<shortId|runId> [--json] [--summary]`; `--summary` is "print the compact JSON
status-loop envelope; implies --json".

**Bytes.** Every attempt records `bytes: { taskFile, authorPrompt, kernel,
dependencyInputs, output }` — the task file the kernel wrote, the action's own
prompt as authored, the remainder after subtracting that prompt and any
embedded requirement text, the sum of the dependency output files the task
points at (0 when there are none), and the durable out file on completion.
The result envelope copies the last attempt's `bytes` onto `actions[]` and
totals `usage.bytes: { taskFiles, dependencyInputs, outputs }`.
`workflow runs show` appends `in <taskFile>/<dependencyInputs> out <output>`
per attempt (blank when unrecorded). Missing values are null, never guessed.

**Digest.** `kind: "digest"` is analyze/low. It is an extractive condensation
of its dependencies' outputs — quoted delivered items, validation numbers,
commands, unfinished work, and integrator requests; no verdicts of its own.
The kernel writes the whole task; the author's prompt is focus guidance only.
Use one when three or more writers feed a single integrator, or when a
consumer's dependency outputs would exceed roughly 20 KB. A digest must
depend on at least one action, owns no files, has empty `evidenceFor`, and
needs no `affects`. Evidence must not depend on a digest: evidence reads the
real artifacts. Consumers that depend on a digest receive that digest plus a
`digestOf` array of `{ actionId, outputFile }` so they can drill down; those
paths are pointers, not extra `dependencyInputs`. (The kind table in
[Workflows](./workflows.md#kinds) derives lane and effort.)

```json
{
  "schemaVersion": "bullswarm.workflow.program.v2",
  "actions": [
    { "id": "write-a", "kind": "implement", "dependsOn": [], "ownedFiles": ["a.ts"], "affects": ["requirement-1"], "evidenceFor": [], "purpose": "Write slice A", "prompt": "Implement A and report the checks you ran." },
    { "id": "write-b", "kind": "implement", "dependsOn": [], "ownedFiles": ["b.ts"], "affects": ["requirement-2"], "evidenceFor": [], "purpose": "Write slice B", "prompt": "Implement B and report the checks you ran." },
    { "id": "write-c", "kind": "implement", "dependsOn": [], "ownedFiles": ["c.ts"], "affects": ["requirement-3"], "evidenceFor": [], "purpose": "Write slice C", "prompt": "Implement C and report the checks you ran." },
    { "id": "condense", "kind": "digest", "dependsOn": ["write-a", "write-b", "write-c"], "ownedFiles": [], "affects": [], "evidenceFor": [], "purpose": "Condense the writer outputs", "prompt": "Keep every acceptance number and every shared-file request." },
    { "id": "integrate", "kind": "integration", "dependsOn": ["condense"], "ownedFiles": [], "affects": ["requirement-1", "requirement-2", "requirement-3"], "evidenceFor": [], "purpose": "Integrate and run the gates", "prompt": "Apply every request the digest carries and run the repository gates." }
  ]
}
```

An evidence action for those requirements depends on `write-a`, `write-b`, and
`write-c` — never on `condense`.

Live operation of a run — watching, steering, cancelling, resuming, and the
TUI — is covered in [Dashboard](./dashboard.md).
