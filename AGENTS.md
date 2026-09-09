# AGENTS.md — bullswarm

Instructions for AI agents working in this repository.

## What bullswarm is

A CLI that routes bounded tasks to whichever coding-agent CLI subscription
has the most quota headroom, paced by live provider meters, verified by
content. Published as `bullswarm` on npm.

## Non-negotiable doctrine

1. Judge delegate output by CONTENT, not exit code (see `src/lib/verify.js`).
2. Pace by meter surplus = elapsed% (from provider resets_at) − used%.
   Weekly/monthly windows pace; 5h windows are burst gates only (M1–M5 in
   `src/meters/framework.js`).
3. Connector quirks live in `connectors/*.json`, never in core logic.
4. Quarantine always auto-releases; recursion depth is core-owned via env
   (`BULLSWARM_DEPTH`).
5. Workflow dispatches must honor the same guarantees as single runs:
   `BULLSWARM_DEPTH` is propagated, burst-gated pools are excluded, and
   auth verdicts quarantine the pool + append to the shared decision log
   (R6/R7/R8 in `src/workflow/v2-dispatch.js`).
6. Adversarial verification is a first-class primitive: an action naming
   requirements in `evidenceFor` is dispatched under an evidence contract and
   judges them from the durable artifact, so a requirement is only verified by
   work someone else inspected (R-skeptic).
7. New goal workflows are caller-planned programs in a shared workspace.
   `bullswarm workflow goal --program` executes the graph; `--orchestrator`
   explicitly delegates planning. File territories are advisory scheduling
   hints, and the graph finishes without automatic gap rounds. `verified`
   separately records requirement evidence. `--isolation` opts into strict
   per-worker worktrees. Saved V2 runs preserve their original semantics.
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

- Zero runtime dependencies. Node >= 18. Tests must never require network:
  prime `~/.bullswarm/meters/*.json` caches with fresh timestamps if needed.
- Every verb must work non-interactively (no TTY). The interactive wizard is
  a human convenience, never a requirement.
- Version single source: package.json. Release via
  `node bin/bullswarm.js release patch|minor|major`, then `git push` and
  `git push --tags`
  — CI publishes through npm trusted publishing (OIDC), no tokens.

## Adding a connector

Copy an existing file in `connectors/`, set: bin name, configDirs for
discovery, spawn argv template (`{taskFile}` `{cwd}` `{bullswarmDir}`
substitutions), authSignatures (output strings meaning auth/throttle
failure), outputExtraction strategy, meter type, costRank, lanes. Add a
meter reader in `src/meters/` only if the provider exposes a usage API —
declared meters are the fallback, never the goal.

## Releasing

1. All tests green.
2. `node bin/bullswarm.js release patch` (creates commit + tag v*).
3. `git push && git push --tags`.
4. GitHub Actions publishes to npm via trusted publishing; verify with
   `npm view bullswarm version`.
