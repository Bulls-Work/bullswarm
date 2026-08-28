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

```text
(filled in when the fixture is final)
```

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
