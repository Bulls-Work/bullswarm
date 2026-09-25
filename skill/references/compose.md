# Compose your own flow

You keep the control flow; each step is one `bullswarm run` that returns a
checked JSON answer. The loop is yours: a shell script, your own turns, or a
Claude Code Workflow script whose agents each run one `bullswarm run` and
return its `answer` and `answerCheck`. Use `workflow goal` instead when the
work must outlive your session, or when parallel writers share one worktree
and need an integration step.

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
  yourself. A valid answer is enough: a reply of just "done" beside it passes.
- `--answer-file <path>` puts the answer where you want it, for example where
  a later step reads it. By default it sits next to `outFile` in the runs
  folder. A named file the run did not rewrite fails the check.
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

Each background run is a real agent on real quota. Start a long list in
batches, and read verdicts when the jobs exit instead of polling the runs
folder.

## 1. Find, then check each finding

One run finds; one run per finding checks it, four at a time; the confirmed
ones are merged. `check.schema.json` requires `real` (boolean) and `reason`
(string).

```bash
rm -f finding-* confirmed.jsonl                                    # an earlier run's results are stale
bullswarm run --lane analyze --no-caller --json --add-dir "$REPO" \
  --task-file find.md --answer-schema findings.schema.json > find.json || exit 1
jq -ec '.answer.findings[]' find.json > findings.jsonl || exit 0   # no findings: nothing to check
split -l 1 findings.jsonl finding-                                 # finding-aa, finding-ab, ...
n=0
for f in finding-??; do
  bullswarm run --lane analyze --no-caller --json --add-dir "$REPO" \
    --prompt "Is this finding real? Read the code it names. Finding: $(cat "$f")" \
    --answer-schema check.schema.json > "$f.check.json" &
  n=$((n + 1)); [ $((n % 4)) -eq 0 ] && wait
done
wait
for f in finding-??; do
  jq -c --slurpfile x "$f" 'select(.answerCheck.ok and .answer.real) | $x[0] + {reason: .answer.reason}' "$f.check.json"
done > confirmed.jsonl
```

`confirmed.jsonl` holds each confirmed finding with the checker's reason.
`jq -r 'select(.answerCheck.ok | not) | "\(input_filename): \(.why)"'
finding-??.check.json` lists the checks that gave no valid answer: rerun them
or check them yourself.

## 2. Fix until the review passes, at most three rounds

`review.schema.json` requires `passed` (boolean) and `problems` (array of
strings). Each new fix round gets the last review's problems.

```bash
cp fix.md task.md
for round in 1 2 3; do
  bullswarm run --lane build --no-caller --json --add-dir "$REPO" \
    --task-file task.md > fix.json || { jq -r .why fix.json; break; }
  bullswarm run --lane analyze --no-caller --json --add-dir "$REPO" --task-file review.md \
    --answer-schema review.schema.json > review.json || { jq -r .why review.json; break; }
  jq -e '.answer.passed' review.json > /dev/null && { echo "passed in round $round"; break; }
  { cat fix.md; echo; echo '## The last review found'; jq -r '.answer.problems[]' review.json; } > task.md
done
```

A failed run stops the loop and prints its `why`. After three rounds without
a pass, `review.json` holds what is still wrong: raise the cap, take it over,
or stop.

## 3. Propose several, let a judge pick, build the winner

`propose-1.md` to `propose-3.md` each ask for a different approach.
`judge.schema.json` requires `winner` (integer, 1 to 3) and `reason`
(string). The proposals go to named answer files so later tasks can include
them.

```bash
for n in 1 2 3; do
  bullswarm run --lane analyze --no-caller --json --add-dir "$REPO" --task-file "propose-$n.md" \
    --answer-schema proposal.schema.json --answer-file "$PWD/proposal-$n.json" > "propose-$n.json" &
done
wait
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

Only proposals whose answer passed its check reach the judge, and a winner it
was not shown stops the flow before the build. Read
`judge.json`'s `answer.reason` before you build when the choice matters.
