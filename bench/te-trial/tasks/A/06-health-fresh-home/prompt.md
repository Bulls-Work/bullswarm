On a brand-new bullswarm home with an empty decision log, `bullswarm health` says UNHEALTHY and exits non-zero, although nothing is wrong yet. (This is issue #24.)

What I expect: a fresh home with no decisions logged, no gate failures and nothing quarantined reports healthy. `health --json` has `healthy: true` and exits 0. The text report says HEALTHY, shows "decision log: 0 entries" and has no "fix:" hint, since there is nothing to fix. Real problems must still be flagged on an empty log: two pools quarantined for auth, for instance, must still make health report unhealthy with exit code 1.
