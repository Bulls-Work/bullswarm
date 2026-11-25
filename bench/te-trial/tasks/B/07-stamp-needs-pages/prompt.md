`cp-sync stamp <folder>` writes a sync stamp even into a folder that is not a mirror. After a mistyped mirror path in a sync run, it created a stray folder and left a `meta.json` there with no error. That happened twice on 31 Oct.

What I expect: `stamp` refuses a folder that has no `pages/` directory. It exits with status 2, prints "not a mirror" on stderr and writes nothing, so it does not create the folder either. A real mirror, one that has `pages/`, is stamped as before, with `syncedAt` set to the current time.
