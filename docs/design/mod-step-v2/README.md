# Claude mod Step v2 frames

`scripts/render-mod-step-frames.mjs` builds these text frames from three real
`tests/fixtures/home-351` action records read through `workflow action show
--json`. The running and failed frames keep their fixture step data while
projecting those two terminal states, because the scrubbed fixture contains
only completed workflows.

Widths 55 and 120 exercise the phone and desktop pane orders. Each state has
an overview and detail frame:

- `finished-*`: `va7k9a / step-model`
- `running-*`: `va7k9a / step-view`, projected at turn 8
- `failed-*`: `va7k9a / verify`, projected failed

Compared with `docs/design/tidy-0.35.1/frames/real-step-*`, the mod uses the
same grammar: one v2 verdict header; the visible `overview · detail` toggle in the
activity/transcript heading, straight after its word (the Step line above carries
nothing else; the current view is bracketed in these frames, dotted in the pane);
latest 5/10 overview turns with `click for detail`; every turn and tool in the
detail transcript; result or running `now`; task `owns` / `after` / `affects`;
and the two API-rate/plan cost rows. Below 100 columns the section order is
header → result/now → activity/transcript → task → cost; at 120 it is header →
activity/transcript → result/now → task → cost.

`usage-no-run-before.txt` and `usage-no-run-after.txt` record the focused-pane
tmux reproduction with Claude Code 2.1.278. The pre-fix Usage page opened but
had no return control; the fixed footer exposes `back`, and `b` returns to the
idle pane.
