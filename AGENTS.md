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
   (R6/R7/R8 in `src/workflow/runtime.js`).
6. Adversarial verification is a first-class primitive: a `verify` step
   reads a prior outFile and demands a JSON `{ok, concerns, summary}`
   verdict before downstream steps can trust the work (R-skeptic).
7. Workflows can be built incrementally from the shell
   (`bullswarm workflow draft create/phase/step/set/...`). Drafts are
   stored under `~/.bullswarm/drafts/<name>/` and are runnable by name
   without an upfront JSON. JSON is still the durable artifact — drafts
   are JSON documents, just built one mutation at a time.
8. Goal-driven execution is zero-graph by default: `bullswarm workflow goal`
   internalizes the planner contract, chooses the orchestrator and workers,
   persists the generated workflow, and can detach so observation never
   depends on the initiating agent or CLI process.

## Development

```bash
npm test            # 256 tests, no network needed (meters read from cache)
node bin/bullswarm.js doctor --json   # readiness report
node bin/bullswarm.js workflow list   # discover workflows
node bin/bullswarm.js workflow runs   # ongoing workflow instances
node bin/bullswarm.js workflow runs --all   # including historical
node bin/bullswarm.js workflow validate <file>  # dry-run
BULLSWARM_HOME=/tmp/bs node bin/bullswarm.js workflow run <file>   # sandboxed run
# Build a workflow from the shell:
bullswarm workflow draft create my-audit
bullswarm workflow draft phase add my-audit discover
bullswarm workflow draft step add my-audit discover list-files --type run --prompt 'List files'
bullswarm workflow draft run my-audit
# Operate on a run by shortId (6 chars) or full runId (`wf-...`):
bullswarm workflow runs show <shortId>
bullswarm workflow runs delete <shortId> --yes
```

## Using bullswarm from another agent

If you are an agent that wants to offload bounded work via bullswarm,
read `skill/SKILL.md` — that's the agent-facing user guide. It covers
when to reach for `run` vs `workflow draft`, the verify-step pattern,
how to write prompts that pass the content gate, and the failure modes
you'll hit. The skill is published alongside the package and is the
canonical reference for the CLI surface.

- Zero runtime dependencies. Node >= 18. Tests must never require network:
  prime `~/.bullswarm/meters/*.json` caches with fresh timestamps if needed.
- Every verb must work non-interactively (no TTY). The interactive wizard is
  a human convenience, never a requirement.
- Version single source: package.json. Release via
  `node bin/bullswarm.js release patch|minor|major` then `git push --tags`
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
