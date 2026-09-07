# Smoke fixtures — real server runs

Real output from `creep.py`, run against a live server, not the fake
one the unit tests use. One file per run.

## qwen36-gguf-q8-c98304.tsv

- Backend: llama-server
- Model: `unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL` (alias
  `qwen3.6-35b-a3b`)
- Command:
  ```
  llama-server -hf unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL \
    --alias qwen3.6-35b-a3b --no-mmproj \
    --spec-type draft-mtp --spec-draft-n-max 3 --parallel 1 \
    -ngl 999 -fa on -c 98304 \
    --cache-type-k q8_0 --cache-type-v q8_0 \
    --jinja --port 8081 --offline
  ```
  ```
  DEPTH_LIST="4096,8192,16384,24576,32768,40960,49152,57344,65536,81920,98304" \
  MODEL=qwen3.6-35b-a3b SWEEP_BASE=http://127.0.0.1:8081 \
  python3 slow-context-creep/creep.py llama
  ```
- Date: 2026-09-07
- Chip family: Apple M1 Max
- Memory size: 32 GB

## qwen36-gguf-q8-c98304-retry-clean.tsv

Same model, same server command, same `creep.py` command as above.
Re-run after the machine was confirmed clean (see below), to check
whether the first run's early stop was machine noise.

- Date: 2026-09-07 (same day, later, after the server was stopped and
  restarted)
- Chip family: Apple M1 Max
- Memory size: 32 GB

## Comparison to the old tool

The reference run is `choose-a-local-llm`'s
`hardware/m1-max-32gb/benchmarks/bench11/results/creep-qwen36-gguf-q8-clean-redo.tsv`,
the accepted number for this exact model and server command (ceiling
81958 tokens, `speed` verdict, full ladder to depth 98338).

**First run** (`qwen36-gguf-q8-c98304.tsv`): decode speed matches the
reference row for row at every depth both runs reached (36.23 vs
36.53 tok/s at depth 4114, down to 19.60 vs 19.64 at 32818). Stopped
early on a `mem` verdict at depth 32818. Machine was dirty at start:
`swap used` 4727 MB, against the reference run's 517 MB, after a full
day of other benchmark activity.

**Retry** (`qwen36-gguf-q8-c98304-retry-clean.tsv`), after confirming
a clean machine (`swap used` 439 MB at start, matching the reference
run's 517 MB; `tools/preflight.sh` in `choose-a-local-llm` read `ok`
on every check except a known stale machine-file value): **same
result**. Decode speed still matches the reference row for row.
Stopped at the same depth, 32818, same `mem` verdict.

**This rules out machine noise as the explanation.** The real signal
is in the compression/decompression page counts, which are the
`mem` verdict's stop condition:

| depth | reference `decompress_pages` | first run | retry |
| --- | --- | --- | --- |
| 4114 | 32 | 112615 | 84 |
| 8222 | 459 | 19541 | 14162 |
| 16386 | 48 | 3366 | 23883 |
| 24602 | 244 | 3140 | 14263 |
| 32818 | 1064 | 2279 | 22994 |

The reference run barely touches the compressor through depth 32818.
Both new-tool runs generate orders of magnitude more page
compression/decompression at the same depths, on a clean machine,
even though decode speed and wired memory track the reference run
closely. This looks like a real difference in how the new tool grows
the prompt between steps — possibly not reusing the server's prompt
cache the way the old tool's append-only growth rule requires, which
would force much more KV cache churn per step than the reference
tool causes. Not confirmed; flagging for your own investigation
rather than guessing further at the cause.

## A/B run: old tool vs. new tool, same live server (2026-09-07)

`ab-old-tool-qwen36-gguf-q8.tsv` and `ab-new-tool-qwen36-gguf-q8.tsv`
answer the open question above: does the new tool alone cause the
page-churn blowup, or is it the machine?

- Backend: llama-server
- Model: `unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL` (alias
  `qwen3.6-35b-a3b`)
- Server command: same as `qwen36-gguf-q8-c98304.tsv` above, with
  `--verbose` added.
- Ladder: `DEPTH_LIST="4096,8192,16384,24576,32768,40960"`
- The old tool (reconstructed from commit `3a84948`,
  `creep_llama.py`) ran first, then the new tool
  (`slow-context-creep/creep.py llama`) ran right after, against the
  same server process, with no other command run between the two.
  Both tools faced the same machine state.

Result: **both tools stopped early with the same `mem` verdict, at
the same depth, 32818.** The old tool is the unmodified pre-refactor
code. It reproduced the same early stop as the new tool, on this
machine, today.

| depth | old tool: compress + decompress | new tool: compress + decompress |
| --- | --- | --- |
| 4114 | 6741 | 109236 |
| 8222 | 2787 | 81213 |
| 16386 | 5147 | 21283 |
| 24602 | 3503 | 10586 |
| 32818 | 7329 | 2982 |

Decode speed matched row for row between the two tools (36.26 vs.
36.33 tok/s at depth 4114, down to 19.56 vs. 19.55 at 32818), so the
prompt cache worked the same way in both. Only the page-churn columns
differ, and even the smallest of the six numbers above (2787) is far
above the reference run's largest number through this depth (1064).

**Verdict: Case A, environmental.** Both tools show large page
counts on this machine today. The refactor is cleared: the old tool,
running the exact pre-refactor code, shows the same failure on the
same hardware. The compressor state left over from other work on
this machine is the most likely cause, not a defect in
`slow-context-creep/creep.py`. No code fix is needed.

Reminder for a future runner: `Compressions` and `Decompressions` in
`vm_stat` are system-wide, cumulative counters. They count every page
the macOS memory compressor touches for every process, not only the
sweep's own memory. Any other process awake on the machine during a
sweep adds to these columns. Read them as a machine-health signal,
not a per-tool one.

## Follow-up: the Case A verdict above was too quick (2026-09-07, later the same day)

The table above shows two rows over the plan's own 10x match rule
(depth 4114: 16x; depth 8222: 29x). A stricter read of that same
evidence leans toward a tool difference at low depth, not a clean
environmental clearance. The rest of this section holds what a
same-day retest found, and narrows the picture further.

**The compaction stop condition itself makes false positives likely
at this depth range.** `creep.py`'s stop logic
(`slow-context-creep/creep.py`, around line 383) needs two things
together for 3 steps in a row: page churn at or above `COMPACT_PAGES`
(200 pages), and decode speed that fell more than 15% from the step
before (`RECOVERY_FRACTION`, 0.85). Decode speed falls naturally as
context grows — bigger KV cache, more expensive attention — with no
memory problem involved. In the 16K-32K depth range on this model,
that natural fall alone regularly exceeds 15% step to step. So the
stop fires whenever ordinary speed decay lines up with any background
compressor noise, which is close to certain once wired memory sits
near 25-26 GB on a 32 GB machine. `RECOVERY_FRACTION` and
`MAX_COMPACTING_STEPS` were hardcoded before this session; commit
`02a63df` makes them read from the environment, the same way
`COMPACT_PAGES` already did, so a runner can widen the tolerance
without editing the file.

**A real, separate signal turned up: swap growth under sustained
back-to-back sweeps.** Four sweeps run back to back with no recovery
gap between them, at wired 25000, q8_0 KV, `-c 98304`,
`COMPACT_PAGES=5000 RECOVERY_FRACTION=0.75 MAX_COMPACTING_STEPS=6`
(files: `loosened-old-run1-q8-w25000.tsv`,
`loosened-old-run2-q8-w25000-swapstop.tsv`,
`loosened-new-run1-q8-w25000-swapstop.tsv`,
`loosened-new-run2-q8-w25000-swapstop.tsv`). The first sweep (old
tool) reached the full ladder to depth 98338 on the speed floor alone
(loosened thresholds cleared the earlier false-positive stop). The
next three sweeps, run right after with no gap, each stopped on
`swap_delta_mb > 1` — real, positive swap growth, not a page-churn
false positive. Swap climbed across the sequence: 0 to 626 MB to 698
MB to roughly 825 MB, monotonically, never draining between sweeps.
No run 8, 9, or 10 in `choose-a-local-llm` recorded a swap-growth stop
on this exact q8_0 KV config; the two swap-growth stops on record
there were both on f16 KV configs. This pattern — swap growth only
after several sweeps stacked with no recovery pause, at wired 25000 —
has no precedent in this repository's history and is not yet
explained. It looks tied to sustained wired memory near 25-26 GB
without a recovery gap, not to either tool.

**wired 24000 does not serve this q8_0 config at all.** At `-c
98304`, q8_0 KV, wired 24000, the very first request failed outright
with a Metal OOM (`kIOGPUCommandBufferCallbackErrorOutOfMemory`), not
a slow degradation. This matches `choose-a-local-llm`'s own binary
search: 98304 is the largest `-c` that loads and serves a completion
at wired 25000 for this GGUF; wired 24000 falls under the floor this
exact config needs.

**f16 KV ceiling at wired 24000: `-c 33792`.** Found by the same
binary-search method `choose-a-local-llm`'s run11 used for q8_0
(`hardware/m1-max-32gb/benchmarks/bench11/results.md`, "Block 1/10").
33792 loads and serves a real completion; 33920 fails the same Metal
OOM way. For comparison, run11's f16 arm reached `-c 40960` at wired
25000 — 1000 MB less wired limit costs about 7100 tokens of f16
window on this model.

**Tool validation: 4/4 clean runs, f16 KV, wired 24000, `-c 33792`,
`-c` ladder to 32768, the loosened thresholds, `STEP_PAUSE_S=60`.**
Sequence new, old, new, old
(`f16-w24000-new-run1.tsv`, `f16-w24000-old-run1.tsv`,
`f16-w24000-new-run2.tsv`, `f16-w24000-old-run2.tsv` — file names
mark tool by their own label, not run order). Every run finished the
ladder with `no ceiling found up to 32768` and `swap_delta_mb` at or
below 0 on every row. Decode speed and page-churn both swing widely
run to run (old tool alone: 40-54 tok/s on one run, 21-27 tok/s on the
next, same unmodified code) with no consistent old-vs-new split. The
variance sits between runs, not between tools — more support for an
environmental read of the machine's compaction state, on top of the
now-cleared refactor.

**Revised verdict:** the refactor stays cleared — nothing above ties
any failure to code that changed between the old and new tool. But
"Case A, environmental noise, nothing to watch" undersold it. Two
real, separate signals exist and are still open:
1. The stop condition itself produces false positives from ordinary
   speed decay at 16K-32K depth, now visible and tunable via the env
   vars added in `02a63df`.
2. Sustained sweeps at wired 25000 with no recovery gap between them
   produce real swap growth with no precedent in this repository's
   history. Wired 24000 avoids it in every test run so far, at the
   cost of a smaller context window (f16: 33792 vs. 40960 at wired
   25000; q8_0 does not serve at 24000 at all for `-c 98304`).

Neither signal is fully explained yet. A same-machine, same-day
side-by-side of wired 24000 vs. 25000 with matched recovery gaps
between sweeps is the next test that would separate "wired level
causes the swap growth" from "back-to-back sweeps with no recovery
gap cause it regardless of wired level."
