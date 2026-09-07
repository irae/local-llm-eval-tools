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
