#!/usr/bin/env python3
"""creep_mlx.py — context creep against mlx_lm.server.

The method lives in `creep.py`; this file holds only what is specific to
upstream mlx-lm.

Round-robin works here. `mlx_lm.server` holds several distinct KV caches
— `--prompt-cache-size N` is documented as "Maximum number of distinct
KV caches to hold in the prompt cache", backed by an LRU with per-
sequence accounting. **Start the server with `--prompt-cache-size` at
least as large as `N_CONTEXTS`**, or the contexts will evict each other
and every step will re-read its whole prompt.

The one failure this backend has that the others do not: its generation
thread can die while the process lives and `/health` keeps answering.
`SERVER_LOG` points this script at the server log so it can see the Metal
out-of-memory signature and stop, instead of hanging. Set it.

Decode speed comes from the gaps between streamed chunks; this server
reports no timings of its own.

Usage:
    DEPTH_LIST=4096,8192 MODEL=mlx-community/Qwen3.8-27B-4bit \\
    SERVER_LOG=/tmp/mlx-server.log creep_mlx.py
"""

import json
import os
import sys
import threading
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import creep

SERVER_LOG = os.environ.get("SERVER_LOG", "")

DEATH_SIGNATURES = ("Insufficient Memory",
                    "Command buffer execution failed",
                    "Traceback (most recent call last)")


def watch_server_log():
    position = 0
    try:
        with open(SERVER_LOG, errors="ignore") as handle:
            handle.seek(0, os.SEEK_END)
            position = handle.tell()
    except OSError:
        return
    while True:
        time.sleep(3)
        try:
            with open(SERVER_LOG, errors="ignore") as handle:
                handle.seek(position)
                chunk = handle.read()
                position = handle.tell()
        except OSError:
            continue
        if any(signature in chunk for signature in DEATH_SIGNATURES):
            print("STOP: generation thread died in %s" % SERVER_LOG, flush=True)
            os._exit(42)


def step(prompt, _label):
    payload = {"model": creep.MODEL, "prompt": prompt, "max_tokens": 64,
               "temperature": 0, "stream": True}
    request = urllib.request.Request(
        creep.BASE + "/v1/completions", json.dumps(payload).encode(),
        {"Content-Type": "application/json"})

    stamps = []
    pieces = []
    with urllib.request.urlopen(request, timeout=3600) as response:
        for line in response:
            if not line.startswith(b"data:") or b"[DONE]" in line:
                continue
            chunk = json.loads(line[5:])
            piece = chunk["choices"][0].get("text")
            if piece:
                stamps.append(time.time())
                pieces.append(piece)

    if len(stamps) < 3:
        return 0.0, "".join(pieces)
    span = stamps[-1] - stamps[0]
    return ((len(stamps) - 1) / span if span else 0.0), "".join(pieces)


def main():
    if not creep.MODEL:
        raise SystemExit("MODEL must be the repo id the server was started with")
    if not SERVER_LOG:
        print("WARNING: SERVER_LOG unset. This backend can die silently with "
              "a green /health; without the log the sweep will hang instead "
              "of stopping.", flush=True)
    else:
        threading.Thread(target=watch_server_log, daemon=True).start()
    if creep.N_CONTEXTS > 1:
        print("NOTE: start the server with --prompt-cache-size >= %d"
              % creep.N_CONTEXTS, flush=True)
    print("mlx_lm.server, contexts=%d pause=%.0fs"
          % (creep.N_CONTEXTS, creep.STEP_PAUSE_S), flush=True)
    raise SystemExit(creep.run(step))


if __name__ == "__main__":
    main()
