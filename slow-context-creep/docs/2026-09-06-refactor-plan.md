# slow-context-creep refactor plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** one entry point, three backends behind one interface, behavior tests on a fake server, and a README with the shape every tool in this repository shares.

**Architecture:** `creep.py` owns the method and is the only command. Each backend is one module beside it with the same five names. Tests run the real command against a fake HTTP server and fake memory tools on `PATH`, and compare the output against real sweep files copied from `choose-a-local-llm`.

**Tech stack:** Python 3 standard library only. No package, no dependency. Tests with `unittest`.

**Spec:** the "Design" section below. The method page stays in `choose-a-local-llm/docs/methodology/context-creep.md`; this plan does not copy it.

## Global constraints

- Write all prose (README, docstrings, plan, commit messages) in ASD-STE100 Simplified Technical English.
- No code comments. The module docstrings stay, because `--help` prints them.
- The output format does not change: `choose-a-local-llm` reads it. Line 1 backend header, line 2 `start: wired N MB, free N MB, swap used N MB`, line 3 the column header `context	depth_tokens	decode_toks	wired_mb	free_mb	swap_delta_mb	compress_pages	decompress_pages	step_seconds`, then one tab-separated row per step, event lines between rows (`WARNING:`, `STALL:`, two-space indented probe lines, `STOP:`), and the last line `STOP: ...` or `no ceiling found up to D`.
- Exit codes do not change: 0 floor found or last depth reached, 42 a stop that invalidates every number after it, 2 usage or platform error.
- Environment variable names do not change: `DEPTH_LIST`, `N_CONTEXTS`, `STEP_PAUSE_S`, `FLOOR_TOKS`, `COMPACT_PAGES`, `STALL_S`, `PROBE_TIMEOUT_S`, `SWEEP_BASE`, `MODEL`, and per backend `ENDPOINT`, `THINKING`, `SERVER_LOG`.
- Fixtures are real files copied unchanged. Never regenerate, reformat or trim one. A test that needs a new payload gets a new file with a README entry that names its source.
- Memory reads stay macOS (`vm_stat`, `sysctl -n vm.swapusage`). On another platform the tool exits 2 with the message it prints today. Tests put fakes of both on `PATH`.
- Commit messages name the behavior, never a task number. Every commit ends with the two trailer lines the coordinator gives.

---

## Design

### Files after the refactor

```
slow-context-creep/
  README.md                       what it does, install, run, output, tests, example
  creep.py                        entry point and the method
  backend_llama.py                llama-server
  backend_mlx.py                  mlx_lm.server
  backend_lmstudio.py             LM Studio
  tests/test_creep.py             behavior tests, unittest
  tests/helpers/fake-server.py    HTTP server driven by a scenario file
  tests/helpers/fake-vm_stat      prints vm_stat output from a scenario file
  tests/helpers/fake-sysctl       prints `vm.swapusage` from the same scenario
  tests/fixtures/README.md        source of every fixture
  tests/fixtures/creep-qwen38-gguf-short-q8.tsv       llama, STOP on the floor
  tests/fixtures/creep-qwen36-gguf-full-q8.tsv        llama, STOP on compaction
  tests/fixtures/creep-qwen38-gguf-full-f16.tsv       llama, no ceiling found
  tests/fixtures/creep-gemma12-lmstudio-131k.tsv      LM Studio, STALL, probes, STOP on swap
  tests/fixtures/creep-qwen36-mlx-25000.tsv           mlx, STALL and probe lines before the server died
  tests/fixtures/server-qwen36-mlx-creep.log          the mlx server log of that run, Metal OOM traceback
  tests/fixtures/vm_stat-1.txt, vm_stat-2.txt         real vm_stat output, the fake's format
```

`docs/` holds this plan only and is deleted when the plan is done.

### `creep.py`

Command: `python3 creep.py <llama|mlx|lmstudio>`. `python3 creep.py --help` prints the shared docstring (the method, the environment variables, the exit codes). `python3 creep.py <backend> --help` prints the backend docstring. No backend or an unknown backend: usage on stderr, exit 2.

It exports the same names as today for the backends: `BASE`, `MODEL`, `N_CONTEXTS`, `STEP_PAUSE_S`, `die`, `beat`, `watch_server_log`, `run`. The `usage` helper goes away; `creep.py` handles `--help` for both levels.

`main(argv)`: pick the backend module by name (`import backend_llama` and the two others, a dict from name to module), call `backend.check()`, print `backend.describe()`, start `watch_server_log(SERVER_LOG, backend.SIGNATURES)` when `SERVER_LOG` is set and `SIGNATURES` is not empty, print the mlx warning when `SERVER_LOG` is unset and the backend has signatures, then `raise SystemExit(run(backend.step, backend.probe))`.

### Backend interface

Every `backend_*.py` defines exactly these names:

- `__doc__`: what the backend needs; `--help` prints it.
- `SIGNATURES`: tuple of strings that mean the generation thread died, found in the server log. Empty for llama-server and LM Studio, `("Insufficient Memory", ...)` for mlx as today.
- `check()`: validates the environment, calls `creep.die` on misuse (llama chat endpoint without `MODEL`, LM Studio without `MODEL`).
- `describe()`: returns the header line, the same text each backend prints today.
- `step(prompt, label)`: returns `(tok_s, generated_text)`, raises on any failure.
- `probe(timeout)`: sends one real completion, returns True when it came back.

The request bodies, the endpoints and the decode-rate fields do not change from today's `creep_llama.py`, `creep_mlx.py`, `creep_lmstudio.py`.

### Fake server

`tests/helpers/fake-server.py` is a standard-library HTTP server. It reads one JSON scenario from the file named by `FAKE_SERVER_SCENARIO`, listens on `FAKE_SERVER_PORT`, and appends one JSON line per request to `FAKE_SERVER_LOG` with `{"index", "path", "kind", "prompt"}` where `kind` is `probe` for the one-token probe request and `step` otherwise, and `prompt` is the prompt text or the last user message.

Scenario keys:

- `rates`: list of decode rates, one per step request in order; the last value repeats.
- `at`: object from step index (string) to one action: `"fail"` answers HTTP 500; `"empty"` answers with empty text; `"hang"` waits `hang_s` seconds and then answers; `"die"` never answers this request and every later one, probes included.
- `hang_s`: seconds for `hang`.
- `probe`: `"ok"` or `"timeout"`; `timeout` never answers a probe.
- `flavor`: `"llama"`, `"lmstudio"` or `"mlx"`; chooses which endpoints answer and whether the chat reply carries `timings`.

Endpoints and reply shapes: `/completion` returns `{"content", "timings": {"predicted_per_second"}}`; `/v1/chat/completions` returns `{"choices": [{"message": {"content"}}], "usage": {"completion_tokens"}}` plus `timings` when the flavor is `llama`; `/v1/completions` returns `{"choices": [{"text"}], "usage": {"completion_tokens"}}`. The generated text is short and fixed, so appended prompts stay small.

### Fake memory tools

`tests/helpers/fake-vm_stat` and `tests/helpers/fake-sysctl` read `FAKE_MEM_SCENARIO`, a JSON file with `"snapshots"`: a list of objects with `free`, `wired`, `compressions`, `decompressions`, `swap_used_mb`. Each `vm_stat` call prints the next snapshot in the format of `tests/fixtures/vm_stat-1.txt` (page size line, `Pages free:`, `Pages wired down:`, `Compressions:`, `Decompressions:`, the other lines copied with fixed values) and advances the index stored in `FAKE_MEM_INDEX`; the last snapshot repeats. `sysctl -n vm.swapusage` prints `total = 4096.00M  used = <swap_used_mb>M  free = ...` for the current index. The tests link both into a temporary `bin/` as `vm_stat` and `sysctl` and put it first on `PATH`.

### Tests

`tests/test_creep.py` runs the real command as a subprocess with the fake server and fake memory tools. Each test names one behavior. Defaults for speed: `STEP_PAUSE_S=0`, `STALL_S=1`, `PROBE_TIMEOUT_S=1`, `DEPTH_LIST=200,400,600`. Blocks, by intent (functional tests):

- Usage: `--help` prints the environment variable names and exits 0; no backend exits 2; unknown backend exits 2; `DEPTH_LIST` unset exits 2; `vm_stat` missing from `PATH` exits 2 with the macOS message.
- Output shape: header line is the backend's; line 2 starts with `start:`; line 3 equals line 3 of the real fixture `creep-qwen38-gguf-short-q8.tsv`; every row has nine tab-separated fields; the last line is `no ceiling found up to 600`; exit 0. A fast pause prints the `WARNING:` line before the rows.
- Stops: rates that fall under `FLOOR_TOKS` give `STOP: below 8 tok/s at depth D` and exit 0, with the rows before it kept. `fail` gives `STOP: request failed` and exit 42. `empty` gives `STOP: silent halt` and exit 42. A snapshot with more swap gives `STOP: swap grew` and exit 42. Compression deltas at or above `COMPACT_PAGES` on three steps with falling rates give the compaction `STOP:` and exit 42; the same deltas with rates that recover do not stop. The `STOP:` lines must match the same regular expressions that match the STOP lines of the real fixtures.
- Liveness: a `hang` longer than `STALL_S` with `probe: ok` prints `STALL:`, then the indented "probe answered" line, then the row, and the sweep continues to the end. A `die` with `probe: timeout` prints `STALL:`, "probe 1 of 2 failed", a second `STALL:`, then `STOP: server dead`, exit 42. The mlx backend with `SERVER_LOG` set to a copy of lines 1 to 60 of `server-qwen36-mlx-creep.log`, to which the test appends the rest of that log during a `hang`, prints `STOP: generation thread died` and exits 42.
- Round robin: `N_CONTEXTS=2` gives rows with labels A, B, A, B; in the request log every prompt of a context starts with that context's previous prompt; block numbers of A and B never overlap.
- Backends: for each of llama (`/completion`), llama chat (`ENDPOINT=chat`), LM Studio and mlx, the request log shows the right path and the rows carry the rate the scenario gave.

### README outline

1. What it does: one paragraph and the stop conditions in one list.
2. Install: Python 3, macOS for the memory counters, a served model.
3. Run: the one command, the environment variables in a table, one line per backend.
4. Output: the file layout and a short real excerpt from a fixture, the exit codes.
5. Tests: `python3 -m unittest discover -s slow-context-creep/tests` and what the fake server is.
6. Example: how `choose-a-local-llm` runs it: start the server with a fixed context, run the sweep to a file, read the ceiling as the first row with material compaction, swap growth, or a rate under the floor, and the re-creep rule. Prose plus commands; no data files.

---

## Tasks

### Task 1: real fixtures and their README

**Files:**
- Create: `slow-context-creep/tests/fixtures/README.md`
- Create: the five `.tsv` files, the mlx server log and the two `vm_stat-*.txt` files listed in the design, copied with `cp` from `/home/irae/code/choose-a-local-llm/hardware/m1-max-32gb/benchmarks/bench9/results/`, `.../bench10/results/`, `.../bench11/results/` and `/home/irae/code/choose-a-local-llm/tests/fixtures/`. The server log holds Homebrew install paths only; check with grep that no home path, machine name or address other than 127.0.0.1 is in any copied file.

**Interfaces:**
- Produces: the fixture paths every later task reads.

- [ ] Copy the eight files. Compare each with `sha256sum` against its source; all must match.
- [ ] Write the README: one entry per file with the source path, the backend, the model and quantization, the date of the run when the file says it, and which lines show the behavior (the STOP line, the STALL block). Say that every file is real output, copied on 2026-09-06, never regenerated.
- [ ] Commit: "Real sweep outputs and memory readings as the creep tool's test fixtures".

### Task 2: fake server and fake memory tools

**Files:**
- Create: `slow-context-creep/tests/helpers/fake-server.py`, `fake-vm_stat`, `fake-sysctl` (all executable)
- Create: `slow-context-creep/tests/test_creep.py` with the test scaffold: a `setUp` that picks a free port, writes scenario files into a temporary directory, starts the fake server, links the fakes into `bin/`, and a `run_creep(backend, env)` helper that runs `python3 creep.py <backend>` with the merged environment and returns the completed process.

**Interfaces:**
- Produces: the scenario formats in the design; `run_creep` for every later test.

- [ ] Write the three helpers per the design.
- [ ] Write one test block that starts the fake server, sends one `/completion` request with `urllib`, and reads the rate back; one that calls the fake `vm_stat` twice and sees two different `Pages wired down` values; one that calls the fake `sysctl` and reads the swap value. Run them, see them pass.
- [ ] Commit: "A fake completion server and fake memory tools for the creep tests".

### Task 3: one entry point and the backend interface

**Files:**
- Modify: `slow-context-creep/creep.py` (add `main`, remove `usage`)
- Rename: `creep_llama.py` to `backend_llama.py`, `creep_mlx.py` to `backend_mlx.py`, `creep_lmstudio.py` to `backend_lmstudio.py` with `git mv`; each loses its `main()` and `if __name__` block and gains `SIGNATURES`, `check()`, `describe()`.
- Test: `tests/test_creep.py`, the usage and output-shape blocks.

**Interfaces:**
- Consumes: `run_creep` from Task 2.
- Produces: `python3 creep.py <backend>`; the backend names `SIGNATURES`, `check`, `describe`, `step`, `probe`.

- [ ] Write the usage and output-shape test blocks from the design. Run them; they fail because `creep.py` has no `main`.
- [ ] Implement `main` and the three backends. Keep every request body and rate field as it is today.
- [ ] Run the tests; all pass. Run `python3 creep.py llama --help` by hand and check the backend docstring prints.
- [ ] Commit: "One creep command, backends behind one interface".

### Task 4: stop rules

**Files:**
- Test: `tests/test_creep.py`, the stops block.

- [ ] Write the seven stop tests from the design (floor, fail, empty, swap, compaction stop, compaction recovery, STOP grammar against the fixtures). Run them.
- [ ] Fix only what a failing test shows; the rules themselves do not change.
- [ ] Commit: "The creep stop rules have behavior tests".

### Task 5: liveness

**Files:**
- Test: `tests/test_creep.py`, the liveness block.

- [ ] Write the three liveness tests from the design. `STALL_S=1`, `PROBE_TIMEOUT_S=1`, `hang_s=3`. Run them.
- [ ] Fix only what a failing test shows.
- [ ] Commit: "Stall, probe and dead-server behavior has tests".

### Task 6: round robin and the four backends

**Files:**
- Test: `tests/test_creep.py`, the round-robin and backends blocks.

- [ ] Write the tests from the design. Run them.
- [ ] Fix only what a failing test shows.
- [ ] Commit: "Round-robin growth and every backend's request path have tests".

### Task 7: README and root README line

**Files:**
- Create: `slow-context-creep/README.md` per the outline.
- Modify: `/home/irae/code/local-llm-eval-tools/README.md`: one line for this tool.
- Delete: `slow-context-creep/docs/`.

- [ ] Write the README. The output section quotes lines 1 to 5 of `creep-gemma12-lmstudio-131k.tsv` and the STOP line.
- [ ] Run the whole test file once more: `python3 -m unittest discover -s slow-context-creep/tests -v`.
- [ ] Commit: "The creep tool README".
