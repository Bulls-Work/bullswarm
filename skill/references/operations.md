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

```bash
bullswarm workflow goal '<goal>' --cwd=<abs-dir> \
  --suggested-plan='<conceptual plan>' --json
```

The default launch detaches and returns `shortId`, exact observation commands,
and log paths. Normal callers should leave pool/model selection automatic.
Pins such as `--strict-orchestrator`, `--orchestrator-model`, `--worker-pool`,
and `--worker-model` are for controlled QA, not ordinary routing.

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

Resume an interrupted autonomous run with:

```bash
bullswarm workflow goal --resume <shortId> --json
```

Autonomous resume is V2-only. An old autonomous run ID fails before dispatch;
there is no migration or fallback executor. Fixed authored workflows and drafts
remain a separate product surface.

## Caller-planner runs

```bash
bullswarm workflow plan contract "<goal>" --cwd=<abs-dir> --json   # requirement IDs, rules, schema, example
bullswarm workflow goal "<goal>" --cwd=<abs-dir> --program plan.json --json
bullswarm workflow plan show <shortId> --json                       # pending request: boundary, gaps, known actions
bullswarm workflow plan submit <shortId> --program plan-2.json      # new actions only; relaunches detached
bullswarm workflow plan submit <shortId> --exhausted --reason "<why>"
```

A caller-planner run records `plannerMode: caller` in its goal document, never
dispatches a planner or (by default) a scout, and pauses durably with
`lifecycle.status = waiting` plus a `planner-request-turn-N.json` file in the
run directory whenever a planning boundary is reached. `watch` exits 0 at that
pause and prints the `plan show` command; `runs result` reports the pause until
a program or an exhausted decision is submitted. The submitted program passes
the same validator as a dispatched planner response against the exact durable
state; scout units are advisory in this mode. Resume (`workflow goal --resume`)
of a paused run without a submission re-pauses on the same request.

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
- `workflow tui --cancel <id>` on a paused run records the request and reports
  `pausedForCaller: true` with the finalize command; `plan submit` then refuses
  every submission, `plan show` and `watch` print
  `bullswarm workflow goal --resume <id> --json`, and that one resume records
  the cancelled result. Finalizing always clears `planner.awaiting`; a terminal
  state that still claims to be waiting is rejected by the state validator.
- A `--program` supplied at launch is kept as `initial-planner-response.json`
  in the run directory until applied, so an interruption during an opt-in
  `--scout` does not lose it.
- Bare value flags (`--program` with no file, `--planner` with no mode) are
  usage errors (exit 2); nothing launches in a different mode. `plan submit`
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
