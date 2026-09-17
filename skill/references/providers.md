# Adding a provider

A provider teaches Bullswarm one agent CLI. This file is the method. The
contract (exports, `ctx`, the kit, the snapshot, every pool field and its
reader) is `docs/reference/providers.md` in the repository; open it while you
fill in the exports.

Add a provider only when the user asks for one. A new provider is a local
provider in `~/.bullswarm/providers/<name>/` unless the user is changing the
Bullswarm repository itself.

## 1. Discover before writing

Read the CLI's own `--help` and run it by hand. Write down, from real output
only:

- **Headless launch.** The argv that runs one prompt non-interactively and
  exits, and where the prompt goes (a file path, stdin, an argument). Note any
  flag it needs to skip permission prompts.
- **Project resolution.** Whether it takes a directory flag or reads `$PWD`.
  A CLI that reads `$PWD` needs `cwdMode: "pwd"`, or it will answer about the
  wrong repository.
- **Output.** Plain stdout, a JSON field, a file, or a JSONL event stream. For
  a stream, capture one full run and note the event that carries the final
  answer.
- **Model flag.** The flag name and how model IDs are written. Whether a
  listing command exists.
- **Reasoning flag.** The flag or config override, and the exact levels it
  accepts. Leave `reasoning` out when there is none. Mark any value the CLI
  never printed as unverified; never invent one.
- **Failures.** The exact text of an auth failure and of a usage-limit hit.
- **Meter.** Whether the vendor has a usage endpoint, and how it
  authenticates. No endpoint means no `readUsage`; the pool uses a declared
  meter or none.

When the CLI is already shipped and only the account differs (a reseller, a
second login), skip most of this: clone the shipped template.

## 2. Scaffold

```bash
bullswarm provider scaffold <name>
bullswarm provider scaffold <name> --from opencode
```

This writes a commented `provider.mjs` with every export. `--from` copies
that shipped `connector.json` in as the starting template.

## 3. Fill in

Put what you discovered into `connector.json`. Add `provider.mjs` exports
only for what JSON cannot express:

- `connectors(ctx)` for several pools from one template. Build them with
  `ctx.kit.clonePool(ctx.templates.<shipped>, overrides)` and name each
  `<name>` or `<name>:<suffix>`. Keep it synchronous and offline.
- `readUsage(pool, ctx)` when a meter endpoint exists. Fetch with
  `ctx.kit.bearerJson`, return `ctx.kit.snapshot(...)`, throw on failure.
- `doctor(ctx)` only when `bin` on `PATH` plus an existing `configDirs` entry
  is the wrong health test.

Use `ctx.kit`, never `import 'bullswarm/provider-kit'`, from a local provider.
No top-level `await`. Read keys inside `readUsage`; put only pointers in `env`,
never a secret.

## 4. Validate

```bash
bullswarm provider validate <name> --json
```

Exit 2 lists what failed: an export of the wrong type, a pool outside the name
prefix, a missing required field, a value the schema does not allow. Fix and
validate again until it exits 0.

## 5. Probe

```bash
bullswarm provider probe <pool> --json
```

Probe every pool the provider returns. Validate only checks shape. Probe is the
only step that runs the real CLI, and a CLI exits 0 while doing nothing. Probe
spawns the pool through the dispatcher's own runner with a one-word task, then
calls `readUsage` once. It catches what validate cannot: a flag the CLI
rejects, a model ID it does not know, output extraction that returns the
wrong text, a meter call that throws. Read the printed argv against your
discovery notes. Exit 1 means the reply lacked `PONG` or `readUsage` threw. A
provider that has not passed probe is not ready. Say so; do not enable it.

## 6. Enable

A local provider loads on the next Bullswarm start; confirm it with
`bullswarm provider list`. A contrib provider loads only after
`bullswarm provider enable <name>`. Either way the pool then routes like any
other, and `bullswarm strategy set-provider` turns it off without removing it.
Report the pool names, the probe output, and anything you marked unverified.
