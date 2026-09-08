# Bullswarm operations reference

Read this reference only after the common `/bullswarm` decision when the task
needs direct commands, workflow operation, or recovery.

## Autonomous workflow execution

`workflow goal` needs a program: the calling agent is the Workflow Planner
unless it asks for a dispatched one. The three ways to start:

```bash
bullswarm workflow goal '<goal>' --cwd=<abs-dir> --program plan.json --json  # you plan (see below)
bullswarm workflow goal '<goal>' --cwd=<abs-dir> --scout                     # kernel surveys, then pauses for your program
bullswarm workflow goal '<goal>' --cwd=<abs-dir> --orchestrator auto \
  --suggested-plan='<conceptual plan>' --json                                # dispatch a planner agent
```

With none of those the command exits 2, launches nothing, and prints the next
commands (`{"error": "program-required", "next": {...}}` under `--json`).

The default launch detaches and returns `shortId`, exact observation commands,
and log paths. Normal callers should leave pool/model selection automatic.
Pins such as `--orchestrator <pool> --orchestrator-strict`,
`--orchestrator-model`, `--worker-pool`, and `--worker-model` are for
controlled QA, not ordinary routing. `--suggested-plan`, `--no-scout`, and the
`--orchestrator-*` pins apply only with `--orchestrator`; when you are the
planner, the plan is the program. `--strict-orchestrator <pool>` is a
deprecated alias for `--orchestrator <pool> --orchestrator-strict`.

Observe and consume:

```bash
bullswarm workflow watch <shortId> --next
bullswarm workflow watch <shortId> --next --after <sequence> --since <iso-timestamp>
bullswarm workflow watch <shortId>
bullswarm workflow tui <shortId>
bullswarm workflow tui --json <shortId>
bullswarm workflow events --json <shortId> --after 0
bullswarm workflow runs result <shortId> --json
```

V2 watch prints one attach line, then one line per notable event, and stays
silent while work is merely in progress. Launch
`bullswarm workflow watch <shortId> --next` in a background terminal, act on the
printed event when it exits, and relaunch until the outcome line reports a
pause or a terminal status. Every `--next` exit that leaves the run going ends
with `next: bullswarm workflow watch <shortId> --next --after <sequence> --since <iso>`;
relaunch with those exact `--after` and `--since` values so events committed
while no watcher was attached are printed rather than skipped and an
already-reported stall does not fire again (its recovery still prints). With
`--jsonl` that line is absent: take `--after` from the `sequence` field carried
by every emitted object. `--heartbeat` is opt-in for V2 (legacy still
defaults to 60s). `--stall-after` (default 300s) reports a silent running
agent. A usage-limit failure always prints, verbose or not: `⚠ ... usage
limit on <pool> · paused until <deadline> · retrying on another pool`, then
`↺ ... now on <pool> · <model>` once the mechanical retry lands on another
pool. Use `--verbose` only for diagnosis. `--classic` forces the older
heartbeat-based watcher (transition-on-change snapshots plus a periodic
heartbeat) instead of event mode; it is a no-op for legacy runs and cannot
combine with `--next`.
The result command is the stable delivery/verification envelope; do not scrape
task files or assume the last provider response is the deliverable.

Manage a live run:

```bash
bullswarm workflow steer   <shortId> --message '<guidance>'   # next planning boundary; active work is unchanged
bullswarm workflow cancel  <shortId> --json                   # cooperative; a paused caller run is finalized here
bullswarm workflow resume  <shortId> [--foreground|--watch]   # verb form of goal --resume
```

Resume keeps the run's durable planner mode, routing pins, and settings;
`--program`, `--orchestrator`, `--scout`, and `--suggested-plan` are rejected
there (use `workflow plan submit` for a caller program). Autonomous resume is
V2-only. An old autonomous run ID fails before dispatch; there is no migration
or fallback executor. Fixed authored workflows and drafts remain a separate
product surface. `bullswarm workflow goal --resume <shortId>` and
`bullswarm workflow tui --cancel <shortId>` remain as aliases.

## Submitting work at a planning pause

Use these commands when `watch` reports a caller-planner pause:

```bash
bullswarm workflow plan show <shortId> --json
bullswarm workflow plan submit <shortId> --program plan-2.json --watch
```

Read the current request and author only new actions; existing action IDs can
be dependencies. New shared programs pause for opt-in scouting or explicit
steering, not negative evidence. A submission is validated before modifying the
run. Resuming without a submission preserves the pause.

Older saved runs can also pause for requirement gaps and accept
`plan submit <shortId> --exhausted --reason '<why>'` there. Do not use
`--exhausted` for a new program or a steering request.

Pause hygiene, all kernel-enforced:

- The pause is authoritative. A resume keeps the recorded boundary and turn
  even when steering was queued meanwhile; the request is refreshed to list the
  pending steering (`pendingSteering`, also merged into `context.steering`).
  `plan show` performs the same refresh (`requestRefreshed: true`) without
  changing run state. A submission marks exactly the listed steering
  delivered (`steering.delivered` events tagged `source: caller`); steering
  queued after the request was shown stays pending and opens a `steering`
  boundary after the resume. A steering boundary needs at least one new action
  (`--exhausted` is valid only at a `gaps` boundary and is only advertised
  there).
- `workflow cancel <id>` on a paused run finalizes it inline: no kernel is
  alive to honor a cooperative request, so the cancelled result envelope is
  written and the pause record cleared in that one command. If cancellation was
  recorded some other way (`tui --cancel`), `plan submit` refuses every
  submission and `plan show`/`watch` print `bullswarm workflow cancel <id>
  --json`. Finalizing always clears `planner.awaiting`; a terminal state that
  still claims to be waiting is rejected by the state validator.
- A `--program` supplied at launch is kept as `initial-planner-response.json`
  in the run directory until applied, so an interruption during an opt-in
  `--scout` does not lose it.
- Bare value flags (`--program` with no file, `--orchestrator` with no pool)
  are usage errors (exit 2); nothing launches in a different mode. `plan submit`
  checks the goal directory before touching state.

## Workspace and concurrency options

New programs share the target tree. Add `--concurrency=3` at launch when a
specific fan-out cap is useful; it does not bypass overlap serialization or
the sole-integrator rule.

Choose strict per-worker worktrees explicitly with `--isolation`, using it for
both `plan contract`/`plan validate` and `workflow goal`. In this mode writers
must list exact files in `ownedFiles`; undeclared files can fail the action and
are not integrated. An unrestricted writer with `ownedFiles: []` is invalid.
Existing runs preserve their saved mode on resume.

## Fixed graphs, fan-out, and adversarial verification

Use `workflow draft` only when exact phases and dependencies are user-authored
requirements. Drafts support `run`, `fanout`, and `verify` steps. A verify must
return JSON `{ok, concerns, summary}` and is successful only when it parses and
`ok` is true.

For data-driven fan-out, make discovery return a JSON array or a schema-backed
object, then use `itemsFrom`. Put `outputSchema` only on worker output that a
later action consumes structurally; ordinary prose should not have a schema.

## Routing and model policy

Inspect current capability and quota evidence with:

```bash
bullswarm workflow capabilities --json
bullswarm pools --json
bullswarm strategy inventory --json
bullswarm strategy routes --json
```

Automatic routing chooses the most-behind capable eligible pool among those
with 5-hour headroom, honors burst gates and quarantine, and applies only
explicitly approved model assignments and exclusions. A pool at or above 75%
of its 5-hour window is picked only when no eligible pool below that line
exists; `bullswarm pools` shows the reading as `5h=<n>%` with a
`NEAR-5H-LIMIT` label, and meters and quarantines are re-read before every
dispatch rather than frozen at launch. Humans can use bare `bullswarm strategy` to toggle providers
and multi-select high/medium/low per model. Agents should consume the inventory
and apply validated changes with `strategy set-provider`, `strategy set-model`,
or one atomic `strategy configure --file <json> --yes`. Never weaken those
controls in a prompt.

## Recovery and stopping rules

- Auth signatures quarantine the affected pool for a 10-minute re-probe
  window; later dispatches use another eligible pool.
- A provider usage limit is the distinct failure kind `quota`: the attempt is
  killed at once, the pool is quarantined until the reset the message named
  (else its cached 5-hour `resets_at`, else 30 minutes), and the action moves
  to a pool that still has quota. The quarantine holds across runs until it
  expires. Discussing usage limits in a report is not a usage limit.
- A quota-gated preferred orchestrator falls back unless it was strictly pinned
  for QA.
- Silence is evidence to inspect, not automatic proof of a hang. Check the TUI
  or JSON activity and stall fields before cancellation.
- A malformed V2 planner program receives one compact deterministic correction
  request. Repeated invalidity ends planning before worker budget is spent.
- Schema-invalid evidence receives a bounded correction in the same physical
  agent conversation. Schema-valid semantic failure updates the requirement
  ledger and never starts an automatic repair loop.
- Concerns remain evidence data. A passed requirement with concerns remains
  passed unless its requirement contract explicitly says otherwise.
- Use cancellation only for a genuinely hung or no-longer-authorized run.
