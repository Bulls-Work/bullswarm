The shared status cache (the file lock that lets many sessions share one status build) has three problems:

1. A lock file that is older than two minutes is treated as abandoned and broken, even when the process that holds it is still alive and building. A live holder must keep its lock, and a caller that finds it should serve the stale cached value instead of building again.
2. When a build finishes, the release removes the lock path even if another caller has broken our lock and taken the path in the meantime. A release must remove only a lock that this caller took.
3. A caller that waited for someone else's build and then gave up still runs its own build, but throws the result away. It should store what it built in the cache.
