# Feature slices (software)

**Reach for it when:** a software feature touches several parts of a codebase
and is too big for one agent in one sitting, but it breaks into behaviors that
can each be tested.

**Shape**

```
contract → slice-A ┐
         → slice-B ┴→ ship → review
```

**Steps**
- **contract** (optional)
  - Role: produce. Deliverable: files (shared types, an interface, a schema,
    or the event shape the slices share).
  - Evidence: a command, such as a type check.
- **slice-X**
  - Role: produce. Deliverable: files.
  - One whole behavior with its own tests, across whatever files it needs.
  - Evidence: its focused test command.
  - Give it its own worktree when slices overlap.
- **ship**
  - Role: combine. Deliverable: files and a commit or pull request.
  - It runs alone and joins what the slices left.
  - Evidence: the full suite, the build, any size budget, and the project's
    commit convention.
- **review**
  - Role: check. Deliverable: a report per requirement.
  - Route it wherever the caller wants.

**The caller decides:**
- where to cut the slices: by behavior, never half a behavior per step;
- whether the slices share a worktree or each get their own;
- which open gaps from the project record to carry;
- where to place the review;
- whether a person needs to try the result before the next run.

**What backs "done":**
- command: focused tests per slice, the full suite at ship;
- review: the requirement check.

**More than one provider:** helps with economy across slices, and with a
different viewpoint in the review if the caller routes it elsewhere.

**Pitfalls**
- **Cutting by file instead of behavior.** Each writer finishes half of
  something, and the joining step becomes the real author.
- **Docs written before the code settles.** They go stale. Put docs in or
  after ship.
- **A slice's tests that only exercise a fake.** A fake runner lets a real
  failure path pass. Include one test against the real path.
- **Checks that write into the tree**, such as a benchmark that overwrites a
  committed report.

**Neighbors:** batch-of-fixes (independent small changes) · build-try-fix (the
campaign around this run) · bulk-code-migration (the same change everywhere).
