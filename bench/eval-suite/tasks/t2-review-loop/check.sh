#!/usr/bin/env bash
# Usage: check.sh <finished-repo-dir>
# Copies the hidden tests into <dir>/tests/hidden/, runs them (Node 22 needs a glob, not the bare directory), prints "SCORE <passed>/<total>".
set -u
if [ $# -ne 1 ] || [ ! -d "$1" ]; then
  echo "usage: check.sh <repo-dir>" >&2
  echo "SCORE 0/0"
  exit 2
fi
kit="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$1" && pwd)"

mkdir -p "$repo/tests/hidden"
cp "$kit"/hidden/*.test.js "$repo/tests/hidden/"

cd "$repo" || exit 2
out="$(env -u FORCE_COLOR -u NO_COLOR node --test --test-reporter=tap 'tests/hidden/*.test.js' 2>&1)"
passed="$(printf '%s\n' "$out" | sed -n 's/^# pass \([0-9][0-9]*\)$/\1/p' | tail -1)"
total="$(printf '%s\n' "$out" | sed -n 's/^# tests \([0-9][0-9]*\)$/\1/p' | tail -1)"
printf '%s\n' "$out" | grep -E '^(not ok|ok) ' >&2
echo "SCORE ${passed:-0}/${total:-0}"
