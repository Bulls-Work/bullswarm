#!/usr/bin/env bash
# usage: check.sh <finished-repo-dir>
# Copies the hidden tests into <dir>/tests/hidden/, runs them (glob form: a bare directory arg fails on Node 22), prints "SCORE <passed>/<total>".
set -u
if [ $# -ne 1 ] || [ ! -d "$1" ]; then
  echo "usage: check.sh <repo-dir>" >&2
  exit 2
fi
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dir="$(cd "$1" && pwd)"
rm -rf "$dir/tests/hidden"
mkdir -p "$dir/tests/hidden"
cp "$here"/hidden/*.test.js "$dir/tests/hidden/"
out="$(cd "$dir" && env -u FORCE_COLOR -u NO_COLOR node --test "tests/hidden/*.test.js" 2>&1)"
passed="$(printf '%s\n' "$out" | sed -n 's/^# pass \([0-9][0-9]*\)$/\1/p' | tail -1)"
total="$(printf '%s\n' "$out" | sed -n 's/^# tests \([0-9][0-9]*\)$/\1/p' | tail -1)"
printf '%s\n' "$out" | grep -E '^(not ok|# (tests|pass|fail))' >&2
echo "SCORE ${passed:-0}/${total:-0}"
