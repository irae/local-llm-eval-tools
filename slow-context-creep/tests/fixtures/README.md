# Test fixtures for slow-context-creep

Every file is real output from the sweep tool. These files are never regenerated. They were copied on 2026-09-07 from the `choose-a-local-llm` repository.

When a later test needs a different payload, add a new file with a new entry here.

## Fixtures

### creep-qwen38-gguf-short-q8.tsv
Source: `hardware/m1-max-32gb/benchmarks/bench9/results/creep-qwen38-gguf-short-q8.tsv` in `choose-a-local-llm`
Backend: llama-server
Model: Qwen 3.8B, GGUF format, 8-bit quantization
Run: bench9
Behavior: STOP on line 9. Performance dropped below 8 tokens per second at depth 32818 tokens.

### creep-qwen36-gguf-full-q8.tsv
Source: `hardware/m1-max-32gb/benchmarks/bench9/results/creep-qwen36-gguf-full-q8.tsv` in `choose-a-local-llm`
Backend: llama-server
Model: Qwen 3.6B, GGUF format, 8-bit quantization
Run: bench9
Behavior: STOP on line 9. 200 or more pages compressed or decompressed on 3 consecutive steps. Speed did not recover by depth 32818 tokens.

### creep-qwen38-gguf-full-f16.tsv
Source: `hardware/m1-max-32gb/benchmarks/bench9/results/creep-qwen38-gguf-full-f16.tsv` in `choose-a-local-llm`
Backend: llama-server
Model: Qwen 3.8B, GGUF format, 16-bit floating point
Run: bench9
Behavior: No ceiling found on line 9. The sweep completed all depths up to 32768 tokens without hitting a stop condition.

### creep-gemma12-lmstudio-131k.tsv
Source: `hardware/m1-max-32gb/benchmarks/bench10/results/creep-gemma12-lmstudio-131k.tsv` in `choose-a-local-llm`
Backend: LM Studio
Model: Gemma 1.2B, context window 131k
Run: bench10
Behavior: STALL block on lines 5-7 (no output for 600 seconds at depth 131098 tokens; probe timed out). STOP on line 9. Swap grew 443 MB, indicating the machine was timing the swap file.

### creep-qwen36-mlx-25000.tsv
Source: `hardware/m1-max-32gb/benchmarks/bench11/results/creep-qwen36-mlx-25000.tsv` in `choose-a-local-llm`
Backend: mlx_lm.server
Model: Qwen 3.6B, context window 25000
Run: bench11
Behavior: STALL block on lines 12-14 (no output for 600 seconds at depth 45090 tokens; probe timed out). The sweep was interrupted when the server died.

### server-qwen36-mlx-creep.log
Source: `hardware/m1-max-32gb/benchmarks/bench11/results/server-qwen36-mlx-creep.log` in `choose-a-local-llm`
Backend: mlx_lm.server
Model: Qwen 3.6B
Run: bench11
Behavior: Metal OOM traceback on lines 75-94. The server crashed with insufficient GPU memory while evaluating the prompt cache after processing depth 32818 tokens. Error: `kIOGPUCommandBufferCallbackErrorOutOfMemory`.

### vm_stat-1.txt
Source: `tests/fixtures/vm_stat-1.txt` in `choose-a-local-llm`
Type: Real `vm_stat` output from macOS
Purpose: Test fixture for parsing real system memory statistics. Format matches the fake-vm_stat helper's output format.

### vm_stat-2.txt
Source: `tests/fixtures/vm_stat-2.txt` in `choose-a-local-llm`
Type: Real `vm_stat` output from macOS
Purpose: Test fixture for parsing real system memory statistics. Format matches the fake-vm_stat helper's output format.
