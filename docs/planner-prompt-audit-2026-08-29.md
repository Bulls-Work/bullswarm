# Planner prompt and context audit — 2026-08-29

Question from the user: after the 0.11 → 0.14 iterations, does the instruction
set given to the orchestrator/planner still make sense, or should it be
simplified or refactored?

Method: measure what the planner actually receives, not what the source files
look like. The two planner task files of dogfood run `wf-mtdq1l9v-ed22fe`
(`75t4n2`, bullswarm building `outputSchema` in its own repo, runtime 0.13.2)
are the specimens; sizes are characters of the task text
(`task-orchestrator-*.md`), tokens ≈ chars / 4.

## 1. What one planner turn receives

| section | source | turn 1 | turn 2 |
| --- | --- | ---: | ---: |
| orchestrator prompt + worktree line | `goal.js` `AUTONOMOUS_ORCHESTRATOR_PROMPT` | 5 000 | 5 000 |
| PLANNING DOCTRINE (11 bullets) | `runtime.js` runDecision | 3 605 | 3 605 |
| Action skeletons (6 shapes + verify semantics) | `runtime.js` | 1 342 | 1 342 |
| Program skeleton (discovery → fan-out → verify → suite) | `runtime.js` | 1 217 | 1 217 |
| Graph skeleton (two chains + suite) + fanout paragraph + runtime-owned line | `runtime.js` | 4 054 | 4 054 |
| durable context (JSON) | `runtime.js` plannerContext | 17 474 | 162 946 |
| **total** | | **32 730** (~8 k tokens) | **178 452** (~45 k tokens) |

The fixed prefix is 15.2 k chars on every turn. The durable context grew
**9×** between turn 1 and turn 2 of the same run.

### Where the 163 k of turn 2 went

| key | chars | what it is |
| --- | ---: | --- |
| `completedActions` (19 entries) | 66 700 | every finished action **with its full attempt records**: routing candidates and pace numbers, usage, pricing table, child pid, timings — ~3.5 k per action |
| `outputs` (19 entries) | 41 560 | `outputExcerpt` of ~3 k chars for *every* finished action, including ones that finished ok and were already verified in the previous program |
| `intent` | 6 657 | the goal text (6.5 k) + cwd + policy — needed, once |
| `failures` | 1 073 | the two blocked actions — duplicates of `completedActions` entries |
| `availablePools`, `budget`, `executionConstraints`, `closedPhases`, … | ~1 800 | fine |

## 2. What is said more than once

Reading the prefix as the planner does, the same rules appear two or three
times in different words:

| rule | orchestrator prompt | doctrine | skeletons |
| --- | --- | --- | --- |
| propose the whole program, one round trip costs minutes | item 2 | bullets 1, 2 | "all in ONE decision" ×2 |
| N items → N run + N verify + one suite verify | item 5 | "Per-item chains" | Graph skeleton |
| unknown items → discovery + `itemsFrom` fan-out | item 5 | "Unknown item count" | Program skeleton + fanout paragraph |
| every verify gets a `repair` policy | item 5 | "Verification failures" | verify skeleton |
| `completion: all-actions-ok` on a clean program | item 5 | "Self-completing programs" | — |
| self-contained worker prompts, file ownership | item 3 | "File ownership", "Self-contained prompts" | — |
| don't propose pool/addDir/taskFile | closing line | — | final line |

Item 5 of the orchestrator prompt alone is 1 050 chars and restates four
doctrine bullets. The two program skeletons both end in the same
`verify-items → verify-suite` tail.

## 3. Does it matter? Measured

- Turn 1 (32.7 k chars) took **637 s**; turn 2 (178 k chars) took **390 s**.
  Latency is therefore dominated by the model's reasoning on the goal, not by
  context size — the 6.5 k-char goal and a 12-action program cost more thinking
  than reading 45 k tokens. Trimming context is a **cost** and **attention**
  lever, not primarily a latency lever.
- Cost: turn 2 read ~45 k tokens to emit a ~1 k-token decision. At Opus
  prices that is ~$0.25 per boundary; a run with four boundaries (goal 2 on
  0.12.1) spends more on re-reading attempt metadata than on the decisions.
- Attention: the planner's turn-2 reason correctly diagnosed the blocked
  graph, so quality did not visibly suffer here — but 64 k chars of pricing
  tables and routing candidates are noise it must skip to find the two
  `ok:false` concerns that matter.
- Behaviour observed in three runs (goal 2, goal 3, dogfood): every rule the
  prefix repeats was followed on the first turn (whole program, per-item
  chains, repair policies, `completion`). No observed decision needed a rule
  to be stated twice.

## 4. Recommendation

Yes — refactor, in two independent pieces, both measurable:

**A. Compact the durable context (the 9× growth).** Planner-facing ledger rows
instead of raw ledger entries: `{ id, type, phase, status, pool, durationSec,
attempts, why }` (~150 chars; 19 actions → ~3 k instead of 66.7 k). Keep a
full `outputExcerpt` only for actions finished **since the last decision** and
for every `ok:false` verify; older ok actions get a one-line summary (id, ok,
first 200 chars). Replace `failures` with the ids of failing actions (their
full entry already sits in the ledger). Expected turn-2 context: ~25 k chars
instead of 163 k. Pure runtime change; no planner behaviour change intended.

**B. One contract instead of three overlapping texts.** Merge
`AUTONOMOUS_ORCHESTRATOR_PROMPT` and the doctrine bullets into a single ordered
list of ~10 rules (target ≤ 4 k chars, from 8.1 k), each stated once with its
reason; keep exactly two JSON examples — the action shapes list and one
complete program (discovery → data-driven fan-out → per-item verify with
repair → suite verify, with `completion`) — and delete the second program
skeleton (target ≤ 3 k, from 6.6 k). Total prefix ≤ 7 k chars, from 15.2 k.

Acceptance for both: unit tests on the context builder (row shape, excerpt
policy by decision sequence) and on the prompt (each rule appears once; the
skeleton assertions in `tests/workflow-adaptive.test.js` updated); then one
re-run of goal 3 on the same fixture (baseline 0.13.1: 28 min 42 s, 1 planner
turn, 294 s) to confirm the decision shape is unchanged and record the new
per-turn size.

Not recommended: cutting the goal text or the scout excerpt from the context —
both were used verbatim by every first-turn program observed.

## 5. Outcome

Measurements below were taken after the refactor from the current source and
from the committed source saved into `/tmp/goal-before.mjs` and
`/tmp/runtime-before.js`, using the same temporary measurement script. The
canonical prefix is the complete emitted planner task text counted from its
first character up to (not including) the durable-context marker, with the
worktree-isolation suffix included. The committed baseline predates the named
section exports, so its emitted prefix was reconstructed from the committed
`runtime.js` task-text assembly and the committed `AUTONOMOUS_ORCHESTRATOR_PROMPT`.

- Complete emitted planner task text up to the durable-context marker,
  worktree-isolation suffix included: **OBSERVED**, `16,316` characters before
  and `5,208` characters after. Command: `node /tmp/measure-planner.mjs`.
- Static planner task-prefix array through the durable-context boundary:
  **OBSERVED**, `16,209` characters before and `5,101` characters after. The
  after value is 107 characters shorter because it excludes the unchanged
  worktree-isolation suffix; this is a secondary source-level measurement, not
  the canonical emitted-prefix headline. Command: `node /tmp/measure-planner.mjs`.
- `PLANNER_RULES_SECTION`: **OBSERVED**, `2,202` characters after. Command:
  `node /tmp/measure-planner.mjs`.
- `PLANNER_EXAMPLES_SECTION`: **OBSERVED**, `1,867` characters after. Command:
  `node /tmp/measure-planner.mjs`.
- `AUTONOMOUS_ORCHESTRATOR_PROMPT`: **OBSERVED**, `4,670` characters after;
  the committed before source had no separately exported rules or examples
  sections, so separate before-section sizes are **NOT AVAILABLE**, not
  inferred. Command: `node /tmp/measure-planner.mjs`.
- Sample durable context: **OBSERVED** baseline `163,000` characters in the
  audit's rounded turn-2 durable-context total (the detailed table records
  `162,946`; the full turn-2 task was `178,452`), and **COMPUTED** `23,547`
  characters after. The computed sample applies 19
  compact ledger rows at 150 characters each, keeps a 3,000-character scout
  excerpt and two 3,000-character failing-verify excerpts, truncates the
  other 16 action excerpts to 200 characters, represents two failures as
  20-character IDs, and retains the audit's 6,657-character intent and
  1,800-character other-context components. Command: `node /tmp/compute-context.mjs`.

Deliverables:

- Durable planner context shrank because completed actions are compact ledger
  rows, failures are IDs, and stale successful output is truncated.
- Planner contract shrank because overlapping prompt/doctrine/skeleton text is
  now one ordered rules section plus exactly two JSON examples, single-sourced
  in `src/workflow/goal.js`.
- Runtime prompt construction shrank because `src/workflow/runtime.js` imports
  the shared contract instead of carrying a duplicate doctrine and graph
  skeleton.
- `skill/SKILL.md` was left unchanged: it documents the general durable
  context and the separate run-state/TUI attempt view, but does not document a
  renamed/dropped planner-context field shape such as the old attempt records
  or an old `failures` representation.
