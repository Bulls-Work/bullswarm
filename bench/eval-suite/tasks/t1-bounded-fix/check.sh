#!/bin/bash
# check.sh <finished repo dir>: run this task's hidden tests there; last line SCORE <passed>/<total>.
set -u
kit="$(cd "$(dirname "$0")" && pwd)"
dir="$1"
mkdir -p "$dir/tests/hidden"
cp "$kit"/hidden/*.test.js "$dir/tests/hidden/"
out="$(cd "$dir" && env -u FORCE_COLOR -u NO_COLOR node --test 'tests/hidden/*.test.js' 2>&1)"
pass=$(printf '%s\n' "$out" | sed -n 's/^# pass \([0-9]*\)$/\1/p' | tail -1)
fail=$(printf '%s\n' "$out" | sed -n 's/^# fail \([0-9]*\)$/\1/p' | tail -1)
echo "SCORE ${pass:-0}/$(( ${pass:-0} + ${fail:-0} ))"
