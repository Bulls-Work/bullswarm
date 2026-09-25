# Compose your own flow

You keep the control flow; each step is one `bullswarm run` that returns a
checked JSON answer. Bullswarm picks the pool, checks the answer, and keeps a
checker off the provider whose work it checks when you say so. The loop is
yours: a shell script, your own turns, or a Claude Code Workflow script (see
the last section). Use `workflow goal` instead when the work must outlive your
session, or when parallel writers share one worktree and need an integration
step.

## A typed step

```bash
bullswarm run --lane analyze --no-caller --json --add-dir "$REPO" \
  --task-file find.md --answer-schema findings.schema.json > find.json
```

- `--answer-schema <file.json>` is the JSON Schema the answer must match.
  Bullswarm adds the schema and an answer path to the task. A schema that is
  unreadable, not JSON, or uses a keyword outside the supported subset exits 2
  before routing, and no worker starts.
- The verdict carries `answer` (the parsed JSON, or `null`) and `answerCheck`
  (`ok`, `errors`, `file`, `why`). Branch on `answer`: it is already parsed.
- A missing answer, or one that fails its schema, sets `ok: false`, keeps the
  worker's own verdict in `workerOk`, and exits 1. Nothing is retried: you
  decide whether to rerun, change the schema, read `outFile`, or do the step
  yourself. The answer is the result: a reply of just "done" beside a valid
  answer passes, and beside an invalid one only the check fails.
- `--answer-file <path>` puts the answer where you want it, for example where
  a later step reads it. By default it sits next to `outFile` in the runs
  folder. A named file the run did not rewrite fails the check.
- A step without `--answer-schema` is judged by its reply alone. A
  one-sentence reply under 80 characters, such as "Done.", fails as
  `announcement without substance` (exit 1) even when the work was done. Ask
  such a step to report what it changed, or give it a small schema.
- `--no-caller` makes every step a delegate. Without it a step can come back
  `keepOnClaude: true` (exit 0, no answer), and that step is then yours.
- Exit 0 is `ok: true`. Exit 1 is a failed worker, a usage limit, no free
  pool, or an answer that failed its check; `why` says which. Exit 2 is a
  usage error.

Schemas use the subset in [program.md](program.md) (section "Evidence:
command and schema"). `format` is not checked. One small schema:

```json
{ "type": "object", "required": ["findings"], "additionalProperties": false,
  "properties": { "findings": { "type": "array", "items": {
    "type": "object", "required": ["file", "line", "claim"],
    "properties": { "file": { "type": "string" }, "line": { "type": "integer", "minimum": 1 },
                    "claim": { "type": "string" } } } } } }
```

## Who may run a step

- `--independent-of <run>` keeps the step off every pool of the provider that
  ran an earlier run. `<run>` is that run's `outFile` or `id`, both in its
  `--json` verdict. A checker given the finder's `outFile` never shares the
  finder's provider.
- `--avoid-provider <name>`, `--use-provider <name>` and `--avoid-pool <pool>`
  narrow the pick by name; each repeats or takes a comma list. A provider is
  the part of a pool id before `:`.
- The filters are hard. When they leave no pool, the run exits 1 with
  `no pool left after route filters (…)` in `why`, and nothing runs.
  Bullswarm never widens them, waits or retries: you drop a filter, try
  later, or do the step yourself. A name that is not configured, or a run the
  decision log does not have, exits 2.

## Many steps at once

`run --batch tasks.jsonl` runs each line as its own `run` and prints one JSON
array of verdicts in file order. A line is one JSON object: `id`, `lane`,
`prompt` or `taskFile`, and any of `addDir`, `effort`, `reasoning`,
`answerSchema`, `answerFile`, `avoidPool`, `useProvider`, `avoidProvider` and
`independentOf` (the flags, by their JSON names; a route key takes a value or
a list).

```bash
bullswarm run --batch tasks.jsonl --concurrency 4 --no-caller --json > results.json
```

- Each element is that line's verdict with the line's `id`, the run's own id
  as `runId`, and `exit`. Exit 0 when every task is `ok`, 1 when any is not;
  the array says which.
- One attempt per task, no retry, no saved state. A usage limit, or a filter
  that leaves no pool, fails that task only.
- A bad line (an unknown key, a bad value, a schema Bullswarm cannot check, a
  filter that names nothing real) exits 2 before anything runs, with nothing
  on stdout.
- `--concurrency` caps how many real agents run at once (default 4). Read the
  array when the command exits instead of polling the runs folder.
- `independentOf` names a finished run, so not a line of the same batch.

## 1. Find, then check each finding

One run finds. One batch checks every finding, four at a time, each on a
provider other than the finder's. The confirmed ones are merged.
`check.schema.json` requires `real` (boolean) and `reason` (string).

```bash
rm -f checks.json confirmed.jsonl                                  # an earlier run's results are stale
bullswarm run --lane analyze --no-caller --json --add-dir "$REPO" \
  --task-file find.md --answer-schema findings.schema.json > find.json || exit 1
jq -c --arg repo "$REPO" '.outFile as $finder | .answer.findings | to_entries[] | {
    id: "check-\(.key)", lane: "analyze", addDir: $repo,
    prompt: "Is this finding real? Read the code it names. Finding: \(.value | tojson)",
    answerSchema: "check.schema.json", independentOf: $finder}' find.json > tasks.jsonl
[ -s tasks.jsonl ] || exit 0                                       # no findings: nothing to check
bullswarm run --batch tasks.jsonl --concurrency 4 --no-caller --json > checks.json
[ -s checks.json ] || exit 1                                       # exit 2: a bad line, nothing ran
jq -c --slurpfile find find.json '.[] | select(.answerCheck.ok and .answer.real)
  | $find[0].answer.findings[.id | ltrimstr("check-") | tonumber] + {reason: .answer.reason}' \
  checks.json > confirmed.jsonl
```

`confirmed.jsonl` holds each confirmed finding with the checker's reason.
`jq -r '.[] | select(.answerCheck.ok | not) | "\(.id): \(.why)"' checks.json`
lists the checks that gave no valid answer: rerun those lines or check them
yourself. A `why` of `no pool left after route filters` means only the
finder's provider was free; dropping `independentOf` would let it check its
own finding, so make that choice knowingly.

## 2. Fix until the review passes, at most three rounds

`review.schema.json` requires `passed` (boolean) and `problems` (array of
strings). Each new fix round gets the last review's problems, and each review
runs on a provider other than the fix it reviews.

```bash
cp fix.md task.md
for round in 1 2 3; do
  bullswarm run --lane build --no-caller --json --add-dir "$REPO" \
    --task-file task.md > fix.json || { jq -r .why fix.json; break; }
  bullswarm run --lane analyze --no-caller --json --add-dir "$REPO" --task-file review.md \
    --independent-of "$(jq -r .outFile fix.json)" \
    --answer-schema review.schema.json > review.json || { jq -r .why review.json; break; }
  jq -e '.answer.passed' review.json > /dev/null && { echo "passed in round $round"; break; }
  { cat fix.md; echo; echo '## The last review found'; jq -r '.answer.problems[]' review.json; } > task.md
done
```

A failed run stops the loop and prints its `why`, including `no pool left
after route filters` when only the fixer's provider is free. After three
rounds without a pass, `review.json` holds what is still wrong: raise the
cap, take it over, or stop.

## 3. Propose several, let a judge pick, build the winner

`propose-1.md` to `propose-3.md` each ask for a different approach.
`judge.schema.json` requires `winner` (integer, 1 to 3) and `reason`
(string). The proposals go to named answer files so later tasks can include
them. Each proposal is `--independent-of` the ones before it, so the three
come from three providers.

```bash
avoid=()
for n in 1 2 3; do
  bullswarm run --lane analyze --no-caller --json --add-dir "$REPO" --task-file "propose-$n.md" "${avoid[@]}" \
    --answer-schema proposal.schema.json --answer-file "$PWD/proposal-$n.json" > "propose-$n.json"
  out=$(jq -r '.outFile // empty' "propose-$n.json") && [ -n "$out" ] && avoid+=(--independent-of "$out")
done
{ cat judge.md
  for n in 1 2 3; do
    jq -e .answerCheck.ok "propose-$n.json" > /dev/null && { echo "## Proposal $n"; cat "proposal-$n.json"; echo; }
  done; } > judge-task.md
grep -q '^## Proposal' judge-task.md || exit 1                     # no valid proposal: your call
bullswarm run --lane analyze --no-caller --json --add-dir "$REPO" --task-file judge-task.md \
  --answer-schema judge.schema.json > judge.json || { jq -r .why judge.json; exit 1; }
winner=$(jq -r '.answer.winner' judge.json)
jq -e .answerCheck.ok "propose-$winner.json" > /dev/null || exit 1  # the judge named one it was not shown
{ cat build.md; echo; echo '## Build this proposal'; cat "proposal-$winner.json"; } > build-task.md
bullswarm run --lane build --no-caller --json --add-dir "$REPO" --task-file build-task.md > build.json
```

The proposals run one after another, because each must know who ran the ones
before. With fewer than three providers free, a later proposal exits 1 with
`no pool left after route filters`, and the judge sees only the valid ones.
To run them at once, put the three in one `run --batch`, each line with its
own `useProvider` (or `avoidProvider`) naming providers `bullswarm pools`
shows; a named provider that is spent fails its line at once and is not
replaced. Only proposals whose answer passed its check reach the judge, and a
winner it was not shown stops the flow before the build. Read `judge.json`'s
`answer.reason` before you build when the choice matters.

## From a Claude Code Workflow script

A Workflow script cannot run commands itself. Give one wrapper agent the
whole fan-out: it writes `tasks.jsonl`, runs
`bullswarm run --batch tasks.jsonl --no-caller --json`, and returns the
verdict array unchanged as its result. The script branches on each element's
`ok`, `answer` and `why` in its own code and sends the next stage as the next
batch. One agent launches N runs, instead of one relay agent per run each
spending the caller's own quota. Exit 1 still prints the whole array; on exit
2 nothing ran, and the agent returns the stderr lines instead.
