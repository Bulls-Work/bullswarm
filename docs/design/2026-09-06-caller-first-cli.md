# Caller-first workflow CLI (design, 2026-09-06)

Status: implemented (0.24.0). Breaking for `workflow goal` with no planning
flag. Everything below describes shipped behaviour; the two deviations from the
original proposal are noted inline.

## Principle

The calling agent is the Workflow Planner. `bullswarm workflow goal` needs a
program and refuses to run without one. The kernel dispatches a planner agent
only when the caller says so with `--orchestrator`. Every command answers with
the next valid commands, and exit codes are a contract:

| Exit | Meaning |
| --- | --- |
| 0 | done, or paused durably for the caller (nothing is running) |
| 1 | the run ended without completing, or a runtime error |
| 2 | usage or validation error; nothing was launched or dispatched |

## The agent lifecycle, in command order

```bash
# 1. What the kernel will enforce: requirement IDs, rules, schema, example
bullswarm workflow plan contract "<goal>" --cwd <dir> --json

# 2. Check a program against that contract without launching (NEW)
bullswarm workflow plan validate "<goal>" --program plan.json --cwd <dir> --json

# 3. Launch: you are the planner
bullswarm workflow goal "<goal>" --cwd <dir> --program plan.json [--scout] [--json | --watch | --foreground]

# 4. Follow until terminal or paused (exit 0 at a pause, prints the next command)
bullswarm workflow watch <id>

# 5. At a pause: read the boundary request, author, submit
bullswarm workflow plan show <id> --json
bullswarm workflow plan submit <id> --program plan-2.json [--watch]
bullswarm workflow plan submit <id> --exhausted --reason "<why>"     # gaps boundary only

# 6. The stable result envelope
bullswarm workflow runs result <id> --json
```

Two other ways to start, both explicit:

```bash
# Scout first: the kernel surveys the repository, then pauses at the initial
# boundary for your program (scout units are advisory context)
bullswarm workflow goal "<goal>" --cwd <dir> --scout

# Delegate planning: dispatch a Workflow Planner agent (the old default)
bullswarm workflow goal "<goal>" --cwd <dir> --orchestrator auto|<pool> \
  [--orchestrator-model <model>] [--orchestrator-strict] [--suggested-plan <text>] [--no-scout]
```

## Management verbs (first-class)

```bash
bullswarm workflow steer  <id> --message <text>   # surfaced in the next request (caller) or planner turn (orchestrator)
bullswarm workflow cancel <id> [--json]           # NEW verb (was tui --cancel). Finalizes a paused caller run inline.
bullswarm workflow resume <id> [--json|--watch|--foreground]   # NEW verb (was goal --resume). Idempotent at a pause.
bullswarm workflow runs   list|show|result|delete
bullswarm workflow events <id> --after <n> --json
bullswarm workflow action show <id> <actionId>
bullswarm workflow tui    [<id>]
```

`goal --resume <id>` and `tui --cancel <id>` stay as aliases.

## What `goal` does with each flag combination

| Flags on `workflow goal "<goal>"` | Behaviour |
| --- | --- |
| `--program <file>` | validate against the contract; launch; zero planner and scout dispatches |
| `--program <file> --scout` | scout first, then apply the program (units advisory) |
| `--scout` (no program) | scout, then pause at the initial boundary for the caller |
| `--orchestrator auto\|<pool>` | dispatch a Workflow Planner agent at every boundary; scout on unless `--no-scout` |
| none of the above | **exit 2**, nothing launched, guidance printed (below) |
| `--program` + `--orchestrator` | exit 2: pick one planner |
| `--suggested-plan`, `--no-scout`, `--orchestrator-model`, `--orchestrator-strict` without `--orchestrator` | exit 2: these shape a dispatched planner only |

Removed: `--planner dispatched|caller` (introduced earlier today; the presence
of `--orchestrator` is the switch now). Renamed: `--strict-orchestrator <pool>`
becomes `--orchestrator <pool> --orchestrator-strict`; the old spelling stays
one release as a deprecated alias.

## The guidance an agent receives

Program missing (exit 2), human form (each command followed by its purpose):

```
✗ workflow goal needs a program: you are the Workflow Planner.
  contract      bullswarm workflow plan contract "<goal>" --cwd <dir> --json
  validate      bullswarm workflow plan validate "<goal>" --program plan.json --cwd <dir> --json
  launch        bullswarm workflow goal "<goal>" --cwd <dir> --program plan.json --json
  scout         bullswarm workflow goal "<goal>" --cwd <dir> --scout
  orchestrator  bullswarm workflow goal "<goal>" --cwd <dir> --orchestrator auto
```

**Deviation 1 (found in live testing).** The goal is inlined into these
commands only when it is single-line and at most 120 characters; otherwise it
appears as the literal `"<goal>"`. A multi-line goal rendered as a JSON string
does not round-trip through shell double quotes (`\n` becomes a literal
backslash-n), and inlining a long goal five times buries the commands. Values
that are inlined use POSIX single-quoting, so an apostrophe survives `eval`.

With `--json`: `{ "error": "program-required", "next": { contract, validate, launch, scout, orchestrator } }`.

Program invalid (exit 2): `{ "error": "program-invalid", "issues": [...], "next": { contract, validate } }`,
same validator and same wording as `plan submit`.

Every other state already answers with `next`:

| State | The agent sees | Allowed next |
| --- | --- | --- |
| launched | `goal-launched` + `observe.{watch, plan, result, …}` | watch, steer, cancel |
| running | `watch` progress lines | steer, cancel, tui |
| paused (initial / gaps / steering) | `watch` ends: `outcome: waiting …`, `next: plan show` | plan show, plan submit, plan submit --exhausted (gaps only), steer, cancel |
| paused + cancellation requested | `next: … resume finalizes it` | resume (or cancel, which finalizes inline) |
| submit rejected | issues, exit 2, state unchanged | plan show, plan submit |
| terminal | `outcome: completed\|partial\|cancelled\|failed`, `next: runs result` | runs result, runs delete |

## `bullswarm delegate`

`delegate` keeps its single-agent branch unchanged. When it classifies a task
as workflow-shaped it no longer launches an orchestrated run by default; it
returns the contract and the exact `goal --program` launch line so the calling
agent authors the program. `--orchestrator auto|<pool>` passes through to keep
the old behaviour for callers that do not want to plan.

**Deviation 2.** The envelope's `action` is `"plan-required"` (not `"execute"`)
for that branch, and it carries a `handoff: {launch, orchestrator}` object.
`invocation.verb` is `"plan"`, so a caller can branch on the verb without
parsing the display string.

**Deviation 3 (added after the acceptance matrix).** When the goal collapses to
one requirement, the handoff gains a `requirements` field and `plan contract`
gains `advice.requirements`, both carrying the same sentence: one requirement is
one verdict for the whole goal, numbering distinct deliverables buys per-part
verdicts and per-part gap rounds, and a holistic outcome should stay one
sentence. It is advice keyed on the requirement count, so a goal that already
splits into several requirements never sees it.

## `workflow capabilities`

`defaults.plannerMode: "caller"`; `plannerModes.dispatched` reads "explicit
`--orchestrator`"; `features.programRequired: true`.

## Docs and skill

- `skill/SKILL.md`: the six-step loop above becomes the default flow; the
  orchestrator path is a short "when you do not want to plan" note.
- `skill/references/operations.md`, `README.md`, `src/help.js`: same order.
- `CHANGELOG.md`: labelled BREAKING with the one-line migration
  (`add --orchestrator auto to keep the previous behaviour`).

## Phase 2 (not part of this change)

- `plan propose "<goal>"`: dispatch only the planner and return a program for
  the caller to edit and launch; the standalone planner as an advisor.
- `--fallback-after <duration>` on caller runs: escalate a stalled pause to a
  dispatched planner so unattended runs cannot hang.
- `workflow statusline`: a fast one-line segment for the Claude Code status
  line, filtered by the exported `CLAUDE_CODE_SESSION_ID`.

## Why this shape

An agent driving Bullswarm needs three things to be reliable: it must never be
surprised by a run that plans without it (program required), every refusal must
tell it the exact next command (guidance contract, exit 2 with nothing running),
and every durable state must map to a small set of allowed verbs (the state
table). The orchestrator stays available for humans in a terminal, cron, CI,
and cheap callers, but only when asked for by name.
