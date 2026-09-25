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
pattern cards are in `docs/design/patterns/`. Build in the plan's stage order.
The doctrine below stays in force until the stage that changes an item lands.
The redesign rewords items 1, 5, 6 and 7, and each stage updates this file.
Stage 1 (step vocabulary) has landed: program-mode steps may state a role and a
deliverable, each kind belongs to one role and keeps its exact routing, and
the no-op gate is now 'declared deliverable not produced' (failure kind
`not-produced`), measured over the whole step. Stage 2 (evidence v1) has landed:
program steps may declare command and schema `evidence` that the kernel runs
after the worker, a failure is `failed-evidence` with one same-pool retry, and
finished steps in new runs are labelled `proven by …` or `finished · unproven`.
Stage 3 (failure rule and routing constraints) has landed: one automatic retry
per step, then the caller; quota waits; the needs-you block with `step rerun
--avoid` and `step accept`; the per-step `route`; `verifyRounds` counts fixes
(default 1); reviews are placed only by route. Runs started earlier keep their
rules (`features.json`).

## Non-negotiable doctrine

1. Judge delegate output by what can be checked, never by the delegate's exit code or its own report: the content (`src/lib/verify.js`) and, when a step declares them, the command and schema evidence Bullswarm runs itself (`src/workflow/evidence-runner.js`).
2. Pace by meter surplus = elapsed% (from provider resets_at) − used%.
   Weekly/monthly windows pace; 5h windows are burst gates only (M1–M5 in
   `src/meters/framework.js`).
3. Provider quirks live in the provider's directory (`src/providers/<name>/`,
   `providers/contrib/<name>/`, or `~/.bullswarm/providers/<name>/`), never in
   core logic (see `docs/reference/providers.md`).
4. Quarantine always auto-releases; recursion depth is core-owned via env
   (`BULLSWARM_DEPTH`).
5. Workflow dispatches honor the same guarantees as single runs:
   `BULLSWARM_DEPTH` is propagated, burst-gated pools are excluded, and auth
   verdicts quarantine the pool and append to the shared decision log
   (R6/R7/R8 in `src/workflow/v2-dispatch.js`). A step's `route`, the run's
   pin and the step's capability tier are hard filters applied before pace
   ranks what is left. The failure rule is one automatic retry per step (a
   process failure on another eligible pool, a gate failure on the same pool
   with the failure attached), then the caller. An `act` step is never retried
   once its worker started. Exhausted quota makes a step move without spending
   its retry, or wait and say so, whatever the pausing switch; it never fails
   for quota while a return time is known. Only a failed step's dependents
   wait.
6. Review is a caller option, recorded as a fact. A step naming requirements
   in `evidenceFor` is dispatched under the evidence contract and judges them
   from the durable artifact. Where it runs is the caller's choice through
   `route` (`independentOf`, `providers`, `pools`); Bullswarm never moves a
   review on its own, and records who reviewed (pool, model, provider) and
   whether that provider also wrote the work. A caller's `step accept` is
   recorded as evidence `choice` and never makes a requirement verified.
   Runs started before this rule keep automatic writer avoidance (R12/R13).
7. New goal workflows are caller-planned programs in a shared workspace.
   `bullswarm workflow goal --program` executes the graph; `--orchestrator`
   explicitly delegates planning. File territories are advisory scheduling
   hints. A failed check gets one fix step and one re-review
   (`defaults.verifyRounds`, default 1, 0-3), then the caller, who takes over
   through the watcher's needs-you block: rerun elsewhere, change the step,
   take over, or accept anyway. `verified` separately records requirement
   evidence. `--isolation` opts into strict per-worker worktrees. Saved V2
   runs preserve their original semantics (`features.json`).
8. Historical authored-graph runs remain visible as read-only `legacy` rows.
   Their executor was removed in 0.27.0; driving commands fail closed before
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
