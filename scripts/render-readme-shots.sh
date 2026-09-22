#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
SOURCE=/tmp/bsw-demo-src
DEMO_USER_HOME=/tmp/bsw-demo-home/operator
HOME_DIR="$DEMO_USER_HOME/.bullswarm"
TEXT_DIR=/tmp/bsw-demo-shots
OUT_DIR="$ROOT/docs/public/screens"
SESSION=bsw-readme-shots
DENYLIST_DIR=${BULLSWARM_DENYLIST_DIR:?set BULLSWARM_DENYLIST_DIR to the directory containing private-tokens.txt and private-phrases.txt}
TOKEN_LIST="$DENYLIST_DIR/private-tokens.txt"
PHRASE_LIST="$DENYLIST_DIR/private-phrases.txt"
SOURCE_ID_LIST=/tmp/bsw-demo-source-ids.txt

for list in "$TOKEN_LIST" "$PHRASE_LIST"; do
  [[ -f "$list" ]] || { printf 'missing deny list: %s\n' "$list" >&2; exit 2; }
done

cleanup() {
  tmux kill-session -t "$SESSION" 2>/dev/null || true
  rm -rf "$SOURCE"
  rm -f "$SOURCE_ID_LIST"
}
trap cleanup EXIT

rm -rf "$SOURCE" "$HOME_DIR" "$TEXT_DIR"
mkdir -p "$TEXT_DIR" "$OUT_DIR"

# This is the sole call allowed to read the live Bullswarm home.
node "$ROOT/bin/bullswarm.js" home snapshot "$SOURCE" --recent 60 >/dev/null
printf 'snapshot created · 60 recent workflows\n'
node - "$SOURCE" "$SOURCE_ID_LIST" <<'NODE'
const fs = require('fs');
const path = require('path');
const [root, output] = process.argv.slice(2);
const pattern = /wf-[a-z0-9]{8}-[0-9a-f]{6}|(?<![a-z0-9-])[a-z0-9]{8}-[0-9a-f]{6}(?![a-z0-9-])|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{13}-[a-z0-9]{5}|(?<![a-z0-9])(?!\d+h\d+m(?![a-z0-9]))(?=[23456789abcdefghijkmnpqrstuvwxyz]{6}(?![a-z0-9]))(?=[23456789abcdefghijkmnpqrstuvwxyz]*\d)(?=[23456789abcdefghijkmnpqrstuvwxyz]*[a-z])[23456789abcdefghijkmnpqrstuvwxyz]{6}(?![a-z0-9])/gi;
const ids = new Set();
const pending = [root];
while (pending.length) {
  const current = pending.pop();
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const file = path.join(current, entry.name);
    if (entry.isDirectory()) pending.push(file);
    else if (entry.isFile()) {
      for (const match of `${path.relative(root, file)}\n${fs.readFileSync(file, 'utf8')}`.matchAll(pattern)) ids.add(match[0]);
    }
  }
}
fs.writeFileSync(output, `${[...ids].sort().join('\n')}\n`, { mode: 0o600 });
process.stdout.write(`source id tokens collected: ${ids.size}\n`);
NODE
node "$ROOT/scripts/build-demo-home.mjs" "$SOURCE" "$HOME_DIR" --seed 351 \
  --deny-list "$TOKEN_LIST" --deny-list "$PHRASE_LIST"
mkdir -p "$DEMO_USER_HOME"
node - "$DEMO_USER_HOME" <<'NODE'
const fs = require('fs');
const path = require('path');
const home = process.argv[2];
const profile = path.join(home, '.claude-team');
fs.mkdirSync(profile, { recursive: true });
fs.writeFileSync(path.join(profile, '.credentials.json'), `${JSON.stringify({
  claudeAiOauth: {
    accessToken: 'demo-token-never-used',
    expiresAt: Date.now() + 30 * 86_400_000,
    subscriptionType: 'team',
  },
})}\n`);
fs.writeFileSync(path.join(profile, '.claude.json'), `${JSON.stringify({
  oauthAccount: { accountUuid: '00000000-0000-4000-8000-000000000042' },
})}\n`);
NODE

assert_private_free() {
  node - "$TOKEN_LIST" "$PHRASE_LIST" "$@" <<'NODE'
const fs = require('fs');
const path = require('path');
const [tokenList, phraseList, ...roots] = process.argv.slice(2);
const denied = [tokenList, phraseList]
  .flatMap((file) => fs.readFileSync(file, 'utf8').split(/\r?\n/))
  .map((term) => term.trim()).filter(Boolean);
const matches = [];
for (const root of roots) {
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      const relative = path.relative(root, file);
      const nameHit = denied.find((term) => relative.toLowerCase().includes(term.toLowerCase()));
      if (nameHit) matches.push(`${relative} (filename)`);
      if (entry.isDirectory()) pending.push(file);
      else if (entry.isFile()) {
        const text = fs.readFileSync(file, 'utf8').toLowerCase();
        if (denied.some((term) => text.includes(term.toLowerCase()))) matches.push(relative);
      }
    }
  }
}
if (matches.length) {
  process.stderr.write(`private deny-list matches remain:\n${[...new Set(matches)].join('\n')}\n`);
  process.exit(1);
}
NODE
}

assert_source_ids_absent() {
  node - "$SOURCE_ID_LIST" "$@" <<'NODE'
const fs = require('fs');
const path = require('path');
const [list, ...roots] = process.argv.slice(2);
const ids = fs.readFileSync(list, 'utf8').split(/\r?\n/).filter(Boolean);
const sourceIds = new Set(ids);
const pattern = /wf-[a-z0-9]{8}-[0-9a-f]{6}|(?<![a-z0-9-])[a-z0-9]{8}-[0-9a-f]{6}(?![a-z0-9-])|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{13}-[a-z0-9]{5}|(?<![a-z0-9])(?!\d+h\d+m(?![a-z0-9]))(?=[23456789abcdefghijkmnpqrstuvwxyz]{6}(?![a-z0-9]))(?=[23456789abcdefghijkmnpqrstuvwxyz]*\d)(?=[23456789abcdefghijkmnpqrstuvwxyz]*[a-z])[23456789abcdefghijkmnpqrstuvwxyz]{6}(?![a-z0-9])/gi;
let matches = 0;
for (const root of roots) {
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else if (entry.isFile()) {
        const relative = path.relative(root, file);
        const text = `${relative}\n${fs.readFileSync(file, 'utf8')}`;
        for (const match of text.matchAll(pattern)) if (sourceIds.has(match[0])) matches += 1;
      }
    }
  }
}
process.stdout.write(`source id tokens checked: ${ids.length} · remaining matches: ${matches}\n`);
if (matches) process.exit(1);
NODE
}

# Privacy must be a property of the demo home before the dashboard reads it.
assert_private_free "$HOME_DIR"
assert_source_ids_absent "$HOME_DIR"
DEMO_RUN=$(node -e 'const fs=require("fs"); const rows=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").map(JSON.parse).reverse(); const row=rows.find(x=>x.status==="completed"&&!x.legacy&&x.requirements?.total>0); if(!row)process.exit(1); process.stdout.write(row.shortId)' "$HOME_DIR/history/runs.jsonl")

tmux new-session -d -s "$SESSION" -x 160 -y 60 \
  "cd '$ROOT' && HOME='$DEMO_USER_HOME' BULLSWARM_HOME='$HOME_DIR' node bin/bullswarm.js workflow tui"

wait_for() {
  local marker=$1 tries=0
  while ! tmux capture-pane -p -t "$SESSION" | grep -Fq -- "$marker"; do
    sleep 0.25
    tries=$((tries + 1))
    if (( tries >= 120 )); then
      printf 'dashboard did not render marker: %s\n' "$marker" >&2
      return 1
    fi
  done
}

capture() {
  local name=$1 cols=${2:-160} rows=${3:-48}
  tmux capture-pane -p -t "$SESSION" > "$TEXT_DIR/$name.txt"
  python3 "$ROOT/scripts/tui-shot.py" "$SESSION" "$OUT_DIR/$name.png" "$cols" "$rows"
}

wait_for 'Home · Today'
wait_for '91% used'
capture home 160 60
tmux resize-window -t "$SESSION" -x 160 -y 48
tmux send-keys -t "$SESSION" r
wait_for 'bullswarm · runs'
capture runs
tmux resize-window -t "$SESSION" -x 160 -y 56
tmux send-keys -t "$SESSION" b
wait_for 'Budget ·'
sleep 0.5
capture budget 160 56
tmux resize-window -t "$SESSION" -x 160 -y 48
tmux send-keys -t "$SESSION" s
wait_for 'Stats · spending'
capture stats

tmux resize-window -t "$SESSION" -x 55 -y 32
tmux send-keys -t "$SESSION" h
wait_for 'Home · Today'
capture home-phone 55 32

tmux kill-session -t "$SESSION"
tmux new-session -d -s "$SESSION" -x 160 -y 48 \
  "cd '$ROOT' && HOME='$DEMO_USER_HOME' BULLSWARM_HOME='$HOME_DIR' node bin/bullswarm.js workflow tui '$DEMO_RUN'"
wait_for '── plan'
capture run
tmux send-keys -t "$SESSION" Enter
wait_for '── activity'
capture step
tmux send-keys -t "$SESSION" Escape
wait_for '── plan'
tmux resize-window -t "$SESSION" -x 55 -y 48
wait_for '── plan'
capture run-phone 55 48

# This is an assertion only: captures are never rewritten after rasterization.
assert_private_free "$HOME_DIR" "$TEXT_DIR"
assert_source_ids_absent "$HOME_DIR" "$TEXT_DIR"

node - "$TOKEN_LIST" "$PHRASE_LIST" <<'NODE'
const fs = require('fs');
const count = (file) => fs.readFileSync(file, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).length;
process.stdout.write(`privacy deny terms checked: tokens ${count(process.argv[2])} · phrases ${count(process.argv[3])} · remaining matches: 0\n`);
NODE

printf 'text captures: %s\n' "$TEXT_DIR"
printf 'demo home: %s\n' "$HOME_DIR"
