# bullswarm

Route work across coding-agent CLIs. For a goal, Bullswarm can choose a capable
orchestrator, build and expand the plan, route bounded worker actions by quota,
verify the result, and finish without an initiating agent authoring a graph.
Every delegate output is judged by content before it counts.

## The doctrine (non-negotiable)

1. **Judge by CONTENT, not exit code.** Every delegate CLI can exit 0 while
   having done nothing. A non-zero exit is never a success; `ok:true` requires
   passing verification.
2. **Pace by meter.** The scheduling resource is the subscription window:
   elapsed% minus used%, most-behind pool wins. Pace may only promote a
   *cheaper* pool. Lanes are work-nature, never hard-coded to pools.
3. **Delegate output is evidence, never authority.** A goal orchestrator may
   synthesize completion, but only after the deterministic runtime accepts its
   bounded plan and durable verification evidence.
4. **Quarantine re-probes.** A benched pool must be able to return to service
   automatically; a lane is never allowed to silently go down.

## Install

```bash
npm install -g bullswarm   # or: node bin/bullswarm.js directly from a checkout
```

## Quick start

```bash
bullswarm          # first run: interactive setup wizard
bullswarm setup    # re-run or repair
bullswarm pools    # meter state, pace position, quarantine status
bullswarm strategy refresh --apply --yes  # approve capability-aware tier autopilot
bullswarm run --lane analyze --add-dir ~/some-repo --task-file /tmp/t.md --json
bullswarm workflow goal "Fix the failing tests and verify the change" --cwd ~/some-repo
bullswarm health   # re-judge saved outputs; catch gate failures
```

## Verbs

| Verb | Purpose |
|---|---|
| `setup` | Discover installed agent CLIs, show quota state, toggle pools, suggest a routing table, write config. Approval-gated, idempotent. |
| `run` | route → dispatch → watch → verify → one JSON verdict |
| `health` | Re-judge saved outputs against their verdicts; surface verify-gate failures and quarantine clusters |
| `pools` | Show each pool's meter state, pace position, quarantine status |
| `strategy` | Discover models, record subscription value, recommend or assign high/medium/low effort routes |
| `doctor` | Machine-readable readiness report; self-heals on first call |
| `workflow` | Start an autonomous goal, or run / validate / draft / inspect explicit workflows and their live instances. |

## Model strategy and invocation telemetry

Bullswarm can inventory the models exposed by installed agent CLIs and combine
connector-declared, dated pricing/benchmark metadata with live quota surplus:

```bash
bullswarm strategy refresh
bullswarm strategy show --json
bullswarm strategy apply --yes --refresh-hours 24
bullswarm strategy auto status
bullswarm strategy set-subscription command-code \
  --plan GOAT --monthly-usd 10 --included-usd 70 --quota-window monthly
bullswarm strategy assign high --pool claude-code --model claude-opus-4-6
bullswarm run --effort high --lane analyze --task-file /tmp/task.md --json
```

Interactive setup asks whether to enable strategy autopilot; non-interactive
setup requires the explicit `setup --yes --strategy` flag. Recommendations are
context-filtered before ranking: high requires analysis plus workflow-planning,
medium requires build/edit capabilities, and low targets bounded chores. An
approved policy refreshes stale discovery before later runs and re-applies the
best eligible models on its configured interval. Disable it with
`strategy auto off --yes`. Discovery commands, model argument syntax, pricing,
and benchmark declarations remain connector-owned. Unknown license value,
prices, and benchmarks stay `null` rather than being guessed. An assignment is
only a preference: quarantine, exhaustion, burst gates, and capability checks
still win.

Every run and workflow attempt reports its selected agent/model and estimated
usage. When a delegate does not expose counters, Bullswarm labels its UTF-8
byte/4 token estimate. The breakdown separates standard read, cache read,
cache write, and output; API-equivalent cost and normalized subscription quota
remain unknown unless the connector and user-provided subscription data can
support them. `workflow tui --json <id>` exposes the aggregate and the full
phase/step/attempt tree.

## One-command autonomous goals

For normal multi-step work, give Bullswarm the goal—not a JSON graph:

```bash
# Foreground: streams progress and returns when terminal.
bullswarm workflow goal \
  "Fix the failing tests with the smallest correct change and verify them" \
  --cwd ~/some-repo

# Detached: the initiating CLI exits; the workflow continues independently.
bullswarm workflow goal \
  "Audit and repair the parser, then run its acceptance tests" \
  --cwd ~/some-repo --detach --json
```

Bullswarm first honors an approved high-tier provider/model assignment when it
remains eligible, otherwise it selects an eligible `workflow-planning`
orchestrator by live quota surplus. The orchestrator observes durable evidence, proposes bounded actions,
and decides when another expansion or verification is necessary. Bullswarm
validates the proposal, owns agent/process selection, routes workers, and calls
the orchestrator again until completion, cancellation, failure, approval, or a
budget limit. No initial phases, prompts, JSON schema, or agent choice are
required from the user.

The detached response includes a short ID and exact observation commands:

```bash
bullswarm workflow runs show <shortId>
bullswarm workflow tui <shortId>          # printable phase/action/attempt tree
bullswarm workflow tui --json <shortId>
bullswarm workflow events --json <shortId> --after 0
bullswarm workflow action show --json <shortId> <actionId>
```

Resume a process-interrupted autonomous run from its persisted workflow:

```bash
bullswarm workflow goal --resume <shortId> --json
```

`--orchestrator <pool>` exists for controlled testing; ordinary use should
leave selection on `auto`. Hard limits can be adjusted with `--max-agents`,
`--max-expansion-rounds`, `--max-actions`, `--max-items-per-expansion`, and
`--max-workflow-seconds`. Interactive setup also records a worktree-isolation
preference (`agent-decides`, `off`, or `required`); Bullswarm communicates that
policy to the orchestrator without imposing repository topology itself.

## Building a workflow from the shell

Use an explicit draft when the graph itself is a durable contract and should
not be planner-defined. `bullswarm workflow draft ...` lets you assemble it one
mutation at a time. No upfront JSON required. Drafts persist under
`~/.bullswarm/drafts/<name>/` and become first-class workflows
(discoverable, runnable by name) the moment they exist.

```bash
bullswarm workflow draft create audit-code \
    --description "Audit the source code" --input targetDir=.
bullswarm workflow draft phase add audit-code discover
bullswarm workflow draft phase add audit-code review
bullswarm workflow draft step add audit-code discover list-files \
    --type run --lane chore --prompt "List every .js file in src/" \
    --addDir '{{inputs.targetDir}}'
bullswarm workflow draft step add audit-code review per-file \
    --type fanout --items-from 'outputs.list-files.outFile' \
    --lane analyze --concurrency 2 \
    --step-template '{"lane":"analyze","addDir":"{{inputs.targetDir}}","prompt":"Review {{item}}"}'
bullswarm workflow draft show audit-code    # inspect the JSON
bullswarm workflow draft run audit-code     # execute it
bullswarm workflow draft export audit-code workflows/audit-code.json   # promote to file
```

`step add` re-validates after every mutation; partial drafts (zero
phases, etc.) are treated as building, not invalid. `set` and
`step set` patch fields in place. `delete` requires `--yes`.

## Operating on workflow runs

Every run gets a 6-character shortId (Crockford-style alphabet,
no `0/1/i/l/o`). The full `wf-...` runId stays the durable handle.

```bash
bullswarm workflow runs                    # ongoing only (default)
bullswarm workflow runs --all              # ongoing + historical
bullswarm workflow runs --historical       # only historical
bullswarm workflow runs --name audit-code  # filter by workflow
bullswarm workflow runs --limit 20         # cap the result count
bullswarm workflow runs show <shortId>     # state + report + summary
bullswarm runs show <shortId>              # top-level shorthand
bullswarm workflow runs delete <shortId> --yes    # remove the run dir

# Resume by shortId — runs the same logic as the full runId
bullswarm workflow run audit-code --resume <shortId>
```

### Live workflow dashboard

`workflow tui` is the interactive, Claude-style `/workflows` view. It watches
ongoing runs from disk and supports `j`/`k` or arrow-key selection, Enter for
details, `c` to request a cooperative stop, `r` to refresh, and `q` to quit.

```bash
bullswarm workflow tui
```

The same dashboard is agent-friendly and never requires a TTY when used with
JSON/control flags:

```bash
bullswarm workflow tui --json                 # ongoing dashboard rows
bullswarm workflow tui --json --all           # ongoing + historical runs
bullswarm workflow tui --json <shortId>       # inspect one run
bullswarm workflow tui --json --cancel <id>   # request cooperative stop
bullswarm workflow capabilities --json       # pools, lanes, models, meters, limits
bullswarm workflow inspect <file-or-name>     # workflow shape and semantics
bullswarm workflow events --json <id> --after 20
bullswarm workflow action show --json <id> <actionId>
bullswarm workflow approval approve --json <id>  # then resume the run
```

Cancellation is persisted as `cancelling`, terminates an active child process,
records its termination signal and latency evidence, then commits `cancelled`.
`SIGTERM` and `SIGINT` use the same cooperative child termination path but
commit a distinct resumable `interrupted` state. On every workflow command,
active states with a dead/stale owner are automatically reconciled to
`interrupted` instead of remaining falsely `running`.
Live attempts record the last stdout/stderr activity time and observed byte
count separately from the runner heartbeat. This makes a silent process
visible without treating elapsed wall time alone as proof that it is hung.

Each attempt records the phase/action, selected pool and model, effort tier,
routing reason, all eligible candidates with quota surplus, timestamps,
artifact paths, outcome, and reported-or-estimated token/cost/quota usage.
`workflow tui <id>` renders this breakdown for completed runs as well as live
ones; `workflow tui --json <id>` exposes the durable audit document.

### Adaptive workflows

Static workflows remain zero-extra-LLM orchestration. An adaptive workflow adds
an explicit `decide` step, advisory resource targets, and structural expansion
limits:

```json
{
  "mode": "adaptive",
  "settings": {
    "maxAgents": 12,
    "maxExpansionRounds": 3,
    "maxActions": 20,
    "maxItemsPerExpansion": 8,
    "maxWorkflowSeconds": 1800
  },
  "phases": [{
    "name": "review",
    "steps": [
      { "id": "initial", "type": "run", "prompt": "Inspect the code." },
      {
        "id": "planner",
        "type": "decide",
        "requiresCapabilities": ["workflow-planning", "strong-analysis"],
        "prompt": "Judge sufficiency and propose only bounded missing work."
      }
    ]
  }]
}
```

`maxAgents` and `maxWorkflowSeconds` are advisory inputs to the orchestrator.
Crossing either target is recorded in durable state but never stops a worker,
skips verification, or fails a run. `maxExpansionRounds`, `maxActions`, and
`maxItemsPerExpansion` remain hard graph-growth safeguards. Delegates have no
implicit wall-clock timeout; set a step's `timeoutSec` (or direct-run
`--timeout`) only when an operator explicitly wants a hard termination timer.

The planner returns versioned JSON. It may propose `needs_more_work` with
bounded `run`, inline-`fanout`, or `verify` actions. The deterministic runtime
validates IDs, dependencies, operation types, capabilities, and budgets before
appending anything. It executes ready actions, observes their durable results,
and calls the planner again. `events.jsonl`, `state.json`, the TUI, and JSON
inspection expose the same plan, actions, attempts, decisions, budgets, and
artifacts. See `workflows/adaptive-code-review.json` for a complete example.
Planner actions cannot set `pool`, `addDir`, or `taskFile`. If those need to be
fixed by the initiator, declare them under the `decide` step's `actionDefaults`;
otherwise eligible capable pools are ranked by live quota surplus.

## The verdict

```json
{
  "ok": true,
  "keepOnClaude": false,
  "why": "verified",
  "pick": { "pool": "grok", "command": ["grok", "-p", "..."] },
  "contentUsableDespiteExit": false,
  "outFile": "/tmp/dlg.out"
}
```

- `ok: true` — verified output, read the file
- `keepOnClaude: true` — router says do it in-session; nothing ran
- `ok: false` — `why` names the failed gate
- `contentUsableDespiteExit: true` — non-zero exit but complete output; read
  before re-running

## License

MIT
