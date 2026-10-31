The repository in the current directory is a small date-range library. Read `README.md`: it describes how every function in `src/ranges.js` is supposed to behave. Users have reported wrong results, so `src/ranges.js` contains several places where the code does not match that description.

Your job:

1. Review `src/ranges.js` against `README.md` and find every place where the behaviour is wrong. Do not stop at the first one; check each function, including edge cases such as one-day ranges, month and year boundaries, leap years, and input in any order.
2. Fix each problem in `src/ranges.js`. Keep the function names, the `{ start, end }` range shape and the exports as they are.
3. For each problem you fix, add a regression test under `tests/` that fails before your fix and passes after it. Use Node's built-in test runner (`node:test`) with `node:assert`.
4. Run `npm test` and make sure everything passes, including the tests that were already there.

Use only Node's standard library (no new packages). When you finish, list each defect you found, with the line it was on and what you changed.
