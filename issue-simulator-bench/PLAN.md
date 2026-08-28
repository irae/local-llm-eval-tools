# Mendel model benchmark

This branch (`benchmark`) is the formal record of the issue-13 model bake-off. It never
merges into `master`. It can be pushed to `irae/mendel` only. Redact private data before
each commit (see "Redaction").

## What the benchmark measures

Each model gets one identical task, one identical prompt (`prompt.txt`), and one
identical starting commit (`182b07f`). The task is issue 13: replace eight small npm
dependencies with native Node equivalents. The issue contains known traps. The rubric
in `RUBRIC.md` scores each run on 100 points.

## How to run a new model

1. Make sure the harness for the model is installed and authenticated.
2. Run `./run-worker.sh <model> [harness]` for one model. The default harness is
   `pi`; use `claude` for Claude Code (subscription pressure can force the choice).
   `./spawn-claude-workers.sh <model ...>` runs several Claude workers in parallel.
   Each worker:
    - Creates a sibling worktree `../mendel-bench-<model>` at the base commit.
    - Creates the branch `<model>-issue-13`.
    - Runs a real `pnpm install` in the worktree.
    - Spawns `claude -p` with `prompt.txt` and writes results to `runs/` (not versioned).
3. For other harnesses (pi, codex), start the harness in a worktree prepared the same
   way, paste `prompt.txt` verbatim, and let it run to completion without help.
4. Rules that apply to every run:
    - Same base commit for all models.
    - Real `pnpm install` before the run starts.
    - No mid-run human help. If a run is cut short, mark it as partial.

## How to score a run

1. Run the full verification battery in `RUBRIC.md` against the branch. Never trust
   the model's own claims.
2. Apply the rubric unchanged. If you add a criterion, re-score every prior run.
3. Collect telemetry from the harness session log:
    - Claude Code: `runs/<model>-result.json` (cost, usage, session id) and the
      session transcript under `~/.claude/projects/`.
    - pi: session JSONL under `~/.pi/agent/sessions/`; use the `analyze-sessions` skill.

## Harness attribution

Each result row records the model and, as a sub-line, the harness — not only the
provider. Known mappings:

- Branches run in this repo before this branch existed used the **pi** harness.
- Local models in pi map through `~/.pi/agent/models.json`: provider `llama` is
  llama-server (llama.cpp), provider `lmstudio` is LM Studio.
- Runs from `spawn-claude-workers.sh` are **claude-code**.

When the harness is not recorded, guess from the pi provider config and mark the guess.

## Versioned outputs

After scoring, update and commit on this branch:

- `results.json` — full structured results: per model, the harness, provider, scores
  per criterion, defects, telemetry.
- `results.csv` — flat one-row-per-model summary for spreadsheet use.
- `report.html` — the self-contained HTML report. Zero external requests: no `<link>`,
  no `<script src>`, no `@import`, no web fonts. Light and dark theme via CSS custom
  properties.

The sibling project `../choose-a-local-llm/` reads `results.json` and `results.csv`.
Keep the field names stable.

### `results.json` shape

One object per run in a top-level `runs` array:

```json
{
    "model": "grok-4.6",
    "model_id": "grok-4.6",
    "harness": "pi",
    "harness_guessed": false,
    "provider": "xai",
    "local": false,
    "serving": null,
    "branch": "grok-4.6-issue-13",
    "base_commit": "182b07f",
    "partial": false,
    "score_total": 88,
    "scores": {
        "bugs": 25,
        "completion": 15,
        "node_modules": 8,
        "lint": 5,
        "commit_craft": 11.5,
        "first_time": 7,
        "test_discipline": 9,
        "conventions": 5,
        "task_list": 1,
        "truncation": 1.5
    },
    "defects": [{ "severity": "critical|medium|minor", "summary": "..." }],
    "telemetry": {
        "wall_clock_min": 19.7,
        "tokens_total": 11620000,
        "tokens_in": 266195,
        "tokens_out": 32603,
        "cache_read": 11324032,
        "peak_context": 259619,
        "window_pct": 52,
        "compactions": 0,
        "assistant_msgs": 113,
        "tool_calls": 188,
        "tool_errors": 16,
        "commits": 17,
        "failed_commits": 1,
        "truncation_pct": 6
    },
    "cost_usd": 7.76,
    "cost_basis": "metered|plan|local"
}
```

For local models, `local` is true and `serving` names the stack (`llama-server`,
`lmstudio`). `harness_guessed` is true when the harness comes from the pi provider
config, not from a run record. `results.csv` is the same data flattened: one row per
run, `scores.*` and `telemetry.*` as prefixed columns.

## Redaction

This branch can go to a public remote. Before each commit:

- No absolute home paths. Write paths relative to the repo root or with `~`.
- No API keys, tokens, or auth file contents.
- No email addresses other than git authorship.
- Session UUIDs and cost figures are allowed.

## Cleanup

Worker worktrees must be siblings (`../mendel-<name>`) or live under `/tmp/`. Never
nest them inside the repo — the filesystem watchers break. Test runs can leave
mendel processes behind; kill them before you remove the worktree:

```bash
pkill -f "$(cd ../mendel-bench-<model> && pwd)"
git worktree remove --force ../mendel-bench-<model>
git worktree prune
```

Keep the `<model>-issue-13` branch — it is the run's artifact.
