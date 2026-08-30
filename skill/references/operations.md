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
bullswarm strategy show --json
```

Automatic routing chooses the most-behind capable eligible pool, honors burst
gates and quarantine, and applies only explicitly approved model assignments
and exclusions. Never weaken those controls in a prompt.

## Recovery and stopping rules

- Auth/throttle signatures quarantine the affected pool; later dispatches use
  another eligible pool.
- A quota-gated preferred orchestrator falls back unless it was strictly pinned
  for QA.
- Silence is evidence to inspect, not automatic proof of a hang. Check the TUI
  or JSON activity and stall fields before cancellation.
- Malformed planner decisions receive bounded correction turns, then one
  orchestrator escalation, before a truthful qualified outcome.
- `completed_with_concerns` can be a ready verified result. Read the concerns;
  do not equate it with total failure.
- Use cancellation only for a genuinely hung or no-longer-authorized run.
