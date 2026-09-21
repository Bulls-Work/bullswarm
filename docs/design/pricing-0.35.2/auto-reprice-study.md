Read-only design complete. I made no repository edits.

## Recommendation

Add one shared incremental reconciler, used by the kernel, watch completion, and a detached dashboard child. Keep `bullswarm workflow reprice` as a manual full-backfill/recovery command, but route both paths through the same attempt-pricing primitives.

Today:

- `repriceRuns()` scans terminal, non-ongoing runs, but only filters by date/pool; it has no attempt ledger or retry cursor ([reprice.js:476](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/src/workflow/reprice.js:476), [reprice.js:591](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/src/workflow/reprice.js:591)).
- Each invocation constructs provider transcript indexes ([reprice.js:566](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/src/workflow/reprice.js:566)).
- `watchOnce()` only performs a live lookup at attempt completion; missing or ambiguous matches retain the live estimate ([watch.js:937](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/src/lib/watch.js:937)).
- The dashboard reads the rollup index and repaints, but never launches accounting work ([dashboard.js:2218](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/src/workflow/dashboard.js:2218), [dashboard.js:2442](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/src/workflow/dashboard.js:2442)).

### 1. Incremental reconciler

Create `src/workflow/pricing-reconciler.js`, or extract the shared machinery into `reprice.js` and export it.

A record qualifies when:

- Its workflow is V2, terminal, and not ongoing. The existing terminal set includes `completed`, `partial`, `failed`, `cancelled`, `interrupted`, and `blocked` ([status.js:1](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/src/workflow/status.js:1)).
- The attempt has `finishedAt` and is not `running`.
- `tokenSource` is `unknown` or `estimated:utf8-bytes/4`; provider-reported and transcript-summed attempts are skipped ([reprice.js:86](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/src/workflow/reprice.js:86)).
- The stable key has not exhausted `N` tries for the current reader/store version.

Use a default `N = 3` tries per `(readerVersion, transcriptStoreFingerprint)`, with retry delays such as immediate, one minute, and ten minutes. A late transcript or a new reader must reopen the record:

- A changed transcript-store fingerprint resets the tries.
- A changed `readerVersion` resets the tries. This handles attempts that predate a newly added reader or task-text matcher.
- An exhausted record remains visible as unknown; it is not silently converted to zero.

Store one atomic file:

```text
$BULLSWARM_HOME/pricing/reconcile.json
```

Suggested shape:

```json
{
  "schemaVersion": 1,
  "readerVersion": "transcripts-v2-task-text-1",
  "cursor": {
    "historyFingerprint": "size:mtime",
    "providers": {
      "codex": {
        "storeFingerprint": "...",
        "lastIndexedAt": "..."
      }
    }
  },
  "attempts": {
    "wf-.../action-id/1": {
      "tries": 2,
      "lastTriedAt": "...",
      "nextTryAt": "...",
      "lastOutcome": "none",
      "lastReaderVersion": "...",
      "lastStoreFingerprint": "...",
      "matchedFile": null
    }
  },
  "lastPass": {
    "status": "complete",
    "startedAt": "...",
    "finishedAt": "...",
    "elapsedMs": 0,
    "eligible": 0,
    "scannedRuns": 0,
    "scannedAttempts": 0,
    "matched": 0,
    "ambiguous": 0,
    "missing": 0,
    "changedRuns": 0,
    "indexBuildMs": 0,
    "bytesRead": 0
  }
}
```

The pass should:

1. Acquire a non-blocking pricing lock.
2. Compare the history fingerprint, provider store fingerprints, reader version, and due retry times.
3. Return immediately without `listRuns()` or transcript index construction when nothing changed and no retry is due.
4. Build each changed provider index once.
5. Reuse the current `candidateFor()` logic, extending its accepted match confidence to include `task-text` ([reprice.js:273](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/src/workflow/reprice.js:273)).
6. Recompute aggregate state usage from all attempts; do not call additive `addUsage()` on an already-counted attempt ([v2-runtime.js:518](/home/dev/Repo/bullswarm-0.35.2-providers/src/workflow/v2-runtime.js:518)).
7. Preserve the existing result status, verdict, reason, requirements, and evidence while replacing usage fields ([reprice.js:420](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/src/workflow/reprice.js:420)).
8. Atomically write state/result and call the existing rollup writer ([reprice.js:648](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/src/workflow/reprice.js:648), [rollup.js:488](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/src/workflow/rollup.js:488)).

For `none` and `ambiguous`, keep the current historical semantics: no match becomes unknown with null cost, never an arbitrary transcript. The ledger still retries the record when the store or reader version changes.

Provider-specific cheap fingerprints should live with providers, not core logic. The no-change path should stat directory metadata and tracked unresolved files, not parse transcripts. That is how the dashboard pass stays below one second when there is nothing new.

### 2. Execution hooks and concurrency

Flow:

```text
watchOnce finishes
        ↓
enqueue pricing candidate
        ↓
kernel boundary pass ──────────────┐
        or                         │
dashboard detached historical pass│
        ↓                         │
state/result/rollup/history update│
        ↓                         │
dashboard fingerprint → repaint ◄─┘
```

Kernel:

- Add a `reconcileCurrentRun()` dependency to `runV2Kernel()`.
- Invoke it immediately before `evaluateV2Progress()` ([v2-runtime.js:2238](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/src/workflow/v2-runtime.js:2238)), guarded by `activeTasks.size === 0`; `waitForProgress()` can return after only one concurrent action settles ([v2-runtime.js:2028](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/src/workflow/v2-runtime.js:2028)).
- Invoke one final current-run pass in `finalize()` before subscription reconciliation ([v2-runtime.js:1938](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/src/workflow/v2-runtime.js:1938)).
- Persist through the kernel lease. The normal attempt-finished path already has the durable attempt and usage available ([v2-runtime.js:1755](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/src/workflow/v2-runtime.js:1755)).

Watch:

- Add an `onUsageFinalized` callback to `watchOnce()` after subscription/calibration accounting, around line 1101 ([watch.js:988](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/src/lib/watch.js:988)).
- Pass the completed attempt metadata, task text, task-file path, provider, session, cwd, and time window.
- The callback should enqueue a candidate or mark pricing dirty; it must not build a 1,294-file transcript index synchronously.
- The kernel’s finished-attempt callback then performs the durable current-run pass.

Dashboard:

- After the initial `paint()` at startup ([dashboard.js:3406](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/src/workflow/dashboard.js:3406)), spawn a hidden internal incremental-pricing child with `detached: true`, ignored stdio, and `unref()`. The repository already uses this detached pattern ([workflow/cli.js:318](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/src/workflow/cli.js:318)).
- Do not wait for the child. The first frame is already painted.
- On each `refresh()`, read `reconcile.json`; if a pass is active, set the existing `message` field to `pricing N older records…` ([dashboard.js:2349](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/src/workflow/dashboard.js:2349)).
- The next `readIndex()` sees the changed `size:mtime` fingerprint and reloads rollups; `paint()` then rebuilds Home/Stats ([dashboard.js:2219](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/src/workflow/dashboard.js:2219), [dashboard.js:2478](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/src/workflow/dashboard.js:2478)).

Locks:

- Add `$BULLSWARM_HOME/pricing.lock`.
- Use atomic `openSync(path, 'wx')`, bounded acquisition, stale-owner recovery, and atomic release—the same basic semantics as `state.lock` ([state.js:419](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/src/lib/state.js:419)).
- Do not use the existing 30-second stale timeout unchanged: a legitimate transcript index can take longer. Store PID, process identity, token, and heartbeat, following the kernel lease pattern ([v2-process.js:16](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/src/workflow/v2-process.js:16)).
- Dashboard and watch use non-blocking acquisition; if another pass owns the lock, they quietly skip.
- Before mutating a historical run, acquire its `kernel.lock` as a short-lived fence or skip if an active kernel owns it. Root `state.json` updates must use `updateState()` ([state.js:471](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/src/lib/state.js:471)).
- `appendRollupIndex()` is already idempotent by `runId` ([rollup.js:454](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/src/workflow/rollup.js:454)).

### 3. Task-text matching and ambiguity

Current matching path:

```text
reprice candidateFor()
  → readTranscriptUsage({
      provider, sessionId, cwd, startedAt, endedAt, home
    })
  → provider-neutral reader dispatch
  → provider reader
```

The call originates at [reprice.js:315](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/src/workflow/reprice.js:315). The provider-neutral dispatcher currently forwards the common arguments and index ([transcripts/index.js:106](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/src/lib/transcripts/index.js:106)); the indexed wrapper builds indexes once and injects one ([transcripts/index.js:148](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/src/lib/transcripts/index.js:148)).

Codex currently indexes only file, session ID, cwd, and edge times ([codex.js:174](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/src/lib/transcripts/codex.js:174)). Its fallback is cwd/time matching; zero candidates return `none`, and multiple candidates return `ambiguous` ([codex.js:337](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/src/lib/transcripts/codex.js:337), [codex.js:358](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/src/lib/transcripts/codex.js:358)).

Implement:

1. Extend the common reader arguments with `taskText`.
2. Read the bounded task-file contents in `candidateFor()`; do not store the text itself in the ledger.
3. Add `firstUserTextHash` and `firstUserTextLength` to Codex index entries. Parse the first user message from the transcript edge; use a real full scan only when the changed file is outside the edge.
4. In `src/lib/transcripts/index.js`, apply this precedence:
   - unique provider session match;
   - unique exact task-text hash match;
   - unique cwd/time-window match;
   - otherwise `none` or `ambiguous`.
5. For a unique task-text match, call the provider reader with that entry’s session ID/file and return `confidence: 'task-text'`.
6. If task text matches more than one transcript, return `ambiguous`; never choose by recency or lexical order.
7. A conflicting explicit session ID wins over task text, but a failed session lookup may fall back to one unique task-text match.

The provider adapter already forwards arbitrary reader arguments via spread ([providers.js:372](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/src/lib/providers.js:372)), so this can be added without dropping the field.

The task file says the first user message contains the task text verbatim for `g6d6q2` ([task file:5](/home/dev/.bullswarm/runs/task-1789864407118-0dmz7.md:5)). I could not independently verify that claim: the permitted `home-352` snapshot contains no `.codex/sessions` store and no `g6d6q2` workflow directory. The checked-in Codex fixture is only three JSONL rows—session metadata, turn context, and token count—so it cannot prove task-text matching ([codex-rollout.jsonl:1](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/tests/fixtures/transcripts/codex-rollout.jsonl:1)).

### 4. Home and Stats effects

The durable update is:

```text
attempt.usage
  → state.usage / result.usage
  → rollup.json
  → history/runs.jsonl
  → dashboard readIndex()
  → dashboardModel()
  → Home and Stats repaint
```

Home aggregates rollup pool entries for API cost, subscription cost, and token source ([home-model.js:122](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/src/workflow/home-model.js:122)). Its formatter distinguishes estimated, transcript-summed, and provider-reported values ([usage-basis.js:75](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/src/lib/usage-basis.js:75)).

Therefore:

- unknown → transcript-summed changes `api unknown`/blank to `≈ $… api summed`;
- estimated → transcript-summed replaces `~ $… api estimated` with `≈ $… api summed`;
- subscription may remain unknown if no meter or plan price exists;
- no missing amount becomes `$0`.

Rollups keep strict whole-scope money null while retaining known subtotals ([rollup.js:177](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/src/workflow/rollup.js:177)). Stats follows the same rule: a partial period stays null for total spend until all attempts are priced ([stats-model.js:864](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/src/workflow/stats-model.js:864), [stats-model.js:898](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/src/workflow/stats-model.js:898)).

### 5. Tests

Add real-fixture acceptance coverage for the reconciler:

- First pass: terminal estimated Codex attempt plus the actual Codex rollout fixture; assert `transcript-summed`, updated state/result/rollup/history, and ledger outcome `matched`.
- Second pass with unchanged fingerprints: assert zero index builds, zero eligible scans, and `elapsedMs < 1000`.
- Late transcript: first pass against an empty temporary provider store; copy the real rollout fixture in; next pass must reset tries from the changed store fingerprint and upgrade the attempt.
- Reader upgrade: keep the store unchanged, change the reader version, and assert previously exhausted attempts become eligible.
- Ambiguous match: duplicate a real transcript fixture into two real store locations; assert `ambiguous`, no arbitrary selection, and no false cost.
- Task-text match: use a captured real Codex rollout that actually contains a first user message; assert unique `task-text` confidence and duplicate-task ambiguity.
- Concurrency: launch two real reconciler child processes against one temporary home; assert one owns the lock, the other skips, and history contains one rollup line.
- Dashboard: use the real updated rollup/history, start the dashboard with a test TTY, let the detached child run, and assert a later frame contains the repriced Home/Stats values and the quiet pricing note.

Existing real-fixture tests provide good building blocks:

- Codex/Claude/Grok reader behavior and ambiguity are covered in [transcripts.test.js:41](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/tests/transcripts.test.js:41) and [transcripts.test.js:142](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/tests/transcripts.test.js:142).
- Real indexed Codex project backfill is covered in [workflow-reprice-project.test.js:43](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/tests/workflow-reprice-project.test.js:43).
- Current reprice tests prove rollup/result persistence ([workflow-reprice.test.js:237](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/tests/workflow-reprice.test.js:237)), but several inject transcript-reader functions ([workflow-reprice.test.js:219](/home/dev/Repo/bullswork/bullswarm-0.35.2-providers/tests/workflow-reprice.test.js:219)). Those are useful unit tests, not sufficient proof for the new automatic path.

I ran the focused baseline:

```text
1..14
# tests 14
# pass 14
# fail 0
```

I did not run the full suite because this was a report-only study and the checkout currently contains pre-existing uncommitted changes, including provider/transcript files. I left them untouched.

