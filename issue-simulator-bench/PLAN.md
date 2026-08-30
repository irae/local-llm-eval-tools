# Mendel model benchmark — round 2 (guided prompt)

This branch (`benchmark2`) is the formal record of round 2 of the issue-13 model
bake-off. It never merges into `master`. It can be pushed to `irae/mendel` only.
Redact private data before each commit (see "Redaction").

## What round 2 changes

Round 1 (branch `benchmark`) used a terse prompt and base commit `182b07f`. Round 2
asks one question: how much of the score gap was the prompt's fault? Everything else
stays fixed so the two rounds are comparable per model.

- **New prompt** (`prompt.txt`): a detailed step-by-step workflow that names the known
  pitfalls (the glob AsyncIterator trap, the incomplete reference list, the tmp
  exit-hook regression, the chalk `enableColor` contract, the `node:` prefix lint
  convention, the fixture file to leave alone). Round 1's terse prompt is preserved on
  the `benchmark` branch.
- **New base commit `4679b5a`** = `182b07f` plus one fix that master needed anyway:
  the root now declares `mendel-pipeline` as a workspace devDependency, so the hoisted
  `node_modules/.bin/mendel` link resolves and the full-example karma test runs on a
  fresh install instead of dying with `mendel: command not found`.
- **Run branches are `<model>-issue-13-r2`**, worktrees `../mendel-bench2-<model>`.
- **The rubric is unchanged** (`RUBRIC.md`). Because the prompt now discloses the
  traps, round-2 scores measure instruction-following more than trap discovery; never
  compare a round-2 score to a round-1 score of a different model, only to the same
  model's round-1 score.
- `results.json`/`results.csv` on this branch keep the round-1 rows as the baseline;
  round-2 rows are appended with the `-r2` branch name.

## What the benchmark measures

Each model gets one identical task, one identical prompt (`prompt.txt`), and one
identical starting commit (`4679b5a` in round 2). The task is issue 13: replace eight
small npm dependencies with native Node equivalents. The issue contains known traps.
The rubric in `RUBRIC.md` scores each run on 100 points.

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
- `report.html` — the self-contained HTML report. **Do not edit its tables by hand.**
  The report is data driven: `generate-report.mjs` reads `results.json` and
  `report-template.html` (prose + `{{SCOREBOARD}}`/`{{MATRIX}}`/`{{COST}}`/`{{PLAN}}`
  placeholders) and writes the output paths given as arguments. Fix data in
  `results.json`, prose in the template, then regenerate:
  `node benchmark/generate-report.mjs benchmark/report.html docs/superpowers/issue13-model-bakeoff.html`.
  The headline cost everywhere is the **cheapest OpenRouter route**; what was
  actually paid (metered, plan share, or plan estimate) sits under it. Zero external requests: no `<link>`,
  no `<script src>`, no `@import`, no web fonts. Light and dark theme via CSS custom
  properties.

Cost sources: for pi runs, use the cost that pi reports (recompute the tier math when
its price table is wrong). For Claude Code runs, read the token counts from the
session log and compute the cost from the published rates; the report shows that
computed figure, never an "n/a". The OpenRouter column is the cheapest route quote
for the same tokens; Anthropic models have no other route.

The report keeps two separate cost tables. The **per-run cost table** holds real
money only: the metered vendor rate and the cheapest OpenRouter quote. The **plan
table** amortises flat subscriptions (X Premium+, ChatGPT Plus, Claude Max) against
the share of the allowance the run consumed. Claude Code does not expose plan-window
usage, so Claude plan figures are estimates — state the assumption in the table lede.

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
