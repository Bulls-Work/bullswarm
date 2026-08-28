# Claude ultracode dynamic workflow vs bullswarm `workflow goal` — side-by-side (2026-08-29)

Status: IN PROGRESS — results sections are filled in as runs complete. Numbers
below are observed, not projected; anything estimated is labelled.

## Question

Same goal, same models, same fixture: how does bullswarm's autonomous
`workflow goal` loop behave next to Claude Code's native dynamic workflow
(the `Workflow` tool, "ultracode"), and what has to change in bullswarm to make
it feel as smooth?

## Setup (identical on both sides)

- **Fixture**: `swarmbench`, a zero-dependency Node ESM project with six small
  pure-logic modules under `src/`, one `node:test` file per module under
  `tests/`, plus an intentionally incomplete `src/index.js` barrel with its own
  test. Bugs were planted by a separate subagent; the orchestrator of the Claude
  side (this session) was told only file names and baseline counts, never the
  bugs, so both orchestrators had to discover them.
- **Two byte-identical copies**, each `git init`-ed so the diff can be audited
  afterwards. Test files are SHA-256 fingerprinted before and after each run to
  prove neither side edited a test.
- **Goal text (verbatim, both sides)**: see "Goal" below.
- **Models locked to one account**: workers on both sides are `claude-opus-5`.
  Orchestrator: Claude side = this Claude Code session (Fable 5, authoring and
  running the workflow script); bullswarm side = `claude-code` connector pinned
  with `--orchestrator claude-code` and `strategy assign high|medium|low --pool
  claude-code --model claude-opus-5`, `claude-fable-5` excluded.
- **bullswarm** 0.10.9 (released and installed from npm for this experiment),
  run from the installed binary with an isolated `BULLSWARM_HOME` in which every
  pool except `claude-code` is disabled and the connector meter is `none` so a
  5-hour burst gate cannot bench the only pool mid-run.
- **Sequential runs** on the same laptop so wall-clock numbers are not skewed
  by contention for the same subscription and CPUs.

## Goal

Verbatim, passed as the single goal argument to bullswarm and as the task
statement the Claude-side workflow script decomposes:

```text
Make `npm test` pass in this repository. Every failing test is caused by a bug in a file under src/ (including an incomplete src/index.js barrel that must re-export every module's public API). Fix the source so all tests pass. You must not modify, delete, or add any file under tests/. Finish by running the full `npm test` and report, per file changed, what was wrong and what you changed.
```

## Fixture baseline

`swarmbench`: `src/{csv,duration,index,intervals,lru,semver,slugify}.js`,
`tests/{csv,duration,index,intervals,lru,semver,slugify}.test.js`, `npm test`
= `node --test tests/*.test.js`. Baseline on both copies (Node v22.23.2):

```text
# tests 52
# pass 37
# fail 15      (failures present in all 7 test files)
```

Test-file SHA-256 before any run (identical in both copies):

```text
5106804683c7f6cef0dbc3629c4c14f4ab2e88319d934626d79bb18a080ae707  tests/csv.test.js
b7c7d77daad8bfe03dd0b755574cf59faaf677df7d2701a717cf8e44138bd108  tests/duration.test.js
27aa49f0f601d22748f36e161c963ac77bd9861fe84028a69e02a456a9b38302  tests/index.test.js
80abeecbea763df43b2260a7ee03df211db5b092ea87e418e0be740c59383cbd  tests/intervals.test.js
2aa610981dcb9a6c65a0dd9b7b3362f23c95ef5c6436a43cb3d969fc0cc3dded  tests/lru.test.js
d62bc016abe37f4400499f4a77b94c7b60cc8f473bac6b63f5a461f9a18b6a20  tests/semver.test.js
d611fd789caed8820eaf03b08aeb2799f564e5f0d320485f886fd9c5cf6ac112  tests/slugify.test.js
```

Both bullswarm runs and the Claude workflow use a concurrency cap of 8
(Claude's own cap on this 10-CPU laptop is min(16, CPUs − 2) = 8; bullswarm
gets `--concurrency 8`), so parallelism differences come from the driving
loop, not the cap.

## Warm-up: bullswarm 0.10.9 smoke goal (observed)

Goal: "Create a file named hello.txt in this directory containing exactly the
single line 'hello from smoke test', then verify it exists with that exact
content." Run `srdwjs`, single pool `claude-code` pinned to `claude-opus-5`,
`--max-agents 5 --max-expansion-rounds 2 --concurrency 2`.

| metric | value |
| --- | --- |
| wall | 553 s (9m13s) |
| dispatches | 6 (4 orchestrator turns, 1 worker, 1 verifier) |
| orchestrator time | 438 s = 79 % of wall (turns: 108 s, 102 s, 151 s, 77 s) |
| worker time | 38 s (create) + 76 s (verify) |
| max concurrent attempts | 1 |
| tokens | ≈29.1 k (bullswarm estimate: utf8 bytes / 4) |
| outcome | `completed`, verified |

Two of the four planning turns were spent on `verify` actions that died inside
the runtime without dispatching: the planner put reviewer instructions (turn 2)
and then a filesystem path (turn 3) into `verify.review`, which the runtime
resolves as a dotted scope path to an artifact. The 0.10.9 planner skeleton had
shown exactly that wrong shape. Fixed in the 0.11.0 work (see below).

## Results

### bullswarm `workflow goal`

(pending)

### Claude `Workflow` (ultracode)

(pending)

### Correctness audit

(pending: independent `npm test` on each copy, test-file SHA comparison, diff stat)

## Behaviour differences observed

(pending)

## What to change in bullswarm

(pending)
