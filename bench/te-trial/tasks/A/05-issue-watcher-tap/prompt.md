When the issue watcher (scripts/issue-watcher) writes a fix commit, the "tests:" line in the message is wrong. The first fix it made, PR #25, recorded "tests: ok 1 - connector adapters normalize semantic..." which is only the first passing test, not the result of the run.

What I expect: the commit message quotes the totals line of the TAP output, the one that reads `# tests N`. Only when the output has no totals line should it fall back to an `ok ...` line.
