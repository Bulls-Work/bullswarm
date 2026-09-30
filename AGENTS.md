# AGENTS.md — bullswarm

Instructions for AI agents working in this repository.

## What bullswarm is

A CLI that routes bounded tasks to whichever coding-agent CLI subscription
has the most quota headroom, paced by live provider meters, verified by
content. Published as `bullswarm` on npm.

## Redesign in progress (2026-09)

The core is being redesigned around facts-only mechanics, four mandatory
principles, caller-chosen options and a pattern library, for any kind of work
rather than code only. The design, the decisions taken and the staged build
plan are in `docs/design/redesign-mechanics-principles-options.md`, and draft
pattern cards are in `docs/design/patterns/`. Each release updates this file.

0.37.0 (program v3, the generic model) landed: a step is a run, and a
workflow composes steps, phases, gates and loops. `bullswarm run` is a
one-step workflow. A step passes by facts (clean exit, deliverable produced,
evidence passed, answer matching its schema), a gate waits for
`workflow continue`, a loop reruns its steps until one condition holds (at
most 5 rounds), and new work is added with `workflow add`, never by editing
the run's steps. v3 reports facts per step and has no requirement IDs,
`evidenceFor` or `verifyRounds`.

0.38.0 (the removals release, `docs/design/0.38.0-removals.md`) deleted the
mechanisms v3 replaced: the preflight scout, the dispatched planner
(`--orchestrator`), the caller-planner gap turn (`plan show`/`plan submit`),
whole-plan revise (`plan export`/`plan revise`), the v2 repair loop, the
kernel-written digest and review tasks, and the old dispatch rules. New
programs are `bullswarm.workflow.program.v3` only; a v2 program is refused
before a run folder exists. Only a run marked `programFormat: 3` is driven.
Every other saved run (v2, stage 1-3, legacy) is view-only: it stays
listable, showable and countable, and every driving command refuses it
before doing anything. Their readers and stored formats are unchanged.

## Non-negotiable doctrine

1. Judge delegate output by what can be checked, never by the delegate's exit code or its own report: the content (`src/lib/verify.js`) and, when a step declares them, the command and schema evidence Bullswarm runs itself (`src/workflow/evidence-runner.js`).
2. Pace by meter surplus = elapsed% (from provider resets_at) − used%.
   Weekly/monthly windows pace; 5h windows are burst gates only (M1–M5 in
   `src/meters/framework.js`). Any metered window at 100% (5h, weekly or
   monthly) keeps its pool out of every pick until that window resets.
3. Provider quirks live in the provider's directory (`src/providers/<name>/`,
   `providers/contrib/<name>/`, or `~/.bullswarm/providers/<name>/`), never in
   core logic (see `docs/reference/providers.md`).
4. A spent or dead pool is never remembered across steps: nothing pauses or
   benches a pool, and every pick reads the live meters. The one fact that
   outlives a step is the 100% refusal marker a usage limit writes when the
   meter cannot be read, and it counts only when its reset was named or
   measured, never guessed (`refusalResetKnown` in `src/meters/framework.js`).
   Beside it sits one plan fact: `state.strategy.planExcludedModels[pool]`,
   the models a provider said that pool's subscription does not include
   (failure kind `model-not-in-plan`). It is a fact about the plan, like its
   price, not a spent or dead pool: the pool stays pickable with its other
   models, and the record ends when the subscription changes or the operator
   turns the model back on (`src/lib/strategy.js`).
   Recursion depth is core-owned via env (`BULLSWARM_DEPTH`).
5. Workflow dispatches honor the same guarantees as single runs, in
   `src/workflow/v2-dispatch.js`: `BULLSWARM_DEPTH` is checked and propagated
   (`assertDepthAllowed` and `childDepthEnv` in `dispatchV2Action`), pools at
   a spent window are excluded (`preparePools`), and a sign-in failure is
   failure kind `auth`: the step's retry skips every pool in the dead
   credential's group (`upstreamGroupOf`), a choice held for that dispatch
   only and never stored. A step's `route`, the run's pin and the step's
   capability tier are hard filters applied before pace ranks what is left. The failure rule is one automatic retry per step (a
   process failure on another eligible pool, a gate failure on the same pool
   with the failure attached), then the caller. An `act` step is never retried
   once its worker started. A usage limit (a spent 5-hour or weekly window, or
   no credit left) ends the step and sends it to the caller: no wait, no
   automatic move, no retry. The pool's meter is re-read after it
   (when that read fails, the refusal marker counts the pool as full only until
   a reset the provider named or a reading measured, never a guessed one), so
   a window at 100% keeps that pool out of later steps. Finding no capable pool
   free at the pick sends the step to the caller too. Nothing waits for a
   pool inside a run; only a transient rate limit backs off on the same pool,
   at most twice (20 s, then 60 s, or a named wait of at most 2 minutes), then
   goes to the caller.
   Only a failed step's dependents wait.
6. Review is a caller option, recorded as a fact. A check is an ordinary
   step with an `answer` and/or `evidence`, and it passes by facts only.
   Where it runs is the caller's choice through `route` (`independentOf`,
   `providers`, `pools`); Bullswarm never moves a review on its own, and
   records who reviewed (pool, model, provider) and whether that provider
   also wrote the work. A caller's `step accept` is recorded as evidence
   `choice`. Saved v2 runs keep showing their requirement verdicts
   (`evidenceFor`, `verified`) as they were recorded.
7. New goal workflows are caller-planned v3 programs in a shared workspace.
   `bullswarm workflow goal --program` executes the graph; the caller writes
   the plan (or a step whose answer is a list of steps, appended with
   `workflow add --from-answer`). File territories are advisory scheduling
   hints. A check is an ordinary step, and fixing until it passes is a loop
   the caller declares (`loops`, `until` one condition, `maxRounds` 1-5); a
   loop out of rounds or a gate waits for the caller (`workflow continue`),
   and a failed step goes to the caller through the watcher's needs-you
   block: rerun elsewhere, add steps (`workflow add`), take over, or accept
   anyway. v3 validate refuses `defaults.verifyRounds`. `--isolation` opts
   into strict per-worker worktrees. A saved run that is not v3 is view-only
   (0.38.0): its original semantics are kept for display (`features.json`),
   and nothing drives it again.
8. Historical authored-graph runs remain visible as read-only `legacy` rows,
   and `runs show`/`result`/`watch` print a bounded summary of them. Their
   executor was removed in 0.27.0; driving commands fail closed before
   dispatch and historical run directories remain untouched.

## Development

```bash
npm test            # full suite, no network needed (meters read from cache)
node bin/bullswarm.js doctor --json   # readiness report
node bin/bullswarm.js workflow goal "Fix the failing tests" --program plan.json
node bin/bullswarm.js workflow runs   # ongoing workflow instances
node bin/bullswarm.js workflow runs --all   # including historical
# Validate a caller-authored program before launch:
bullswarm workflow plan validate "Fix the failing tests" --program plan.json
# Operate on a run by shortId (6 chars) or full runId (`wf-...`):
bullswarm workflow runs show <shortId>
bullswarm workflow runs delete <shortId> --yes
```

## Using bullswarm from another agent

If you are an agent that wants to offload bounded work via bullswarm,
read `skill/SKILL.md` — that's the agent-facing user guide. There are
exactly two ways to start work, and the caller chooses the shape itself: one
bounded outcome goes to `bullswarm run`; parallel territories, integration,
or independent acceptance go to `bullswarm workflow goal` with a program you
author (`bullswarm workflow plan contract` returns the schema). There is no
classifier or preview step. The skill is published alongside the package and
is the canonical reference for the CLI surface.

- Zero runtime dependencies. Node >= 22.12 (providers load synchronously
  through `require` of ES modules). Tests must never require network:
  prime `~/.bullswarm/meters/*.json` caches with fresh timestamps if needed.
- Every verb must work non-interactively (no TTY). The interactive wizard is
  a human convenience, never a requirement.
- Version single source: package.json. Release via
  `npm run release -- patch|minor|major [--title "<headline>"]`, then `git push` and
  `git push --tags`
  — CI publishes through npm trusted publishing (OIDC), no tokens.

## Adding a provider

A provider is a directory holding `connector.json` (a pool template checked
against `src/providers/_schema.json`) and/or `provider.mjs`. First-class
providers live in `src/providers/<name>/`, contrib providers in
`providers/contrib/<name>/` (enabled per machine through
`~/.bullswarm/providers.json`), and a user's own in
`~/.bullswarm/providers/<name>/`. Start from
`bullswarm provider scaffold <name> [--from <template>]`, then
`bullswarm provider validate` and `bullswarm provider probe <pool>`. Write a
`readUsage` export only if the vendor exposes a usage API — declared meters
are the fallback, never the goal. The contract is `docs/reference/providers.md`;
the authoring method is `skill/references/providers.md`.

## Releasing

1. All tests green.
2. `npm run release -- patch --title "<headline>"` (dates `## Unreleased`
   in CHANGELOG.md, bumps package.json, creates commit + tag v*).
3. `git push && git push --tags`.
4. GitHub Actions publishes to npm via trusted publishing; verify with
   `npm view bullswarm version`.
