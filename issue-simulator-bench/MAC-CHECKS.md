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

## 3. Does Claude Code log in from the pinned config dir? (item 4)

`run-worker.sh` now runs Claude Code with `--bare` and
`CLAUDE_CONFIG_DIR=benchmark/.claude-config` (it copies
`~/.claude/.credentials.json` in). On macOS the OAuth token may live in
the Keychain instead of that file:

```bash
cd ~/code/mendel/benchmark && rm -rf .claude-config && mkdir .claude-config
[ -e ~/.claude/.credentials.json ] && cp ~/.claude/.credentials.json .claude-config/
cp agents-global.md .claude-config/CLAUDE.md
CLAUDE_CONFIG_DIR="$PWD/.claude-config" claude --bare -p 'reply with exactly: ok'
```

- Prints `ok`: done.
- Auth error: fix `build_claude_config_dir` in `run-worker.sh` so the
  pinned dir still authenticates (for example `claude setup-token` into
  the pinned dir, or another documented credential path). Keep the
  isolation: the pinned dir must not read `~/.claude/CLAUDE.md`,
  plugins, or hooks.

## 4. Does the parent-directory scan pass? (item 4)

`run-worker.sh` refuses to start when a parent directory of the
worktree holds `AGENTS.md`, `AGENTS.override.md`, or `CLAUDE.md`.
Worktrees are siblings of the repo (`~/code/`). Check the Mac:

```bash
ls ~/code/AGENTS.md ~/code/CLAUDE.md ~/AGENTS.md ~/CLAUDE.md 2>/dev/null
```

If any exists, move it away for benchmark runs (the abort message names
the file). This is intended behavior, not a bug.

## 5. Smoke the pinned pi environment (items 2-4 together)

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
