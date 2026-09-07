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

## Comparison to the old tool

The reference run is `choose-a-local-llm`'s
`hardware/m1-max-32gb/benchmarks/bench11/results/creep-qwen36-gguf-q8-clean-redo.tsv`,
the accepted number for this exact model and server command (ceiling
81958 tokens, `speed` verdict, full ladder to depth 98338).

This run's decode speed matches the reference row for row at every
depth both runs reached: 36.23 vs 36.53 tok/s at depth 4114, 43.56 vs
44.15 at 8222, 31.05 vs 31.16 at 16386, 24.07 vs 24.14 at 24602, 19.60
vs 19.64 at 32818. The tool reproduces the old one's numbers.

The stop point does not match: this run hit a `mem` verdict (material
page compaction) at depth 32818, where the reference run continued to
a `speed` verdict at depth 98338. The two runs did not start from the
same machine state — this run's `start: swap used` reads 4727 MB,
against the reference run's 517 MB. The machine had a full day of
other benchmark activity behind it, not a clean baseline. The stop
point is a reading of machine state, not a tool difference.
