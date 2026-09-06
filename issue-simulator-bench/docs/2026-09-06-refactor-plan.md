# issue-simulator-bench refactor plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the runner, the scorer and the report generator read a task configuration that lives with the target repository, not Mendel; one command drives them; settings come from the command line, then files, then defaults; scoring is objective by default and a judge is an option; reports are data first; the moved tests stay green at every commit and new tests cover the run, the score and the report.

**Architecture:** `isb` is a bash dispatcher with sub-commands. `run-worker.sh` (bash) prepares the checkout and calls `run-pi-rpc.mjs` (node), which drives one `pi --mode rpc` session with the fixed nudge policy. `score.mjs` computes the generic evidence, runs the task's verification battery, and writes an objective results row; a judge's verdict can be merged in. `report.mjs` builds a UI-agnostic report model from one or many results files and renders it. Everything target-specific lives in a task folder that the target repository commits on a dedicated branch, or that the user keeps under their config directory. Every output lives under the user's data directory.

**Tech stack:** bash, node (no dependencies), python3 for `loop-check.py` only. Tests: bash scripts with the fake pi and the real event fixtures, `unittest` for the loop check.

**Spec:** the "Design" section below. Policy text in `PLAN.md` is the source for the README until the README replaces it.

## Global constraints

- Write all prose in ASD-STE100 Simplified Technical English. No code comments; the file header comments that document usage stay and shrink to usage.
- The results row keeps every field name in `PLAN.md`, "results.json shape": `model`, `model_id`, `harness`, `harness_guessed`, `provider`, `local`, `serving`, `branch`, `base_commit`, `thinking`, `prompt_version`, `partial`, `end_reason`, `libraries_done`, `score_total`, `scores.*`, `defects`, `telemetry.*`, `cost_usd`, `cost_basis`. The completion unit field name comes from the task (`libraries_done` for Mendel). New fields are added; none renamed.
- The meta file, the worker file and the evidence pack keep every field they have today. New fields may be added; none renamed.
- `run-pi-rpc.mjs` keeps its command line; new options are optional. Without `--task` it behaves as today, so `tests/test-run-pi-rpc.sh` stays green at every commit.
- Fixtures under `tests/fixtures/` never change. Verify with `sha256sum` against the manifest in the fixtures README after every task that touches `tests/`.
- Configuration precedence, every sub-command: command line, then the task's `defaults`, then `config.json`, then built-in defaults.
- Nothing target-specific ships in this repository: no prompt, no rubric, no agent instructions, no report prose. The Mendel task lives on a branch of the Mendel repository; this README describes it in prose.
- The Mendel report templates are not kept after the refactor; history keeps them. The tool ships one generic renderer.
- House rules stay in force and go into the README: sibling worktree first, never nested; no bare stash; one run per plan provider at a time; credit exhaustion is a pause, never a teardown; a judge, when used, runs on a strong model; the task's `agents.md` is frozen, a new version is a new results epoch.
- No home paths, machine names or credentials in the tree or in test output that gets committed.
- Commit messages name the behavior, never a task number. Every commit ends with the two trailer lines the coordinator gives.

---

## Design

### Files after the refactor

```
issue-simulator-bench/
  README.md                    what it does, install, run, output, tests, example, future goals and ideas
  isb                          entry point (bash): run, score, judge-pack, report, loop-check, count, probe-plan, estimate-plan, import-swebench, config, version
  run-worker.sh                one run: checkout, pinned pi config, runner, loop verdict, artifacts, predictions
  run-pi-rpc.mjs               the pi RPC runner with the nudge policy
  score.mjs                    evidence pack, objective results row, judge merge
  report.mjs                   report model from results files, renderers (json, csv, md, html)
  report-template.html         the one generic HTML page: styles and placeholders, no prose
  import-swebench.mjs          a task folder from one SWE-bench instance record
  loop-check.py                repetition-loop verdict on a session or events log
  count-tool-calls.mjs         assistant messages, tool calls, peak context of a session log
  probe-plan.mjs               plan-window probe per provider
  estimate-plan-share.mjs      plan-share estimate from results files
  tests/
    run.sh                     runs every test below
    test-run-pi-rpc.sh         moved; extended with the task nudge and the model budget
    test_loop_check.py         moved
    test-isb-run.sh            new: isb run on the tiny task, both modes, three config sources
    test-score.sh              new: isb score objective row, judge merge, battery contract
    test-report.sh             new: isb report on two real rows, single and folder scan
    test-import.sh             new: import-swebench on one instance record
    helpers/fake-pi            moved
    helpers/tiny-task/         a task folder in the layout below, for tests
    helpers/swebench-instance.json   one instance record in the SWE-bench field shape, written for the test
    fixtures/                  moved, plus results-two-rows.json (decision B)
```

Deleted at the end, with `git rm`: `PLAN.md`, `RUBRIC.md`, `issue-13.md`, `prompt-guided.txt`, `prompt-blind.txt`, `report-template.html` and `report-guided-template.html` (the Mendel ones; the new generic file takes the first name), `agents-global.md`, `generate-report.mjs`, `.gitignore`, `docs/`. History keeps them; Task 10 reads them from history to build the Mendel task folder outside this repository.

### Task folder layout

The same layout in both places:

- Committed in the target repository, on a dedicated branch (Mendel: `llm-benchmark`), at the single root `.issue-simulator-bench/`. The branch holds the configuration and nothing else that the tool needs; runs start from a base commit on another branch or tag.
- Or under the user's config directory: `$XDG_CONFIG_HOME/issue-simulator-bench/tasks/<name>/` (default `~/.config/issue-simulator-bench/tasks/<name>/`).

```
.issue-simulator-bench/            or  ~/.config/issue-simulator-bench/tasks/<name>/
  task.json                        the manifest, a SWE-bench instance record plus extensions
  issue.md                         the problem statement
  prompts/<variant>.txt            one prompt per variant
  rubric.md                        the rubric a judge reads, optional
  battery.mjs                      the verification battery, any command named in task.json
  agents.md                        the frozen global instructions for the model under test
  cleanup.sh                       optional, runs before the checkout is removed
```

### The manifest and SWE-bench

`task.json` is a superset of one SWE-bench instance record. The SWE-bench fields keep their names and meanings, so an instance can become a task and a task can be read by anyone who knows SWE-bench:

- `instance_id`: short id, used in data paths (SWE-bench: `owner__repo-NNNN`).
- `repo`: `owner/name` as in SWE-bench. The tool adds `repo_url` (optional, default `https://github.com/<repo>.git`) and `repo_path` (optional local checkout; when the task folder sits inside a checkout it defaults to that checkout's root).
- `base_commit`: tag, branch or sha the run starts from.
- `problem_statement`: the issue text. The tool accepts a file name (`issue.md`) or the text itself.
- `version`: the task version, a string; every results row records it as `prompt_version` together with the variant's own version.
- `FAIL_TO_PASS`, `PASS_TO_PASS`: lists of test ids, optional. The battery receives them; the default battery runs each list with `test_cmd` and reports which passed.
- `hints_text`, `created_at`, `patch`, `test_patch`, `environment_setup_commit`: optional, copied through, never read by the tool; `patch` is the gold patch and stays out of the model's reach.

Extensions, under the same object:

- `test_cmd`: command that runs one test id in the checkout, optional; used by the default battery for the two lists.
- `unit`: `{ "field": "libraries_done", "max": 8, "label": "libraries" }`; the completion unit, optional. Without it the unit is `resolved` alone.
- `variants`: object from variant name to `{ "prompt", "version", "base_commit", "branch_suffix", "worktree_prefix", "results" }`; `base_commit` and `version` override the top-level ones for that variant; one variant named `default` with `prompt` `prompts/default.txt` is the minimum. Blind and guided are Mendel's variants, not the tool's.
- `rubric`, `battery`, `agents_file`, `install`, `done_check`, `model_nudge`, `cleanup`, `plan_providers`, `defaults`: as before. `battery` runs from the task folder with the worktree path, the branch and the base sha, and prints one JSON object that `score.mjs` merges into the evidence pack, battery keys winning. `defaults` may hold `variant`, `mode`, `thinking`, `max_tooling`, `max_model`, `stall_min`, `wall_min`, `turn_min`, `reserve_tokens`, `keep_recent_tokens`; `context_window` is per model and comes from the command line or `config.json`.

`isb import-swebench <instance.json> [--to <dir>]` writes a task folder from one SWE-bench instance record: `task.json` with the record's fields, `issue.md` from `problem_statement`, `prompts/default.txt` that holds the problem statement, and a `battery.mjs` that runs the two lists with `test_cmd` (the user sets `test_cmd`; the tool cannot know the repository's test runner).

What a task loses if it is only a SWE-bench record: prompt variants and their versions, a graded unit, a rubric, the frozen agent instructions, the nudge and done-check settings, the install and cleanup commands. The superset keeps them.

### Settings and directories

`$XDG_CONFIG_HOME/issue-simulator-bench/config.json` (default `~/.config/issue-simulator-bench/config.json`), all keys optional: `task` (a task name under `tasks/` or a path), `data_dir`, `mode`, `thinking`, `max_tooling`, `max_model`, `stall_min`, `wall_min`, `turn_min`, `reserve_tokens`, `keep_recent_tokens`, and `models`: an object from model id to `{ "context_window", "thinking" }`.

Data: `$XDG_DATA_HOME/issue-simulator-bench/<instance_id>/` (default `~/.local/share/issue-simulator-bench/<instance_id>/`), or `data_dir` from the settings, or `--data-dir`. Layout: `runs/` (meta, session, events, runner log, loop verdict, worker file, plan probes, install log, the pinned pi config while a run is alive), `artifacts/<slug>/` (the artifact pack), `clones/<slug>/` (clone mode, removed after the run unless kept), `evidence/`, `results/`, `reports/`. Nothing is written inside the tool folder or inside the target repository other than the run branch and its worktree.

Task resolution for every sub-command: `--task <dir>`; else `.issue-simulator-bench/` in the current directory's git root; else `config.json` `task`; else an error that names the three places. `isb config` prints the resolved settings, the task folder and the data directory. `isb version` prints the tool version (`git describe --tags --always` of this repository, or the `version` file in a release); every meta file and results row records it as `tool_version`.

### Run modes

`isb run <model> [--task <dir>] [--variant <name>] [--thinking <level>] [--mode worktree|clone] [--data-dir <dir>] [--keep] [--allow-bad-config] [--max-tooling N] [--max-model N] [--stall-min N] [--wall-min N] [--turn-min N] [--context-window N] [--reserve-tokens N] [--keep-recent-tokens N]`. The model is the one argument every run gives; the thinking level is required for pi and comes from the command line or the defaults chain.

The last three are the harness window parameters. They are run-time inputs, never fixed values of a task: the newest measurement sets them at run time (`choose-a-local-llm/docs/methodology/mendel.md`, "Window and budget"). The worker writes `--context-window` into the model's entry of the private `models.json` copy, and `--reserve-tokens` (default 8192) and `--keep-recent-tokens` (default: pi's own) into the private `settings.json`; the runner records all three in the meta as `harness_window`. The operator's own pi config is never edited.

- `worktree` (default when `repo_path` resolves): as today. A sibling worktree `<worktree_prefix><slug>` beside `repo_path`, branch `<slug><branch_suffix>` at the base commit. The branch and the worktree stay after the run; the owner can adopt the branch. `isb run --cleanup <slug>` removes the worktree later.
- `clone`: `git clone <repo_url> clones/<slug>` under the data directory, `git checkout -b <branch> <base_commit>`. After the run the worker collects the artifact pack and removes the clone unless `--keep`.
- Both modes write the artifact pack to `artifacts/<slug>/`: `patches/` from `git format-patch <base>..HEAD`, `<slug>.bundle`, `diff.patch` for uncommitted changes, `status.txt`, `log.txt`, and `predictions.jsonl` with one line `{ "instance_id", "model_name_or_path", "model_patch" }` where `model_patch` is `git diff <base>..HEAD` plus the uncommitted diff: the SWE-bench exchange shape, so another judge can evaluate the same run.

The worker file `<slug>-worker.json` keeps `model`, `harness`, `bench` (the variant name), `thinking`, `plan_provider`, `branch`, `base_commit`, `start`, `end`, `pinned_env`, `loop_flag`, `loop_ratio`, `loop_kind`, and adds `task`, `mode`, `artifacts`, `tool_version`.

### Runner

`run-pi-rpc.mjs` gains `--task <dir>`. With it, the unfinished-work check reads `done_check.tasks_file` and the model nudge text comes from `model_nudge`; the meta records `task` and `tool_version`. Nothing else changes.

### Scoring: objective by default, judge as an option

`isb score <slug> [--task <dir>] [--data-dir <dir>] [--worktree <dir>] [--judge <verdict.json>]` reads the run's meta, session and worker files from `runs/`, and the checkout when it still exists (or the artifact pack when it does not).

1. Generic evidence: `branch`, `base`, `generated`, `commit_craft` (commits, files per commit, subjects, failed commits from the session), `session_habits`, `runner` (nudges, stops, loop verdict, harness window). Then the task battery runs and its keys merge in. The pack goes to `evidence/<slug>-evidence.json`.
2. The objective row: every results field that a script can fill. `resolved` (boolean: the battery reports `FAIL_TO_PASS` all passed and `PASS_TO_PASS` none broken, or, without lists, the battery's own `resolved` key), the unit count from the battery (`<unit.field>`, Mendel: static completeness gives `libraries_done`), `partial`, `end_reason`, `telemetry.*`, `cost_usd`, `cost_basis`, `harness`, `provider`, `local`, `serving`, `thinking`, `prompt_version`, `base_commit`, `tool_version`, and `scores.*` for the mechanical criteria the battery returns under `scores` (Mendel: completion, node_modules, lint, task_list, truncation, nudges). `score_total` is the sum of the scores present; `scored_by` is `battery`. The row is appended to `results/<results file>` of the variant, replacing an earlier row with the same slug and version, and the CSV is regenerated.
3. With `--judge <verdict.json>`: the file holds `scores` for the judged criteria, `defects`, and `notes` (an object of fixed sections: `summary`, `what_decided_it`, `defects`, `anomalies`). The scores merge into the row, `score_total` is recomputed, `scored_by` becomes `judge:<model>` from the file's `judge` field, and the notes go into the row under `notes`. No LLM is called by the tool.

`isb judge-pack <slug>` writes `evidence/<slug>-judge-pack.md`: the rubric, the evidence pack, the artifact log, and the session path, with the instruction that the judge must answer in the `verdict.json` shape. The owner's coordinator hands that to a strong model; the tool stays offline.

### Report: data first, one or many

`isb report [--task <dir>] [--data-dir <dir>] [--variant <name>] [--all] [--scan <dir>] [--format json|csv|md|html] [--out <file>]`.

- The report model is JSON: `{ "generated", "tool_version", "tasks": [ { "instance_id", "variant", "version", "unit", "rows": [ ...results rows with derived fields: capped score, rank, score line... ], "cost": [...], "plan": [...] } ] }`. `--format json` writes it; `csv` flattens the rows; `md` and `html` render it. The HTML uses `report-template.html`, one generic page with styles and placeholders, no task prose; a task adds prose through the judge notes, not through templates.
- Default: one task, one variant, one file at `reports/<instance_id>-<variant>.html`.
- `--all`: every variant of the task, one file each, cross-linked in a navigation block.
- `--scan <dir>`: every `results/*.json` under a data directory (or a checkout of a results branch), grouped by task and variant, one index page plus one page per group, all cross-linked. This is how `choose-a-local-llm` builds its overview.
- The refusal on a `score_total` that disagrees with `scores.*` stays; the completion cap uses `unit.max`; the score line prints `<done>/<max> <label>` and `resolved` when the task has lists.

### Tests

Functional tests through the real commands, fake pi on `PATH`, real fixtures, `XDG_CONFIG_HOME` and `XDG_DATA_HOME` pointed at temporary directories so no test touches the user's home:

- `test-run-pi-rpc.sh` (moved, extended): the five loop-stop blocks stay. New blocks: with `--task tests/helpers/tiny-task` and a `TASKS.md` with one unchecked item in the work repository, the healthy fixture ends with model nudges whose text is the task's `model_nudge`, and with `--max-model 1` the run ends `model_budget_exhausted`; without `--task` the nudge text is today's text.
- `test-isb-run.sh` (new): builds a tiny git repository in a temporary directory (one commit, tagged `base`). Blocks: without a thinking level anywhere `isb run` refuses; with `thinking` in `config.json` it runs; `--thinking` wins over the task `defaults` which win over `config.json` (`isb config` shows it); a parent directory with `AGENTS.md` makes the run refuse; the task is found from `.issue-simulator-bench/` inside the repository, from `--task`, and from `config.json`, and an unresolved task names the three places; clone mode with the healthy fixture writes the worker file with the listed fields, `end_reason` `complete` in the meta, the artifact pack with `log.txt`, `patches/`, `status.txt`, `predictions.jsonl` whose one line has the three keys and a `model_patch` that applies cleanly to the base with `git apply --check`, and removes the clone; `--keep` keeps it; worktree mode creates the branch and the sibling worktree and refuses a second run on the same branch; the loop verdict lands in the worker file; during the run the pinned config carries the given reserve, keep-recent and context window and the meta records `harness_window`; the pinned config directory is gone after the run; nothing is written under the tool folder or the repository beyond the branch and the worktree; the meta carries `tool_version`.
- `test-score.sh` (new): after a fake-pi run of the tiny task, `isb score <slug>` writes the evidence pack with the generic keys and the tiny battery's keys, appends an objective row with `scored_by` `battery`, `resolved` from the battery, the unit count, the telemetry fields, and `score_total` equal to the sum of the mechanical scores; a second `isb score` of the same slug replaces the row; `--judge` with a verdict file merges the judged scores and notes and sets `scored_by`; a verdict whose criteria clash with the battery's is refused; a missing run fails with a clear message.
- `test-report.sh` (new): `isb report --format json` on `results-two-rows.json` gives a model with two rows, ranks and capped scores; `html` renders both models and the unit label and has no `<script src`, no `<link`, no `@import`; `md` and `csv` render; `--scan` over a directory with two result files gives an index and two pages that link each other; a copy with a wrong `score_total` is refused.
- `test-import.sh` (new): `isb import-swebench` on the helper instance writes a task folder that `isb config` resolves, with `issue.md` equal to the problem statement, the default prompt, and a battery that reports the two lists.
- `test_loop_check.py` (moved): unchanged.
- `tests/run.sh`: runs all of the above, exits non-zero when any fails.

### README outline

1. What it does: several models each implement one issue of a real repository through pi; the tool keeps the run honest (nudges, budgets, loop stop, evidence), scores objectively from a battery and telemetry, takes a judge's verdict as an option, and generates reports from data. The fixed nudge policy in one list. Why the scoring is thorough: fewer runs per local model, so the rows must tell models apart.
2. Install: node, pi with the models configured (`contextWindow`, `maxTokens` rule), python3, git.
3. Run: the task folder layout, every `task.json` key with the SWE-bench fields marked, the two places a task can live, `config.json`, the precedence rule, `isb run` and its options, the two modes, the harness window inputs, the pinned environment, the data directory, the house rules, `import-swebench`.
4. Output: the run files, the artifact pack and `predictions.jsonl`, the evidence pack, every measurement in the results row and how each is computed (telemetry, objective scores, judge scores, cap, retries, invalid rows), the report model and the four formats, single, `--all`, `--scan`.
5. Tests: `bash issue-simulator-bench/tests/run.sh`; the fake pi and the fixtures.
6. Example: Mendel issue 13, eight small dependencies to replace, in prose: the `llm-benchmark` branch with `.issue-simulator-bench/`, the two variants and their base tags, the traps, the battery and its unit, the commands for one run, one score, one judge pack and one report, and how the owner's smoke gate calls `isb loop-check` and copies the pinned config layout.
7. Future goals and ideas: issues and tests stored in this repository; static outcome checks for known traps (the iterator trap of issue 13) so a judge is not needed for them; Docker images per task for full environment pinning; a full SWE-bench import over many instances.

### Decisions for the owner

- A. The Mendel task folder does not ship here. Task 10 builds it from history into a scratch clone of Mendel, runs the Luna replay from there, and hands the owner a patch for the `llm-benchmark` branch.
- B. The report test needs a small results file. It copies two real rows from the extracted `results-guided.json` (from history), unchanged, with a README entry that names the commit and the models.
- C. `loop-check.py` stays Python. `isb loop-check <log>` wraps it, so `choose-a-local-llm`'s smoke can call it without this repository's internals.
- D. `mendel-smoke.sh` stays in `choose-a-local-llm`.
- E. Names: the tool folder `issue-simulator-bench`, the command `isb`, the in-repo root `.issue-simulator-bench/`, the config and data directories `issue-simulator-bench/` under XDG.
- F. Judge off by default. `choose-a-local-llm` uses `--judge` with a verdict from a strong model.
- G. The Mendel HTML templates go; one generic template stays. `choose-a-local-llm` reads the report model JSON or the results files, not the HTML.

---

## Tasks

### Task 1: the entry point, settings, version and the test runner

**Files:**
- Create: `issue-simulator-bench/isb` (executable bash): parses the sub-command; resolves `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `config.json`, the task folder and the data directory per the design; exports `ISB_TASK_DIR`, `ISB_DATA_DIR`, `ISB_TOOL_VERSION` and the resolved settings as `ISB_*`; forwards to the scripts; `isb config` and `isb version` print; `isb` alone or `--help` prints the sub-commands and exits 2.
- Create: `issue-simulator-bench/tests/run.sh`.
- Test: `tests/test-isb-run.sh`, the resolution blocks (task found in three ways, unresolved task error, precedence shown by `isb config`, `isb version` prints a non-empty string).

**Interfaces:**
- Produces: `./isb <sub-command> ...`; the `ISB_*` variables: `ISB_TASK_DIR`, `ISB_DATA_DIR`, `ISB_TOOL_VERSION`, `ISB_VARIANT`, `ISB_MODE`, `ISB_THINKING`, `ISB_MAX_TOOLING`, `ISB_MAX_MODEL`, `ISB_STALL_MIN`, `ISB_WALL_MIN`, `ISB_TURN_MIN`, `ISB_CONTEXT_WINDOW`, `ISB_RESERVE_TOKENS`, `ISB_KEEP_RECENT_TOKENS`.

- [ ] Write the resolution test blocks. Run them; they fail.
- [ ] Write `isb` and `run.sh`. Run `bash tests/run.sh`; the moved tests and the resolution blocks pass.
- [ ] Commit: "One isb command that resolves its task and settings from the command line, files and defaults".

### Task 2: the tiny task for tests

**Files:**
- Create: `tests/helpers/tiny-task/task.json` (`instance_id` `tiny__repo-1`, `repo` `tiny/repo`, `base_commit` `base`, `problem_statement` `issue.md`, `version` `1`, `FAIL_TO_PASS` `["t_fix"]`, `PASS_TO_PASS` `["t_keep"]`, `test_cmd` `bash test.sh`, `unit` `{ "field": "files_done", "max": 2, "label": "files" }`, one variant `default` with `prompts/default.txt`, `version` `v1`, `branch_suffix` `-tiny`, `worktree_prefix` `tiny-bench-`, `results` `results-default.json`; `rubric` `rubric.md`; `battery` `bash battery.sh`; `done_check.tasks_file` `TASKS.md`; `model_nudge` `Tiny task: continue.`; `agents_file` `agents.md`; `defaults` `{ "variant": "default", "mode": "clone" }`).
- Create: `issue.md`, `prompts/default.txt`, `rubric.md`, `agents.md` (three short lines), `battery.sh` (prints `{"tiny_battery": {"args": [...]}, "resolved": true, "files_done": 2, "scores": {"completion": 10, "lint": 5}}`).

**Interfaces:**
- Produces: the task folder every test consumes; tests copy it into a temporary place and set `repo_path` or `repo_url` with `node -e`, because the repository is built at test time.

- [ ] Write the files. Commit: "A tiny task folder for the simulator tests".

### Task 3: the runner reads the task

**Files:**
- Modify: `run-pi-rpc.mjs` (args, `unfinishedWork`, `MODEL_MSG`, meta `task` and `tool_version`).
- Test: `tests/test-run-pi-rpc.sh`, the new blocks.

- [ ] Write the new test blocks from the design. Run them; they fail because `--task` is unknown.
- [ ] Implement. Run `bash tests/run.sh`; every block passes. Verify the fixture checksums.
- [ ] Commit: "The runner takes its done check and nudge text from a task".

### Task 4: the worker runs a task in worktree or clone mode

**Files:**
- Modify: `run-worker.sh` (reads `ISB_*`, the manifest with `node -e`, modes, data directory, harness window inputs, artifact pack with `predictions.jsonl`, plan provider map from the task, `--cleanup`).
- Test: `tests/test-isb-run.sh`, the run blocks.

- [ ] Write the run test blocks. Run them; they fail.
- [ ] Implement. The pinned config builder, the parent-directory scan, the loop verdict and the plan probes stay; the prompt, the base commit, the suffix, the prefix, the agents file, the install and cleanup commands come from the task; the data directory replaces `$REPO/scratchpad/benchmark/runs`.
- [ ] Run `bash tests/run.sh`. Commit: "The worker runs any task, in a sibling worktree or in a clone, and collects an artifact pack".

### Task 5: objective scoring and the judge merge

**Files:**
- Modify: `score.mjs` (generic parts, the objective row, the results file update, the judge merge; the Mendel constants and checks leave into `docs/mendel-battery.mjs`, committed with this task and removed in Task 10).
- Create: `judge-pack` as a mode of `score.mjs` (`--judge-pack`), reached by `isb judge-pack`.
- Test: `tests/test-score.sh` (new).

- [ ] Write the test blocks. Run them; they fail.
- [ ] Split `score.mjs`. Keep the printed summary lines.
- [ ] Run `bash tests/run.sh`. Commit: "The scorer writes an objective row from the battery and telemetry, and merges a judge's verdict on request".

### Task 6: the report model and its renderers

**Files:**
- Create: `report.mjs` and the generic `report-template.html` (after `git rm` of the two Mendel templates and `generate-report.mjs`; the completion cap, the sort, the cost and plan tables and the refusal move from `generate-report.mjs` into `report.mjs`).
- Create: `tests/fixtures/results-two-rows.json` (decision B) and its README entry.
- Test: `tests/test-report.sh` (new).

- [ ] Copy two rows with `node -e` from the historic `results-guided.json` (`git log --all --format=%H -- issue-simulator-bench/results-guided.json | head -1`, then `git show <sha>:issue-simulator-bench/results-guided.json`) into the fixture; keep the objects unchanged.
- [ ] Write the test blocks. Run them; they fail.
- [ ] Implement. Run `bash tests/run.sh`. Commit: "Reports come from a data model with json, csv, markdown and html renderers, for one variant, all variants or a whole data directory".

### Task 7: SWE-bench import

**Files:**
- Create: `import-swebench.mjs`, `tests/helpers/swebench-instance.json` (an instance record written for the test: `instance_id` `tiny__repo-1`, `repo` `tiny/repo`, `base_commit` `base`, `problem_statement` two lines, `version` `1`, `FAIL_TO_PASS`, `PASS_TO_PASS`).
- Test: `tests/test-import.sh` (new).

- [ ] Write the test blocks. Run them; they fail.
- [ ] Implement. Run `bash tests/run.sh`. Commit: "A task folder from one SWE-bench instance record".

### Task 8: the Mendel files leave the tree

**Files:**
- Delete with `git rm`: `PLAN.md`, `RUBRIC.md`, `issue-13.md`, `prompt-guided.txt`, `prompt-blind.txt`, `agents-global.md`, `.gitignore`.
- Modify: `estimate-plan-share.mjs` reads the results files from the data directory.

- [ ] Before the deletion, check that every rule in `PLAN.md` that the README needs is in the README draft of Task 9.
- [ ] Run `bash tests/run.sh`. Commit: "The Mendel task files leave the tool; a task branch of the target repository holds them".

### Task 9: README and root README line

**Files:**
- Create: `issue-simulator-bench/README.md` per the outline.
- Modify: `/home/irae/code/local-llm-eval-tools/README.md`: one line for this tool.

- [ ] Write the README. Run `bash tests/run.sh` once more. Verify the fixture checksums.
- [ ] Commit: "The issue simulator README".

### Task 10: the Mendel task folder and the Luna replay (proof, after review)

Outside this repository, in the scratch directory: clone `git@github.com:irae/mendel.git`, create branch `llm-benchmark` from `master`, build `.issue-simulator-bench/` from this repository's history (`git show` of the files deleted in Task 8 plus `docs/mendel-battery.mjs` from Task 5): `task.json` with `instance_id` `irae__mendel-13`, `repo` `irae/mendel`, the `guided` and `blind` variants (`prompts/guided.txt` v3.0 at `benchmark-guided-base`, suffix `-guided-v3-issue-13`, prefix `mendel-bench-guided-`; `prompts/blind.txt` v1.1 at `benchmark-blind-base`, suffix `-issue-13`, prefix `mendel-bench-`), `install` `pnpm install`, `done_check.tasks_file` `TASKS.md`, today's `model_nudge`, `battery` `node battery.mjs`, `plan_providers`, `unit` `libraries_done` 8 `libraries`; `README.md` with the Mendel parts of `PLAN.md`. Commit it there; do not push. Then `isb run gpt-5.6-luna --task <clone>/.issue-simulator-bench --variant guided --thinking low --mode clone`, `isb score <slug>`, `isb judge-pack <slug>`, and `isb report --all` with the historic results placed under `results/`. Report to the owner: the worker command, the telemetry fields of the meta, the evidence pack keys, the objective row, the report model for the historic rows (same rows, same capped scores and ranks as the historic HTML), and the path of the `llm-benchmark` patch. Delete `docs/` in this repository.
