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

## Development

```bash
npm test            # 61+ tests, no network needed (meters read from cache)
node bin/bullswarm.js doctor --json   # readiness report
```

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
