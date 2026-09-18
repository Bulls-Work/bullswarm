# Prototype frames

Exact text frames of the approved dashboard prototype (docs/design/dashboard-prototype.html), one file per page and width:
`<page>-120.txt` (desktop, 120 columns × 40 rows) and `<page>-55.txt` (phone, 55 columns × 26 rows).
`▇` marks a coloured background cell (meters, share bars). The `.tagged.txt` twins keep the
prototype's colour and role markup: `{g|…}` green, `{a|…}` amber, `{r|…}` red, `{p|…}` purple,
`{o|…}` orange, `{c|…}` cyan, `{b|…}` bold, `{d|…}` dim, `{u|…}` underline, `{on|…}` selected,
`{k:<action>|…}` clickable. The prototype's numbers are illustrative; the product shows real data
in the same composition. `docs/design/prototype-shots/` holds the owner's screenshots of the
prototype on a 200-column terminal-width window; `scripts/tui-shot.py` renders a tmux pane of the
real product to PNG for the same comparison.
