# Home “today” prototype frames

These are plain-text, no-colour frames for the redesigned Home section:

- [`home-today-55.txt`](home-today-55.txt) is the phone layout. Finished-run cards stack above the licence block.
- [`home-today-120.txt`](home-today-120.txt) is the desktop layout. The cards and licence block sit side by side.

The frame snapshot is 2026-09-18 (Asia/Hong_Kong), captured at
2026-09-18T05:09:23Z. The three finished workflows attributed to today are:

| card | project | goal opening shown on the card | recorded wall time | result |
| --- | --- | --- | ---: | --- |
| `2yrcxi` | `project-a` | `[other project's task text removed]` | 104.9m | completed, not verified |
| `fuyyca` | `bullswarm` | `The 0.33.0 owner-review pass in /home/dev/Repo/bullswork/bullswarm-dashboard (branch dashboard-0.33, PR #36, version 0.33.0): close the eight readability gaps the owner found while using the dashboard on a phone against real data.` | 208.2m | completed, not verified |
| `ipccf2` | `project-a` | `[other project's task text removed]` | 542.7m | completed, verified |

The `for:` text is a readable prefix of the exact first goal line, clipped to fit
the card. The source lines (including their long repository context) are:

- `2yrcxi`: `[other project's task text removed]`
- `fuyyca`: `The 0.33.0 owner-review pass in /home/dev/Repo/bullswork/bullswarm-dashboard (branch dashboard-0.33, PR #36, version 0.33.0): close the eight readability gaps the owner found while using the dashboard on a phone against real data. Evidence of each gap is the owner's screenshot in docs/design/owner-review-2026-09-18/ (named per page). The product keeps real figures and the ≈/basis rules; nothing is invented. Rendering is checked on a COPY of the real home (cp -Rp ~/.bullswarm /tmp/bsw-review-home, then BULLSWARM_HOME=/tmp/bsw-review-home node bin/bullswarm.js workflow reindex), never on ~/.bullswarm itself, at 55x26 (phone portrait), 60x50 (tall phone), 170x35 (phone landscape) and 200x50, with tmux + scripts/tui-shot.py.`
- `ipccf2`: `[other project's task text removed]`

The source commands and measurements used were:

1. `node /home/dev/Repo/bullswork/bullswarm-0.33.1/bin/bullswarm.js workflow runs list --json` returned `count: 1`: the ongoing `u9d48s` run (`status: running`). That command defaults to ongoing runs, so it does not itself return finished cards. `workflow runs list --all --since today --json` returned the same ongoing run plus the completed `fuyyca` and `2yrcxi`; the durable run history’s `finishedAt` attribution also includes `ipccf2`, which started on 17 Sep and finished on 18 Sep. The cards above use those real goal and project fields.
2. `node /home/dev/Repo/bullswork/bullswarm-0.33.1/bin/bullswarm.js pools` at the snapshot printed these live meter readings: `claude-code` weekly `63%` used / `53.1%` elapsed and 5-hour `3%`; `claude-code:acme` weekly `76%` / `92.4%` and 5-hour `36%`; `codex` weekly `59%` / `73.1%`; `grok` weekly `98%` / `99.2%`; `command-code` monthly `0.4%` / `3.6%` and 5-hour `1.3%`; `claude-code:initech`, `echo`, and `opencode` were disabled or unmetered. Those are the `used` cells, not a claim that the whole meter was spent today.
3. The finished-workflow records supplied today’s measured worker minutes and API-equivalent estimates: `claude-code:acme` `84.01m` and `≈$0.161738`; `codex` `161.77m` and `≈$0.031034`; `grok` `25.97m` and `≈$0.009668`; `opencode` `634.64m` with no recorded API estimate. The frame rounds minutes to one decimal and money to cents. The measured workflow share of each pool’s own licence window was `2.9%` (acme), `2.1%` (codex), and `4.3%` (grok), calculated as that pool’s measured worker-minutes × its measured `%/minute` rate from the dashboard loader’s meter history; no rate was invented.
4. `node /home/dev/Repo/bullswork/bullswarm-0.33.1/bin/bullswarm.js workflow usage --json` is not a command in this checkout; it printed the workflow help text rather than a usage JSON document. Therefore the `run%` column is `—`: no normalized licence percentage exists for the two finished `bullswarm run` tasks. Their measured durations are still available from the task ledger: codex `60.0m` (1 task) and opencode `17.6m` (2 tasks). Workflow and single-run minutes are shown separately so they are not silently added together.

`API≈` is the recorded API-equivalent estimate, not an invoice. `wf%` is a percentage-point draw against each pool’s own meter window, not a share of the other pools. `—` means the source did not measure that figure; it is deliberately not replaced with zero.

Pressing Enter on a finished card opens that workflow’s run detail. Pressing Enter on a pool row opens its Budget detail: every reported window (5-hour, 7-day, or monthly), reset time, pace, and the measured workflow-minute basis. The `run%` detail remains absent until a task records a normalized quota draw.

Design choices: cards keep the goal’s first line visible and make the project a separate identity; the desktop keeps the two concerns in parallel while the phone stacks them; the right block labels live meter usage, workflow draw, single-run draw, and minutes separately so a missing measurement cannot look like “0%”.
