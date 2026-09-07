# Agent instructions for this repository

## Where to write persistent data

Never write a run output, a server log, a fixture, or anything else
that must survive a reboot to `/tmp`. A model server sometimes needs a
reboot, and `/tmp` does not survive one. Data written only to `/tmp`
has been lost this way before.

Use these directories instead, the standard XDG layout:

- `~/.config/<tool>/` — configuration: task definitions, settings
  files.
- `~/.local/share/<tool>/` — data that must survive: run outputs,
  results, artifact packs, evidence.
- `~/.local/state/<tool>/` — logs: server logs, runner logs.

`<tool>` is the tool's own folder name in this repository, for example
`slow-context-creep` or `issue-simulator-bench`. Create the directory
with `mkdir -p` before writing to it; do not assume it exists.

`/tmp` is for files that only need to exist for the lifetime of one
command and that nothing reads back after a reboot: a named pipe, a
lock file, a scratch build artifact deleted before the command exits.
If a human or a later command will read the file again, it does not
belong in `/tmp`.

This rule binds every script, every README example, and every plan or
debugging note written in this repository.

## Other standing rules

- Write all prose (code comments where allowed, commit messages,
  READMEs, plans, agent reports) in ASD-STE100 Simplified Technical
  English: short sentences, active voice, one idea per sentence,
  simple words.
- No code comments by default. Add one only when the code cannot
  express something itself: a hidden behavior crossing many files, or
  a dependency or external-API gotcha. Never restate what the code
  does.
- Do not mention plan steps, phases, or task numbers in code, comments,
  or commit messages. A commit message states the behavior or the bug
  fixed, not the step of a plan.
- Never edit `../choose-a-local-llm`, `../mendel`, or
  `../mendel-benchmark`. They are separate repositories in use by live
  runs.
