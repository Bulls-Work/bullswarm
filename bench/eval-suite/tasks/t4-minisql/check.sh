#!/usr/bin/env bash
# Usage: check.sh <finished-repo-dir>
# Copies the hidden tests into <dir>/tests/hidden/, runs them, prints "SCORE <passed>/<total>" as the last line.
set -u
if [ $# -ne 1 ] || [ ! -d "$1" ]; then
  echo "usage: check.sh <repo-dir>" >&2
  echo "SCORE 0/0"
  exit 2
fi
kit="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dir="$(cd "$1" && pwd)"
total=$(grep -hcE '^test\(' "$kit"/hidden/*.test.js | paste -sd+ - | bc)
rm -rf "$dir/tests/hidden"
mkdir -p "$dir/tests/hidden"
cp "$kit"/hidden/*.test.js "$dir/tests/hidden/"
out="$(mktemp)"
# Node 22 does not accept a bare directory for --test, so pass the files of tests/hidden/ explicitly.
(cd "$dir" && env -u FORCE_COLOR -u NO_COLOR node --test tests/hidden/*.test.js >"$out" 2>&1)
passed=$(grep -E '^# pass ' "$out" | awk '{print $3}')
passed=${passed:-0}
rm -f "$out"
echo "SCORE $passed/$total"
