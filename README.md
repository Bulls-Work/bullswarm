# bullswarm

Route work across coding-agent CLIs. For a goal, Bullswarm chooses a capable
Workflow Planner, validates its bounded generic action program, routes work and
evidence agents by quota, and computes completion from a durable requirement
ledger without an initiating agent authoring a graph.
Every delegate output is judged by content before it counts.

## Entry points

There are exactly two ways to start work:

```bash
bullswarm run --lane analyze --add-dir ~/some-repo --prompt "Explain the parser" --json
bullswarm workflow goal "Fix the failing tests and verify the change" --cwd ~/some-repo --program plan.json
```

`bullswarm run` is the single-agent entry point: route, dispatch, watch,
verify, one JSON verdict. `bullswarm workflow goal` is the workflow entry
point: you author the bounded action program and the kernel executes it to the
end. For agents, `/bullswarm` (or `$bullswarm` where skills use that syntax)
reads the packaged skill and goes straight to one of those two. The calling
agent decides the shape itself from the request — one bounded outcome takes
`run`, parallel territories, integration, or independent acceptance take
`workflow goal`. There is no preview, classifier, or dispatcher command
between them.

Every command and nested subcommand supports contextual `-h` / `--help`
without initializing state or executing the command:

```bash
bullswarm --help
bullswarm workflow goal --help
bullswarm workflow runs show --help
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
   *cheaper* pool. Lanes are work-nature, never hard-coded to pools. The
   5-hour window never paces — it gates: a pool at or above 75% of it is
   chosen only when no eligible pool below that line exists, and one at or
   above 90% is not dispatched at all.
3. **Delegate output is evidence, never authority.** The Workflow Planner may
   propose actions, but only the deterministic kernel validates the program,
   accepts requirement-scoped evidence, and computes completion.
4. **Quarantine re-probes.** A benched pool must be able to return to service
   automatically; a lane is never allowed to silently go down. A pool benched
   for a usage limit waits for the reset the provider named, not a flat
   guess — and never longer.

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
```

## Verbs

| Verb | Purpose |
|---|---|
| `setup` | Discover installed agent CLIs, show quota state, toggle pools, suggest a routing table, write config. Approval-gated, idempotent. |
| `integrate` | Register or remove the canonical Bullswarm skill and global awareness rules for Codex, Claude, and Grok. |
| `run` | route → dispatch → watch → verify → one JSON verdict |
| `health` | Re-judge saved outputs against their verdicts; surface verify-gate failures and quarantine clusters |
| `pools` | Show each pool's meter state, pace position, 5-hour utilization (`5h=<n>%`, flagged `NEAR-5H-LIMIT` at or above 75%), quarantine status |
| `strategy` | Interactive provider/model control center with live high/medium/low route previews and an agent-facing JSON API |
| `doctor` | Machine-readable readiness report; self-heals on first call |
| `workflow` | Plan, execute, observe, and operate one autonomous workflow engine and its live instances. |
| `runs` | Short alias for `workflow runs`, including list, show, result, and delete operations. |
| `version` / `--version` | Print the installed Bullswarm version. |
| `release` | Run the guarded local version-bump, commit, and tag workflow used before CI publishes to npm. |

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
bullswarm strategy configure --file strategy.json --yes  # atomic agent-created policy
bullswarm strategy reset-tier low --yes     # restore one tier to automatic
bullswarm strategy set-reasoning --tier high --level xhigh --yes
bullswarm strategy set-reasoning --tier high --level high --pool codex --yes
bullswarm strategy reset-reasoning --tier high --yes  # back to connector defaults
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

### Rungs

A **rung** is one pool's model *plus its reasoning level* for one effort tier —
the two halves you actually choose together. `bullswarm strategy rungs` reads
them as one table and `bullswarm strategy set-rung` writes both halves in one
atomic save:

```bash
bullswarm strategy rungs                      # every enabled pool x configured tier
bullswarm strategy rungs --json --pool codex  # machine-readable, one pool
bullswarm strategy set-rung codex high --model gpt-5.6-sol --reasoning xhigh
```

Each row carries the effective model and where it came from, the effective
reasoning level and which layer chose it, the dated benchmark evidence for that
model *at that reasoning level* (`blended`, `$/task`, `tok/task`), and what this
machine recorded for that pool and tier (dispatch count, median wall minutes, ok
share). Evidence and record are never estimated: a model the datapack does not
cover prints `no evidence`, and a tier with no matching attempt prints `no
dispatches`. `strategy inventory --json` carries the identical rows under
`rungs`.

Reading is free of side effects — no state write, no model discovery, no
download. `set-rung` never spawns discovery either: a model absent from the
pool's cached discovery exits 2 and lists the models it does know, unless you
pass `--force`. A reasoning level the connector cannot express is clamped down
to the strongest level it accepts and the clamp is printed. A rung is singular
per pool and tier, so the tier moves off whichever model held it while that
model keeps its other tiers. Nothing about `state.json` changed shape: rungs are
a view over `strategy.modelTiers` and `strategy.reasoning`.

The Relay-backed OpenCode pools (`opencode2`, `opencode2:relay-2`,
`opencode2:relay-3`) express reasoning as opencode's `--variant <level>`, at the
same five levels as `command-code`. opencode only forwards a variant its own
config declares for that model, so bullswarm injects them: each pool is spawned
with `OPENCODE_CONFIG_CONTENT` declaring `low`/`medium`/`high`/`xhigh`/`max` as
`reasoningEffort` variants of `<providerId>/gpt-5.6-luna`, merged over your
`~/.config/opencode/opencode.json` (your API keys stay in force). Without that
injection opencode accepts `--variant` and silently drops it. Set a rung per
pool, using that pool's own provider prefix:

```bash
bullswarm strategy set-rung opencode2:relay-2 medium \
  --model relay-2/gpt-5.6-luna --reasoning max
```

If you set `OPENCODE_CONFIG_CONTENT` yourself in
`~/.bullswarm/connectors/opencode2.json`, bullswarm leaves it alone and injects
nothing — you own the variants from then on.

The benchmark evidence comes from Epoch AI's benchmarking hub, used under
CC BY 4.0: Epoch AI, 'AI Benchmarking Hub'. Published online at epoch.ai.
Retrieved from <https://epoch.ai/benchmarks>. `blended` is the mean of the
cursorbench, deepswe, arc-agi-2, and critpt scores recorded for that exact
model and reasoning level; cost and tokens per task come from cursorbench. See
[data/README.md](data/README.md) for the schema and the refresh job.

Setup first asks whether to analyze live usage and recommend routes or open the
current configuration for manual editing. Analysis shows a spinner plus
per-provider usage progress, then presents the proposed defaults before making
any routing change. Press `Y` to apply them or `N` to retain the current policy.
The analysis selects at most one default model for each provider and effort
tier. It uses OpenRouter's agentic, coding, and intelligence indices as quality
signals and API-equivalent pricing as the budget signal. A repository-owned
benchmark refresh job refreshes two public assets on the rolling
`benchmark-data-latest` GitHub Release:
`openrouter-benchmarks.json` from the authenticated OpenRouter APIs, and
`epoch-benchmarks.json` from Epoch AI's CC BY 4.0 benchmark export, which is
what `strategy rungs` reads for per-model-per-reasoning-level evidence.
Installed CLIs download only those public files and never need or receive an
OpenRouter key.
The sources are OpenRouter's [benchmarks API](https://openrouter.ai/docs/api/api-reference/benchmarks/list-benchmarks)
and [models API](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties).
The CLI caches each datapack under `~/.bullswarm/cache/`. OpenRouter is
cache-or-network only: a fresh cache is used as-is, otherwise the rolling
release is fetched, and a cache miss with no network yields an empty catalog
plus connector metadata — there is no bundled `data/openrouter-benchmarks.json`.
Epoch keeps `data/epoch-benchmarks.json` as a bundled last-resort, so a missing
network never blocks setup when that file exists.

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
only a preference: quarantine, exhaustion, burst gates, 5-hour headroom, and
capability checks still win. Routing prefers pools below
`FIVE_HOUR_NEAR_LIMIT_PCT` (75) of their 5-hour window over pools at or above
it, ahead of pace, an approved assignment, and incumbency; a near-limit pool is
still picked when it is the only eligible one, and a pool with no 5-hour
reading counts as having headroom. The routing reason and every candidate row
name the utilization that decided the pick, and meters and quarantines are
re-read before each dispatch — and again, live, right after a usage limit —
so a long run never routes off the snapshot it launched with.

Those thresholds are applied to the FORECAST, not to the last reading. A meter
reading is already old when it arrives: agents dispatched seconds ago have
spent quota the provider has not reported yet, and the assignment being routed
will spend more. So each pool's projection — its reading plus the quota its
in-flight agents are still expected to burn — gets this candidate's own
expected consumption added, and the tiers apply to that number: a pool
projected at or above 75% drops to the near-limit tier even while its reading
is lower, and one projected at or above `BURST_BLOCK_PCT` (90) is left out of
selection entirely as forecast-gated. If every capable pool is forecast-gated,
routing still names the least loaded of them rather than stranding the action,
and says so in the reason. A pool with no measured rate forecasts nothing and
is never gated or deprioritized for a number nobody produced.

Within a tier, pools already carrying work yield to quieter pools of similar
pace: each pool's surplus is reduced by the weekly quota its in-flight agents
and this assignment are expected to spend, and by at least a flat 3 surplus
points per in-flight agent. That floor is what spreads work at real rates,
where a six-minute agent projects to well under one point; the charge is
labeled `penalty` when the floor set it and carries its measured basis
(`history`, `bootstrap`) when the projection was larger. Load also beats
incumbency: an incumbent carrying more in-flight agents than a challenger keeps
neither its 10-point margin nor its cost protection, so the quieter pool wins
as soon as its effective surplus is higher. A burst of parallel actions
therefore spreads across providers instead of stacking on the single
most-behind one.
`bullswarm pools` shows each pool's `inflight=<n>` count and its 5-hour column
as `5h=<reading>%-><projected>%` whenever in-flight work is expected to move
it, `bullswarm assignments` lists what those agents are, `bullswarm run
--dry-run` prints the forecast the pick was made on without registering
anything, and every candidate row carries `pace`, `effectiveSurplus`,
`inflight`, `projectedFiveHourPct`, `forecastFiveHourPct`, `ratePerMinute`,
`estimateSource` and `forecastGated`, so a surprising pick can be read back
number by number.

The rates come from real records: every live meter reading is retained as a
capped per-pool series (`~/.bullswarm/meters/history/<pool>.jsonl`) and paired
with the worker-minutes dispatched between readings. Until at least five
worker-minutes of dispatch are attributable to a window there is no rate at
all — `null`, not a ratio of percentage points to seconds — so a fresh machine
routes on pace and the flat penalty until it has measured something. The
penalty itself is `config.inflightPenaltyPct` in `~/.bullswarm/state.json`
(default 3; `0` turns the tie-breaker off).

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

For normal multi-step work, give Bullswarm the goal and the program you author
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
the scheduler can batch a wider useful program safely. There is no default
wall-clock timeout: fresh semantic/transport heartbeats allow a useful worker
to continue, while silence is inspected rather than blindly killed.

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

### Kinds

Stating lane and effort separately on every action means re-deciding two
fields for work whose nature already implies both. The optional `kind` field
names that nature once and derives them:

| `kind` | lane | effort |
| --- | --- | --- |
| `mechanical` | chore | low |
| `io-read` | analyze | low |
| `digest` | analyze | low |
| `check` | analyze | medium |
| `implement` | build | medium |
| `integration` | build | high |
| `architecture` | analyze | high |
| `adversarial-acceptance` | analyze | high |

`digest` is the one kind whose instructions the kernel supplies in full — your
prompt for it is focus guidance only. It condenses the
outputs of the actions it depends on — quoting each source's delivered items,
validation numbers, commands, unfinished work, and requests verbatim, one
section per source, with no verdicts of its own — so an expensive consumer
reads one artifact instead of many raw output files, and the digest entry in
that consumer's dependency artifacts still names every digested source for
drill-down. Use one when three or more writers feed a single integrator, or
when a consumer's dependency outputs would exceed roughly 20 KB. A digest must
depend on at least one action, owns no files, needs no `affects`, and no
evidence action may depend on one: evidence reads the real artifacts.

Resolution is per field: an explicit `lane` or `effort` on the action wins,
then the kind table, then an optional program-level `defaults` object — which
may set only `effort` and `reasoning`, because lane follows the individual
action — then the per-lane default table. A `kind` outside that closed list is
a validation error, not a runtime failure: it is a typo in your program, so
`workflow plan validate` exits 2 and nothing launches. A program that uses
neither `kind` nor `defaults` and states `lane` and `effort` on every action
validates and runs exactly as before; the one widening is that `effort` is now
optional and falls back to the per-lane default instead of being rejected.

Two advisories report effort smells without ever rejecting anything.
`all-writers-high` fires when three or more `build`/`chore` actions run and
none is below high effort; `docs-at-high` fires when a `build`/`chore` action
owns only `*.md` files at high effort. `workflow plan validate` includes them
as `advisories` in `--json` and prints `advisory:` lines otherwise, `workflow
goal` prints the same lines at launch, and both keep their exit codes. The
kernel stores them on the run, so `workflow runs show` lists them afterwards,
and `runs result`, `runs show`, and `workflow action show` print `kind` next to
lane and effort.

Reasoning depth is a third, independent decision. An action may carry an
optional `reasoning` field — `low`, `medium`, `high`, `xhigh`, `max`, or
`default` — that sets how hard the picked model thinks on that one action and
outranks every configured level for it. `default` passes nothing and lets the
worker CLI's own setting decide. Omitting the field keeps the configured level.
It never changes the pool, model, or effort tier, so a `low`-effort mechanical
step can still be given `xhigh` thinking and a `high`-effort action can be told
to think cheaply. A connector that does not accept the requested level gets the
nearest level it supports.

The planner does not author phases or declare success/failure. The kernel
derives stable presentation stages for the TUI and computes the final V2
result. Saved V2 runs retain their original execution and workspace policy on
resume. V1 autonomous run directories are not migrated or resumed;
explicitly naming one fails before any paid dispatch.

The detached response includes a short ID and exact observation commands:

```bash
bullswarm workflow runs show <shortId>
bullswarm workflow watch <shortId>        # V2: attach, then one line per notable event
bullswarm workflow watch <shortId> --next # print the next notable event and exit
                                          # relaunch with the --after/--since it prints
bullswarm workflow runs result <shortId> --json --summary  # compact status-loop envelope once terminal
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

Reasoning depth can be pinned for a whole run the same way, without touching
global strategy:

```bash
bullswarm workflow goal "Implement and verify the change" --cwd . \
  --program plan.json --worker-reasoning high --json
bullswarm run --lane build --reasoning xhigh --prompt '<task>' --json
```

`--worker-reasoning` covers scout, work actions, and evidence actions;
`--planner-reasoning` covers a dispatched Workflow Planner and applies only
with `--orchestrator`. Exactly one level is resolved per attempt, and the
first layer that sets one wins — not the strongest: the action's own
`reasoning` field, then the run-wide flag (`--worker-reasoning`,
`--planner-reasoning`, `bullswarm run --reasoning`), then the configured
`strategy.reasoning` level for that pool and tier, then the same for the tier
globally, then the connector's own default for the effort tier, and otherwise
nothing is appended. So an action asking for `low` beats a run-wide `max`.
`default` at any layer stops there and passes nothing, letting the worker
CLI's own setting decide; a connector with no `reasoning` block, or a model it
marks as skipped, never receives a flag. The applied level is recorded on
every attempt with the layer that set it and displayed next to the model, so a
run that thought more cheaply than requested is visible rather than inferred.

The `opencode2` connector itself does not require a Relay provider: its base
spawn command carries no hardcoded model, so a plain OpenCode installation
dispatches with OpenCode's own configured default. When
`~/.config/opencode/opencode.json` has one or more Relay providers configured,
Bullswarm discovers them and pins an explicit `--model <providerId>/gpt-5.6-luna`
per provider — the first as the primary `opencode2` pool, each additional one
as its own `opencode2:<id>` pool — which is what the `--worker-model
relay/gpt-5.6-luna` example above locks onto.

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

## Operating on workflow runs

Every run gets a 6-character shortId (Crockford-style alphabet,
no `0/1/i/l/o`). The full `wf-...` runId stays the durable handle.

```bash
bullswarm workflow runs                    # ongoing only (default)
bullswarm workflow runs --all              # ongoing + historical
bullswarm workflow runs --historical       # only historical
bullswarm workflow runs --name audit-code  # filter by exact goal/name
bullswarm workflow runs --all --since 7d   # initiated in the last 7 days
bullswarm workflow runs --historical --since yesterday --until today
bullswarm workflow runs --all --from 2026-08-20 --to 2026-08-27
bullswarm workflow runs --limit 20         # cap the result count
bullswarm workflow runs show <shortId>     # state + report + summary
bullswarm workflow runs result <shortId> --json --summary  # compact status-loop envelope
bullswarm workflow runs result <shortId> --json            # full envelope (failed/partial, or before judging evidence)
bullswarm runs show <shortId>              # top-level shorthand
bullswarm workflow runs delete <shortId> --yes    # remove the run dir
```

Legacy authored-graph runs are listed as read-only rows marked `legacy`. Every
driving command prints `legacy authored-graph run <shortId>: its executor was
removed in 0.27.0; files remain under <dir>` and exits 2; historical directories
are untouched.

Run-history time filters always compare when the workflow was initiated
(`startedAt`), never when it finished. `--since` is inclusive and `--until` is
exclusive; `--started-after`/`--from` and `--started-before`/`--to` are aliases.
Values accept ISO timestamps, local `YYYY-MM-DD` dates, `today`, `yesterday`,
`tomorrow`, `now`, or relative durations such as `30m`, `24h`, `7d`, and `2w`.

After a workflow reaches a terminal state, agents should consume
`workflow runs result <id> --json --summary` for the status loop instead of
probing `state.json`, task files, or provider-specific output. Read the full
envelope with `--json` alone when the run is failed or partial, or before
judging evidence. Autonomous V2's full document is the versioned
`bullswarm.workflow.result.v2` envelope with kernel-computed status, fresh
requirement evidence, per-action status/failure/output files, explicit gaps,
usage, and verification qualification. New programs include `executionMode:
"program"` and a `workspace` report with `changedFiles`, `baselineChangedFiles`,
and warnings. This is a Git status inventory, not attribution to individual
workers; files stay in the target directory. A completed program may be
unverified and contain negative evidence. `runs show` remains the low-level debugging surface.
Goal launch output includes an `instructions` handoff with four named paths:
`agentInspect` for a machine-readable snapshot, `watch` for low-noise progress,
`humanTui` for the interactive browser, and `result` for the terminal delivery.
Use `--watch` when the initiating terminal should immediately follow progress;
otherwise the command returns after printing this handoff.
Time filters preserve the existing scope, so use `--all` or `--historical` when
auditing completed runs.

### Context diet

The kernel now measures — and can shrink — what it puts in front of a model.
These are UTF-8 byte counts, never tokens.

**Status loop.** Poll with `--summary`; it implies JSON (with or without
`--json`) and prints `schemaVersion: "bullswarm.workflow.result-summary.v1"`:
`runId`, `shortId`, `status`, `verified`, `executionMode`, `reason`,
`finishedAt`, the goal's first line (120 characters) plus `goalBytes`, each
requirement as `{ id, status, mandatory, evidenceCount, why }`, each action as
`{ id, kind, lane, effort, status, pool, model, reasoning, wallSec, outFile,
bytes }`, `concerns: { count, first }`, `usage`, and `next: { full, runDir, outputs }` — every output name is a basename inside `next.runDir`.
The full `bullswarm.workflow.result.v2` envelope is unchanged and remains the
default. Read it (`--json` alone) on a failed or partial run, or before judging
evidence. A terminal `workflow watch` prints the same compact command as
`next:`.

```bash
bullswarm workflow runs result <shortId> --json --summary
bullswarm workflow runs result <shortId> --json
```

`workflow runs result --help` states `Usage: bullswarm workflow runs result
<shortId|runId> [--json] [--summary]`; `--summary` is "print the compact JSON
status-loop envelope; implies --json".

**Bytes.** Every attempt records `bytes: { taskFile, authorPrompt, kernel,
dependencyInputs, output }` — the task file the kernel wrote, the action's own
prompt as authored, the remainder after subtracting that prompt and any
embedded requirement text, the sum of the dependency output files the task
points at (0 when there are none), and the durable out file on completion.
The result envelope copies the last attempt's `bytes` onto `actions[]` and
totals `usage.bytes: { taskFiles, dependencyInputs, outputs }`.
`workflow runs show` appends `in <taskFile>/<dependencyInputs> out <output>`
per attempt (blank when unrecorded). Missing values are null, never guessed.

**Digest.** `kind: "digest"` is analyze/low. It is an extractive condensation
of its dependencies' outputs — quoted delivered items, validation numbers,
commands, unfinished work, and integrator requests; no verdicts of its own.
The kernel writes the whole task; the author's prompt is focus guidance only.
Use one when three or more writers feed a single integrator, or when a
consumer's dependency outputs would exceed roughly 20 KB. A digest must
depend on at least one action, owns no files, has empty `evidenceFor`, and
needs no `affects`. Evidence must not depend on a digest: evidence reads the
real artifacts. Consumers that depend on a digest receive that digest plus a
`digestOf` array of `{ actionId, outputFile }` so they can drill down; those
paths are pointers, not extra `dependencyInputs`. (The kind table above
derives lane and effort.)

```json
{
  "schemaVersion": "bullswarm.workflow.program.v2",
  "actions": [
    { "id": "write-a", "kind": "implement", "dependsOn": [], "ownedFiles": ["a.ts"], "affects": ["requirement-1"], "evidenceFor": [], "purpose": "Write slice A", "prompt": "Implement A and report the checks you ran." },
    { "id": "write-b", "kind": "implement", "dependsOn": [], "ownedFiles": ["b.ts"], "affects": ["requirement-2"], "evidenceFor": [], "purpose": "Write slice B", "prompt": "Implement B and report the checks you ran." },
    { "id": "write-c", "kind": "implement", "dependsOn": [], "ownedFiles": ["c.ts"], "affects": ["requirement-3"], "evidenceFor": [], "purpose": "Write slice C", "prompt": "Implement C and report the checks you ran." },
    { "id": "condense", "kind": "digest", "dependsOn": ["write-a", "write-b", "write-c"], "ownedFiles": [], "affects": [], "evidenceFor": [], "purpose": "Condense the writer outputs", "prompt": "Keep every acceptance number and every shared-file request." },
    { "id": "integrate", "kind": "integration", "dependsOn": ["condense"], "ownedFiles": [], "affects": ["requirement-1", "requirement-2", "requirement-3"], "evidenceFor": [], "purpose": "Integrate and run the gates", "prompt": "Apply every request the digest carries and run the repository gates." }
  ]
}
```

An evidence action for those requirements depends on `write-a`, `write-b`, and
`write-c` — never on `condense`.

### Live workflow dashboard

For ordinary observation, use the non-interactive watcher. For V2 runs it
prints one attach line, then one line per notable event as it happens
(action finished/failed/blocked/cancelled, evidence, stage completion,
planner turn, stall/recovery, cancellation, and the existing pause and
terminal `outcome:` / `next:` lines) and stays silent while work is merely
in progress. A terminal watch's `next:` line is
`bullswarm workflow runs result <shortId> --json --summary`. Agent starts,
mechanical retries, and steering delivery print only with `--verbose`. A usage-limit failure (`failureKind: 'quota'`) always
prints, verbose or not: `⚠ <actionId> usage limit on <pool> · paused until
<deadline> · retrying on another pool`, followed once the mechanical retry
lands on another pool by `↺ <actionId> now on <pool> · <model>`. The
periodic heartbeat is off unless you pass `--heartbeat <seconds>`;
`--stall-after <seconds>` (default 300) reports a running agent that has
gone silent. Pass `--classic` to force the older heartbeat-based watcher
instead (the transition-on-change snapshot stream plus a periodic
heartbeat, every 60 seconds unless `--heartbeat <seconds>` is given).
`--classic` applies only to V2 runs and cannot combine with `--next`, which
exists only for event mode. `--next` prints no attach line and
exits after the first notable event so a background terminal can wake the
caller; relaunch until the outcome line reports a pause or a terminal
status (exit 0 while the run continues or delivered, 1 when it ended
without delivering or the kernel is not running). Every `--next` exit that
leaves the run going ends with a relaunch line —
`next: bullswarm workflow watch <shortId> --next --after <sequence> --since <iso>` —
and the relaunch should copy those two values verbatim: `--after` starts
from the durable event sequence the previous watcher consumed, so events
committed while nothing was attached are printed instead of skipped, and
`--since` is that watcher's exit time, so an agent whose silence it already
reported does not produce a duplicate stall line (its recovery still
prints). `--jsonl` emits one JSON object per notable event with a stable
`type` (`attach`, `action.finished`,
`evidence.recorded`, `stage.completed`, `planner.finished`, `agent.stalled`,
`agent.recovered`, `cancellation.requested`, `attempt.quota`,
`attempt.moved`, `paused`, `finished`,
`interrupted`, and with `--verbose` `action.started`, `attempt.retrying`,
`steering.delivered`); in that mode the relaunch line is not printed and
every object instead carries the `sequence` it was emitted at, which is the
value to pass as `--after`. `--once` still prints one current snapshot. A legacy
(pre-0.27.0 authored-graph) run cannot be watched at all: the watcher prints
the legacy line and exits 2 before it polls anything.

```bash
bullswarm workflow watch <shortId>
bullswarm workflow watch <shortId> --next        # next notable event, then exit
bullswarm workflow watch <shortId> --next --after 42 --since 2026-09-08T10:15:00.000Z
                                                 # the relaunch: values copied from the previous next: line
bullswarm workflow watch <shortId> --jsonl       # one JSON object per event
bullswarm workflow watch <shortId> --once        # one current/terminal snapshot
bullswarm workflow watch <shortId> --verbose     # started / retry / steering too
bullswarm workflow watch <shortId> --stall-after 120 --heartbeat 30
bullswarm workflow watch <shortId> --classic     # older heartbeat-based watcher instead of event mode
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
bullswarm workflow events --json <id> --after 20
bullswarm workflow steer <id> --message "Prefer focused tests before another full suite"
bullswarm workflow action show --json <id> <actionId>
```

Cancellation stops active delegates and commits `cancelled`. V2 goal workflows
keep the operator request in a separate durable file so kernel progress cannot
overwrite it.
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

A provider that reports a usage limit — `You've hit your session limit ·
resets 8:20pm (Asia/Hong_Kong)`, `usage_credits_required`, `rate limit
exceeded`, `quota exceeded` — is its own mechanical failure kind, `quota`,
never `process`, `semantic`, or `auth`. The attempt is killed immediately
even if the CLI would otherwise hang, and the pool is quarantined until the
reset time parsed from the message, falling back to that pool's cached 5-hour
`resets_at` and then to 30 minutes. The quarantine record carries
`kind: 'quota'` and excludes the pool from every later dispatch, in this run
and in others, until it expires; the action is immediately re-dispatched on
another pool with quota and never retried on the one that hit the limit. An
agent report that merely discusses usage limits, or tool output that quotes
them, is not a limit: detection is shape-gated to lines that look like a
provider notice.

After ten minutes without transport, parsed-event, or semantic-action evidence,
an active child is labeled `suspected_stalled`. This is an inspection signal,
not a death verdict and never an automatic kill: buffered CLIs can be silent
while working. Process exit, a fatal auth/quota signature, explicit operator
cancellation, or an opt-in timeout remain the terminal signals.

Each attempt records the phase/action, selected pool and model, effort tier,
the applied reasoning level with the layer that set it, routing reason, all
eligible candidates with quota surplus, timestamps, artifact paths, outcome,
and reported-or-estimated token/cost/quota usage.
`workflow tui <id>` renders this breakdown for completed runs as well as live
ones; `workflow tui --json <id>` exposes the durable audit document.
When a provider event stream reports the actual model, Bullswarm records that
runtime value and uses its matching connector rate metadata for the attempt's
cost estimate. Unknown or provider-hidden model identity remains explicitly
unknown.

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
