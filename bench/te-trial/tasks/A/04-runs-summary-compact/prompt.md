`bullswarm workflow runs result <run> --summary` is meant to stay under the 4,096-byte summary budget, but on real runs callers receive more than that (5,208 bytes on one run, 4,563 on another). The summary is sized against compact JSON, yet the command prints it with two-space indentation, and the extra whitespace pushes it over the budget.

What I expect: `--summary` prints the summary as a single line of compact JSON followed by a newline, and the printed bytes match what the size check measured. `--json` on its own keeps printing the full envelope indented as today.
