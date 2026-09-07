# Creep compaction discrepancy — findings and Mac debugging plan

Date: 2026-09-07. Repository: `local-llm-eval-tools`, branch `master`.

## 1. Summary

- I found one real code regression from the refactor. It is committed
  (`7215c04`). It does **not** explain the compaction numbers.
- The prompt-cache hypothesis is **ruled out** by the evidence itself.
  See section 3.
- The compaction gap is most probably environmental. I cannot prove
  this from static analysis. An on-machine A/B test decides it.
  Section 6 is that plan.

## 2. Diff result: the request path did not change

I compared the pre-refactor files with the current ones:

```
diff <(git show 3a84948:slow-context-creep/creep_llama.py) \
     <(git show 461e0a6:slow-context-creep/backend_llama.py)
diff <(git show 3a84948:slow-context-creep/creep.py) \
     <(git show 461e0a6:slow-context-creep/creep.py)
```

Every hunk is restructuring. Nothing in the two diffs touches what the
tool sends or how it samples memory:

- `creep.py`: the only changes are the module docstring, the new
  `SERVER_LOG` constant, the removal of `usage()`, and the new `main()`
  plus the `__main__` guard. Lines 122 to 405 of the old file — which
  hold `vm_counters`, `swap_used_mb`, `wired_mb`, `free_mb`,
  `watch_server_log`, `beat`, `take_step` and `run` — are byte
  identical. `BLOCK`, `RANGE_SPAN`, `COMPACT_PAGES`, `STEP_PAUSE_S`,
  `RECOVERY_FRACTION` and `MAX_COMPACTING_STEPS` are byte identical.
- `run()`: the growth rule `ctx["prompt"] += BLOCK % ctx["block"]` and
  `ctx["prompt"] += generated` is byte identical to the old tool. The
  append-only rule is intact.
- Order of operations in `run()` is byte identical: the step runs, then
  `vm_counters()` and `swap_used_mb()` read the machine, then the row
  prints, then `time.sleep(STEP_PAUSE_S)`. The memory sample is taken
  before the pause in both tools.
- `backend_llama.py`: the only changes are the module docstring, the
  new `SIGNATURES = ()`, and `main()` split into `check()` and
  `describe()`. `post()`, `step_completion()`, `probe()` and
  `step_chat()` are byte identical.
- `step_completion` still sends
  `{"prompt": prompt, "n_predict": 64, "temperature": 0,
  "cache_prompt": True}` to `/completion`. The flag and the payload
  shape did not change.
- `take_step` cannot issue an extra request in these runs. The probe
  starts only after `STALL_S` seconds of silence. `STALL_S` defaults to
  600 s. The longest step in the new runs took 20 s. No probe fired.
  The output confirms this: no `STALL:` line appears in either TSV.

## 3. The prompt cache is working — the evidence proves it

The `step_seconds` column is the decisive number. It is wall time for
the whole request, so it includes prefill.

| depth | reference | first run | retry clean |
| --- | --- | --- | --- |
| 4114 | 7 | 10 | 7 |
| 8222 | 7 | 7 | 7 |
| 16386 | 15 | 15 | 15 |
| 24602 | 17 | 17 | 17 |
| 32818 | 20 | 20 | 20 |

The new tool takes the same wall time per step as the reference, at
every depth, on both runs. A cold reprocess of a 32818-token prompt on
this machine costs tens of seconds of prefill. That cost is absent.
The prompt cache is being hit exactly as before.

The same conclusion follows from `decode_toks`, which matches row for
row, and from `wired_mb`, which tracks the reference within 100 MB. A
cold reprocess would also move `wired_mb`.

So: the hypothesis "the new tool makes llama-server treat each step as
a cold prompt" is false. The code diff says it cannot happen, and the
timings say it did not happen.

## 4. The real regression I found (fixed, unrelated to compaction)

The refactor made `creep.py` both the entry point and a library. The
backends do `import creep`. When you run `python3 creep.py llama`,
Python loads the file **twice**: once as `__main__`, once as `creep`.
The two module objects hold separate state.

`LAST_BEAT` is the shared mutable state. `beat()` writes it and
`take_step()` reads it. After the refactor, `take_step` ran in the
`__main__` copy while a backend's `creep.beat()` wrote the `creep`
copy. The heartbeat never reached the stall clock.

Verified:

```
cd slow-context-creep && python3 -c "
import sys, runpy
sys.argv = ['creep.py', 'mlx', '--help']
try: runpy.run_path('creep.py', run_name='__main__')
except SystemExit: pass
import creep
print('same object?', creep is sys.modules['__main__'])"
# -> same object? False
```

Effect: on the `mlx` and `lmstudio` backends, which stream and call
`creep.beat()` per chunk, a healthy but slow step looks silent. After
`STALL_S` the sweep prints `STALL:` and fires a probe. The probe takes
a cache slot, which the tool's own message says can make the next step
re-read its prompt. Worst case, two failed probes stop a live sweep
with a false `STOP: server dead`.

The old tool did not have this bug. `creep_llama.py` was `__main__` and
imported `creep` once.

Fix (commit `7215c04`): the `__main__` guard now imports `creep` and
calls `creep.main(sys.argv[1:])`. One module object holds the sweep and
the backends.

All 27 tests pass after the fix.

**Would the tests have caught it?** No. This is a real test gap. Every
stall and probe test uses the `llama` backend, which does not stream
and never calls `beat()`. No test drives a slow streaming step on the
`mlx` or `lmstudio` backend and asserts that no `STALL:` line appears.
Noted for a later task; I did not add tests here.

**Does it explain the compaction?** No. The `llama` backend never calls
`beat()`, so the bug is inert on the runs in the evidence.

## 5. Why I read the compaction gap as environmental

`Compressions` and `Decompressions` in `vm_stat` are **system-wide,
cumulative counters**. They count every page the macOS memory
compressor touches for every process, not for the sweep. The tool reads
the delta between two steps. Anything else awake on the machine lands
in that delta.

The evidence fits a machine under pressure from something other than
the sweep:

- `free_mb` is lower in both new runs than in the reference. Reference:
  180, 100, 71, 101, 61. Retry clean: 1178, 62, 57, 58, 59. The
  reference run kept more headroom at the same depths.
- `swap_delta_mb` is **negative** in both new runs (-16, -40, -48 on
  the retry; -1300 on the first run). Swap was draining while the sweep
  ran. The reference held a flat 0. A draining swap file means the
  system was pulling pages back in — which is exactly what
  `Decompressions` counts.
- The magnitudes are far too large for the sweep itself. 140275 pages
  at 16384 bytes is about 2.2 GB of compression inside one 20-second
  step. The sweep's own prompt at depth 32818 is roughly 130 KB of
  Python string. `llama-server`'s KV cache is preallocated and wired,
  and `wired_mb` barely moves. Nothing in the sweep can produce 2.2 GB
  of churn.
- The two new runs disagree with each other by orders of magnitude at
  the same depths (4114: 112615 vs 84; 16386: 3366 vs 23883). A code
  defect gives a repeatable signature. Machine noise does not.

The "clean machine" check used swap **level**, not compressor state.
The repository's own checklist says swap is judged by growth, never by
level, and it does not clear the compressor. A machine can sit at 439
MB of swap and still hold gigabytes of compressed pages from days of
benchmarking, which other processes then decompress on touch. So the
retry did not rule out the environment; it ruled out only swap level.

The most probable extra load is the agent harness itself and whatever
else was awake during the new runs. I cannot confirm this from here.

**Conclusion:** static analysis cannot decide it, but it can and does
clear the two mechanisms that were suspected. The code path is byte
identical and the timings prove the cache is hit. The remaining
difference is machine state. The A/B test below settles it.

## 6. Debugging plan for the Mac runner

You are a Sonnet-tier runner on the Mac. You have no memory of the work
above. Follow these steps in order. Use Opus-tier subagents only where
a step says so. Write in Simplified Technical English. Use no home
paths in anything you commit.

### 6.0 Setup

1. Clone or update the repository:
   ```
   git clone https://github.com/<owner>/local-llm-eval-tools.git
   cd local-llm-eval-tools
   git fetch --all
   git checkout mac-creep-smoke
   git merge --ff-only origin/master
   ```
   If the merge is not fast-forward, `git merge origin/master` instead.
2. Confirm the fix from `master` is present:
   ```
   tail -12 slow-context-creep/creep.py
   ```
   The last lines must call `creep.main(sys.argv[1:])`.
3. Run the machine preflight in the sibling repository:
   ```
   cd ../choose-a-local-llm && ./tools/preflight.sh; cd -
   ```
   Act on every `fix` and `ask` line. Record the `memory` line.
4. Record the compressor baseline before anything else:
   ```
   vm_stat | grep -E "Pages free|Pages wired|Compress|Decompress"
   sysctl -n vm.swapusage
   ```
   Save the output. You compare against it later.

### 6.1 Reconstruct the old tool

```
mkdir -p /tmp/creep-old
git show 3a84948:slow-context-creep/creep.py       > /tmp/creep-old/creep.py
git show 3a84948:slow-context-creep/creep_llama.py > /tmp/creep-old/creep_llama.py
python3 -c "import py_compile,sys; py_compile.compile('/tmp/creep-old/creep.py', doraise=True); py_compile.compile('/tmp/creep-old/creep_llama.py', doraise=True)"
```

The old tool is run as `python3 /tmp/creep-old/creep_llama.py`.

### 6.2 Start the server, once, for both tools

Start it once and leave it up for the whole A/B. Both tools must face
the same server process and the same warm cache state.

```
llama-server -hf unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL \
  --alias qwen3.6-35b-a3b --no-mmproj \
  --spec-type draft-mtp --spec-draft-n-max 3 --parallel 1 \
  -ngl 999 -fa on -c 98304 \
  --cache-type-k q8_0 --cache-type-v q8_0 \
  --jinja --port 8081 --offline \
  --verbose \
  > /tmp/llama-server-ab.log 2>&1 &
```

`--verbose` matters. It makes the server print one prompt-processing
line per request. You need those lines in step 6.4.

Warm it up with one small request:
```
curl -s http://127.0.0.1:8081/completion \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"ok","n_predict":1,"temperature":0}' > /dev/null
```

### 6.3 The decisive A/B run

Use a short ladder. It reaches the depth where both new runs stopped
and it costs about 15 minutes per tool, not an hour.

```
export DEPTH_LIST="4096,8192,16384,24576,32768,40960"
export MODEL=qwen3.6-35b-a3b
export SWEEP_BASE=http://127.0.0.1:8081
```

Run the OLD tool first:
```
python3 /tmp/creep-old/creep_llama.py > /tmp/ab-old.tsv 2>&1
```

Then, immediately after, the NEW tool against the same live server:
```
python3 slow-context-creep/creep.py llama > /tmp/ab-new.tsv 2>&1
```

Do not touch the machine between the two runs. Do not open apps. Do not
run other commands while a sweep runs. Both runs must face the same
machine state; that is the whole point of the test.

Then look at both:
```
column -t -s$'\t' /tmp/ab-old.tsv
column -t -s$'\t' /tmp/ab-new.tsv
```

### 6.4 Read the verdict

Compare the `compress_pages` and `decompress_pages` columns of the two
files at the same depths.

**"Matches" means the same order of magnitude, not equality.** Machine
state moves run to run. Use this rule: at each shared depth, the sum
`compress_pages + decompress_pages` of the two runs must not differ by
more than 10x. Judge the pattern across all rows, not one row.

- **Case A — both tools show large page counts.** The discrepancy is
  environmental. Compressor state left by days of benchmarking is the
  cause, and a swap-level check does not clear it. The refactor is
  cleared. No code fix is needed. Go to 6.6 and write the verdict.
- **Case B — the old tool stays low and the new tool blows up.** This
  is a real regression. Go to 6.5.
- **Case C — both tools stay low, and the new tool now reaches depth
  98338 on the speed floor.** The earlier new-tool runs met transient
  machine state. The refactor is cleared. Go to 6.6.

Also confirm the prompt cache directly, for both files. The methodology
requires `.timings.prompt_n` to be the delta, not the total. In
`/tmp/llama-server-ab.log`, look for the prompt-processing lines:
```
grep -nE "prompt processing|n_past|n_tokens|prompt_n|cache" /tmp/llama-server-ab.log | tail -60
```
A cache hit shows a small token count per step (a few thousand at most,
the new tail). A cold reprocess shows the full depth (for example
32818). Compare the counts of the old-tool half of the log against the
new-tool half. If both halves are small, the cache works for both tools
and the compaction is not a prefill problem.

### 6.5 Case B only — isolate the regression

Allow **at most 3 rounds** of hypothesis-then-test. Mac time is scarce.
After the third round, stop and report to the owner with your evidence,
even if you have not found the cause.

Each round: state one hypothesis, define the one command that tests it,
run it, record the result. Use an Opus-tier subagent to read code and
form the hypothesis; you run the commands.

Round tools, in order of cost:

1. **Print the request body.** Add a temporary print at the top of
   `step_completion` in `slow-context-creep/backend_llama.py`:
   ```python
   print("REQ bytes=%d tail=%r" % (len(prompt), prompt[-80:]),
         file=sys.stderr, flush=True)
   ```
   Add the matching print to `/tmp/creep-old/creep_llama.py`. Run both
   tools for two depths only (`DEPTH_LIST="4096,8192"`). The byte
   counts and the tails must match step for step. Remove the prints
   afterwards. Never commit them.
2. **Compare the server's own view.** With `--verbose` on, the server
   log tells you how many tokens each request actually processed. Diff
   the per-request token counts and `progress` values between the
   old-tool half and the new-tool half of the log, at the same depths.
   A difference here is the answer.
3. **Bisect the refactor.** The refactor is commit `55329d3`
   ("One creep command, backends behind one interface"). Its parent is
   `d5f3f8d`. If rounds 1 and 2 find nothing, run the sweep at
   `55329d3` and at `d5f3f8d` and compare.

Do not use `tcpdump` or a proxy. The prints and the server log are
enough.

If you find and fix a real defect:
```
git checkout -b creep-compaction-fix
git add slow-context-creep
git commit
git push -u origin creep-compaction-fix
```
Write the commit message in Simplified Technical English. Say what
changed and why. Do not name plan steps or phases. End it with:
```
Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
```
Then run the whole suite before you push:
```
python3 -m unittest discover -s slow-context-creep/tests -v
```

### 6.6 Write the outcome

Append a new section to `slow-context-creep/tests/fixtures/smoke/README.md`.
**Append. Do not remove or edit the entries that are already there.**

Follow the conventions of the file: a `## ` heading per run, then short
bullet lines for backend, model, command, date, chip family and memory
size. Use Simplified Technical English. Use no home paths; write repo
relative paths only.

Add the two A/B files to the same directory:
```
cp /tmp/ab-old.tsv slow-context-creep/tests/fixtures/smoke/ab-old-tool-qwen36-gguf-q8.tsv
cp /tmp/ab-new.tsv slow-context-creep/tests/fixtures/smoke/ab-new-tool-qwen36-gguf-q8.tsv
```

The new section must state, in plain sentences:

1. That the old tool and the new tool ran back to back against one live
   server, on the same day, with the same depths.
2. The `compress_pages` and `decompress_pages` numbers of both runs at
   each shared depth, as a table.
3. The verdict: environmental, or a tool defect. Say which case of 6.4
   the numbers matched.
4. If it was a defect: the branch name and the commit that fixes it.
5. That `Compressions` and `Decompressions` in `vm_stat` are
   system-wide counters, so any other process on the machine adds to
   them. A future runner needs this to read the column correctly.

Commit on a branch and push:
```
git checkout -b creep-ab-verdict
git add slow-context-creep/tests/fixtures/smoke
git commit
git push -u origin creep-ab-verdict
```

End the commit message with:
```
Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
```

Then report the verdict to the owner. Do not merge to `master`
yourself.
