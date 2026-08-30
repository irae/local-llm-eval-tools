# Mendel model benchmark

This branch (`benchmark`) is the formal record of the issue-13 model bake-offs. It
never merges into `master`. It can be pushed to `irae/mendel` only. Redact private
data before each commit (see "Redaction").

## Two tests, independent artifacts

The branch holds two separate tests of the same task (issue 13: replace eight small
npm dependencies with native Node equivalents). They share the rubric (`RUBRIC.md`,
100 points, applied unchanged to both) but nothing else — each has its own prompt,
base commit, branch suffix, results files, and report. Never mix their rows, and
never compare a score across the two tests; a model compares only against its own
run of the same test.

|              | Blind run                              | Guided run                                           |
| ------------ | -------------------------------------- | ---------------------------------------------------- |
| Question     | Can the model discover the traps?      | How far does a structured plan lift it?              |
| Prompt       | `prompt-blind.txt` (terse)             | `prompt-guided.txt` (numbered plan, traps disclosed) |
| Base commit  | `182b07f`                              | `4679b5a`                                            |
| Run branches | `<model>-issue-13`                     | `<model>-issue-13-r2`                                |
| Worktrees    | `../mendel-bench-<model>`              | `../mendel-bench2-<model>`                           |
| Results      | `results.json` / `results.csv`         | `results-guided.json` / `results-guided.csv`         |
| Report       | `report.html` (`report-template.html`) | `report-guided.html` (`report-guided-template.html`) |
| Status       | complete (6 models, Aug 2026)          | active — all new runs go here                        |

The guided run exists because the blind run showed the weaker (and local) models
losing most of their points to discoverable traps. Its prompt is a detailed
step-by-step workflow that names the known pitfalls (the glob AsyncIterator trap,
the incomplete reference list, the tmp exit-hook regression, the chalk
`enableColor` contract, the `node:` prefix lint convention, the fixture file to
leave alone). With the traps disclosed, its scores measure instruction-following
more than trap discovery.

The guided base commit `4679b5a` is `182b07f` plus one fix master needed anyway:
the root declares `mendel-pipeline` as a workspace devDependency, so the hoisted
`node_modules/.bin/mendel` link resolves and the full-example karma test runs on a
fresh install instead of dying with `mendel: command not found`.

The guided prompt is frozen at v2.1. One haiku run (`…-issue-13-r2-p0`, tagged
`r2.0` in the results) predates the freeze; keep it as a variance data point, and
run every new model against the frozen prompt.

## How to run a new model

1. Make sure the harness for the model is installed and authenticated.
2. Run `./run-worker.sh <model> [harness] [bench]` for one model. The default
   harness is `pi`; use `claude` for Claude Code (subscription pressure can force
   the choice). The default bench is `guided`; pass `blind` only to extend the
   closed blind table. `./spawn-claude-workers.sh <model ...>` runs several Claude
   workers in parallel. Each worker:
    - Creates a sibling worktree at the bench's base commit.
    - Creates the bench's run branch for the model.
    - Runs a real `pnpm install` in the worktree.
    - Spawns `claude -p` with the bench's prompt and writes results to `runs/`
      (not versioned).
3. For other harnesses (pi, codex), start the harness in a worktree prepared the
   same way, paste the bench's prompt verbatim, and let it run to completion
   without help.
4. Rules that apply to every run:
    - Same base commit for all models of the same bench.
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

After scoring, update and commit on this branch — always the files of the bench the
run belongs to (blind: `results.json`/`results.csv`/`report.html`; guided:
`results-guided.json`/`results-guided.csv`/`report-guided.html`):

- the results `.json` — full structured results: per model, the harness, provider,
  scores per criterion, defects, telemetry (guided rows also carry
  `prompt_version`).
- the results `.csv` — flat one-row-per-model summary for spreadsheet use.
- the report `.html` — the self-contained HTML report. **Do not edit its tables by
  hand.** The report is data driven: `generate-report.mjs` reads the bench's
  results file and template (prose + `{{SCOREBOARD}}`/`{{MATRIX}}`/`{{COST}}`/`{{PLAN}}`
  placeholders) and writes the output paths given as arguments. Fix data in the
  results file, prose in the template, then regenerate:
  `node benchmark/generate-report.mjs benchmark/report.html docs/superpowers/issue13-model-bakeoff.html`
  for the blind report, or `node benchmark/generate-report.mjs --guided` for the
  guided one (default output `benchmark/report-guided.html`).
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

The sibling project `../choose-a-local-llm/` reads `results.json`/`results.csv`
and can read the `-guided` pair the same way. Keep the field names stable.

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
