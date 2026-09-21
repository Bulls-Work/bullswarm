Read-only study complete. I made no edits, did not touch live `~/.bullswarm`, and did not run destructive tests. The checkout remains dirty with existing changes; I left them untouched.

## A. Retention design

### Layout and evidence

V2 runs live under `~/.bullswarm/workflows/wf-*` ([v2-runtime.js](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/src/workflow/v2-runtime.js:1149)). Isolated action trees are created under:

```text
<runDir>/workspaces/<action-id>
```

([v2-workspace.js](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/src/workflow/v2-workspace.js:50))

They may be Git worktrees or ordinary copies; disposal already distinguishes those cases ([v2-workspace.js](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/src/workflow/v2-workspace.js:106)).

### Recommended policy

Use a home-level `state.json.retention` block:

```json
{
  "retention": {
    "enabled": true,
    "workspacesDays": 7
  }
}
```

I would not place this in `state.strategy`: that namespace is already routing/model/subscription policy ([configuration.md](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/docs/reference/configuration.md:68)). I also would not add it to every V2 run state because that state has a strict top-level schema ([v2-state.js](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/src/workflow/v2-state.js:967)).

The setting should be read through the existing atomic, locked state path ([state.js](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/src/lib/state.js:476)).

### What is eligible

After 7 days from `state.lifecycle.finishedAt`, delete only:

```text
<runDir>/workspaces/**
```

Eligible runs must have:

- V2 terminal status: `completed`, `partial`, `cancelled`, or `failed`.
- A valid non-null `finishedAt`; the validator already requires this for terminal states ([v2-state.js](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/src/workflow/v2-state.js:489)).
- No active kernel lease.
- A locally readable `state.json`.

Do not clean `interrupted`, `paused`, corrupt, legacy, or currently ongoing runs. Interrupted workspaces are explicitly preserved for recovery.

For Git worktrees, use the equivalent of `disposeIsolatedWorkspace` and remove the Git worktree registration before deleting files. If the source checkout or worktree kind cannot be safely determined, skip and report it rather than leaving stale `.git/worktrees` metadata.

### What must never be removed

By default, never delete:

- `state.json`, `goal.json`, `events.jsonl`
- `result*.json`, `report.json`, `rollup.json`
- Every `task-*`, `out-*`, `diff-*`, `stream-*`, and `stdout-*` artifact
- Contracts, completion receipts, workspace baselines, and evidence files
- `history/runs.jsonl`
- Provider transcripts outside Bullswarm

The home snapshot copies selected workflow directories and only omits streams/logs when `--no-streams` is requested ([home-cli.js](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/src/home-cli.js:191), [home-cli.js](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/src/home-cli.js:282)). Retention must operate only on the configured live home, never on a snapshot.

### Automatic execution and reporting

Refactor the existing terminal-run iterator used by `workflow reprice`—which already skips nonterminal and ongoing runs ([reprice.js](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/src/workflow/reprice.js:586))—into a shared maintenance pass.

Run it:

- At V2 kernel finalize/idle, once per process or time budget.
- From the same maintenance pass used by repricing.
- Under a home maintenance lock, then acquire and recheck each run’s kernel lease before deletion.

Expose a proposed diagnostic command:

```text
bullswarm workflow retention --dry-run --json
```

Default should be dry-run; automatic maintenance is the only implicit apply path. JSON should include policy, scanned/eligible/skipped counts, candidate workspace paths, byte sizes, reclaimable bytes, deleted count, and failures. Existing reprice already establishes `--dry-run`/`--json` conventions ([reprice.js](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/src/workflow/reprice.js:444)).

### Tests

Add tests for:

- Dry-run reports old workspaces without deleting anything.
- Apply removes only `workspaces/`; all durable artifacts remain.
- Under-TTL workspaces remain.
- `interrupted`, paused, active, corrupt, legacy, and lease-contended runs are skipped.
- Git worktree cleanup removes both the directory and Git registration.
- Symlinks/path traversal cannot escape the direct `runDir/workspaces` subtree.
- Repeated sweeps are idempotent.
- JSON output is machine-readable.
- Snapshots are not mutated.

The task-provided measurement—367 MB across 321 runs, with most remaining bulk in old workspace copies—is consistent with this being the highest-value safe deletion boundary.

## B. Capture-time persistence

### Current timing gap

`runDelegate` does finish the event decoder at child exit and returns `reportedUsage` in memory ([watch.js](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/src/lib/watch.js:666), [watch.js](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/src/lib/watch.js:702)).

However, `watchOnce` then performs usage estimation, transcript lookup, subscription accounting, and verdict assembly before dispatch writes `record.usage` and updates `record.session` ([watch.js](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/src/lib/watch.js:923), [watch.js](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/src/lib/watch.js:938), [v2-dispatch.js](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/src/workflow/v2-dispatch.js:894), [v2-dispatch.js](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/src/workflow/v2-dispatch.js:922)).

Thus the stream file is recoverable, but the attempt record can remain without final usage/session data if the kernel dies during transcript pricing. Resume recovery currently reconstructs stream/output/diff paths, not usage ([v2-dispatch.js](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/src/workflow/v2-dispatch.js:205), [v2-runtime.js](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/src/workflow/v2-runtime.js:1068)).

### Already stored

The final attempt record already supports:

- `usage.model`
- `usage.sessionId`
- `usage.tokens.{standardRead,cacheRead,cacheWrite5m,cacheWrite1h,cacheWrite,output,reasoning,totalKnown}`
- `usage.tokenSource`
- API/subscription pricing envelopes

([usage.js](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/src/lib/usage.js:386), [v2-state.js](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/src/workflow/v2-state.js:33)).

`session` currently stores `pool`, `model`, `sessionId`, `generation`, and timestamps, but the initial ID may be Bullswarm’s generated conversation ID rather than a provider-confirmed ID ([v2-dispatch.js](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/src/workflow/v2-dispatch.js:503), [v2-state.js](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/src/workflow/v2-state.js:65)).

### Provider comparison

| Provider | Session ID and final usage in stream | Current decoder status |
|---|---|---|
| Codex | `thread.started.thread_id`; final `turn.completed.usage` ([connector](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/src/providers/codex/connector.json:167)) | Already captured by top-level `eventStream.usage`; only durability timing is missing. |
| Claude Code | Final `result.session_id`; `result.usage` ([connector](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/src/providers/claude-code/connector.json:113)) | Already decoded; transcript also carries the ID in filename/rows ([claude-code.js](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/src/lib/transcripts/claude-code.js:161)). |
| Grok | Fixture final `end.sessionId` and `end.usage` ([fixture](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/tests/fixtures/stream/grok.jsonl:9)) | Current connector has only `rules[].usagePaths`, not top-level `eventStream.usage` ([connector](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/src/providers/grok/connector.json:103)); `decoder.usage()` therefore returns null. The normalized event has usage but no session ID because `agent-events.js` has no `sessionId` optional alias ([agent-events.js](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/src/lib/agent-events.js:44)). Durable fallback is `row.sid` in `~/.grok/logs/unified.jsonl` ([grok.js](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/src/lib/transcripts/grok.js:135)). |

### Recommended change

Add an immutable optional `attempt.capture` block:

```json
{
  "capturedAt": "...",
  "source": "event-stream",
  "providerSessionId": "...",
  "sessionSource": "provider-stream",
  "model": "...",
  "tokens": {
    "standardRead": 0,
    "cacheRead": 0,
    "cacheWrite5m": 0,
    "cacheWrite1h": 0,
    "cacheWrite": 0,
    "output": 0,
    "reasoning": 0,
    "totalKnown": 0
  },
  "tokenSource": "provider-reported",
  "providerCostUsd": null,
  "exitCode": 0,
  "signal": null
}
```

Implement it as follows:

1. Invoke a synchronous worker-exit callback inside `runDelegate` immediately after `finishStream()`, before resolving the observation.
2. Build the canonical provider-reported usage in `watchOnce` without consulting transcripts.
3. Dispatch a new `onAttempt('captured', ...)` stage.
4. Runtime merges `capture`, `usage`, and provider-confirmed `sessionId` into the existing started attempt and persists under the kernel lease, without marking the attempt finished or adding aggregate usage twice.
5. Later transcript pricing may upgrade an estimate, but must never downgrade `provider-reported`. Reprice already treats provider-reported usage as authoritative ([reprice.js](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/src/workflow/reprice.js:295)).

For Grok, add a top-level final-`end` usage rule mapping `sessionId`, token classes, and cost. Add a decoder test asserting Grok session ID and totals, and verify the provider’s input/cache and reasoning inclusion semantics against a live capture before finalizing the connector rule.

This makes transcript rotation harmless for Codex, Claude, and Grok streams that actually emit final counters. If a provider emits no counters at all, the honest capture remains `unknown`; it must not fabricate totals.

## Could not verify

- I did not inspect live `~/.bullswarm`, `.claude`, `.grok`, or `.codex` data.
- The supplied snapshot contains source-home absolute paths; I did not follow them.
- The Grok fixture proves the stream shape, but not every installed Grok version’s token-counter semantics.
- I did not implement or run the proposed tests because the task explicitly required a read-only report.

