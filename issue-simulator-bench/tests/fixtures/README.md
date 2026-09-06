# Test fixtures

Every file here is real output, copied on 2026-09-05. Large logs are
trimmed; the trim is named beside the file. Nothing here is synthetic.

The tests also read two committed calibration files straight from
`benchmarks/`: `calibration-gemma12-gguf-off.json` (converged, small,
so the budget takes the 8192 floor), `calibration-qwen36-think.json`
(converged, large, so the budget is the observed max times 1.5) and
`calibration-gemma12-lmstudio-thinking-on.json` (six `finish_reason:
length` rows, so the tool refuses to guess a budget).

## Server logs

- `server-llama-oom.log`. Lines 1-20 of
  `~/.local/share/choose-a-local-llm/evidence/run9/server-qwen38-gguf-full-f16-c262144.log`
  on the reference Mac. llama-server fails to load at 262144 context and
  prints `Insufficient Memory (00000008:kIOGPUCommandBufferCallbackErrorOutOfMemory)`.
  The same signature is in the `-c229376` and `-c65536` logs of that run.
- `server-mlx-metal-oom.log`. Lines 35-60 of
  `~/.local/share/choose-a-local-llm/evidence/run2-qwen38-ceiling/mlx-server.log`.
  The block E crash: a Python traceback that ends in
  `RuntimeError: [METAL] Command buffer execution failed`.
- `server-llama-healthy.log`. The whole of
  `~/.local/share/choose-a-local-llm/evidence/run9/server-gemma26-gguf-short-f16.log`,
  92 lines. Normal slot and timing lines, no death signature.
- `server-lmstudio-healthy.log`. Lines 40-50, 228-240 and 556-559 of
  `~/.cache/lm-studio/server-logs/2026-09/2026-09-04.1.log`, joined. A
  healthy LM Studio server: context fit, prompt cache restores, a
  streamed completion. It carries one `[ERROR]` line for a routine
  client mistake ("Unexpected endpoint or method. (GET /props).
  Returning 200 anyway"), which is why a bare `[ERROR]` is not a death
  signature. The model listing the server prints beside it is left out;
  it is an inventory of the owner's machine.

## Memory

- `vm_stat-1.txt` and `vm_stat-2.txt`. Two `vm_stat` runs on the
  reference Mac, 45 seconds apart. Swapins move by 28 between them, so
  the delta columns have a real value to carry.

## Session and events logs

- `session-loop.jsonl`. Assistant messages 30-90 of
  `benchmark/runs/google-gemma-4-12b-low-guided-v3-issue-13-session.jsonl`
  in the Mendel benchmark repository. That slice is exactly the sliding
  window the loop check reports on the whole log, so it keeps the
  published verdict: 61 tool calls, one distinct shape,
  `distinct-shape ratio=0.02`, LOOP.
- `session-healthy.jsonl`. The last 25 assistant messages of
  `benchmark/runs/anthropic-claude-opus-5-high-issue-13-session.jsonl`.
  24 tool calls, all different, ratio 0.47, no loop, stop reason `stop`.
- `session-compaction.jsonl`. Lines 1-45 of
  `benchmark/runs/google-gemma-4-12b-low-guided-v3-issue-13-session.jsonl`
  in the Mendel benchmark repository: the header records, 21 assistant
  messages with 17 tool calls, and the run's first three `compaction`
  records. The first (line 32) is the split-turn marker whose summary
  starts with "No prior history"; the two after it are real summaries.
  Peak context 45159 on the `length` turn before the first record, the
  value `count-tool-calls.mjs` prints for the slice. The split-turn
  test reads the first 33 lines, which stop after that first record.
- `events-loop-calls.jsonl`. Event lines 462 to 526 of
  `benchmark/runs/prism-ml-Ternary-Bonsai-27B-mlx-2bit-off-guided-v3-issue-13-retry2-events.jsonl`
  in the Mendel benchmark repository, timestamps dropped: the first six
  of the 85 assistant messages in a row that each call
  `ls -la .../.taprc; cat .../.taprc` with the same arguments, the loop
  of 2026-09-06. The runner must end the run at the fifth.
- `events-text-cycle.jsonl`. Assistant message 274 of
  `benchmark/runs/gemma-4-12b-off-guided-v3-issue-13-session.jsonl`,
  wrapped as one `message_start` and one `message_end`: 45072
  characters, 1632 lines, no tool call, the "Wait, I'll do that now /
  Actually, I'll just do that" cycle that stopped on `length`. Shape
  ratio 0.02 over a 60-line window.
- `events-flood.jsonl`. Assistant message 45 of
  `benchmark/runs/google-gemma-4-12b-high-guided-v3-issue-13-session.jsonl`:
  a thinking block of 5461 characters, 5451 of them newlines, replayed
  as `thinking_delta` events of 500 characters and then the
  `message_end`. The runner must end the run on the deltas, before the
  message ends.
- `events-healthy.jsonl`. The 25 assistant messages of
  `session-healthy.jsonl` (above), wrapped as `message_start` and
  `message_end` pairs. All tool calls distinct; the run completes.
- `events-healthy-repeats.jsonl`. The first 30 assistant messages of
  `benchmark/runs/accounts-fireworks-models-deepseek-v4-flash-0731-high-issue-13-session.jsonl`,
  wrapped the same way: 43 tool calls, one command repeated with other
  calls between the repeats. The run completes; a repeat with work
  between it is not a loop.
- `events-toolcalls.jsonl`. Thirty whole tool calls
  (`toolcall_start`, its deltas, `toolcall_end`) from
  `~/.local/share/choose-a-local-llm/evidence/mendel-issue-13-run7/google-gemma-4-12b-low-guided-events.jsonl`,
  the smallest run of thirty in that log. It holds repeated `ls -F`
  commands, so it tests the 2026-09-05 fix: every tool call must end its
  own line.
