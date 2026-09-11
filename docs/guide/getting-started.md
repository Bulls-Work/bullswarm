---
title: Getting started
permalink: /guide/getting-started/
---

## Install

Requires Node.js 18 or later.

```bash
npm install -g bullswarm   # or: node bin/bullswarm.js directly from a checkout
bullswarm setup            # detect installed agent CLIs, show quota, write routing config
bullswarm integrate install --agents codex,claude,grok --yes
```

`bullswarm setup` is the human starting point. The integration command
registers Bullswarm's packaged `bullswarm` skill with Codex, Claude, and Grok
and appends a concise, marker-delimited awareness rule to each agent's global
instructions. It is explicit, idempotent, and reversible:

```bash
bullswarm integrate status --json
bullswarm integrate remove --agents codex,claude,grok --yes
```

If the retired pre-Bullswarm Claude `offload` skill is detected, status reports
it without changing it. Archive it recoverably with
`bullswarm integrate retire-legacy --yes`. The awareness rule prevents workers
already launched by Bullswarm (`BULLSWARM_DEPTH` is set in their environment)
from casually re-delegating and creating recursive swarms.

## Quick start

```bash
bullswarm          # first run: interactive setup wizard on a TTY; non-TTY callers self-initialize
bullswarm setup    # interactive provider/model configuration
bullswarm setup --wizard  # broader worktree + integration questionnaire
bullswarm pools    # meter state, pace position, quarantine status
bullswarm strategy  # explicit alias for the same routing control center
bullswarm run --lane analyze --add-dir ~/some-repo --task-file /tmp/t.md --json
bullswarm run --lane analyze --add-dir ~/some-repo --prompt "Inspect the parser" --json
bullswarm workflow plan contract "Fix the failing tests and verify the change" --cwd ~/some-repo --json  # you are the planner
bullswarm workflow goal "Fix the failing tests and verify the change" --cwd ~/some-repo --program plan.json
bullswarm workflow goal "Fix the failing tests and verify the change" --cwd ~/some-repo --orchestrator auto  # dispatch a planner agent
bullswarm health --json   # re-judge saved outputs; catch gate failures (omit --json for a human summary)
bullswarm doctor --json   # machine-readable readiness report; self-heals on first call
```

`doctor` is the command to reach for when something about routing or state
looks wrong before you dig further — see [Verbs](./entry-points.md#verbs) for
what every top-level command does.
