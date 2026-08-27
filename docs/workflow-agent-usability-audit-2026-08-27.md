# Workflow agent usability audit — 2026-08-27

## Executive result

Four isolated, dependency-free Node projects were given to four entry paths:

1. direct invocation of the checkout CLI;
2. Claude Code, asked in natural language to use Bullswarm;
3. Grok, asked in natural language to use Bullswarm;
4. Command Code (`cmd`), asked in natural language to use Bullswarm.

All four paths created detached `workflow goal` runs without hand-authored workflow JSON. All four runs reached durable `completed` / `delivered` state, included a worker action and a first-class `verify` action, and produced implementations that passed an independent post-run test. The three agent initiators did not edit their projects directly.

The feature is functionally usable by all four paths, but it is not yet frictionless as a distributed CLI experience. The checkout is version 0.7.2 while both the `bullswarm` on `PATH` and the current npm package are 0.4.0. The launch response emits bare `bullswarm workflow ...` observation commands, which fail in this environment even though the detached run was correctly launched through the checkout source. Claude, Grok, and Command Code all had to discover and explain this mismatch.

## Test method

- Shared isolated state: `/tmp/bullswarm-usability-EsM9ev/home`
- Isolated projects: sibling `direct`, `claude`, `grok`, and `cmd` directories
- Runtime dependencies: none; each project used Node's built-in test runner
- Initial state: direct failed 2/3, Claude failed 3/3, Grok failed 3/3, Command Code failed 3/3
- Agent prompt constraint: use Bullswarm, do not edit directly, do not author workflow JSON, detach, and return the run ID plus observation commands
- Acceptance: terminal workflow state, inspect the persisted graph/attempts/decisions/report/events, then independently run `npm test` in each fixture
- Test integrity: test files retained their original modification time while implementation files changed; their final SHA-256 values were recorded below

The initiators were given the checkout path and the canonical `skill/SKILL.md`, but not the `workflow goal` command syntax. This tests whether they can select the intended surface without making CLI discovery itself an unbounded research task.

## Summary

| Entry path | Initiation result | Approx. foreground launch time | Run | Workflow runtime | Dynamic result | Independent result | Friction verdict |
|---|---:|---:|---|---:|---|---|---|
| Direct checkout CLI | success | 2.6 s | `wf-mtbiwjf1-0eca29` / `k6zkba` | 10m 50s | verifier found an untested formatting defect; planner added repair + second verify | 3/3 pass | Low invocation friction; high model latency, valuable recovery |
| Claude Code | success | ~4m 08s | `wf-mtbj96ey-6276a5` / `vxxps2` | 3m 55s | implement + verify + terminal decision | 3/3 pass | Works, but foreground initiation is too slow and over-instrumented |
| Grok | success | ~1m 35s | `wf-mtbjcdzw-b070a8` / `wykuwi` | 3m 42s | first verifier was content-empty; retry routed to Command Code and passed | 3/3 pass | Best agent UX; progressive status and concise handoff |
| Command Code | success | ~5m 39s | `wf-mtbjkys1-435fe4` / `8ve272` | 4m 00s | implement + verify + terminal decision | 3/3 pass | Works, but the launch turn was silent and much too slow |

Times are wall-clock observations of local subscription CLIs, not benchmark claims about the underlying models.

## Trial 1 — direct CLI

### Goal

Repair a duration parser/formatter to support positive decimals and surrounding whitespace, reject malformed/non-positive values, preserve exports, choose the largest exact display unit, and round-trip.

### Invocation

```bash
BULLSWARM_HOME=/tmp/bullswarm-usability-EsM9ev/home \
node /Users/cowcow02/Repo/bullswarm/bin/bullswarm.js workflow goal \
  "Repair the duration utility ... and require an independent verification step before completion." \
  --cwd=/tmp/bullswarm-usability-EsM9ev/direct --detach --json
```

The command returned in 2.6 seconds with run ID, short ID, PID, status, log paths, and summary/dashboard/event observation commands. Auto-routing selected Grok for orchestration.

### Persisted run steps

| Order | Action | Type | Pool | Outcome |
|---:|---|---|---|---|
| 1 | `orchestrator` attempt 1 | decide | Grok | proposed initial implementation + verify |
| 2 | `fix-duration-utility` | run | Grok | succeeded; public suite passed |
| 3 | `verify-duration-fix` | verify | Grok | valid JSON verdict with `ok:false` |
| 4 | `orchestrator` attempt 2 | decide | Grok | accepted the concern and added focused recovery |
| 5 | `fix-format-duration` | run | Grok | repaired decimal largest-unit formatting |
| 6 | `verify-format-duration` | verify | Grok | `ok:true`, no concerns |
| 7 | `orchestrator` attempt 3 | decide | Grok | `complete`, accepted |

The first verifier found a real gap that the public test did not assert: `formatDuration(2500)` returned `2500ms` rather than `2.5s`, and `formatDuration(75000)` returned `75s` rather than `1.25m`. The workflow did not accept green tests as sufficient; it expanded from three planned actions to five durable actions and two expansion rounds. Final state used 7 dispatches, produced 79 events, and was `completed` / `delivered`.

One observability subtlety should be clarified in the UI/docs: the verify action's process/action ledger status is `succeeded` because it produced a valid verdict, while the report step is `ok:false` because the verdict rejected the work. That distinction is correct but easy to misread.

### Acceptance

Independent `npm test`: 3 passed, 0 failed. Test file SHA-256: `f07c1bad954c9faf5a35c168f1dea667f214841ccabdded61e817943be25f321`.

## Trial 2 — Claude initiates Bullswarm

### Natural-language handoff

Claude was asked to use Bullswarm to repair case-insensitive header merging, block prototype-polluting keys, reject non-string values, preserve inputs, detach, and report how to observe the work. It was explicitly told not to edit directly or write workflow JSON.

Claude read the guide, ran a baseline, diagnosed the installed/check-out version skew, invoked the checkout's `workflow goal`, checked initial events, and returned the run ID and checkout-qualified observation commands. It also created a temporary background watcher; no watcher remained after completion.

### Persisted run steps

| Order | Action | Type | Pool | Outcome |
|---:|---|---|---|---|
| 1 | `orchestrator` attempt 1 | decide | Grok | proposed implement + verify |
| 2 | `implement-merge-headers` | run | Grok | succeeded |
| 3 | `verify-merge-headers` | verify | Grok | `ok:true` |
| 4 | `orchestrator` attempt 2 | decide | Grok | `complete`, accepted |

Final state used 4 dispatches, one expansion round, and 49 events. The run was `completed` / `delivered` in 3m 55s.

### Acceptance and friction

Independent `npm test`: 3 passed, 0 failed. Test file SHA-256: `d1f11816651030ed285a92e3c69e96d357e9a275b763b5810cebe08dcdf52647`.

Claude's reasoning was accurate and its handoff was the most detailed, but launching a detached job took about 4m 08s in the foreground. Baseline/doctor/event checks are useful, yet a detached launcher should normally hand back the durable ID much sooner and let observation happen separately.

## Trial 3 — Grok initiates Bullswarm

### Natural-language handoff

Grok was asked to repair an async retry helper: initial attempt plus configured retries, `onRetry` only between attempts, pre-invocation validation, full tests, detached execution, and no direct edits/JSON graph.

Grok progressively reported three useful stages—reading the guide, checking readiness, then launching—and returned the durable IDs and checkout-qualified observation commands in about 1m 35s.

### Persisted run steps

| Order | Action | Type | Pool | Outcome |
|---:|---|---|---|---|
| 1 | `orchestrator` attempt 1 | decide | Grok | proposed implement + verify |
| 2 | `fix-retry` | run | Grok | succeeded |
| 3 | `verify-retry` attempt 1 | verify | Grok | `failed_retryable`: announcement without substance |
| 4 | `verify-retry` attempt 2 | verify | Command Code | succeeded with a substantive `ok:true` verdict |
| 5 | `orchestrator` attempt 2 | decide | Grok | `complete`, accepted |

This is strong evidence for the content-first doctrine: Bullswarm rejected a zero-substance verifier response despite process success, retried on a different eligible pool, and only then accepted the workflow. Final state used 5 dispatches, one expansion round, and 56 events; runtime was 3m 42s.

### Acceptance

Independent `npm test`: 3 passed, 0 failed. Test file SHA-256: `1695025b7f107261610810a8fdd29e8b54ca68966fa31be66047d6c496843fee`.

## Trial 4 — Command Code initiates Bullswarm

### Natural-language handoff

Command Code was asked to implement deterministic topological ordering, cycle reporting, unknown-node validation, and input immutability through Bullswarm, with the same detach/no-direct-edit/no-JSON constraints.

It correctly read the guide, discovered the version skew, invoked checkout source, and returned a durable run ID. The human-facing `cmd` entry point and Bullswarm connector's `command-code` binary alias both exist locally at version 1.36.0, so there was no connector alias failure.

### Persisted run steps

| Order | Action | Type | Pool | Outcome |
|---:|---|---|---|---|
| 1 | `orchestrator` attempt 1 | decide | Grok | proposed implement + verify |
| 2 | `fix-graph-module` | run | Grok | succeeded |
| 3 | `verify-graph-tests` | verify | Grok | `ok:true` |
| 4 | `orchestrator` attempt 2 | decide | Grok | `complete`, accepted |

Final state used 4 dispatches, one expansion round, and 49 events. Runtime was 4m 00s.

### Acceptance and friction

Independent `npm test`: 3 passed, 0 failed. Test file SHA-256: `f8eacb470b336b5e5b57a6b673be63d44ddb57b3a5112a8735afab8828ea40b6`.

The initiation turn was silent for about 5m 39s before returning. It also printed bare `bullswarm workflow ...` observation commands even after explaining that bare `bullswarm` is version 0.4.0, so its handoff was internally inconsistent.

## Cross-cutting findings

### What worked without steering

- Every initiator selected `workflow goal`, not drafts or a hand-built JSON graph.
- `--detach --json` produced a durable ID and a parent process independent of the initiating CLI.
- The adaptive kernel generated bounded worker and verifier actions, enforced worker + verifier completion, and returned to the orchestrator for a terminal decision.
- The direct run recovered from a verifier-discovered requirement gap.
- The Grok-initiated run rejected content-empty output and automatically retried its verifier on Command Code.
- Auto-routing consistently selected Grok for orchestration from the live capability/quota view; initiator identity did not improperly pin worker identity.
- All terminal claims agreed with independent tests, and no test file was modified.

### Material friction

1. **Unreleased CLI surface is the largest blocker.** `bullswarm version` on PATH is 0.4.0, checkout source is 0.7.2, and `npm view bullswarm version` is also 0.4.0. Installing `@latest` would not expose this feature today.
2. **Generated observation commands assume PATH coherence.** The launch JSON returns bare `bullswarm workflow ...`; those commands fail here. Until release, the response should emit the actual launcher executable or clearly mark commands as requiring the same version.
3. **Agent initiation latency is disproportionate.** Grok took ~95s, Claude ~248s, and Command Code ~339s merely to launch a detached workflow. The ideal agent behavior is guide lookup → one launch → immediate ID handoff.
4. **Progress visibility varies by provider.** Grok streamed useful milestones; Claude and Command Code were silent until their final response.
5. **Verifier action status has two layers.** A valid `ok:false` verdict can have action status `succeeded` but report status `ok:false`. Dashboards should label this as “verdict produced: rejected” rather than relying on a generic success badge.
6. **Model-turn latency dominates small tasks.** Auto-selected Grok turns were commonly around one minute. A three-action workflow therefore took roughly four minutes even when no recovery was needed; the direct recovery case took nearly eleven minutes.

## Recommended acceptance gates before calling the feature frictionless

1. Publish a version containing `workflow goal`, or provide a supported install/link command for the checkout build.
2. Make launch responses emit observation commands bound to the executable/version that launched the run.
3. Add a minimal initiator recipe near the top of `skill/SKILL.md`: read goal, launch detached, return ID; perform baseline/doctor only when launch fails or readiness is unknown.
4. Make the dashboard distinguish execution success, verifier verdict, and terminal workflow acceptance.
5. Repeat this four-initiator matrix after publication and require: launch handoff under 30 seconds excluding provider API latency, correct copy-paste observation commands, terminal worker + verify evidence, unchanged tests, and independent acceptance.

## Reproduction and observation

The preserved evidence for this run is under `/tmp/bullswarm-usability-EsM9ev/home/workflows/<runId>/`:

- `state.json`: action ledger, attempts, routing, decisions, budgets, terminal state
- `workflow.json`: generated durable workflow document
- `events.jsonl`: ordered event replay
- `out-*`: worker/verifier/orchestrator artifacts
- `report.json`: action-level acceptance summary

Use the checkout binary for this snapshot:

```bash
export BULLSWARM_HOME=/tmp/bullswarm-usability-EsM9ev/home
node /Users/cowcow02/Repo/bullswarm/bin/bullswarm.js workflow runs show <shortId>
node /Users/cowcow02/Repo/bullswarm/bin/bullswarm.js workflow tui --json <shortId>
node /Users/cowcow02/Repo/bullswarm/bin/bullswarm.js workflow events --json <shortId> --after 0
```
