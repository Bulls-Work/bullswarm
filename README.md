# bullswarm

Route work across coding-agent CLIs. For a goal, Bullswarm chooses a capable
Workflow Planner, validates its bounded generic action program, routes work and
evidence agents by quota, and computes completion from a durable requirement
ledger without an initiating agent authoring a graph.
Every delegate output is judged by content before it counts.

For agents, `/bullswarm` (or `$bullswarm` where skills use that syntax) is the
common entry point. Its durable CLI equivalent is `bullswarm delegate`: it
first explains whether the request needs one bounded agent or an autonomous
workflow, shows the conceptual plan, and then executes the selected engine.

Every command and nested subcommand supports contextual `-h` / `--help`
without initializing state or executing the command:

```bash
bullswarm --help
bullswarm workflow run --help
bullswarm workflow draft step add --help
```

`workflow goal` launches a durable background runner, prints operating commands,
and returns by default. Add `--watch` to immediately follow low-noise progress
until terminal, or `--foreground` to keep execution owned by the initiating
terminal. Open the unified workflow home with bare `bullswarm workflow`, or
jump directly to one run with `bullswarm workflow tui <shortId>`. The default
detail view is a human timeline with Live agents and a plain-language Next
line; `v` reveals technical state. Wide terminals use a workflow sidebar plus
detail pane, while narrow/mobile terminals show one pane at a time. `q`
detaches safely.

## The doctrine (non-negotiable)

1. **Judge by CONTENT, not exit code.** Every delegate CLI can exit 0 while
   having done nothing. A non-zero exit is never a success; `ok:true` requires
   passing verification.
2. **Pace by meter.** The scheduling resource is the subscription window:
   elapsed% minus used%, most-behind pool wins. Pace may only promote a
   *cheaper* pool. Lanes are work-nature, never hard-coded to pools.
3. **Delegate output is evidence, never authority.** The Workflow Planner may
   propose actions, but only the deterministic kernel validates the program,
   accepts requirement-scoped evidence, and computes completion.
4. **Quarantine re-probes.** A benched pool must be able to return to service
   automatically; a lane is never allowed to silently go down.

## Install

```bash
npm install -g bullswarm   # or: node bin/bullswarm.js directly from a checkout
bullswarm integrate install --agents codex,claude,grok --yes
```

The integration command registers Bullswarm's packaged `bullswarm` skill with
Codex, Claude, and Grok and appends a concise, marker-delimited awareness rule
to each agent's global instructions. It is explicit, idempotent, and reversible:

```bash
bullswarm integrate status --json
bullswarm integrate remove --agents codex,claude,grok --yes
```

If the retired pre-Bullswarm Claude `offload` skill is detected, status reports
it without changing it. Archive it recoverably with
`bullswarm integrate retire-legacy --yes`. The awareness rule prevents workers
already launched by Bullswarm (`BULLSWARM_DEPTH` is set) from casually
re-delegating and creating recursive swarms.

## Quick start

```bash
bullswarm          # first run: interactive setup wizard
bullswarm setup    # interactive provider/model configuration
bullswarm setup --wizard  # broader worktree + integration questionnaire
bullswarm pools    # meter state, pace position, quarantine status
bullswarm strategy  # explicit alias for the same routing control center
bullswarm delegate --cwd ~/some-repo --prompt "Explain the parser"            # one agent
bullswarm delegate --cwd ~/some-repo --prompt "Audit all commands, fix help, and independently verify"  # workflow
bullswarm delegate --dry-run --json --cwd ~/some-repo --prompt "Your task"     # bounded classification + decision/plan; no work dispatch
bullswarm run --lane analyze --add-dir ~/some-repo --task-file /tmp/t.md --json
bullswarm run --lane analyze --add-dir ~/some-repo --prompt "Inspect the parser" --json
bullswarm workflow plan contract "Fix the failing tests and verify the change" --cwd ~/some-repo --json  # you are the planner
bullswarm workflow goal "Fix the failing tests and verify the change" --cwd ~/some-repo --program plan.json
bullswarm workflow goal "Fix the failing tests and verify the change" --cwd ~/some-repo --orchestrator auto  # dispatch a planner agent
bullswarm health   # re-judge saved outputs; catch gate failures
```

## Verbs

| Verb | Purpose |
|---|---|
| `setup` | Discover installed agent CLIs, show quota state, toggle pools, suggest a routing table, write config. Approval-gated, idempotent. |
| `integrate` | Register or remove the canonical Bullswarm skill and global awareness rules for Codex, Claude, and Grok. |
| `delegate` | Explain and execute the smallest reliable shape: one content-verified agent, or the planning contract for an autonomous workflow you author (`--orchestrator` dispatches a planner agent instead). |
| `run` | route → dispatch → watch → verify → one JSON verdict |
| `health` | Re-judge saved outputs against their verdicts; surface verify-gate failures and quarantine clusters |
| `pools` | Show each pool's meter state, pace position, quarantine status |
| `strategy` | Interactive provider/model control center with live high/medium/low route previews and an agent-facing JSON API |
| `doctor` | Machine-readable readiness report; self-heals on first call |
| `workflow` | Start an autonomous goal, or run / validate / draft / inspect explicit workflows and their live instances. |
| `runs` | Short alias for `workflow runs`, including list, show, result, delete, and cleanup operations. |
| `version` / `--version` | Print the installed Bullswarm version. |
| `release` | Run the guarded local version-bump, commit, and tag workflow used before CI publishes to npm. |

### Delegate classification

With the default `--mode auto`, `delegate` first uses deterministic task
signals, then uses an LLM to refine the choice between a single delegate and a
workflow during execution. If that optional refinement is unavailable or
unusable, automatic mode uses the deterministic decision.

Use `--classify deterministic` to bypass the LLM refinement — this is the
instant, no-dispatch preview. Use `--classify llm` when an LLM decision is
required: the command fails if it cannot obtain a usable one. In automatic
mode, `--dry-run` still performs that same bounded low-effort classification
request (one analyze-lane, low-effort dispatch) and prints the resulting
decision — it never dispatches the work itself. An explicit `--mode single` or
`--mode workflow` is the caller's decision and bypasses automatic LLM
classification.

Discover and validate workflow definitions without executing them:

```bash
bullswarm workflow list
bullswarm workflow list --json
bullswarm workflow validate workflows/my-workflow.json
```

`workflow goal --request <path>` and `--run-id <id>` are internal detached-runner
resume plumbing. Normal callers should provide a goal or use `--resume <shortId|runId>`.

## Model strategy and invocation telemetry

Bullswarm can inventory the models exposed by installed agent CLIs and combine
connector-declared, dated pricing/benchmark metadata with live quota surplus:

```bash
bullswarm setup                            # TTY: interactive control center
bullswarm strategy                         # explicit routing-focused alias
bullswarm strategy inventory --json        # agent-readable detection + policy + routes
bullswarm strategy routes --json           # compact effective choices
bullswarm strategy set-provider codex off --yes
bullswarm strategy set-model opencode2 relay/gpt-5.6-luna \
  --tiers high,medium,low --yes
bullswarm strategy configure --file strategy.json --yes  # atomic agent-authored policy
bullswarm strategy reset-tier low --yes     # restore one tier to automatic
bullswarm strategy refresh
bullswarm strategy show --json
bullswarm strategy apply --yes --refresh-hours 24
bullswarm strategy auto status
bullswarm strategy set-subscription command-code \
  --plan GOAT --monthly-usd 10 --included-usd 70 --quota-window monthly
bullswarm strategy assign high --pool claude-code --model claude-opus-4-6
bullswarm strategy exclude-model claude-fable-5
bullswarm run --effort high --lane analyze --task-file /tmp/task.md --json
```

Setup first asks whether to analyze live usage and recommend routes or open the
current configuration for manual editing. Analysis shows a spinner plus
per-provider usage progress, then presents the proposed defaults before making
any routing change. Press `Y` to apply them or `N` to retain the current policy.
The analysis selects at most one default model for each provider and effort
tier. It uses OpenRouter's agentic, coding, and intelligence indices as quality
signals and API-equivalent pricing as the budget signal. A repository-owned
GitHub Actions job calls the authenticated OpenRouter APIs once per day and
replaces a public, validated `openrouter-benchmarks.json` asset on the rolling
`benchmark-data-latest` GitHub Release. Installed CLIs download only that public
file and never need or receive an OpenRouter key.
The sources are OpenRouter's [benchmarks API](https://openrouter.ai/docs/api/api-reference/benchmarks/list-benchmarks)
and [models API](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties).
The CLI caches the datapack under `~/.bullswarm/cache/`; network failure falls
back to a stale or bundled datapack, then connector metadata, without blocking
setup.

The TUI lists every detected provider/account separately so its toggle matches
its own quota meter. Enter drills into that provider's detected models. In the
model matrix, `Up`/`Down` selects a model, `Left`/`Right` moves a visibly
highlighted cell across High, Medium, and Low, and `Enter` toggles that cell.
Type to filter model names; assigned models sort above unassigned or disabled
models. Select `Finish setup` and press `Enter`, or press `F` directly, to leave
the control center. The effective-route panel is recomputed from the same policy
and live surplus used by real dispatch. Provider and model edits affect new
direct runs and workflow dispatches.

An external AI agent should first read `strategy inventory --json`, then use
the validated `set-provider` / `set-model` commands or write one JSON document
for `strategy configure --file`. Unknown pools and models are rejected before
state is saved. Existing automatic choices are preserved when a human begins
curating a tier; a model-level `off` never empties unrelated tiers.

```json
{
  "providers": { "codex": false, "opencode2": true },
  "models": {
    "opencode2": {
      "relay/gpt-5.6-sol": ["high"],
      "relay/gpt-5.6-luna": ["medium", "low"]
    }
  }
}
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

Model exclusions are hard routing policy. An excluded model is removed from
recommendations and assignments, and Bullswarm pins a same-tier allowed model
through the connector-owned model flag whenever the provider default could be
excluded. A pool that cannot guarantee the exclusion is ineligible for that
dispatch. Reverse the policy with `bullswarm strategy include-model <model>`.

Every run and workflow attempt reports its selected agent/model and estimated
usage. When a delegate does not expose counters, Bullswarm labels its UTF-8
byte/4 token estimate. The breakdown separates standard read, cache read,
cache write, and output; API-equivalent cost and normalized subscription quota
remain unknown unless the connector and user-provided subscription data can
support them. `workflow tui --json <id>` exposes the aggregate and the full
phase/step/attempt tree.

## One-command autonomous goals

For normal multi-step work, give Bullswarm the goal and the program you authored
for it—not a JSON graph of phases:

```bash
# 1. What the kernel will enforce: requirement IDs, rules, action schema, example.
bullswarm workflow plan contract \
  "1. Fix the failing tests with the smallest correct change. 2. Verify them." \
  --cwd ~/some-repo --json

# 2. Launch with your program. Starts independently, prints observation
#    commands, and returns. Add --watch to follow low-noise progress.
bullswarm workflow goal \
  "1. Fix the failing tests with the smallest correct change. 2. Verify them." \
  --cwd ~/some-repo --program plan.json --watch

# Don't want to plan? Ask for a Workflow Planner agent explicitly.
bullswarm workflow goal \
  "Audit and repair the parser, then run its acceptance tests" \
  --cwd ~/some-repo --orchestrator auto --watch
```

`workflow goal` needs a program: with neither `--program`, `--scout`, nor
`--orchestrator` it exits 2, launches nothing, and prints the commands above.
That is deliberate — the kernel never plans on the caller's behalf unless the
caller asks for it by name.

`--max-agents`, `--max-actions`, and `--max-expansion-rounds` are soft V2
planning targets. They encourage the Workflow Planner to consolidate optional
work, but the kernel never stops or rejects essential work merely because a
target was reached. `--concurrency` still bounds simultaneous dispatches so
the scheduler can batch a wider useful program safely.

The caller authors a complete program, or explicitly asks for a dispatched
planner. The kernel validates the graph, executes it, and returns every action
result. Independent agents share the target worktree. `ownedFiles` describes
intended territory and lets the scheduler serialize overlapping writers; it
does not reject or discard edits. A dependent starts as soon as its own inputs
finish, without waiting for unrelated siblings. A failed action skips its
dependents while other branches continue.

After a parallel implementation wave, plan one integrator depending on all its
writers. Give it `lane: "build"` and `ownedFiles: []` to run alone with permission
to fix any file. Its prompt should read worker outputs, apply cross-territory
requests, reconcile shared files, and run the repository acceptance commands.
Analyze actions remain read-only. Evidence actions are optional and report
independent judgments; negative evidence does not open another planner round.
The graph ends with `completed` when all actions succeeded, or `partial` when
some failed or were blocked. `verified` separately records whether all mandatory
requirements have fresh passing evidence. Read that qualification and the
actual outputs before claiming acceptance. Further repairs use a new program.

Lane and effort are separate decisions for every proposed action. `analyze` is
read-only investigation, judgment, or evidence; `build` is contextual product,
test, or documentation mutation; `chore` is deterministic mechanical mutation.
The kernel rejects evidence outside `analyze`, file ownership inside `analyze`,
and any `chore` above low effort. Low is for fixed-procedure checks and edits,
medium is the default for ordinary bounded work, and high is reserved for
architecture, ambiguous tradeoffs, cross-cutting integration, or genuinely
adversarial acceptance judgment. Merely being an analysis/evidence action or
part of a difficult goal never promotes an action to high. The selected effort
then resolves through the High/Medium/Low routes configured by `bullswarm setup`.

The planner does not author phases or declare success/failure. The kernel
derives stable presentation stages for the TUI and computes the final V2
result. Saved V2 runs retain their original execution and workspace policy on
resume. V1 autonomous run directories are not migrated or resumed;
explicitly naming one fails before any paid dispatch. Fixed JSON workflows and
drafts remain a separate authored-graph feature with their existing step
types.

The detached response includes a short ID and exact observation commands:

```bash
bullswarm workflow runs show <shortId>
bullswarm workflow watch <shortId>        # V2: attach, then one line per notable event
bullswarm workflow watch <shortId> --next # print the next notable event and exit
bullswarm workflow                         # unified human workflow home
bullswarm workflow tui <shortId>          # jump directly to one run timeline
bullswarm workflow tui --json <shortId>
bullswarm workflow events --json <shortId> --after 0
bullswarm workflow action show --json <shortId> <actionId>
```

Manage a run with first-class verbs:

```bash
bullswarm workflow steer  <shortId> --message "<guidance>"   # next planning boundary
bullswarm workflow cancel <shortId> --json                   # a paused run is finalized here
bullswarm workflow resume <shortId> --watch                  # verb form of goal --resume
```

`--orchestrator <pool>` expresses a preference and immediately falls back to
another eligible pool if that provider is quota-gated or unavailable; plain
`--orchestrator auto` leaves selection to the kernel. For controlled provider
QA only, add `--orchestrator-strict` to require that exact pool and fail if it
is not available. Controlled comparisons can additionally pin the exact planner
and worker routes without changing global strategy:

```bash
bullswarm workflow goal "Implement and verify the change" --cwd . \
  --orchestrator codex --orchestrator-strict --orchestrator-model gpt-5.6-sol \
  --worker-pool opencode2 --worker-model relay/gpt-5.6-luna
```

These pins, plus `--suggested-plan` and `--no-scout`, apply only with
`--orchestrator`. When you are the planner, the plan is the program.

The worker lock covers scout, work actions, and evidence actions. A pool that cannot guarantee
the requested model is ineligible rather than silently substituting another
model.

The `opencode2` connector itself does not require a Relay provider: its base
spawn command carries no hardcoded model, so a plain OpenCode installation
dispatches with OpenCode's own configured default. When
`~/.config/opencode/opencode.json` has one or more Relay providers configured,
Bullswarm discovers them and pins an explicit `--model <providerId>/gpt-5.6-luna`
per provider — the first as the primary `opencode2` pool, each additional one
as its own `opencode2:<id>` pool — which is what the `--worker-model
relay/gpt-5.6-luna` example above locks onto.

`--max-agents`, `--max-actions`, and `--max-expansion-rounds` are soft V2
planning targets: they guide the planner toward a small program but do not
hard-stop useful work. `--concurrency` is the actual bound on simultaneous
dependency-ready dispatches. There is no default wall-clock timeout: fresh
semantic/transport heartbeats allow a useful worker to continue, while silence
is inspected rather than blindly killed.
New goal runs use the shared workspace regardless of the older setup
worktree-isolation preference. Add `--isolation` to `workflow goal` when you
explicitly want per-worker worktrees and strict ownership before integration.
Pass it to `workflow plan contract` and `workflow plan validate` as well so the
contract describes that run. Shared execution does no manifest scan, copying,
integration, or rollback. Its final Git inventory is advisory, includes
pre-existing/concurrent changes, and never prevents completion if unavailable.

## Building a workflow from the shell

### You are the planner: `--program` and `workflow plan`

This is the default. The calling agent (Claude Code, Codex, or any frontier
model with the repository in context) is the Workflow Planner, instead of the
kernel paying for a dispatched scout and planner that cannot see the
conversation. The kernel handles graph validation, quota routing, scheduling,
mechanical retries, optional evidence, durable recovery, and the result envelope while the
caller supplies the program, exactly the division of labour Claude Code's
`Workflow` tool uses between the authoring model and its harness.

```bash
bullswarm workflow plan contract "1. Fix the parser. 2. Update the docs." --cwd . --json
#   → requirement IDs (requirement-1..n), rules, action fields, validation, example
bullswarm workflow plan validate "1. Fix the parser. 2. Update the docs." --cwd . --program plan.json --json
#   → dry run against that contract; exit 0 valid, exit 2 with the issues; nothing launches
bullswarm workflow goal "1. Fix the parser. 2. Update the docs." --cwd . --program plan.json --watch
#   → validated before launch; executes with zero planner/scout dispatches
bullswarm workflow plan show <shortId> --json      # initial scout or explicit steering pause
bullswarm workflow plan submit <shortId> --program plan-2.json --watch
```

Exit codes are a contract: **0** done or paused durably for you (nothing is
running), **1** the run ended without completing, **2** usage or validation
error with nothing launched. Every refusal names the commands that come next.

For foreground execution, exit 0 means the graph ran successfully or paused
durably; it does not imply independent verification. An independent launch
also returns 0 before the workers finish. Consume its eventual result.

`--program` accepts the planner response envelope or a bare
`bullswarm.workflow.program.v2` document. An invalid program exits 2 with the
validator's issues and nothing is launched. When the kernel reaches a planning
boundary for an initial plan or queued user steering, it writes
`planner-request-turn-N.json`, sets the run to `waiting`, exits, and `watch` prints the
`plan show` command. A submitted program contains only new actions and is
validated against the exact durable state at that boundary. Older saved V2
runs still support their original gap boundaries and `--exhausted` submissions.
`--scout` without
`--program` runs the kernel scout first and pauses at the initial boundary so
the caller plans against a real survey; scout units are advisory for a caller
planner.

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
    --add-dir '{{inputs.targetDir}}'
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
bullswarm workflow runs --all --since 7d   # initiated in the last 7 days
bullswarm workflow runs --historical --since yesterday --until today
bullswarm workflow runs --all --from 2026-08-20 --to 2026-08-27
bullswarm workflow runs --limit 20         # cap the result count
bullswarm workflow runs show <shortId>     # state + report + summary
bullswarm workflow runs result <shortId> --json  # stable result for the calling agent
bullswarm runs show <shortId>              # top-level shorthand
bullswarm workflow runs delete <shortId> --yes    # remove the run dir

# Resume by shortId — runs the same logic as the full runId
bullswarm workflow run audit-code --resume <shortId>
```

Run-history time filters always compare when the workflow was initiated
(`startedAt`), never when it finished. `--since` is inclusive and `--until` is
exclusive; `--started-after`/`--from` and `--started-before`/`--to` are aliases.
Values accept ISO timestamps, local `YYYY-MM-DD` dates, `today`, `yesterday`,
`tomorrow`, `now`, or relative durations such as `30m`, `24h`, `7d`, and `2w`.

After a workflow reaches a terminal state, agents should consume
`workflow runs result <id> --json` instead of probing `state.json`, task files,
or provider-specific output. Autonomous V2 returns the versioned
`bullswarm.workflow.result.v2` envelope with kernel-computed status, fresh
requirement evidence, per-action status/failure/output files, explicit gaps,
usage, and verification qualification. New programs include `executionMode:
"program"` and a `workspace` report with `changedFiles`, `baselineChangedFiles`,
and warnings. This is a Git status inventory, not attribution to individual
workers; files stay in the target directory. A completed program may be
unverified and contain negative evidence. Fixed authored workflows retain their existing
result envelope. `runs show` remains the low-level debugging surface.
Goal launch output includes an `instructions` handoff with four named paths:
`agentInspect` for a machine-readable snapshot, `watch` for low-noise progress,
`humanTui` for the interactive browser, and `result` for the terminal delivery.
Use `--watch` when the initiating terminal should immediately follow progress;
otherwise the command returns after printing this handoff.
Time filters preserve the existing scope, so use `--all` or `--historical` when
auditing completed runs.

### Live workflow dashboard

For ordinary observation, use the non-interactive watcher. For V2 runs it
prints one attach line, then one line per notable event as it happens
(action finished/failed/blocked/cancelled, evidence, stage completion,
planner turn, stall/recovery, cancellation, and the existing pause and
terminal `outcome:` / `next:` lines) and stays silent while work is merely
in progress. Agent starts, mechanical retries, and steering delivery print
only with `--verbose`. The periodic heartbeat is off unless you pass
`--heartbeat <seconds>`; `--stall-after <seconds>` (default 300) reports a
running agent that has gone silent. `--next` prints no attach line and
exits after the first notable event so a background terminal can wake the
caller; relaunch until the outcome line reports a pause or a terminal
status (exit 0 while the run continues or delivered, 1 when it ended
without delivering or the kernel is not running). `--jsonl` emits one JSON
object per notable event with a stable `type` (`attach`, `action.finished`,
`evidence.recorded`, `stage.completed`, `planner.finished`, `agent.stalled`,
`agent.recovered`, `cancellation.requested`, `paused`, `finished`,
`interrupted`, and with `--verbose` `action.started`, `attempt.retrying`,
`steering.delivered`). `--once` still prints one current snapshot. Legacy
(non-V2) runs keep the compact transition-plus-heartbeat stream unchanged.

```bash
bullswarm workflow watch <shortId>
bullswarm workflow watch <shortId> --next        # next notable event, then exit
bullswarm workflow watch <shortId> --jsonl       # one JSON object per event
bullswarm workflow watch <shortId> --once        # one current/terminal snapshot
bullswarm workflow watch <shortId> --verbose     # started / retry / steering too
bullswarm workflow watch <shortId> --stall-after 120 --heartbeat 30
```

`workflow tui` is the interactive, Claude-style `/workflows` view. For an
autonomous goal its left navigation stacks a compact Workflow Planner panel
above the Phases panel; internal planner turns never appear as workers or phases.
The default desktop main panel is a timestamped workflow timeline: completed
preflight, planner-checkpoint, phase-transition, and worker-result events stay
above a live section containing the waiting/running Workflow Planner and workers,
each with its latest semantic action and stream heartbeat. Planned work is kept
in a separate Next section so it cannot be mistaken for execution evidence.
Select Workflow Planner and press Enter, or press `o`
anywhere, to open a summary-first planner overview: what it is doing now,
its latest decision in plain language, why it chose that path, what happens
next, progress, and the last three semantic actions. Press `v` from the timeline
for workflow technical state, or from Workflow Planner for provider session,
every checkpoint turn, usage, prompt, and artifact paths. Status marks are consistent throughout the tree: `○` not started,
an animated Braille spinner for active work, `⧖` waiting, `✓` finished, and
`✗` failed or interrupted. The non-emoji `⧖` avoids the inconsistent cell
width of `⌛` across terminal fonts. It watches ongoing runs from disk and supports `j`/`k` or arrow-key selection, Enter for
details, Esc to go back, `c` to request a confirmed cooperative stop, `r` to
refresh, and `q` to detach. Its responsive drill-down fits both desktop and
mobile SSH terminals without squeezing phase, agent, and activity into three
narrow columns. Below 100 columns it opens on a full-width timeline; press `t`
to toggle Timeline and Phases, then use Enter/Esc for agents and activity.

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
bullswarm workflow steer <id> --message "Prefer focused tests before another full suite"
bullswarm workflow action show --json <id> <actionId>
bullswarm workflow approval approve --json <id>  # then resume the run
```

Cancellation stops active delegates and commits `cancelled`. V2 goal workflows
keep the operator request in a separate durable file so kernel progress cannot
overwrite it; authored V1 graphs additionally expose a `cancelling` state.
`SIGTERM` and `SIGINT` stop delegate process groups and commit a resumable
`interrupted` state. A V2 resume holds an exclusive kernel lease, stops recorded
surviving delegates from the previous kernel, and finishes post-processing from
durable successful-attempt receipts instead of dispatching that work again.

Watchers identify dead kernels as interrupted; V2 state is reconciled on resume.
Unfinished attempts may execute again, so external side effects still require
idempotency. Shared edits are retained. Failed or interrupted isolated trees
are preserved for inspection; result warnings identify any retained trees.
Recovery refuses to overwrite conflicting user edits during integration.

`workflow steer` is optional operator guidance, not hot-patching. It appends a
durable instruction that is delivered only to the next not-yet-started
`decide` checkpoint; the active worker continues unchanged. Steering remains
inside the original goal and authorization boundary and cannot bypass runtime
validation or required verification. Static workflows and terminal runs reject
steering because they have no future orchestration checkpoint.
Live attempts record the last stdout/stderr activity time and observed byte
count separately from the runner heartbeat. This makes a silent process
visible without treating elapsed wall time alone as proof that it is hung.
Supported coding-agent connectors also enable their native JSONL event mode and
declaratively map provider events into a common semantic action record:

```json
{"id":"provider-action-id","at":"...","kind":"shell_command|read_file|edit|response","status":"running|completed|failed","summary":"safe scalar preview"}
```

The live workflow pane retains and numbers the latest three logical actions per agent.
Repeated updates for the same tool call replace its status, and streaming text
chunks coalesce into one response action. Heartbeats, token/thought deltas,
usage messages, hooks, and unparsed output remain liveness evidence but do not
occupy the action pane. The viewer tracks the total logical-action count so it
can display `last 3 of N`, and completed-agent detail includes a scrollable
Outcome read from the durable output artifact. Connector-specific flags, paths, and mappings live in
`connectors/*.json` under `eventStream`; core contains no provider event names.
Raw structured stdout is treated as an agent transcript, not a provider error
channel, so reading source text such as an auth-signature matcher cannot falsely
quarantine Grok or Command Code. Error-shaped semantic results and stderr
diagnostics still trigger the auth/quota guard.

After ten minutes without transport, parsed-event, or semantic-action evidence,
an active child is labeled `suspected_stalled`. This is an inspection signal,
not a death verdict and never an automatic kill: buffered CLIs can be silent
while working. Process exit, a fatal auth/quota signature, explicit operator
cancellation, or an opt-in timeout remain the terminal signals.

Each attempt records the phase/action, selected pool and model, effort tier,
routing reason, all eligible candidates with quota surplus, timestamps,
artifact paths, outcome, and reported-or-estimated token/cost/quota usage.
`workflow tui <id>` renders this breakdown for completed runs as well as live
ones; `workflow tui --json <id>` exposes the durable audit document.
When a provider event stream reports the actual model, Bullswarm records that
runtime value and uses its matching connector rate metadata for the attempt's
cost estimate. Unknown or provider-hidden model identity remains explicitly
unknown.

### Authored adaptive graphs

This is part of the separately authored fixed-graph engine, not the autonomous
V2 `workflow goal` path. A graph may add an explicit `decide` step, advisory
resource targets, and structural expansion limits:

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

For an authored adaptive graph, `maxAgents`, `maxWorkflowSeconds`, and
`maxExpansionRounds` are advisory inputs to its decide step. Approaching them
strongly biases that step toward
consolidating existing artifacts and returning the best useful outcome;
crossing them is recorded but never stops a worker, skips verification, or
fails a run. `maxActions` and `maxItemsPerExpansion` remain hard structural
safeguards. Reaching one returns a qualified outcome when useful work exists,
rather than discarding the run as a blanket failure. Delegates have no
implicit wall-clock timeout; set a step's `timeoutSec` (or direct-run
`--timeout`) only when an operator explicitly wants a hard termination timer.

Within this authored-graph engine, `complete` remains strictly verified. A
decide-step `stop` still
delivers a completed outcome when a useful delivery exists: unresolved
verification concerns and the stopping reason ride along as `outcome.concerns`
and `outcome.reason`, attributes of that completed outcome rather than a
separate terminal status. `stop` produces `blocked` only when no useful
delivery exists. `workflow runs result` treats the completed outcome as ready
while reporting `verified:false`. The status value `completed_with_concerns`
still appears on some runs — including legacy ones recorded before this
framing — and every consumer reads it exactly like `completed`: a delivered
result with concerns to review, never a failure.

The planner returns versioned JSON. It may propose `needs_more_work` with
bounded `run`, inline-`fanout`, or `verify` actions. The deterministic runtime
validates IDs, dependencies, operation types, capabilities, and budgets before
appending anything. It executes ready actions, observes their durable results,
and calls the planner again. `events.jsonl`, `state.json`, the TUI, and JSON
inspection expose the same plan, actions, attempts, decisions, budgets, and
artifacts. See `workflows/adaptive-code-review.json` for a complete example.
Planner actions cannot set `pool`, `model`, `addDir`, or `taskFile`. If those need to be
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
