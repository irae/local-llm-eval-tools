# issue-simulator-bench refactor plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the runner, the scorer and the report generator read a task folder, not Mendel; one command drives them; the moved tests stay green at every commit and new tests cover the run, the score and the report.

**Architecture:** `sim` is a bash dispatcher with sub-commands. `run-worker.sh` (bash) prepares the checkout and calls `run-pi-rpc.mjs` (node), which drives one `pi --mode rpc` session with the fixed nudge policy. `score.mjs` computes the generic evidence and runs the task's verification battery. `generate-report.mjs` renders the task's template. Everything target-specific lives in a task folder. Every output lives in an output directory outside the repositories.

**Tech stack:** bash, node (no dependencies), python3 for `loop-check.py` only. Tests: bash scripts with the fake pi and the real event fixtures, `unittest` for the loop check.

**Spec:** the "Design" section below. Policy text in `PLAN.md` is the source for the README until the README replaces it.

## Global constraints

- Write all prose in ASD-STE100 Simplified Technical English. No code comments; the file header comments that document usage stay and shrink to usage.
- The results row keeps every field name in `PLAN.md`, "results.json shape": `model`, `model_id`, `harness`, `harness_guessed`, `provider`, `local`, `serving`, `branch`, `base_commit`, `thinking`, `prompt_version`, `partial`, `end_reason`, `libraries_done`, `score_total`, `scores.*`, `defects`, `telemetry.*`, `cost_usd`, `cost_basis`. The completion unit field name comes from the task (`libraries_done` for Mendel).
- The meta file, the worker file and the evidence pack keep every field they have today. New fields may be added; none renamed.
- `run-pi-rpc.mjs` keeps its command line; new options are optional. Without `--task` it behaves as today, so `tests/test-run-pi-rpc.sh` stays green at every commit.
- Fixtures under `tests/fixtures/` never change. Verify with `sha256sum` against the manifest in the fixtures README after every task that touches `tests/`.
- House rules stay in force and go into the README: sibling worktree first, never nested; no bare stash; one run per plan provider at a time; credit exhaustion is a pause, never a teardown; scoring judgment on a strong model; `agents-global.md` of a task is frozen, a new version is a new results epoch.
- No home paths, machine names or credentials in the tree or in test output that gets committed.
- Commit messages name the behavior, never a task number. Every commit ends with the two trailer lines the coordinator gives.

---

## Design

### Files after the refactor

```
issue-simulator-bench/
  README.md                    what it does, install, run, output, tests, example
  sim                          entry point (bash): run, score, report, loop-check, count, probe-plan, estimate-plan
  run-worker.sh                one run: checkout, pinned pi config, runner, loop verdict, artifacts
  run-pi-rpc.mjs               the pi RPC runner with the nudge policy
  score.mjs                    evidence pack: generic facts plus the task battery
  generate-report.mjs          report from a results file and the task template
  loop-check.py                repetition-loop verdict on a session or events log
  count-tool-calls.mjs         assistant messages, tool calls, peak context of a session log
  probe-plan.mjs               plan-window probe per provider
  estimate-plan-share.mjs      plan-share estimate from a results file
  tasks/mendel-issue-13/       the reference task (decision A below)
    task.json
    README.md                  the Mendel-specific parts of today's PLAN.md
    issue.md                   today's issue-13.md
    prompt-guided.txt, prompt-blind.txt
    RUBRIC.md
    battery.mjs                static completeness, lockfile, root devDeps, trap A, prettier, eslint
    agents-global.md           frozen v1.0
    report-guided-template.html, report-template.html
    cleanup.sh                 kills processes of the checkout, removes node_modules links
  tests/
    run.sh                     runs every test below
    test-run-pi-rpc.sh         moved; extended with the task nudge and the model budget
    test_loop_check.py         moved
    test-sim-run.sh            new: sim run on a tiny task in both modes
    test-score.sh              new: sim score on a small repository
    test-report.sh             new: sim report on two real rows
    helpers/fake-pi            moved
    helpers/tiny-task/         a task folder for tests: task.json, issue.md, prompt.txt, battery.sh, template.html, agents-global.md
    fixtures/                  moved, plus results-two-rows.json (decision B)
```

Deleted at the end: `PLAN.md` (its policy goes to the README, its Mendel parts to the task README), `RUBRIC.md`, `issue-13.md`, the prompts, the templates and `agents-global.md` at the tool root (they move into the task folder with `git mv`), `.gitignore` (nothing is generated inside the tree any more), `docs/`.

### Task folder

`task.json` keys, all required unless marked:

- `name`: short id, used in output paths.
- `repo`: `{ "url": "<git url>", "path": "<local checkout, optional>" }`. `worktree` mode needs `path`; `clone` mode needs `url`.
- `issue`: file name of the issue text.
- `unit`: `{ "field": "libraries_done", "max": 8, "label": "libraries" }`. The completion unit; the results row keeps `field` as its key and the report reads `max` and `label`.
- `variants`: object from variant name to `{ "prompt", "version", "base_ref", "branch_suffix", "worktree_prefix", "template", "results" }`. `results` is the results file name inside the output directory (`results-guided.json`).
- `rubric`: file name.
- `battery`: a command run from the task folder with three arguments: worktree path, branch, base commit. It prints one JSON object. `score.mjs` merges its top-level keys into the evidence pack; battery keys win.
- `agents_file`: the frozen global instructions file installed as `AGENTS.md` in the pinned pi config.
- `install`: command run in the checkout after it is created (`pnpm install`), optional.
- `done_check`: `{ "tasks_file": "TASKS.md" }`; the runner treats unchecked `- [ ]` items in this file as unfinished work. Optional; without it only the git status counts.
- `model_nudge`: the model nudge text. Optional; default is today's text.
- `cleanup`: command run with the checkout path before it is removed, optional.
- `plan_providers`: object from model prefix to plan provider name, for `probe-plan.mjs` (`{ "openai-codex/": "openai-codex", "gpt-5.6-": "openai-codex", "xai/": "xai", "grok-": "xai" }`), optional.

### Output directory

`--out <dir>` on every sub-command, default `$SIM_OUT` or `~/.local/share/issue-simulator-bench/<task name>/`. Layout: `runs/<slug>-*` (meta, session, events, runner log, loop verdict, worker file, plan probes, install log), `runs/<slug>-artifacts/` (the artifact pack), `evidence/<branch>-evidence.json`, `results-<variant>.json`, `results-<variant>.csv`, `report-<variant>.html`. Nothing is written inside the tool folder or the target repository other than the run branch.

### Run modes

`sim run <task-dir> <model> <thinking> [--variant <name>] [--mode worktree|clone] [--out <dir>] [--keep] [--allow-bad-config]`.

- `worktree` (default when `repo.path` exists): as today. A sibling worktree `<worktree_prefix><slug>` beside `repo.path`, branch `<slug><branch_suffix>` at `base_ref`. The branch stays in the repository after the run; the owner can adopt it. The worktree stays until `sim run` is asked to remove it with a later `cleanup` call, as today.
- `clone`: `git clone --branch <base_ref> <url> <out>/clones/<slug>` (a tag or branch; then `git checkout -b <branch>`). The run happens there. After the run the worker collects the artifact pack and removes the clone unless `--keep`.
- Both modes write the artifact pack to `runs/<slug>-artifacts/`: `patches/` from `git format-patch <base>..HEAD`, `<slug>.bundle` from `git bundle create`, `diff.patch` for uncommitted changes, `status.txt`, `log.txt` (`git log --oneline <base>..HEAD`). The pack is what a scorer needs when the checkout is gone.

The worker file `<slug>-worker.json` keeps `model`, `harness`, `bench` (the variant name), `thinking`, `plan_provider`, `branch`, `base_commit`, `start`, `end`, `pinned_env`, `loop_flag`, `loop_ratio`, `loop_kind`, and adds `task`, `mode`, `artifacts`.

### Runner

`run-pi-rpc.mjs` gains `--task <dir>`. With it: the unfinished-work check reads `done_check.tasks_file` and the model nudge text comes from `model_nudge`. `--agent-dir` is not needed; the worker keeps `PI_CODING_AGENT_DIR`. Nothing else changes.

### Scorer

`sim score <task-dir> <branch> --session <file> --meta <file> [--worktree <dir>] [--out <dir>]`. Generic evidence: `branch`, `base` (merge base with the variant's `base_ref`, given with `--base-ref` or found from the branch suffix), `generated`, `commit_craft` (commits, files per commit, subjects, failed commits from the session), `session_habits`, `runner` (nudges and stops from the meta). Then it runs the task battery and merges its keys. `score.mjs` runs `git` in `repo.path` when given, else in the worktree.

The Mendel battery `battery.mjs` returns today's `static_completeness`, `lockfile`, `root_devdeps`, `runtime_checks` and the target parts of `commit_craft` (`non_chore`, `multi_package`, `tasks_md_leak`) so the evidence pack of a Mendel run has the same keys as today.

### Report

`sim report <task-dir> --variant <name> [--out <dir>] [<output.html> ...]`. Reads `results-<variant>.json` from the output directory, the variant template from the task folder, `unit` from `task.json`. The completion cap becomes `min(score_total, 100 × done / unit.max)`; the score line prints `<done>/<max> done` with `unit.label`; `{{NAV}}` links the other variants' reports. The refusal on a `score_total` that disagrees with `scores.*` stays.

### Tests

Functional tests through the real commands, fake pi on `PATH`, real fixtures:

- `test-run-pi-rpc.sh` (moved, extended): the five loop-stop blocks stay. New blocks: with `--task tests/helpers/tiny-task` and a `TASKS.md` with one unchecked item in the work repository, the healthy fixture ends with model nudges whose text is the task's `model_nudge`, and after `--max-model 1` the run ends `model_budget_exhausted`; without `--task` the nudge text is today's text.
- `test-sim-run.sh` (new): builds a tiny git repository in a temporary directory (one commit, tagged `base`), points the tiny task at it. Blocks: `sim run` without a thinking level refuses; `sim run` refuses when a parent directory carries `AGENTS.md`; clone mode with the healthy fixture writes the worker file with the listed fields, `end_reason` `complete` in the meta, the artifact pack with `log.txt`, `patches/`, `status.txt`, and removes the clone; `--keep` keeps the clone; worktree mode creates the branch and the sibling worktree and refuses a second run on the same branch; the loop verdict from the events fixture lands in the worker file; the pinned config directory is gone after the run and held only the agents file, the settings and the copied model files during it.
- `test-score.sh` (new): a temporary repository with `base` and a branch of two commits; `sim score` with `session-healthy.jsonl` and a meta from a fake-pi run writes an evidence pack with the generic keys and the tiny battery's keys; a missing branch fails with a clear message.
- `test-report.sh` (new): `sim report` on `results-two-rows.json` renders a scoreboard with both models and the unit label; a copy with a wrong `score_total` is refused; the output has no `<script src`, no `<link`, no `@import`.
- `test_loop_check.py` (moved): unchanged.
- `tests/run.sh`: runs all of the above, exits non-zero when any fails.

### README outline

1. What it does: several models each implement one issue of a real repository through pi; the tool keeps the run honest (nudges, budgets, loop stop, evidence), scores from a battery plus a rubric, generates the report. The fixed nudge policy in one list.
2. Install: node, pi with the models configured (`contextWindow`, `maxTokens` rule), python3, git.
3. Run: the task folder format (every `task.json` key), `sim run` and its options, the two modes, the pinned environment, the output directory, the house rules.
4. Output: the run files, the artifact pack, the evidence pack, the results row (field list with the stable names), the report.
5. Tests: `bash issue-simulator-bench/tests/run.sh`; what the fake pi and the fixtures are.
6. Example: Mendel issue 13, eight small dependencies to replace, in prose: the two variants, the traps, the battery, the completion unit, the commands for one run, one score and one report, and how the owner's smoke gate can use `sim loop-check` and the pinned config without the Mendel branch.

### Decisions for the owner

- A. The Mendel task folder ships in the repository as `tasks/mendel-issue-13/`. Reason: its files already came with their history, the replay proof needs it, and a tool with no complete task is hard to adopt. The README example still describes it in prose. Alternative: keep the folder out of the tree and hand it to `choose-a-local-llm`.
- B. The report test needs a small results file. It copies two real rows from the extracted `results-guided.json` (commit `1a0e8c6^`), unchanged, with a README entry that names the commit and the models. Alternative: a hand-written results file, which the fixture rule forbids.
- C. `loop-check.py` stays Python. The moved tests are Python; the runner already carries the same shape measure in JavaScript for the live stop.
- D. `mendel-smoke.sh` stays in `choose-a-local-llm`. The extracted tool gives it `sim loop-check` and the pinned config layout it needs.

---

## Tasks

### Task 1: the entry point and the test runner

**Files:**
- Create: `issue-simulator-bench/sim` (executable bash): parses the sub-command, forwards the rest to `run-worker.sh`, `score.mjs`, `generate-report.mjs`, `loop-check.py`, `count-tool-calls.mjs`, `probe-plan.mjs`, `estimate-plan-share.mjs`; `sim` alone or `sim --help` prints the sub-commands and exits 2.
- Create: `issue-simulator-bench/tests/run.sh` (runs `test-run-pi-rpc.sh`, `test_loop_check.py`, and every later test script).

**Interfaces:**
- Produces: `./sim <sub-command> ...`.

- [ ] Write `sim` and `run.sh`. Run `bash tests/run.sh`; the moved tests pass through it.
- [ ] Commit: "One sim command with sub-commands and one test runner".

### Task 2: the tiny task for tests

**Files:**
- Create: `tests/helpers/tiny-task/task.json` (`name` `tiny`, `unit` `{ "field": "files_done", "max": 2, "label": "files" }`, one variant `plain` with `prompt.txt`, `version` `v1`, `base_ref` `base`, `branch_suffix` `-tiny`, `worktree_prefix` `tiny-bench-`, `template` `template.html`, `results` `results-plain.json`; `battery` `bash battery.sh`; `done_check.tasks_file` `TASKS.md`; `model_nudge` `Tiny task: continue.`; `agents_file` `agents-global.md`).
- Create: `issue.md`, `prompt.txt`, `agents-global.md` (three short lines), `battery.sh` (prints `{"tiny_battery": {"args": [...]}}`), `template.html` (a minimal page with the five placeholders and no external resource).

**Interfaces:**
- Produces: the task folder every test consumes; `repo.path` and `repo.url` are set by each test with `sed` into a temporary copy, because the repository is built at test time.

- [ ] Write the files. Commit: "A tiny task folder for the simulator tests".

### Task 3: the runner reads the task

**Files:**
- Modify: `run-pi-rpc.mjs` (args, `unfinishedWork`, `MODEL_MSG`).
- Test: `tests/test-run-pi-rpc.sh`, the new blocks.

**Interfaces:**
- Produces: `--task <dir>` on the runner.

- [ ] Write the new test blocks from the design. Run them; they fail because `--task` is unknown.
- [ ] Implement: read `task.json` when `--task` is given, use `done_check.tasks_file` and `model_nudge`, record `task` in the meta.
- [ ] Run `bash tests/run.sh`; every block passes. Verify the fixture checksums.
- [ ] Commit: "The runner takes its done check and nudge text from a task".

### Task 4: the worker runs a task in worktree or clone mode

**Files:**
- Modify: `run-worker.sh` (arguments, task reading with `node -e`, modes, output directory, artifact pack, plan provider map from the task).
- Test: `tests/test-sim-run.sh` (new).

**Interfaces:**
- Consumes: `--task` from Task 3.
- Produces: `sim run` as in the design; the worker file fields; the artifact pack layout.

- [ ] Write the test blocks from the design. Run them; they fail.
- [ ] Implement the worker. The pinned config builder, the parent-directory scan, the loop verdict and the plan probes stay as they are; the prompt, the base ref, the suffix, the prefix, the agents file, the install and cleanup commands come from the task; the output directory replaces `$REPO/scratchpad/benchmark/runs`.
- [ ] Run `bash tests/run.sh`; every block passes.
- [ ] Commit: "The worker runs any task, in a sibling worktree or in a clone, and collects an artifact pack".

### Task 5: the scorer runs the task battery

**Files:**
- Modify: `score.mjs`.
- Create: `tasks/mendel-issue-13/battery.mjs` (the code that leaves `score.mjs`: `DEPS`, `FIXTURE`, static completeness, lockfile, root devDeps, trap A, prettier, eslint, the target parts of commit craft).
- Test: `tests/test-score.sh` (new).

**Interfaces:**
- Produces: `sim score` as in the design; the evidence pack keys.

- [ ] Write the test blocks. Run them; they fail.
- [ ] Split `score.mjs`; create `battery.mjs`. Keep the printed summary lines.
- [ ] Run `bash tests/run.sh`. Commit: "The scorer computes generic evidence and runs the task's battery".

### Task 6: the report reads the task

**Files:**
- Modify: `generate-report.mjs`.
- Create: `tests/fixtures/results-two-rows.json` (decision B) and its README entry.
- Test: `tests/test-report.sh` (new).

- [ ] Copy two rows with `node -e` from `git show 1a0e8c6^:issue-simulator-bench/results-guided.json` into the fixture; keep the objects unchanged.
- [ ] Write the test blocks. Run them; they fail.
- [ ] Implement: results from the output directory, template and unit from the task, variant navigation.
- [ ] Run `bash tests/run.sh`. Commit: "The report renders any task's results with its own template and unit".

### Task 7: the Mendel task folder

**Files:**
- Move with `git mv`: `issue-13.md` to `tasks/mendel-issue-13/issue.md`, `prompt-guided.txt`, `prompt-blind.txt`, `RUBRIC.md`, `agents-global.md`, both templates.
- Create: `tasks/mendel-issue-13/task.json` (repo url `https://github.com/irae/mendel.git`, no `repo.path`; the owner sets `repo.path` on the machine that runs worktree mode), `cleanup.sh` (today's `pkill -f` and `git worktree` steps from `PLAN.md` "Cleanup"), `README.md` (the Mendel parts of `PLAN.md`: the two tests, which models run which test, the prompt versions, the completion cap, invalid runs and retries, the score line, harness attribution, redaction).
- Modify: `estimate-plan-share.mjs` reads the results files from `--out <dir>` instead of its own folder.
- Delete: `.gitignore`.

- [ ] Write `task.json` with both variants (`guided`: `prompt-guided.txt`, `v3.0`, `benchmark-guided-base`, `-guided-v3-issue-13`, `mendel-bench-guided-`, `report-guided-template.html`, `results-guided.json`; `blind`: `prompt-blind.txt`, `v1.1`, `benchmark-blind-base`, `-issue-13`, `mendel-bench-`, `report-template.html`, `results.json`), `install` `pnpm install`, `done_check.tasks_file` `TASKS.md`, today's `model_nudge`, `battery` `node battery.mjs`, `plan_providers`.
- [ ] Prove the report path: with the historic `results-guided.json` and `results.json` from `git show 1a0e8c6^:...` placed in a temporary output directory, `sim report tasks/mendel-issue-13 --variant guided` produces a file that differs from the historic `report-guided.html` only in the navigation links. Paste the `diff` summary in the commit message body.
- [ ] Run `bash tests/run.sh`. Commit: "Mendel issue 13 as a task folder".

### Task 8: README and root README line

**Files:**
- Create: `issue-simulator-bench/README.md` per the outline; the policy text moves from `PLAN.md` with the wording kept where it is a rule.
- Modify: `/home/irae/code/local-llm-eval-tools/README.md`: one line for this tool.
- Delete: `PLAN.md`, `docs/`.

- [ ] Write the README. Run `bash tests/run.sh` once more. Verify the fixture checksums.
- [ ] Commit: "The simulator README".

### Task 9: the Luna replay (proof, after review)

Not a code task. `sim run tasks/mendel-issue-13 gpt-5.6-luna low --variant guided --mode clone --out <scratch>`, then `sim score` with the session and meta, unscored by any judge, then `sim report` with the historic results. Report to the owner: the worker command, the telemetry fields of the meta, the evidence pack keys, the report diff. The clone is removed; the artifact pack is kept in the scratch directory for the owner.
