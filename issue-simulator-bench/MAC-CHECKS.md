# Checks to run on the Mac before the first new run

For the Fable agent on the benchmark box. Run these once, top to bottom,
before the next scored run. Fix what fails directly (self-fix is
approved) and commit the fix as `chore(benchmark)`. When every check is
done, **delete this file from git** (`git rm`, commit) — it is a
worksheet, not documentation.

## 1. Does mlx_lm.server send `finish_reason`? (fairness, item 2)

With any model loaded on `mlx_lm.server` (port 8081):

```bash
curl -sN http://127.0.0.1:8081/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"<loaded-model>","messages":[{"role":"user","content":"say hi"}],"stream":true,"max_tokens":20}' \
  | tail -6
```

- The last data chunk carries `"finish_reason":"stop"` (or `"length"`):
  remove `compat.supportsFinishReason: false` from the mlx provider in
  `~/.pi/agent/models.json`. PLAN.md already tells operators not to set
  it without this proof.
- No `finish_reason` anywhere: keep the flag. The runner now classifies
  fairly either way (empty stops and budget-level stops are not charged
  as model nudges by themselves).

## 2. Does the thinking level reach the model? (item 3)

With `mlx_lm.server` running and the Qwen3.8 entry configured:

1. Start one throwaway pi turn at `low`, one at `medium` (tiny prompt,
   not a scored run).
2. Compare what the server received (server log, or a proxy such as
   `mitmproxy`/`nc` in between): the two requests must differ in the
   reasoning field (`reasoning_effort`, `chat_template_kwargs`, or the
   template's thinking toggle).
3. If the requests are identical, the level never reaches the model —
   set the right `thinkingFormat` (or `compat` field) on the entry in
   `~/.pi/agent/models.json` (see pi `docs/models.md`, "Thinking Level
   Map" and `thinkingFormat`), and re-check. Until this passes, "low"
   and "medium" rows for mlx-served models are not distinct.

## 3. Does the parent-directory scan pass? (item 4)

`run-worker.sh` refuses to start when a parent directory of the
worktree holds `AGENTS.md`, `AGENTS.override.md`, or `CLAUDE.md`.
Worktrees are siblings of the repo (`~/code/`). Check the Mac:

```bash
ls ~/code/AGENTS.md ~/code/CLAUDE.md ~/AGENTS.md ~/CLAUDE.md 2>/dev/null
```

If any exists, move it away for benchmark runs (the abort message names
the file). This is intended behavior, not a bug.

## 4. Smoke the pinned pi environment (items 2-4 together)

One short unscored run:

```bash
cd ~/code/mendel/benchmark && ./run-worker.sh <local-model> pi guided low
```

Kill it after the first turn. Then check `runs/<slug>-meta.json`:
`warnings` is empty, `pi_flags` lists the three `--no-*` flags,
`agent_dir` points at `benchmark/.pi-agent`, `context_files` lists only
the pinned global `AGENTS.md` plus the worktree's own context files,
`thinking_level` is `low`, and `model_info` carries the full entry with
no `apiKey`. Delete the smoke branch and worktree afterwards.

## 5. Prefill speed vs the stall watchdog (item 11)

The stall watchdog aborts after 10 minutes with no events, and pi emits
no events during prefill. On llama.cpp the runner now asks `/slots`
first, so long prefills are safe there. `mlx_lm.server` and LM Studio
give no busy signal: measure the time to first token of one request at
about 80 k tokens of context on each stack. If it can pass 10 minutes,
raise `--stall-min` for those stacks and note the value in PLAN.md.

## 6. Respawn with a dangling tool call (item 12)

During the smoke run (check 4), `kill -9` the `pi` process while a tool
call is executing. The runner respawns on the same session file and
sends "Continue from where you stopped." Confirm pi resumes a session
whose last entry is an unanswered toolCall; if it refuses or errors,
report back — the runner then needs to append a synthetic error tool
result before the nudge.
