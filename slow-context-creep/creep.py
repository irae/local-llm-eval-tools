"""creep.py — the shared context-creep runner.

One implementation of the method in `docs/methodology/context-creep.md`,
used by `creep_llama.py`, `creep_mlx.py` and `creep_lmstudio.py`. Those
three files hold only what genuinely differs per backend: the endpoint,
the request shape, how decode speed is read, and how a dead server is
detected.

What this file owns, so that every backend gets it identically:

- **Slow creep by default.** `STEP_PAUSE_S` defaults to 25 seconds. A
  faster sweep must be asked for explicitly and is announced in the
  output, because macOS needs time to move GPU memory and a no-pause
  sweep understates the ceiling.
- **Round-robin contexts.** `N_CONTEXTS` independent prompts grown in
  turn, each append-only with a disjoint block-number range so their
  prefixes never collide. `N_CONTEXTS=1` is the single-context fill.
  Parallel slot testing is deliberately not supported: the project
  measures round-robin, which is what separate sessions keeping their
  own cache actually look like.
- **The stop conditions.** Decode below the floor, an OOM or any request
  failure, a silent halt, swap growth, and sustained memory compaction.
- **Memory sampling.** The runner reads `vm_stat` itself rather than
  trusting an external watcher, so a sweep cannot silently run blind.
  Run the watcher as well, for the record.

Environment, all optional except DEPTH_LIST:

    DEPTH_LIST      comma-separated target depths, required
    N_CONTEXTS      round-robin contexts, default 1
    STEP_PAUSE_S    seconds between steps, default 25
    FLOOR_TOKS      usability floor, default 8
    SWEEP_BASE      server base URL, default http://127.0.0.1:8081
    MODEL           model id the server answers to, where needed
"""

import json
import os
import subprocess
import sys
import time

DEPTHS = [int(x) for x in os.environ["DEPTH_LIST"].split(",")]
N_CONTEXTS = int(os.environ.get("N_CONTEXTS", "1"))
STEP_PAUSE_S = float(os.environ.get("STEP_PAUSE_S", "25"))
FLOOR_TOKS = float(os.environ.get("FLOOR_TOKS", "8"))
BASE = os.environ.get("SWEEP_BASE", "http://127.0.0.1:8081")
MODEL = os.environ.get("MODEL", "")

BLOCK = ("def parse_record_%06d(line):\n"
         "    fields = line.strip().split(',')\n"
         "    return {'id': int(fields[0]), 'name': fields[1], 'value': float(fields[2])}\n\n")

# Each context takes its own block-number range so no two prompts ever
# share a prefix, which would make the server's cache treat them as one.
RANGE_SPAN = 200000

# Compaction is normal under pressure and often recovers. Stop only when
# it persists AND speed does not come back.
MAX_COMPACTING_STEPS = 3


def vm_counters():
    out = subprocess.run(["vm_stat"], capture_output=True, text=True).stdout
    counters = {}
    for line in out.splitlines():
        if ":" not in line:
            continue
        key, _, value = line.partition(":")
        digits = value.strip().rstrip(".").replace(",", "")
        if digits.isdigit():
            counters[key.strip()] = int(digits)
    return counters


def swap_used_mb():
    out = subprocess.run(["sysctl", "-n", "vm.swapusage"],
                         capture_output=True, text=True).stdout
    for token in out.split():
        if token.endswith("M") and "used" in out.split(token)[0][-8:]:
            try:
                return float(token.rstrip("M"))
            except ValueError:
                pass
    parts = out.split()
    for i, token in enumerate(parts):
        if token == "used" and i + 2 < len(parts):
            return float(parts[i + 2].rstrip("M"))
    return 0.0


def free_mb(counters):
    return counters.get("Pages free", 0) * 16384 / 1048576


def run(step):
    """Drive the sweep. `step(prompt, label)` returns (tok_s, generated).

    It must raise on failure; the runner turns that into an OOM stop.
    """
    if STEP_PAUSE_S < 25:
        print("WARNING: pause %.0fs is below the documented 25s. A fast "
              "sweep understates the ceiling." % STEP_PAUSE_S, flush=True)

    contexts = []
    for index in range(N_CONTEXTS):
        contexts.append({
            "label": chr(ord("A") + index),
            "prompt": "Here is code base %s:\n\n" % chr(ord("A") + index),
            "block": index * RANGE_SPAN,
            "depth": 6,
        })

    start = vm_counters()
    swap_start = swap_used_mb()
    compaction_start = start.get("Decompressions", 0)
    compacting_steps = 0
    best_toks = 0.0

    print("context\tdepth_tokens\tdecode_toks\tfree_mb\tswap_delta_mb\tstep_seconds",
          flush=True)

    for target in DEPTHS:
        for ctx in contexts:
            while ctx["depth"] < target:
                ctx["prompt"] += BLOCK % ctx["block"]
                ctx["block"] += 1
                ctx["depth"] += 52

            began = time.time()
            try:
                tok_s, generated = step(ctx["prompt"], ctx["label"])
            except Exception as error:
                print("STOP: request failed at depth %d on context %s: %s"
                      % (ctx["depth"], ctx["label"], error), flush=True)
                return 42
            elapsed = time.time() - began

            ctx["prompt"] += generated

            counters = vm_counters()
            swap_delta = swap_used_mb() - swap_start
            print("%s\t%d\t%.2f\t%.0f\t%.0f\t%.0f"
                  % (ctx["label"], ctx["depth"], tok_s, free_mb(counters),
                     swap_delta, elapsed), flush=True)

            if tok_s <= 0:
                print("STOP: silent halt, no tokens at depth %d"
                      % ctx["depth"], flush=True)
                return 42

            if swap_delta > 1:
                print("STOP: swap grew %.0f MB by depth %d; the machine is "
                      "timing the swap file, not the model."
                      % (swap_delta, ctx["depth"]), flush=True)
                return 42

            compacting = counters.get("Decompressions", 0) > compaction_start
            compaction_start = counters.get("Decompressions", 0)
            recovered = tok_s >= 0.9 * best_toks
            if compacting and not recovered:
                compacting_steps += 1
                if compacting_steps >= MAX_COMPACTING_STEPS:
                    print("STOP: memory compaction on %d consecutive steps "
                          "without speed recovering, by depth %d"
                          % (compacting_steps, ctx["depth"]), flush=True)
                    return 42
            else:
                compacting_steps = 0

            best_toks = max(best_toks, tok_s)

            if tok_s < FLOOR_TOKS:
                print("STOP: below %.0f tok/s at depth %d"
                      % (FLOOR_TOKS, ctx["depth"]), flush=True)
                return 0

            time.sleep(STEP_PAUSE_S)

    print("no ceiling found up to %d" % DEPTHS[-1], flush=True)
    return 0
