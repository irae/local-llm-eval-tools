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

|              | Blind run                              | Guided run                                             |
| ------------ | -------------------------------------- | ------------------------------------------------------ |
| Question     | Can the model discover the traps?      | How far does a structured plan lift it?                |
| Prompt       | `prompt-blind.txt` (terse)             | `prompt-guided.txt` (numbered plan, traps disclosed)   |
| Base commit  | `182b07f`                              | `23050bd` (tag `guided-v3-base`; v2.1 rows: `4679b5a`) |
| Run branches | `<model>-issue-13`                     | `<model>-guided-issue-13`                              |
| Worktrees    | `../mendel-bench-<model>`              | `../mendel-bench2-<model>`                             |
| Results      | `results.json` / `results.csv`         | `results-guided.json` / `results-guided.csv`           |
| Report       | `report.html` (`report-template.html`) | `report-guided.html` (`report-guided-template.html`)   |
| Status       | complete (6 models, Aug 2026)          | active — all new runs go here                          |

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

The guided prompt is now v3.0 (base `guided-v3-base`); the blind prompt is v1.1.
The five v2.1 guided rows (base `4679b5a`) are a closed set — do not add to them.
One result row per model per prompt version: a pre-freeze
haiku run exists only as branch `…-p0-guided-issue-13` and in git history, not in the
results files. Run every new model against the frozen prompt.

## How to run a new model

1. Make sure the harness for the model is installed and authenticated. For local
   models in pi, `~/.pi/agent/models.json` must give the model a truthful
   `contextWindow` (the server's real context) and `maxTokens`; without them
   auto-compaction cannot trigger at the right point and `length` stops cannot be
   classified. For OpenAI-compatible servers that end streams without
   `finish_reason` (mlx_lm.server did), set `compat.supportsFinishReason: false`.
2. Run `./run-worker.sh <model> [harness] [bench] <thinking>` for one model. The
   default harness is `pi`; use `claude` for Claude Code. The default bench is
   `guided`; pass `blind` only to extend the closed blind table. The thinking
   level is mandatory for pi runs — a level inherited from operator settings is
   not comparable and earlier runs silently ran at the operator's default.
   Each worker:
    - Creates a sibling worktree at the bench's base commit.
    - Creates the bench's run branch for the model.
    - Runs a real `pnpm install` in the worktree.
    - Starts the harness with the bench's prompt and writes its outputs to `runs/`.
3. **pi runs go through `run-pi-rpc.mjs`, never `pi -p`.** `pi -p` exits on the
   first `length` or `error` stop — a harness limitation a TUI user would simply
   type "continue" past. The runner keeps one `pi --mode rpc` session alive (same
   context throughout) and applies one fixed policy to every model:
    - **Tooling nudge — never scored.** The stop came from the harness or the
      server: stream error, premature `length` (below 80 % of the model's output
      budget), no events for `--stall-min` (default 10) minutes, a dead pi process
      (respawned on the same session file). Message: `Continue from where you
stopped.` Budget `--max-tooling` (default 10).
    - **Model nudge — scored.** The model stopped by itself (`stop`, or `length`
      at its real output budget) while TASKS.md still has `- [ ]` items or `git
status` is not clean. Message, always identical: `You are not done. Check
TASKS.md for unchecked items and \`git status\` for uncommitted work, then
      continue the workflow from where you stopped.`Budget`--max-model`
      (default 3).
    - Nothing reads the chat. The runner also forces auto-compaction and
      auto-retry on and records whether they took effect; `--wall-min` (default 300) is the hard stop.
    - **Config guard.** Before the first prompt the runner refuses (exit 3,
      `end_reason: bad_config`) when the model has no `contextWindow` or
      `maxTokens`, when `maxTokens` is not below `contextWindow`, when
      auto-compaction did not enable, or when a local server reports a smaller
      loaded context than pi's `contextWindow` (llama.cpp `/props`, LM Studio
      `/api/v0/models`; mlx_lm.server cannot be probed — recorded as unverified).
      `--allow-bad-config` starts anyway and marks the run non-comparable.
    - Outputs per run: `<slug>-meta.json` (nudges with causes, compactions,
      retries, warnings, session stats), `<slug>-session.jsonl` (raw pi session,
      home path redacted), `<slug>-session.html` (export), `<slug>-events.jsonl`
      and `<slug>-runner.log` (not versioned).
4. Rules that apply to every run:
    - Same base commit for all models of the same bench.
    - Real `pnpm install` before the run starts.
    - No human input during a run. If a run is cut short, mark it as partial.
    - **Pinned environment.** No operator personalization reaches a run.
      `run-worker.sh` builds a fresh config directory per run: for pi
      (`benchmark/.pi-agent`, via `PI_CODING_AGENT_DIR`) it holds only the
      model config, the auth files, a minimal settings.json, and
      `agents-global.md` as the global `AGENTS.md`; the runner also passes
      `--no-extensions --no-skills --no-prompt-templates`. For Claude Code
      (`benchmark/.claude-config`, via `CLAUDE_CONFIG_DIR`, with `--bare`) it
      holds only the credentials and `agents-global.md` as the global
      `CLAUDE.md`. The worker refuses to start when a parent directory of the
      worktree carries an `AGENTS.md`, `AGENTS.override.md`, or `CLAUDE.md`.
      The pi runner records the flags, the config dir, and every context file
      found on pi's search path in `<slug>-meta.json`.
    - **Pinned thinking level and sampling.** The thinking level comes from the
      command line, never from settings, and lands in the results row
      (`thinking`). The pi runner stores the full resolved model entry
      (sampling, compat, thinking map; secrets stripped) in
      `<slug>-meta.json`, plus the llama.cpp `/props` body where available.

## How to score a run

1. Run the full verification battery in `RUBRIC.md` against the branch. Never trust
   the model's own claims.
2. Apply the rubric unchanged. If you add a criterion, re-score every prior run.
3. Collect telemetry from the harness session log:
    - Claude Code: `runs/<model>-result.json` (cost, usage, session id) and the
      session transcript under `~/.claude/projects/`.
    - pi: `runs/<slug>-meta.json` and `runs/<slug>-session.jsonl` written by
      `run-pi-rpc.mjs`. Copy the nudge counts into `telemetry.nudges_tooling` and
      `telemetry.nudges_model`.
      After scoring, copy the log to `runs/<branch>-session.jsonl`, redact it (see
      "Redaction"), and list it in `runs/SESSIONS.md`. `runs/` is otherwise not
      versioned; the `.gitignore` allows the session logs and that index only.
      To find the log of an older run, match a candidate session against the row:
      each pi assistant message carries its own `model` and `usage`, so count the
      assistant messages of the run's model, count the `toolCall` blocks, and
      compare both against `telemetry`. Do not trust the directory name alone —
      runs made before the bench worktrees existed sit under
      `~/.pi/agent/sessions/--Users-irae-code-mendel--/`, next to unrelated work.

## Plan accounting

Runs on a flat subscription (Claude Max for Claude Code, ChatGPT Plus/Pro for pi's
`openai-codex/*` models, X/SuperGrok for pi's `xai/*` models) are costed by the
share of the plan's rate-limit windows they consume, measured, not estimated:

1. `run-worker.sh` calls `probe-plan.mjs <provider>` **before and after** the run
   and keeps both readings (`runs/<slug>-plan-before.json`, `-plan-after.json`).
   A failed probe before the run aborts it: without a baseline the run is not
   accountable.
2. **Isolation rule.** While a plan run is in flight, nothing else may draw on
   that plan — not the coordinator agent, not a browser session. Drive the
   benchmark from a different vendor's tool (a Claude run coordinated from Codex,
   a Codex run coordinated from Claude). The two probes make contamination
   visible; they cannot prevent it.
3. Start plan runs at a low reading of the 5 h window (`used_percent` well under
   50 %) so the run cannot hit the ceiling and stall mid-way.
4. Share and cost: `Δ5h = after.five_hour − before.five_hour` and
   `Δ7d = after.seven_day − before.seven_day` (percentage points, the windows do
   not reset inside a run shorter than 5 h — if one did, `reset_at` shows it and
   the run gets `w5h: reset during run`). The plan table shows `w5h`/`wweek` as
   these deltas and prices the run as `marginal = Δ7d % × monthly price × 7 / 30`.
5. What each provider exposes:
    - **anthropic** (Claude Code): `api.anthropic.com/api/oauth/usage` with the
      Claude Code OAuth token — `five_hour` and `seven_day` utilization. pi's own
      Anthropic login is _not_ on the plan (it bills extra usage per token), so
      pi+anthropic rows are metered, never plan.
    - **openai-codex**: `chatgpt.com/backend-api/wham/usage` with pi's Codex
      token — `plan_type`, `primary_window` (5 h) and `secondary_window` (7 d)
      `used_percent`.
    - **xai**: no usage endpoint accepts the OAuth token. Grok plan rows keep
      `w5h`/`wweek` as `not exposed` and are priced from their metered/OpenRouter
      token figure only.

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
    "thinking": "high",
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
        "truncation_pct": 6,
        "nudges_tooling": 0,
        "nudges_model": 0
    },
    "cost_usd": 7.76,
    "cost_basis": "metered|plan|local"
}
```

For local models, `local` is true and `serving` names the stack (`llama-server`,
`lmstudio`). `harness_guessed` is true when the harness comes from the pi provider
config, not from a run record. `thinking` is the pinned thinking level (`null`
for Claude Code runs and where no record exists). The per-criterion `scores` are
the single source of truth for the total: `generate-report.mjs` refuses to render
when a matrix cell's bold number or `score_total` disagrees with them. `results.csv` is the same data flattened: one row per
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

Keep the `<model>-issue-13` branch — it is the run's artifact. Push it to
`origin` when the run is scored (`git push origin <branch>`), together with the
run's session log in `runs/`, so anyone can inspect the raw data from any
machine. Policy change 2026-08-31: run branches were kept local before; push
them all.
