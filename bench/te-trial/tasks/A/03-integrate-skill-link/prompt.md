`bullswarm integrate status` reports a conflict for every agent on a machine where bullswarm was installed with `npm link`. The skill link is `~/.claude/skills/bullswarm`, which points to `~/.local/lib/node_modules/bullswarm/skill`, which is itself a symlink to `<repo>/skill`. Each agent does read the current skill, but status flags the link as wrong.

What I expect: a skill link that reaches the packaged skill directory through one or more further symlinks counts as installed, not as a conflict. A link that ends somewhere else must still be reported as a conflict.
