# Bullswarm operations reference

Read this reference only after the common `/bullswarm` decision when the task
needs direct commands, workflow operation, or recovery.

## Direct single-agent execution

```bash
bullswarm run --lane <analyze|build|chore> \
  --add-dir <abs-dir> --prompt '<task>' --json
```

The result is usable only when `ok:true`. Read `outFile`; do not infer the
answer from an exit code. `keepOnClaude` means no eligible delegate beat the
caller, so finish in the current session. Lanes describe work, not providers:
`analyze` for reading/judgment, `build` for edits, and `chore` for cheap
mechanical work.

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
bullswarm workflow watch <shortId>
bullswarm workflow tui <shortId>
bullswarm workflow tui --json <shortId>
bullswarm workflow events --json <shortId> --after 0
bullswarm workflow runs result <shortId> --json
```

The default watch is a compact heartbeat. Use `--verbose` only for diagnosis.
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

## Caller-planner runs (the default)

```bash
bullswarm workflow plan contract "<goal>" --cwd=<abs-dir> --json   # requirement IDs, rules, schema, example
bullswarm workflow plan validate "<goal>" --cwd=<abs-dir> --program plan.json --json  # dry run; nothing launches
bullswarm workflow goal "<goal>" --cwd=<abs-dir> --program plan.json --json
bullswarm workflow plan show <shortId> --json                       # pending request: boundary, gaps, known actions
bullswarm workflow plan submit <shortId> --program plan-2.json      # new actions only; relaunches detached
bullswarm workflow plan submit <shortId> --exhausted --reason "<why>"   # gaps boundary only
```

A caller-planner run records `plannerMode: caller` in its goal document, never
dispatches a planner or (by default) a scout, and pauses durably with
`lifecycle.status = waiting` plus a `planner-request-turn-N.json` file in the
run directory whenever a planning boundary is reached. `watch` exits 0 at that
pause and prints the `plan show` command; `runs result` reports the pause until
a program or an exhausted decision is submitted. The submitted program passes
the same validator as a dispatched planner response against the exact durable
state; scout units are advisory in this mode. Resume (`workflow resume`) of a
paused run without a submission re-pauses on the same request.

`plan validate` is the dry run: the same requirement ledger, validator, and
preview state a launch uses, with no run created. Exit 0 prints the accepted
actions and the launch line; exit 2 prints the same issues `workflow goal`
would print, as `{"error": "program-invalid", "issues": [...]}` under `--json`.

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

Automatic routing chooses the most-behind capable eligible pool, honors burst
gates and quarantine, and applies only explicitly approved model assignments
and exclusions. Humans can use bare `bullswarm strategy` to toggle providers
and multi-select high/medium/low per model. Agents should consume the inventory
and apply validated changes with `strategy set-provider`, `strategy set-model`,
or one atomic `strategy configure --file <json> --yes`. Never weaken those
controls in a prompt.

## Recovery and stopping rules

- Auth/throttle signatures quarantine the affected pool; later dispatches use
  another eligible pool.
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
