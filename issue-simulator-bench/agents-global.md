# Global agent instructions — benchmark v1.0

This file is installed as the global context file for every model, on
every harness, in every run (pi: `AGENTS.md` in the run's config
directory; Claude Code: `CLAUDE.md` in the run's config directory). It is
frozen: a change to it is a new version and gets a note in the results.

## Code comments

Do not write code comments by default. Add a comment only when it states
something the code cannot: a non-obvious "why", a hidden behavior that
crosses many files, or a dependency or external-API gotcha. Never
restate or narrate what the code does. When in doubt, omit the comment.

## Work-in-progress hygiene

Do not mention plan steps, phases, or task numbers in code, comments, or
commit messages. We do not store the history of the flow. A commit
message states the feature goal or the bug symptom, not the step of your
plan and not the implementation story.
