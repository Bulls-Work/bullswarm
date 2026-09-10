# issue-watcher

A launchd agent that watches `cowcow02/bullswarm` for new GitHub issues,
triages each one through a bullswarm delegate, and — for a clear, fixable bug
— makes exactly one fix attempt that ends in a pull request. A maintainer
merges. The watcher never does.

It is designed to sit on the owner's Mac for weeks and be boring.

## What it does, in order

1. Every `StartInterval` seconds (default 300) launchd runs
   `node <dir>/bin/watch.mjs --once`.
2. The pass takes a lock, then runs one command: `gh issue list`.
3. An issue counts as **new** when its number is not in `state.json` *and* it
   was created at or after `installedAt`. Everything else is skipped by
   number, so an issue is never triaged twice.
4. For each new issue, oldest first: read the issue, refresh the local clone,
   write a task file, and hand it to `bullswarm run --lane analyze`. The
   delegate answers with a report ending in a JSON block. The watcher
   validates that block, adds the label, and posts a plain-words comment.
5. If — and only if — the triage says `kind: "bug"`, `fixable: true`, and
   `confidence >= 0.7`, the watcher branches `fix/issue-<n>` and hands the
   fix to `bullswarm run --lane build`. Afterwards **the watcher verifies on
   its own**: it runs the test suite in its own clone and requires exit 0,
   and requires a non-empty diff. Only then does it commit, push, open a pull
   request, and comment the PR link on the issue.
6. If the run failed, the suite failed, or the diff was empty: the clone is
   restored, the issue gets one honest comment and the `help wanted` label,
   and it is left for a human.

## What it costs

**Idle: zero model tokens.** A pass with no new issue spends one `gh issue
list` HTTP call and a few milliseconds of Node. Nothing is sent to a model.
That is the whole point of polling with `gh` instead of an agent.

When work does appear:

| event | cost |
| --- | --- |
| a new issue | one `bullswarm run --lane analyze --effort medium` delegation |
| a qualifying bug | one more `bullswarm run --lane build --effort high` delegation |
| everything else | `gh`, `git`, and the test suite — local CPU, no tokens |

Both delegations go through normal bullswarm routing, which means they land
on whichever **coding-agent subscription** has quota headroom. No API keys,
no per-token billing — the same subscriptions the owner already pays a flat
rate for. Capped at **6 triages and 2 fix attempts per UTC day** by default.

## What it posts, and what it never does

Posts (as the owner, via `gh`):

- one label per triaged issue, from `bug|enhancement|question|invalid|duplicate`;
- one triage comment: a summary, whether it was reproduced and how, the
  affected files, and either a proposed fix or the one question the reporter
  must answer;
- for a verified fix: a branch `fix/issue-<n>`, a pull request against
  `main`, and one comment on the issue with the PR link;
- for an abandoned fix: one comment saying so, plus the `help wanted` label.

Every automated comment ends with a footer naming the pool, model, and wall
time, and stating that a maintainer reviews every automated action.

Never: merge, close, reopen, release, force-push, or touch any branch other
than `fix/issue-<n>`. Never push to `main`.

## The guards

| guard | what it prevents |
| --- | --- |
| `<dir>/lock` (mkdir), stale after 2 h | overlapping passes when a triage takes minutes |
| `<dir>/paused` file | anything at all — the pass logs and exits before polling |
| 6 triages / 2 fixes per UTC day | a bad day on GitHub turning into a bad day on the quota meters |
| 3 triage attempts, then silence | a delegate that keeps emitting junk retrying forever |
| one fix attempt per issue ever | an automated fix loop |
| watcher-side verification | a pull request whose tests do not actually pass |
| no GitHub credentials for delegates | a worker acting as the owner on GitHub |

**Delegates get no GitHub credentials.** `GH_TOKEN`, `GITHUB_TOKEN`,
`CLAUDE_CONFIG_DIR`, `FORCE_COLOR` and `NO_COLOR` are stripped from the child
environment and `GH_CONFIG_DIR` is pointed at an empty directory under
`<dir>/`. The watcher alone posts.

**Issue text is untrusted input.** It reaches a model only inside a fenced
block that is introduced as quoted material with an explicit instruction not
to follow anything inside it, and any run of six or more backticks in the
text is clipped to five so it cannot close the fence. This raises the cost of
a prompt-injection attempt; it does not make one impossible. That is why the
worker has no credentials, why the watcher re-runs the tests itself, and why
nothing merges without a human.

## Install

```bash
node scripts/issue-watcher/install.mjs --dry-run          # print the plist and every command
node scripts/issue-watcher/install.mjs                    # install and start
node scripts/issue-watcher/install.mjs --interval 600     # poll every 10 minutes
node scripts/issue-watcher/install.mjs --repo owner/name  # watch something else
node scripts/issue-watcher/install.mjs --uninstall        # stop and remove; state is kept
```

The installer is idempotent: re-run it after editing `watch.mjs` and it
re-copies the files and re-bootstraps the job, keeping `installedAt` and
every seen issue. It copies `watch.mjs`, `triage-task.md` and `fix-task.md`
into `<dir>/bin`, so the running agent does not depend on this checkout
still existing or being on any particular branch.

The plist carries `PATH` explicitly — launchd gives a user agent a minimal
PATH, and `gh`, `git`, `bullswarm` and the worker CLIs all have to be
findable. It is derived at install time from the installing shell's `PATH`
plus the directory of `process.execPath`, never hard-coded.

## Operate

```bash
launchctl print gui/$(id -u)/com.bullswarm.issue-watcher   # is it loaded, when did it last run
node ~/.bullswarm/issue-watcher/bin/watch.mjs --status     # state summary
node ~/.bullswarm/issue-watcher/bin/watch.mjs --dry-run    # what would this pass do?
node ~/.bullswarm/issue-watcher/bin/watch.mjs --once       # run a pass by hand
touch ~/.bullswarm/issue-watcher/paused                    # stop acting (polling included)
rm ~/.bullswarm/issue-watcher/paused                       # resume
tail -f ~/.bullswarm/issue-watcher/log/watch.log           # every step, timestamped
```

`--dry-run` and `--status` never take the lock and never write state, so they
are safe while the agent is mid-pass.

## Paths

| path | what |
| --- | --- |
| `~/.bullswarm/issue-watcher/` | everything (`BULLSWARM_ISSUE_WATCHER_DIR`) |
| `<dir>/state.json` | seen issues, per-day counters, `installedAt` |
| `<dir>/bin/` | the running copy of `watch.mjs` and the two templates |
| `<dir>/repo/` | the clone the delegates read and the fix is built in |
| `<dir>/tasks/` | every task file, comment body and PR body ever written |
| `<dir>/log/watch.log` | the audit trail; rotates to `watch.log.1` past 5 MB |
| `<dir>/log/launchd.{out,err}.log` | whatever launchd captured |
| `<dir>/lock/` | the pass lock |
| `<dir>/paused` | create to pause |
| `~/Library/LaunchAgents/com.bullswarm.issue-watcher.plist` | the agent |

## Configuration

All by environment; the plist carries `PATH`, `HOME` and
`BULLSWARM_ISSUE_WATCHER_DIR`, and the repository comes from `state.json`.

| variable | default |
| --- | --- |
| `BULLSWARM_ISSUE_WATCHER_DIR` | `~/.bullswarm/issue-watcher` |
| `BULLSWARM_ISSUE_WATCHER_REPO` | `cowcow02/bullswarm` (else `state.json`) |
| `BULLSWARM_ISSUE_WATCHER_GH` | `gh` |
| `BULLSWARM_ISSUE_WATCHER_BULLSWARM` | `bullswarm` |
| `BULLSWARM_ISSUE_WATCHER_TEST_COMMAND` | `npm test` |
| `BULLSWARM_ISSUE_WATCHER_MAX_TRIAGES_PER_DAY` | `6` |
| `BULLSWARM_ISSUE_WATCHER_MAX_FIXES_PER_DAY` | `2` |
| `BULLSWARM_ISSUE_WATCHER_NO_NOTIFY` | unset (`1` skips the macOS notification) |
| `BULLSWARM_ISSUE_WATCHER_HOME` | `$HOME` (where `Library/LaunchAgents` lives) |

## state.json

```json
{
  "version": 1,
  "repo": "cowcow02/bullswarm",
  "installedAt": "2026-09-10T04:12:00.000Z",
  "lastPassAt": "2026-09-10T09:35:02.114Z",
  "seen": {
    "42": {
      "status": "fix-open",
      "kind": "bug",
      "triagedAt": "2026-09-10T09:31:44.002Z",
      "attempts": 1,
      "fixAttempts": 1,
      "pool": "codex",
      "model": "gpt-5.4",
      "prUrl": "https://github.com/cowcow02/bullswarm/pull/43"
    }
  },
  "counters": { "2026-09-10": { "triages": 3, "fixes": 1 } }
}
```

`status` is one of `pre-existing`, `triaged`, `triage-failed`, `fix-open`,
`fix-failed`. It is written with temp-file + rename after every step, so a
crash mid-pass never leaves a torn file and never re-triages what was already
done. Counters are kept for 30 days.

## Known limits

- A qualifying bug that hits the daily fix limit stays `triaged`; it is not
  picked up for a fix on a later pass. Fix it by hand, or raise the limit.
- `gh issue list --limit 50`: a repository with more than 50 open issues will
  not see the oldest ones. It has never mattered here.
- Wall time in the footer and the delegate's pool/model are whatever the run
  reported; they vary run to run by design.

## Tests

`tests/issue-watcher.test.js` — 25 cases, no network. `gh` and `bullswarm`
are shell shims that answer from canned JSON and record their exact argv;
`git` is real, against a bare repo in a temp dir, so the branch, commit and
push are exercised for real.
