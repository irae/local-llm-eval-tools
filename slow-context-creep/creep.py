"""creep.py — the shared context-creep runner.

One implementation of the method in `docs/methodology/context-creep.md`,
used by `creep_llama.py`, `creep_mlx.py` and `creep_lmstudio.py`. Those
three files hold only what genuinely differs per backend: the endpoint,
the request shape, how decode speed is read, and the two backend parts
of the liveness signal (the server-log death signature, and the one real
completion used as a probe).

One command, one output file. The runner is also the monitor: it samples
memory itself and it watches liveness itself, so a sweep needs no second
process beside it. Send stdout to a file and that file holds the whole
run — the column header, one row per step, every event, and the STOP
line that carries the verdict.

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
- **Memory sampling, wired first.** The runner reads `vm_stat` after
  every step. Wired memory is the meter that cannot lie: free memory
  stays low after the first model load, because the weights sit in the
  page cache (`research/run1/results/backend-diagnosis.md`). Free and
  the swap delta ride beside it, and so do the compressor page counts,
  which are what the compression-onset criterion reads.
- **The stop conditions.** Decode below the floor, an OOM or any request
  failure, a silent halt, swap growth, sustained material compaction,
  and a dead server. Compaction counts only when it is material
  (COMPACT_PAGES, hundreds of pages, not the machine's idle noise of
  about 12 per tick), persists for MAX_COMPACTING_STEPS steps, and
  speed does not recover against the PREVIOUS step. A depth sweep
  declines by design, so recovery against the best step of the run
  can never be met; an earlier rule did that and truncated a healthy
  sweep at 196618 on 2026-09-04.
- **Liveness, one signal.** A server can answer `/health` after its
  generation thread died, so `/health` is never used. The runner watches
  the server log for the backend's death signature, and, when a step
  gives no reply for `STALL_S`, it sends ONE real completion. A
  completion that returns means the server is alive and the step is
  merely slow. One that does not return means the server is dead.

Environment, all optional except DEPTH_LIST:

    DEPTH_LIST      comma-separated target depths, required
    N_CONTEXTS      round-robin contexts, default 1
    STEP_PAUSE_S    seconds between steps, default 25
    FLOOR_TOKS      usability floor, default 8
    COMPACT_PAGES   pages compressed or decompressed in one step that
                    count as material compaction, default 200
    STALL_S         seconds of silence before one liveness probe,
                    default 600
    PROBE_TIMEOUT_S seconds to wait for that probe, default 300
    SWEEP_BASE      server base URL, default http://127.0.0.1:8081
    MODEL           model id the server answers to, where needed

Exit codes: 0 the sweep found the floor or reached the last depth, 42 a
stop that invalidates every number past it, 2 a usage or platform error.
"""

import os
import subprocess
import sys
import threading
import time

DEPTHS = [int(x) for x in
          os.environ.get("DEPTH_LIST", "").replace(" ", "").split(",") if x]
N_CONTEXTS = int(os.environ.get("N_CONTEXTS", "1"))
STEP_PAUSE_S = float(os.environ.get("STEP_PAUSE_S", "25"))
FLOOR_TOKS = float(os.environ.get("FLOOR_TOKS", "8"))
COMPACT_PAGES = int(os.environ.get("COMPACT_PAGES", "200"))
STALL_S = float(os.environ.get("STALL_S", "600"))
PROBE_TIMEOUT_S = float(os.environ.get("PROBE_TIMEOUT_S", "300"))
BASE = os.environ.get("SWEEP_BASE", "http://127.0.0.1:8081")
MODEL = os.environ.get("MODEL", "")

BLOCK = ("def parse_record_%06d(line):\n"
         "    fields = line.strip().split(',')\n"
         "    return {'id': int(fields[0]), 'name': fields[1], 'value': float(fields[2])}\n\n")

# Each context takes its own block-number range so no two prompts ever
# share a prefix, which would make the server's cache treat them as one.
RANGE_SPAN = 200000

RECOVERY_FRACTION = 0.85
MAX_COMPACTING_STEPS = 3

# A probe queued behind a live step on a one-slot server fails exactly
# like a probe to a dead one. So one failure is a suspicion and two are
# the verdict, and the step gets another silent STALL_S to answer in
# between.
PROBES_BEFORE_DEAD = 2

PAGE_BYTES = 16384
POLL_S = min(30.0, STALL_S)
LAST_BEAT = [0.0]


class ServerDead(Exception):
    pass


def die(message):
    print(message, file=sys.stderr, flush=True)
    raise SystemExit(2)


def usage(doc):
    if "--help" in sys.argv[1:] or "-h" in sys.argv[1:]:
        print(doc.strip())
        raise SystemExit(0)


def vm_counters():
    try:
        out = subprocess.run(["vm_stat"], capture_output=True, text=True).stdout
    except FileNotFoundError:
        die("vm_stat not found. This method reads the macOS memory "
            "counters; run the sweep on the machine under test.")
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
    try:
        out = subprocess.run(["sysctl", "-n", "vm.swapusage"],
                             capture_output=True, text=True).stdout
    except FileNotFoundError:
        return 0.0
    parts = out.split()
    for index, token in enumerate(parts):
        if token == "used" and index + 2 < len(parts):
            return float(parts[index + 2].rstrip("M"))
    return 0.0


def wired_mb(counters):
    return counters.get("Pages wired down", 0) * PAGE_BYTES / 1048576


def free_mb(counters):
    return counters.get("Pages free", 0) * PAGE_BYTES / 1048576


def watch_server_log(path, signatures):
    """Stop the sweep when the server log shows a death signature.

    The signatures belong to the backend, so the adapter passes them in.
    """
    try:
        with open(path, errors="ignore") as handle:
            handle.seek(0, os.SEEK_END)
            start = handle.tell()
    except OSError as error:
        print("WARNING: cannot read %s (%s). The log signal is off; the "
              "stall probe still runs." % (path, error), flush=True)
        return

    def loop():
        position = start
        while True:
            time.sleep(3)
            try:
                with open(path, errors="ignore") as handle:
                    handle.seek(position)
                    chunk = handle.read()
                    position = handle.tell()
            except OSError:
                continue
            if any(signature in chunk for signature in signatures):
                print("STOP: generation thread died in %s" % path, flush=True)
                os._exit(42)

    threading.Thread(target=loop, daemon=True).start()


def beat():
    """An adapter calls this for every streamed chunk it receives.

    The stall clock counts silence, so a step that still sends tokens
    never looks stalled.
    """
    LAST_BEAT[0] = time.time()


def take_step(step, probe, prompt, label, depth):
    """Run one step, and probe liveness while the step stays silent."""
    box = {}

    def worker():
        try:
            box["value"] = step(prompt, label)
        except BaseException as error:
            box["error"] = error

    began = time.time()
    LAST_BEAT[0] = began
    thread = threading.Thread(target=worker, daemon=True)
    thread.start()

    probe_box = {}
    probe_thread = None
    stall_at = STALL_S
    seen_beat = began
    failures = 0

    def probe_worker():
        try:
            probe_box["alive"] = bool(probe(PROBE_TIMEOUT_S))
        except Exception as error:
            probe_box["alive"] = False
            probe_box["error"] = error

    while True:
        thread.join(POLL_S)

        if not thread.is_alive():
            if probe_thread is not None and probe_thread.is_alive():
                print("  the step answered while the probe was still "
                      "waiting. The server is alive; the probe is dropped.",
                      flush=True)
            break

        silent = time.time() - LAST_BEAT[0]

        if LAST_BEAT[0] > seen_beat:
            seen_beat = LAST_BEAT[0]
            stall_at = STALL_S
            failures = 0
            if probe_thread is not None:
                print("  the step sends tokens again. The server is alive; "
                      "the probe is dropped.", flush=True)
                probe_thread = None
                probe_box = {}

        if probe_thread is not None:
            if probe_thread.is_alive():
                continue
            took = time.time() - probe_box.get("began", time.time())
            if probe_box.get("alive"):
                print("  the probe answered in %.0f s. The server is alive "
                      "and the step is slow. The probe took a cache slot, so "
                      "the next step can re-read its prompt and read slow."
                      % took, flush=True)
                probe_thread = None
                probe_box = {}
                failures = 0
                stall_at = silent + STALL_S
                continue
            if "error" in probe_box:
                print("  the probe did not come back: %s" % probe_box["error"],
                      flush=True)
            probe_thread = None
            probe_box = {}
            failures += 1
            if failures < PROBES_BEFORE_DEAD:
                print("  probe %d of %d failed. A queued probe behind a live "
                      "step fails the same way, so the sweep waits another "
                      "%.0f s of silence and probes again."
                      % (failures, PROBES_BEFORE_DEAD, STALL_S), flush=True)
                stall_at = silent + STALL_S
                continue
            print("STOP: server dead. The step gave nothing for %.0f s and "
                  "%d probes did not come back, at depth %d."
                  % (silent, failures, depth), flush=True)
            raise ServerDead()

        if silent < stall_at:
            continue

        print("STALL: no output for %.0f s at depth %d on context %s"
              % (silent, depth, label), flush=True)
        if probe is None:
            print("  this backend gives no probe; the sweep keeps waiting",
                  flush=True)
            stall_at = silent + STALL_S
            continue
        probe_box = {"began": time.time()}
        probe_thread = threading.Thread(target=probe_worker, daemon=True)
        probe_thread.start()

    if "error" in box:
        raise box["error"]
    tok_s, generated = box["value"]
    return tok_s, generated, time.time() - began


def run(step, probe=None):
    """Drive the sweep. `step(prompt, label)` returns (tok_s, generated).

    It must raise on failure; the runner turns that into an OOM stop.
    `probe(timeout)` sends ONE real completion and returns whether it
    came back. Pass it, so the runner can tell a slow step from a dead
    server without a second process.
    """
    if not DEPTHS:
        die("DEPTH_LIST must be set, e.g. DEPTH_LIST=4096,8192,16384")
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
    compressions = start.get("Compressions", 0)
    decompressions = start.get("Decompressions", 0)
    compacting_steps = 0
    previous_toks = 0.0

    print("start: wired %.0f MB, free %.0f MB, swap used %.0f MB"
          % (wired_mb(start), free_mb(start), swap_start), flush=True)
    print("context\tdepth_tokens\tdecode_toks\twired_mb\tfree_mb\t"
          "swap_delta_mb\tcompress_pages\tdecompress_pages\tstep_seconds",
          flush=True)

    for target in DEPTHS:
        for ctx in contexts:
            while ctx["depth"] < target:
                ctx["prompt"] += BLOCK % ctx["block"]
                ctx["block"] += 1
                ctx["depth"] += 52

            try:
                tok_s, generated, elapsed = take_step(
                    step, probe, ctx["prompt"], ctx["label"], ctx["depth"])
            except ServerDead:
                return 42
            except Exception as error:
                print("STOP: request failed at depth %d on context %s: %s"
                      % (ctx["depth"], ctx["label"], error), flush=True)
                return 42

            ctx["prompt"] += generated

            counters = vm_counters()
            swap_delta = swap_used_mb() - swap_start
            compress_delta = counters.get("Compressions", 0) - compressions
            decompress_delta = counters.get("Decompressions", 0) - decompressions
            compressions = counters.get("Compressions", 0)
            decompressions = counters.get("Decompressions", 0)

            print("%s\t%d\t%.2f\t%.0f\t%.0f\t%.0f\t%d\t%d\t%.0f"
                  % (ctx["label"], ctx["depth"], tok_s, wired_mb(counters),
                     free_mb(counters), swap_delta, compress_delta,
                     decompress_delta, elapsed), flush=True)

            if tok_s <= 0:
                print("STOP: silent halt, no tokens at depth %d"
                      % ctx["depth"], flush=True)
                return 42

            if swap_delta > 1:
                print("STOP: swap grew %.0f MB by depth %d; the machine is "
                      "timing the swap file, not the model."
                      % (swap_delta, ctx["depth"]), flush=True)
                return 42

            compacting = compress_delta + decompress_delta >= COMPACT_PAGES
            recovered = previous_toks == 0 or tok_s >= RECOVERY_FRACTION * previous_toks
            if compacting and not recovered:
                compacting_steps += 1
                if compacting_steps >= MAX_COMPACTING_STEPS:
                    print("STOP: %d or more pages compressed or decompressed "
                          "on %d steps in a row, and speed did not come back, "
                          "by depth %d"
                          % (COMPACT_PAGES, compacting_steps, ctx["depth"]),
                          flush=True)
                    return 42
            else:
                compacting_steps = 0

            previous_toks = tok_s

            if tok_s < FLOOR_TOKS:
                print("STOP: below %.0f tok/s at depth %d"
                      % (FLOOR_TOKS, ctx["depth"]), flush=True)
                return 0

            time.sleep(STEP_PAUSE_S)

    print("no ceiling found up to %d" % DEPTHS[-1], flush=True)
    return 0
