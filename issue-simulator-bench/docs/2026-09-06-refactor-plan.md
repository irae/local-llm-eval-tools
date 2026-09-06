# issue-simulator-bench refactor plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the runner, the scorer and the report generator read a task configuration, not Mendel; one command drives them; configuration comes from the command line, then files, then defaults; the moved tests stay green at every commit and new tests cover the run, the score and the report.

**Architecture:** `isb` is a bash dispatcher with sub-commands. `run-worker.sh` (bash) prepares the checkout and calls `run-pi-rpc.mjs` (node), which drives one `pi --mode rpc` session with the fixed nudge policy. `score.mjs` computes the generic evidence and runs the task's verification battery. `generate-report.mjs` renders the task's template. Everything target-specific lives in a task folder that the target repository commits on a dedicated branch, or that the user keeps under their config directory. Every output lives under the user's data directory.

**Tech stack:** bash, node (no dependencies), python3 for `loop-check.py` only. Tests: bash scripts with the fake pi and the real event fixtures, `unittest` for the loop check.

**Spec:** the "Design" section below. Policy text in `PLAN.md` is the source for the README until the README replaces it.

## Global constraints

- Write all prose in ASD-STE100 Simplified Technical English. No code comments; the file header comments that document usage stay and shrink to usage.
- The results row keeps every field name in `PLAN.md`, "results.json shape": `model`, `model_id`, `harness`, `harness_guessed`, `provider`, `local`, `serving`, `branch`, `base_commit`, `thinking`, `prompt_version`, `partial`, `end_reason`, `libraries_done`, `score_total`, `scores.*`, `defects`, `telemetry.*`, `cost_usd`, `cost_basis`. The completion unit field name comes from the task (`libraries_done` for Mendel).
- The meta file, the worker file and the evidence pack keep every field they have today. New fields may be added; none renamed.
- `run-pi-rpc.mjs` keeps its command line; new options are optional. Without `--task` it behaves as today, so `tests/test-run-pi-rpc.sh` stays green at every commit.
- Fixtures under `tests/fixtures/` never change. Verify with `sha256sum` against the manifest in the fixtures README after every task that touches `tests/`.
- Configuration precedence, every sub-command: command line, then the task's `defaults`, then `config.json`, then built-in defaults.
- Nothing target-specific ships in this repository. The Mendel task lives on a branch of the Mendel repository; this README describes it in prose.
- House rules stay in force and go into the README: sibling worktree first, never nested; no bare stash; one run per plan provider at a time; credit exhaustion is a pause, never a teardown; scoring judgment on a strong model; the task's `agents.md` is frozen, a new version is a new results epoch.
- No home paths, machine names or credentials in the tree or in test output that gets committed.
- Commit messages name the behavior, never a task number. Every commit ends with the two trailer lines the coordinator gives.

---

## Design

### Files after the refactor

```
issue-simulator-bench/
  README.md                    what it does, install, run, output, tests, example
  isb                          entry point (bash): run, score, report, loop-check, count, probe-plan, estimate-plan, config
  run-worker.sh                one run: checkout, pinned pi config, runner, loop verdict, artifacts
  run-pi-rpc.mjs               the pi RPC runner with the nudge policy
  score.mjs                    evidence pack: generic facts plus the task battery
  generate-report.mjs          report from a results file and the task template
  loop-check.py                repetition-loop verdict on a session or events log
  count-tool-calls.mjs         assistant messages, tool calls, peak context of a session log
  probe-plan.mjs               plan-window probe per provider
  estimate-plan-share.mjs      plan-share estimate from a results file
  tests/
    run.sh                     runs every test below
    test-run-pi-rpc.sh         moved; extended with the task nudge and the model budget
    test_loop_check.py         moved
    test-isb-run.sh            new: isb run on the tiny task in both modes and both config sources
    test-score.sh              new: isb score on a small repository
    test-report.sh             new: isb report on two real rows
    helpers/fake-pi            moved
    helpers/tiny-task/         a task folder in the layout below, for tests
    fixtures/                  moved, plus results-two-rows.json (decision B)
```

Deleted at the end, with `git rm`: `PLAN.md` (its policy goes to the README; its Mendel parts go to the Mendel branch, see Task 9), `RUBRIC.md`, `issue-13.md`, `prompt-guided.txt`, `prompt-blind.txt`, `report-template.html`, `report-guided-template.html`, `agents-global.md`, `.gitignore`, `docs/`. History keeps them; Task 9 reads them from history to build the Mendel task folder outside this repository.

### Task folder layout

The same layout in both places:

- Committed in the target repository, on a dedicated branch (Mendel: `llm-benchmark`), at the single root `.issue-simulator-bench/`. The branch holds the configuration and nothing else that the tool needs; runs start from `base_ref` on another branch or tag.
- Or under the user's config directory: `$XDG_CONFIG_HOME/issue-simulator-bench/tasks/<name>/` (default `~/.config/issue-simulator-bench/tasks/<name>/`).

```
.issue-simulator-bench/            or  ~/.config/issue-simulator-bench/tasks/<name>/
  task.json                        the manifest
  issue.md                         the problem statement
  prompts/<variant>.txt            one prompt per variant
  rubric.md                        the scoring rubric, read by the human or LLM scorer
  battery.mjs                      the verification battery, any command named in task.json
  agents.md                        the frozen global instructions for the model under test
  templates/<variant>.html         report template per variant
  cleanup.sh                       optional, runs before the checkout is removed
```

This is the shape common to benchmark harnesses: one manifest with the repository, the base commit and the problem statement (SWE-bench names them `repo`, `base_commit`, `problem_statement`), the prompts, and the tests that grade a solution (Terminal-Bench keeps them beside a `task.yaml`). The manifest keeps SWE-bench names where the meaning is the same.

`task.json` keys, all required unless marked:

- `name`: short id, used in data paths.
- `repo`: `{ "url": "<git url>", "path": "<local checkout, optional>" }`. When the task folder sits inside a checkout, `path` defaults to that checkout's root and `url` to its `origin`.
- `problem_statement`: file name, `issue.md`.
- `unit`: `{ "field": "libraries_done", "max": 8, "label": "libraries" }`. The completion unit; the results row keeps `field` as its key; the report reads `max` and `label`.
- `variants`: object from variant name to `{ "prompt", "version", "base_commit", "branch_suffix", "worktree_prefix", "template", "results" }`. `base_commit` is a tag, branch or sha. `results` is the results file name under the data directory (`results-guided.json`).
- `rubric`: file name.
- `battery`: a command run from the task folder with three arguments: worktree path, branch, base sha. It prints one JSON object; `score.mjs` merges its top-level keys into the evidence pack, battery keys win.
- `agents_file`: installed as `AGENTS.md` in the pinned pi config.
- `install`: command run in the checkout after it is created (`pnpm install`), optional.
- `done_check`: `{ "tasks_file": "TASKS.md" }`, optional; the runner treats unchecked `- [ ]` items in this file as unfinished work; without it only the git status counts.
- `model_nudge`: the model nudge text, optional; default is today's text.
- `cleanup`: file name, optional.
- `plan_providers`: object from model prefix to plan provider name, optional.
- `defaults`: object with any of `variant`, `mode`, `thinking`, `max_tooling`, `max_model`, `stall_min`, `wall_min`, `turn_min`, `reserve_tokens`, `keep_recent_tokens`, optional. `context_window` is not a task default: it depends on the model and the serving stack, so it comes from the command line or `config.json` per model.

### Settings and directories

`$XDG_CONFIG_HOME/issue-simulator-bench/config.json` (default `~/.config/issue-simulator-bench/config.json`), all keys optional: `task` (a task name under `tasks/` or a path), `data_dir`, `mode`, `thinking`, `max_tooling`, `max_model`, `stall_min`, `wall_min`, `turn_min`, `reserve_tokens`, `keep_recent_tokens`, and `models`: an object from model id to `{ "context_window", "thinking" }` for per-model values.

Data: `$XDG_DATA_HOME/issue-simulator-bench/<task name>/` (default `~/.local/share/issue-simulator-bench/<task name>/`), or `data_dir` from the settings, or `--data-dir`. Layout: `runs/` (meta, session, events, runner log, loop verdict, worker file, plan probes, install log, the pinned pi config while a run is alive), `artifacts/<slug>/` (the artifact pack), `clones/<slug>/` (clone mode, removed after the run unless kept), `evidence/`, `results/`, `reports/`. Nothing is written inside the tool folder or inside the target repository other than the run branch and its worktree.

Task resolution for every sub-command: `--task <dir>`; else `.issue-simulator-bench/` in the current directory's git root; else `config.json` `task`; else an error that names the three places.

`isb config` prints the resolved settings, the task folder and the data directory, so a user can see what a run would use.

### Run modes

`isb run <model> [--task <dir>] [--variant <name>] [--thinking <level>] [--mode worktree|clone] [--data-dir <dir>] [--keep] [--allow-bad-config] [--max-tooling N] [--max-model N] [--stall-min N] [--wall-min N] [--turn-min N] [--context-window N] [--reserve-tokens N] [--keep-recent-tokens N]`. The model is the one argument every run gives; the thinking level is required for pi and comes from the command line or the defaults chain.

The last three are the harness window parameters. They are run-time inputs, never fixed values of a task: the newest measurement sets them at run time (`choose-a-local-llm/docs/methodology/mendel.md`, "Window and budget"). The worker writes `--context-window` into the model's entry of the private `models.json` copy, and `--reserve-tokens` (default 8192) and `--keep-recent-tokens` (default: pi's own) into the private `settings.json`; the runner records all three in the meta as `harness_window`. The operator's own pi config is never edited.

- `worktree` (default when `repo.path` resolves): as today. A sibling worktree `<worktree_prefix><slug>` beside `repo.path`, branch `<slug><branch_suffix>` at `base_commit`. The branch and the worktree stay after the run; the owner can adopt the branch. `isb run --cleanup <slug>` removes the worktree later.
- `clone`: `git clone <url> clones/<slug>` under the data directory, `git checkout -b <branch> <base_commit>`. After the run the worker collects the artifact pack and removes the clone unless `--keep`.
- Both modes write the artifact pack to `artifacts/<slug>/`: `patches/` from `git format-patch <base>..HEAD`, `<slug>.bundle` from `git bundle create`, `diff.patch` for uncommitted changes, `status.txt`, `log.txt`. The pack is what a scorer needs when the checkout is gone.

The worker file `<slug>-worker.json` keeps `model`, `harness`, `bench` (the variant name), `thinking`, `plan_provider`, `branch`, `base_commit`, `start`, `end`, `pinned_env`, `loop_flag`, `loop_ratio`, `loop_kind`, and adds `task`, `mode`, `artifacts`.

### Runner

`run-pi-rpc.mjs` gains `--task <dir>`. With it, the unfinished-work check reads `done_check.tasks_file` and the model nudge text comes from `model_nudge`; the meta records `task`. Nothing else changes.

### Scorer

`isb score <branch> --session <file> --meta <file> [--worktree <dir>] [--task <dir>] [--data-dir <dir>] [--variant <name>]`. Generic evidence: `branch`, `base` (merge base with the variant's `base_commit`), `generated`, `commit_craft` (commits, files per commit, subjects, failed commits from the session), `session_habits`, `runner` (nudges and stops from the meta). Then it runs the task battery and merges its keys. Git commands run in `repo.path` when it resolves, else in the worktree. The evidence pack goes to `evidence/<branch>-evidence.json`.

The Mendel battery (built in Task 9 from today's `score.mjs`) returns `static_completeness`, `lockfile`, `root_devdeps`, `runtime_checks` and the target parts of `commit_craft` (`non_chore`, `multi_package`, `tasks_md_leak`), so the evidence pack of a Mendel run keeps today's keys.

### Report

`isb report [--variant <name>] [--task <dir>] [--data-dir <dir>] [<output.html> ...]`. Reads `results/<results file>` for the variant, the variant template from the task folder, `unit` from `task.json`. The completion cap is `min(score_total, 100 × done / unit.max)`; the score line prints `<done>/<max> done` with `unit.label`; `{{NAV}}` links the other variants' reports. The refusal on a `score_total` that disagrees with `scores.*` stays. Default output `reports/report-<variant>.html`.

### Tests

Functional tests through the real commands, fake pi on `PATH`, real fixtures, `XDG_CONFIG_HOME` and `XDG_DATA_HOME` pointed at temporary directories so no test touches the user's home:

- `test-run-pi-rpc.sh` (moved, extended): the five loop-stop blocks stay. New blocks: with `--task tests/helpers/tiny-task` and a `TASKS.md` with one unchecked item in the work repository, the healthy fixture ends with model nudges whose text is the task's `model_nudge`, and with `--max-model 1` the run ends `model_budget_exhausted`; without `--task` the nudge text is today's text.
- `test-isb-run.sh` (new): builds a tiny git repository in a temporary directory (one commit, tagged `base`). Blocks: without a thinking level anywhere `isb run` refuses; with `thinking` in `config.json` it runs; `--thinking` on the command line wins over the task `defaults` which win over `config.json` (`isb config` prints the resolved value); a parent directory with `AGENTS.md` makes the run refuse; the task is found from `.issue-simulator-bench/` inside the repository, from `--task`, and from `config.json`, and an unresolved task names the three places; clone mode with the healthy fixture writes the worker file with the listed fields, `end_reason` `complete` in the meta, the artifact pack with `log.txt`, `patches/`, `status.txt`, and removes the clone; `--keep` keeps it; worktree mode creates the branch and the sibling worktree and refuses a second run on the same branch; the loop verdict lands in the worker file; the pinned config directory is gone after the run; during the run its `settings.json` carries the given reserve and keep-recent values and its `models.json` carries the given context window for the model, and the meta records them as `harness_window`; nothing is written under the tool folder or the repository beyond the branch and the worktree.
- `test-score.sh` (new): a temporary repository with `base` and a branch of two commits; `isb score` with `session-healthy.jsonl` and a meta from a fake-pi run writes an evidence pack with the generic keys and the tiny battery's keys; a missing branch fails with a clear message.
- `test-report.sh` (new): `isb report` on `results-two-rows.json` renders a scoreboard with both models and the unit label; a copy with a wrong `score_total` is refused; the output has no `<script src`, no `<link`, no `@import`.
- `test_loop_check.py` (moved): unchanged.
- `tests/run.sh`: runs all of the above, exits non-zero when any fails.

### README outline

1. What it does: several models each implement one issue of a real repository through pi; the tool keeps the run honest (nudges, budgets, loop stop, evidence), scores from a battery plus a rubric, generates the report. The fixed nudge policy in one list.
2. Install: node, pi with the models configured (`contextWindow`, `maxTokens` rule), python3, git.
3. Run: the task folder layout and every `task.json` key; the two places a task can live; `config.json`; the precedence rule; `isb run` and its options; the two modes; the pinned environment; the data directory; the house rules.
4. Output: the run files, the artifact pack, the evidence pack, the results row (field list with the stable names), the report.
5. Tests: `bash issue-simulator-bench/tests/run.sh`; what the fake pi and the fixtures are.
6. Example: Mendel issue 13, eight small dependencies to replace, in prose: the `llm-benchmark` branch with `.issue-simulator-bench/`, the two variants and their base tags, the traps, the battery, the completion unit, the commands for one run, one score and one report, and how the owner's smoke gate can call `isb loop-check` and copy the pinned config layout without the tool's branch.

### Decisions for the owner

- A. The Mendel task folder does not ship here. Task 9 builds it from history into a scratch clone of Mendel, runs the Luna replay from there, and hands the owner a patch for the `llm-benchmark` branch.
- B. The report test needs a small results file. It copies two real rows from the extracted `results-guided.json` (from history), unchanged, with a README entry that names the commit and the models.
- C. `loop-check.py` stays Python. `isb loop-check <log>` wraps it, so `choose-a-local-llm`'s smoke can call it without this repository's internals.
- D. `mendel-smoke.sh` stays in `choose-a-local-llm`.
- E. Names: the tool folder `issue-simulator-bench`, the command `isb`, the in-repo root `.issue-simulator-bench/`, the config and data directories `issue-simulator-bench/` under XDG. One name everywhere.

---

## Tasks

### Task 1: the entry point, settings and the test runner

**Files:**
- Create: `issue-simulator-bench/isb` (executable bash): parses the sub-command; resolves `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `config.json`, the task folder and the data directory per the design; exports `ISB_TASK_DIR`, `ISB_DATA_DIR` and the resolved settings as `ISB_*` variables; forwards to `run-worker.sh`, `score.mjs`, `generate-report.mjs`, `loop-check.py`, `count-tool-calls.mjs`, `probe-plan.mjs`, `estimate-plan-share.mjs`; `isb config` prints the resolution; `isb` alone or `--help` prints the sub-commands and exits 2.
- Create: `issue-simulator-bench/tests/run.sh`.
- Test: `tests/test-isb-run.sh`, the resolution blocks only (task found in three ways, unresolved task error, precedence shown by `isb config`).

**Interfaces:**
- Produces: `./isb <sub-command> ...`; the `ISB_*` variables the worker reads: `ISB_TASK_DIR`, `ISB_DATA_DIR`, `ISB_VARIANT`, `ISB_MODE`, `ISB_THINKING`, `ISB_MAX_TOOLING`, `ISB_MAX_MODEL`, `ISB_STALL_MIN`, `ISB_WALL_MIN`, `ISB_TURN_MIN`, `ISB_CONTEXT_WINDOW`, `ISB_RESERVE_TOKENS`, `ISB_KEEP_RECENT_TOKENS`.

- [ ] Write the resolution test blocks. Run them; they fail.
- [ ] Write `isb` and `run.sh`. Run `bash tests/run.sh`; the moved tests and the resolution blocks pass.
- [ ] Commit: "One isb command that resolves its task and settings from the command line, files and defaults".

### Task 2: the tiny task for tests

**Files:**
- Create: `tests/helpers/tiny-task/task.json` (`name` `tiny`, `problem_statement` `issue.md`, `unit` `{ "field": "files_done", "max": 2, "label": "files" }`, one variant `plain` with `prompts/plain.txt`, `version` `v1`, `base_commit` `base`, `branch_suffix` `-tiny`, `worktree_prefix` `tiny-bench-`, `template` `templates/plain.html`, `results` `results-plain.json`; `rubric` `rubric.md`; `battery` `bash battery.sh`; `done_check.tasks_file` `TASKS.md`; `model_nudge` `Tiny task: continue.`; `agents_file` `agents.md`; `defaults` `{ "variant": "plain", "mode": "clone" }`).
- Create: `issue.md`, `prompts/plain.txt`, `rubric.md`, `agents.md` (three short lines), `battery.sh` (prints `{"tiny_battery": {"args": [...]}}`), `templates/plain.html` (a minimal page with the five placeholders and no external resource).

**Interfaces:**
- Produces: the task folder every test consumes; tests copy it into a temporary place and set `repo.path` or `repo.url` with `node -e`, because the repository is built at test time.

- [ ] Write the files. Commit: "A tiny task folder for the simulator tests".

### Task 3: the runner reads the task

**Files:**
- Modify: `run-pi-rpc.mjs` (args, `unfinishedWork`, `MODEL_MSG`, meta `task`).
- Test: `tests/test-run-pi-rpc.sh`, the new blocks.

- [ ] Write the new test blocks from the design. Run them; they fail because `--task` is unknown.
- [ ] Implement. Run `bash tests/run.sh`; every block passes. Verify the fixture checksums.
- [ ] Commit: "The runner takes its done check and nudge text from a task".

### Task 4: the worker runs a task in worktree or clone mode

**Files:**
- Modify: `run-worker.sh` (reads `ISB_*`, the task manifest with `node -e`, modes, data directory, artifact pack, plan provider map from the task, `--cleanup`).
- Test: `tests/test-isb-run.sh`, the run blocks.

- [ ] Write the run test blocks. Run them; they fail.
- [ ] Implement. The pinned config builder, the parent-directory scan, the loop verdict and the plan probes stay; the prompt, the base commit, the suffix, the prefix, the agents file, the install and cleanup commands come from the task; the data directory replaces `$REPO/scratchpad/benchmark/runs`.
- [ ] Run `bash tests/run.sh`. Commit: "The worker runs any task, in a sibling worktree or in a clone, and collects an artifact pack".

### Task 5: the scorer runs the task battery

**Files:**
- Modify: `score.mjs` (generic parts only; the Mendel constants and checks leave into a scratch file the coordinator keeps for Task 9: `docs/mendel-battery.mjs`, committed with this task and removed in Task 9).
- Test: `tests/test-score.sh` (new).

- [ ] Write the test blocks. Run them; they fail.
- [ ] Split `score.mjs`. Keep the printed summary lines.
- [ ] Run `bash tests/run.sh`. Commit: "The scorer computes generic evidence and runs the task's battery".

### Task 6: the report reads the task

**Files:**
- Modify: `generate-report.mjs`.
- Create: `tests/fixtures/results-two-rows.json` (decision B) and its README entry.
- Test: `tests/test-report.sh` (new).

- [ ] Copy two rows with `node -e` from the historic `results-guided.json` (`git log --all --format=%H -- issue-simulator-bench/results-guided.json | head -1`, then `git show <sha>:issue-simulator-bench/results-guided.json`) into the fixture; keep the objects unchanged.
- [ ] Write the test blocks. Run them; they fail.
- [ ] Implement. Run `bash tests/run.sh`. Commit: "The report renders any task's results with its own template and unit".

### Task 7: the Mendel files leave the tree

**Files:**
- Delete with `git rm`: `PLAN.md`, `RUBRIC.md`, `issue-13.md`, `prompt-guided.txt`, `prompt-blind.txt`, `report-template.html`, `report-guided-template.html`, `agents-global.md`, `.gitignore`.
- Modify: `estimate-plan-share.mjs` reads the results files from the data directory.

- [ ] Before the deletion, check that every rule in `PLAN.md` that the README needs is in the README draft of Task 8 (the coordinator keeps the draft beside the plan).
- [ ] Run `bash tests/run.sh`. Commit: "The Mendel task files leave the tool; a task branch of the target repository holds them".

### Task 8: README and root README line

**Files:**
- Create: `issue-simulator-bench/README.md` per the outline.
- Modify: `/home/irae/code/local-llm-eval-tools/README.md`: one line for this tool.

- [ ] Write the README. Run `bash tests/run.sh` once more. Verify the fixture checksums.
- [ ] Commit: "The issue simulator README".

### Task 9: the Mendel task folder and the Luna replay (proof, after review)

Outside this repository, in the scratch directory: clone `git@github.com:irae/mendel.git`, create branch `llm-benchmark` from `master`, build `.issue-simulator-bench/` from this repository's history (`git show` of the files deleted in Task 7 plus `docs/mendel-battery.mjs` from Task 5): `task.json` with the `guided` and `blind` variants (`prompts/guided.txt` v3.0 at `benchmark-guided-base`, suffix `-guided-v3-issue-13`, prefix `mendel-bench-guided-`; `prompts/blind.txt` v1.1 at `benchmark-blind-base`, suffix `-issue-13`, prefix `mendel-bench-`), `install` `pnpm install`, `done_check.tasks_file` `TASKS.md`, today's `model_nudge`, `battery` `node battery.mjs`, `plan_providers`, `unit` `libraries_done` 8 `libraries`; `README.md` with the Mendel parts of `PLAN.md`. Commit it there; do not push. Then `isb run gpt-5.6-luna --task <clone>/.issue-simulator-bench --variant guided --thinking low --mode clone`, `isb score`, and `isb report` with the historic results placed under `results/`. Report to the owner: the worker command, the telemetry fields of the meta, the evidence pack keys, the report diff against the historic `report-guided.html` (only the navigation may differ), and the path of the `llm-benchmark` patch. Delete `docs/` in this repository.
