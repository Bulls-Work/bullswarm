# Handoff: custom provider configuration for Bullswarm (design discussion, 2026-09-12/13)

You are picking up a design discussion about how Bullswarm (repo `/Users/cowcow02/Repo/bullswarm`, the installed `bullswarm` CLI is a symlink into this checkout, so edits are live) should let a package user add their own provider without touching the repo. Nothing from this discussion has been implemented. Read this file, then continue the discussion with the user or, if asked, turn it into a plan or a Bullswarm workflow.

## Where the repo stands

- Branch `main`, 2 unpushed commits (231c5f5, 866b6b7 = unreleased 0.29.0). Seven files are modified and uncommitted: `src/lib/opencode-relay.js`, `src/meters/registry.js`, `src/lib/config.js`, `tests/opencode-relay.test.js`, `tests/meters.test.js`, `CHANGELOG.md`, `.gitignore`. Suite: 838 pass, 0 fail. `bullswarm update` refuses to pull while the checkout is dirty.
- Uncommitted work: (1) OpenCode reasoning variants are now injected for every model a Relay provider lists in opencode.json, not just gpt-5.6-luna, so a `--variant medium` on gpt-5.6-sol actually reaches the API (verified: low 1,552 vs xhigh 5,027 reasoning tokens on relay-2); (2) the Relay meter reads used% against the pool's declared `includedValueUsd` (set-subscription --included-usd) before the host-wide `RELAY_PLAN_USD` and the $50 default.
- Live routing state (no pins, pace decides): Claude accounts Opus on high only; grok grok-4.6 on medium only; command-code DeepSeek v4.1 flash on medium+low; Relay pools 1/2/4 gpt-5.6-sol on high only (medium reasoning); codex gpt-5.6-sol high (medium) and gpt-5.6-luna medium+low (max); Relay 3 disabled (account banned). No real job has run on codex yet.
- Relay facts: gpt-5.6-luna has no upstream channel on any key (503); sol, terra, gpt-5.5 answer on keys 1/2/4. relay-4 is a new $20 newcomer wallet, provider added to `~/.config/opencode/opencode.json` (backup `opencode.json.bak-20260912-relay4`), key file `.relay4-key` in the repo root is git-ignored. Memory note: `~/.claude-wati/projects/-Users-cowcow02-Repo-bullswarm/memory/relay-declared-reset-dates.md`.

## The user's goal

Remove every Relay footprint from the repo while Relay keeps working in the pool system, the strategy pages and setup. Let the package user, or an agent acting for them, add a custom provider locally. Prefer declarative files over executable plugin code.

## Relay footprint today (what has to move)

- `src/lib/opencode-relay.js`: scans opencode.json for api.relay.com keys, clones the `opencode2` connector per key (pools `opencode2`, `opencode2:relay-2`, ...), pins `--model <id>/gpt-5.6-luna`, injects `OPENCODE_CONFIG_CONTENT` reasoning variants, sets `upstreamGroup: relay:<host>`. Called from `loadConnectors` in `src/lib/config.js` right after `expandClaudeAccountConnectors` (the same hard-coded pattern).
- `src/meters/relay.js` + the pool-to-reader mapping in `src/meters/registry.js` (`relayReaderFor`, `relayIncludedUsd`, env `RELAY_PLAN_USD`).
- One New-API phrase in `src/lib/auth-signatures.js` defaults ("no available channel for model"); connectors can already declare `authSignatures` in JSON.
- Help examples in `src/help.js`, connector comments in `connectors/opencode2.json`, docs, changelog, and about 20 test files that use `opencode2:relay-2` as a pool name.
- Already generic and user-local: `~/.bullswarm/connectors/*.json` is read by `loadConnectors` for any JSON; `upstreamGroup` and `authSignatures` are plain connector fields.

## Design conclusions reached so far (in order; later ones supersede earlier)

1. **Plugin hooks** (`~/.bullswarm/plugins/<name>/plugin.mjs` exporting `expandConnectors`, `meterReaderFor`, `authSignatures`) would work and cost about a day. Kept only as an escape hatch; the user does not want executable plugins as the primary path.
2. **Agent-authored providers**: add `bullswarm provider scaffold | probe | enable | list | validate` (JSON-first) and a `provider-authoring` skill. `probe` runs one real one-word task through the connector alone, checks the model flag, reasoning flag, event parsing and meter, and is the step not to skip. Only `enable --yes` touches routing. Keys never go in connector JSON.
3. **Manifest pattern**: a first draft with `clone` from opencode-config, `recipe: opencode-variants`, `http-json` meter engine and `sharedCredential` was rejected by the user as too Relay-shaped.
4. **Current position, generic short form.** A pool is a CLI + an environment that selects one account/backend + a quota. Essential fields:
   - `name`
   - `agent`: a known CLI name (`opencode`, `codex`, `claude`, `grok`) which inherits spawn, output parsing, model flag, reasoning flag, failure phrases; or `{ run: "<cmd> {task}", output: "stdout" | "jsonl", modelFlag }` for a new CLI
   - `models`: ids as the CLI expects them (also serves as discovery)
   - `env`: variables that make this pool this account/backend (universal switch: `OPENCODE_CONFIG_CONTENT`, `CLAUDE_CONFIG_DIR`, base URL/key vars)
   - `quota`: `none` or `{ window: weekly|monthly, includedUsd?, resetsAt?, reader? }`; `reader` names a built-in reader (grok, claude, codex) or a generic `http-json` engine
   - optional generic: `instances: [{ suffix, env, models? }]` (one pool per credential, replaces every "scan another tool's config and clone" engine) and `credentialGroup` (string; siblings benched together on auth failure; the existing upstreamGroup under an honest name)
   - Deliberately excluded from runtime: reading another tool's config to discover keys (a `provider add` convenience may write `instances` once), vendor-named meters, model-prefix rewriting.
   - Implementation shape: a **normaliser** expanding the short form into today's full connector so routing, verdicts and strategy pages do not change; per-CLI base profiles addressable via `agent`; a **shared model catalog** (tier/quality/pricing by model name, replacing per-connector `modelProfiles`); per-tier reasoning defaults move to strategy state where `set-rung` already writes them; `instances` + `credentialGroup` in the normaliser retire both hard-coded expanders (Claude accounts become `agent: claude` + `CLAUDE_CONFIG_DIR`).
5. **Limits check against grok** (the real test): the short form covers ~80% of grok and 100% of a reseller. Two irreducible gaps for any new CLI: its **event-stream rules** (grok needs two rules with id/kind/summary/status paths; keep the existing rules language, it already serves four CLIs) and its **meter** (grok refreshes an OAuth token; stays a built-in named reader). Verdict: not too limited provided the short form is additive, every full-connector field stays legal and explicit values win over defaults. Grok would be ~25 lines instead of ~130; a reseller ~8.

## Open questions to settle with the user

- Confirm the short-form field list above, especially `instances` vs. a one-time `provider add` that discovers keys from opencode.json.
- Whether Claude accounts also migrate to the short form or stay as the built-in reference expander.
- Whether changelog history mentioning Relay is scrubbed (I advised leaving history).
- Order of work proposed: normaliser + defaults, shared model catalog, `provider add/probe`, then Relay extraction into `~/.bullswarm/providers/` with a live probe of relay-4 as acceptance. Suggested delivery: one Bullswarm workflow with parallel writers, an integration action, and an adversarial-acceptance action.

## Standing rules that shaped the discussion

Real data only; evidence before "done" (exercise the real artifact); plain words, verdict first; every `set-model` clears all tier pins; `set-rung` needs `--force` for a model not in cached discovery; do not poll Relay usage endpoints repeatedly (429).
