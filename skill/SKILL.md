---
name: bullswarm
description: Delegate bounded work through Bullswarm to one quota-routed coding agent or a shared-worktree workflow. Use for /bullswarm, offloading, independent verification, or requested multi-agent execution.
---

# Bullswarm

You supply the task or dependency graph. Bullswarm routes workers by quota and
capability, runs them, and saves their outputs. For workflows, **you are the
planner by default**: write the graph once; the kernel executes it to the end.

Keep the user's scope and working directory. Delegate only authorized work;
permission to delegate does not authorize messages, releases, or other external
writes. If `BULLSWARM_DEPTH` is set, do the assigned work directly unless the
task explicitly requires nested delegation.

## 1. Choose the execution shape

Use one agent for a bounded outcome such as a review or localized fix. Use a
workflow for parallel territories, integration, or implementation followed by
independent acceptance. When the user already chose the shape, go directly to
that mode below. Otherwise preview:

```bash
bullswarm delegate --dry-run --json --cwd=<abs-dir> --prompt='<user request>'
```

Tell the user the selected **Single bounded agent** or **Autonomous workflow**,
its `reason`, and the short `phases` plan. Stop here if the user requested only
a plan; otherwise execute without reconfirming:

```bash
bullswarm delegate --mode=<single|workflow> --cwd=<abs-dir> \
  --plan='<decision.suggestedPlan>' --prompt='<same user request>' --json
```

Use `--task-file` instead of `--prompt` for long text or awkward quoting.
The default preview can call a low-effort classifier; add
`--classify deterministic` for a no-provider preview. Do not run `doctor`
unless dispatch reports a readiness problem.

## 2a. One agent

The `delegate --mode=single` result contains `execution`:

- `keepOnClaude: true`: do the work yourself, even if `ok` is true.
- Otherwise, when `ok: true`, read `outFile` and check its content before using it.
- `ok: false`: inspect and report the failure; a successful CLI exit is not
  proof that the work succeeded.

For an explicitly requested direct run:

```bash
bullswarm run --lane=analyze --add-dir=<abs-dir> --prompt='<task>' --json
```

Its result fields are top-level. Choose `build` for edits or `chore` for
mechanical edits; `analyze` is read-only.

## 2b. A workflow

`delegate --mode=workflow` returns `action: "plan-required"` and the planning
contract. This has **not launched workers**. Use that contract; if starting a
workflow directly, get it with:

```bash
bullswarm workflow plan contract '<goal>' --cwd=<abs-dir> --json
```

Use exactly the same goal when validating and launching. Keep `--cwd` fixed to
the absolute target directory even when generating the plan elsewhere. Preserve
the requested outcomes; numbered deliverables produce separate requirement IDs. The contract
contains the current schema, IDs, rules, and a worked program example.

Write `plan.json` from the contract's worked example. The bare program has
`schemaVersion: "bullswarm.workflow.program.v2"` and a populated `actions` array.
Each action needs `id`, `purpose`, `dependsOn`, `affects`, `ownedFiles`, `prompt`, `lane`,
`effort`, and `evidenceFor`. Copy requirement IDs from the contract. Optional
`inputs`/`produces` describe actual artifacts; ordinary dependencies do not
need them. Never put provider/model fields into the program.

Author the graph around these rules:

- **Shared tree:** give each writer an intended `ownedFiles` territory. New
  files survive; territories guide scheduling, not file rejection. Tell workers
  others share the tree, preserve their edits, and report shared-file requests.
- **Real dependencies:** independent actions run concurrently. After parallel
  writers, add a sole integrator depending on all of them, with `lane: "build"`
  and `ownedFiles: []`. It reads their outputs, handles shared-file requests,
  and runs repository acceptance checks. This unrestricted integrator runs alone.
- **Self-contained work:** each prompt names the exact workspace, outcome,
  relevant files, and concrete checks. Use `medium` effort for ordinary build
  or analysis, `low` for mechanical chores, and `high` for difficult judgment.
- **Optional evidence:** an independent check uses `lane: "analyze"`, empty
  `affects`/`ownedFiles`, and `evidenceFor` requirement IDs. Depend on every
  writer affecting those requirements. Describe the checks; the kernel adds
  the evidence JSON instructions. Evidence is optional for graph completion.
- **Optional reasoning depth:** `effort` picks the model tier; the optional
  `reasoning` field picks how hard that model thinks. Values are
  `low|medium|high|xhigh|max`, or `default` to pass nothing and let the worker
  CLI's own setting decide. It applies to that one action and outranks every
  configured level for it — so a `low`-effort integrator can still get `xhigh`
  thinking. Omit it and the configured level applies; it never changes the
  pool, model, or effort tier, and a connector that does not accept the exact
  level gets the nearest level it supports. Set it only when an action needs
  deeper thinking than its tier implies (a tricky shared-file integrator,
  ambiguous acceptance judgment) or cheaper thinking for mechanical work.
  For the whole run instead of one action, pass
  `--worker-reasoning <level>` (and `--planner-reasoning <level>` with
  `--orchestrator`) to `workflow goal`; the contract's `reasoning` block
  echoes what a launch will apply.

Validate, then launch:

```bash
bullswarm workflow plan validate '<goal>' --cwd=<abs-dir> --program=plan.json --json
bullswarm workflow goal '<goal>' --cwd=<abs-dir> --program=plan.json --json
```

An invalid program exits 2 and launches nothing. Fix the reported issues and
validate again. A valid launch detaches and returns `shortId`; report it.

## 3. Observe and judge the result

```bash
bullswarm workflow watch <shortId> --next
bullswarm workflow watch <shortId> --next --after <sequence> --since <iso-timestamp>
bullswarm workflow runs result <shortId> --json
```

When the user asked you to complete the work, follow the run through its result.
Launch `bullswarm workflow watch <shortId> --next` in a background terminal, act
on the printed event when it exits, and relaunch until the outcome line reports
a pause or a terminal status. Each exit that leaves the run going ends with
`next: bullswarm workflow watch <shortId> --next --after <sequence> --since <iso>`:
relaunch with exactly those two values, so events committed while you were
acting are printed instead of skipped and a stall you already saw does not
report twice. In `--jsonl` mode there is no such line — take `--after` from the
`sequence` field of the last object. V2 watch prints one line per notable event
and stays silent while work is merely in progress; `--heartbeat` is opt-in and
`--stall-after` (default 300s) reports a silent running agent. A usage-limit
failure always prints — `⚠ ... usage limit on <pool> · paused until <deadline>
· retrying on another pool`, then `↺ ... now on <pool> · <model>` once the
mechanical retry lands — even without `--verbose`. Pass `--classic` for the
older heartbeat-based watcher instead (it cannot combine with `--next`).
`watch` also exits at a durable planning pause; that is not completion.

Read action outputs and actual artifacts, and probe important edge cases yourself.
`completed` means the graph succeeded; `verified` means the evidence agents
returned passing verdicts, which can still miss bugs. A `partial` result
exposes failed or skipped branches. Negative evidence remains negative and does
not trigger automatic gap-planning rounds. Author follow-up work explicitly
when the requested outcome still needs repairs.

Shared files remain after failure or cancellation. Saved older runs keep their
original execution behavior. Exit 0 can mean launched, paused, or completed;
always inspect the returned status.

Read [operations.md](references/operations.md) only when you need **steering,
cancellation, resume, scouting, a dispatched planner, explicit isolation,
routing diagnosis, or fixed drafts**. Ordinary work needs only the flow above.
