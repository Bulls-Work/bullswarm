# bullswarm

Route work across coding-agent CLIs. The frontier agent keeps orchestration,
judgment, and synthesis; bounded work goes to whichever subscription has the
most quota left; every delegate output is judged by content before it counts.

## The doctrine (non-negotiable)

1. **Judge by CONTENT, not exit code.** Every delegate CLI can exit 0 while
   having done nothing. A non-zero exit is never a success; `ok:true` requires
   passing verification.
2. **Pace by meter.** The scheduling resource is the subscription window:
   elapsed% minus used%, most-behind pool wins. Pace may only promote a
   *cheaper* pool. Lanes are work-nature, never hard-coded to pools.
3. **Delegate output is input, never the answer.** Final synthesis,
   architecture decisions, and anything needing live conversation context
   stays with the caller.
4. **Quarantine re-probes.** A benched pool must be able to return to service
   automatically; a lane is never allowed to silently go down.

## Install

```bash
npm install -g bullswarm   # or: node bin/bullswarm.js directly from a checkout
```

## Quick start

```bash
bullswarm          # first run: interactive setup wizard
bullswarm setup    # re-run or repair
bullswarm pools    # meter state, pace position, quarantine status
bullswarm run --lane analyze --add-dir ~/some-repo --task-file /tmp/t.md --json
bullswarm health   # re-judge saved outputs; catch gate failures
```

## Verbs

| Verb | Purpose |
|---|---|
| `setup` | Discover installed agent CLIs, show quota state, toggle pools, suggest a routing table, write config. Approval-gated, idempotent. |
| `run` | route → dispatch → watch → verify → one JSON verdict |
| `health` | Re-judge saved outputs against their verdicts; surface verify-gate failures and quarantine clusters |
| `pools` | Show each pool's meter state, pace position, quarantine status |
| `doctor` | Machine-readable readiness report; self-heals on first call |
| `workflow` | Run / validate / list / draft. Drafts are built interactively from the CLI. |

## Building a workflow from the shell

`bullswarm workflow draft ...` lets you assemble a workflow one
mutation at a time. No upfront JSON required. Drafts persist under
`~/.bullswarm/drafts/<name>/` and become first-class workflows
(discoverable, runnable by name) the moment they exist.

```bash
bullswarm workflow draft create audit-code \
    --description "Audit the source code" --input targetDir=.
bullswarm workflow draft phase add audit-code discover
bullswarm workflow draft phase add audit-code review
bullswarm workflow draft step add audit-code discover list-files \
    --type run --lane chore --prompt "List every .js file in src/" \
    --addDir '{{inputs.targetDir}}'
bullswarm workflow draft step add audit-code review per-file \
    --type fanout --items-from 'outputs.list-files.outFile' \
    --lane analyze --concurrency 2 \
    --step-template '{"lane":"analyze","addDir":"{{inputs.targetDir}}","prompt":"Review {{item}}"}'
bullswarm workflow draft show audit-code    # inspect the JSON
bullswarm workflow draft run audit-code     # execute it
bullswarm workflow draft export audit-code workflows/audit-code.json   # promote to file
```

`step add` re-validates after every mutation; partial drafts (zero
phases, etc.) are treated as building, not invalid. `set` and
`step set` patch fields in place. `delete` requires `--yes`.

## The verdict

```json
{
  "ok": true,
  "keepOnClaude": false,
  "why": "verified",
  "pick": { "pool": "grok", "command": ["grok", "-p", "..."] },
  "contentUsableDespiteExit": false,
  "outFile": "/tmp/dlg.out"
}
```

- `ok: true` — verified output, read the file
- `keepOnClaude: true` — router says do it in-session; nothing ran
- `ok: false` — `why` names the failed gate
- `contentUsableDespiteExit: true` — non-zero exit but complete output; read
  before re-running

## License

MIT
