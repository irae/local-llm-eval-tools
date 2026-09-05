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
- `events-toolcalls.jsonl`. Thirty whole tool calls
  (`toolcall_start`, its deltas, `toolcall_end`) from
  `~/.local/share/choose-a-local-llm/evidence/mendel-issue-13-run7/google-gemma-4-12b-low-guided-events.jsonl`,
  the smallest run of thirty in that log. It holds repeated `ls -F`
  commands, so it tests the 2026-09-05 fix: every tool call must end its
  own line.
