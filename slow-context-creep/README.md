# slow-context-creep

A depth sweep for a served local model. It grows a prompt step by step
and records decode speed and memory at each step, on one of three
backends: llama-server, mlx_lm.server, or LM Studio.

## What it does

The tool sends one growing, append-only prompt to a served model and
reads back the decode speed and the macOS memory counters after every
step. It writes one row per step to stdout. The run ends at the first
stop condition, or at the last configured depth. Each stop condition
has its own exit code.

| Stop condition | Exit code |
| --- | --- |
| Decode speed falls under the floor | 0 |
| A request fails | 42 |
| A step returns no tokens (silent halt) | 42 |
| Swap memory grows | 42 |
| Sustained material compaction | 42 |
| The server log shows the death signature | 42 |
| Two liveness probes in a row fail | 42 |

Exit 0 also covers the case where the sweep reaches its last configured
depth with no stop condition met.

## Install

- Python 3. No pip install, no package.
- macOS, for the memory counters (`vm_stat`, `sysctl`). The tool exits 2
  with a message on any other platform.
- A model already served on one of the three backends: llama-server,
  mlx_lm.server, or LM Studio.

## Run

```
python3 creep.py <llama|mlx|lmstudio>
```

`DEPTH_LIST` is required. Every other variable has a default.

| Variable | Default | Meaning |
| --- | --- | --- |
| `DEPTH_LIST` | none, required | Comma-separated target depths in tokens |
| `N_CONTEXTS` | 1 | Round-robin contexts grown in turn |
| `STEP_PAUSE_S` | 25 | Seconds between steps |
| `FLOOR_TOKS` | 8 | Decode speed floor, in tokens per second |
| `COMPACT_PAGES` | 200 | Pages compressed or decompressed in one step that count as material compaction |
| `STALL_S` | 600 | Seconds of silence before one liveness probe |
| `PROBE_TIMEOUT_S` | 300 | Seconds to wait for that probe |
| `SWEEP_BASE` | `http://127.0.0.1:8081` | Server base URL |
| `MODEL` | none | Model id the server answers to, where needed |

Per-backend variables:

| Variable | Backend | Meaning |
| --- | --- | --- |
| `ENDPOINT` | llama | `completion` (default, raw) or `chat` (`/v1/chat/completions`) |
| `THINKING` | llama | `off` (default) sends `enable_thinking: false` on the chat endpoint |
| `SERVER_LOG` | mlx | Path to the server log, read for the death signature |
| `MODEL` | mlx, lmstudio | Required: the model id the server was started with |

One line per backend:

```
DEPTH_LIST=4096,8192,16384 python3 creep.py llama > run-creep.tsv 2>&1
DEPTH_LIST=4096,8192,16384 MODEL=<model id> SERVER_LOG=/tmp/mlx.log python3 creep.py mlx > run-creep.tsv 2>&1
DEPTH_LIST=4096,8192,16384 MODEL=<model key> python3 creep.py lmstudio > run-creep.tsv 2>&1
```

Help at both levels:

```
python3 creep.py --help
python3 creep.py <llama|mlx|lmstudio> --help
```

## Output

The tool writes stdout only. Layout, in order:

1. One header line naming the backend and its settings.
2. One `start:` line with the wired, free and swap memory at the start.
3. One column header line.
4. One tab-separated row per step, with event lines (`WARNING:`,
   `STALL:`, indented probe lines, `STOP:`) between rows where they
   occur.
5. A last line: either a `STOP:` line, or `no ceiling found up to D`.

The preamble before the first row can also carry `NOTE:` and `WARNING:`
lines, for example a fast pause or an unset `SERVER_LOG` on mlx.

The nine columns of each row:

| Column | Meaning |
| --- | --- |
| `context` | Round-robin context label: A, B, ... |
| `depth_tokens` | Used context depth at this step |
| `decode_toks` | Decode speed, tokens per second |
| `wired_mb` | Wired memory |
| `free_mb` | Free memory |
| `swap_delta_mb` | Swap used now, minus swap used at the start |
| `compress_pages` | Pages compressed since the previous step |
| `decompress_pages` | Pages decompressed since the previous step |
| `step_seconds` | Wall time of the step |

An excerpt from a real run (LM Studio, a stall followed by a stop on
swap growth):

```
LM Studio, chat endpoint, contexts=1 pause=25s
start: wired 7887 MB, free 72 MB, swap used 893 MB
context	depth_tokens	decode_toks	wired_mb	free_mb	swap_delta_mb	compress_pages	decompress_pages	step_seconds
A	4114	35.49	11404	158	0	0	16	24
STALL: no output for 600 s at depth 131098 on context A
```

Its last line:

```
STOP: swap grew 443 MB by depth 131098; the machine is timing the swap file, not the model.
```

Exit codes: 0 the sweep found the floor or reached the last configured
depth; 42 a stop that invalidates every number after it; 2 a usage or
platform error.

## Tests

```
python3 -m unittest discover -s slow-context-creep/tests -v
```

The tests run the real command as a subprocess. They point it at a fake
server and fake memory tools instead of a real model and a real
machine. A scenario file drives both fakes: it sets the decode rate of
each step, marks which requests fail or hang, and lists the memory
snapshot after each step. This lets each test set up one exact behavior,
such as a stall, a dead server, or a compaction stop.

The fixtures under `tests/fixtures/` are real output from real sweeps.
They are never regenerated, reformatted or trimmed. See
[`tests/fixtures/README.md`](tests/fixtures/README.md) for the source of
each one.

## Example

This is how `choose-a-local-llm` uses the tool to find the depth
ceiling of one server configuration.

1. Start the server for one configuration, at a fixed context size, and
   send its log to a file.
2. Warm the server up with one small request.
3. Run the sweep and keep its whole output in a file:

```
DEPTH_LIST=4096,8192,16384,24576,32768,49152,65536 \
MODEL=<the id the server answers to> \
python3 creep.py llama > /tmp/<config>-creep.tsv 2>&1
```

   On mlx_lm.server, add `SERVER_LOG=<the server log>` so the runner
   can see the death signature.
4. Read the ceiling from the file. On llama-server and mlx_lm.server,
   the ceiling is the deepest row before the stop: a rate under the
   floor, a swap-growth stop, or a sustained-compaction stop. LM Studio
   cannot pin its context window, so its window is only a loader
   estimate, not a measurement. For LM Studio, the ceiling is instead
   the FIRST row that shows material compaction or any swap growth. The
   engine keeps answering well past that row, but that row is still the
   ceiling.
5. To continue a sweep past a raised context size, do not restart from
   the first depth. Set `DEPTH_LIST` to the last verified depth plus the
   new, deeper targets. The tool grows the prompt to that first depth in
   one jump, as a control point. Its reading must land within 5% of the
   value the earlier, slow run found there. Otherwise the two runs are
   not comparable.
6. Keep `STEP_PAUSE_S` at its default, 25 seconds, unless a faster
   sweep is explicitly wanted. The pause gives macOS time to compress
   other memory, which raises the measured ceiling; a faster sweep
   understates it, and the tool prints a `WARNING:` line when it runs
   below 25 seconds.
