# Mendel benchmark — remaining improvements (review of 2026-09-01)

Scope: how the benchmark runs, scores, and reports. Worst first. Each item
has evidence and a proposed fix. Closed rows are not reopened. Item 1 of
the handoff (a Claude Code runner on the Agent SDK) is dropped by the
owner's decision.

## Todo

- [x] 1. One run, two totals: scoreboard and matrix disagree on 13 of 17 rows
- [x] 2. On mlx_lm.server a cut stream becomes a scored model nudge
- [x] 3. Thinking level and sampling are not pinned and not recorded
- [x] 4. Operator personalization leaks into every run
- [x] 5. Subagent use is invisible in results and report (resolved: no action)
- [x] Extra: Claude Code retired as a harness (2026-09-01); pi is the only harness
- [x] 6. Done-check false positives: blind base, pre-existing dirt
- [ ] 7. Rubric text and matrix labels drift from prompt v3
- [ ] 8. Prompt-version bookkeeping is incomplete
- [ ] 9. "Partial" hides the end reason
- [ ] 10. Scoring is hand-written HTML; make the mechanical part a script
- [ ] 11. Wall-clock and stall budgets are absolute, not model-aware
- [ ] 12. Small runner bugs
- [ ] 13. The task text is fetched live from GitHub
- [ ] 14. Evidence gaps: footnotes, not re-runs

## 7. Rubric text and matrix labels drift from prompt v3

**Evidence.**

- RUBRIC criterion 7: "full suite about every 5 commits". Guided v3
  demands the full suite before every commit; blind v1.x says every 5
  commits. Matrix row label: "Full suite every ~5 commits".
- RUBRIC criterion 6: "recovery from the `node:` prefix trap". The trap
  is retired on the v3 base. Matrix row "Handled the `node:` ESLint trap"
  has no meaning for v3 rows.
- RUBRIC criterion 9: "sub-items discovered per library" and matrix "sub-
  items on arrival". v3 asks for one sub-item per file, grouped by
  package; blind asks for one per package.
- RUBRIC criterion 4: "full marks only when the model ran them itself".
  The husky pre-commit runs `prettier --write` and `eslint --fix`
  (`.lintstagedrc.yaml`), so a clean branch is nearly free. Only rules
  eslint cannot auto-fix, and hook bypasses, separate models.
- PLAN.md lines 27-33 say the guided prompt "names the known pitfalls (the
  glob AsyncIterator trap, ... the chalk `enableColor` contract, the
  `node:` prefix lint convention, the fixture file to leave alone)".
  v3 names none of these; it discloses only rimraf `force` and the legacy
  baseline. The "Two tests" paragraph describes v2.1.

**Fix.** Make the rubric version-aware in one table, like the chalk check
already is:

| #   | Blind v1.x / guided v2.1                       | Guided v3.0                                                                                                                                            |
| --- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 4   | as now                                         | 3 pts clean on re-run; 2 pts the log shows `prettier --check` and `eslint .` run by the model after the last code change; `--no-verify` forfeits the 3 |
| 6   | self-inflicted repairs + `node:` trap recovery | self-inflicted repairs only (trap retired)                                                                                                             |
| 7   | narrow runs + full suite every ~5 commits      | narrow runs + full suite before every commit (count commits without a preceding `pnpm run unit`)                                                       |
| 9   | sub-items per package                          | sub-items per file, grouped by package                                                                                                                 |

Matrix rows get the same split (label per version, or a "n/a on v3"
cell). Rewrite PLAN.md "Two tests" for v3 (what is disclosed now: the
workflow, rimraf `force`, the legacy baseline; what is not: traps A, B,
C).

## 8. Prompt-version bookkeeping is incomplete

**Evidence.**

- `results-guided.json` header: `"prompt": "prompt-guided.txt (frozen
v2.1)"`; rows: `"prompt_version": "r2.1"`. The prompt file is v3.0.
- `results.json`: no `bench`, no `prompt`, no `prompt_version` on any
  row. The blind prompt is now v1.1; every scored blind row ran v1.0.
- PLAN.md table: guided base `23050bd`; the tag `guided-v3-base` resolves
  to `6458616` (one commit later, the fixture change). A scorer who
  copies the hash from PLAN.md checks out the wrong base.
- The report has one scoreboard and one matrix; the first v3 row would
  sit next to v2.1 rows, the cross-version comparison PLAN.md forbids
  (handoff item 3).

**Fix.**

1. Every row carries `prompt_version` (`v1.0` for all blind rows,
   `v2.1`, `v3.0`) and `base_commit`. Header carries `prompt_versions:
[...]`. Use one spelling (`v`, not `r`).
2. `generate-report.mjs` groups by `prompt_version`: one scoreboard and
   one matrix per version, newest first, each with its base commit and a
   link to the prompt at that version (`git show <tag>:benchmark/...`).
   No cross-version totals, no shared "best" highlighting.
3. Tag the prompts (`guided-prompt-v2.1`, `guided-prompt-v3.0`,
   `blind-prompt-v1.0`, `blind-prompt-v1.1`) so a version is a git ref.
4. Fix the PLAN.md hash to `6458616` and write "tag `guided-v3-base`" as
   the primary reference everywhere.

## 9. "Partial" hides the end reason

**Evidence.** `partial: true` is the only flag. It covers a 3/8 Bonsai
run stuck 45 min on its own bug, a run cut by a server crash and
relaunched, a run that hit `model_budget_exhausted`, and a run the
operator killed. The runner now knows the reason (`meta.end_reason`),
the results row does not carry it, and the scoreboard shows one label.

**Fix.** Add `end_reason` to every row with a closed set: `complete`,
`wall_clock`, `model_budget`, `tooling_budget`, `harness_crash`,
`operator_stop`, `stuck` (self-inflicted loop, operator closed it). Add
`libraries_done` (0-8). The scoreboard shows `(partial · 3/8 ·
stuck)` instead of `(partial)`; the report gets a five-line legend.
Back-fill the closed rows from the report prose and state.md — that is a
documentation task, not a re-score.

## 10. Scoring is hand-written HTML

**Evidence.** `matrix_cells` are 30 HTML strings per run, typed by the
scorer. `matrix_total` is typed too (see item 1). The verification
battery in RUBRIC.md is already mostly shell. Criteria 2, 3, 4, 5, 10 and
the nudge counts are mechanical; 1 (severity), 6, 8, 9 need a reading.

**Fix.** `benchmark/score.mjs <branch>`:

1. Runs the battery: static grep, trap A repro, chalk check (version-
   aware), prettier/eslint, per-package tap with the documented
   baselines, lockfile diff, `git log` facts (types, per-package split,
   root devDeps, TASKS.md leak), session-log facts (`--no-verify`, `git
add -A`, `tail`/`head` share, commands per commit, `pnpm run unit`
   before each commit, nudge counts from meta).
2. Writes `runs/<slug>-evidence.json` with a computed value for every
   mechanical criterion and the raw evidence next to it.
3. The scorer fills only `defects[]`, `first_time`, `conventions`,
   `task_list` in a small JSON; `score.mjs --merge` writes the results
   row. `generate-report.mjs` renders the matrix cells from structured
   fields (`{value, tone, note}`), never from HTML strings.
4. Run it once against all 17 closed rows as a regression test: any
   mechanical criterion that disagrees with the 2026-08-31 re-score is
   either a script bug or a finding — both worth knowing.

## 11. Wall-clock and stall budgets are absolute

**Evidence.** `--wall-min 300` and `--stall-min 10` apply the same to a
cloud model at 100 tok/s and a 2-bit 27B at a fraction of that. The
handoff calls the budgets guesses. pi emits no event during prefill; a
long prefill after compaction on a slow box (60-90 k tokens) can look
like a stall, and the abort throws away the partial turn (the model then
redoes the work under the same wall clock).

**Fix.**

1. Record throughput in meta (output tokens / generation time from the
   session usage) so the budgets can be set from data.
2. Stall detection: before aborting, check whether the server is busy
   (llama.cpp `/slots`, LM Studio `/api/v0/models`); abort only when the
   server is idle too. mlx_lm.server has no such endpoint — for it, set
   `--stall-min` from the measured prefill speed, and say so in meta.
3. Wall clock: keep a hard stop, but express it as a budget of generated
   tokens for local models (same work, not same minutes), or state
   plainly in the report that the wall budget favours fast servers.
   Mac check: TTFT of one request at ~80 k context on each stack.

## 12. Small runner bugs

- `wallHit` is set after `await send({type:'abort'})`. If `agent_settled`
  arrives first, the loop reads `wallHit === false`, classifies
  `aborted` as a tooling nudge, and starts another turn. Set `wallHit =
true` before the send.
- Respawn after a dead pi resumes the session with a possibly dangling
  `toolCall` (no result). Verify pi tolerates it; otherwise append a
  synthetic error tool result before the nudge.
- `generate-report.mjs --guided` with a stray argument writes a stray
  file (handoff notes it). Validate arguments.
- Matrix row "Compactions" has no `type` field (all others say `row`).
  Harmless now; item 10 gives the rows a schema.

## 13. The task text is fetched live from GitHub

**Evidence.** Both prompts say "Fetch https://github.com/irae/mendel/
issues/13". The issue is the task statement. If the issue or its comments
change, later runs get a different task under the same prompt version.
Comments on the issue are visible to `gh issue view --comments` and may
name the traps.

**Fix.** Lock the issue on GitHub (no new comments). Store
`benchmark/issue-13.md` with the text as fetched today and its sha256;
PLAN.md states that the prompt's live fetch must match this file. If the
issue has comments, record whether any model read them.

## 14. Evidence gaps: footnotes, not re-runs

**Evidence.** (handoff item 5) Blind Claude transcripts are on the Mac
only; Qwen3.8-low's last commit has no session record; gemma's in-session
commit `60b93f8` is missing from its branch.

**Fix.** No re-runs (the rows are closed). The Claude harness is retired
and its rows will be replaced by pi runs, so the transcript import is
optional history, not a requirement. Add a `notes`
field per row and a footnote in the report: "one commit without a
session record" and "one in-session commit not on the branch". Both are
already in RUBRIC.md "Scorer discipline" item 6; the report should say it
where the row is.

---

# Addressed (moved below the open items)

## 1. One run, two totals

**Evidence.** In both results files `score_total` (= sum of `scores`) and
`matrix_total` differ for most rows. The scoreboard ranks by
`score_total`; the matrix footer prints `matrix_total`. A reader sees two
numbers for one run on one page.

| File                | Model           | `scores` sum | `score_total` | `matrix_total` |
| ------------------- | --------------- | -----------: | ------------: | -------------: |
| results.json        | grok-4.6        |         89.5 |          89.5 |             88 |
| results.json        | gpt-5.6-sol     |         65.5 |          65.5 |             69 |
| results.json        | gemma-4-26b-a4b |           38 |            38 |             41 |
| results.json        | Bonsai-27B      |           58 |            58 |             55 |
| results-guided.json | claude-sonnet-5 |         98.5 |          98.5 |           97.5 |
| results-guided.json | qwen3.6-35b-a3b |         65.5 |          65.5 |           67.5 |

13 of 17 rows differ. Only opus (blind) and Qwen3.8 (guided) agree.

**Cause.** `matrix_cells` and `matrix_total` are free-text HTML written by
hand at scoring time. `scores` was re-scored on 2026-08-31; the matrix
cells were not regenerated from it.

**Fix.** One source of truth. `scores` is the truth. Remove
`matrix_total` from the results files; `generate-report.mjs` computes the
footer from `scores`. Add a check in `generate-report.mjs` that fails when
a matrix cell's bold number (the per-criterion score in the cell) does not
match `scores.<criterion>`. Re-derive the mismatched cells from the
2026-08-31 re-score notes (commit log and report prose already list the
deltas). Item 10 removes the hand-written cells for good.

## 2. On mlx_lm.server a cut stream becomes a scored model nudge

**Evidence.** PLAN.md step 1 and the handoff tell the operator to set
`compat.supportsFinishReason: false` on the mlx provider. The pi docs
(`docs/models.md`, `supportsFinishReason`): "When `false`, pi infers
`stop` or `toolUse` when the stream ends." In `run-pi-rpc.mjs` a `stop`
goes straight to `unfinishedWork()`; if TASKS.md has open items the nudge
is a **model** nudge, −2 points. The 80 % `length` branch can never fire
for that provider because pi never reports `length`. Result: every server
cut on mlx (the "biggest single fairness problem" of the last runs) is
charged to the model.

The flag also hides real errors. The "Stream ended without
finish_reason" message came from the tool-parser crash, not from normal
completions. With the flag on, a crashed stream is an inferred `stop`
(possibly scored), not an `error` (free).

**Fix.**

1. Do not set `supportsFinishReason: false` for mlx unless a normal
   completion is shown to omit `finish_reason`. Mac check (one curl):
   stream a short chat completion from `mlx_lm.server` and look at the
   last chunk. If `finish_reason` is present, drop the flag from PLAN.md
   and the handoff.
2. Make `classify()` robust for either setting: treat `stop` with
   `usage.output >= 0.8 × maxTokens` as `length`; treat `stop` with zero
   output tokens and no text as a tooling stop; record `usage.output` and
   `stopReason` on every nudge entry (the stop reason is there, the token
   count is not).
3. Record `compat` of the model in `meta.model_info` so the scorer can see
   which classification path was active.

## 3. Thinking level and sampling are not pinned and not recorded

**Evidence.** `qwen3.6-35b-a3b-guided-issue-13-session.jsonl` line 3:
`"thinkingLevel":"high"`. No `--thinking` was passed; pi took the level
from the operator's settings or the model default. The results row does
not carry it. The Qwen3.8 rows carry the level only in the slug
(`-low`). Nothing records `temperature`, `samplingParams`,
`thinkingFormat`, or `compat` of the models.json entry, nor the serving
command (quantization, KV settings, `--parallel`). For mlx_lm.server it is
not verified that pi's `reasoning_effort` reaches the model at all; if
the server ignores it, "low" and "medium" rows differ in name only.

**Fix.**

1. `run-worker.sh`: `thinking` becomes mandatory for pi runs (no default
   from the operator's settings). The runner refuses to start when
   `--thinking` is absent, the same way it refuses a missing
   `contextWindow`.
2. `run-pi-rpc.mjs`: after `get_state`, copy the resolved model entry
   (minus `apiKey`/headers) into `meta.model_info`, plus the thinking
   level from state. For llama.cpp also store the `/props` body (it
   carries the generation settings and the loaded model path).
3. Results row: add `thinking` and `sampling` (object) fields; the report
   sub-line shows the level next to the harness. Back-fill the five guided
   rows from the session logs (`thinking_level_change`) where possible.
4. Mac check: with `mlx_lm.server` running, send one request through pi
   at `low` and one at `medium` and diff the server-side request log (or
   the `chat_template_kwargs`) to confirm the level reaches the model. If
   it does not, the models.json entry needs `thinkingFormat:
"qwen-chat-template"` (or the mlx equivalent) before the next Qwen row.

## 4. Operator personalization leaks into every run

**Evidence.** pi loads at startup (`docs/usage.md`, "Context Files"):
`~/.pi/agent/AGENTS.md`, `AGENTS.md`/`CLAUDE.md` from every parent
directory of the worktree, plus user extensions, skills, and prompt
templates from `~/.pi/agent/`. The runner already handles
`extension_ui_request`, which proves extensions load. Claude Code loads
`~/.claude/CLAUDE.md`, user plugins, hooks, and skills (this box has the
superpowers plugin with TDD and planning skills; the Mac's set is
unknown). None of this is recorded per run, and it differs per box and
per day. The session log has no record of the system prompt or of the
context files that were loaded.

**Fix.**

1. pi: run with `--no-extensions --no-skills --no-prompt-templates` and
   `PI_CODING_AGENT_DIR` pointing to a benchmark-owned directory that
   holds only `models.json`, `auth.json`, and a minimal `settings.json`
   (compaction and retry on). Keep repo context files (`--no-context-files`
   would drop the repo's AGENTS.md, which is part of the task).
2. Claude Code: run with `--bare` (skips hooks, LSP, plugins) and a
   `CLAUDE_CONFIG_DIR` (or `--setting-sources project`) that excludes the
   user CLAUDE.md. Verify on the Mac that `--bare` keeps OAuth login.
3. Both: the worktree's parent directories must hold no `AGENTS.md` or
   `CLAUDE.md`. `run-worker.sh` checks and refuses.
4. Record in `meta` the list of context files pi loaded (available via
   the RPC `get_state`/system-prompt if exposed; otherwise a one-line
   scan of the same paths pi scans) and the Claude Code settings sources.
5. State the rule in PLAN.md "Rules that apply to every run" and in the
   report's "Harnesses" section.

## 5. Subagent use is invisible

**Resolution (2026-09-01, no action).** pi does not bundle subagents (its
docs list them as intentionally not included; the subagent is an example
extension) and benchmark runs now start with `--no-extensions`, so a pi
run cannot spawn one. Claude Code subagents run on the parent's model
(the sonnet-5 guided run's `modelUsage` lists only `claude-sonnet-5`)
and bill to the same plan. The Harnesses section already discloses the
harness difference.

**Evidence.** `runs/claude-sonnet-5-result.json` (guided, the top row at
98.5): `num_turns: 5`, `subagent_stats.spawned: 1`
(`general-purpose`), 54 k output tokens. The main agent delegated the
whole task to one subagent. `runs/claude-haiku-4-5-20251001-result.json`:
`num_turns: 239`, no subagent. The results row and the report do not say
this. pi has no subagents, so a Claude Code row may be a two-agent
system scored as one model.

**Fix.** Do not forbid it (it is part of the harness, and the report
already separates harnesses). Disclose it: copy `subagent_stats` into
`telemetry.subagents` for Claude rows (0 for pi), show it in the matrix
"Context economy" group, and add one sentence to "Harnesses". State in
PLAN.md whether telemetry for such rows (assistant messages, tool calls,
truncation share) covers the subagent transcript too, and how it was
collected.

## 6. Done-check false positives

**Evidence.** `unfinishedWork()` returns "uncommitted or untracked
changes" for any non-empty `git status --porcelain`.

- Blind base `182b07f` does not gitignore TASKS.md (only the v3 guided
  base does). PLAN.md still allows `run-worker.sh <model> pi blind`. A
  blind run through the RPC runner has a dirty tree from the first
  `TASKS.md` write until the end: three scored model nudges, then
  `model_budget_exhausted`, always partial.
- Any file that `pnpm install` or the harness leaves untracked before the
  first prompt counts as the model's unfinished work.

**Fix (as applied; the owner rejected gitignore/exclude tricks).** The
done-check itself got smarter, all inside `run-pi-rpc.mjs`:

1. Before the first prompt the runner snapshots `git status --porcelain`
   and records the paths as `baseline_dirty` in the meta file (a warning
   when non-empty, never fatal).
2. The done-check ignores `TASKS.md` and every baseline path; only dirt
   the run itself made counts, and the nudge cause names the first few
   paths.
