# Integration audit — can Codex, Claude, and Grok discover the Bullswarm skill?

Read-only evidence report. Date: 2026-08-31. Repo checkout: `/Users/cowcow02/Repo/bullswarm`
at commit `8908ef8` ("feat: portable opencode2 connector and LLM-refined delegate
classification"), version `0.20.0`. Every number, path, and quotation below came from a
command run during this audit; nothing is inferred from memory. No file outside
`docs/integration-audit-2026-08-31.md` was modified.

## Verdict

All three CLIs **do discover and register** the Bullswarm skill that
`bullswarm integrate install` put in place. Two caveats, both confirmed, neither fatal:
the skill the CLIs actually load is a **different, older copy** than this checkout, and
`bullswarm integrate status` run *from this checkout* reports `conflict` for all three
agents purely because of that copy mismatch — not because anything is missing.

| Agent | Registered? | Evidence class | Where its copy comes from |
| --- | --- | --- | --- |
| Codex (`codex-cli 0.151.0`) | Yes | Skill appears in Codex's own model-visible prompt | `~/.codex/skills/bullswarm/SKILL.md` (root `r0`) |
| Claude Code (`2.1.251`) | Yes | Skill listed in this live session's available-skills block | `~/.claude/skills/bullswarm` |
| Grok (`grok 1.0.13`) | Yes | `grok inspect --json` lists it, `userInvocable: true` | `~/.grok/skills/bullswarm/SKILL.md` |

Awareness block: present and byte-identical in all three global instruction files, and it
is actually delivered to the model (proved for Codex and Claude, see §4).

**Scope limit — read this before quoting the table.** "Registered" means each CLI's own
discovery machinery resolved the skill and put it in front of the model. It does **not**
mean a Bullswarm task was executed end-to-end through each CLI; running the skill would
require invoking each model, which is outside this audit's read-only mandate. Grok's
`userInvocable: true` is Grok's own assertion about `/bullswarm`, quoted as such, not an
observed invocation.

## 1. What is installed on disk

All three integration points are symlinks with the same target:

```
/Users/cowcow02/.claude/skills/bullswarm -> /Users/cowcow02/.local/lib/node_modules/bullswarm/skill
/Users/cowcow02/.codex/skills/bullswarm  -> /Users/cowcow02/.local/lib/node_modules/bullswarm/skill
/Users/cowcow02/.grok/skills/bullswarm   -> /Users/cowcow02/.local/lib/node_modules/bullswarm/skill
```

Each resolves (`readlink -f`) to an existing directory containing `SKILL.md`, `agents/`,
`references/`. None is broken.

Three copies of the Bullswarm skill exist on this machine:

| Copy | `skill/SKILL.md` size | Role |
| --- | --- | --- |
| `/Users/cowcow02/Repo/bullswarm/skill` | 5.4K | this checkout (working tree) |
| `/Users/cowcow02/.local/lib/node_modules/bullswarm/skill` | 5.1K | **what all three symlinks point at** |
| `/Users/cowcow02/.nvm/versions/node/v22.17.0/lib/node_modules/bullswarm/skill` | — | second global install, unused by the symlinks |

`which -a bullswarm` resolves `/Users/cowcow02/.local/bin/bullswarm` first, which is a
symlink to `../lib/node_modules/bullswarm/bin/bullswarm.js` — i.e. the same `.local` copy
the skill symlinks point at. `npm root -g` reports the *other* prefix,
`/Users/cowcow02/.nvm/versions/node/v22.17.0/lib/node_modules`. Both installs report
`"version": "0.20.0"` in `package.json`.

### 1a. The installed skill is stale relative to this checkout

Comparing the **committed** skill (`git show HEAD:skill/SKILL.md`) against the copy the
symlinks point at produces exactly one hunk — HEAD lines 80–87 versus the installed copy's
lines 80–82:

```
HEAD (new):      "In automatic execution, the CLI starts with deterministic signals and
                  lets an LLM refine its decision ... Pass `--classify deterministic` ...
                  or `--classify llm` ... `--dry-run` uses only the deterministic decision."
installed (old): "The CLI classifier is transparent and overridable; the agent may pass
                  `--mode` when domain context makes the correct shape clearer than
                  textual signals."
```

So the LLM-refined classification guidance added in `8908ef8` (`git log --oneline -3 --
skill/SKILL.md`) is **not** in the skill any of the three agents load today. Everything
else under `skill/` is identical between HEAD and the installed copy.

**Concurrent-edit note.** The working tree was *not* clean during this audit:
`git status --short` reported six modified files — `CHANGELOG.md`, `README.md`,
`skill/SKILL.md`, `src/delegate.js`, `src/help.js`, `tests/delegate.test.js` — none written
by this audit, which touched only `docs/integration-audit-2026-08-31.md`. The uncommitted
`skill/SKILL.md` edit is `+7 −4` lines in the same classifier paragraph (it rewords the
`--dry-run` behaviour). Consequently `diff -r skill ~/.local/.../skill` run against the
*working tree* shows that same single region with the newer uncommitted wording. Both
comparisons — working tree vs. installed, and HEAD vs. installed — isolate the identical
paragraph, so the staleness finding holds either way; the quotation above is the committed
text so it stays reproducible. The 5.4K size given for `skill/SKILL.md` in the table above is
the working-tree file at audit time.

## 2. `integrate status` and what "conflict" actually means

The task's mandated command, run from this checkout:

```
$ node bin/bullswarm.js integrate status --json     # exit 1
"ok": false, "skillSource": "/Users/cowcow02/Repo/bullswarm/skill"
codex/claude/grok → skill.status "conflict",
                    skill.target "/Users/cowcow02/.local/lib/node_modules/bullswarm/skill",
                    awareness true
legacyOffload: detected false, action null
```

Same command from the two installed copies:

| Invoked binary | `skillSource` | Per-agent `skill.status` | `ok` | exit |
| --- | --- | --- | --- | --- |
| `node bin/bullswarm.js` (checkout) | `/Users/cowcow02/Repo/bullswarm/skill` | conflict ×3 | false | 1 |
| `/Users/cowcow02/.local/lib/node_modules/bullswarm/bin/bullswarm.js` | `/Users/cowcow02/.local/lib/node_modules/bullswarm/skill` | **installed ×3** | **true** | 0 |
| `/Users/cowcow02/.nvm/.../bullswarm/bin/bullswarm.js` | `/Users/cowcow02/.nvm/.../bullswarm/skill` | conflict ×3 | false | 1 |

The symlink targets never changed between those three runs — only the yardstick did.
`src/integrate.js:15` sets `SKILL_SOURCE` from the *invoking* module's location, and
`skillLinkStatus()` (`src/integrate.js:227–238`) marks a link `installed` only when
`target === resolve(skillSource)`; anything else is `conflict`, including a symlink to a
different, perfectly valid Bullswarm copy. `ok` requires every agent to be `installed`
(`src/integrate.js:100`), and `cmdIntegrate` turns `ok === false` on `status` into exit 1
(`src/integrate.js:190–191`).

**Plain reading:** here `conflict` means *"linked to a Bullswarm copy other than mine"*, not
*"not installed"* and not *"a foreign non-Bullswarm skill is in the way"*. The consequences
are real though: `installIntegration` refuses to run against a `conflict` path
(`src/integrate.js:124–126`, `:209–211`) and `removeSkillLink` leaves it untouched
(`src/integrate.js:220–222`), so from this checkout you can neither repoint nor remove the
links without first deleting them by hand. That is what makes the stale target in §1a
sticky.

The `--json` payload also reports `legacyOffload.detected: false` — the retired
pre-Bullswarm `~/.claude/skills/offload` is gone (`~/.claude/skills-archive` exists).

## 3. Per-agent discovery evidence

### 3a. Codex — confirmed, including symlink traversal

`codex debug prompt-input` renders the model-visible prompt input as JSON without calling a
model. Its `<skills_instructions>` section lists 39 available skills and declares its skill
roots:

```
### Skill roots
- `r0` = `/Users/cowcow02/.codex/skills`
- `r1` = `/Users/cowcow02/.agents/skills`
- `r2` = `/Users/cowcow02/.codex/skills/.system`
- `r3`..`r8` = plugin caches under /Users/cowcow02/.codex/plugins/cache/...
### Available skills
- bullswarm: Use when the user invokes /bullswarm or $bullswarm, ... (file: r0/bullswarm/SKILL.md)
```

Exactly one `bullswarm` entry, rooted at `r0` = `~/.codex/skills`. Since
`~/.codex/skills/bullswarm` is a symlink, this also proves Codex **follows the symlink**
into `/Users/cowcow02/.local/lib/node_modules/bullswarm/skill`. 16 of the 39 entries are
`r0`-rooted, so the user skill root is scanned as a whole, not special-cased.

No skill root under `~/.claude/skills` appears in Codex's root table on this machine.

Supporting local Codex evidence:

- `codex features list` prints `skill_search  stable  true`,
  `skill_mcp_dependency_install  stable  true`, and
  `skip_host_skill_discovery  under development  false` (quoted verbatim; no interpretation
  of what "host" covers is offered here).
- The preinstalled system skill `~/.codex/skills/.system/skill-creator/SKILL.md:151` says:
  "Respect a user-specified location; otherwise create discoverable skills in
  `$CODEX_HOME/skills`, or `~/.codex/skills` when `CODEX_HOME` is unset."
- `~/.codex/skills/.system/skill-installer/SKILL.md` states it "Installs into
  `$CODEX_HOME/skills/<skill-name>` (defaults to `~/.codex/skills`)" and that after
  installing "it will be available on their next turn".
- The `codex` binary embeds a skills subsystem: `strings` on
  `~/.codex/packages/standalone/current/bin/codex` yields `ext/skills/src/loader/discovery.rs`,
  `ext/skills/src/sources.rs`, `ext/skills/src/loader/host_roots.rs`,
  `app-server/src/skills_watcher.rs`, `tui/src/bottom_pane/skills_toggle_view.rs`, and the
  runtime message `/skills scan reached its traversal limit (root: `.

The prompt-input observation is the load-bearing evidence; the rest is corroboration.

### 3b. Claude Code — confirmed from this session

This audit is running inside Claude Code `2.1.251`. The session's available-skills block
lists, verbatim:

```
- bullswarm: Use when the user invokes /bullswarm or $bullswarm, asks to delegate or offload
  a self-contained task, or wants Bullswarm to choose between one quota-routed agent and an
  autonomous multi-agent workflow. Classify first, show the decision and conceptual plan,
  then execute through the common delegate interface.
```

That string is the `description` frontmatter of the installed
`SKILL.md` (`name: bullswarm`), reached through `~/.claude/skills/bullswarm`. The awareness
block from `~/.claude/CLAUDE.md` is likewise present in this session's instruction context.
This is first-hand runtime observation of the running CLI, not documentation.

**Evidence gap:** Claude Code ships no local, readable document describing its skill
discovery order. `claude --help` mentions skills only obliquely — "Skills still resolve via
/skill-name" (line 45 of `--help` output), `--disable-slash-commands  Disable all skills`
(line 69), and `--safe-mode  Start with all customizations (CLAUDE.md, skills, plugins,
hooks, ...) disabled` (lines 194–198). There is no local file stating that
`~/.claude/skills/` is the user skill root or how ties are broken. The runtime observation
above stands on its own; the *documented rule* for Claude is unverified locally.

### 3c. Grok — confirmed, with documented discovery rules

`grok inspect` (read-only: "Show the configuration Grok discovers for this directory") lists
74 skills; line 24 of its output is:

```
  └ bullswarm                   user
```

`grok inspect --json` gives the source:

```json
{ "name": "bullswarm",
  "description": "Use when the user invokes /bullswarm or $bullswarm, ...",
  "source": { "type": "user", "path": "/Users/cowcow02/.grok/skills/bullswarm/SKILL.md" },
  "userInvocable": true }
```

Grok's local documentation, `~/.grok/docs/user-guide/08-skills.md`:

- lines 17–27 — discovery roots in priority order: `./.grok/skills/` (Local, Highest),
  `<repo_root>/.grok/skills/` (Repo, Medium), `~/.grok/skills/` (User, Lowest),
  `~/.claude/skills/` + `~/.claude/commands/` (User, Lowest, "Claude Code compatibility"),
  `./.claude/skills/` (Local/Repo, High), `~/.cursor/skills/` (User, Lowest),
  `./.cursor/skills/` (Local/Repo, High).
- line 29 — "Grok deduplicates skills by name -- a higher-priority location overrides a
  lower one. Grok also scans `.agents/skills/` (and `commands/`) at each tier (alongside
  `.grok/`)..."
- line 35 — "Grok scans the Claude and Cursor skill directories by default." Disable per
  vendor via `[compat.claude]` / `[compat.cursor]` in `~/.grok/config.toml` or
  `GROK_CLAUDE_SKILLS_ENABLED` / `GROK_CURSOR_SKILLS_ENABLED`.
- lines 170–180 — name collisions with built-ins keep **both** invocable, the skill under a
  scope-qualified name (`user:`, `local:`, `repo:`, plugin name); `grok inspect` tags these
  `[collides with /x → /scope:x]`.

`grok inspect` confirms the compat switches are on: under "Harness Compatibility", `cursor →
skills on (default)` and `claude → skills on (default)`; for `codex` only `sessions` is on.
Grok also loads the awareness file: its "Project Instructions (4)" list includes
`/Users/cowcow02/.grok/Agents.md (global, ~226 tokens)` and
`/Users/cowcow02/.claude/Claude.md (global, ~935 tokens) [claude]`.

## 4. Awareness blocks

| File | Marker lines | Block identical to canonical? |
| --- | --- | --- |
| `/Users/cowcow02/.claude/CLAUDE.md` | 14–28 | yes |
| `/Users/cowcow02/.codex/AGENTS.md` | 7–21 | yes |
| `/Users/cowcow02/.grok/AGENTS.md` | 1–15 | yes |

Checked by extracting each `<!-- bullswarm:begin v3 --> ... <!-- bullswarm:end -->` region
and comparing byte-for-byte: all three are identical to each other (905 bytes) and to the
string returned by `awarenessBlock()` from **both** `src/integrate.js` in this checkout
(`src/integrate.js:28–44`) and the `.local` install. So the block, unlike the skill body,
has not drifted.

Delivery to the model is confirmed for two of three:

- **Codex** — `codex debug prompt-input` item 3 (`role: user`) carries the header
  `# AGENTS.md instructions for /Users/cowcow02/Repo/bullswarm` and inside it the text of
  `~/.codex/AGENTS.md` lines 1–21, including the full `bullswarm:begin v3` block. Attribution
  is unambiguous: the repo's own `AGENTS.md` contains no `bullswarm:begin` marker
  (`grep -n "bullswarm" AGENTS.md` returns only prose matches), while `~/.codex/AGENTS.md`
  lines 7–21 match the injected text exactly, alongside its neighbours
  `@/Users/cowcow02/.codex/RTK.md` and the CircleCI paragraph.
- **Claude** — the block is present in this session's instruction context (its text appears
  under "## Bullswarm delegation"), sourced from `~/.claude/CLAUDE.md:14–28`.
- **Grok** — `grok inspect` lists `~/.grok/Agents.md` as a loaded global instruction file
  (~226 tokens, consistent with a 906-byte file that is the block plus a trailing newline),
  but no read-only Grok command dumps the assembled prompt, so the block's presence *in the
  model's context* is inferred from Grok's own instruction-loading report rather than
  observed directly.

`awarenessBlockPresent()` (`src/integrate.js:67–69`) reports `awareness: true` for all three
agents in every `integrate status` run above, including the ones that reported `conflict`.

## 5. Grok's duplicate-registration behaviour

Grok's documented rule (08-skills.md:29) is "deduplicates skills by name — a higher-priority
location overrides a lower one". Observed behaviour on this machine, from
`grok inspect --json` (74 registered skills):

- **19 skill names are registered more than once.** `status` appears **4 times**;
  `central-station`, `database`, `deploy`, `deployment`, `domain`, `environment`, `metrics`,
  `new`, `projects`, `railway-docs`, `service`, `templates`, `adversarial-review`, `cancel`,
  `rescue`, `result`, `setup` twice each; `review` three times.
- The clearest pair: name `status` registered from both
  `/Users/cowcow02/.claude/skills/railway-status/SKILL.md` (`"vendor": "claude"`) **and**
  `/Users/cowcow02/.cursor/skills/railway-status/SKILL.md` (`"vendor": "cursor"`), with
  identical descriptions. Both are in the *same* priority tier (User / Lowest per the docs
  table), and dedup did **not** collapse them. Only the Claude-sourced one carries
  `"collidesWith": "status", "invocableAs": "user:status"`; the Cursor-sourced twin carries
  no collision annotation at all, so the qualified-name escape hatch (08-skills.md:170–180)
  does not disambiguate the pair either.
- Source split across the 74: 33 `vendor: claude`, 13 `vendor: cursor`, 28 with no vendor
  (Grok-native roots, `bundled/`, or plugins).

**Bullswarm itself is registered exactly once**, from
`/Users/cowcow02/.grok/skills/bullswarm/SKILL.md`. No entry anywhere in the JSON has a
source path under `/Users/cowcow02/.claude/skills/bullswarm`, even though that symlink
exists and Claude-compat scanning is on. `circleci` behaves the same way (single entry from
`~/.grok/skills/circleci/SKILL.md`, despite copies under `~/.claude/skills/circleci` and
`~/.cursor/skills/circleci`), as do `composio-cli` and `orca-cli` (single entries resolved to
`~/.agents/skills/...`, which line 29 of the docs names as a Grok-native root scanned at
each tier).

**Practical consequence:** because `bullswarm integrate install` writes into
`~/.grok/skills/`, Grok picks up the native copy and the `~/.claude/skills/bullswarm` copy
never produces a second entry. An install that only touched `~/.claude/skills/` would sit in
the same equal-priority vendor tier as `~/.cursor/skills/`, which is exactly where the
observed duplicates live.

**Evidence gap — the mechanism is not determined.** Two explanations fit every observation
equally well: (a) Grok-native user roots (`~/.grok/skills`, `~/.agents/skills`) outrank the
vendor-compat user roots (`~/.claude`, `~/.cursor`) inside the "User / Lowest" tier, so the
native copy wins by name; or (b) Grok deduplicates by resolved real path — every
single-entry case here is a set of symlinks resolving to one directory, while the duplicated
`railway-*` pairs are two independent real directories. Distinguishing them would require
creating a same-name skill with different content in two roots, i.e. a write, which is out of
scope for this read-only audit. Hypothesis (b) is not what the documentation claims;
hypothesis (a) is not what the documentation's flat priority table shows. Reported as
unresolved rather than guessed.

## 6. Confirmed vs. gaps

**Confirmed by direct observation**

1. All three symlinks exist, resolve, and contain a valid `SKILL.md`.
2. Codex 0.151.0 puts `bullswarm` in its model-visible prompt from `~/.codex/skills`, through the symlink.
3. Claude Code 2.1.251 lists the `bullswarm` skill in this live session.
4. Grok 1.0.13 registers `bullswarm` once, from `~/.grok/skills/bullswarm/SKILL.md`, `userInvocable: true`.
5. The awareness block is present, current, and identical in all three instruction files; Codex's copy is verifiably in the delivered prompt.
6. `integrate status`'s `conflict`/exit 1 from this checkout is a copy-identity mismatch, not a missing install; the `.local` copy the links point at reports `ok: true` / exit 0.
7. The linked skill body is one hunk older than `HEAD` (missing the `--classify` guidance from `8908ef8`); the working tree carries a further uncommitted edit to that same paragraph, written by something other than this audit.
8. Grok registers 19 duplicate skill names, including a same-tier `claude`/`cursor` pair; Bullswarm is not among them.

**Gaps, explicitly not claimed**

1. No Bullswarm task was executed through any of the three CLIs — registration is proven, invocation is not.
2. Claude Code has no local document stating its skill-discovery roots or precedence; only runtime behaviour was observed.
3. Grok's awareness-block delivery into the model prompt is inferred from `grok inspect`'s instruction list, not from a rendered prompt.
4. The mechanism behind Grok's single Bullswarm entry (native-root precedence vs. real-path dedup) is undetermined; see §5.
5. Codex's `skip_host_skill_discovery` flag is quoted verbatim; what "host" enumerates is not established locally.
6. Behaviour was sampled with cwd `/Users/cowcow02/Repo/bullswarm` (plus one Codex run from `/tmp`, same result). Project-scoped roots (`./.grok/skills`, `./.claude/skills`) were not exercised in another repository.

## 7. Recommendations

1. **Make installation identity independent of the invoking checkout.** Change
   `skillLinkStatus()` and the `ok` calculation so a symlink is accepted when its
   resolved target is a valid Bullswarm skill directory, rather than only when
   `target === resolve(skillSource)`. At minimum, validate the target's
   `SKILL.md` and Bullswarm skill identity. This would make the current
   `.local/lib/node_modules/bullswarm/skill` target report as installed when the
   command is run from this checkout, instead of reporting `conflict` and exit 1.

2. **Give the installer an explicit repair path for an equivalent Bullswarm copy.**
   If the target is an equivalent Bullswarm installation, `integrate install` should
   either leave it in place with a clear `installed` result or offer an explicit
   `--repoint`/repair mode to replace the link with the selected source. It should
   not require manual deletion before the supported installer can repair a stale
   target. Preserve the existing refusal for a non-Bullswarm or user-owned path.

3. **Keep the three agent links on one current skill source.** After publishing or
   updating Bullswarm, repoint the three links to the intended current installation
   and rerun `bullswarm integrate status --json` from that same installation. The
   observed link target is the `.local` copy, while the checkout contains newer
   classifier guidance; this is the concrete source-drift that currently leaves all
   three CLIs loading an older skill body.

4. **Add a non-model integration check to release verification.** Exercise the
   read-only discovery surfaces used here: Codex `debug prompt-input`, Claude's
   skill-loaded session or equivalent inspection, and Grok `inspect --json`. Assert
   that each discovers `bullswarm` from the expected root and that the loaded
   `SKILL.md` matches the release artifact. Keep the test's conclusion limited to
   discovery/registration; proving that a model follows the skill requires an
   actual invocation and is a separate test.

5. **Document Grok's duplicate-name limitation and avoid relying on undocumented
   precedence.** Grok's docs promise name deduplication, but this machine still
   exposes same-tier Claude/Cursor duplicates, while Bullswarm appears once from
   `~/.grok/skills`. Keep installing the native Grok path, monitor duplicate-name
   output in `grok inspect --json`, and do not claim that resolved-path dedup or
   native-root precedence is the mechanism until a controlled write-based test can
   distinguish them.

## Appendix — commands run

All read-only. Nothing outside `docs/integration-audit-2026-08-31.md` was written; `/tmp`
files below are scratch capture only.

| Command | Fact taken from it |
| --- | --- |
| `node bin/bullswarm.js integrate status --json` | conflict ×3, awareness ×3, `skillSource` = checkout, exit 1 |
| `node ~/.local/lib/node_modules/bullswarm/bin/bullswarm.js integrate status` | `skill ✓; awareness ✓` ×3, exit 0 |
| `node ~/.nvm/versions/node/v22.17.0/lib/node_modules/bullswarm/bin/bullswarm.js integrate status` | conflict ×3, exit 1 |
| `ls -ld` / `readlink` / `readlink -f` on the three skill paths | symlink targets, all resolving, non-broken |
| `which -a bullswarm`, `npm root -g` | `.local` first on PATH; npm global prefix is the nvm one |
| `diff -r skill ~/.local/lib/node_modules/bullswarm/skill` | single hunk in the classifier paragraph (working-tree text) |
| `git show HEAD:skill/SKILL.md > /tmp/head-skill.md; diff /tmp/head-skill.md ~/.local/.../skill/SKILL.md` | same single hunk, HEAD lines 80–87 vs installed 80–82 |
| `git status --short`, `git diff --stat skill/SKILL.md` | six files modified by other activity; `skill/SKILL.md` `+7 −4` |
| `git log --oneline -3 -- skill/SKILL.md` | `8908ef8` is the commit the installed copy predates |
| `codex debug prompt-input` (cwd repo, and `/tmp`) | skill roots table, 39 skills, one `bullswarm` at `r0`, `~/.codex/AGENTS.md` block in item 3 |
| `codex features list` | `skill_search stable true`, `skip_host_skill_discovery under development false` |
| `codex --version`, `claude --version` | `codex-cli 0.151.0`, `2.1.251 (Claude Code)` |
| `grok inspect` header line, `ls -l ~/.grok/bin/grok` | `Version: 1.0.13 [unknown]`; binary `grok-1.0.13-macos-aarch64` |
| `grok inspect`, `grok inspect --json` | 74 skills, bullswarm source path, vendor tags, duplicate-name counts, Harness Compatibility, instruction files |
| `cat -n` of `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.grok/AGENTS.md` | marker line ranges 14–28 / 7–21 / 1–15 |
| Python byte-compare of the three blocks vs `awarenessBlock()` from both installs | identical, 905 bytes |
| `grep -n` in `~/.grok/docs/user-guide/08-skills.md`, `~/.grok/README.md:1572–1650` | documented roots, dedup rule, compat switches, collision handling |
| `strings ~/.codex/packages/standalone/current/bin/codex \| grep …` | `ext/skills/...` module paths, `$CODEX_HOME/skills` strings |
| `head` of `~/.codex/skills/.system/skill-creator/SKILL.md`, `.../skill-installer/SKILL.md` | documented user skill location for Codex |
| `claude --help \| grep -i skill` | only the three oblique mentions quoted in §3b |
