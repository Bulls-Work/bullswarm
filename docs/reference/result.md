---
title: Result envelope
description: Field-by-field JSON returned by bullswarm run --json and workflow runs result --json.
---

# Result envelope

After this page you can parse `bullswarm run --json` and `bullswarm workflow runs result --json` without opening `state.json`, and know which fields mean the work is done versus merely launched.

Judge delegate output by content, not exit code. A clean process exit is not proof of success. Read `ok` / `verified` and the saved artifact before treating a run as done.

## run --json

`bullswarm run --json` prints one verdict object. Without `--json` it prints a one-line `OK`/`FAIL` summary and, on `--dry-run`, the command and a `forecast:` line.

```bash
# Dispatch one bounded task and print the verdict document.
bullswarm run --lane analyze --add-dir . --json "List every TODO in src/ with file:line"
```

| Field | Meaning |
|---|---|
| `ok` | `true` when the content judge passed **and** the process exited 0. `false` on a failed judge, a non-zero exit, spawn failure, timeout, stall, quota, or auth |
| `keepOnClaude` | `true` when routing kept the task on the calling agent instead of spawning a delegate. `ok` is then `true` and `pick.pool` is `null` |
| `why` | one-line reason. Success is `verified`. A non-zero exit with passing content is `verified content but non-zero exit` |
| `pick.pool` | pool that ran, or `null` when kept on the caller |
| `pick.model` | model id sent to the CLI |
| `pick.command` | argv template (`spawn.cmd`). On `--dry-run` this is the resolved argv including the clamped reasoning flag |
| `outFile` | `~/.bullswarm/runs/out-<stamp>.md` (or `$BULLSWARM_HOME/runs/...`) — the extracted answer. Always read this when `ok` is true |
| `taskFile` | the prompt file the worker was given |
| `contentUsableDespiteExit` | `true` when `ok` is false, the process exited non-zero, and the content judge still passed. Do not discard that `outFile` |
| `failureKind` | present on failure: `quota`, `auth`, `provider`, `process`, `schema`, `stalled` |
| `quarantineHint` | `true` on auth or quota; the pool is benched until `quarantinedUntil` |
| `quarantineUntil` / `quarantineSource` | quota reset deadline and whether it came from the provider message or the cached 5-hour meter |
| `quarantinedSiblings` | other pools in the same `credentialGroup` benched on an **auth** failure. Quota never spreads |
| `cancelled` | `true` when a workflow cancellation stopped the worker |
| `dryRun` | `true` on `--dry-run`. Nothing was spawned, logged, or registered in the assignment ledger |
| `forecast` | the numbers routing compared: `inflight`, `projectedFiveHourPct`, `forecastFiveHourPct`, `expectedMinutes`, `ratePerMinute`, `estimateSource` |
| `candidates` | routing candidate rows (dry-run and keep-on-caller include this) |
| `reasoning` | `{ requested, applied, source, clamped }` — the level this attempt actually ran at |
| `meta.exitCode`, `meta.signal`, `meta.timedOut`, `meta.stalled`, `meta.cancelled` | process observation |
| `meta.wallSec`, `meta.outBytes` | duration and extracted output size |
| `meta.usage` | token/cost estimate. When the CLI did not report counters, this is a labelled UTF-8-byte/4 estimate with standard-read, cache-read, cache-write, and output broken out. API-equivalent cost stays `null` unless the connector and a subscription can support it |
| `structured` | only when an output validator ran (workflow evidence): `{ ok, errors, value? }` |

`--dry-run` prints `ok`, `dryRun: true`, `keepOnClaude`, `why`, `forecast`, `candidates`, `pick` (resolved argv including the clamped reasoning flag), and `reasoning`. It omits `outFile`, `taskFile`, `contentUsableDespiteExit`, `meta`, and quarantine fields, because nothing was spawned. `--dry-run` with no eligible pool and `keepOnClaude: true` still exits 0. `--dry-run` that cannot pick and cannot keep the task sets `ok: false` and exits 1.

::: warning
`ok: true` with `keepOnClaude: true` means the caller should do the work itself. It is not a completed delegate. The skill documents this as `keepOnClaude: true`.
:::

## workflow runs result --json

After a workflow reaches a terminal state, consume this envelope instead of probing `state.json` or provider-specific output. `runs show` remains the low-level debugging surface.

```bash
# Compact status-loop envelope (implies --json). Use this to poll.
bullswarm workflow runs result <shortId> --json --summary
# Full versioned document. Read this on failed or partial runs, or before judging evidence.
bullswarm workflow runs result <shortId> --json
```

The full document is `schemaVersion: "bullswarm.workflow.result.v2"`. Allowed top-level fields:

| Field | Meaning |
|---|---|
| `schemaVersion` | `bullswarm.workflow.result.v2` |
| `runId` | durable `wf-...` id |
| `shortId` | 6-character Crockford-style handle (no `0/1/i/l/o`) |
| `intentId` | goal/intent id |
| `goal` | the goal text as launched |
| `status` | `completed`, `partial`, or `cancelled` |
| `verified` | `true` only when `status` is `completed` **and** every mandatory requirement has passing evidence. A completed program can be unverified |
| `reason` | one-line outcome. Completed-but-unverified names which requirement is open |
| `executionMode` | `"program"` on caller-authored (and dispatched-planner) programs |
| `workspace` | Git status inventory on program runs: `cwd`, `changedFiles`, `baselineChangedFiles`, `warnings`. Not per-worker attribution; files stay in the target directory |
| `requirements[]` | ledger: `id`, `text`, `mandatory`, `status` (`pending`/`passed`/`failed`/`blocked`), `workRevision`, `evidence[]` |
| `actions[]` | `id`, `purpose`, `status`, `outputFile`, `artifactIds`, `reasoning`, `kind`, `bytes`, and on program runs `failure` |
| `gaps` | `null` on a verified completed run; otherwise `bullswarm.workflow.gaps.v2` with open requirements and failed/blocked/cancelled/interrupted actions |
| `usage` | `{ total, byPool, bytes: { taskFiles, dependencyInputs, outputs } }` — UTF-8 byte counts, never tokens |
| `finishedAt` | ISO timestamp |
| `handback` | present unless the run is completed, verified, and has no unread steering. See below |

Requirement `status` values: `pending`, `passed`, `failed`, `blocked`. Action `status` values: `pending`, `ready`, `running`, `waiting`, `succeeded`, `failed`, `blocked`, `cancelled`, `interrupted`, `removed`.

Each requirement `evidence[]` entry is `{ sourceAction, status, evidence, concerns, eventSequence, mechanicalFailure? }`. Only evidence from the current `workRevision` is current. Negative evidence does not open another planner round.

Each action `bytes` is `{ taskFile, authorPrompt, kernel, dependencyInputs, output }` — the task file the kernel wrote, the action's own prompt, the remainder after subtracting that prompt, the sum of dependency output files (0 when there are none), and the durable out file. Missing values are `null`, never guessed.

`failure` is `{ kind, message? }`. Kinds a plain `workflow resume` can retry: `provider`, `quota`, `auth`, `process`, `unavailable`, `interrupted`, `runtime`, `schema`, `stalled`. A check that failed the work, or a semantic failure, is not retried; add a fix step or name the id in `plan revise --rerun`.

## Compact summary

`--summary` implies `--json` and prints `schemaVersion: "bullswarm.workflow.result-summary.v1"` as a single `JSON.stringify` line, fitted under a 4,096-byte budget.

| Field | Meaning |
|---|---|
| `runId`, `shortId` | same ids as the full envelope |
| `status`, `verified`, `executionMode`, `reason`, `finishedAt` | same facts, compacted |
| `goal` | first line of the goal, at most 120 characters, plus `goalBytes` |
| `requirements[]` | `{ id, status, mandatory, evidenceCount, why }`. `why` is filled only when the requirement is not `passed` |
| `actions[]` | `{ id, kind, lane, effort, status, pool, model, reasoning, wallSec, outFile, bytes }`. `outFile` is a basename inside `next.runDir` |
| `concerns` | `{ count, first }` — first few concern strings from requirement evidence |
| `usage` | copied from the full envelope |
| `handback` | compacted unfinished steps, unread steering, and `options` commands |
| `next` | `{ full, runDir, outputs }`. `full` is the command for the full envelope. Every `outputs` entry is a basename inside `runDir` |

If the summary would exceed 4,096 bytes, fields shrink in a fixed order (concerns, then per-action detail, then an open requirement's `why` last).

## handback

Anything short of a verified run with no unread guidance is handed back. The run never waits for the caller.

| Field | Meaning |
|---|---|
| `unfinished[]` | `{ id, status, failureKind, why, retryAfter?, retryable }` for every action that is not `succeeded` or `removed` |
| `unresolvedRequirements[]` | `{ id, status, why }` for every requirement that is not `passed` |
| `unreadSteering[]` | `{ id, message, queuedAt }` guidance queued with `workflow steer` that nobody acted on |

The compact summary adds `options`:

| Option | When | Command it names |
|---|---|---|
| `continue` | program-mode run whose plan needs a fix, a new step, or a redo | `workflow plan export` then `plan revise` |
| `retry` | at least one unfinished step is retryable | `workflow resume` (with `retryAfter` when every retry waits on a paused pool) |
| `takeOver` | always offered when handback exists | do the unfinished work yourself; the full envelope names every `outputFile` |
| `restart` | the goal or the approach was wrong | a new `workflow goal --program` |

`retry` is omitted when nothing is retryable. `workflow resume` on a finished run with nothing retryable prints `nothing to retry`, starts nothing, and exits 1.

## Launch versus result

`workflow goal --json` without `--foreground` prints a launch document (`schemaVersion: "bullswarm.goal.launcher.v2"`), not a result. It includes an `instructions` handoff with four named paths: `agentInspect`, `watch`, `humanTui`, and `result`. Use `--watch` when the initiating terminal should follow progress; otherwise the command returns after printing that handoff.

A dead kernel with no terminal state is diagnosable: `workflow watch`, `runs show`, and the TUI print the last 20 lines of `~/.bullswarm/goals/<runId>/stderr.log`.

Legacy authored-graph runs are listed as `legacy` rows. Driving commands, including `runs result`, print `legacy authored-graph run <shortId>: its executor was removed in 0.27.0; files remain under <dir>` and exit 2.

## Next steps

- [CLI reference](/reference/cli) — `run` and `workflow runs result` flags
- [Observing](/guide/observing) — watch, TUI, and the status loop
- [Workflow program](/reference/program) — the graph whose outcomes this envelope reports
