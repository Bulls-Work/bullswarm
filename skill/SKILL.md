---
name: bullswarm-setup
description: Use when you want to offload work to coding-agent subscriptions or run a self-contained goal across heterogeneous providers. bullswarm can accept one goal, select an orchestrator, expand and execute a bounded plan, verify the outcome, and expose the whole run through CLI state and events. Use `bullswarm workflow goal` for ordinary multi-step work, an explicit workflow draft when the graph itself is the contract, and `bullswarm run` for one bounded task. Every verb self-initializes.
---

# bullswarm — agent guide

bullswarm lets you offload bounded work to whichever installed coding-agent
CLI subscription has the most quota headroom. Every delegate output is
judged by **content**, not exit code. A non-zero exit is never a success; a
`verified` output is.

## When to reach for it

You should consider bullswarm when **any** of the following apply:

- A task can be expressed as a `run` or `verify` of a single prompt against a
  repo (file reading, summarization, "review this PR", "explain this module",
  "draft a commit message"). → use `bullswarm run`.
- A goal needs autonomous decomposition, implementation, verification, and
  replanning without you choosing agents or authoring JSON. → use
  `bullswarm workflow goal "..." --cwd <repo>`.
- A task has a fixed **pipeline** whose exact graph is itself a contract. → use
  `bullswarm workflow draft ...`.
- A task is naturally a **fan-out** — the same operation applied to N
  items (every file in a directory, every commit in a range, every issue
  in a list). → `bullswarm workflow draft ...` with a `fanout` step.
- You want **adversarial review** of an agent's output before acting on
  it. → add a `verify` step right after the step whose output you don't
  trust.
- You have multiple agent CLIs installed (`codex`, `grok`, `claude`,
  `opencode`, `command-code`) and you don't want to reason about which
  one to use — let bullswarm pick by live meter.

Do NOT use bullswarm when:

- The work needs live conversation context (use the frontier session).
- A single `Read`/`Grep`/`Bash` call is enough.
- The user is asking for a one-liner, a quick edit, or a command to run.

## Single-task shape (`bullswarm run`)

```bash
bullswarm run --lane <analyze|build|chore> \
  --add-dir <abs/path/to/repo> \
  --task-file <abs/path/to/task.md> \
  --json
```

The verdict shape:

```json
{ "ok": true, "keepOnClaude": false, "why": "verified",
  "pick": { "pool": "grok", "command": ["grok","-p","..."] },
  "contentUsableDespiteExit": false, "outFile": "/tmp/dlg.out" }
```

- `ok: true` → read `outFile`, that's the answer
- `keepOnClaude: true` → do it in-session; no pool could take it
- `ok: false` → `why` names the failed gate; do not use the output
- `contentUsableDespiteExit: true` → non-zero exit but full content; read anyway

Lanes are work-nature, not pool:
- `analyze` — read, explain, audit, review
- `build` — implement, modify, write code
- `chore` — reformat, convert, summarize, smoke-check

## Autonomous multi-step shape (`bullswarm workflow goal`)

Prefer this for ordinary goal-driven work. The caller supplies intent only:

```bash
bullswarm workflow goal \
  "Fix the failing parser tests with the smallest correct change and verify them" \
  --cwd=<abs/path/to/repo> --detach --json
```

The returned JSON contains `runId`, `shortId`, logs, and exact observation
commands. Bullswarm chooses a capable orchestrator by quota surplus, supplies
the internal planning contract, validates every proposed graph expansion,
routes workers independently, requires verification evidence, and replans until
a truthful terminal state. The initiating agent does not create phases, action
IDs, dependency JSON, planner prompts, or pool assignments.

Observe from any other shell or agent:

```bash
bullswarm workflow runs show <shortId>
bullswarm workflow watch <shortId>
bullswarm workflow tui --json <shortId>
bullswarm workflow events --json <shortId> --after 0
bullswarm workflow action show --json <shortId> <actionId>
```

The detached runner does not depend on the initiating CLI remaining alive.
Resume a process-interrupted run from its persisted definition with
`bullswarm workflow goal --resume <shortId> --json`. Leave orchestrator
selection automatic in normal use; `--orchestrator=<pool>` is for controlled
provider QA. `SIGTERM`/`SIGINT` cooperatively terminate the active delegate and
persist `interrupted`; later workflow commands also reconcile dead or stale
owners into that explicit resumable state.

## Multi-step shape (`bullswarm workflow draft ...`)

If the work is more than one logical step, build a draft incrementally
from the shell. Drafts persist under `~/.bullswarm/drafts/<name>/` and
become first-class workflows the moment they exist (discoverable, runnable
by name, validatable).

```bash
# Create and add a phase:
bullswarm workflow draft create my-audit --description "Audit the source"
bullswarm workflow draft phase add my-audit discover

# Add a step. --type can be `run`, `fanout`, or `verify`:
bullswarm workflow draft step add my-audit discover list-files \
  --type=run --lane=chore --prompt="List every .ts file under src/" \
  --addDir=<abs/path/to/repo> --timeout=60

# Add a fanout that reads the discover output:
bullswarm workflow draft step add my-audit review per-file \
  --type=fanout --itemsFrom=outputs.list-files.outFile \
  --lane=analyze --concurrency=4 \
  --step-template='{"lane":"analyze","prompt":"Review {{item}} in 60 words. Sign with Model=<id>."}'

# Add a skeptic step (adversarial review of the prior step):
bullswarm workflow draft step add my-audit review skeptic \
  --type=verify --review=outputs.per-file.outFile \
  --prompt='Read the work. Reply ONLY with JSON {"ok":<bool>,"concerns":[...],"summary":"..."}' \
  --on-error=continue

# Run it:
bullswarm workflow draft run my-audit --input=targetDir=<abs/repo/path> --json --quiet
```

Built-in step types:

- **`run`** — one delegate dispatch. Outputs `outFile` (path) and
  `outputText` (truncated to 64 KB in `state.json`).
- **`fanout`** — expand a list and dispatch one per item. The list comes
  from `itemsFrom`, a dotted path. Either an input array (`inputs.items`)
  or a prior step's outFile (`outputs.<stepId>.outFile` — runtime reads
  the file and parses the first JSON array).
- **`verify`** — adversarial review. Runtime inlines the prior outFile
  into a structured prompt asking for `{"ok":<bool>,"concerns":[],"summary":""}`
  and the step is `ok:true` only if the JSON parses AND `ok===true`.
  Use this between any step whose output you won't believe without a
  second pair of eyes.
- **`decide`** — an explicit adaptive planning gate. The planner receives the
  durable intent, completed actions, failures, artifact paths, verification
  results, remaining budgets, and available connector capabilities. Its
  versioned JSON is a proposal; deterministic validation decides whether any
  new `run`, inline-`fanout`, or `verify` actions may execute.

Flag style: prefer `--key=value` over `--key value` — the `=` form
survives shell quoting, agents calling from JSON tools don't have
to think about it, and the parser is unambiguous when the value
itself starts with `--`. Both forms work; the `=` form is recommended.

## Operating on runs

Every run gets a 6-character shortId (Crockford-style alphabet, no
`0/1/i/l/o`). The full `wf-...` runId is the durable handle on disk.

```bash
bullswarm workflow runs                       # ongoing only (default)
bullswarm workflow runs --all                 # ongoing + historical
bullswarm workflow runs --name <workflow>     # filter by workflow name
bullswarm workflow runs --all --since 7d      # initiated in the last 7 days
bullswarm workflow runs --historical --since yesterday --until today
bullswarm workflow runs show <shortId>        # state + report + summary
bullswarm workflow runs delete <shortId> --yes
```

Historical time ranges filter the workflow's initiation time (`startedAt`),
not completion time. `--since` is inclusive and `--until` is exclusive, with
`--from`/`--to` and `--started-after`/`--started-before` aliases. Bounds accept
ISO timestamps, local dates, today/yesterday/tomorrow/now, or durations such as
`7d`. Add `--all` or `--historical`; time filters do not silently change the
normal ongoing-only scope.

Before authoring or choosing a workflow, agents can inspect the live execution
fabric and the workflow document itself:

```bash
bullswarm workflow capabilities --json
bullswarm workflow inspect <file-or-name>
bullswarm workflow watch <shortId>              # low-noise progress until terminal
bullswarm workflow watch <shortId> --jsonl      # machine-readable progress stream
bullswarm workflow tui <shortId>              # text phase/action/attempt tree
bullswarm workflow events --json <shortId> --after 20
bullswarm workflow action show --json <shortId> <actionId>
bullswarm workflow approval approve --json <shortId>
bullswarm workflow steer <shortId> --message "guidance for the next planner checkpoint"
```

`capabilities` reports available pools, supported lanes, configured models,
meter readings, burst gates, quarantine state, retry limits, and the important
routing rule. Automatic routing chooses the highest time-adjusted quota surplus
among capable pools. For strategic model selection, first run:

```bash
bullswarm strategy refresh
bullswarm strategy show --json
bullswarm strategy apply --yes --refresh-hours 24
bullswarm strategy auto status
bullswarm strategy assign high --pool <pool> --model <model>
```

Connector-declared discovery, dated benchmark/pricing evidence, live quota,
and tier-specific capability requirements produce high/medium/low suggestions;
unknown evidence remains null. `apply --yes` is the explicit approval gate: it
persists assignments and enables TTL-based discovery/re-application. A step's
`effort` or a lane default (`analyze=high`, `build=medium`, `chore=low`) can use
an assignment, but it never bypasses capability, quarantine, exhaustion, or
burst-gate safety. Each attempt records the chosen agent/model and labeled
token, cost, and normalized-quota estimates in the workflow tree.

Run state also exposes the versioned plan, action ledger, aggregate usage, every attempt,
planner decisions and reasons, budgets, `currentPhase`, `currentStep`, and
`activeAgents` in `workflow tui --json <shortId>`. Each attempt includes its
pool, selected model, effort tier, routing reason and eligible candidates,
usage/cost estimate, status, task/output artifacts, timings, failure
reason, and child-process termination evidence. `workflow tui` displays the
same information interactively. `workflow events` supports replay after a
monotonic sequence cursor.

Prefer `workflow watch` for ordinary monitoring; it prints semantic changes and
a periodic heartbeat, then a per-attempt timing/token breakdown at terminal
status. `workflow steer` is an optional durable queue for autonomous workflows:
it never changes the active worker and is delivered only to the next
not-yet-started decision gate. Steering cannot expand the original authority,
weaken verification, or bypass proposal validation.

Retries are bounded. `settings.retryAttempts` is an integer from 0 to 3 and
adds same-pool retries; `escalateOnFail` permits a failed invocation to move to
another eligible capable pool. `requiresCapabilities` filters pools before
quota-surplus ranking and never silently selects a weaker pool.

Delegates wait for natural completion by default. Connector timeout metadata
does not impose an implicit kill timer. Use a step's `timeoutSec` or direct
run's `--timeout` only as an explicit operator-selected termination control;
otherwise inspect `activeAgents.lastActivityAt` and `outputBytesObserved`, then
use workflow cancellation for a genuinely hung process. Some CLIs buffer
output, so silence is evidence to inspect, not automatic proof of a hang.

For Codex, Claude, Grok, Command Code, and OpenCode, also inspect
`activeAgents.lastActions` and `activeAgents.stall`. The connector translates
native JSONL shell commands, reads, edits/writes, tool calls, and response
blocks into the same action shape and retains the latest three. Ten minutes
without any transport/event/action evidence becomes `suspected_stalled` with
`autoTerminate:false`; it is deliberately not treated as proof of death.

For adaptive work, declare a `decide` step plus `maxExpansionRounds` and the
other graph-growth safeguards (`maxActions` and `maxItemsPerExpansion`).
`maxAgents` and `maxWorkflowSeconds` are advisory planning targets: they expose
remaining headroom and overage to the orchestrator but never stop a worker or
skip required verification. The loop is durable:

```text
execute -> observe -> decide -> validate proposal -> append -> execute -> observe
```

Allowed planner decisions are `proceed`, `complete`, `needs_more_work`,
`retry`, `escalate`, `wait_for_approval`, and `stop`. Expansion decisions must
contain bounded actions; malformed or over-budget output executes nothing.
Use `workflows/adaptive-code-review.json` as the starting template.
Planner proposals cannot choose `pool`, `addDir`, or `taskFile`. Those fields
are runtime-owned. An initiator may constrain them with a decide step's
`actionDefaults`; absent a pinned default, normal capability and quota routing
selects the worker.

Resume by shortId:

```bash
bullswarm workflow draft run my-audit --resume <shortId> --json --quiet
```

## Writing prompts that the verify gate will accept

The verify gate (`src/lib/verify.js`) flags outputs as `intent_only`
when they look like announcements with no work behind them. To pass:

- ≥ 80 characters of *non-intent* prose after intent sentences
  ("I'll", "I will", "let me", "I'm going to") are stripped.
- No "rate limit", "auth", "unauthorized" or other failure markers
  in the first 400 chars.
- Substantive work: bullet lists, code blocks, paragraphs of analysis.

If you want a step to reliably pass, prompt the model to *show its
work*: "In 200 words: (1) the top 3 risks, (2) cited file paths,
(3) a one-sentence recommendation." Not "Summarize the codebase."

## Self-initialization

You do NOT need to set up bullswarm. Every verb self-initializes:

- Missing `~/.bullswarm/`? Created on first call.
- No enabled pools? `autoSetup` enables every installed agent CLI plus
  the deterministic `echo` pool (so offload works on a fresh machine).
- `bullswarm doctor --json` returns a readiness report; non-zero exit
  only on a real problem. The first call to `doctor` self-heals.

```bash
# Always start with this; it tells you what's available:
bullswarm doctor --json
```

The output has a `checks[]` array with one entry per readiness concern
(config, connectors, meters, offload-capable) and a `nextActions[]` list
of exact commands to fix anything missing.

## Common patterns

### "Audit every file in this directory"

A discover-based fanout requires the discover delegate to return a bare
JSON array in its output file. The built-in `echo` pool is a verifier
fixture and deliberately returns prose, so use a real provider for this
variant:

```bash
bullswarm workflow draft create file-audit \
  --description="Audit every file" --input=targetDir=<abs/path>
bullswarm workflow draft phase add file-audit discover
bullswarm workflow draft phase add file-audit review
bullswarm workflow draft step add file-audit discover list \
  --type=run --lane=chore \
  --prompt="List every file in <DIR> (exclude dotfiles). Return ONLY a JSON array." \
  --addDir=<abs/path> --timeout=60
bullswarm workflow draft step add file-audit review per-file \
  --type=fanout --itemsFrom=outputs.list.outFile \
  --lane=analyze --concurrency=4 \
  --step-template='{"lane":"analyze","prompt":"In 80 words: top risk in {{item}}"}'
bullswarm workflow draft run file-audit --json --quiet
```

For a deterministic no-network smoke test, provide the fanout items
as a JSON input instead of asking a delegate to discover them:

```bash
bullswarm workflow draft create file-audit-smoke \
  --description="Deterministic fanout smoke test" \
  --input=targetDir=<abs/path>
bullswarm workflow draft phase add file-audit-smoke review
bullswarm workflow draft step add file-audit-smoke review per-file \
  --type=fanout --itemsFrom=inputs.items --lane=chore --concurrency=2 \
  --step-template='{"lane":"chore","prompt":"Process {{item}} and report the concrete result."}'
bullswarm workflow draft run file-audit-smoke \
  --input='items=["src/index.js","README.md"]' --json --quiet
```

### "Research this question, get a second opinion, then write up the result"

```bash
bullswarm workflow draft create research-x
bullswarm workflow draft phase add research-x research
bullswarm workflow draft phase add research-x verify
bullswarm workflow draft phase add research-x write
# step 1: do the research
bullswarm workflow draft step add research-x research gather \
  --type=run --lane=analyze --prompt="<your question>" \
  --addDir=<abs> --timeout=180
# step 2: skeptic reviews the research
bullswarm workflow draft step add research-x verify skeptic \
  --type=verify --review=outputs.gather.outFile \
  --prompt='Be a strict skeptic. Reply JSON {ok,concerns,summary}.'
# step 3: write the final answer, gated by the skeptic's ok
bullswarm workflow draft step add research-x write final \
  --type=run --lane=build \
  --prompt="Write the final answer. Read {{inputs.gather}}." \
  --addDir=<abs> --timeout=180
bullswarm workflow draft run research-x --json --quiet
```

### "I already have a workflow file, just run it"

```bash
bullswarm workflow run <path-or-name> --input k=v --json --quiet
# resume:
bullswarm workflow run <path-or-name> --resume <shortId|runId> --json --quiet
```

## Sandbox for tests / sandboxes

Set `BULLSWARM_HOME=/tmp/bs-sandbox` to redirect all state into a temp
directory. Use this when running bullswarm from a subshell, a CI
runner, or any context where the user's real `~/.bullswarm/` is
inaccessible. The env var is read on every call, not at module load,
so changing it between calls works as expected.

```bash
export BULLSWARM_HOME=/tmp/bs-sandbox
bullswarm doctor --json     # self-heals inside the sandbox
```

## Failure modes you will see

- `"refusing to delete without --yes"` — you tried `runs delete` or
  `draft delete` without the flag. Add `--yes`.
- `"recursion guard"` — the connector you're dispatching to itself
  tried to spawn `bullswarm`. Reduce the depth or the workflow's
  parallelism; the core's depth limit is 2 by default.
- `workflow.agent_target_exceeded` — the run used more dispatches than the
  advisory `maxAgents` target. This is planning/observability evidence; the
  workflow continues and still performs required verification.
- `"auth/throttle signature"` — the delegate's output matched a
  configured auth-error string. The pool is auto-quarantined for
  10 min; subsequent dispatches skip it.

## Reference

- All verbs: `bullswarm <verb> --help` (most also support `--json`)
- Verdict contract: `src/lib/verify.js`
- Pacing: `src/meters/framework.js` (5h = burst gate; weekly/monthly = pace)
- Routing: `src/lib/route.js` (most-behind capable pool; cost-guard)
- Workflows: `src/workflow/*`
- Short IDs: `src/workflow/short-id.js`
