# issue-simulator-bench

`issue-simulator-bench` runs several models, one at a time, against the same
real repository issue through [pi](https://github.com/badlogic/pi-mono), and
keeps every run honest and comparable:

- A fixed nudge policy stops a harness or server hiccup from ending a run
  early.
- A verification battery and session telemetry score every run objectively.
  No opinion is needed.
- A judge's verdict is an option, never a requirement.
- Reports come from one data model, rendered in four formats.

A local model gets far fewer runs than an API model, because each run costs
real time and, often, real money. With fewer runs per model, each run's row
must carry enough signal on its own to tell two close models apart. This is
why the scoring below is thorough.

## The nudge policy

`pi -p` (the one-shot mode) exits on the first `length` or `error` stop. A
person driving the interactive tool would just type "continue". This tool
keeps one RPC session alive instead, and applies the same two-nudge policy to
every model:

- **Tooling nudge** (never scored): the stop came from the harness or the
  server, not from the model — a stream error, a `length` stop far below the
  model's own output budget, a stall with no events, an aborted turn, a dead
  `pi` process. Message: "Continue from where you stopped." Budget:
  `--max-tooling` (default 10).
- **Model nudge** (scored): the model itself chose to stop (`stop`, or a real
  `length` stop at its own budget) while work is visibly unfinished — the
  done-check's tasks file still has unchecked items, or the tree has
  uncommitted changes. Message: the task's own `model_nudge` text when a task
  is given, else the tool's own default ("You are not done. Check TASKS.md
  for unchecked items and `git status` for uncommitted work, then continue
  the workflow from where you stopped."). Budget: `--max-model` (default 3).

Three timers end a run outright, regardless of nudges: a stall timer
(`--stall-min`, default 10 minutes with no event), a turn timer
(`--turn-min`, default 25 minutes for one model turn), and a wall-clock timer
(`--wall-min`, default 300 minutes total).

## Install

- `node` (no dependencies).
- `python3`, for `loop-check.py` only.
- `git`.
- `pi`, with every model under test configured in `~/.pi/agent/models.json`.
  Each entry needs a `contextWindow` and a `maxTokens` smaller than it.
  Without both, `isb run` refuses to start; `--allow-bad-config` overrides
  the refusal and marks the run as not comparable to the others.

## Run

### The task folder

Everything specific to one target — the prompt, the repository, the rubric,
the frozen agent instructions — lives in a task folder, never in this
repository. A task folder can live in either of two places:

- Committed in the target repository, on a dedicated branch, at the single
  root `.issue-simulator-bench/`. Runs start from a base commit on another
  branch or tag, so the task branch never needs to merge.
- Under the user's config directory:
  `$XDG_CONFIG_HOME/issue-simulator-bench/tasks/<name>/` (default
  `~/.config/issue-simulator-bench/tasks/<name>/`).

Layout, the same in both places:

```
.issue-simulator-bench/
  task.json              the manifest
  issue.md               the problem statement
  prompts/<variant>.txt  one prompt per variant
  rubric.md              the judge's rubric, optional
  battery.mjs            the verification battery
  agents.md              the frozen global instructions for the model
  cleanup.sh             optional, runs before the checkout is removed
```

### The manifest

`task.json` is a superset of one SWE-bench instance record: an instance can
become a task, and a task can be read by anyone who knows SWE-bench.

SWE-bench fields, kept with their SWE-bench names and meanings:

- `instance_id`: short id, used in data paths.
- `repo`: `owner/name`. The tool derives `repo_url`
  (`https://github.com/<repo>.git`) when the task does not set one.
- `base_commit`: tag, branch, or sha the run starts from.
- `problem_statement`: a file name (`issue.md`) or the issue text itself.
- `version`: the task's version string. A results row actually records a
  variant's own `version` as `prompt_version`, so two variants of one task
  can carry different values.
- `FAIL_TO_PASS`, `PASS_TO_PASS`: lists of test ids, optional. The default
  battery runs each with `test_cmd` and reports which passed.
- `hints_text`, `created_at`, `patch`, `test_patch`,
  `environment_setup_commit`: optional, copied through, never read by the
  tool. `patch` is the gold patch and stays out of the model's reach.

Extensions the tool adds, under the same object:

- `repo_url`, `repo_path`: `repo_path` is a local checkout; when the task
  folder sits inside a checkout, it defaults to that checkout's root.
- `test_cmd`: the command that runs one test id, used by the default battery
  for the two lists.
- `unit`: `{ "field", "max", "label" }`, the completion unit, optional.
  Without it, the run's only unit is `resolved`.
- `variants`: an object from variant name to `{ "prompt", "version",
  "base_commit", "branch_suffix", "worktree_prefix", "results", "rubric" }`.
  `base_commit`, `version`, and `rubric` override the top-level ones for that
  variant. One variant named `default` with `prompt`
  `prompts/default.txt` is the minimum.
- `battery`: the command that runs the verification battery, from the task
  folder, with the worktree path, the branch, and the base sha as arguments.
  It prints one JSON object that `isb score` merges into the evidence pack,
  battery keys winning on a clash.
- `agents_file`, `install`, `cleanup`, `done_check`, `model_nudge`,
  `plan_providers`: the frozen agent instructions file, the install command,
  an optional cleanup script, the done-check tasks file, the model-nudge
  text, and a map from model-name prefix to a subscription-plan provider.
- `defaults`: settings for this task — `variant`, `mode`, `thinking`,
  `max_tooling`, `max_model`, `stall_min`, `wall_min`, `turn_min`,
  `reserve_tokens`, `keep_recent_tokens`. `context_window` is never a task
  default: it is a run-time input (see "The harness window" below).
- `rubric`: a path to the judge's rubric file, read only by `isb judge-pack`,
  never by `isb score`'s objective pass. A task's top-level `rubric` is its
  default; `variants.<name>.rubric` overrides it for that variant. The path
  may point outside the task folder, so several tasks that judge the same
  way can share one file.

`isb import-swebench <instance.json> [--to <dir>]` builds a task folder
(default `./<instance_id>`) from one SWE-bench instance record: `task.json`,
`issue.md`, `prompts/default.txt`, `agents.md`, `battery.mjs`, and
`rubric.md`. A task built this way has no prompt variants, no graded unit, no
judge rubric beyond a stub, no frozen agent instructions beyond a stub, and
no nudge, install, or cleanup settings — the full task folder format keeps
all of those; the import only gets you started.

### Settings

`$XDG_CONFIG_HOME/issue-simulator-bench/config.json` (default
`~/.config/issue-simulator-bench/config.json`), every key optional: `task`
(a task name under `tasks/`, or a path), `data_dir`, and one key per setting
— `variant`, `mode`, `thinking`, `max_tooling`, `max_model`, `stall_min`,
`wall_min`, `turn_min`, `context_window`, `reserve_tokens`,
`keep_recent_tokens`, `server_log`.

Every setting resolves the same way, for every sub-command: the command
line, then the task's `defaults`, then `config.json`, then a built-in
default (only `reserve_tokens` has one: 8192). `server_log` is the one
exception: it resolves from the command line, then `config.json`, and never
from a task's `defaults` — see "The server log of a local model" below.

Task resolution, for every sub-command: `--task <dir>`; else
`.issue-simulator-bench/` at the git root of the current directory; else
`config.json`'s `task` key; else an error naming all three places.

`isb config` prints the resolved task folder, data directory, tool version,
and every setting. `isb version` prints the tool version
(`git describe --tags --always` of this repository).

### `isb run`

```
isb run <model> [--task <dir>] [--variant <name>] [--thinking <level>]
    [--mode worktree|clone] [--data-dir <dir>] [--keep] [--allow-bad-config]
    [--max-tooling N] [--max-model N] [--stall-min N] [--wall-min N]
    [--turn-min N] [--context-window N] [--reserve-tokens N]
    [--keep-recent-tokens N] [--server-log <path>]
isb run --cleanup <fslug>
```

`<model>` is the one argument every run needs. A thinking level is required
too (`--thinking`, a task default, or `config.json`); without one, the run
refuses to start.

Two modes:

- `worktree` (the default when `repo_path` resolves): a sibling worktree
  `<worktree_prefix><slug>` beside `repo_path`, on branch
  `<slug><branch_suffix>` at the base commit. The branch and the worktree
  stay after the run, so the owner can adopt the branch; `isb run --cleanup
  <fslug>` removes the worktree later. The run refuses to start if an
  `AGENTS.md`, `AGENTS.override.md`, or `CLAUDE.md` sits in any directory
  above the worktree — such a file would leak into the run.
- `clone`: `git clone` into `clones/<fslug>` under the data directory, then
  a new branch from the base commit. After the run, the worker collects the
  artifact pack and removes the clone, unless `--keep`.

### The harness window

`--context-window`, `--reserve-tokens` (default 8192), and
`--keep-recent-tokens` are run-time inputs, not fixed task values: the
newest measurement of a model's real behavior sets them at run time. The
worker writes `--context-window` into the model's entry of a private,
per-run copy of `models.json`, and `--reserve-tokens` and
`--keep-recent-tokens` into a private `settings.json`:
`compaction.reserveTokens` is always written, with its built-in default
(8192) when nothing else sets it; `compaction.keepRecentTokens` is written
only when given. The run's meta file records all three under
`harness_window`.
The operator's own pi configuration is never edited.

### The server log of a local model

A local model runs behind a server the operator starts —
`llama-server`, `mlx_lm.server`, LM Studio, or another. `--server-log
<path>` names that server's own log file; the tool never starts, stops, or
configures the server, it only keeps a copy of the run's own slice. It is a
settings flag, key `server_log` in `config.json`, exported as
`ISB_SERVER_LOG`. It resolves from the command line, then from
`config.json` — never from a task's `defaults`, because the path names one
machine and a task folder is committed to the target repository and shared
across machines. There is no environment variable for it. `isb config`
prints `server_log` with the other settings.

With no `--server-log` and no `server_log` in `config.json`, nothing is
captured and the run is normal — the case for every remote API run. When a
path is given and the file cannot be read at run start, the worker prints
one warning line to the runner log and the run continues with no capture.

### The pinned environment

Each run gets its own agent directory under
`runs/.pi-agent-<fslug>`: a copy of `models.json`, `auth.json`, and
`models-store.json` from `~/.pi/agent/`, with the context window applied
when given, a `settings.json` with compaction and retry enabled, and the
task's `agents_file` copied in as `AGENTS.md`. The directory is deleted once
the run ends.

### The data directory

`$XDG_DATA_HOME/issue-simulator-bench/<instance_id>/` (default
`~/.local/share/issue-simulator-bench/<instance_id>/`), or `data_dir` from
`config.json`, or `--data-dir`. Layout: `runs/`, `artifacts/<fslug>/`,
`clones/<fslug>/`, `evidence/`, `results/`, `reports/`. Nothing is written
inside this tool's own folder, or inside the target repository, other than
the run's branch and worktree.

### House rules

- Use a sibling worktree first. Never nest one worktree inside another.
- Never use a bare `git stash`.
- Run one plan-provider run at a time.
- Treat credit exhaustion as a pause, never as a teardown.
- Run a judge, when used, on a strong model.
- Treat a task's `agents.md` as frozen. A new version starts a new results
  epoch.
- A local model's server belongs to the operator, never to this tool.
  `isb run` never starts, stops, or configures one.

### The other sub-commands

- `isb loop-check <log>`: wraps `loop-check.py`'s repetition-loop verdict, so
  another tool can call it without reaching into this repository.
- `isb count [--lines N] <session.jsonl> [...]`: tool calls, assistant
  messages, and peak context of one or more session logs.
- `isb probe-plan <provider> [--out <file>]`: one reading of a subscription
  plan's rate-limit windows (`anthropic`, `openai-codex`, `xai`, or `none`).
- `isb estimate-plan <model> [results.json ...]`: a fallback plan-share
  estimate for a run whose before/after probes are missing.

`isb` alone, or `isb --help`, prints the sub-command list and exits 2.

## Output

Under `runs/<fslug>-*`: `meta.json` (the run's own record: end reason,
nudges, warnings, harness window), `session.jsonl` and `events.jsonl` (the
raw session), `session.html` (an HTML export), `runner.log`, `loop.txt` (the
repetition-loop check's own output), `worker.json` (the worker file),
`plan-before.json` / `plan-after.json` (the plan probes), `install.log`
when the task defines an install command, and `server.log` when
`--server-log` was given. The worker file carries `model`, `harness`,
`bench` (the variant name), `thinking`, `plan_provider`, `branch`,
`base_commit`, `start`, `end`, `pinned_env`, `loop_flag`, `loop_ratio`,
`loop_kind`, `task`, `mode`, `checkout`, `artifacts`, `tool_version`, and
`server_log`.

`runs/<fslug>-server.log` is one run's own slice of the operator's server
log: everything written to the log from the moment the run started, byte
for byte. When the server rotated or truncated its log during the run — the
file is smaller at the end than the offset the worker recorded at the start
— the worker falls back to copying the whole file as it stands. With no
`--server-log`, no file is written and the worker file's `server_log` is
`null`.

The artifact pack, `artifacts/<fslug>/`: `patches/` (`git format-patch
<base>..HEAD`), `<slug>.bundle` (when there are commits), `diff.patch`
(uncommitted changes), `status.txt`, `log.txt`, and `predictions.jsonl` —
one line, `{ "instance_id", "model_name_or_path", "model_patch" }`, the
SWE-bench prediction shape, so another judge can evaluate the same run from
the artifact pack alone.

The evidence pack, `evidence/<fslug>-evidence.json`: generic evidence
(branch, base, a timestamp, commit craft, session habits, runner facts from
the meta, telemetry) merged with whatever JSON object the task's battery
prints, battery keys winning on a clash.

The report model, from `isb report`, is one JSON object: `{ "generated",
"tool_version", "tasks": [ { "instance_id", "variant", "version", "unit",
"rows", "cost", "plan" } ] }`. Each task's `rows` groups the results rows by
`prompt_version`, as `{ "prompt_version", "rows" }` objects, with each row
carrying its derived rank, capped score, and score line. `--format json`
writes the model as-is; `csv` flattens the rows; `md` and `html` render it,
`html` through the one generic `report-template.html`. By default, one task
and variant renders to
`reports/<instance_id>-<variant>.<ext>`; `--all` renders every variant of
the task, cross-linked; `--scan <dir>` walks every `results/*.json` under a
data directory, grouped by task and variant, with an index page plus one
page per group, all cross-linked.

## Scoring

Scoring is 100 percent objective. Nothing in this pass reads a rubric.

Every field of a results row, and how it is computed:

- `model`, `model_id`: the model argument the run received.
- `harness`: `pi`, always — this tool drives only pi today.
  `harness_guessed` is always `false`.
- `provider`, `local`, `serving`: filled in by hand today; nothing
  detects them automatically yet.
- `branch`, `base_commit`, `thinking`, `plan_provider`: copied from the
  worker file.
- `prompt_version`: the matched variant's own `version`.
- `partial`: `true` unless the meta's `end_reason` is `complete`.
- `end_reason`, `tool_version`: copied from the meta and the worker file.
- `resolved`: when the task lists `FAIL_TO_PASS` and `PASS_TO_PASS`, `true`
  only when the battery's own `tests` object marks every listed id passed.
  Without those lists, `resolved` is the battery's own `resolved` key.
  `resolved_by` records which path decided it (`lists` or `battery`).
- the unit field (for example Mendel's `libraries_done`): present only when
  the task defines `unit`; copied from the battery's own field of that name.
- `scores.*`: the mechanical criteria object the battery returns, unchanged
  (for example Mendel's `completion`, `node_modules`, `lint`, `task_list`,
  `truncation`, `nudges`).
- `score_raw`: the sum of every value in `scores.*`, before any cap or
  penalty.
- `reruns`: an integer, 0 on a fresh row. Replacing a row with the same
  `branch` carries the old row's `reruns` forward, so a human who orders a
  retry can raise it by hand and have it survive a re-score. Nothing in the
  tool sets `reruns` above 0 today.
- `score_total`: `max(0, min(score_raw, cap) - 10 * reruns)`, where `cap` is
  `100 * <unit field value> / unit.max` when the task defines a unit, else
  `score_raw` itself (no cap). With `reruns` at 0, `score_total` equals the
  capped `score_raw`.
- `scored_by`: `"battery"` for an objective row, or `"judge:<model>"` after
  a judge merge.
- `telemetry.*`: `tool_calls`, `assistant_msgs`, `peak_context`,
  `tokens_in`, `tokens_out`, `cache_read`, `cache_write`, `tokens_total`,
  `compactions`, `wall_clock_min`, `loop_flag`, `loop_ratio`, `loop_kind`,
  `tool_errors`, `truncation_pct`, `nudges_tooling`, `nudges_model` — read
  from the session log, the meta, and the worker file.
- `cost_usd`, `cost_basis`: `null` and `"local"` until filled in by hand or
  by `estimate-plan-share.mjs`.
- `defects`: an empty array until a judge fills it.

Invalid rows: `isb report` checks each row's `scores.*` sum against
`score_raw` (or, for a legacy row with no `score_raw`, against
`score_total`) and refuses — it exits non-zero and prints every mismatch —
rather than render a row whose numbers do not add up.

The judge is a separate, optional step. `isb judge-pack <slug>` writes
`evidence/<fslug>-judge-pack.md`: the rubric, the evidence pack, the
artifact log, and the session path, asking for an answer in a `verdict.json`
shape (`judge`, `scores`, `defects`, and `notes` with `summary`,
`what_decided_it`, `defects`, `anomalies`). `isb score <slug> --judge
<verdict.json>` merges `verdict.scores` into the row — refusing if a judged
criterion's name clashes with a battery score — recomputes `score_raw` and
`score_total`, and sets `scored_by` to `judge:<model>`. The tool never calls
an LLM itself; a person hands the pack to a strong model by hand. A rubric
is task-owned and judge-only: it may live outside the task folder so several
tasks share one file, and `isb score`'s objective pass never opens it.

## Tests

```
bash issue-simulator-bench/tests/run.sh
```

This runs `test-run-pi-rpc.sh`, the loop-check unit tests
(`python3 -m unittest tests.test_loop_check`), and every other
`tests/test-*.sh` script: `test-isb-run.sh`, `test-isb-wiring.sh`,
`test-score.sh`, `test-report.sh`, `test-import.sh`. All of them drive the
real commands against a fake `pi` on `PATH` and the real fixtures under
`tests/fixtures/`, with `XDG_CONFIG_HOME` and `XDG_DATA_HOME` pointed at
temporary directories, so no test run touches the user's home directory.

## Example: Mendel issue 13

Mendel's issue 13 asks for eight small npm dependencies to be replaced with
native Node equivalents. Its task folder lives on a dedicated
`llm-benchmark` branch of the Mendel repository, at
`.issue-simulator-bench/`, with two variants:

- `guided`: `prompts/guided.txt`, version `v3.0`, base tag
  `benchmark-guided-base`, branch suffix `-guided-v3-issue-13`. The prompt
  gives the model a numbered workflow (grep first, test-first for uncovered
  files, the right removal command, a full test run before every commit).
- `blind`: `prompts/blind.txt`, version `v1.1`, base tag
  `benchmark-blind-base`, branch suffix `-issue-13`. The prompt is terse and
  discloses nothing; it asks whether a model finds the issue's traps
  unaided.

The issue hides known traps — for example, an async iterator that looks
correct but breaks on an edge case. The blind prompt names none of them; the
guided prompt teaches a workflow that catches most of them without naming
them either. The task's battery reports `libraries_done` against a unit of
8, labeled "libraries".

One run, one score, one judge pack, and one report:

```
isb run gpt-5.6-luna --task ../mendel/.issue-simulator-bench \
    --variant guided --thinking low --mode clone
isb score gpt-5.6-luna-low-guided
isb judge-pack gpt-5.6-luna-low-guided
isb report --all
```

The owner's smoke gate, in `choose-a-local-llm`, calls `isb loop-check` on
its own session logs to get the same repetition-loop verdict this tool
uses, and copies the pinned per-run config layout (a private `models.json`,
`auth.json`, and `settings.json` under the run's own directory) so its own
smoke runs stay comparable to a full `isb run`.

## Future goals and ideas

- Store issues and tests inside this repository, instead of only in a task
  folder outside it.
- Static outcome checks for known traps (for example, the async iterator
  trap in Mendel's issue 13), so a judge is not needed to catch them.
- A Docker image per task, for full environment pinning.
- A full SWE-bench import over many instances, not just one record at a
  time.
- Compress a captured server log.
- Read a plan-provider server log the same way.
