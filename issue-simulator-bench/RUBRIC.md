# Issue-13 verification battery and scoring rubric

Run all checks for every new branch. Apply the rubric unchanged so scores stay
comparable. Paths are relative to the repo root; `$d` is the eval worktree.

## The task

Issue 13 lists eight npm packages to replace with Node built-ins: `uuid`, `xtend`,
`urlsafe-base64`, `rimraf`, `glob`, `chalk`, `tmp`, `shasum`.

## The three traps

**A. `fs.promises.glob()` returns an AsyncIterator, not a Promise.** A naive
`.then()` swap in `packages/mendel-development/apply-extra-options.js` throws at
runtime. Correct form: `Array.fromAsync(fs.promises.glob(pattern))`. No unit test
covers this file — only the runtime repro below catches it. Highest-signal check.

**B. The issue's reference list is incomplete.** `legacy-packages/mendel-requirify`
still requires `rimraf` in two test files and declares it in `package.json`. The
prompt warns about missing references; the issue does not list this one.

**C. The issue is wrong about `tmp`.** `tmp` does not auto-clean on exit unless
`setGracefulCleanup()` is called, and nothing in this repo calls it. Adding an exit
hook to `packages/mendel-development/validate-manifest.js` is a regression: it
deletes the debug manifest one line after the code prints its path.

Also, on the blind and v2.1 bases only: `packages/mendel-deps/test/fixtures/js/es5/foo/browser.js:2`
contains `require('glob')` as parser fixture data. Leaving it is correct. The v3 guided
base (`guided-v3-base`) has that fixture requiring `debug` instead, so no exception applies.

## Verification battery

### Worktree setup

Sibling worktree, detached at the branch, symlink `node_modules` from the main repo
(root and per package) instead of a fresh install. Delete the symlinks before
`git worktree remove`.

### Static completeness

```bash
b=<branch>
git grep -nE "require\('(uuid|xtend|urlsafe-base64|rimraf|glob|chalk|tmp|shasum)'\)" $b -- '*.js' \
  | grep -v "js/es5/foo/browser.js"
git grep -nE '"(uuid|xtend|urlsafe-base64|rimraf|glob|chalk|tmp|shasum)":' $b -- '*/package.json' 'package.json'
git diff --stat master..$b -- pnpm-lock.yaml
```

A perfect branch leaves only the fixture file (older bases) or nothing (v3 base). Note: `git grep -E` has no
backreferences — write the quotes literally.

### Runtime repro for trap A (decisive)

```bash
cat > /tmp/repro-glob.js <<'EOF'
const applyExtraOptions = require(process.argv[2] + '/packages/mendel-development/apply-extra-options.js');
const b = { _pending: 0, _ready: true, ignore(){}, exclude(){}, external(){}, require(){}, emit(){} };
try {
    applyExtraOptions(b, {ignore: ['packages/*/index.js']});
    console.log('SYNC OK, pending=', b._pending);
} catch (e) {
    console.log('THREW:', e.constructor.name, e.message);
}
EOF
node /tmp/repro-glob.js "$d"
```

`SYNC OK` = pass. A `TypeError` on `.then` = critical bug.

### Chalk / colour behaviour

Master forces the colour level: `chalk.level = options.enableColor !== false ? 3 : 0`.
Scoring depends on the prompt version:

- **v2.1 and blind v1.0**: a faithful `util.styleText` port must honor `enableColor: false`
  and pass `{ validateStream: false }` so colour survives redirection. Load
  `packages/mendel-pipeline/src/helpers/analytics/cli-printer.js`, capture `print()` with
  `{enableColor:false}` and `{}`, test for ANSI escapes. Correct: `false` then `true`.
- **guided v3.0 and blind v1.1**: the direction is Node defaults. Correct: no forced level,
  no `enableColor` handling, plain `util.styleText(styles, text)` — colour follows the
  stream (ANSI on a TTY, none when piped). Forcing colour either way is a medium defect.

### Lint and format

`prettier --check .` and `eslint .` from the repo's own `node_modules/.bin` must be
silent. The `node:` prefix trap is retired as of the v3 guided base: the patched
`eslint-plugin-implicit-dependencies` accepts both `require('node:crypto')` and
`require('crypto')`. It still applies when scoring runs on the older bases.

### Package test suites

Run tap per package (`mendel-core`, `mendel-config`, `mendel-deps`,
`mendel-development`, `mendel-manifest-extract-bundles`, `mendel-manifest-uglify`,
`mendel-outlet-manifest`, `mendel-pipeline/test/cli-printer.js`,
`legacy-packages/mendel-requirify`). Expected baselines — never score these as
regressions:

- `mendel-requirify` fails 3/3 on every branch and on master (outside the pnpm
  workspace).
- `mendel-config` can flake to 4/1; re-run standalone and it passes 41/41.
- Anything that needs a live daemon socket (`MENDEL_IPC`) already fails on master.

### Session-log metrics

From the harness session log collect: cost, assistant messages, tool calls, tool
errors, compactions, tokens (input, output, cacheRead, cacheWrite), peak context,
duration, commit count, failed commits, share of shell commands piped to
`tail`/`head`, `--no-verify` and `git add -A` use, TASKS.md handling. For pi runs
made with `run-pi-rpc.mjs`, also the nudge counts from `<slug>-meta.json`:
**tooling nudges are never scored** (harness and server failures are not the
model's); **each model nudge costs 2 points on criterion 6**, floor 0 — the model
declared itself done with work visibly left. A run that ends on
`model_budget_exhausted` or `tooling_budget_exhausted` is partial.

### Commit-craft inspection

`git log master..$b` — one package per commit, all types `chore`, no TASKS.md leak,
root devDependencies (`rimraf`, `tmp`) removed.

## Scorer discipline — pitfalls found in the 2026-08-31 re-score

Earlier scoring passes missed each of these at least once. Check them all so
different scorers land on the same numbers:

1. **Never trust a prior scorer's cell labels.** Re-derive every judgement
   from the branch and the session log. The re-score found labels that were
   simply wrong ("batched" task lists that were textbook, "never recovered"
   loops that recovered).
2. **Re-run flaky-looking suites standalone, three times.** A batch failure
   that persists 3/3 standalone is a real regression, not the documented
   flake (this is how the gpt-5.6-sol generator-config regression was found).
3. **Distinguish vacuous passes.** Trap A and the chalk contract "pass" on a
   branch that never touched those files. That is absence of work, not
   correctness; score completion accordingly and say so in the cell.
4. **Classify commit failures by cause.** A bash quoting error, a test-first
   `&&` chain that stopped, and a husky reject are three different things;
   only hook rejects and bypasses belong to the commit-hooks bucket.
5. **Check TASKS.md at the branch tip**, not just in the log. A "removed the
   file" commit can modify it instead of deleting it (qwen3.6 blind).
6. **Match commits against session events.** A branch commit with no command
   in any session log is a provenance gap; an in-session commit missing from
   the pushed branch is one too. Record both (Qwen3.8-low guided; gemma
   blind 60b93f8).
7. **Search the session log for human messages inside the scored region.**
   Any mid-run instruction, nudge, or "continue" violates the no-help rule:
   flag the run as assisted in the report prose and dock any criterion the
   help directly satisfied (deepseek's trap-B credit).
8. **Truncation is about effect, not just the pipe count.** Redirecting a
   noisy run to a file and grepping it is truncation by better means; a raw
   run into the harness output cap is not truncation at all.
9. **Task-list scale, applied uniformly:** textbook progressive discovery
   with per-commit ticks = 4; upfront full tree but faithful ticks = 2-3;
   bulk/batched check-offs = 1.5; coarse or unmaintained = 1 or less.
10. **Lint credit needs both facts:** is the branch clean when you re-run
    the tools, and did the model run them itself (or at least let the hooks
    run — a `--no-verify` bypass forfeits "clean via hooks" credit).
11. **Harness failures are not model failures.** Server crashes, silent
    client exits, and restarts do not count against right-the-first-time;
    self-inflicted broken edits do. Keep the two lists separate.

## Scoring rubric — 100 points

| #   | Criterion                     | Max | Measurement                                                                                                                             |
| --- | ----------------------------- | --: | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Bugs remaining                |  25 | `25 − 3 × weighted_bug_points`, floor 0. Critical = 3, medium = 2, minor = 1.                                                           |
| 2   | Task completion               |  20 | All 8 libraries done; no stale `require()`; gone from every `package.json`; found the `mendel-requirify` reference.                     |
| 3   | node_modules actually pruned  |   8 | Real `pnpm install` (8) > lockfile-only + hand check (7) > install unverified (4) > lockfile-only (2) > no pnpm (0).                    |
| 4   | Prettier & ESLint clean       |   5 | Re-run on the branch; split by prompt version, see below.                                                                               |
| 5   | Commit craft                  |  12 | All `chore` (4) + commits split per package (4) + no `--no-verify`, no `git add -A`, no TASKS.md leak (4).                              |
| 6   | Right the first time          |   8 | Self-inflicted repair commits; version-aware, see below.                                                                                |
| 7   | Test discipline               |  10 | Narrow per-package runs and the full-suite cadence the prompt mandates, see below.                                                      |
| 8   | House conventions             |   5 | Minimal diff, matched neighbor style, no drive-by churn.                                                                                |
| 9   | Task list built progressively |   4 | Libraries listed upfront with no sub-items; sub-items on discovery (granularity per version, see below); marked done after each commit. |
| 10  | Truncated noisy commands      |   3 | Share of shell commands piped through `tail`/`head`.                                                                                    |

### Criteria by prompt version

Four criteria measure "did the model do what the prompt said", and the prompts
differ by version. Score against the version in the run's `prompt_version`:

| #                      | Blind v1.x / guided v2.1                                                                                                                                              | Guided v3.0                                                                                                                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 4 Prettier & ESLint    | 5 pts when clean on re-run AND the model ran the tools itself. The husky hook auto-fixes, so hook-only cleanliness caps at 3; `--no-verify` forfeits the hook credit. | Same split, explicit: 3 pts clean on re-run; 2 pts when the session log shows `prettier --check` and `eslint .` run by the model after the last code change; `--no-verify` forfeits the 3. |
| 6 Right the first time | Includes recovery from the `node:` prefix lint trap.                                                                                                                  | The trap is retired on the v3 base — score self-inflicted repairs only.                                                                                                                    |
| 7 Test discipline      | Full suite about every 5 commits, as the blind prompt says.                                                                                                           | Full suite before every commit — count the commits with no `pnpm run unit` before them.                                                                                                    |
| 9 Task list            | Sub-items per affected package.                                                                                                                                       | Sub-items per affected file, grouped by package.                                                                                                                                           |

The chalk check and the fixture exception above are already version-aware. The
matrix labels are version-neutral; each version renders its own scoreboard and
matrix in the report.

Criterion-5 note (prompt v3): the root package.json change scores the same
whether it rides with a package's commit or comes as its own commit. Leaving
the root change uncommitted loses the split-per-package points. Never
removing the root's dependencies at all (rimraf and tmp stay declared) is a
critical defect under criterion 1, not a commit-craft matter.

Cost is reported next to the scores but is never scored.
