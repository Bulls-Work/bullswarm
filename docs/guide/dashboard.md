---
title: Live workflow dashboard
permalink: /guide/dashboard/
---

For ordinary observation, use the non-interactive watcher. On the current
workflow engine (V2) it prints one attach line, then one line per notable
event as it happens (action finished/failed/blocked/cancelled, evidence,
stage completion, planner turn, stall/recovery, cancellation, and the
existing pause and terminal `outcome:` / `next:` lines) and stays silent
while work is merely in progress. A terminal watch's `next:` line is
`bullswarm workflow runs result <shortId> --json --summary`.

Agent starts, mechanical retries, and steering delivery print only with
`--verbose`. A usage-limit failure (`failureKind: 'quota'`) always prints,
verbose or not: `⚠ <actionId> usage limit on <pool> · paused until
<deadline> · retrying on another pool`, followed once the mechanical retry
lands on another pool by `↺ <actionId> now on <pool> · <model>`.

The periodic heartbeat is off unless you pass `--heartbeat <seconds>`;
`--stall-after <seconds>` (default 300) reports a running agent that has
gone silent. Pass `--classic` to force the older heartbeat-based watcher
instead (the transition-on-change snapshot stream plus a periodic
heartbeat, every 60 seconds unless `--heartbeat <seconds>` is given).
`--classic` applies only to V2 runs and cannot combine with `--next`, which
exists only for event mode.

`--next` prints no attach line and exits after the first notable event so a
background terminal can wake the caller; relaunch until the outcome line
reports a pause or a terminal status (exit 0 while the run continues or
delivered, 1 when it ended without delivering or the kernel is not
running). Every `--next` exit that leaves the run going ends with a
relaunch line —
`next: bullswarm workflow watch <shortId> --next --after <sequence> --since <iso>` —
and the relaunch should copy those two values verbatim: `--after` starts
from the durable event sequence the previous watcher consumed, so events
committed while nothing was attached are printed instead of skipped, and
`--since` is that watcher's exit time, so an agent whose silence it already
reported does not produce a duplicate stall line (its recovery still
prints).

`--jsonl` emits one JSON object per notable event with a stable `type`
(`attach`, `action.finished`, `evidence.recorded`, `stage.completed`,
`planner.finished`, `agent.stalled`, `agent.recovered`,
`cancellation.requested`, `attempt.quota`, `attempt.moved`, `paused`,
`finished`, `interrupted`, and with `--verbose` `action.started`,
`attempt.retrying`, `steering.delivered`); in that mode the relaunch line
is not printed and every object instead carries the `sequence` it was
emitted at, which is the value to pass as `--after`. `--once` still prints
one current snapshot. A legacy (pre-0.27.0 authored-graph) run cannot be
watched at all: the watcher prints the legacy line and exits 2 before it
polls anything.

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

### Terminal glyphs

The live views draw a Braille spinner and symbol status icons. macOS
Terminal.app cannot render them: Andale Mono, Menlo, SF Mono, Monaco and
Courier New all have zero glyphs in `U+2800-U+28FF`, and none has `⧖`, so the
dashboard repaints a flashing `?` where each one should be. Apple Terminal is
detected and given a one-column ASCII table instead (`|/-\` spinner, `+`
succeeded, `x` failed, `:` waiting, `#` blocked). Panel borders are unchanged —
box drawing is present in every one of those fonts.

Override the detection either way:

```bash
BULLSWARM_ASCII=1 bullswarm workflow      # force ascii (any terminal showing ?)
BULLSWARM_UNICODE=1 bullswarm workflow    # force unicode (font does have them)
```

A non-UTF-8 locale, `TERM=dumb` and `TERM=linux` also select ASCII.

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
keep the operator request in a separate durable file so kernel progress (the
runtime's own writes) cannot overwrite it.
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

How a usage-limit failure is classified, quarantined, and re-probed is covered
in [Routing](./routing.md#quarantine-on-a-usage-limit) — this is what the
`⚠`/`↺` watch lines above are reporting.

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
